'use strict';
/*
 * ARTEMIS Termux bridge server -- v1, read-only.
 *
 * Binds 127.0.0.1:3001 only. There is no write endpoint in v1: no
 * FEL_WRITE, no FEL_EXEC, no eMMC write, no DRAM write, no SD-image
 * builder. Any future write phase needs its own design, backup and
 * explicit user approval, and is out of scope here.
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
 * - No token is used in v1 because the endpoints are read-only and
 *   localhost-only; any local app on the phone could in theory call
 *   them, which is why they must never become write endpoints
 *   without adding authentication first.
 *
 * Endpoints:
 *   GET  /api/bridge/status
 *   POST /api/bridge/probe        {device?: "/dev/bus/usb/001/002"}
 *   POST /api/bridge/fel-version  {device?: "/dev/bus/usb/001/002"}
 *   GET  /api/bridge/report
 *
 * probe / fel-version run their native binary through termux-usb:
 *   termux-usb -r -e <binary> <device>
 * where <binary> is usb_probe / fel_version from this repo, built by
 * bridge/termux-setup.sh. termux-usb passes the USB file descriptor
 * as the command's argument (older, documented form). A newer
 * termux-usb -E form passes it via $TERMUX_USB_FD; fel_version.c
 * accepts that too, but the server uses the -e argument form in v1
 * because it is the form documented in the Termux wiki and it
 * matches usb_probe.c. See bridge/docs/SOURCES.md.
 *
 * If termux-usb is not installed, or no device is given and the
 * device list is not exactly one device, the endpoint fails with a
 * clear JSON error. It never invents a probe result.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { URL } = require('node:url');

const BRIDGE_DIR = __dirname;
const RUN_DIR = path.join(BRIDGE_DIR, 'run');
const REPORTS_DIR = path.join(BRIDGE_DIR, 'reports');
const LATEST_REPORT = path.join(RUN_DIR, 'latest-report.json');
const USB_PROBE_BIN = path.join(__dirname, '..', 'usb_probe');
const FEL_VERSION_BIN = path.join(BRIDGE_DIR, 'fel_version');
const VERSION = '1.0.0';

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
  const kind = report.tool === 'fel_version' ? 'fel-version' : 'probe';
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
        // termux-usb -l output format is not guaranteed; keep only
        // plausible device paths and report the raw list when unsure.
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
    bridge: 'artemis-termux-bridge/v1',
    version: VERSION,
    mode: 'read-only',
    host: HOST,
    port: PORT,
    felWriteEnabled: false,
    felExecEnabled: false,
    emmcWriteEnabled: false,
    termuxUsbAvailable: commandExists('termux-usb'),
    usbProbeAvailable: fileExists(USB_PROBE_BIN),
    felVersionAvailable: fileExists(FEL_VERSION_BIN),
    sunxiFelAvailable: commandExists('sunxi-fel'),
    latestReport: latestReport() ? { exists: true, generatedAt: latestReport().generatedAt || null } : { exists: false },
    note: 'Read-only v1. FEL_VERSION is the only FEL command implemented; there is no write endpoint.',
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
    let parsed = null;
    try { parsed = JSON.parse(run.stdout.trim()); } catch {
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

  // There is deliberately no /api/bridge/write, /exec, /flash or
  // /read endpoint in v1. A request for one is a 404, not a stub.
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
    console.log(`ARTEMIS Termux bridge v${VERSION} listening on ${HOST}:${PORT} (read-only)`);
  });
}

module.exports = { server, handler, createServer, HOST, PORT, VERSION };
