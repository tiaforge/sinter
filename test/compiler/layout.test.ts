// @vitest-environment node
// The fixed size of an <img> from the page's stylesheets (src/compiler/layout.ts). Each case states
// what the cascade derives; with Playwright installed, the same pages are also laid out in
// Chromium, and every size the cascade claims must be the one the browser renders.
import { createRequire } from 'node:module';
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Layout, evaluate } from '../../src/compiler/layout.js';

type El = DefaultTreeAdapterMap['element'];

/** temper's avatar rules (core.css), as an app loads them */
const TEMPER = `@layer tm.reset, tm.base, tm.components, tm.layout;
@layer tm.reset { :where(*, ::before, ::after) { box-sizing: border-box; margin: 0; } :where(img, svg, video, canvas, picture) { display: block; max-inline-size: 100%; } }
@layer tm.base { :where([data-size="sm"]) { --_size: 0.8; } :where([data-size="lg"]) { --_size: 1.2; } }
@layer tm.components {
  :where([data-avatar]) { --_av: calc(var(--tm-avatar-size, 2.5rem) * var(--_size, 1)); display: inline-grid; place-items: center; flex-shrink: 0; inline-size: var(--_av); block-size: var(--_av); border-radius: 50%; overflow: hidden; }
  :where([data-avatar]) > :where(img) { inline-size: 100%; block-size: 100%; object-fit: cover; }
}`;

