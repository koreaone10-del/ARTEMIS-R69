'use strict';
const SECTOR_BYTES = 512;
function parsePartitions(text) {
  const blocks = String(text).split(/\[(?:partition)\]/i).slice(1); const rows = [];
  for (const block of blocks) {
    const get = k => { const m = block.match(new RegExp('^\\s*' + k + '\\s*=\\s*([^\\r\\n;]+)', 'im')); return m ? m[1].trim().replace(/^['"]|['"]$/g,'') : null; };
    const name = get('name'); if (!name) continue;
    const sectors = Number(get('size'));
    rows.push({ name, sectors: Number.isFinite(sectors) && sectors >= 0 ? sectors : null, bytes: Number.isFinite(sectors) && sectors >= 0 ? sectors * SECTOR_BYTES : null, downloadfile: get('downloadfile'), user_type: get('user_type') });
  }
  const known = rows.filter(x => Number.isFinite(x.sectors));
  const totalSectors = known.reduce((n,x) => n+x.sectors,0);
  return { sectorBytes: SECTOR_BYTES, partitions: rows, fixedSectorTotal: totalSectors, fixedBytes: totalSectors*SECTOR_BYTES, fixedGiB: totalSectors*SECTOR_BYTES/(1024**3), caveat: 'UDISK may be unspecified/remaining space; this sum is not proof of physical eMMC capacity or live partition geometry.' };
}
module.exports = { parsePartitions, SECTOR_BYTES };
