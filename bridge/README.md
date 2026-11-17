# جسر Termux — ARTEMIS R69 (v3.1، قراءة FEL + كتابة SRAM فقط + SPL/U-Boot على طريقة sunxi-fel)

**English summary:** A Termux bridge that lets a Samsung phone talk
to an R69 TV Box in FEL mode over OTG. v3 adds SPL + U-Boot staging
(`POST /api/bridge/fel-spl-uboot`, `bridge/fel_spl_uboot.c`)
implementing upstream sunxi-fel's `aw_fel_write_and_execute_spl`
(stack swap + thunk + eGON checksum + `eGON.FEL` read-back) and
`aw_fel_write_uboot_image` (U-Boot proper staged in DRAM at its
mkimage load address, then executed). **v3.1 (2026-11-17):** the v3
tool printed NOTHING on the phone — neither via the page nor via a
direct Termux run — so v3.1 prints one progress JSON line per step
immediately (plus a banner after file validation), sets stdout
unbuffered, adds `--validate-only` / `validate_only:true` (validate
the file + FEL_VERSION/soc, exit without any write/exec — run it
FIRST), and prints stderr diagnostics on failed steps. FEL_WRITE
and FEL_EXEC remain confined to H3 SRAM (`0x00000000-0x00020000`),
with an explicit confirm per write/exec and an exec rule that
requires a prior write in the same bridge session. There is still
**no eMMC / flash / NAND write** anywhere in the bridge.
FEL_VERSION, FEL_READ and the pattern write/read-back were proven
live on the phone on 2026-11-17; the v3 SPL + U-Boot flow is
verified from sunxi-tools source only and is **UNVERIFIED on real
hardware** until the test plan below is run.

## الفكرة في سطر واحد

```
TV Box (FEL) --OTG--> هاتف Samsung (Termux = الجسر، localhost فقط)
  --> ARTEMIS على 127.0.0.1:3000 --> تقرير JSON تنسخه إلى Muse
```

أنا (Muse) لست على هاتفك ولا أصل إلى USB مباشرة. الهاتف هو
الجسر، وأنا أحلل التقارير التي ينتجها وأعطي الأمر التالي. هذه
هي الطريقة الذكية الواقعية، وليست اتصالاً مباشراً وهمياً.

## حدود السلامة — اقرأ قبل التشغيل

- **v2: SRAM فقط.** الكتابة والتنفيذ محصوران في SRAM
  (`0x00000000-0x00020000`). لا يوجد أي endpoint لكتابة
  eMMC أو NAND أو Flash، ولا يوجد `/write` أو `/exec` أو
  `/flash` أو `/emmc` — أي طلب إليها يرجع 404.
- **FEL_READ** مسموح فقط لـ SRAM ونافذة SID
  (`0x01C14200-0x01C14210`). DRAM (`0x40000000`) لا تُقرأ
  أبداً قبل تهيئتها.
- **مناطق BROM المحمية** مرفوضة في الكتابة العامة: stack
  الـIRQ ‏`0x1C00-0x1FFF`‏، والـstack ‏`0x5C00-0x6FFF`‏،
  والمنطقة المهمة ‏`0x7C00-0x7FFF`‏ (وفيها scratchpad
  ‏`0x7E00`‏ الذي يرجعه FEL_VERSION)، وجدول MMU / thunk
  ‏`0x8000-0xBFFF`‏.
- **FEL_EXEC** مرفوض ما لم يكن العنوان داخل نطاق كُتب
  بـ FEL_WRITE في نفس جلسة الجسر. لا يوجد تنفيذ لعنوان
  لم تكتبه أنت للتو.
- **SPL: v3 فقط، والكتابة الخام في v2 مهملة.** تحميل SPL في v3
  (`POST /api/bridge/fel-spl-uboot`) ينفذ الطريقة الأصلية
  لـ sunxi-fel: ينسخ المناطق المحمية (`0x1C00` / `0x5C00` /
  `0x7C00`) إلى SRAM احتياطي (`0xA400` / `0xA800` / `0xBC00`)،
  يشغّل thunk في `0xA200`، يتحقق من eGON checksum، يقرأ
  `eGON.FEL` من `0x00000004`، وبعدها فقط يضع U-Boot في DRAM
  وينفذه (انظر `bridge/docs/SOURCES.md` §6). **الكتابة الخام
  لـ SPL في v2 (`fel-write` مع `spl:true`) مهملة وممنوعة
  عملياً: في 2026-11-17 قتلت FEL** — فشلت كتابة 32768 بايت
  إلى `0x0` برسالة "fel_write did not return JSON"، وبعدها
  لم يعد FEL_VERSION يردّ إطلاقاً حتى أُعيد إدخال الجهاز
  في FEL (مسار جديد `/dev/bus/usb/001/002`). لا تعِد
  المحاولة بها أبداً.
