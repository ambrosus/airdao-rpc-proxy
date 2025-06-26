const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = process.env.PORT || 6095;
const RPC_TARGET = process.env.PROXY_TO || 'https://network.ambrosus.io';
const WS_TARGET = RPC_TARGET.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 100;
const CONNECTION_TIMEOUT = parseInt(process.env.CONNECTION_TIMEOUT) || 60 * 1000;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 70000;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DISABLE_REQUEST_LOGGING = process.env.DISABLE_REQUEST_LOGGING === 'true';

const logger = {
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  warn: (msg, ...args) => LOG_LEVEL !== 'error' && console.warn(`[WARN] ${msg}`, ...args),
  info: (msg, ...args) => ['info', 'debug'].includes(LOG_LEVEL) && console.info(`[INFO] ${msg}`, ...args),
  debug: (msg, ...args) => LOG_LEVEL === 'debug' && console.log(`[DEBUG] ${msg}`, ...args)
};

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

app.use('/rpc', (req, res, next) => {
  if (req.body && req.body.params && Array.isArray(req.body.params)) {
    req.body.params = req.body.params.map(param => {
      if (param && typeof param === 'object' && param.input) {
        return { ...param, data: param.input, input: undefined };
      }
      return param;
    });
  }
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    activeConnections,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

const rpcProxy = createProxyMiddleware({
  target: RPC_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/rpc': '' },
  timeout: REQUEST_TIMEOUT,
  proxyTimeout: REQUEST_TIMEOUT,
  onProxyReq: (proxyReq, req, res) => {
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Type', 'application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  onError: (err, req, res) => {
    logger.error('RPC Proxy error:', err.message);
    res.status(502).json({ 
      error: 'Proxy error', 
      message: 'Unable to connect to target server' 
    });
  },
  onProxyReq: !DISABLE_REQUEST_LOGGING ? (proxyReq, req, res) => {
    logger.debug(`RPC Request: ${req.method} ${req.path}`);
  } : undefined
});

app.use('/rpc', rpcProxy);

const server = http.createServer(app);

const wss = new WebSocket.Server({ 
  server, 
  path: '/ws',
  perMessageDeflate: false
});

let activeConnections = 0;
const connectionStats = {
  total: 0,
  rejected: 0,
  errors: 0
};

function createInactivityTimer(ws, targetWs, connectionId) {
  let timeout = setTimeout(() => {
    logger.info(`Connection ${connectionId} inactive, closing...`);
    ws.close();
    if (targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
  }, CONNECTION_TIMEOUT);

  const resetTimer = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      logger.info(`Connection ${connectionId} inactive, closing...`);
      ws.close();
      if (targetWs.readyState !== WebSocket.CLOSED) {
        targetWs.close();
      }
    }, CONNECTION_TIMEOUT);
  };

  const clearTimer = () => {
    clearTimeout(timeout);
  };

  return { resetTimer, clearTimer };
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(data);
      return true;
    } catch (error) {
      logger.error('Error sending message:', error.message);
      return false;
    }
  }
  return false;
}

function isChainIdMethod(message) {
  try {
    const parsed = JSON.parse(message.toString());
    return parsed.method === 'eth_chainId';
  } catch (err) {
    return false;
  }
}

wss.on('connection', (ws, req) => {
  if (activeConnections >= MAX_CONNECTIONS) {
    logger.warn('Too many connections, rejecting');
    connectionStats.rejected++;
    ws.close(1013, 'Too many connections');
    return;
  }

  activeConnections++;
  connectionStats.total++;
  const connectionId = connectionStats.total;
  
  logger.info(`Client connected (${activeConnections}/${MAX_CONNECTIONS} active) ID: ${connectionId}`);

  let targetWs;
  try {
    targetWs = new WebSocket(WS_TARGET, {
      handshakeTimeout: 10000,
      perMessageDeflate: false
    });
  } catch (error) {
    logger.error('Failed to create target WebSocket:', error.message);
    ws.close(1011, 'Internal error');
    activeConnections--;
    return;
  }

  const { resetTimer, clearTimer } = createInactivityTimer(ws, targetWs, connectionId);
  let isConnected = false;
  let targetReady = false;
  let pendingMessages = [];

  targetWs.on('open', () => {
    targetReady = true;
    isConnected = true;
    logger.debug(`Target connection established for client ${connectionId}`);
    
    pendingMessages.forEach(msg => {
      targetWs.send(msg);
    });
    pendingMessages = [];
  });

  ws.on('message', (message) => {
    resetTimer();
    
    if (!isConnected) {
      logger.warn(`Message received before target connection established for client ${connectionId}`);
      return;
    }

    if (isChainIdMethod(message)) {
      logger.debug(`chainId request from client ${connectionId}, forwarding directly`);
      safeSend(targetWs, message);
      return;
    }

    try {
      const parsed = JSON.parse(message.toString());
      
      if (parsed.params && Array.isArray(parsed.params)) {
        parsed.params = parsed.params.map(param => {
          if (param && typeof param === 'object' && param.input) {
            return { ...param, data: param.input, input: undefined };
          }
          return param;
        });
      }
      
      safeSend(targetWs, JSON.stringify(parsed));
      
    } catch (err) {
      logger.error(`Message parsing error for client ${connectionId}:`, err.message);
      safeSend(targetWs, message);
    }
  });

  targetWs.on('message', (msg) => {
    resetTimer();
    safeSend(ws, msg);
  });

  ws.on('close', (code, reason) => {
    logger.info(`Client ${connectionId} disconnected (${code}: ${reason})`);
    activeConnections--;
    clearTimer();
    if (targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
  });

  targetWs.on('close', (code, reason) => {
    logger.info(`Target connection closed for client ${connectionId} (${code}: ${reason})`);
    clearTimer();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target server disconnected');
    }
  });

  ws.on('error', (err) => {
    logger.error(`Client WS error for ${connectionId}:`, err.message);
    connectionStats.errors++;
    clearTimer();
    if (targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
  });

  targetWs.on('error', (err) => {
    logger.error(`Target WS error for ${connectionId}:`, err.message);
    connectionStats.errors++;
    clearTimer();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target server error');
    }
  });
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, starting graceful shutdown...');
  
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, starting graceful shutdown...');
  
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

if (LOG_LEVEL === 'debug') {
  setInterval(() => {
    logger.debug('Connection stats:', {
      active: activeConnections,
      total: connectionStats.total,
      rejected: connectionStats.rejected,
      errors: connectionStats.errors,
      memory: process.memoryUsage()
    });
  }, 60000);
}

server.listen(PORT, () => {
  logger.info(`Proxy server running on port ${PORT}`);
  logger.info(`RPC Target: ${RPC_TARGET}`);
  logger.info(`WS Target: ${WS_TARGET}`);
  logger.info(`Max connections: ${MAX_CONNECTIONS}`);
  logger.info(`Connection timeout: ${CONNECTION_TIMEOUT}ms`);
});
