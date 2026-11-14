// Images from the API (docs/images.md, step 2): a bound <img src> gets the resizing service's
// srcset, with widths from the box the stylesheets give it.
import { expect, test } from 'vitest';
import { render, mockRequests } from '../../src/testing/index.js';
import { remote, resolveRemote } from '../../src/remote.js';
import { compile } from '../../src/compiler/index.js';

const AVATAR = ':where([data-avatar]) { inline-size: 2.5rem; block-size: 2.5rem; display: inline-grid } :where([data-avatar]) > :where(img) { inline-size: 100%; block-size: 100%; object-fit: cover }';
const page = `
  <sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>
  <ul><template data-sn-for="c in contacts">
    <li><span data-avatar><img alt="" data-sn-attr="{src: c.avatar}"></span></li>
  </template></ul>
  <sn-resource name="me" src="/api/me"></sn-resource>
  <img id="hero" alt="" data-sn-attr="{src: me.cover}">`;
const data = {
  'GET /api/contacts': [
    { id: 1, avatar: 'https://uploads.example.com/a/1.jpg' },
    { id: 2, avatar: '/media/2.jpg' },
    { id: 3, avatar: 'https://elsewhere.example.org/3.jpg' },
    { id: 4, avatar: 'https://uploads.example.com/logo.svg' },
    { id: 5, avatar: null },
  ],
  'GET /api/me': { cover: 'https://uploads.example.com/c.jpg?v=2' },
};

test('a fixed box from the stylesheets: 1x/2x/3x through the template, cover crop with {h}; other origins as they are', async () => {
  const { root, settle } = await render(page, {
    requests: mockRequests(data), css: AVATAR,
    remoteImages: { url: 'https://img.example.com/{w}/{url}', cover: 'https://img.example.com/{w}x{h}/{url}', origins: ['self', 'https://uploads.example.com'] },
  });
  await settle();
  const imgs = [...root.querySelectorAll('li img')] as HTMLImageElement[];
  const enc = encodeURIComponent('https://uploads.example.com/a/1.jpg');
  expect(imgs[0]!.getAttribute('src')).toBe(`https://img.example.com/40x40/${enc}`);
  expect(imgs[0]!.getAttribute('srcset')).toBe(`https://img.example.com/40x40/${enc} 40w, https://img.example.com/80x80/${enc} 80w, https://img.example.com/120x120/${enc} 120w`);
  expect(imgs[0]!.getAttribute('sizes')).toBe('(max-width: 40px) 100vw, 40px');
  expect([imgs[0]!.getAttribute('width'), imgs[0]!.getAttribute('height'), imgs[0]!.getAttribute('loading'), imgs[0]!.getAttribute('decoding')]).toEqual(['40', '40', 'lazy', 'async']);
  // same origin: its path
  expect(imgs[1]!.getAttribute('src')).toBe(`https://img.example.com/40x40/${encodeURIComponent('/media/2.jpg')}`);
  // another origin, an SVG: as they are, no srcset
  expect(imgs[2]!.getAttribute('src')).toBe('https://elsewhere.example.org/3.jpg');
  expect(imgs[2]!.hasAttribute('srcset')).toBe(false);
  expect(imgs[3]!.getAttribute('src')).toBe('https://uploads.example.com/logo.svg');
  expect(imgs[3]!.hasAttribute('srcset')).toBe(false);
  expect(imgs[4]!.hasAttribute('src')).toBe(false);
  // not sized by the stylesheets: fluid widths, the 1280 px file as src
  const hero = root.querySelector('#hero')!;
  expect(hero.getAttribute('src')).toBe(`https://img.example.com/1280/${encodeURIComponent('https://uploads.example.com/c.jpg?v=2')}`);
  expect(hero.getAttribute('srcset')!.split(', ').map((c) => c.split(' ')[1])).toEqual(['480w', '960w', '1440w', '1920w', '2560w']);
  expect(hero.getAttribute('sizes')).toBe('auto, 100vw');
});

test('without a cover template, a cover box is resized by width only; {url:raw} and {q}', async () => {
  const { root, settle } = await render(page, { requests: mockRequests(data), css: AVATAR, remoteImages: { url: 'cloudflare', cover: undefined, origins: ['https://uploads.example.com'], quality: 60 } });
  await settle();
  const img = root.querySelector('li img')!;
  // the cloudflare preset has a cover template
  expect(img.getAttribute('src')).toBe('/cdn-cgi/image/width=40,height=40,fit=cover,quality=60,format=auto/https://uploads.example.com/a/1.jpg');
  const v = await render(page, { requests: mockRequests(data), css: AVATAR, remoteImages: { url: 'vercel', origins: ['https://uploads.example.com'] } });
  await v.settle();
  expect(v.root.querySelector('li img')!.getAttribute('srcset')).toContain(`/_vercel/image?url=${encodeURIComponent('https://uploads.example.com/a/1.jpg')}&w=80&q=75 80w`);
});

test('constants and state are not data: left as they are', () => {
  const out = compile('<!doctype html><html><body><div data-sn-state="{ s: \'/a.jpg\' }"><img alt="" data-sn-attr="{src: s}"><img alt="" data-sn-attr="{src: \'/b.jpg\'}"></div></body></html>', {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
    remoteImages: resolveRemote({ url: 'netlify', origins: ['self'] }),
  });
  expect(out.module).not.toContain('$ri');
  expect(out.html).not.toContain('srcset');
});