- الخادم يرتبط بـ `127.0.0.1:3001` فقط. أي محاولة ربط بعنوان
  آخر تُرفض وتُنهي العملية. لا يوجد CORS إلا لـ ARTEMIS المحلي
  (`http://127.0.0.1:3000` و`http://localhost:3000`).
- **صفحة الجسر لا تعمل من موقع Render.** الموقع على
  `https://artemis-r69.onrender.com` لا يستطيع الوصول إلى
  `http://127.0.0.1:3001` على هاتفك. يجب تشغيل ARTEMIS محلياً
  في Termux (`npm start` → `http://127.0.0.1:3000`).
- `fel_common.c` و`fel_read.c` و`fel_write.c` و`fel_exec.c`
  و`fel_spl_uboot.c` و`fel_version.c` مرخّصة GPL-2.0-or-later
  (انظر ملفات المصدر)، بينما بقية المستودع Apache-2.0.
  بروتوكول FEL نفسه موثّق في `bridge/docs/SOURCES.md` من
  مصدر sunxi-tools. كود thunk في `fel_spl_uboot.c` مأخوذ
  حرفياً من `fel-to-spl-thunk.h` في sunxi-tools (ترخيص MIT،
  Siarhei Siamashka 2015).

## ما هو مثبَت حياً، وما هو غير مختبَر

**مثبَت على هاتفك (2026-11-17):**
- ARTEMIS يعمل محلياً على `127.0.0.1:3000`.
- `usb_probe`: VID `0x1F3A` PID `0xEFE8`، جهاز
  `/dev/bus/usb/001/004`، نقطتا Bulk `0x01` / `0x82`.
- `FEL_VERSION`: `AWUSBFEX`، soc `0x1680`، H3،
  scratchpad `0x7e00`. (في v1 كان الحقل
  `verified_on_device` مطبوعاً `false` ثابتاً — كان خطأً
  في الكود، وأُصلح في v2: يصبح `true` عند نجاح التوقيع
  وفك معرّف SoC.)
- `FEL_READ` مباشرة في Termux (2026-11-17، 15:18 UTC):
  `0x1000` × 16 على `/dev/bus/usb/001/006`، hex
  `43f0704313604bf00072ddf824c00a98`، sha256
  `5b2402fa391d657a137b6d3f33ef97ff962b7d2cd5863276ae483946f3292191`،
  مرتين بنتيجة متطابقة، بالصيغتين `-E` وبدون `-E`.
- اختبار النمط عبر صفحة الجسر (2026-11-17، 15:29-15:30 UTC):
  كتابة 28 بايت (`HELLO-FEL-PATTERN-0123456789`) إلى `0x1000`
  ثم قراءتها مجدداً بنفس SHA-256
  `93a6594f99e0c9eeecce69137b536c238e90b46e7d99db725a99873085007fc8`.
  حلقة FEL الكاملة (فحص، FEL_VERSION، FEL_READ، FEL_WRITE،
  قراءة مطابقة) مثبَتة حياً عبر صفحة الجسر.
- **فشل v2 في كتابة SPL (2026-11-17) ثم التعافي:** كتابة
  SPL خاماً (32768 بايت، `spl-only.bin`) إلى `0x0` فشلت،
  وتوقف FEL عن الرد تماماً. أُعيد إدخال الجهاز في FEL:
  مسار جديد `/dev/bus/usb/001/002`، إذن ممنوح، وFEL_VERSION
  عاد يعمل (`AWUSBFEX` / `0x1680` / H3، scratchpad `0x7e00`).
  لم تُكتب eMMC أبداً، فكان الفشل قابلاً للتعافي. هذا هو
  الدليل الذي بُنيت عليه v3.

