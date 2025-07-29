const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

// Set environment variable to disable update check
process.env.YTDL_NO_UPDATE = '1';

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: ['http://localhost:3000', 'https://ytdownkb.onrender.com', /\.vercel\.app$/, /\.netlify\.app$/, /\.surge\.sh$/], // Allow multiple origins including common deployment platforms
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve downloads with proper headers for browser download
app.get('/downloads/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(downloadsDir, filename);
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    // Set headers to force download to user's default download folder
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins for file downloads
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.mp3') {
        res.setHeader('Content-Type', 'audio/mpeg');
    } else if (ext === '.mp4') {
        res.setHeader('Content-Type', 'video/mp4');
    }
    
    // Stream the file to the user
    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
    
    fileStream.on('end', () => {
        console.log(`File served for download: ${filename}`);
    });
    
    fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Error downloading file' });
        }
    });
});

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Utility function to sanitize filename
const sanitizeFilename = (filename) => {
    return filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
};

// Utility function to format file size
const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Get video info endpoint
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        console.log('Received URL:', url);
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log('Getting video info...');
        
        // Retry mechanism for getting video info
        let info;
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                info = await ytdl.getInfo(url, {
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'en-US,en;q=0.5',
                            'Accept-Encoding': 'gzip, deflate',
                            'DNT': '1',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1'
                        },
                        transform: (parsed) => {
                            parsed.rejectUnauthorized = false;
                            return parsed;
                        }
                    },
                    agent: false
                });
                break; // Success, exit retry loop
            } catch (error) {
                attempts++;
                console.log(`Attempt ${attempts} failed:`, error.message);
                
                if (attempts >= maxAttempts) {
                    // If all retries failed, check if it's a specific error
                    if (error.message.includes('Video unavailable')) {
                        return res.status(400).json({ 
                            error: 'This video is not available for download. It may be private, age-restricted, or region-blocked.',
                            details: 'Please try with a different video URL.'
                        });
                    }
                    throw error; // Re-throw other errors
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
        }
        
        const videoDetails = info.videoDetails;
        console.log('Video title:', videoDetails.title);
        
        // Get all formats
        const allFormats = info.formats;
        console.log('Total formats found:', allFormats.length);
        
        // Debug: Log format details
        allFormats.forEach((format, index) => {
            console.log(`Format ${index}:`, {
                itag: format.itag,
                quality: format.quality,
                qualityLabel: format.qualityLabel,
                height: format.height,
                hasVideo: format.hasVideo,
                hasAudio: format.hasAudio,
                audioBitrate: format.audioBitrate,
                container: format.container
            });
        });
        
        // Filter video formats with audio
        const videoWithAudioFormats = allFormats.filter(f => 
            f.hasVideo && f.hasAudio && f.height
        );
        
        // Filter video-only formats
        const videoOnlyFormats = allFormats.filter(f => 
            f.hasVideo && !f.hasAudio && f.height
        );
        
        // Filter audio-only formats
        const audioOnlyFormats = allFormats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate
        );
        
        console.log('Video+Audio formats:', videoWithAudioFormats.length);
        console.log('Video-only formats:', videoOnlyFormats.length);
        console.log('Audio-only formats:', audioOnlyFormats.length);
        
        // Get unique video qualities from both video+audio and video-only formats
        const allVideoFormats = [...videoWithAudioFormats, ...videoOnlyFormats];
        const videoQualities = [...new Set(allVideoFormats
            .filter(f => f.height)
            .map(f => f.height)
            .sort((a, b) => b - a)
        )].map(height => `${height}p`);

        // Get unique audio qualities
        const audioQualities = [...new Set(audioOnlyFormats
            .filter(f => f.audioBitrate)
            .map(f => f.audioBitrate)
            .sort((a, b) => b - a)
        )].map(bitrate => `${bitrate}kbps`);

        console.log('Available video qualities:', videoQualities);
        console.log('Available audio qualities:', audioQualities);

        res.json({
            title: videoDetails.title,
            author: videoDetails.author.name,
            duration: videoDetails.lengthSeconds,
            viewCount: videoDetails.viewCount,
            publishDate: videoDetails.publishDate,
            description: videoDetails.description?.substring(0, 200) + '...',
            thumbnail: videoDetails.thumbnails[videoDetails.thumbnails.length - 1].url,
            availableQualities: {
                video: videoQualities,
                audio: audioQualities
            }
        });

    } catch (error) {
        console.error('Error getting video info:', error);
        console.error('Error details:', error.message);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to get video information',
            details: error.message 
        });
    }
});

