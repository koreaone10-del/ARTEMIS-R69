'use strict';
/*
 * Bridge tests -- no R69 device needed.
 * Run: node --test bridge/tests/bridge.test.js
 * (Repo-wide: npm test runs tests/*.test.js; this file lives in
 * bridge/tests/ so it is also run explicitly from bridge/README.md.)
 *
 * v2: the allowlist / confirm / session rules are tested against
 * the live server. Anything that would need a real device
 * (termux-usb, the FEL exchange) is expected to fail before it
 * reaches the device: the tests assert the refusal, not a device
 * result. FEL_READ / FEL_WRITE / FEL_EXEC on real hardware are
 * UNVERIFIED.
 *
 * v3: validateFullUbootImage and the fel-spl-uboot endpoint are
 * tested the same way — a valid full u-boot-sunxi-with-spl.bin
 * is built in-memory (eGON header + checksum + mkimage header)
 * and must pass validation; every bad variant must be refused
 * before any device access. The SPL swap/thunk/eGON.FEL flow
 * itself runs only on a live H3 and is UNVERIFIED.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { createServer, buildTermuxUsbCmd, validateFullUbootImage, parseSplUbootOutput } = require('../server');

function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

async function stop(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function post(base, p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const DEV = '/dev/bus/usb/001/004';

test('status is sram-only+spl-uboot v3, localhost, and reports no emmc capability', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'read-write-sram-only+spl-uboot');
    assert.equal(body.bridge, 'artemis-termux-bridge/v3');
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.emmcWriteEnabled, false);
    assert.equal(typeof body.felSplUbootAvailable, 'boolean');
    assert.equal(typeof body.felReadAvailable, 'boolean');
    assert.equal(typeof body.felWriteAvailable, 'boolean');
    assert.equal(typeof body.felExecAvailable, 'boolean');
    assert.equal(typeof body.usbProbeAvailable, 'boolean');
    assert.equal(typeof body.felVersionAvailable, 'boolean');
  } finally { await stop(server); }
});

test('report with no probe yet is 404, not a fake report', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/report`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'no_report_yet');
  } finally { await stop(server); }
});

test('session starts empty', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/session`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.written));
  } finally { await stop(server); }
});

test('probe and fel-version reject an invalid device path with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const p of ['/api/bridge/probe', '/api/bridge/fel-version']) {
      const { status, body } = await post(base, p, { device: '/dev/bus/usb/999/999; rm -rf /' });
      assert.equal(status, 400, p);
      assert.equal(body.error, 'invalid_device');
    }
  } finally { await stop(server); }
});

test('there is no generic write/exec/flash/emmc endpoint in v2', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const p of ['/api/bridge/write', '/api/bridge/exec', '/api/bridge/flash', '/api/bridge/emmc', '/api/bridge/read']) {
      const { status } = await post(base, p, {});
      assert.equal(status, 404, p);
    }
  } finally { await stop(server); }
});

test('Render origin gets no CORS header', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/status`, {
      headers: { Origin: 'https://artemis-r69.onrender.com' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const local = await fetch(`${base}/api/bridge/status`, {
      headers: { Origin: 'http://127.0.0.1:3000' },
    });
    assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000');
  } finally { await stop(server); }
});

test('a non-localhost BRIDGE_HOST is refused', async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, BRIDGE_HOST: '0.0.0.0', BRIDGE_PORT: '39999' },
    timeout: 5000,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /refusing non-localhost binding/);
});

/* --- termux-usb command-string form (v2.1 fix) --- */

