/**
 * Wave Radio - Main Application Script
 * Vanilla JS, no frameworks.
 * Supports:
 * - Station Music Library with local upload & IndexedDB persistence
 * - Seamless Live DJ broadcast takeover & automatic return
 * - Audio visualizer, track scrubber, and media controls
 */

const CONFIG = {
  stationName: 'Bethel Radio',
  streams: [
    { url: 'https://stream.zeno.fm/yn65fsaurfhvv', format: 'mp3', label: '24/7 Station Stream' },
    { url: 'https://wave-radio-relay.onrender.com/stream', format: 'webm', label: 'Live DJ Studio' }
  ],
  defaultVolume: 0.8,
  reconnectDelay: 3000,
  maxReconnectAttempts: 10,
  metadataInterval: 8000, // poll every 8s
  listenerCountInterval: 15000,
  visualizerEnabled: true,
};

// Utilities
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

const fetchWithTimeout = async (resource, options = {}) => {
  const { timeout = 8000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
};

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

function formatTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/**
 * RadioPlayer Class
 * Coordinates audio playback for 24/7 internet radio stream
 * and seamless takeover when the DJ broadcasts live.
 */
class RadioPlayer {
  constructor() {
    this.audio = document.getElementById('radio-stream');
    this.playBtn = document.getElementById('play-btn');
    this.playIcon = this.playBtn ? this.playBtn.querySelector('i') : null;
    this.volumeSlider = document.getElementById('volume-slider');
    this.muteBtn = document.querySelector('.volume-icon');
    this.muteIcon = this.muteBtn || null;
    
    this.canvas = document.getElementById('visualizer-canvas');
    this.canvasCtx = this.canvas ? this.canvas.getContext('2d') : null;
    this.nowPlayingTitle = document.getElementById('now-playing-title');
    this.nowPlayingArtist = document.getElementById('now-playing-artist');
    this.listenerCountDisplay = document.getElementById('listener-count');
    this.equalizer = document.querySelector('.equalizer');
    
    this.streams = CONFIG.streams;
    this.currentStreamIndex = 0;
    this.isLive = false;
    this.reconnectAttempts = 0;
    this.isPlaying = false;
    this.isMuted = false;
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.animationId = null;
    this.autoplayPill = null;
    this.firstTouchHandler = null;
    
    this.intervals = {
      metadata: null,
      listeners: null
    };
    
    this.currentSong = { title: CONFIG.stationName, artist: '24/7 Live Stream' };
    
    this.init();
  }

  init() {
    if (!this.audio) return;
    
    this.audio.volume = CONFIG.defaultVolume;
    if (this.volumeSlider) this.volumeSlider.value = Math.round(CONFIG.defaultVolume * 100);
    
    this.setStreamSource();
    this.setupEventListeners();
    this.setupMediaSession();
    this.startPolling();
    this.setupUnloadTracking();
    
    // Attempt automatic playback as soon as the page opens
    this.autoStartListening();

    // Responsive canvas
    if (this.canvas) {
      this.resizeCanvas();
      window.addEventListener('resize', debounce(() => this.resizeCanvas(), 250));
    }
  }

  setStreamSource(url) {
    if (!this.audio) return;
    const targetUrl = url || (this.streams && this.streams[this.currentStreamIndex] ? this.streams[this.currentStreamIndex].url : '');
    if (targetUrl && this.audio.src !== targetUrl) {
      this.audio.src = targetUrl;
      this.audio.load();
    }
  }

  /**
   * Automatic listening on page load / entry
   * Modern browsers enforce autoplay restrictions that require user interaction
   * if the user has not interacted with the domain before.
   * If blocked, we present a prompt pill and attach a one-touch listener anywhere on the page.
   */
  autoStartListening() {
    if (!this.audio) return;
    
    const playPromise = this.audio.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        console.log('Bethel Radio: Autoplay started successfully.');
        this.hideAutoplayPill();
      }).catch((err) => {
        console.log('Bethel Radio: Autoplay awaiting user interaction:', err.name);
        this.showAutoplayPill();
        this.setupFirstTouchAutoplay();
      });
    }
  }

  showAutoplayPill() {
    if (this.autoplayPill) {
      this.autoplayPill.style.display = 'flex';
      this.autoplayPill.style.opacity = '1';
      return;
    }
    const pill = document.createElement('div');
    pill.id = 'autoplay-pill';
    pill.className = 'autoplay-pill';
    pill.innerHTML = '<i class="fas fa-volume-up"></i> <span>Tap anywhere to listen live</span>';
    pill.title = 'Click or tap anywhere on page to start radio';
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      this.triggerFirstTouchPlayback();
    });
    document.body.appendChild(pill);
    this.autoplayPill = pill;
  }

  hideAutoplayPill() {
    if (this.autoplayPill) {
      this.autoplayPill.style.opacity = '0';
      setTimeout(() => {
        if (this.autoplayPill) {
          this.autoplayPill.remove();
          this.autoplayPill = null;
        }
      }, 300);
    }
  }

  setupFirstTouchAutoplay() {
    if (this.firstTouchHandler) return;
    
    this.firstTouchHandler = () => {
      this.triggerFirstTouchPlayback();
    };

    const events = ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'];
    events.forEach(evt => {
      document.addEventListener(evt, this.firstTouchHandler, { capture: true, once: true });
    });
  }

  async triggerFirstTouchPlayback() {
    if (this.firstTouchHandler) {
      const events = ['click', 'touchstart', 'touchend', 'pointerdown', 'keydown'];
      events.forEach(evt => {
        document.removeEventListener(evt, this.firstTouchHandler, { capture: true });
      });
      this.firstTouchHandler = null;
    }
    this.hideAutoplayPill();

    if (this.audioContext && this.audioContext.state === 'suspended') {
      try { await this.audioContext.resume(); } catch (_) {}
    }

    if (this.audio && this.audio.paused) {
      try {
        if (!this.audio.src) this.setStreamSource();
        await this.audio.play();
      } catch (e) {
        console.warn('Playback on interaction failed:', e);
      }
    }
  }

  setupEventListeners() {
    if (this.playBtn) {
      this.playBtn.addEventListener('click', () => this.togglePlay());
    }
    
    if (this.volumeSlider) {
      this.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value));
    }
    
    if (this.muteBtn) {
      this.muteBtn.addEventListener('click', () => this.toggleMute());
    }
    
    // Audio Events
    this.audio.addEventListener('play', () => this.handlePlay());
    this.audio.addEventListener('pause', () => this.handlePause());
    this.audio.addEventListener('ended', () => this.handleEnded());
    this.audio.addEventListener('error', (e) => this.handleError(e));
    this.audio.addEventListener('waiting', () => this.handleWaiting());
    this.audio.addEventListener('canplay', () => this.handleCanPlay());
    this.audio.addEventListener('stalled', () => this.handleStalled());
  }

  async togglePlay() {
    try {
      this.hideAutoplayPill();
      if (this.audio.paused) {
        if (this.audioContext && this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        if (!this.audio.src) {
          this.setStreamSource();
        }
        await this.audio.play();
      } else {
        this.audio.pause();
      }
    } catch (error) {
      console.error('Playback failed:', error);
      window.uiManager?.showToast('Could not start playback. Please try again.', 'error');
    }
  }

  handleLiveStarted(liveStreamUrl) {
    this.isLive = true;
    const wasPlaying = this.isPlaying;
    
    this.audio.src = liveStreamUrl;
    this.audio.load();

    this.currentSong = { title: 'Live DJ Broadcast', artist: 'Bethel Radio Studio' };
    this.updateMetadataUI();

    if (wasPlaying) {
      this.audio.play().catch(e => console.warn('Auto-play blocked:', e));
    }
  }

  handleLiveEnded() {
    this.isLive = false;
    const wasPlaying = this.isPlaying;
    
    this.setStreamSource();
    this.currentSong = { title: CONFIG.stationName, artist: '24/7 Live Stream' };
    this.updateMetadataUI();

    if (wasPlaying) {
      this.audio.play().catch(e => console.warn('Auto-play blocked:', e));
    }
  }

  setVolume(value) {
    const vol = parseFloat(value) / 100;
    this.audio.volume = Math.max(0, Math.min(1, vol));
    this.isMuted = vol === 0;
    this.updateVolumeUI();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.audio.muted = this.isMuted;
    if (this.volumeSlider) {
      this.volumeSlider.value = this.isMuted ? 0 : Math.round(this.audio.volume * 100);
    }
    this.updateVolumeUI();
  }

  updateVolumeUI() {
    if (this.muteIcon) {
      this.muteIcon.className = this.isMuted || this.audio.volume === 0 
        ? 'fas fa-volume-mute' 
        : (this.audio.volume < 0.5 ? 'fas fa-volume-down' : 'fas fa-volume-up');
    }
  }

  handlePlay() {
    this.isPlaying = true;
    this.reconnectAttempts = 0;
    this.hideAutoplayPill();
    document.body.classList.add('playing');
    if (this.playIcon) this.playIcon.className = 'fas fa-pause';
    
    if (CONFIG.visualizerEnabled) {
      this.initVisualizer();
    }
    
    this.trackListener('join');
    this.setUIState('playing');
  }

  handlePause() {
    this.isPlaying = false;
    document.body.classList.remove('playing');
    if (this.playIcon) this.playIcon.className = 'fas fa-play';
    
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    
    this.trackListener('leave');
    this.setUIState('paused');
  }

  handleEnded() {
    this.handlePause();
    this.handleError();
  }

  handleError(e) {
    console.error('Audio stream error', e);
    this.setUIState('error');
    if (this.reconnectAttempts < CONFIG.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = CONFIG.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      setTimeout(() => {
        if (this.audio) {
          if (!this.isLive) {
            // Alternate backup stream if primary failed repeatedly
            if (this.reconnectAttempts > 2 && this.streams.length > 1) {
              this.currentStreamIndex = (this.currentStreamIndex + 1) % this.streams.length;
              this.setStreamSource();
            }
          }
          this.audio.load();
          this.audio.play().catch(() => {});
        }
      }, delay);
    }
  }

  handleWaiting() {
    this.setUIState('loading');
  }

  handleCanPlay() {
    if (this.isPlaying) {
      this.setUIState('playing');
    }
  }

  handleStalled() {
    this.setUIState('loading');
  }

  setUIState(state) {
    if (this.playBtn) {
      this.playBtn.classList.remove('loading', 'error');
      if (state === 'loading') {
        this.playBtn.classList.add('loading');
        if (this.playIcon) this.playIcon.className = 'fas fa-spinner fa-spin';
      } else if (state === 'error') {
        this.playBtn.classList.add('error');
        if (this.playIcon) this.playIcon.className = 'fas fa-exclamation-triangle';
      } else if (state === 'playing') {
        if (this.playIcon) this.playIcon.className = 'fas fa-pause';
      } else if (state === 'paused') {
        if (this.playIcon) this.playIcon.className = 'fas fa-play';
      }
    }
    
    if (this.equalizer) {
      if (state === 'playing') {
        this.equalizer.classList.add('active');
      } else {
        this.equalizer.classList.remove('active');
      }
    }
  }

  setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
      this.updateMediaSession();
    }
  }

  updateMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.currentSong.title,
        artist: this.currentSong.artist,
        album: CONFIG.stationName,
        artwork: [
          { src: '/img/logo-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/img/logo-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    }
  }

  initVisualizer() {
    if (!this.canvasCtx || this.audioContext) return;
    
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContext();
      this.analyser = this.audioContext.createAnalyser();
      this.audio.crossOrigin = "anonymous";
      
      this.source = this.audioContext.createMediaElementSource(this.audio);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      
      this.analyser.fftSize = 256;
      this.drawVisualizer();
      
      if (this.equalizer) this.equalizer.style.display = 'none';
      this.canvas.style.display = 'block';
      
    } catch (e) {
      console.warn('AudioContext visualization not supported or blocked by CORS', e);
      if (this.equalizer) this.equalizer.style.display = 'flex';
      if (this.canvas) this.canvas.style.display = 'none';
    }
  }

  resizeCanvas() {
    if (!this.canvas) return;
    const parent = this.canvas.parentElement;
    this.canvas.width = parent.clientWidth;
    this.canvas.height = parent.clientHeight;
  }

  drawVisualizer() {
    if (!this.analyser || !this.canvasCtx) return;
    
    this.animationId = requestAnimationFrame(() => this.drawVisualizer());
    
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);
    
    this.canvasCtx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    const barWidth = (this.canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * this.canvas.height;
      
      const gradient = this.canvasCtx.createLinearGradient(0, this.canvas.height, 0, 0);
      gradient.addColorStop(0, '#7b2cbf');
      gradient.addColorStop(1, '#00f5d4');
      
      this.canvasCtx.fillStyle = gradient;
      this.canvasCtx.fillRect(x, this.canvas.height - barHeight / 2, barWidth, barHeight / 2);
      
      x += barWidth + 1;
    }
  }

  startPolling() {
    this.fetchMetadata();
    this.intervals.metadata = setInterval(() => this.fetchMetadata(), CONFIG.metadataInterval);
    
    this.fetchListenerCount();
    this.intervals.listeners = setInterval(() => this.fetchListenerCount(), CONFIG.listenerCountInterval);
  }

  async fetchMetadata() {
    // Only poll server metadata if live DJ is broadcasting
    if (!this.isLive) return;

    try {
      const response = await fetchWithTimeout('/.netlify/functions/now-playing', { timeout: 5000 });
      if (!response.ok) return;
      const data = await response.json();
      
      if (data.isLive && (data.title !== this.currentSong.title || data.artist !== this.currentSong.artist)) {
        this.currentSong = { title: data.title || CONFIG.stationName, artist: data.artist || 'Live DJ' };
        this.updateMetadataUI();
      }
    } catch (_) {}
  }

  updateMetadataUI() {
    if (this.nowPlayingTitle && this.nowPlayingArtist) {
      this.nowPlayingTitle.style.opacity = '0';
      this.nowPlayingArtist.style.opacity = '0';
      
      setTimeout(() => {
        this.nowPlayingTitle.textContent = this.currentSong.title;
        this.nowPlayingArtist.textContent = this.currentSong.artist;
        document.title = `${this.currentSong.title} - ${CONFIG.stationName}`;
        this.updateMediaSession();
        
        this.nowPlayingTitle.style.opacity = '1';
        this.nowPlayingArtist.style.opacity = '1';
      }, 300);
    }
  }

  async trackListener(action) {
    try {
      await fetchWithTimeout('/.netlify/functions/track-listener', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, timestamp: new Date().toISOString() }),
        timeout: 5000
      });
    } catch (_) {}
  }

  async fetchListenerCount() {
    try {
      const response = await fetchWithTimeout('/.netlify/functions/track-listener', { timeout: 5000 });
      if (response.ok) {
        const data = await response.json();
        if (this.listenerCountDisplay && data.count !== undefined) {
          this.listenerCountDisplay.innerHTML = `<i class="fas fa-users"></i> ${data.count.toLocaleString()} Listening`;
        }
      }
    } catch (_) {}
  }

  setupUnloadTracking() {
    window.addEventListener('beforeunload', () => {
      if (this.isPlaying) {
        const data = new Blob([JSON.stringify({ action: 'leave' })], { type: 'application/json' });
        navigator.sendBeacon('/.netlify/functions/track-listener', data);
      }
    });
  }
}


