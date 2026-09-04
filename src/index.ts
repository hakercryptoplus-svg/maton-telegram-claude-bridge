import 'dotenv/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Telegraf } from 'telegraf';
import { MatonBrowser } from './maton-browser.js';
import { logger } from './logger.js';
import {
  alreadyConnectedMessage,
  formatError,
  formatStatus,
  formatStreamChunk,
  helpMessage,
  welcomeMessage,
} from './formatter.js';
import type { BridgeMode, BridgeState } from './types.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUserId = process.env.ALLOWED_TELEGRAM_USER_ID;
const dataDir = process.env.BROWSER_DATA_DIR ?? '/data/browser';
const stateFile = `${dataDir}/bridge-state.json`;
if (!token || !allowedUserId) throw new Error('TELEGRAM_BOT_TOKEN and ALLOWED_TELEGRAM_USER_ID are required');

const bot = new Telegraf(token, {
  telegram: { apiRoot: process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org' },
});
const browser = new MatonBrowser(dataDir);
const port = Number(process.env.PORT ?? 10000);

// ── HTTP health server ────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'maton-telegram-claude-bridge' }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});
httpServer.listen(port, '0.0.0.0', () => logger.info(`Health server listening on port ${port}`));

// ── State ─────────────────────────────────────────────────────────────────────
let state: BridgeState = { mode: 'idle' };
let busy = false;

async function saveState(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, stateFile);
}

async function loadState(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<BridgeState>;
    const validModes: BridgeMode[] = ['idle', 'awaiting-email', 'awaiting-confirmation', 'awaiting-task', 'ready'];
    state = {
      taskUrl: saved.taskUrl,
      mode: validModes.includes(saved.mode as BridgeMode) ? (saved.mode as BridgeMode) : 'idle',
      lastChatId: saved.lastChatId,
    };
    logger.info('State loaded', { mode: state.mode, hasTask: !!state.taskUrl });
  } catch {
    logger.info('No saved state, starting fresh');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function authorized(ctx: any): boolean {
  return String(ctx.from?.id ?? '') === allowedUserId;
}

function deny(ctx: any) {
  return ctx.reply('⛔ غير مصرح لهذا الحساب.', { parse_mode: 'HTML' });
}

function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s]+/i)?.[0];
}

async function streamReply(chatId: number, messageId: number, text: string, done = false): Promise<void> {
  // Limit to 4000 chars (Telegram's limit is 4096 for HTML)
  const trimmed = text.length > 3800 ? '...\n\n' + text.slice(-3800) : text;
  const formatted = formatStreamChunk(trimmed, done);
  await bot.telegram.editMessageText(chatId, messageId, undefined, formatted, { parse_mode: 'HTML' }).catch(() => undefined);
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  if (!authorized(ctx)) return deny(ctx);
  state.lastChatId = ctx.chat.id;

  if (state.mode === 'ready' && state.taskUrl) {
    return ctx.reply(alreadyConnectedMessage(state.taskUrl), { parse_mode: 'HTML' });
  }
  if (state.mode === 'awaiting-task') {
    return ctx.reply('✅ <b>المصادقة محفوظة.</b> أرسل رابط المهمة من Maton.', { parse_mode: 'HTML' });
  }

  state.mode = 'awaiting-email';
  await saveState();
  return ctx.reply(welcomeMessage(), { parse_mode: 'HTML' });
});

