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
$('exportReport').addEventListener('click',()=>{const report={schema:'artemis-r69-report/v1',generatedAt:new Date().toISOString(),product:'ARTEMIS R69 v6.1',target:'SHUNJUEY R69-EMCP V2.0',mode:'READ_ONLY',device:{socExpected:'Allwinner H3',socIdExpected:'0x1680',board:'dolphin-p1',emcpReported:'SanDisk SD9DS28K-8G'},usb:state.usb?{vendorId:state.usb.vendorId,productId:state.usb.productId,felVersionRead:false}:null,firmware:state.firmwareAnalysis,dram:state.dram,partitions:state.partitions,bootArtifacts:state.boot,logs:state.logs,safety:{felWrite:false,felExec:false,emmcWrite:false,ramPatternTest:false,recoveryImageBuilder:false,note:'No persistent writes or arbitrary execution are implemented.'}};downloadBlob(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'ARTEMIS_R69_diagnostic_report.json');$('reportPreview').textContent=JSON.stringify({generatedAt:report.generatedAt,mode:report.mode,firmwareEntries:report.firmware?.count||0,bootArtifacts:report.bootArtifacts.length,logEntries:report.logs.length,safety:report.safety},null,2);log('report','Exported diagnostic JSON report.');});
fetch('/api/ai/status').then(r=>r.json()).then(j=>{document.getElementById('aiMode').textContent=j.endpointConfigured?`AI endpoint configured • ${j.model} • ${j.authentication}`:'Offline rules active — configure a no-key local model endpoint for generative AI';}).catch(()=>{document.getElementById('aiMode').textContent='AI status unavailable';});
