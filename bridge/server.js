'use strict';
/*
 * ARTEMIS Termux bridge server -- v3.2, SRAM-only FEL read/write/exec
 * plus upstream-style SPL + U-Boot staging (fel_spl_uboot).
 * v3.1: fel_spl_uboot prints incremental progress lines (v3 printed
 * nothing on the phone on 2026-11-17) and fel-spl-uboot accepts
 * validate_only:true — run that first, before the full flow.
 * v3.2: fel_spl_uboot mirrors every JSON line to stderr too and
 * retries the eGON.FEL read-back 3 times — on 2026-11-17 the full
 * flow's stdout was lost entirely while stderr survived, and the
 * single read-back attempt failed though FEL_VERSION itself is
 * intermittent on this phone. parseSplUbootOutput now reads
 * progress/banner/final from stderr as well.
 * v3.3: fel_auto — an automatic attempt driver
 * (POST /api/bridge/fel-auto, runFelAuto). It tries an ordered
 * list of candidate full images (validate-only first per
 * candidate, then the full fel_spl_uboot flow), runs diagnostics
 * automatically after a failure (FEL_VERSION x3, pattern
 * write/read-back at 0x1000, usb_probe), and moves to the next
 * candidate without stopping at each error. It STOPS and waits
 * for the human only when FEL needs physical re-entry (the
 * 2026-11-17 no-DRAM failure shape: the flow dies at step 4
 * fel_version_soc_check, "FEL_VERSION failed"), when a boot
 * succeeds, when the candidates are exhausted, or when the user
 * presses Stop. There is NO local LLM on the phone: the driver
 * is a deterministic decision tree, and the intelligence is
 * Muse in the cloud reading the run log it writes to
 * bridge/run/fel-auto-<timestamp>.json/.log. FEL re-entry
 * (reset pin in the AV port) remains manual — no script can do
 * it. A nodram candidate whose eGON.FEL reads back but whose
 * U-Boot staging then fails is recorded as
 * EXPECTED_UBOOT_STAGE_FAIL (DRAM was never initialised, so
 * staging to DRAM cannot work), not as a boot failure.
 *
 * Binds 127.0.0.1:3001 only. There is NO eMMC / flash / NAND write
 * endpoint, and there never will be one on this server: FEL_WRITE
 * and FEL_EXEC are confined to H3 SRAM (0x00000000-0x00020000),
 * FEL_READ is confined to SRAM plus the SID window
 * (0x01C14200-0x01C14210), and FEL_EXEC refuses unless the entry
 * address lies inside a range written by FEL_WRITE in this bridge
 * session (tracked in memory and persisted to bridge/run/session.json).
 * The v3 fel-spl-uboot flow writes the SPL to SRAM 0x00000000 with
 * the upstream sunxi-fel stack swap + thunk (implemented in
 * bridge/fel_spl_uboot.c) and stages U-Boot proper in DRAM at the
 * load address in its own mkimage header (0x4a000000 for the
 * current build). DRAM is written only by that one flow, only at
 * the header's load address, and only after eGON.FEL proves the
 * SPL ran. There is still no eMMC/flash/NAND endpoint.
 *
 * Localhost-only is a deliberate safety property, not a default:
 * - HOST is fixed to 127.0.0.1. Setting BRIDGE_HOST to anything else
 *   makes the process exit with "refusing non-localhost binding".
 * - CORS is allowed only for http://127.0.0.1:3000 and
 *   http://localhost:3000 (ARTEMIS running locally in Termux).
 *   The Render origin (https://artemis-r69.onrender.com) gets no
 *   CORS header, and a browser on Render cannot reach this server
 *   anyway (mixed content + localhost). The Live Bridge page only
 *   works with ARTEMIS on localhost.
 * - No token is used: the endpoints are localhost-only and the
 *   write surface is SRAM-only with an explicit confirm per call.
 *   Any local app on the phone could in theory call them, which is
 *   why they must never become eMMC/flash endpoints.
 *
 * Endpoints:
 *   GET  /api/bridge/status
 *   POST /api/bridge/probe        {device?: "/dev/bus/usb/001/002"}
 *   POST /api/bridge/fel-version  {device?: "/dev/bus/usb/001/002"}
 *   POST /api/bridge/fel-read     {device, address, length}
 *   POST /api/bridge/fel-write    {device, address, base64, sha256, confirm:true, spl?:boolean}
 *   POST /api/bridge/fel-exec     {device, address, confirm:true}
 *   POST /api/bridge/fel-spl-uboot {device, base64, sha256, confirm:true, validate_only?:boolean}
 *   POST /api/bridge/fel-auto {device, candidates:[{label, base64, sha256, nodram?:boolean}], confirm:true}
 *   POST /api/bridge/fel-auto/stop {runId}
 *   GET  /api/bridge/session      written ranges in this session
 *   GET  /api/bridge/report
 *
 * probe / fel-version run their native binary through termux-usb
 * in the v1 form, proven live on the phone on 2026-11-17:
 *   termux-usb -r -e <binary> <device>
 * fel-read / fel-write / fel-exec need extra arguments, so they
 * use the command-string form, documented in the wild
 * (termux-usb -r -e "<binary> <args>" <device>):
 *   termux-usb -r -e "<binary> 0x1000 16" <device>
 * The C tools accept the USB fd as argv[1] (v1 form), as the last
 * argv token (this form, where termux-usb appends the fd after the
 * command string), or via $TERMUX_USB_FD (-E form), and they also
 * accept FEL_ADDR / FEL_LEN / FEL_FILE from the environment.
 * PROVEN LIVE 2026-11-17: the UNQUOTED command-string form works
 * on this phone — both
 *   termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/006
 * and
 *   termux-usb -r -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/006
 * returned identical FEL_READ JSON (address 0x1000, length 16,
 * sha256 5b2402fa391d657a137b6d3f33ef97ff962b7d2cd5863276ae483946f3292191).
 * The SINGLE-QUOTED form the server originally built
 * (termux-usb -r -e "'<binary>' 0x1000 16" <device>) FAILED on
 * this phone with "fel_read did not return JSON" — termux-usb
 * does not strip the quotes, so the binary path was not found.
 * The server therefore builds the command string UNQUOTED
 * (see buildTermuxUsbCmd). A failure is reported, never faked.
 * See bridge/docs/SOURCES.md.
 *
 * The allowlist is enforced here AND in the C tools (fel_common.h);
 * neither layer trusts the other. Protected BROM regions
 * (IRQ stack 0x1C00-0x1FFF, stack 0x5C00-0x6FFF, the important
 * 0x7C00-0x7FFF region holding the FEL_VERSION scratchpad 0x7E00,
 * MMU table / thunk 0x8000-0xBFFF) are refused for generic writes.
 * The only exception is an SPL write starting exactly at
 * 0x00000000 with spl:true: upstream sunxi-fel loads the SPL there,
 * but only after swapping the protected regions to backup SRAM and
 * running a thunk to restore them. v2 does NOT implement that
 * swap/thunk, so an SPL write+exec in v2 is UNVERIFIED and may kill
 * FEL mid-transfer — and on 2026-11-17 it did: a v2 raw SPL write
 * to 0x0 left FEL_VERSION with no output at all until the device
 * was re-entered into FEL. DO NOT use the v2 spl:true form any
 * more; use POST /api/bridge/fel-spl-uboot (v3, fel_spl_uboot.c),
 * which implements the upstream swap/thunk faithfully.
 * See bridge/docs/SOURCES.md §6 and bridge/README.md.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { URL } = require('node:url');

const BRIDGE_DIR = __dirname;
const RUN_DIR = path.join(BRIDGE_DIR, 'run');
const REPORTS_DIR = path.join(BRIDGE_DIR, 'reports');
const LATEST_REPORT = path.join(RUN_DIR, 'latest-report.json');
const SESSION_FILE = path.join(RUN_DIR, 'session.json');
const USB_PROBE_BIN = path.join(__dirname, '..', 'usb_probe');
const FEL_VERSION_BIN = path.join(BRIDGE_DIR, 'fel_version');
const FEL_READ_BIN = path.join(BRIDGE_DIR, 'fel_read');
const FEL_WRITE_BIN = path.join(BRIDGE_DIR, 'fel_write');
const FEL_EXEC_BIN = path.join(BRIDGE_DIR, 'fel_exec');
const FEL_SPL_UBOOT_BIN = path.join(BRIDGE_DIR, 'fel_spl_uboot');
const VERSION = '3.3.0';
/* v3.3 fel_auto: at most 4 candidates per run (the phone user
 * picks them in the page; each full flow can take up to 60 s
 * plus diagnostics, so more would make one run unreasonably
 * long). The pattern bytes are the same HELLO-FEL-PATTERN
 * string the v2 pattern test writes (28 bytes; the UI label
 * says 16, the code uses the real length). */