/** [name, css, body (the <img id="t"> is measured), expected: [width, height | null] | 'fluid' | null, the browser may render it narrower (a % max-width)] */
const CASES: Array<[string, string, string, [number, number | null] | 'fluid' | null, boolean?]> = [
  ['temper avatar', TEMPER, '<span data-avatar><img id="t" src="a.png" alt=""></span>', [40, 40]],
  ['temper avatar, sm', TEMPER, '<span data-avatar data-size="sm"><img id="t" src="a.png" alt=""></span>', [32, 32]],
  ['temper avatar, lg in a list', TEMPER, '<ul data-size="lg"><li><span data-avatar><img id="t" src="a.png" alt=""></span></li></ul>', [48, 48]],
  ['temper avatar, app size', TEMPER + ':root { --tm-avatar-size: 3rem }', '<span data-avatar><img id="t" src="a.png" alt=""></span>', [48, 48]],
  ['temper plain img: not sized', TEMPER, '<img id="t" src="a.png" alt="">', null],
  ['px width', 'img { width: 200px }', '<img id="t" src="a.png" alt="">', [200, null]],
  ['rem, aspect-ratio', '.card img { inline-size: 12rem; aspect-ratio: 1; object-fit: cover }', '<div class="card"><img id="t" src="a.png" alt=""></div>', [192, 192]],
  ['root font size', 'html { font-size: 20px } img { width: 10rem }', '<img id="t" src="a.png" alt="">', [200, null]],
  ['later layer wins', '@layer a, b; @layer b { img { width: 100px } } @layer a { img { width: 300px } }', '<img id="t" src="a.png" alt="">', [100, null]],
  ['unlayered wins', 'img { width: 120px } @layer a { #t { width: 300px } }', '<img id="t" src="a.png" alt="">', [120, null]],
  ['!important in an earlier layer wins', '@layer a, b; @layer a { img { width: 80px !important } } @layer b { img { width: 300px !important } } img { width: 10px }', '<img id="t" src="a.png" alt="">', [80, null]],
  ['specificity', '#t { width: 90px } img.x { width: 300px }', '<img id="t" class="x" src="a.png" alt="">', [90, null]],
  [':is specificity, :where none', ':is(#t, img) { width: 70px } :where(#t) { width: 300px } img { width: 20px }', '<img id="t" src="a.png" alt="">', [70, null]],
  ['inline style wins', 'img { width: 300px }', '<img id="t" src="a.png" style="width: 150px" alt="">', [150, null]],
  ['% of a fixed parent', 'div { width: 400px } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', [200, null]],
  ['% of a fluid parent', 'img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
  ['% of an inline parent', 'span { width: 400px } img { width: 50% }', '<span><img id="t" src="a.png" alt=""></span>', 'fluid'],
  ['parent padding: not resolved', 'div { width: 400px; padding: 10px } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
  ['media query', 'img { width: 100px } @media (min-width: 600px) { img { width: 300px } }', '<img id="t" src="a.png" alt="">', 'fluid'],
  ['media query that loses', 'img { width: 100px !important } @media (min-width: 600px) { img { width: 300px } }', '<img id="t" src="a.png" alt="">', [100, null]],
  ['state', 'img { width: 100px } img:hover { width: 300px }', '<img id="t" src="a.png" alt="">', 'fluid'],
  ['unknown pseudo-class that cannot win', 'img:hover { width: 300px } #t { width: 100px }', '<img id="t" src="a.png" alt="">', [100, null]],
  ['vw', 'img { width: 30vw }', '<img id="t" src="a.png" alt="">', 'fluid'],
  ['calc, var, clamp', ':root { --s: 50px } img { width: clamp(100px, calc(var(--s) * 3), 400px) }', '<img id="t" src="a.png" alt="">', [150, null]],
  ['min with px', 'img { width: min(300px, 12.5rem) }', '<img id="t" src="a.png" alt="">', [200, null]],
  ['missing var without fallback', 'img { width: var(--nope) }', '<img id="t" src="a.png" alt="">', 'fluid'],
  ['nesting', '.a { & img { width: 64px } }', '<div class="a"><img id="t" src="a.png" alt=""></div>', [64, null]],
  ['nesting without &', '.a { img { width: 66px } }', '<div class="a"><img id="t" src="a.png" alt=""></div>', [66, null]],
  ['nth-child', 'img { width: 10px } img:nth-child(2n) { width: 60px }', '<div><img src="a.png" alt=""><img id="t" src="a.png" alt=""></div>', [60, null]],
  ['sibling', 'img { width: 10px } p + img { width: 61px }', '<div><p>x</p><img id="t" src="a.png" alt=""></div>', [61, null]],
  ['attribute operators', 'img { width: 10px } [data-k$=".png" i][alt~="b"] { width: 62px }', '<img id="t" src="a.png" data-k="A.PNG" alt="a b">', [62, null]],
  ['max-width: 100% may shrink it', 'img { width: 2000px; max-width: 100% }', '<img id="t" src="a.png" alt="">', [2000, null], true],
  ['absolute max-width', 'img { width: 500px; max-width: 300px }', '<img id="t" src="a.png" alt="">', [300, null]],
  ['height fixed', 'img { width: 100px; height: 50px }', '<img id="t" src="a.png" alt="">', [100, 50]],
  ['height % of a fluid parent', 'img { width: 100px; height: 50% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
  ['flex with siblings', 'div { display: flex; width: 400px } img { width: 100% }', '<div><img id="t" src="a.png" alt=""><p>x</p></div>', 'fluid'],
  [':host never matches in the page', ':root, :host { --s: 30px } img { width: var(--s) }', '<img id="t" src="a.png" alt="">', [30, null]],
  ['escaped class names', '.w-\\[72px\\] { width: 72px } .md\\:x { width: 1px }', '<img id="t" class="w-[72px]" src="a.png" alt="">', [72, null]],
  ['a reset\'s zero padding and border on the parent', '* { padding: 0; border: 0 solid } div { width: 300px } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', [150, null]],
  ['a border on the parent', '* { padding: 0; border: 0 solid } div { width: 300px; border: 1px solid } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
  ['grid with tracks', 'div { display: grid; grid-template-columns: 1fr 1fr; width: 400px } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
];

const page = (css: string, body: string) => `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;

function find(doc: DefaultTreeAdapterMap['document'], id: string): El {
  const walk = (n: DefaultTreeAdapterMap['parentNode']): El | null => {
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue;
      if (c.attrs.some((a) => a.name === 'id' && a.value === id)) return c;
      const r = walk(c.tagName === 'template' ? (c as DefaultTreeAdapterMap['template']).content : c);
      if (r) return r;
    }
    return null;
  };
  return walk(doc)!;
}

function derive(css: string, body: string) {
  const doc = parse5.parse(page('', body));
  const b = new Layout([{ file: 'test.css', css }], doc).box(find(doc, 't'));
  return b === null || b === 'fluid' ? b : [b.width, b.height] as [number, number | null];
}

describe('the cascade', () => {
  for (const [name, css, body, want] of CASES) test(name, () => expect(derive(css, body)).toEqual(want));

  test('object-fit and object-position, and whether they are inline', () => {
    const doc = parse5.parse(page('', '<span data-avatar><img id="t" src="a.png" style="object-position: top" alt=""></span>'));
    expect(new Layout([{ file: 't.css', css: TEMPER }], doc).box(find(doc, 't'))).toEqual({ width: 40, height: 40, fit: 'cover', position: 'top', inlineFit: false });
  });

  test('inside a template, the template\'s parent is the parent; structural selectors may or may not match', () => {
    expect(derive(TEMPER, '<ul data-size="sm"><template><li><span data-avatar><img id="t" src="a.png" alt=""></span></li></template></ul>')).toEqual([32, 32]);
    expect(derive('img { width: 10px } li:first-child img { width: 60px }', '<ul><template><li><img id="t" src="a.png" alt=""></li></template></ul>')).toBe('fluid');
  });

  test('bindings can change classes, attributes and styles: what they could change is not known', () => {
    expect(derive('img { width: 10px } .big img { width: 60px }', '<div data-sn-class="{big: x}"><img id="t" src="a.png" alt=""></div>')).toBe('fluid');
    expect(derive(TEMPER, '<span data-avatar data-sn-style="{\'--_size\': s}"><img id="t" src="a.png" alt=""></span>')).toBe('fluid');
    expect(derive(TEMPER, '<span data-avatar data-sn-attr="{\'data-size\': s}"><img id="t" src="a.png" alt=""></span>')).toBe('fluid');
  });

  test('evaluate', () => {
    expect(evaluate('calc(2.5rem * 0.8)', { rem: 16, percent: 0 })).toBe(32);
    expect(evaluate('calc(100% - 2rem)', { rem: 16, percent: 400 })).toBe(368);
    expect(evaluate('max(10px, 2rem, 5%)', { rem: 16, percent: 1000 })).toBe(50);
    expect(evaluate('auto', { rem: 16, percent: 0 })).toBeNull();
    expect(evaluate('2', { rem: 16, percent: 0 })).toBeNull();
    expect(evaluate('10px / 0', { rem: 16, percent: 0 })).toBeNull();
  });
});

// ---- the same cases, laid out by Chromium

let chromium: { launch(): Promise<{ newPage(o?: object): Promise<BrowserPage>; close(): Promise<void> }> } | null = null;
interface BrowserPage { setContent(html: string): Promise<void>; setViewportSize(s: { width: number; height: number }): Promise<void>; evaluate<T>(fn: () => T): Promise<T> }
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch { /* not installed: the browser check is skipped */ }

describe.skipIf(!chromium)('the browser renders what the cascade claims', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: BrowserPage;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  // a 1×1 image, so an unsized image has a size of its own that differs from every claim
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  for (const [name, css, body, want, shrinks] of CASES) {
    if (!Array.isArray(want)) continue;
    test(name, async () => {
      for (const width of [1600, 390]) {
        await tab.setViewportSize({ width, height: 800 });
        await tab.setContent(page(css, body.replaceAll('src="a.png"', `src="${IMG}"`).replace(/<template>([\s\S]*)<\/template>/, '$1')));
        const r = await tab.evaluate(() => { const b = document.getElementById('t')!.getBoundingClientRect(); return [b.width, b.height]; });
        if (shrinks && width < want[0]) { expect(r[0]).toBeLessThanOrEqual(want[0]); continue; }
        expect(r[0], `${name} at ${width}px`).toBeCloseTo(want[0], 0);
        if (want[1] !== null) expect(r[1], `${name} at ${width}px`).toBeCloseTo(want[1], 0);
      }
    });
  }
});