class ScheduleManager {
  constructor() {
    this.container = document.getElementById('schedule-container');
    this.defaultSchedule = [
      { day: 0, show: 'Sunday Gospel', time: '06:00', endTime: '10:00', dj: 'Pastor Ken' },
      { day: 0, show: 'Weekend Wind Down', time: '18:00', endTime: '22:00', dj: 'DJ Smooth' },
      { day: 1, show: 'Morning Drive', time: '06:00', endTime: '10:00', dj: 'DJ Spike' },
      { day: 1, show: 'Afrobeats Connect', time: '14:00', endTime: '17:00', dj: 'DJ Yemi' },
      { day: 2, show: 'Morning Drive', time: '06:00', endTime: '10:00', dj: 'DJ Spike' },
      { day: 2, show: 'Jazz Lounge', time: '20:00', endTime: '23:00', dj: 'Miles Jr.' },
      { day: 3, show: 'Morning Drive', time: '06:00', endTime: '10:00', dj: 'DJ Spike' },
      { day: 3, show: 'Midweek Motivation', time: '12:00', endTime: '14:00', dj: 'Sarah T' },
      { day: 4, show: 'Morning Drive', time: '06:00', endTime: '10:00', dj: 'DJ Spike' },
      { day: 4, show: 'Throwback Thursday', time: '16:00', endTime: '20:00', dj: 'DJ Retro' },
      { day: 5, show: 'TGIF Mix', time: '18:00', endTime: '00:00', dj: 'DJ Blaze' },
      { day: 6, show: 'Saturday Party', time: '20:00', endTime: '02:00', dj: 'DJ X' },
    ];
    this.schedule = [];
    
    this.init();
  }