test('fel-read/write/exec command string is unquoted, never single-quoted', () => {
  // Regression test for the live failure on 2026-11-17: the server
  // originally built "'<binary>' 0x1000 16", and termux-usb on the
  // user's phone did not strip the quotes, so fel_read never ran
  // ("fel_read did not return JSON"). The unquoted form was proven
  // live the same day, both with -E and without, returning
  // identical FEL_READ JSON for 0x1000 x16 (sha256 5b2402fa...2191).
  assert.equal(
    buildTermuxUsbCmd('/data/data/com.termux/files/home/ARTEMIS-R69/bridge/fel_read', ['0x00001000', '16']),
    '/data/data/com.termux/files/home/ARTEMIS-R69/bridge/fel_read 0x00001000 16',
  );
  assert.equal(
    buildTermuxUsbCmd('/x/bridge/fel_write', ['0x00000000', '/x/bridge/run/fel-write-123-5b2402fa.bin', '--spl']),
    '/x/bridge/fel_write 0x00000000 /x/bridge/run/fel-write-123-5b2402fa.bin --spl',
  );
  assert.equal(
    buildTermuxUsbCmd('/x/bridge/fel_exec', ['0x00001000', '--confirmed']),
    '/x/bridge/fel_exec 0x00001000 --confirmed',
  );
  const built = buildTermuxUsbCmd('/x/bridge/fel_read', ['0x00001000', '16']);
  assert.ok(!built.includes("'"), 'command string must contain no single quotes');
  // Unsafe tokens are rejected, never quoted into the command.
  for (const bad of ['0x1000; rm -rf /', "a'b", 'a b', 'a$b', 'a|b', 'a`b`', '']) {
    assert.throws(() => buildTermuxUsbCmd('/x/bridge/fel_read', [bad]), /unsafe termux-usb command token/);
  }
  assert.throws(() => buildTermuxUsbCmd("/x/bridge/fel_read' ", ['0x1000']), /unsafe termux-usb command token/);
});

/* --- fel-read allowlist --- */

test('fel-read rejects dram, flash and out-of-range addresses with 403', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const address of ['0x40000000', '0x01000000', '0x01c14000', '0x00020000', '0x01c14210']) {
      const { status, body } = await post(base, '/api/bridge/fel-read', { device: DEV, address, length: 16 });
      assert.equal(status, 403, address);
      assert.equal(body.error, 'address_not_allowed');
    }
    // SID window itself is allowed by the allowlist: it must get
    // past validation (501 not-built here, or a device error) and
    // must NOT be rejected as address_not_allowed.
    const sid = await post(base, '/api/bridge/fel-read', { device: DEV, address: '0x01c14200', length: 16 });
    assert.notEqual(sid.body.error, 'address_not_allowed', 'sid read must pass the allowlist');
    const sram = await post(base, '/api/bridge/fel-read', { device: DEV, address: '0x1000', length: 16 });
    assert.notEqual(sram.body.error, 'address_not_allowed', 'sram read must pass the allowlist');
  } finally { await stop(server); }
});

test('fel-read rejects bad lengths with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const length of [0, -1, 4097, 'x']) {
      const { status, body } = await post(base, '/api/bridge/fel-read', { device: DEV, address: '0x1000', length });
      assert.equal(status, 400, String(length));
      assert.equal(body.error, 'invalid_length');
    }
    const badAddr = await post(base, '/api/bridge/fel-read', { device: DEV, address: 'hello', length: 16 });
    assert.equal(badAddr.status, 400);
    assert.equal(badAddr.body.error, 'invalid_address');
  } finally { await stop(server); }
});

/* --- fel-write allowlist / confirm / sha --- */

function writeBody(overrides) {
  const data = Buffer.from('HELLO-FEL-PATTERN-0123456789', 'utf8');
  return {
    device: DEV,
    address: '0x1000',
    base64: data.toString('base64'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    confirm: true,
    ...overrides,
  };
}

test('fel-write rejects a missing confirm with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    const { status, body } = await post(base, '/api/bridge/fel-write', writeBody({ confirm: undefined }));
    assert.equal(status, 400);
    assert.equal(body.error, 'confirm_required');
    const wrong = await post(base, '/api/bridge/fel-write', writeBody({ confirm: 'yes' }));
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, 'confirm_required');
  } finally { await stop(server); }
});

