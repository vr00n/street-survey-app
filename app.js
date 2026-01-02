/**
 * Street Survey Collector - Main Application
 * Captures images, GPS, and accelerometer data for street surveys
 */

// ============================================
// Configuration (loaded from settings)
// ============================================
const CONFIG = {
  GITHUB_TOKEN: '',
  GITHUB_REPO: '',
  GITHUB_BRANCH: 'main',
  MAPBOX_TOKEN: '',
  CONTRIBUTOR: ''
};

// ============================================
// Application State
// ============================================

const AppState = {
  // Recording state
  isRecording: false,
  isPaused: false,
  currentSession: null,
  sequenceNum: 0,
  startTime: null,
  recordingTimer: null,
  captureInterval: null,
  
  // Sensor managers
  gpsManager: null,
  accelManager: null,
  wakeLockManager: null,
  
  // Camera
  cameraStream: null,
  videoElement: null,
  canvasElement: null,
  
  // Settings
  settings: {
    captureInterval: 2000,
    imageQuality: 0.7,
    imageMaxWidth: 1280,
    githubLimit: 1000
  },
  
  // UI state
  currentView: 'camera',
  sessionToDelete: null
};

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('Initializing Street Survey Collector...');
  
  try {
    // Initialize database
    await Storage.init();
    console.log('Database initialized');
    
    // Request persistent storage
    await Storage.requestPersistentStorage();
    
    // Load settings
    await loadSettings();
    
    // Initialize UI
    initializeUI();
    
    // Check for session recovery
    await checkRecovery();
    
    // Initialize camera
    await initCamera();
    
    // Update storage info
    await updateStorageInfo();
    
    console.log('App initialized successfully');
    
  } catch (error) {
    console.error('Failed to initialize app:', error);
    showToast('Failed to initialize app: ' + error.message, 'error');
  }
});

// ============================================
// Settings Management
// ============================================

async function loadSettings() {
  const savedSettings = await Storage.getAllSettings();
  
  // Load saved capture settings
  if (savedSettings.captureInterval) {
    AppState.settings.captureInterval = savedSettings.captureInterval;
  }
  if (savedSettings.imageQuality) {
    AppState.settings.imageQuality = savedSettings.imageQuality;
  }
  if (savedSettings.imageMaxWidth) {
    AppState.settings.imageMaxWidth = savedSettings.imageMaxWidth;
  }
  if (savedSettings.githubLimit) {
    AppState.settings.githubLimit = savedSettings.githubLimit;
  }
  
  // Load API tokens
  if (savedSettings.githubToken) {
    CONFIG.GITHUB_TOKEN = savedSettings.githubToken;
  }
  if (savedSettings.githubRepo) {
    CONFIG.GITHUB_REPO = savedSettings.githubRepo;
  }
  if (savedSettings.githubBranch) {
    CONFIG.GITHUB_BRANCH = savedSettings.githubBranch;
  }
  if (savedSettings.mapboxToken) {
    CONFIG.MAPBOX_TOKEN = savedSettings.mapboxToken;
  }
  if (savedSettings.contributor) {
    CONFIG.CONTRIBUTOR = savedSettings.contributor;
  }
  
  // Populate settings form
  document.getElementById('capture-interval').value = AppState.settings.captureInterval;
  document.getElementById('image-quality').value = AppState.settings.imageQuality;
  document.getElementById('image-resolution').value = AppState.settings.imageMaxWidth;
  document.getElementById('github-limit').value = AppState.settings.githubLimit;
  
  // Populate API tokens
  document.getElementById('github-token').value = CONFIG.GITHUB_TOKEN;
  document.getElementById('github-repo').value = CONFIG.GITHUB_REPO;
  document.getElementById('github-branch').value = CONFIG.GITHUB_BRANCH;
  document.getElementById('mapbox-token').value = CONFIG.MAPBOX_TOKEN;
  document.getElementById('contributor').value = CONFIG.CONTRIBUTOR;
}

async function saveSettings() {
  // Read capture settings from form
  AppState.settings.captureInterval = parseInt(document.getElementById('capture-interval').value);
  AppState.settings.imageQuality = parseFloat(document.getElementById('image-quality').value);
  AppState.settings.imageMaxWidth = parseInt(document.getElementById('image-resolution').value);
  AppState.settings.githubLimit = parseInt(document.getElementById('github-limit').value);
  
  // Read API tokens from form
  CONFIG.GITHUB_TOKEN = document.getElementById('github-token').value.trim();
  CONFIG.GITHUB_REPO = document.getElementById('github-repo').value.trim();
  CONFIG.GITHUB_BRANCH = document.getElementById('github-branch').value.trim() || 'main';
  CONFIG.MAPBOX_TOKEN = document.getElementById('mapbox-token').value.trim();
  CONFIG.CONTRIBUTOR = document.getElementById('contributor').value.trim();
  
  // Save capture settings to IndexedDB
  for (const [key, value] of Object.entries(AppState.settings)) {
    await Storage.saveSetting(key, value);
  }
  
  // Save API tokens to IndexedDB
  await Storage.saveSetting('githubToken', CONFIG.GITHUB_TOKEN);
  await Storage.saveSetting('githubRepo', CONFIG.GITHUB_REPO);
  await Storage.saveSetting('githubBranch', CONFIG.GITHUB_BRANCH);
  await Storage.saveSetting('mapboxToken', CONFIG.MAPBOX_TOKEN);
  await Storage.saveSetting('contributor', CONFIG.CONTRIBUTOR);
  
  showToast('Settings saved', 'success');
  hidePanel('settings-panel');
}

