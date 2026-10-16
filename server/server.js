/**
 * Bethel Radio Relay Server
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
const listeners = new Set(); // HTTP audio listeners
const activeListeners = new Map(); // WebSocket listener clients: listenerId => { ws, name, id }
let currentCall = null; // { callerId, callerName, onAir: false, startTime: number }
let initSegment = null;
let recentChunks = [];
let awaitingInit = true;

const broadcastInfo = {
  isLive: false,
  djName: null,
  showTitle: null,
  trackTitle: null,
  trackArtist: null,
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
  broadcastInfo.trackTitle = null;
  broadcastInfo.trackArtist = null;
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
    trackTitle: broadcastInfo.trackTitle || broadcastInfo.showTitle,
    trackArtist: broadcastInfo.trackArtist || broadcastInfo.djName,
    listeners: listeners.size,
    activeCall: currentCall ? { onAir: currentCall.onAir, callerName: currentCall.callerName } : null,
    chatUsers: activeListeners.size,
    startedAt: broadcastInfo.startedAt,
    peakListeners: broadcastInfo.peakListeners,
    uptime: process.uptime(),
  });
}

function handleRoot(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><head><title>Bethel Radio Relay</title>
<style>body{font-family:sans-serif;background:#0a0a0f;color:#fff;text-align:center;padding:50px}a{color:#00CEC9}</style></head>
<body><h1>🟢 Bethel Radio Relay Server is running</h1>
<p>Status: <b>${broadcastInfo.isLive ? 'LIVE — ' + broadcastInfo.djName : 'Off air'}</b> · Listeners: ${listeners.size}</p>
<p><a href="/status">/status</a> · <a href="/health">/health</a> · <a href="/stream">/stream</a></p>
<p>DJ WebSocket endpoint: <code>wss://${req.headers.host}/ws</code></p></body></html>`);
}

// --- WebSocket server (DJ & Listeners) ---
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

  ws.isAlive = true;
  ws.role = null; // 'dj' or 'listener'
  ws.listenerId = null;
  ws.listenerName = null;
  ws.on('pong', () => { ws.isAlive = true; });

  // Drop sockets that never send handshake within 15s
  const authTimeout = setTimeout(() => {
    if (!ws.role) {
      sendJSON(ws, { type: 'auth_fail', message: 'Handshake timeout' });
      ws.close(4001, 'Handshake timeout');
    }
  }, 15000);

  // NOTE: ws v8 delivers ALL messages as Buffers; `isBinary` distinguishes text from audio.
  ws.on('message', (data, isBinary) => {
    // ---- Handshake / Role Registration ----
    if (!ws.role) {
      if (isBinary) return ws.close(4002, 'Handshake required');
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(4002, 'Bad handshake payload'); }

      // 1. DJ Handshake / Auth
      if (msg.type === 'auth') {
        if (msg.token !== CONFIG.djPassword) {
          log(`Auth failed from ${ip}`);
          sendJSON(ws, { type: 'auth_fail', message: 'Invalid DJ password' });
          return ws.close(4003, 'Invalid password');
        }

        // Replace previous DJ session if any
        if (djSocket && djSocket !== ws && djSocket.readyState === WebSocket.OPEN) {
          log('Replacing previous DJ session');
          sendJSON(djSocket, { type: 'error', message: 'Another DJ session took over' });
          djSocket.terminate();
          resetBroadcast();
        }

        clearTimeout(authTimeout);
        ws.role = 'dj';
        djSocket = ws;
        broadcastInfo.djName = (msg.djName || 'DJ').toString().slice(0, 50);
        log(`DJ authenticated: ${broadcastInfo.djName}`);
        sendJSON(ws, {
          type: 'auth_ok',
          listeners: listeners.size,
          chatUsers: activeListeners.size,
          activeCall: currentCall ? { callerId: currentCall.callerId, callerName: currentCall.callerName, onAir: currentCall.onAir } : null
        });

        // Notify active listeners that DJ is online
        for (const l of activeListeners.values()) {
          sendJSON(l.ws, { type: 'dj_status', online: true, djName: broadcastInfo.djName });
        }
        return;
      }

      // 2. Listener Join (No password needed)
      if (msg.type === 'listener_join' || msg.type === 'join') {
        clearTimeout(authTimeout);
        ws.role = 'listener';
        const listenerId = msg.listenerId || 'caller_' + Math.random().toString(36).substring(2, 9);
        const name = (msg.name || 'Listener').toString().slice(0, 40).trim() || 'Listener';
        ws.listenerId = listenerId;
        ws.listenerName = name;

        activeListeners.set(listenerId, { ws, name, id: listenerId, joinedAt: Date.now() });
        log(`Listener connected: ${name} (${listenerId}) [${activeListeners.size} online]`);

        sendJSON(ws, {
          type: 'listener_joined',
          listenerId,
          djOnline: !!(djSocket && djSocket.readyState === WebSocket.OPEN),
          djName: broadcastInfo.djName,
          isLive: broadcastInfo.isLive
        });

        // Inform DJ of new listener
        if (djSocket && djSocket.readyState === WebSocket.OPEN) {
          sendJSON(djSocket, {
            type: 'chat_user_joined',
            listenerId,
            name,
            onlineCount: activeListeners.size
          });
        }
        return;
      }

      sendJSON(ws, { type: 'error', message: 'Handshake required' });
      return ws.close(4002, 'Handshake required');
    }

    // ==========================================
    // ROLE: DJ
    // ==========================================
    if (ws.role === 'dj') {
      // Audio data (binary) from DJ
      if (isBinary) {
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
        return;
      }

      // Control messages (text) from DJ
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return log('Invalid control message from DJ'); }

      switch (msg.type) {
        case 'start':
          resetBroadcast();
          broadcastInfo.isLive = true;
          broadcastInfo.showTitle = (msg.showTitle || 'Live Show').toString().slice(0, 100);
          if (msg.trackTitle) broadcastInfo.trackTitle = msg.trackTitle.toString().slice(0, 100);
          if (msg.trackArtist) broadcastInfo.trackArtist = msg.trackArtist.toString().slice(0, 100);
          broadcastInfo.startedAt = new Date().toISOString();
          broadcastInfo.peakListeners = 0;
          log(`Broadcast STARTED: "${broadcastInfo.showTitle}" by ${broadcastInfo.djName}${broadcastInfo.trackTitle ? ` [Track: ${broadcastInfo.trackTitle}]` : ''}`);
          sendJSON(ws, { type: 'live_ok' });
          for (const l of activeListeners.values()) {
            sendJSON(l.ws, { type: 'station_live', isLive: true, showTitle: broadcastInfo.showTitle, djName: broadcastInfo.djName });
          }
          break;

        case 'stop':
          log('Broadcast STOPPED by DJ');
          resetBroadcast();
          for (const l of activeListeners.values()) {
            sendJSON(l.ws, { type: 'station_live', isLive: false });
          }
          break;

        case 'metadata':
          if (msg.showTitle !== undefined) broadcastInfo.showTitle = msg.showTitle ? msg.showTitle.toString().slice(0, 100) : 'Live Show';
          if (msg.trackTitle !== undefined) broadcastInfo.trackTitle = msg.trackTitle ? msg.trackTitle.toString().slice(0, 100) : null;
          if (msg.trackArtist !== undefined) broadcastInfo.trackArtist = msg.trackArtist ? msg.trackArtist.toString().slice(0, 100) : null;
          log(`Metadata updated: ${broadcastInfo.trackTitle || broadcastInfo.showTitle} - ${broadcastInfo.trackArtist || broadcastInfo.djName}`);
          break;

        case 'ping':
          sendJSON(ws, { type: 'pong', t: msg.t });
          break;

        // DJ Sending Chat Message
        case 'chat': {
          const text = (msg.text || '').toString().slice(0, 500).trim();
          if (!text) break;
          const recipientId = msg.recipientId;
          const chatPayload = {
            type: 'chat_message',
            fromId: 'dj',
            sender: broadcastInfo.djName || 'Bethel Radio DJ',
            text,
            isFromDJ: true,
            isDirect: !!recipientId && recipientId !== 'all',
            recipientId: recipientId || 'all',
            timestamp: Date.now()
          };

          if (recipientId && recipientId !== 'all') {
            const target = activeListeners.get(recipientId);
            if (target) sendJSON(target.ws, chatPayload);
            sendJSON(djSocket, { ...chatPayload, delivered: !!target });
          } else {
            for (const l of activeListeners.values()) {
              sendJSON(l.ws, chatPayload);
            }
            sendJSON(djSocket, { ...chatPayload, broadcast: true });
          }
          break;
        }

        // DJ Accepting incoming call
        case 'call_accept': {
          const callerId = msg.callerId;
          const caller = activeListeners.get(callerId);
          if (caller) {
            currentCall = { callerId, callerName: caller.name, startTime: Date.now(), onAir: false };
            log(`DJ accepted call from ${caller.name} (${callerId}) [Mode: Off-Air]`);
            sendJSON(caller.ws, { type: 'call_accepted', callerId, djName: broadcastInfo.djName });
            sendJSON(djSocket, { type: 'call_started', callerId, callerName: caller.name });
          } else {
            sendJSON(djSocket, { type: 'error', message: 'Caller is no longer connected' });
          }
          break;
        }

        // DJ Declining incoming call
        case 'call_decline': {
          const callerId = msg.callerId;
          const caller = activeListeners.get(callerId);
          if (caller) {
            sendJSON(caller.ws, { type: 'call_declined', reason: msg.reason || 'DJ is unable to take calls right now' });
          }
          if (currentCall && currentCall.callerId === callerId) currentCall = null;
          break;
        }

        // DJ Switching On-Air vs Off-Air mode
        case 'call_mode': {
          const isOnAir = !!msg.onAir;
          if (currentCall) {
            currentCall.onAir = isOnAir;
            log(`Call with ${currentCall.callerName} switched to: ${isOnAir ? '🔴 ON-AIR (Broadcasting)' : '🎧 OFF-AIR (Private)'}`);
            const caller = activeListeners.get(currentCall.callerId);
            if (caller) {
              sendJSON(caller.ws, { type: 'call_mode_changed', onAir: isOnAir });
            }
            sendJSON(djSocket, { type: 'call_mode_ack', onAir: isOnAir });
          }
          break;
        }

        // DJ Ending Call
        case 'call_hangup': {
          if (currentCall) {
            const caller = activeListeners.get(currentCall.callerId);
            if (caller) {
              sendJSON(caller.ws, { type: 'call_ended', reason: 'DJ ended the call' });
            }
            currentCall = null;
          }
          sendJSON(djSocket, { type: 'call_ended', reason: 'Call ended' });
          break;
        }

        // WebRTC Signaling from DJ to Caller
        case 'webrtc_signal': {
          const targetId = msg.targetId;
          const caller = activeListeners.get(targetId);
          if (caller) {
            sendJSON(caller.ws, {
              type: 'webrtc_signal',
              fromId: 'dj',
              signal: msg.signal
            });
          }
          break;
        }
      }
      return;
    }

    // ==========================================
    // ROLE: LISTENER
    // ==========================================
    if (ws.role === 'listener') {
      if (isBinary) return; // Audio is handled via WebRTC
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      switch (msg.type) {
        // Listener Chat Message
        case 'chat': {
          const text = (msg.text || '').toString().slice(0, 500).trim();
          if (!text) break;
          const chatMsg = {
            type: 'chat_message',
            fromId: ws.listenerId,
            sender: ws.listenerName || 'Listener',
            text,
            isFromDJ: false,
            timestamp: Date.now()
          };

          if (djSocket && djSocket.readyState === WebSocket.OPEN) {
            sendJSON(djSocket, chatMsg);
          }

          if (msg.directOnly) {
            sendJSON(ws, { ...chatMsg, deliveredToDJ: !!djSocket });
          } else {
            for (const l of activeListeners.values()) {
              sendJSON(l.ws, chatMsg);
            }
          }
          break;
        }

        // Listener Calling DJ
        case 'call_request': {
          if (!djSocket || djSocket.readyState !== WebSocket.OPEN) {
            sendJSON(ws, { type: 'call_failed', reason: 'DJ is currently off-air' });
            break;
          }
          if (currentCall && currentCall.callerId !== ws.listenerId) {
            sendJSON(ws, { type: 'call_busy', reason: 'DJ is currently taking another live call. Please try again shortly!' });
            break;
          }

          log(`Incoming call request from ${ws.listenerName} (${ws.listenerId})`);
          sendJSON(djSocket, {
            type: 'call_incoming',
            callerId: ws.listenerId,
            callerName: ws.listenerName
          });
          sendJSON(ws, { type: 'call_ringing' });
          break;
        }

        // Listener Cancels Call
        case 'call_cancel': {
          if (djSocket) {
            sendJSON(djSocket, { type: 'call_cancelled', callerId: ws.listenerId });
          }
          sendJSON(ws, { type: 'call_ended', reason: 'Call cancelled' });
          break;
        }

        // Listener Hangs Up
        case 'call_hangup': {
          if (currentCall && currentCall.callerId === ws.listenerId) {
            currentCall = null;
            if (djSocket) {
              sendJSON(djSocket, { type: 'call_ended', callerId: ws.listenerId, reason: 'Caller hung up' });
            }
          }
          sendJSON(ws, { type: 'call_ended', reason: 'You ended the call' });
          break;
        }

        // WebRTC Signaling from Listener to DJ
        case 'webrtc_signal': {
          if (djSocket && djSocket.readyState === WebSocket.OPEN) {
            sendJSON(djSocket, {
              type: 'webrtc_signal',
              fromId: ws.listenerId,
              signal: msg.signal
            });
          }
          break;
        }

        case 'ping':
          sendJSON(ws, { type: 'pong' });
          break;
      }
    }
  });

  ws.on('close', (code) => {
    clearTimeout(authTimeout);
    if (ws.role === 'dj' && djSocket === ws) {
      log(`DJ disconnected: ${broadcastInfo.djName} (code ${code})`);
      djSocket = null;
      if (currentCall) {
        const caller = activeListeners.get(currentCall.callerId);
        if (caller) sendJSON(caller.ws, { type: 'call_ended', reason: 'DJ disconnected' });
        currentCall = null;
      }
      for (const l of activeListeners.values()) {
        sendJSON(l.ws, { type: 'dj_status', online: false });
      }
      resetBroadcast();
    } else if (ws.role === 'listener' && ws.listenerId) {
      activeListeners.delete(ws.listenerId);
      log(`Listener left: ${ws.listenerName} (${ws.listenerId}) [${activeListeners.size} online]`);
      if (currentCall && currentCall.callerId === ws.listenerId) {
        currentCall = null;
        if (djSocket) {
          sendJSON(djSocket, { type: 'call_ended', callerId: ws.listenerId, reason: 'Caller disconnected' });
        }
      }
      if (djSocket) {
        sendJSON(djSocket, { type: 'chat_user_left', listenerId: ws.listenerId, onlineCount: activeListeners.size });
      }
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
  console.log(`🟢 Bethel Radio Relay Server on port ${CONFIG.port}`);
  console.log(`   DJ WebSocket : ws://localhost:${CONFIG.port}/ws`);
  console.log(`   Listen stream: http://localhost:${CONFIG.port}/stream`);
  console.log(`   Max listeners: ${CONFIG.maxListeners}`);
  console.log('='.repeat(50));
});
