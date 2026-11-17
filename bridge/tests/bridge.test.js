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
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { createServer, buildTermuxUsbCmd } = require('../server');

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

test('status is sram-only v2, localhost, and reports no emmc capability', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'read-write-sram-only');
    assert.equal(body.bridge, 'artemis-termux-bridge/v2');
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.emmcWriteEnabled, false);
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
