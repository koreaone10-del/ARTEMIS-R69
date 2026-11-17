# Bridge sources — what was verified, and what was not

Date: 2026-11-17 (v2 added the same day). No R69 device was available
in the VM for this work, so nothing here is a claim about a live
device test except the items explicitly marked **LIVE** below.
Anything marked **UNVERIFIED** must be tested on the phone before
it is presented as working.

## Live results on the user's phone (2026-11-17)

- ARTEMIS runs locally on `127.0.0.1:3000` (Node fixed after the
  v1 `libicui18n.so.79` breakage).
- `usb_probe` at 14:42 UTC: VID `0x1F3A`, PID `0xEFE8`, device
  `/dev/bus/usb/001/004`, 1 vendor interface (class FF), bulk
  endpoints `0x01` out / `0x82` in, 64-byte packets, no
  manufacturer/product/serial.
- `FEL_VERSION` at 14:44 UTC: signature `AWUSBFEX`, soc_id 5760 /
  `0x1680`, soc_name `H3`, protocol 1, scratchpad `0x7e00`, bulk
  endpoints 1 out / 130 (`0x82`) in. **The FEL handshake is
  proven.** Bridge v1 status at that time: read-only,
  `127.0.0.1:3001`, termuxUsbAvailable / usbProbeAvailable /
  felVersionAvailable true, sunxiFelAvailable false.
- FEL_READ / FEL_WRITE / FEL_EXEC have **never** been run on a
  real device. Everything in v2 about them is verified from
  source only, and is **UNVERIFIED** on hardware until the test
  plan in bridge/README.md is run on the phone.

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
  `-e` argument form for probe and fel-version (v1, proven live).

### 2. termux-usb `-e` with a command string — UNVERIFIED on this phone

- The v2 tools (fel_read / fel_write / fel_exec) need arguments
  in addition to the fd, so the server uses the command-string
  form: `termux-usb -r -e "<binary> <args>" <device>`.
- Evidence that this form exists: `termux-usb -r -E -e
  "$HOME/ql570 status" /dev/bus/usb/001/002` in
  https://github.com/sschueller/brother-ql570-go/blob/HEAD/README.md
  (a command string with arguments after `-e`), and the DeepWiki
  summary of termux-api-package `scripts/termux-usb.in` stating
  the fd "is passed as argument or via `TERMUX_USB_FD`
  environment variable (with `-E` flag)".
- Whether the fd is appended **after** the command string's
  arguments on the user's Termux version is **UNVERIFIED**. The
  v2 C tools therefore accept the fd in three positions: argv[1]
  (v1 form), the last argv token (command-string form), or
  `$TERMUX_USB_FD` (-E form); parameters can also come from
  `FEL_ADDR` / `FEL_LEN` / `FEL_FILE` in the environment. The
  server also passes those env vars. If the command-string form
  fails on the phone, the README documents the direct Termux
  fallback (`termux-usb -r -E -e "./fel_read 0x1000 16" <device>`).

### 3. termux-usb `-E` variant — UNVERIFIED

- Some newer Termux:API versions / projects document
  `termux-usb -r -E -e "<command>" <device>`, where the fd is
  passed in the environment variable `$TERMUX_USB_FD` instead of
  as an argument.
- The v2 C tools accept **both**: `argv[1]` first, then the last
  argv token, then `$TERMUX_USB_FD`. Whether `-E` exists on the
  user's Samsung / Termux version is **UNVERIFIED** — try it
  manually if `-e` fails, do not assume it.

### 4. Allwinner FEL protocol (sunxi-fel) — re-verified for v2

