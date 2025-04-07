const cors = require("@fastify/cors");
const websocket = require('@fastify/websocket');
const formbody = require('@fastify/formbody');
const { WebSocket } = require('ws');
const { ethers } = require("ethers");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Настройка логирования
const fastify = require('fastify')({
  logger: {
    transport: process.env.NODE_ENV === 'development' 
      ? { target: 'pino-pretty' } 
      : undefined,
    level: process.env.LOG_LEVEL || 'info',
    redact: ['req.headers.authorization'],
    serializers: {
      err: (err) => {
        // Пользовательский сериализатор для ошибок
        return {
          type: err.constructor.name,
          message: err.message,
          stack: err.stack,
          code: err.code,
          statusCode: err.statusCode,
          ...(err.cause && { cause: err.cause })
        };
      }
    }
  }
});

// Конфигурация
const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus-dev.io';
const PORT = parseInt(process.env.PORT || '8545', 10);
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const MAX_PAYLOAD_SIZE = parseInt(process.env.MAX_PAYLOAD_SIZE || '10485760', 10); // 10MB
const WS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS || '5', 10);
const ERROR_LOG_PATH = process.env.ERROR_LOG_PATH || '/app/logs/errors';
const MAX_ERROR_LOGS = parseInt(process.env.MAX_ERROR_LOGS || '1000', 10);
const LOG_ROTATION_INTERVAL = parseInt(process.env.LOG_ROTATION_INTERVAL || '86400000', 10); // 24 часа в мс

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// Создаем директорию для логов, если она не существует
if (!fs.existsSync(ERROR_LOG_PATH)) {
  try {
    fs.mkdirSync(ERROR_LOG_PATH, { recursive: true });
    fastify.log.info(`Created error log directory: ${ERROR_LOG_PATH}`);
  } catch (err) {
    fastify.log.error({ err }, 'Failed to create error log directory');
  }
}

