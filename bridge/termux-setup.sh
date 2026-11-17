#!/data/data/com.termux/files/usr/bin/bash
# ARTEMIS Termux bridge -- setup (read-only v1)
#
# Installs the Termux packages the bridge needs, builds the two
# native tools (usb_probe, fel_version) from this repo, and creates
# bridge/run/ and bridge/reports/ for probe reports.
#
# Idempotent: safe to run again. It never writes to the TV Box.
# It does NOT install sunxi-fel by default: stock sunxi-fel cannot
# use a termux-usb file-descriptor handoff (it opens the device by
# VID/PID with libusb discovery), so it is not a substitute for
# fel_version.c. See bridge/docs/SOURCES.md.
#
# Prerequisites that this script CANNOT install for you:
#   - Termux app and Termux:API app, both from F-Droid
#     (the Play Store builds are outdated).
#   - USB permission for the R69, granted on the phone screen when
#     termux-usb asks for it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== ARTEMIS Termux bridge setup (read-only v1) =="
echo "Repo: $ROOT"

if [ -z "${PREFIX:-}" ]; then
  echo "WARNING: \$PREFIX is not set; this does not look like Termux."
  echo "Continuing anyway, but 'pkg' will probably fail."
fi

pkg update -y
# termux-api provides the `termux-usb` command. clang + libusb build
# usb_probe.c and bridge/fel_version.c. nodejs-lts runs the bridge
# server and the ARTEMIS web app. git is only needed for the
# optional sunxi-fel build below.
pkg install -y termux-api libusb clang nodejs-lts git

CC="${CC:-cc}"
echo "Compiler: $CC"

echo "-- Building usb_probe (read-only USB descriptors) --"
"$CC" -O2 -Wall -Wextra -o usb_probe usb_probe.c -lusb-1.0

echo "-- Building bridge/fel_version (read-only FEL_VERSION) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_version bridge/fel_version.c -lusb-1.0

mkdir -p bridge/run bridge/reports

echo "-- Checking node --"
node --check bridge/server.js
node --check backend/server.js || echo "WARNING: backend/server.js check failed (ARTEMIS web app); bridge server check passed."

echo "-- sunxi-fel (optional, NOT required for v1) --"
if command -v sunxi-fel >/dev/null 2>&1; then
  echo "sunxi-fel: AVAILABLE at $(command -v sunxi-fel)"
  sunxi-fel version 2>&1 | head -2 || true
  echo "Note: stock sunxi-fel still cannot use a termux-usb fd handoff."
  echo "Use bridge/fel_version for the Termux bridge, not sunxi-fel."
elif [ "${BRIDGE_BUILD_SUNXI:-0}" = "1" ]; then
  echo "BRIDGE_BUILD_SUNXI=1: attempting to build sunxi-tools from source."
  echo "This is best-effort; a failure here does not block the bridge."
  set +e
  if [ ! -d /tmp/sunxi-tools ]; then
    git clone --depth 1 https://github.com/linux-sunxi/sunxi-tools /tmp/sunxi-tools
  fi
  (cd /tmp/sunxi-tools && make sunxi-fel)
  if [ -x /tmp/sunxi-tools/sunxi-fel ]; then
    echo "sunxi-fel built at /tmp/sunxi-tools/sunxi-fel (optional tool only)."
  else
    echo "sunxi-fel: BUILD FAILED -- NOT AVAILABLE. The bridge does not need it."
  fi
  set -e
else
  echo "sunxi-fel: NOT AVAILABLE (and not required for v1)."
  echo "Stock sunxi-fel cannot use a termux-usb file-descriptor handoff,"
  echo "so building it would not add a working FEL path on the phone."
  echo "To try anyway: BRIDGE_BUILD_SUNXI=1 bash bridge/termux-setup.sh"
fi

echo ""
echo "Setup done. Next:"
echo "  1. Connect the R69 in FEL mode (reset in the AV port, then OTG)."
echo "  2. termux-usb -l        # find /dev/bus/usb/001/002"
echo "  3. bash bridge/run-bridge.sh"
echo "  4. In a second Termux session: npm start   # ARTEMIS on :3000"
echo "  5. Open http://127.0.0.1:3000 and go to 'جسر Termux'."