// ============================================
// Camera Management
// ============================================

async function initCamera() {
  AppState.videoElement = document.getElementById('camera-preview');
  
  // Create a canvas element for capturing frames
  AppState.canvasElement = document.createElement('canvas');
  
  try {
    // Request camera with rear-facing preference
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    
    AppState.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    AppState.videoElement.srcObject = AppState.cameraStream;
    
    // Wait for video to be ready
    await new Promise((resolve) => {
      AppState.videoElement.onloadedmetadata = () => {
        AppState.videoElement.play();
        resolve();
      };
    });
    
    console.log('Camera initialized:', AppState.videoElement.videoWidth, 'x', AppState.videoElement.videoHeight);
    
  } catch (error) {
    console.error('Failed to access camera:', error);
    showToast('Camera access denied. Please grant permission.', 'error');
  }
}

async function captureImage() {
  if (!AppState.videoElement || !AppState.cameraStream) {
    console.warn('Camera not available');
    return null;
  }
  
  const video = AppState.videoElement;
  
  // Make sure video has dimensions
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    console.warn('Video not ready yet');
    return null;
  }
  
  // Use the persistent canvas
  const canvas = AppState.canvasElement;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Convert to blob
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => {
      if (!blob || blob.size === 0) {
        console.warn('Failed to create blob from canvas');
        resolve(null);
        return;
      }
      
      console.log('Captured image:', blob.size, 'bytes');
      
      // Compress image
      const compressed = await compressImage(blob);
      resolve(compressed);
    }, 'image/jpeg', 0.92);
  });
}

// ============================================
// Image Compression
// ============================================

async function compressImage(blob) {
  const quality = AppState.settings.imageQuality;
  const maxWidth = AppState.settings.imageMaxWidth;
  
  try {
    const img = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / img.width);
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    
    return new Promise((resolve) => {
      canvas.toBlob((compressed) => {
        if (!compressed || compressed.size < 1000) {
          console.warn('Compressed image too small, using original');
          resolve(blob);
          return;
        }
        
        console.log('Compressed:', blob.size, '->', compressed.size);
        img.close();
        resolve(compressed);
      }, 'image/jpeg', quality);
    });
    
  } catch (error) {
    console.error('Compression failed:', error);
    return blob;
  }
}

// ============================================
// GPS Manager
// ============================================

class GPSManager {
  constructor() {
    this.lastPosition = null;
    this.lastUpdateTime = null;
    this.watchId = null;
    this.staleThresholdMs = 10000;
    this.errorState = null;
    this.heartbeat = null;
    this.onStale = null;
    this.onError = null;
    this.onUpdate = null;
  }
  
  start() {
    if (!navigator.geolocation) {
      this.errorState = { code: 0, message: 'Geolocation not supported' };
      return false;
    }
    
    this.watchId = navigator.geolocation.watchPosition(
      (position) => this.onPosition(position),
      (error) => this.handleError(error),
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      }
    );
    
    this.heartbeat = setInterval(() => this.checkHealth(), 5000);
    return true;
  }
  
  onPosition(position) {
    this.lastPosition = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: position.coords.altitude,
      speed: position.coords.speed,
      timestamp: position.timestamp
    };
    this.lastUpdateTime = Date.now();
    this.errorState = null;
    
    if (this.onUpdate) {
      this.onUpdate(this.lastPosition);
    }
  }
  
  handleError(error) {
    this.errorState = {
      code: error.code,
      message: error.message,
      timestamp: Date.now()
    };
    
    if (this.onError) {
      this.onError(this.errorState);
    }
  }
  
  checkHealth() {
    const now = Date.now();
    const age = this.lastUpdateTime ? now - this.lastUpdateTime : Infinity;
    
    if (age > this.staleThresholdMs && this.onStale) {
      this.onStale({ lastUpdate: this.lastUpdateTime, ageMs: age });
    }
  }
  
  getCurrentReading() {
    if (!this.lastPosition) {
      return { available: false, error: this.errorState };
    }
    
    const age = Date.now() - this.lastUpdateTime;
    return {
      available: true,
      ...this.lastPosition,
      stale: age > this.staleThresholdMs,
      ageMs: age
    };
  }
  
  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

// ============================================
// Accelerometer Manager
// ============================================

class AccelerometerManager {
  constructor() {
    this.supported = 'DeviceMotionEvent' in window;
    this.lastReading = null;
    this.permissionGranted = false;
    this.listener = null;
  }
  
