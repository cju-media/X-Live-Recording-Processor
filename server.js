const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const multer = require('multer');

const app = express();
const PORT = 1797;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

const CONFIG_FILE = path.join(__dirname, 'config.json');
const CSV_FILE = path.join(__dirname, 'track_titles.csv');

let activeProcessTracker = { proc: null };

// Initialize files
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ card1: '', card2: '', output: '' }, null, 2));
}

if (!fs.existsSync(CSV_FILE)) {
    let defaultCsv = 'track,title,process\n';
    for(let i=1; i<=32; i++) {
        defaultCsv += `${i},Track ${i},true\n`;
    }
    fs.writeFileSync(CSV_FILE, defaultCsv);
}

// API: Config
app.get('/api/config', (req, res) => {
    if (fs.existsSync(CONFIG_FILE)) {
        res.json(JSON.parse(fs.readFileSync(CONFIG_FILE)));
    } else {
        res.json({});
    }
});

app.post('/api/config', (req, res) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
});

// API: CSV
app.get('/api/csv', (req, res) => {
    if (fs.existsSync(CSV_FILE)) {
        res.send(fs.readFileSync(CSV_FILE, 'utf-8'));
    } else {
        res.send('');
    }
});

app.post('/api/csv', (req, res) => {
    const { csvContent } = req.body;
    if (csvContent) {
        fs.writeFileSync(CSV_FILE, csvContent);
    }
    res.json({ success: true });
});

app.post('/api/upload-csv', upload.single('csvFile'), (req, res) => {
    if (req.file) {
        const content = fs.readFileSync(req.file.path, 'utf-8');
        fs.writeFileSync(CSV_FILE, content);
        fs.unlinkSync(req.file.path);
        res.json({ success: true, csvContent: content });
    } else {
        res.status(400).json({ error: 'No file uploaded' });
    }
});

app.get('/api/csv/download', (req, res) => {
    if (fs.existsSync(CSV_FILE)) {
        res.download(CSV_FILE, 'track_titles.csv');
    } else {
        res.status(404).send('CSV file not found');
    }
});

app.get('/api/cancel', (req, res) => {
    if (activeProcessTracker.proc) {
        try {
            activeProcessTracker.proc.kill('SIGKILL');
            activeProcessTracker.proc = null;
            res.json({ success: true, message: 'Process cancelled' });
        } catch (e) {
            res.status(500).json({ error: 'Failed to cancel process' });
        }
    } else {
        res.json({ success: false, message: 'No active process' });
    }
});

