/**
 * Wave Radio - Main Application Script
 * Vanilla JS, no frameworks.
 * Supports:
 * - Station Music Library with local upload & IndexedDB persistence
 * - Seamless Live DJ broadcast takeover & automatic return
 * - Audio visualizer, track scrubber, and media controls
 */

const CONFIG = {
  stationName: 'Wave Radio',
  defaultVolume: 0.7,
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
 * Station Music Library
 * Manages uploaded audio tracks in browser IndexedDB
 */
class StationLibrary {
  constructor(player) {
    this.player = player;
    this.dbName = 'WaveRadioStationDB';
    this.dbVersion = 1;
    this.storeName = 'station_tracks';
    this.db = null;
    this.tracks = [];
    
    // DOM Elements
    this.modal = document.getElementById('library-modal');
    this.openBtn = document.getElementById('btn-open-library');
    this.closeBtn = document.getElementById('btn-close-library');
    this.dropzone = document.getElementById('upload-dropzone');
    this.fileInput = document.getElementById('station-file-input');
    this.tracksList = document.getElementById('library-tracks-list');
    this.statusText = document.getElementById('library-status-text');
    this.badge = document.getElementById('library-count-badge');
    this.clearBtn = document.getElementById('btn-clear-library');
    this.shuffleBtn = document.getElementById('btn-shuffle-library');
    
    this.init();
  }

  async init() {
    this.setupUIListeners();
    await this.openDB();
    await this.loadTracks();
  }

  openDB() {
    return new Promise((resolve) => {
      if (!window.indexedDB) {
        console.warn('IndexedDB not supported, falling back to memory');
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(this.dbName, this.dbVersion);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'id' });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  setupUIListeners() {
    if (this.openBtn) {
      this.openBtn.addEventListener('click', () => this.openModal());
    }
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.closeModal());
    }
    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.closeModal();
      });
    }

    if (this.fileInput) {
      this.fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleFiles(e.target.files);
          this.fileInput.value = '';
        }
      });
    }

    if (this.dropzone) {
      ['dragenter', 'dragover'].forEach(name => {
        this.dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.dropzone.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach(name => {
        this.dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.dropzone.classList.remove('dragover');
        });
      });
      this.dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          this.handleFiles(dt.files);
        }
      });
    }

    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', () => {
        if (this.tracks.length === 0) return;
        if (confirm('Clear all uploaded station tracks?')) {
          this.clearAll();
        }
      });
    }

    if (this.shuffleBtn) {
      this.shuffleBtn.addEventListener('click', () => {
        if (this.tracks.length > 1) {
          this.shuffleTracks();
          window.uiManager?.showToast('Station tracks shuffled!', 'info', 2500);
        }
      });
    }
  }

  openModal() {
    if (this.modal) this.modal.style.display = 'flex';
  }

  closeModal() {
    if (this.modal) this.modal.style.display = 'none';
  }

  parseTrackName(fileName) {
    let clean = fileName.replace(/\.[^/.]+$/, '');
    clean = clean.replace(/^[0-9]+[\s._-]+/, '');
    
    let artist = 'Station Music';
    let title = clean;
    
    if (clean.includes(' - ')) {
      const parts = clean.split(' - ');
      artist = parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    }
    
    return { title, artist };
  }

  async handleFiles(fileList) {
    const audioFiles = Array.from(fileList).filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f.name));
    
    if (audioFiles.length === 0) {
      window.uiManager?.showToast('Please select audio files (.mp3, .wav, .m4a, etc.)', 'warning');
      return;
    }

    let addedCount = 0;
    for (const file of audioFiles) {
      const { title, artist } = this.parseTrackName(file.name);
      const track = {
        id: 'track_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        title,
        artist,
        name: file.name,
        size: file.size,
        blob: file,
        dateAdded: Date.now()
      };
      await this.saveTrackToDB(track);
      this.tracks.push(track);
      addedCount++;
    }

    this.renderTrackList();
    this.updateBadge();
    window.uiManager?.showToast(`Added ${addedCount} song(s) to station library!`, 'success', 3000);

    if (this.player && this.player.currentTrackIndex === -1 && this.tracks.length > 0 && !this.player.isLive) {
      this.player.loadTrack(0, false);
    }
  }

  saveTrackToDB(track) {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(track);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  loadTracks() {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).getAll();
        req.onsuccess = () => {
          this.tracks = req.result || [];
          this.renderTrackList();
          this.updateBadge();
          if (this.tracks.length > 0 && this.player && !this.player.isLive) {
            this.player.loadTrack(0, false);
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  deleteTrack(id) {
    if (this.db) {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(id);
      } catch (_) {}
    }
    const idx = this.tracks.findIndex(t => t.id === id);
    if (idx !== -1) {
      const wasCurrent = this.player && this.player.currentTrackIndex === idx;
      this.tracks.splice(idx, 1);
      this.renderTrackList();
      this.updateBadge();

      if (wasCurrent && this.player && !this.player.isLive) {
        if (this.tracks.length > 0) {
          const nextIdx = idx >= this.tracks.length ? 0 : idx;
          this.player.loadTrack(nextIdx, this.player.isPlaying);
        } else {
          this.player.resetToOffAir();
        }
      }
    }
  }

  clearAll() {
    if (this.db) {
      try {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).clear();
      } catch (_) {}
    }
    this.tracks = [];
    this.renderTrackList();
    this.updateBadge();
    if (this.player && !this.player.isLive) {
      this.player.resetToOffAir();
    }
    window.uiManager?.showToast('Station library cleared.', 'info');
  }

  shuffleTracks() {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
    this.renderTrackList();
    if (this.player && this.tracks.length > 0 && !this.player.isLive) {
      this.player.loadTrack(0, this.player.isPlaying);
    }
  }

  updateBadge() {
    const count = this.tracks.length;
    if (this.badge) this.badge.textContent = count;
    if (this.statusText) this.statusText.textContent = `${count} track${count === 1 ? '' : 's'} uploaded`;
    
    const prevBtn = document.getElementById('prev-track-btn');
    const nextBtn = document.getElementById('next-track-btn');
    const displayStyle = (count > 1 && (!this.player || !this.player.isLive)) ? 'flex' : 'none';
    if (prevBtn) prevBtn.style.display = displayStyle;
    if (nextBtn) nextBtn.style.display = displayStyle;
  }

  renderTrackList() {
    if (!this.tracksList) return;

    if (this.tracks.length === 0) {
      this.tracksList.innerHTML = `
        <div class="empty-library-state">
            <i class="fas fa-compact-disc"></i>
            <p>No music uploaded yet.<br>Upload your favorite audio files to build your station's playlist!</p>
        </div>
      `;
      return;
    }

    this.tracksList.innerHTML = '';
    this.tracks.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'track-item' + (this.player && this.player.currentTrackIndex === index ? ' active' : '');
      item.innerHTML = `
        <span class="track-index">${index + 1}</span>
        <div class="track-details">
            <div class="track-name">${escapeHTML(track.title)}</div>
            <p class="track-meta">${escapeHTML(track.artist)}</p>
        </div>
        <button class="track-remove-btn" title="Remove track" data-id="${track.id}">
            <i class="fas fa-times"></i>
        </button>
      `;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.track-remove-btn')) {
          e.stopPropagation();
          this.deleteTrack(track.id);
          return;
        }
        if (this.player) {
          this.player.loadTrack(index, true);
          this.closeModal();
        }
      });

      this.tracksList.appendChild(item);
    });
  }
}