  async requestPermission() {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const result = await DeviceMotionEvent.requestPermission();
        this.permissionGranted = result === 'granted';
        return this.permissionGranted;
      } catch (e) {
        console.warn('Accelerometer permission denied:', e);
        return false;
      }
    }
    this.permissionGranted = true;
    return true;
  }
  
  start() {
    if (!this.supported) {
      console.warn('DeviceMotion not supported');
      return false;
    }
    
    this.listener = (e) => {
      if (e.accelerationIncludingGravity) {
        this.lastReading = {
          x: e.accelerationIncludingGravity.x,
          y: e.accelerationIncludingGravity.y,
          z: e.accelerationIncludingGravity.z,
          timestamp: Date.now()
        };
      }
    };
    
    window.addEventListener('devicemotion', this.listener);
    return true;
  }
  
  getCurrentReading() {
    if (!this.supported || !this.permissionGranted) {
      return null;
    }
    return this.lastReading;
  }
  
  stop() {
    if (this.listener) {
      window.removeEventListener('devicemotion', this.listener);
      this.listener = null;
    }
  }
}

// ============================================
// Wake Lock Manager
// ============================================

class WakeLockManager {
  constructor() {
    this.wakeLock = null;
    this.fallbackVideo = null;
    this.supported = 'wakeLock' in navigator;
    this.method = null;
  }
  
  async acquire() {
    if (this.supported) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          console.warn('Wake lock released');
          this.wakeLock = null;
          
          // Auto-reacquire if still recording
          if (AppState.isRecording && !AppState.isPaused) {
            console.log('Auto-reacquiring wake lock...');
            setTimeout(() => this.acquire(), 1000);
          }
        });
        this.method = 'wakeLock';
        console.log('Wake lock acquired');
        return { method: 'wakeLock', success: true };
      } catch (e) {
        console.warn('Wake lock failed, trying fallback:', e);
      }
    }
    
    return this.acquireFallback();
  }
  
  async acquireFallback() {
    if (!this.fallbackVideo) {
      this.fallbackVideo = document.createElement('video');
      this.fallbackVideo.setAttribute('playsinline', '');
      this.fallbackVideo.setAttribute('muted', '');
      this.fallbackVideo.muted = true;
      this.fallbackVideo.style.cssText = 'position:fixed;top:-1px;left:-1px;width:1px;height:1px;opacity:0;pointer-events:none;';
      
      // Tiny silent video data URI
      this.fallbackVideo.src = 'data:video/mp4;base64,AAAAIGZ0eXBtcDQyAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA0NtZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE1NyByMjk4MCBkMGEyZTU1IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxOCAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTYgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAABIGWIhAAz//727L4FNf2f0JcRLMXaSnA+KqSAgHc0wAAAAwAAAwAAFgn0IAAABANAAAE1gAAAAwAAU7trAR4AAADLAAAR4QAAABcABECjAYVUDGwaA94AAAADAAAABgAAAAoAERAkk6AAAAMAAAADgAAAABEABECjAYVUDGwaA94AAAADAAAABgAAAAoAERAkk6A=';
      this.fallbackVideo.loop = true;
      document.body.appendChild(this.fallbackVideo);
    }
    
    try {
      await this.fallbackVideo.play();
      this.method = 'video';
      return { method: 'video', success: true };
    } catch (e) {
      this.method = null;
      return { method: 'none', success: false, error: e.message };
    }
  }
  
  async release() {
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch (e) {}
      this.wakeLock = null;
    }
    if (this.fallbackVideo) {
      this.fallbackVideo.pause();
    }
    this.method = null;
  }
  
  async reacquire() {
    if (this.method === 'wakeLock' && !this.wakeLock) {
      await this.acquire();
    }
  }
}

// ============================================
// Recording Control
// ============================================

async function startRecording(sessionName = null) {
  if (AppState.isRecording) return;
  
  try {
    // Make sure camera is ready
    if (!AppState.videoElement || AppState.videoElement.videoWidth === 0) {
      await initCamera();
      // Wait a bit for camera to stabilize
      await new Promise(r => setTimeout(r, 500));
    }
    
    // Create session
    AppState.currentSession = await Storage.createSession(sessionName, {
      captureInterval: AppState.settings.captureInterval,
      imageQuality: AppState.settings.imageQuality,
      imageMaxWidth: AppState.settings.imageMaxWidth
    });
    
    AppState.sequenceNum = 0;
    AppState.startTime = Date.now();
    AppState.isRecording = true;
    AppState.isPaused = false;
    
    // Initialize sensors
    AppState.gpsManager = new GPSManager();
    AppState.gpsManager.onUpdate = updateGPSDisplay;
    AppState.gpsManager.onStale = () => updateGPSStatus('stale');
    AppState.gpsManager.onError = (e) => {
      console.error('GPS error:', e);
      updateGPSStatus('error');
    };
    AppState.gpsManager.start();
    
    AppState.accelManager = new AccelerometerManager();
    const accelPermission = await AppState.accelManager.requestPermission();
    if (accelPermission) {
      AppState.accelManager.start();
      console.log('Accelerometer started');
    } else {
      console.warn('Accelerometer permission denied - continuing without it');
    }
    
    // Acquire wake lock
    AppState.wakeLockManager = new WakeLockManager();
    await AppState.wakeLockManager.acquire();
    
    // Handle visibility change
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Start mini map
    if (CONFIG.MAPBOX_TOKEN) {
      try {
        await CoverageMap.initMiniMap('mini-map', CONFIG.MAPBOX_TOKEN);
        CoverageMap.startLiveTrack();
        document.getElementById('mini-map-container').style.display = 'block';
      } catch (e) {
        console.warn('Mini map failed:', e);
      }
    }
    
    // Start capture interval
    startCaptureLoop();
    
    // Start recording timer
    startRecordingTimer();
    
    // Update UI
    updateRecordingUI();
    document.getElementById('capacity-bar').classList.add('visible');
    
    showToast('Recording started', 'success');
    
  } catch (error) {
    console.error('Failed to start recording:', error);
    showToast('Failed to start recording: ' + error.message, 'error');
    await stopRecording();
  }
}

