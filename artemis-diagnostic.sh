#!/data/data/com.termux/files/usr/bin/bash

export LC_ALL=C
clear

echo "================================================"
echo "       ARTEMIS R69 - DIAGNOSTIC CENTER"
echo "================================================"
echo "MODE: READ ONLY"
echo "DEVICE: R69-EMCP V2.0"
echo "PLATFORM: ANDROID / TERMUX"
echo "================================================"

section() {
    echo
    echo "------------------------------------------------"
    echo " $1"
    echo "------------------------------------------------"
}

section "1. SYSTEM INFORMATION"

date
uname -a
node --version 2>/dev/null || true

section "2. USB DEVICE DETECTION"

USB_LIST="$(termux-usb -l 2>&1)"
echo "$USB_LIST"

USB_DEVICE="$(printf '%s\n' "$USB_LIST" |
    grep -oE '/dev/bus/usb/[0-9]+/[0-9]+' | head -1)"

if [ -n "$USB_DEVICE" ]; then
    echo
    echo "[USB] DETECTED: $USB_DEVICE"
else
    echo "[USB] NO DEVICE DETECTED"
fi

section "3. USB DESCRIPTOR PROBE"

if [ -n "$USB_DEVICE" ] && [ -x "./usb_probe" ]; then
    echo "Requesting read-only USB descriptor inspection..."
    termux-usb -r -e "$PWD/usb_probe" "$USB_DEVICE" 2>&1
else
    echo "Probe unavailable. No USB operation performed."
fi

section "4. BOOT FILE ANALYSIS"

FILES=(
"$HOME/R69_ANALYSIS/boot0_nand.fex"
"$HOME/R69_ANALYSIS/boot0_sdcard.fex"
"$HOME/R69_ANALYSIS/boot_package.fex"
"$HOME/R69_ANALYSIS/boot.fex"
"/storage/emulated/0/Download/R69_EMCP_V2_SD_Unbrick_Boot.img"
"/storage/emulated/0/Download/R69_SD_Bootable_Unbrick_1MB.img"
"/storage/emulated/0/Download/R69_SD_Unbrick_Bootable.img"
)

for f in "${FILES[@]}"; do
    echo
    echo "FILE: $(basename "$f")"

    if [ -f "$f" ]; then
        stat -c 'SIZE: %s bytes' "$f"
        sha256sum "$f"
        file "$f"

        echo "SIGNATURES:"
        grep -aobE 'eGON\.BT0|eGON\.BT1|TOC1' "$f" |
            head -10 || true
    else
        echo "FILE NOT FOUND"
    fi
done

section "5. ARTEMIS SOFTWARE TESTS"

npm test

section "6. FINAL STATUS"

echo "Diagnostic completed."
echo "No firmware files modified."
echo "No boot code executed."
echo "No device memory written."

echo "================================================"
echo "           ARTEMIS R69 - FINISHED"
echo "================================================"
