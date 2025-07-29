const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/downloads', express.static('downloads'));

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

// Enhanced agent configuration to avoid detection
const getRequestOptions = () => ({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    }
});

// Utility function to sanitize filename
const sanitizeFilename = (filename) => {
    return filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
};

// Enhanced error handling wrapper
const handleYtdlError = (error) => {
    console.error('YTDL Error Details:', {
        message: error.message,
        stack: error.stack,
        statusCode: error.statusCode
    });
    
    if (error.message.includes('<!DOCTYPE')) {
        return {
            error: 'YouTube access blocked or rate limited. Please try again later.',
            details: 'The request was blocked by YouTube. This often happens due to rate limiting or bot detection.'
        };
    }
    
    if (error.message.includes('Video unavailable')) {
        return {
            error: 'Video is unavailable or private',
            details: 'The video may be private, deleted, or region-restricted.'
        };
    }
    
    if (error.message.includes('Sign in to confirm')) {
        return {
            error: 'Age-restricted content',
            details: 'This video requires age verification and cannot be downloaded.'
        };
    }
    
    return {
        error: 'Failed to process YouTube video',
        details: error.message
    };
};

// Enhanced video info endpoint with better error handling
app.post('/api/video-info', async (req, res) => {
    try {
        const { url } = req.body;
        
        console.log('Received URL:', url);
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL format' });
        }

        console.log('Getting video info...');
        
        // Add timeout and retry logic
        const info = await Promise.race([
            ytdl.getInfo(url, {
                requestOptions: getRequestOptions()
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout')), 30000)
            )
        ]);
        
        const videoDetails = info.videoDetails;
        console.log('Video title:', videoDetails.title);
        
        // Validate that we got proper video details
        if (!videoDetails || !videoDetails.title) {
            throw new Error('Invalid video data received');
        }
        
        // Get all formats with enhanced filtering
        const allFormats = info.formats.filter(format => {
            // Filter out formats without proper URLs or content length
            return format.url && (format.contentLength || format.approxDurationMs);
        });
        
        console.log('Valid formats found:', allFormats.length);
        
        if (allFormats.length === 0) {
            throw new Error('No downloadable formats found for this video');
        }
        
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
                container: format.container,
                hasUrl: !!format.url
            });
        });
        
        // Filter video formats with audio
        const videoWithAudioFormats = allFormats.filter(f => 
            f.hasVideo && f.hasAudio && f.height && f.url
        );
        
        // Filter video-only formats
        const videoOnlyFormats = allFormats.filter(f => 
            f.hasVideo && !f.hasAudio && f.height && f.url
        );
        
        // Filter audio-only formats
        const audioOnlyFormats = allFormats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate && f.url
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

        // Ensure we have at least some formats available
        if (videoQualities.length === 0 && audioQualities.length === 0) {
            throw new Error('No valid download formats available for this video');
        }

        res.json({
            title: videoDetails.title,
            author: videoDetails.author?.name || 'Unknown',
            duration: videoDetails.lengthSeconds,
            viewCount: videoDetails.viewCount,
            publishDate: videoDetails.publishDate,
            description: videoDetails.description?.substring(0, 200) + '...' || 'No description available',
            thumbnail: videoDetails.thumbnails?.[videoDetails.thumbnails.length - 1]?.url || '',
            availableQualities: {
                video: videoQualities,
                audio: audioQualities
            }
        });

    } catch (error) {
        console.error('Error getting video info:', error);
        const errorResponse = handleYtdlError(error);
        res.status(500).json(errorResponse);
    }
});

// Enhanced download endpoint
app.post('/api/download', async (req, res) => {
    try {
        const { url, format, quality } = req.body;
        
        console.log('Download request:', { url, format, quality });
        
        if (!url || !format) {
            return res.status(400).json({ error: 'URL and format are required' });
        }
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL format' });
        }

        // Add timeout to getInfo request
        const info = await Promise.race([
            ytdl.getInfo(url, {
                requestOptions: getRequestOptions()
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout while getting video info')), 30000)
            )
        ]);
        
        const title = sanitizeFilename(info.videoDetails.title);
        
        console.log('Starting download for:', title);
        
        if (format === 'mp3') {
            await downloadMP3(url, title, quality, res, info);
        } else {
            await downloadMP4(url, title, quality, res, info);
        }

    } catch (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
            const errorResponse = handleYtdlError(error);
            res.status(500).json(errorResponse);
        }
    }
});