async function pauseRecording() {
  if (!AppState.isRecording || AppState.isPaused) return;
  
  AppState.isPaused = true;
  
  // Stop capture loop
  if (AppState.captureInterval) {
    clearInterval(AppState.captureInterval);
    AppState.captureInterval = null;
  }
  
  // Update session
  if (AppState.currentSession) {
    AppState.currentSession.status = 'paused';
    await Storage.updateSession(AppState.currentSession);
  }
  
  updateRecordingUI();
  showToast('Recording paused', 'info');
}

async function resumeRecording() {
  if (!AppState.currentSession || !AppState.isPaused) return;
  
  AppState.isPaused = false;
  AppState.isRecording = true;
  
  // Update session
  AppState.currentSession.status = 'recording';
  await Storage.updateSession(AppState.currentSession);
  
  // Restart capture loop
  startCaptureLoop();
  
  // Reacquire wake lock
  if (AppState.wakeLockManager) {
    await AppState.wakeLockManager.reacquire();
  }
  
  updateRecordingUI();
  showToast('Recording resumed', 'success');
}

async function stopRecording() {
  AppState.isRecording = false;
  AppState.isPaused = false;
  
  // Stop capture loop
  if (AppState.captureInterval) {
    clearInterval(AppState.captureInterval);
    AppState.captureInterval = null;
  }
  
  // Stop timer
  if (AppState.recordingTimer) {
    clearInterval(AppState.recordingTimer);
    AppState.recordingTimer = null;
  }
  
  // Stop sensors
  if (AppState.gpsManager) {
    AppState.gpsManager.stop();
    AppState.gpsManager = null;
  }
  
  if (AppState.accelManager) {
    AppState.accelManager.stop();
    AppState.accelManager = null;
  }
  
  // Release wake lock
  if (AppState.wakeLockManager) {
    await AppState.wakeLockManager.release();
    AppState.wakeLockManager = null;
  }
  
  // Stop mini map tracking
  CoverageMap.stopLiveTrack();
  document.getElementById('mini-map-container').style.display = 'none';
  
  // Remove visibility handler
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  
  // Update session
  if (AppState.currentSession) {
    AppState.currentSession.status = 'stopped';
    AppState.currentSession.duration = Math.floor((Date.now() - AppState.startTime) / 1000);
    await Storage.updateSession(AppState.currentSession);
  }
  
  updateRecordingUI();
  showToast('Recording stopped', 'info');
}

function startCaptureLoop() {
  // Clear any existing interval
  if (AppState.captureInterval) {
    clearInterval(AppState.captureInterval);
  }
  
  // Capture immediately
  captureFrame();
  
  // Then at interval
  AppState.captureInterval = setInterval(captureFrame, AppState.settings.captureInterval);
}

async function captureFrame() {
  if (!AppState.isRecording || AppState.isPaused) return;
  
  try {
    // Get image
    const imageBlob = await captureImage();
    if (!imageBlob) {
      console.warn('Failed to capture image, skipping frame');
      return;
    }
    
    // Get sensor readings
    const gpsReading = AppState.gpsManager?.getCurrentReading() || { available: false };
    const accelReading = AppState.accelManager?.getCurrentReading();
    
    // Create capture record
    AppState.sequenceNum++;
    
    const capture = {
      sessionId: AppState.currentSession.id,
      sequenceNum: AppState.sequenceNum,
      timestamp: new Date().toISOString(),
      timezoneOffset: new Date().getTimezoneOffset(),
      gps: gpsReading.available ? {
        lat: gpsReading.lat,
        lng: gpsReading.lng,
        accuracy: gpsReading.accuracy,
        timestamp: gpsReading.timestamp,
        stale: gpsReading.stale || false
      } : null,
      accel: accelReading ? {
        x: Math.round(accelReading.x * 100) / 100,
        y: Math.round(accelReading.y * 100) / 100,
        z: Math.round(accelReading.z * 100) / 100
      } : null,
      imageBlob,
      imageSizeBytes: imageBlob.size,
      published: false,
      publishedUrl: null
    };
    
    // Save to IndexedDB
    await Storage.saveCapture(capture);
    
    console.log('Captured frame', AppState.sequenceNum, 'size:', imageBlob.size);
    
    // Update mini map
    if (gpsReading.available) {
      CoverageMap.updateLiveTrack(gpsReading.lng, gpsReading.lat);
      CoverageMap.setCurrentPosition(gpsReading.lat, gpsReading.lng);
    }
    
    // Update UI
    updateCaptureCounter();
    updateCapacityBar();
    updateAccelDisplay(accelReading);
    
    // Check quota
    await checkQuotaWarnings();
    
  } catch (error) {
    console.error('Capture failed:', error);
  }
}