test('the page module creates the service from the config, only when a page uses it', () => {
  const html = '<!doctype html><html><body><sn-resource name="me" src="/api/me"></sn-resource><img alt="" data-sn-attr="{src: me.photo}"></body></html>';
  const out = compile(html, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
    remoteImages: resolveRemote({ url: 'netlify', origins: ['self'] }),
  });
  expect(out.module).toContain("import { remote } from '@tiaforge-ui/sinter/remote';");
  expect(out.module).toContain('const $ri = remote({"url":"/.netlify/images?url={url}&w={w}&q={q}"');
  expect(out.module).toMatch(/\$ri\.set\(\(\$\.\$r\.me\.photo\), \[480,960,1440,1920,2560\], 0\)/);
});

test('config: presets, and what cannot work is an error', () => {
  expect(resolveRemote({ url: 'imgproxy:https://img.example.com/', origins: ['self'] })).toEqual({
    url: 'https://img.example.com/insecure/rs:fit:{w}:0/q:{q}/plain/{url}', cover: 'https://img.example.com/insecure/rs:fill:{w}:{h}/q:{q}/plain/{url}', origins: ['self'], quality: 75,
  });
  expect(() => resolveRemote({ url: 'https://img.example.com/{url}', origins: ['self'] })).toThrow(/needs \{url\} \(or \{url:raw\}\) and \{w\}/);
  expect(() => resolveRemote({ url: 'https://img/{w}/{url}', cover: 'https://img/{w}/{url}', origins: ['self'] })).toThrow(/cover needs .* \{h\}/);
  expect(() => resolveRemote({ url: 'https://img/{w}/{url}', origins: [] })).toThrow(/origins lists/);
  expect(() => resolveRemote({ url: 'https://img/{w}/{url}', origins: ['https://uploads.example.com/path'] })).toThrow(/is not an origin/);
  expect(() => resolveRemote({ url: 'https://img/{w}/{url}', origins: ['self'], quality: 0 })).toThrow(/quality/);
  expect(resolveRemote({ url: 'https://img/{w}/{url}', origins: ['https://uploads.example.com/'] }).origins).toEqual(['https://uploads.example.com']);
});

test('remote() on its own', () => {
  const r = remote({ url: '/r?u={url}&w={w}', cover: null, origins: ['self'], quality: 75 });
  expect(r.src('/p/a.jpg?x=1', 100, 1)).toBe(`/r?u=${encodeURIComponent('/p/a.jpg?x=1')}&w=100`);
  expect(r.set('javascript:alert(1)', [1], 0)).toBeNull();
  expect(r.src(42, 100, 0)).toBe(42);
});

test('a fluid API image in a max-width container: sizes and widths from the bound', async () => {
  const { root, settle } = await render(page, {
    requests: mockRequests(data), css: AVATAR + ' body { max-width: 500px } img { max-width: 100% }',
    remoteImages: { url: 'https://img.example.com/{w}/{url}', origins: ['https://uploads.example.com'] },
  });
  await settle();
  const hero = root.querySelector('#hero')!;
  expect(hero.getAttribute('sizes')).toBe('auto, (max-width: 500px) 100vw, 500px');
  expect(hero.getAttribute('srcset')!.split(', ').map((c) => c.split(' ')[1])).toEqual(['480w', '960w', '1500w']);
  expect(hero.getAttribute('src')).toContain('https://img.example.com/500/');
});

test('SN514: an API image in the rows of an auto-fit grid; auto-fill gets exact sizes; an author sizes silences it', () => {
  const grid = (fit: string, img = '<img alt="" data-sn-attr="{src: c.photo}">') => compile(`<!doctype html><html><head></head><body>
    <sn-resource name="cards" src="/api/cards" key="id"></sn-resource>
    <div class="g"><template data-sn-for="c in cards">${img}</template></div></body></html>`, {
    file: '/app/index.html', root: '/app', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} },
    remoteImages: resolveRemote({ url: 'netlify', origins: ['self'] }),
    images: { info: () => null, url: () => '', styles: [{ file: 'a.css', css: `body { margin: 0 } .g { display: grid; grid-template-columns: repeat(${fit}, minmax(200px, 1fr)); gap: 16px } img { width: 100% }` }] },
  });
  // (the images have no height before their files load either: SN521, which this test is not about)
  const codes = (x: ReturnType<typeof grid>) => x.diagnostics.filter((d) => d.code !== 'SN521');
  const fit = grid('auto-fit');
  expect(codes(fit).map((d) => d.code)).toEqual(['SN514']);
  expect(codes(fit)[0]!.hint).toMatch(/use `repeat\(auto-fill, …\)`/);
  const fill = grid('auto-fill');
  expect(codes(fill)).toEqual([]);
  // 200 px columns and 16 px gaps: a second column from 416 px, a third from 632
  expect(fill.html).toMatch(/sizes="auto, \(max-width: 415\.98px\) 100vw, \(max-width: 631\.98px\) calc\(50vw - 8px\)/);
  expect(codes(grid('auto-fit', '<img alt="" sizes="300px" data-sn-attr="{src: c.photo}">'))).toEqual([]);
});
