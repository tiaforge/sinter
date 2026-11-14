// @vitest-environment node
// Reserved space through the Vite plugin (docs/first-paint.md#reserved-space): the stylesheets of the
// page's layout are read, a local font's metrics give `line-height: normal`, the placeholder's rule is
// in the page's stylesheet, and in Chromium the rows arrive without moving what follows the list.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-reserve-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

/** a font file with only the tables the metrics come from: unitsPerEm 1000, ascender 1000, descender -250 (`normal` is 1.25) */
function font(): Buffer {
  const head = Buffer.alloc(54), hhea = Buffer.alloc(36);
  head.writeUInt32BE(0x5f0f3cf5, 12); head.writeUInt16BE(1000, 18);
  hhea.writeInt16BE(1000, 4); hhea.writeInt16BE(-250, 6);
  const dirLen = 12 + 2 * 16, out = Buffer.alloc(dirLen + 54 + 36);
  out.writeUInt32BE(0x00010000, 0); out.writeUInt16BE(2, 4);
  out.write('head', 12, 'latin1'); out.writeUInt32BE(dirLen, 20); out.writeUInt32BE(54, 24);
  out.write('hhea', 28, 'latin1'); out.writeUInt32BE(dirLen + 54, 36); out.writeUInt32BE(36, 40);
  head.copy(out, dirLen); hhea.copy(out, dirLen + 54);
  return out;
}

const files: Record<string, string | Buffer> = {
  'src/layouts/app-layout.html': `<!doctype html>
<html lang="en" data-sn-layout="{}">
<head><meta charset="utf-8"><title>List</title><link rel="stylesheet" href="../styles/app.css"></head>
<body><main><slot></slot></main><footer id="after">below</footer></body>
</html>
`,
  'src/styles/app.css': `@font-face { font-family: Lined; src: url(../fonts/lined.ttf) format('truetype') }
body { margin: 0 } ul { margin: 0; padding: 0; list-style: none }
.text li { font: 20px Lined, sans-serif; padding: 4px 0 }
.fixed li { height: 48px; border-bottom: 1px solid #ccc; box-sizing: border-box }
`,
  'src/fonts/lined.ttf': font(),
  'index.html': `<app-layout>
  <sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="5"></sn-resource>
  <ul class="text"><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul>
</app-layout>
`,
  'fixed.html': `<app-layout>
  <sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="5"></sn-resource>
  <ul class="fixed"><template data-sn-for="p in people"><li data-sn-text="p.name"></li></template></ul>
</app-layout>
`,
};

beforeAll(async () => {
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  await build({
    root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()],
    build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: { index: join(root, 'index.html'), fixed: join(root, 'fixed.html') } } },
  });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const css = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');

test('the placeholder after the template, its height from the layout\'s stylesheet and the font\'s metrics', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).toMatch(/<\/template><li class="sn-reserve sn-reserve-[\w]+-0" aria-hidden="true" data-sn="\d+"><\/li><\/ul>/);
  // a row: one line of `normal` (1.25 × 20 px, less the pixel engines may round away) and 8 px of padding
  expect(css()).toMatch(/\.sn-reserve\.sn-reserve-[\w]+-0\s*\{[^}]*height:\s*160px\s*!important/);
  // fixed rows: 5 × 48
  expect(css()).toMatch(/\.sn-reserve\.sn-reserve-[\w]+-0\s*\{[^}]*height:\s*240px\s*!important/);
});

test.runIf(!!chromium)('in Chromium: the rows arrive in the space held for them, the footer does not move', async () => {
  let answer: () => void = () => {};
  const site = http((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/api/people') {
      // answered when the test says so: the first paint has the placeholder
      answer = () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ people: [1, 2, 3, 4, 5].map((id) => ({ id, name: `P${id}` })) })); };
      return;
    }
    try {
      const body = readFileSync(join(out, path.endsWith('/') ? path + 'index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const port = await listen(site);
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    await tab.addInitScript(() => { (window as any).__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__cls += (e as any).value; }).observe({ type: 'layout-shift', buffered: true }); });
    await tab.goto(`http://127.0.0.1:${port}/fixed/`);
    await tab.waitForFunction(() => document.querySelector('.sn-reserve') !== null);
    const before = await tab.evaluate(() => document.getElementById('after')!.getBoundingClientRect().top);
    answer();
    await tab.waitForFunction(() => document.querySelectorAll('ul li:not(.sn-reserve)').length === 5);
    await tab.waitForTimeout(200);
    const after = await tab.evaluate(() => document.getElementById('after')!.getBoundingClientRect().top);
    expect(after).toBeCloseTo(before, 0);
    expect(await tab.evaluate(() => document.querySelector('.sn-reserve'))).toBeNull();
    expect(await tab.evaluate(() => (window as any).__cls)).toBeLessThan(0.001);
  } finally { await browser.close(); site.close(); }
}, 60_000);
