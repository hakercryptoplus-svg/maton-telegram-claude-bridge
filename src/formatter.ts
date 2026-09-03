/**
 * Telegram message formatting utilities.
 * Uses HTML parse mode for rich formatting.
 */

/** Escape HTML special chars for Telegram HTML mode */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Format a status update from Claude with nice HTML layout */
export function formatClaudeUpdate(text: string): string {
  const lines = text.split('\n');
  const formatted = lines.map((line) => {
    // Code blocks
    if (line.startsWith('    ') || line.startsWith('\t')) {
      return `<code>${esc(line.trimStart())}</code>`;
    }
    // Headers (##, ###)
    if (/^#{1,3}\s/.test(line)) {
      const content = line.replace(/^#+\s/, '');
      return `<b>${esc(content)}</b>`;
    }
    // Bold (**text**)
    const withBold = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    return withBold;
  });
  return formatted.join('\n').trim();
}

/** Progress message while waiting for Claude */
export function thinking(): string {
  return '🤔 <b>جاري التفكير...</b>';
}

/** Success prefix for responses */
export function claudeHeader(): string {
  return '🤖 <b>Claude Code:</b>\n\n';
}

/** Format final response */
export function formatFinalResponse(text: string): string {
  return claudeHeader() + formatClaudeUpdate(text);
}

/** Format a streamed chunk (partial response) */
export function formatStreamChunk(text: string, done = false): string {
  const icon = done ? '✅' : '⏳';
  return `${icon} <b>Claude Code:</b>\n\n${formatClaudeUpdate(text)}`;
}

/** Format error message */
export function formatError(msg: string): string {
  return `❌ <b>خطأ:</b> ${esc(msg)}`;
}

/** Format status message */
export function formatStatus(mode: string, taskUrl?: string): string {
  const modeLabels: Record<string, string> = {
    idle: '😴 غير نشط',
    'awaiting-email': '📧 في انتظار البريد الإلكتروني',
    'awaiting-confirmation': '🔗 في انتظار رابط التأكيد',
    'awaiting-task': '📋 في انتظار رابط المهمة',
    ready: '✅ جاهز',
  };
  const modeLabel = modeLabels[mode] ?? mode;
  let msg = `📊 <b>الحالة:</b> ${modeLabel}`;
  if (taskUrl) msg += `\n🔗 <b>المهمة:</b> <a href="${esc(taskUrl)}">${esc(taskUrl)}</a>`;
  return msg;
}

/** Welcome/start message */
export function welcomeMessage(): string {
  return (
    '👋 <b>مرحباً بك في Maton Bridge!</b>\n\n' +
    '🔗 هذا البوت يربطك بـ Claude Code عبر Maton.\n\n' +
    '📧 أرسل بريد Maton الإلكتروني لبدء تسجيل الدخول.'
  );
}

/** Already connected message */
export function alreadyConnectedMessage(taskUrl: string): string {
  return (
    `✅ <b>الجلسة نشطة!</b>\n\n` +
    `🔗 المهمة: <a href="${esc(taskUrl)}">${esc(taskUrl)}</a>\n\n` +
    `💬 أرسل رسالتك مباشرة، أو /reset لإعادة الضبط.`
  );
}

/** Help message */
export function helpMessage(): string {
  return (
    '📖 <b>الأوامر المتاحة:</b>\n\n' +
    '/start — بدء الجلسة أو عرض الحالة\n' +
    '/status — عرض الحالة الحالية\n' +
    '/reset — إعادة ضبط الجلسة\n' +
    '/help — عرض هذه المساعدة\n\n' +
    '💡 <b>طريقة الاستخدام:</b>\n' +
    '1. أرسل /start\n' +
    '2. أدخل بريدك الإلكتروني على Maton\n' +
    '3. أرسل رابط التأكيد من بريدك\n' +
    '4. أرسل رابط المهمة من Maton\n' +
    '5. تحدث مع Claude Code مباشرة! 🚀'
  );
}
