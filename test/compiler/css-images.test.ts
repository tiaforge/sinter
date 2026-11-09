// CSS backgrounds (docs/images.md, step 3), with a fake host.
import { expect, test } from 'vitest';
import { rewriteCssImages, type CssImageHost } from '../../src/css-images.js';
import type { ImageInfo, ImageVariant } from '../../src/compiler/images.js';

const infos: Record<string, ImageInfo> = {
  '/app/hero.jpg': { width: 1600, height: 900, alpha: false, kind: 'photo', color: null, bytes: 300_000, hash: 'h' },
  '/app/pattern.png': { width: 200, height: 200, alpha: true, kind: 'graphic', color: null, bytes: 20_000, hash: 'p' },
  '/app/dot.png': { width: 8, height: 8, alpha: false, kind: 'graphic', color: null, bytes: 200, hash: 'd' },
};
const name = (v: ImageVariant) => `/v/${v.file.slice(5).replace(/\.\w+$/, '')}-${v.width}.${v.format === 'jpeg' ? 'jpg' : v.format}`;
const host: CssImageHost = {
  source: (u) => (u.startsWith('/app/') ? u : null),
  info: (f) => infos[f] ?? null,
  analyze: async () => {},
  url: name,
};

test('a sized background: the source as 2x, AVIF first, the original declaration kept before', async () => {
  const out = await rewriteCssImages('.hero{background:url(/app/hero.jpg) 50%/cover no-repeat;color:red}', host);
  expect(out!.css).toBe('.hero{background:url(/app/hero.jpg) 50%/cover no-repeat;background:image-set(url("/v/hero-800.avif") type("image/avif") 1x,url("/v/hero-1600.avif") type("image/avif") 2x,url("/v/hero-800.jpg") type("image/jpeg") 1x,url("/v/hero-1600.jpg") type("image/jpeg") 2x) 50%/cover no-repeat;color:red}');
  expect(out!.variants.map(name)).toEqual(['/v/hero-800.avif', '/v/hero-1600.avif', '/v/hero-800.jpg', '/v/hero-1600.jpg']);
});

test('sized by background-size in the same rule; not sized: 1x only, so the tile keeps its size', async () => {
  const sized = await rewriteCssImages('.a{background-image:url("/app/hero.jpg");background-size:cover}', host);
  expect(sized!.css).toContain('2x');
  const tile = await rewriteCssImages('.t{background-image:url(/app/pattern.png)}', host);
  expect(tile!.css).toBe('.t{background-image:url(/app/pattern.png);background-image:image-set(url("/v/pattern-200.webp") type("image/webp") 1x,url("/v/pattern-200.png") type("image/png") 1x)}');
});

test('left alone: tiny files, other properties, other urls, image-set already, and !important is kept', async () => {
  expect(await rewriteCssImages('.d{background:url(/app/dot.png)}', host)).toBeNull();
  expect(await rewriteCssImages('.m{mask:url(/app/hero.jpg)}@font-face{src:url(/app/hero.jpg)}', host)).toBeNull();
  expect(await rewriteCssImages('.r{background:url(https://x.test/a.jpg)}', host)).toBeNull();
  expect(await rewriteCssImages('.s{background-image:image-set(url(/app/hero.jpg) 1x)}', host)).toBeNull();
  const imp = await rewriteCssImages('.i{background-image:url(/app/hero.jpg)!important}', host);
  expect(imp!.css).toMatch(/^\.i\{background-image:url\(\/app\/hero\.jpg\)!important;background-image:image-set\(.*\)!important\}$/);
});

test('several layers and nesting: each url() of a local image', async () => {
  const out = await rewriteCssImages('@media (min-width:600px){.x{background:linear-gradient(red,blue),url(/app/hero.jpg) center/cover,url(https://x.test/b.jpg)}}', host);
  expect(out!.css).toContain('background:linear-gradient(red,blue),image-set(url("/v/hero-800.avif")');
  expect(out!.css).toContain('center/cover,url(https://x.test/b.jpg)}}');
});
