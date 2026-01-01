/**
 * Publisher Module - GitHub upload with resilient retry logic
 * Handles uploading sessions to GitHub with progress tracking and error recovery
 */

// Publisher state
let publisherState = {
  isPublishing: false,
  isPaused: false,
  currentSession: null,
  queue: [],
  completed: 0,
  failed: 0,
  total: 0,
  startTime: null,
  onProgress: null,
  onComplete: null,
  onError: null
};

// GitHub API base URL
const GITHUB_API = 'https://api.github.com';

// ============================================
// GitHub API Helpers
// ============================================

/**
 * Validate GitHub access before publishing
 */
async function validateGitHubAccess(config) {
  const errors = [];
  
  try {
    // Test token validity
    const userResponse = await fetch(`${GITHUB_API}/user`, {
      headers: {
        'Authorization': `token ${config.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (userResponse.status === 401) {
      errors.push('GitHub token is invalid or expired');
      return { valid: false, errors };
    }
    
    if (!userResponse.ok) {
      errors.push(`GitHub API error: ${userResponse.status}`);
      return { valid: false, errors };
    }
    
    const userData = await userResponse.json();
    
    // Test repo access
    const [owner, repo] = config.repo.split('/');
    const repoResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
      headers: {
        'Authorization': `token ${config.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    if (repoResponse.status === 404) {
      errors.push('Repository not found or no access');
      return { valid: false, errors };
    }
    
    if (!repoResponse.ok) {
      errors.push(`Repository access error: ${repoResponse.status}`);
      return { valid: false, errors };
    }
    
    const repoData = await repoResponse.json();
    
    if (!repoData.permissions?.push) {
      errors.push('Token does not have write access to repository');
      return { valid: false, errors };
    }
    
    // Check rate limit
    const rateLimitResponse = await fetch(`${GITHUB_API}/rate_limit`, {
      headers: {
        'Authorization': `token ${config.token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    
    const rateLimitData = await rateLimitResponse.json();
    const remaining = rateLimitData.resources.core.remaining;
    const resetTime = new Date(rateLimitData.resources.core.reset * 1000);
    
    if (remaining < 100) {
      errors.push(`Low API quota: ${remaining} remaining. Resets at ${resetTime.toLocaleTimeString()}`);
    }
    
    return {
      valid: errors.length === 0,
      errors,
      user: userData.login,
      rateLimit: {
        remaining,
        limit: rateLimitData.resources.core.limit,
        resetTime
      }
    };
    
  } catch (error) {
    errors.push(`Network error: ${error.message}`);
    return { valid: false, errors };
  }
}

/**
 * Check if a file exists in the repository
 */
async function fileExists(config, path) {
  const [owner, repo] = config.repo.split('/');
  
  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${config.branch || 'main'}`,
      {
        headers: {
          'Authorization': `token ${config.token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    if (response.status === 200) {
      const data = await response.json();
      return { exists: true, sha: data.sha, downloadUrl: data.download_url };
    }
    
    return { exists: false };
  } catch (error) {
    return { exists: false, error: error.message };
  }
}

/**
 * Upload a file to GitHub
 */
async function uploadFile(config, path, content, message, existingSha = null) {
  const [owner, repo] = config.repo.split('/');
  
  const body = {
    message,
    content: typeof content === 'string' ? btoa(unescape(encodeURIComponent(content))) : content,
    branch: config.branch || 'main'
  };
  
  if (existingSha) {
    body.sha = existingSha;
  }
  
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${config.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || `Upload failed: ${response.status}`);
  }
  
  const data = await response.json();
  return {
    url: data.content.download_url,
    sha: data.content.sha,
    path: data.content.path
  };
}

/**
 * Upload an image blob to GitHub
 */
async function uploadImage(config, capture, sessionId) {
  const path = `sessions/${sessionId}/images/${capture.sequenceNum.toString().padStart(6, '0')}.jpg`;
  
  // Check if file already exists (idempotent upload)
  const existing = await fileExists(config, path);
  if (existing.exists) {
    console.log(`Image already exists: ${path}`);
    return { url: existing.downloadUrl, skipped: true };
  }
  
  // Convert blob to base64
  const base64 = await blobToBase64(capture.imageBlob);
  
  const result = await uploadFile(
    config,
    path,
    base64,
    `Upload image ${capture.sequenceNum}`
  );
  
  return { url: result.url, skipped: false };
}

/**
 * Convert blob to base64
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      // Remove data URL prefix
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============================================
// Publish Queue Management
// ============================================

/**
 * Start publishing a session
 */
async function startPublish(sessionId, config, callbacks = {}) {
  if (publisherState.isPublishing) {
    throw new Error('Already publishing');
  }
  
  // Validate GitHub access first
  const validation = await validateGitHubAccess(config);
  if (!validation.valid) {
    throw new Error(validation.errors.join('\n'));
  }
  
  // Get session and captures
  const session = await Storage.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  const captures = await Storage.getUnpublishedCaptures(sessionId);
  if (captures.length === 0) {
    throw new Error('No captures to publish');
  }
  
  // Initialize publish state
  publisherState = {
    isPublishing: true,
    isPaused: false,
    currentSession: session,
    config,
    queue: [...captures],
    completed: 0,
    failed: 0,
    total: captures.length,
    startTime: Date.now(),
    onProgress: callbacks.onProgress,
    onComplete: callbacks.onComplete,
    onError: callbacks.onError
  };
  
  // Save publish state to IndexedDB
  await Storage.savePublishState({
    sessionId,
    publishStarted: new Date().toISOString(),
    totalToUpload: captures.length,
    completed: 0,
    failed: 0,
    inProgress: true
  });
  
  // Update session status
  session.status = 'publishing';
  await Storage.updateSession(session);
  
  // Start processing queue
  processQueue();
  
  return { total: captures.length };
}

/**
 * Process the upload queue
 */
async function processQueue() {
  while (publisherState.queue.length > 0 && publisherState.isPublishing && !publisherState.isPaused) {
    // Check if online
    if (!navigator.onLine) {
      reportProgress('Waiting for network...');
      await waitForOnline();
    }
    
    const capture = publisherState.queue[0];
    
    try {
      reportProgress(`Uploading image ${capture.sequenceNum}...`);
      
      const result = await uploadWithRetry(capture);
      
      // Mark as published
      await Storage.markCapturePublished(capture.id, result.url);
      
      // Update state
      publisherState.completed++;
      publisherState.queue.shift();
      
      // Save progress
      await Storage.savePublishState({
        sessionId: publisherState.currentSession.id,
        publishStarted: new Date(publisherState.startTime).toISOString(),
        totalToUpload: publisherState.total,
        completed: publisherState.completed,
        failed: publisherState.failed,
        inProgress: true
      });
      
      reportProgress();
      
      // Small delay to avoid rate limiting
      await delay(500);
      
    } catch (error) {
      console.error('Upload failed:', error);
      publisherState.failed++;
      publisherState.queue.shift(); // Move to next
      
      if (publisherState.onError) {
        publisherState.onError(error, capture);
      }
    }
  }
  
  // Check if complete
  if (publisherState.queue.length === 0 && publisherState.isPublishing) {
    await finishPublish();
  }
}

/**
 * Upload with retry logic
 */
async function uploadWithRetry(capture, maxRetries = 5) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Check network
      if (!navigator.onLine) {
        await waitForOnline();
      }
      
      const result = await uploadImage(
        publisherState.config,
        capture,
        publisherState.currentSession.id
      );
      
      return result;
      
    } catch (error) {
      lastError = error;
      console.warn(`Upload attempt ${attempt} failed:`, error.message);
      
      // Check for rate limit
      if (error.message.includes('rate limit') || error.message.includes('403')) {
        reportProgress('Rate limited. Waiting...');
        await delay(60000); // Wait 1 minute
      } else if (attempt < maxRetries) {
        // Exponential backoff
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 60000);
        await delay(waitTime);
      }
    }
  }
  
  throw lastError;
}

/**
 * Finish publishing - upload metadata and CSV
 */
async function finishPublish() {
  const session = publisherState.currentSession;
  const config = publisherState.config;
  
  try {
    reportProgress('Uploading metadata...');
    
    // Get all captures with published URLs
    const captures = await Storage.getSessionCaptures(session.id);
    
    // Generate CSV
    const csv = generateCSV(captures);
    await uploadFile(
      config,
      `sessions/${session.id}/data.csv`,
      csv,
      `Upload data.csv for session ${session.id}`
    );
    
    // Generate metadata
    const metadata = {
      sessionId: session.id,
      name: session.name,
      device: navigator.userAgent,
      startTime: session.createdAt,
      endTime: new Date().toISOString(),
      totalCaptures: captures.length,
      publishedCaptures: publisherState.completed,
      failedCaptures: publisherState.failed,
      settings: session.settings,
      contributor: config.contributor || 'anonymous'
    };
    
    await uploadFile(
      config,
      `sessions/${session.id}/metadata.json`,
      JSON.stringify(metadata, null, 2),
      `Upload metadata for session ${session.id}`
    );
    
    // Update coverage index
    await updateCoverageIndex(session, captures, config);
    
    // Update session status
    session.status = publisherState.failed > 0 ? 'partially_published' : 'published';
    await Storage.updateSession(session);
    
    // Clear publish state
    await Storage.savePublishState({
      sessionId: session.id,
      publishStarted: new Date(publisherState.startTime).toISOString(),
      totalToUpload: publisherState.total,
      completed: publisherState.completed,
      failed: publisherState.failed,
      inProgress: false,
      completedAt: new Date().toISOString()
    });
    
    publisherState.isPublishing = false;
    
    if (publisherState.onComplete) {
      publisherState.onComplete({
        completed: publisherState.completed,
        failed: publisherState.failed,
        total: publisherState.total
      });
    }
    
  } catch (error) {
    console.error('Failed to finish publish:', error);
    if (publisherState.onError) {
      publisherState.onError(error);
    }
  }
}

/**
 * Pause publishing
 */
function pausePublish() {
  publisherState.isPaused = true;
  reportProgress('Paused');
}

/**
 * Resume publishing
 */
function resumePublish() {
  if (publisherState.isPaused) {
    publisherState.isPaused = false;
    processQueue();
  }
}

/**
 * Cancel publishing
 */
async function cancelPublish() {
  publisherState.isPublishing = false;
  publisherState.isPaused = false;
  publisherState.queue = [];
  
  if (publisherState.currentSession) {
    const session = await Storage.getSession(publisherState.currentSession.id);
    if (session) {
      session.status = 'stopped';
      await Storage.updateSession(session);
    }
  }
}

/**
 * Get current publish progress
 */
function getPublishProgress() {
  if (!publisherState.isPublishing) {
    return null;
  }
  
  const elapsed = Date.now() - publisherState.startTime;
  const rate = publisherState.completed / (elapsed / 1000);
  const remaining = publisherState.queue.length;
  const estimatedSeconds = rate > 0 ? remaining / rate : 0;
  
  return {
    completed: publisherState.completed,
    failed: publisherState.failed,
    total: publisherState.total,
    remaining,
    percent: Math.round((publisherState.completed / publisherState.total) * 100),
    estimatedTime: formatDuration(estimatedSeconds),
    isPaused: publisherState.isPaused
  };
}

// ============================================
// Coverage Index
// ============================================

/**
 * Update the coverage index after publishing
 */
async function updateCoverageIndex(session, captures, config) {
  try {
    // Load existing coverage index
    let index = await loadCoverageIndex(config);
    
    // Create LineString from session coordinates
    const coordinates = captures
      .filter(c => c.gps?.lat && c.gps?.lng)
      .map(c => [c.gps.lng, c.gps.lat]);
    
    if (coordinates.length < 2) {
      console.warn('Not enough GPS points for coverage index');
      return;
    }
    
    // Create and simplify line
    const line = turf.lineString(coordinates);
    const simplified = turf.simplify(line, { tolerance: 0.0001, highQuality: true });
    
    // Add properties
    simplified.properties = {
      sessionId: session.id,
      name: session.name,
      collectedAt: session.createdAt,
      collector: config.contributor || 'anonymous',
      imageCount: captures.length,
      published: true
    };
    
    // Remove existing entry for this session if present
    index.features = index.features.filter(f => f.properties.sessionId !== session.id);
    
    // Add new entry
    index.features.push(simplified);
    index.generatedAt = new Date().toISOString();
    index.stats = calculateCoverageStats(index);
    
    // Upload updated index
    const existing = await fileExists(config, 'coverage-index.geojson');
    await uploadFile(
      config,
      'coverage-index.geojson',
      JSON.stringify(index, null, 2),
      'Update coverage index',
      existing.exists ? existing.sha : null
    );
    
    console.log('Coverage index updated');
    
  } catch (error) {
    console.error('Failed to update coverage index:', error);
    // Don't throw - this is not critical
  }
}

/**
 * Load coverage index from GitHub
 */
async function loadCoverageIndex(config) {
  const [owner, repo] = config.repo.split('/');
  
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${config.branch || 'main'}/coverage-index.geojson`,
      { cache: 'no-store' }
    );
    
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.warn('Could not load existing coverage index:', error);
  }
  
  // Return empty index
  return {
    type: 'FeatureCollection',
    generatedAt: new Date().toISOString(),
    stats: {
      totalSessions: 0,
      totalKilometers: 0,
      totalImages: 0,
      contributors: 0
    },
    features: []
  };
}

/**
 * Calculate coverage statistics
 */
function calculateCoverageStats(index) {
  const totalKm = index.features.reduce((sum, f) => {
    return sum + turf.length(f, { units: 'kilometers' });
  }, 0);
  
  const totalImages = index.features.reduce((sum, f) => {
    return sum + (f.properties.imageCount || 0);
  }, 0);
  
  const contributors = new Set(index.features.map(f => f.properties.collector));
  
  return {
    totalSessions: index.features.length,
    totalKilometers: Math.round(totalKm * 10) / 10,
    totalImages,
    contributors: contributors.size
  };
}

// ============================================
// Utility Functions
// ============================================

/**
 * Generate CSV from captures
 */
function generateCSV(captures) {
  const headers = ['sequence', 'timestamp', 'gps_lat', 'gps_lng', 'gps_accuracy', 'gps_stale', 'image_url', 'accel_x', 'accel_y', 'accel_z'];
  
  const rows = captures.map(c => [
    c.sequenceNum,
    c.timestamp,
    c.gps?.lat ?? '',
    c.gps?.lng ?? '',
    c.gps?.accuracy ?? '',
    c.gps?.stale ?? '',
    c.publishedUrl || '',
    c.accel?.x ?? '',
    c.accel?.y ?? '',
    c.accel?.z ?? ''
  ]);
  
  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

/**
 * Report progress
 */
function reportProgress(status = null) {
  if (publisherState.onProgress) {
    const progress = getPublishProgress();
    if (status) {
      progress.status = status;
    }
    publisherState.onProgress(progress);
  }
}

/**
 * Wait for online status
 */
function waitForOnline() {
  return new Promise(resolve => {
    if (navigator.onLine) {
      resolve();
      return;
    }
    
    const handler = () => {
      window.removeEventListener('online', handler);
      resolve();
    };
    
    window.addEventListener('online', handler);
  });
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format duration in seconds to human readable
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ============================================
// Local Export (ZIP)
// ============================================

/**
 * Export session as ZIP file
 */
async function exportSessionAsZip(sessionId, onProgress = null) {
  const session = await Storage.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  const captures = await Storage.getSessionCaptures(sessionId);
  if (captures.length === 0) {
    throw new Error('No captures to export');
  }
  
  const zip = new JSZip();
  
  // Add images folder
  const imagesFolder = zip.folder('images');
  let processed = 0;
  let imagesAdded = 0;
  
  for (const capture of captures) {
    const filename = `${capture.sequenceNum.toString().padStart(6, '0')}.jpg`;
    
    // Check if imageBlob exists and is valid
    if (capture.imageBlob && capture.imageBlob instanceof Blob && capture.imageBlob.size > 0) {
      imagesFolder.file(filename, capture.imageBlob);
      imagesAdded++;
    } else {
      console.warn(`Capture ${capture.sequenceNum} has no valid image blob`);
    }
    
    processed++;
    if (onProgress) {
      onProgress({
        phase: 'preparing',
        current: processed,
        total: captures.length,
        percent: Math.round((processed / captures.length) * 50)
      });
    }
  }
  
  if (imagesAdded === 0) {
    throw new Error('No images found in session. Images may have been cleared from storage.');
  }
  
  // Generate CSV
  const csv = generateCSV(captures);
  zip.file('data.csv', csv);
  
  // Add metadata
  const metadata = {
    sessionId: session.id,
    name: session.name,
    createdAt: session.createdAt,
    captureCount: captures.length,
    imagesExported: imagesAdded,
    exportedAt: new Date().toISOString(),
    settings: session.settings
  };
  zip.file('metadata.json', JSON.stringify(metadata, null, 2));
  
  // Generate ZIP
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    },
    (meta) => {
      if (onProgress) {
        onProgress({
          phase: 'compressing',
          percent: 50 + Math.round(meta.percent / 2)
        });
      }
    }
  );
  
  // Trigger download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.name || session.id}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  return {
    filename: `${session.name || session.id}.zip`,
    size: blob.size,
    captureCount: imagesAdded
  };
}

/**
 * Export CSV only (lightweight)
 */
async function exportSessionAsCSV(sessionId) {
  const session = await Storage.getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  const captures = await Storage.getSessionCaptures(sessionId);
  const csv = generateCSV(captures);
  
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.name || session.id}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  return { filename: `${session.name || session.id}.csv` };
}

// ============================================
// Export for module usage
// ============================================

window.Publisher = {
  validateGitHubAccess,
  startPublish,
  pausePublish,
  resumePublish,
  cancelPublish,
  getPublishProgress,
  
  // Coverage
  loadCoverageIndex,
  
  // Export
  exportSessionAsZip,
  exportSessionAsCSV,
  generateCSV
};

