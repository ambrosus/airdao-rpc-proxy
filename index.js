const cors = require("@fastify/cors");
const websocket = require('@fastify/websocket');
const formbody = require('@fastify/formbody');
const { WebSocket } = require('ws');
const { ethers } = require("ethers");

const fastify = require('fastify')({
  logger: {
    transport: process.env.NODE_ENV === 'development' 
      ? { target: 'pino-pretty' } 
      : undefined,
    level: process.env.LOG_LEVEL || 'info'
  }
});

const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus-dev.io';
const PORT = parseInt(process.env.PORT || '8545', 10);
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const MAX_PAYLOAD_SIZE = parseInt(process.env.MAX_PAYLOAD_SIZE || '10485760', 10); // 10MB
const WS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS || '5', 10);

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

async function shutdown() {
  fastify.log.info('Shutting down gracefully');
  try {
    await fastify.close();
    fastify.log.info('Server closed successfully');
    process.exit(0);
  } catch (err) {
    fastify.log.error('Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('uncaughtException', (err) => {
  fastify.log.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  fastify.log.error('Unhandled rejection:', reason);
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

  fastify.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() };
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
            fastify.log.error('Error terminating previous WebSocket:', err);
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
          
          if (pingInterval) clearInterval(pingInterval);
          pingInterval = setInterval(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
              try {
                wsClient.ping();
              } catch (err) {
                fastify.log.error('Error sending ping:', err);
              }
            }
          }, 30000);
        });

        wsClient.on('ping', () => {
          try {
            wsClient.pong();
          } catch (err) {
            fastify.log.error('Error sending pong:', err);
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
              fastify.log.error('Error sending message to client:', err);
            }
          }
        });

        wsClient.on('close', (code, reason) => {
          fastify.log.info('Backend WS closed:', code, reason);
          wsReady = false;
          clearInterval(pingInterval);
          
          if (connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
            const timeout = Math.min(1000 * Math.pow(2, connectionAttempts), 10000);
            fastify.log.info(`Reconnecting in ${timeout}ms...`);
            setTimeout(connectWs, timeout);
          }
        });

        wsClient.on('error', (error) => {
          fastify.log.error('Backend WS error:', error);
          wsReady = false;
        });

      } catch (err) {
        fastify.log.error('Error creating WebSocket:', err);
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
        fastify.log.error('Error processing WS message:', err);
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
      fastify.log.info('Client disconnected');
      clearInterval(pingInterval);
      messageQueue.clear(); // Clearing the queue on disconnection
      if (wsClient) {
        try {
          wsClient.close();
        } catch (err) {
          fastify.log.error('Error closing WebSocket:', err);
        }
      }
    });
  });

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error('Error starting server:', err);
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
  fastify.log.debug("Original user request:", JSON.stringify(request.body, undefined, 4));

  try {
    const { isArr, userRequest } = prepareUserRequest(request);
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), TIMEOUT)
    );
    
    const networkResponse = await Promise.race([
      sendToNetwork(userRequest),
      timeoutPromise
    ]);

    fastify.log.debug("User request and network response:", 
      JSON.stringify(userRequest, undefined, 4),
      JSON.stringify(networkResponse, undefined, 4)
    );

    const fixed = await findAndFixErrors(userRequest, networkResponse);

    networkResponse.forEach((res) => {
      if (fixed[res.id])
        res.error = fixed[res.id];
    });

    const response = isArr ? networkResponse : networkResponse[0];
    reply.send(response);
  } catch (err) {
    fastify.log.error('Error handling request:', err);
    reply.status(500).send({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: err.message || 'Internal server error'
      },
      id: Array.isArray(request.body) ? null : request.body?.id
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
        fastify.log.warn("Error, not fixed", res);
      }
    }
    // if it was a call, we need to parse the revert reason
    else if (req.method === "eth_call") {
      const fixedError = parseCallError(res.error);
      if (!fixedError) {
        fastify.log.warn("Can't parse error", res);
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
      fastify.log.error('Error finding and fixing errors:', err);
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
    fastify.log.error('Error parsing call error:', err);
    return error;
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
    
    return response.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error('Network request timeout');
    }
    
    fastify.log.error("Error sending request to network:", e);
    throw new Error('Network request failed: ' + e.message);
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

main();