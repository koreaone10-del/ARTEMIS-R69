'use strict';
const MAGIC = Buffer.from('eGON.BT0', 'ascii');
const STAMP = 0x5f0a6c39;
function parseEgon(input) {
  const b = Buffer.from(input);
  if (b.length < 32) throw new Error('eGON image is shorter than the minimum header');
  const magic = b.subarray(0, 8).toString('ascii');
  const checksum = b.readUInt32LE(8);
  const length = b.readUInt32LE(12);
  const entry = b.readUInt32LE(16);
  const result = { magic, validMagic: magic === MAGIC.toString('ascii'), checksum, checksumHex: '0x' + checksum.toString(16).padStart(8,'0'), length, entryPoint: entry, fileSize: b.length, stamp: STAMP, warnings: [] };
  if (!result.validMagic) result.warnings.push('Magic mismatch: not identified as eGON.BT0.');
  if (length < 32 || length > b.length || (length & 3)) result.warnings.push('Header length is out of bounds or not 4-byte aligned; checksum not evaluated.');
  else {
    const copy = Buffer.from(b.subarray(0, length));
    copy.writeUInt32LE(STAMP, 8);
    let sum = 0;
    for (let i = 0; i < length; i += 4) sum = (sum + copy.readUInt32LE(i)) >>> 0;
    result.computedChecksum = sum;
    result.checksumValid = sum === checksum;
  }
  return result;
}
module.exports = { parseEgon, EGON_MAGIC: MAGIC.toString('ascii'), EGON_STAMP: STAMP };
