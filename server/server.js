/**
 * Wave Radio Relay Server
 * DJ (WebSocket /ws) ──audio──▶ this server ──HTTP /stream──▶ listeners
 */
const http = require('http');
const WebSocket = require('ws');

const CONFIG = {
  port: process.env.PORT || 3000,
  djPassword: process.env.DJ_PASSWORD || 'waveradio2024',
  maxListeners: parseInt(process.env.MAX_LISTENERS || '500', 10),
  streamContentType: 'audio/webm;codecs=opus',
  heartbeatInterval: 25000, // keep proxies (Render/Railway/Nginx) from killing idle sockets
  statsInterval: 5000,      // push listener count to DJ
  bufferSize: 12,           // recent chunks (~3s at 250ms) for smooth listener joins
};

// --- State ---
let djSocket = null;
const listeners = new Set();
let initSegment = null;
let recentChunks = [];
let awaitingInit = true;

const broadcastInfo = {
  isLive: false,
  djName: null,
  showTitle: null,
  startedAt: null,
  peakListeners: 0,
};

function log(msg) {
  console.log(`[${new Date().toISOString().substr(11, 8)}] ${msg}`);
}

function sendJSON(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function endAllListeners() {
  for (const res of listeners) {
    try { res.end(); } catch (_) { /* ignore */ }
  }
  listeners.clear();
}

function resetBroadcast() {
  broadcastInfo.isLive = false;
  initSegment = null;
  recentChunks = [];
  awaitingInit = true;
  endAllListeners();
}

// --- HTTP server ---
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method Not Allowed');
  }

  const { pathname } = new URL(req.url, 'http://localhost');
  switch (pathname) {
    case '/stream': return handleStream(req, res);
    case '/status': return handleStatus(req, res);
    case '/health': return json(res, 200, { status: 'ok', uptime: process.uptime() });
    case '/':       return handleRoot(req, res);
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
  }
});

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' });
  res.end(JSON.stringify(obj));
}

