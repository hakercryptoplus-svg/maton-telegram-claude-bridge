import { chromium, BrowserContext, Page } from 'playwright';

export class MatonBrowser {
  private context?: BrowserContext;
  private page?: Page;

  constructor(private readonly dataDir: string) {}

  async start() {
    this.context = await chromium.launchPersistentContext(this.dataDir, {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      viewport: { width: 1280, height: 900 },
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto('https://www.maton.ai/', { waitUntil: 'domcontentloaded' });
  }

  private get activePage(): Page {
    if (!this.page) throw new Error('Browser is not started');
    return this.page;
  }

  async openLogin() {
    await this.activePage.goto('https://www.maton.ai/login', { waitUntil: 'domcontentloaded' });
    await this.activePage.getByRole('button', { name: 'Continue', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
  }

  async submitEmail(email: string) {
    await this.activePage.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 15000 });
    await this.activePage.locator('input[type="email"]').fill(email);
    await this.activePage.getByRole('button', { name: 'Continue', exact: true }).click();
    await this.activePage.waitForTimeout(1000);
  }

  async openConfirmationUrl(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.maton.ai' && parsed.hostname !== 'maton.ai' && !parsed.hostname.endsWith('.awstrack.me')) {
      throw new Error('Only Maton confirmation links are allowed');
    }
    await this.activePage.goto(url, { waitUntil: 'domcontentloaded' });
    const continueButton = this.activePage.getByRole('link', { name: /continue to sign in/i });
    if (await continueButton.count()) {
      await continueButton.click();
    }
    await this.activePage.waitForTimeout(1500);
  }

  async openTask(taskUrl: string) {
    const parsed = new URL(taskUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.maton.ai' || !parsed.pathname.startsWith('/tasks/')) {
      throw new Error('Only https://www.maton.ai/tasks/... URLs are allowed');
    }
    await this.activePage.goto(taskUrl, { waitUntil: 'domcontentloaded' });
    await this.activePage.locator('textarea[placeholder="Ask Claude Code to perform a task..."]').waitFor({ state: 'visible', timeout: 30000 });
  }

  async sendTaskMessage(message: string, onUpdate: (text: string) => Promise<void>) {
    const page = this.activePage;
    const composer = page.locator('textarea[placeholder="Ask Claude Code to perform a task..."]');
    await composer.waitFor({ state: 'visible', timeout: 30000 }).catch(() => { throw new Error('Task composer was not found after waiting 30 seconds'); });

    const readConversation = async () => (await page.locator('main').innerText().catch(() => page.locator('body').innerText())).trim();
    const before = await readConversation();
    await composer.fill(message);
    await composer.press('Enter');

    let previous = before;
    let stableTicks = 0;
    let sawNewContent = false;
    for (let i = 0; i < 180; i++) {
      await page.waitForTimeout(1000);
      const current = await readConversation();
      if (!current || current === previous) {
        if (sawNewContent) stableTicks++;
        if (sawNewContent && stableTicks >= 5) break;
        continue;
      }
      stableTicks = 0;
      const common = Math.min(previous.length, current.length);
      let prefix = 0;
      while (prefix < common && previous[prefix] === current[prefix]) prefix++;
      const delta = current.slice(prefix).trim();
      previous = current;
      if (delta) {
        sawNewContent = true;
        await onUpdate(delta.slice(-3500));
      }
    }
  }

  async close() {
    await this.context?.close();
  }
}
