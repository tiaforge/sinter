// @vitest-environment node
// CSS backgrounds through the Vite plugin (docs/images.md, step 3): a build rewrites the finished
// stylesheets (Sass included), the dev server its compiled CSS; Chromium loads the 1x or 2x file.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as http } from 'node:http';
import sharp from 'sharp';
import { build, createServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-css-images-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(async () => {
  mkdirSync(join(root, 'src/parts'), { recursive: true });
  const w = 1600, h = 900, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(join(root, 'src/hero.jpg'));
  writeFileSync(join(root, 'src/main.js'), "import './app.css';\nimport './more.scss';\n");
  writeFileSync(join(root, 'src/app.css'), '.hero { background: url(./hero.jpg) center / cover; height: 300px }\n.tile { background-image: url("./hero.jpg"); height: 50px }\n');
  // Sass: the url() in a partial, relative to the partial
  writeFileSync(join(root, 'src/parts/_banner.scss'), '.banner { background-image: url(../hero.jpg); background-size: contain; height: 100px }\n');
  writeFileSync(join(root, 'src/more.scss'), "@use 'parts/banner';\n");
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><script type="module" src="/src/main.js"></script></head><body><div class="hero"></div><div class="tile"></div><div class="banner"></div></body></html>');
});

test('build: image-set() in the finished stylesheet, the variants beside it', async () => {
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: out, emptyOutDir: true }, plugins: [sinter()] });
  const files = readdirSync(join(out, 'assets'));
  const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('');
  // sized (cover, contain): 1x and 2x; the tile: 1x only, keeping its intrinsic size
  expect(css).toMatch(/\.hero\{background:url\(\/assets\/hero-[\w-]+\.jpg\) 50%\/cover;background:image-set\(url\("\/assets\/hero-800-[\w-]+\.avif"\) type\("image\/avif"\) 1x,url\("\/assets\/hero-1600-[\w-]+\.avif"\) type\("image\/avif"\) 2x,url\("\/assets\/hero-800-[\w-]+\.jpg"\) type\("image\/jpeg"\) 1x,url\("\/assets\/hero-1600-[\w-]+\.jpg"\) type\("image\/jpeg"\) 2x\) 50%\/cover;/);
  expect(css).toMatch(/\.tile\{background-image:url\(\/assets\/hero-[\w-]+\.jpg\);background-image:image-set\(url\("\/assets\/hero-1600-[\w-]+\.avif"\) type\("image\/avif"\) 1x,url\("\/assets\/hero-1600-[\w-]+\.jpg"\) type\("image\/jpeg"\) 1x\);/);
  expect(css).toMatch(/\.banner\{background-image:url\([^)]+\);background-image:image-set\([^)]*hero-800-[\w-]+\.avif/);
  for (const name of new Set([...css.matchAll(/\/assets\/(hero-\d+-[\w-]+\.(?:avif|jpg))/g)].map((m) => m[1]!))) {
    expect(files).toContain(name);
    expect((await sharp(readFileSync(join(out, 'assets', name))).metadata()).width).toBe(Number(/-(\d+)-/.exec(name)![1]));
  }
  if (!chromium) return;
  // the page from disk, with relative asset paths
  writeFileSync(join(out, 'assets', 'check.css'), css.replace(/\/assets\//g, './'));
  writeFileSync(join(out, 'check.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/check.css"></head><body><div class="hero"></div><div class="tile"></div></body></html>');
  // served over HTTP: Chromium records no resource timing for file: pages
  const files2 = http((req, res) => {
    const f = join(out, decodeURIComponent((req.url ?? '/').split('?')[0]!));
    try { const b = readFileSync(f); res.setHeader('Content-Type', f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html' : f.endsWith('.avif') ? 'image/avif' : 'image/jpeg'); res.end(b); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => files2.listen(0, '127.0.0.1', () => r()));
  const at = `http://127.0.0.1:${(files2.address() as { port: number }).port}`;
  try {
  for (const [dpr, want] of [[1, 'hero-800-'], [2, 'hero-1600-']] as const) {
    const browser = await chromium.launch();
    try {
      const tab = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: dpr });
      await tab.goto(`${at}/check.html`);
      await tab.waitForTimeout(300);
      const loaded = await tab.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name.slice(e.name.lastIndexOf('/') + 1)));
      expect(loaded.some((n) => n.startsWith(want) && n.endsWith('.avif')), `${dpr}x: ${loaded.join(', ')}`).toBe(true);
    } finally {
      await browser.close();
    }
  }
  } finally {
    files2.close();
  }
}, 60_000);

test('dev: the compiled stylesheet names the dev server\'s variants, which it serves', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { port: 0, hmr: false, ws: false }, plugins: [sinter()] });
  try {
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    const res = await fetch(`http://localhost:${port}/src/app.css?direct`, { headers: { accept: 'text/css' } });
    const css = await res.text();
    const url = /url\("(\/@sinter\/img\/hero-800-[\w-]+\.avif)"\)/.exec(css)?.[1];
    expect(url, css).toBeDefined();
    const img = await fetch(`http://localhost:${port}${url}`);
    expect(img.headers.get('content-type')).toBe('image/avif');
    // the Sass partial's url(), rebased by Vite
    expect(await (await fetch(`http://localhost:${port}/src/more.scss?direct`)).text()).toMatch(/image-set\(url\("\/@sinter\/img\/hero-800-/);
  } finally {
    await server.close();
  }
}, 30_000);

