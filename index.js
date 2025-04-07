const cors = require("@fastify/cors");
const websocket = require('@fastify/websocket');
const formbody = require('@fastify/formbody');
const { WebSocket } = require('ws');
const { ethers } = require("ethers");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Fastify server with optimized logging
const fastify = require('fastify')({
  logger: {
    transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    level: process.env.LOG_LEVEL || 'info',
    redact: ['req.headers.authorization'],
    serializers: {
      err: (err) => ({
        type: err.constructor.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        statusCode: err.statusCode,
        ...(err.cause && { cause: err.cause })
      })
    }
  },
  disableRequestLogging: process.env.DISABLE_REQUEST_LOGGING === 'true',
  trustProxy: true // Trust X-Forwarded-For headers from nginx
});

// Configuration
const PROXY_TO = process.env.PROXY_TO || 'https://network.ambrosus-dev.io';
const PORT = parseInt(process.env.PORT || '8545', 10);
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000', 10);
const MAX_PAYLOAD_SIZE = parseInt(process.env.MAX_PAYLOAD_SIZE || '10485760', 10);
const WS_RECONNECT_MAX_ATTEMPTS = parseInt(process.env.WS_RECONNECT_MAX_ATTEMPTS || '20', 10);
const ERROR_LOG_PATH = process.env.ERROR_LOG_PATH || '/app/logs/errors';
const MAX_ERROR_LOGS = parseInt(process.env.MAX_ERROR_LOGS || '1000', 10);
const LOG_ROTATION_INTERVAL = parseInt(process.env.LOG_ROTATION_INTERVAL || '86400000', 10);
const MAX_PARALLEL_CONNECTIONS = parseInt(process.env.MAX_PARALLEL_CONNECTIONS || '5', 10);
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000', 10);
const MEMORY_METRICS_INTERVAL = parseInt(process.env.MEMORY_METRICS_INTERVAL || '60000', 10);
const HTTP_KEEP_ALIVE_TIMEOUT = parseInt(process.env.HTTP_KEEP_ALIVE_TIMEOUT || '5000', 10);
const ERROR_SAMPLING_RATE = parseFloat(process.env.ERROR_SAMPLING_RATE || '1.0'); // 1.0 = log all errors

// RPC endpoints for WebSocket
const RPC_ENDPOINTS = [
  PROXY_TO.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws',
  'wss://network.ambrosus.io/ws',
  ...(process.env.ADDITIONAL_WS_ENDPOINTS ? process.env.ADDITIONAL_WS_ENDPOINTS.split(',') : [])
];

