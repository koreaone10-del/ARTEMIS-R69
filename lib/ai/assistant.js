'use strict';
const BASE_SYSTEM = `You are ARTEMIS R69, a cautious embedded-systems and firmware analysis assistant. Target: SHUNJUEY R69-EMCP V2.0, reported Allwinner H3, dolphin-p1, SanDisk SD9DS28K-8G eMCP. Distinguish observed facts, firmware declarations, and hypotheses. Never invent successful hardware detection. Do not recommend pin shorting, arbitrary RAM execution, unverified DRAM patches, or writing eMMC/flash. No flash-writing or FEL_EXEC features exist. When reviewing code, identify exact defect, evidence, safe patch, and tests. Do not claim you executed or validated code unless test output is supplied. Keep advice suitable for phone-only Termux workflows.`;
function offlineAnswer(prompt, context) {
  const p = prompt.toLowerCase(); const facts = [];
  if (/fel|usb|1f3a|efe8/.test(p)) facts.push('VID/PID 1F3A:EFE8 confirms the USB device identity only; it does not prove a successful FEL_VERSION exchange or H3 SoC ID.');
  if (/dram|lpddr|zq|336/.test(p)) facts.push('The supplied firmware declares LPDDR3 (dram_type=7) at 336 MHz. This is a firmware configuration, not a live RAM test. The reported eMCP marking implies 8Gbit LPDDR3 = 1GB.');
  if (/boot0|egon|checksum/.test(p)) facts.push('eGON header fields: magic at 0x00, checksum at 0x08, declared length at 0x0C, entry point at 0x10. Checksum validation is read-only; recalculation is not a safe substitute for validating the payload.');
  if (/toc1|boot.package|uboot/.test(p)) facts.push('The known boot_package.fex was identified as TOC1 with u-boot, scp, soc-cfg, dtb and optee. This build reports the package header conservatively and does not guess unverified entry-table offsets.');
  if (/partition|udisk|emmc/.test(p)) facts.push('Partition totals from sys_partition.fex describe firmware metadata only. An unspecified UDISK and missing physical geometry mean the sum is not proof of eMMC capacity.');
  if (/imagewty|firmware|rom|update/.test(p)) facts.push('IMAGEWTY v3 layout varies by vendor. The parser marks its current field layout as a candidate profile and bounds-checks every table entry; confirm against extracted known payloads before relying on offsets.');
  if (/error|bug|fix|debug|code|javascript|python|node/.test(p)) facts.push('For a precise code repair, provide the failing function, exact error text, runtime/version, expected behavior and actual behavior. ARTEMIS can review a pasted snippet, propose a patch and list tests; it does not execute untrusted code.');
  if (!facts.length) facts.push('I can analyze firmware metadata, eGON headers, TOC1 headers, FEX configuration, partition maps, WebUSB descriptors and pasted code. Include the exact log or code excerpt for a specific diagnosis.');
  return { mode:'offline-expert', answer:facts.join('\n\n'), safety:'READ-ONLY. No FEL_WRITE, FEL_EXEC, eMMC writes, or automatic boot-image creation.' };
}
async function runAssistant(prompt, context) {
  const key = process.env.AI_API_KEY; const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,''); const model = process.env.AI_MODEL || 'gpt-4o-mini';
  if (!key) return offlineAnswer(prompt, context);
  const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), 45000);
  try {
    const r = await fetch(base + '/chat/completions', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`}, body:JSON.stringify({ model, temperature:0.15, messages:[{role:'system',content:BASE_SYSTEM},{role:'user',content:`Context JSON:\n${JSON.stringify(context).slice(0,12000)}\n\nRequest:\n${prompt}`}]}), signal:controller.signal });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || `AI provider HTTP ${r.status}`);
    return { mode:'connected-ai', model, answer:j.choices?.[0]?.message?.content || 'Provider returned an empty response.', safety:'Provider advice is advisory; hardware operations remain disabled.' };
  } finally { clearTimeout(timer); }
}
module.exports = { runAssistant, offlineAnswer };