**غير مختبَر على جهاز حقيقي:**
- تدفق SPL + U-Boot في v3 (تبديل stacks + thunk +
  `eGON.FEL` + وضع U-Boot في DRAM + تنفيذ) — منفّذ من
  مصدر sunxi-fel فقط (`bridge/docs/SOURCES.md` §6)، ولم
  يُشغَّل بعد على H3 حقيقي.
- FEL_READ عبر صفحة الجسر: القراءة نفسها أُثبتت حياً مباشرة
  في Termux في 2026-11-17 (`0x1000` × 16،
  sha256 `5b2402fa391d657a137b6d3f33ef97ff962b7d2cd5863276ae483946f3292191`)،
  مرتين بنتيجة متطابقة، بالصيغتين `-E` وبدون `-E`. الصيغة
  المقتبسة التي بناها خادم v2 أصلاً (`'<binary>'`) فشلت على
  الهاتف، وأُصلحت في v2.1 إلى الصيغة غير المقتبسة المثبَتة.
  أعد اختبار القراءة من صفحة الجسر بعد سحب الإصلاح.
- تحميل SPL خاماً وتنفيذه من `0x0` دون swap/thunk — **أُثبت
  أنه يقتل FEL في 2026-11-17. لا تعِد المحاولة.**

## التثبيت على الهاتف (Termux)

1. ثبّت تطبيق **Termux** وتطبيق **Termux:API** من **F-Droid**
   (نسخ Play Store قديمة). السكربت لا يستطيع تثبيت التطبيقات.
2. انسخ المستودع إلى الهاتف أو افتحه في Termux، ثم:
   ```bash
   git checkout bridge/termux-v3
   bash bridge/termux-setup.sh
   ```
   يثبّت `termux-api libusb clang git`، ويبني `usb_probe`
   و`bridge/fel_version` و`bridge/fel_read` و`bridge/fel_write`
   و`bridge/fel_exec` و`bridge/fel_spl_uboot`، وينشئ
   `bridge/run/` و`bridge/reports/`.
   السكربت idempotent — آمن لإعادة تشغيله.
   **Node:** السكربت يفحص `node -v` أولاً، وإذا كان Node
   يعمل يتركه كما هو ولا يعيد تثبيته. (في v1 كان يعيد
   تثبيت `nodejs-lts` في كل مرة، وهذا ما كسر Node على
   هاتفك بخطأ `libicui18n.so.79`.)
   `sunxi-fel` غير مطلوب في v2، ولن يُبنى افتراضياً (انظر
   `bridge/docs/SOURCES.md` لمعرفة السبب).
3. أدخل TV Box في وضع FEL:
   - افصل الكهرباء عن الجهاز.
   - اضغط باستمرار على زر الريسيت المخفي داخل منفذ AV بدبوس.
   - وصّل كابل USB ذكر-ذكر بين منفذ OTG في الجهاز وهاتفك،
     وأنت ما زلت ضاغطاً، ثم حرّر الزر.
   - اللمبة الزرقاء وحدها لا تثبت FEL؛ التأكيد هو ظهور
     الجهاز في `termux-usb -l` ثم نجاح `FEL_VERSION`.
4. في Termux:
   ```bash
   termux-usb -l
   # مثال على الخرج: /dev/bus/usb/001/002 — أعد الأمر في كل مرة،
   # فالمسار يتغير حسب المنفذ.
   termux-usb -r /dev/bus/usb/001/002   # امنح الإذن على الشاشة
   ```

## التشغيل

في جلسة Termux أولى:
```bash
bash bridge/run-bridge.sh
# Bridge:  http://127.0.0.1:3001/api/bridge/status
```

في جلسة Termux ثانية:
```bash
npm start
# ARTEMIS: http://127.0.0.1:3000
```

افتح `http://127.0.0.1:3000` في Chrome على الهاتف، وانتقل إلى
**“جسر Termux”** في القائمة الجانبية.

## خطة الاختبار — بالترتيب، ولا تتخطَّ خطوة

