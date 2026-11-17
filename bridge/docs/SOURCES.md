# Bridge sources — what was verified, and what was not

Date: 2026-11-17. No R69 device was available for this work, so
nothing here is a claim about a live device test. Anything marked
**UNVERIFIED** below must be tested on the phone before it is
presented as working.

## Verified from source

### 1. termux-usb (Termux:API)

- Usage: `termux-usb [-l | [-r] [-e command] device]`
- `-l` lists available devices (paths like `/dev/bus/usb/001/002`;
  it does **not** show VID/PID, so the R69 must be identified by
  trying the listed device, or by elimination when only one USB
  device is connected).
- `-r` shows the Android permission dialog if access has not
  already been granted. Permission must be granted again after a
  phone reboot.
- `-e command` executes the specified command **with a file
  descriptor referring to the device as its argument**. That is
  why `usb_probe.c` takes the fd as `argv[1]` and calls
  `libusb_wrap_sys_device()`.
- Source: Termux wiki / Termux:API docs, “Termux-usb” —
  https://github.com/termux-monet/termux-monet/blob/HEAD/docs/en/Termux-usb.md
  (a copy of the Termux wiki page), and the same usage in the
  Termux:API / pyusb documentation. The bridge server uses this
  `-e` argument form.

### 2. termux-usb `-E` variant — UNVERIFIED

- Some newer Termux:API versions / projects document
  `termux-usb -r -E -e "<command>" <device>`, where the fd is
  passed in the environment variable `$TERMUX_USB_FD` instead of
  as an argument.
- `fel_version.c` accepts **both**: `argv[1]` first, then
  `$TERMUX_USB_FD`. The bridge server itself only uses the `-e`
  argument form in v1. Whether `-E` exists on the user's Samsung /
  Termux version is **UNVERIFIED** — try it manually if `-e`
  fails, do not assume it.

### 3. Allwinner FEL protocol (sunxi-fel)

Verified against the sunxi-tools source, `fel.c` on master
(Icenowy/sunxi-tools, also the Debian dgit copy):

- https://raw.githubusercontent.com/Icenowy/sunxi-tools/master/fel.c
- https://browse.dgit.debian.org/sunxi-tools.git/tree/fel.c

Facts used by `bridge/fel_version.c`:

| Item | Value (from fel.c) |
|---|---|
| VID / PID | `0x1F3A` / `0xEFE8` |
| USB request signature | `"AWUC"` (8-byte field, zero-padded) |
| USB request | length LE32, unknown1 `0x0c000000`, request LE16, length2 = length, 10 pad bytes; total 32 bytes |
| AW_USB_READ / WRITE | `0x11` / `0x12` |
| USB reply | 13 bytes, must start `"AWUS"` |
| FEL request | 16 bytes: request LE32, address LE32, length LE32, pad LE32 |
| AW_FEL_VERSION | `0x001` (address 0, length 0) |
| AW_FEL_1_WRITE / EXEC / READ | `0x101` / `0x102` / `0x103` — **deliberately not defined or used in v1** |
| FEL version reply | 32-byte `aw_fel_version`: signature `"AWUSBFEX"`, soc_id raw LE32, unknown_0a LE32, protocol LE16, unknown_12/13 bytes, scratchpad, pad[2]; then an 8-byte FEL status read |
| SoC ID decoding | `soc_id = (le32(soc_id_raw) >> 8) & 0xFFFF` |
| H3 | `0x1680` → `"H3"` (same table as in fel.c) |
| Expected H3 reply (examples in forums / sunxi docs) | `AWUSBFEX soc=00001680(H3) 00000001 ver=0001 44 08 scratchpad=00007e00 …` |
| Bulk endpoints | **discovered at runtime** from the active configuration: bulk endpoints, IN vs OUT by direction bit. Current upstream does not hardcode them. Older sunxi code used OUT `0x01` / IN `0x82`; do not hardcode those. |
| H3 SRAM info (context only, not used in v1) | scratch `0x1000`, mmu_tt `0x8000`, thunk `0xA200`, sid `0x01C14200` |
| Upstream timeout | 60000 ms in fel.c |

### 4. Timeout deviation — deliberate

`fel_version.c` uses 5000 ms per bulk transfer, not upstream's
60000 ms. A single FEL_VERSION exchange is 32 bytes in and 32
bytes out; if it has not answered in 5 s on the phone, the bridge
server (which also enforces a 5 s timeout) should fail fast and
report a timeout, not hang. If a real H3 answers slowly on some
phones, this value may need raising — that is a test result, not
a guess to make now.

### 5. sunxi-fel on Termux — NOT a working path in v1

- Building sunxi-fel from source is a verified method in general:
  `git clone https://github.com/linux-sunxi/sunxi-tools && make sunxi-fel`
  (needs `make gcc pkg-config libusb-1.0-0-dev` on Linux; on Termux
  `clang libusb`).
- **But** stock `sunxi-fel` opens the device by VID/PID with
  libusb discovery (`libusb_open_device_with_vid_pid`). It has no
  option to take a termux-usb file descriptor. So even a successful
  build does not give a working FEL path on a non-rooted phone.
  That is why v1 ships `fel_version.c` instead, and why
  `termux-setup.sh` does not build sunxi-fel by default. Setting
  `BRIDGE_BUILD_SUNXI=1` tries the build as an optional extra
  only, and a failure there does not block the bridge.

## Unverified on a real device

- `termux-usb -l` output format on the user's phone (JSON array
  vs plain lines). The server parses both, but this is untested.
- Whether `libusb_claim_interface(handle, 0)` succeeds on a
  termux-usb wrapped handle on Samsung/Android. `fel_version.c`
  reports a failure instead of silently continuing.
- Whether the 5 s FEL timeout is enough on that phone.
- Whether Chrome on the phone can reach `http://127.0.0.1:3001`
  from ARTEMIS on `http://127.0.0.1:3000` (same-device fetch
  should work; Render-hosted ARTEMIS will **not** work — see
  bridge/README.md).
- The exact `/dev/bus/usb/001/002` path on the user's phone; it
  changes with the USB port / hub, so always re-run
  `termux-usb -l` first.

## Device reference (from the repo, not re-verified here)

- Board SHUNJUEY R69-EMCP V2.0, Allwinner H3, `dolphin-p1`,
  SanDisk SD9DS28K-8G eMCP, 1 GB LPDDR3 type 7 @ 336 MHz,
  Wi-Fi XR819, Android 10, IMAGEWTY v3 (`atv10_h3fixed.img`,
  37 entries). See `docs/DEVICE_PROFILE.md`.