function startRecordingTimer() {
  if (AppState.recordingTimer) {
    clearInterval(AppState.recordingTimer);
  }
  
  updateRecordingTime();
  AppState.recordingTimer = setInterval(() => {
    if (!AppState.isPaused) {
      updateRecordingTime();
    }
  }, 1000);
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && AppState.isRecording && !AppState.isPaused) {
    // Reacquire wake lock when returning to app
    if (AppState.wakeLockManager) {
      AppState.wakeLockManager.reacquire();
    }
  }
}

// ============================================
// Session Recovery
// ============================================

async function checkRecovery() {
  const recoverableSessions = await Storage.checkForRecovery();
  
  if (recoverableSessions.length > 0) {
    const session = recoverableSessions[0];
    showRecoveryModal(session);
  }
}

function showRecoveryModal(session) {
  document.getElementById('recovery-session-name').textContent = session.name || 'Unnamed';
  document.getElementById('recovery-capture-count').textContent = session.captureCount;
  
  if (session.recoveryInfo?.potentialMissedFrames > 0) {
    document.getElementById('recovery-gap-warning').style.display = 'flex';
    document.getElementById('recovery-missed-frames').textContent = session.recoveryInfo.potentialMissedFrames;
  } else {
    document.getElementById('recovery-gap-warning').style.display = 'none';
  }
  
  document.getElementById('recovery-modal').style.display = 'flex';
  
  // Store session for resume
  AppState.recoverySession = session;
}

async function resumeRecoverySession() {
  const session = AppState.recoverySession;
  if (!session) return;
  
  hideModal('recovery-modal');
  
  // Load session
  AppState.currentSession = session;
  AppState.sequenceNum = session.captureCount;
  AppState.startTime = Date.now() - (session.duration * 1000);
  
  // Update session status first
  session.status = 'recording';
  await Storage.updateSession(session);
  
  // Now start recording components
  AppState.isRecording = true;
  AppState.isPaused = false;
  
  // Initialize sensors
  AppState.gpsManager = new GPSManager();
  AppState.gpsManager.onUpdate = updateGPSDisplay;
  AppState.gpsManager.start();
  
  AppState.accelManager = new AccelerometerManager();
  await AppState.accelManager.requestPermission();
  AppState.accelManager.start();
  
  AppState.wakeLockManager = new WakeLockManager();
  await AppState.wakeLockManager.acquire();
  
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  startCaptureLoop();
  startRecordingTimer();
  updateRecordingUI();
  document.getElementById('capacity-bar').classList.add('visible');
  
  showToast('Session resumed', 'success');
}

function discardRecoverySession() {
  hideModal('recovery-modal');
  AppState.recoverySession = null;
}

// ============================================
// UI Updates
// ============================================

function updateRecordingUI() {
  const idleControls = document.getElementById('controls-idle');
  const recordingControls = document.getElementById('controls-recording');
  const pausedControls = document.getElementById('controls-paused');
  const stoppedControls = document.getElementById('controls-stopped');
  const recordingIndicator = document.getElementById('recording-indicator');
  const capacityBar = document.getElementById('capacity-bar');
  
  // Hide all control sets
  idleControls.style.display = 'none';
  recordingControls.style.display = 'none';
  pausedControls.style.display = 'none';
  stoppedControls.style.display = 'none';
  
  // Reset indicator classes
  recordingIndicator.classList.remove('active', 'paused');
  
  if (AppState.isRecording && !AppState.isPaused) {
    recordingControls.style.display = 'flex';
    recordingIndicator.classList.add('active');
    capacityBar.classList.add('visible');
  } else if (AppState.isPaused) {
    pausedControls.style.display = 'flex';
    recordingIndicator.classList.add('paused');
    capacityBar.classList.add('visible');
  } else if (AppState.currentSession && AppState.currentSession.status === 'stopped') {
    stoppedControls.style.display = 'flex';
    capacityBar.classList.remove('visible');
  } else {
    idleControls.style.display = 'flex';
    capacityBar.classList.remove('visible');
  }
}

function updateRecordingTime() {
  if (!AppState.startTime) return;
  
  const elapsed = Math.floor((Date.now() - AppState.startTime) / 1000);
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  
  const timeStr = [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    seconds.toString().padStart(2, '0')
  ].join(':');
  
  document.getElementById('rec-time').textContent = timeStr;
}

function updateCaptureCounter() {
  document.getElementById('counter-value').textContent = AppState.sequenceNum;
}

