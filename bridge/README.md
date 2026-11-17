# جسر Termux — ARTEMIS R69 (v2، قراءة FEL + كتابة SRAM فقط)

**English summary:** A Termux bridge that lets a Samsung phone talk
to an R69 TV Box in FEL mode over OTG. v2 adds FEL_READ (SRAM +
SID only), FEL_WRITE and FEL_EXEC confined to H3 SRAM
(`0x00000000-0x00020000`), with an explicit confirm per write/exec
and an exec rule that requires a prior write in the same bridge
session. There is still **no eMMC / flash / NAND write** anywhere
in the bridge. FEL_VERSION was proven live on the phone on
2026-11-17 (`AWUSBFEX`, soc `0x1680`, H3); FEL_READ / FEL_WRITE /
FEL_EXEC are verified from sunxi-tools source only and are
**UNVERIFIED on real hardware** until the test plan below is run.

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
- **SPL: غير موثّق في v2.** تحميل SPL يكتب الملف خاماً
  إلى `0x00000000` ثم ينفذه من هناك، **دون** تبديل
  الـstacks ودون thunk كما يفعل sunxi-fel الأصلي (انظر
  `bridge/docs/SOURCES.md` §6). هذا المسار قد يقتل FEL
  أثناء النقل. لا تستخدمه قبل نجاح اختبار النمط (أدناه)،
  ولا تستخدمه إلا بموافقة صريحة لكل تشغيل.
- الخادم يرتبط بـ `127.0.0.1:3001` فقط. أي محاولة ربط بعنوان
  آخر تُرفض وتُنهي العملية. لا يوجد CORS إلا لـ ARTEMIS المحلي
  (`http://127.0.0.1:3000` و`http://localhost:3000`).
- **صفحة الجسر لا تعمل من موقع Render.** الموقع على
  `https://artemis-r69.onrender.com` لا يستطيع الوصول إلى
  `http://127.0.0.1:3001` على هاتفك. يجب تشغيل ARTEMIS محلياً
  في Termux (`npm start` → `http://127.0.0.1:3000`).
- `fel_common.c` و`fel_read.c` و`fel_write.c` و`fel_exec.c`
  و`fel_version.c` مرخّصة GPL-2.0-or-later (انظر ملفات المصدر)،
  بينما بقية المستودع Apache-2.0. بروتوكول FEL نفسه موثّق في
  `bridge/docs/SOURCES.md` من مصدر sunxi-tools.

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

**غير مختبَر على جهاز حقيقي:**
- FEL_READ / FEL_WRITE / FEL_EXEC أنفسها.
- صيغة `termux-usb -e "<binary> <args>"` على هاتفك (v1
  استخدم صيغة الثنائي وحده، وهي المثبتة). إذا فشلت،
  استخدم البديل المباشر في قسم "إذا فشلت صفحة الجسر".
- تحميل SPL خاماً وتنفيذه من `0x0` دون swap/thunk.

## التثبيت على الهاتف (Termux)

1. ثبّت تطبيق **Termux** وتطبيق **Termux:API** من **F-Droid**
   (نسخ Play Store قديمة). السكربت لا يستطيع تثبيت التطبيقات.
2. انسخ المستودع إلى الهاتف أو افتحه في Termux، ثم:
   ```bash
   git checkout bridge/termux-v2
   bash bridge/termux-setup.sh
   ```
   يثبّت `termux-api libusb clang git`، ويبني `usb_probe`
   و`bridge/fel_version` و`bridge/fel_read` و`bridge/fel_write`
   و`bridge/fel_exec`، وينشئ `bridge/run/` و`bridge/reports/`.
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
   `HELLO-FEL-PATTERN-0123456789` (16 بايت)، ويعرض SHA-256
   الخاص به.
2. اكتب النمط إلى العنوان `0x1000` (زر "كتابة النمط" —
   يتطلب تأكيداً).
3. اقرأ `0x1000` مجدداً بطول 16 بـ FEL_READ، وقارن
   `sha256`: يجب أن يطابق SHA-256 النمط تماماً.
