# Bridge sources — what was verified, and what was not

Date: 2026-11-17 (v2 added the same day; v3 the same day).
No R69 device was available in the VM for this work, so nothing
here is a claim about a live device test except the items
explicitly marked **LIVE** below. Anything marked **UNVERIFIED**
must be tested on the phone before it is presented as working.
Line numbers for fel.c refer to the copy fetched 2026-11-17 from
https://raw.githubusercontent.com/Icenowy/sunxi-tools/master/fel.c
(1775 lines). The v2 draft cited line numbers from an older
fel.c layout (e.g. H3 entry L1148-1162, SPL function
L2045-2327); those were wrong for the current file and are
corrected in v3 (§5, §6).

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
- FEL_READ was proven live directly in Termux at 15:18 UTC on
  `/dev/bus/usb/001/006` (device path had changed from `001/004`),
  twice with identical results: address `0x1000`, length 16,
  hex `43f0704313604bf00072ddf824c00a98`, sha256
  `5b2402fa391d657a137b6d3f33ef97ff962b7d2cd5863276ae483946f3292191`,
  `verified_on_device: true`. Both the `-E` form and the non-`-E`
  form worked. The same FEL_READ through the bridge page failed
  first (quoted command-string bug, fixed in v2.1 — see §2) and
  has not yet been re-tested from the page.
- FEL_WRITE / FEL_EXEC have **never** been run on a real device.
  Everything in v2 about them is verified from source only, and
  is **UNVERIFIED** on hardware until the test plan in
  bridge/README.md is run on the phone.
- **LIVE 2026-11-17, 15:29-15:30 UTC:** the pattern test passed
  through the bridge page on `/dev/bus/usb/001/006`: FEL_WRITE of
  28 bytes (`HELLO-FEL-PATTERN-0123456789`) to `0x1000`, then
  FEL_READ read-back with identical SHA-256
  `93a6594f99e0c9eeecce69137b536c238e90b46e7d99db725a99873085007fc8`.
  The full FEL loop (probe, FEL_VERSION, FEL_READ, FEL_WRITE,
  read-back) is proven live via the bridge page.
- **LIVE 2026-11-17: the v3 SPL + U-Boot run printed NOTHING.**
  Via the bridge page: `fel_spl_uboot_bad_output`, stdout empty,
  stderr only locale warnings, no steps. Direct in Termux
  (`termux-usb -r -E -e "./bridge/fel_spl_uboot
  /data/data/com.termux/files/home/uboot-full.bin"
/dev/bus/usb/001/002"`): also no output at all. The binary
  exists (30,632 bytes), prints usage JSON with no arguments,
  and the file copy was verified (559,480 bytes, SHA-256
  `8c70a180…ece071`). FEL was alive (FEL_VERSION succeeded
  before and after). FEL_VERSION itself was intermittent in
  the same session: success, then twice no output at all from
  the identical command, then success again. See §6b for the
  audit finding and the v3.1 fix (incremental progress lines,
  banner, `--validate-only`, stderr diagnostics, buffers off
  the stack).
- **LIVE 2026-11-17: the v2 raw SPL write KILLED FEL.** A v2
  `fel_write` of 32768 bytes to `0x00000000` (spl-only.bin, SHA-256
  `5979cc33…`) failed with "fel_write did not return JSON", and
  afterwards FEL_VERSION direct produced NO output at all,
  although `termux-usb -l` still listed the device at `001/006`.
  The device was recovered by re-entering FEL: new path
  `/dev/bus/usb/001/002`, permission granted, FEL_VERSION again
  OK (`AWUSBFEX` / `0x1680` / H3). eMMC was never written. This is
  the evidence for v3: the v2 raw SPL write must not be retried.
  See §6.

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

### 2. termux-usb `-e` with a command string — PROVEN live, unquoted only

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
- **Proven live on the user's phone, 2026-11-17:** the UNQUOTED
  form works, both with `-E` and without, returning identical
  FEL_READ JSON for `0x1000` x16 on `/dev/bus/usb/001/006`:
  `termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/006`
  and `termux-usb -r -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/006`
  both returned `{"ok":true,"tool":"fel_read","address":4096,
  "address_hex":"0x00001000","length":16,
  "sha256":"5b2402fa391d657a137b6d3f33ef97ff962b7d2cd5863276ae483946f3292191",
  "hex":"43f0704313604bf00072ddf824c00a98","verified_on_device":true}`.
  The fd is appended after the command string's arguments (the
  v2 C tools also accept the fd first, or via `$TERMUX_USB_FD`).