### (أ) قراءة FEL — 16 بايت من SRAM
في صفحة الجسر، نموذج FEL_READ:
- العنوان: `0x1000` (وهو `scratch_addr` في sunxi-fel: "مكان
  آمن لرفع وتشغيل كود صغير")، الطول: `16`.
- المتوقع: `ok: true` مع `hex` و`base64` و`sha256`.
- إذا فشل، أرسل الناتج كاملاً ولا تتابع. هذا يثبت أن
  FEL_READ يعمل قبل أي كتابة.

### (ب) كتابة نمط اختبار + قراءته مجدداً — قبل أي SPL
1. في صفحة الجسر، نموذج "اختبار نمط SRAM": يولّد النمط
   `HELLO-FEL-PATTERN-0123456789` (28 بايت)، ويعرض SHA-256
   الخاص به.
2. اكتب النمط إلى العنوان `0x1000` (زر "كتابة النمط" —
   يتطلب تأكيداً).
3. اقرأ `0x1000` مجدداً بطول 28 بـ FEL_READ، وقارن
   `sha256`: يجب أن يطابق SHA-256 النمط تماماً.
4. المتوقع: الكتابة والقراءة تعملان، وFEL ما زال يرد على
   FEL_VERSION بعدها. إذا اختلف SHA-256 أو توقف FEL عن
   الرد، أعد إدخال الجهاز في FEL (افصل الطاقة، اضغط
   الريسيت، أعد التوصيل) وأرسل التقارير.
5. لا تنفّذ (`Exec`) النمط — إنه بيانات نصية، وليس كوداً.

### (ج) SPL + U-Boot (v3.1) — فقط بموافقة صريحة، وبعد نجاح (أ) و(ب)

**ابدأ دائماً بـ «تحقق فقط» (v3.1) قبل التدفق الكامل.** في
2026-11-17 طبعت أداة v3 لا شيء على الهاتف — لا عبر الصفحة
(`fel_spl_uboot_bad_output`، ‏stdout‏ فارغ، ‏stderr‏ تحذيرات
locale فقط، بلا خطوات) ولا عبر التشغيل المباشر في Termux
(الأمر نفسه، بلا أي ناتج). وكان FEL_VERSION نفسه متقطعاً
على ذلك الهاتف في الجلسة نفسها: نجح، ثم لم يرجع أي ناتج
في مرتين متتاليتين بالأمر نفسه، ثم نجح مجدداً. التدقيق
(انظر `docs/SOURCES.md` §6) لم يجد عطلاً حتمياً في مسار
التحقق/فتح الجهاز — في VM تطبع الأداة خطوات التحقق الأربع
+ فشل `fel_open` — ولم يجد تجاوز مخزن مؤقت. الموت الصامت
هو على الأرجح توقف من جهة الجهاز أو فقدان ‏stdout‏ في
مسار termux-usb، وجعله غير قابل للتشخيص تصميم v3: سجل
الخطوات كان يُبنى في الذاكرة ويُطبع في النهاية فقط، وstdout
كان مخزناً بالكامل (pipe). v3.1 تطبع كل خطوة فوراً، فحتى
الموت اللاحق يترك الخطوات المكتملة ظاهرة.

**خطوة v3.1 الأولى — التحقق فقط:**
1. **الملف المطلوب هو الملف الكامل `u-boot-sunxi-with-spl.bin`
   (559,480 بايت)، وليس SPL وحده.** البناء الحالي: U-Boot
   v2025.01 من `orangepi_pc_plus_defconfig` مع
   `CONFIG_SUNXI_DRAM_LPDDR3_STOCK=y` و`CONFIG_DRAM_CLK=336`
   و`CONFIG_DRAM_ZQ=3750393`، طول SPL ‏24,576‏ بايت،
   U-Boot proper عند `0x4a000000` (حمولة 526,648 بايت).
   **تحقق من SHA-256 في المتصفح قبل الكتابة:**
   `8c70a1809803b0bc22ba74217bb95312701c55ce1fb18342d08b5cf655ece071`.
   إذا لم يطابق، توقف وأرسل ما ظهر لك — لا تكتب ملفاً لا
   تعرف مصدره. (إذا أُعيد البناء لاحقاً بإعدادات DRAM
   مختلفة، سيكون لـ SHA-256 قيمة جديدة؛ سجّلها وأرسلها.)
   الملف موجود على الهاتف؟ `spl-only.bin` وحده لا يكفي
   هنا — يلزم الملف الكامل. إذا لم يكن موجوداً، اطلب
   رابط تنزيله من Muse قبل المتابعة.
2. في صفحة الجسر، لوحة **"SPL + U-Boot (v3)"**: اختر الملف
   الكامل، وسيُحسب SHA-256 في المتصفح ويُعرض مع الحجم
   وطول SPL وعنوان تحميل U-Boot. الملفات الأكبر من 600KB
   مرفوضة في الواجهة والخادم. العنوان مُعبأ مسبقاً بـ
   `0x00000000` (عنوان SPL لـ H3) ولا يُغيَّر.
3. علّم على "أفهم أن هذا يكتب SPL إلى SRAM ويضع U-Boot في
   DRAM، وليس إلى eMMC/Flash" ثم اضغط **«تحقق فقط (بدون
   كتابة) — v3.1»**. هذا يتحقق من الملف، ويفتح الجهاز،
   ويفحص FEL_VERSION/H3، ثم يخرج **دون أي كتابة أو تنفيذ**
   (مهلة 10 ثوانٍ). يجب أن ترى 4 خطوات تحقق + سطر banner،
   ثم نتيجة `validate_only: true`.
   - إذا نجح التحقق فقط: الأداة والنقل يعملان، ويمكنك
     المتابعة إلى التدفق الكامل أدناه.
   - إذا فشل التحقق فقط بصمت أيضاً (بلا خطوات): المشكلة في
     الأداة أو في نقل termux-usb، وليست في الجهاز — أرسل
     التقرير كاملاً ولا تتابع إلى التدفق الكامل.
   - إذا فشل بخطوات (مثلاً `fel_open` أو FEL_VERSION):
     أرسل الخطوات؛ الجهاز قد لا يكون في FEL أو الإذن
     مفقود — أعد إدخال FEL وأعد الفحص.