// API: Browse Directory
app.get('/api/browse', (req, res) => {
    let dir = req.query.dir || 'root';
    if (dir === 'root') {
        dir = path.parse(process.cwd()).root;
    }
    try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        const directories = items.filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => item.name).sort();
        res.json({ currentDir: dir, directories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function cleanPath(inputPath) {
    if (!inputPath) return '';
    let p = inputPath.trim().replace(/^['"](.*)['"]$/, '$1').trim();
    if (p.startsWith('file://')) {
        p = p.substring(7);
        // decode URI components in case spaces are %20
        try { p = decodeURI(p); } catch(e) {}
    }
    // Remove backslash escapes for spaces typical in terminal drag/drop
    p = p.replace(/\\ /g, ' ');
    return p;
}

async function getWavFiles(dir) {
    if (!dir) return [];
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Directory does not exist or is not a folder: ${dir}`);
    }
    let wavFiles = [];

    function searchRecursive(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                searchRecursive(fullPath);
            } else if (entry.isFile() && entry.name.toUpperCase().endsWith('.WAV')) {
                wavFiles.push(fullPath);
            }
        }
    }

    searchRecursive(dir);
    return wavFiles.sort();
}

function runCommand(command, args, sendLog, onProgress, processTracker) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        if (processTracker) {
             processTracker.proc = proc;
        }
        let output = '';

        proc.stdout.on('data', data => {
            const str = data.toString();
            output += str;
            if (sendLog) sendLog(str.trim());
        });

        proc.stderr.on('data', data => {
            const str = data.toString();

            // Try parsing ffmpeg time= progress
            if (onProgress && command === ffmpegPath) {
                const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1], 10);
                    const minutes = parseInt(timeMatch[2], 10);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentSeconds = (hours * 3600) + (minutes * 60) + seconds;
                    onProgress(currentSeconds);
                }
            }

            if (sendLog && command !== ffprobePath) { // ffprobe logs to stderr by default
                // sendLog(str.trim()); // ffmpeg logs a lot to stderr, omit to avoid swamping UI unless debugging
            }
        });

        proc.on('error', err => reject(err));
        proc.on('close', code => {
            if (processTracker) {
                 processTracker.proc = null;
            }
            if (code === 0) {
                resolve(output.trim());
            } else if (code === null) {
                reject(new Error('Process was cancelled'));
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });
    });
}

app.get('/process', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendLog = (msg) => {
        if (!msg) return;
        const lines = msg.split('\n');
        for (const line of lines) {
            res.write(`data: ${line}\n\n`);
        }
    };

    const sendProgress = (percent) => {
        res.write(`event: progress\ndata: ${percent}\n\n`);
    }

    const sendError = (msg) => {
        res.write(`event: errorMsg\ndata: ${msg}\n\n`);
    };

    const finish = () => {
        res.write(`event: done\ndata: ok\n\n`);
        res.end();
    };

    try {
        const card1Dir = cleanPath(req.query.card1);
        const card2Dir = cleanPath(req.query.card2);
        const outputDir = cleanPath(req.query.output);

        if (!card1Dir || !outputDir) {
            sendError('First Card directory and Output directory are required.');
            return finish();
        }

        sendLog('Scanning directories...');
        let files1 = [];
        let files2 = [];

        try {
            files1 = await getWavFiles(card1Dir);
        } catch (e) {
            sendError(e.message);
            return finish();
        }

        if (card2Dir) {
            try {
                files2 = await getWavFiles(card2Dir);
            } catch (e) {
                sendError(e.message);
                return finish();
            }
        }

        const allWavFiles = [...files1, ...files2];

        if (allWavFiles.length === 0) {
            sendError('No .WAV files found in the provided directories.');
            return finish();
        }

        sendLog(`Found ${allWavFiles.length} .WAV file(s) to process.`);

        let totalDurationSeconds = 0;
        sendLog('Calculating total duration...');
        for (const file of allWavFiles) {
            try {
                const durStr = await runCommand(ffprobePath, [
                    '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    file
                ]);
                const dur = parseFloat(durStr);
                if (!isNaN(dur)) totalDurationSeconds += dur;
            } catch(err) {
                 sendLog(`Warning: Could not get duration for ${path.basename(file)}`);
            }
        }

        if (totalDurationSeconds > 0) {
            sendLog(`Total duration to process: ${totalDurationSeconds.toFixed(2)} seconds.`);
        } else {
            sendLog(`Warning: Total duration could not be calculated.`);
        }

        const firstFile = allWavFiles[0];
        sendLog(`Analyzing ${path.basename(firstFile)} ...`);

        // Get Channels
        let numChannels;
        try {
            const channelsStr = await runCommand(ffprobePath, [
                '-v', 'error',
                '-show_entries', 'stream=channels',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                firstFile
            ]);
            numChannels = parseInt(channelsStr);
            if (isNaN(numChannels) || numChannels <= 0) throw new Error("Invalid channel count");
        } catch (err) {
            sendError(`Failed to detect number of channels: ${err.message}`);
            return finish();
        }

        sendLog(`Detected ${numChannels} channels.`);

        // Get Bit Depth
        let bitDepth = 24;
        try {
            const bitDepthStr = await runCommand(ffprobePath, [
                '-v', 'error',
                '-show_entries', 'stream=bits_per_raw_sample,bits_per_sample',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                firstFile
            ]);

            const lines = bitDepthStr.split('\n').map(l => l.trim()).filter(l => l && l !== 'N/A');
            if (lines.length > 0) {
                 const detectedBits = parseInt(lines[0]);
                 if (!isNaN(detectedBits) && detectedBits > 0) {
                     bitDepth = detectedBits;
                 }
            }
        } catch (err) {
            sendLog('Could not determine bit depth, defaulting to 24-bit.');
        }

        sendLog(`Detected bit depth: ${bitDepth}`);

        if (!fs.existsSync(outputDir)) {
            sendLog(`Creating output directory: ${outputDir}`);
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const concatFilePath = path.join(outputDir, 'concat_list.txt');
        const concatContent = allWavFiles.map(f => {
            let absPath = path.resolve(f).replace(/\\/g, '/');
            return `file '${absPath.replace(/'/g, "'\\''")}'`;
        }).join('\n');
        fs.writeFileSync(concatFilePath, concatContent);

        // Read CSV track titles
        let trackNames = {};
        let trackProcessStatus = {};
        if (fs.existsSync(CSV_FILE)) {
            const csvContent = fs.readFileSync(CSV_FILE, 'utf-8');
            const lines = csvContent.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line) {
                    const parts = line.split(',');
                    if (parts.length >= 2) {
                        const num = parseInt(parts[0].trim(), 10);
                        let title = parts[1].trim();
                        let processStatus = true;

                        // Parse third column for process toggle if it exists
                        if (parts.length >= 3) {
                            const processStr = parts[parts.length - 1].trim().toLowerCase();
                            if (processStr === 'false' || processStr === '0' || processStr === 'no') {
                                processStatus = false;
                            }
                            title = parts.slice(1, parts.length - 1).join(',').trim();
                        } else {
                            title = parts.slice(1).join(',').trim();
                        }

                        if (!isNaN(num) && title) {
                            let safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-');
                            trackNames[num] = safeTitle;
                            trackProcessStatus[num] = processStatus;
                        }
                    }
                }
            }
        }

        sendLog('\nStarting ffmpeg processing...');

        const ffmpegArgs = ['-f', 'concat', '-safe', '0', '-i', concatFilePath];

        let filterComplex = '';
        for (let i = 0; i < numChannels; i++) {
            const trackNum = i + 1;
            const shouldProcess = trackProcessStatus[trackNum] !== false; // Default to true if not defined
            if (shouldProcess) {
                filterComplex += `[0:a]pan=1c|c0=c${i}[ch${i+1}];`;
            }
        }

        if (filterComplex === '') {
             sendError("No tracks selected for processing.");
             if (fs.existsSync(concatFilePath)) {
                 fs.unlinkSync(concatFilePath);
             }
             return finish();
        }

        filterComplex = filterComplex.slice(0, -1);
        ffmpegArgs.push('-filter_complex', filterComplex);

        let audioCodec = 'pcm_s24le';
        if (bitDepth === 16) audioCodec = 'pcm_s16le';
        else if (bitDepth === 32) audioCodec = 'pcm_s32le';

        let processingTrackNames = [];
        for (let i = 0; i < numChannels; i++) {
            const trackNum = i + 1;
            const shouldProcess = trackProcessStatus[trackNum] !== false;
            if (shouldProcess) {
                ffmpegArgs.push('-map', `[ch${i+1}]`);
                ffmpegArgs.push('-c:a', audioCodec);
                let trackName = trackNames[trackNum] || `Track_${String(trackNum).padStart(2, '0')}`;
                if (!trackName.toLowerCase().endsWith('.wav')) {
                    trackName += '.wav';
                }
                processingTrackNames.push(trackName);
                ffmpegArgs.push(path.join(outputDir, trackName));
            }
        }

        res.write(`event: processingState\ndata: Simultaneously processing: ${processingTrackNames.join(', ')}\n\n`);

        try {
            await runCommand(ffmpegPath, ffmpegArgs, null, (currentSeconds) => {
                if (totalDurationSeconds > 0) {
                    let percent = (currentSeconds / totalDurationSeconds) * 100;
                    if (percent > 100) percent = 100;
                    sendProgress(percent.toFixed(2));
                }
            }, activeProcessTracker);
            sendLog('\nProcessing complete!');
            sendProgress("100.00");
        } catch (err) {
            sendError(`Error during ffmpeg processing: ${err.message}`);
        } finally {
            if (fs.existsSync(concatFilePath)) {
                fs.unlinkSync(concatFilePath);
            }
        }
    } catch (e) {
        sendError(`Unexpected error: ${e.message}`);
    }

    finish();
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});