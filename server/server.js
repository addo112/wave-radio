const http = require('http');
const WebSocket = require('ws');

const CONFIG = {
  port: process.env.PORT || 3000,
  djPassword: process.env.DJ_PASSWORD || 'waveradio2024',
  maxListeners: parseInt(process.env.MAX_LISTENERS || '500', 10),
  streamContentType: 'audio/webm;codecs=opus',
  corsOrigins: '*',
  healthCheckInterval: 30000,
  bufferSize: 10, // number of recent chunks to buffer for new listeners
};

// --- State Management ---
let djSocket = null;
const listeners = new Set();
let initSegment = null;
let recentChunks = [];
let isFirstChunk = true; // Tracks if next chunk is the init segment

const broadcastInfo = {
  isLive: false,
  djName: null,
  showTitle: null,
  startedAt: null,
  peakListeners: 0
};

// --- Logging Helper ---
function log(msg) {
  const time = new Date().toTimeString().split(' ')[0];
  console.log(`[${time}] ${msg}`);
}

function updatePeakListeners() {
  if (listeners.size > broadcastInfo.peakListeners) {
    broadcastInfo.peakListeners = listeners.size;
  }
}

// --- HTTP Server Setup ---
const server = http.createServer((req, res) => {
  // CORS Headers for all responses
  res.setHeader('Access-Control-Allow-Origin', CONFIG.corsOrigins);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  
  if (req.method === 'GET') {
    switch (url.pathname) {
      case '/stream':
        handleStreamRequest(req, res);
        break;
      case '/status':
        handleStatusRequest(req, res);
        break;
      case '/health':
        handleHealthRequest(req, res);
        break;
      case '/':
        handleRootRequest(req, res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
  } else {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  }
});

// --- HTTP Route Handlers ---
function handleStreamRequest(req, res) {
  if (!broadcastInfo.isLive) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No live broadcast' }));
  }

  if (listeners.size >= CONFIG.maxListeners) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server capacity reached' }));
  }

  res.writeHead(200, {
    'Content-Type': CONFIG.streamContentType,
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff'
  });

  // Write initialization segment to client if available
  if (initSegment) {
    res.write(initSegment);
  }

  // Write buffered chunks for smooth playback start
  for (const chunk of recentChunks) {
    res.write(chunk);
  }

  listeners.add(res);
  updatePeakListeners();
  
  if (listeners.size % 10 === 0 || listeners.size === 1) {
    log(`Listener joined. Total listeners: ${listeners.size}`);
  }

  const cleanup = () => {
    if (listeners.has(res)) {
      listeners.delete(res);
      if (listeners.size % 10 === 0 || listeners.size === 0) {
        log(`Listener disconnected. Total listeners: ${listeners.size}`);
      }
    }
  };

  req.on('close', cleanup);
  res.on('error', (err) => {
    // Ignore normal disconnection errors
    if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      log(`Listener stream error: ${err.message}`);
    }
    cleanup();
  });
}

function handleStatusRequest(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  });
  
  const status = {
    isLive: broadcastInfo.isLive,
    djName: broadcastInfo.djName,
    showTitle: broadcastInfo.showTitle,
    listeners: listeners.size,
    startedAt: broadcastInfo.startedAt,
    uptime: process.uptime(),
    peakListeners: broadcastInfo.peakListeners
  };
  
  res.end(JSON.stringify(status));
}

function handleHealthRequest(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
}

