const $ = id => document.getElementById(id);
const state = { firmware:null, firmwareAnalysis:null, dram:null, partitions:null, boot:[], usb:null, logs:[] };
const log = (type, message) => { state.logs.push({at:new Date().toISOString(),type,message}); if(state.logs.length>300)state.logs.shift(); };
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n).toLocaleString('en-US');
function go(view){document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.navitem').forEach(x=>x.classList.toggle('active',x.dataset.view===view));$('view-'+view).classList.add('active');$('pageTitle').textContent=document.querySelector(`[data-view="${view}"] span`)?.textContent||'ARTEMIS';}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
async function readSlice(file,start,end){return new Uint8Array(await file.slice(start,end).arrayBuffer());}
function u32(v,o){return new DataView(v.buffer,v.byteOffset,v.byteLength).getUint32(o,true);}
function hex(n){return '0x'+Number(n).toString(16).padStart(8,'0');}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),3000);}

// One-tap smart discovery. This is deliberately read-only: it never sends FEL_WRITE/FEL_EXEC.
const SMART_PROFILE = { expectedVid: 0x1f3a, expectedPid: 0xefe8, soc: 'Allwinner H3 (reported)', board: 'R69-EMCP V2.0 (reported)', memory: 'SanDisk SD9DS28K-8G / LPDDR3 (reported)' };
const smartStep = (name, text, cls='ok') => { const el = document.querySelector(`[data-smart-step="${name}"]`); if(el){ el.textContent = text; el.className = cls; } };
const smartJson = value => JSON.stringify(value, null, 2);
function smartEndpoints(device) {
  const endpoints = [];
  const interfaces = [];
  const config = device.configuration;
  if (!config) return { interfaces, endpoints };
  for (const iface of config.interfaces) for (const alt of iface.alternates) {
    const row = { interfaceNumber: iface.interfaceNumber, alternateSetting: alt.alternateSetting, interfaceClass: alt.interfaceClass, interfaceSubclass: alt.interfaceSubclass, interfaceProtocol: alt.interfaceProtocol, endpoints: [] };
    for (const ep of alt.endpoints) { const item = { number: ep.endpointNumber, direction: ep.direction, type: ep.type, packetSize: ep.packetSize }; row.endpoints.push(item); endpoints.push({ ...item, interfaceNumber: iface.interfaceNumber }); }
    interfaces.push(row);
  }
  return { interfaces, endpoints };
}
function smartFindings(device, topology) {
  const vid = device.vendorId === SMART_PROFILE.expectedVid;
  const pid = device.productId === SMART_PROFILE.expectedPid;
  const bulkIn = topology.endpoints.filter(e => e.direction === 'in' && e.type === 'bulk');
  const bulkOut = topology.endpoints.filter(e => e.direction === 'out' && e.type === 'bulk');
  const findings = [];
  findings.push({ level: vid && pid ? 'pass' : 'warn', code: 'USB_IDENTITY', message: vid && pid ? 'VID/PID يطابقان واجهة Allwinner FEL المتوقعة.' : 'المعرف لا يطابق 1F3A:EFE8؛ لا تتابع إلى أي كتابة.' });
  findings.push({ level: bulkIn.length && bulkOut.length ? 'pass' : 'fail', code: 'BULK_ENDPOINTS', message: bulkIn.length && bulkOut.length ? `تم العثور على Bulk IN=${bulkIn.map(x=>x.number).join(',')} وBulk OUT=${bulkOut.map(x=>x.number).join(',')}.` : 'لم يتم العثور على Bulk IN وBulk OUT معاً.' });
  findings.push({ level: 'info', code: 'FEL_PROTOCOL', message: 'تم فحص الواصفات فقط. لم يتم إثبات FEL_VERSION ولم يتم إرسال أمر FEL.' });
  findings.push({ level: 'info', code: 'BOARD_MATCH', message: 'H3/R69 وذاكرة eMCP معلومات مرجعية وليست قراءة مباشرة من الشريحة.' });
  findings.push({ level: 'blocked', code: 'PERSISTENT_WRITE', message: 'كتابة eMCP وFEL_EXEC محجوزان حتى تتوفر نسخة احتياطية وتوافق مثبت.' });
  return { findings, bulkIn, bulkOut, vid, pid };
}
async function runSmartScan() {
  const summary = $('smartSummary'), findingsBox = $('smartFindings'), badge = $('smartBadge');
  if (!summary || !findingsBox) return;
  smartStep('browser', navigator.usb ? '✓ WebUSB متاح' : '■ غير متاح', navigator.usb ? 'ok' : 'danger');
  if (!navigator.usb) { badge.textContent = 'توقف: WebUSB'; summary.textContent = 'استخدم Chrome/Chromium على Android عبر HTTPS أو localhost.'; findingsBox.textContent = 'الإصلاح: فعّل USB OTG، استخدم متصفحاً يدعم WebUSB، وتأكد من صلاحية USB Host.'; return; }
  badge.textContent = 'جاري الفحص'; smartStep('usb', '◌ طلب الإذن…', 'warn');
  try {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: SMART_PROFILE.expectedVid, productId: SMART_PROFILE.expectedPid }] });
    state.usb = device;
    const topology = smartEndpoints(device);
    const result = smartFindings(device, topology);
    smartStep('usb', result.vid && result.pid ? '✓ FEL VID/PID' : '⚠ معرف غير متوقع', result.vid && result.pid ? 'ok' : 'warn');
    smartStep('endpoints', `${result.bulkIn.length}/${result.bulkOut.length} Bulk`, result.bulkIn.length && result.bulkOut.length ? 'ok' : 'danger');
    smartStep('profile', result.vid && result.pid ? '⚠ مرشح H3/R69' : '■ غير مطابق', result.vid && result.pid ? 'warn' : 'danger');
    smartStep('write', '■ محجوز', 'danger');
    badge.textContent = result.vid && result.pid ? 'تم التعرف' : 'تحذير'; badge.className = result.vid && result.pid ? 'tag blue' : 'tag';
    const identity = { vendorId: hex(device.vendorId), productId: hex(device.productId), manufacturerName: device.manufacturerName || null, productName: device.productName || null, serialNumber: device.serialNumber || null, usbVersionMajor: device.usbVersionMajor, configuration: device.configuration?.configurationValue ?? null, profile: SMART_PROFILE, interfaces: topology.interfaces, felVersionRead: false, felWriteEnabled: false, felExecEnabled: false };
    summary.textContent = smartJson(identity);
    findingsBox.textContent = smartJson({ findings: result.findings, nextAction: result.vid && result.bulkIn.length && result.bulkOut.length ? 'اقرأ تقرير الجهاز واطلب مراجعة توافق قبل أي استعادة.' : 'صحح الاتصال والواجهة أولاً.', safety: 'تشخيص فقط؛ لم يتم إرسال بيانات إلى SRAM/DRAM/eMCP.' });
    log('smart-scan', `Smart scan completed for ${hex(device.vendorId)}:${hex(device.productId)}; no write/exec.`);
  } catch (e) {
    badge.textContent = 'فشل أو إلغاء'; smartStep('usb', '■ لم يتم الاتصال', 'danger'); smartStep('endpoints', '◌ لم يُفحص', 'warn'); smartStep('profile', '◌ لم يُفحص', 'warn');
    summary.textContent = `لم تكتمل الجلسة: ${e.message}`;
    findingsBox.textContent = 'الإصلاحات المقترحة:\n1) أدخل الجهاز في FEL قبل فتح الطلب.\n2) افصل الطاقة ثم أعد توصيل OTG.\n3) اختر 1F3A:EFE8 فقط.\n4) لا تستخدم كتابة eMCP من المتصفح.';
    log('smart-scan-error', e.message);
  }
}
$('smartScan')?.addEventListener('click', runSmartScan);

