<div align="center">

# ARTEMIS R69 — ORION v6.1
### Mobile-first firmware forensics & embedded engineering workspace
**SHUNJUEY R69-EMCP V2.0 • Allwinner H3 • dolphin-p1**

![Node](https://img.shields.io/badge/Node.js-20%2B-3c873a) ![Safety](https://img.shields.io/badge/Hardware-READ--ONLY-23b78a) ![License](https://img.shields.io/badge/License-Apache--2.0-blue)

</div>

## ما هو ARTEMIS؟

نسخة جديدة من مشروع CHIBANI LOL AI، مخصصة لتحليل جهاز R69 وملفات Firmware والإقلاع. تم الاحتفاظ بفكرة غرفة العمليات والهوية التقنية، لكن أُعيد بناء منطق التعامل مع USB والإقلاع حتى لا تنفّذ الواجهة أوامر غير موثّقة. الموقع يعمل من الهاتف، ويقرأ الملفات المختارة محلياً داخل المتصفح.

### الوحدات

- **Hardware Intelligence:** طلب صلاحية WebUSB واستعراض descriptors وواجهات USB ونقاط النهاية. لا يدّعي نجاح FEL أو تحديد H3 اعتماداً على VID/PID وحدهما.
- **Firmware Inspector:** قراءة ترويسة IMAGEWTY v3 وفق بنية الحقول الفعلية في مرجع C مفتوح المصدر، وفحص 37 مدخلاً/أي عدد معلن، ثم استخراج payload محلياً بعد فحص الاسم والمدى والحجم. الملفات لا تُرفع إلى الخادم.
- **Bootloader Lab:** فحص eGON magic والطول وchecksum، وعرض ترويسة TOC1 ومكونات R69 المعروفة دون تخمين offsets غير مثبتة.
- **DRAM Analyzer:** تحليل قيم FEX، مثل `dram_type=7` و`dram_clk=336` و`dram_zq`، مع الفصل بين إعدادات Firmware وقياسات العتاد الحقيقية.
- **Partition Engineer:** حساب القطاعات والأحجام مع توضيح أن مجموع الأقسام ليس إثباتاً لسعة eMMC.
- **AI Engineering Assistant:** تحليل محلي دون مفتاح، أو مزود متوافق مع OpenAI عبر متغيرات بيئة الخادم. يساعد في مراجعة الأخطاء والشفرة ولا يشغّل الشفرة.
- **Reports:** تصدير تقرير JSON يجمع الأدلة والنتائج والتحذيرات.

## حدود السلامة — اقرأ قبل الاستخدام

هذا المشروع **ليس أداة تفليش**. لا يحتوي على تنفيذ فعّال لـ `FEL_WRITE` أو `FEL_EXEC`، ولا يكتب على eMMC، ولا يختبر DRAM بكتابة patterns، ولا يعدّل Boot0، ولا ينتج صورة SD إقلاعية. هذه الوظائف مستبعدة لأن عنوان RAM أو بنية Boot0 أو جدول TOC1 غير المؤكد قد يسبب تلفاً أو تشخيصاً مضللاً.

- VID/PID `1F3A:EFE8` يثبت هوية USB التي رُصدت سابقاً فقط، ولا يثبت نجاح FEL handshake.
- SoC ID المتوقع لـ H3 هو `0x1680`، لكنه لم يُقرأ بعد من الجهاز عبر FEL_VERSION.
- `dolphin-p1`, LPDDR3 336 MHz و`dram_type=7` هي قيم معلنة في Firmware.
- IMAGEWTY v3 layout في 6.1.0 مطابق للحقول التي يقرأها المرجع `fuxdasec/imagewty-tool`؛ مع ذلك يجب فحص صحة كل مدى قبل الاستخراج، ولا يوجد ادعاء CRC عام.
- TOC1 inspector يقرأ header ولا يدّعي تحليل جدول العناصر الداخلي حتى يتم توثيق layout الخاص بهذه الحزمة.

## تشغيل على Android / Termux

```bash
pkg update -y
pkg install nodejs-lts git unzip -y
unzip ARTEMIS_R69_v6_ORION.zip
cd ARTEMIS_R69_v6
npm install
npm start
```

افتح في المتصفح:

`http://127.0.0.1:3000`

ملاحظة: WebUSB قد لا يعمل على localhost في بعض إصدارات Android/Chrome أو مع بعض OTG adapters. استضافة Render HTTPS لا تضمن دعم WebUSB على كل هاتف. التطبيق يبقى مفيداً لتحليل ملفات Firmware حتى دون USB.

## التشغيل على Render

1. ارفع محتويات المجلد إلى مستودع GitHub جديد.
2. في Render اختر **New Web Service** واربط المستودع.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Health path: `/api/health`
6. لا تضف `AI_API_KEY` إلا إذا أردت مزوداً خارجياً؛ خزّنه في Environment Variables فقط.

ملف `render.yaml` جاهز كـ Blueprint. الخادم لا يستقبل ملفات Firmware؛ تحليل الملفات يتم في المتصفح. لا ترفع أي مفاتيح API إلى GitHub.

## تفعيل الذكاء الاصطناعي

في إعدادات الخدمة أو بيئة Termux:

```bash
export AI_BASE_URL="https://api.openai.com/v1"
export AI_API_KEY="YOUR_SECRET_KEY"
export AI_MODEL="gpt-4o-mini"
npm start
```

يمكن استعمال أي endpoint متوافق مع Chat Completions. من دون المفتاح يعمل المساعد في وضع Offline Expert بقواعد تخصصية. المفتاح لا يرسل إلى المتصفح.

## الاختبارات

```bash
npm run check
npm test
```

الاختبارات تستخدم `node:test` ولا تتطلب جهاز R69. العينات النصية داخل `samples/` اصطناعية/مبسطة وليست firmware قابلاً للإقلاع.

## بنية المشروع

```text
ARTEMIS_R69_v6/
├── frontend/             # واجهة RTL mobile-first
├── backend/              # Express API + AI proxy
├── lib/parsers/          # FEX, IMAGEWTY, eGON, TOC1, partitions
├── lib/analyzers/        # hardware profile, boot dispatcher, reports
├── lib/ai/               # offline expert + connected provider
├── tests/                # Node built-in unit tests
├── samples/              # FEX samples for parser testing
├── docs/                 # architecture, evidence profile, sources
├── scripts/              # Termux install/start
├── .github/workflows/    # CI tests
├── Dockerfile
├── render.yaml
└── BUILD_INFO.json
```

## IMAGEWTY v3 layout correction

النسخة السابقة كانت تقرأ مواضع خاطئة داخل كل entry، ولهذا كانت تعرض أسماء/offsets فارغة. في النسخة 6.1.0 تم تصحيحها: `filename_length=0x00`, `header_size=0x04`, `maintype=0x08`, `subtype=0x10`, `unknown0=0x20`, `filename=0x24`, `stored_length=0x124`, `original_length=0x12c`, `offset=0x134`. قيمة الحقل الرئيسي عند `0x20` هي `file_header_length`؛ جدول الملفات يبدأ عند `0x400`. انظر المصدر المرجعي في `docs/RESEARCH_SOURCES.md`.

## Sources
انظر [docs/RESEARCH_SOURCES.md](docs/RESEARCH_SOURCES.md) و[docs/DEVICE_PROFILE.md](docs/DEVICE_PROFILE.md). تم الفصل بين ما ورد في مصادر عامة وما تم استخراجه من ملفات الجهاز وما هو مجرد توقع.

## Credits & license
Developed for the CHIBANI LOL / ARTEMIS R69 project. Apache-2.0. The legacy project files are retained in `docs/` as historical references only; the former active flashing workflow is not part of this build.