// Enhanced MP3 Download function
async function downloadMP3(url, title, quality, res, info) {
    const filename = `${title}.mp3`;
    const filepath = path.join(downloadsDir, filename);
    
    try {
        console.log('Starting MP3 download...');
        
        // Get the best audio format with enhanced filtering
        const audioFormats = info.formats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate && f.url && (f.contentLength || f.approxDurationMs)
        );
        
        console.log('Available audio formats for MP3:', audioFormats.map(f => ({
            audioBitrate: f.audioBitrate,
            audioSampleRate: f.audioSampleRate,
            itag: f.itag,
            container: f.container,
            hasUrl: !!f.url
        })));
        
        if (audioFormats.length === 0) {
            throw new Error('No suitable audio-only formats available for this video');
        }
        
        // Select the best audio format
        const bestAudioFormat = audioFormats.sort((a, b) => b.audioBitrate - a.audioBitrate)[0];
        console.log('Selected audio format:', bestAudioFormat.itag, bestAudioFormat.audioBitrate + 'kbps');
        
        // Get audio stream with enhanced options
        const audioStream = ytdl(url, {
            format: bestAudioFormat,
            requestOptions: getRequestOptions(),
            highWaterMark: 1 << 25 // Increase buffer size
        });

        // Add error handling for the stream
        audioStream.on('error', (error) => {
            console.error('Audio stream error:', error);
            if (!res.headersSent) {
                res.status(500).json(handleYtdlError(error));
            }
        });

        // Determine bitrate
        let bitrate = 192; // default
        if (quality !== 'best' && quality.includes('kbps')) {
            bitrate = parseInt(quality.replace('kbps', ''));
        }

        console.log('Converting to MP3 with bitrate:', bitrate);

        // Convert to MP3 using ffmpeg with timeout
        const ffmpegProcess = ffmpeg(audioStream)
            .audioBitrate(bitrate)
            .format('mp3')
            .audioCodec('libmp3lame')
            .on('start', (commandLine) => {
                console.log('FFmpeg started with command:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Processing: ' + progress.percent + '% done');
            })
            .save(filepath);

        // Add timeout to ffmpeg process
        const timeout = setTimeout(() => {
            ffmpegProcess.kill('SIGKILL');
            if (!res.headersSent) {
                res.status(500).json({ error: 'MP3 conversion timeout' });
            }
        }, 300000); // 5 minutes timeout

        ffmpegProcess.on('end', () => {
            clearTimeout(timeout);
            console.log('MP3 conversion completed');
            if (!res.headersSent) {
                res.json({
                    success: true,
                    filename: filename,
                    downloadUrl: `/downloads/${filename}`,
                    message: 'MP3 download completed successfully!'
                });
            }
        });

        ffmpegProcess.on('error', (error) => {
            clearTimeout(timeout);
            console.error('FFmpeg error:', error);
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Failed to convert to MP3',
                    details: error.message 
                });
            }
        });

    } catch (error) {
        console.error('MP3 download error:', error);
        if (!res.headersSent) {
            res.status(500).json(handleYtdlError(error));
        }
    }
}

// Enhanced MP4 Download function
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

        // Get available formats with enhanced filtering
        const allFormats = info.formats.filter(f => f.url && (f.contentLength || f.approxDurationMs));
        console.log('Total valid formats available:', allFormats.length);
        
        if (allFormats.length === 0) {
            throw new Error('No valid formats available for download');
        }
        
        // Filter formats that have both video and audio
        const videoWithAudioFormats = allFormats.filter(f => 
            f.hasVideo && f.hasAudio && f.height
        );
        
        console.log('Available video+audio formats:', videoWithAudioFormats.map(f => ({
            height: f.height,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            itag: f.itag,
            container: f.container,
            hasUrl: !!f.url
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
                    requestOptions: getRequestOptions(),
                    highWaterMark: 1 << 25
                });

                // Add error handling for the stream
                videoStream.on('error', (error) => {
                    console.error('Video stream error:', error);
                    throw error;
                });

                const writeStream = fs.createWriteStream(filepath);
                
                // Add timeout to pipeline
                await Promise.race([
                    pipeline(videoStream, writeStream),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Download timeout')), 600000) // 10 minutes
                    )
                ]);

                console.log('Single stream download completed');
                if (!res.headersSent) {
                    res.json({
                        success: true,
                        filename: filename,
                        downloadUrl: `/downloads/${filename}`,
                        message: `MP4 download completed successfully at ${selectedFormat.height}p!`
                    });
                }
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
        if (!res.headersSent) {
            res.status(500).json(handleYtdlError(error));
        }
    }
}