4. **بعد نجاح التحقق فقط**، اضغط "كتابة SPL + تنفيذ
   U-Boot (v3)". هذا يتطلب تأكيداً. **تدفق واحد**: الخادم
   يتحقق من الملف كاملاً (الحجم، SHA-256، ترويسة eGON،
   checksum، ترويسة mkimage) قبل لمس الجهاز، ثم يشغّل
   `fel_spl_uboot` (مهلة 60 ثانية)، ويعرض سجل الخطوات
   خطوة بخطوة: فحص eGON، معلومات الـstack، نسخ MMU، كتابة
   قطع SPL، تنفيذ thunk، قراءة `eGON.FEL`، استعادة MMU،
   وضع U-Boot في DRAM، تنفيذ U-Boot. في v3.1 تصل كل خطوة
   إلى الصفحة فور حدوثها (مربع «التقدم»).
5. **إذا لم تظهر `eGON.FEL` في السجل: توقف ولا تتابع.**
   أرسل سجل الخطوات كاملاً إلى Muse. لا تعِد المحاولة
   دون مراجعة.
6. بعد التنفيذ: **قد لا يأتي رد حالة FEL أبداً** — U-Boot
   الذي يستلم الجهاز لا يعود إلى FEL. هذا متوقع، وليس
   بالضرورة فشلاً. اتبع **قائمة ما بعد التشغيل** في
   الصفحة:
   - أعد فحص FEL_VERSION: إذا ردّ، فـ U-Boot لم يستلم
     الجهاز (أو عاد FEL).
   - اقرأ `0x00000004` (8 بايت): يجب أن تكون `eGON.FEL`
     إذا نفّذ SPL بنجاح.
   - انسخ التقرير الكامل وأرسله إلى Muse مع كل خطوة.
7. **لا تستخدم لوحة SPL القديمة (v2) أبداً** — هي مهملة،
   وكتابتها الخام قتلت FEL في 2026-11-17.

### (د) إذا فشل SPL أو توقف FEL عن الرد
- إذا توقف FEL عن الرد بعد أي خطوة: أعد إدخال الجهاز في
  FEL (افصل الطاقة، اضغط الريسيت داخل منفذ AV، أعد
  التوصيل)، ثم أعد `termux-usb -l` (المسار يتغير في كل
  مرة — حالياً `/dev/bus/usb/001/002`) وأعد فحص
  FEL_VERSION، وأرسل النتيجة.
