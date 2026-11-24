// @vitest-environment node
// Vite's HTML step skipped for pages it does not change (src/html-step.ts, src/vite.ts `sinter:html-in`/`-out`): such a
// page is kept before the step, Vite parses a stand-in, and the page is put back inside the step, so what follows sees
// what Vite would have written. Every file must be the same as with every page through the step (`SN_HTML_SKIP=0`), and
// an app with another plugin's HTML hook keeps every page in the step.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { build, createLogger, type Plugin } from 'vite';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import sinter from '../../src/vite.js';
import { viteStepNeeded } from '../../src/html-step.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-html-step-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => { delete process.env.SN_HTML_SKIP; delete process.env.SN_HTML_LOG; });
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

describe('the pages Vite\'s step would change, and those it would not', () => {
  const page = (head: string, body = '<p>x</p>') => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>t</title>${head}</head><body>${body}</body></html>`;
  test('not changed: a static page, its canonical link, its Speculation Rules, links to other pages and origins', () => {
    expect(viteStepNeeded(page('<link rel="canonical" href="https://example.com/a"><script type="speculationrules">{"prefetch":[{"where":{"href_matches":["/(a|b)\\\\?*#*"]}}]}</script>', '<a href="/b/">b</a> 50% of 60%'))).toBe(false);
    expect(viteStepNeeded(page('<link rel="preconnect" href="//fonts.gstatic.com" crossorigin><link rel="icon" href="data:,"><meta name="description" content="/x.png">'))).toBe(false);
  });
  test.each([
    ['an env value', page('', '<p>%MODE%</p>')],
    ['a placeholder of Vite\'s', page('', '<p>__VITE_ASSET__abc__</p>')],
    ['vite-ignore', page('', '<p vite-ignore>x</p>')],
    ['a module script', page('<script type="module" src="/src/a.ts"></script>')],
    ['an inline classic script', page('<script>console.log(1)</script>')],
    ['a script with a src', page('<script src="/a.js"></script>')],
    ['JSON data', page('<script type="application/json">{}</script>')],
    ['the rules with an import', page('<script type="speculationrules">{"x":"import(1)"}</script>')],
    ['an import map', page('<script type="importmap">{}</script>')],
    ['a script the pattern does not read whole', page('<script type="speculationrules">{}')],
    ['a stylesheet', page('<link rel="stylesheet" href="/src/a.css">')],
    ['an icon from the public folder', page('<link rel="icon" href="/favicon.svg">')],
    ['a relative link href', page('<link rel="manifest" href="manifest.json">')],
    ['an imagesrcset', page('<link rel="preload" as="image" href="https://x.test/a.png" imagesrcset="a.png 1x">')],
    ['a <style>', page('<style>p{color:red}</style>')],
    ['a style with url()', page('', '<p style="background: url(/a.png)">x</p>')],
    ['image-set()', page('', '<p style="background-image: image-set(\'a.png\' 1x)">x</p>')],
    ['an image', page('', '<img src="/a.png" alt="">')],
    ['an image, upper case', page('', '<IMG SRC="/a.png" alt="">')],
    ['a video', page('', '<video poster="/a.png"></video>')],
    ['a source', page('', '<picture><source srcset="/a.avif"></picture>')],
    ['an svg use', page('', '<svg><use href="/icons.svg#a"></use></svg>')],
    ['an object', page('', '<object data="/a.pdf"></object>')],
    ['an og:image', page('<meta property="og:image" content="/a.png">')],
    ['a twitter:image', page('<meta name="twitter:image" content="/a.png">')],
    ['a link with a quoted >', page('<link title="a>b" href="/a.css" rel="stylesheet">')],
  ])('changed or in doubt: %s', (_, html) => { expect(viteStepNeeded(html)).toBe(true); });
});

/** an app with a page of each kind; built with the skip and without, every file and log line */
async function both(plugins: Plugin[] = []) {
  const root = join(tmp, `app-${Math.random().toString(36).slice(2)}`);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
  put('src/sinter.helpers.ts', 'export const up = (s: string) => s.toUpperCase();\n');
  put('public/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  put('src/a.css', 'p { color: red }\n');
  put('src/a.png', 'png');
  put('index.html', page('home', '<h1 data-sn-text="up(\'home\')"></h1><a href="/about/">about</a> 50% of it'));
  put('about.html', page('about', '<p>plain</p><a href="https://example.org/">out</a>'));
  put('styled.html', page('styled', '<p>s</p>', '<link rel="stylesheet" href="/src/a.css"><link rel="icon" href="/favicon.svg">'));
  put('image.html', page('image', '<p style="background: url(/src/a.png)">i</p>'));
  put('live.html', page('live', '<p data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></p>'));
  put('env.html', page('env', '<p>%MODE% %BASE_URL%</p>'));
  const input = ['index.html', 'about.html', 'styled.html', 'image.html', 'live.html', 'env.html'];
  const out: Record<string, { files: Record<string, string>; lines: string[]; said: string[] }> = {};
  for (const k of ['0', '1']) {
    process.env.SN_HTML_SKIP = k;
    process.env.SN_HTML_LOG = '1';
    const said: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { said.push(String(m)); });
    const lines: string[] = [], logger = createLogger('info');
    const dist = join(root, `dist-${k}`);
    for (const l of ['info', 'warn', 'warnOnce', 'error'] as const) logger[l] = (m: string) => { lines.push(`${l} ${m.replaceAll(relative(root, dist), 'OUT').replace(/\d+(\.\d+)? ?m?s\b/g, 'T')}`); };
    try {
      await build({ root, customLogger: logger, resolve: { alias }, plugins: [sinter(), ...plugins], build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: input.map((f) => join(root, f)) } } });
    } finally { spy.mockRestore(); }
    out[k] = { files: Object.fromEntries(walk(dist).map((f) => [relative(dist, f), readFileSync(f, 'utf8')])), lines: lines.sort(), said: said.filter((l) => l.startsWith('sinter html:')) };
  }
  return out;
}

test('pages of every kind: the same files and log lines with the step skipped where it changes nothing', async () => {
  const r = await both();
  expect(r['1']!.files).toEqual(r['0']!.files);
  expect(r['1']!.lines).toEqual(r['0']!.lines);
  // the home page (a helper folded) and the plain page skip it; the stylesheet, the url(), the live page and %MODE% do not
  expect(r['1']!.said).toEqual(['sinter html: 2 pages kept out of Vite\'s HTML step, 4 through it']);
  expect(r['0']!.said).toEqual(['sinter html: 0 pages kept out of Vite\'s HTML step, 6 through it (off for this app)']);
  // what the step did to the others is there: the stylesheet bundled, the env value written
  expect(r['1']!.files['styled/index.html']).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/);
  expect(r['1']!.files['env/index.html']).toContain('<p>production /</p>');
}, 120_000);

test('another plugin with an HTML hook: every page through Vite\'s step, and the hook sees every page', async () => {
  const seen = new Map<string, string>();
  const other: Plugin = { name: 'app-html', transformIndexHtml: { order: 'post', handler(html, ctx) { seen.set(relative(tmp, ctx.filename), html); return html.replace('</body>', '<!--app--></body>'); } } };
  const r = await both([other]);
  expect(r['1']!.said).toEqual(['sinter html: 0 pages kept out of Vite\'s HTML step, 6 through it (off for this app)']);
  expect(r['1']!.files).toEqual(r['0']!.files);
  expect(r['1']!.files['about/index.html']).toContain('<p>plain</p><a href="https://example.org/">out</a><!--app--></body>');
  for (const [f, html] of seen) expect(html, f).toMatch(/<title>/);
}, 120_000);