/**
 * RadioPlayer Class
 * Coordinates audio playback for both Live DJ streams and uploaded station tracks
 */
class RadioPlayer {
  constructor() {
    this.audio = document.getElementById('radio-stream');
    this.playBtn = document.getElementById('play-btn');
    this.playIcon = this.playBtn ? this.playBtn.querySelector('i') : null;
    this.prevBtn = document.getElementById('prev-track-btn');
    this.nextBtn = document.getElementById('next-track-btn');
    this.volumeSlider = document.getElementById('volume-slider');
    this.muteBtn = document.querySelector('.volume-icon');
    this.muteIcon = this.muteBtn || null;
    
    // Scrubber elements
    this.scrubber = document.getElementById('track-scrubber');
    this.progressContainer = document.getElementById('progress-container');
    this.progressFill = document.getElementById('progress-fill');
    this.currentTimeEl = document.getElementById('track-current-time');
    this.totalTimeEl = document.getElementById('track-total-time');

    this.canvas = document.getElementById('visualizer-canvas');
    this.canvasCtx = this.canvas ? this.canvas.getContext('2d') : null;
    this.nowPlayingTitle = document.getElementById('now-playing-title');
    this.nowPlayingArtist = document.getElementById('now-playing-artist');
    this.listenerCountDisplay = document.getElementById('listener-count');
    this.equalizer = document.querySelector('.equalizer');
    
    this.currentTrackIndex = -1;
    this.isLive = false;
    this.activeBlobUrl = null;
    this.reconnectAttempts = 0;
    this.isPlaying = false;
    this.isMuted = false;
    this.audioContext = null;
    this.analyser = null;
    this.source = null;
    this.animationId = null;
    
    this.intervals = {
      metadata: null,
      listeners: null
    };
    
    this.currentSong = { title: CONFIG.stationName, artist: 'Feel The Frequency' };
    
    // Initialize station library
    this.library = new StationLibrary(this);
    this.init();
  }

