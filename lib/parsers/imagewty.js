'use strict';
const DEFAULT_PROFILE = { headerBytes: 96, tableOffset: 0x400, entryBytes: 1024, countOffset: 60, versionOffset: 8, version: 0x300, filenameOffset: 4, filenameBytes: 256, storedLengthOffset: 260, originalLengthOffset: 268, dataOffsetOffset: 276 };
function parseImagewtyHeader(input, profile = DEFAULT_PROFILE) {
  const b = Buffer.from(input);
  if (b.length < profile.headerBytes) throw new Error('IMAGEWTY header truncated');
  if (b.subarray(0,8).toString('ascii') !== 'IMAGEWTY') throw new Error('IMAGEWTY magic mismatch');
  const version = b.readUInt32LE(profile.versionOffset);
  const count = b.readUInt32LE(profile.countOffset);
  if (count > 512) throw new Error(`Implausible entry count: ${count}`);
  const tableEnd = profile.tableOffset + count * profile.entryBytes;
  if (!Number.isSafeInteger(tableEnd) || tableEnd > b.length) throw new Error('Entry table is not fully present in supplied buffer');
  const entries = [];
  for (let i=0;i<count;i++) {
    const p = profile.tableOffset + i*profile.entryBytes;
    const end = b.indexOf(0, p+profile.filenameOffset);
    const nameEnd = end < 0 || end > p+profile.filenameOffset+profile.filenameBytes ? p+profile.filenameOffset+profile.filenameBytes : end;
    const name = b.subarray(p+profile.filenameOffset,nameEnd).toString('utf8').trim();
    const storedLength = b.readUInt32LE(p+profile.storedLengthOffset);
    const originalLength = b.readUInt32LE(p+profile.originalLengthOffset);
    const offset = b.readUInt32LE(p+profile.dataOffsetOffset);
    const inBounds = Number.isSafeInteger(offset+storedLength) && offset >= tableEnd && offset+storedLength <= b.length;
    entries.push({ index:i, name, storedLength, originalLength, offset, inBounds, note: 'Offsets are interpreted using the documented candidate profile; validate against known extracted payloads before trusting.' });
  }
  return { magic:'IMAGEWTY', version, expectedVersion:profile.version, versionMatches:version===profile.version, count, tableOffset:profile.tableOffset, entries, confidence:'candidate-v3-profile', warning:'Vendor IMAGEWTY variants differ. This profile is a candidate, not a universal format guarantee.' };
}
module.exports = { parseImagewtyHeader, DEFAULT_PROFILE };
