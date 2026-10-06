#!/bin/bash
# macOS launcher: double-click in Finder to start Local Downloader.
cd "$(dirname "$0")" || exit 1

# Apps started from Finder don't load your shell profile, so add the usual
# Homebrew locations where node, yt-dlp and ffmpeg live.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause_and_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it (see README.md) and try again."
  pause_and_exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install --no-fund --no-audit || pause_and_exit 1
fi

node server.js --open || pause_and_exit 1