bot.help(async (ctx) => {
  if (!authorized(ctx)) return deny(ctx);
  return ctx.reply(helpMessage(), { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
  console.log(`Telegram update received: chat=${ctx.chat.id} from=${ctx.from?.id ?? 'unknown'}`);
  if (!authorized(ctx)) return deny(ctx);
  const text = ctx.message.text.trim();
  state.lastChatId = ctx.chat.id;

  // ── Built-in commands ───────────────────────────────────────────────────────
  if (text === '/status') {
    return ctx.reply(formatStatus(state.mode, state.taskUrl), { parse_mode: 'HTML' });
  }
  if (text === '/help') {
    return ctx.reply(helpMessage(), { parse_mode: 'HTML' });
  }
  if (text === '/reset') {
    state = { mode: 'idle', lastChatId: ctx.chat.id };
    busy = false;
    await saveState();
    return ctx.reply('🔄 <b>تمت إعادة ضبط الجلسة.</b> أرسل /start للبدء.', { parse_mode: 'HTML' });
  }

  if (busy) {
    return ctx.reply('⏳ يُرجى الانتظار، هناك طلب قيد المعالجة...', { parse_mode: 'HTML' });
  }

  // ── State machine ───────────────────────────────────────────────────────────
  if (state.mode === 'awaiting-email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      return ctx.reply('📧 أرسل بريدًا إلكترونيًا صالحًا.', { parse_mode: 'HTML' });
    }
    busy = true;
    try {
      await browser.openLogin();
      await browser.submitEmail(text);
      state.mode = 'awaiting-confirmation';
      await ctx.reply(
        '📨 <b>تم إرسال رابط الدخول!</b>\n\nافتح بريدك وأرسل رابط التأكيد هنا.',
        { parse_mode: 'HTML' },
      );
    } catch (e) {
      await ctx.reply(formatError(`فشل بدء الدخول: ${String(e)}`), { parse_mode: 'HTML' });
    } finally {
      busy = false;
    }
    await saveState();
    return;
  }

  if (state.mode === 'awaiting-confirmation') {
    const url = extractUrl(text);
    if (!url) return ctx.reply('🔗 أرسل رابط التأكيد كاملًا.', { parse_mode: 'HTML' });
    busy = true;
    try {
      await browser.openConfirmationUrl(url);
      state.mode = 'awaiting-task';
      await ctx.reply(
        '✅ <b>تمت المصادقة بنجاح!</b>\n\nأرسل رابط المهمة من Maton\n<code>https://www.maton.ai/tasks/...</code>',
        { parse_mode: 'HTML' },
      );
    } catch (e) {
      await ctx.reply(formatError(`رابط التأكيد غير مقبول: ${String(e)}`), { parse_mode: 'HTML' });
    } finally {
      busy = false;
    }
    await saveState();
    return;
  }

  if (state.mode === 'awaiting-task') {
    if (!/^https:\/\/www\.maton\.ai\/tasks\/[\w-]+$/i.test(text)) {
      return ctx.reply(
        '🔗 أرسل رابط مهمة Maton بصيغة:\n<code>https://www.maton.ai/tasks/...</code>',
        { parse_mode: 'HTML' },
      );
    }
    busy = true;
    try {
      await browser.openTask(text);
      state.taskUrl = text;
      state.mode = 'ready';
      await saveState();
      await ctx.reply(
        '🚀 <b>تم فتح المهمة!</b>\n\nأرسل رسالتك الآن إلى Claude Code.',
        { parse_mode: 'HTML' },
      );
    } catch (e) {
      await ctx.reply(formatError(`تعذر فتح المهمة: ${String(e)}`), { parse_mode: 'HTML' });
    } finally {
      busy = false;
    }
    return;
  }

  if (state.mode !== 'ready') {
    return ctx.reply('💡 أرسل /start للبدء.', { parse_mode: 'HTML' });
  }

  // ── Send message to Claude ──────────────────────────────────────────────────
  busy = true;
  const status = await ctx.reply('⏳ <b>Claude Code</b>', { parse_mode: 'HTML' });
  try {
    let latestResponse = '';
    await browser.sendTaskMessage(text, async (response) => {
      latestResponse = response;
      await streamReply(ctx.chat.id, status.message_id, response, false);
    });
    // Final update — just change icon to done
    await streamReply(ctx.chat.id, status.message_id, latestResponse, true).catch(() => undefined);
  } catch (e) {
    logger.error('Failed to send task message', { error: String(e) });
    await ctx.reply(`❌ فشل: ${String(e)}`, { parse_mode: 'HTML' });
  } finally {
    busy = false;
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────
bot.catch((error, ctx) => {
  console.error('Telegram update handler failed:', error, { updateType: ctx.updateType });
});
await loadState();
await browser.start();

if (state.taskUrl && state.mode === 'ready') {
  try {
    await browser.openTask(state.taskUrl);
    logger.info('Restored Maton task session');
  } catch (error) {
    logger.error('Could not restore Maton task on startup', { error: String(error) });
  }
}

let launched = false;
for (let attempt = 1; attempt <= 5 && !launched; attempt++) {
  try {
    // Render runs one long-lived process; remove any stale webhook so polling receives updates.
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    await bot.launch({ dropPendingUpdates: false });
    launched = true;
  } catch (error) {
    logger.error(`Telegram startup attempt ${attempt}/5 failed`, { error: String(error) });
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
  }
}
if (!launched) throw new Error('Telegram connection failed after 5 attempts');
logger.info('Maton Telegram bridge is running | build=telegram-polling-webhook-fix');
console.log('Telegram polling is active; send /status to verify message delivery.');
process.once('SIGINT', () => { bot.stop('SIGINT'); httpServer.close(); void browser.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); httpServer.close(); void browser.close(); });
