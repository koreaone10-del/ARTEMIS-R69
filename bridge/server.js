'use strict';
/*
 * ARTEMIS Termux bridge server -- v2, SRAM-only FEL read/write/exec.
 *
 * Binds 127.0.0.1:3001 only. There is NO eMMC / flash / NAND write
 * endpoint, and there never will be one on this server: FEL_WRITE
 * and FEL_EXEC are confined to H3 SRAM (0x00000000-0x00020000),
 * FEL_READ is confined to SRAM plus the SID window
 * (0x01C14200-0x01C14210), and FEL_EXEC refuses unless the entry
 * address lies inside a range written by FEL_WRITE in this bridge
 * session (tracked in memory and persisted to bridge/run/session.json).
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
 * accept FEL_ADDR / FEL_LEN / FEL_FILE from the environment. The
 * command-string form is UNVERIFIED on the user's phone; if it
 * fails, the README documents the direct Termux fallback. See
 * bridge/docs/SOURCES.md.
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
 * FEL mid-transfer. See bridge/docs/SOURCES.md and bridge/README.md.
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
const VERSION = '2.0.0';

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
    : report.tool === 'fel_exec' ? 'fel-exec' : 'probe';
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
 * v2 form for tools that need arguments: the command is passed as
 * one string, and termux-usb appends the USB fd as the command's
 * argument (the C tools also accept the fd first, or via
 * $TERMUX_USB_FD). Only numeric / hex parameters and server-made
 * file paths are ever interpolated here; the binary and file paths
 * are single-quoted. This form is UNVERIFIED on the user's phone
 * (see the header comment); a failure is reported, never faked.
 */
function runViaTermuxUsbCmd(binary, args, device, timeoutMs, envExtra) {
  const quoted = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command = [quoted(binary), ...args].join(' ');
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
    bridge: 'artemis-termux-bridge/v2',
    version: VERSION,
    mode: 'read-write-sram-only',
    host: HOST,
    port: PORT,
    felWriteEnabled: true,
    felExecEnabled: true,
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
    note: 'v2: FEL_READ (SRAM + SID only), FEL_WRITE and FEL_EXEC are SRAM-only (0x00000000-0x00020000). eMMC / flash / NAND writing is still disabled: there is no endpoint for it. FEL_EXEC requires a prior FEL_WRITE in this session. SPL upload at 0x00000000 is UNVERIFIED (no upstream stack swap/thunk in v2).',
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
    try { saveReport(report); } catch { /* see probe */ }
    return send(res, 200, report, req);
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
    console.log(`ARTEMIS Termux bridge v${VERSION} listening on ${HOST}:${PORT} (read-write-sram-only, no emmc/flash)`);
  });
}

module.exports = { server, handler, createServer, HOST, PORT, VERSION,
  parseAddress, parseLength, readAllowed, writeAllowed, execAllowed,
  inSram, inSid, hexAddr, writtenRanges };
