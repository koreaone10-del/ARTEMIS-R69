'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectBootEvidence } = require('../lib/analyzers/boot-evidence');

test('detects eGON.BT0 at documented offset 4', () => {
  const b = Buffer.alloc(128);
  b.writeUInt32LE(0xea000000, 0);
  b.write('eGON.BT0', 4, 'ascii');
  b.writeUInt32LE(128, 16);

  const result = inspectBootEvidence(b, 'boot0-test');

  assert.equal(result.signatures[0].offset, 4);
  assert.equal(result.header.baseOffset, 0);
  assert.equal(result.header.declaredLength, 128);
  assert.equal(result.checksumStatus, 'NOT_VERIFIED');
  assert.equal(result.modified, false);
});

test('does not invent a signature when none exists', () => {
  const result = inspectBootEvidence(Buffer.alloc(64));

  assert.equal(result.signatures.length, 0);
  assert.equal(result.header, null);
  assert.equal(result.compatibility, 'UNKNOWN');
});

test('detects TOC1 without claiming package validity', () => {
  const b = Buffer.from('xxxxTOC1xxxx');
  const result = inspectBootEvidence(b);

  assert.equal(result.signatures[0].magic, 'TOC1');
  assert.equal(result.compatibility, 'UNKNOWN');
});

test('calculates a SHA-256 fingerprint', () => {
  const result = inspectBootEvidence(Buffer.from('ARTEMIS'));

  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('reads eGON public header size from the correct field', () => {
  const b = Buffer.alloc(128);
  b.write('eGON.BT0', 4, 'ascii');
  b.writeUInt32LE(128, 16);
  b.writeUInt32LE(48, 20);
  b.write('0001', 24, 'ascii');

  const result = inspectBootEvidence(b);

  assert.equal(result.header.publicHeaderSize, 48);
  assert.equal(result.header.declaredLength, 128);
});
