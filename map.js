/**
 * Map Module - Mapbox coverage visualization
 * Displays collected routes, gaps, and real-time tracking
 */

// Map instances
let coverageMap = null;
let miniMap = null;
let liveTrack = null;

// Map state
let mapState = {
  initialized: false,
  coverageData: null,
  currentPosition: null,
  isTracking: false
};

// ============================================
// Coverage Map (Full Screen)
// ============================================

/**
 * Initialize the coverage map
 */
async function initCoverageMap(containerId, accessToken) {
  if (!accessToken) {
    console.warn('Mapbox token not provided');
    return null;
  }
  
  mapboxgl.accessToken = accessToken;
  
  coverageMap = new mapboxgl.Map({
    container: containerId,
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [0, 0],
    zoom: 2,
    attributionControl: false
  });
  
  // Add attribution
  coverageMap.addControl(new mapboxgl.AttributionControl({ compact: true }));
  
  // Add navigation controls
  coverageMap.addControl(new mapboxgl.NavigationControl(), 'top-right');
  
  // Add geolocation control
  const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true
  });
  coverageMap.addControl(geolocate, 'top-right');
  
  // Wait for map to load
  await new Promise(resolve => {
    coverageMap.on('load', resolve);
  });
  
  // Add coverage layers
  setupCoverageLayers();
  
  mapState.initialized = true;
  
  return coverageMap;
}

/**
 * Setup coverage map layers
 */
function setupCoverageLayers() {
  // Source for coverage data
  coverageMap.addSource('coverage', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] }
  });
  
  // Published routes layer (green)
  coverageMap.addLayer({
    id: 'coverage-published',
    type: 'line',
    source: 'coverage',
    filter: ['==', ['get', 'published'], true],
    paint: {
      'line-color': '#22c55e',
      'line-width': 4,
      'line-opacity': 0.8
    }
  });
  
  // Pending routes layer (yellow)
  coverageMap.addLayer({
    id: 'coverage-pending',
    type: 'line',
    source: 'coverage',
    filter: ['==', ['get', 'published'], false],
    paint: {
      'line-color': '#eab308',
      'line-width': 4,
      'line-opacity': 0.8
    }
  });
  
  // Source for current session track
  coverageMap.addSource('current-track', {
    type: 'geojson',
    data: { type: 'LineString', coordinates: [] }
  });
  
  // Current track layer (blue)
  coverageMap.addLayer({
    id: 'current-track-line',
    type: 'line',
    source: 'current-track',
    paint: {
      'line-color': '#3b82f6',
      'line-width': 6,
      'line-opacity': 0.9
    }
  });
  
  // Click handler for route info
  coverageMap.on('click', 'coverage-published', (e) => {
    const feature = e.features[0];
    showRoutePopup(e.lngLat, feature.properties);
  });
  
  coverageMap.on('click', 'coverage-pending', (e) => {
    const feature = e.features[0];
    showRoutePopup(e.lngLat, feature.properties);
  });
  
  // Cursor styles
  coverageMap.on('mouseenter', 'coverage-published', () => {
    coverageMap.getCanvas().style.cursor = 'pointer';
  });
  
  coverageMap.on('mouseleave', 'coverage-published', () => {
    coverageMap.getCanvas().style.cursor = '';
  });
  
  coverageMap.on('mouseenter', 'coverage-pending', () => {
    coverageMap.getCanvas().style.cursor = 'pointer';
  });
  
  coverageMap.on('mouseleave', 'coverage-pending', () => {
    coverageMap.getCanvas().style.cursor = '';
  });
}

/**
 * Show popup for route info
 */
function showRoutePopup(lngLat, properties) {
  const html = `
    <div style="font-size: 14px; line-height: 1.5;">
      <div style="font-weight: 600; margin-bottom: 8px;">${properties.name || 'Session'}</div>
      <div style="color: #a0a0b0; font-size: 12px;">
        <div>📅 ${new Date(properties.collectedAt).toLocaleDateString()}</div>
        <div>👤 ${properties.collector || 'Anonymous'}</div>
        <div>📷 ${properties.imageCount || 0} images</div>
        ${properties.published ? '<div style="color: #22c55e;">✓ Published</div>' : '<div style="color: #eab308;">⏳ Pending</div>'}
      </div>
    </div>
  `;
  
  new mapboxgl.Popup({ closeButton: true, maxWidth: '200px' })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(coverageMap);
}