function updateGPSDisplay(position) {
  const lat = position.lat.toFixed(6);
  const lng = position.lng.toFixed(6);
  document.getElementById('gps-coords').textContent = `${lat}, ${lng}`;
  
  const accuracyEl = document.getElementById('gps-accuracy');
  accuracyEl.textContent = `±${Math.round(position.accuracy)}m`;
  
  // Update accuracy color
  accuracyEl.classList.remove('warning', 'critical', 'stale');
  if (position.accuracy > 30) {
    accuracyEl.classList.add('critical');
  } else if (position.accuracy > 10) {
    accuracyEl.classList.add('warning');
  }
}

function updateGPSStatus(status) {
  const accuracyEl = document.getElementById('gps-accuracy');
  accuracyEl.classList.remove('warning', 'critical', 'stale');
  
  if (status === 'stale') {
    accuracyEl.classList.add('stale');
    accuracyEl.textContent = 'STALE';
  } else if (status === 'error') {
    accuracyEl.classList.add('critical');
    accuracyEl.textContent = 'ERROR';
  }
}

function updateAccelDisplay(reading) {
  const el = document.getElementById('accel-values');
  if (!reading) {
    el.textContent = '--';
    return;
  }
  
  const x = (reading.x || 0).toFixed(1);
  const y = (reading.y || 0).toFixed(1);
  const z = (reading.z || 0).toFixed(1);
  el.textContent = `${x},${y},${z}`;
}

async function updateCapacityBar() {
  if (!AppState.currentSession) return;
  
  const session = await Storage.getSession(AppState.currentSession.id);
  if (!session) return;
  
  const usedMB = (session.totalBytes || 0) / (1024 * 1024);
  const limitMB = AppState.settings.githubLimit;
  const percent = (usedMB / limitMB) * 100;
  
  const fill = document.getElementById('capacity-fill');
  fill.style.width = `${Math.min(percent, 100)}%`;
  
  fill.classList.remove('warning', 'critical');
  if (percent > 90) {
    fill.classList.add('critical');
  } else if (percent > 75) {
    fill.classList.add('warning');
  }
  
  document.getElementById('capacity-used').textContent = `${usedMB.toFixed(1)} MB`;
  document.getElementById('capacity-limit').textContent = `${limitMB} MB`;
  
  // Calculate remaining time
  if (session.avgImageSize > 0) {
    const remainingMB = limitMB - usedMB;
    const remainingCaptures = remainingMB / (session.avgImageSize / (1024 * 1024));
    const capturesPerSecond = 1000 / session.settings.captureInterval;
    const remainingSeconds = remainingCaptures / capturesPerSecond;
    
    document.getElementById('capacity-time').textContent = `~${formatDuration(remainingSeconds)} left`;
  }
}

async function updateStorageInfo() {
  const quota = await Storage.checkStorageQuota();
  
  if (quota.supported) {
    document.getElementById('local-storage-used').textContent = `${quota.usedMB} MB`;
    document.getElementById('local-storage-available').textContent = `${quota.quotaMB - quota.usedMB} MB`;
  }
}

async function checkQuotaWarnings() {
  const quota = await Storage.checkStorageQuota();
  
  if (quota.status === 'critical') {
    showWarning('Storage nearly full! Export your data now.', true);
  } else if (quota.status === 'warning') {
    showWarning('Storage getting full. Consider exporting data.');
  }
}

function showWarning(message, isError = false) {
  const banner = document.getElementById('warning-banner');
  const text = document.getElementById('warning-text');
  
  text.textContent = message;
  banner.classList.toggle('error', isError);
  banner.style.display = 'flex';
}

function hideWarning() {
  document.getElementById('warning-banner').style.display = 'none';
}

// ============================================
// Sessions List
// ============================================

async function loadSessionsList() {
  const sessions = await Storage.getAllSessions();
  const container = document.getElementById('sessions-list');
  const emptyState = document.getElementById('no-sessions');
  
  // Clear existing items (keep empty state)
  const items = container.querySelectorAll('.session-item');
  items.forEach(item => item.remove());
  
  if (sessions.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }
  
  emptyState.style.display = 'none';
  
  sessions.forEach(session => {
    const item = createSessionItem(session);
    container.appendChild(item);
  });
}