test('fel-write rejects a sha256 mismatch with 400, before any device access', async () => {
  const { server, base } = await startTestServer();
  try {
    const { status, body } = await post(base, '/api/bridge/fel-write', writeBody({ sha256: '00'.repeat(32) }));
    assert.equal(status, 400);
    assert.equal(body.error, 'sha256_mismatch');
  } finally { await stop(server); }
});

test('fel-write rejects dram, protected brom regions and oversize data', async () => {
  const { server, base } = await startTestServer();
  try {
    const dram = await post(base, '/api/bridge/fel-write', writeBody({ address: '0x40000000' }));
    assert.equal(dram.status, 403);
    assert.equal(dram.body.error, 'address_not_allowed');
    // FEL_VERSION scratchpad 0x7e00 is inside a protected region.
    const scratch = await post(base, '/api/bridge/fel-write', writeBody({ address: '0x7e00' }));
    assert.equal(scratch.status, 403);
    assert.equal(scratch.body.error, 'address_not_allowed');
    // BROM stack area.
    const stack = await post(base, '/api/bridge/fel-write', writeBody({ address: '0x5c00' }));
    assert.equal(stack.status, 403);
    // Oversize: 131073 bytes.
    const big = Buffer.alloc(131073, 0x41);
    const over = await post(base, '/api/bridge/fel-write', {
      device: DEV, address: '0x1000',
      base64: big.toString('base64'),
      sha256: crypto.createHash('sha256').update(big).digest('hex'),
      confirm: true,
    });
    assert.equal(over.status, 400);
    assert.equal(over.body.error, 'invalid_size');
    // SPL flag at a non-SPL address is rejected.
    const splWrong = await post(base, '/api/bridge/fel-write', writeBody({ address: '0x1000', spl: true }));
    assert.equal(splWrong.status, 400);
    assert.equal(splWrong.body.error, 'invalid_spl_address');
  } finally { await stop(server); }
});

/* --- fel-exec session rule --- */

test('fel-exec refuses an address that was not written in this session', async () => {
  const { server, base } = await startTestServer();
  try {
    const { status, body } = await post(base, '/api/bridge/fel-exec', { device: DEV, address: '0x1000', confirm: true });
    assert.equal(status, 403);
    assert.equal(body.error, 'exec_not_written');
  } finally { await stop(server); }
});

test('fel-exec rejects a missing confirm with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    const { status, body } = await post(base, '/api/bridge/fel-exec', { device: DEV, address: '0x1000' });
    assert.equal(status, 400);
    assert.equal(body.error, 'confirm_required');
    const dram = await post(base, '/api/bridge/fel-exec', { device: DEV, address: '0x40000000', confirm: true });
    assert.equal(dram.status, 403);
    assert.equal(dram.body.error, 'address_not_allowed');
  } finally { await stop(server); }
});

/* --- v3: fel-spl-uboot validation --- */

/* Build an in-memory full u-boot-sunxi-with-spl.bin with a valid
 * eGON header + checksum and a valid mkimage header, matching the
 * real build (SPL 24,576 bytes, U-Boot load/entry 0x4a000000).
 * The eGON checksum is solved from fel.c L1102-1117:
 *   2*w3 - 0x5F0A6C39 - sum(all words) == 0
 * with w3 the checksum field itself, so w3 = 0x5F0A6C39 +
 * sum(all other words) (mod 2^32). */
