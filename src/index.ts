import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Telegraf } from 'telegraf';
import { MatonBrowser } from './maton-browser.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
const dataDir = process.env.BROWSER_DATA_DIR ?? '/data/browser';
const stateFile = `${dataDir}/bridge-state.json`;
if (!token || !allowedUserId) throw new Error('TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_USER_ID are required');

const bot = new Telegraf(token, {
  telegram: {
    apiRoot: process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org',
  },
});
const browser = new MatonBrowser(dataDir);
const port = Number(process.env.PORT ?? 10000);
const httpServer = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'maton-telegram-claude-bridge' }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});
httpServer.listen(port, '0.0.0.0', () => console.log(`HTTP health server listening on ${port}`));
let taskUrl: string | undefined;
let busy = false;
let mode: 'idle' | 'awaiting-email' | 'awaiting-confirmation' | 'awaiting-task' | 'ready' = 'idle';
let lastChatId: number | undefined;

async function saveState() {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify({ taskUrl, mode, lastChatId }, null, 2), { mode: 0o600 });
  await rename(tmp, stateFile);
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as { taskUrl?: string; mode?: string; lastChatId?: number };
    if (saved.taskUrl) taskUrl = saved.taskUrl;
    if (['idle', 'awaiting-email', 'awaiting-confirmation', 'awaiting-task', 'ready'].includes(saved.mode ?? '')) mode = saved.mode as typeof mode;
    if (saved.lastChatId) lastChatId = saved.lastChatId;
  } catch { /* first boot: no saved state */ }
}

function authorized(ctx: any) {
  return String(ctx.from?.id ?? '') === allowedUserId;
}
function deny(ctx: any) {
  return ctx.reply('غير مصرح لهذا الحساب.');
}
function extractUrl(text: string) {
  return text.match(/https?:\/\/[^\s]+/i)?.[0];
}
async function streamReply(chatId: number, messageId: number, text: string) {
  const clipped = text.slice(-3900);
  await bot.telegram.editMessageText(chatId, messageId, undefined, clipped).catch(() => undefined);
}

bot.start(async (ctx) => {
  if (!authorized(ctx)) return deny(ctx);
  lastChatId = ctx.chat.id;
  if (mode === 'ready' && taskUrl) return ctx.reply('الجلسة والمهمة محفوظتان. أرسل رسالتك مباشرة، أو أرسل /reset لإعادة الضبط.');
  if (mode === 'awaiting-task') return ctx.reply('المصادقة محفوظة. أرسل رابط المهمة من Maton.');
  mode = 'awaiting-email';
  await saveState();
  await ctx.reply('أرسل بريد Maton الإلكتروني. لن أستخدمه إلا لإكمال تسجيل الدخول.');
});

bot.on('text', async (ctx) => {
  if (!authorized(ctx)) return deny(ctx);
  const text = ctx.message.text.trim();
  lastChatId = ctx.chat.id;
  if (text === '/status') return ctx.reply(`الحالة: ${mode}${taskUrl ? `\nالمهمة: ${taskUrl}` : ''}`);
  if (text === '/reset') {
    mode = 'idle'; taskUrl = undefined; busy = false;
    await saveState();
    return ctx.reply('تمت إعادة ضبط الحالة. أرسل /start للبدء.');
  }
  if (busy) return ctx.reply('هناك طلب قيد التنفيذ، انتظر بث النتيجة.');

  if (mode === 'awaiting-email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return ctx.reply('أرسل بريدًا إلكترونيًا صالحًا.');
    busy = true;
    try { await browser.openLogin(); await browser.submitEmail(text); mode = 'awaiting-confirmation'; await ctx.reply('تم إرسال طلب الدخول. أرسل رابط التأكيد الذي وصلك في البريد.'); }
    catch (e) { await ctx.reply(`فشل بدء الدخول: ${String(e)}`); }
    finally { busy = false; }
    await saveState();
    return;
  }
  if (mode === 'awaiting-confirmation') {
    const url = extractUrl(text);
    if (!url) return ctx.reply('أرسل رابط التأكيد كاملًا.');
    busy = true;
    try { await browser.openConfirmationUrl(url); mode = 'awaiting-task'; await ctx.reply('تمت المصادقة. أرسل رابط المهمة من Maton.'); }
    catch (e) { await ctx.reply(`رابط التأكيد غير مقبول: ${String(e)}`); }
    finally { busy = false; }
    await saveState();
    return;
  }
  if (mode === 'awaiting-task') {
    if (!/^https:\/\/www\.maton\.ai\/tasks\/[\w-]+$/i.test(text)) return ctx.reply('أرسل رابط مهمة Maton بصيغة https://www.maton.ai/tasks/...');
    busy = true;
    try { await browser.openTask(text); taskUrl = text; mode = 'ready'; await saveState(); await ctx.reply('تم فتح المهمة. أرسل رسالتك الآن إلى Claude Code.'); }
    catch (e) { await ctx.reply(`تعذر فتح المهمة: ${String(e)}`); }
    finally { busy = false; }
    return;
  }
  if (mode !== 'ready') return ctx.reply('أرسل /start للبدء.');

  busy = true;
  const status = await ctx.reply('⏳ جاري إرسال الطلب إلى Claude Code...');
  try {
    await browser.sendTaskMessage(text, async (update) => streamReply(ctx.chat.id, status.message_id, update));
  } catch (e) { await streamReply(ctx.chat.id, status.message_id, `فشل الطلب: ${String(e)}`); }
  finally { busy = false; }
});

await loadState();
await browser.start();
if (taskUrl && String(mode) === 'ready') {
  try { await browser.openTask(taskUrl); console.log('Restored Maton task session'); }
  catch (error) { console.error('Could not restore Maton task on startup:', error); }
}
let launched = false;
for (let attempt = 1; attempt <= 5 && !launched; attempt++) {
  try {
    await bot.launch();
    launched = true;
  } catch (error) {
    console.error(`Telegram startup attempt ${attempt}/5 failed:`, error);
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
}
if (!launched) throw new Error('Telegram connection failed after 5 attempts');
console.log('Telegram/Maton bridge is running | build=web-service-health-fix');
process.once('SIGINT', () => { bot.stop('SIGINT'); httpServer.close(); void browser.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); httpServer.close(); void browser.close(); });
