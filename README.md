# YouTube Downloader Backend

A Node.js Express server for downloading YouTube videos in MP4 and MP3 formats.

## Features

- Download YouTube videos in various qualities (up to 4K)
- Convert videos to MP3 audio format
- Support for quality selection
- Automatic video and audio stream merging for high-quality downloads
- Debug endpoint to view available formats
- Automatic cleanup of old downloaded files

## Dependencies

- Express.js - Web framework
- @distube/ytdl-core - YouTube video downloading
- fluent-ffmpeg - Video/audio processing
- cors - Cross-origin resource sharing

## Installation

```bash
npm install
```

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

The server will run on port 5000 by default.

## API Endpoints

### GET /api/video-info
Get video information and available qualities.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

**Response:**
```json
{
  "title": "Video Title",
  "author": "Channel Name",
  "duration": 180,
  "viewCount": 1000000,
  "publishDate": "2023-01-01",
  "description": "Video description...",
  "thumbnail": "https://...",
  "availableQualities": {
    "video": ["2160p", "1440p", "1080p", "720p"],
    "audio": ["192k", "128k"]
  }
}
```

### POST /api/download
Download video in specified format and quality.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "format": "mp4", // or "mp3"
  "quality": "1080p" // or "best"
}
```

**Response:**
```json
{
  "success": true,
  "filename": "video_title.mp4",
  "downloadUrl": "/downloads/video_title.mp4",
  "message": "Download completed successfully!"
}
```

### POST /api/debug-formats
Get detailed information about all available formats.

**Request:**
```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}
```

## Requirements

- Node.js 14+
- FFmpeg (for audio conversion and video merging)

## Environment Variables

- `PORT` - Server port (default: 5000)

## License

MIT