function makeValidUbootImage({ splLen = 24576, load = 0x4a000000, payloadSize = 526648 } = {}) {
  const total = 32768 + 64 + payloadSize;
  const buf = Buffer.alloc(total, 0xab);
  // SPL header.
  buf.write('eGON.BT0', 4, 'latin1');
  buf.writeUInt32LE(splLen, 16);
  // Deterministic SPL payload words (avoid the checksum field).
  for (let off = 32; off < splLen; off += 4) buf.writeUInt32LE(0x12345678 + off, off);
  let sumOthers = 0;
  for (let off = 0; off < splLen; off += 4) {
    if (off === 12) continue;
    sumOthers = (sumOthers + buf.readUInt32LE(off)) >>> 0;
  }
  buf.writeUInt32LE((0x5F0A6C39 + sumOthers) >>> 0, 12);
  // U-Boot proper mkimage header at offset 32768 (big-endian).
  const h = 32768;
  buf.writeUInt32BE(0x27051956, h + 0);
  buf[h + 29] = 2; // IH_ARCH_ARM
  buf[h + 30] = 5; // IH_TYPE_FIRMWARE
  buf.writeUInt32BE(payloadSize, h + 12); // data_size
  buf.writeUInt32BE(load, h + 16); // load address
  buf.writeUInt32BE(load, h + 20); // entry address
  buf.write('ARTEMIS-R69-test', h + 32, 'latin1');
  return buf;
}

function splUbootBody(overrides) {
  const data = makeValidUbootImage();
  return {
    device: DEV,
    base64: data.toString('base64'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    confirm: true,
    ...overrides,
  };
}

test('validateFullUbootImage accepts the real-shaped full image', () => {
  const data = makeValidUbootImage();
  assert.equal(data.length, 559480);
  const v = validateFullUbootImage(data);
  assert.equal(v.ok, true);
  assert.equal(v.spl_len, 24576);
  assert.equal(v.uboot_load, 0x4a000000);
  assert.equal(v.uboot_entry, 0x4a000000);
  assert.equal(v.uboot_size, 526648);
  // The same bytes must also pass the C tool's validation: run the
  // compiled binary (if present) with a bad fd and check that all
  // four validation steps pass before fel_open fails.
  // v3.1: stdout is now multi-line (one progress line per step, a
  // banner line, then the final JSON as the LAST line), so parse
  // the last line as the result and check the progress lines too.
  const fs = require('node:fs');
  const bin = path.join(__dirname, '..', 'fel_spl_uboot');
  if (fs.existsSync(bin)) {
    const { spawnSync } = require('node:child_process');
    const tmp = path.join(__dirname, 'tmp-valid-uboot.bin');
    fs.writeFileSync(tmp, data);
    try {
      const r = spawnSync(bin, ['3', tmp], { encoding: 'utf8', timeout: 10000 });
      const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const progress = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      assert.equal(progress.filter((o) => o.progress === true).length, 4);
      assert.equal(progress.filter((o) => o.banner === true).length, 1);
      assert.equal(progress.find((o) => o.banner === true).validate_only, false);
      const out = JSON.parse(lines[lines.length - 1]);
      assert.equal(out.ok, false); // no USB device on fd 3
      assert.deepEqual(out.steps.map((s) => s.name), [
        'validate_file_size', 'validate_egon_header',
        'validate_egon_checksum', 'validate_uboot_header',
      ]);
      assert.ok(out.steps.every((s) => s.ok));
      assert.equal(out.file_sha256, crypto.createHash('sha256').update(data).digest('hex'));
    } finally { fs.unlinkSync(tmp); }
  }
});

test('validateFullUbootImage refuses bad eGON, bad checksum, oversize SPL, and a bad U-Boot header', () => {
  const good = makeValidUbootImage();
  const badEgon = Buffer.from(good);
  badEgon.write('XXXX.BT0', 4, 'latin1');
  assert.equal(validateFullUbootImage(badEgon).error, 'bad_egon');
  const badChecksum = Buffer.from(good);
  badChecksum[1000] ^= 0xff;
  assert.equal(validateFullUbootImage(badChecksum).error, 'bad_checksum');
  const bigSpl = Buffer.from(good);
  bigSpl.writeUInt32LE(32772, 16); // > SPL_LEN_LIMIT, multiple of 4
  assert.equal(validateFullUbootImage(bigSpl).error, 'spl_too_large');
  const badMagic = Buffer.from(good);
  badMagic.writeUInt32BE(0xdeadbeef, 32768);
  assert.equal(validateFullUbootImage(badMagic).error, 'bad_uboot_header');
  const badArch = Buffer.from(good);
  badArch[32768 + 29] = 0x15; // not ARM
  assert.equal(validateFullUbootImage(badArch).error, 'bad_uboot_header');
  const badType = Buffer.from(good);
  badType[32768 + 30] = 2; // not IH_TYPE_FIRMWARE
  assert.equal(validateFullUbootImage(badType).error, 'bad_uboot_header');
  const badSize = Buffer.from(good);
  badSize.writeUInt32BE(123, 32768 + 12); // data_size mismatch
  assert.equal(validateFullUbootImage(badSize).error, 'bad_uboot_header');
  const splOnly = Buffer.from(good.subarray(0, 32768));
  assert.equal(validateFullUbootImage(splOnly).error, 'no_uboot_proper');
});

test('validateFullUbootImage refuses U-Boot load addresses outside DRAM (eMMC/flash-style targets)', () => {
  for (const load of [0x00000000, 0x01000000, 0x00020000, 0x3fffffff, 0xc0000000]) {
    const img = makeValidUbootImage({ load });
    const v = validateFullUbootImage(img);
    assert.equal(v.ok, false, `load 0x${load.toString(16)}`);
    assert.equal(v.error, 'uboot_address_not_allowed');
  }
  // A load at the very end of DRAM with a payload that overflows it.
  const img = makeValidUbootImage({ load: 0xc0000000 - 100 });
  assert.equal(validateFullUbootImage(img).error, 'uboot_address_not_allowed');
});

test('fel-spl-uboot rejects a missing confirm, a sha256 mismatch, and an oversize file, before any device access', async () => {
  const { server, base } = await startTestServer();
  try {
    const noConfirm = await post(base, '/api/bridge/fel-spl-uboot', splUbootBody({ confirm: undefined }));
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.error, 'confirm_required');
    const wrongConfirm = await post(base, '/api/bridge/fel-spl-uboot', splUbootBody({ confirm: 'yes' }));
    assert.equal(wrongConfirm.status, 400);
    assert.equal(wrongConfirm.body.error, 'confirm_required');
    const badSha = await post(base, '/api/bridge/fel-spl-uboot', splUbootBody({ sha256: '00'.repeat(32) }));
    assert.equal(badSha.status, 400);
    assert.equal(badSha.body.error, 'sha256_mismatch');
    const big = Buffer.alloc(600 * 1024 + 1, 0x41);
    const over = await post(base, '/api/bridge/fel-spl-uboot', {
      device: DEV,
      base64: big.toString('base64'),
      sha256: crypto.createHash('sha256').update(big).digest('hex'),
      confirm: true,
    });
    assert.equal(over.status, 400);
    assert.equal(over.body.error, 'invalid_size');
  } finally { await stop(server); }
});