/**
 * Load and display coverage data
 */
async function loadCoverage(config) {
  if (!coverageMap) return;
  
  try {
    // Load from GitHub
    const coverageData = await Publisher.loadCoverageIndex(config);
    mapState.coverageData = coverageData;
    
    // Update map source
    coverageMap.getSource('coverage').setData(coverageData);
    
    // Fit bounds if we have features
    if (coverageData.features.length > 0) {
      const bounds = new mapboxgl.LngLatBounds();
      
      coverageData.features.forEach(feature => {
        if (feature.geometry.type === 'LineString') {
          feature.geometry.coordinates.forEach(coord => {
            bounds.extend(coord);
          });
        }
      });
      
      coverageMap.fitBounds(bounds, { padding: 50 });
    }
    
    // Update stats
    updateCoverageStats(coverageData);
    
    return coverageData;
    
  } catch (error) {
    console.error('Failed to load coverage:', error);
    return null;
  }
}

/**
 * Add local sessions to coverage map
 */
async function addLocalSessions() {
  if (!coverageMap) return;
  
  const sessions = await Storage.getAllSessions();
  const features = [];
  
  for (const session of sessions) {
    if (session.status === 'published') continue; // Already in GitHub index
    
    const captures = await Storage.getSessionCaptures(session.id);
    const coordinates = captures
      .filter(c => c.gps?.lat && c.gps?.lng)
      .map(c => [c.gps.lng, c.gps.lat]);
    
    if (coordinates.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates
        },
        properties: {
          sessionId: session.id,
          name: session.name,
          collectedAt: session.createdAt,
          imageCount: session.captureCount,
          published: false
        }
      });
    }
  }
  
  // Merge with existing coverage data
  if (mapState.coverageData) {
    const merged = {
      ...mapState.coverageData,
      features: [...mapState.coverageData.features, ...features]
    };
    coverageMap.getSource('coverage').setData(merged);
  }
}

/**
 * Update coverage statistics display
 */
function updateCoverageStats(coverageData) {
  const stats = coverageData.stats || {
    totalSessions: coverageData.features.length,
    totalKilometers: 0,
    contributors: 0
  };
  
  // Calculate if not provided
  if (!coverageData.stats) {
    stats.totalKilometers = coverageData.features.reduce((sum, f) => {
      return sum + turf.length(f, { units: 'kilometers' });
    }, 0);
    
    const contributors = new Set(coverageData.features.map(f => f.properties.collector));
    stats.contributors = contributors.size;
  }
  
  // Update UI
  const coverageEl = document.getElementById('stat-coverage');
  const gapsEl = document.getElementById('stat-gaps');
  const sessionsEl = document.getElementById('stat-sessions');
  
  if (sessionsEl) sessionsEl.textContent = stats.totalSessions;
  if (coverageEl) coverageEl.textContent = `${Math.round(stats.totalKilometers)} km`;
  if (gapsEl) gapsEl.textContent = '--'; // Would need area bounds to calculate gaps
}

// ============================================
// Mini Map (During Recording)
// ============================================

/**
 * Initialize mini map for recording view
 */
async function initMiniMap(containerId, accessToken) {
  if (!accessToken) return null;
  
  mapboxgl.accessToken = accessToken;
  
  miniMap = new mapboxgl.Map({
    container: containerId,
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [0, 0],
    zoom: 16,
    interactive: false,
    attributionControl: false
  });
  
  await new Promise(resolve => {
    miniMap.on('load', resolve);
  });
  
  // Add track source
  miniMap.addSource('live-track', {
    type: 'geojson',
    data: { type: 'LineString', coordinates: [] }
  });
  
  // Add track layer
  miniMap.addLayer({
    id: 'live-track-line',
    type: 'line',
    source: 'live-track',
    paint: {
      'line-color': '#3b82f6',
      'line-width': 4,
      'line-opacity': 0.9
    }
  });
  
  return miniMap;
}

/**
 * Live track layer for mini map
 */
class LiveTrackLayer {
  constructor(map) {
    this.map = map;
    this.coordinates = [];
    this.marker = null;
  }
  