  async init() {
    if (!this.container) return;
    await this.fetchSchedule();
    this.renderSchedule();
    
    // Update active show every minute
    setInterval(() => this.highlightCurrentShow(), 60000);
  }

  async fetchSchedule() {
    try {
      const response = await fetchWithTimeout('/.netlify/functions/get-schedule');
      if (response.ok) {
        this.schedule = await response.json();
      } else {
        this.schedule = this.defaultSchedule;
      }
    } catch (error) {
      console.warn('Could not fetch schedule, using default');
      this.schedule = this.defaultSchedule;
    }
  }

  renderSchedule() {
    if (!this.container || this.schedule.length === 0) return;
    
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    this.container.innerHTML = '';
    
    // Group by day
    const grouped = this.schedule.reduce((acc, curr) => {
      acc[curr.day] = acc[curr.day] || [];
      acc[curr.day].push(curr);
      return acc;
    }, {});
    
    Object.keys(grouped).sort().forEach(dayIndex => {
      const daySchedule = grouped[dayIndex];
      const dayWrapper = document.createElement('div');
      dayWrapper.className = 'schedule-day';
      
      const dayTitle = document.createElement('h3');
      dayTitle.textContent = days[dayIndex];
      dayWrapper.appendChild(dayTitle);
      
      const showsGrid = document.createElement('div');
      showsGrid.className = 'shows-grid';
      
      daySchedule.forEach(show => {
        const showCard = document.createElement('div');
        showCard.className = 'show-card';
        showCard.dataset.day = show.day;
        showCard.dataset.time = show.time;
        showCard.dataset.endTime = show.endTime;
        
        showCard.innerHTML = `
          <div class="show-time">${show.time} - ${show.endTime}</div>
          <div class="show-details">
            <h4 class="show-title">${show.show}</h4>
            <span class="show-dj">with ${show.dj}</span>
          </div>
        `;
        
        showsGrid.appendChild(showCard);
      });
      
      dayWrapper.appendChild(showsGrid);
      this.container.appendChild(dayWrapper);
    });
    
    this.highlightCurrentShow();
  }