test('fel-spl-uboot rejects bad eGON, bad checksum, oversize SPL, and a bad U-Boot header with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    const cases = [
      ['bad_egon', (() => { const b = makeValidUbootImage(); b.write('XXXX.BT0', 4, 'latin1'); return b; })()],
      ['bad_checksum', (() => { const b = makeValidUbootImage(); b[1000] ^= 0xff; return b; })()],
      ['spl_too_large', (() => { const b = makeValidUbootImage(); b.writeUInt32LE(32772, 16); return b; })()],
      ['bad_uboot_header', (() => { const b = makeValidUbootImage(); b.writeUInt32BE(0xdeadbeef, 32768); return b; })()],
      ['no_uboot_proper', (() => makeValidUbootImage().subarray(0, 32768))()],
      ['uboot_address_not_allowed', (() => makeValidUbootImage({ load: 0x01000000 }))()],
    ];
    for (const [expected, data] of cases) {
      const buf = Buffer.from(data);
      const { status, body } = await post(base, '/api/bridge/fel-spl-uboot', {
        device: DEV,
        base64: buf.toString('base64'),
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        confirm: true,
      });
      assert.equal(status, 400, expected);
      assert.equal(body.error, expected);
    }
  } finally { await stop(server); }
});

test('fel-spl-uboot with a valid file passes validation (fails at the device, never at validation)', async () => {
  // In this VM the fel_spl_uboot binary is not built into
  // bridge/, so the endpoint must stop at "binary not built"
  // AFTER validation passed. On the phone, termux-setup.sh
  // builds it and the flow continues to the device.
  const { server, base } = await startTestServer();
  try {
    const fs = require('node:fs');
    const bin = path.join(__dirname, '..', 'fel_spl_uboot');
    const { status, body } = await post(base, '/api/bridge/fel-spl-uboot', splUbootBody());
    if (fs.existsSync(bin)) {
      // Binary present (a build was run): it must fail at the
      // device, not at validation — termux-usb is absent in this
      // VM (503), or the tool's step log is returned (502).
      assert.ok(status === 502 || status === 503, `unexpected status ${status}`);
      assert.notEqual(body.error, 'bad_egon');
      assert.notEqual(body.error, 'bad_checksum');
      assert.notEqual(body.error, 'bad_uboot_header');
      assert.notEqual(body.error, 'spl_too_large');
      assert.notEqual(body.error, 'no_uboot_proper');
      assert.notEqual(body.error, 'uboot_address_not_allowed');
      if (status === 502) assert.ok(Array.isArray(body.detail.steps));
    } else {
      assert.equal(status, 501);
      assert.equal(body.error, 'fel_spl_uboot_not_built');
    }
  } finally { await stop(server); }
});

