/**
 * Publisher Module - GitHub upload with resilient retry logic
 * Handles uploading sessions to GitHub with progress tracking and error recovery
 */

// Publisher state
let publisherState = {
  isPublishing: false,
  isPaused: false,
  isProcessing: false, // Lock to prevent concurrent processQueue calls
  currentSession: null,
  config: null,
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
// Debug Helpers
// ============================================

function debugLog(message, details = null) {
  if (window.Debug) {
    window.Debug.log('publisher', message, details);
  }
}

function debugError(message, details = null) {
  if (window.Debug) {
    window.Debug.error('publisher', message, details);
  }
}

function debugSuccess(message, details = null) {
  if (window.Debug) {
    window.Debug.success('publisher', message, details);
  }
}

function debugWarn(message, details = null) {
  if (window.Debug) {
    window.Debug.warn('publisher', message, details);
  }
}

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
  const contentSize = typeof content === 'string' ? content.length : 'binary';
  
  debugLog(`Uploading: ${path}`, { size: contentSize, hasSha: !!existingSha });
  
  const body = {
    message,
    content: typeof content === 'string' ? btoa(unescape(encodeURIComponent(content))) : content,
    branch: config.branch || 'main'
  };
  
  if (existingSha) {
    body.sha = existingSha;
    debugLog(`Using existing SHA: ${existingSha.substring(0, 8)}...`);
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
    debugError(`Upload failed: ${path}`, { status: response.status, error: error.message });
    
    // Handle SHA mismatch error - file exists but we didn't provide SHA
    if (response.status === 422 && error.message?.includes('sha')) {
      debugWarn(`SHA required for existing file, fetching: ${path}`);
      const existing = await fileExists(config, path);
      if (existing.exists && existing.sha) {
        debugLog(`Retrying with SHA: ${existing.sha.substring(0, 8)}...`);
        // Retry with the SHA
        body.sha = existing.sha;
        const retryResponse = await fetch(
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
        
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          debugSuccess(`Upload succeeded on retry: ${path}`);
          return {
            url: retryData.content.download_url,
            sha: retryData.content.sha,
            path: retryData.content.path
          };
        }
        
        const retryError = await retryResponse.json();
        debugError(`Retry also failed: ${path}`, { error: retryError.message });
        throw new Error(retryError.message || `Upload retry failed: ${retryResponse.status}`);
      }
    }
    
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
  
  // Check for image data - support both new format (imageData) and legacy (imageBlob)
  const hasImageData = capture.imageData && (capture.imageData instanceof ArrayBuffer || capture.imageData.byteLength !== undefined);
  const hasImageBlob = capture.imageBlob && capture.imageBlob instanceof Blob && capture.imageBlob.size > 0;
  
  if (!hasImageData && !hasImageBlob) {
    debugError(`No valid image data for capture #${capture.sequenceNum}`, {
      hasImageData: !!capture.imageData,
      imageDataType: capture.imageData?.constructor?.name,
      hasImageBlob: !!capture.imageBlob,
      imageBlobType: capture.imageBlob?.constructor?.name
    });
    throw new Error(`Capture #${capture.sequenceNum} has no valid image data`);
  }
  
  const imageSize = hasImageData ? capture.imageData.byteLength : capture.imageBlob.size;
  
  debugLog(`Preparing upload for #${capture.sequenceNum}`, {
    format: hasImageData ? 'ArrayBuffer' : 'Blob',
    size: imageSize,
    type: capture.imageType || 'image/jpeg'
  });
  
  // Check if file already exists (idempotent upload)
  const existing = await fileExists(config, path);
  if (existing.exists) {
    debugLog(`Image already exists: ${path}`);
    return { url: existing.downloadUrl, skipped: true };
  }
  
  // Convert to base64
  let base64;
  if (hasImageData) {
    // New format: ArrayBuffer - direct conversion
    base64 = arrayBufferToBase64(capture.imageData);
    debugLog(`ArrayBuffer to base64 for #${capture.sequenceNum}: ${base64.length} chars`);
  } else if (hasImageBlob) {
    // Legacy format: Blob - may fail on iOS if blob is detached
    debugWarn(`Using legacy Blob format for #${capture.sequenceNum} - may fail on iOS`);
    try {
      base64 = await blobToBase64(capture.imageBlob);
      debugLog(`Blob to base64 for #${capture.sequenceNum}: ${base64.length} chars`);
    } catch (blobError) {
      debugError(`Blob conversion failed for #${capture.sequenceNum} - this session was created with an older app version`, {
        error: blobError.message
      });
      throw new Error(`Image #${capture.sequenceNum} data is corrupted. This session was created with an older app version. Please delete it and create a new session.`);
    }
  }
  
  if (!base64 || base64.length === 0) {
    debugError(`Base64 conversion returned empty result for #${capture.sequenceNum}`);
    throw new Error(`Failed to convert image #${capture.sequenceNum} to base64`);
  }
  
  const result = await uploadFile(
    config,
    path,
    base64,
    `Upload image ${capture.sequenceNum}`
  );
  
  return { url: result.url, skipped: false };
}

/**
 * Convert ArrayBuffer to base64 string
 * More reliable than Blob methods on iOS
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  
  return btoa(binary);
}

/**
 * Convert blob to base64
 * Uses multiple methods for mobile compatibility
 */
async function blobToBase64(blob) {
  // Validate blob first
  if (!blob || !(blob instanceof Blob)) {
    debugError('blobToBase64: Invalid blob', { blob: typeof blob });
    throw new Error('Invalid blob provided');
  }
  
  if (blob.size === 0) {
    debugError('blobToBase64: Empty blob');
    throw new Error('Blob is empty');
  }
  
  debugLog(`Converting blob to base64: ${blob.size} bytes, type: ${blob.type}`);
  
  // Method 1: Try using arrayBuffer (more reliable on mobile)
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192; // Process in chunks to avoid call stack issues
    
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    
    const base64 = btoa(binary);
    debugLog(`Base64 conversion successful: ${base64.length} chars`);
    return base64;
    
  } catch (arrayBufferError) {
    debugWarn('arrayBuffer method failed, trying FileReader', { error: arrayBufferError.message });
  }
  
  // Method 2: Fall back to FileReader
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = () => {
      try {
        if (!reader.result) {
          debugError('FileReader returned null result');
          reject(new Error('FileReader returned null'));
          return;
        }
        
        // Remove data URL prefix (e.g., "data:image/jpeg;base64,")
        const dataUrl = reader.result;
        const commaIndex = dataUrl.indexOf(',');
        if (commaIndex === -1) {
          debugError('Invalid data URL format', { result: dataUrl.substring(0, 50) });
          reject(new Error('Invalid data URL format'));
          return;
        }
        
        const base64 = dataUrl.substring(commaIndex + 1);
        debugLog(`FileReader base64 conversion successful: ${base64.length} chars`);
        resolve(base64);
        
      } catch (parseError) {
        debugError('Error parsing FileReader result', { error: parseError.message });
        reject(parseError);
      }
    };
    
    reader.onerror = () => {
      debugError('FileReader error', { error: reader.error });
      reject(reader.error || new Error('FileReader failed'));
    };
    
    reader.onabort = () => {
      debugError('FileReader aborted');
      reject(new Error('FileReader aborted'));
    };
    
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
  // Check for existing publish operation (including processing state)
  if (publisherState.isPublishing || publisherState.isProcessing) {
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
    debugError('Session not found', { sessionId });
    throw new Error('Session not found');
  }
  
  debugLog(`Found session: ${session.name || sessionId}`, {
    captureCount: session.captureCount,
    status: session.status
  });
  
  const captures = await Storage.getUnpublishedCaptures(sessionId);
  if (captures.length === 0) {
    debugError('No captures to publish');
    throw new Error('No captures to publish');
  }
  
  // Check for captures with missing blobs
  const capturesWithBlobs = captures.filter(c => c.imageBlob && c.imageBlob.size > 0);
  const missingBlobs = captures.length - capturesWithBlobs.length;
  
  if (missingBlobs > 0) {
    debugWarn(`${missingBlobs} captures have missing/empty blobs`, {
      total: captures.length,
      withBlobs: capturesWithBlobs.length
    });
  }
  
  debugLog(`Starting publish: ${capturesWithBlobs.length} captures`, {
    repo: config.repo,
    branch: config.branch
  });
  
  // Initialize publish state (reset all fields to prevent stale data)
  publisherState = {
    isPublishing: true,
    isPaused: false,
    isProcessing: false,
    currentSession: session,
    config,
    queue: [...capturesWithBlobs], // Only include captures with valid blobs
    completed: 0,
    failed: 0,
    total: capturesWithBlobs.length,
    startTime: Date.now(),
    onProgress: callbacks.onProgress,
    onComplete: callbacks.onComplete,
    onError: callbacks.onError
  };
  
  // Save publish state to IndexedDB
  await Storage.savePublishState({
    sessionId,
    publishStarted: new Date().toISOString(),
    totalToUpload: capturesWithBlobs.length,
    completed: 0,
    failed: 0,
    inProgress: true
  });
  
  // Update session status
  session.status = 'publishing';
  await Storage.updateSession(session);
  
  debugSuccess('Publish started, processing queue...');
  
  // Start processing queue (don't await - runs in background)
  processQueue();
  
  return { total: capturesWithBlobs.length };
}