// Enhanced download and merge MP4 function
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

        // Select video format with enhanced filtering
        let videoFormat;
        const videoOnlyFormats = info.formats.filter(f => 
            f.hasVideo && !f.hasAudio && f.height && f.url && (f.contentLength || f.approxDurationMs)
        );
        
        console.log('Available video-only formats:', videoOnlyFormats.map(f => ({
            height: f.height,
            quality: f.quality,
            qualityLabel: f.qualityLabel,
            itag: f.itag,
            container: f.container,
            hasUrl: !!f.url
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

        // Select audio format with enhanced filtering
        const audioOnlyFormats = info.formats.filter(f => 
            !f.hasVideo && f.hasAudio && f.audioBitrate && f.url && (f.contentLength || f.approxDurationMs)
        );
        
        console.log('Available audio-only formats:', audioOnlyFormats.map(f => ({
            audioBitrate: f.audioBitrate,
            audioSampleRate: f.audioSampleRate,
            itag: f.itag,
            container: f.container,
            hasUrl: !!f.url
        })));
        
        const audioFormat = audioOnlyFormats.sort((a, b) => b.audioBitrate - a.audioBitrate)[0];

        if (!videoFormat || !audioFormat) {
            throw new Error(`Could not find suitable formats. Video: ${!!videoFormat}, Audio: ${!!audioFormat}`);
        }

        console.log(`Selected formats - Video: ${videoFormat.height}p (itag: ${videoFormat.itag}), Audio: ${audioFormat.audioBitrate}kbps (itag: ${audioFormat.itag})`);

        // Download video stream with timeout
        console.log('Downloading video stream...');
        const videoStream = ytdl(url, { 
            format: videoFormat,
            requestOptions: getRequestOptions(),
            highWaterMark: 1 << 25
        });
        
        await Promise.race([
            pipeline(videoStream, fs.createWriteStream(tempVideoPath)),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Video download timeout')), 600000)
            )
        ]);
        console.log('Video stream downloaded');
        
        // Download audio stream with timeout
        console.log('Downloading audio stream...');
        const audioStream = ytdl(url, { 
            format: audioFormat,
            requestOptions: getRequestOptions(),
            highWaterMark: 1 << 25
        });
        
        await Promise.race([
            pipeline(audioStream, fs.createWriteStream(tempAudioPath)),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Audio download timeout')), 600000)
            )
        ]);
        console.log('Audio stream downloaded');

        // Merge using ffmpeg with timeout
        console.log('Starting merge with ffmpeg...');
        const ffmpegProcess = ffmpeg()
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
            .save(filepath);

        // Add timeout to ffmpeg process
        const timeout = setTimeout(() => {
            ffmpegProcess.kill('SIGKILL');
            cleanupTempFiles();
            if (!res.headersSent) {
                res.status(500).json({ error: 'Merge process timeout' });
            }
        }, 300000); // 5 minutes timeout

        const cleanupTempFiles = () => {
            try {
                if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
                if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
            } catch (cleanupError) {
                console.error('Error cleaning up temp files:', cleanupError);
            }
        };

        ffmpegProcess
            .on('end', () => {
                clearTimeout(timeout);
                console.log('Merge completed successfully');
                cleanupTempFiles();
                
                if (!res.headersSent) {
                    res.json({
                        success: true,
                        filename: filename,
                        downloadUrl: `/downloads/${filename}`,
                        message: `MP4 download completed successfully at ${videoFormat.height}p!`
                    });
                }
            })
            .on('error', (error) => {
                clearTimeout(timeout);
                console.error('Merge error:', error);
                cleanupTempFiles();
                
                if (!res.headersSent) {
                    res.status(500).json({ 
                        error: 'Failed to merge video and audio',
                        details: error.message 
                    });
                }
            });

    } catch (error) {
        console.error('Download and merge error:', error);
        // Clean up temp files
        try {
            if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
            if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        } catch (cleanupError) {
            console.error('Error cleaning up temp files:', cleanupError);
        }
        
        if (!res.headersSent) {
            res.status(500).json(handleYtdlError(error));
        }
    }
}

// Enhanced debug endpoint
app.post('/api/debug-formats', async (req, res) => {
    try {
        const { url } = req.body;
        
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const info = await Promise.race([
            ytdl.getInfo(url, {
                requestOptions: getRequestOptions()
            }),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Request timeout')), 30000)
            )
        ]);
        
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
            mimeType: f.mimeType,
            hasUrl: !!f.url
        }));

        res.json({
            title: info.videoDetails.title,
            totalFormats: formats.length,
            validFormats: formats.filter(f => f.hasUrl).length,
            formats: formats
        });

    } catch (error) {
        console.error('Debug formats error:', error);
        res.status(500).json(handleYtdlError(error));
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        downloadsDir: downloadsDir
    });
});

// Enhanced cleanup with error handling
setInterval(() => {
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        files.forEach(file => {
            try {
                const filePath = path.join(downloadsDir, file);
                const stats = fs.statSync(filePath);
                
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old file: ${file}`);
                }
            } catch (fileError) {
                console.error(`Error processing file ${file}:`, fileError);
            }
        });
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}, 60 * 60 * 1000); // Run every hour

// Global error handler
app.use((error, req, res, next) => {
    console.error('Global error handler:', error);
    if (!res.headersSent) {
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`YouTube Downloader server running on port ${PORT}`);
    console.log(`Downloads will be saved to: ${downloadsDir}`);
    console.log('Health check available at: /api/health');
});