test('fel-spl-uboot command string is unquoted and rejects unsafe tokens', () => {
  assert.equal(
    buildTermuxUsbCmd('/x/bridge/fel_spl_uboot', ['/x/bridge/run/fel-spl-uboot-123-8c70a180.bin']),
    '/x/bridge/fel_spl_uboot /x/bridge/run/fel-spl-uboot-123-8c70a180.bin',
  );
  assert.ok(!buildTermuxUsbCmd('/x/bridge/fel_spl_uboot', ['/x/bridge/run/f.bin']).includes("'"));
  assert.throws(() => buildTermuxUsbCmd('/x/bridge/fel_spl_uboot', ['/x/bridge/run/f b.bin']), /unsafe termux-usb command token/);
});

/* --- v3.1: incremental progress, banner, validate-only --- */

function runCTool(args, env = {}) {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const bin = path.join(__dirname, '..', 'fel_spl_uboot');
  if (!fs.existsSync(bin)) return null;
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { r, lines, parsed,
    progress: parsed.filter((o) => o.progress === true),
    banner: parsed.find((o) => o.banner === true) || null,
    final: parsed.length ? parsed[parsed.length - 1] : null };
}

test('v3.1: fel_spl_uboot --validate-only prints progress lines + banner and stops at fel_open (no write)', () => {
  const fs = require('node:fs');
  const data = makeValidUbootImage();
  const tmp = path.join(__dirname, 'tmp-v31-validate.bin');
  fs.writeFileSync(tmp, data);
  try {
    const out = runCTool(['--validate-only', '3', tmp]);
    if (!out) return; // binary not built in this checkout; server tests cover validation
    assert.equal(out.progress.length, 4, 'four validation steps as progress lines');
    assert.deepEqual(out.progress.map((p) => p.name), [
      'validate_file_size', 'validate_egon_header',
      'validate_egon_checksum', 'validate_uboot_header',
    ]);
    assert.ok(out.banner, 'banner line present');
    assert.equal(out.banner.validate_only, true);
    assert.equal(out.banner.spl_len, 24576);
    assert.equal(out.banner.uboot_load, '0x4a000000');
    assert.equal(out.final.ok, false); // no USB device on fd 3
    assert.equal(out.final.validate_only, true);
    assert.equal(out.final.error, 'libusb_wrap_sys_device failed');
    assert.ok(out.r.stderr.includes('step=fel_open failed'), 'stderr diagnostic for fel_open');
  } finally { fs.unlinkSync(tmp); }
});

