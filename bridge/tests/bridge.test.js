'use strict';
/*
 * Bridge tests -- no R69 device needed.
 * Run: node --test bridge/tests/bridge.test.js
 * (Repo-wide: npm test runs tests/*.test.js; this file lives in
 * bridge/tests/ so it is also run explicitly from bridge/README.md.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { createServer } = require('../server');

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

test('status is read-only, localhost, and reports no write capability', async () => {
  const { server, base } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/bridge/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'read-only');
    assert.equal(body.host, '127.0.0.1');
    assert.equal(body.felWriteEnabled, false);
    assert.equal(body.felExecEnabled, false);
    assert.equal(body.emmcWriteEnabled, false);
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

test('probe and fel-version reject an invalid device path with 400', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const p of ['/api/bridge/probe', '/api/bridge/fel-version']) {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: '/dev/bus/usb/999/999; rm -rf /' }),
      });
      assert.equal(res.status, 400, p);
      const body = await res.json();
      assert.equal(body.error, 'invalid_device');
    }
  } finally { await stop(server); }
});

test('there is no write endpoint in v1', async () => {
  const { server, base } = await startTestServer();
  try {
    for (const p of ['/api/bridge/write', '/api/bridge/exec', '/api/bridge/flash']) {
      const res = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 404, p);
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
