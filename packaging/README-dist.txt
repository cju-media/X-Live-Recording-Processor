X-Live Processor - macOS App
=============================

No installation needed - Node.js and ffmpeg are both bundled inside the app.

TO RUN:
  Double-click "X-Live Processor.app". It appears in the Dock like a normal app, but has no
  window of its own - after a moment your browser opens automatically to the app instead.

IF YOU CLOSE THE BROWSER TAB/WINDOW:
  The app keeps running in the Dock - closing the browser window doesn't quit it. Click its
  Dock icon again (or double-click "X-Live Processor.app" again) to reopen the browser tab
  without restarting the app itself.

TO SEE LOGS / TROUBLESHOOT:
  A full log of every run (including ffmpeg's own output) is written to processing.log inside
  ~/Library/Application Support/X-Live Processor/ - open that file if the app appears to hang
  or a run fails with no clear reason in the browser.

TO STOP THE APP:
  Quit it the way you'd quit any Mac app - right-click its Dock icon and choose Quit, or Cmd+Q
  while it's frontmost. This also cancels any run that's still in progress.

FIRST LAUNCH ("unidentified developer" warning):
  Since this app isn't signed with an Apple Developer certificate, macOS Gatekeeper will
  likely refuse to open it the first time, with a message like "cannot be opened because
  the developer cannot be verified" or "is damaged and can't be opened."
  To allow it:
    1. Right-click (or Control-click) "X-Live Processor.app" and choose "Open".
    2. Click "Open" again in the dialog that appears.
  You only need to do this once. If that still doesn't work, open Terminal, cd into this
  folder, and run:  xattr -cr "X-Live Processor.app"
  then try again.

YOUR SETTINGS ARE SAVED SEPARATELY FROM THE APP:
  The card/output folder paths and track title CSV are stored in
  ~/Library/Application Support/X-Live Processor/, not inside the app itself - so replacing
  "X-Live Processor.app" with a newer build won't lose them.

WHAT'S BUNDLED (inside the app - right-click > Show Package Contents to look):
  - Contents/MacOS/xlive-processor      the app server (Node.js runtime + app code)
  - Contents/MacOS/resources/ffmpeg     a self-contained ffmpeg build for audio processing
  - Contents/MacOS/resources/ffprobe    a self-contained ffprobe build for audio analysis

COMPATIBILITY:
  This build targets the Mac architecture it was built on (Apple Silicon or Intel). It will
  not run on a Mac with the other architecture - that needs a separate build made on a
  machine of that architecture (see the project's packaging/build_mac.sh script).