- إذا ظهر `eGON.FEL` لكن U-Boot لم يستلم الجهاز (ردّ
  FEL_VERSION بعد التنفيذ): قد تكون DRAM لم تُهيأ — لا
  يوجد UART على الهاتف، فيُستدل على ذلك فقط من غياب
  `eGON.FEL` أو مهلة FEL. البديل هو إعادة بناء U-Boot
  بإعدادات DRAM أخرى (`CLK 300` / `ZQ 3650393`، أو 280)
  وإعادة الاختبار بملف جديد وSHA-256 جديد.
- إذا لم يظهر `eGON.FEL`: أرسل سجل الخطوات كاملاً قبل أي
  محاولة أخرى.

## إذا فشلت صفحة الجسر (البديل المباشر في Termux)

إذا رجعت `/api/bridge/fel-read` أو `fel-write` أو `fel-exec`
أو `fel-spl-uboot` خطأ `*_bad_output` أو مهلة، فصيغة الأمر
في الخادم قد لا تعمل على إصدار Termux لديك. جرّب مباشرة
في Termux (مع بقاء الجهاز في FEL):

```bash
termux-usb -l
termux-usb -r /dev/bus/usb/001/002   # غيّر المسار حسب خرج -l

# قراءة 16 بايت من 0x1000:
termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/002

# كتابة نمط (بعد إنشاء الملف):
printf 'HELLO-FEL-PATTERN-0123456789' > /tmp/pattern.bin
termux-usb -r -E -e "./bridge/fel_write 0x1000 /tmp/pattern.bin" /dev/bus/usb/001/002

# قراءته مجدداً للمقارنة:
termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/002

# SPL + U-Boot (v3.1) مباشرة — الملف الكامل فقط، وليس spl-only.bin:
# الملف على الهاتف الآن باسم بسيط بلا مسافات (نُسخ من التنزيل):
#   cp "/storage/emulated/0/Download/u-boot-sunxi-with-spl (3).bin" /data/data/com.termux/files/home/uboot-full.bin
# تحقق أولاً (v3.1) — بدون كتابة:
termux-usb -r -E -e "./bridge/fel_spl_uboot --validate-only /data/data/com.termux/files/home/uboot-full.bin" /dev/bus/usb/001/002
# أو عبر متغير البيئة:
FEL_VALIDATE_ONLY=1 termux-usb -r -E -e "./bridge/fel_spl_uboot /data/data/com.termux/files/home/uboot-full.bin" /dev/bus/usb/001/002
# فقط بعد نجاح التحقق فقط، التدفق الكامل:
termux-usb -r -E -e "./bridge/fel_spl_uboot /data/data/com.termux/files/home/uboot-full.bin" /dev/bus/usb/001/002

# بعدها، أعد فحص FEL_VERSION وقراءة 0x4:
termux-usb -r -E -e "./bridge/fel_version" /dev/bus/usb/001/002
termux-usb -r -E -e "./bridge/fel_read 0x4 8" /dev/bus/usb/001/002
```

إذا لم يوجد الخيار `-E` على هاتفك، جرّب الصيغة نفسها
بدونه. أرسل النواتج كما هي.

## Node معطّل (درس v1)

إذا ظهر خطأ `CANNOT LINK EXECUTABLE "node": library
"libicui18n.so.79" not found`:
1. `pkg update -y` ثم `pkg upgrade -y` ثم
   `pkg install -y libicu` ثم `node -v` — النجاح هو
   ظهور إصدار Node.
2. **لا تعِد تشغيل `bridge/termux-setup.sh` بعد الإصلاح**،
   فهو الآن لا يعيد تثبيت Node إذا كان يعمل، لكن لا داعي
   للمخاطرة.
3. إذا استمر الخطأ: `pkg uninstall nodejs-lts` ثم
   `pkg install nodejs` ثم `node -v` و`npm -v`.

## واجهة الخادم (API)

