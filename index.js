const cors = require("@fastify/cors");
const websocket = require('@fastify/websocket');
const formbody = require('@fastify/formbody');
const { WebSocket } = require('ws');
const crypto = require('crypto');

// Настройка сервера fastify с минимальным логированием
const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'error',
    redact: ['req.headers.authorization']
  },
  disableRequestLogging: true
});

// Базовая конфигурация
const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus.io';
const PORT = parseInt(process.env.PORT || '6095', 10);
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const MAX_PAYLOAD_SIZE = parseInt(process.env.MAX_PAYLOAD_SIZE || '10485760', 10);
const WS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS || '10', 10);
const MAX_PARALLEL_CONNECTIONS = parseInt(process.env.MAX_PARALLEL_CONNECTIONS || '3', 10);

// Массив альтернативных RPC endpoints для WebSocket
const WS_ENDPOINT = PROXY_TO.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';

// Состояние для WebSocket соединений
let activeConnectionAttempts = 0;

// Подготовка запроса (замена input на data)
function prepareUserRequest(request) {
  const isArr = Array.isArray(request.body);
  const userRequest = isArr ? request.body : [request.body];

  userRequest.forEach((req) => {
    req?.params?.forEach((p) => {
      if (p?.input) {
        p.data = p.input;  // viem use `input` instead of `data`
        delete p.input;
      }
      delete p?.type;
      delete p?.chainId;
    });
  });

  return { isArr, userRequest };
}

// Обработчик HTTP запросов
async function handler(request, reply) {
  const originalRequest = request.body;
  const requestId = crypto.randomUUID();
  
  try {
    const { isArr, userRequest } = prepareUserRequest(request);
    
    // Таймаут для запроса
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
    
    const response = await fetch(PROXY_TO, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'AirDAO-RPC-Proxy/1.1',
        'X-Request-ID': requestId,
        'Connection': 'keep-alive'
      },
      body: JSON.stringify(userRequest),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Network error: ${response.status} ${response.statusText}`);
    }
    
    const networkResponse = await response.json();
    const finalResponse = isArr ? networkResponse : networkResponse[0];
    
    reply.send(finalResponse);
  } catch (err) {
    fastify.log.error({ err, requestId }, 'Error handling request');
    
    reply.status(500).send({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: err.message || 'Internal server error'
      },
      id: Array.isArray(originalRequest) ? null : originalRequest?.id
    });
  }
}

// Запуск сервера
async function main() {
  // Регистрация плагинов
  await fastify.register(cors, { 
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'] 
  });
  
  await fastify.register(websocket, {
    options: { maxPayload: MAX_PAYLOAD_SIZE }
  });
  
  await fastify.register(formbody, {
    bodyLimit: MAX_PAYLOAD_SIZE
  });

  // HTTP обработчик
  fastify.post('/', handler);

  // WebSocket обработчик
  fastify.get('/ws', { websocket: true }, (connection, req) => {
    let wsClient = null;
    let wsReady = false;
    let connectionAttempts = 0;
    const messageQueue = new Map();
    let pingInterval;
    let reconnectTimer;
    
    function connectWs() {
      // Проверка лимита параллельных соединений
      if (activeConnectionAttempts >= MAX_PARALLEL_CONNECTIONS) {
        setTimeout(connectWs, 1000 + Math.random() * 2000);
        return;
      }
      
      // Проверка максимального числа попыток
      if (connectionAttempts >= WS_RECONNECT_MAX_ATTEMPTS) {
        fastify.log.error('Max connection attempts reached for WebSocket');
        return;
      }

      activeConnectionAttempts++;
      connectionAttempts++;
      
      try {
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
          try {
            wsClient.terminate();
          } catch (err) {
            fastify.log.error('Error terminating previous WebSocket');
          }
        }
        
        wsClient = new WebSocket(WS_ENDPOINT, {
          handshakeTimeout: 5000,
          maxPayload: MAX_PAYLOAD_SIZE,
          perMessageDeflate: false,
          followRedirects: true
        });
        
        wsClient.on('open', () => {
          fastify.log.info('Backend WS connected successfully');
          wsReady = true;
          activeConnectionAttempts--;
          connectionAttempts = 0;
          
          // Установка ping интервала
          pingInterval = setInterval(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
              wsClient.ping();
            } else {
              clearInterval(pingInterval);
            }
          }, 30000);
        });

        wsClient.on('message', (data) => {
          if (connection.socket.readyState === WebSocket.OPEN) {
            try {
              const response = JSON.parse(data.toString());
              messageQueue.delete(response.id);
              connection.socket.send(data);
            } catch (err) {
              fastify.log.error('Error sending message to client');
            }
          }
        });

        wsClient.on('close', () => {
          wsReady = false;
          clearInterval(pingInterval);
          activeConnectionAttempts--;
          
          // Переподключение с задержкой
          reconnect();
        });

        wsClient.on('error', (error) => {
          fastify.log.error({ error: error.message }, 'WebSocket connection error');
          wsReady = false;
          
          if (connectionAttempts === 1) {
            activeConnectionAttempts--;
          }
        });

      } catch (err) {
        activeConnectionAttempts--;
        fastify.log.error('Error creating WebSocket');
        reconnect();
      }
    }

    // Функция переподключения с экспоненциальной задержкой
    function reconnect() {
      if (connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
        // Экспоненциальная задержка с элементом случайности
        const baseDelay = Math.min(1000 * Math.pow(2, connectionAttempts), 30000);
        const jitter = Math.random() * 2000;
        const timeout = Math.floor(baseDelay + jitter);
        
        reconnectTimer = setTimeout(connectWs, timeout);
      }
    }

    // Начинаем подключение
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

        // Проверяем, что запрос еще не в очереди
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

        // Подготавливаем запрос (input → data)
        const userRequest = prepareUserRequest({ body: request }).userRequest;
        messageQueue.set(requestId, userRequest);
        wsClient.send(JSON.stringify(userRequest));

        // Таймаут для запроса
        setTimeout(() => {
          if (messageQueue.has(requestId)) {
            messageQueue.delete(requestId);
            if (connection.socket.readyState === WebSocket.OPEN) {
              connection.socket.send(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: 'Request timeout'
                },
                id: requestId
              }));
            }
          }
        }, TIMEOUT);

      } catch (err) {
        fastify.log.error('Error processing WS message');

        if (connection.socket.readyState === WebSocket.OPEN) {
          connection.socket.send(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Internal server error'
            },
            id: null
          }));
        }
      }
    });

    connection.socket.on('close', () => {
      clearInterval(pingInterval);
      clearTimeout(reconnectTimer);
      messageQueue.clear();
      
      if (wsClient) {
        try {
          wsClient.close();
        } catch (err) {
          fastify.log.error('Error closing WebSocket');
        }
      }
    });
  });

  // Запуск сервера
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${PORT}, proxying to ${PROXY_TO}`);
  } catch (err) {
    fastify.log.error('Error starting server');
    process.exit(1);
  }
}

// Обработка завершения работы
async function shutdown() {
  fastify.log.info('Shutting down gracefully');
  try {
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error('Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Запускаем сервер
main();