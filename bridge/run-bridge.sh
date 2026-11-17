#!/data/data/com.termux/files/usr/bin/bash
# Start the ARTEMIS Termux bridge server (v2, SRAM-only).
# Binds 127.0.0.1:3001 only. Run ARTEMIS itself separately:
#   npm start    # http://127.0.0.1:3000, in a second Termux session
# FEL_WRITE / FEL_EXEC here are SRAM-only; there is no eMMC/flash
# endpoint. See bridge/README.md before any SPL upload.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -x bridge/fel_version ] || [ ! -x usb_probe ]; then
  echo "Native tools are missing. Run first:"
  echo "  bash bridge/termux-setup.sh"
  exit 1
fi
for tool in fel_read fel_write fel_exec; do
  if [ ! -x "bridge/$tool" ]; then
    echo "WARNING: bridge/$tool is missing (v2 tool). Run:"
    echo "  bash bridge/termux-setup.sh"
    echo "The bridge will still start, but /api/bridge/fel-read,"
    echo "fel-write and fel-exec will return 501 until it is built."
  fi
done

echo "ARTEMIS Termux bridge (v2, SRAM-only FEL read/write/exec)"
echo "  Bridge:  http://127.0.0.1:3001/api/bridge/status"
echo "  ARTEMIS: http://127.0.0.1:3000  (run 'npm start' in another session)"
echo "  No eMMC/flash write. FEL_EXEC needs a prior FEL_WRITE in this session."
echo "  Press Ctrl+C to stop."
exec node bridge/server.js
