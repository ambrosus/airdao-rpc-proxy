const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');

// Configuration
const PORT = process.env.PORT || 6095;
const RPC_TARGET = 'https://network.ambrosus.io';
const WS_TARGET = 'wss://network.ambrosus.io/ws';
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_REQUESTS_PER_SECOND = 150;
const INACTIVITY_TIMEOUT = 60 * 1000; // 1 minute

// Create Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Rate limiting middleware (150 requests per second)
const limiter = rateLimit({
  windowMs: 1000, // 1 second
  max: MAX_REQUESTS_PER_SECOND, // Limit each IP to 150 requests per second
  message: 'Too many requests, please try again later.'
});

app.use(limiter);

// Middleware to modify RPC request data
app.use('/rpc', (req, res, next) => {
  if (req.body && req.body.params) {
    req.body.params = req.body.params.map(param => {
      if (param && param.input) {
        return { ...param, data: param.input, input: undefined };
      }
      return param;
    });
  }
  next();
});

// Set up RPC proxy
const rpcProxy = createProxyMiddleware({
  target: RPC_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/rpc': '' },
  onProxyReq: (proxyReq, req) => {
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  onError: (err, req, res) => {
    console.error('Error during proxy request:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.use('/rpc', rpcProxy);

// Create HTTP server
const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

// Heartbeat for connections
function setupHeartbeat(ws, name) {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const interval = setInterval(() => {
    if (!ws.isAlive) {
      console.log(`${name} socket not alive, terminating...`);
      ws.terminate();
      clearInterval(interval);
      return;
    }
    ws.isAlive = false;
    ws.ping();
  }, 30000); // Every 30 seconds, ping the client
}

// Create and manage target WebSocket
function createTargetWebSocket(ws, attempt = 1) {
  const targetWs = new WebSocket(WS_TARGET);

  targetWs.on('open', () => {
    console.log('Connected to target WebSocket');
  });

  targetWs.on('message', (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });

  targetWs.on('error', (error) => {
    console.error('Target WebSocket error:', error);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  targetWs.on('close', () => {
    console.log('Target WebSocket closed');
    if (attempt < MAX_RECONNECT_ATTEMPTS) {
      console.log(`Reconnecting to target WebSocket (attempt ${attempt + 1})...`);
      setTimeout(() => {
        createTargetWebSocket(ws, attempt + 1);
      }, RECONNECT_DELAY);
    } else {
      console.error('Max reconnect attempts reached. Could not reconnect.');
    }
  });

  setupHeartbeat(targetWs, 'target');
  return targetWs;
}

// Handle client WebSocket connections
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  setupHeartbeat(ws, 'client');

  // Set up inactivity timer (1 minute)
  let inactivityTimer = setTimeout(() => {
    console.log('Client inactive for 1 minute, closing connection...');
    ws.close();
  }, INACTIVITY_TIMEOUT);

  // Reset the inactivity timer on each message
  ws.on('message', (message) => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.log('Client inactive for 1 minute, closing connection...');
      ws.close();
    }, INACTIVITY_TIMEOUT);

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(message.toString());
      if (parsedMessage.params) {
        parsedMessage.params = parsedMessage.params.map(param => {
          if (param && param.input) {
            return { ...param, data: param.input, input: undefined };
          }
          return param;
        });
      }
    } catch (err) {
      console.error('Failed to parse or modify message:', err);
      parsedMessage = message;
    }

    const sendData = typeof parsedMessage === 'string' ? parsedMessage : JSON.stringify(parsedMessage);
    if (ws._targetWs.readyState === WebSocket.OPEN) {
      ws._targetWs.send(sendData);
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clearTimeout(inactivityTimer); // Clean up inactivity timer
    ws._targetWs.close();
  });

  ws.on('error', (error) => {
    console.error('WebSocket client error:', error);
    ws._targetWs.close();
  });

  // Create target WebSocket connection
  ws._targetWs = createTargetWebSocket(ws);
});

// Start server
server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
