// @vitest-environment node
// The built head asks for the stylesheets before the page's modules: Vite writes the entry script, its modulepreloads,
// then the stylesheets; the build's post HTML step moves those stylesheets to just before the entry script (after
// the early head scripts). A server sends in the order it is asked, over HTTP/2 from one large send buffer, so a
// stylesheet asked for last arrives after every module (docs/first-paint.md).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter, { stylesheetsFirst } from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];

describe('stylesheetsFirst', () => {
  const entry = '<script type="module" crossorigin src="/assets/index-a.js"';
  const page = (head: string) => `<!doctype html><html><head>\n  <meta charset="utf-8">\n  ${head}\n</head><body><link rel="stylesheet" href="/body.css"></body></html>`;
  const order = (html: string) => [...html.slice(0, html.indexOf('</head>')).matchAll(/<(link|script|noscript|template)\b[^>]*?(?:href|src|id)="([^"]+)"|<(noscript|template)\b/g)].map((m) => m[2] ?? m[3]);

  test('several stylesheets move before the entry script, in their order, with their attributes; nothing else moves', () => {
    const html = page(`<script src="/assets/sinter-head-x.js"></script>
  <script type="module" crossorigin src="/assets/index-a.js" async></script>
  <link rel="modulepreload" crossorigin href="/assets/app-b.js">
  <link rel="stylesheet" crossorigin href="/assets/a.css">
  <link rel="stylesheet" crossorigin href="/assets/b.css" media="print" data-x="1">
  <link rel="modulepreload" crossorigin fetchpriority="low" href="/assets/later-c.js">`);
    const out = stylesheetsFirst(html, entry);
    expect(order(out)).toEqual(['/assets/sinter-head-x.js', '/assets/a.css', '/assets/b.css', '/assets/index-a.js', '/assets/app-b.js', '/assets/later-c.js']);
    expect(out).toContain('<link rel="stylesheet" crossorigin href="/assets/b.css" media="print" data-x="1">');
    // the same tags, only reordered; the body is not touched
    expect(out.length).toBe(html.length);
    expect(out).toContain('<body><link rel="stylesheet" href="/body.css"></body>');
  });

  test('no stylesheet after the script, or no entry script: unchanged', () => {
    const none = page(`<script type="module" crossorigin src="/assets/index-a.js" async></script>\n  <link rel="modulepreload" crossorigin href="/assets/app-b.js">`);
    expect(stylesheetsFirst(none, entry)).toBe(none);
    const noEntry = page(`<link rel="modulepreload" crossorigin href="/assets/app-b.js">\n  <link rel="stylesheet" href="/assets/a.css">`);
    expect(stylesheetsFirst(noEntry, entry)).toBe(noEntry);
  });

  test('a stylesheet written before the scripts stays; one in a <noscript> or <template> is not moved', () => {
    const html = page(`<link rel="stylesheet" href="https://cdn.example/hand.css">
  <script type="module" crossorigin src="/assets/index-a.js" async></script>
  <link rel="modulepreload" crossorigin href="/assets/app-b.js">
  <link rel="stylesheet" crossorigin href="/assets/a.css">
  <noscript><link rel="stylesheet" href="/assets/fonts-later.css"></noscript>
  <template id="sn-t-1"><link rel="stylesheet" href="/in-template.css"></template>`);
    const out = stylesheetsFirst(html, entry);
    expect(order(out)).toEqual(['https://cdn.example/hand.css', '/assets/a.css', '/assets/index-a.js', '/assets/app-b.js', 'noscript', '/assets/fonts-later.css', 'sn-t-1', '/in-template.css']);
  });
});

describe('in a build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-css-first-'));
  const root = join(dir, 'app');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeAll(async () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    // two pages share the helpers module (a modulepreload), which imports a stylesheet (Vite writes it last)
    const page = (title: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="https://cdn.example/hand.css"></head>
<body><p data-sn-text="up($url.q ?? '${title}')"></p></body></html>
`;
    writeFileSync(join(root, 'index.html'), page('index'));
    writeFileSync(join(root, 'about.html'), page('about'));
    writeFileSync(join(root, 'src', 'app.css'), 'p { color: teal }\n');
    writeFileSync(join(root, 'src', 'sinter.helpers.js'), "import './app.css';\nexport const up = (s) => String(s).toUpperCase();\n");
    const opts = (outDir: string, firstPaint: boolean) => ({
      root, logLevel: 'silent' as const, resolve: { alias }, plugins: [sinter({ firstPaint, fonts: false })],
      build: { outDir, emptyOutDir: true, minify: false, rollupOptions: { input: { index: join(root, 'index.html'), about: join(root, 'about.html') } } },
    });
    await build(opts(join(dir, 'on'), true));
    await build(opts(join(dir, 'off'), false));
  }, 120_000);

  const head = (variant: string) => { const html = readFileSync(join(dir, variant, 'index.html'), 'utf8'); return html.slice(0, html.indexOf('</head>')); };
  const at = (h: string, re: RegExp) => h.search(re);

  test.each(['on', 'off'])('firstPaint %s: the built stylesheets come before the entry script and its modulepreloads', (variant) => {
    const h = head(variant);
    const css = at(h, /<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/);
    expect(css).toBeGreaterThan(0);
    expect(css).toBeLessThan(at(h, /<script type="module"/));
    expect(css).toBeLessThan(at(h, /<link rel="modulepreload"/));
    // no built stylesheet is left after the entry script
    expect(h.slice(at(h, /<script type="module"/))).not.toMatch(/<link rel="stylesheet" crossorigin href="\/assets\//);
    // the stylesheet written into the page stays before everything the build added
    expect(at(h, /href="https:\/\/cdn\.example\/hand\.css"/)).toBeLessThan(css);
  });

  test('firstPaint on: the early head scripts still come first, before every stylesheet', () => {
    const h = head('on');
    const early = at(h, /<script src="\/assets\/sinter-head-/);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(at(h, /<link rel="stylesheet"/));
    expect(at(h, /<script src="\/assets\/index-head-/)).toBeLessThan(at(h, /<link rel="stylesheet" crossorigin href="\/assets\//));
  });
});
