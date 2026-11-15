'use strict';
const BASE_SYSTEM = `You are ARTEMIS R69, a cautious embedded-systems and firmware analysis assistant. Target: SHUNJUEY R69-EMCP V2.0, reported Allwinner H3, dolphin-p1, SanDisk SD9DS28K-8G eMCP. Distinguish observed facts, firmware declarations, and hypotheses. Never invent successful hardware detection. Do not recommend pin shorting, arbitrary RAM execution, unverified DRAM patches, or writing eMMC/flash. No flash-writing or FEL_EXEC features exist. When reviewing code, identify exact defect, evidence, safe patch, and tests. Do not claim you executed or validated code unless test output is supplied. Keep advice suitable for phone-only Termux workflows.`;
function getAIStatus() {
  const configuredBase = process.env.AI_BASE_URL && process.env.AI_BASE_URL.trim();
  const model = process.env.AI_MODEL || (configuredBase ? 'configured-open-source-model' : null);
  return {
    mode: configuredBase ? 'openai-compatible-no-key-or-keyed' : 'offline-rules',
    model,
    endpointConfigured: Boolean(configuredBase),
    authentication: process.env.AI_API_KEY ? 'bearer-key' : 'none',
    note: configuredBase ? 'Endpoint configured; availability is checked when a request is sent.' : 'No model endpoint configured. Deterministic local rules are active; this is not generative AI.'
  };
}
function offlineAnswer(prompt, context) {
  const p = prompt.toLowerCase(); const facts = [];
  if (/fel|usb|1f3a|efe8/.test(p)) facts.push('VID/PID 1F3A:EFE8 confirms the USB device identity only; it does not prove a successful FEL_VERSION exchange or H3 SoC ID.');
  if (/dram|lpddr|zq|336/.test(p)) facts.push('The supplied firmware declares LPDDR3 (dram_type=7) at 336 MHz. This is a firmware configuration, not a live RAM test. The reported eMCP marking implies 8Gbit LPDDR3 = 1GB.');
  if (/boot0|egon|checksum/.test(p)) facts.push('eGON header fields: magic at 0x00, checksum at 0x08, declared length at 0x0C, entry point at 0x10. Checksum validation is read-only; recalculation is not a safe substitute for validating the payload.');
  if (/toc1|boot.package|uboot/.test(p)) facts.push('The known boot_package.fex was identified as TOC1 with u-boot, scp, soc-cfg, dtb and optee. This build reports the package header conservatively and does not guess unverified entry-table offsets.');
  if (/partition|udisk|emmc/.test(p)) facts.push('Partition totals from sys_partition.fex describe firmware metadata only. An unspecified UDISK and missing physical geometry mean the sum is not proof of eMMC capacity.');
  if (/imagewty|firmware|rom|update/.test(p)) facts.push('IMAGEWTY v3 parser uses the serialized field layout cross-checked against fuxdasec/imagewty-tool: the table starts at 0x400, file_header_length is at main-header 0x20, filename_length is at entry 0x00, filename at 0x24, stored_length at 0x124, original_length at 0x12c and data offset at 0x134. Every payload range is bounds-checked; no generic CRC is assumed.');
  if (/error|bug|fix|debug|code|javascript|python|node/.test(p)) facts.push('For a precise code repair, provide the failing function, exact error text, runtime/version, expected behavior and actual behavior. ARTEMIS can review a pasted snippet, propose a patch and list tests; it does not execute untrusted code.');
  if (!facts.length) facts.push('I can analyze firmware metadata, eGON headers, TOC1 headers, FEX configuration, partition maps, WebUSB descriptors and pasted code. Include the exact log or code excerpt for a specific diagnosis.');
  return { mode:'offline-expert', answer:facts.join('\n\n'), safety:'READ-ONLY. No FEL_WRITE, FEL_EXEC, eMMC writes, or automatic boot-image creation.' };
}
async function runAssistant(prompt, context) {
  const configuredBase = (process.env.AI_BASE_URL || '').trim();
  if (!configuredBase) return offlineAnswer(prompt, context);
  const key = process.env.AI_API_KEY || '';
  const base = configuredBase.replace(/\/$/, '');
  const model = process.env.AI_MODEL || 'Qwen2.5-Coder-1.5B-Instruct-GGUF';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 90000));
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model, temperature: 0.15, messages: [
        { role: 'system', content: BASE_SYSTEM },
        { role: 'user', content: `Context JSON:\n${JSON.stringify(context).slice(0, 12000)}\n\nRequest:\n${prompt}` }
      ] }), signal: controller.signal
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || `AI provider HTTP ${r.status}`);
    return { mode: key ? 'connected-ai' : 'open-source-no-key', model, answer: j.choices?.[0]?.message?.content || 'Provider returned an empty response.', safety: 'AI output is advisory. ARTEMIS does not write to device storage or execute boot code.' };
  } catch (error) {
    const fallback = offlineAnswer(prompt, context);
    return { ...fallback, mode: 'offline-fallback', providerError: error.name === 'AbortError' ? 'AI endpoint timed out.' : error.message };
  } finally { clearTimeout(timer); }
}
module.exports = { runAssistant, offlineAnswer, getAIStatus };