function createSessionItem(session) {
  const item = document.createElement('div');
  item.className = `session-item ${session.status}`;
  item.dataset.sessionId = session.id;
  
  const statusLabels = {
    recording: 'Recording',
    paused: 'Paused',
    stopped: 'Ready',
    publishing: 'Publishing',
    published: 'Published',
    partially_published: 'Partial'
  };
  
  const date = new Date(session.createdAt).toLocaleDateString();
  const size = ((session.totalBytes || 0) / (1024 * 1024)).toFixed(1);
  const duration = formatDuration(session.duration || 0);
  
  item.innerHTML = `
    <div class="session-header">
      <span class="session-name">${session.name || 'Unnamed Session'}</span>
      <span class="session-status ${session.status}">${statusLabels[session.status] || session.status}</span>
    </div>
    <div class="session-meta">
      <span>📅 ${date}</span>
      <span>📷 ${session.captureCount || 0}</span>
      <span>💾 ${size} MB</span>
      <span>⏱️ ${duration}</span>
    </div>
    <div class="session-actions">
      ${session.status === 'paused' || session.status === 'stopped' ? `
        <button class="btn btn-success session-resume" data-id="${session.id}">
          <span class="btn-icon">▶</span>
          <span class="btn-label">Resume</span>
        </button>
      ` : ''}
      ${session.status === 'stopped' || session.status === 'paused' ? `
        <button class="btn btn-primary session-publish" data-id="${session.id}">
          <span class="btn-icon">☁️</span>
          <span class="btn-label">Publish</span>
        </button>
      ` : ''}
      <button class="btn btn-secondary session-export" data-id="${session.id}">
        <span class="btn-icon">💾</span>
        <span class="btn-label">Export</span>
      </button>
      <button class="btn btn-danger session-delete" data-id="${session.id}">
        <span class="btn-icon">🗑️</span>
      </button>
    </div>
  `;
  
  // Add event listeners
  const resumeBtn = item.querySelector('.session-resume');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => resumeSession(session.id));
  }
  
  const publishBtn = item.querySelector('.session-publish');
  if (publishBtn) {
    publishBtn.addEventListener('click', () => publishSession(session.id));
  }
  
  const exportBtn = item.querySelector('.session-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportSession(session.id));
  }
  
  const deleteBtn = item.querySelector('.session-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => confirmDeleteSession(session.id));
  }
  
  return item;
}

async function resumeSession(sessionId) {
  const session = await Storage.getSession(sessionId);
  if (!session) return;
  
  hidePanel('sessions-panel');
  
  AppState.currentSession = session;
  AppState.sequenceNum = session.captureCount || 0;
  AppState.startTime = Date.now() - ((session.duration || 0) * 1000);
  
  await startRecording();
}

async function publishSession(sessionId) {
  hidePanel('sessions-panel');
  showPublishModal();
  
  try {
    await Publisher.startPublish(sessionId, {
      token: CONFIG.GITHUB_TOKEN,
      repo: CONFIG.GITHUB_REPO,
      branch: CONFIG.GITHUB_BRANCH,
      contributor: CONFIG.CONTRIBUTOR
    }, {
      onProgress: updatePublishProgress,
      onComplete: onPublishComplete,
      onError: onPublishError
    });
  } catch (error) {
    hideModal('publish-modal');
    showToast('Publish failed: ' + error.message, 'error');
  }
}

async function exportSession(sessionId) {
  showToast('Preparing export...', 'info');
  
  try {
    const result = await Publisher.exportSessionAsZip(sessionId, (progress) => {
      // Could show progress here
    });
    
    showToast(`Exported ${result.captureCount} captures`, 'success');
  } catch (error) {
    showToast('Export failed: ' + error.message, 'error');
  }
}

function confirmDeleteSession(sessionId) {
  AppState.sessionToDelete = sessionId;
  document.getElementById('delete-modal').style.display = 'flex';
}

async function deleteSession() {
  if (!AppState.sessionToDelete) return;
  
  try {
    await Storage.deleteSession(AppState.sessionToDelete);
    showToast('Session deleted', 'success');
    loadSessionsList();
  } catch (error) {
    showToast('Failed to delete session', 'error');
  }
  
  AppState.sessionToDelete = null;
  hideModal('delete-modal');
}

async function clearAllSessions() {
  if (!confirm('Delete ALL sessions? This cannot be undone.')) return;
  
  try {
    await Storage.deleteAllSessions();
    showToast('All sessions deleted', 'success');
    loadSessionsList();
  } catch (error) {
    showToast('Failed to clear sessions', 'error');
  }
}

// ============================================
// Publish UI
// ============================================

function showPublishModal() {
  document.getElementById('publish-modal').style.display = 'flex';
  document.getElementById('publish-progress-fill').style.width = '0%';
  document.getElementById('publish-percent').textContent = '0%';
  document.getElementById('publish-status').textContent = 'Preparing...';
  document.getElementById('publish-errors').style.display = 'none';
}

function updatePublishProgress(progress) {
  document.getElementById('publish-progress-fill').style.width = `${progress.percent}%`;
  document.getElementById('publish-completed').textContent = progress.completed;
  document.getElementById('publish-total').textContent = progress.total;
  document.getElementById('publish-percent').textContent = `${progress.percent}%`;
  document.getElementById('publish-time').textContent = progress.estimatedTime || 'Calculating...';
  
  if (progress.status) {
    document.getElementById('publish-status').textContent = progress.status;
  } else {
    document.getElementById('publish-status').textContent = `Uploading ${progress.completed + 1} of ${progress.total}...`;
  }
  
  if (progress.failed > 0) {
    document.getElementById('publish-errors').style.display = 'flex';
    document.getElementById('publish-error-count').textContent = progress.failed;
  }
}

function onPublishComplete(result) {
  hideModal('publish-modal');
  
  if (result.failed > 0) {
    showToast(`Published with ${result.failed} failures`, 'warning');
  } else {
    showToast('Published successfully!', 'success');
  }
  
  loadSessionsList();
}

function onPublishError(error) {
  document.getElementById('publish-status').textContent = `Error: ${error.message}`;
}

