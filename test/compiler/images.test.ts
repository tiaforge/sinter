// Static <img> rewrite (docs/images.md): the compiler side, with a fake host.
import { expect, test } from 'vitest';
import { compile, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';

const root = '/app';
const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const files: Record<string, ImageInfo | null> = {
  '/app/img/photo.jpg': photo,
  '/app/img/logo.png': { width: 400, height: 100, alpha: true, kind: 'graphic', color: null, bytes: 9000, hash: 'def' },
  '/app/img/tiny.png': { width: 32, height: 32, alpha: false, kind: 'graphic', color: '#ffffff', bytes: 900, hash: 'ghi' },
  '/app/img/small.jpg': { ...photo, width: 300, height: 200 },
};
const url = (v: ImageVariant) => `/i/${v.file.slice(v.file.lastIndexOf('/') + 1).replace(/\.\w+$/, '')}-${v.width}${v.crop ? `c${v.crop.left}x${v.crop.top}` : ''}.${v.format === 'original' ? v.file.split('.').pop() : v.format === 'jpeg' ? 'jpg' : v.format}`;
const host: ImageHost = { info: (f) => (f in files ? files[f] : undefined), url, stylesheet: '/@sinter/img/index.html.css' };

function run(body: string, h: ImageHost = host) {
  return compile(`<!doctype html><html><head></head><body>${body}</body></html>`, {
    file: '/app/index.html', root, dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, images: h,
  });
}
const body = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;

test('a fluid photo: AVIF source, JPEG fallback, widths below the source and the source width, dimensions, the first image eager', () => {
  const out = run('<img src="img/photo.jpg" alt="A"><img src="./img/photo.jpg" alt="B">');
  expect(out.diagnostics).toEqual([]);
  const [a, b] = body(out.html).split('</picture>');
  expect(a).toBe('<picture><source type="image/avif" srcset="/i/photo-480.avif 480w, /i/photo-960.avif 960w, /i/photo-1440.avif 1440w, /i/photo-1600.avif 1600w" sizes="100vw">'
    + '<img src="/i/photo-960.jpg" alt="A" srcset="/i/photo-480.jpg 480w, /i/photo-960.jpg 960w, /i/photo-1440.jpg 1440w, /i/photo-1600.jpg 1600w" sizes="100vw" width="1600" height="1067" decoding="async">');
  // the second is lazy, and `sizes` can be `auto` there
  expect(b).toContain('sizes="auto, 100vw"');
  expect(b).toContain('loading="lazy"');
  expect(out.images!.variants.map(url)).toEqual([...new Set(out.images!.variants.map(url))]);
  expect(out.images!.css).toBe(':where(img[src="/i/photo-960.jpg"]){height:auto;background-color:#8a7f6e}\n');
  expect(out.module.startsWith('import "/@sinter/img/index.html.css";\n')).toBe(true);
});

test('a fixed box: 1x, 2x and, for a small box, 3x; `sizes` from the box', () => {
  const out = run('<img src="img/photo.jpg" width="200" alt="">');
  const html = body(out.html);
  expect(html).toContain('srcset="/i/photo-200.avif 200w, /i/photo-400.avif 400w, /i/photo-600.avif 600w" sizes="(max-width: 200px) 100vw, 200px"');
  expect(html).toContain('width="200" alt=""');
  expect(html).toContain('height="133"');
  expect(html).toContain('src="/i/photo-200.jpg"');
});

test('a large box gets no 3x; a box the source cannot fill at 2x is SN511', () => {
  expect(body(run('<img src="img/photo.jpg" width="800" alt="">').html)).toContain('srcset="/i/photo-800.avif 800w, /i/photo-1600.avif 1600w"');
  const out = run('<img src="img/small.jpg" width="200" alt="">');
  expect(out.diagnostics.map((d) => [d.code, d.message])).toEqual([['SN511', '`img/small.jpg` is 300 px wide; the 200 px box needs 400 px to be sharp on 2x screens']]);
  expect(body(out.html)).toContain('srcset="/i/small-200.avif 200w, /i/small-300.avif 300w"');
});

test('width/height equal to the source are only its ratio: fluid', () => {
  expect(body(run('<img src="img/photo.jpg" width="1600" height="1067" alt="">').html)).toContain('sizes="100vw" decoding="async"');
});

test('object-fit: cover crops at object-position and drops the inline style; other declarations stay', () => {
  const out = run('<img src="img/photo.jpg" width="200" height="200" style="object-fit: cover; object-position: right; border-radius: 50%" alt="">');
  expect(out.diagnostics).toEqual([]);
  const html = body(out.html);
  // 1067 × 1067 from the right edge of a 1600 px wide source
  expect(html).toContain('/i/photo-200c533x0.avif 200w, /i/photo-400c533x0.avif 400w, /i/photo-600c533x0.avif 600w');
  expect(html).toContain('style="border-radius: 50%"');
  expect(html).toContain('width="200" height="200"');
  expect(out.images!.variants[0]!.crop).toEqual({ left: 533, top: 0, width: 1067, height: 1067 });
  expect(body(run('<img src="img/photo.jpg" width="200" height="200" style="object-fit:cover" alt="">').html)).not.toContain('style=');
});

test('object-fit: contain makes the fitted size, keeps the style and the box, and no height: auto', () => {
  const out = run('<img src="img/photo.jpg" width="300" height="300" style="object-fit: contain" alt="">');
  expect(body(out.html)).toContain('srcset="/i/photo-300.avif 300w, /i/photo-600.avif 600w, /i/photo-900.avif 900w"');
  expect(body(out.html)).toContain('style="object-fit: contain"');
  expect(out.images!.css).toBe(':where(img[src="/i/photo-300.jpg"]){background-color:#8a7f6e}\n');
});

test('another ratio without object-fit is SN512', () => {
  const out = run('<img src="img/photo.jpg" width="200" height="200" alt="">');
  expect(out.diagnostics.map((d) => d.code)).toEqual(['SN512']);
});

test('a graphic: lossless WebP and a PNG fallback; transparency gets no color', () => {
  const out = run('<img src="img/logo.png" alt="Logo">');
  expect(body(out.html)).toContain('<source type="image/webp" srcset="/i/logo-400.webp 400w"');
  expect(body(out.html)).toContain('src="/i/logo-400.png"');
  expect(out.images!.css).toBe(':where(img[src="/i/logo-400.png"]){height:auto}\n');
});

test('a tiny image: the original file with dimensions, no picture', () => {
  expect(body(run('<img src="img/tiny.png" alt="">').html)).toBe('<img src="/i/tiny-32.png" alt="" width="32" height="32" decoding="async">');
});

test('left alone: remote, data:, svg, srcset, inside a picture, with directives, unknown file types, non-numeric width', () => {
  for (const img of [
    '<img src="https://x.test/a.jpg" alt="">', '<img src="data:image/png;base64,AA" alt="">', '<img src="img/a.svg" alt="">',
    '<img src="img/photo.jpg" srcset="img/photo.jpg 1x" alt="">', '<picture><img src="img/photo.jpg" alt=""></picture>',
    '<img src="img/photo.jpg" width="50%" alt="">', '<img src="img/photo.jpg" style="object-fit: none" alt="">',
  ]) expect(body(run(img).html)).toBe(img);
  expect(body(run('<img src="img/missing.jpg" alt="">', { ...host, info: () => null }).html)).toBe('<img src="img/missing.jpg" alt="">');
});

test('images in templates are rewritten (lazy), bindings next to them keep their paths', () => {
  const out = run('<ul data-sn-state="{ xs: [1, 2] }"><template data-sn-for="x in xs" data-sn-key="x"><li><img src="img/photo.jpg" width="100" alt=""><span data-sn-text="x"></span></li></template></ul>');
  expect(out.diagnostics).toEqual([]);
  expect(out.html).toMatch(/<template[^>]*><li><picture><source [^>]+><img [^>]*loading="lazy"[^>]*><\/picture><span><\/span><\/li><\/template>/);
  // the span is still the row's second child
  expect(out.module).toContain('"path":[0,1]');
});

test('an unknown file is pending: left as written for now', () => {
  const out = run('<img src="img/new.jpg" alt="">');
  expect(out.images!.pending).toEqual(['/app/img/new.jpg']);
  expect(body(out.html)).toBe('<img src="img/new.jpg" alt="">');
});

test('vite-ignore on the variants when asked', () => {
  expect(body(run('<img src="img/photo.jpg" alt="">', { ...host, ignore: true }).html)).toMatch(/<source [^>]*vite-ignore=""><img [^>]*vite-ignore="">/);
});