// Metrics for monitoring
const metrics = {
  httpRequestsTotal: 0,
  httpRequestsSuccess: 0,
  httpRequestsError: 0,
  httpRequestDurations: [], // last 100 requests
  wsConnectionsTotal: 0,
  wsConnectionsActive: 0,
  wsConnectionsSuccessful: 0,
  wsConnectionsFailed: 0,
  wsConnectionsDuration: [],
  wsMessagesReceived: 0,
  wsMessagesSent: 0,
  wsReconnectAttempts: 0,
  wsQuickDisconnects: 0,
  startTime: Date.now(),
  lastMemoryUsage: process.memoryUsage(),
  memoryUsageHistory: [],
  currentEndpointIndex: 0,
  endpointStats: RPC_ENDPOINTS.map(url => ({
    url,
    connectAttempts: 0,
    successfulConnects: 0,
    failedConnects: 0,
    totalErrors: 0,
    lastConnectTime: null,
    averageConnectionDuration: 0
  })),
  
  updateMemoryMetrics() {
    this.lastMemoryUsage = process.memoryUsage();
    
    if (this.memoryUsageHistory.length > 30) { // Reduced from 60 to 30 entries
      this.memoryUsageHistory.shift();
    }
    
    this.memoryUsageHistory.push({
      timestamp: Date.now(),
      rss: Math.round(this.lastMemoryUsage.rss / 1024 / 1024),
      heapTotal: Math.round(this.lastMemoryUsage.heapTotal / 1024 / 1024),
      heapUsed: Math.round(this.lastMemoryUsage.heapUsed / 1024 / 1024)
    });
  },
  
  updateEndpointStats(index, isConnected, duration = null) {
    const endpoint = this.endpointStats[index];
    endpoint.connectAttempts++;
    
    if (isConnected) {
      endpoint.successfulConnects++;
      endpoint.lastConnectTime = Date.now();
      
      if (duration !== null) {
        endpoint.averageConnectionDuration = 
          (endpoint.averageConnectionDuration * (endpoint.successfulConnects - 1) + duration) / 
          endpoint.successfulConnects;
      }
    } else {
      endpoint.failedConnects++;
      endpoint.totalErrors++;
    }
  },
  
  addHttpRequestDuration(duration) {
    if (this.httpRequestDurations.length >= 100) {
      this.httpRequestDurations.shift();
    }
    this.httpRequestDurations.push(duration);
  },
  
  addWsConnectionDuration(duration) {
    if (this.wsConnectionsDuration.length >= 50) { // Reduced from 100 to 50
      this.wsConnectionsDuration.shift();
    }
    this.wsConnectionsDuration.push(duration);
  },
  
  getStats() {
    const httpAvgDuration = this.httpRequestDurations.length > 0 
      ? this.httpRequestDurations.reduce((a, b) => a + b, 0) / this.httpRequestDurations.length
      : 0;
      
    const wsAvgDuration = this.wsConnectionsDuration.length > 0
      ? this.wsConnectionsDuration.reduce((a, b) => a + b, 0) / this.wsConnectionsDuration.length
      : 0;
      
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      http: {
        requestsTotal: this.httpRequestsTotal,
        requestsSuccess: this.httpRequestsSuccess,
        requestsError: this.httpRequestsError,
        successRate: this.httpRequestsTotal > 0 
          ? (this.httpRequestsSuccess / this.httpRequestsTotal * 100).toFixed(2) + '%' 
          : '0%',
        averageRequestDuration: httpAvgDuration.toFixed(2) + 'ms'
      },
      websocket: {
        connectionsTotal: this.wsConnectionsTotal,
        connectionsActive: this.wsConnectionsActive,
        connectionsSuccessful: this.wsConnectionsSuccessful,
        connectionsFailed: this.wsConnectionsFailed,
        messagesReceived: this.wsMessagesReceived,
        messagesSent: this.wsMessagesSent,
        reconnectAttempts: this.wsReconnectAttempts,
        quickDisconnects: this.wsQuickDisconnects,
        averageConnectionDuration: wsAvgDuration.toFixed(2) + 's',
        currentEndpoint: RPC_ENDPOINTS[this.currentEndpointIndex]
      },
      system: {
        memoryUsage: {
          rss: Math.round(this.lastMemoryUsage.rss / 1024 / 1024) + 'MB',
          heapTotal: Math.round(this.lastMemoryUsage.heapTotal / 1024 / 1024) + 'MB',
          heapUsed: Math.round(this.lastMemoryUsage.heapUsed / 1024 / 1024) + 'MB'
        },
        loadAvg1m: os.loadavg()[0].toFixed(2),
        cpus: os.cpus().length,
        platform: os.platform(),
        hostname: os.hostname()
      },
      endpoints: this.endpointStats
    };
  }
};

// Update memory metrics periodically
setInterval(() => {
  metrics.updateMemoryMetrics();
}, MEMORY_METRICS_INTERVAL);

// State variables for endpoint switching
let currentEndpointIndex = 0;
let endpointFailureCount = 0;
let activeConnectionAttempts = 0;
let quickDisconnects = 0;
const QUICK_DISCONNECT_THRESHOLD = 5; // seconds
const QUICK_DISCONNECT_COUNT_LIMIT = 10;

const abiCoder = ethers.AbiCoder.defaultAbiCoder();

// Create error log directory
if (!fs.existsSync(ERROR_LOG_PATH)) {
  try {
    fs.mkdirSync(ERROR_LOG_PATH, { recursive: true });
    fastify.log.info(`Created error log directory: ${ERROR_LOG_PATH}`);
  } catch (err) {
    fastify.log.error({ err }, 'Failed to create error log directory');
  }
}

