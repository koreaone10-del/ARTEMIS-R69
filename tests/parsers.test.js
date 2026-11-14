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

test('IMAGEWTY candidate parser validates table bounds and marks profile uncertain',()=>{const b=Buffer.alloc(1024);b.write('IMAGEWTY',0);b.writeUInt32LE(0x300,8);b.writeUInt32LE(0,60);const r=parseImagewtyHeader(b);assert.equal(r.versionMatches,true);assert.equal(r.count,0);assert.match(r.confidence,/candidate/);});
