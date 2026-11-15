'use strict';
function parseFex(text) {
  const sections = []; let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[([^\]]+)\]/);
    if (m) { current = { name: m[1], values: {} }; sections.push(current); continue; }
    if (!current || !line || line.startsWith(';') || line.startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:;.*)?$/);
    if (kv) current.values[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return sections;
}
function getSection(sections, name) { return sections.find(s => s.name.toLowerCase() === name.toLowerCase()); }
function parseDramConfig(text) {
  const sections = parseFex(text);
  const all = Object.assign({}, ...sections.map(s => s.values));
  const num = k => all[k] == null ? null : (/^0x/i.test(all[k]) ? Number.parseInt(all[k],16) : Number(all[k]));
  return { machine: all.machine || null, dram_clk_mhz: num('dram_clk'), dram_type: num('dram_type'), dram_zq: all.dram_zq || null, dram_para1: all.dram_para1 || null, dram_para2: all.dram_para2 || null, tpr: Object.fromEntries(Object.entries(all).filter(([k]) => /^dram_tpr\d+$/.test(k))), interpretation: 'Firmware configuration only; not a live measurement of installed RAM.' };
}
module.exports = { parseFex, getSection, parseDramConfig };