// USB: descriptor enumeration only. This code intentionally sends no FEL transfer.
$('usbConnect').addEventListener('click',async()=>{
  if(!navigator.usb){$('usbResult').textContent='WebUSB غير متاح في هذا المتصفح. جرّب Chrome على Android مع HTTPS أو localhost.';return;}
  try{
    const d=await navigator.usb.requestDevice({filters:[{vendorId:0x1f3a,productId:0xefe8}]});
    state.usb=d; const config=d.configuration; const interfaces=[];
    if(config) for(const i of config.interfaces) for(const a of i.alternates){interfaces.push({interfaceNumber:i.interfaceNumber,alternateSetting:a.alternateSetting,classCode:a.interfaceClass,subclassCode:a.interfaceSubclass,protocolCode:a.interfaceProtocol,endpoints:a.endpoints.map(e=>({number:e.endpointNumber,direction:e.direction,type:e.type,packetSize:e.packetSize}))});}
    $('usbBadge').textContent='USB descriptor read';$('usbBadge').className='tag blue';
    $('usbResult').textContent=JSON.stringify({vendorId:hex(d.vendorId),productId:hex(d.productId),manufacturerName:d.manufacturerName||null,productName:d.productName||null,serialNumber:d.serialNumber||null,usbVersionMajor:d.usbVersionMajor,deviceVersionMajor:d.deviceVersionMajor,configuration:config?.configurationValue??null,interfaces,conclusion:'USB identity only. FEL_VERSION and SoC ID have NOT been read.'},null,2);
    log('usb','USB descriptors inspected; no FEL command sent.');
  }catch(e){$('usbResult').textContent=`USB request cancelled or failed: ${e.message}`;log('usb-error',e.message);}
});
$('usbDisconnect').addEventListener('click',async()=>{try{if(state.usb?.opened)await state.usb.close();}catch{}state.usb=null;$('usbBadge').textContent='غير متصل';$('usbBadge').className='tag';$('usbResult').textContent='تم إنهاء جلسة فحص الواصفات.';});

// Termux bridge (localhost only, read-only v1).
// The bridge server runs on http://127.0.0.1:3001 in Termux.
// From Render (https) this fetch cannot work: mixed content and a
// different host. The page says so instead of faking a connection.
const BRIDGE_BASE = 'http://127.0.0.1:3001';
let bridgeReport = null;
const bridgeIsLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
async function bridgeCall(pathname, options) {
  if (!bridgeIsLocal) throw Error('افتح ARTEMIS محلياً على http://127.0.0.1:3000 — صفحة الجسر لا تعمل من Render.');
  const r = await fetch(BRIDGE_BASE + pathname, options);
  const j = await r.json().catch(() => ({ ok: false, error: 'bad_json' }));
  if (!r.ok) throw Error(j.message || j.error || `bridge HTTP ${r.status}`);
  return j;
}
$('bridgeStatus')?.addEventListener('click', async () => {
  const out = $('bridgeStatusResult'), badge = $('bridgeBadge');
  if (!out) return;
  out.textContent = 'جارٍ فحص الجسر…';
  try {
    const s = await bridgeCall('/api/bridge/status');
    badge.textContent = s.usbProbeAvailable && s.felVersionAvailable ? 'الجسر يعمل' : 'الجسر يعمل — أدوات ناقصة';
    badge.className = 'tag blue';
    out.textContent = JSON.stringify(s, null, 2);
    log('bridge-status', 'Bridge status checked.');
  } catch (e) {
    badge.textContent = 'الجسر غير مشغّل';
    badge.className = 'tag';
    out.textContent = `الجسر غير متاح: ${e.message}\n\nتأكد من:\n1) تشغيل bash bridge/run-bridge.sh في Termux\n2) فتح ARTEMIS من http://127.0.0.1:3000 وليس من Render\n3) أن المنفذ 3001 غير محجوب على الهاتف`;
    log('bridge-status-error', e.message);
  }
});
async function bridgeRun(pathname, label) {
  const out = $('bridgeResult');
  const device = $('bridgeDevice')?.value.trim();
  if (!out) return;
  if (!device) { out.textContent = 'أدخل مسار الجهاز من termux-usb -l أولاً، مثال: /dev/bus/usb/001/002'; return; }
  out.textContent = `جارٍ ${label}… لا تغلق الصفحة.`;
  try {
    const j = await bridgeCall(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device }) });
    bridgeReport = j;
    out.textContent = JSON.stringify(j, null, 2);
    log('bridge', `${label} completed for ${device}`);
  } catch (e) {
    bridgeReport = null;
    out.textContent = `فشل ${label}: ${e.message}`;
    log('bridge-error', e.message);
  }
}
$('bridgeProbe')?.addEventListener('click', () => bridgeRun('/api/bridge/probe', 'فحص USB'));
$('bridgeFelVersion')?.addEventListener('click', () => bridgeRun('/api/bridge/fel-version', 'قراءة FEL_VERSION'));
$('bridgeCopyReport')?.addEventListener('click', async () => {
  const out = $('bridgeResult');
  if (!bridgeReport) { if (out) out.textContent = 'لا يوجد تقرير بعد. شغّل فحص USB أو FEL_VERSION أولاً.'; return; }
  try { await navigator.clipboard.writeText(JSON.stringify(bridgeReport, null, 2)); if (out) out.textContent = 'تم نسخ التقرير. أرسله إلى Muse للتحليل.\n\n' + JSON.stringify(bridgeReport, null, 2); }
  catch { if (out) out.textContent = 'تعذّر النسخ التلقائي. حدّد نص التقرير وانسخه يدوياً.\n\n' + JSON.stringify(bridgeReport, null, 2); }
});

