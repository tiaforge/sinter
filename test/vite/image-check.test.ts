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

  async function warnings(body: string, deviceScaleFactor = 1): Promise<string[]> {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor });
    const out: string[] = [];
    tab.on('console', (m) => { if (m.type() === 'warning') out.push(m.text()); });
    // images by URL (`/w20.png` is 20 px square), since data: URLs hold commas a srcset cannot take
    await tab.route('http://t.test/**', (r) => {
      // `/w400.png` is 400 px square, `/w400x100.avif` 400 × 100
      const m = /\/w(\d+)(?:x(\d+))?\.(png|avif)$/.exec(r.request().url());
      if (!m) return void r.fulfill({ body: `<!doctype html><html><body style="margin: 0">${body}</body></html>`, contentType: 'text/html' });
      const img = sharp({ create: { width: Number(m[1]), height: Number(m[2] ?? m[1]), channels: 3, background: '#c03' } });
      void (m[3] === 'avif' ? img.avif() : img.png()).toBuffer().then((b) => r.fulfill({ body: b, contentType: `image/${m[3]}` }));
    });
    await tab.goto('http://t.test/', { waitUntil: 'load' });
    await tab.addScriptTag({ content: IMAGE_CHECK, type: 'module' });
    await tab.waitForTimeout(900);
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

  test('a CSS background drawn larger than its file: cover counts the larger side', async () => {
    // 800 × 400 covering 1200 × 300: scaled by 1.5, drawn 1200 px wide
    const w = await warnings('<div style="width: 1200px; height: 300px; background: url(/w800x400.png) center / cover"></div>');
    expect(w).toEqual([expect.stringMatching(/a background image is drawn 1200 px wide \(1200 device px at 1x\) from a file 800 px wide.*Use a larger source, at least 1200 px wide/)]);
    expect(await warnings('<div style="width: 600px; height: 300px; background: url(/w800x400.png) center / cover"></div>')).toEqual([]);
  });

  test('an image-set(): the option the browser uses, and the 2x rule in the message', async () => {
    const set = "image-set(url(/w400x200.avif) type('image/avif') 1x, url(/w800x400.avif) type('image/avif') 2x, url(/w400x200.png) type('image/png') 1x, url(/w800x400.png) type('image/png') 2x)";
    // 1x: the 400 px file in a 600 px box
    expect(await warnings(`<div style="width: 600px; height: 300px; background-image: ${set}; background-size: cover"></div>`))
      .toEqual([expect.stringMatching(/drawn 600 px wide \(600 device px at 1x\) from a file 400 px wide.*counts a CSS background as a 2x image.*at least 1200 px wide/)]);
    // 2x: the 800 px file, but 1200 device px are needed
    expect(await warnings(`<div style="width: 600px; height: 300px; background-image: ${set}; background-size: cover"></div>`, 2))
      .toEqual([expect.stringMatching(/drawn 600 px wide \(1200 device px at 2x\) from a file 800 px wide/)]);
    // a box that fits: none
    expect(await warnings(`<div style="width: 380px; height: 190px; background-image: ${set}; background-size: cover"></div>`, 2)).toEqual([]);
  });

  test('sizes in px and %, auto (the file at its resolution), gradients and later elements', async () => {
    expect(await warnings('<div style="width: 500px; height: 100px; background: url(/w200.png) 0 0 / 50% auto no-repeat"></div>'))
      .toEqual([expect.stringMatching(/drawn 250 px wide/)]);
    // auto: drawn at the file's own size, enough at 1x, not at 2x
    expect(await warnings('<div style="width: 500px; height: 300px; background: linear-gradient(red, blue), url(/w200.png) no-repeat"></div>')).toEqual([]);
    expect(await warnings('<div style="width: 500px; height: 300px; background: url(/w200.png) no-repeat"></div>', 2)).toEqual([expect.stringMatching(/drawn 200 px wide \(400 device px at 2x\)/)]);
    // an element added after load (a row rendered from data)
    expect(await warnings('<div id="list"></div><script>setTimeout(() => { const d = document.createElement("div"); d.style.cssText = "width: 900px; height: 100px; background: url(/w300.png) 0 0 / cover"; document.getElementById("list").append(d); }, 50)</script>'))
      .toEqual([expect.stringMatching(/drawn 900 px wide/)]);
  });
});