- **The SINGLE-QUOTED form FAILED on this phone:** the v2 server
  originally built `termux-usb -r -e "'<binary>' 0x1000 16"
  <device>`, and the bridge page's FEL_READ failed with
  "fel_read did not return JSON" — termux-usb does not strip the
  quotes, so the binary path was not resolved. The v2.1 server
  fix builds the command string unquoted
  (`buildTermuxUsbCmd` in `bridge/server.js`, which rejects any
  token containing whitespace, quotes or shell metacharacters
  instead of quoting it in). Only server-validated hex addresses,
  decimal lengths, `--flag`s and server-made temp file paths are
  ever interpolated. The server also passes `FEL_ADDR` /
  `FEL_LEN` / `FEL_FILE` in the environment as a fallback.

### 3. termux-usb `-E` variant — PROVEN live on this phone

- Some newer Termux:API versions / projects document
  `termux-usb -r -E -e "<command>" <device>`, where the fd is
  passed in the environment variable `$TERMUX_USB_FD` instead of
  as an argument.
- The v2 C tools accept **both**: `argv[1]` first, then the last
  argv token, then `$TERMUX_USB_FD`. **Proven live 2026-11-17:**
  `-E` exists on the user's Samsung / Termux version and the
  `-E` FEL_READ returned the identical result quoted in §2.
  The non-`-E` form works too, so the server (which does not
  pass `-E`) uses the proven unquoted non-`-E` form.

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

### 5. H3 SRAM map (sunxi-fel `soc_sram_info`, fel.c) — verified for v2, line numbers corrected for v3

H3 entry in `soc_sram_info_table` (fel.c L602-609):

| Item | Value | Reference |
|---|---|---|
| soc_id | `0x1680` (H3) | fel.c L603 |
| scratch_addr — "a safe place to upload & run code" | `0x1000` | fel.c L604 |
| mmu_tt_addr (16K-aligned MMU table) | `0x8000` | fel.c L605 |
| thunk_addr / thunk_size | `0xA200` / `0x200` | fel.c L606 |
| swap_buffers | `a10_a13_a20_sram_swap_buffers` | fel.c L607 |
| sid_addr (SID_KEY[0-3] base) | `0x01C14200` | fel.c L608 (also L600 for the entry above it) |
| **spl_addr** | **not set in the H3 entry — the field defaults to `0`** | fel.c L602-609 (no `.spl_addr` line, unlike A64/A80 which set `0x10000`) |
| SPL load address for H3, effective | **`0x00000000`** (SRAM base; `cur_addr = sram_info->spl_addr` in `aw_fel_write_and_execute_spl`) | fel.c L1078-1190 |
| SPL_LEN_LIMIT (max SPL size; also the offset of the main U-Boot image inside `u-boot-sunxi-with-spl.bin`) | `0x8000` (32 KiB) | fel.c L1076 |
| DRAM_BASE / DRAM_SIZE | `0x40000000` / `0x80000000` | fel.c L670-671 |

Distinguish two different "scratch" values — they are not the same:
- The **FEL_VERSION reply** field `scratchpad` is `0x7e00`
  (fel.c L132, and the live 2026-11-17 read returned `0x7e00`).
  It lies inside `0x7C00-0x7FFF`.
- The **`soc_sram_info.scratch_addr`** used by upstream to upload
  and run small code is `0x1000` (fel.c L1152).

