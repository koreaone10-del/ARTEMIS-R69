'use strict';

// Layout cross-checked against fuxdasec/imagewty-tool:
// include/img_header.h + src/img_header.c (IMAGEWTY v3 and v4 parser).
// Main header is 1024 bytes; file-header table starts at 0x400.
const MAIN = Object.freeze({
  magic: 0x00,
  version: 0x08,
  headerSize: 0x0c,
  baseRam: 0x10,
  formatVersion: 0x14,
  totalImageSize: 0x18,
  headerSizeAligned: 0x1c,
  fileHeaderLength: 0x20,
  usbProductId: 0x24,
  usbVendorId: 0x28,
  hardwareId: 0x2c,
  firmwareId: 0x30,
  unknown1: 0x34,
  unknown2: 0x38,
  count: 0x3c,
  unknown3: 0x40,
});
const ENTRY = Object.freeze({
  filenameLength: 0x00,
  headerSize: 0x04,
  mainType: 0x08,
  subType: 0x10,
  unknown0: 0x20,
  filename: 0x24,
  filenameBytes: 256,
  storedLength: 0x124,
  pad1: 0x128,
  originalLength: 0x12c,
  pad2: 0x130,
  offset: 0x134,
  minimumBytes: 0x138,
});
const TABLE_OFFSET = 0x400;
const MAIN_HEADER_BYTES = 1024;
const MAX_FILES = 10000;

function readCStringField(buf, start, length) {
  const field = buf.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString('utf8').trim();
}
function safeName(name) {
  return !!name && name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
}
function parseImagewtyHeader(input, options = {}) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const fileSize = Number.isSafeInteger(options.fileSize) ? options.fileSize : b.length;
  if (b.length < MAIN_HEADER_BYTES) throw new Error('IMAGEWTY main header/table prefix truncated (need 1024 bytes)');
  if (b.subarray(0, 8).toString('ascii') !== 'IMAGEWTY') throw new Error('IMAGEWTY magic mismatch');

  const version = b.readUInt32LE(MAIN.version);
  const headerSize = b.readUInt32LE(MAIN.headerSize);
  const fileHeaderLength = b.readUInt32LE(MAIN.fileHeaderLength);
  const count = b.readUInt32LE(MAIN.count);
  if (!Number.isSafeInteger(fileSize) || fileSize < MAIN_HEADER_BYTES) throw new Error('Invalid image size');
  if (headerSize < 68 || headerSize > MAIN_HEADER_BYTES) throw new Error(`Invalid main header size: ${headerSize}`);
  if (count < 1 || count > MAX_FILES) throw new Error(`Invalid IMAGEWTY file count: ${count}`);
  if (fileHeaderLength < ENTRY.minimumBytes || fileHeaderLength > 0x100000) {
    throw new Error(`Invalid file_header_length at 0x20: ${fileHeaderLength}`);
  }

  const tableBytes = count * fileHeaderLength;
  const tableEnd = TABLE_OFFSET + tableBytes;
  if (!Number.isSafeInteger(tableEnd) || tableEnd > fileSize) throw new Error('IMAGEWTY file-header table exceeds image bounds');
  if (b.length < tableEnd) throw new Error(`Need ${tableEnd} bytes to parse all headers; received ${b.length}`);

  const entries = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const p = TABLE_OFFSET + i * fileHeaderLength;
    const filenameLength = b.readUInt32LE(p + ENTRY.filenameLength);
    const entryHeaderSize = b.readUInt32LE(p + ENTRY.headerSize);
    const mainType = readCStringField(b, p + ENTRY.mainType, 8);
    const subType = readCStringField(b, p + ENTRY.subType, 16);
    const unknown0 = b.readUInt32LE(p + ENTRY.unknown0);
    const storedLength = b.readUInt32LE(p + ENTRY.storedLength);
    const pad1 = b.readUInt32LE(p + ENTRY.pad1);
    const originalLength = b.readUInt32LE(p + ENTRY.originalLength);
    const pad2 = b.readUInt32LE(p + ENTRY.pad2);
    const offset = b.readUInt32LE(p + ENTRY.offset);

    const nameLengthValid = filenameLength >= 1 && filenameLength <= ENTRY.filenameBytes;
    const name = nameLengthValid
      ? b.subarray(p + ENTRY.filename, p + ENTRY.filename + filenameLength).toString('utf8').replace(/\0+$/g, '').trim()
      : '';
    const rangeEnd = offset + originalLength;
    const storedEnd = offset + storedLength;
    const validName = safeName(name);
    const rangeValid = Number.isSafeInteger(rangeEnd) && Number.isSafeInteger(storedEnd) &&
      offset >= tableEnd && originalLength <= storedLength && storedEnd <= fileSize;
    const entryValid = entryHeaderSize >= ENTRY.minimumBytes && entryHeaderSize <= fileHeaderLength &&
      nameLengthValid && validName && rangeValid;
    const duplicate = seen.has(name);
    if (name) seen.add(name);

    entries.push({
      index: i,
      name,
      filenameLength,
      entryHeaderSize,
      mainType,
      subType,
      unknown0,
      storedLength,
      originalLength,
      pad1,
      pad2,
      offset,
      dataEnd: rangeEnd,
      inBounds: rangeValid,
      valid: entryValid && !duplicate,
      duplicateName: duplicate,
      issues: [
        ...(nameLengthValid ? [] : ['invalid filename_length']),
        ...(validName ? [] : ['unsafe or empty filename']),
        ...(entryHeaderSize >= ENTRY.minimumBytes && entryHeaderSize <= fileHeaderLength ? [] : ['invalid entry header_size']),
        ...(rangeValid ? [] : ['payload range invalid']),
        ...(duplicate ? ['duplicate filename'] : []),
      ],
    });
  }

  return {
    magic: 'IMAGEWTY', version, versionHex: `0x${version.toString(16).padStart(8, '0')}`,
    versionMatchesV3: version === 0x300,
    headerSize, baseRam: b.readUInt32LE(MAIN.baseRam),
    formatVersion: b.readUInt32LE(MAIN.formatVersion),
    totalImageSize: b.readUInt32LE(MAIN.totalImageSize),
    headerSizeAligned: b.readUInt32LE(MAIN.headerSizeAligned),
    fileHeaderLength, count, tableOffset: TABLE_OFFSET, tableEnd,
    fileSize, entries,
    validEntries: entries.filter(x => x.valid).length,
    invalidEntries: entries.filter(x => !x.valid).length,
    profile: 'reference-implementation-layout',
    source: 'fuxdasec/imagewty-tool: include/img_header.h + src/img_header.c',
    notes: [
      'At 0x20 the main header stores file_header_length (not image_header_size).',
      'Each file header begins with filename_length, header_size, maintype, subtype and unknown0.',
      'The filename begins at entry offset 0x24; stored_length/original_length/offset are at 0x124/0x12c/0x134.',
      'Payload range is checked using original_length <= stored_length and offset >= end of header table.',
      'No generic per-file CRC is assumed; this reference tool verifies V*.fex checksums separately.',
    ],
  };
}

module.exports = { parseImagewtyHeader, MAIN, ENTRY, TABLE_OFFSET, MAIN_HEADER_BYTES };
