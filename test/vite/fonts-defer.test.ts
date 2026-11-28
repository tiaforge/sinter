// @vitest-environment node
// Web fonts after `load` (docs/first-paint.md#fonts-after-the-load): in a build, a page with an early file loads its
// bundled stylesheets' `font-display: swap` faces from a stylesheet of their own, linked in `<noscript data-sn-fonts>`,
// which its early file adds after the window's `load`. Faces that hold text for the font, faces `fonts.preload` names
// and faces in a conditional rule stay; a page with no script links the same stylesheet and the faces' file as is.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { deferredFaces, fallbackFaces, rebaseFace, textFamilies, withFallbackFamilies } from '../../src/fonts-build.js';
import { fitMetrics, isTextFont } from '../../src/font-metrics.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const face = (family: string, weight: number, display: string | null, file: string) =>
  `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight};${display ? ` font-display: ${display};` : ''} src: url(./files/${file}.woff2) format('woff2'); }`;
const CSS = [
  face('Swap Sans', 400, 'swap', 'swap-400'),
  face('Swap Sans', 700, 'swap', 'swap-700'),
  face('Block Sans', 400, 'block', 'block-400'),
  face('Optional Sans', 400, 'optional', 'optional-400'),
  face('Plain Sans', 400, null, 'plain-400'),
  `@media (min-width: 1px) { ${face('Media Sans', 400, 'swap', 'media-400')} }`,
  "body { font-family: 'Swap Sans', 'Block Sans', 'Optional Sans', 'Plain Sans', 'Media Sans', sans-serif; }",
].join('\n');
const FILES = ['swap-400', 'swap-700', 'block-400', 'optional-400', 'plain-400', 'media-400'];

/**
 * A font file with a glyph for each code point of `ranges` (a `cmap` of format 4, advances of `advance` units in
 * 1,000): enough for the build to tell a text font (a–z) from an icon font (private-use code points) and to fit a fallback face.
 */
function font(ranges: Array<[number, number]>, advance = 500): Uint8Array {
  const segs = [...ranges, [0xffff, 0xffff] as [number, number]], n = segs.length;
  let gid = 1;
  const firsts = segs.map(([lo, hi]) => { const g = gid; gid += hi - lo + 1; return g; });
  const sub = new DataView(new ArrayBuffer(16 + n * 8)), at = (i: number, k: number) => 14 + k * (n * 2) + (k ? 2 : 0) + i * 2;
  sub.setUint16(0, 4); sub.setUint16(2, sub.byteLength); sub.setUint16(6, n * 2);
  segs.forEach(([lo, hi], i) => { sub.setUint16(at(i, 0), hi); sub.setUint16(at(i, 1), lo); sub.setInt16(at(i, 2), ((i == n - 1 ? 1 : firsts[i]! - lo) << 16) >> 16); });
  const cmap = new Uint8Array(12 + sub.byteLength), c = new DataView(cmap.buffer);
  c.setUint16(2, 1); c.setUint16(4, 3); c.setUint16(6, 1); c.setUint32(8, 12); cmap.set(new Uint8Array(sub.buffer), 12);
  const head = new Uint8Array(54), hhea = new Uint8Array(36), hmtx = new Uint8Array(gid * 4);
  new DataView(head.buffer).setUint32(12, 0x5f0f3cf5); new DataView(head.buffer).setUint16(18, 1000);
  const hh = new DataView(hhea.buffer); hh.setInt16(4, 900); hh.setInt16(6, -300); hh.setUint16(34, gid);
  for (let g = 0; g < gid; g++) new DataView(hmtx.buffer).setUint16(g * 4, advance);
  const t: Array<[string, Uint8Array]> = [['cmap', cmap], ['head', head], ['hhea', hhea], ['hmtx', hmtx]];
  const dir = 12 + t.length * 16, out = new Uint8Array(dir + t.reduce((a, [, b]) => a + b.length, 0)), v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, t.length);
  let off = dir;
  t.forEach(([tag, b], i) => { out.set([...tag].map((ch) => ch.charCodeAt(0)), 12 + i * 16); v.setUint32(12 + i * 16 + 8, off); v.setUint32(12 + i * 16 + 12, b.length); out.set(b, off); off += b.length; });
  return out;
}
const TEXT: Array<[number, number]> = [[0x20, 0x20], [0x61, 0x7a]], ICONS: Array<[number, number]> = [[0xe000, 0xe0ff]];
/** real fonts, each without `font-display`: a text font, an icon font, and an icon font with letters (ligatures) beside its icons */
const REAL: Record<string, Uint8Array> = { 'text-400': font(TEXT, 400), 'text-700': font(TEXT, 450), 'icons': font(ICONS), 'ligatures': font([[0x61, 0x7a], [0xe000, 0xe1ff]], 1000) };
const REAL_CSS = [
  "@font-face { font-family: 'Text Sans'; font-weight: 400; src: url(./files/text-400.ttf) format('truetype'); }",
  "@font-face { font-family: 'Text Sans'; font-weight: 700; src: url(./files/text-700.ttf) format('truetype'); }",
  "@font-face { font-family: 'App Icons'; src: url(./files/icons.ttf) format('truetype'); }",
  "@font-face { font-family: 'Lig Icons'; src: url(./files/ligatures.ttf) format('truetype'); }",
  "h1 { font: 700 2rem/1.2 'Text Sans', sans-serif; } .i { font-family: 'App Icons'; } :root { --ui: Text Sans, sans-serif; }",
].join('\n');