function handleRootRequest(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
    <head><title>Wave Radio Relay Server</title><style>body { font-family: sans-serif; text-align: center; padding: 50px; }</style></head>
    <body>
      <h1>Wave Radio Relay Server is running \uD83D\uDFE2</h1>
      <p>Endpoints: <a href="/status">/status</a> | <a href="/health">/health</a> | <a href="/stream">/stream</a></p>
    </body>
    </html>
  `);
}

// --- WebSocket Server (DJ Connection) ---
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  log(`Incoming WebSocket connection from ${req.socket.remoteAddress}`);
  
  let isAuthenticated = false;

  ws.on('message', (message) => {
    // 1. Handle authentication
    if (!isAuthenticated) {
      try {
        const data = JSON.parse(message);
        if (data.type === 'auth') {
          if (data.token !== CONFIG.djPassword) {
            log(`Auth failed for IP: ${req.socket.remoteAddress}`);
            ws.send(JSON.stringify({ type: 'auth_fail', message: 'Invalid token' }));
            ws.close();
            return;
          }
          if (djSocket && djSocket.readyState === WebSocket.OPEN) {
            log(`Auth rejected: Another DJ is broadcasting`);
            ws.send(JSON.stringify({ type: 'error', message: 'Another DJ is already broadcasting' }));
            ws.close();
            return;
          }
          
          isAuthenticated = true;
          djSocket = ws;
          broadcastInfo.djName = data.djName || 'Unknown DJ';
          log(`DJ authenticated: ${broadcastInfo.djName}`);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'First message must be auth' }));
          ws.close();
        }
      } catch (err) {
        log(`Invalid auth message payload: ${err.message}`);
        ws.close();
      }
      return;
    }

    // 2. Handle DJ Messages (After Auth)
    if (typeof message === 'string' || Buffer.isBuffer(message) === false) {
      // JSON Control Message
      try {
        const data = JSON.parse(message);
        switch (data.type) {
          case 'start':
            broadcastInfo.isLive = true;
            broadcastInfo.showTitle = data.showTitle || 'Live Show';
            broadcastInfo.startedAt = new Date().toISOString();
            initSegment = null;
            recentChunks = [];
            isFirstChunk = true;
            log(`Broadcast started: ${broadcastInfo.showTitle} by ${broadcastInfo.djName}`);
            break;
          case 'stop':
            broadcastInfo.isLive = false;
            initSegment = null;
            recentChunks = [];
            log(`Broadcast stopped by DJ.`);
            // End all listener streams
            listeners.forEach(res => res.end());
            listeners.clear();
            break;
          case 'metadata':
            broadcastInfo.showTitle = data.showTitle || broadcastInfo.showTitle;
            log(`Show title updated to: ${broadcastInfo.showTitle}`);
            break;
          default:
            log(`Unknown message type from DJ: ${data.type}`);
        }
      } catch (err) {
        log(`Invalid control message from DJ: ${err.message}`);
      }
    } else {
      // Binary Audio Data
      if (!broadcastInfo.isLive) return;

      if (isFirstChunk) {
        initSegment = message;
        isFirstChunk = false;
        log('Init segment captured.');
      } else {
        recentChunks.push(message);
        if (recentChunks.length > CONFIG.bufferSize) {
          recentChunks.shift();
        }
      }

      // Broadcast to all listeners
      for (const res of listeners) {
        // Write the chunk. If the write fails or the connection is ending, we don't crash, 
        // the error handler on res will remove the listener.
        res.write(message, (err) => {
          if (err) {
            listeners.delete(res);
          }
        });
      }
    }
  });

  ws.on('close', () => {
    if (isAuthenticated) {
      log(`DJ disconnected: ${broadcastInfo.djName}`);
      djSocket = null;
      broadcastInfo.isLive = false;
      initSegment = null;
      recentChunks = [];
      listeners.forEach(res => res.end());
      listeners.clear();
    }
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`);
  });
});

// --- System Error Handling & Shutdown ---
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught Exception:`, err);
  // Do not crash the server on socket errors
  if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
    process.exit(1);
  }
});

const gracefulShutdown = (signal) => {
  log(`Received ${signal}. Shutting down gracefully...`);
  listeners.forEach(res => res.end());
  listeners.clear();
  if (djSocket) {
    djSocket.close();
  }
  server.close(() => {
    log('Server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// --- Startup ---
server.listen(CONFIG.port, () => {
  console.log('='.repeat(50));
  console.log(`\uD83D\uDFE2 Wave Radio Relay Server running on port ${CONFIG.port}`);
  console.log(`- Max Listeners: ${CONFIG.maxListeners}`);
  console.log(`- Buffer Size:   ${CONFIG.bufferSize} chunks`);
  console.log('='.repeat(50));
});