  highlightCurrentShow() {
    const cards = this.container.querySelectorAll('.show-card');
    const now = new Date();
    const currentDay = now.getDay();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    cards.forEach(card => {
      card.classList.remove('active');
      const day = parseInt(card.dataset.day);
      if (day === currentDay) {
        const [startH, startM] = card.dataset.time.split(':').map(Number);
        const [endH, endM] = card.dataset.endTime.split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        let endMinutes = endH * 60 + endM;
        
        // Handle overnight shows
        if (endMinutes < startMinutes) {
          endMinutes += 24 * 60;
        }
        
        if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
          card.classList.add('active');
        }
      }
    });
  }
}

class UIManager {
  constructor() {
    this.toastQueue = [];
    this.isShowingToast = false;
    this.toastContainer = null;
    
    this.init();
  }

  init() {
    this.setupNavigation();
    this.setupToastContainer();
    this.setupCookieConsent();
    this.setupContactForm();
    this.setupKeyboardShortcuts();
    this.registerServiceWorker();
    
    // CSS transitions helper
    this.nowPlayingTitle = document.getElementById('now-playing-title');
    if (this.nowPlayingTitle) {
      this.nowPlayingTitle.style.transition = 'opacity 0.3s ease-in-out';
    }
    const artist = document.getElementById('now-playing-artist');
    if (artist) artist.style.transition = 'opacity 0.3s ease-in-out';
  }