Protected SRAM regions used by the v2/v3 allowlist (the comment
above `a10_a13_a20_sram_swap_buffers`, fel.c L482-490):
- `0x1C00-0x1FFF` — BROM IRQ stack ("0x2000 (and growing down)
  for the IRQ handler").
- `0x5C00-0x6FFF` — BROM stack ("0x7000 (and also growing
  down) for the regular code").
- `0x7C00-0x7FFF` — "the addresses 0x7D00-0x7FFF contain
  something important too (overwriting them kills FEL)". The
  v2/v3 allowlist protects `0x7C00-0x8000` (the whole swap entry).
- `0x8000-0xBFFF` — MMU translation table at `0x8000` and the
  thunk at `0xA200`; backup areas `0xA400`/`0xA800`/`0xBC00`
  live here too. v2/v3 protect `0x8000-0xC000`.

### 6. How upstream loads and executes an SPL — and what v3 implements

`aw_fel_write_and_execute_spl` (fel.c L1078-1235),
`aw_fel_write_uboot_image` (fel.c L1238-1296) and
`aw_fel_process_spl_and_uboot` (fel.c L1300-1313), as called by
sunxi-fel's `spl` / `uboot` commands (fel.c L1748-1763). v3
(`bridge/fel_spl_uboot.c`, server endpoint
`POST /api/bridge/fel-spl-uboot`) implements this flow
faithfully, step by step, in the same order:

1. **eGON header + checksum (fel.c L1097-1117).** The file must
   start with the eGON header: bytes 4..11 are `"eGON.BT0"`,
   the SPL length is LE32 word 4 (byte offset 16), and the
   checksum is `spl_checksum = 2 * le32(buf32[3]) - 0x5F0A6C39`
   (word 3 is byte offset 12), subtracting every LE32 word of
   the SPL; the result must be 0. v3 checks this in the server
   (`validateFullUbootImage` in `bridge/server.js`) **and** in
   the C tool (`egon_checksum_ok` in `bridge/fel_spl_uboot.c`)
   before touching the device. v2 did not check it at all.
2. **Stack info, logging only (fel.c L1124, `aw_get_stackinfo`
   L824-875).** Upstream reads `sp_irq` and `sp` by running
   scratch code at `0x1000` that switches CPSR modes
   (the "works everywhere" branch, L846-870) and logs them.
   v3 does the same; a failure here is a warning step, not a
   fatal error, because upstream uses the values only for
   logging.
3. **MMU backup (fel.c L1127, `aw_backup_and_disable_mmu`
   L933-1016).** Upstream reads SCTLR via scratch code
   (`aw_read_arm_cp_reg`, fel.c L673-692) and requires
   `(sctlr & ~((0x7<<11)|(1<<6)|1)) == 0x00C50038`
   (L975-980). If the MMU is not enabled — the H3 case
   (fel.c L457-460) — it returns NULL ("MMU is not enabled by
   BROM", L983-986). If it is enabled, upstream checks DACR
   `== 0x55555555`, TTBCR `== 0`, TTBR0 16K-aligned, reads the
   16 KiB table and validates every entry as a direct-mapped
   section descriptor, then disables I-cache, MMU and branch
   prediction with scratch code (L945-958). v3 implements all
   of it, including the same SCTLR/DACR/TTBCR/TTBR0 checks.
   The CP-register scratch code words in v3 are copied from
   fel.c L673-716 (`mrc`/`mcr` + `dsb`/`isb` + `bx lr`).
4. **MMU setup for H3 (fel.c L1129-1150).** When the backup
   returned NULL and `mmu_tt_addr` is set (H3: `0x8000`),
   upstream requires it 16K-aligned, sets DACR `0x55555555`,
   TTBCR `0x00000000`, TTBR0 `0x8000`, and generates a new
   translation table host-side (`aw_generate_mmu_translation_table`,
   fel.c L914-931: `tt[i] = 0xDE2 | (i<<20)`, with `tt[0]` and
   `tt[0xFFF]` OR-ed with `0x1000`). **Quirk, preserved
   faithfully:** upstream sets the registers here but writes
   the table back to the device only in the restore step
   (step 8). v3 does the same and documents it; the table is
   not written to `0x8000` at setup time.
5. **SPL piece writes with the swap (fel.c L1151-1175).**
   Upstream walks `swap_buffers` in order
   (`a10_a13_a20_sram_swap_buffers`, fel.c L482-490):
   - `{0x01C00 -> 0xA400, size 0x0400}` (IRQ stack)
   - `{0x05C00 -> 0xA800, size 0x1400}` (stack)
   - `{0x07C00 -> 0xBC00, size 0x0400}` ("something important")
   - terminator `{0}`
   For each entry it first shrinks `spl_len_limit` if the
   backup buffer lies inside `[spl_addr, spl_addr+limit)`,
   then writes the SPL bytes before the protected region to
   their real address, and the bytes that fall on the
   protected region to the **backup** address instead.
   After the loop, if `thunk_addr < spl_len_limit` the limit
   shrinks to `thunk_addr` (L1177-1178), SPL longer than the
   limit is refused (L1181-1187), and any remaining bytes are
   written at the current address (L1189). Only the first
   `spl_len` bytes are written — never the `0xFF` padding
   after them. v3 implements the loop identically, with the
   same backup addresses (verified, not guessed).
6. **Thunk (fel.c L1190-1213).** Upstream builds a buffer of
   `sizeof(fel_to_spl_thunk) + sizeof(spl_addr) + (nswap+1) *
   sizeof(swap entry)` bytes — for H3: 264 + 4 + 4*12 = **316
   bytes**, which must fit `thunk_size` 0x200 (512) — copies
   the thunk words, then `spl_addr`, then the swap table
   including its terminator, converts every word to LE32,
   writes the buffer to `thunk_addr` (`0xA200`) and executes
   it there. The thunk itself (`fel_to_spl_thunk`, fel.c
   L666, from `fel-to-spl-thunk.h`, generated by
   `ruby -x fel-to-spl-thunk.S`): swaps every swap buffer
   (buf1 <-> buf2, word by word), sets up its own stack,
   disables IRQ/FIQ, re-verifies the SPL eGON checksum,
   writes `"eGON.FEL"` at `spl_addr+4` on success (or
   `"eGON.CRC"` / `"eGON.CAC"` on failure), jumps to the SPL
   (`blx r8`), and on return swaps the buffers back and
   returns to FEL (`bx lr`). v3 embeds the **66 words verbatim**
   from the fetched `fel-to-spl-thunk.h` (264 bytes, offsets
   `0x0-0x104`, starting `0xea000015` / `b 5c <setup_stack>`,
   ending `0xe59dd000` / `0xe12fff1e`); nothing about them was
   invented. The v3 thunk buffer layout and LE32 conversion
   follow fel.c L1190-1209 exactly.
7. **Wait + eGON.FEL read-back (fel.c L1214-1225).** Upstream
   sleeps 250 ms (`usleep(250000)`, L1217, with a TODO comment
   about a bug needing the workaround), then FEL_READs 8 bytes
   at `spl_addr + 4` and requires `"eGON.FEL"` — that is the
   only success proof for an SPL run. If it is not there,
   upstream exits with the failure code in the header. **v3
   stops here and does not stage U-Boot** if the signature is
   absent, and returns the step log so the failure can be
   reported.
8. **MMU restore (fel.c L1227-1228, `aw_restore_and_enable_mmu`
   L1018-1076).** If a table exists, upstream writes it back
   to the current TTBR0, after clearing the TEXCB bits and
   setting TEXCB `00100` (normal uncached) for DRAM and
   `00111` (normal write-back cached) for the BROM section
   `0xFFF`, then enables I-cache, MMU and branch prediction
   with scratch code (L1028-1042). v3 implements it identically.
   **Deviation, documented:** upstream writes the table to
   whatever TTBR0 reads as; v3 refuses a TTBR0 of 0 rather
   than writing a 16 KiB table to address 0.
9. **U-Boot proper (fel.c L1238-1296).** `aw_fel_write_uboot_image`
   takes the bytes after `SPL_LEN_LIMIT` (32 KiB): it requires
   `len > HEADER_SIZE` (64 = 32 name offset + 32 name length,
   fel.c L145-146), checks the mkimage header with
   `get_image_type` (fel.c L158-172: magic `0x27051956`
   big-endian, arch byte 29 must be 2 = ARM, type byte 30 is
   returned), requires `IH_TYPE_FIRMWARE` (5), reads
   `data_size = be32(buf32[3])` (offset 12) and
   `load_addr = be32(buf32[4])` (offset 16), requires
   `data_size == len - HEADER_SIZE`, then writes the payload
   (`buf + HEADER_SIZE`) to `load_addr` and records
   `uboot_entry = load_addr` (L1290-1293). Upstream does **not**
   verify the mkimage header/data CRCs (TODO, fel.c
   L1273-1284) — v3 does not either. v3 validates the header
   server-side and in the C tool before any write, and adds one
   safety refusal upstream does not have: the load address must
   lie inside DRAM (`0x40000000-0xC0000000`); any other address
   is refused.
10. **U-Boot exec (fel.c L1748-1763, the `uboot` command).**
    Upstream executes `uboot_entry` (== load address) on exit.
    The exec request itself must be accepted (AWUS reply); the
    8-byte FEL status afterwards is **not** expected, because
    U-Boot takes over the CPU and never returns to FEL. v3
    reports that as `"uboot_exec_sent, no FEL reply expected"`
    with the step log, not as a failure, and instructs
    re-checking FEL_VERSION afterwards (a reply means U-Boot
    did not take over; no reply may mean it is running).

**Deviations of v3 from upstream (deliberate, all documented
in `bridge/fel_spl_uboot.c`):**
- U-Boot staging is written in **64 KiB FEL_WRITE chunks**
  instead of one FEL_WRITE, because `fel_common.c` uses a
  5000 ms per-transfer bulk timeout (upstream uses 60000 ms)
  and a single 526 KiB transfer could time out on the phone.
  The bytes landing in DRAM are identical. See §7.
- The C tool refuses a TTBR0 of 0 in the MMU restore (step 8)
  and refuses U-Boot load addresses outside DRAM (step 9);
  upstream has neither refusal.
- `aw_get_stackinfo` failure is a warning step in v3, not
  fatal; upstream only logs the values (step 2).

**Consequence for v2:** the v2 SPL form does a raw
`FEL_WRITE` of the file to `0x00000000` followed by a raw
`FEL_EXEC` at `0x00000000`, with **no stack swap, no MMU
handling, no thunk, no eGON checksum check, and no
`eGON.FEL` read-back**. That is a deliberate simplification,
and on **2026-11-17 it was proven to kill FEL**: a 32768-byte
SPL write to `0x0` failed with "fel_write did not return
JSON", and FEL_VERSION afterwards produced no output at all
until the device was re-entered into FEL (new path
`/dev/bus/usb/001/002`). **Do not retry the v2 raw SPL
write.** The v2 `spl:true` form and its UI panel are
deprecated in v3; SPL upload must go through
`POST /api/bridge/fel-spl-uboot` (v3), which implements the
flow above. The pattern test (28 bytes at `0x1000`,
read-back SHA-256 match, proven live 2026-11-17) still uses
the v2 tools and must pass first.

### 6b. v3 silent failure on the phone (2026-11-17) — and v3.1

**Evidence.** The v3 run via the bridge page failed with
`fel_spl_uboot_bad_output`: `fel_spl_uboot` did not return
JSON, stdout empty, stderr only the two `setlocale` warnings,
no steps at all. The direct Termux run then failed the same
way:
`termux-usb -r -E -e "./bridge/fel_spl_uboot
/data/data/com.termux/files/home/uboot-full.bin"
/dev/bus/usb/001/002` — also no output at all, prompt
returned. But the binary exists (30,632 bytes, `-rwx------`,
17:39), running it with no arguments prints the usage JSON
correctly, and the file copy was verified on the phone
(559,480 bytes, SHA-256
`8c70a1809803b0bc22ba74217bb95312701c55ce1fb18342d08b5cf655ece071`).
FEL was alive: FEL_VERSION succeeded immediately before the
direct run, and again after it.

**FEL_VERSION is intermittent on this phone.** In the same
session, the identical FEL_VERSION command succeeded, then
produced NO output at all on the next two runs, then succeeded
again with `AWUSBFEX` / `0x1680` / H3. `fel_version` prints a
single JSON object at the end (no fflush before return, stdout
fully buffered when piped), so a dropped run cannot be told
apart from a tool crash by its output — the transport itself
(termux-usb / Termux:API / Android USB permission race) can
lose a whole run's output, even for a short, proven tool.

**Audit finding (v3.1, 2026-11-17).** No deterministic crash
was found in `bridge/fel_spl_uboot.c`:
- In the VM the compiled v3 binary, run against the real
  `u-boot-sunxi-with-spl.bin` with a bad fd, prints all four
  validation steps plus a `fel_open` failure JSON (exit 1),
  and with no arguments prints the usage JSON (exit 2).
- No buffer overflow was found: every stack buffer is sized
  correctly (`code[12/24/36/48]`, `raw[16384]`, `tt[4096]`,
  `thunk` buffer `malloc` + `CHECK`), the SPL piece-write loop
  is bounded by `remaining`, the MMU table loops are bounded
  (`0..4095`, DRAM sections `1024..3071`), the eGON length is
  checked before the checksum reads the SPL, and the U-Boot
  header reads are guarded by `rem > HEADER_SIZE`. The thunk
  loop `i <= H3_NSWAP` is CORRECT — it must include the
  `{0,0,0}` terminator entry.
- The one real latent risk found was stack depth: `tt[4096]`
  (16 KiB) in `main`, nested under `raw[16384]` (16 KiB) in
  `backup_and_disable_mmu` / `restore_and_enable_mmu` — ~32 KiB
  plus frames, inside a process spawned by Termux:API whose
  stack limits are not documented. v3.1 moves both to static
  storage.
- The diagnosability defect, which is certain: v3 built its
  step log in memory (`g_steps`) and printed JSON **only at
  the end**, and stdout was fully buffered (a pipe through
  termux-usb), so ANY kill, crash, or lost stdout at any point
  — including after all four validation steps had already
  passed — produced exactly the observed silence. That is the
  bug v3.1 fixes, not a specific crash.

**v3.1 changes (`bridge/fel_spl_uboot.c`, server 3.1.0):**
- Every `STEP()` also prints a one-line progress JSON object
  immediately (`{"progress":true,"step":N,"name":"...","ok":...,"detail":"..."}`)
  with `fflush(stdout)`, and `main` sets stdout unbuffered
  (`setvbuf(stdout, NULL, _IONBF, 0)`).
- A banner line is printed after file validation and before
  any device access (`{"banner":true,...,"spl_len":...,"uboot_load":"0x4a000000",...}`).
  If a phone run shows the banner and nothing after it, the
  tool died opening the device or in the FEL_VERSION exchange.
- `--validate-only` (also `FEL_VALIDATE_ONLY=1`): validates
  the file, opens the device, checks FEL_VERSION/soc, then
  exits with a `validate_only:true` result WITHOUT any write
  or exec. Server: `validate_only:true` on
  `POST /api/bridge/fel-spl-uboot` (10 s timeout, no session
  write recorded). Frontend: a "Validate only" button in the
  v3 panel plus a live progress box rendering the incremental
  lines. **Test plan: validate-only FIRST, from the page, and
  report its output; only then the full flow.**
- Failure paths print a short stderr diagnostic
  (`fel_spl_uboot: step=<name> failed: <reason>`), flushed,
  for `fel_open`, FEL_VERSION, and every
  `fel_write_mem` / `fel_exec_mem` / `fel_read_mem` failure in
  the SPL / thunk / MMU / staging steps.
- The server parses multi-line tool output
  (`parseSplUbootOutput`): progress lines, banner, and the
  final result as the LAST line — the old whole-stdout
  `JSON.parse` would have failed on v3.1 output. The response
  carries `progress` (and `banner`) alongside `steps` /
  `detail.steps`, so progress survives even a missing final
  JSON.
- `read_all_file` refuses files over 2 MiB before allocating
  for them; every `malloc` is checked.

**v3.2 changes (`bridge/fel_spl_uboot.c`, server 3.2.0) — live-run lesson from 2026-11-17:**
- Validate-only PASSED on the phone (all 4 validation steps +
  FEL_VERSION 0x1680/H3), but the full flow failed at
  `egon_fel_readback` ("FEL stopped answering after the thunk")
  with stdout entirely lost (`stdout ""`, `progress []`) while
  stderr survived (it carried the diag line). So v3.1's
  incremental stdout progress is not enough on this phone:
  every JSON line the tool prints (progress, banner, final
  result) is now emitted to stdout AND stderr (`emit_json`),
  and the server's `parseSplUbootOutput` scans stderr lines
  too (stdout first, progress deduped by step number), so the
  step log and the final result survive a lost stdout.
- The `eGON.FEL` read-back is retried 3 times, 500 ms apart,
  before failing: FEL_VERSION itself is intermittent on this
  phone (two identical runs returned nothing, then a third
  succeeded), so one failed read is weak evidence FEL is dead.
  The 250 ms post-thunk wait (upstream fel.c L1216) is
  unchanged.
- Bridge tests 31/31 pass in the VM (28 v3.1 + 3 new v3.2:
  stderr recovery, dedupe, binary stderr mirror).

**v3.3 changes (server 3.3.0, no C changes) — automatic attempt driver `fel_auto`:**
- The user asked (2026-11-19) for the phone to try candidates in sequence without stopping at each error, following the device–phone connection and moving to the next stage on success. Two honest limits shaped the design: (1) there is no open-source AI model that runs on the phone and can make diagnostic decisions — the intelligence is Muse in the cloud reading the run log; the phone runs a deterministic decision tree (`runFelAuto` in `bridge/server.js`), NOT a local LLM; (2) a single session without disconnecting is impossible, because after every SPL attempt FEL dies and the device only returns by physically re-entering FEL (power off, hold the reset pin in the AV port, connect USB, release) — no script can do that, so stopping on NEED_REENTRY is protection, not a bug.
- `POST /api/bridge/fel-auto {device, candidates:[{label, base64, sha256, nodram?}], confirm:true}` (max 4 candidates, each ≤600 KB, same server-side SHA-256 + eGON + mkimage validation as the v3 panel, `confirm:true` literal required). Response is NDJSON: one JSON line per event as it happens, last line `{"type":"final", ...run}`. `POST /api/bridge/fel-auto/stop {runId}` sets a stop flag the driver checks between candidates and after validate-only. Status reports `felAutoAvailable:true`, version 3.3.0, mode `read-write-sram-only+spl-uboot+fel-auto`.
- Per candidate: validate-only first (file + FEL_VERSION/soc, no write); a validate-only failure whose kind is not NEED_REENTRY skips that candidate and moves on; then the full `fel_spl_uboot` flow (reusing the proven binary, 60 s timeout); on `eGON.FEL` success the flow already stages U-Boot to DRAM and execs, so the run reports BOOT_SUCCESS. On failure the driver runs diagnostics automatically — FEL_VERSION x3 with 5 s gaps (it is intermittent on this phone), pattern FEL_WRITE+READ at 0x1000 with SHA-256 compare, usb_probe — appends them to the run log, then moves to the next candidate.
- Failure classification (`classifyFelSplUbootFailure`): NEED_REENTRY when the flow dies at step 4 `fel_version_soc_check` ("FEL_VERSION failed: device is not answering in FEL mode") or the step log stops right after `validate_uboot_header` — the exact shape of the 2026-11-17 no-DRAM run, which never wrote or executed anything. On NEED_REENTRY the driver stops (trying the next candidate against a dead FEL would only repeat the same failure) and tells the user to re-enter FEL and re-run. EGON_READBACK_FAIL is the 336/300 MHz shape (steps 0–12 ok, read-back failed after 3 attempts). UBOOT_STAGE_FAIL for a nodram candidate is recorded as EXPECTED_UBOOT_STAGE_FAIL — eGON.FEL read back (the SPL ran and returned, so DRAM init was not killing FEL), and DRAM staging then fails as expected because that SPL never initialised DRAM; the driver stops there so the next step is a human decision (no-CPU-clock-raise build or a single-variable ZQ/CLK build), not another blind retry. Outcomes: BOOT_SUCCESS | EXPECTED_UBOOT_STAGE_FAIL | NEED_REENTRY | TRANSPORT_ERROR | EXHAUSTED | STOPPED.
- Run log: `bridge/run/fel-auto-<timestamp>.json` (full run object: outcome, per-candidate status/failure kind/diagnostics, logLines) + human-readable `.log`. Frontend: new "محاولات تلقائية (v3.3)" panel — candidate list UI (add up to 4 files, per-candidate label, nodram checkbox, reorder, remove), Start with SRAM-only checkbox, live progress box (NDJSON events as they arrive), Stop button, outcome banner with the exact next human step, copy-log button. Nothing else is deprecated.
- Bridge tests 41/41 pass in the VM (31 v3.2 + 10 new v3.3: classification of the exact 2026-11-17 failure shapes, candidate validation/rejection, four simulated end-to-end runs with a stub runner — egon-fail → diagnostics → boot; validate-only NEED_REENTRY stops before candidate 2; nodram EXPECTED_UBOOT_STAGE_FAIL; all-fail EXHAUSTED — plus Stop-between-candidates and endpoint validation/NDJSON).

**Still UNVERIFIED after v3.2:** the whole v3 flow on live
hardware (swap/thunk, `eGON.FEL`, DRAM staging, U-Boot exec),
whether the 5 s bulk timeout holds for the 64 KiB chunks, and
whether FEL really dies after the thunk or only the read-back
transport drops (the pending user check is FEL_VERSION plus a
direct FEL_READ of 0x00000004 x8). The validate-only run is
designed to answer the transport question before any write is
attempted.

### 7. Timeout deviation — deliberate (v1, kept in v2 and v3)

`fel_common.c` uses 5000 ms per bulk transfer, not upstream's
60000 ms. A single small FEL exchange is 32 bytes in and 32
bytes out; if it has not answered in 5 s on the phone, the
bridge server (which enforces its own timeouts: 10 s read,
30 s write, 10 s exec, **60 s for fel-spl-uboot**) should fail
fast and report a timeout, not hang. If a real H3 answers
slowly on some phones, this value may need raising — that is a
test result, not a guess to make now. Note: an SPL that takes
over the device never returns a FEL status, so `fel_exec`
timing out after an SPL exec is an expected outcome, not proof
of failure. **v3 consequence:** the U-Boot proper staging
(~527 KiB) is written in 64 KiB FEL_WRITE chunks instead of
upstream's single `aw_write_buffer` call, so no single transfer
is large enough to hit the 5 s bulk timeout; the bytes landing
in DRAM are identical.

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
  from source only). FEL_READ was proven live directly in Termux
  on 2026-11-17 (0x1000 x16, sha256 5b2402fa…2191); the same
  exchange through the bridge page was blocked only by the
  quoted command-string bug, fixed in v2.1 (see §2).
- The `termux-usb -e "<binary> <args>"` command-string form:
  the UNQUOTED form is proven live (§2); the single-quoted form
  the v2 server originally built is proven to FAIL on this phone.
  The fd is appended after the arguments, and `-E` also works.
- Whether `libusb_claim_interface()` succeeds on a termux-usb
  wrapped handle on Samsung/Android for the new tools (it did
  for fel_version on 2026-11-17, which is encouraging but not
  proof for a second open of the device).
- Whether the 5 s FEL timeout is enough for a 128 KiB write on
  that phone (the server allows 30 s for the whole write call;
  v3 stages U-Boot in 64 KiB chunks for the same reason).
- Whether the v3 SPL + U-Boot flow works on the real R69:
  the swap/thunk/eGON.FEL sequence and the DRAM staging are
  implemented from fel.c source only (§6) and have never run
  against a live H3. A live run is the only proof.
- Whether the raw SPL write+exec at `0x00000000` works without
  upstream's swap/thunk — **answered 2026-11-17: it does NOT;
  it killed FEL** (see the live results at the top of this file
  and §6). Do not retry it.
- The exact `/dev/bus/usb/001/002` path on the user's phone; it
  changes with the USB port / hub, so always re-run
  `termux-usb -l` first.

## Device reference (from the repo, not re-verified here)

- Board SHUNJUEY R69-EMCP V2.0, Allwinner H3, `dolphin-p1`,
  SanDisk SD9DS28K-8G eMCP, 1 GB LPDDR3 type 7 @ 336 MHz,
  Wi-Fi XR819, Android 10, IMAGEWTY v3 (`atv10_h3fixed.img`,
  37 entries). See `docs/DEVICE_PROFILE.md`.
