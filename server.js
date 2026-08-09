const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStaticPath = require('ffprobe-static').path;
const multer = require('multer');
const open = require('open');

// True when running inside a pkg-built standalone executable (pkg sets this itself).
// Packaging changes two things: __dirname points into a read-only embedded snapshot instead of
// a real directory (so writable/bundled files need a different home), and ffmpeg/ffprobe need to
// come from real files on disk rather than the ffmpeg-static/ffprobe-static npm packages.
const IS_PACKAGED = !!process.pkg;

// Directory containing bundled app resources (ffmpeg, ffprobe) - these ship as part of the app
// itself, not user data. This is the folder the packaged executable lives in; in dev it's just
// the project directory.
const EXECUTABLE_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;

// Directory for user data that must survive the app being replaced/updated (config.json,
// track_titles.csv, processing.log, uploads). Deliberately NOT the same as EXECUTABLE_DIR when
// packaged: a macOS .app is conventionally treated as disposable/replaceable (dragging a new
// build over the old one, or even just deleting and reinstalling), and anything written inside
// the bundle itself would be lost when that happens. ~/Library/Application Support is the
// standard macOS location for exactly this kind of per-app persistent data. In dev it's just the
// project directory, same as before.
const WRITABLE_DIR = IS_PACKAGED
    ? path.join(os.homedir(), 'Library', 'Application Support', 'X-Live Processor')
    : __dirname;
if (IS_PACKAGED) {
    fs.mkdirSync(WRITABLE_DIR, { recursive: true });
}

// When packaged, ffmpeg-static/ffprobe-static's own binaries live inside pkg's read-only
// snapshot filesystem and can't be spawned directly (child_process.spawn needs a real path on
// disk) - use the copies build_mac.sh places next to the executable instead.
const ffmpegPath = IS_PACKAGED ? path.join(EXECUTABLE_DIR, 'resources', 'ffmpeg') : ffmpegStaticPath;
const ffprobePath = IS_PACKAGED ? path.join(EXECUTABLE_DIR, 'resources', 'ffprobe') : ffprobeStaticPath;