// Debug formats endpoint
app.post('/api/debug-formats', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                transform: (parsed) => {
                    parsed.rejectUnauthorized = false;
                    return parsed;
                }
            },
            agent: false
        });
        const videoDetails = info.videoDetails;
        
        // Get all available formats with detailed information
        const allFormats = info.formats.map(format => ({
            itag: format.itag,
            container: format.container,
            quality: format.quality,
            qualityLabel: format.qualityLabel,
            height: format.height,
            width: format.width,
            fps: format.fps,
            hasVideo: format.hasVideo,
            hasAudio: format.hasAudio,
            audioBitrate: format.audioBitrate,
            audioSampleRate: format.audioSampleRate,
            contentLength: format.contentLength,
            url: format.url ? 'Available' : 'Unavailable'
        }));

        res.json({
            title: videoDetails.title,
            totalFormats: allFormats.length,
            formats: allFormats
        });

    } catch (error) {
        console.error('Error getting debug info:', error);
        res.status(500).json({ error: 'Failed to get debug information' });
    }
});

// Download endpoint
app.post('/api/download', async (req, res) => {
    try {
        const { url, format, quality } = req.body;
        
        console.log('Download request:', { url, format, quality });
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                transform: (parsed) => {
                    parsed.rejectUnauthorized = false;
                    return parsed;
                }
            },
            agent: false
        });
        const title = sanitizeFilename(info.videoDetails.title);
        
        console.log('Starting download for:', title);
        
        if (format === 'mp3') {
            await downloadMP3(url, title, quality, res, info);
        } else {
            await downloadMP4(url, title, quality, res, info);
        }

    } catch (error) {
        console.error('Download error:', error);
        console.error('Error details:', error.message);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Download failed',
                details: error.message 
            });
        }
    }
});

// MP3 Download function
async function downloadMP3(url, title, quality, res, info) {
    const filename = `${title}.mp3`;
    const filepath = path.join(downloadsDir, filename);
    
    try {
        console.log('Starting MP3 download...');
        
        // Get the best audio format
        const audioFormats = info.formats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate && f.contentLength
        );
        
        console.log('Available audio formats for MP3:', audioFormats.map(f => ({
            audioBitrate: f.audioBitrate,
            audioSampleRate: f.audioSampleRate,
            itag: f.itag,
            container: f.container
        })));
        
        if (audioFormats.length === 0) {
            throw new Error('No audio-only formats available');
        }
        
        // Select the best audio format
        const bestAudioFormat = audioFormats.sort((a, b) => b.audioBitrate - a.audioBitrate)[0];
        console.log('Selected audio format:', bestAudioFormat.itag, bestAudioFormat.audioBitrate + 'kbps');
        
        // Get audio stream with specific format
        const audioStream = ytdl(url, {
            format: bestAudioFormat,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }
        });

        // Determine bitrate
        let bitrate = 192; // default
        if (quality !== 'best' && quality.includes('kbps')) {
            bitrate = parseInt(quality.replace('kbps', ''));
        }

        console.log('Converting to MP3 with bitrate:', bitrate);

        // Convert to MP3 using ffmpeg
        const ffmpegProcess = ffmpeg(audioStream)
            .audioBitrate(bitrate)
            .format('mp3')
            .on('start', (commandLine) => {
                console.log('FFmpeg started with command:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Processing: ' + progress.percent + '% done');
            })
            .save(filepath);

        ffmpegProcess.on('end', () => {
            console.log('MP3 conversion completed');
            const fileSize = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
            res.json({
                success: true,
                filename: filename,
                downloadUrl: `/downloads/${filename}`,
                message: `MP3 download completed successfully! (${formatFileSize(fileSize)})`,
                fileSize: fileSize,
                fileSizeFormatted: formatFileSize(fileSize),
                autoDownload: true // Flag to trigger automatic download in frontend
            });
        });

        ffmpegProcess.on('error', (error) => {
            console.error('FFmpeg error:', error);
            res.status(500).json({ 
                error: 'Failed to convert to MP3',
                details: error.message 
            });
        });

    } catch (error) {
        console.error('MP3 download error:', error);
        res.status(500).json({ 
            error: 'MP3 download failed',
            details: error.message 
        });
    }
}

