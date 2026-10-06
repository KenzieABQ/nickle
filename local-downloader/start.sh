#!/bin/bash
# Linux launcher: run ./start.sh (or double-click it if your file manager allows).
# It updates the app from GitHub, installs dependencies if needed, starts the
# server and opens your browser.
cd "$(dirname "$0")" || exit 1

pause_and_exit() {
  echo
  read -n 1 -s -r -p "Press any key to close this window."
  exit "$1"
}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it (see README.md) and try again."
  pause_and_exit 1
fi

node launch.js || pause_and_exit 1
