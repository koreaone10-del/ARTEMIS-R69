'use strict';
const EXPECTED = { vendorId:0x1f3a, productId:0xefe8, socName:'Allwinner H3', socId:0x1680, board:'dolphin-p1', memory:'SanDisk SD9DS28K-8G eMCP (reported: 8GB eMMC + 8Gbit LPDDR3 = 1GB)' };
function compareHardware(observed={}) {
  const checks = [
    { label:'USB VID', expected:'0x1f3a', observed:observed.vendorId == null ? null : '0x'+Number(observed.vendorId).toString(16), status:observed.vendorId == null ? 'unknown' : Number(observed.vendorId)===EXPECTED.vendorId?'match':'mismatch' },
    { label:'USB PID', expected:'0xefe8', observed:observed.productId == null ? null : '0x'+Number(observed.productId).toString(16), status:observed.productId == null ? 'unknown' : Number(observed.productId)===EXPECTED.productId?'match':'mismatch' },
    { label:'SoC ID', expected:'0x1680 (H3)', observed:observed.socId == null ? null : '0x'+Number(observed.socId).toString(16), status:observed.socId == null ? 'not-read' : Number(observed.socId)===EXPECTED.socId?'match':'mismatch' }
  ];
  return { expected:EXPECTED, checks, conclusion:observed.socId == null ? 'USB identity is not proof of H3 silicon. FEL protocol SoC ID has not been verified.' : checks[2].status==='match' ? 'H3 SoC ID matches expected value.' : 'SoC ID mismatch: stop device-specific operations.', persistentActionsAllowed:false };
}
module.exports = { EXPECTED, compareHardware };