// Termux bridge v2: FEL_READ (SRAM + SID), pattern write/read-back,
// SPL upload (SRAM only) and session-gated FEL_EXEC.
// All write/exec calls require an explicit confirm; exec is refused
// by the server unless the address was written in this session.
const FEL_PATTERN = new TextEncoder().encode('HELLO-FEL-PATTERN-0123456789');
let felPatternSha256 = null; // computed at runtime with crypto.subtle, never hardcoded
function base64EncodeBytes(bytes) {
  // Chunked: String.fromCharCode(...bytes) would overflow the
  // argument limit for a 128 KiB SPL upload.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function bridgeDeviceOrThrow() {
  const device = $('bridgeDevice')?.value.trim();
  if (!device) throw Error('أدخل مسار الجهاز من termux-usb -l أولاً، مثال: /dev/bus/usb/001/002');
  return device;
}
function bridgeSetReport(j) { bridgeReport = j; }
$('bridgeSession')?.addEventListener('click', async () => {
  const out = $('bridgeSessionResult');
  if (!out) return;
  out.textContent = 'جارٍ عرض الجلسة…';
  try {
    const s = await bridgeCall('/api/bridge/session');
    out.textContent = JSON.stringify(s, null, 2);
    refreshSplExecState(s.written || []);
    log('bridge-session', `Session has ${(s.written || []).length} written range(s).`);
  } catch (e) { out.textContent = `تعذّر عرض الجلسة: ${e.message}`; }
});
$('felReadRun')?.addEventListener('click', async () => {
  const out = $('felReadResult');
  if (!out) return;
  out.textContent = 'جارٍ FEL_READ… لا تغلق الصفحة.';
  try {
    const device = bridgeDeviceOrThrow();
    const address = $('felReadAddr')?.value.trim();
    const length = Number($('felReadLen')?.value);
    const j = await bridgeCall('/api/bridge/fel-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, address, length }) });
    bridgeSetReport(j);
    out.textContent = JSON.stringify(j, null, 2);
    log('bridge-fel-read', `FEL_READ ${address} x${length} ok.`);
  } catch (e) { out.textContent = `فشل FEL_READ: ${e.message}`; log('bridge-fel-read-error', e.message); }
});
async function felWriteBytes(address, bytes, spl) {
  const device = bridgeDeviceOrThrow();
  const base64 = base64EncodeBytes(bytes);
  const sha256 = await sha256Hex(bytes);
  if (!confirm(`كتابة ${bytes.length} بايت إلى SRAM على العنوان ${address}؟\nهذه كتابة إلى SRAM فقط (متقلّبة)، وليست إلى eMMC أو Flash. الجهاز يجب أن يبقى في وضع FEL.`)) throw Error('ألغى المستخدم الكتابة.');
  const j = await bridgeCall('/api/bridge/fel-write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, address, base64, sha256, confirm: true, spl: Boolean(spl) }) });
  bridgeSetReport(j);
  return j;
}
$('felPatternWrite')?.addEventListener('click', async () => {
  const out = $('felPatternResult');
  if (!out) return;
  out.textContent = 'جارٍ كتابة النمط إلى 0x1000…';
  try {
    if (!felPatternSha256) felPatternSha256 = await sha256Hex(FEL_PATTERN);
    const j = await felWriteBytes('0x1000', FEL_PATTERN, false);
    out.textContent = `تمت الكتابة. SHA-256 المتوقع للنمط: ${felPatternSha256}\n\n` + JSON.stringify(j, null, 2) + '\n\nالآن اضغط "قراءة 0x1000 ومقارنة SHA-256".';
    log('bridge-pattern-write', 'Pattern written to 0x1000.');
    await refreshSessionQuiet();
  } catch (e) { out.textContent = `فشلت كتابة النمط: ${e.message}`; log('bridge-pattern-write-error', e.message); }
});
$('felPatternVerify')?.addEventListener('click', async () => {
  const out = $('felPatternResult');
  if (!out) return;
  out.textContent = 'جارٍ قراءة 0x1000 ومقارنة SHA-256…';
  try {
    const device = bridgeDeviceOrThrow();
    if (!felPatternSha256) felPatternSha256 = await sha256Hex(FEL_PATTERN);
    const j = await bridgeCall('/api/bridge/fel-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, address: '0x1000', length: FEL_PATTERN.length }) });
    bridgeSetReport(j);
    const match = j.sha256 === felPatternSha256;
    out.textContent = (match ? '✓ تطابق SHA-256 — الكتابة والقراءة تعملان.\n' : '✗ عدم تطابق SHA-256 — لا تتابع إلى SPL.\n') + `المتوقع: ${felPatternSha256}\nالمقروء: ${j.sha256}\n\n` + JSON.stringify(j, null, 2);
    log('bridge-pattern-verify', match ? 'Pattern read-back matches.' : 'Pattern read-back MISMATCH.');
  } catch (e) { out.textContent = `فشلت قراءة التحقق: ${e.message}`; log('bridge-pattern-verify-error', e.message); }
});
async function refreshSessionQuiet() {
  try {
    const s = await bridgeCall('/api/bridge/session');
    const out = $('bridgeSessionResult');
    if (out) out.textContent = JSON.stringify(s, null, 2);
    refreshSplExecState(s.written || []);
  } catch { /* session display is best-effort */ }
}
function refreshSplExecState(written) {
  const addr = ($('splAddress')?.value || '0x00000000').trim().toLowerCase();
  const n = written.some(r => {
    const start = Number(r.address);
    const target = addr.startsWith('0x') ? parseInt(addr, 16) : Number(addr);
    return target >= start && target < start + Number(r.length);
  });
  const execBtn = $('splExec');
  if (execBtn) execBtn.disabled = !n;
}
let splFileBytes = null, splFileSha256 = null;
$('splFile')?.addEventListener('change', async e => {
  const f = e.target.files?.[0] || null;
  const meta = $('splFileMeta'), writeBtn = $('splWrite');
  splFileBytes = null; splFileSha256 = null;
  if (writeBtn) writeBtn.disabled = true;
  if (!f) { if (meta) meta.textContent = 'لم يتم اختيار ملف SPL.'; return; }
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > 32768) { if (meta) meta.textContent = `الملف كبير جداً: ${buf.length} بايت (الحد 32768). SPL أكبر من SPL_LEN_LIMIT مرفوض في v2.`; return; }
    splFileSha256 = await sha256Hex(buf);
    splFileBytes = buf;
    if (meta) meta.textContent = `File: ${f.name}\nSize: ${buf.length} bytes\nSHA-256: ${splFileSha256}\n\nتحقق من الترويسة في "مختبر Bootloader" (eGON.BT0) قبل الكتابة.`;
    updateSplWriteButton();
    log('bridge-spl-file', `SPL file selected: ${f.name} (${buf.length} bytes).`);
  } catch (err) { if (meta) meta.textContent = `تعذّرت قراءة الملف: ${err.message}`; }
});
function updateSplWriteButton() {
  const writeBtn = $('splWrite');
  if (!writeBtn) return;
  writeBtn.disabled = !(splFileBytes && $('splAcknowledge')?.checked);
}
$('splAcknowledge')?.addEventListener('change', updateSplWriteButton);
$('splWrite')?.addEventListener('click', async () => {
  const out = $('splResult');
  if (!out) return;
  if (!splFileBytes) { out.textContent = 'اختر ملف SPL أولاً.'; return; }
  out.textContent = 'جارٍ كتابة SPL إلى SRAM… لا تفصل الجهاز.';
  try {
    const address = $('splAddress')?.value.trim() || '0x00000000';
    const j = await felWriteBytes(address, splFileBytes, true);
    out.textContent = `تمت كتابة SPL (${splFileBytes.length} بايت) إلى ${address}.\nSHA-256: ${splFileSha256}\n\n` + JSON.stringify(j, null, 2) + '\n\nزر "تنفيذ SPL" أصبح متاحاً بعد ظهور النطاق في الجلسة — ويتطلب تأكيداً ثانياً.';
    log('bridge-spl-write', `SPL written to ${address}.`);
    await refreshSessionQuiet();
  } catch (e) { out.textContent = `فشلت كتابة SPL: ${e.message}`; log('bridge-spl-write-error', e.message); }
});
$('splExec')?.addEventListener('click', async () => {
  const out = $('splResult');
  if (!out) return;
  out.textContent = 'جارٍ تنفيذ SPL…';
  try {
    const device = bridgeDeviceOrThrow();
    const address = $('splAddress')?.value.trim() || '0x00000000';
    if (!confirm(`تنفيذ الكود على العنوان ${address} في SRAM؟\nتأكيد ثانٍ: SPL الذي يستلم الجهاز لن يعود، وقد لا يأتي رد حالة FEL. أعد فحص FEL_VERSION بعدها.`)) throw Error('ألغى المستخدم التنفيذ.');
    const j = await bridgeCall('/api/bridge/fel-exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, address, confirm: true }) });
    bridgeSetReport(j);
    out.textContent = JSON.stringify(j, null, 2) + '\n\nأعد فحص FEL_VERSION الآن: إذا ردّ، فالـSPL لم يستلم الجهاز؛ وإذا لم يردّ، فقد يعمل SPL أو تعطّل الجهاز — أعد إدخاله في FEL وأعد الفحص.';
    log('bridge-spl-exec', `SPL exec at ${address}.`);
  } catch (e) { out.textContent = `فشل تنفيذ SPL: ${e.message}\n\nإذا كانت الرسالة عن مهلة (timeout)، فقد يكون SPL يعمل فعلاً — أعد فحص FEL_VERSION قبل افتراض الفشل.`; log('bridge-spl-exec-error', e.message); }
});
// Termux bridge v3: SPL + U-Boot (fel_spl_uboot) — upstream sunxi-fel
// swap/thunk flow. Single Write+Exec call; the server validates the
// full file and the C tool re-validates it, runs the thunk, requires
// eGON.FEL, then stages U-Boot proper in DRAM and executes it.
// The v2 raw SPL write above is DEPRECATED (it killed FEL on
// 2026-11-17) — do not use it for SPL upload any more.
const UB_MAX_FILE = 600 * 1024;
const UB_EXPECTED = { size: 559480, sha256: '8c70a1809803b0bc22ba74217bb95312701c55ce1fb18342d08b5cf655ece071' };
let ubFileBytes = null, ubFileSha256 = null;
function ubValidateHeaders(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const egon = new TextDecoder().decode(buf.subarray(4, 12));
  if (egon !== 'eGON.BT0') return { ok: false, error: 'لا توجد ترويسة eGON.BT0 في الإزاحة 4' };
  const splLen = view.getUint32(16, true);
  if (splLen > 32768 || splLen % 4 !== 0) return { ok: false, error: 'طول SPL غير صالح (يجب أن يكون ≤ 32768 ومضاعفاً لـ 4)' };
  let c = ((2 * view.getUint32(12, true)) - 0x5F0A6C39) >>> 0;
  for (let i = 0; i < splLen / 4; i++) c = (c - view.getUint32(i * 4, true)) >>> 0;
  if (c !== 0) return { ok: false, error: 'فشل checksum لـ eGON' };
  if (buf.length <= 32768 + 64) return { ok: false, error: 'لا يوجد U-Boot proper في الملف — هذا ملف SPL وحده، مرفوض هنا' };
  if (view.getUint32(32768, false) !== 0x27051956) return { ok: false, error: 'ترويسة mkimage غير صالحة عند الإزاحة 32768' };
  if (buf[32768 + 29] !== 2) return { ok: false, error: 'معمارية U-Boot ليست ARM' };
  if (buf[32768 + 30] !== 5) return { ok: false, error: 'نوع U-Boot ليس IH_TYPE_FIRMWARE' };
  const load = view.getUint32(32768 + 16, false);
  const entry = view.getUint32(32768 + 20, false);
  const size = view.getUint32(32768 + 12, false);
  if (size !== buf.length - 32768 - 64) return { ok: false, error: 'حجم بيانات U-Boot لا يطابق طول الملف' };
  return { ok: true, splLen, load, entry, size };
}
function updateUbWriteExecButton() {
  const btn = $('ubWriteExec');
  if (!btn) return;
  btn.disabled = !(ubFileBytes && $('ubAcknowledge')?.checked);
}
$('ubFile')?.addEventListener('change', async e => {
  const f = e.target.files?.[0] || null;
  const meta = $('ubFileMeta');
  ubFileBytes = null; ubFileSha256 = null;
  updateUbWriteExecButton();
  if (!f) { if (meta) meta.textContent = 'لم يتم اختيار الملف الكامل.'; return; }
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (buf.length > UB_MAX_FILE) { if (meta) meta.textContent = `الملف كبير جداً: ${buf.length} بايت (الحد 600KB). اختر الملف الكامل u-boot-sunxi-with-spl.bin (559,480 بايت).`; return; }
    ubFileSha256 = await sha256Hex(buf);
    const v = ubValidateHeaders(buf);
    if (!v.ok) { if (meta) meta.textContent = `File: ${f.name}\nSize: ${buf.length} bytes\nSHA-256: ${ubFileSha256}\n\n✗ الملف مرفوض: ${v.error}\nتأكد أن هذا هو الملف الكامل u-boot-sunxi-with-spl.bin وليس SPL وحده.`; return; }
    ubFileBytes = buf;
    const shaMatch = ubFileSha256 === UB_EXPECTED.sha256;
    if (meta) meta.textContent = `File: ${f.name}\nSize: ${buf.length} bytes\nSHA-256: ${ubFileSha256}\nSPL length: ${v.splLen} bytes\nU-Boot load/entry: 0x${v.load.toString(16)} / 0x${v.entry.toString(16)}, payload ${v.size} bytes\n\n${buf.length === UB_EXPECTED.size && shaMatch ? '✓ يطابق البناء المتوقع (LPDDR3 336 MHz, ZQ 3750393).' : '⚠ لا يطابق SHA-256 المتوقع للبناء الحالي (8c70a180…ece071). إذا كان هذا بناءً جديداً (مثلاً CLK 300)، فهذا متوقع — تأكد من مصدر الملف قبل المتابعة.'}`;
    updateUbWriteExecButton();
    log('bridge-spl-uboot-file', `Full U-Boot file selected: ${f.name} (${buf.length} bytes, sha ${ubFileSha256.slice(0, 12)}…).`);
  } catch (err) { if (meta) meta.textContent = `تعذّرت قراءة الملف: ${err.message}`; }
});
$('ubAcknowledge')?.addEventListener('change', updateUbWriteExecButton);
$('ubWriteExec')?.addEventListener('click', async () => {
  const out = $('ubResult');
  if (!out) return;
  if (!ubFileBytes) { out.textContent = 'اختر الملف الكامل أولاً.'; return; }
  out.textContent = 'جارٍ كتابة SPL + تنفيذ U-Boot… قد يستغرق حتى 60 ثانية. لا تفصل الجهاز ولا تغلق الصفحة.';
  try {
    const device = bridgeDeviceOrThrow();
    if (!confirm(`تشغيل SPL + U-Boot (v3)؟\nيكتب SPL إلى SRAM 0x00000000 (مع تبديل المناطق المحمية وthunk)، ويتحقق من eGON.FEL، ثم يضع U-Boot في DRAM 0x4a000000 وينفذه.\nلا يكتب إلى eMMC أو Flash. الجهاز يجب أن يبقى في وضع FEL.`)) throw Error('ألغى المستخدم التشغيل.');
    const base64 = base64EncodeBytes(ubFileBytes);
    // Direct fetch (not bridgeCall): on failure the server returns
    // the C tool's step log in detail.steps, and that log is the
    // diagnosis — it must reach the screen, not be discarded.
    const r = await fetch(BRIDGE_BASE + '/api/bridge/fel-spl-uboot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, base64, sha256: ubFileSha256, confirm: true }) });
    const j = await r.json().catch(() => ({ ok: false, error: 'bad_json' }));
    if (!r.ok) {
      const steps = j.detail?.steps || [];
      const stepText = steps.map(s => `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`).join('\n');
      out.textContent = `فشل SPL + U-Boot (${j.error || `HTTP ${r.status}`}): ${j.message || ''}\n\nخطوات التنفيذ:\n${stepText || '(لا توجد خطوات)'}\n\nJSON:\n${JSON.stringify(j, null, 2)}\n\nأعد فحص FEL_VERSION: إذا ردّ، فـ FEL ما زال حياً. انسخ هذا التقرير كاملاً وأرسله إلى Muse.`;
      log('bridge-spl-uboot-error', `fel-spl-uboot failed: ${j.error || r.status}`);
      return;
    }
    bridgeSetReport(j);
    const steps = Array.isArray(j.steps) ? j.steps.map(s => `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`).join('\n') : '';
    out.textContent = `اكتمل SPL + U-Boot.\nSHA-256: ${ubFileSha256}\nU-Boot load/entry: ${j.uboot_load} / ${j.uboot_entry}\neGON.FEL: ${j.egon_fel ? 'نعم' : 'لا'} — U-Boot exec sent: ${j.uboot_exec_sent ? 'نعم' : 'لا'}\n\nخطوات التنفيذ:\n${steps}\n\nJSON:\n${JSON.stringify(j, null, 2)}\n\nالآن اتبع قائمة ما بعد التشغيل أدناه.`;
    const checklist = $('ubChecklist');
    if (checklist) checklist.style.display = '';
    log('bridge-spl-uboot', 'SPL + U-Boot flow completed.');
    await refreshSessionQuiet();
  } catch (e) { out.textContent = `فشل SPL + U-Boot: ${e.message}\n\nأعد فحص FEL_VERSION: إذا ردّ، فـ FEL ما زال حياً. انسخ رسالة الخطأ كاملة وأرسلها إلى Muse.`; log('bridge-spl-uboot-error', e.message); }
});
$('ubRecheckFel')?.addEventListener('click', async () => {
  const out = $('ubCheckResult');
  if (!out) return;
  out.textContent = 'جارٍ إعادة فحص FEL_VERSION…';
  try {
    const device = bridgeDeviceOrThrow();
    const j = await bridgeCall('/api/bridge/fel-version', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device }) });
    bridgeSetReport(j);
    out.textContent = `✓ ردّ FEL_VERSION — U-Boot لم يستلم الجهاز (أو عاد FEL).\n\n${JSON.stringify(j, null, 2)}`;
    log('bridge-spl-uboot-recheck', 'FEL_VERSION answered after uboot exec.');
  } catch (e) { out.textContent = `✗ لم يردّ FEL_VERSION: ${e.message}\nقد يكون U-Boot يعمل، أو توقف FEL. أعد إدخال الجهاز في FEL وحاول مجدداً، وأرسل النتيجة إلى Muse.`; log('bridge-spl-uboot-recheck-error', e.message); }
});
$('ubReadEgon')?.addEventListener('click', async () => {
  const out = $('ubCheckResult');
  if (!out) return;
  out.textContent = 'جارٍ قراءة 0x4…';
  try {
    const device = bridgeDeviceOrThrow();
    const j = await bridgeCall('/api/bridge/fel-read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, address: '0x4', length: 8 }) });
    bridgeSetReport(j);
    const isFel = (j.hex || '').toLowerCase() === '65474f4e2e46454c';
    out.textContent = (isFel ? '✓ eGON.FEL موجود — نفّذ SPL بنجاح.\n' : '✗ ليست eGON.FEL — توقف ولا تتابع إلى U-Boot.\n') + JSON.stringify(j, null, 2);
    log('bridge-spl-uboot-egon', isFel ? 'eGON.FEL present at 0x4.' : 'eGON.FEL NOT present at 0x4.');
  } catch (e) { out.textContent = `فشلت قراءة 0x4: ${e.message}`; log('bridge-spl-uboot-egon-error', e.message); }
});
$('bridgeCopyReport2')?.addEventListener('click', async () => {
  const out = $('splResult');
  if (!bridgeReport) { if (out) out.textContent = 'لا يوجد تقرير بعد. شغّل فحصاً أو قراءة أو كتابة أولاً.'; return; }
  try { await navigator.clipboard.writeText(JSON.stringify(bridgeReport, null, 2)); if (out) out.textContent = 'تم نسخ التقرير. أرسله إلى Muse للتحليل.\n\n' + JSON.stringify(bridgeReport, null, 2); }
  catch { if (out) out.textContent = 'تعذّر النسخ التلقائي. حدّد نص التقرير وانسخه يدوياً.\n\n' + JSON.stringify(bridgeReport, null, 2); }
});

// IMAGEWTY parser aligned with the public reference implementation's serialized structs.
$('firmwareFile').addEventListener('change',e=>{state.firmware=e.target.files[0]||null;$('firmwareMeta').textContent=state.firmware?`File: ${state.firmware.name}\nSize: ${fmt(state.firmware.size)} bytes (${(state.firmware.size/1024**3).toFixed(3)} GiB)\nProcessing: local browser only; no upload.`:'لم يتم اختيار ملف.';$('parseFirmware').disabled=!state.firmware;$('downloadManifest').disabled=true;});
$('parseFirmware').addEventListener('click',async()=>{
 const f=state.firmware;if(!f)return;const out=$('firmwareResult');out.textContent='Reading IMAGEWTY main header and file table locally…';
 try{
  const main=await readSlice(f,0,1024);if(new TextDecoder().decode(main.slice(0,8))!=='IMAGEWTY')throw Error('IMAGEWTY magic غير موجود في أول 8 بايت.');
  const version=u32(main,8),headerSize=u32(main,12),fileHeaderLength=u32(main,32),count=u32(main,60),tableOffset=0x400;
  if(headerSize<68||headerSize>1024)throw Error(`قيمة header_size غير منطقية: ${headerSize}`);
  if(count<1||count>10000)throw Error(`عدد الإدخالات غير منطقي: ${count}`);
  if(fileHeaderLength<0x138||fileHeaderLength>0x100000)throw Error(`file_header_length عند 0x20 غير صالح: ${fileHeaderLength}`);
  const tableEnd=tableOffset+count*fileHeaderLength;if(!Number.isSafeInteger(tableEnd)||tableEnd>f.size)throw Error('جدول الإدخالات يتجاوز حجم الملف.');
  const table=await readSlice(f,tableOffset,tableEnd),view=new DataView(table.buffer,table.byteOffset,table.byteLength);
  const read32=o=>view.getUint32(o,true),textField=(o,n)=>{const a=table.slice(o,o+n),z=a.indexOf(0);return new TextDecoder().decode(a.slice(0,z<0?a.length:z)).trim();};
  const entries=[],seen=new Set();
  for(let i=0;i<count;i++){
   const p=i*fileHeaderLength,filenameLength=read32(p),entryHeaderSize=read32(p+4);
   const mainType=textField(p+8,8),subType=textField(p+16,16),unknown0=read32(p+32);
   const name=filenameLength>=1&&filenameLength<=256?new TextDecoder().decode(table.slice(p+0x24,p+0x24+filenameLength)).split('\0',1)[0].trim().replace(/\\/g,'/'):'';
   const storedLength=read32(p+0x124),pad1=read32(p+0x128),originalLength=read32(p+0x12c),pad2=read32(p+0x130),offset=read32(p+0x134);
   const parts=name.split('/');
   const safeName=!!name&&!/[\x00-\x1f\x7f]/.test(name)&&!name.startsWith('/')&&!/^[a-zA-Z]:/.test(name)&&(parts.length===1||(parts.length===2&&parts[0]==='imgRePacker'))&&parts.every(x=>x&&x!=='.'&&x!=='..')&&/^[a-zA-Z0-9._-]+$/.test(parts[parts.length-1]),duplicate=seen.has(name);if(name)seen.add(name);
   const end=offset+storedLength,rangeValid=Number.isSafeInteger(end)&&offset>=tableEnd&&originalLength<=storedLength&&end<=f.size;
   const valid=filenameLength>=1&&filenameLength<=256&&safeName&&entryHeaderSize>=0x138&&entryHeaderSize<=fileHeaderLength&&rangeValid&&!duplicate;
   entries.push({index:i,name,filenameLength,entryHeaderSize,mainType,subType,unknown0,storedLength,originalLength,pad1,pad2,offset,inBounds:rangeValid,valid,duplicateName:duplicate,issues:[...(safeName?[]:['invalid filename']),...(entryHeaderSize>=0x138&&entryHeaderSize<=fileHeaderLength?[]:['invalid entry header size']),...(rangeValid?[]:['invalid payload range']),...(duplicate?['duplicate filename']:[])]});
  }
  state.firmwareAnalysis={file:f.name,size:f.size,magic:'IMAGEWTY',version,versionHex:hex(version),versionMatches:version===0x300,headerSize,fileHeaderLength,count,tableOffset,tableEnd,profile:'fuxdasec-imagewty-tool-serialized-layout',validEntries:entries.filter(x=>x.valid).length,invalidEntries:entries.filter(x=>!x.valid).length,entries,notes:['0x20 is file_header_length, not a table offset.','Entry filename_length=0x00, header_size=0x04, maintype=0x08, subtype=0x10, unknown0=0x20, filename=0x24, stored_length=0x124, original_length=0x12c, offset=0x134.','Extraction uses original_length bytes from offset; no generic CRC is assumed.']};
  out.innerHTML=`<div class="kv"><span>Magic</span><b>IMAGEWTY ✓</b></div><div class="kv"><span>Version</span><b>${hex(version)} ${version===0x300?'(v3)':'(not v3)'}</b></div><div class="kv"><span>Entries</span><b>${count}</b></div><div class="kv"><span>Header entry size</span><b>${fmt(fileHeaderLength)} bytes</b></div><div class="kv"><span>Valid / invalid</span><b>${state.firmwareAnalysis.validEntries} / ${state.firmwareAnalysis.invalidEntries}</b></div><p class="note">Layout corrected using the reference C implementation. File data is read and extracted locally; no firmware upload.</p><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font:11px var(--mono)"><thead><tr><th>Name</th><th>Stored</th><th>Original</th><th>Offset</th><th>Status</th><th>Action</th></tr></thead><tbody>${entries.map(x=>`<tr><td>${esc(x.name||'(invalid name)')}</td><td>${fmt(x.storedLength)}</td><td>${fmt(x.originalLength)}</td><td>${hex(x.offset)}</td><td>${x.valid?'VALID':esc(x.issues.join(', ')||'INVALID')}</td><td>${x.valid?`<button class="ghost extract" data-index="${x.index}">Extract</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`;
  out.querySelectorAll('.extract').forEach(b=>b.addEventListener('click',()=>{const x=entries[Number(b.dataset.index)];if(!x?.valid)return;const blob=f.slice(x.offset,x.offset+x.originalLength);downloadBlob(blob,(x.name||`entry-${x.index}`).replace(/[\\/:*?"<>|]/g,'_'));log('extract',`Extracted ${x.name} (${x.originalLength} bytes)`);}));
  $('downloadManifest').disabled=false;log('firmware',`Parsed IMAGEWTY ${version.toString(16)}: ${count} entries, ${state.firmwareAnalysis.validEntries} valid`);
 }catch(e){state.firmwareAnalysis=null;$('downloadManifest').disabled=true;out.textContent='تحليل غير ناجح: '+e.message;log('firmware-error',e.message);}
});
$('downloadManifest').addEventListener('click',()=>{if(state.firmwareAnalysis)downloadBlob(new Blob([JSON.stringify(state.firmwareAnalysis,null,2)],{type:'application/json'}),'artemis-imagewty-manifest.json');});

function parseEgonBytes(b){const magic=new TextDecoder().decode(b.slice(0,8));if(b.length<32)throw Error('الملف أقصر من ترويسة eGON الدنيا');const checksum=u32(b,8),length=u32(b,12),entry=u32(b,16),r={magic,validMagic:magic==='eGON.BT0',checksum:hex(checksum),length,entryPoint:hex(entry),fileSize:b.length};if(length<32||length>b.length||(length&3)){r.checksumValid=null;r.warning='Length out of bounds or not word aligned';}else{const copy=b.slice(0,length);new DataView(copy.buffer).setUint32(8,0x5f0a6c39,true);let sum=0;for(let i=0;i<length;i+=4)sum=(sum+u32(copy,i))>>>0;r.computedChecksum=hex(sum);r.checksumValid=sum===checksum;}return r;}
$('bootFiles').addEventListener('change',async e=>{const files=[...e.target.files];const results=[];for(const f of files){try{const b=await readSlice(f,0,Math.min(f.size,16*1024*1024));const magic=new TextDecoder().decode(b.slice(0,8));if(magic==='eGON.BT0')results.push({name:f.name,type:'eGON Boot0',...parseEgonBytes(b)});else if(new TextDecoder().decode(b.slice(0,4))==='TOC1')results.push({name:f.name,type:'TOC1 package',magic:'TOC1',fileSize:f.size,headerVersion:hex(u32(b,4)),declaredLength:u32(b,8),itemsCount:u32(b,12),components:['u-boot','scp','soc-cfg','dtb','optee'].map(name=>({name,status:'known from prior R69 inspection; offsets not decoded'})),warning:'Vendor TOC1 item table offsets are not validated in this build.'});else results.push({name:f.name,type:'unclassified',size:f.size,warning:'No supported magic at file start.'});}catch(err){results.push({name:f.name,error:err.message});}}
 state.boot=results;$('bootResults').textContent=JSON.stringify(results,null,2);log('boot',`Inspected ${files.length} boot artifact(s)`);});

function parseFex(text){const sections=[];let current=null;for(const raw of text.split(/\r?\n/)){const line=raw.trim(),m=line.match(/^\[([^\]]+)\]/);if(m){current={name:m[1],values:{}};sections.push(current);continue;}if(!current||!line||line.startsWith(';')||line.startsWith('#'))continue;const kv=line.match(/^([\w.-]+)\s*=\s*(.*?)\s*(?:;.*)?$/);if(kv)current.values[kv[1]]=kv[2].replace(/^['"]|['"]$/g,'');}return sections;}
$('parseDram').addEventListener('click',()=>{const sections=parseFex($('dramText').value),all=Object.assign({},...sections.map(s=>s.values));const n=k=>all[k]?( /^0x/i.test(all[k])?parseInt(all[k],16):Number(all[k])):null;state.dram={machine:all.machine||null,dram_clk_mhz:n('dram_clk'),dram_type:n('dram_type'),dram_zq:all.dram_zq||null,dram_para1:all.dram_para1||null,dram_para2:all.dram_para2||null,tpr:Object.fromEntries(Object.entries(all).filter(([k])=>/^dram_tpr\d+$/.test(k))),meaning:'Firmware-declared settings only; not live RAM measurement.'};$('dramResult').textContent=JSON.stringify(state.dram,null,2);log('dram','Parsed FEX DRAM parameters.');});
$('parsePartitions').addEventListener('click',()=>{const blocks=$('partitionText').value.split(/\[partition\]/i).slice(1),rows=[];for(const block of blocks){const get=k=>{const m=block.match(new RegExp('^\\s*'+k+'\\s*=\\s*([^\\r\\n;]+)','im'));return m?m[1].trim().replace(/^['"]|['"]$/g,''):null;};const name=get('name');if(!name)continue;const sectors=Number(get('size'));rows.push({name,sectors:Number.isFinite(sectors)?sectors:null,bytes:Number.isFinite(sectors)?sectors*512:null,downloadfile:get('downloadfile')});}const total=rows.reduce((a,x)=>a+(x.sectors||0),0);state.partitions={sectorBytes:512,partitions:rows,fixedSectorTotal:total,fixedBytes:total*512,fixedGiB:(total*512/1024**3).toFixed(3),caveat:'Metadata total is not proof of physical eMMC size; UDISK may be unspecified.'};$('partitionResult').textContent=JSON.stringify(state.partitions,null,2);log('partitions',`Parsed ${rows.length} partition records`);});


const BOOT_SOURCE_TEMPLATE = `/* ARTEMIS R69 — source review scaffold only.
 * NOT a validated board port. Do not compile/flash this scaffold.
 * Fill values only from the exact board schematic and vendor sources.
 */
#include <common.h>

/* TODO: identify exact board revision and validated boot flow. */
int board_early_init_f(void)
{
    /* Keep this function non-destructive until clocks, pinmux and DRAM
     * initialization are verified against the exact R69 board revision.
     */
    return 0;
}

/* TODO: add board-specific code only after source-level review. */
`;
$('bootTemplate').addEventListener('click',()=>{$('bootCode').value=BOOT_SOURCE_TEMPLATE;$('bootCodeResult').textContent='تم إدراج قالب توثيق C غير قابل للاستخدام كـBootloader جاهز. يجب التحقق من كل قيمة ومصدر قبل أي بناء.';});
$('bootSourceFile').addEventListener('change', async e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024){$('bootCodeResult').textContent='الملف أكبر من الحد الآمن للمحرر (2MB).';return;}try{$('bootCode').value=await f.text();$('bootCodeResult').textContent=`تم فتح ${f.name} محلياً (${f.size} bytes). لم يتم رفعه إلى الخادم.`;log('source-open',`Opened source file ${f.name}`);}catch(err){$('bootCodeResult').textContent='تعذر فتح الملف: '+err.message;}});
$('saveBootCode').addEventListener('click',()=>{const src=$('bootCode').value;if(!src.trim())return;$('bootCodeResult').textContent='تم تجهيز المصدر للحفظ محلياً.';downloadBlob(new Blob([src],{type:'text/plain'}),'artemis-boot-source-review.c');});
$('reviewBootCode').addEventListener('click',()=>{const code=$('bootCode').value.trim();if(!code){$('bootCodeResult').textContent='ألصق كود المصدر أولاً.';return;}go('assistant');$('aiPrompt').value='راجع كود الإقلاع التالي (C / U-Boot) مراجعة source-only: حدد أخطاء الترجمة والمنطق والتوافق المحتمل مع H3، وافصل الحقائق عن الافتراضات، واقترح تعديلات مصدرية واختبارات بناء آمنة. لا تقترح تحميله أو تنفيذه على R69 ولا تفترض أن القيم الخاصة باللوحة صحيحة.\n\n'+code;$('aiContext').value='Boot Code Studio source review. Target reported R69-EMCP V2.0 / Allwinner H3 / dolphin-p1. No verified board schematic. Do not generate flash instructions.';$('aiResult').textContent='تم نقل المصدر إلى مساعد البرمجة للمراجعة.';});

$('askAI').addEventListener('click',async()=>{const prompt=$('aiPrompt').value.trim();if(!prompt){$('aiResult').textContent='اكتب المشكلة أو الكود أولاً.';return;}const context={extra:$('aiContext').value,device:'R69-EMCP V2.0 / H3 reported',firmware:state.firmwareAnalysis,dram:state.dram,partitions:state.partitions,boot:state.boot};$('aiResult').textContent='ARTEMIS is analyzing…';try{const r=await fetch('/api/assistant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,context})});const j=await r.json();if(!r.ok)throw Error(j.message||j.error||'AI request failed');$('aiMode').textContent=`${j.mode} ${j.model||''}`;$('aiResult').textContent=`MODE: ${j.mode}\n\n${j.answer}\n\n${j.safety||''}`;log('assistant',`Assistant response via ${j.mode}`);}catch(e){$('aiResult').textContent=`تعذر الاتصال بالمساعد: ${e.message}\nتحقق من تشغيل خادم ARTEMIS.`;log('assistant-error',e.message);}});
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{$('aiPrompt').value=b.dataset.prompt;$('aiPrompt').focus();}));
$('exportReport').addEventListener('click',()=>{const report={schema:'artemis-r69-report/v1',generatedAt:new Date().toISOString(),product:'ARTEMIS R69 v6.1',target:'SHUNJUEY R69-EMCP V2.0',mode:'READ_ONLY',device:{socExpected:'Allwinner H3',socIdExpected:'0x1680',board:'dolphin-p1',emcpReported:'SanDisk SD9DS28K-8G'},usb:state.usb?{vendorId:state.usb.vendorId,productId:state.usb.productId,felVersionRead:false}:null,firmware:state.firmwareAnalysis,dram:state.dram,partitions:state.partitions,bootArtifacts:state.boot,logs:state.logs,safety:{felWrite:'sram-only (bridge v3)',felExec:'sram-only, session-gated (bridge v3)',felSplUboot:'upstream sunxi-fel swap/thunk + eGON.FEL check, DRAM staging at mkimage load address (bridge v3)',emmcWrite:false,ramPatternTest:false,recoveryImageBuilder:false,note:'No persistent writes or arbitrary execution are implemented. FEL_WRITE / FEL_EXEC are confined to H3 SRAM and require a prior write in the same bridge session. The v2 raw SPL write is deprecated: it killed FEL on 2026-11-17; SPL upload uses the v3 fel-spl-uboot flow only.'}};downloadBlob(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'ARTEMIS_R69_diagnostic_report.json');$('reportPreview').textContent=JSON.stringify({generatedAt:report.generatedAt,mode:report.mode,firmwareEntries:report.firmware?.count||0,bootArtifacts:report.bootArtifacts.length,logEntries:report.logs.length,safety:report.safety},null,2);log('report','Exported diagnostic JSON report.');});
fetch('/api/ai/status').then(r=>r.json()).then(j=>{document.getElementById('aiMode').textContent=j.endpointConfigured?`AI endpoint configured • ${j.model} • ${j.authentication}`:'Offline rules active — configure a no-key local model endpoint for generative AI';}).catch(()=>{document.getElementById('aiMode').textContent='AI status unavailable';});
