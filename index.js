const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

// Конфигурация
const PORT = process.env.PORT || 6095;
const RPC_TARGET = process.env.PROXY_TO || 'https://network.ambrosus.io';
const WS_TARGET = RPC_TARGET.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
const MAX_CONNECTIONS = parseInt(process.env.MAX_PARALLEL_CONNECTIONS) || 300;
const CONNECTION_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 60 * 1000;
const WS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS) || 10;
const UPSTREAM_CONNECT_TIMEOUT = 30 * 1000; // 30 секунд на подключение к upstream
const MESSAGE_QUEUE_SIZE = 100; // Максимум сообщений в очереди на upstream

// Логирование
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DISABLE_REQUEST_LOGGING = process.env.DISABLE_REQUEST_LOGGING === 'true';

function log(level, message, data = null) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const currentLevel = levels[LOG_LEVEL] || 2;
  
  if (levels[level] <= currentLevel) {
    const timestamp = new Date().toISOString();
    const logData = data ? ` | ${JSON.stringify(data)}` : '';
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
  }
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Middleware для преобразования input -> data
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

// HTTP RPC прокси
const rpcProxy = createProxyMiddleware({
  target: RPC_TARGET,
  changeOrigin: true,
  pathRewrite: { '^/rpc': '' },
  timeout: CONNECTION_TIMEOUT,
  onProxyReq: (proxyReq, req, res) => {
    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  onError: (err, req, res) => {
    log('error', 'HTTP proxy error', { error: err.message, method: req.body?.method });
    res.status(502).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: req.body?.id || null
    });
  }
});

app.use('/rpc', rpcProxy);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

let activeConnections = 0;
let connectionId = 0;

// Улучшенный таймер неактивности
function startInactivityTimer(ws, targetWs, connId) {
  let timeout = setTimeout(() => {
    log('info', 'Connection inactive, closing', { connectionId: connId });
    safeClose(ws, 1000, 'Timeout');
    safeClose(targetWs, 1000, 'Timeout');
  }, CONNECTION_TIMEOUT);

  const reset = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      log('info', 'Connection inactive, closing', { connectionId: connId });
      safeClose(ws, 1000, 'Timeout');
      safeClose(targetWs, 1000, 'Timeout');
    }, CONNECTION_TIMEOUT);
  };

  ws.on('message', reset);
  targetWs.on('message', reset);
  
  const cleanup = () => {
    clearTimeout(timeout);
  };
  
  ws.on('close', cleanup);
  targetWs.on('close', cleanup);
  
  return cleanup;
}

// Безопасное закрытие WebSocket
function safeClose(ws, code = 1000, reason = '') {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason);
    }
  } catch (err) {
    log('warn', 'Error closing WebSocket', { error: err.message });
  }
}

// Создание upstream WebSocket с переподключением
function createUpstreamConnection(connId, onMessage, onClose, onError) {
  let attempts = 0;
  let ws = null;
  let messageQueue = [];
  let isConnected = false;

  function connect() {
    if (attempts >= WS_RECONNECT_MAX_ATTEMPTS) {
      log('error', 'Max reconnection attempts reached', { connectionId: connId, attempts });
      onError(new Error('Max reconnection attempts reached'));
      return null;
    }

    attempts++;
    log('debug', 'Connecting to upstream', { connectionId: connId, attempt: attempts, target: WS_TARGET });

    ws = new WebSocket(WS_TARGET);
    
    const connectTimeout = setTimeout(() => {
      log('warn', 'Upstream connection timeout', { connectionId: connId });
      safeClose(ws, 1002, 'Connection timeout');
    }, UPSTREAM_CONNECT_TIMEOUT);

    ws.on('open', () => {
      clearTimeout(connectTimeout);
      isConnected = true;
      attempts = 0; // Сброс счетчика при успешном подключении
      log('debug', 'Upstream connected', { connectionId: connId, queueSize: messageQueue.length });
      
      // Отправка сообщений из очереди
      while (messageQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        const message = messageQueue.shift();
        ws.send(message);
      }
    });

    ws.on('message', (data) => {
      if (!DISABLE_REQUEST_LOGGING) {
        log('debug', 'Upstream message received', { connectionId: connId });
      }
      onMessage(data);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(connectTimeout);
      isConnected = false;
      log('info', 'Upstream connection closed', { 
        connectionId: connId, 
        code, 
        reason: reason.toString(),
        attempts 
      });
      
      // Переподключение только если не достигли лимита попыток
      if (attempts < WS_RECONNECT_MAX_ATTEMPTS) {
        setTimeout(() => connect(), Math.min(1000 * attempts, 10000));
      } else {
        onClose();
      }
    });

    ws.on('error', (err) => {
      clearTimeout(connectTimeout);
      log('error', 'Upstream WebSocket error', { 
        connectionId: connId, 
        error: err.message,
        attempts 
      });
      onError(err);
    });

    return ws;
  }

  const connection = {
    send: (message) => {
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      } else {
        // Добавление в очередь с ограничением размера
        if (messageQueue.length < MESSAGE_QUEUE_SIZE) {
          messageQueue.push(message);
          log('debug', 'Message queued', { connectionId: connId, queueSize: messageQueue.length });
        } else {
          log('warn', 'Message queue full, dropping message', { connectionId: connId });
        }
      }
    },
    close: () => {
      safeClose(ws, 1000, 'Client disconnected');
    },
    isConnected: () => isConnected
  };

  connect();
  return connection;
}