const FEL_AUTO_MAX_CANDIDATES = 4;
const FEL_AUTO_PATTERN = Buffer.from('HELLO-FEL-PATTERN-0123456789', 'utf8');
const FEL_AUTO_PATTERN_SHA256 = crypto.createHash('sha256').update(FEL_AUTO_PATTERN).digest('hex');
const NODRAM_SHA256 = 'ce490280899193e292a2aa3d46f81be3e635f5b9cdc06fa655d678559ccce0db';

const HOST = '127.0.0.1';
if (process.env.BRIDGE_HOST && process.env.BRIDGE_HOST !== HOST) {
  // Refuse any non-localhost binding, loudly, before listening.
  console.error('refusing non-localhost binding: BRIDGE_HOST must be 127.0.0.1');
  process.exit(2);
}
const PORT = Number(process.env.BRIDGE_PORT || process.env.PORT || 3001);

const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
]);

/* --- H3 allowlist (mirrors fel_common.h; enforced in both layers) --- */
const SRAM_BASE = 0x00000000;
const SRAM_END = 0x00020000;
const SID_ADDR = 0x01C14200;
const SID_LEN = 16;
const SPL_ADDR = 0x00000000;
const SPL_LEN_LIMIT = 0x8000;
const FEL_READ_MAX_LEN = 4096;
const FEL_WRITE_MAX_LEN = 131072;
/* v3: full u-boot-sunxi-with-spl.bin. The current build is
 * 559,480 bytes; the UI refuses files over 600 KiB and so does
 * the server. */
const UB_MAX_FILE = 600 * 1024;
const UB_HEADER_SIZE = 64;
const UB_IH_MAGIC = 0x27051956;
const DRAM_BASE = 0x40000000;
const DRAM_SIZE = 0x80000000;
const PROTECTED_RANGES = [
  [0x1C00, 0x2000], // BROM IRQ stack
  [0x5C00, 0x7000], // BROM stack
  [0x7C00, 0x8000], // "something important"; FEL_VERSION scratchpad 0x7E00
  [0x8000, 0xC000], // MMU translation table (0x8000) + thunk (0xA200)
];

function inRange(addr, len, start, end) {
  return Number.isInteger(addr) && Number.isInteger(len) && len > 0 &&
    addr >= start && addr + len <= end;
}
function inSram(addr, len) { return inRange(addr, len, SRAM_BASE, SRAM_END); }
function inSid(addr, len) { return inRange(addr, len, SID_ADDR, SID_ADDR + SID_LEN); }
function readAllowed(addr, len) { return inSram(addr, len) || inSid(addr, len); }
function overlapsProtected(addr, len) {
  return PROTECTED_RANGES.some(([s, e]) => addr < e && addr + len > s);
}
function writeAllowed(addr, len, spl) {
  if (!Number.isInteger(len) || len < 1 || len > FEL_WRITE_MAX_LEN) return false;
  if (!inSram(addr, len)) return false;
  if (overlapsProtected(addr, len)) return Boolean(spl) && addr === SPL_ADDR;
  return true;
}

/* v3: server-side validation of a full u-boot-sunxi-with-spl.bin,
 * mirroring fel_spl_uboot.c (which re-validates before any write).
 * Returns { ok:true, spl_len, uboot_load, uboot_entry, uboot_size }
 * or { ok:false, error, message }. All arithmetic is unsigned
 * 32-bit (>>> 0), matching the C tool's uint32_t checksum. */
function le32(buf, off) {
  return buf.readUInt32LE(off);
}
function be32(buf, off) {
  return buf.readUInt32BE(off);
}
function validateFullUbootImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > UB_MAX_FILE) {
    return { ok: false, error: 'invalid_size',
      message: `full image must be 1..${UB_MAX_FILE} bytes (the current build is 559,480 bytes)` };
  }
  if (bytes.length <= SPL_LEN_LIMIT) {
    return { ok: false, error: 'no_uboot_proper',
      message: 'file must be a full u-boot-sunxi-with-spl.bin larger than 32768 bytes; an SPL-only file is refused here (use the v2 pattern test for SPL-only files, never the raw SPL write)' };
  }
  if (bytes.length < 32 || bytes.subarray(4, 12).toString('latin1') !== 'eGON.BT0') {
    return { ok: false, error: 'bad_egon',
      message: 'SPL: eGON header is not found (expected eGON.BT0 at offset 4, fel.c L1097)' };
  }
  const splLen = le32(bytes, 16);
  if (splLen > bytes.length || splLen % 4 !== 0) {
    return { ok: false, error: 'bad_spl_length',
      message: 'SPL: bad length in the eGON header (fel.c L1106)' };
  }
  if (splLen > SPL_LEN_LIMIT) {
    return { ok: false, error: 'spl_too_large',
      message: 'SPL: too large (need spl_len <= 32768, fel.c L1181)' };
  }
  let checksum = ((2 * le32(bytes, 12)) - 0x5F0A6C39) >>> 0;
  for (let i = 0; i < splLen / 4; i++) checksum = (checksum - le32(bytes, i * 4)) >>> 0;
  if (checksum !== 0) {
    return { ok: false, error: 'bad_checksum',
      message: 'SPL: checksum check failed (fel.c L1110-1117)' };
  }
  const h = bytes.subarray(SPL_LEN_LIMIT);
  if (h.length <= UB_HEADER_SIZE) {
    return { ok: false, error: 'bad_uboot_header',
      message: 'Invalid U-Boot image: bad size or signature' };
  }
  if (be32(h, 0) !== UB_IH_MAGIC) {
    return { ok: false, error: 'bad_uboot_header',
      message: 'Invalid U-Boot image: bad magic (expected 0x27051956)' };
  }
  if (h[29] !== 2) {
    return { ok: false, error: 'bad_uboot_header',
      message: 'Invalid U-Boot image: wrong architecture (expected ARM)' };
  }
  if (h[30] !== 5) {
    return { ok: false, error: 'bad_uboot_header',
      message: 'U-Boot image type mismatch: expected IH_TYPE_FIRMWARE' };
  }
  const dataSize = be32(h, 12);
  if (dataSize !== h.length - UB_HEADER_SIZE) {
    return { ok: false, error: 'bad_uboot_header',
      message: 'U-Boot image data size mismatch' };
  }
  const ubootLoad = be32(h, 16);
  const ubootEntry = be32(h, 20);
  if (ubootLoad < DRAM_BASE || ubootLoad >= DRAM_BASE + DRAM_SIZE ||
      ubootLoad + dataSize > DRAM_BASE + DRAM_SIZE) {
    return { ok: false, error: 'uboot_address_not_allowed',
      message: 'U-Boot load address is outside DRAM (0x40000000-0xc0000000)' };
  }
  return { ok: true, spl_len: splLen, uboot_load: ubootLoad,
    uboot_entry: ubootEntry, uboot_size: dataSize };
}

function parseAddress(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return value;
  if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value.trim())) {
    const n = Number(value.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return n;
  }
  return null;
}
function parseLength(value, max) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
  if (n === null || !Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}
function hexAddr(n) { return `0x${n.toString(16).padStart(8, '0')}`; }

/* --- Session: ranges written by FEL_WRITE in this bridge session --- */
let writtenRanges = [];
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (Array.isArray(parsed.written)) writtenRanges = parsed.written;
    }
  } catch { writtenRanges = []; }
}
function saveSession() {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ written: writtenRanges }, null, 2));
  } catch { /* session persistence must not fail the write */ }
}
function recordWrite(entry) {
  writtenRanges.push(entry);
  saveSession();
}
function execAllowed(addr) {
  return writtenRanges.some((r) => addr >= r.address && addr < r.address + r.length);
}
loadSession();

