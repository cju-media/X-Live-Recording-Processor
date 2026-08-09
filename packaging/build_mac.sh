#!/bin/bash
# Builds a fully self-contained macOS distribution of X-Live Processor: bundles the Node server
# and a copy of ffmpeg/ffprobe into one .app that needs nothing installed on the end user's
# machine - no Node, npm, or Homebrew required to RUN it (only to BUILD it, here, once).
#
# Requires on the BUILD machine only: Node.js + npm (ffmpeg/ffprobe come from this project's own
# ffmpeg-static/ffprobe-static npm dependencies, already statically linked against nothing but
# OS-provided frameworks - no Homebrew ffmpeg or dylibbundler needed, unlike some other projects).
#
# This targets whatever CPU architecture the build machine itself is running (arm64 on Apple
# Silicon, x86_64 on Intel) - ffmpeg-static/ffprobe-static's postinstall step downloads a binary
# for the host architecture, and pkg is told to match it. To support both, run this script once
# on an Apple Silicon Mac and once on an Intel Mac.
set -e

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
PACKAGING_DIR="$PROJECT_ROOT/packaging"
OUT_DIR="$PACKAGING_DIR/dist-mac"
ARCH="$(uname -m)"
PKG_ARCH="arm64"
if [ "$ARCH" != "arm64" ]; then
    PKG_ARCH="x64"
fi

echo "== X-Live Processor macOS build ($ARCH) =="
echo ""

# --- 1. Node dependencies (also downloads the ffmpeg-static/ffprobe-static binaries below) ---
echo "-- [1/5] Installing dependencies (npm install) --"
(cd "$PROJECT_ROOT" && npm install)
echo ""

# --- 2. Node server: standalone executable via pkg ---
echo "-- [2/5] Building server executable (pkg, node24-macos-$PKG_ARCH) --"
mkdir -p "$PACKAGING_DIR/dist-node"
rm -f "$PACKAGING_DIR/dist-node/xlive-processor"
npx --yes @yao-pkg/pkg "$PROJECT_ROOT" --targets "node24-macos-$PKG_ARCH" --output "$PACKAGING_DIR/dist-node/xlive-processor"
echo ""

# --- 3. ffmpeg/ffprobe: copy this project's own (statically-linked) binaries ---
# ffmpeg-static/ffprobe-static ship binaries whose only link-time dependencies are OS-provided
# frameworks (Foundation, AVFoundation, etc.) and system libs - verified with `otool -L` - so,
# unlike a Homebrew ffmpeg, they need no dylibbundler pass to run standalone on another Mac.
echo "-- [3/5] Bundling ffmpeg/ffprobe --"
FFMPEG_SRC="$(node -e "console.log(require('$PROJECT_ROOT/node_modules/ffmpeg-static'))")"
FFPROBE_SRC="$(node -e "console.log(require('$PROJECT_ROOT/node_modules/ffprobe-static').path)")"
if [ ! -f "$FFMPEG_SRC" ] || [ ! -f "$FFPROBE_SRC" ]; then
    echo "ERROR: could not resolve ffmpeg-static/ffprobe-static binaries. Run 'npm install' first." >&2
    exit 1
fi
rm -rf "$PACKAGING_DIR/dist-ffmpeg"
mkdir -p "$PACKAGING_DIR/dist-ffmpeg"
cp "$FFMPEG_SRC" "$PACKAGING_DIR/dist-ffmpeg/ffmpeg"
cp "$FFPROBE_SRC" "$PACKAGING_DIR/dist-ffmpeg/ffprobe"
chmod +x "$PACKAGING_DIR/dist-ffmpeg/ffmpeg" "$PACKAGING_DIR/dist-ffmpeg/ffprobe"
# Apple Silicon refuses to run any unsigned Mach-O binary at all, even locally. ffmpeg-static's
# binary already ships ad-hoc signed; ffprobe-static's doesn't - ad-hoc sign both here so neither
# depends on upstream packaging happening to already do it.
codesign --force -s - "$PACKAGING_DIR/dist-ffmpeg/ffmpeg" "$PACKAGING_DIR/dist-ffmpeg/ffprobe"
echo ""