// ============================================
// Map View
// ============================================

async function showMapView() {
  document.getElementById('camera-view').classList.remove('active');
  document.getElementById('map-view').classList.add('active');
  AppState.currentView = 'map';
  
  // Initialize map if needed
  if (!CoverageMap.getState().initialized && CONFIG.MAPBOX_TOKEN) {
    await CoverageMap.init('coverage-map', CONFIG.MAPBOX_TOKEN);
    
    // Load coverage data
    if (CONFIG.GITHUB_REPO && CONFIG.GITHUB_TOKEN) {
      await CoverageMap.loadCoverage({
        repo: CONFIG.GITHUB_REPO,
        branch: CONFIG.GITHUB_BRANCH,
        token: CONFIG.GITHUB_TOKEN
      });
    }
    
    // Add local sessions
    await CoverageMap.addLocalSessions();
  }
}

function hideMapView() {
  document.getElementById('map-view').classList.remove('active');
  document.getElementById('camera-view').classList.add('active');
  AppState.currentView = 'camera';
}

// ============================================
// Panel Navigation
// ============================================

function showPanel(panelId) {
  document.getElementById(panelId).classList.add('active');
  
  if (panelId === 'sessions-panel') {
    loadSessionsList();
  }
}

function hidePanel(panelId) {
  document.getElementById(panelId).classList.remove('active');
}

function hideModal(modalId) {
  document.getElementById(modalId).style.display = 'none';
}

// ============================================
// Toast Notifications
// ============================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  
  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <span class="toast-message">${message}</span>
  `;
  
  container.appendChild(toast);
  
  // Auto remove
  setTimeout(() => {
    toast.classList.add('hiding');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================
// Utility Functions
// ============================================

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ============================================
// UI Event Handlers
// ============================================

function initializeUI() {
  // Recording controls
  document.getElementById('btn-start').addEventListener('click', () => {
    document.getElementById('session-name-modal').style.display = 'flex';
  });
  
  document.getElementById('btn-create-session').addEventListener('click', () => {
    const name = document.getElementById('session-name').value.trim();
    hideModal('session-name-modal');
    document.getElementById('session-name').value = '';
    startRecording(name || null);
  });
  
  document.getElementById('btn-cancel-session').addEventListener('click', () => {
    hideModal('session-name-modal');
    document.getElementById('session-name').value = '';
  });
  
  document.getElementById('btn-pause').addEventListener('click', pauseRecording);
  document.getElementById('btn-stop').addEventListener('click', stopRecording);
  document.getElementById('btn-resume').addEventListener('click', resumeRecording);
  document.getElementById('btn-stop-paused').addEventListener('click', stopRecording);
  
  document.getElementById('btn-new-session').addEventListener('click', () => {
    AppState.currentSession = null;
    updateRecordingUI();
  });
  
  document.getElementById('btn-publish').addEventListener('click', () => {
    if (AppState.currentSession) {
      publishSession(AppState.currentSession.id);
    }
  });
  
  document.getElementById('btn-export').addEventListener('click', () => {
    if (AppState.currentSession) {
      exportSession(AppState.currentSession.id);
    }
  });
  
  // Navigation
  document.getElementById('btn-sessions').addEventListener('click', () => showPanel('sessions-panel'));
  document.getElementById('sessions-back').addEventListener('click', () => hidePanel('sessions-panel'));
  
  document.getElementById('btn-map').addEventListener('click', showMapView);
  document.getElementById('map-back').addEventListener('click', hideMapView);
  document.getElementById('btn-record-here').addEventListener('click', () => {
    hideMapView();
    document.getElementById('session-name-modal').style.display = 'flex';
  });
  
  document.getElementById('btn-settings').addEventListener('click', () => showPanel('settings-panel'));
  document.getElementById('settings-back').addEventListener('click', () => hidePanel('settings-panel'));
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  
  // Sessions panel
  document.getElementById('btn-clear-all').addEventListener('click', clearAllSessions);
  
  // Delete modal
  document.getElementById('btn-cancel-delete').addEventListener('click', () => hideModal('delete-modal'));
  document.getElementById('btn-confirm-delete').addEventListener('click', deleteSession);
  
  // Recovery modal
  document.getElementById('btn-resume-recovery').addEventListener('click', resumeRecoverySession);
  document.getElementById('btn-discard-recovery').addEventListener('click', discardRecoverySession);
  
  // Publish modal
  document.getElementById('btn-pause-publish').addEventListener('click', () => {
    const btn = document.getElementById('btn-pause-publish');
    if (btn.textContent.includes('Pause')) {
      Publisher.pausePublish();
      btn.innerHTML = '<span class="btn-label">Resume</span>';
    } else {
      Publisher.resumePublish();
      btn.innerHTML = '<span class="btn-label">Pause</span>';
    }
  });
  
  document.getElementById('btn-cancel-publish').addEventListener('click', async () => {
    await Publisher.cancelPublish();
    hideModal('publish-modal');
    showToast('Publish cancelled', 'info');
  });
  
  // Warning banner
  document.getElementById('warning-dismiss').addEventListener('click', hideWarning);
}
