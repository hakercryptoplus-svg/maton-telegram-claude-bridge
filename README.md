# Maton Telegram Claude Bridge

بوت Telegram خاص يفتح جلسة Chromium محفوظة، يمرّر خطوات تسجيل Maton، ثم يفتح مهمة Maton مرتبطة بـ Claude Code ويرسل الرسائل إليها ويعرض التحديثات تدريجيًا في Telegram.

## الأمان

هذا المشروع لا يضع أي رمز Telegram أو Maton داخل Git. احصر الوصول عبر `ALLOWED_TELEGRAM_USER_ID`، واستخدم Render Environment Variables. لا ترسل مفاتيح API أو روابط التأكيد إلى السجلات. رابط التأكيد حساس وقابل للاستخدام مرة واحدة.

## المتغيرات المطلوبة

```text
TELEGRAM_BOT_TOKEN=...
ALLOWED_TELEGRAM_USER_ID=123456789
BROWSER_DATA_DIR=/data/browser
```

## النشر على Render

أنشئ Web Service من هذا المستودع واختر Docker، أو استخدم ملف `render.yaml` عبر Blueprint. أضف قرصًا دائمًا بحجم 1GB على المسار `/data` حتى تبقى جلسة Chromium محفوظة بعد إعادة التشغيل. أضف `TELEGRAM_BOT_TOKEN` و`ALLOWED_TELEGRAM_USER_ID` من لوحة Render، ولا تضعهما في المستودع.

## الاستخدام

أرسل `/start`، ثم البريد، ثم رابط التأكيد الذي يصلك بالبريد، ثم رابط المهمة بصيغة `https://www.maton.ai/tasks/<uuid>`. بعد ظهور رسالة الجاهزية، كل رسالة نصية جديدة تُرسل إلى مربع مهمة Claude Code، ويجري تحديث رسالة Telegram أثناء تغيّر سجل المهمة.

الأوامر المتاحة هي `/status` لمعرفة الحالة و`/reset` لإعادة التدفق من البداية.

## ملاحظات مهمة

التدفق يعتمد على واجهة Maton المرئية، لأن Maton لا يوثق API عامة لإرسال رسائل إلى مهمة Claude Code الموجودة. إذا تغيّر تصميم الموقع فقد تحتاج محددات Playwright في `src/maton-browser.ts` إلى تحديث. كما أن Render Worker يحتاج خطة تدعم القرص الدائم؛ تخزين المتصفح دون قرص دائم سيؤدي إلى إعادة تسجيل الدخول بعد كل إعادة تشغيل.
