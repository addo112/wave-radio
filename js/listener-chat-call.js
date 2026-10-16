/**
 * Bethel Radio - Listener Direct Chat & Live Studio Call (WhatsApp-style)
 * Allows listeners to chat directly with the DJ and place live audio calls to the studio.
 * Supports Off-Air private screening and Live On-Air broadcasting managed by the DJ.
 */

(function () {
  'use strict';

  const DEFAULT_RELAY_WS = 'wss://wave-radio-relay.onrender.com/ws';

  function getRelayWsUrl() {
    const saved = localStorage.getItem('relay-ws-url') || localStorage.getItem('relay-server-url');
    if (saved) {
      let url = saved.trim().replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
      if (!/^[a-z]+:\/\//i.test(url)) url = 'wss://' + url;
      if (!url.endsWith('/ws')) url = url.replace(/\/$/, '') + '/ws';
      return url;
    }
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
    if (isLocal) return 'ws://localhost:3000/ws';
    return DEFAULT_RELAY_WS;
  }

  class StationHub {
    constructor() {
      this.wsUrl = getRelayWsUrl();
      this.ws = null;
      this.listenerId = localStorage.getItem('bethel_listener_id') || 'listener_' + Math.random().toString(36).substring(2, 9);
      this.listenerName = localStorage.getItem('bethel_listener_name') || '';
      localStorage.setItem('bethel_listener_id', this.listenerId);

      this.isConnected = false;
      this.djOnline = false;
      this.djName = 'DJ';
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;

      // WebRTC Call State
      this.peerConnection = null;
      this.localAudioStream = null;
      this.remoteAudio = new Audio();
      this.remoteAudio.autoplay = true;
      this.isCallActive = false;
      this.isCalling = false;
      this.callStartTime = null;
      this.callTimerInterval = null;
      this.isOnAir = false;
      this.isMicMuted = false;
      this.ringbackOsc = null;
      this.ringbackGain = null;
      this.audioCtx = null;
      this.previousPlayerVolume = 80;
      this.wasPlayerMuted = false;

      // Chat State
      this.unreadMessages = 0;
      this.isChatOpen = false;

      this.buildUI();
      this.connectWebSocket();
    }

    // ========================================================
    // UI BUILDER
    // ========================================================
    buildUI() {
      // Inject CSS
      const style = document.createElement('style');
      style.id = 'station-hub-styles';
      style.textContent = `
        /* Floating Action Hub */
        .station-hub-bar {
          position: fixed;
          bottom: 24px;
          right: 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          z-index: 9999;
          font-family: 'Inter', -apple-system, sans-serif;
        }
        .hub-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 12px 20px;
          border-radius: 50px;
          font-weight: 700;
          font-size: 14px;
          color: #fff;
          cursor: pointer;
          border: 1px solid rgba(255, 255, 255, 0.2);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          box-shadow: 0 8px 25px rgba(0, 0, 0, 0.35);
          outline: none;
        }
        .hub-btn:hover {
          transform: translateY(-3px);
          box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
        }
        .hub-btn-chat {
          background: rgba(108, 92, 231, 0.85);
          position: relative;
        }
        .hub-btn-chat:hover {
          background: rgba(108, 92, 231, 1);
        }
        .hub-btn-call {
          background: linear-gradient(135deg, #00CEC9, #0984e3);
          border-color: rgba(0, 206, 201, 0.4);
        }
        .hub-btn-call.online {
          animation: hubCallPulse 2s infinite;
        }
        @keyframes hubCallPulse {
          0% { box-shadow: 0 0 0 0 rgba(0, 206, 201, 0.7); }
          70% { box-shadow: 0 0 0 14px rgba(0, 206, 201, 0); }
          100% { box-shadow: 0 0 0 0 rgba(0, 206, 201, 0); }
        }
        .hub-badge {
          position: absolute;
          top: -6px;
          right: -6px;
          background: #e74c3c;
          color: white;
          font-size: 11px;
          font-weight: 800;
          min-width: 20px;
          height: 20px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 5px;
          border: 2px solid #0a0a0f;
          display: none;
        }

        /* Modals & Overlays */
        .hub-modal-overlay {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(10, 10, 15, 0.75);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
          padding: 16px;
          font-family: 'Inter', -apple-system, sans-serif;
        }
        .hub-modal-overlay.open {
          opacity: 1;
          pointer-events: auto;
        }
        .hub-glass-card {
          background: rgba(26, 26, 46, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 20px;
          box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
          width: 100%;
          color: #fff;
          overflow: hidden;
        }

        /* Direct Chat Drawer / Modal */
        .chat-card {
          max-width: 440px;
          height: 600px;
          max-height: 85vh;
          display: flex;
          flex-direction: column;
        }
        .chat-header {
          padding: 16px 20px;
          background: rgba(0, 0, 0, 0.25);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .chat-header h3 {
          margin: 0;
          font-size: 1.1rem;
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
        }
        .chat-status-pill {
          font-size: 12px;
          padding: 3px 10px;
          border-radius: 20px;
          background: rgba(255,255,255,0.08);
          color: #a0a0b8;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .chat-status-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          background: #7f8c8d;
        }
        .chat-status-dot.online {
          background: #2ecc71;
          box-shadow: 0 0 8px #2ecc71;
        }
        .chat-close-btn {
          background: none;
          border: none;
          color: #a0a0b8;
          font-size: 22px;
          cursor: pointer;
          line-height: 1;
          padding: 4px;
        }
        .chat-close-btn:hover { color: #fff; }
        .chat-messages {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .chat-bubble {
          max-width: 82%;
          padding: 10px 14px;
          border-radius: 14px;
          font-size: 13.5px;
          line-height: 1.45;
          word-break: break-word;
        }
        .chat-bubble.mine {
          align-self: flex-end;
          background: linear-gradient(135deg, #6C5CE7, #8e44ad);
          color: #fff;
          border-bottom-right-radius: 3px;
        }
        .chat-bubble.dj {
          align-self: flex-start;
          background: linear-gradient(135deg, rgba(0, 206, 201, 0.25), rgba(108, 92, 231, 0.35));
          border: 1px solid rgba(0, 206, 201, 0.5);
          color: #fff;
          border-bottom-left-radius: 3px;
          box-shadow: 0 4px 15px rgba(0, 206, 201, 0.15);
        }
        .chat-bubble.others {
          align-self: flex-start;
          background: rgba(255, 255, 255, 0.08);
          color: #e0e0e0;
          border-bottom-left-radius: 3px;
        }
        .bubble-meta {
          font-size: 11px;
          margin-bottom: 3px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .bubble-sender {
          font-weight: 700;
          color: #00CEC9;
        }
        .chat-bubble.dj .bubble-sender {
          color: #FD79A8;
        }
        .bubble-time {
          color: rgba(255, 255, 255, 0.5);
          font-size: 10px;
        }
        .chat-input-area {
          padding: 14px 16px;
          background: rgba(0, 0, 0, 0.35);
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          display: flex;
          gap: 10px;
        }
        .chat-input-area input {
          flex: 1;
          background: rgba(255, 255, 255, 0.07);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 25px;
          padding: 10px 18px;
          color: #fff;
          font-size: 14px;
          outline: none;
          font-family: inherit;
        }
        .chat-input-area input:focus {
          border-color: #6C5CE7;
        }
        .chat-send-btn {
          width: 42px;
          height: 42px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6C5CE7, #00CEC9);
          border: none;
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 15px;
          transition: transform 0.2s;
        }
        .chat-send-btn:hover {
          transform: scale(1.08);
        }

        /* WhatsApp-Style Calling Modal */
        .call-card {
          max-width: 380px;
          text-align: center;
          padding: 36px 24px;
          position: relative;
        }
        .call-avatar-wrap {
          position: relative;
          width: 120px;
          height: 120px;
          margin: 0 auto 24px;
        }
        .call-avatar {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: linear-gradient(135deg, #6C5CE7, #00CEC9);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 48px;
          color: white;
          position: relative;
          z-index: 2;
          box-shadow: 0 10px 30px rgba(108, 92, 231, 0.4);
        }
        .call-pulse-ring {
          position: absolute;
          top: -15px; left: -15px; right: -15px; bottom: -15px;
          border-radius: 50%;
          border: 2px solid rgba(0, 206, 201, 0.6);
          animation: callWave 2s infinite ease-out;
          z-index: 1;
        }
        .call-pulse-ring:nth-child(2) {
          animation-delay: 0.7s;
        }
        @keyframes callWave {
          0% { transform: scale(0.85); opacity: 1; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        .call-title {
          font-size: 1.5rem;
          font-weight: 800;
          margin-bottom: 6px;
        }
        .call-subtitle {
          color: #a0a0b8;
          font-size: 14px;
          margin-bottom: 18px;
        }
        .call-status-badge {
          display: inline-block;
          padding: 6px 16px;
          border-radius: 30px;
          font-size: 13px;
          font-weight: 700;
          margin-bottom: 24px;
          transition: all 0.3s;
        }
        .call-status-badge.ringing {
          background: rgba(241, 196, 15, 0.2);
          color: #f1c40f;
          border: 1px solid rgba(241, 196, 15, 0.4);
        }
        .call-status-badge.off-air {
          background: rgba(0, 206, 201, 0.2);
          color: #00CEC9;
          border: 1px solid rgba(0, 206, 201, 0.4);
        }
        .call-status-badge.on-air {
          background: rgba(231, 76, 60, 0.85);
          color: white;
          border: 1px solid #ff7675;
          animation: onAirFlash 1.5s infinite;
        }
        @keyframes onAirFlash {
          0%, 100% { box-shadow: 0 0 10px rgba(231,76,60,0.5); }
          50% { box-shadow: 0 0 25px rgba(231,76,60,0.9); }
        }
        .call-air-notice {
          font-size: 12.5px;
          color: #cbd5e1;
          background: rgba(0, 0, 0, 0.3);
          border-radius: 10px;
          padding: 10px;
          margin-bottom: 24px;
          line-height: 1.4;
        }
        .call-controls {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 24px;
          margin-top: 10px;
        }
        .call-btn {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          color: white;
          transition: transform 0.2s, background-color 0.2s;
        }
        .call-btn:hover { transform: scale(1.1); }
        .call-btn-mute {
          background: rgba(255, 255, 255, 0.15);
        }
        .call-btn-mute.active {
          background: #e74c3c;
        }
        .call-btn-end {
          background: #e74c3c;
          box-shadow: 0 6px 20px rgba(231, 76, 60, 0.4);
          width: 64px;
          height: 64px;
          font-size: 24px;
        }
        .call-btn-end:hover {
          background: #c0392b;
        }

        /* Responsive */
        @media (max-width: 600px) {
          .station-hub-bar {
            bottom: 16px; right: 16px;
            gap: 8px;
          }
          .hub-btn {
            padding: 10px 16px;
            font-size: 13px;
          }
          .chat-card {
            height: 90vh;
          }
        }
      `;
      document.head.appendChild(style);

      // Create Floating Action Bar
      const bar = document.createElement('div');
      bar.className = 'station-hub-bar';
      bar.innerHTML = `
        <button id="btn-hub-chat" class="hub-btn hub-btn-chat" title="Direct Chat with DJ">
          <i class="fas fa-comment-dots"></i>
          <span>Chat with DJ</span>
          <span id="hub-chat-badge" class="hub-badge">0</span>
        </button>
        <button id="btn-hub-call" class="hub-btn hub-btn-call" title="Call the Studio">
          <i class="fas fa-phone-alt"></i>
          <span id="hub-call-text">Call Studio</span>
        </button>
      `;
      document.body.appendChild(bar);

      // Create Chat Modal
      const chatModal = document.createElement('div');
      chatModal.id = 'hub-chat-modal';
      chatModal.className = 'hub-modal-overlay';
      chatModal.innerHTML = `
        <div class="hub-glass-card chat-card">
          <div class="chat-header">
            <h3><i class="fas fa-comments text-gradient"></i> Bethel Radio Chat</h3>
            <div class="chat-status-pill">
              <span id="hub-chat-dot" class="chat-status-dot"></span>
              <span id="hub-dj-status-text">DJ Off-Air</span>
            </div>
            <button class="chat-close-btn" id="btn-close-chat">&times;</button>
          </div>
          <div class="chat-messages" id="hub-chat-messages">
            <div style="text-align: center; color: #a0a0b8; padding: 40px 20px; font-size: 13px;">
              <i class="fas fa-broadcast-tower" style="font-size: 32px; color: #6C5CE7; margin-bottom: 12px; display: block;"></i>
              Welcome to Bethel Radio direct chat! Send message requests and shoutouts directly to the DJ.
            </div>
          </div>
          <div class="chat-input-area">
            <input type="text" id="hub-chat-input" placeholder="Message Bethel Radio DJ..." maxlength="500">
            <button class="chat-send-btn" id="btn-hub-send-chat" title="Send Message">
              <i class="fas fa-paper-plane"></i>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(chatModal);

      // Create Calling Modal (WhatsApp style)
      const callModal = document.createElement('div');
      callModal.id = 'hub-call-modal';
      callModal.className = 'hub-modal-overlay';
      callModal.innerHTML = `
        <div class="hub-glass-card call-card">
          <div class="call-avatar-wrap">
            <div class="call-pulse-ring"></div>
            <div class="call-pulse-ring"></div>
            <div class="call-avatar">
              <i class="fas fa-broadcast-tower"></i>
            </div>
          </div>
          <div class="call-title">Bethel Radio Studio</div>
          <div class="call-subtitle" id="hub-call-subtitle">Calling DJ Studio...</div>
          
          <div id="hub-call-badge" class="call-status-badge ringing">
            <i class="fas fa-phone-volume"></i> <span id="hub-call-status-text">Connecting...</span>
          </div>

          <div class="call-air-notice" id="hub-call-air-notice">
            🎧 <strong>Private Screening</strong>: You will talk privately with the DJ first. The DJ will decide when to put you live on air.
          </div>

          <div class="call-controls">
            <button id="btn-call-mute" class="call-btn call-btn-mute" title="Mute Microphone">
              <i class="fas fa-microphone"></i>
            </button>
            <button id="btn-call-hangup" class="call-btn call-btn-end" title="End Call">
              <i class="fas fa-phone-slash"></i>
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(callModal);

      // Bind Listeners
      document.getElementById('btn-hub-chat').addEventListener('click', () => this.toggleChat());
      document.getElementById('btn-close-chat').addEventListener('click', () => this.toggleChat(false));
      document.getElementById('btn-hub-send-chat').addEventListener('click', () => this.sendChatMessage());
      document.getElementById('hub-chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.sendChatMessage();
      });

      document.getElementById('btn-hub-call').addEventListener('click', () => this.initiateCall());
      document.getElementById('btn-call-hangup').addEventListener('click', () => this.endCall(true));
      document.getElementById('btn-call-mute').addEventListener('click', () => this.toggleMicMute());
    }

    // ========================================================
    // WEBSOCKET SIGNALING & CHAT CONNECTION
    // ========================================================
    connectWebSocket() {
      if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        console.warn('StationHub WS connection error:', err);
        this.scheduleReconnect();
        return;
      }

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.sendJSON({
          type: 'listener_join',
          listenerId: this.listenerId,
          name: this.listenerName || 'Listener'
        });
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data);
          this.handleServerMessage(msg);
        } catch (e) {
          console.error('StationHub bad message', e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.setDJStatus(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.isConnected = false;
      };
    }

    scheduleReconnect() {
      clearTimeout(this.reconnectTimer);
      const delay = Math.min(20000, 3000 * Math.pow(1.5, this.reconnectAttempts++));
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), delay);
    }

    sendJSON(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    handleServerMessage(msg) {
      switch (msg.type) {
        case 'listener_joined':
          this.setDJStatus(msg.djOnline, msg.djName);
          break;

        case 'dj_status':
          this.setDJStatus(msg.online, msg.djName);
          break;

        case 'station_live':
          if (msg.isLive) {
            this.setDJStatus(true, msg.djName);
          }
          break;

        case 'chat_message':
          this.renderChatMessage(msg);
          break;

        // Call responses from DJ
        case 'call_ringing':
          this.setCallRingingState();
          break;

        case 'call_accepted':
          this.onCallAccepted(msg);
          break;

        case 'call_declined':
          this.onCallDeclined(msg.reason);
          break;

        case 'call_failed':
        case 'call_busy':
          this.onCallFailed(msg.reason);
          break;

        case 'call_mode_changed':
          this.setAirMode(msg.onAir);
          break;

        case 'call_ended':
          this.onRemoteCallEnded(msg.reason);
          break;

        case 'webrtc_signal':
          this.handleWebRTCSignal(msg.signal);
          break;
      }
    }

    setDJStatus(isOnline, name) {
      this.djOnline = !!isOnline;
      if (name) this.djName = name;

      const dot = document.getElementById('hub-chat-dot');
      const text = document.getElementById('hub-dj-status-text');
      const callBtn = document.getElementById('btn-hub-call');

      if (this.djOnline) {
        if (dot) dot.className = 'chat-status-dot online';
        if (text) text.textContent = `🎙️ ${this.djName} Online`;
        if (callBtn) callBtn.classList.add('online');
      } else {
        if (dot) dot.className = 'chat-status-dot';
        if (text) text.textContent = 'DJ Off-Air';
        if (callBtn) callBtn.classList.remove('online');
      }
    }

    // ========================================================
    // DIRECT CHAT SYSTEM
    // ========================================================
    toggleChat(forceOpen) {
      const modal = document.getElementById('hub-chat-modal');
      const isOpen = forceOpen !== undefined ? forceOpen : !modal.classList.contains('open');
      this.isChatOpen = isOpen;

      if (isOpen) {
        modal.classList.add('open');
        this.unreadMessages = 0;
        this.updateBadge();
        const input = document.getElementById('hub-chat-input');
        if (input) setTimeout(() => input.focus(), 100);
      } else {
        modal.classList.remove('open');
      }
    }

    promptNameIfNeeded() {
      if (this.listenerName) return this.listenerName;
      const entered = prompt('Please enter your name for the DJ:', 'Listener');
      this.listenerName = (entered || 'Listener').trim().slice(0, 30);
      localStorage.setItem('bethel_listener_name', this.listenerName);
      if (this.isConnected) {
        this.sendJSON({
          type: 'listener_join',
          listenerId: this.listenerId,
          name: this.listenerName
        });
      }
      return this.listenerName;
    }

    sendChatMessage() {
      const input = document.getElementById('hub-chat-input');
      const text = (input.value || '').trim();
      if (!text) return;

      this.promptNameIfNeeded();
      this.sendJSON({
        type: 'chat',
        text: text
      });

      input.value = '';
    }

    renderChatMessage(msg) {
      const container = document.getElementById('hub-chat-messages');
      if (!container) return;

      const isMine = msg.fromId === this.listenerId;
      const isDJ = msg.isFromDJ;

      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${isMine ? 'mine' : (isDJ ? 'dj' : 'others')}`;

      const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const senderName = isMine ? 'You' : (isDJ ? `🎙️ ${msg.sender || 'DJ'} (Studio)` : (msg.sender || 'Listener'));

      bubble.innerHTML = `
        <div class="bubble-meta">
          <span class="bubble-sender">${this.escapeHTML(senderName)}</span>
          <span class="bubble-time">${timeStr}</span>
        </div>
        <div class="bubble-text">${this.escapeHTML(msg.text)}</div>
      `;

      container.appendChild(bubble);
      container.scrollTop = container.scrollHeight;

      if (!this.isChatOpen && !isMine) {
        this.unreadMessages++;
        this.updateBadge();
        if (window.uiManager && typeof window.uiManager.showToast === 'function') {
          window.uiManager.showToast(`💬 New message from ${msg.sender}: "${msg.text.slice(0, 40)}"`, 'info', 4000);
        }
      }
    }

    updateBadge() {
      const badge = document.getElementById('hub-chat-badge');
      if (!badge) return;
      if (this.unreadMessages > 0) {
        badge.textContent = this.unreadMessages;
        badge.style.display = 'flex';
      } else {
        badge.style.display = 'none';
      }
    }

    // ========================================================
    // WHATSAPP-STYLE CALL SYSTEM (WEBRTC)
    // ========================================================
    async initiateCall() {
      if (this.isCalling || this.isCallActive) return;

      this.promptNameIfNeeded();

      if (!this.isConnected) {
        alert('Connecting to Bethel Radio studio... Please try again in a few moments.');
        this.connectWebSocket();
        return;
      }

      // Request microphone access
      try {
        this.localAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        });
      } catch (err) {
        alert('Microphone permission is required to call the DJ studio.');
        console.error('Mic access denied:', err);
        return;
      }

      // Lower/mute background radio stream so caller has zero audio feedback
      this.muteRadioStreamForCall();

      this.isCalling = true;
      this.openCallModal('Connecting to studio...', 'Calling DJ...', 'ringing');
      this.startRingbackTone();

      this.sendJSON({
        type: 'call_request',
        callerId: this.listenerId,
        callerName: this.listenerName
      });
    }

    openCallModal(subtitle, statusText, statusClass) {
      const modal = document.getElementById('hub-call-modal');
      const sub = document.getElementById('hub-call-subtitle');
      const badge = document.getElementById('hub-call-badge');
      const st = document.getElementById('hub-call-status-text');

      if (sub) sub.textContent = subtitle;
      if (st) st.textContent = statusText;
      if (badge) badge.className = `call-status-badge ${statusClass}`;

      modal.classList.add('open');
    }

    setCallRingingState() {
      const sub = document.getElementById('hub-call-subtitle');
      const badge = document.getElementById('hub-call-badge');
      const st = document.getElementById('hub-call-status-text');

      if (sub) sub.textContent = 'Studio phone is ringing...';
      if (st) st.textContent = 'Ringing...';
      if (badge) badge.className = 'call-status-badge ringing';
    }

    async onCallAccepted(msg) {
      this.stopRingbackTone();
      this.isCalling = false;
      this.isCallActive = true;
      this.callStartTime = Date.now();

      this.startCallDurationTimer();
      this.setAirMode(false); // Starts in Off-Air mode

      // Initialize WebRTC
      await this.createPeerConnection();
    }

    async createPeerConnection() {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        });
        this.peerConnection = pc;

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            this.sendJSON({
              type: 'webrtc_signal',
              signal: { candidate: event.candidate }
            });
          }
        };

        pc.ontrack = (event) => {
          if (event.streams && event.streams[0]) {
            this.remoteAudio.srcObject = event.streams[0];
            this.remoteAudio.play().catch(e => console.warn('Caller remote audio play error:', e));
          }
        };

        // Add local mic track
        if (this.localAudioStream) {
          this.localAudioStream.getAudioTracks().forEach(track => {
            pc.addTrack(track, this.localAudioStream);
          });
        }

        // Caller creates offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.sendJSON({
          type: 'webrtc_signal',
          signal: { sdp: pc.localDescription }
        });
      } catch (err) {
        console.error('Failed to create WebRTC PeerConnection:', err);
        alert('Could not establish voice connection with the studio.');
        this.endCall(true);
      }
    }

    async handleWebRTCSignal(signal) {
      if (!this.peerConnection) return;
      try {
        if (signal.sdp) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        } else if (signal.candidate) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.error('Caller WebRTC signal error:', err);
      }
    }

    setAirMode(isOnAir) {
      this.isOnAir = !!isOnAir;
      const badge = document.getElementById('hub-call-badge');
      const notice = document.getElementById('hub-call-air-notice');
      const st = document.getElementById('hub-call-status-text');

      if (this.isOnAir) {
        if (badge) badge.className = 'call-status-badge on-air';
        if (st) st.innerHTML = '<i class="fas fa-dot-circle"></i> YOU ARE LIVE ON AIR!';
        if (notice) {
          notice.innerHTML = '🔴 <strong>LIVE BROADCAST</strong>: You are currently live on the radio! The entire Bethel Radio audience is listening.';
          notice.style.background = 'rgba(231, 76, 60, 0.25)';
          notice.style.border = '1px solid #e74c3c';
        }
      } else {
        if (badge) badge.className = 'call-status-badge off-air';
        if (st) st.innerHTML = '<i class="fas fa-headset"></i> Connected (Private Screening)';
        if (notice) {
          notice.innerHTML = '🎧 <strong>Off-Air Mode</strong>: You are speaking privately with the DJ. You are not on the live broadcast yet.';
          notice.style.background = 'rgba(0, 0, 0, 0.3)';
          notice.style.border = 'none';
        }
      }
    }

    startCallDurationTimer() {
      clearInterval(this.callTimerInterval);
      const sub = document.getElementById('hub-call-subtitle');
      this.callTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
        const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        if (sub) sub.textContent = `Call Duration: ${m}:${s}`;
      }, 1000);
    }

    toggleMicMute() {
      if (!this.localAudioStream) return;
      this.isMicMuted = !this.isMicMuted;
      this.localAudioStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMicMuted;
      });

      const btn = document.getElementById('btn-call-mute');
      if (btn) {
        btn.className = `call-btn call-btn-mute ${this.isMicMuted ? 'active' : ''}`;
        btn.innerHTML = this.isMicMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
      }
    }

    onCallDeclined(reason) {
      this.stopRingbackTone();
      alert(`The DJ is unable to take your call right now: ${reason || 'Busy'}`);
      this.endCall(false);
    }

    onCallFailed(reason) {
      this.stopRingbackTone();
      alert(`Could not complete call: ${reason || 'Studio unavailable'}`);
      this.endCall(false);
    }

    onRemoteCallEnded(reason) {
      this.stopRingbackTone();
      if (this.isCallActive || this.isCalling) {
        alert(reason || 'The DJ has ended the call. Thank you for calling Bethel Radio!');
      }
      this.endCall(false);
    }

    endCall(notifyServer = true) {
      this.stopRingbackTone();
      clearInterval(this.callTimerInterval);

      if (notifyServer && (this.isCalling || this.isCallActive)) {
        this.sendJSON({
          type: this.isCalling ? 'call_cancel' : 'call_hangup'
        });
      }

      if (this.peerConnection) {
        try { this.peerConnection.close(); } catch (_) {}
        this.peerConnection = null;
      }

      if (this.localAudioStream) {
        this.localAudioStream.getTracks().forEach(track => track.stop());
        this.localAudioStream = null;
      }

      this.remoteAudio.srcObject = null;
      this.isCalling = false;
      this.isCallActive = false;
      this.isOnAir = false;
      this.isMicMuted = false;

      // Close call modal
      const modal = document.getElementById('hub-call-modal');
      if (modal) modal.classList.remove('open');

      // Restore radio player volume
      this.restoreRadioStreamAfterCall();
    }

    muteRadioStreamForCall() {
      if (window.radioPlayer && window.radioPlayer.audio) {
        this.wasPlayerMuted = window.radioPlayer.audio.muted;
        window.radioPlayer.audio.muted = true;
      }
    }

    restoreRadioStreamAfterCall() {
      if (window.radioPlayer && window.radioPlayer.audio) {
        window.radioPlayer.audio.muted = this.wasPlayerMuted;
      }
    }

    startRingbackTone() {
      try {
        if (!this.audioCtx) {
          this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume();
        }

        const playRing = () => {
          if (!this.isCalling || !this.audioCtx) return;
          const osc1 = this.audioCtx.createOscillator();
          const osc2 = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();

          osc1.frequency.value = 440;
          osc2.frequency.value = 480;
          gain.gain.setValueAtTime(0.04, this.audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 1.5);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(this.audioCtx.destination);

          osc1.start();
          osc2.start();
          osc1.stop(this.audioCtx.currentTime + 1.5);
          osc2.stop(this.audioCtx.currentTime + 1.5);
        };

        playRing();
        this.ringbackInterval = setInterval(() => {
          if (this.isCalling) playRing();
          else clearInterval(this.ringbackInterval);
        }, 3000);
      } catch (e) {
        console.warn('Could not generate ringback tone:', e);
      }
    }

    stopRingbackTone() {
      if (this.ringbackInterval) {
        clearInterval(this.ringbackInterval);
        this.ringbackInterval = null;
      }
    }

    escapeHTML(str) {
      if (!str) return '';
      return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      }[tag] || tag));
    }
  }

  // Initialize StationHub on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    window.stationHub = new StationHub();
  });
})();