function handleStream(req, res) {
  if (!broadcastInfo.isLive || !initSegment) {
    return json(res, 503, { error: 'No live broadcast' });
  }
  if (listeners.size >= CONFIG.maxListeners) {
    return json(res, 503, { error: 'Server capacity reached' });
  }

  res.writeHead(200, {
    'Content-Type': CONFIG.streamContentType,
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no', // disable proxy buffering so audio flows immediately
  });
  if (req.method === 'HEAD') return res.end();

  res.write(initSegment);
  for (const chunk of recentChunks) res.write(chunk);

  listeners.add(res);
  if (listeners.size > broadcastInfo.peakListeners) broadcastInfo.peakListeners = listeners.size;
  log(`Listener joined (${listeners.size} total)`);

  const cleanup = () => {
    if (listeners.delete(res)) log(`Listener left (${listeners.size} total)`);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

function handleStatus(req, res) {
  json(res, 200, {
    isLive: broadcastInfo.isLive && !!initSegment,
    djName: broadcastInfo.djName,
    showTitle: broadcastInfo.showTitle,
    listeners: listeners.size,
    startedAt: broadcastInfo.startedAt,
    peakListeners: broadcastInfo.peakListeners,
    uptime: process.uptime(),
  });
}

function handleRoot(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><title>Wave Radio Relay</title>
<style>body{font-family:sans-serif;background:#0a0a0f;color:#fff;text-align:center;padding:50px}a{color:#00CEC9}</style></head>
<body><h1>🟢 Wave Radio Relay Server is running</h1>
<p>Status: <b>${broadcastInfo.isLive ? 'LIVE — ' + broadcastInfo.djName : 'Off air'}</b> · Listeners: ${listeners.size}</p>
<p><a href="/status">/status</a> · <a href="/health">/health</a> · <a href="/stream">/stream</a></p>
<p>DJ WebSocket endpoint: <code>wss://${req.headers.host}/ws</code></p></body></html>`);
}

// --- WebSocket server (DJ) ---
// Accept connections on "/ws" AND "/" so a URL missing the /ws suffix still works.
const wss = new WebSocket.Server({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws' && pathname !== '/') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  log(`WebSocket connection from ${ip}`);

  let isAuthenticated = false;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Drop sockets that never authenticate
  const authTimeout = setTimeout(() => {
    if (!isAuthenticated) {
      sendJSON(ws, { type: 'auth_fail', message: 'Authentication timeout' });
      ws.close(4001, 'Auth timeout');
    }
  }, 10000);

  // NOTE: ws v8 delivers ALL messages as Buffers; `isBinary` distinguishes text from audio.
  ws.on('message', (data, isBinary) => {
    // ---- Authentication ----
    if (!isAuthenticated) {
      if (isBinary) return ws.close(4002, 'Auth required');
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(4002, 'Bad auth payload'); }

      if (msg.type !== 'auth') {
        sendJSON(ws, { type: 'auth_fail', message: 'First message must be auth' });
        return ws.close(4002, 'Auth required');
      }
      if (msg.token !== CONFIG.djPassword) {
        log(`Auth failed from ${ip}`);
        sendJSON(ws, { type: 'auth_fail', message: 'Invalid DJ password' });
        return ws.close(4003, 'Invalid password');
      }
      // Replace a stale/ghost DJ session rather than locking everyone out
      if (djSocket && djSocket !== ws && djSocket.readyState === WebSocket.OPEN) {
        log('Replacing previous DJ session');
        sendJSON(djSocket, { type: 'error', message: 'Another DJ session took over' });
        djSocket.terminate();
        resetBroadcast();
      }

      clearTimeout(authTimeout);
      isAuthenticated = true;
      djSocket = ws;
      broadcastInfo.djName = (msg.djName || 'DJ').toString().slice(0, 50);
      log(`DJ authenticated: ${broadcastInfo.djName}`);
      sendJSON(ws, { type: 'auth_ok', listeners: listeners.size });
      return;
    }

    // ---- Control messages (text) ----
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return log('Invalid control message'); }

      switch (msg.type) {
        case 'start':
          resetBroadcast();
          broadcastInfo.isLive = true;
          broadcastInfo.showTitle = (msg.showTitle || 'Live Show').toString().slice(0, 100);
          broadcastInfo.startedAt = new Date().toISOString();
          broadcastInfo.peakListeners = 0;
          log(`Broadcast STARTED: "${broadcastInfo.showTitle}" by ${broadcastInfo.djName}`);
          sendJSON(ws, { type: 'live_ok' });
          break;
        case 'stop':
          log('Broadcast STOPPED by DJ');
          resetBroadcast();
          break;
        case 'metadata':
          if (msg.showTitle) broadcastInfo.showTitle = msg.showTitle.toString().slice(0, 100);
          break;
        case 'ping':
          sendJSON(ws, { type: 'pong', t: msg.t });
          break;
      }
      return;
    }

    // ---- Audio data (binary) ----
    if (!broadcastInfo.isLive) return;

    if (awaitingInit) {
      initSegment = data; // first MediaRecorder chunk contains the WebM header
      awaitingInit = false;
      log(`Init segment captured (${data.length} bytes) — stream is now available`);
    } else {
      recentChunks.push(data);
      if (recentChunks.length > CONFIG.bufferSize) recentChunks.shift();
    }

    for (const res of listeners) {
      if (res.writableEnded || res.destroyed) { listeners.delete(res); continue; }
      res.write(data);
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimeout);
    if (isAuthenticated && djSocket === ws) {
      log(`DJ disconnected: ${broadcastInfo.djName} (code ${code})`);
      djSocket = null;
      resetBroadcast();
    }
  });

  ws.on('error', (err) => log(`WebSocket error: ${err.message}`));
});

// Heartbeat: terminate dead sockets, keep live ones open through proxies
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, CONFIG.heartbeatInterval);

// Push listener stats to the DJ
const stats = setInterval(() => {
  sendJSON(djSocket, { type: 'listener_count', count: listeners.size, peak: broadcastInfo.peakListeners });
}, CONFIG.statsInterval);

// --- Process handling ---
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack || err.message}`);
  if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') process.exit(1);
});

function shutdown(signal) {
  log(`${signal} received — shutting down`);
  clearInterval(heartbeat);
  clearInterval(stats);
  endAllListeners();
  for (const ws of wss.clients) ws.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(CONFIG.port, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🟢 Wave Radio Relay Server on port ${CONFIG.port}`);
  console.log(`   DJ WebSocket : ws://localhost:${CONFIG.port}/ws`);
  console.log(`   Listen stream: http://localhost:${CONFIG.port}/stream`);
  console.log(`   Max listeners: ${CONFIG.maxListeners}`);
  console.log('='.repeat(50));
});