4. المتوقع: الكتابة والقراءة تعملان، وFEL ما زال يرد على
   FEL_VERSION بعدها. إذا اختلف SHA-256 أو توقف FEL عن
   الرد، أعد إدخال الجهاز في FEL (افصل الطاقة، اضغط
   الريسيت، أعد التوصيل) وأرسل التقارير.
5. لا تنفّذ (`Exec`) النمط — إنه بيانات نصية، وليس كوداً.

### (ج) تحميل SPL + تنفيذ — فقط بموافقة صريحة، وبعد نجاح (أ) و(ب)
1. **مصدر SPL:** لا يوجد أي ملف SPL مرفق مع الجسر، ولا
   رابط تنزيل مخترع هنا. المصدر الصحيح هو أحد هذين:
   - ملف `u-boot-sunxi-with-spl.bin` معروف وموثوق للوحة
     `dolphin-p1` مع LPDDR3 (ابنِه من U-Boot لنفس اللوحة،
     أو خذه من مصدر تثق به)، أو
   - SPL مستخرج من `atv10_h3fixed.img` على الهاتف (من
     `boot0_sdcard.fex` / `boot_package.fex` — لكن انتبه:
     boot0 الخاص بالشركة المصنّعة ليس بالضرورة SPL
     بصيغة eGON التي يتوقعها sunxi-fel؛ تحقق منه أولاً
     في "مختبر Bootloader": يجب أن يبدأ بـ `eGON.BT0`
     وأن يصح checksum الخاص به).
   قبل الرفع: تحقق من حجم الملف (≤ 32768 بايت، وهو
   `SPL_LEN_LIMIT 0x8000`) ومن SHA-256 الخاص به، وسجّلهما.
2. في صفحة الجسر، نموذج SPL: اختر الملف، وسيُحسب SHA-256
   في المتصفح ويُعرض مع الحجم. العنوان مُعبأ مسبقاً بـ
   `0x00000000` (عنوان تحميل SPL لـ H3 في sunxi-fel).
3. علّم على "أفهم أن هذه الكتابة إلى SRAM فقط، وليست إلى
   eMMC/Flash" ثم اضغط "كتابة SPL". هذا يتطلب تأكيداً.
4. **فقط بعد نجاح الكتابة وظهور النطاق في "الجلسة"**،
   يصبح زر "تنفيذ SPL" متاحاً، ويتطلب تأكيداً ثانياً.
5. بعد التنفيذ: **قد لا يأتي رد حالة FEL أبداً** — SPL
   الذي يستلم الجهاز لا يعود. هذا متوقع، وليس بالضرورة
   فشلاً. أعد فحص FEL_VERSION:
   - إذا ردّ FEL_VERSION: SPL لم يستلم الجهاز (أو عاد).
     اقرأ `0x00000004` (8 بايت) وتحقق من توقيع `eGON.FEL`
     كما يفعل sunxi-fel.
   - إذا لم يردّ: SPL قد يعمل، أو الجهاز تعطّل. أعد إدخاله
     في FEL (افصل الطاقة، اضغط الريسيت، أعد التوصيل) ثم
     أعد فحص FEL_VERSION.
6. أرسل كل التقارير (كتابة + تنفيذ + FEL_VERSION بعدها)
   إلى Muse قبل أي خطوة تالية. لا يوجد في v2 أي خطوة
   بعد تنفيذ SPL (لا كتابة U-Boot كاملة، ولا كتابة eMMC).

## إذا فشلت صفحة الجسر (البديل المباشر في Termux)

إذا رجعت `/api/bridge/fel-read` أو `fel-write` أو `fel-exec`
خطأ `*_bad_output` أو مهلة، فصيغة الأمر في الخادم قد لا
تعمل على إصدار Termux لديك. جرّب مباشرة في Termux (مع
بقاء الجهاز في FEL):