// MP4 Download function
async function downloadMP4(url, title, quality, res, info) {
    const filename = `${title}.mp4`;
    const filepath = path.join(downloadsDir, filename);
    
    try {
        console.log('Starting MP4 download with quality:', quality);
        
        let targetHeight = null;
        
        // Determine target height
        if (quality !== 'best' && quality.includes('p')) {
            targetHeight = parseInt(quality.replace('p', ''));
            console.log('Target height:', targetHeight);
        }

        // Get available formats
        const allFormats = info.formats;
        console.log('Total formats available:', allFormats.length);
        
        // Filter formats that have both video and audio
        const videoWithAudioFormats = allFormats.filter(f => 
            f.hasVideo && f.hasAudio && f.height && f.contentLength
        );
        
        console.log('Available video+audio formats:', videoWithAudioFormats.map(f => ({
            height: f.height,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            itag: f.itag,
            container: f.container
        })));
        
        // First, try to find a format with both video and audio
        let selectedFormat = null;
        
        if (targetHeight) {
            // Look for exact height match with video and audio
            selectedFormat = videoWithAudioFormats.find(f => f.height === targetHeight);
            console.log('Exact match found:', !!selectedFormat);
            
            // If not found, look for closest height with video and audio
            if (!selectedFormat) {
                const closestFormats = videoWithAudioFormats
                    .filter(f => f.height <= targetHeight)
                    .sort((a, b) => b.height - a.height);
                
                selectedFormat = closestFormats[0];
                console.log('Closest match found:', !!selectedFormat, selectedFormat?.height);
            }
        } else {
            // Get best quality with both video and audio
            const sortedFormats = videoWithAudioFormats.sort((a, b) => b.height - a.height);
            selectedFormat = sortedFormats[0];
            console.log('Best quality match found:', !!selectedFormat, selectedFormat?.height);
        }

        if (selectedFormat) {
            console.log(`Downloading single stream: ${selectedFormat.height}p, container: ${selectedFormat.container}, itag: ${selectedFormat.itag}`);
            
            try {
                const videoStream = ytdl(url, {
                    format: selectedFormat,
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    }
                });

                const writeStream = fs.createWriteStream(filepath);
                await pipeline(videoStream, writeStream);

                console.log('Single stream download completed');
                const fileSize = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
                res.json({
                    success: true,
                    filename: filename,
                    downloadUrl: `/downloads/${filename}`,
                    message: `MP4 download completed successfully at ${selectedFormat.height}p! (${formatFileSize(fileSize)})`,
                    fileSize: fileSize,
                    fileSizeFormatted: formatFileSize(fileSize),
                    autoDownload: true // Flag to trigger automatic download in frontend
                });
            } catch (streamError) {
                console.error('Stream download failed:', streamError.message);
                console.log('Falling back to merge method...');
                await downloadAndMergeMP4(url, title, quality, res, info);
            }
        } else {
            // No single format found, need to merge video and audio
            console.log('No single format found, downloading and merging...');
            await downloadAndMergeMP4(url, title, quality, res, info);
        }

    } catch (error) {
        console.error('MP4 download error:', error);
        res.status(500).json({ 
            error: 'MP4 download failed',
            details: error.message 
        });
    }
}

