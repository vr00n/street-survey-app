/**
 * Storage Module - IndexedDB wrapper for sessions and captures
 * Handles local storage, quota monitoring, and data persistence
 */

// Database instance
let db = null;

// Database configuration
const DB_NAME = 'SensorCollectorDB';
const DB_VERSION = 1;

/**
 * Initialize the IndexedDB database
 */
async function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => {
      console.error('Failed to open database:', request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      db = request.result;
      console.log('Database opened successfully');
      resolve(db);
    };
    
    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      
      // Sessions store
      if (!database.objectStoreNames.contains('sessions')) {
        const sessionsStore = database.createObjectStore('sessions', { keyPath: 'id' });
        sessionsStore.createIndex('status', 'status', { unique: false });
        sessionsStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      
      // Captures store
      if (!database.objectStoreNames.contains('captures')) {
        const capturesStore = database.createObjectStore('captures', { keyPath: 'id', autoIncrement: true });
        capturesStore.createIndex('sessionId', 'sessionId', { unique: false });
        capturesStore.createIndex('sequenceNum', 'sequenceNum', { unique: false });
        capturesStore.createIndex('sessionSequence', ['sessionId', 'sequenceNum'], { unique: true });
        capturesStore.createIndex('published', 'published', { unique: false });
      }
      
      // Publish state store
      if (!database.objectStoreNames.contains('publishState')) {
        const publishStore = database.createObjectStore('publishState', { keyPath: 'sessionId' });
      }
      
      // Settings store
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
      
      console.log('Database schema created/upgraded');
    };
  });
}

/**
 * Request persistent storage to prevent data loss
 */
async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    console.log('Persistent storage:', granted ? 'granted' : 'denied');
    return granted;
  }
  return false;
}

/**
 * Check storage quota and usage
 */
async function checkStorageQuota() {
  if (!navigator.storage || !navigator.storage.estimate) {
    return { supported: false };
  }
  
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const usedMB = usage / (1024 * 1024);
    const quotaMB = quota / (1024 * 1024);
    const percentUsed = (usage / quota) * 100;
    
    let status = 'ok';
    if (percentUsed > 90) {
      status = 'critical';
    } else if (percentUsed > 75) {
      status = 'warning';
    }
    
    return {
      supported: true,
      usedBytes: usage,
      quotaBytes: quota,
      usedMB: Math.round(usedMB * 10) / 10,
      quotaMB: Math.round(quotaMB),
      percentUsed: Math.round(percentUsed * 10) / 10,
      status
    };
  } catch (error) {
    console.error('Error checking storage quota:', error);
    return { supported: false, error: error.message };
  }
}

// ============================================
// Session Operations
// ============================================

/**
 * Create a new session
 */
