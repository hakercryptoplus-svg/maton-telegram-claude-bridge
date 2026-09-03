type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const ICONS: Record<Level, string> = { debug: '🔍', info: 'ℹ️ ', warn: '⚠️ ', error: '🔴' };

const minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function log(level: Level, message: string, context?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const icon = ICONS[level];
  const ctx = context ? ' ' + JSON.stringify(context) : '';
  console[level === 'debug' ? 'log' : level](`${ts} ${icon} [${level.toUpperCase()}] ${message}${ctx}`);
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
};