```bash
termux-usb -l
termux-usb -r /dev/bus/usb/001/004   # غيّر المسار حسب خرج -l

# قراءة 16 بايت من 0x1000:
termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/004

# كتابة نمط (بعد إنشاء الملف):
printf 'HELLO-FEL-PATTERN-0123456789' > /tmp/pattern.bin
termux-usb -r -E -e "./bridge/fel_write 0x1000 /tmp/pattern.bin" /dev/bus/usb/001/004

# قراءته مجدداً للمقارنة:
termux-usb -r -E -e "./bridge/fel_read 0x1000 16" /dev/bus/usb/001/004
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
| GET | `/api/bridge/status` | حالة الجسر v2، `read-write-sram-only`، لا يحتاج جهازاً |
| GET | `/api/bridge/session` | النطاقات المكتوبة في هذه الجلسة (العنوان، الطول، SHA-256) |
| POST | `/api/bridge/probe` | `{device}` → يشغّل `usb_probe` عبر `termux-usb -e` (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-version` | `{device}` → يشغّل `fel_version` عبر `termux-usb -e` (مهلة 5 ثوانٍ) |
| POST | `/api/bridge/fel-read` | `{device, address, length}` → SRAM + SID فقط، طول 1..4096 (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-write` | `{device, address, base64, sha256, confirm:true, spl?:boolean}` → SRAM فقط، ≤ 128 KiB، SHA-256 يجب أن يطابق، `confirm` يجب أن يكون `true` حرفياً (مهلة 30 ثانية) |
| POST | `/api/bridge/fel-exec` | `{device, address, confirm:true}` → مرفوض ما لم يكن العنوان داخل نطاق مكتوب في هذه الجلسة (مهلة 10 ثوانٍ) |
| GET | `/api/bridge/report` | آخر تقرير محفوظ، أو 404 إن لم يكن هناك تقرير |

لا يوجد `/write` أو `/exec` أو `/flash` أو `/emmc` أو
`/read` — أي طلب إليها يرجع 404. إذا لم يكن الثنائي
المطلوب مبنياً، يرجع الخطأ 501 صريحاً، ولا يُخترع نتيجة.

## الملفات

```text
bridge/
├── README.md            # هذا الملف
├── docs/SOURCES.md      # المصادر الموثقة وما هو غير مختبَر
├── termux-setup.sh      # تثبيت وبناء في Termux (v2)
├── run-bridge.sh        # تشغيل الخادم على 127.0.0.1:3001
├── server.js            # خادم Node v2 (http المدمج فقط، بدون اعتماديات)
├── fel_common.h/.c      # نقل FEL المشترك + allowlist + SHA-256 (GPL-2.0-or-later)
├── fel_version.c        # عميل FEL_VERSION للقراءة فقط (GPL-2.0-or-later)
├── fel_read.c           # عميل FEL_READ، SRAM + SID فقط (GPL-2.0-or-later)
├── fel_write.c          # عميل FEL_WRITE، SRAM فقط (GPL-2.0-or-later)
├── fel_exec.c           # عميل FEL_EXEC، SRAM فقط، يتطلب --confirmed (GPL-2.0-or-later)
├── tests/bridge.test.js # اختبارات Node بدون جهاز (14 اختباراً في v2)
├── run/                 # تقارير التشغيل + session.json (لا تُرفع إلى Git)
└── reports/             # نسخ التقارير (لا تُرفع إلى Git)
```

## ما بعد v2 (خارج النطاق عمداً)

- محمّل SPL صحيح على طريقة sunxi-fel (تبديل stacks +
  thunk + فحص eGON checksum + قراءة `eGON.FEL` بعد التنفيذ).
- كتابة U-Boot الكاملة بعد SPL (الجزء بعد `SPL_LEN_LIMIT`).
- كتابة eMMC أو توليد صورة SD إقلاعية — غير موجودة في v2
  ولا تُبنى من تخمين.

لا تبنِ أيّاً مما سبق من هذا الملف وحده؛ كل مرحلة تحتاج
توثيقاً واختباراً على جهاز حقيقي أولاً.
