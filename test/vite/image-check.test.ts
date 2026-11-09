// @vitest-environment node
// The dev server's image check (src/image-check.ts), in Chromium when Playwright is installed.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { IMAGE_CHECK } from '../../src/image-check.js';
import { chromium } from '../browser.js';


const png = async (w: number) => `data:image/png;base64,${(await sharp({ create: { width: w, height: w, channels: 3, background: '#c03' } }).png().toBuffer()).toString('base64')}`;

describe.skipIf(!chromium)('the dev image check', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  beforeAll(async () => { browser = await chromium!.launch(); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  async function warnings(body: string): Promise<string[]> {
    const tab = await browser.newPage();
    const out: string[] = [];
    tab.on('console', (m) => { if (m.type() === 'warning') out.push(m.text()); });
    // images by URL (`/w20.png` is 20 px square), since data: URLs hold commas a srcset cannot take
    await tab.route('http://t.test/**', (r) => {
      const m = /\/w(\d+)\.png$/.exec(r.request().url());
      if (!m) return void r.fulfill({ body: `<!doctype html><html><body>${body}</body></html>`, contentType: 'text/html' });
      void sharp({ create: { width: Number(m[1]), height: Number(m[1]), channels: 3, background: '#c03' } }).png().toBuffer().then((b) => r.fulfill({ body: b, contentType: 'image/png' }));
    });
    await tab.goto('http://t.test/', { waitUntil: 'load' });
    await tab.addScriptTag({ content: IMAGE_CHECK, type: 'module' });
    await tab.waitForTimeout(300);
    return out;
  }

  test('a source with too few pixels', async () => {
    const w = await warnings(`<img src="${await png(40)}" style="width: 100px" alt="">`);
    expect(w).toEqual([expect.stringMatching(/shown 100 px wide \(100 device px at 1x\) from a file 40 px wide.*Use a larger source, at least 100 px wide/)]);
  });

  test('a sizes smaller than the image is shown', async () => {
    const w = await warnings('<img srcset="/w20.png 20w, /w400.png 400w" sizes="10px" style="width: 100px" alt="">');
    expect(w).toEqual([expect.stringMatching(/from a file 20 px wide.*has a 400 px file: its sizes \("10px"\) is smaller than the image is shown/)]);
  });

  test('enough pixels, and object-fit: cover counts the larger side', async () => {
    expect(await warnings(`<img src="${await png(200)}" style="width: 100px" alt="">`)).toEqual([]);
    const wide = `data:image/png;base64,${(await sharp({ create: { width: 300, height: 100, channels: 3, background: '#036' } }).png().toBuffer()).toString('base64')}`;
    // 300 × 100 covering a 100 × 100 box shows 100 of its 100 rows: scaled to 300 × 100 css px, enough at 1x
    expect(await warnings(`<img src="${wide}" style="width: 100px; height: 100px; object-fit: cover" alt="">`)).toEqual([]);
    expect(await warnings(`<img src="${wide}" style="width: 100px; height: 200px; object-fit: cover" alt="">`)).toEqual([expect.stringMatching(/600 device px/)]);
  });
});
