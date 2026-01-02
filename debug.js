/**
 * Debug Console Module
 * Captures and displays logs, errors, and network activity
 */

const DebugConsole = (() => {
  // State
  let logs = [];
  let isEnabled = true;
  let showNetwork = false;
  let showVerbose = false;
  let maxLogs = 500;
  
  // Counters
  let logCount = 0;
  let errorCount = 0;
  let warnCount = 0;
  
  // Original console methods
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };
  
  /**
   * Initialize the debug console
   */
  function init() {
    // Override console methods
    console.log = (...args) => {
      originalConsole.log(...args);
      if (isEnabled && showVerbose) {
        addLog('log', 'console', args);
      }
    };
    
    console.warn = (...args) => {
      originalConsole.warn(...args);
      if (isEnabled) {
        addLog('warn', 'console', args);
      }
    };
    
    console.error = (...args) => {
      originalConsole.error(...args);
      if (isEnabled) {
        addLog('error', 'console', args);
      }
    };
    
    console.info = (...args) => {
      originalConsole.info(...args);
      if (isEnabled) {
        addLog('info', 'console', args);
      }
    };
    
    // Capture unhandled errors
    window.addEventListener('error', (event) => {
      if (isEnabled) {
        addLog('error', 'window', [`Uncaught: ${event.message}`, `at ${event.filename}:${event.lineno}`]);
      }
    });
    
    // Capture unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      if (isEnabled) {
        addLog('error', 'promise', [`Unhandled rejection: ${event.reason}`]);
      }
    });
    
    // Intercept fetch for network logging
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0].url;
      const method = args[1]?.method || 'GET';
      const startTime = Date.now();
      
      if (isEnabled && showNetwork) {
        addLog('network', 'fetch', [`→ ${method} ${truncateUrl(url)}`], { url, method, status: 'pending' });
      }
      
      try {
        const response = await originalFetch(...args);
        const duration = Date.now() - startTime;
        
        if (isEnabled && showNetwork) {
          const status = response.ok ? 'success' : 'error';
          addLog('network', 'fetch', [
            `← ${response.status} ${truncateUrl(url)} (${duration}ms)`
          ], { url, method, status: response.status, duration, ok: response.ok });
        }
        
        return response;
      } catch (error) {
        const duration = Date.now() - startTime;
        
        if (isEnabled && showNetwork) {
          addLog('error', 'fetch', [
            `✕ ${method} ${truncateUrl(url)} - ${error.message} (${duration}ms)`
          ], { url, method, error: error.message, duration });
        }
        
        throw error;
      }
    };
    
    // Setup UI handlers
    setupUI();
    
    // Log initialization
    addLog('info', 'debug', ['Debug console initialized']);
    addLog('info', 'debug', [`User Agent: ${navigator.userAgent}`]);
    addLog('info', 'debug', [`Platform: ${navigator.platform}`]);
    addLog('info', 'debug', [`Online: ${navigator.onLine}`]);
    
    // Log storage info
    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then(({ usage, quota }) => {
        const usedMB = (usage / 1024 / 1024).toFixed(1);
        const quotaMB = (quota / 1024 / 1024).toFixed(0);
        addLog('info', 'storage', [`Storage: ${usedMB}MB / ${quotaMB}MB`]);
      });
    }
  }
  
  /**
   * Add a log entry
   */
  function addLog(type, source, args, details = null) {
    const entry = {
      id: Date.now() + Math.random(),
      time: new Date(),
      type,
      source,
      message: args.map(arg => formatArg(arg)).join(' '),
      details: details ? JSON.stringify(details, null, 2) : null
    };
    
    logs.push(entry);
    
    // Update counters
    logCount++;
    if (type === 'error') errorCount++;
    if (type === 'warn') warnCount++;
    
    // Trim old logs
    if (logs.length > maxLogs) {
      logs = logs.slice(-maxLogs);
    }
    
    // Update UI
    renderLog(entry);
    updateStats();
  }
  
  /**
   * Format an argument for display
   */
  function formatArg(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (arg instanceof Blob) return `Blob(${arg.size} bytes, ${arg.type})`;
    
    try {
      const str = JSON.stringify(arg, null, 2);
      return str.length > 500 ? str.substring(0, 500) + '...' : str;
    } catch {
      return String(arg);
    }
  }
  
  /**
   * Truncate URL for display
   */
  function truncateUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.length > 50) {
        return parsed.host + '/...' + path.slice(-30);
      }
      return parsed.host + path;
    } catch {
      return url.length > 60 ? url.substring(0, 60) + '...' : url;
    }
  }
  
  /**
   * Render a single log entry
   */
  function renderLog(entry) {
    const container = document.getElementById('debug-log');
    if (!container) return;
    
    const el = document.createElement('div');
    el.className = `log-entry ${entry.type}`;
    el.innerHTML = `
      <div class="log-header">
        <span class="log-time">${formatTime(entry.time)}</span>
        <span class="log-source">[${entry.source}]</span>
      </div>
      <div class="log-message">${escapeHtml(entry.message)}</div>
      ${entry.details ? `<div class="log-details">${escapeHtml(entry.details)}</div>` : ''}
    `;
    
    container.appendChild(el);
    
    // Auto-scroll to bottom
    const logContainer = document.getElementById('debug-log-container');
    if (logContainer) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }
  
  /**
   * Format time for display
   */
  function formatTime(date) {
    return date.toTimeString().split(' ')[0] + '.' + 
           date.getMilliseconds().toString().padStart(3, '0');
  }
  
  /**
   * Escape HTML
   */
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
  
  /**
   * Update stats display
   */
  function updateStats() {
    const logCountEl = document.getElementById('debug-log-count');
    const errorCountEl = document.getElementById('debug-error-count');
    const warnCountEl = document.getElementById('debug-warn-count');
    
    if (logCountEl) logCountEl.textContent = `${logCount} logs`;
    if (errorCountEl) errorCountEl.textContent = `${errorCount} errors`;
    if (warnCountEl) warnCountEl.textContent = `${warnCount} warnings`;
  }
  
  /**
   * Setup UI event handlers
   */
  function setupUI() {
    // Enable/disable logging
    const enabledCheckbox = document.getElementById('debug-enabled');
    if (enabledCheckbox) {
      enabledCheckbox.checked = isEnabled;
      enabledCheckbox.addEventListener('change', (e) => {
        isEnabled = e.target.checked;
        addLog('info', 'debug', [`Logging ${isEnabled ? 'enabled' : 'disabled'}`]);
      });
    }
    
    // Network logging
    const networkCheckbox = document.getElementById('debug-network');
    if (networkCheckbox) {
      networkCheckbox.checked = showNetwork;
      networkCheckbox.addEventListener('change', (e) => {
        showNetwork = e.target.checked;
        addLog('info', 'debug', [`Network logging ${showNetwork ? 'enabled' : 'disabled'}`]);
      });
    }
    
    // Verbose logging
    const verboseCheckbox = document.getElementById('debug-verbose');
    if (verboseCheckbox) {
      verboseCheckbox.checked = showVerbose;
      verboseCheckbox.addEventListener('change', (e) => {
        showVerbose = e.target.checked;
        addLog('info', 'debug', [`Verbose logging ${showVerbose ? 'enabled' : 'disabled'}`]);
      });
    }
    
    // Clear logs
    const clearBtn = document.getElementById('btn-clear-logs');
    if (clearBtn) {
      clearBtn.addEventListener('click', clearLogs);
    }
    
    // Copy logs
    const copyBtn = document.getElementById('btn-copy-logs');
    if (copyBtn) {
      copyBtn.addEventListener('click', copyLogs);
    }
    
    // Download logs
    const downloadBtn = document.getElementById('btn-download-logs');
    if (downloadBtn) {
      downloadBtn.addEventListener('click', downloadLogs);
    }
    
    // Back button
    const backBtn = document.getElementById('debug-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        document.getElementById('debug-panel')?.classList.remove('active');
      });
    }
    
    // Debug button in nav
    const debugBtn = document.getElementById('btn-debug');
    if (debugBtn) {
      debugBtn.addEventListener('click', () => {
        document.getElementById('debug-panel')?.classList.add('active');
      });
    }
  }
  
  /**
   * Clear all logs
   */
  function clearLogs() {
    logs = [];
    logCount = 0;
    errorCount = 0;
    warnCount = 0;
    
    const container = document.getElementById('debug-log');
    if (container) {
      container.innerHTML = '';
    }
    
    updateStats();
    addLog('info', 'debug', ['Logs cleared']);
  }
  
  /**
   * Copy logs to clipboard
   */
  async function copyLogs() {
    const text = formatLogsAsText();
    
    try {
      await navigator.clipboard.writeText(text);
      addLog('success', 'debug', ['Logs copied to clipboard']);
    } catch (error) {
      addLog('error', 'debug', ['Failed to copy logs:', error.message]);
    }
  }
  
  /**
   * Download logs as file
   */
  function downloadLogs() {
    const text = formatLogsAsText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    addLog('success', 'debug', ['Logs downloaded']);
  }
  
  /**
   * Format logs as text
   */
  function formatLogsAsText() {
    const header = [
      '='.repeat(60),
      'Street Survey Collector - Debug Log',
      `Generated: ${new Date().toISOString()}`,
      `User Agent: ${navigator.userAgent}`,
      `Platform: ${navigator.platform}`,
      '='.repeat(60),
      ''
    ].join('\n');
    
    const logLines = logs.map(entry => {
      const time = formatTime(entry.time);
      const line = `[${time}] [${entry.type.toUpperCase()}] [${entry.source}] ${entry.message}`;
      if (entry.details) {
        return line + '\n  ' + entry.details.split('\n').join('\n  ');
      }
      return line;
    }).join('\n');
    
    return header + logLines;
  }
  
  /**
   * Custom logging methods for app code
   */
  function log(source, message, details = null) {
    if (isEnabled) {
      addLog('info', source, [message], details);
    }
  }
  
  function warn(source, message, details = null) {
    if (isEnabled) {
      addLog('warn', source, [message], details);
    }
  }
  
  function error(source, message, details = null) {
    if (isEnabled) {
      addLog('error', source, [message], details);
    }
  }
  
  function success(source, message, details = null) {
    if (isEnabled) {
      addLog('success', source, [message], details);
    }
  }
  
  // Public API
  return {
    init,
    log,
    warn,
    error,
    success,
    clearLogs,
    getLogs: () => [...logs],
    getStats: () => ({ logCount, errorCount, warnCount })
  };
})();

// Initialize on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  DebugConsole.init();
});

// Make available globally
window.Debug = DebugConsole;