  init() {
    if (!this.audio) return;
    
    this.audio.volume = CONFIG.defaultVolume;
    if (this.volumeSlider) this.volumeSlider.value = Math.round(CONFIG.defaultVolume * 100);
    
    this.setupEventListeners();
    this.setupMediaSession();
    this.startPolling();
    this.setupUnloadTracking();
    
    // Responsive canvas
    if (this.canvas) {
      this.resizeCanvas();
      window.addEventListener('resize', debounce(() => this.resizeCanvas(), 250));
    }
  }

  setupEventListeners() {
    if (this.playBtn) {
      this.playBtn.addEventListener('click', () => this.togglePlay());
    }

    if (this.prevBtn) {
      this.prevBtn.addEventListener('click', () => this.playPrevTrack());
    }

    if (this.nextBtn) {
      this.nextBtn.addEventListener('click', () => this.playNextTrack());
    }
    
    if (this.volumeSlider) {
      this.volumeSlider.addEventListener('input', (e) => this.setVolume(e.target.value));
    }
    
    if (this.muteBtn) {
      this.muteBtn.addEventListener('click', () => this.toggleMute());
    }

    if (this.progressContainer) {
      this.progressContainer.addEventListener('click', (e) => this.seekAudio(e));
    }
    
    // Audio Events
    this.audio.addEventListener('play', () => this.handlePlay());
    this.audio.addEventListener('pause', () => this.handlePause());
    this.audio.addEventListener('ended', () => this.handleEnded());
    this.audio.addEventListener('error', (e) => this.handleError(e));
    this.audio.addEventListener('waiting', () => this.handleWaiting());
    this.audio.addEventListener('canplay', () => this.handleCanPlay());
    this.audio.addEventListener('stalled', () => this.handleStalled());
    this.audio.addEventListener('timeupdate', () => this.updateScrubber());
    this.audio.addEventListener('loadedmetadata', () => this.updateScrubber());
  }

  loadTrack(index, autoPlay = true) {
    if (!this.library || !this.library.tracks || index < 0 || index >= this.library.tracks.length) return;
    
    if (this.activeBlobUrl) {
      try { URL.revokeObjectURL(this.activeBlobUrl); } catch (_) {}
    }

    this.currentTrackIndex = index;
    const track = this.library.tracks[index];
    this.activeBlobUrl = URL.createObjectURL(track.blob);
    this.audio.src = this.activeBlobUrl;
    this.audio.load();

    this.currentSong = { title: track.title, artist: track.artist };
    this.updateMetadataUI();

    if (this.scrubber) this.scrubber.style.display = 'flex';
    this.library.renderTrackList();
    this.library.updateBadge();

    if (autoPlay) {
      this.audio.play().catch(e => console.warn('Playback error:', e));
    }
  }

