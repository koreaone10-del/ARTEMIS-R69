'use strict';
const { parseEgon } = require('../parsers/egon');
const { parseToc1 } = require('../parsers/toc1');
function analyzeBootArtifacts(files) {
  const out = [];
  for (const f of files || []) {
    const name = String(f.name || 'unnamed'); const b = Buffer.from(f.bytes || []);
    if (name.toLowerCase().includes('boot0') || b.subarray(0,8).toString('ascii') === 'eGON.BT0') {
      try { out.push({ name, kind:'eGON Boot0', ...parseEgon(b) }); } catch(e) { out.push({ name, kind:'eGON Boot0', error:e.message }); }
    } else if (name.toLowerCase().includes('boot_package') || b.subarray(0,4).toString('ascii') === 'TOC1') {
      try { out.push({ name, kind:'TOC1 package', ...parseToc1(b) }); } catch(e) { out.push({ name, kind:'TOC1 package', error:e.message }); }
    } else out.push({ name, kind:'unknown/vendor payload', bytes:b.length, note:'No destructive interpretation attempted.' });
  }
  return out;
}
module.exports = { analyzeBootArtifacts };
