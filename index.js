const express = require('express');
const http = require('http');
const https = require('https');
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
    // Replace input with data in the request body
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
  onProxyReq: (proxyReq, req, res) => {
    // If the request body was modified, we need to update the content-length header
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      // Write the modified body to the proxy request
      proxyReq.write(bodyData);
    }
  }
});

app.use('/rpc', rpcProxy);

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server, path: '/ws' });

// Helper function to reconnect WebSocket
function reconnectWebSocket(ws, targetWs) {
  if (targetWs.readyState !== WebSocket.OPEN) {
    console.log('Reconnecting to target WebSocket...');
    targetWs = new WebSocket(WS_TARGET);
    
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
      ws.close();
    });

    targetWs.on('close', () => {
      console.log('Target WebSocket closed, reconnecting...');
      reconnectWebSocket(ws, targetWs);
    });
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  // Create a connection to the target WebSocket server
  let targetWs = new WebSocket(WS_TARGET);
  
  // Handle messages from client
  ws.on('message', (message) => {
    try {
      // Parse the message to modify it
      const parsedMessage = JSON.parse(message.toString());
      
      // Replace input with data in the message
      if (parsedMessage.params) {
        parsedMessage.params = parsedMessage.params.map(param => {
          if (param && param.input) {
            return { ...param, data: param.input, input: undefined };
          }
          return param;
        });
      }
      
      // Forward the modified message to the target
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(parsedMessage));
      } else {
        reconnectWebSocket(ws, targetWs);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      // Forward the original message if there's an error
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(message);
      }
    }
  });
  
  // Forward messages from target to client
  targetWs.on('message', (message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
  
  // Handle client disconnection
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    targetWs.close();
  });
  
  // Handle target disconnection
  targetWs.on('close', () => {
    console.log('Target WebSocket disconnected');
    ws.close();
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket client error:', error);
    targetWs.close();
  });
  
  targetWs.on('error', (error) => {
    console.error('Target WebSocket error:', error);
    ws.close();
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