  playNextTrack() {
    if (this.isLive || !this.library || this.library.tracks.length === 0) return;
    const nextIdx = (this.currentTrackIndex + 1) % this.library.tracks.length;
    this.loadTrack(nextIdx, true);
  }

  playPrevTrack() {
    if (this.isLive || !this.library || this.library.tracks.length === 0) return;
    const prevIdx = (this.currentTrackIndex - 1 + this.library.tracks.length) % this.library.tracks.length;
    this.loadTrack(prevIdx, true);
  }

  resetToOffAir() {
    this.audio.pause();
    this.audio.src = '';
    this.currentTrackIndex = -1;
    this.currentSong = { title: CONFIG.stationName, artist: 'Station Ready - Upload Your Music' };
    this.updateMetadataUI();
    if (this.scrubber) this.scrubber.style.display = 'none';
    if (this.prevBtn) this.prevBtn.style.display = 'none';
    if (this.nextBtn) this.nextBtn.style.display = 'none';
    this.setUIState('paused');
  }

  seekAudio(e) {
    if (this.isLive || !this.audio.duration || !isFinite(this.audio.duration)) return;
    const rect = this.progressContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    this.audio.currentTime = pos * this.audio.duration;
  }

  updateScrubber() {
    if (this.isLive || !this.audio || !this.audio.duration || !isFinite(this.audio.duration)) return;
    const cur = this.audio.currentTime || 0;
    const dur = this.audio.duration || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    
    if (this.progressFill) this.progressFill.style.width = `${pct}%`;
    if (this.currentTimeEl) this.currentTimeEl.textContent = formatTime(cur);
    if (this.totalTimeEl) this.totalTimeEl.textContent = formatTime(dur);
  }

  async togglePlay() {
    try {
      if (this.isLive) {
        if (this.audio.paused) {
          if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
          }
          await this.audio.play();
        } else {
          this.audio.pause();
        }
        return;
      }

      // Station music mode
      if (!this.library || this.library.tracks.length === 0) {
        this.library.openModal();
        window.uiManager?.showToast('No music uploaded yet! Upload your audio files to start listening.', 'info', 4000);
        return;
      }

      if (this.audio.paused) {
        if (this.audioContext && this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }
        if (!this.audio.src || this.currentTrackIndex === -1) {
          this.loadTrack(0, true);
        } else {
          await this.audio.play();
        }
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
    
    if (this.scrubber) this.scrubber.style.display = 'none';
    if (this.prevBtn) this.prevBtn.style.display = 'none';
    if (this.nextBtn) this.nextBtn.style.display = 'none';

    this.audio.src = liveStreamUrl;
    this.audio.load();

    if (wasPlaying) {
      this.audio.play().catch(e => console.warn('Auto-play blocked:', e));
    }
  }

  handleLiveEnded() {
    this.isLive = false;
    if (this.library && this.library.tracks.length > 0) {
      const idx = this.currentTrackIndex >= 0 ? this.currentTrackIndex : 0;
      this.loadTrack(idx, this.isPlaying);
    } else {
      this.resetToOffAir();
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
    if (this.isLive) {
      this.handlePause();
      this.handleError();
    } else {
      if (this.library && this.library.tracks.length > 0) {
        this.playNextTrack();
      } else {
        this.handlePause();
      }
    }
  }

  handleError(e) {
    if (!this.isLive) return;
    console.error('Audio stream error', e);
    this.setUIState('error');
    if (this.reconnectAttempts < CONFIG.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = CONFIG.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      setTimeout(() => {
        if (this.isLive && this.audio) {
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
    if (this.isLive) {
      this.setUIState('loading');
    }
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
      navigator.mediaSession.setActionHandler('previoustrack', () => this.playPrevTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.playNextTrack());
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
    console.log('%c Wave Radio initialized 🌊 ', 'background: #7b2cbf; color: #fff; font-size: 16px; padding: 4px; border-radius: 4px;');
    
    // Create globals for cross-class communication
    window.uiManager = new UIManager();
    window.radioPlayer = new RadioPlayer();
    window.scheduleManager = new ScheduleManager();
    
  } catch (error) {
    console.error('Initialization error:', error);
  }
});