// Функция для очистки старых логов
async function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(ERROR_LOG_PATH)
      .filter(file => file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(ERROR_LOG_PATH, file),
        time: fs.statSync(path.join(ERROR_LOG_PATH, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time); // Сортировка от новых к старым
    
    // Удаляем логи, превышающие лимит
    if (files.length > MAX_ERROR_LOGS) {
      const filesToRemove = files.slice(MAX_ERROR_LOGS);
      for (const file of filesToRemove) {
        fs.unlinkSync(file.path);
      }
      fastify.log.info(`Cleaned up ${filesToRemove.length} old error logs, keeping newest ${MAX_ERROR_LOGS}`);
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error cleaning up old logs');
  }
}

// Настроим периодическую очистку логов
setInterval(cleanupOldLogs, LOG_ROTATION_INTERVAL);
// И запустим очистку при старте
cleanupOldLogs();

// Функция для логирования ошибок в файл
function logErrorToFile(requestData, errorData) {
  const timestamp = new Date().toISOString();
  // Создаем хеш на основе запроса для группировки похожих ошибок
  let requestHash = '';
  
  try {
    if (typeof requestData === 'object') {
      // Создаем стабильный хеш на основе метода и параметров запроса
      const methodStr = Array.isArray(requestData) 
        ? requestData.map(r => r.method).join('_')
        : (requestData?.method || 'unknown');
      
      requestHash = crypto
        .createHash('md5')
        .update(methodStr)
        .digest('hex')
        .substring(0, 8);
    }
  } catch (e) {
    requestHash = 'hash_error';
  }
  
  const errorId = `error_${timestamp.replace(/[:.]/g, '-')}_${requestHash}`;
  const logFilePath = path.join(ERROR_LOG_PATH, `${errorId}.json`);
  
  // Подготовка данных для лога с ограничением размера
  let safeRequestData = requestData;
  let safeErrorData = errorData;
  
  // Ограничиваем размер объектов для логирования
  const truncateForLog = (obj, maxDepth = 3, currentDepth = 0) => {
    if (currentDepth >= maxDepth) return '[Truncated]';
    
    if (Array.isArray(obj)) {
      return obj.length > 10 
        ? [...obj.slice(0, 10).map(item => truncateForLog(item, maxDepth, currentDepth + 1)), `[${obj.length - 10} more items]`]
        : obj.map(item => truncateForLog(item, maxDepth, currentDepth + 1));
    }
    
    if (obj && typeof obj === 'object') {
      const result = {};
      const entries = Object.entries(obj);
      
      if (entries.length > 20) {
        // Если объект слишком большой, ограничим количество полей
        for (let i = 0; i < 20; i++) {
          const [key, value] = entries[i];
          result[key] = truncateForLog(value, maxDepth, currentDepth + 1);
        }
        result['[truncated]'] = `${entries.length - 20} more fields`;
      } else {
        for (const [key, value] of entries) {
          result[key] = truncateForLog(value, maxDepth, currentDepth + 1);
        }
      }
      return result;
    }
    
    if (typeof obj === 'string' && obj.length > 1000) {
      return obj.substring(0, 1000) + '... [truncated]';
    }
    
    return obj;
  };
  
  safeRequestData = truncateForLog(requestData);
  safeErrorData = truncateForLog(errorData);
  
  const logData = {
    timestamp,
    requestHash,
    proxy_to: PROXY_TO,
    request: safeRequestData,
    error: safeErrorData
  };
  
  try {
    fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
    fastify.log.info({ errorId }, 'Error logged to file');
    return errorId;
  } catch (err) {
    fastify.log.error({ err }, 'Failed to write error log');
    return null;
  }
}

// Обработка завершения работы
async function shutdown() {
  fastify.log.info('Shutting down gracefully');
  try {
    await fastify.close();
    fastify.log.info('Server closed successfully');
    process.exit(0);
  } catch (err) {
    fastify.log.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Обработка неперехваченных ошибок
process.on('uncaughtException', (err) => {
  fastify.log.error({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'Unhandled rejection');
});

// Start the server
async function main() {
  // Регистрация плагинов
  await fastify.register(cors, { origin: '*' });
  await fastify.register(websocket, {
    options: {
      maxPayload: MAX_PAYLOAD_SIZE
    }
  });
  await fastify.register(formbody, {
    bodyLimit: MAX_PAYLOAD_SIZE
  });

  // Эндпоинт для проверки здоровья системы
  fastify.get('/health', async (request, reply) => {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      proxy_to: PROXY_TO,
      uptime: process.uptime(),
      connections: fastify.websocketServer ? fastify.websocketServer.clients.size : 0
    };
  });

  // Эндпоинт для просмотра статистики ошибок
  fastify.get('/errors/stats', async (request, reply) => {
    try {
      if (!fs.existsSync(ERROR_LOG_PATH)) {
        return { count: 0, errors: [] };
      }
      
      // Группировка ошибок по типам/хешам для более компактного представления
      const errorFiles = fs.readdirSync(ERROR_LOG_PATH)
        .filter(file => file.endsWith('.json'))
        .map(file => {
          const filePath = path.join(ERROR_LOG_PATH, file);
          const stats = fs.statSync(filePath);
          return { 
            file,
            path: filePath,
            mtime: stats.mtime.getTime(),
            size: stats.size
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
      
      // Хеш-карта для группировки ошибок
      const errorGroups = new Map();
      const recentErrors = [];
      
      // Обрабатываем только последние 100 ошибок для статистики
      for (const fileInfo of errorFiles.slice(0, 100)) {
        try {
          const data = JSON.parse(fs.readFileSync(fileInfo.path, 'utf8'));
          const requestMethod = Array.isArray(data.request) 
            ? data.request.map(r => r.method).join(',')
            : (data.request?.method || 'unknown');
          
          const errorMessage = data.error?.message || 'unknown error';
          const groupKey = `${requestMethod}:${errorMessage.substring(0, 50)}`;
          
          if (!errorGroups.has(groupKey)) {
            errorGroups.set(groupKey, {
              method: requestMethod,
              error: errorMessage,
              count: 0,
              examples: []
            });
          }
          
          const group = errorGroups.get(groupKey);
          group.count++;
          
          // Добавляем пример ошибки, если их немного
          if (group.examples.length < 3) {
            group.examples.push({
              id: fileInfo.file.replace('.json', ''),
              timestamp: data.timestamp,
              requestHash: data.requestHash
            });
          }
          
          // Отдельно сохраняем самые последние ошибки
          if (recentErrors.length < 10) {
            recentErrors.push({
              id: fileInfo.file.replace('.json', ''),
              timestamp: data.timestamp,
              method: requestMethod,
              error: errorMessage,
              requestHash: data.requestHash
            });
          }
        } catch (err) {
          fastify.log.warn({ file: fileInfo.file, err }, 'Failed to parse error log file');
        }
      }
      
      return { 
        count: errorFiles.length, 
        totalFiles: errorFiles.length,
        diskUsage: errorFiles.reduce((sum, file) => sum + file.size, 0),
        groups: Array.from(errorGroups.values())
          .sort((a, b) => b.count - a.count)
          .slice(0, 20),
        recentErrors
      };
    } catch (err) {
      fastify.log.error({ err }, 'Error getting error stats');
      return { error: 'Failed to get error statistics', message: err.message };
    }
  });

  // Дополнительный эндпоинт для просмотра детальной информации о конкретной ошибке
  fastify.get('/errors/:id', async (request, reply) => {
    try {
      const errorId = request.params.id;
      const errorFilePath = path.join(ERROR_LOG_PATH, `${errorId}.json`);
      
      if (!fs.existsSync(errorFilePath)) {
        reply.status(404).send({ error: 'Error log not found' });
        return;
      }
      
      const errorData = JSON.parse(fs.readFileSync(errorFilePath, 'utf8'));
      return errorData;
    } catch (err) {
      fastify.log.error({ err, errorId: request.params.id }, 'Error retrieving error log');
      reply.status(500).send({ error: 'Failed to retrieve error log' });
    }
  });

  // HTTP handler
  fastify.post('/', handler);

  // WebSocket handler
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    let wsClient = null;
    let wsReady = false;
    let connectionAttempts = 0;
    const messageQueue = new Map();
    let pingInterval;
    
    function connectWs() {
      if (connectionAttempts >= WS_RECONNECT_MAX_ATTEMPTS) {
        fastify.log.error('Max connection attempts reached');
        return;
      }

      connectionAttempts++;
      const wsUrl = PROXY_TO.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
      fastify.log.info(`Attempting to connect to backend WS (attempt ${connectionAttempts}/${WS_RECONNECT_MAX_ATTEMPTS}): ${wsUrl}`);
      
      try {
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
          try {
            wsClient.terminate();
          } catch (err) {
            fastify.log.error({ err }, 'Error terminating previous WebSocket');
          }
        }
        
        wsClient = new WebSocket(wsUrl, {
          handshakeTimeout: 10000,
          maxPayload: MAX_PAYLOAD_SIZE,
          perMessageDeflate: false,
          followRedirects: true
        });
        
        wsClient.on('open', () => {
          fastify.log.info('Backend WS connected successfully');
          wsReady = true;
          connectionAttempts = 0;
          
          // Установка пинг-интервала после успешного подключения
          if (pingInterval) clearInterval(pingInterval);
          pingInterval = setInterval(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
              try {
                wsClient.ping();
              } catch (err) {
                fastify.log.error({ err }, 'Error sending ping');
              }
            }
          }, 30000);
        });

        wsClient.on('ping', () => {
          try {
            wsClient.pong();
          } catch (err) {
            fastify.log.error({ err }, 'Error sending pong');
          }
        });

        wsClient.on('message', (data) => {
          if (connection.socket.readyState === WebSocket.OPEN) {
            try {
              const response = JSON.parse(data.toString());
              // Remove a request from the queue after receiving a response
              messageQueue.delete(response.id);
              connection.socket.send(data);
            } catch (err) {
              fastify.log.error({ err }, 'Error sending message to client');
            }
          }
        });

        wsClient.on('close', (code, reason) => {
          fastify.log.info({ code, reason: reason?.toString() }, 'Backend WS closed');
          wsReady = false;
          clearInterval(pingInterval);
          
          if (connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
            const timeout = Math.min(1000 * Math.pow(2, connectionAttempts), 10000);
            fastify.log.info(`Reconnecting in ${timeout}ms...`);
            setTimeout(connectWs, timeout);
          }
        });

        wsClient.on('error', (error) => {
          // Логирование полной информации об ошибке
          const errorDetails = {
            name: error.name,
            message: error.message,
            code: error.code,
            type: error.type,
            errno: error.errno,
            syscall: error.syscall,
            hostname: error.hostname,
            address: error.address,
            port: error.port
          };
          
          fastify.log.error({ error: errorDetails }, 'Backend WS error');
          wsReady = false;
          
          // Сохраняем ошибку в файл для анализа
          logErrorToFile({ type: 'ws_connection', url: wsUrl }, errorDetails);
        });

      } catch (err) {
        fastify.log.error({ err }, 'Error creating WebSocket');
        if (connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
          const timeout = Math.min(1000 * Math.pow(2, connectionAttempts), 10000);
          setTimeout(connectWs, timeout);
        }
      }
    }

    connectWs();

    connection.socket.on('message', async (data) => {
      try {
        if (!wsReady || !wsClient || wsClient.readyState !== WebSocket.OPEN) {
          if (!wsReady && connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
            connectWs();
          }
          connection.socket.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Backend WebSocket is not connected. Please try again in a few seconds.'
            },
            id: JSON.parse(data)?.id || null
          }));
          return;
        }

        const request = JSON.parse(data);
        const requestId = request.id;

        // Check if the request is not already in the queue
        if (messageQueue.has(requestId)) {
          connection.socket.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Request with this ID is already in progress'
            },
            id: requestId
          }));
          return;
        }

        // Apply the same transformations as for HTTP requests
        const { userRequest } = prepareUserRequest({ body: request });
        messageQueue.set(requestId, userRequest);
        wsClient.send(JSON.stringify(userRequest));

        // Timeout for request
        setTimeout(() => {
          if (messageQueue.has(requestId)) {
            messageQueue.delete(requestId);
            if (connection.socket.readyState === WebSocket.OPEN) {
              // Логируем ошибку таймаута
              const errorId = logErrorToFile(
                request, 
                { code: -32000, message: 'Request timeout', timestamp: new Date().toISOString() }
              );

              connection.socket.send(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: 'Request timeout',
                  data: errorId ? `Error ID: ${errorId}` : undefined
                },
                id: requestId
              }));
            }
          }
        }, TIMEOUT);

      } catch (err) {
        fastify.log.error({ err }, 'Error processing WS message');
        
        // Логируем необработанную ошибку
        const rawData = data.toString();
        const requestData = (() => {
          try { return JSON.parse(rawData); } 
          catch { return rawData; }
        })();
        
        const errorId = logErrorToFile(
          requestData, 
          { code: -32000, message: err.message, stack: err.stack }
        );

        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Internal server error',
              data: errorId ? `Error ID: ${errorId}` : undefined
            },
            id: null
          }));
        }
      }
    });

    connection.socket.on('close', () => {
      fastify.log.info('Client disconnected');
      clearInterval(pingInterval);
      messageQueue.clear(); // Clearing the queue on disconnection
      if (wsClient) {
        try {
          wsClient.close();
        } catch (err) {
          fastify.log.error({ err }, 'Error closing WebSocket');
        }
      }
    });
  });

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Listening on port ${PORT}, proxying to ${PROXY_TO}`);
  } catch (err) {
    fastify.log.error({ err }, 'Error starting server');
    process.exit(1);
  }
}

function prepareUserRequest(request) {
  const isArr = Array.isArray(request.body);
  const userRequest = isArr ? request.body : [request.body];

  userRequest.forEach((req) => {
    req?.params?.forEach((p) => {
      if (p?.input) {
        p.data = p.input;  // viem use `input` instead of `data`
        delete p.input;
      }
      if (req.method === "eth_estimateGas") {
        delete p?.type; // remix sends this
      }
      delete p?.chainId
    });
  });

  return { isArr, userRequest };
}

async function handler(request, reply) {
  const originalRequest = request.body;
  fastify.log.debug({ request: originalRequest }, "Incoming RPC request");

  try {
    const { isArr, userRequest } = prepareUserRequest(request);
    
    // Добавляем таймаут для запроса
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), TIMEOUT)
    );
    
    // Выполняем запрос с таймаутом
    const networkResponse = await Promise.race([
      sendToNetwork(userRequest),
      timeoutPromise
    ]);

    fastify.log.debug({ 
      request: userRequest,
      response: networkResponse
    }, "Network response received");

    const fixed = await findAndFixErrors(userRequest, networkResponse);

    networkResponse.forEach((res) => {
      if (fixed[res.id])
        res.error = fixed[res.id];
    });

    const response = isArr ? networkResponse : networkResponse[0];
    reply.send(response);
  } catch (err) {
    fastify.log.error({ err, request: originalRequest }, 'Error handling request');
    
    // Логируем ошибку с деталями запроса
    const errorId = logErrorToFile(
      originalRequest, 
      { 
        message: err.message, 
        stack: err.stack,
        status: err.status,
        code: err.code,
        responseText: err.responseText 
      }
    );
    
    // Устанавливаем HTTP статус 502 для Bad Gateway, чтобы Nginx мог сделать фолбек
    reply.status(502).send({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: err.message || 'Internal server error',
        data: errorId ? `Error ID: ${errorId}` : undefined
      },
      id: Array.isArray(originalRequest) ? null : originalRequest?.id
    });
  }
}

async function findAndFixErrors(request, response) {
  const needToCallTxs = [];
  let fixedReverts = {};

  for (const res of response) {
    if (!res.error) continue;

    const req = request.find((r) => r.id === res.id);
    if (!req) throw new Error(`Request ${res.id} not found`);

    // if it was a gas estimation or raw tx, we need to make a call to get the revert reason
    if (req.method === "eth_estimateGas" || req.method === "eth_sendRawTransaction") {
      if (res.error.data && res.error.data.startsWith("Reverted")) {
        needToCallTxs.push({ ...req, method: "eth_call" });
      }
      else if (res.error.data && res.error.data.includes("Bad instruction")) {
        fixedReverts[res.id] = {
          code: res.error.code,
          message: `${res.error.data}. Most likely you need to change EVM version. Check documentation: https://docs.airdao.io/build-on-airdao/smart-contract-overview`,
          data: res.error.data
        }
      }
      else {
        fastify.log.warn({ error: res.error, request: req }, "Error not fixed");
      }
    }
    // if it was a call, we need to parse the revert reason
    else if (req.method === "eth_call") {
      const fixedError = parseCallError(res.error);
      if (!fixedError) {
        fastify.log.warn({ error: res.error, request: req }, "Can't parse error");
        continue;
      }

      fixedReverts[res.id] = fixedError;
    }
  }

  if (needToCallTxs.length > 0) {
    try {
      const anotherFixedReverts = await findAndFixErrors(needToCallTxs, await sendToNetwork(needToCallTxs));
      fixedReverts = { ...fixedReverts, ...anotherFixedReverts };
    } catch (err) {
      fastify.log.error({ err }, 'Error finding and fixing errors');
    }
  }

  return fixedReverts;
}

