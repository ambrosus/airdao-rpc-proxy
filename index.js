const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 6095;
const RPC_TARGET = 'https://network.ambrosus.io';
const WS_TARGET = 'wss://network.ambrosus.io/ws';
const MAX_CONNECTIONS = 300;
const CONNECTION_TIMEOUT = 60 * 1000;

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

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

const rpcProxy = createProxyMiddleware({
  target: RPC_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/rpc': '' },
  onProxyReq: (proxyReq, req, res) => {
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  }
});

app.use('/rpc', rpcProxy);

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/ws' });
let activeConnections = 0;

function startInactivityTimer(ws, targetWs) {
  let timeout = setTimeout(() => {
    console.log('Connection inactive, closing...');
    ws.close();
    targetWs.close();
  }, CONNECTION_TIMEOUT);

  const reset = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      console.log('Connection inactive, closing...');
      ws.close();
      targetWs.close();
    }, CONNECTION_TIMEOUT);
  };

  ws.on('message', reset);
  targetWs.on('message', reset);
  ws.on('close', () => clearTimeout(timeout));
  targetWs.on('close', () => clearTimeout(timeout));
}

wss.on('connection', (ws) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    console.log('Too many connections, rejecting');
    ws.close(1013, 'Too many connections');
    return;
  }

  activeConnections++;
  console.log(`Client connected (${activeConnections} total)`);

  let targetWs = new WebSocket(WS_TARGET);

  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.params) {
        parsed.params = parsed.params.map(param => {
          if (param && param.input) {
            return { ...param, data: param.input, input: undefined };
          }
          return param;
        });
      }
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(parsed));
      }
    } catch (err) {
      console.error('Message parsing error:', err);
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message);
      }
    }
  });

  targetWs.on('message', (msg) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    activeConnections--;
    targetWs.close();
  });

  targetWs.on('close', () => {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  });

  ws.on('error', (err) => {
    console.error('Client WS error:', err);
    targetWs.close();
  });

  targetWs.on('error', (err) => {
    console.error('Target WS error:', err);
    ws.close();
  });

  startInactivityTimer(ws, targetWs);
});

// Start server
server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
