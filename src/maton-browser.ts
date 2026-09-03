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

    // Read the assistant's last message directly
    const readLastAssistantMessage = async () => {
      try {
        // Try multiple selectors to find Claude's response
        const selectors = [
          '[data-role="assistant"]:last-of-type',
          '[data-sender="assistant"]:last-of-type',
          '.message.assistant:last-of-type',
          '[class*="assistant"]:last-of-type',
          'main > div:last-of-type',
        ];

        for (const selector of selectors) {
          const el = page.locator(selector);
          if ((await el.count()) > 0) {
            const text = await el.innerText();
            if (text.trim()) return text.trim();
          }
        }

        // Fallback: read main content area
        const main = await page.locator('main').innerText().catch(() => '');
        return main.trim();
      } catch (e) {
        logger.error('Failed to read assistant message', { error: String(e) });
        return '';
      }
    };

    logger.info('Sending message and polling for response');
    await composer.fill(message);
    await composer.press('Enter');
    await page.waitForTimeout(2000); // Wait for message to be sent

    let previousResponse = '';
    let stableTicks = 0;
    let sawNewContent = false;
    const MAX_TICKS = 180; // 3 minutes max

    for (let i = 0; i < MAX_TICKS; i++) {
      await page.waitForTimeout(1000);
      const currentResponse = await readLastAssistantMessage();

      if (!currentResponse || currentResponse === previousResponse) {
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
      previousResponse = currentResponse;
      sawNewContent = true;

      logger.info('Response update', { length: currentResponse.length, preview: currentResponse.slice(0, 100) });
      await onUpdate(currentResponse);
    }

    if (!sawNewContent) {
      logger.warn('No response detected after sending message');
    }
  }

  async close(): Promise<void> {
    logger.info('Closing browser');
    await this.context?.close();
  }
}

/**
 * Extract new content appended to `current` compared to `previous`.
 * Tries multiple strategies to find what was genuinely added.
 */
function extractNewContent(previous: string, current: string): string {
  if (current.length <= previous.length) return '';

  // Fast path: if current starts with previous exactly, return the suffix
  if (current.startsWith(previous)) {
    return current.slice(previous.length).trim();
  }

  // Try to find where previous ends in current
  // Check last 1000 chars of previous to find a match
  const searchLength = Math.min(previous.length, 1000);
  const searchText = previous.slice(-searchLength);

  const idx = current.indexOf(searchText);
  if (idx !== -1) {
    const newContent = current.slice(idx + searchLength).trim();
    if (newContent) return newContent;
  }

  // Fallback: try with smaller chunks
  for (let len of [500, 300, 150, 80]) {
    if (previous.length < len) continue;
    const chunk = previous.slice(-len);
    const pos = current.indexOf(chunk);
    if (pos !== -1) {
      const newContent = current.slice(pos + len).trim();
      if (newContent && newContent.length > 10) return newContent;
    }
  }

  // Last resort: if current is significantly longer, assume most of it is new
  if (current.length > previous.length * 1.3) {
    // Take everything after a reasonable overlap estimate
    const overlap = Math.floor(previous.length * 0.7);
    return current.slice(overlap).trim();
  }

  return '';
}