// Обработка WebSocket подключений
wss.on('connection', (ws, req) => {
  const connId = ++connectionId;
  
  if (activeConnections >= MAX_CONNECTIONS) {
    log('warn', 'Too many connections, rejecting', { connectionId: connId, activeConnections });
    ws.close(1013, 'Too many connections');
    return;
  }

  activeConnections++;
  log('info', 'Client connected', { connectionId: connId, activeConnections, clientIP: req.connection.remoteAddress });

  let cleanupTimer = null;
  let targetConnection = null;

  // Создание upstream соединения
  targetConnection = createUpstreamConnection(
    connId,
    // onMessage
    (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    },
    // onClose
    () => {
      log('info', 'Upstream permanently closed', { connectionId: connId });
      safeClose(ws, 1002, 'Upstream unavailable');
    },
    // onError
    (err) => {
      log('error', 'Upstream connection failed', { connectionId: connId, error: err.message });
      safeClose(ws, 1002, 'Upstream error');
    }
  );

  // Обработка сообщений от клиента
  ws.on('message', (message) => {
    try {
      if (!DISABLE_REQUEST_LOGGING) {
        log('debug', 'Client message received', { connectionId: connId });
      }
      
      const parsed = JSON.parse(message.toString());
      
      // Преобразование input -> data
      if (parsed.params) {
        parsed.params = parsed.params.map(param => {
          if (param && param.input) {
            return { ...param, data: param.input, input: undefined };
          }
          return param;
        });
      }
      
      targetConnection.send(JSON.stringify(parsed));
    } catch (err) {
      log('warn', 'Message parsing error', { connectionId: connId, error: err.message });
      // Отправка сырого сообщения при ошибке парсинга
      targetConnection.send(message);
    }
  });

  // Обработка закрытия соединения клиента
  ws.on('close', (code, reason) => {
    log('info', 'Client disconnected', { 
      connectionId: connId, 
      code, 
      reason: reason.toString(),
      activeConnections: activeConnections - 1 
    });
    activeConnections--;
    targetConnection.close();
    if (cleanupTimer) cleanupTimer();
  });

  // Обработка ошибок клиента
  ws.on('error', (err) => {
    log('error', 'Client WebSocket error', { connectionId: connId, error: err.message });
    targetConnection.close();
    if (cleanupTimer) cleanupTimer();
  });

  // Запуск таймера неактивности
  cleanupTimer = startInactivityTimer(ws, { close: () => targetConnection.close() }, connId);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Received SIGTERM, shutting down gracefully');
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('info', 'Received SIGINT, shutting down gracefully');
  server.close(() => {
    log('info', 'Server closed');
    process.exit(0);
  });
});

// Обработка неперехваченных исключений
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled rejection', { reason, promise });
});

// Запуск сервера
server.listen(PORT, () => {
  log('info', 'Proxy server started', { 
    port: PORT, 
    rpcTarget: RPC_TARGET, 
    wsTarget: WS_TARGET,
    maxConnections: MAX_CONNECTIONS,
    connectionTimeout: CONNECTION_TIMEOUT 
  });
});