/** pages: an early one (a text from the URL, rendered by its early file) and, with `staticPage`, one with nothing to run, both linking app.css */
async function site(opts: { real?: boolean; preload?: Parameters<typeof sinter>[0] extends infer O ? O extends { fonts?: infer F } ? F extends { preload?: infer P } ? P : never : never : never; staticPage?: boolean; base?: string; body?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-fonts-defer-'));
  dirs.push(root);
  mkdirSync(join(root, 'files'));
  // over Vite's inline limit, so each font file is an asset (each its own bytes: Vite emits identical files once)
  for (const [i, f] of FILES.entries()) writeFileSync(join(root, `files/${f}.woff2`), Buffer.alloc(8192, i + 1));
  if (opts.real) for (const [f, b] of Object.entries(REAL)) writeFileSync(join(root, `files/${f}.ttf`), Buffer.concat([b, Buffer.alloc(8192)]));
  writeFileSync(join(root, 'app.css'), opts.real ? `${CSS}\n${REAL_CSS}` : CSS);
  const head = '<meta charset="utf-8"><title>t</title><link rel="stylesheet" href="./app.css">';
  writeFileSync(join(root, 'index.html'), `<!doctype html><html lang="en"><head>${head}</head><body>${opts.body ?? '<p data-sn-text="$url.q"></p>'}</body></html>`);
  const input = [join(root, 'index.html')];
  if (opts.staticPage) {
    writeFileSync(join(root, 'about.html'), `<!doctype html><html lang="en"><head>${head}</head><body><p>About us.</p></body></html>`);
    input.push(join(root, 'about.html'));
  }
  await build({
    root, logLevel: 'silent', base: opts.base, plugins: [sinter({ redirects: false, fonts: opts.preload ? { preload: opts.preload } : undefined })], resolve: { alias },
    build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input } },
  });
  const out = join(root, 'dist');
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  const assets = readdirSync(join(out, 'assets'));
  return { read, assets };
}