// Clean up old logs
async function cleanupOldLogs() {
  try {
    const files = fs.readdirSync(ERROR_LOG_PATH)
      .filter(file => file.endsWith('.json'))
      .map(file => ({
        name: file,
        path: path.join(ERROR_LOG_PATH, file),
        time: fs.statSync(path.join(ERROR_LOG_PATH, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);
    
    if (files.length > MAX_ERROR_LOGS) {
      const filesToRemove = files.slice(MAX_ERROR_LOGS);
      for (const file of filesToRemove) {
        fs.unlinkSync(file.path);
      }
      fastify.log.info(`Cleaned up ${filesToRemove.length} old error logs`);
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error cleaning up old logs');
  }
}

// Set up periodic log cleanup
setInterval(cleanupOldLogs, LOG_ROTATION_INTERVAL);
cleanupOldLogs();

// Graceful shutdown
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

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  fastify.log.error({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  fastify.log.error({ reason }, 'Unhandled rejection');
});
// Check network status
async function checkNetworkStatus() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(PROXY_TO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'net_version', params: [], id: crypto.randomUUID() }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    return response.ok;
  } catch (err) {
    fastify.log.error({ err }, 'Network check failed');
    return false;
  }
}

// Log errors to file with error sampling
function logErrorToFile(requestData, errorData) {
  // Error sampling to reduce disk I/O
  if (ERROR_SAMPLING_RATE < 1.0 && Math.random() > ERROR_SAMPLING_RATE) {
    return null;
  }

  const timestamp = new Date().toISOString();
  let requestHash = '';
  
  try {
    if (typeof requestData === 'object') {
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
  
  // Truncate large objects for logging
  const truncateForLog = (obj, maxDepth = 2, currentDepth = 0) => {
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
    
    if (typeof obj === 'string' && obj.length > 500) { // Reduced from 1000 to 500
      return obj.substring(0, 500) + '... [truncated]';
    }
    
    return obj;
  };
  
  const logData = {
    timestamp,
    requestHash,
    proxy_to: PROXY_TO,
    request: truncateForLog(requestData),
    error: truncateForLog(errorData)
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

// Prepare user request
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

// HTTP request handler
async function handler(request, reply) {
  const originalRequest = request.body;
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  
  metrics.httpRequestsTotal++;
  
  fastify.log.debug({ request: originalRequest, requestId }, "Incoming RPC request");

  try {
    const { isArr, userRequest } = prepareUserRequest(request);
    
    // Add timeout for request
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Request timeout')), TIMEOUT)
    );
    
    // Execute request with timeout
    const networkResponse = await Promise.race([
      sendToNetwork(userRequest, requestId),
      timeoutPromise
    ]);

    fastify.log.debug({ 
      requestId,
      duration: Date.now() - startTime
    }, "Network response received");

    const fixed = await findAndFixErrors(userRequest, networkResponse);

    networkResponse.forEach((res) => {
      if (fixed[res.id])
        res.error = fixed[res.id];
    });

    const response = isArr ? networkResponse : networkResponse[0];
    
    metrics.httpRequestsSuccess++;
    metrics.addHttpRequestDuration(Date.now() - startTime);
    
    reply.send(response);
  } catch (err) {
    metrics.httpRequestsError++;
    metrics.addHttpRequestDuration(Date.now() - startTime);
    
    fastify.log.error({ err, requestId, duration: Date.now() - startTime }, 'Error handling request');
    
    // Log error with request details
    const errorId = logErrorToFile(
      originalRequest, 
      { 
        message: err.message, 
        stack: err.stack,
        status: err.status,
        code: err.code,
        responseText: err.responseText,
        duration: Date.now() - startTime
      }
    );
    
    reply.status(500).send({
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

// Find and fix errors in response
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

// Parse call error
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
      const parsed = abiCoder.decode(["string"], ethers.getBytes(reason).slice(4))[0];
      newError.message  += `: Error("${parsed}")`;
    }
    else if (reason.startsWith("0x4e487b71")) {
      const code = Number(abiCoder.decode(["uint256"], ethers.getBytes(reason).slice(4))[0]);
      newError.message += `: Panic(${code}) (${PanicReasons[code] ?? "Unknown panic code"})`;
    }
  } catch (err) {
    fastify.log.error({ err, error }, 'Error parsing call error');
    return error;
  }

  return newError;
}

// Send request to network
async function sendToNetwork(request, requestId = null) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);
    
    const response = await fetch(PROXY_TO, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'AirDAO-RPC-Proxy/1.1',
        'X-Request-ID': requestId || crypto.randomUUID(),
        'Connection': 'keep-alive'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Network response was not ok: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.responseText = errorText;
      
      // Log upstream server error
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
      
      // Log timeout
      const errorId = logErrorToFile(
        request,
        { message: 'Network request timeout', timeoutMs: TIMEOUT }
      );
      
      error.errorId = errorId;
      throw error;
    }
    
    fastify.log.error({ err: e }, "Error sending request to network");
    throw e;
  }
}

// Panic reason codes
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
// Start the server
async function main() {
  // Register plugins
  await fastify.register(cors, { 
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
  });
  
  await fastify.register(websocket, {
    options: {
      maxPayload: MAX_PAYLOAD_SIZE
    }
  });
  
  await fastify.register(formbody, {
    bodyLimit: MAX_PAYLOAD_SIZE
  });

  // Set server keep-alive timeout
  fastify.server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT;
  fastify.server.headersTimeout = HTTP_KEEP_ALIVE_TIMEOUT + 1000;

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    const networkCheck = await checkNetworkStatus();
    
    return { 
      status: networkCheck ? 'ok' : 'degraded', 
      timestamp: new Date().toISOString(),
      proxy_to: PROXY_TO,
      uptime: process.uptime(),
      connections: {
        websocket: fastify.websocketServer ? fastify.websocketServer.clients.size : 0,
        activeAttempts: activeConnectionAttempts
      },
      networkStatus: networkCheck ? 'ok' : 'issues detected',
      currentEndpoint: RPC_ENDPOINTS[currentEndpointIndex]
    };
  });

  // Metrics endpoint
  fastify.get('/metrics', async (request, reply) => {
    metrics.updateMemoryMetrics();
    return metrics.getStats();
  });

  // Error stats endpoint
  fastify.get('/errors/stats', async (request, reply) => {
    try {
      if (!fs.existsSync(ERROR_LOG_PATH)) {
        return { count: 0, errors: [] };
      }
      
      // Group errors by type/hash for more compact representation
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
      
      // Error hash map for grouping
      const errorGroups = new Map();
      const recentErrors = [];
      
      // Process only the last 100 errors for statistics
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
          
          // Add error example if there are few
          if (group.examples.length < 3) {
            group.examples.push({
              id: fileInfo.file.replace('.json', ''),
              timestamp: data.timestamp,
              requestHash: data.requestHash
            });
          }
          
          // Save most recent errors
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
          fastify.log.warn({ file: fileInfo.file }, 'Failed to parse error log file');
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

  // Detailed error info endpoint
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
    let healthCheckInterval;
    let reconnectTimer;
    let connectionStartTime = null;
    
    // Increase connection count in metrics
    metrics.wsConnectionsTotal++;
    metrics.wsConnectionsActive++;

    function connectWs() {
      // Check parallel connection limit
      if (activeConnectionAttempts >= MAX_PARALLEL_CONNECTIONS) {
        fastify.log.warn(`Too many active connection attempts (${activeConnectionAttempts}), deferring...`);
        setTimeout(connectWs, 1000 + Math.random() * 1000);
        return;
      }
      
      // Check max attempts
      if (connectionAttempts >= WS_RECONNECT_MAX_ATTEMPTS) {
        fastify.log.error('Max connection attempts reached for WebSocket connection');
        return;
      }

      activeConnectionAttempts++;
      metrics.wsReconnectAttempts++;
      
      // More aggressive connection break detection
      let isConnected = false;
      let connectionTimer;
      
      connectionAttempts++;
      // Choose current endpoint based on index
      const wsUrl = RPC_ENDPOINTS[currentEndpointIndex];
      
      // Update endpoint metrics
      metrics.updateEndpointStats(currentEndpointIndex, false);
      
      fastify.log.info({
        attempt: connectionAttempts,
        maxAttempts: WS_RECONNECT_MAX_ATTEMPTS,
        url: wsUrl,
        activeAttempts: activeConnectionAttempts
      }, `Attempting to connect to backend WS`);
      
      try {
        if (wsClient && wsClient.readyState !== WebSocket.CLOSED) {
          try {
            wsClient.terminate();
            fastify.log.info('Previous WebSocket terminated');
          } catch (err) {
            fastify.log.error({ err }, 'Error terminating previous WebSocket');
          }
        }
        
        // Set timer to cancel connection if not established in time
        connectionTimer = setTimeout(() => {
          if (!isConnected && wsClient) {
            fastify.log.warn({ url: wsUrl }, 'Connection timeout, terminating WebSocket');
            try {
              wsClient.terminate();
            } catch (e) {
              // Ignore error on close
            }
            activeConnectionAttempts--;
          }
        }, 5000);
        
        wsClient = new WebSocket(wsUrl, {
          handshakeTimeout: 5000,
          maxPayload: MAX_PAYLOAD_SIZE,
          perMessageDeflate: false,
          followRedirects: true,
          headers: {
            'User-Agent': 'AirDAO-RPC-Proxy/1.1'
          }
        });
        
        wsClient.on('open', () => {
          connectionStartTime = Date.now();
          isConnected = true;
          clearTimeout(connectionTimer);
          
          fastify.log.info({ url: wsUrl }, 'Backend WS connected successfully');
          wsReady = true;
          
          // Update metrics
          metrics.wsConnectionsSuccessful++;
          metrics.updateEndpointStats(currentEndpointIndex, true);
          activeConnectionAttempts--;
          
          // Reset attempt counter after successful connection
          if (connectionAttempts > 1) {
            fastify.log.info(`Connection successful after ${connectionAttempts} attempts, resetting counter`);
          }
          connectionAttempts = 0;
          endpointFailureCount = 0; // Reset endpoint failure counter
          
          // Set ping interval after successful connection
          if (pingInterval) clearInterval(pingInterval);
          pingInterval = setInterval(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
              try {
                fastify.log.debug('Sending ping to backend WebSocket');
                wsClient.ping();
              } catch (err) {
                fastify.log.error({ err }, 'Error sending ping');
              }
            } else {
              fastify.log.warn('Ping interval running but WebSocket not open, cleaning up');
              clearInterval(pingInterval);
            }
          }, 30000);
          
          // For robustness, set a timer to check connection state
          if (healthCheckInterval) clearInterval(healthCheckInterval);
          healthCheckInterval = setInterval(() => {
            if (!wsReady || !wsClient || wsClient.readyState !== WebSocket.OPEN) {
              fastify.log.warn('WebSocket health check failed, attempting to reconnect');
              clearInterval(healthCheckInterval);
              reconnect();
            }
          }, HEALTH_CHECK_INTERVAL);
        });

        wsClient.on('ping', () => {
          try {
            wsClient.pong();
            fastify.log.debug('Responded to ping from server');
          } catch (err) {
            fastify.log.error({ err }, 'Error sending pong');
          }
        });
        
        wsClient.on('pong', () => {
          fastify.log.debug('Received pong from server');
        });

        wsClient.on('message', (data) => {
          // Increase received messages counter
          metrics.wsMessagesReceived++;
          
          if (connection.socket.readyState === WebSocket.OPEN) {
            try {
              const response = JSON.parse(data.toString());
              // Remove request from queue after receiving response
              messageQueue.delete(response.id);
              connection.socket.send(data);
              metrics.wsMessagesSent++;
            } catch (err) {
              fastify.log.error({ err }, 'Error sending message to client');
            }
          } else {
            fastify.log.warn('Received message from backend but client socket not open');
          }
        });

        wsClient.on('close', (code, reason) => {
          clearTimeout(connectionTimer);
          const connectionDuration = connectionStartTime ? (Date.now() - connectionStartTime) / 1000 : 0;
          
          // If connection was short, increase quick disconnect counter
          if (isConnected && connectionDuration < QUICK_DISCONNECT_THRESHOLD) {
            quickDisconnects++;
            metrics.wsQuickDisconnects++;
            
            fastify.log.warn({ 
              quickDisconnects, 
              threshold: QUICK_DISCONNECT_THRESHOLD,
              limit: QUICK_DISCONNECT_COUNT_LIMIT
            }, 'Quick disconnect detected');
            
            // If many quick disconnects, change endpoint
            if (quickDisconnects >= QUICK_DISCONNECT_COUNT_LIMIT) {
              currentEndpointIndex = (currentEndpointIndex + 1) % RPC_ENDPOINTS.length;
              metrics.currentEndpointIndex = currentEndpointIndex;
              fastify.log.info(`Switching to alternate endpoint due to quick disconnects: ${RPC_ENDPOINTS[currentEndpointIndex]}`);
              quickDisconnects = 0;
            }
          } else if (isConnected) {
            // If connection was stable for some time, decrease quick disconnect counter
            quickDisconnects = Math.max(0, quickDisconnects - 1);
            
            // Save connection duration for metrics
            metrics.addWsConnectionDuration(connectionDuration);
          }
          
          if (isConnected) {
            activeConnectionAttempts--;
          }
          
          fastify.log.info({ 
            code, 
            reason: reason?.toString() || 'No reason provided',
            wasConnected: isConnected,
            duration: connectionDuration
          }, 'Backend WS closed');
          
          wsReady = false;
          clearInterval(pingInterval);
          clearInterval(healthCheckInterval);
          
          reconnect();
        });

        wsClient.on('error', (error) => {
          clearTimeout(connectionTimer);
          
          // Log full error information
          const errorDetails = {
            name: error.name,
            message: error.message,
            code: error.code,
            type: error.type,
            errno: error.errno,
            syscall: error.syscall,
            hostname: error.hostname,
            address: error.address,
            port: error.port,
            url: wsUrl
          };
          
          // Increase endpoint error counter
          endpointFailureCount++;
          
          // If endpoint consistently fails, switch to another
          if (endpointFailureCount >= 5) {
            currentEndpointIndex = (currentEndpointIndex + 1) % RPC_ENDPOINTS.length;
            metrics.currentEndpointIndex = currentEndpointIndex;
            fastify.log.info(`Switching to alternate endpoint due to errors: ${RPC_ENDPOINTS[currentEndpointIndex]}`);
            endpointFailureCount = 0;
          }
          
          fastify.log.error({ error: errorDetails }, 'Backend WS error');
          wsReady = false;
          
          metrics.wsConnectionsFailed++;
          
          // Save error to file for analysis
          logErrorToFile({ type: 'ws_connection', url: wsUrl }, errorDetails);
          
          // If error occurred before connection, close event won't fire
          // so initiate reconnection here
          if (!isConnected) {
            activeConnectionAttempts--;
            reconnect();
          }
        });

      } catch (err) {
        clearTimeout(connectionTimer);
        activeConnectionAttempts--;
        fastify.log.error({ err, url: wsUrl }, 'Error creating WebSocket');
        reconnect();
      }
    }

    // Reconnect function with exponential backoff
    function reconnect() {
      if (connectionAttempts < WS_RECONNECT_MAX_ATTEMPTS) {
        // Use exponential backoff with random element to avoid thundering herd effect
        const baseDelay = Math.min(1000 * Math.pow(1.5, connectionAttempts), 30000);
        const jitter = Math.random() * 1000;
        const timeout = Math.floor(baseDelay + jitter);
        
        fastify.log.info({ timeout, attempt: connectionAttempts + 1 }, `Reconnecting in ${timeout}ms...`);
        reconnectTimer = setTimeout(connectWs, timeout);
      } else {
        fastify.log.error('WebSocket reconnection failed after maximum attempts');
        
        // After reaching max attempts, set a long timer
        // for possible recovery in future
        fastify.log.info('Scheduling reconnection attempt in 5 minutes');
        connectionAttempts = 0; // Reset counter for next cycle
        reconnectTimer = setTimeout(connectWs, 5 * 60 * 1000);
      }
    }

    // Start connection
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

        // Check if request is already in queue
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

        // Apply same transformations as for HTTP requests
        const { userRequest } = prepareUserRequest({ body: request });
        messageQueue.set(requestId, userRequest);
        wsClient.send(JSON.stringify(userRequest));

        // Timeout for request
        setTimeout(() => {
          if (messageQueue.has(requestId)) {
            messageQueue.delete(requestId);
            if (connection.socket.readyState === WebSocket.OPEN) {
              // Log timeout error
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
        
        // Log unhandled error
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
      clearInterval(healthCheckInterval);
      clearTimeout(reconnectTimer);
      messageQueue.clear();
      
      // Update metrics
      metrics.wsConnectionsActive--;
      
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

// Start the server
main();
