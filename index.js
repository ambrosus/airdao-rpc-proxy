const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Configuration
const PORT = process.env.PORT || 6095;
const RPC_TARGET = 'https://network.ambrosus.io';
const WS_TARGET = 'wss://network.ambrosus.io/ws';

// Create Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

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
  }, 30000);
}

// Create and manage target WebSocket
function createTargetWebSocket(ws) {
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
    console.log('Target WebSocket closed, reconnecting...');
    if (ws.readyState === WebSocket.OPEN) {
      setTimeout(() => {
        const newTarget = createTargetWebSocket(ws);
        ws._targetWs = newTarget;
      }, 1000);
    }
  });

  setupHeartbeat(targetWs, 'target');
  return targetWs;
}

// Handle client WebSocket connections
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  setupHeartbeat(ws, 'client');

  ws._targetWs = createTargetWebSocket(ws);

  ws.on('message', (message) => {
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

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    ws._targetWs.close();
  });

  ws.on('error', (error) => {
    console.error('WebSocket client error:', error);
    ws._targetWs.close();
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