| الطريقة | المسار | ماذا يفعل |
|---|---|---|
| GET | `/api/bridge/status` | حالة الجسر v3، `read-write-sram-only+spl-uboot`، لا يحتاج جهازاً |
| GET | `/api/bridge/session` | النطاقات المكتوبة في هذه الجلسة (العنوان، الطول، SHA-256) |
| POST | `/api/bridge/probe` | `{device}` → يشغّل `usb_probe` عبر `termux-usb -e` (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-version` | `{device}` → يشغّل `fel_version` عبر `termux-usb -e` (مهلة 5 ثوانٍ) |
| POST | `/api/bridge/fel-read` | `{device, address, length}` → SRAM + SID فقط، طول 1..4096 (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-write` | `{device, address, base64, sha256, confirm:true, spl?:boolean}` → SRAM فقط، ≤ 128 KiB، SHA-256 يجب أن يطابق، `confirm` يجب أن يكون `true` حرفياً (مهلة 30 ثانية). **تحذير: `spl:true` مهمل في v3 — قتل FEL في 2026-11-17؛ استخدم `fel-spl-uboot` بدلاً منه.** |
| POST | `/api/bridge/fel-exec` | `{device, address, confirm:true}` → مرفوض ما لم يكن العنوان داخل نطاق مكتوب في هذه الجلسة (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-spl-uboot` | `{device, base64, sha256, confirm:true, validate_only?:boolean}` → يتحقق من الملف الكامل `u-boot-sunxi-with-spl.bin` (≤ 600KB، eGON + checksum + ترويسة mkimage + عنوان DRAM) ثم يشغّل `fel_spl_uboot`: تبديل stacks + thunk + `eGON.FEL` + وضع U-Boot في DRAM + تنفيذ (مهلة 60 ثانية؛ 10 ثوانٍ عند `validate_only:true`، دون أي كتابة أو تنفيذ). يرجع سجل الخطوات كاملاً في `steps`، وخطوات التقدم الفورية في `progress`، وفي حالة الفشل في `detail.steps`. |
| GET | `/api/bridge/report` | آخر تقرير محفوظ، أو 404 إن لم يكن هناك تقرير |

لا يوجد `/write` أو `/exec` أو `/flash` أو `/emmc` أو
`/read` — أي طلب إليها يرجع 404. إذا لم يكن الثنائي
المطلوب مبنياً، يرجع الخطأ 501 صريحاً، ولا يُخترع نتيجة.

## الملفات

```text
bridge/
├── README.md            # هذا الملف
├── docs/SOURCES.md      # المصادر الموثقة وما هو غير مختبَر
├── termux-setup.sh      # تثبيت وبناء في Termux (v3)
├── run-bridge.sh        # تشغيل الخادم على 127.0.0.1:3001
├── server.js            # خادم Node v3.1 (http المدمج فقط، بدون اعتماديات)
├── fel_common.h/.c      # نقل FEL المشترك + allowlist + SHA-256 (GPL-2.0-or-later)
├── fel_version.c        # عميل FEL_VERSION للقراءة فقط (GPL-2.0-or-later)
├── fel_read.c           # عميل FEL_READ، SRAM + SID فقط (GPL-2.0-or-later)
├── fel_write.c          # عميل FEL_WRITE، SRAM فقط (GPL-2.0-or-later)
├── fel_exec.c           # عميل FEL_EXEC، SRAM فقط، يتطلب --confirmed (GPL-2.0-or-later)
├── fel_spl_uboot.c      # v3.1: SPL + U-Boot على طريقة sunxi-fel (swap/thunk/eGON.FEL/DRAM) + خطوات تقدم فورية + --validate-only (GPL-2.0-or-later؛ thunk من sunxi-tools، MIT)
├── tests/bridge.test.js # اختبارات Node بدون جهاز (28 اختباراً في v3.1، كلها تمر في VM بدون جهاز)
├── run/                 # تقارير التشغيل + session.json (لا تُرفع إلى Git)
└── reports/             # نسخ التقارير (لا تُرفع إلى Git)
```

## ما بعد v3 (خارج النطاق عمداً)

- كتابة eMMC أو توليد صورة SD إقلاعية — غير موجودة في v3
  ولا تُبنى من تخمين. v3 يضع U-Boot في DRAM فقط؛ لا يكتب
  أي شيء دائماً.

لا تبنِ أيّاً مما سبق من هذا الملف وحده؛ كل مرحلة تحتاج
توثيقاً واختباراً على جهاز حقيقي أولاً.
