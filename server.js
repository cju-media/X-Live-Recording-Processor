const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

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

function runCommand(command, args, sendLog) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args);
        let output = '';

        proc.stdout.on('data', data => {
            const str = data.toString();
            output += str;
            if (sendLog) sendLog(str.trim());
        });

        proc.stderr.on('data', data => {
            const str = data.toString();
            if (sendLog && command !== ffprobePath) { // ffprobe logs to stderr by default
                // sendLog(str.trim()); // ffmpeg logs a lot to stderr, omit to avoid swamping UI unless debugging
            }
        });

        proc.on('error', err => reject(err));
        proc.on('close', code => {
            if (code === 0) {
                resolve(output.trim());
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

        sendLog('\nStarting ffmpeg processing...');

        const ffmpegArgs = ['-f', 'concat', '-safe', '0', '-i', concatFilePath];

        let filterComplex = '';
        for (let i = 0; i < numChannels; i++) {
            filterComplex += `[0:a]pan=1c|c0=c${i}[ch${i+1}];`;
        }
        filterComplex = filterComplex.slice(0, -1);

        ffmpegArgs.push('-filter_complex', filterComplex);

        let audioCodec = 'pcm_s24le';
        if (bitDepth === 16) audioCodec = 'pcm_s16le';
        else if (bitDepth === 32) audioCodec = 'pcm_s32le';

        for (let i = 0; i < numChannels; i++) {
            ffmpegArgs.push('-map', `[ch${i+1}]`);
            ffmpegArgs.push('-c:a', audioCodec);
            ffmpegArgs.push(path.join(outputDir, `Track_${String(i+1).padStart(2, '0')}.wav`));
        }

        try {
            await runCommand(ffmpegPath, ffmpegArgs, null); // Don't pipe stdout here to avoid swamping UI, ffmpeg logs to stderr anyway
            sendLog('\nProcessing complete!');
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