# جسر Termux — ARTEMIS R69 (v1، قراءة فقط)

**English summary:** A Termux bridge that lets a Samsung phone talk
to an R69 TV Box in FEL mode over OTG, read-only. The phone runs a
localhost-only Node server (`127.0.0.1:3001`) that runs `usb_probe`
and a minimal `fel_version` client through `termux-usb`. ARTEMIS,
running locally on the same phone (`127.0.0.1:3000`), shows the
probe / FEL_VERSION report. No FEL_WRITE, no FEL_EXEC, no eMMC
write, no SD-image builder in v1. Nothing here has been tested on
a live R69 yet — see “ما هو غير مختبَر” below.

## الفكرة في سطر واحد

```
TV Box (FEL) --OTG--> هاتف Samsung (Termux = الجسر، localhost فقط)
  --> ARTEMIS على 127.0.0.1:3000 --> تقرير JSON تنسخه إلى Muse
```

أنا (Muse) لست على هاتفك ولا أصل إلى USB مباشرة. الهاتف هو
الجسر، وأنا أحلل التقارير التي ينتجها وأعطي الأمر التالي. هذه
هي الطريقة الذكية الواقعية، وليست اتصالاً مباشراً وهمياً.

## حدود السلامة — اقرأ قبل التشغيل

- **v1 قراءة فقط.** لا يوجد أي endpoint للكتابة في الخادم، ولا
  يوجد `FEL_WRITE` أو `FEL_EXEC` في `fel_version.c` (الثوابت
  `0x101` / `0x102` / `0x103` غير معرّفة فيه عمداً).
- الخادم يرتبط بـ `127.0.0.1:3001` فقط. أي محاولة ربط بعنوان
  آخر تُرفض وتُنهي العملية. لا يوجد CORS إلا لـ ARTEMIS المحلي
  (`http://127.0.0.1:3000` و`http://localhost:3000`).
- **صفحة الجسر لا تعمل من موقع Render.** الموقع على
  `https://artemis-r69.onrender.com` لا يستطيع الوصول إلى
  `http://127.0.0.1:3001` على هاتفك. يجب تشغيل ARTEMIS محلياً
  في Termux (`npm start` → `http://127.0.0.1:3000`).
- `fel_version.c` مرخّص GPL-2.0-or-later (انظر ملف المصدر)،
  بينما بقية المستودع Apache-2.0. بروتوكول FEL نفسه موثّق في
  `bridge/docs/SOURCES.md` من مصدر sunxi-tools.

## ما هو غير مختبَر (مهم)

لم يتوفر جهاز R69 أثناء بناء هذا الجسر، فلا تدّعي أن أي خطوة
“تعمل” قبل تجربتها على جهازك:

- هل ينجح `libusb_claim_interface(0)` على مقبض termux-usb
  في هاتف Samsung؟ الكود يبلّغ عن الفشل بدل تجاهله.
- هل تكفي مهلة 5 ثوانٍ لرد FEL_VERSION على هاتفك؟
- صيغة خرج `termux-usb -l` على إصدار Termux لديك.
- وجود خيار `-E` في `termux-usb` (يمرر FD عبر `$TERMUX_USB_FD`)؛
  `fel_version.c` يقبله كبديل، لكن الخادم يستخدم صيغة `-e`
  الموثّقة.

## التثبيت على الهاتف (Termux)

1. ثبّت تطبيق **Termux** وتطبيق **Termux:API** من **F-Droid**
   (نسخ Play Store قديمة). السكربت لا يستطيع تثبيت التطبيقات.
2. انسخ المستودع إلى الهاتف أو افتحه في Termux، ثم:
   ```bash
   bash bridge/termux-setup.sh
   ```
   يثبّت `termux-api libusb clang nodejs-lts git`، ويبني
   `usb_probe` و`bridge/fel_version`، وينشئ `bridge/run/`
   و`bridge/reports/`. السكربت idempotent — آمن لإعادة تشغيله.
   `sunxi-fel` غير مطلوب في v1، ولن يُبنى افتراضياً (انظر
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

## الفحص من المتصفح (قراءة فقط)

1. اضغط **“فحص حالة الجسر”**: يجب أن تظهر `read-only` وأن
   `usb_probe` و`fel_version` متوفران. إذا ظهر “الجسر غير
   مشغّل”، فالخادم غير يعمل — لا يوجد اتصال وهمي.
2. أدخل مسار الجهاز من `termux-usb -l` (مثال:
   `/dev/bus/usb/001/002`) واضغط **“تشغيل فحص USB”**.
   يظهر VID/PID والواجهات ونقاط النهاية.
3. اضغط **“قراءة FEL_VERSION”**: يجب أن يظهر
   `soc_id_hex: 0x1680` و`soc_name: H3` إذا كان الجهاز فعلاً
   في FEL. أي قيمة أخرى تعني: لا تتابع إلى أي كتابة.
4. اضغط **“نسخ التقرير”** وأرسله إلى Muse. التقرير يُحفظ
   أيضاً في `bridge/run/latest-report.json` وفي
   `bridge/reports/` على الهاتف.

## واجهة الخادم (API)

| الطريقة | المسار | ماذا يفعل |
|---|---|---|
| GET | `/api/bridge/status` | حالة الجسر، قراءة فقط، لا يحتاج جهازاً |
| POST | `/api/bridge/probe` | `{device}` → يشغّل `usb_probe` عبر `termux-usb -e` (مهلة 10 ثوانٍ) |
| POST | `/api/bridge/fel-version` | `{device}` → يشغّل `fel_version` عبر `termux-usb -e` (مهلة 5 ثوانٍ) |
| GET | `/api/bridge/report` | آخر تقرير محفوظ، أو 404 إن لم يكن هناك تقرير |

لا يوجد `/write` أو `/exec` أو `/flash` — أي طلب إليها
يرجع 404. إذا لم يكن ملف `fel_version` مبنياً، يرجع
`fel-version` خطأ 501 صريحاً: “not implemented until the
binary exists”، ولا يخترع نتيجة.

## الملفات

```text
bridge/
├── README.md            # هذا الملف
├── docs/SOURCES.md      # المصادر الموثقة وما هو غير مختبَر
├── termux-setup.sh      # تثبيت وبناء في Termux
├── run-bridge.sh        # تشغيل الخادم على 127.0.0.1:3001
├── server.js            # خادم Node (http المدمج فقط، بدون اعتماديات)
├── fel_version.c        # عميل FEL_VERSION للقراءة فقط (GPL-2.0-or-later)
├── tests/bridge.test.js # اختبارات Node بدون جهاز
├── run/                 # تقارير التشغيل (لا تُرفع إلى Git)
└── reports/             # نسخ التقارير (لا تُرفع إلى Git)
```

## ما بعد v1 (خارج النطاق عمداً)

- قراءة ذاكرة عبر FEL_READ لعناوين موثّقة فقط، بعد تأكيد
  FEL_VERSION.
- تحميل SPL إلى SRAM وتنفيذه — يتطلب عناوين H3 الموثّقة
  (`scratch 0x1000` وغيرها في `fel.c`) ومراجعة مستقلة،
  ونسخة احتياطية، وموافقة صريحة لكل أمر.
- كتابة eMMC أو توليد صورة SD إقلاعية — غير موجودة في v1
  ولا تُبنى من تخمين.

لا تبنِ أيّاً مما سبق من هذا الملف وحده؛ كل مرحلة تحتاج
توثيقاً واختباراً على جهاز حقيقي أولاً.
