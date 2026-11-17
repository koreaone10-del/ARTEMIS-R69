#!/data/data/com.termux/files/usr/bin/bash
# ARTEMIS Termux bridge -- setup (v3, SRAM-only FEL read/write/exec
# + upstream-style SPL + U-Boot staging)
#
# Installs the Termux packages the bridge needs, builds the native
# tools (usb_probe, fel_version, fel_read, fel_write, fel_exec,
# fel_spl_uboot) from this repo, and creates bridge/run/ and
# bridge/reports/ for probe reports and the bridge session file.
#
# Idempotent: safe to run again. It never writes to the TV Box.
# It does NOT install sunxi-fel by default: stock sunxi-fel cannot
# use a termux-usb file-descriptor handoff (it opens the device by
# VID/PID with libusb discovery), so it is not a substitute for the
# bridge tools. See bridge/docs/SOURCES.md.
#
# Node fix (v1 lesson): v1 ran `pkg install nodejs-lts` every time,
# which on the user's phone replaced a working nodejs 26 with
# nodejs-lts 24 and broke Node (libicui18n.so.79 not found). This
# script now checks `node -v` FIRST: if Node already works, it is
# left alone. nodejs-lts is installed only when Node is missing or
# broken. If Node is still broken afterwards, see bridge/README.md
# ("Node broken" section) instead of re-running this script blindly.
#
# Prerequisites that this script CANNOT install for you:
#   - Termux app and Termux:API app, both from F-Droid
#     (the Play Store builds are outdated).
#   - USB permission for the R69, granted on the phone screen when
#     termux-usb asks for it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== ARTEMIS Termux bridge setup (v3, SRAM-only + SPL/U-Boot) =="
echo "Repo: $ROOT"

if [ -z "${PREFIX:-}" ]; then
  echo "WARNING: \$PREFIX is not set; this does not look like Termux."
  echo "Continuing anyway, but 'pkg' will probably fail."
fi

pkg update -y
# termux-api provides the `termux-usb` command. clang + libusb build
# the native tools. git is only needed for the optional sunxi-fel
# build below. Node is handled separately (see below).
pkg install -y termux-api libusb clang git

echo "-- Checking node (v1 lesson: do not force-reinstall it) --"
if node -v >/dev/null 2>&1; then
  echo "Node already works: $(node -v). Leaving it alone."
else
  echo "Node is missing or broken; installing nodejs-lts..."
  pkg install -y nodejs-lts || {
    echo "nodejs-lts install failed; trying nodejs instead..."
    pkg install -y nodejs
  }
  node -v
fi

CC="${CC:-cc}"
echo "Compiler: $CC"

echo "-- Building usb_probe (read-only USB descriptors) --"
"$CC" -O2 -Wall -Wextra -o usb_probe usb_probe.c -lusb-1.0

echo "-- Building bridge/fel_version (read-only FEL_VERSION) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_version \
  bridge/fel_version.c bridge/fel_common.c -lusb-1.0

echo "-- Building bridge/fel_read (FEL_READ, SRAM + SID only) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_read \
  bridge/fel_read.c bridge/fel_common.c -lusb-1.0

echo "-- Building bridge/fel_write (FEL_WRITE, SRAM only) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_write \
  bridge/fel_write.c bridge/fel_common.c -lusb-1.0

echo "-- Building bridge/fel_exec (FEL_EXEC, SRAM only) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_exec \
  bridge/fel_exec.c bridge/fel_common.c -lusb-1.0

echo "-- Building bridge/fel_spl_uboot (v3: upstream SPL swap/thunk + U-Boot staging) --"
"$CC" -O2 -Wall -Wextra -o bridge/fel_spl_uboot \
  bridge/fel_spl_uboot.c bridge/fel_common.c -lusb-1.0

mkdir -p bridge/run bridge/reports

echo "-- Checking node --"
node --check bridge/server.js
node --check backend/server.js || echo "WARNING: backend/server.js check failed (ARTEMIS web app); bridge server check passed."

echo "-- Quick self-test (no device needed) --"
./bridge/fel_version || echo "(expected: usage error, exit 2 -- the binary runs)"
./bridge/fel_read || echo "(expected: usage error, exit 2)"
TERMUX_USB_FD=99 ./bridge/fel_read 0x40000000 16 || echo "(expected: DRAM refused, exit 2)"
./bridge/fel_exec || echo "(expected: usage error, exit 2)"
./bridge/fel_spl_uboot || echo "(expected: usage error, exit 2)"
./bridge/fel_spl_uboot 99 /dev/null || echo "(expected: file validation error, exit 1)"

echo "-- sunxi-fel (optional, NOT required for v3) --"
if command -v sunxi-fel >/dev/null 2>&1; then
  echo "sunxi-fel: AVAILABLE at $(command -v sunxi-fel)"
  sunxi-fel version 2>&1 | head -2 || true
  echo "Note: stock sunxi-fel still cannot use a termux-usb fd handoff."
  echo "Use the bridge tools for the Termux bridge, not sunxi-fel."
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
  echo "sunxi-fel: NOT AVAILABLE (and not required for v3)."
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
echo "  6. Test in order (see bridge/README.md): FEL_READ at 0x1000,"
echo "     then the 16-byte pattern write + read-back, then -- only"
echo "     with explicit approval -- the SPL + U-Boot upload (v3 panel)."
echo "     Do NOT use the old v2 raw SPL write: it killed FEL on"
echo "     2026-11-17. Use the v3 SPL + U-Boot panel instead."