  setupNavigation() {
    const hamburger = document.querySelector('.mobile-menu-btn');
    const mobileNav = document.querySelector('.mobile-nav');
    const header = document.querySelector('header');
    
    if (hamburger && mobileNav) {
      hamburger.addEventListener('click', () => {
        mobileNav.classList.toggle('hidden');
        mobileNav.classList.toggle('open');
        const icon = hamburger.querySelector('i');
        if (icon) {
          icon.className = mobileNav.classList.contains('open') ? 'fas fa-times' : 'fas fa-bars';
        }
      });
      
      // Close on link click
      mobileNav.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
          mobileNav.classList.add('hidden');
          mobileNav.classList.remove('open');
          const icon = hamburger.querySelector('i');
          if (icon) icon.className = 'fas fa-bars';
        });
      });
    }
    
    // Smooth scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const targetId = this.getAttribute('href');
        if (targetId === '#') return;
        
        const target = document.querySelector(targetId);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth' });
        }
      });
    });
    
    // Header scroll effect
    if (header) {
      window.addEventListener('scroll', debounce(() => {
        if (window.scrollY > 50) {
          header.classList.add('scrolled');
        } else {
          header.classList.remove('scrolled');
        }
      }, 50), { passive: true });
    }
    
    // Intersection observer for active sections
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('nav ul li a');
    
    if (sections.length > 0 && navLinks.length > 0) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            navLinks.forEach(link => {
              link.classList.remove('active');
              if (link.getAttribute('href') === `#${entry.target.id}`) {
                link.classList.add('active');
              }
            });
          }
        });
      }, { threshold: 0.3 });
      
      sections.forEach(section => observer.observe(section));
    }
  }

  setupToastContainer() {
    this.toastContainer = document.createElement('div');
    this.toastContainer.id = 'toast-container';
    this.toastContainer.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
    `;
    document.body.appendChild(this.toastContainer);
  }

  showToast(message, type = 'info', duration = 3000) {
    this.toastQueue.push({ message, type, duration });
    this.processToastQueue();
  }

  processToastQueue() {
    if (this.isShowingToast || this.toastQueue.length === 0) return;
    
    this.isShowingToast = true;
    const { message, type, duration } = this.toastQueue.shift();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    // Styling
    const colors = {
      success: '#2ecc71',
      error: '#e74c3c',
      info: '#3498db'
    };
    
    toast.style.cssText = `
      background: #2a2a2a;
      color: white;
      padding: 12px 24px;
      border-radius: 4px;
      border-left: 4px solid ${colors[type] || colors.info};
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: sans-serif;
      font-size: 14px;
      transform: translateX(120%);
      transition: transform 0.3s ease-in-out;
      display: flex;
      align-items: center;
      gap: 10px;
    `;
    
    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    if (type === 'error') iconClass = 'fa-exclamation-circle';
    
    toast.innerHTML = `<i class="fas ${iconClass}"></i><span>${message}</span>`;
    
    this.toastContainer.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(0)';
    });
    
    // Animate out
    setTimeout(() => {
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        this.isShowingToast = false;
        this.processToastQueue();
      }, 300);
    }, duration);
  }

  setupCookieConsent() {
    const consent = localStorage.getItem('cookie-consent');
    const banner = document.getElementById('cookie-banner');
    if (!banner) return;
    
    if (consent) {
      banner.remove();
      return;
    }
    
    // Show the banner
    setTimeout(() => {
      banner.classList.remove('hidden');
    }, 1000);
    
    const acceptBtn = document.getElementById('accept-cookies');
    const declineBtn = document.getElementById('decline-cookies');
    
    const dismiss = (value) => {
      localStorage.setItem('cookie-consent', value);
      banner.classList.add('hidden');
      setTimeout(() => banner.remove(), 500);
    };
    
    if (acceptBtn) acceptBtn.addEventListener('click', () => dismiss('all'));
    if (declineBtn) declineBtn.addEventListener('click', () => dismiss('essential'));
  }

  setupContactForm() {
    const form = document.querySelector('form[name="contact"]');
    if (!form) return;
    
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const submitBtn = form.querySelector('button[type="submit"]');
      const originalText = submitBtn.textContent;
      submitBtn.textContent = 'Sending...';
      submitBtn.disabled = true;
      
      try {
        const formData = new FormData(form);
        const response = await fetch('/', {
          method: 'POST',
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(formData).toString()
        });
        
        if (response.ok) {
          this.showToast('Message sent successfully!', 'success');
          form.reset();
        } else {
          throw new Error('Server error');
        }
      } catch (error) {
        this.showToast('Failed to send message. Please try again.', 'error');
      } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
      }
    });
  }

  setupKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't trigger if user is typing in an input
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      
      if (e.code === 'Space') {
        e.preventDefault();
        window.radioPlayer?.togglePlay();
      } else if (e.code === 'KeyM') {
        window.radioPlayer?.toggleMute();
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        if (window.radioPlayer) {
          let vol = window.radioPlayer.audio.volume + 0.1;
          if (vol > 1) vol = 1;
          window.radioPlayer.setVolume(vol);
          if (window.radioPlayer.volumeSlider) window.radioPlayer.volumeSlider.value = vol;
        }
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        if (window.radioPlayer) {
          let vol = window.radioPlayer.audio.volume - 0.1;
          if (vol < 0) vol = 0;
          window.radioPlayer.setVolume(vol);
          if (window.radioPlayer.volumeSlider) window.radioPlayer.volumeSlider.value = vol;
        }
      }
    });
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => {
          console.log('ServiceWorker registration failed: ', err);
        });
      });
    }
  }
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  try {
    console.log('%c Bethel Radio initialized 📻 ', 'background: #7b2cbf; color: #fff; font-size: 16px; padding: 4px; border-radius: 4px;');
    
    // Create globals for cross-class communication
    window.uiManager = new UIManager();
    window.radioPlayer = new RadioPlayer();
    window.scheduleManager = new ScheduleManager();
    
  } catch (error) {
    console.error('Initialization error:', error);
  }
});