test('v3.1: fel_spl_uboot validate-only via FEL_VALIDATE_ONLY=1 behaves the same', () => {
  const fs = require('node:fs');
  const data = makeValidUbootImage();
  const tmp = path.join(__dirname, 'tmp-v31-validate-env.bin');
  fs.writeFileSync(tmp, data);
  try {
    const out = runCTool(['3', tmp], { FEL_VALIDATE_ONLY: '1' });
    if (!out) return;
    assert.equal(out.banner && out.banner.validate_only, true);
    assert.equal(out.final.validate_only, true);
  } finally { fs.unlinkSync(tmp); }
});

test('v3.1: corrupted eGON checksum is refused with progress lines, and no banner', () => {
  const fs = require('node:fs');
  const data = makeValidUbootImage();
  data[1000] ^= 0xff; // break the eGON checksum
  const tmp = path.join(__dirname, 'tmp-v31-bad-checksum.bin');
  fs.writeFileSync(tmp, data);
  try {
    const out = runCTool(['3', tmp]);
    if (!out) return;
    // Only the first two validation steps ran; the banner is
    // printed only after ALL validation passes, so it must be absent.
    assert.deepEqual(out.progress.map((p) => p.name), ['validate_file_size', 'validate_egon_header']);
    assert.equal(out.banner, null);
    assert.equal(out.final.ok, false);
    assert.match(out.final.error, /checksum check failed/);
  } finally { fs.unlinkSync(tmp); }
});

test('v3.1: parseSplUbootOutput extracts progress lines, banner, and the last line as the final result', () => {
  const run = { stdout: [
    '{"progress":true,"step":0,"name":"validate_file_size","ok":true,"detail":"size 559480 bytes, sha256 x"}',
    '{"banner":true,"tool":"fel_spl_uboot","file_size":559480,"validate_only":false}',
    '{"progress":true,"step":3,"name":"validate_uboot_header","ok":true,"detail":"mkimage header ok"}',
    '{"ok":false,"tool":"fel_spl_uboot","version":1,"steps":[],"error":"libusb_wrap_sys_device failed"}',
    '',
  ].join('\n') };
  const { final, progress, banner } = parseSplUbootOutput(run);
  assert.equal(progress.length, 2);
  assert.equal(banner.file_size, 559480);
  assert.equal(final.ok, false);
  assert.equal(final.error, 'libusb_wrap_sys_device failed');
  // The v3 silent-failure case: no final line at all, but the
  // progress lines survive and must be returned.
  const silent = parseSplUbootOutput({ stdout: '{"progress":true,"step":0,"name":"validate_file_size","ok":true,"detail":"size 559480 bytes"}\n{"banner":true,"tool":"fel_spl_uboot","file_size":559480}\n' });
  assert.equal(silent.final, null);
  assert.equal(silent.progress.length, 1);
  assert.equal(silent.banner.file_size, 559480);
});

/* --- v3.2: stderr mirror + read-back retry --- */

test('v3.2: parseSplUbootOutput recovers progress, banner and final from stderr when stdout is lost', () => {
  // The phone run on 2026-11-17: stdout "" while stderr survived
  // (it carried the egon_fel_readback diag). With v3.2 the tool
  // mirrors every JSON line to stderr, so the step log must be
  // recoverable from stderr alone.
  const mirrored = [
    '{"progress":true,"step":0,"name":"validate_file_size","ok":true,"detail":"size 559480 bytes, sha256 x"}',
    '{"progress":true,"step":4,"name":"validate_uboot_header","ok":true,"detail":"mkimage header ok"}',
    '{"banner":true,"tool":"fel_spl_uboot","file_size":559480,"validate_only":false}',
    '{"ok":false,"tool":"fel_spl_uboot","version":1,"steps":[{"step":0,"name":"validate_file_size","ok":true,"detail":"size 559480 bytes, sha256 x"}],"error":"SPL: could not read back the SPL header (FEL stopped answering after the thunk, 3 attempts)"}',
  ].join('\n');
  const run = {
    stdout: '',
    stderr: 'fel_spl_uboot: step=egon_fel_readback failed: FEL_READ of SPL header failed after 3 attempts (FEL stopped answering after the thunk)\n' + mirrored + '\n',
  };
  const { final, progress, banner } = parseSplUbootOutput(run);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map((p) => p.name), ['validate_file_size', 'validate_uboot_header']);
  assert.equal(banner.file_size, 559480);
  assert.equal(final.ok, false);
  assert.match(final.error, /3 attempts/);
});