async function createSession(name = null, settings = {}) {
  const session = {
    id: `session_${Date.now()}`,
    name: name || `Session ${new Date().toLocaleDateString()}`,
    createdAt: new Date().toISOString(),
    status: 'recording',
    captureCount: 0,
    totalBytes: 0,
    avgImageSize: 0,
    duration: 0,
    startTime: Date.now(),
    lastCaptureTime: null,
    settings: {
      captureInterval: settings.captureInterval || 2000,
      imageQuality: settings.imageQuality || 0.7,
      imageMaxWidth: settings.imageMaxWidth || 1280
    }
  };
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');
    const request = store.add(session);
    
    request.onsuccess = () => resolve(session);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get a session by ID
 */
async function getSession(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const request = store.get(sessionId);
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update a session
 */
async function updateSession(session) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');
    const request = store.put(session);
    
    request.onsuccess = () => resolve(session);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all sessions
 */
async function getAllSessions() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const index = store.index('createdAt');
    const request = index.openCursor(null, 'prev'); // Newest first
    
    const sessions = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        sessions.push(cursor.value);
        cursor.continue();
      } else {
        resolve(sessions);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get sessions by status
 */
async function getSessionsByStatus(status) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const index = store.index('status');
    
    const statuses = Array.isArray(status) ? status : [status];
    const sessions = [];
    let completed = 0;
    
    statuses.forEach(s => {
      const request = index.getAll(s);
      request.onsuccess = () => {
        sessions.push(...request.result);
        completed++;
        if (completed === statuses.length) {
          resolve(sessions);
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Delete a session and all its captures
 */
async function deleteSession(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions', 'captures', 'publishState'], 'readwrite');
    
    // Delete session
    const sessionsStore = transaction.objectStore('sessions');
    sessionsStore.delete(sessionId);
    
    // Delete all captures for this session
    const capturesStore = transaction.objectStore('captures');
    const index = capturesStore.index('sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId));
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    
    // Delete publish state
    const publishStore = transaction.objectStore('publishState');
    publishStore.delete(sessionId);
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Delete all sessions and captures
 */
async function deleteAllSessions() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions', 'captures', 'publishState'], 'readwrite');
    
    transaction.objectStore('sessions').clear();
    transaction.objectStore('captures').clear();
    transaction.objectStore('publishState').clear();
    
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ============================================
// Capture Operations
// ============================================

/**
 * Save a capture
 * Note: We keep the imageBlob in IndexedDB - do NOT null it out
 */
async function saveCapture(capture) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures', 'sessions'], 'readwrite');
    
    // Save capture (blob is stored in IndexedDB)
    const capturesStore = transaction.objectStore('captures');
    const captureRequest = capturesStore.add(capture);
    
    // Update session stats
    const sessionsStore = transaction.objectStore('sessions');
    const sessionRequest = sessionsStore.get(capture.sessionId);
    
    sessionRequest.onsuccess = () => {
      const session = sessionRequest.result;
      if (session) {
        session.captureCount++;
        session.totalBytes += capture.imageSizeBytes || 0;
        session.avgImageSize = session.totalBytes / session.captureCount;
        session.lastCaptureTime = capture.timestamp;
        session.duration = Math.floor((Date.now() - session.startTime) / 1000);
        sessionsStore.put(session);
      }
    };
    
    captureRequest.onsuccess = () => resolve(captureRequest.result);
    captureRequest.onerror = () => reject(captureRequest.error);
  });
}

/**
 * Get all captures for a session
 */
async function getSessionCaptures(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures'], 'readonly');
    const store = transaction.objectStore('captures');
    const index = store.index('sessionId');
    const request = index.getAll(sessionId);
    
    request.onsuccess = () => {
      // Sort by sequence number
      const captures = request.result.sort((a, b) => a.sequenceNum - b.sequenceNum);
      resolve(captures);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get capture count for a session
 */
async function getSessionCaptureCount(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures'], 'readonly');
    const store = transaction.objectStore('captures');
    const index = store.index('sessionId');
    const request = index.count(sessionId);
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get unpublished captures for a session
 */
async function getUnpublishedCaptures(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures'], 'readonly');
    const store = transaction.objectStore('captures');
    const index = store.index('sessionId');
    const request = index.openCursor(IDBKeyRange.only(sessionId));
    
    const captures = [];
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (!cursor.value.published) {
          captures.push(cursor.value);
        }
        cursor.continue();
      } else {
        resolve(captures.sort((a, b) => a.sequenceNum - b.sequenceNum));
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update a capture (e.g., mark as published)
 */
async function updateCapture(capture) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures'], 'readwrite');
    const store = transaction.objectStore('captures');
    const request = store.put(capture);
    
    request.onsuccess = () => resolve(capture);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mark capture as published
 */
async function markCapturePublished(captureId, publishedUrl) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['captures'], 'readwrite');
    const store = transaction.objectStore('captures');
    const request = store.get(captureId);
    
    request.onsuccess = () => {
      const capture = request.result;
      if (capture) {
        capture.published = true;
        capture.publishedUrl = publishedUrl;
        store.put(capture);
        resolve(capture);
      } else {
        reject(new Error('Capture not found'));
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Find gaps in sequence numbers (for crash recovery)
 */
function findSequenceGaps(captures) {
  const gaps = [];
  for (let i = 1; i < captures.length; i++) {
    const expected = captures[i - 1].sequenceNum + 1;
    const actual = captures[i].sequenceNum;
    if (actual !== expected) {
      gaps.push({
        after: captures[i - 1].sequenceNum,
        before: captures[i].sequenceNum,
        missing: actual - expected
      });
    }
  }
  return gaps;
}

// ============================================
// Publish State Operations
// ============================================

/**
 * Save or update publish state
 */
async function savePublishState(state) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['publishState'], 'readwrite');
    const store = transaction.objectStore('publishState');
    const request = store.put(state);
    
    request.onsuccess = () => resolve(state);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get publish state for a session
 */
async function getPublishState(sessionId) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['publishState'], 'readonly');
    const store = transaction.objectStore('publishState');
    const request = store.get(sessionId);
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Settings Operations
// ============================================

/**
 * Save a setting
 */
async function saveSetting(key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readwrite');
    const store = transaction.objectStore('settings');
    const request = store.put({ key, value });
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get a setting
 */
async function getSetting(key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');
    const request = store.get(key);
    
    request.onsuccess = () => {
      resolve(request.result ? request.result.value : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all settings
 */
async function getAllSettings() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');
    const request = store.getAll();
    
    request.onsuccess = () => {
      const settings = {};
      request.result.forEach(item => {
        settings[item.key] = item.value;
      });
      resolve(settings);
    };
    request.onerror = () => reject(request.error);
  });
}

// ============================================
// Recovery Operations
// ============================================

/**
 * Check for sessions that need recovery
 */
async function checkForRecovery() {
  const activeSessions = await getSessionsByStatus(['recording', 'publishing']);
  const recoverableSessions = [];
  
  for (const session of activeSessions) {
    const captures = await getSessionCaptures(session.id);
    const gaps = findSequenceGaps(captures);
    
    if (gaps.length > 0) {
      session.recoveryInfo = {
        potentialMissedFrames: gaps.reduce((sum, g) => sum + g.missing, 0),
        lastCaptureTime: captures.length > 0 ? captures[captures.length - 1].timestamp : null,
        gaps
      };
    }
    
    // Reset status to paused
    session.status = 'paused';
    await updateSession(session);
    
    recoverableSessions.push(session);
  }
  
  return recoverableSessions;
}

// ============================================
// Export for module usage
// ============================================

// Make functions available globally for non-module usage
window.Storage = {
  init: initDatabase,
  requestPersistentStorage,
  checkStorageQuota,
  
  // Sessions
  createSession,
  getSession,
  updateSession,
  getAllSessions,
  getSessionsByStatus,
  deleteSession,
  deleteAllSessions,
  
  // Captures
  saveCapture,
  getSessionCaptures,
  getSessionCaptureCount,
  getUnpublishedCaptures,
  updateCapture,
  markCapturePublished,
  findSequenceGaps,
  
  // Publish state
  savePublishState,
  getPublishState,
  
  // Settings
  saveSetting,
  getSetting,
  getAllSettings,
  
  // Recovery
  checkForRecovery
};

