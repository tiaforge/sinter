// @vitest-environment node
// Static images through the Vite plugin (docs/images.md): a build emits the variants and the
// page's rules; the dev server encodes a variant on its first request.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { build, createServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const root = mkdtempSync(join(tmpdir(), 'sinter-images-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const alias = [{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }];
/** a PostCSS plugin of the app's: \`x-thumb\` becomes \`width\` */
const xThumb = { postcssPlugin: 'x-thumb', Declaration: { 'x-thumb': (d: { prop: string }) => { d.prop = 'width'; } } };

beforeAll(async () => {
  mkdirSync(join(root, 'img'));
  mkdirSync(join(root, 'partials'));
  // a "photo": a gradient with noise, as a JPEG
  const w = 1000, h = 667, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w), n = (i * 2654435761) % 41;
    raw[i * 3] = (x / w) * 200 + n; raw[i * 3 + 1] = (y / h) * 180 + n; raw[i * 3 + 2] = 90 + n;
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(join(root, 'img/photo.jpg'));
  // a "logo": flat shapes on transparency, as a PNG
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect x="10" y="10" width="120" height="80" rx="12" fill="#c03"/><circle cx="250" cy="50" r="40" fill="#036"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(join(root, 'img/logo.png'));
  // a "screenshot": many flat colored bars, larger than a tiny file
  const bars = Array.from({ length: 60 }, (_, i) => `<rect x="${(i * 37) % 760}" y="${i * 10}" width="${40 + (i * 53) % 300}" height="8" fill="hsl(${i * 47} 70% 50%)"/>`).join('');
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#fff"/>${bars}</svg>`)).png().toFile(join(root, 'img/ui.png'));
  // the app's CSS: a module script imports it, and it imports the avatar rules into a layer
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/main.js'), "import './app.css';\nimport './thumbs.scss';\n");
  // Sass: a module with a variable and a mixin, nesting; compiled as Vite compiles it
  writeFileSync(join(root, 'src/_sizes.scss'), '$thumb: 4rem;\n@mixin square($s) { inline-size: $s; aspect-ratio: 1; object-fit: cover; }\n');
  writeFileSync(join(root, 'src/thumbs.scss'), "@use 'sizes';\n.thumb { img { @include sizes.square(sizes.$thumb); } }\n.pc img { x-thumb: 72px; aspect-ratio: 1; object-fit: cover; }\n");
  writeFileSync(join(root, 'src/app.css'), "@import './avatar.css' layer(ui);\n.hero img { width: 100% }\n");
  writeFileSync(join(root, 'src/avatar.css'), ':where([data-avatar]) { --_av: calc(var(--avatar-size, 2.5rem)); display: inline-grid; inline-size: var(--_av); block-size: var(--_av); overflow: hidden; }\n:where([data-avatar]) > :where(img) { inline-size: 100%; block-size: 100%; object-fit: cover; }\n');
  writeFileSync(join(root, 'partials/card.html'), '<img src="../img/photo.jpg" width="120" height="120" style="object-fit: cover" alt="Card">');
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>Images</title><script type="module" src="/src/main.js"></script></head><body>
<span data-avatar><img src="img/photo.jpg" alt="Avatar"></span>
<div class="hero"><img src="img/photo.jpg" width="300" alt="Fluid by CSS"></div>
<div class="thumb"><img src="img/photo.jpg" alt="Sass"></div>
<p class="pc"><img src="img/photo.jpg" alt="PostCSS"></p>
<img src="./img/photo.jpg" alt="Hero">
<img src="img/logo.png" width="200" alt="Logo">
<img src="img/ui.png" alt="UI">
<sn-include src="./partials/card.html"></sn-include>
</body></html>`);
});

test('a build: <picture> with AVIF and lossless WebP, the variants in assets/, the page rules in its stylesheet', async () => {
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, css: { postcss: { plugins: [xThumb] } }, build: { outDir: out, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  // the Sass rule (4rem, square) and the PostCSS plugin's output (72 px) size their images
  expect(html).toMatch(/<img src="\/assets\/photo-64-[\w-]+\.jpg" alt="Sass"[^>]* width="64" height="64"/);
  expect(html).toMatch(/<img src="\/assets\/photo-72-[\w-]+\.jpg" alt="PostCSS"[^>]* width="72" height="72"/);
  expect(html).not.toContain('vite-ignore');
  expect(html).toMatch(/<picture><source type="image\/avif" srcset="\/assets\/photo-480-[\w-]+\.avif 480w, \/assets\/photo-1000-[\w-]+\.avif 1000w" sizes="auto, 100vw"\s?><img src="\/assets\/photo-1000-[\w-]+\.jpg" alt="Hero"/);
  // a tiny PNG is the original file, with dimensions; a larger one is lossless WebP with a PNG fallback
  expect(html).toMatch(/<img src="\/assets\/logo-400-[\w-]+\.png" width="200" alt="Logo" height="50" loading="lazy" decoding="async"\s?>/);
  expect(html).toMatch(/<source type="image\/webp" srcset="\/assets\/ui-480-[\w-]+\.webp 480w, \/assets\/ui-800-[\w-]+\.webp 800w"[^>]*><img src="\/assets\/ui-800-[\w-]+\.png"/);
  expect(html).toMatch(/<img src="\/assets\/photo-120-[\w-]+\.jpg" width="120" height="120" alt="Card"[^>]* loading="lazy" decoding="async"/);
  expect(html).not.toContain('object-fit');
  // the stylesheets size the avatar (40 px, cropped square by their object-fit); the hero's CSS width wins over its attribute
  expect(html).toMatch(/srcset="\/assets\/photo-40-[\w-]+\.avif 40w, \/assets\/photo-80-[\w-]+\.avif 80w, \/assets\/photo-120-[\w-]+\.avif 120w" sizes="\(max-width: 40px\) 100vw, 40px"/);
  expect(html).toMatch(/<img src="\/assets\/photo-40-[\w-]+\.jpg" alt="Avatar"[^>]* width="40" height="40" decoding="async"/);
  expect(html).toMatch(/<img src="[^"]+" width="300" alt="Fluid by CSS"[^>]* sizes="auto, 100vw"/);
  // every URL in the page is a file of the build, with the format and size it claims
  const urls = [...html.matchAll(/\/assets\/([\w-]+\.(?:avif|webp|jpg|png))/g)].map((m) => m[1]!);
  expect(urls.length).toBeGreaterThan(8);
  for (const name of new Set(urls)) {
    const meta = await sharp(readFileSync(join(out, 'assets', name))).metadata();
    const [, width, ext] = /-(\d+)-[\w-]+\.(\w+)$/.exec(name)!;
    expect(meta.width).toBe(Number(width));
    expect({ avif: 'heif', webp: 'webp', jpg: 'jpeg', png: 'png' }[ext!]).toBe(meta.format);
    // the crop is square
    if (/^photo-(40|80|120|240|360)-/.test(name)) expect(meta.height).toBe(meta.width);
  }
  const css = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('');
  expect(css).toMatch(/:where\(img\[src="\/assets\/photo-1000-[\w-]+\.jpg"\]\)\s*\{\s*height:\s*auto;\s*background-color:\s*#[0-9a-f]{6}/);
  // transparent: no color
  expect(css).toMatch(/:where\(img\[src="\/assets\/logo-400-[\w-]+\.png"\]\)\s*\{\s*height:\s*auto;?\s*\}/);
  expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[\w-]+\.css">/);
});

test('the dev server serves a variant on its first request', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, css: { postcss: { plugins: [xThumb] } }, server: { port: 0, hmr: false, ws: false }, plugins: [sinter()] });
  try {
    await server.listen();
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    const url = /srcset="(\/@sinter\/img\/photo-480-[\w-]+\.avif) 480w/.exec(html)![1]!;
    const port = (server.httpServer!.address() as { port: number }).port;
    const res = await fetch(`http://localhost:${port}${url}`);
    expect(res.headers.get('content-type')).toBe('image/avif');
    expect((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).width).toBe(480);
    const css = await server.transformRequest('/@sinter/img-css/index.html.css');
    expect(css?.code).toContain('background-color');
  } finally {
    await server.close();
  }
}, 30_000);

test('images: false leaves them as written', async () => {
  const out = join(root, 'off');
  await build({ root, logLevel: 'silent', plugins: [sinter({ images: false })], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
  expect(readFileSync(join(out, 'index.html'), 'utf8')).not.toContain('<picture>');
});
