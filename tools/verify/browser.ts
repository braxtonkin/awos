import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type Page, type Request } from 'playwright-core';

export type Theme = 'light' | 'dark';

export type Step = { readonly click: string } | { readonly fill: string; readonly text: string } | { readonly press: string } | { readonly waitFor: string };

export type Served = { readonly origin: string; readonly read: (path: string) => Promise<Buffer | undefined> };

export type View = {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly steps: readonly Step[];
  readonly served?: Served;
  readonly scripts?: boolean;
};

export type Opened = {
  readonly page: Page;
  readonly errors: readonly string[];
};

export type Script<W, A, R> = (window: W, argument: A) => R;

export async function withBrowser<T>(work: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    return await work(browser);
  } finally {
    await browser.close();
  }
}

async function serve(page: Page, served: Served): Promise<void> {
  await page.route(`${served.origin}/**`, async route => {
    const body = await served.read(new URL(route.request().url()).pathname.slice(1));
    await (body === undefined ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, body, contentType: contentType(route.request().url()) }));
  });
}

const contentTypes: Readonly<Record<string, string>> = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', woff2: 'font/woff2', png: 'image/png', webm: 'video/webm', json: 'application/json' };

const contentType = (url: string): string => contentTypes[new URL(url).pathname.split('.').pop() ?? ''] ?? 'application/octet-stream';

const pageReads: ReadonlySet<string> = new Set(['fetch', 'eventsource']);

const cancelledByThePage = (request: Request): boolean => pageReads.has(request.resourceType()) && request.failure()?.errorText === 'net::ERR_ABORTED';

async function runStep(page: Page, step: Step): Promise<void> {
  if ('click' in step) await page.locator(step.click).click();
  else if ('fill' in step) await page.locator(step.fill).fill(step.text);
  else if ('press' in step) await page.keyboard.press(step.press);
  else await page.locator(step.waitFor).waitFor();
}

export async function open<T>(browser: Browser, view: View, work: (opened: Opened) => Promise<T>, video?: string): Promise<T> {
  const size = { width: view.width, height: view.height };
  if (video !== undefined) await mkdir(video, { recursive: true });
  const context = await browser.newContext({ viewport: size, colorScheme: view.theme, deviceScaleFactor: 1, reducedMotion: 'reduce', javaScriptEnabled: view.scripts ?? true, ...(video === undefined ? {} : { recordVideo: { dir: video, size } }) });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => {
      if (!cancelledByThePage(request)) errors.push(`${request.method()} ${request.url()} ${request.resourceType()} failed to load: ${request.failure()?.errorText ?? 'no reason given'}`);
    });
    if (view.served !== undefined) await serve(page, view.served);
    await page.goto(view.url, { waitUntil: 'load' });
    for (const step of view.steps) await runStep(page, step);
    return await work({ page, errors });
  } finally {
    await context.close();
  }
}

export const run = <W, A, R>(page: Page, script: Script<W, A, R>, argument: A): Promise<unknown> => page.evaluate(`(${script.toString()})(window, ${JSON.stringify(argument)})`);

export const shoot = (page: Page, path: string): Promise<Buffer> => page.screenshot({ path, animations: 'disabled', caret: 'hide' });

export async function recording<T>(browser: Browser, view: View, file: string, work: (opened: Opened) => Promise<T>): Promise<T> {
  let saved: Promise<string> | undefined;
  const result = await open(
    browser,
    view,
    async opened => {
      const done = await work(opened);
      saved = opened.page.video()?.path();
      return done;
    },
    dirname(file),
  );
  if (saved === undefined) throw new Error('the page recorded no video');
  await rename(await saved, file);
  return result;
}

export const record = (browser: Browser, view: View, seconds: number, file: string): Promise<void> => recording(browser, view, file, ({ page }) => page.waitForTimeout(seconds * 1000));