  start() {
    this.coordinates = [];
    
    // Create position marker
    const el = document.createElement('div');
    el.className = 'live-track-marker';
    el.style.cssText = `
      width: 16px;
      height: 16px;
      background: #3b82f6;
      border: 3px solid #fff;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    `;
    
    this.marker = new mapboxgl.Marker({ element: el })
      .setLngLat([0, 0])
      .addTo(this.map);
  }
  
  updatePosition(lng, lat) {
    this.coordinates.push([lng, lat]);
    
    // Update track line
    if (this.map.getSource('live-track')) {
      this.map.getSource('live-track').setData({
        type: 'LineString',
        coordinates: this.coordinates
      });
    }
    
    // Update marker
    if (this.marker) {
      this.marker.setLngLat([lng, lat]);
    }
    
    // Center map
    this.map.setCenter([lng, lat]);
  }
  
  stop() {
    if (this.marker) {
      this.marker.remove();
      this.marker = null;
    }
    this.coordinates = [];
  }
  
  getTrackGeoJSON() {
    return {
      type: 'LineString',
      coordinates: this.coordinates
    };
  }
}

/**
 * Start live tracking on mini map
 */
function startLiveTrack() {
  if (!miniMap) return;
  
  liveTrack = new LiveTrackLayer(miniMap);
  liveTrack.start();
  mapState.isTracking = true;
  
  // Show mini map container
  const container = document.getElementById('mini-map-container');
  if (container) {
    container.style.display = 'block';
    miniMap.resize();
  }
}

/**
 * Update live track position
 */
function updateLiveTrack(lng, lat) {
  if (liveTrack && mapState.isTracking) {
    liveTrack.updatePosition(lng, lat);
  }
}

/**
 * Stop live tracking
 */
function stopLiveTrack() {
  if (liveTrack) {
    const trackData = liveTrack.getTrackGeoJSON();
    liveTrack.stop();
    liveTrack = null;
    mapState.isTracking = false;
    
    // Hide mini map container
    const container = document.getElementById('mini-map-container');
    if (container) {
      container.style.display = 'none';
    }
    
    return trackData;
  }
  return null;
}

// ============================================
// Gap Detection
// ============================================

/**
 * Find coverage gaps in an area
 * Note: This requires OSM road data which would need an external API
 * For now, this is a placeholder that could be expanded
 */
async function findCoverageGaps(bounds, coverageData) {
  // This would require:
  // 1. Fetching OSM road network for the area (e.g., from Overpass API)
  // 2. Buffering collected routes
  // 3. Finding roads not intersecting with buffer
  
  // Placeholder implementation
  console.log('Gap detection would analyze area:', bounds);
  
  return {
    gaps: { type: 'FeatureCollection', features: [] },
    totalGapKm: 0,
    percentCovered: 0
  };
}

// ============================================
// Utility Functions
// ============================================

/**
 * Center map on user's location
 */
function centerOnUser() {
  if (mapState.currentPosition && coverageMap) {
    coverageMap.flyTo({
      center: [mapState.currentPosition.lng, mapState.currentPosition.lat],
      zoom: 15
    });
  }
}

/**
 * Set current position
 */
function setCurrentPosition(lat, lng) {
  mapState.currentPosition = { lat, lng };
}

/**
 * Toggle layer visibility
 */
function toggleLayer(layerId, visible) {
  if (coverageMap && coverageMap.getLayer(layerId)) {
    coverageMap.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

/**
 * Destroy maps and clean up
 */
function destroyMaps() {
  if (coverageMap) {
    coverageMap.remove();
    coverageMap = null;
  }
  if (miniMap) {
    miniMap.remove();
    miniMap = null;
  }
  if (liveTrack) {
    liveTrack.stop();
    liveTrack = null;
  }
  mapState = {
    initialized: false,
    coverageData: null,
    currentPosition: null,
    isTracking: false
  };
}

// ============================================
// Export for module usage
// ============================================

window.CoverageMap = {
  // Coverage map
  init: initCoverageMap,
  loadCoverage,
  addLocalSessions,
  centerOnUser,
  toggleLayer,
  
  // Mini map
  initMiniMap,
  startLiveTrack,
  updateLiveTrack,
  stopLiveTrack,
  
  // Gaps
  findCoverageGaps,
  
  // State
  setCurrentPosition,
  getState: () => mapState,
  
  // Cleanup
  destroy: destroyMaps
};