/**
 * Process the upload queue
 * Uses a lock to prevent concurrent processing
 */
async function processQueue() {
  // Prevent concurrent processing (race condition fix)
  if (publisherState.isProcessing) {
    console.log('processQueue already running, skipping');
    return;
  }
  
  publisherState.isProcessing = true;
  
  try {
    while (publisherState.queue.length > 0 && publisherState.isPublishing && !publisherState.isPaused) {
      // Check if online
      if (!navigator.onLine) {
        reportProgress('Waiting for network...');
        await waitForOnline();
        
        // Re-check state after waiting (could have been cancelled)
        if (!publisherState.isPublishing) break;
      }
      
      const capture = publisherState.queue[0];
      
      // Snapshot current state to detect changes
      const currentSessionId = publisherState.currentSession?.id;
      
      try {
        reportProgress(`Uploading image ${capture.sequenceNum}...`);
        
        const result = await uploadWithRetry(capture);
        
        // Verify we're still publishing the same session (race condition check)
        if (publisherState.currentSession?.id !== currentSessionId) {
          console.warn('Session changed during upload, aborting');
          break;
        }
        
        // Mark as published
        await Storage.markCapturePublished(capture.id, result.url);
        
        // Update state atomically
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
  } finally {
    // Always release the lock
    publisherState.isProcessing = false;
  }
}

/**
 * Upload with retry logic
 */
async function uploadWithRetry(capture, maxRetries = 5) {
  let lastError = null;
  
  debugLog(`Starting upload for capture #${capture.sequenceNum}`, {
    id: capture.id,
    hasImageData: !!capture.imageData,
    imageDataSize: capture.imageData?.byteLength,
    hasBlob: !!capture.imageBlob,
    blobSize: capture.imageBlob?.size
  });
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Check network
      if (!navigator.onLine) {
        debugWarn('Offline, waiting for network...');
        await waitForOnline();
        debugLog('Back online, resuming');
      }
      
      const result = await uploadImage(
        publisherState.config,
        capture,
        publisherState.currentSession.id
      );
      
      if (result.skipped) {
        debugLog(`Image #${capture.sequenceNum} already exists, skipped`);
      } else {
        debugSuccess(`Image #${capture.sequenceNum} uploaded successfully`);
      }
      
      return result;
      
    } catch (error) {
      lastError = error || new Error('Unknown error');
      const errorMessage = error?.message || String(error) || 'Unknown error';
      
      debugError(`Upload attempt ${attempt}/${maxRetries} failed for #${capture.sequenceNum}`, {
        error: errorMessage,
        stack: error?.stack,
        errorType: error?.constructor?.name
      });
      
      // Check for rate limit (with safe string check)
      const isRateLimited = errorMessage.includes && (
        errorMessage.includes('rate limit') || 
        errorMessage.includes('403') ||
        errorMessage.includes('secondary rate limit')
      );
      
      if (isRateLimited) {
        debugWarn('Rate limited, waiting 60 seconds...');
        reportProgress('Rate limited. Waiting...');
        await delay(60000); // Wait 1 minute
      } else if (attempt < maxRetries) {
        // Exponential backoff
        const waitTime = Math.min(1000 * Math.pow(2, attempt), 60000);
        debugLog(`Retrying in ${waitTime}ms...`);
        await delay(waitTime);
      }
    }
  }
  
  debugError(`All ${maxRetries} attempts failed for #${capture.sequenceNum}`, {
    lastError: lastError?.message || String(lastError)
  });
  throw lastError || new Error('Upload failed after all retries');
}

