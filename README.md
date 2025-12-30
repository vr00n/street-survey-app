# Street Survey Collector

A Progressive Web App for collecting street-level imagery and sensor data for digital surveys. Designed to run on Android devices and deploy via GitHub Pages.

## Features

- **Camera Capture**: Captures images at configurable intervals (1-10 seconds)
- **GPS Tracking**: High-accuracy location tracking with staleness detection
- **Accelerometer Data**: Collects device motion data alongside imagery
- **Local Storage**: All data stored locally in IndexedDB - works offline
- **Session Management**: Create, pause, resume, and recover sessions
- **GitHub Publishing**: Upload sessions to a GitHub repository
- **Coverage Map**: Visualize collected routes and identify gaps using Mapbox
- **Local Export**: Download sessions as ZIP files with CSV data

## Output Format

Each capture includes:
```
timestamp | gps_coords | image_url | accel_x | accel_y | accel_z
```

## Quick Start

1. **Deploy to GitHub Pages**:
   - Create a new repository on GitHub
   - Push these files to the repository
   - Enable GitHub Pages in repository settings

2. **Configure the App**:
   - Open the app on your Android device
   - Tap the ⚙️ settings button
   - Enter your GitHub Personal Access Token (requires `repo` scope)
   - Enter your repository name (e.g., `username/street-survey-data`)
   - Optionally add your Mapbox access token for the coverage map

3. **Start Surveying**:
   - Tap "Start" to begin a new session
   - Walk or drive along streets to capture data
   - Use "Pause" to temporarily stop, "Resume" to continue
   - Tap "Stop" when finished, then "Publish" to upload to GitHub

## Requirements

### Device
- Android device with Chrome browser
- Camera, GPS, and motion sensor access
- Internet connection (for publishing only - recording works offline)

### GitHub Repository
- A GitHub repository for storing survey data
- Personal Access Token with `repo` scope
- Recommended: Use a dedicated repository for survey data

### Optional
- Mapbox access token for coverage map visualization

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Capture Interval | Time between captures | 2 seconds |
| Image Quality | JPEG compression level | Medium (0.7) |
| Max Resolution | Maximum image width | 1280px |
| GitHub Limit | Target repo size limit | 1 GB |

## Storage Estimates

| Capture Interval | 1 GB Limit | 5-hour session |
|------------------|------------|----------------|
| 1 second | ~3.5 hours | ~1.4 GB |
| 2 seconds | ~7 hours | ~720 MB |
| 5 seconds | ~17 hours | ~288 MB |
| 10 seconds | ~34 hours | ~144 MB |

## Reliability Features

- **Crash Recovery**: Automatically detects interrupted sessions
- **Offline Operation**: Records without internet connection
- **Persistent Storage**: Requests browser permission to prevent data loss
- **Quota Monitoring**: Warns before storage limits are reached
- **Resumable Uploads**: Publishing can be paused and resumed
- **Rate Limit Handling**: Automatically pauses for GitHub API limits
- **Wake Lock**: Keeps screen on during recording
- **GPS Health Monitoring**: Alerts on stale or inaccurate GPS

## File Structure

```
sessions/
├── session_1234567890/
│   ├── images/
│   │   ├── 000001.jpg
│   │   ├── 000002.jpg
│   │   └── ...
│   ├── data.csv
│   └── metadata.json
└── coverage-index.geojson
```

## Browser Permissions

The app requests the following permissions:
- Camera (for image capture)
- Location (for GPS tracking)
- Motion Sensors (for accelerometer)
- Screen Wake Lock (to prevent sleep)
- Persistent Storage (to prevent data loss)

## License

MIT License

## Contributing

Contributions welcome! Please ensure the app remains a static site deployable to GitHub Pages.