test('v3.2: parseSplUbootOutput dedupes progress lines present in both stdout and stderr', () => {
  const line = '{"progress":true,"step":0,"name":"validate_file_size","ok":true,"detail":"size 559480 bytes"}';
  const { progress, final } = parseSplUbootOutput({ stdout: line + '\n', stderr: line + '\n' });
  assert.equal(progress.length, 1);
  assert.equal(final, null);
});

test('v3.2: fel_spl_uboot --validate-only mirrors progress lines and the final result to stderr', () => {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const data = makeValidUbootImage();
  const tmp = path.join(__dirname, 'tmp-v32-validate.bin');
  fs.writeFileSync(tmp, data);
  try {
    const bin = path.join(__dirname, '..', 'fel_spl_uboot');
    if (!fs.existsSync(bin)) return; // binary not built in this checkout
    const r = spawnSync(bin, ['--validate-only', '3', tmp], { encoding: 'utf8', timeout: 10000, env: process.env });
    const errParsed = r.stderr.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const errProgress = errParsed.filter((o) => o.progress === true);
    assert.equal(errProgress.length, 4, 'four validation steps mirrored to stderr');
    assert.deepEqual(errProgress.map((p) => p.name), [
      'validate_file_size', 'validate_egon_header',
      'validate_egon_checksum', 'validate_uboot_header',
    ]);
    // Progress lines also carry an "ok" field, so the final result
    // is the "ok" object with neither the progress nor banner flag.
    const errFinal = errParsed.find((o) => typeof o.ok === 'boolean' && !o.progress && !o.banner);
    assert.ok(errFinal, 'final result mirrored to stderr');
    assert.equal(errFinal.validate_only, true);
  } finally { fs.unlinkSync(tmp); }
});

test('v3.1: fel-spl-uboot validate_only:true is accepted and records no session write', async () => {
  const { server, base } = await startTestServer();
  try {
    const { status, body } = await post(base, '/api/bridge/fel-spl-uboot', splUbootBody({ validate_only: true }));
    // In this VM termux-usb is absent (503) or the binary is not
    // built (501) or the tool fails at the device (502) — none of
    // those is a validation refusal, and none must record a write.
    assert.ok([501, 502, 503].includes(status), `unexpected status ${status}: ${JSON.stringify(body)}`);
    assert.notEqual(body.error, 'bad_egon');
    assert.notEqual(body.error, 'bad_checksum');
    assert.notEqual(body.error, 'bad_uboot_header');
    const session = await fetch(`${base}/api/bridge/session`).then((r) => r.json());
    assert.deepEqual(session.written, [], 'validate-only must not record a written range');
  } finally { await stop(server); }
});

test('v3.1: fel-spl-uboot validate-only with a bad file is still refused before any device access', async () => {
  const { server, base } = await startTestServer();
  try {
    const bad = makeValidUbootImage();
    bad.write('XXXX.BT0', 4, 'latin1');
    const { status, body } = await post(base, '/api/bridge/fel-spl-uboot', {
      device: DEV,
      base64: Buffer.from(bad).toString('base64'),
      sha256: crypto.createHash('sha256').update(bad).digest('hex'),
      confirm: true, validate_only: true,
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_egon');
  } finally { await stop(server); }
});