const app = express();
const PORT = 1797;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const UPLOADS_DIR = path.join(WRITABLE_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const upload = multer({ dest: UPLOADS_DIR });

const CONFIG_FILE = path.join(WRITABLE_DIR, 'config.json');
const CSV_FILE = path.join(WRITABLE_DIR, 'track_titles.csv');
const DEBUG_LOG_FILE = path.join(WRITABLE_DIR, 'processing.log');

let activeProcessTracker = { proc: null };

// Persistent, timestamped debug logger. Writes to console AND to a log file
// on disk so a run can be diagnosed even if the browser/SSE connection never
// receives anything (e.g. the event loop is blocked by a slow network fs
// call, or the client disconnects). Check processing.log on the machine
// running the server if the UI appears to hang with no visible logs.
function debugLog(msg) {
    const stamped = `[${new Date().toISOString()}] ${msg}`;
    console.log(stamped);
    try {
        fs.appendFileSync(DEBUG_LOG_FILE, stamped + '\n');
    } catch (e) {
        // Don't let logging failures break processing
        console.error('Failed to write to processing.log:', e.message);
    }
}

// Surface crashes instead of letting the process die silently mid-request,
// which from the browser's perspective looks identical to "hanging".
process.on('uncaughtException', (err) => {
    debugLog(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
    debugLog(`UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : reason}`);
});

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

// Lightweight liveness check the frontend polls to notice the app quitting (Cmd+Q, Dock Quit,
// or the packaged app's process exiting some other way) - see the heartbeat poll in
// public/index.html for why a plain poll is used instead of a persistent connection.
app.get('/api/ping', (req, res) => res.json({ ok: true }));

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

async function getWavFiles(dir, sendLog) {
    if (!dir) return [];

    const log = (msg) => {
        debugLog(msg);
        if (sendLog) sendLog(msg);
    };

    const existsT0 = Date.now();
    const exists = fs.existsSync(dir);
    const existsElapsed = Date.now() - existsT0;
    if (existsElapsed > 500) {
        log(`  (checking existence of "${dir}" took ${existsElapsed}ms — slow network path?)`);
    }
    if (!exists || !fs.statSync(dir).isDirectory()) {
        throw new Error(`Directory does not exist or is not a folder: ${dir}`);
    }

    let wavFiles = [];
    let dirsScanned = 0;

    function searchRecursive(currentDir) {
        dirsScanned++;
        log(`Scanning folder #${dirsScanned}: ${currentDir}`);

        let entries;
        const t0 = Date.now();
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (err) {
            log(`  WARNING: could not read "${currentDir}": ${err.message} — skipping.`);
            return;
        }
        const elapsed = Date.now() - t0;
        if (elapsed > 1000) {
            log(`  NOTE: listing "${currentDir}" (${entries.length} entries) took ${elapsed}ms — the network share may be slow or overloaded.`);
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                searchRecursive(fullPath);
            } else if (entry.isFile() && entry.name.toUpperCase().endsWith('.WAV')) {
                wavFiles.push(fullPath);
                if (wavFiles.length % 25 === 0) {
                    log(`  ...${wavFiles.length} .WAV file(s) found so far`);
                }
            }
        }
    }

    searchRecursive(dir);
    log(`Finished scanning ${dirsScanned} folder(s) under "${dir}" — found ${wavFiles.length} .WAV file(s).`);
    return wavFiles.sort();
}

function runCommand(command, args, sendLog, onProgress, processTracker, label) {
    return new Promise((resolve, reject) => {
        const tag = label || path.basename(command);
        const t0 = Date.now();
        debugLog(`SPAWN [${tag}]: ${command} ${args.join(' ')}`);

        let proc;
        try {
            // stdin is explicitly closed ('ignore') so that if ffmpeg ever ends up
            // asking an interactive question on stderr (e.g. the classic
            // "File already exists. Overwrite? [y/N]" prompt when -y is missing
            // and an output file already exists from a prior run), it hits EOF
            // immediately instead of blocking forever on a stdin pipe nobody
            // writes to. This alone turns a silent infinite hang into a fast,
            // visible failure. -y/-nostdin below are the primary fix; this is a
            // belt-and-suspenders backstop.
            proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            debugLog(`SPAWN FAILED [${tag}]: ${err.message}`);
            reject(err);
            return;
        }

        if (processTracker) {
             processTracker.proc = proc;
        }
        let output = '';
        let stderrTail = '';

        // If a spawned process never emits stdout/stderr/close, this makes the
        // stall visible instead of silently sitting at 0% forever.
        const stallWarnInterval = setInterval(() => {
            debugLog(`STILL WAITING on [${tag}] after ${((Date.now() - t0) / 1000).toFixed(1)}s (pid ${proc.pid})...`);
        }, 15000);

        proc.stdout.on('data', data => {
            const str = data.toString();
            output += str;
            if (sendLog) sendLog(str.trim());
        });

        proc.stderr.on('data', data => {
            const str = data.toString();
            stderrTail = (stderrTail + str).slice(-4000); // keep last ~4KB for error diagnostics

            // Try parsing ffmpeg time= (and speed=) progress
            let isStatsLine = false;
            if (onProgress && command === ffmpegPath) {
                const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (timeMatch) {
                    isStatsLine = true;
                    const hours = parseInt(timeMatch[1], 10);
                    const minutes = parseInt(timeMatch[2], 10);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentSeconds = (hours * 3600) + (minutes * 60) + seconds;
                    // ffmpeg's own encode-speed multiplier, e.g. "speed=5.8x".
                    // Absent/"N/A" during the first stats line or two.
                    const speedMatch = str.match(/speed=\s*([\d.]+)x/);
                    const ffmpegSpeed = speedMatch ? parseFloat(speedMatch[1]) : null;
                    onProgress(currentSeconds, ffmpegSpeed);
                }
            }

            // Always capture ffmpeg's raw stderr to the debug log (never to the
            // browser SSE stream, which would get swamped). Routine per-second
            // stats lines are throttled to avoid flooding the file; anything
            // else — warnings, errors, and critically an interactive prompt
            // like "Overwrite? [y/N]" — is logged immediately in full so a
            // stall is never silent again.
            if (command === ffmpegPath) {
                const now = Date.now();
                if (!isStatsLine || !proc._lastStatsLogAt || now - proc._lastStatsLogAt > 5000) {
                    debugLog(`[ffmpeg stderr] ${str.trim()}`);
                    if (isStatsLine) proc._lastStatsLogAt = now;
                }
            }
        });

        proc.on('error', err => {
            clearInterval(stallWarnInterval);
            debugLog(`SPAWN ERROR [${tag}] after ${Date.now() - t0}ms: ${err.message}`);
            reject(err);
        });
        proc.on('close', code => {
            clearInterval(stallWarnInterval);
            const elapsed = Date.now() - t0;
            if (processTracker) {
                 processTracker.proc = null;
            }
            if (code === 0) {
                debugLog(`DONE [${tag}] in ${elapsed}ms`);
                resolve(output.trim());
            } else if (code === null) {
                debugLog(`CANCELLED [${tag}] after ${elapsed}ms`);
                reject(new Error('Process was cancelled'));
            } else {
                debugLog(`FAILED [${tag}] after ${elapsed}ms, exit code ${code}. stderr tail: ${stderrTail.trim()}`);
                reject(new Error(`${command} exited with code ${code}${stderrTail.trim() ? ` — ${stderrTail.trim().split('\n').pop()}` : ''}`));
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
            if (line.trim()) debugLog(`[SSE] ${line}`);
        }
    };

    // etaSeconds/speed are optional — only present while ffmpeg is actively
    // encoding and a rate estimate is available.
    const sendProgress = (percent, etaSeconds, speed) => {
        const payload = { percent: parseFloat(percent) };
        if (etaSeconds != null && isFinite(etaSeconds)) payload.etaSeconds = Math.round(etaSeconds);
        if (speed != null && isFinite(speed) && speed > 0) payload.speed = Math.round(speed * 100) / 100;
        res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
        debugLog(`[SSE] progress: ${JSON.stringify(payload)}`);
    }

    const sendError = (msg) => {
        res.write(`event: errorMsg\ndata: ${msg}\n\n`);
        debugLog(`[SSE] ERROR: ${msg}`);
    };

    // Periodic heartbeat so the browser/proxy sees the connection is alive
    // even during long gaps between steps, and so processing.log gets a
    // steady drip of "still running" markers to bound how stale a stall is.
    const heartbeat = setInterval(() => {
        res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 10000);

    const finish = () => {
        clearInterval(heartbeat);
        res.write(`event: done\ndata: ok\n\n`);
        res.end();
    };

    try {
        const card1Dir = cleanPath(req.query.card1);
        const card2Dir = cleanPath(req.query.card2);
        const outputDir = cleanPath(req.query.output);

        debugLog(`/process request received. card1="${card1Dir}" card2="${card2Dir}" output="${outputDir}"`);

        if (!card1Dir || !outputDir) {
            sendError('First Card directory and Output directory are required.');
            return finish();
        }

        sendLog(`Scanning "${card1Dir}"...`);
        let files1 = [];
        let files2 = [];

        try {
            const t0 = Date.now();
            files1 = await getWavFiles(card1Dir, sendLog);
            sendLog(`Scan of "${card1Dir}" took ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
        } catch (e) {
            sendError(e.message);
            return finish();
        }

        if (card2Dir) {
            sendLog(`Scanning "${card2Dir}"...`);
            try {
                const t0 = Date.now();
                files2 = await getWavFiles(card2Dir, sendLog);
                sendLog(`Scan of "${card2Dir}" took ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
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
        for (let i = 0; i < allWavFiles.length; i++) {
            const file = allWavFiles[i];
            const fileT0 = Date.now();
            sendLog(`  Probing duration [${i + 1}/${allWavFiles.length}]: ${path.basename(file)}`);
            try {
                const durStr = await runCommand(ffprobePath, [
                    '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    file
                ], null, null, null, `ffprobe-duration ${path.basename(file)}`);
                const dur = parseFloat(durStr);
                const fileElapsed = Date.now() - fileT0;
                if (!isNaN(dur)) totalDurationSeconds += dur;
                if (fileElapsed > 2000) {
                    sendLog(`    -> ${dur.toFixed(2)}s (took ${(fileElapsed / 1000).toFixed(1)}s — slower than expected, check the network path)`);
                }
            } catch(err) {
                 sendLog(`  Warning: Could not get duration for ${path.basename(file)} (after ${Date.now() - fileT0}ms): ${err.message}`);
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
            ], null, null, null, 'ffprobe-channels');
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
            ], null, null, null, 'ffprobe-bitdepth');

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

        try {
            if (!fs.existsSync(outputDir)) {
                sendLog(`Creating output directory: ${outputDir}`);
                fs.mkdirSync(outputDir, { recursive: true });
            }
        } catch (err) {
            sendError(`Failed to create/access output directory "${outputDir}": ${err.message}`);
            return finish();
        }

        const concatFilePath = path.join(outputDir, 'concat_list.txt');
        const concatContent = allWavFiles.map(f => {
            let absPath = path.resolve(f).replace(/\\/g, '/');
            return `file '${absPath.replace(/'/g, "'\\''")}'`;
        }).join('\n');
        try {
            const t0 = Date.now();
            fs.writeFileSync(concatFilePath, concatContent);
            const elapsed = Date.now() - t0;
            sendLog(`Wrote concat list to "${concatFilePath}" (${elapsed}ms).`);
        } catch (err) {
            sendError(`Failed to write concat list to "${concatFilePath}": ${err.message}`);
            return finish();
        }

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

        // -y: auto-overwrite existing output files without prompting.
        // -nostdin: disable ffmpeg's interactive stdin console entirely.
        // Without these, if an output .wav from a prior run already exists,
        // ffmpeg prints "File already exists. Overwrite? [y/N]" to stderr and
        // blocks reading an answer from stdin — which we never write to. That
        // is a silent, permanent hang: the process stays alive (so it looks
        // like it's "still running") but never produces another byte of
        // output. This was the root cause of hangs after a retried run left
        // partial output files in the destination folder.
        const ffmpegArgs = ['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', concatFilePath];

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
        debugLog(`ffmpeg command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

        // If ffmpeg is stuck (e.g. hung reading from an unresponsive network
        // mount) it stays silent on stderr and no time= progress ever comes
        // through, which otherwise looks identical to "not started". Warn
        // explicitly if no progress line has arrived in a while.
        let lastProgressAt = Date.now();
        const noProgressWarnInterval = setInterval(() => {
            const idleSec = (Date.now() - lastProgressAt) / 1000;
            if (idleSec > 20) {
                sendLog(`  ...no ffmpeg progress in ${idleSec.toFixed(0)}s (still running, pid tracked). If this continues, ffmpeg may be stuck reading a source file over the network.`);
            }
        }, 15000);

        try {
            const ffmpegT0 = Date.now();
            sendLog(`Running ffmpeg (this can take a while for large/slow-network files)...`);
            await runCommand(ffmpegPath, ffmpegArgs, null, (currentSeconds, ffmpegSpeed) => {
                lastProgressAt = Date.now();
                if (totalDurationSeconds > 0) {
                    let percent = (currentSeconds / totalDurationSeconds) * 100;
                    if (percent > 100) percent = 100;

                    // Prefer ffmpeg's own reported speed (matches what shows up
                    // in processing.log); fall back to our own measured average
                    // (content seconds processed / wall-clock seconds elapsed)
                    // for the first stats line or two, before ffmpeg reports one.
                    const elapsedWallSec = (Date.now() - ffmpegT0) / 1000;
                    let effectiveSpeed = ffmpegSpeed;
                    if (!effectiveSpeed || effectiveSpeed <= 0) {
                        effectiveSpeed = elapsedWallSec > 0 ? currentSeconds / elapsedWallSec : null;
                    }
                    const remainingContentSec = Math.max(totalDurationSeconds - currentSeconds, 0);
                    const etaSeconds = (effectiveSpeed && effectiveSpeed > 0)
                        ? remainingContentSec / effectiveSpeed
                        : null;

                    sendProgress(percent.toFixed(2), etaSeconds, effectiveSpeed);
                }
            }, activeProcessTracker, 'ffmpeg-encode');
            sendLog(`\nProcessing complete! (ffmpeg took ${((Date.now() - ffmpegT0) / 1000).toFixed(1)}s)`);
            sendProgress("100.00");
        } catch (err) {
            sendError(`Error during ffmpeg processing: ${err.message}`);
        } finally {
            clearInterval(noProgressWarnInterval);
            if (fs.existsSync(concatFilePath)) {
                fs.unlinkSync(concatFilePath);
            }
        }
    } catch (e) {
        debugLog(`UNEXPECTED ERROR in /process: ${e.stack || e.message}`);
        sendError(`Unexpected error: ${e.message}`);
    }

    finish();
});

// Stops any in-flight ffmpeg run and exits. Shared by the OS-signal handlers below so that
// quitting the app (Dock icon, Cmd+Q, the native wrapper forwarding SIGTERM, Ctrl+C in dev)
// doesn't leave an orphaned ffmpeg process behind, still writing to files in the output folder.
function gracefulShutdown(reason) {
    debugLog(`Shutting down (${reason}).`);
    if (activeProcessTracker.proc) {
        try {
            activeProcessTracker.proc.kill('SIGKILL');
        } catch (e) {
            // already gone
        }
    }
    process.exit(0);
}

// Dock icon Quit / Cmd+Q reach here as SIGTERM via the native launcher wrapper (this app has no
// window and isn't itself a Cocoa/AppKit app). SIGINT covers Ctrl+C when running "node server.js"
// directly in a terminal during dev. Without these, either would bypass gracefulShutdown()
// entirely and go straight to Node's default behavior (an immediate exit with no cleanup).
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

app.listen(PORT, () => {
    debugLog(`Server running at http://localhost:${PORT}`);
    if (IS_PACKAGED) {
        // End users running the packaged app don't know (or need to know) about localhost ports
        // - open the GUI for them automatically. Left out in dev mode so it doesn't pop a
        // browser tab on every "node server.js" restart during development.
        open(`http://localhost:${PORT}`).catch(err => {
            debugLog(`Failed to auto-open browser: ${err.message}`);
        });
    }
});