/**
 * Finish publishing - upload metadata and CSV
 */
async function finishPublish() {
  const session = publisherState.currentSession;
  const config = publisherState.config;
  
  debugLog('Finishing publish...', {
    sessionId: session.id,
    completed: publisherState.completed,
    failed: publisherState.failed
  });
  
  try {
    reportProgress('Uploading metadata...');
    
    // Get all captures with published URLs
    const captures = await Storage.getSessionCaptures(session.id);
    
    // Generate CSV
    const csv = generateCSV(captures);
    const csvPath = `sessions/${session.id}/data.csv`;
    const existingCsv = await fileExists(config, csvPath);
    await uploadFile(
      config,
      csvPath,
      csv,
      `Upload data.csv for session ${session.id}`,
      existingCsv.exists ? existingCsv.sha : null
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
    
    const metadataPath = `sessions/${session.id}/metadata.json`;
    const existingMetadata = await fileExists(config, metadataPath);
    await uploadFile(
      config,
      metadataPath,
      JSON.stringify(metadata, null, 2),
      `Upload metadata for session ${session.id}`,
      existingMetadata.exists ? existingMetadata.sha : null
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
    
    // Always reset publishing state on error to prevent stuck state
    publisherState.isPublishing = false;
    
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
  if (publisherState.isPaused && publisherState.isPublishing) {
    publisherState.isPaused = false;
    // Only start processQueue if not already processing
    if (!publisherState.isProcessing) {
      processQueue();
    }
  }
}

/**
 * Cancel publishing
 */
async function cancelPublish() {
  const sessionId = publisherState.currentSession?.id;
  
  // Signal to stop processing
  publisherState.isPublishing = false;
  publisherState.isPaused = false;
  publisherState.queue = [];
  
  // Wait for any in-progress processing to complete
  let waitCount = 0;
  while (publisherState.isProcessing && waitCount < 50) {
    await delay(100);
    waitCount++;
  }
  
  if (sessionId) {
    const session = await Storage.getSession(sessionId);
    if (session) {
      session.status = 'stopped';
      await Storage.updateSession(session);
    }
  }
  
  // Reset state
  publisherState.currentSession = null;
  publisherState.config = null;
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
    
    // Support both new format (imageData as ArrayBuffer) and legacy (imageBlob)
    if (capture.imageData && capture.imageData.byteLength > 0) {
      // New format: ArrayBuffer
      imagesFolder.file(filename, capture.imageData);
      imagesAdded++;
    } else if (capture.imageBlob && capture.imageBlob instanceof Blob && capture.imageBlob.size > 0) {
      // Legacy format: Blob
      imagesFolder.file(filename, capture.imageBlob);
      imagesAdded++;
    } else {
      console.warn(`Capture ${capture.sequenceNum} has no valid image data`);
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

