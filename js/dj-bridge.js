/**
 * DJ Bridge - Detects live DJ broadcasts and switches the player stream
 * Add to index.html: <script src="js/dj-bridge.js"></script>
 */
class DJBridge {
  constructor(relayServerUrl) {
    this.relayUrl = relayServerUrl || 'http://localhost:3000';
    this.isLive = false;
    this.pollInterval = null;
    this.liveIndicator = null;
    this.init();
  }

  init() {
    // Create live DJ indicator element
    this.liveIndicator = document.createElement('div');
    this.liveIndicator.id = 'dj-live-indicator';
    this.liveIndicator.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: rgba(231,76,60,0.9);
      color: white;
      padding: 10px 20px;
      border-radius: 30px;
      font-weight: bold;
      font-size: 14px;
      z-index: 1001;
      display: none;
      align-items: center;
      gap: 8px;
      backdrop-filter: blur(10px);
      box-shadow: 0 4px 15px rgba(231,76,60,0.4);
      animation: pulse 2s infinite;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
    `;
    this.liveIndicator.innerHTML = '<span style="display:inline-block;width:8px;height:8px;background:#fff;border-radius:50%;animation:liveDot 1.5s infinite;"></span> DJ LIVE';
    this.liveIndicator.title = 'Click to switch to live stream';
    this.liveIndicator.addEventListener('click', () => this.switchToLive());
    
    // Add keyframes
    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(231,76,60, 0.7); }
        70% { box-shadow: 0 0 0 10px rgba(231,76,60, 0); }
        100% { box-shadow: 0 0 0 0 rgba(231,76,60, 0); }
      }
      @keyframes liveDot {
        0% { opacity: 1; }
        50% { opacity: 0.3; }
        100% { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(this.liveIndicator);

    // Start polling server status
    this.checkStatus();
    this.pollInterval = setInterval(() => this.checkStatus(), 10000);
  }

  async checkStatus() {
    try {
      const res = await fetch(`${this.relayUrl}/status`, { mode: 'cors' });
      if (!res.ok) throw new Error('Server offline');
      const data = await res.json();
      
      if (data.isLive && !this.isLive) {
        this.isLive = true;
        this.liveIndicator.style.display = 'flex';
        this.liveIndicator.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:#fff;border-radius:50%;animation:liveDot 1.5s infinite;"></span> 🎙️ ${data.djName || 'DJ'} is LIVE`;
        
        // Auto-switch to live stream
        this.switchToLive();
        
        if (window.uiManager && typeof window.uiManager.showToast === 'function') {
          window.uiManager.showToast(`🎙️ ${data.djName || 'A DJ'} just went live!`, 'info', 5000);
        }
      } else if (!data.isLive && this.isLive) {
        this.isLive = false;
        this.liveIndicator.style.display = 'none';
        
        // Switch back to default stream
        this.switchToDefault();
        
        if (window.uiManager && typeof window.uiManager.showToast === 'function') {
          window.uiManager.showToast('Live broadcast ended. Switching back to regular programming.', 'info', 5000);
        }
      }

      // Update show title if live
      if (data.isLive && data.showTitle) {
        const titleEl = document.getElementById('now-playing-title');
        const artistEl = document.getElementById('now-playing-artist');
        if (titleEl) titleEl.textContent = data.showTitle;
        if (artistEl) artistEl.textContent = `Live with ${data.djName || 'DJ'}`;
      }
    } catch (e) {
      // Server not reachable, that's okay
      console.debug('Relay server status fetch error:', e);
    }
  }

  switchToLive() {
    if (window.radioPlayer && window.radioPlayer.audio) {
      const liveStreamUrl = `${this.relayUrl}/stream`;
      const wasPlaying = !window.radioPlayer.audio.paused;
      window.radioPlayer.audio.src = liveStreamUrl;
      window.radioPlayer.audio.load();
      if (wasPlaying) {
        window.radioPlayer.audio.play().catch(e => console.warn('Auto-play blocked', e));
      }
    }
  }

  switchToDefault() {
    if (window.radioPlayer) {
      window.radioPlayer.currentStreamIndex = 0;
      window.radioPlayer.setStreamSource();
      if (window.radioPlayer.isPlaying) {
        window.radioPlayer.audio.play().catch(e => console.warn('Auto-play blocked', e));
      }
    }
  }

  destroy() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.liveIndicator) this.liveIndicator.remove();
  }
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Configure relay server URL here
  const RELAY_SERVER = localStorage.getItem('relay-server-url') || 'http://localhost:3000';
  window.djBridge = new DJBridge(RELAY_SERVER);
});
