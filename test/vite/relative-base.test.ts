// @vitest-environment node
// A relative `base` (`./`): image URLs relative to the page that names them (`../assets/…` from
// `blog/post.html`) and to the stylesheet, as Vite writes its own. Chromium loads them from a
// subfolder of the server, as a site deployed under an unknown path.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as http } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium } from '../browser.js';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-relative-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(async () => {
  mkdirSync(join(root, 'blog'));
  mkdirSync(join(root, 'img'));
  const w = 1200, h = 800, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(join(root, 'img/photo.jpg'));
  writeFileSync(join(root, 'style.css'), '.hero { background: url(./img/photo.jpg) center / cover; height: 200px }\n');
  // a binding that renders before data: the page gets an early file and the render-blocking paint script
  const page = (img: string, css: string) => `<!doctype html><html><head><link rel="stylesheet" href="${css}"></head><body><div class="hero"></div><img src="${img}" alt="Photo"><div data-sn-state="{ n: 'early' }"><input data-sn-model="n" data-sn-persist="n"><p data-sn-text="n"></p></div></body></html>`;
  writeFileSync(join(root, 'index.html'), page('./img/photo.jpg', './style.css'));
  writeFileSync(join(root, 'blog/post.html'), page('../img/photo.jpg', '../style.css'));
});

test('a relative base: every image URL resolves from its page or stylesheet', async () => {
  const out = join(root, 'dist');
  await build({
    root, base: './', logLevel: 'silent', resolve: { alias }, plugins: [sinter()],
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html'), post: join(root, 'blog/post.html') } } },
  });
  const urls = (text: string) => [...text.matchAll(/(?:src|srcset)="([^"]+)"|url\("?([^")]+)"?\)/g)].flatMap((m) => (m[1] ?? m[2])!.split(', ').map((c) => c.split(' ')[0]!)).filter((u) => /\.(avif|webp|jpg|png)$/.test(u));
  const html = readFileSync(join(out, 'index.html'), 'utf8'), post = readFileSync(join(out, 'blog/post/index.html'), 'utf8');
  expect(html).toMatch(/<img src="\.\/assets\/photo-1200-[\w-]+\.jpg"/);
  // the post is a directory's index (blog/post/index.html): one folder deeper
  expect(post).toMatch(/<img src="\.\.\/\.\.\/assets\/photo-1200-[\w-]+\.jpg"/);
  // sinter's own scripts too, and the page bundle is async
  expect(post).toMatch(/<script src="\.\.\/\.\.\/assets\/sinter-head-[\w-]+\.js"><\/script>\s*<script src="\.\.\/\.\.\/assets\/blog-post-head-[\w-]+\.js"><\/script>/);
  expect(post).toMatch(/<script type="module" crossorigin src="\.\.\/\.\.\/assets\/post-[\w-]+\.js" async>/);
  for (const [file, text] of [['index.html', html], ['blog/post/index.html', post]] as const) {
    const list = urls(text);
    expect(list.length).toBeGreaterThan(2);
    for (const u of list) expect(existsSync(resolve(dirname(join(out, file)), u)), `${file}: ${u}`).toBe(true);
  }
  for (const f of readdirSync(join(out, 'assets')).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(out, 'assets', f), 'utf8');
    if (css.includes('.hero')) expect(css).toContain('image-set(');
    for (const u of urls(css.replace(/\[src="[^"]*"\]/g, ''))) expect(existsSync(resolve(join(out, 'assets'), u)), `${f}: ${u}`).toBe(true);
  }
  if (!chromium) return;
  // the site under /site/, a path the build did not know
  const server = http((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/site\//, '/');
    try {
      const body = readFileSync(join(out, path.endsWith('/') ? path + 'index.html' : path));
      res.setHeader('Content-Type', { html: 'text/html', css: 'text/css', js: 'text/javascript', avif: 'image/avif', jpg: 'image/jpeg' }[path.endsWith('/') ? 'html' : path.split('.').pop()!] ?? 'application/octet-stream');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    await tab.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/site/blog/post/`);
    await tab.waitForFunction(() => { const i = document.querySelector('img')!; return i.complete; });
    const r = await tab.evaluate(() => ({
      img: document.querySelector('img')!.naturalWidth,
      failed: performance.getEntriesByType('resource').filter((e) => (e as PerformanceResourceTiming).responseStatus >= 400).map((e) => e.name),
      loaded: performance.getEntriesByType('resource').map((e) => e.name.slice(e.name.lastIndexOf('/') + 1)),
    }));
    expect(r.img).toBeGreaterThan(0);
    expect(r.loaded.some((n) => /^blog-post-head-[\w-]+\.js$/.test(n)), r.loaded.join(', ')).toBe(true);
    expect(await tab.evaluate(() => document.querySelector('p')!.textContent)).toBe('early');
    expect(r.failed).toEqual([]);
    expect(r.loaded.some((n) => /^photo-1200-[\w-]+\.avif$/.test(n))).toBe(true);
  } finally {
    await browser.close();
    server.close();
  }
}, 60_000);
