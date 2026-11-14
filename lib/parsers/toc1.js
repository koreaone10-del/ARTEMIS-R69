'use strict';
function parseToc1(input) {
  const b = Buffer.from(input);
  const magic = b.subarray(0, 4).toString('ascii');
  if (magic !== 'TOC1') throw new Error(`TOC1 magic mismatch (found ${JSON.stringify(magic)})`);
  if (b.length < 0x40) throw new Error('TOC1 header truncated');
  const header = { magic, version: b.readUInt32LE(4), length: b.readUInt32LE(8), itemsCount: b.readUInt32LE(12), fileSize: b.length };
  const candidates = [];
  // Vendor TOC1 layouts vary. The known R69 package has five named components;
  // this inspector reports a conservative header and never guesses entry offsets.
  for (const name of ['u-boot','scp','soc-cfg','dtb','optee']) candidates.push({ name, status: 'expected-from-prior-R69-inspection', offset: null, size: null });
  if (header.length && header.length > b.length) header.warning = 'Declared package length exceeds supplied bytes.';
  return { header, components: candidates, parseStatus: 'header-only; item table layout not validated for this vendor package', safe: true };
}
module.exports = { parseToc1 };
