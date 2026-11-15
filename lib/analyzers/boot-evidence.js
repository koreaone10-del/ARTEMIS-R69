'use strict';

const crypto = require('node:crypto');

const SIGNATURES = [
  { magic: 'eGON.BT0', kind: 'Boot0' },
  { magic: 'eGON.BT1', kind: 'Boot1' },
  { magic: 'TOC1', kind: 'TOC1' }
];

function inspectBootEvidence(input, name = 'unnamed') {
  const bytes = Buffer.from(input || []);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  const matches = [];

  for (const item of SIGNATURES) {
    const signature = Buffer.from(item.magic, 'ascii');
    let offset = 0;

    while ((offset = bytes.indexOf(signature, offset)) !== -1) {
      matches.push({
        magic: item.magic,
        kind: item.kind,
        offset,
        offsetHex: '0x' + offset.toString(16)
      });
      offset += signature.length;
    }
  }

  const egon = matches.find(x =>
    x.magic === 'eGON.BT0' || x.magic === 'eGON.BT1'
  );

  let header = null;

  if (egon && egon.offset >= 4) {
    const base = egon.offset - 4;

    if (base + 24 <= bytes.length) {
      header = {
        baseOffset: base,
        jumpInstruction: '0x' +
          bytes.readUInt32LE(base).toString(16).padStart(8, '0'),
        checksum: bytes.readUInt32LE(base + 12),
        declaredLength: bytes.readUInt32LE(base + 16),
        publicHeaderSize: bytes.readUInt32LE(base + 20),
        headerVersion: bytes.subarray(base + 24, base + 28).toString('hex'),
        fileHeaderVersion: bytes.subarray(base + 28, base + 32).toString('hex')
      };
    }
  }

  return {
    name: String(name),
    size: bytes.length,
    sha256,
    signatures: matches,
    header,
    evidenceLevel: matches.length ? 'SIGNATURE_FOUND' : 'NO_KNOWN_SIGNATURE',
    checksumStatus: 'NOT_VERIFIED',
    compatibility: 'UNKNOWN',
    executable: false,
    modified: false,
    note: 'Static inspection only. No boot code is generated or executed.'
  };
}

module.exports = { inspectBootEvidence };