function parseCallError(error) {
  if (!error?.data?.startsWith("Reverted"))
    return;

  const reason = error.data.substring(9);

  const newError = {
    code: error.code,
    message: "execution reverted",
    data: reason
  }

  try {
    if (reason.startsWith("0x08c379a0")) {
      // https://github.com/authereum/eth-revert-reason/blob/e33f4df82426a177dbd69c0f97ff53153592809b/index.js#L93
      // "0x08c379a0" is `Error(string)` method signature, it's called by revert/require
      const parsed = abiCoder.decode(["string"], ethers.getBytes(reason).slice(4))[0];
      newError.message  += `: Error("${parsed}")`;
    }
    else if (reason.startsWith("0x4e487b71")) {
      const code = Number(abiCoder.decode(["uint256"], ethers.getBytes(reason).slice(4))[0]);
      newError.message += `: Panic(${code}) (${PanicReasons[code] ?? "Unknown panic code"})`;
    }
  } catch (err) {
    fastify.log.error({ err, error }, 'Error parsing call error');
    return error; // Возвращаем оригинальную ошибку при проблемах с парсингом
  }

  return newError;
}

async function sendToNetwork(request) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
    
    const response = await fetch(PROXY_TO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Network response was not ok: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.responseText = errorText;
      
      // Логируем ошибку с upstream сервера
      const errorId = logErrorToFile(
        request,
        { 
          message: `Upstream error: ${response.status} ${response.statusText}`,
          responseText: errorText,
          status: response.status
        }
      );
      
      error.errorId = errorId;
      throw error;
    }
    
    return response.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const error = new Error('Network request timeout');
      
      // Логируем таймаут
      const errorId = logErrorToFile(
        request,
        { message: 'Network request timeout', timeoutMs: TIMEOUT }
      );
      
      error.errorId = errorId;
      throw error;
    }
    
    fastify.log.error({ err: e, request }, "Error sending request to network");
    throw e;
  }
}

const PanicReasons = {
  0x00: "GENERIC_PANIC",
  0x01: "ASSERT_FALSE",
  0x11: "OVERFLOW",
  0x12: "DIVIDE_BY_ZERO",
  0x21: "ENUM_RANGE_ERROR",
  0x22: "BAD_STORAGE_DATA",
  0x31: "STACK_UNDERFLOW",
  0x32: "ARRAY_RANGE_ERROR",
  0x41: "OUT_OF_MEMORY",
  0x51: "UNINITIALIZED_FUNCTION_CALL",
}

// Запускаем сервер
main();