function send(res, status, body, req) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  const origin = req && req.headers && req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function commandExists(cmd) {
  try {
    const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0 && Boolean(r.stdout && r.stdout.trim());
  } catch {
    return false;
  }
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function latestReport() {
  try {
    if (!fs.existsSync(LATEST_REPORT)) return null;
    return JSON.parse(fs.readFileSync(LATEST_REPORT, 'utf8'));
  } catch {
    return null;
  }
}

function saveReport(report) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(LATEST_REPORT, JSON.stringify(report, null, 2));
  const stamp = new Date(report.generatedAt || Date.now())
    .toISOString().replace(/[:.]/g, '-');
  const kind = report.tool === 'fel_version' ? 'fel-version'
    : report.tool === 'fel_read' ? 'fel-read'
    : report.tool === 'fel_write' ? 'fel-write'
    : report.tool === 'fel_exec' ? 'fel-exec'
    : report.tool === 'fel_spl_uboot' ? 'fel-spl-uboot' : 'probe';
  fs.writeFileSync(
    path.join(REPORTS_DIR, `${stamp}-${kind}.json`),
    JSON.stringify(report, null, 2),
  );
}

const DEVICE_RE = /^\/dev\/bus\/usb\/\d{3}\/\d{3}$/;
function validateDevice(device) {
  return typeof device === 'string' && DEVICE_RE.test(device);
}

function listUsbDevices() {
  return new Promise((resolve) => {
    execFile('termux-usb', ['-l'], { timeout: 5000, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: 'termux-usb -l failed', detail: err.message });
        const text = String(stdout || '');
        let devices = [];
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) devices = parsed.map(String);
        } catch {
          devices = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
        devices = devices.filter((d) => DEVICE_RE.test(d));
        resolve({ ok: true, devices, raw: text.trim().slice(0, 500) });
      });
  });
}

async function resolveDevice(requested) {
  if (requested) {
    if (!validateDevice(requested)) {
      return { ok: false, status: 400, error: 'invalid_device',
        message: 'device must look like /dev/bus/usb/001/002' };
    }
    return { ok: true, device: requested };
  }
  const listed = await listUsbDevices();
  if (!listed.ok) {
    return { ok: false, status: 503, error: 'termux_usb_unavailable',
      message: 'termux-usb is not available; install Termux:API and run: termux-usb -l' };
  }
  if (listed.devices.length === 0) {
    return { ok: false, status: 404, error: 'no_usb_device',
      message: 'no USB device listed by termux-usb -l; connect the R69 in FEL mode and retry' };
  }
  if (listed.devices.length > 1) {
    return { ok: false, status: 400, error: 'device_required',
      message: 'more than one USB device is connected; pass the R69 device path explicitly',
      devices: listed.devices };
  }
  return { ok: true, device: listed.devices[0] };
}

