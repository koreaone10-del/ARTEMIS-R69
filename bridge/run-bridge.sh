#!/data/data/com.termux/files/usr/bin/bash
# Start the ARTEMIS Termux bridge server (read-only v1).
# Binds 127.0.0.1:3001 only. Run ARTEMIS itself separately:
#   npm start    # http://127.0.0.1:3000, in a second Termux session
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x bridge/fel_version ] || [ ! -x usb_probe ]; then
  echo "Native tools are missing. Run first:"
  echo "  bash bridge/termux-setup.sh"
  exit 1
fi

echo "ARTEMIS Termux bridge (read-only v1)"
echo "  Bridge:  http://127.0.0.1:3001/api/bridge/status"
echo "  ARTEMIS: http://127.0.0.1:3000  (run 'npm start' in another session)"
echo "  Press Ctrl+C to stop."
exec node bridge/server.js
