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

// Новые настройки
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 30000; // 30 секунд
const HEARTBEAT_TIMEOUT = parseInt(process.env.HEARTBEAT_TIMEOUT) || 35000;   // 35 секунд
const RECONNECT_ATTEMPTS = parseInt(process.env.RECONNECT_ATTEMPTS) || 3;
const RECONNECT_DELAY = parseInt(process.env.RECONNECT_DELAY) || 1000;        // 1 секунда
const ENABLE_HEARTBEAT = process.env.ENABLE_HEARTBEAT !== 'false';

const logger = {
  error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, ...args),
  warn: (msg, ...args) => LOG_LEVEL !== 'error' && console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, ...args),
  info: (msg, ...args) => ['info', 'debug'].includes(LOG_LEVEL) && console.info(`[INFO] ${new Date().toISOString()} ${msg}`, ...args),
  debug: (msg, ...args) => LOG_LEVEL === 'debug' && console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`, ...args)
};

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Существующий middleware для RPC
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



// Расширенный health check
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  
  const healthData = { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
    uptimeSeconds: uptime,
    activeConnections,
    memory: {
      used: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
      total: `${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(memory.external / 1024 / 1024)}MB`,
      rss: `${Math.round(memory.rss / 1024 / 1024)}MB`
    },
    config: {
      port: PORT,
      rpcTarget: RPC_TARGET,
      wsTarget: WS_TARGET,
      maxConnections: MAX_CONNECTIONS,
      connectionTimeout: CONNECTION_TIMEOUT,
      requestTimeout: REQUEST_TIMEOUT,
      heartbeatEnabled: ENABLE_HEARTBEAT,
      heartbeatInterval: HEARTBEAT_INTERVAL
    }
  };

  res.status(200).json(healthData);
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
      message: 'Unable to connect to target server',
      timestamp: new Date().toISOString()
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

// Улучшенная функция для создания таймера неактивности
function createInactivityTimer(ws, targetWs, connectionId) {
  let timeout = setTimeout(() => {
    logger.info(`Connection ${connectionId} inactive, closing...`);
    ws.close();
    if (targetWs && targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
  }, CONNECTION_TIMEOUT);

  const resetTimer = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      logger.info(`Connection ${connectionId} inactive, closing...`);
      ws.close();
      if (targetWs && targetWs.readyState !== WebSocket.CLOSED) {
        targetWs.close();
      }
    }, CONNECTION_TIMEOUT);
  };

  const clearTimer = () => {
    clearTimeout(timeout);
  };

  return { resetTimer, clearTimer };
}

// Улучшенная функция heartbeat
function setupHeartbeat(ws, targetWs, connectionId) {
  if (!ENABLE_HEARTBEAT) return { clearHeartbeat: () => {} };
  
  let heartbeatTimer;
  let timeoutTimer;
  let isAlive = true;

  function sendHeartbeat() {
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      isAlive = false;
      targetWs.ping();
      logger.debug(`Heartbeat sent for connection ${connectionId}`);
      
      timeoutTimer = setTimeout(() => {
        if (!isAlive) {
          logger.warn(`Heartbeat timeout for connection ${connectionId}`);
          if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.terminate();
          }
        }
      }, HEARTBEAT_TIMEOUT);
    }
  }

  if (targetWs) {
    targetWs.on('pong', () => {
      isAlive = true;
      logger.debug(`Heartbeat received for connection ${connectionId}`);
      clearTimeout(timeoutTimer);
    });

    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  }

  const clearHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  };

  return { clearHeartbeat };
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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

// Функция для попытки переподключения
function attemptReconnection(ws, connectionId, retryCount = 0) {
  if (retryCount >= RECONNECT_ATTEMPTS) {
    logger.error(`Max reconnection attempts reached for client ${connectionId}`);
    ws.close(1011, 'Unable to establish target connection');
    return null;
  }

  const delay = RECONNECT_DELAY * Math.pow(2, retryCount); // Exponential backoff
  logger.info(`Attempting reconnection ${retryCount + 1}/${RECONNECT_ATTEMPTS} for client ${connectionId} in ${delay}ms`);
  
  setTimeout(() => {
    try {
      const targetWs = new WebSocket(WS_TARGET, {
        handshakeTimeout: 10000,
        perMessageDeflate: false
      });
      
      return targetWs;
    } catch (error) {
      logger.error(`Reconnection attempt ${retryCount + 1} failed for client ${connectionId}:`, error.message);
      return attemptReconnection(ws, connectionId, retryCount + 1);
    }
  }, delay);
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
  
  logger.info(`Client connected (${activeConnections}/${MAX_CONNECTIONS} active) ID: ${connectionId} from ${req.socket.remoteAddress}`);

  let targetWs;
  let heartbeat = { clearHeartbeat: () => {} };
  let inactivityTimer;
  
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

  let isConnected = false;
  let targetReady = false;
  let pendingMessages = [];
  let requestTimes = new Map(); // Для отслеживания времени ответа

  targetWs.on('open', () => {
    targetReady = true;
    isConnected = true;
    logger.debug(`Target connection established for client ${connectionId}`);
    
    // Настраиваем heartbeat
    heartbeat = setupHeartbeat(ws, targetWs, connectionId);
    
    // Настраиваем таймер неактивности
    inactivityTimer = createInactivityTimer(ws, targetWs, connectionId);
    
    // Отправляем отложенные сообщения
    pendingMessages.forEach(msg => {
      targetWs.send(msg);
    });
    pendingMessages = [];
  });

  ws.on('message', (message) => {
    if (inactivityTimer) inactivityTimer.resetTimer();
    
    if (!isConnected) {
      logger.warn(`Message received before target connection established for client ${connectionId}`);
      pendingMessages.push(message);
      return;
    }

    // Записываем время для измерения ответа
    try {
      const parsed = JSON.parse(message.toString());
      if (parsed.id) {
        requestTimes.set(parsed.id, Date.now());
      }
    } catch (err) {
      // Игнорируем ошибки парсинга для измерения времени
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
    if (inactivityTimer) inactivityTimer.resetTimer();
    
    // Измеряем время ответа
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.id && requestTimes.has(parsed.id)) {
        const responseTime = Date.now() - requestTimes.get(parsed.id);
        requestTimes.delete(parsed.id);
        logger.debug(`Response time for request ${parsed.id}: ${responseTime}ms`);
      }
    } catch (err) {
      // Игнорируем ошибки парсинга
    }
    
    safeSend(ws, msg);
  });

  ws.on('close', (code, reason) => {
    logger.info(`Client ${connectionId} disconnected (${code}: ${reason})`);
    activeConnections--;
    metrics.connections.active = activeConnections;
    
    if (inactivityTimer) inactivityTimer.clearTimer();
    heartbeat.clearHeartbeat();
    
    if (targetWs && targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
    
    // Очищаем отложенные запросы
    requestTimes.clear();
  });

  targetWs.on('close', (code, reason) => {
    logger.info(`Target connection closed for client ${connectionId} (${code}: ${reason})`);
    
    if (inactivityTimer) inactivityTimer.clearTimer();
    heartbeat.clearHeartbeat();
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target server disconnected');
    }
  });

  ws.on('error', (err) => {
    logger.error(`Client WS error for ${connectionId}:`, err.message);
    connectionStats.errors++;
    updateMetrics('connection', { event: 'error' });
    
    if (inactivityTimer) inactivityTimer.clearTimer();
    heartbeat.clearHeartbeat();
    
    if (targetWs && targetWs.readyState !== WebSocket.CLOSED) {
      targetWs.close();
    }
  });

  targetWs.on('error', (err) => {
    logger.error(`Target WS error for ${connectionId}:`, err.message);
    connectionStats.errors++;
    updateMetrics('connection', { event: 'error' });
    
    if (inactivityTimer) inactivityTimer.clearTimer();
    heartbeat.clearHeartbeat();
    
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Target server error');
    }
  });
});

// Graceful shutdown
function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown...`);
  
  // Сохраняем финальные метрики
  if (ENABLE_METRICS) {
    logger.info('Final metrics:', {
      uptime: Date.now() - metrics.startTime,
      totalConnections: metrics.connections.total,
      totalRequests: metrics.requests.total,
      errorRate: metrics.requests.total > 0 ? 
        (metrics.requests.failed / metrics.requests.total * 100).toFixed(2) + '%' : '0%'
    });
  }
  
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  
  // Принудительное завершение через 10 секунд
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Обработка необработанных ошибок
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Периодическое логирование статистики
if (LOG_LEVEL === 'debug') {
  setInterval(() => {
    const memUsage = process.memoryUsage();
    logger.debug('Connection stats:', {
      active: activeConnections,
      total: connectionStats.total,
      rejected: connectionStats.rejected,
      errors: connectionStats.errors,
      memory: {
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`
      }
    });
    
    if (ENABLE_METRICS) {
      logger.debug('Performance stats:', {
        requestsPerMinute: metrics.requests.total / ((Date.now() - metrics.startTime) / 60000),
        avgResponseTime: `${Math.round(metrics.performance.avgResponseTime)}ms`,
        errorRate: metrics.requests.total > 0 ? 
          (metrics.requests.failed / metrics.requests.total * 100).toFixed(2) + '%' : '0%'
      });
    }
  }, 60000);
}

server.listen(PORT, () => {
  logger.info(`Proxy server running on port ${PORT}`);
  logger.info(`RPC Target: ${RPC_TARGET}`);
  logger.info(`WS Target: ${WS_TARGET}`);
  logger.info(`Max connections: ${MAX_CONNECTIONS}`);
  logger.info(`Connection timeout: ${CONNECTION_TIMEOUT}ms`);
  logger.info(`Request timeout: ${REQUEST_TIMEOUT}ms`);
  logger.info(`Heartbeat enabled: ${ENABLE_HEARTBEAT}`);
  logger.info(`Metrics enabled: ${ENABLE_METRICS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);
  
  if (ENABLE_HEARTBEAT) {
    logger.info(`Heartbeat interval: ${HEARTBEAT_INTERVAL}ms`);
    logger.info(`Heartbeat timeout: ${HEARTBEAT_TIMEOUT}ms`);
  }
});
