import { chromium, BrowserContext, Page } from 'playwright';
import { logger } from './logger.js';
import type { UpdateCallback } from './types.js';

const MATON_ORIGINS = new Set(['https://www.maton.ai', 'https://maton.ai']);
const CONFIRM_ORIGINS = new Set(['https://www.maton.ai', 'https://maton.ai']);
// AWS tracking links redirect back to maton
const CONFIRM_HOSTNAME_SUFFIX = '.awstrack.me';

function isSafeMaton(hostname: string): boolean {
  return MATON_ORIGINS.has(`https://${hostname}`) || hostname.endsWith(CONFIRM_HOSTNAME_SUFFIX);
}

export class MatonBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private taskUrl?: string;

  constructor(private readonly dataDir: string) {}

  async start(): Promise<void> {
    logger.info('Starting browser', { dataDir: this.dataDir });
    this.context = await chromium.launchPersistentContext(this.dataDir, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox'],
      viewport: { width: 1280, height: 900 },
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto('https://www.maton.ai/', { waitUntil: 'domcontentloaded' });
    logger.info('Browser started');
  }

  private get activePage(): Page {
    if (!this.page) throw new Error('Browser is not started');
    return this.page;
  }

  async openLogin(): Promise<void> {
    logger.info('Opening login page');
    await this.activePage.goto('https://www.maton.ai/login', { waitUntil: 'domcontentloaded' });
    await this.activePage.getByRole('button', { name: 'Continue', exact: true }).waitFor({
      state: 'visible',
      timeout: 15_000,
    });
  }

  async submitEmail(email: string): Promise<void> {
    logger.info('Submitting email');
    const input = this.activePage.locator('input[type="email"]');
    await input.waitFor({ state: 'visible', timeout: 15_000 });
    await input.fill(email);
    await this.activePage.getByRole('button', { name: 'Continue', exact: true }).click();
    // Wait for form submission
    await this.activePage.waitForTimeout(1000);
  }

  async openConfirmationUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !isSafeMaton(parsed.hostname)) {
      throw new Error('Only Maton confirmation links are allowed');
    }
    logger.info('Opening confirmation URL', { host: parsed.hostname });
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded' });
    const continueBtn = this.activePage.getByRole('link', { name: /continue to sign in/i });
    if ((await continueBtn.count()) > 0) {
      await continueBtn.click();
    }
    await this.activePage.waitForTimeout(1500);
  }

  async openTask(taskUrl: string): Promise<void> {
    const parsed = new URL(taskUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.maton.ai' || !parsed.pathname.startsWith('/tasks/')) {
      throw new Error('Only https://www.maton.ai/tasks/... URLs are allowed');
    }
    logger.info('Opening task', { taskUrl });
    this.taskUrl = taskUrl;
    await this.activePage.goto(taskUrl, { waitUntil: 'domcontentloaded' });
    await this.activePage.waitForTimeout(1500);
  }

  private async findComposer(): Promise<ReturnType<Page['locator']>> {
    const page = this.activePage;
    // Combined selector — Playwright evaluates all at once and .last() picks the
    // bottom-most visible match, which is typically the active input on the page.
    const combined = [
      '[data-testid="task-composer"] textarea',
      '[data-testid="message-input"]',
      'form textarea',
      'textarea[placeholder]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
    ].join(', ');
    const composer = page.locator(combined).last();
    await composer.waitFor({ state: 'visible', timeout: 15_000 });
    return composer;
  }

  async sendTaskMessage(message: string, onUpdate: UpdateCallback): Promise<void> {
    const page = this.activePage;

    let composer: ReturnType<Page['locator']>;
    try {
      composer = await this.findComposer();
    } catch {
      logger.warn('Composer not found, reloading task page');
      if (this.taskUrl) {
        await page.goto(this.taskUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
      }
      composer = await this.findComposer();
    }

    // Read conversation area only (more reliable than full page)
    const readConversation = async () => {
      try {
        // Try multiple selectors for the conversation/chat area
        const selectors = [
          '[data-testid="conversation"]',
          '[data-testid="messages"]',
          'main [role="log"]',
          'main',
        ];
        for (const selector of selectors) {
          const el = page.locator(selector).first();
          if ((await el.count()) > 0) {
            return (await el.innerText()).trim();
          }
        }
        return (await page.locator('body').innerText()).trim();
      } catch {
        return '';
      }
    };

    const beforeText = await readConversation();
    await composer.fill(message);
    await composer.press('Enter');
    logger.info('Message sent, polling for response');

    let previous = beforeText;
    let stableTicks = 0;
    let sawNewContent = false;
    const MAX_TICKS = 180; // 3 minutes max

    for (let i = 0; i < MAX_TICKS; i++) {
      await page.waitForTimeout(1000);
      const current = await readConversation();

      if (!current || current === previous) {
        if (sawNewContent) {
          stableTicks++;
          if (stableTicks >= 4) {
            logger.info('Response stabilized, done polling');
            break;
          }
        }
        continue;
      }

      stableTicks = 0;

      // Extract only the new content added since last tick
      const newContent = extractNewContent(previous, current);
      previous = current;

      if (newContent) {
        sawNewContent = true;
        logger.debug('New content chunk', { length: newContent.length });
        await onUpdate(newContent);
      }
    }

    if (!sawNewContent) {
      logger.warn('No new content detected after sending message');
    }
  }

  async close(): Promise<void> {
    logger.info('Closing browser');
    await this.context?.close();
  }
}

/**
 * Extract new content appended to `current` compared to `previous`.
 * Uses suffix matching to find only what was genuinely added.
 */
function extractNewContent(previous: string, current: string): string {
  if (current.length <= previous.length) return '';

  // Fast path: if current starts with previous exactly, return the suffix
  if (current.startsWith(previous)) {
    return current.slice(previous.length).trim();
  }

  // Otherwise try to find longest common suffix of previous that's a prefix of current
  // This handles cases where timestamps or UI elements changed in the middle
  const maxCheck = Math.min(previous.length, 500); // Check last 500 chars of previous
  for (let len = maxCheck; len > 50; len--) {
    const suffix = previous.slice(-len);
    const idx = current.indexOf(suffix);
    if (idx !== -1) {
      // Found common part, return everything after it
      const newPart = current.slice(idx + len).trim();
      if (newPart) return newPart;
    }
  }

  // Fallback: if nothing matches well, assume it's all new (but skip duplicating previous)
  // This handles edge cases where the page structure changed significantly
  if (current.length > previous.length * 1.5) {
    return current.slice(previous.length).trim();
  }

  return '';
}