# --- 4. App icon: build a real .icns from packaging/AppIcon.png ---
echo "-- [4/5] Building app icon --"
if [ -f "$PACKAGING_DIR/AppIcon.png" ]; then
    rm -rf "$PACKAGING_DIR/AppIcon.iconset" "$PACKAGING_DIR/AppIcon.icns"
    mkdir -p "$PACKAGING_DIR/AppIcon.iconset"
    sips -z 16 16     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_16x16.png" >/dev/null
    sips -z 32 32     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_16x16@2x.png" >/dev/null
    sips -z 32 32     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_32x32.png" >/dev/null
    sips -z 64 64     "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_32x32@2x.png" >/dev/null
    sips -z 128 128   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_128x128.png" >/dev/null
    sips -z 256 256   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_128x128@2x.png" >/dev/null
    sips -z 256 256   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_256x256.png" >/dev/null
    sips -z 512 512   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_256x256@2x.png" >/dev/null
    cp "$PACKAGING_DIR/AppIcon.png" "$PACKAGING_DIR/AppIcon.iconset/icon_512x512@2x.png"
    sips -z 512 512   "$PACKAGING_DIR/AppIcon.png" --out "$PACKAGING_DIR/AppIcon.iconset/icon_512x512.png" >/dev/null
    iconutil -c icns "$PACKAGING_DIR/AppIcon.iconset" -o "$PACKAGING_DIR/AppIcon.icns"
else
    echo "No packaging/AppIcon.png found - skipping icon (app will use the generic executable icon)."
fi
echo ""

# --- 5. Native Dock launcher (Swift/AppKit) + assemble the final .app bundle ---
# xlive-processor (built above) is a bare pkg-built Node executable with no AppKit/Cocoa
# involvement, so it can't be CFBundleExecutable directly and still behave like a normal Mac app
# in the Dock - the Dock only stops bouncing an icon once the app signals "I'm a real GUI app and
# I'm ready" via AppKit, which a plain command-line binary never does. This tiny wrapper IS a
# real (windowless) AppKit app: it settles in the Dock normally, launches xlive-processor as a
# child process, and forwards Cmd+Q/Dock Quit to it as a clean SIGTERM (which server.js's own
# gracefulShutdown() handles) instead of leaving those with nothing to actually terminate.
echo "-- [5/5] Building native Dock launcher (swiftc) and assembling $OUT_DIR --"
mkdir -p "$PACKAGING_DIR/dist-wrapper"
swiftc -O "$PACKAGING_DIR/AppWrapper.swift" -o "$PACKAGING_DIR/dist-wrapper/xlive-processor-launcher"

APP_DIR="$OUT_DIR/X-Live Processor.app"
rm -rf "$OUT_DIR"
mkdir -p "$APP_DIR/Contents/MacOS/resources" "$APP_DIR/Contents/Resources"

cp "$PACKAGING_DIR/Info.plist" "$APP_DIR/Contents/Info.plist"

if [ -f "$PACKAGING_DIR/AppIcon.icns" ]; then
    cp "$PACKAGING_DIR/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"
fi

cp "$PACKAGING_DIR/dist-node/xlive-processor" "$APP_DIR/Contents/MacOS/xlive-processor"
chmod +x "$APP_DIR/Contents/MacOS/xlive-processor"

cp "$PACKAGING_DIR/dist-wrapper/xlive-processor-launcher" "$APP_DIR/Contents/MacOS/xlive-processor-launcher"
chmod +x "$APP_DIR/Contents/MacOS/xlive-processor-launcher"
# swiftc doesn't always ad-hoc sign its own output - do it explicitly, same reason as step 3 above.
codesign --force -s - "$APP_DIR/Contents/MacOS/xlive-processor-launcher"

cp "$PACKAGING_DIR/dist-ffmpeg/ffmpeg" "$APP_DIR/Contents/MacOS/resources/ffmpeg"
cp "$PACKAGING_DIR/dist-ffmpeg/ffprobe" "$APP_DIR/Contents/MacOS/resources/ffprobe"

cp "$PACKAGING_DIR/README-dist.txt" "$OUT_DIR/README.txt"

echo ""
echo "== Build complete =="
echo "Distributable app: $APP_DIR"
echo "Zip $OUT_DIR and hand it to any Mac with the same CPU architecture as this one ($ARCH)."