// Download and merge MP4 (for higher quality videos)
async function downloadAndMergeMP4(url, title, quality, res, info) {
    const filename = `${title}.mp4`;
    const filepath = path.join(downloadsDir, filename);
    const tempVideoPath = path.join(downloadsDir, `${title}_temp_video.mp4`);
    const tempAudioPath = path.join(downloadsDir, `${title}_temp_audio.mp4`);
    
    try {
        console.log('Starting merge process...');
        
        let targetHeight = null;
        
        if (quality !== 'best' && quality.includes('p')) {
            targetHeight = parseInt(quality.replace('p', ''));
        }

        // Select video format
        let videoFormat;
        const videoOnlyFormats = info.formats.filter(f => 
            f.hasVideo && !f.hasAudio && f.height && f.contentLength
        );
        
        console.log('Available video-only formats:', videoOnlyFormats.map(f => ({
            height: f.height,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            itag: f.itag,
            container: f.container
        })));
        
        if (targetHeight) {
            // Find exact height match
            videoFormat = videoOnlyFormats.find(f => f.height === targetHeight);
            
            // If not found, get closest
            if (!videoFormat) {
                const closestFormats = videoOnlyFormats
                    .filter(f => f.height <= targetHeight)
                    .sort((a, b) => b.height - a.height);
                videoFormat = closestFormats[0];
            }
        } else {
            // Get highest quality
            videoFormat = videoOnlyFormats.sort((a, b) => b.height - a.height)[0];
        }

        // Select audio format
        const audioOnlyFormats = info.formats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate && f.contentLength
        );
        
        console.log('Available audio-only formats:', audioOnlyFormats.map(f => ({
            audioBitrate: f.audioBitrate,
            audioSampleRate: f.audioSampleRate,
            itag: f.itag,
            container: f.container
        })));
        
        const audioFormat = audioOnlyFormats.sort((a, b) => b.audioBitrate - a.audioBitrate)[0];

        if (!videoFormat || !audioFormat) {
            throw new Error(`Could not find suitable formats. Video: ${!!videoFormat}, Audio: ${!!audioFormat}`);
        }

        console.log(`Selected formats - Video: ${videoFormat.height}p (itag: ${videoFormat.itag}), Audio: ${audioFormat.audioBitrate}kbps (itag: ${audioFormat.itag})`);

        // Download video stream
        console.log('Downloading video stream...');
        const videoStream = ytdl(url, { 
            format: videoFormat,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }
        });
        await pipeline(videoStream, fs.createWriteStream(tempVideoPath));
        console.log('Video stream downloaded');
        
        // Download audio stream
        console.log('Downloading audio stream...');
        const audioStream = ytdl(url, { 
            format: audioFormat,
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }
        });
        await pipeline(audioStream, fs.createWriteStream(tempAudioPath));
        console.log('Audio stream downloaded');

        // Merge using ffmpeg
        console.log('Starting merge with ffmpeg...');
        ffmpeg()
            .input(tempVideoPath)
            .input(tempAudioPath)
            .videoCodec('copy')
            .audioCodec('aac')
            .on('start', (commandLine) => {
                console.log('FFmpeg started with command:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Merging progress: ' + progress.percent + '% done');
            })
            .save(filepath)
            .on('end', () => {
                console.log('Merge completed successfully');
                // Clean up temp files
                if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
                if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
                
                const fileSize = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
                res.json({
                    success: true,
                    filename: filename,
                    downloadUrl: `/downloads/${filename}`,
                    message: `MP4 download completed successfully at ${videoFormat.height}p! (${formatFileSize(fileSize)})`,
                    fileSize: fileSize,
                    fileSizeFormatted: formatFileSize(fileSize),
                    autoDownload: true // Flag to trigger automatic download in frontend
                });
            })
            .on('error', (error) => {
                console.error('Merge error:', error);
                // Clean up temp files
                if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
                if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
                
                res.status(500).json({ 
                    error: 'Failed to merge video and audio',
                    details: error.message 
                });
            });

    } catch (error) {
        console.error('Download and merge error:', error);
        // Clean up temp files
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        
        res.status(500).json({ 
            error: 'Download and merge failed',
            details: error.message 
        });
    }
}

// Debug endpoint to see all available formats
app.post('/api/debug-formats', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const info = await ytdl.getInfo(url, {
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                }
            }
        });
        
        const formats = info.formats.map(f => ({
            itag: f.itag,
            container: f.container,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            height: f.height,
            width: f.width,
            fps: f.fps,
            hasVideo: f.hasVideo,
            hasAudio: f.hasAudio,
            audioBitrate: f.audioBitrate,
            audioSampleRate: f.audioSampleRate,
            contentLength: f.contentLength,
            mimeType: f.mimeType
        }));

        res.json({
            title: info.videoDetails.title,
            totalFormats: formats.length,
            formats: formats
        });

    } catch (error) {
        console.error('Debug formats error:', error);
        res.status(500).json({ 
            error: 'Failed to get format information',
            details: error.message 
        });
    }
});

// Clean up old files periodically (optional)
setInterval(() => {
    const files = fs.readdirSync(downloadsDir);
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    files.forEach(file => {
        const filePath = path.join(downloadsDir, file);
        const stats = fs.statSync(filePath);
        
        if (now - stats.mtime.getTime() > maxAge) {
            fs.unlinkSync(filePath);
            console.log(`Cleaned up old file: ${file}`);
        }
    });
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
    console.log(`YouTube Downloader server running on port ${PORT}`);
    console.log(`Downloads will be saved to: ${downloadsDir}`);
});