Re-fetched 2026-11-17 from
https://raw.githubusercontent.com/Icenowy/sunxi-tools/master/fel.c
(Icenowy/sunxi-tools master; also the Debian dgit copy
https://browse.dgit.debian.org/sunxi-tools.git/tree/fel.c).

| Item | Value (from fel.c) | Reference |
|---|---|---|
| VID / PID | `0x1F3A` / `0xEFE8` | fel.c L65-67 |
| USB request signature | `"AWUC"` (8-byte field, zero-padded) | fel.c L101-115, L323-343 |
| USB request | length LE32, unknown1 `0x0c000000`, request LE16, length2 = length, 10 pad bytes; total 32 bytes | fel.c L101-115 |
| AW_USB_READ / WRITE | `0x11` / `0x12` | fel.c L139-141 |
| USB reply | 13 bytes, must start `"AWUS"` | fel.c L346-356 |
| FEL request | 16 bytes: request LE32, address LE32, length LE32, pad LE32 | fel.c L387-397, L409-425 |
| AW_FEL_VERSION | `0x001` (address 0, length 0) | fel.c L400 |
| AW_FEL_1_WRITE | `0x101` | fel.c L402 |
| AW_FEL_1_EXEC | `0x102` | fel.c L404 |
| AW_FEL_1_READ | `0x103` | fel.c L406 |
| **v1 table check** | The v1 SOURCES.md claim (WRITE `0x101` / EXEC `0x102` / READ `0x103`) is **correct** — confirmed against fel.c L402-406. No correction was needed. | fel.c L400-406 |
| FEL version reply | 32-byte `aw_fel_version`: signature `"AWUSBFEX"`, soc_id raw LE32, unknown_0a LE32, protocol LE16, unknown_12/13 bytes, scratchpad, pad[2]; then an 8-byte FEL status read | fel.c L118-136, L439-462 |
| SoC ID decoding | `soc_id = (le32(soc_id_raw) >> 8) & 0xFFFF` | fel.c L450 |
| H3 | `0x1680` → `"H3"` | fel.c L496 |
| Bulk endpoints | **discovered at runtime** from the active configuration: bulk endpoints, IN vs OUT by direction bit. Current upstream does not hardcode them. Older sunxi code used OUT `0x01` / IN `0x82`; do not hardcode those. | fel.c L2603-2671 |
| Upstream timeout | 60000 ms in fel.c | fel.c L148 |
| `aw_fel_read` order | FEL_READ request, then AW_USB_READ of the data, then 8-byte FEL status | fel.c L512-522 |
| `aw_fel_write` order | FEL_WRITE request, then AW_USB_WRITE of the data, then 8-byte FEL status | fel.c L525-535 |
| `aw_fel_execute` order | FEL_EXEC request (address, length 0), then 8-byte FEL status only — no data transfer | fel.c L538-546 |

### 5. H3 SRAM map (sunxi-fel `soc_sram_info`, fel.c) — verified for v2

H3 entry in `soc_sram_info_table` (fel.c L1148-1162):

| Item | Value | Reference |
|---|---|---|
| soc_id | `0x1680` (H3) | fel.c L1150 |
| scratch_addr — "a safe place to upload & run code" | `0x1000` | fel.c L1152, L870-892 |
| mmu_tt_addr (16K-aligned MMU table) | `0x8000` | fel.c L1154 |
| thunk_addr / thunk_size | `0xA200` / `0x200` | fel.c L1156 |
| swap_buffers | `a10_a13_a20_sram_swap_buffers` | fel.c L1158, L913-929 |
| sid_addr (SID_KEY[0-3] base) | `0x01C14200` | fel.c L1160 |
| **spl_addr** | **not set in the H3 entry — the field defaults to `0`** | fel.c L1148-1162 (no `.spl_addr` line, unlike A64/A80 at L1120/L1168 which set `0x10000`) |
| SPL load address for H3, effective | **`0x00000000`** (SRAM base; `cur_addr = sram_info->spl_addr` in `aw_fel_write_and_execute_spl`) | fel.c L2067 |
| SPL_LEN_LIMIT (max SPL size; also the offset of the main U-Boot image inside `u-boot-sunxi-with-spl.bin`) | `0x8000` (32 KiB) | fel.c L2042 |
| DRAM_BASE / DRAM_SIZE | `0x40000000` / `0x80000000` | fel.c L1276-1278 |

Distinguish two different "scratch" values — they are not the same:
- The **FEL_VERSION reply** field `scratchpad` is `0x7e00`
  (fel.c L132, and the live 2026-11-17 read returned `0x7e00`).
  It lies inside `0x7C00-0x7FFF`.
- The **`soc_sram_info.scratch_addr`** used by upstream to upload
  and run small code is `0x1000` (fel.c L1152).

Protected SRAM regions used by the v2 allowlist (fel.c
L895-911 comment + `a10_a13_a20_sram_swap_buffers` L913-929):
- `0x1C00-0x1FFF` — BROM IRQ stack ("0x2000 (and growing down)
  for the IRQ handler").
- `0x5C00-0x6FFF` — BROM stack ("0x7000 (and also growing
  down) for the regular code").
- `0x7C00-0x7FFF` — "the addresses 0x7D00-0x7FFF contain
  something important too (overwriting them kills FEL)". The
  v2 allowlist protects `0x7C00-0x8000` (the whole swap entry).
- `0x8000-0xBFFF` — MMU translation table at `0x8000` and the
  thunk at `0xA200`; backup areas `0xA400`/`0xA800`/`0xBC00`
  live here too. v2 protects `0x8000-0xC000`.

### 6. How upstream loads and executes an SPL — and what v2 does NOT do

`aw_fel_write_and_execute_spl` (fel.c L2045-2327) and
`aw_fel_process_spl_and_uboot` (fel.c L2460-2484):

1. The SPL file must start with the eGON header: bytes 4..11
   are `"eGON.BT0"`, the length is LE32 word 4 (byte offset 16),
   and the checksum is verified as
   `spl_checksum = 2 * le32(buf32[3]) - 0x5F0A6C39` (word 3 is
   byte offset 12), subtracting every LE32 word of the SPL; the
   result must be 0 (fel.c L2081-2117). **v2 does not verify the eGON header or
   checksum** — the UI/server only check size and SHA-256 of
   the uploaded file. An SPL without a valid eGON header will
   be refused by upstream's check; in v2 it would be written
   and executed blindly. The user must verify the SPL with the
   Bootloader Lab (eGON check) before upload.
2. Upstream backs up the MMU state, disables the MMU, and (for
   H3, which has `mmu_tt_addr`) generates a new translation
   table at `0x8000` (fel.c L2129-2178).
3. Upstream writes the SPL in pieces, **skipping the protected
   regions**: the chunks at `0x1C00`, `0x5C00` and `0x7C00` are
   written to the backup addresses `0xA400`, `0xA800` and
   `0xBC00` instead (fel.c L2181-2227).
4. Upstream writes a **thunk** (`fel-to-spl-thunk`, an ARM code
   blob from `fel-to-spl-thunk.h`) at `0xA200`, and executes
   the thunk — not the SPL directly. The thunk restores the
   backed-up regions and then jumps to the SPL at `spl_addr`
   (fel.c L2255-2293).
5. After the thunk returns, upstream reads back
   `spl_addr + 4` and requires the signature `"eGON.FEL"`
   (fel.c L2306-2318). That is the only success proof for an
   SPL run.
6. If the file is larger than `SPL_LEN_LIMIT` (0x8000), the
   remainder is treated as a main U-Boot image (mkimage header,
   `IH_TYPE_FIRMWARE`) and written to the load address in its
   own header (fel.c L2342-2451, L2476-2480). **v2 does not
   implement this**: a `u-boot-sunxi-with-spl.bin` larger than
   32 KiB is refused by the server (`spl_too_large`).

**Consequence for v2:** the v2 SPL form does a raw
`FEL_WRITE` of the file to `0x00000000` followed by a raw
`FEL_EXEC` at `0x00000000`, with **no stack swap, no MMU
handling, no thunk, no eGON checksum check, and no
`eGON.FEL` read-back**. That is a deliberate simplification,
and it is **UNVERIFIED and risky**: writing the SPL over the
live BROM stacks (`0x1C00`/`0x5C00`/`0x7C00`) can kill FEL
mid-transfer, and executing at `0x0` without the thunk has
never been tested. The `--spl` flag / `spl:true` body field
exist so this path is explicit and auditable. The safe
pattern test (16 bytes at `0x1000`, read back and compare)
must pass first, and SPL exec needs explicit user approval
for that single run. A correct upstream-style SPL loader
(swap + thunk + eGON check) is v3 work, not v2.

### 7. Timeout deviation — deliberate (v1, kept in v2)

`fel_common.c` uses 5000 ms per bulk transfer, not upstream's
60000 ms. A single small FEL exchange is 32 bytes in and 32
bytes out; if it has not answered in 5 s on the phone, the
bridge server (which enforces its own timeouts: 10 s read,
30 s write, 10 s exec) should fail fast and report a timeout,
not hang. If a real H3 answers slowly on some phones, this
value may need raising — that is a test result, not a guess
to make now. Note: an SPL that takes over the device never
returns a FEL status, so `fel_exec` timing out after an SPL
exec is an expected outcome, not proof of failure.

### 8. sunxi-fel on Termux — NOT a working path in v2

- Building sunxi-fel from source is a verified method in general:
  `git clone https://github.com/linux-sunxi/sunxi-tools && make sunxi-fel`
  (needs `make gcc pkg-config libusb-1.0-0-dev` on Linux; on Termux
  `clang libusb`).
- **But** stock `sunxi-fel` opens the device by VID/PID with
  libusb discovery (`libusb_open_device_with_vid_pid`). It has no
  option to take a termux-usb file descriptor. So even a successful
  build does not give a working FEL path on a non-rooted phone.
  That is why v2 ships `fel_read.c` / `fel_write.c` / `fel_exec.c`
  instead, and why `termux-setup.sh` does not build sunxi-fel by
  default. Setting `BRIDGE_BUILD_SUNXI=1` tries the build as an
  optional extra only, and a failure there does not block the bridge.

## Unverified on a real device

- FEL_READ / FEL_WRITE / FEL_EXEC themselves (exchange order is
  from source only).
- Whether the `termux-usb -e "<binary> <args>"` command-string
  form works on the user's phone, and whether the fd is appended
  after the arguments (the C tools accept fd first, fd last, and
  `$TERMUX_USB_FD` to cover the variants).
- Whether `-E` exists on the user's Termux version.
- Whether `libusb_claim_interface()` succeeds on a termux-usb
  wrapped handle on Samsung/Android for the new tools (it did
  for fel_version on 2026-11-17, which is encouraging but not
  proof for a second open of the device).
- Whether the 5 s FEL timeout is enough for a 128 KiB write on
  that phone (the server allows 30 s for the whole write call).
- Whether the raw SPL write+exec at `0x00000000` works without
  upstream's swap/thunk (see §6 — expected to be fragile).
- The exact `/dev/bus/usb/001/002` path on the user's phone; it
  changes with the USB port / hub, so always re-run
  `termux-usb -l` first.

## Device reference (from the repo, not re-verified here)

- Board SHUNJUEY R69-EMCP V2.0, Allwinner H3, `dolphin-p1`,
  SanDisk SD9DS28K-8G eMCP, 1 GB LPDDR3 type 7 @ 336 MHz,
  Wi-Fi XR819, Android 10, IMAGEWTY v3 (`atv10_h3fixed.img`,
  37 entries). See `docs/DEVICE_PROFILE.md`.