/** the bundled stylesheets a page links (render-blocking), its `<noscript data-sn-fonts>` link, and the head scripts */
const linksOf = (html: string) => ({
  sheets: [...html.replace(/<noscript[\s\S]*?<\/noscript>/g, '').matchAll(/<link rel="stylesheet"[^>]*href="[^"]*?(assets\/[^"]+\.css)"/g)].map((m) => m[1]!),
  fonts: /<noscript data-sn-fonts="[^"]*"[^>]*><link rel="stylesheet"[^>]*href="[^"]*?(assets\/fonts-[\w-]+\.css)"><\/noscript>/.exec(html)?.[1] ?? null,
  scripts: [...html.matchAll(/<script src="[^"]*?(assets\/[^"]+\.js)"><\/script>/g)].map((m) => m[1]!),
});

test('a page with an early file: its swap faces move to a stylesheet in <noscript>, the others stay render-blocking', async () => {
  const { read, assets } = await site();
  const html = read('index.html'), l = linksOf(html);
  expect(l.sheets).toHaveLength(1);
  expect(l.fonts).not.toBeNull();
  const sheet = read(l.sheets[0]!), fonts = read(l.fonts!);
  // moved: both swap faces, with their files' URLs as Vite wrote them (same folder)
  expect(fonts.match(/@font-face/g)).toHaveLength(2);
  expect(fonts).toMatch(/font-family:\s*["']?Swap Sans/);
  expect(fonts).toMatch(/url\("?\/assets\/swap-400-[\w-]+\.woff2"?\)/);
  expect(sheet).not.toContain('Swap Sans;');
  expect(sheet).not.toMatch(/swap-400-[\w-]+\.woff2/);
  // kept: block, optional, none, and the face in @media; the other rules
  for (const f of ['block-400', 'optional-400', 'plain-400', 'media-400']) expect(sheet).toMatch(new RegExp(`${f}-[\\w-]+\\.woff2`));
  expect(sheet).toMatch(/body\s*\{\s*font-family:/);
  // the noscript at the start of the head, before the early file that reads it; the original stylesheet, which no page links, is gone
  expect(html.indexOf('<noscript data-sn-fonts=')).toBeGreaterThan(-1);
  expect(html.indexOf('<noscript data-sn-fonts=')).toBeLessThan(html.indexOf(l.scripts[0]!));
  expect(assets.filter((a) => a.endsWith('.css'))).toHaveLength(2);
  // the early file has the loader: it reads the noscript after `load`
  const early = l.scripts.map(read).join('\n');
  expect(early).toContain('noscript[data-sn-fonts]');
  expect(early).toMatch(/addEventListener\(\s*["'`]load["'`]/);
  // no inline script or style, no event handler attribute (a `script-src 'self'; style-src 'self'` policy)
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)(?![^>]*type="(?:application\/json|speculationrules)")[^>]*>/);
  expect(html).not.toMatch(/<style\b|\son\w+=/);
});

test('faces fonts.preload names stay in the render-blocking stylesheet', async () => {
  const { read } = await site({ preload: [{ family: 'Swap Sans', weight: 700 }] });
  const l = linksOf(read('index.html')), sheet = read(l.sheets[0]!), fonts = read(l.fonts!);
  expect(sheet).toMatch(/swap-700-[\w-]+\.woff2/);
  expect(fonts).not.toMatch(/swap-700/);
  expect(fonts).toMatch(/swap-400-[\w-]+\.woff2/);
});

test('a page with nothing to run gets no script, and the same stylesheet as the early page, with the faces in a plain link before it', async () => {
  const { read, assets } = await site({ staticPage: true });
  const about = read('about/index.html'), index = read('index.html');
  // (the Speculation Rules, as on any page, are no script that runs)
  expect(about).not.toMatch(/<script(?! type="speculationrules")/);
  expect(about).not.toContain('<noscript');
  const early = linksOf(index), plain = linksOf(about);
  // the faces' file first (render-blocking, as the faces were), then the stylesheet both pages share
  expect(plain.sheets).toEqual([early.fonts, early.sheets[0]]);
  expect(read(early.sheets[0]!)).not.toMatch(/swap-400/);
  expect(read(early.fonts!)).toMatch(/swap-400-[\w-]+\.woff2/);
  // the original, which no page links, is gone: the copy and the faces' file
  expect(assets.filter((a) => a.endsWith('.css'))).toHaveLength(2);
});

test('a relative base: the noscript link and the copy are relative to the page', async () => {
  const { read } = await site({ base: './' });
  const html = read('index.html');
  expect(html).toMatch(/<noscript data-sn-fonts="(\.\/assets\/fonts-[\w-]+\.css)"[^>]*><link rel="stylesheet"[^>]*href="\1"><\/noscript>/);
  const fonts = read(linksOf(html).fonts!);
  expect(fonts).toMatch(/url\("?\.\/swap-400-[\w-]+\.woff2"?\)/);
});

test('deferredFaces: swap faces only, top-level only, not the ones kept; the rest of the stylesheet as it was', () => {
  const css = `/* a } in a comment */ @font-face{font-family:A;font-display:swap;src:url("a}.woff2")}.x{content:"@font-face{"}@font-face{font-family:B;font-display:fallback;src:url(b.woff2)}@layer l{@font-face{font-family:C;font-display:swap;src:url(c.woff2)}}@FONT-FACE {font-family:"D";font-weight:100 900;font-display:SWAP;src:url(d.woff2)}`;
  const out = deferredFaces(css)!;
  expect(out.faces).toEqual(['@font-face{font-family:A;font-display:swap;src:url("a}.woff2")}', '@FONT-FACE {font-family:"D";font-weight:100 900;font-display:SWAP;src:url(d.woff2)}']);
  expect(out.css).toBe('/* a } in a comment */ .x{content:"@font-face{"}@font-face{font-family:B;font-display:fallback;src:url(b.woff2)}@layer l{@font-face{font-family:C;font-display:swap;src:url(c.woff2)}}');
  // a preloaded face: a variable face whose range spans the weight is that face
  expect(deferredFaces(css, [{ family: 'd', weight: 700, style: 'normal' }])!.faces).toHaveLength(1);
  expect(deferredFaces(css, [{ family: 'D', weight: 700, style: 'italic' }])!.faces).toHaveLength(2);
  expect(deferredFaces('@font-face{font-family:A;src:url(a.woff2)}body{font-family:A}')).toBeNull();
  expect(rebaseFace('@font-face{src:url(./f.woff2),url(/abs.woff2),url(https://x/y.woff2)}', 'assets/css', 'assets')).toBe('@font-face{src:url(./css/f.woff2),url(/abs.woff2),url(https://x/y.woff2)}');
});

test('a text font without font-display, self-hosted, is deferred as swap with a fitted fallback family; icon fonts stay as they are', async () => {
  const { read } = await site({ real: true });
  const l = linksOf(read('index.html')), sheet = read(l.sheets[0]!), fonts = read(l.fonts!);
  // moved, now swap: both faces of the text font (with the two swap faces)
  expect(fonts.match(/@font-face/g)).toHaveLength(4);
  expect(fonts.match(/@font-face\s*\{font-display:swap;\s*font-family:\s*["']?Text Sans/g)).toHaveLength(2);
  expect(sheet).not.toMatch(/text-400-[\w-]+\.ttf/);
  // kept, as written: the icon font (private-use code points only) and the one with letters beside its icons
  for (const f of ['icons', 'ligatures']) { expect(sheet).toMatch(new RegExp(`${f}-[\\w-]+\\.ttf`)); expect(fonts).not.toContain(f); }
  expect(sheet).not.toMatch(/(App|Lig) Icons Fallback/);
  // the fitted family: a system font per face, scaled to the web font's advance (0.4 and 0.45 em against Arial's)
  expect(sheet).toMatch(/@font-face\{font-family:"Text Sans Fallback";font-style:normal;font-weight:400;src:local\("Arial"\),local\("ArialMT"\),local\("Liberation Sans"\);size-adjust:91%;ascent-override:98\.91%;descent-override:32\.97%;line-gap-override:0%\}/);
  expect(sheet).toMatch(/@font-face\{font-family:"Text Sans Fallback";font-style:normal;font-weight:700;src:local\("Arial Bold"\)/);
  // named after the web font in the lists that name it: a declaration, the shorthand, a custom property
  expect(sheet).toMatch(/font:\s*700 2rem\/1\.2 ["']?Text Sans["']?,\s*"Text Sans Fallback",\s*sans-serif/i);
  expect(sheet).toMatch(/--ui:\s*Text Sans,\s*"Text Sans Fallback",\s*sans-serif/);
  // the swap faces' garbage files cannot be read: no fitted family for them
  expect(sheet).not.toContain('Swap Sans Fallback');
});

test('textFamilies and deferredFaces: a family is text by its Latin face\'s file; unread or icon files leave the faces where they are', async () => {
  const g = (family: string, file: string, extra = '') => `@font-face{font-family:'${family}';font-weight:400;${extra}src:url(${file}) format('woff2')}`;
  const css = g('Sans', 'cyr.woff2', 'unicode-range:U+0400-045F;') + g('Sans', 'latin.woff2', 'unicode-range:U+0000-00FF;') + g('Lora', 'lora.woff2', 'font-display:auto;')
    + g('Icons', 'icons.woff2') + g('Gone', 'gone.woff2') + g('Blocked', 'latin.woff2', 'font-display:block;') + g('Swapped', 'icons.woff2', 'font-display:swap;');
  const seen: string[] = [];
  const text = await textFamilies(css, async (url) => { seen.push(url); return url == 'gone.woff2' ? null : isTextFont(url == 'icons.woff2' ? font(ICONS) : font(TEXT)); });
  expect([...text].sort()).toEqual(['lora', 'sans']);
  // the Latin face's file says what the family is (not the Cyrillic subset's, which has no a–z); faces with a font-display are not read
  expect(seen).toEqual(['latin.woff2', 'lora.woff2', 'icons.woff2', 'gone.woff2']);
  const out = deferredFaces(css, [], text)!;
  expect(out.faces).toHaveLength(4);
  expect(out.faces[0]).toMatch(/^@font-face\{font-display:swap;font-family:'Sans';font-weight:400;unicode-range:U\+0400/);
  expect(out.faces[2]).toMatch(/font-family:'Lora';font-weight:400;font-display:swap;src:/);
  expect(out.faces[3]).toContain('Swapped');
  for (const kept of ["'Icons'", "'Gone'", "'Blocked'"]) expect(out.css).toContain(kept);
  // without the files' verdict nothing without font-display moves
  expect(deferredFaces(css)!.faces).toHaveLength(1);
  expect(isTextFont(font([[0x61, 0x7a], [0xe000, 0xe1ff]]))).toBe(false);
  expect(isTextFont(new Uint8Array(64))).toBeNull();
});

test('fallbackFaces: one fitted system face per Latin face of a family, weight and style; none for monospace or an unread file', async () => {
  const face = (family: string, weight: number, style: string, range: string) => `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:swap;src:url(https://x/${family.replace(' ', '')}-${weight}.woff2);unicode-range:${range}}`;
  const faces = [face('Text Sans', 400, 'normal', 'U+0100-02BA'), face('Text Sans', 400, 'normal', 'U+0000-00FF'), face('Text Sans', 700, 'italic', 'U+0000-00FF'), face('Book', 400, 'normal', 'U+0000-00FF'), face('Code', 400, 'normal', 'U+0000-00FF'), face('Gone', 400, 'normal', 'U+0000-00FF'), face('Unlisted', 400, 'normal', 'U+0000-00FF')];
  const css = `body{font-family:text sans,sans-serif}h1{font:700 2rem/1 "Book",serif}pre{font-family:Code,monospace}i{font-family:Gone,sans-serif}`;
  const seen: string[] = [];
  const out = await fallbackFaces(faces, css, (f) => f != 'Unlisted', async (url) => { seen.push(url); return url.includes('Gone') ? null : { ascent: 0.984, descent: 0.273, lineGap: 0, avg: 0.43958 * 0.9 }; });
  const rules = out.css.match(/@font-face\{[^}]*\}/g)!;
  expect(rules).toHaveLength(3);
  expect(out.families).toEqual(['Text Sans', 'Book']);
  // the web font is 0.9 of Arial's width: the system font scaled to it, its lines the web font's
  expect(rules[0]).toBe('@font-face{font-family:"Text Sans Fallback";font-style:normal;font-weight:400;src:local("Arial"),local("ArialMT"),local("Liberation Sans");size-adjust:90%;ascent-override:109.33%;descent-override:30.33%;line-gap-override:0%}');
  expect(rules[1]).toMatch(/font-family:"Text Sans Fallback";font-style:italic;font-weight:700;src:local\("Arial Bold Italic"\)/);
  expect(rules[2]).toMatch(/font-family:"Book Fallback";font-style:normal;font-weight:400;src:local\("Times New Roman"\)/);
  // the Latin files only, and not the monospace family's
  expect(seen).toEqual(['https://x/TextSans-400.woff2', 'https://x/TextSans-700.woff2', 'https://x/Book-400.woff2', 'https://x/Gone-400.woff2']);
  expect(fitMetrics(font(TEXT, 400))).toEqual({ ascent: 0.9, descent: 0.3, lineGap: 0, avg: 0.4 });
});

test('withFallbackFamilies: the fitted family after the web font in font lists, shorthands and custom properties; faces and other lists untouched', () => {
  const css = `@font-face{font-family:"Inter";src:url(a.woff2)}body{font-family:Inter,sans-serif}h1{font:italic 700 2rem/1.2 "Inter", serif}:root{--f: 'inter' ;--g:Inter Tight,serif}p{font-family:Inter!important}code{font-family:"Inter","Inter Fallback",monospace}a{font-family:Arial}`;
  expect(withFallbackFamilies(css, ['Inter'])).toBe(`@font-face{font-family:"Inter";src:url(a.woff2)}body{font-family:Inter,"Inter Fallback",sans-serif}h1{font:italic 700 2rem/1.2 "Inter","Inter Fallback", serif}:root{--f: 'inter' ,"Inter Fallback";--g:Inter Tight,serif}p{font-family:Inter,"Inter Fallback"!important}code{font-family:"Inter","Inter Fallback",monospace}a{font-family:Arial}`);
  expect(withFallbackFamilies(css, [])).toBe(css);
});

test('a page whose early work the build left out (a branch its state closes at first) keeps its early file, and its fonts after the load', async () => {
  const { read } = await site({ body: '<main data-sn-state="{ open: false }"><button data-sn-on-click="open = !open">menu</button><template data-sn-if="open"><nav>menu</nav></template></main>' });
  const html = read('index.html'), l = linksOf(html);
  // the faces are deferred as on any page with an early file: the stylesheet in <noscript>, before the head scripts
  expect(l.fonts).not.toBeNull();
  expect(l.scripts).toHaveLength(2);
  expect(html.indexOf('<noscript data-sn-fonts=')).toBeLessThan(html.indexOf(l.scripts[0]!));
  expect(read(l.sheets[0]!)).not.toMatch(/swap-400-[\w-]+\.woff2/);
  // its own early file: the call of the loader (the head script's here, where every page has it), and nothing of the
  // branch (no anchor rendered, no state made)
  const own = read(l.scripts.find((x) => !/sinter-head-/.test(x))!);
  expect(l.scripts.map(read).join('')).toContain('sn-fonts');
  expect(own).toMatch(/fonts:\w+/);
  expect(own).not.toContain('.open');
  expect(own).toMatch(/scopes:\(\)=>\[\],render:\(\)=>\{\}/);
  // the branch's markup is at the end of the body, not in the head
  expect(html.slice(0, html.indexOf('</head>'))).not.toContain('<nav>menu</nav>');
});

test('a page that never had anything to run early has no head script, as before: its faces stay in its stylesheet', async () => {
  const { read } = await site({ body: '<main data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><p data-sn-text="n"></p></main>' });
  const l = linksOf(read('index.html'));
  expect(l.scripts).toEqual([]);
  expect(l.fonts).toBeNull();
  expect(read(l.sheets[0]!)).toMatch(/swap-400-[\w-]+\.woff2/);
});
