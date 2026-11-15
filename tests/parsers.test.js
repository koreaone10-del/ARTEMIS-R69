'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEgon } = require('../lib/parsers/egon');
const { parseFex, parseDramConfig } = require('../lib/parsers/fex');
const { parsePartitions } = require('../lib/parsers/partitions');
const { parseToc1 } = require('../lib/parsers/toc1');
const { parseImagewtyHeader } = require('../lib/parsers/imagewty');
const { compareHardware } = require('../lib/analyzers/hardware');
function makeEgon(){const b=Buffer.alloc(64);b.write('eGON.BT0',0);b.writeUInt32LE(64,12);b.writeUInt32LE(0x40000000,16);b.writeUInt32LE(0x5f0a6c39,8);let s=0;for(let i=0;i<64;i+=4)s=(s+b.readUInt32LE(i))>>>0;b.writeUInt32LE(s,8);return b;}
test('eGON header validates magic, bounds and checksum',()=>{const r=parseEgon(makeEgon());assert.equal(r.validMagic,true);assert.equal(r.checksumValid,true);});
test('eGON rejects truncated data',()=>assert.throws(()=>parseEgon(Buffer.alloc(8))));
test('FEX parser reads DRAM configuration',()=>{const r=parseDramConfig('[dram_para]\ndram_clk = 336\ndram_type = 7\ndram_zq = 0x3939f9');assert.equal(r.dram_clk_mhz,336);assert.equal(r.dram_type,7);assert.equal(r.dram_zq,'0x3939f9');});
test('partition parser calculates sector bytes and warns about capacity inference',()=>{const r=parsePartitions('[partition]\nname = boot\nsize = 65536\n[partition]\nname = cache\nsize = 10');assert.equal(r.partitions.length,2);assert.equal(r.fixedBytes,65546*512);assert.match(r.caveat,/not proof/i);});
test('TOC1 inspector requires magic and returns conservative header-only status',()=>{const b=Buffer.alloc(64);b.write('TOC1');b.writeUInt32LE(1,4);b.writeUInt32LE(64,8);b.writeUInt32LE(5,12);const r=parseToc1(b);assert.equal(r.header.itemsCount,5);assert.match(r.parseStatus,/header-only/);});
test('hardware checker never treats VID/PID as SoC proof',()=>{const r=compareHardware({vendorId:0x1f3a,productId:0xefe8});assert.equal(r.checks[2].status,'not-read');assert.match(r.conclusion,/not proof/i);});

test('IMAGEWTY parser rejects a zero/invalid main-header size instead of fabricating empty entries',()=>{const b=Buffer.alloc(1024);b.write('IMAGEWTY',0);b.writeUInt32LE(0x300,8);b.writeUInt32LE(0,60);assert.throws(()=>parseImagewtyHeader(b),/header size|file count/);});

function makeImagewtyV3(count=1) {
  const entrySize=1024, tableOffset=0x400, tableEnd=tableOffset+count*entrySize;
  const b=Buffer.alloc(tableEnd+count*16);
  b.write('IMAGEWTY',0,'ascii');
  b.writeUInt32LE(0x300,0x08);
  b.writeUInt32LE(96,0x0c);
  b.writeUInt32LE(0x04d00000,0x10);
  b.writeUInt32LE(0x00100234,0x14);
  b.writeUInt32LE(b.length,0x18);
  b.writeUInt32LE(1024,0x1c);
  b.writeUInt32LE(entrySize,0x20);
  b.writeUInt32LE(count,0x3c);
  for(let i=0;i<count;i++){
    const p=tableOffset+i*entrySize, name=`payload-${i}.fex`, dataOffset=tableEnd+i*16;
    b.writeUInt32LE(Buffer.byteLength(name),p+0x00);
    b.writeUInt32LE(0x138,p+0x04);
    b.write('BOOT',p+0x08,'ascii');
    b.write('TEST',p+0x10,'ascii');
    b.write(name,p+0x24,'ascii');
    b.writeUInt32LE(8,p+0x124);
    b.writeUInt32LE(4,p+0x12c);
    b.writeUInt32LE(dataOffset,p+0x134);
    b.write('DATA',dataOffset,'ascii');
  }
  return b;
}

test('IMAGEWTY v3 reads real serialized entry fields and all 37 names',()=>{
  const {parseImagewtyHeader}=require('../lib/parsers/imagewty');
  const b=makeImagewtyV3(37),r=parseImagewtyHeader(b);
  assert.equal(r.version,0x300);
  assert.equal(r.fileHeaderLength,1024);
  assert.equal(r.count,37);
  assert.equal(r.validEntries,37);
  assert.equal(r.entries[0].name,'payload-0.fex');
  assert.equal(r.entries[0].offset,0x400+37*1024);
  assert.equal(r.entries[0].originalLength,4);
});

test('IMAGEWTY v3 rejects an entry pointing into its header table',()=>{
  const {parseImagewtyHeader}=require('../lib/parsers/imagewty');
  const b=makeImagewtyV3(1);b.writeUInt32LE(0,0x400+0x134);
  const r=parseImagewtyHeader(b);
  assert.equal(r.invalidEntries,1);
  assert.equal(r.entries[0].valid,false);
});

test('IMAGEWTY v3 rejects truncated metadata and unsafe filenames',()=>{
  const {parseImagewtyHeader}=require('../lib/parsers/imagewty');
  const b=makeImagewtyV3(1);b.write('../escape.fex',0x400+0x24,'ascii');
  b.writeUInt32LE(13,0x400);
  assert.equal(parseImagewtyHeader(b).entries[0].valid,false);
  assert.throws(()=>parseImagewtyHeader(b.subarray(0,800),{fileSize:b.length}));
});