/* v1 form, proven live on the phone: termux-usb -r -e <binary> <device> */
function runViaTermuxUsb(binary, device, timeoutMs) {
  return new Promise((resolve) => {
    execFile('termux-usb', ['-r', '-e', binary, device],
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          return resolve({ ok: false, status: 503, error: 'termux_usb_unavailable',
            message: 'termux-usb not found; install the termux-api package and the Termux:API app' });
        }
        if (err && err.killed) {
          return resolve({ ok: false, status: 504, error: 'device_timeout',
            message: `device did not answer within ${timeoutMs} ms` });
        }
        resolve({ ok: true, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

/*
 * Build the termux-usb command string for tools that need
 * arguments, UNQUOTED. The single-quoted form originally used
 * here FAILED live on the user's phone on 2026-11-17
 * ("fel_read did not return JSON"): termux-usb does not strip
 * the quotes, so the binary path was not resolved. The unquoted
 * form was proven live the same day, both with -E and without,
 * returning identical FEL_READ JSON for 0x1000 x16. See
 * bridge/docs/SOURCES.md.
 *
 * Safety: only server-validated tokens are ever interpolated —
 * a binary path, a hex address, a decimal length, a --flag, or
 * a server-made temp file path. Every token must match the safe
 * pattern below (letters, digits, '.', '_', '-', '/' only, plus
 * a leading 0x for hex); anything else (whitespace, quotes,
 * shell metacharacters, user free text) throws instead of being
 * quoted into the command. The C tools also accept the same
 * parameters from FEL_ADDR / FEL_LEN / FEL_FILE in the
 * environment, which the server still passes as a fallback.
 */
function buildTermuxUsbCmd(binary, args) {
  const SAFE_TOKEN = /^[A-Za-z0-9._\/-]+$/;
  for (const token of [binary, ...args]) {
    if (typeof token !== 'string' || !SAFE_TOKEN.test(token)) {
      throw new Error(`unsafe termux-usb command token: ${String(token)}`);
    }
  }
  return [binary, ...args].join(' ');
}

function runViaTermuxUsbCmd(binary, args, device, timeoutMs, envExtra) {
  const command = buildTermuxUsbCmd(binary, args);
  return new Promise((resolve) => {
    execFile('termux-usb', ['-r', '-e', command, device],
      { timeout: timeoutMs, maxBuffer: 512 * 1024,
        env: { ...process.env, ...(envExtra || {}) } },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          return resolve({ ok: false, status: 503, error: 'termux_usb_unavailable',
            message: 'termux-usb not found; install the termux-api package and the Termux:API app' });
        }
        if (err && err.killed) {
          return resolve({ ok: false, status: 504, error: 'device_timeout',
            message: `device did not answer within ${timeoutMs} ms` });
        }
        resolve({ ok: true, code: err ? err.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
  });
}

function parseToolJson(run) {
  try { return JSON.parse(run.stdout.trim()); } catch { return null; }
}

/* v3.1: fel_spl_uboot prints one progress JSON line per step, a
 * banner line, and the final result JSON as the LAST line. The
 * old parseToolJson (JSON.parse of the whole stdout) would fail
 * on that multi-line output, so this parser splits by lines:
 * progress lines have "progress":true, the banner has
 * "banner":true, and the final result is the last line that is a
 * JSON object with an "ok" field and neither flag. Returns
 * { final, progress, banner } with final null when no result line
 * was printed (the v3 silent-failure case — the progress lines
 * are then the only diagnosis, and they are returned too).
 * v3.2: the C tool mirrors every JSON line to stderr as well,
 * because on the phone on 2026-11-17 the full flow's stdout was
 * lost entirely (stdout "", progress []) while stderr survived.
 * This parser therefore scans stderr lines too (stdout first,
 * so a stdout line always wins), deduping progress lines by
 * step number — the same step appears once per stream. */
function parseSplUbootOutput(run) {
  const progress = [];
  const seenSteps = new Set();
  let banner = null;
  let final = null;
  for (const text of [run.stdout || '', run.stderr || '']) {
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      if (obj && obj.progress === true) {
        if (!seenSteps.has(obj.step)) { seenSteps.add(obj.step); progress.push(obj); }
        continue;
      }
      if (obj && obj.banner === true) { if (!banner) banner = obj; continue; }
      if (obj && typeof obj.ok === 'boolean' && !final) final = obj;
    }
  }
  progress.sort((a, b) => (a.step || 0) - (b.step || 0));
  return { final, progress, banner };
}

/* --- v3.3 fel_auto: automatic attempt driver ---
 * The driver is a deterministic decision tree, NOT a local LLM:
 * the intelligence is Muse in the cloud reading the run log.
 * It is written so the core (runFelAuto) can run in the VM
 * against a stub runner, while the real runner below uses the
 * same termux-usb helpers as the single-attempt endpoints.
 *
 * Runner interface (both real and stub):
 *   validateOnly(bytes) -> { transport?:boolean, parsed, progress, banner, error? }
 *   fullFlow(bytes)     -> same shape
 *   felVersion()        -> { ok, parsed? }
 *   patternTest()       -> { writeOk, readOk, match, readSha256, expectedSha256 }
 *   usbProbe()          -> { ok, vid?, pid?, endpoints? }
 * A runner result with transport:true means termux-usb itself
 * (or the binary) is unavailable — the run cannot proceed at
 * all, and the driver stops with TRANSPORT_ERROR instead of
 * burning candidates against a missing transport.
 *
 * Candidate classification (from the fel_spl_uboot final JSON):
 *   NEED_REENTRY — the flow died at step 4 fel_version_soc_check
 *     ("FEL_VERSION failed: device is not answering in FEL
 *     mode") or the step log stops right after
 *     validate_uboot_header with no fel_version_soc_check step.
 *     This is the exact shape of the 2026-11-17 no-DRAM run,
 *     which never wrote or executed anything. FEL is dead (or
 *     was never alive for this run); trying the next candidate
 *     against a dead FEL would only repeat the same failure,
 *     so the driver stops and tells the user to re-enter FEL
 *     and re-run. Diagnostics still run (FEL_VERSION x3 +
 *     usb_probe) to confirm the classification.
 *   EGON_READBACK_FAIL — the thunk ran (steps 0-12 ok) but the
 *     eGON.FEL read-back failed after 3 attempts. The 336 and
 *     300 MHz builds both failed this way on 2026-11-17.
 *   UBOOT_STAGE_FAIL — eGON.FEL read back, but staging U-Boot
 *     proper to DRAM failed. For a nodram candidate this is
 *     EXPECTED (DRAM was never initialised), see below.
 *   FLOW_FAIL — anything else (thunk exec, MMU, SPL write…).
 *
 * Outcomes: BOOT_SUCCESS | EXPECTED_UBOOT_STAGE_FAIL |
 * NEED_REENTRY | TRANSPORT_ERROR | EXHAUSTED. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyFelSplUbootFailure(parsed, progress) {
  if (!parsed) return 'FLOW_FAIL';
  const err = String(parsed.error || '');
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const prog = Array.isArray(progress) ? progress : [];
  const stepNames = new Set([...steps.map((s) => s.name), ...prog.map((s) => s.name)]);
  if (err.includes('FEL_VERSION failed') ||
      (steps.length > 0 && steps[steps.length - 1].name === 'validate_uboot_header' &&
        !stepNames.has('fel_version_soc_check'))) {
    return 'NEED_REENTRY';
  }
  if (err.includes('could not read back') || err.includes('egon_fel_readback') ||
      err.includes('FEL stopped answering after the thunk')) {
    return 'EGON_READBACK_FAIL';
  }
  if (err.includes('U-Boot staging') || err.includes('DRAM may not be initialised')) {
    return 'UBOOT_STAGE_FAIL';
  }
  return 'FLOW_FAIL';
}

function validateAutoCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length < 1) {
    return { ok: false, error: 'no_candidates',
      message: 'fel-auto needs 1..4 candidates, each {label, base64, sha256}' };
  }
  if (candidates.length > FEL_AUTO_MAX_CANDIDATES) {
    return { ok: false, error: 'too_many_candidates',
      message: `fel-auto accepts at most ${FEL_AUTO_MAX_CANDIDATES} candidates per run` };
  }
  const items = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] || {};
    const label = typeof c.label === 'string' && c.label.trim()
      ? c.label.trim().slice(0, 80) : `candidate-${i + 1}`;
    if (typeof c.base64 !== 'string' || !c.base64) {
      return { ok: false, error: 'invalid_data', message: `candidate ${label}: base64 data is required` };
    }
    let bytes;
    try { bytes = Buffer.from(c.base64, 'base64'); } catch {
      return { ok: false, error: 'invalid_data', message: `candidate ${label}: base64 could not be decoded` };
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (typeof c.sha256 !== 'string' || c.sha256.toLowerCase() !== sha256) {
      return { ok: false, error: 'sha256_mismatch',
        message: `candidate ${label}: sha256 does not match the base64 data; refused before touching the device`,
        expected: sha256 };
    }
    const validated = validateFullUbootImage(bytes);
    if (!validated.ok) {
      return { ok: false, error: validated.error,
        message: `candidate ${label}: ${validated.message}` };
    }
    const nodram = c.nodram === true ||
      /nodram/i.test(label) || sha256 === NODRAM_SHA256;
    items.push({ label, nodram, bytes, sha256, validated });
  }
  return { ok: true, items };
}

/* Diagnostics run after a failed attempt (and, for NEED_REENTRY,
 * to confirm FEL really is dead). FEL_VERSION x3 with 5 s gaps:
 * FEL_VERSION is intermittent on this phone, so one silence
 * proves nothing. Pattern write/read-back at 0x1000 proves the
 * bulk path is still alive; usb_probe proves USB enumeration
 * still works (control transfers) even when FEL bulk is dead. */
async function runFelAutoDiagnostics(runner, sleepMs, emit) {
  const felVersionAttempts = [];
  for (let i = 0; i < 3; i++) {
    let r;
    try { r = await runner.felVersion(); } catch (e) { r = { ok: false, error: e.message }; }
    felVersionAttempts.push({ attempt: i + 1, ok: Boolean(r && r.ok),
      soc_id_hex: r && r.parsed ? (r.parsed.soc_id_hex || null) : null });
    emit({ type: 'diagnostic', name: 'fel_version', attempt: i + 1, ok: Boolean(r && r.ok) });
    if (i < 2) await sleep(sleepMs);
  }
  let pattern;
  try { pattern = await runner.patternTest(); } catch (e) { pattern = { writeOk: false, readOk: false, match: false, error: e.message }; }
  emit({ type: 'diagnostic', name: 'pattern', ok: Boolean(pattern && pattern.match), detail: pattern });
  let probe;
  try { probe = await runner.usbProbe(); } catch (e) { probe = { ok: false, error: e.message }; }
  emit({ type: 'diagnostic', name: 'usb_probe', ok: Boolean(probe && probe.ok), detail: probe });
  return { felVersionAttempts, pattern, probe };
}

async function runFelAuto({ device, candidates, runner, sleepMs = 5000, onEvent = () => {}, isStopped = () => false }) {
  const startedAt = new Date().toISOString();
  const logLines = [];
  const emit = (event) => {
    const line = `[${new Date().toISOString()}] ${event.type}: ${JSON.stringify(event)}`;
    logLines.push(line);
    onEvent(event);
  };
  const results = [];
  let outcome = 'EXHAUSTED';
  let outcomeDetail = '';
  for (let idx = 0; idx < candidates.length; idx++) {
    if (isStopped()) { outcome = 'STOPPED'; outcomeDetail = 'Stopped by the user before candidate ' + (idx + 1); break; }
    const cand = candidates[idx];
    emit({ type: 'candidate_start', index: idx, label: cand.label, sha256: cand.sha256, nodram: cand.nodram });
    const result = { index: idx, label: cand.label, sha256: cand.sha256, nodram: cand.nodram, status: null };
    results.push(result);
    // 1) validate-only first: file + FEL_VERSION/soc, no write.
    let vo;
    try { vo = await runner.validateOnly(cand.bytes); } catch (e) { vo = { transport: false, parsed: null, error: e.message }; }
    if (vo.transport) {
      result.status = 'SKIPPED';
      result.reason = 'transport_error: termux-usb or fel_spl_uboot is unavailable; no candidate can run';
      outcome = 'TRANSPORT_ERROR';
      outcomeDetail = result.reason;
      emit({ type: 'candidate_result', index: idx, label: cand.label, status: result.status, reason: result.reason });
      break;
    }
    if (!vo.parsed || !vo.parsed.ok) {
      const kind = classifyFelSplUbootFailure(vo.parsed, vo.progress);
      result.validateOnly = { ok: false, error: vo.parsed ? vo.parsed.error : (vo.error || 'no result'), kind };
      emit({ type: 'candidate_result', index: idx, label: cand.label, status: 'VALIDATE_FAILED', kind, error: result.validateOnly.error });
      if (kind === 'NEED_REENTRY') {
        result.status = 'NEED_REENTRY';
        result.diagnostics = await runFelAutoDiagnostics(runner, sleepMs, emit);
        outcome = 'NEED_REENTRY';
        outcomeDetail = 'FEL was not answering at fel_version_soc_check (step 4) before any write. Re-enter FEL (power off, hold the reset pin in the AV port, connect USB, release), confirm FEL_VERSION answers, then re-run fel-auto. Do not retry against a dead FEL.';
        break;
      }
      result.status = 'SKIPPED';
      result.reason = `validate-only failed (${kind}); candidate skipped, moving to the next candidate`;
      continue;
    }
    result.validateOnly = { ok: true };
    emit({ type: 'candidate_validated', index: idx, label: cand.label });
    if (isStopped()) { outcome = 'STOPPED'; outcomeDetail = 'Stopped by the user after validate-only for ' + cand.label; break; }
    // 2) full flow: SPL write + thunk + eGON.FEL + U-Boot staging + exec.
    let flow;
    try { flow = await runner.fullFlow(cand.bytes); } catch (e) { flow = { transport: false, parsed: null, error: e.message }; }
    if (flow.transport) {
      result.status = 'SKIPPED';
      result.reason = 'transport_error during the full flow';
      outcome = 'TRANSPORT_ERROR';
      outcomeDetail = result.reason;
      emit({ type: 'candidate_result', index: idx, label: cand.label, status: result.status, reason: result.reason });
      break;
    }
    result.steps = flow.parsed && Array.isArray(flow.parsed.steps) ? flow.parsed.steps : [];
    result.progress = flow.progress || [];
    if (flow.parsed && flow.parsed.ok) {
      result.status = 'BOOT_SUCCESS';
      result.detail = flow.parsed;
      outcome = 'BOOT_SUCCESS';
      outcomeDetail = `SPL + U-Boot flow completed for ${cand.label} (eGON.FEL read back, U-Boot staged and exec sent). Re-check FEL_VERSION: a reply means U-Boot did not take over.`;
      emit({ type: 'candidate_result', index: idx, label: cand.label, status: 'BOOT_SUCCESS' });
      break;
    }
    const kind = classifyFelSplUbootFailure(flow.parsed, flow.progress);
    result.failureKind = kind;
    result.error = flow.parsed ? flow.parsed.error : (flow.error || 'no result');
    emit({ type: 'candidate_result', index: idx, label: cand.label, status: 'FAILED', kind, error: result.error });
    if (kind === 'NEED_REENTRY') {
      result.status = 'NEED_REENTRY';
      result.diagnostics = await runFelAutoDiagnostics(runner, sleepMs, emit);
      outcome = 'NEED_REENTRY';
      outcomeDetail = 'FEL stopped answering at fel_version_soc_check (step 4). Re-enter FEL (power off, hold the reset pin in the AV port, connect USB, release), confirm FEL_VERSION answers, then re-run fel-auto.';
      break;
    }
    if (kind === 'UBOOT_STAGE_FAIL' && cand.nodram) {
      // Decisive for the nodram test: eGON.FEL read back (the
      // SPL ran and returned), but staging U-Boot to DRAM cannot
      // work because this SPL never initialised DRAM. That is
      // the expected result for a nodram candidate, not a boot
      // failure — and it proves DRAM init was NOT the thing
      // killing FEL (FEL stayed alive past the thunk). Stop
      // here: the next candidate needs a human decision.
      result.status = 'EXPECTED_UBOOT_STAGE_FAIL';
      outcome = 'EXPECTED_UBOOT_STAGE_FAIL';
      outcomeDetail = `eGON.FEL read back for the nodram candidate ${cand.label} — the SPL ran and returned, so DRAM init was not killing FEL. U-Boot staging to DRAM then failed as expected, because this SPL never initialised DRAM. Stop here and report this to Muse: the next step is a no-CPU-clock-raise build or a single-variable ZQ/CLK build, not another blind retry.`;
      emit({ type: 'candidate_result', index: idx, label: cand.label, status: 'EXPECTED_UBOOT_STAGE_FAIL' });
      break;
    }
    // EGON_READBACK_FAIL / FLOW_FAIL / UBOOT_STAGE_FAIL
    // (non-nodram): run diagnostics, then move on.
    result.diagnostics = await runFelAutoDiagnostics(runner, sleepMs, emit);
    result.status = 'FAILED';
    if (isStopped()) { outcome = 'STOPPED'; outcomeDetail = 'Stopped by the user after diagnostics for ' + cand.label; break; }
  }
  if (outcome === 'EXHAUSTED') {
    outcomeDetail = 'All candidates were tried and none booted. Send the run log to Muse; do not re-run the same files.';
  }
  const finishedAt = new Date().toISOString();
  const run = { ok: outcome === 'BOOT_SUCCESS', outcome, outcomeDetail, device,
    startedAt, finishedAt, candidates: results, logLines };
  emit({ type: 'run_finished', outcome, outcomeDetail });
  return run;
}

function saveFelAutoLog(run) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
    const base = path.join(RUN_DIR, `fel-auto-${stamp}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
    const human = [
      `fel-auto run ${run.startedAt} -> ${run.finishedAt}`,
      `device: ${run.device}`,
      `outcome: ${run.outcome}`,
      run.outcomeDetail,
      '',
      ...run.candidates.map((c) => `- ${c.label} (${c.sha256.slice(0, 12)}…): ${c.status}${c.failureKind ? ` [${c.failureKind}]` : ''}${c.error ? ` — ${c.error}` : ''}`),
      '',
      ...run.logLines,
    ].join('\n');
    fs.writeFileSync(`${base}.log`, human);
    return { json: `${base}.json`, log: `${base}.log` };
  } catch { return null; }
}

/* Real runner: the same termux-usb helpers the single-attempt
 * endpoints use. Each attempt writes its candidate bytes to a
 * server temp file and deletes it afterwards. */
function buildFelAutoRunner(device) {
  async function runSplUboot(bytes, validateOnly) {
    if (!fileExists(FEL_SPL_UBOOT_BIN)) {
      return { transport: true, parsed: null, progress: [], banner: null, error: 'fel_spl_uboot_not_built' };
    }
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const tmpFile = path.join(RUN_DIR, `fel-auto-${Date.now()}-${sha.slice(0, 8)}.bin`);
    let run;
    try {
      fs.writeFileSync(tmpFile, bytes);
      run = await runViaTermuxUsbCmd(FEL_SPL_UBOOT_BIN,
        [tmpFile, ...(validateOnly ? ['--validate-only'] : [])],
        device, validateOnly ? 10000 : 60000,
        { FEL_FILE: tmpFile, ...(validateOnly ? { FEL_VALIDATE_ONLY: '1' } : {}) });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
    }
    if (!run.ok) return { transport: true, parsed: null, progress: [], banner: null, error: run.error || run.message };
    const out = parseSplUbootOutput(run);
    return { transport: false, parsed: out.final, progress: out.progress, banner: out.banner };
  }
  return {
    validateOnly: (bytes) => runSplUboot(bytes, true),
    fullFlow: (bytes) => runSplUboot(bytes, false),
    felVersion: async () => {
      if (!fileExists(FEL_VERSION_BIN)) return { ok: false, error: 'fel_version_not_built' };
      const run = await runViaTermuxUsb(FEL_VERSION_BIN, device, 5000);
      if (!run.ok) return { ok: false, error: run.error || run.message };
      const parsed = parseToolJson(run);
      if (!parsed || run.code !== 0 || !parsed.ok) return { ok: false, parsed: parsed || null };
      return { ok: true, parsed };
    },
    patternTest: async () => {
      if (!fileExists(FEL_WRITE_BIN) || !fileExists(FEL_READ_BIN)) {
        return { writeOk: false, readOk: false, match: false, error: 'fel_write/fel_read not built' };
      }
      fs.mkdirSync(RUN_DIR, { recursive: true });
      const tmpFile = path.join(RUN_DIR, `fel-auto-pattern-${Date.now()}.bin`);
      let writeParsed = null;
      try {
        fs.writeFileSync(tmpFile, FEL_AUTO_PATTERN);
        const w = await runViaTermuxUsbCmd(FEL_WRITE_BIN, ['0x00001000', tmpFile],
          device, 30000, { FEL_ADDR: '0x00001000', FEL_FILE: tmpFile });
        writeParsed = w.ok ? parseToolJson(w) : null;
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
      }
      const writeOk = Boolean(writeParsed && writeParsed.ok);
      const r = await runViaTermuxUsbCmd(FEL_READ_BIN, ['0x00001000', String(FEL_AUTO_PATTERN.length)],
        device, 10000, { FEL_ADDR: '0x00001000', FEL_LEN: String(FEL_AUTO_PATTERN.length) });
      const readParsed = r.ok ? parseToolJson(r) : null;
      const readOk = Boolean(readParsed && readParsed.ok);
      const readSha256 = readParsed && readParsed.sha256 ? readParsed.sha256 : null;
      return { writeOk, readOk, match: writeOk && readOk && readSha256 === FEL_AUTO_PATTERN_SHA256,
        readSha256, expectedSha256: FEL_AUTO_PATTERN_SHA256 };
    },
    usbProbe: async () => {
      if (!fileExists(USB_PROBE_BIN)) return { ok: false, error: 'usb_probe_not_built' };
      const run = await runViaTermuxUsb(USB_PROBE_BIN, device, 10000);
      if (!run.ok || run.code !== 0) return { ok: false, error: run.error || run.message };
      return { ok: true, ...parseProbeOutput(run.stdout) };
    },
  };
}

/* Stop flags for in-flight fel-auto runs (the page's Stop
 * button). The driver checks the flag between candidates and
 * after validate-only; a run already inside a 60 s full-flow
 * attempt finishes that attempt, then stops. */
const felAutoStopFlags = new Set();

function parseProbeOutput(stdout) {
  const vidPid = stdout.match(/VID:PID\s+([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})/);
  const get = (label) => {
    const m = stdout.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const endpoints = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/Endpoint\s+([0-9A-Fa-f]{2})\s+Attributes\s+([0-9A-Fa-f]{2})\s+MaxPacket\s+(\d+)/);
    if (m) endpoints.push({ address: `0x${m[1]}`, attributes: `0x${m[2]}`, maxPacketSize: Number(m[3]) });
  }
  return {
    vid: vidPid ? `0x${vidPid[1].toLowerCase()}` : null,
    pid: vidPid ? `0x${vidPid[2].toLowerCase()}` : null,
    manufacturer: get('Manufacturer'),
    product: get('Product'),
    serial: get('Serial'),
    endpoints,
  };
}

function statusBody() {
  return {
    ok: true,
    bridge: 'artemis-termux-bridge/v3',
    version: VERSION,
    mode: 'read-write-sram-only+spl-uboot+fel-auto',
    host: HOST,
    port: PORT,
    felWriteEnabled: true,
    felExecEnabled: true,
    felSplUbootAvailable: fileExists(FEL_SPL_UBOOT_BIN),
    felAutoAvailable: fileExists(FEL_SPL_UBOOT_BIN),
    emmcWriteEnabled: false,
    termuxUsbAvailable: commandExists('termux-usb'),
    usbProbeAvailable: fileExists(USB_PROBE_BIN),
    felVersionAvailable: fileExists(FEL_VERSION_BIN),
    felReadAvailable: fileExists(FEL_READ_BIN),
    felWriteAvailable: fileExists(FEL_WRITE_BIN),
    felExecAvailable: fileExists(FEL_EXEC_BIN),
    sunxiFelAvailable: commandExists('sunxi-fel'),
    writtenRanges: writtenRanges.length,
    latestReport: latestReport() ? { exists: true, generatedAt: latestReport().generatedAt || null } : { exists: false },
    note: 'v3.1: FEL_READ (SRAM + SID only), FEL_WRITE and FEL_EXEC are SRAM-only (0x00000000-0x00020000). SPL + U-Boot staging (POST /api/bridge/fel-spl-uboot) implements the upstream sunxi-fel stack swap + thunk (fel.c aw_fel_write_and_execute_spl) and stages U-Boot proper in DRAM at its mkimage load address; eMMC / flash / NAND writing is still disabled: there is no endpoint for it. FEL_EXEC requires a prior FEL_WRITE in this session. The v2 raw SPL write (fel-write spl:true) is DEPRECATED: it killed FEL on 2026-11-17. Use fel-spl-uboot instead. v3.2: fel_spl_uboot mirrors every progress/final JSON line to stderr too and retries the eGON.FEL read-back 3 times (on 2026-11-17 the full flow stdout was lost entirely while stderr survived, and the single read-back attempt failed though FEL_VERSION itself is intermittent on this phone), and fel-spl-uboot accepts validate_only:true, which validates the file + FEL_VERSION/soc and exits without any write or exec — run that first. v3.3: fel-auto (POST /api/bridge/fel-auto) tries an ordered list of up to 4 candidate full images — validate-only first per candidate, then the full flow, diagnostics after a failure (FEL_VERSION x3, pattern write/read-back at 0x1000, usb_probe) — and moves to the next candidate without stopping at each error. It stops only for NEED_REENTRY (FEL not answering at step 4 — re-enter FEL manually and re-run), BOOT_SUCCESS, EXPECTED_UBOOT_STAGE_FAIL (nodram candidate: eGON.FEL read back, DRAM staging failed as expected because DRAM was never initialised), exhaustion, transport failure, or the user pressing Stop. No local LLM is involved: the driver is a deterministic decision tree and Muse reads the run log.',
  };
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      });
      return res.end();
    }
    return send(res, 403, { ok: false, error: 'origin_not_allowed' }, req);
  }

  if (req.method === 'GET' && url.pathname === '/api/bridge/status') {
    return send(res, 200, statusBody(), req);
  }
  if (req.method === 'GET' && url.pathname === '/api/bridge/session') {
    return send(res, 200, { ok: true, written: writtenRanges }, req);
  }
  if (req.method === 'GET' && url.pathname === '/api/bridge/report') {
    const report = latestReport();
    if (!report) return send(res, 404, { ok: false, error: 'no_report_yet',
      message: 'no probe has run yet; POST /api/bridge/probe first' }, req);
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/probe') {
    let body = {};
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (!fileExists(USB_PROBE_BIN)) {
      return send(res, 501, { ok: false, error: 'usb_probe_not_built',
        message: 'usb_probe binary not found; run bridge/termux-setup.sh first' }, req);
    }
    const run = await runViaTermuxUsb(USB_PROBE_BIN, resolved.device, 10000);
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    if (run.code !== 0) {
      return send(res, 502, { ok: false, error: 'usb_probe_failed',
        message: 'usb_probe exited non-zero; check the device is in FEL mode and permission was granted',
        stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) }, req);
    }
    const parsed = parseProbeOutput(run.stdout);
    const report = {
      ok: true, tool: 'usb_probe', version: 1,
      generatedAt: new Date().toISOString(),
      device: resolved.device, ...parsed, rawOutput: run.stdout,
      felVersionRead: false, felWriteEnabled: false, felExecEnabled: false,
    };
    try { saveReport(report); } catch { /* report saving must not fail the probe */ }
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-version') {
    let body = {};
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (!fileExists(FEL_VERSION_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_version_not_built',
        message: 'fel_version binary not found; run bridge/termux-setup.sh first. FEL_VERSION is not implemented until that binary exists.' }, req);
    }
    const run = await runViaTermuxUsb(FEL_VERSION_BIN, resolved.device, 5000);
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    const parsed = parseToolJson(run);
    if (!parsed) {
      return send(res, 502, { ok: false, error: 'fel_version_bad_output',
        message: 'fel_version did not return JSON', stdout: run.stdout.slice(0, 2000) }, req);
    }
    if (run.code !== 0 || !parsed.ok) {
      return send(res, 502, { ok: false, error: 'fel_version_failed', detail: parsed }, req);
    }
    const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device };
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-read') {
    let body = {};
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    const address = parseAddress(body.address);
    const length = parseLength(body.length, FEL_READ_MAX_LEN);
    if (address === null) {
      return send(res, 400, { ok: false, error: 'invalid_address',
        message: 'address must be a hex (0x...) or decimal integer' }, req);
    }
    if (length === null) {
      return send(res, 400, { ok: false, error: 'invalid_length',
        message: 'length must be an integer 1..4096' }, req);
    }
    if (!readAllowed(address, length)) {
      return send(res, 403, { ok: false, error: 'address_not_allowed',
        message: 'fel_read is allowed only for h3 sram 0x00000000-0x00020000 and sid 0x01c14200-0x01c14210; dram (0x40000000) is never read before it is initialised',
        address: hexAddr(address), length }, req);
    }
    if (!fileExists(FEL_READ_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_read_not_built',
        message: 'fel_read binary not found; run bridge/termux-setup.sh first' }, req);
    }
    const run = await runViaTermuxUsbCmd(FEL_READ_BIN, [hexAddr(address), String(length)],
      resolved.device, 10000, { FEL_ADDR: hexAddr(address), FEL_LEN: String(length) });
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    const parsed = parseToolJson(run);
    if (!parsed) {
      return send(res, 502, { ok: false, error: 'fel_read_bad_output',
        message: 'fel_read did not return JSON; the termux-usb command-string form may not work on this phone, see bridge/README.md for the direct Termux fallback',
        stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) }, req);
    }
    if (run.code !== 0 || !parsed.ok) {
      return send(res, 502, { ok: false, error: 'fel_read_failed', detail: parsed }, req);
    }
    const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device };
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-write') {
    let body = {};
    try { body = await readJson(req, 262144); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (body.confirm !== true) {
      return send(res, 400, { ok: false, error: 'confirm_required',
        message: 'fel-write requires confirm:true in the request body' }, req);
    }
    const address = parseAddress(body.address);
    if (address === null) {
      return send(res, 400, { ok: false, error: 'invalid_address',
        message: 'address must be a hex (0x...) or decimal integer' }, req);
    }
    if (typeof body.base64 !== 'string' || !body.base64) {
      return send(res, 400, { ok: false, error: 'invalid_data',
        message: 'base64 data is required' }, req);
    }
    let bytes;
    try { bytes = Buffer.from(body.base64, 'base64'); } catch {
      return send(res, 400, { ok: false, error: 'invalid_data', message: 'base64 could not be decoded' }, req);
    }
    if (bytes.length < 1 || bytes.length > FEL_WRITE_MAX_LEN) {
      return send(res, 400, { ok: false, error: 'invalid_size',
        message: 'data must be 1..131072 bytes' }, req);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (typeof body.sha256 !== 'string' || body.sha256.toLowerCase() !== sha256) {
      return send(res, 400, { ok: false, error: 'sha256_mismatch',
        message: 'sha256 does not match the base64 data; the upload was refused before touching the device',
        expected: sha256 }, req);
    }
    const spl = body.spl === true;
    if (spl && address !== SPL_ADDR) {
      return send(res, 400, { ok: false, error: 'invalid_spl_address',
        message: 'spl writes must start at the spl load address 0x00000000' }, req);
    }
    if (spl && bytes.length > SPL_LEN_LIMIT) {
      return send(res, 400, { ok: false, error: 'spl_too_large',
        message: 'spl must be at most 32768 bytes (SPL_LEN_LIMIT 0x8000)' }, req);
    }
    if (!writeAllowed(address, bytes.length, spl)) {
      return send(res, 403, { ok: false, error: 'address_not_allowed',
        message: 'fel_write is sram-only (0x00000000-0x00020000); protected brom regions (stacks, 0x7c00-0x7fff, mmu/thunk 0x8000-0xbfff) are refused unless this is an spl write at 0x00000000',
        address: hexAddr(address), length: bytes.length }, req);
    }
    if (!fileExists(FEL_WRITE_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_write_not_built',
        message: 'fel_write binary not found; run bridge/termux-setup.sh first' }, req);
    }
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const tmpFile = path.join(RUN_DIR, `fel-write-${Date.now()}-${sha256.slice(0, 8)}.bin`);
    let run;
    try {
      fs.writeFileSync(tmpFile, bytes);
      run = await runViaTermuxUsbCmd(FEL_WRITE_BIN,
        [hexAddr(address), tmpFile, ...(spl ? ['--spl'] : [])],
        resolved.device, 30000,
        { FEL_ADDR: hexAddr(address), FEL_FILE: tmpFile });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
    }
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    const parsed = parseToolJson(run);
    if (!parsed) {
      return send(res, 502, { ok: false, error: 'fel_write_bad_output',
        message: 'fel_write did not return JSON; the termux-usb command-string form may not work on this phone, see bridge/README.md for the direct Termux fallback',
        stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) }, req);
    }
    if (run.code !== 0 || !parsed.ok) {
      return send(res, 502, { ok: false, error: 'fel_write_failed', detail: parsed }, req);
    }
    const entry = {
      address, address_hex: hexAddr(address), length: bytes.length,
      sha256, spl, writtenAt: new Date().toISOString(), device: resolved.device,
    };
    recordWrite(entry);
    const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device, session: entry };
    if (spl) {
      report.warning = 'DEPRECATED: the v2 raw SPL write killed FEL on 2026-11-17. Use POST /api/bridge/fel-spl-uboot (v3, upstream stack swap + thunk) for SPL upload instead; do not exec this SPL with fel-exec.';
    }
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-spl-uboot') {
    // v3.1: one flow — validate the full u-boot-sunxi-with-spl.bin
    // server-side, then run fel_spl_uboot (upstream SPL swap/thunk
    // + eGON.FEL check + U-Boot staging in DRAM + exec). The C tool
    // re-validates the file before touching the device.
    // validate_only:true runs the C tool with --validate-only:
    // file validation + FEL_VERSION/soc check only, no write or
    // exec, 10 s timeout. Run it FIRST on the phone: v3 printed
    // nothing at all on 2026-11-17, and validate-only isolates
    // "tool/transport broken" from "device fails during the flow".
    let body = {};
    try { body = await readJson(req, 1024 * 1024); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (body.confirm !== true) {
      return send(res, 400, { ok: false, error: 'confirm_required',
        message: 'fel-spl-uboot requires confirm:true in the request body' }, req);
    }
    const validateOnly = body.validate_only === true;
    if (typeof body.base64 !== 'string' || !body.base64) {
      return send(res, 400, { ok: false, error: 'invalid_data',
        message: 'base64 data is required' }, req);
    }
    let bytes;
    try { bytes = Buffer.from(body.base64, 'base64'); } catch {
      return send(res, 400, { ok: false, error: 'invalid_data', message: 'base64 could not be decoded' }, req);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (typeof body.sha256 !== 'string' || body.sha256.toLowerCase() !== sha256) {
      return send(res, 400, { ok: false, error: 'sha256_mismatch',
        message: 'sha256 does not match the base64 data; the upload was refused before touching the device',
        expected: sha256 }, req);
    }
    const validated = validateFullUbootImage(bytes);
    if (!validated.ok) {
      return send(res, 400, { ok: false, error: validated.error, message: validated.message }, req);
    }
    if (!fileExists(FEL_SPL_UBOOT_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_spl_uboot_not_built',
        message: 'fel_spl_uboot binary not found; run bridge/termux-setup.sh first' }, req);
    }
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const tmpFile = path.join(RUN_DIR, `fel-spl-uboot-${Date.now()}-${sha256.slice(0, 8)}.bin`);
    let run;
    try {
      fs.writeFileSync(tmpFile, bytes);
      // 60 s timeout for the full flow: SPL write, thunk exec,
      // 250 ms wait, eGON.FEL read-back and ~527 KiB DRAM staging
      // in 64 KiB chunks. 10 s for validate-only (validation +
      // FEL_VERSION only). The C tool reports every step as an
      // incremental progress line; parseSplUbootOutput extracts
      // those lines plus the final result line.
      run = await runViaTermuxUsbCmd(FEL_SPL_UBOOT_BIN,
        [tmpFile, ...(validateOnly ? ['--validate-only'] : [])],
        resolved.device, validateOnly ? 10000 : 60000,
        { FEL_FILE: tmpFile, ...(validateOnly ? { FEL_VALIDATE_ONLY: '1' } : {}) });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* best effort cleanup */ }
    }
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    const splOut = parseSplUbootOutput(run);
    const parsed = splOut.final;
    if (!parsed) {
      return send(res, 502, { ok: false, error: 'fel_spl_uboot_bad_output',
        message: 'fel_spl_uboot did not return JSON; the termux-usb command-string form may not work on this phone, see bridge/README.md for the direct Termux fallback',
        stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000),
        progress: splOut.progress, banner: splOut.banner }, req);
    }
    if (run.code !== 0 || !parsed.ok) {
      // The step log is the diagnosis: return it in full, including
      // the eGON.FEL read-back result, so the user can report it.
      // v3.1: also return the incremental progress lines, which
      // survive even when the final JSON is missing a step.
      return send(res, 502, { ok: false, error: 'fel_spl_uboot_failed', detail: parsed,
        message: 'fel-spl-uboot stopped before or during the SPL/U-Boot flow; check the step log in detail.steps, then re-check FEL_VERSION (a reply means FEL is still alive)',
        progress: splOut.progress, banner: splOut.banner }, req);
    }
    if (validateOnly) {
      // No write happened, so nothing is recorded in the session.
      const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device,
        validated, progress: splOut.progress, banner: splOut.banner };
      try { saveReport(report); } catch { /* see probe */ }
      return send(res, 200, report, req);
    }
    // Record the SPL range as written in this session, so a later
    // fel-exec at 0x00000000 is allowed by the session gate.
    const entry = {
      address: SPL_ADDR, address_hex: hexAddr(SPL_ADDR), length: validated.spl_len,
      sha256: crypto.createHash('sha256').update(bytes.subarray(0, validated.spl_len)).digest('hex'),
      spl: true, uboot: true, writtenAt: new Date().toISOString(), device: resolved.device,
    };
    recordWrite(entry);
    const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device,
      session: entry, validated, progress: splOut.progress, banner: splOut.banner };
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-auto/stop') {
    let body = {};
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const runId = typeof body.runId === 'string' ? body.runId : null;
    if (!runId) return send(res, 400, { ok: false, error: 'invalid_run_id', message: 'runId is required' }, req);
    felAutoStopFlags.add(runId);
    return send(res, 200, { ok: true, runId, stopped: true,
      message: 'Stop requested: the driver will stop after the current attempt finishes (at most 60 s) and before the next candidate.' }, req);
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-auto') {
    // v3.3: automatic attempt driver. Validates every candidate
    // server-side (SHA-256 + eGON + mkimage, same as fel-spl-uboot)
    // BEFORE any device access, then runs runFelAuto with the real
    // runner. The response is NDJSON: one JSON line per progress
    // event as it happens, and the last line is
    // {"type":"final", ...run} with the full run log. The page
    // reads the stream and renders events live; a plain fetch
    // .json() on this endpoint will fail — read it line by line.
    // A run can take minutes (up to 4 candidates x 60 s flow +
    // diagnostics), so there is no fixed HTTP timeout here: the
    // driver itself bounds each attempt.
    let body = {};
    try { body = await readJson(req, 5 * 1024 * 1024); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (body.confirm !== true) {
      return send(res, 400, { ok: false, error: 'confirm_required',
        message: 'fel-auto requires confirm:true in the request body' }, req);
    }
    const checked = validateAutoCandidates(body.candidates);
    if (!checked.ok) {
      return send(res, 400, { ok: false, error: checked.error, message: checked.message, expected: checked.expected }, req);
    }
    if (!fileExists(FEL_SPL_UBOOT_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_spl_uboot_not_built',
        message: 'fel_spl_uboot binary not found; run bridge/termux-setup.sh first' }, req);
    }
    const runId = `fel-auto-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    const writeEvent = (event) => {
      try { res.write(JSON.stringify(event) + '\n'); } catch { /* client went away */ }
    };
    writeEvent({ type: 'run_start', runId, device: resolved.device,
      candidates: checked.items.map((c) => ({ label: c.label, sha256: c.sha256, nodram: c.nodram })) });
    try {
      const runner = buildFelAutoRunner(resolved.device);
      const run = await runFelAuto({
        device: resolved.device,
        candidates: checked.items,
        runner,
        sleepMs: 5000,
        onEvent: writeEvent,
        isStopped: () => felAutoStopFlags.has(runId),
      });
      felAutoStopFlags.delete(runId);
      const logFiles = saveFelAutoLog(run);
      if (run.ok) {
        // Record the SPL range as written in this session, as
        // the fel-spl-uboot endpoint does.
        const winner = checked.items[run.candidates.findIndex((c) => c.status === 'BOOT_SUCCESS')] ||
          checked.items[0];
        recordWrite({
          address: SPL_ADDR, address_hex: hexAddr(SPL_ADDR),
          length: winner.validated.spl_len,
          sha256: crypto.createHash('sha256').update(winner.bytes.subarray(0, winner.validated.spl_len)).digest('hex'),
          spl: true, uboot: true, felAuto: true,
          writtenAt: new Date().toISOString(), device: resolved.device,
        });
      }
      writeEvent({ type: 'final', runId, logFiles, ...run });
    } catch (e) {
      felAutoStopFlags.delete(runId);
      writeEvent({ type: 'final', runId, ok: false, outcome: 'DRIVER_ERROR',
        outcomeDetail: `fel-auto driver error: ${e.message}`, device: resolved.device,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        candidates: [], logLines: [] });
    }
    return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/bridge/fel-exec') {
    let body = {};
    try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: 'invalid_json' }, req); }
    const resolved = await resolveDevice(body.device);
    if (!resolved.ok) return send(res, resolved.status, { ok: false, error: resolved.error, message: resolved.message, devices: resolved.devices }, req);
    if (body.confirm !== true) {
      return send(res, 400, { ok: false, error: 'confirm_required',
        message: 'fel-exec requires confirm:true in the request body' }, req);
    }
    const address = parseAddress(body.address);
    if (address === null) {
      return send(res, 400, { ok: false, error: 'invalid_address',
        message: 'address must be a hex (0x...) or decimal integer' }, req);
    }
    if (!inSram(address, 1)) {
      return send(res, 403, { ok: false, error: 'address_not_allowed',
        message: 'fel_exec is sram-only (0x00000000-0x00020000)', address: hexAddr(address) }, req);
    }
    if (!execAllowed(address)) {
      return send(res, 403, { ok: false, error: 'exec_not_written',
        message: 'exec refused: this address was not written by fel_write in this bridge session; write it first, then exec',
        address: hexAddr(address), written: writtenRanges }, req);
    }
    if (!fileExists(FEL_EXEC_BIN)) {
      return send(res, 501, { ok: false, error: 'fel_exec_not_built',
        message: 'fel_exec binary not found; run bridge/termux-setup.sh first' }, req);
    }
    const run = await runViaTermuxUsbCmd(FEL_EXEC_BIN, [hexAddr(address), '--confirmed'],
      resolved.device, 10000, { FEL_ADDR: hexAddr(address) });
    if (!run.ok) return send(res, run.status, { ok: false, error: run.error, message: run.message }, req);
    const parsed = parseToolJson(run);
    if (!parsed) {
      return send(res, 502, { ok: false, error: 'fel_exec_bad_output',
        message: 'fel_exec did not return JSON; the termux-usb command-string form may not work on this phone, see bridge/README.md for the direct Termux fallback',
        stdout: run.stdout.slice(0, 2000), stderr: run.stderr.slice(0, 2000) }, req);
    }
    if (run.code !== 0 || !parsed.ok) {
      // A status timeout after EXEC can mean the code took over the
      // device (an SPL never returns). Surface the detail, do not
      // pretend it is a plain failure.
      return send(res, 502, { ok: false, error: 'fel_exec_failed', detail: parsed,
        message: 'fel_exec did not return a status reply; if this was an spl, it may still be running -- re-check with fel_version / fel_read' }, req);
    }
    const report = { ...parsed, generatedAt: new Date().toISOString(), device: resolved.device };
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
  }

  // Deliberately no /api/bridge/write, /exec, /flash, /emmc or
  // /read endpoint: a request for one is a 404, not a stub.
  return send(res, 404, { ok: false, error: 'not_found' }, req);
}

function createServer() {
  return http.createServer((req, res) => {
    handler(req, res).catch((e) => send(res, 500, { ok: false, error: 'internal_error', message: e.message }, req));
  });
}

const server = createServer();
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`ARTEMIS Termux bridge v${VERSION} listening on ${HOST}:${PORT} (read-write-sram-only+spl-uboot, no emmc/flash)`);
  });
}

module.exports = { server, handler, createServer, HOST, PORT, VERSION,
  parseAddress, parseLength, readAllowed, writeAllowed, execAllowed,
  inSram, inSid, hexAddr, writtenRanges, buildTermuxUsbCmd,
  parseSplUbootOutput,
  validateFullUbootImage, UB_MAX_FILE, SPL_LEN_LIMIT,
  runFelAuto, classifyFelSplUbootFailure, validateAutoCandidates,
  FEL_AUTO_MAX_CANDIDATES, FEL_AUTO_PATTERN_SHA256, NODRAM_SHA256,
  buildFelAutoRunner, saveFelAutoLog };
