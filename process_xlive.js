const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

function cleanPath(inputPath) {
    return inputPath.trim().replace(/^['"](.*)['"]$/, '$1').trim();
}

async function getWavFiles(dir) {
    if (!dir) return [];
    try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            console.warn(`Directory not found or invalid: ${dir}`);
            return [];
        }
        const files = fs.readdirSync(dir);
        return files
            .filter(f => f.toUpperCase().endsWith('.WAV'))
            .sort()
            .map(f => path.join(dir, f));
    } catch (err) {
        console.error(`Error reading directory ${dir}:`, err.message);
        return [];
    }
}

async function runFfprobe(file, args) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', args);
        let output = '';
        ffprobe.stdout.on('data', data => output += data.toString());
        ffprobe.on('error', err => reject(err));
        ffprobe.on('close', code => {
            if (code === 0) {
                resolve(output.trim());
            } else {
                reject(new Error(`ffprobe exited with code ${code}`));
            }
        });
    });
}

async function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
        ffmpeg.on('error', err => reject(err));
        ffmpeg.on('close', code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });
    });
}

async function main() {
    console.log("X-Live SD Card Recording Processor\n");
    console.log("Drag and drop the folder for the First Card (or paste path):");
    let card1Input = await question("> ");

    console.log("\nDrag and drop the folder for the Second Card (optional, press Enter to skip):");
    let card2Input = await question("> ");

    console.log("\nDrag and drop the Output directory:");
    let outputInput = await question("> ");

    rl.close();

    const card1Dir = cleanPath(card1Input);
    const card2Dir = cleanPath(card2Input);
    const outputDir = cleanPath(outputInput);

    if (!card1Dir) {
        console.error("First Card directory is required.");
        process.exit(1);
    }
    if (!outputDir) {
        console.error("Output directory is required.");
        process.exit(1);
    }

    console.log("\nScanning directories...");
    const files1 = await getWavFiles(card1Dir);
    const files2 = await getWavFiles(card2Dir);

    const allWavFiles = [...files1, ...files2];

    if (allWavFiles.length === 0) {
        console.error("No .WAV files found in the provided directories.");
        process.exit(1);
    }

    console.log(`Found ${allWavFiles.length} .WAV file(s) to process.`);

    const firstFile = allWavFiles[0];

    console.log(`\nAnalyzing ${firstFile} ...`);

    let numChannels;
    try {
        const channelsStr = await runFfprobe(firstFile, [
            '-v', 'error',
            '-show_entries', 'stream=channels',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            firstFile
        ]);
        numChannels = parseInt(channelsStr);
        if (isNaN(numChannels) || numChannels <= 0) throw new Error("Invalid channel count");
    } catch (err) {
        console.error("Failed to detect number of channels:", err.message);
        process.exit(1);
    }

    console.log(`Detected ${numChannels} channels.`);

    let bitDepth = 24;
    try {
        const bitDepthStr = await runFfprobe(firstFile, [
            '-v', 'error',
            '-show_entries', 'stream=bits_per_raw_sample,bits_per_sample',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            firstFile
        ]);

        // Output could be multiple lines if bits_per_raw_sample is N/A but bits_per_sample is present
        const lines = bitDepthStr.split('\n').map(l => l.trim()).filter(l => l && l !== 'N/A');
        if (lines.length > 0) {
             const detectedBits = parseInt(lines[0]);
             if (!isNaN(detectedBits) && detectedBits > 0) {
                 bitDepth = detectedBits;
             }
        }
    } catch (err) {
        console.warn("Could not determine bit depth, defaulting to 24-bit.");
    }

    console.log(`Detected bit depth: ${bitDepth} (using for output).`);

    if (!fs.existsSync(outputDir)) {
        console.log(`Creating output directory: ${outputDir}`);
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const concatFilePath = path.join(outputDir, 'concat_list.txt');
    const concatContent = allWavFiles.map(f => {
        let absPath = path.resolve(f);
        // On Windows, resolve generates backslashes, which breaks ffmpeg concat file parsing
        // Replace with forward slashes for compatibility
        absPath = absPath.replace(/\\/g, '/');
        return `file '${absPath.replace(/'/g, "'\\''")}'`;
    }).join('\n');
    fs.writeFileSync(concatFilePath, concatContent);

    console.log("\nStarting processing...");

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
        await runFfmpeg(ffmpegArgs);
        console.log("\nProcessing complete!");
    } catch (err) {
        console.error("\nError during ffmpeg processing:", err.message);
    } finally {
        if (fs.existsSync(concatFilePath)) {
            fs.unlinkSync(concatFilePath);
        }
    }
}

main().catch(err => {
    console.error("Unhandled error:", err);
    process.exit(1);
});
