// @vitest-environment node
// The fixed size of an <img> from the page's stylesheets (src/compiler/layout.ts). Each case states
// what the cascade derives; with Playwright installed, the same pages are also laid out in
// Chromium, and every size the cascade claims must be the one the browser renders.
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Layout, evaluate } from '../../src/compiler/layout.js';
import { chromium } from '../browser.js';
import type { Page } from 'playwright';

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
  ['parent padding, content-box: the width is the content', 'div { width: 400px; padding: 10px } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', [400, null]],
  ['parent padding and border, border-box: less both', 'div { box-sizing: border-box; width: 300px; padding: 16px; border: 2px solid } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', [264, null]],
  ['logical padding and a border side', '* { box-sizing: border-box } div { width: 300px; padding-inline: 10px 20px; border-left: 0.25rem dashed red } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', [266, null]],
  ['four-value padding; a border width without a style draws nothing', '* { box-sizing: border-box } div { width: 300px; padding: 1px 12px 3px 8px; border-width: 9px } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', [140, null]],
  ['border: solid alone is medium (3px)', '* { box-sizing: border-box } div { width: 306px; border: solid } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', [300, null]],
  ['a longhand after the shorthand wins', '* { box-sizing: border-box } div { width: 300px; padding: 20px; padding-right: 0 } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', [280, null]],
  ['padding in %: not resolved', '* { box-sizing: border-box } div { width: 300px; padding: 5% } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
  ['padding from a media query: not resolved', '* { box-sizing: border-box } div { width: 300px } @media (min-width: 600px) { div { padding: 20px } } img { width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', 'fluid'],
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
  ['a border on the parent, content-box', '* { padding: 0; border: 0 solid } div { width: 300px; border: 1px solid } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', [150, null]],
  ['a border on the parent, border-box (Tailwind\'s reset)', '*, ::before { box-sizing: border-box; padding: 0; border: 0 solid } div { width: 300px; border-width: 1px } img { width: 50% }', '<div><img id="t" src="a.png" alt=""></div>', [149, null]],
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
    expect(derive(TEMPER, '<span data-avatar data-size="sm" data-sn-attr="{\'data-size\': s}"><img id="t" src="a.png" alt=""></span>')).toBe('fluid');
    // only the attributes a binding writes are uncertain: a bound `src` does not change `[data-avatar]`
    expect(derive(TEMPER, '<span data-avatar data-sn-attr="{title: t}"><img id="t" data-sn-attr="{src: c.photo}" alt=""></span>')).toEqual([40, 40]);
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


describe.skipIf(!chromium)('the browser renders what the cascade claims', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
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

/** [name, css, body, the bound of #t, the browser renders exactly the bound at 1600 px] */
const BOUNDS: Array<[string, string, string, number | null, boolean?]> = [
  ['a max-width container', 'main { max-width: 800px } img { max-width: 100% }', '<main><p><img id="t" src="a.png" width="2000" alt=""></p></main>', 800, true],
  ['rem, nested: the smaller wins', 'main { max-width: 75rem } article { max-width: 40rem } img { width: 100% }', '<main><article><img id="t" src="a.png" alt=""></article></main>', 640, true],
  ['through a link', 'main { max-width: 600px } img { max-width: 100% }', '<main><a href="#"><img id="t" src="a.png" width="2000" alt=""></a></main>', 600, true],
  ['a fixed column', '.col { width: 300px } img { width: 100% }', '<div class="col"><div><img id="t" src="a.png" alt=""></div></div>', 300, true],
  ['the width attribute', 'img { max-width: 100% }', '<div><img id="t" src="a.png" width="500" alt=""></div>', 500, true],
  ['no container: none', 'img { max-width: 100% }', '<div><img id="t" src="a.png" alt=""></div>', null],
  ['a % max-width container: none', 'main { max-width: 80% } img { max-width: 100% }', '<main><img id="t" src="a.png" alt=""></main>', null],
  ['an image that may overflow: only its own size', 'main { max-width: 600px }', '<main><img id="t" src="a.png" width="900" alt=""></main>', 900, true],
  ['negative margin between: not past it', 'main { max-width: 600px } .bleed { margin: 0 -40px } img { width: 100% }', '<main><div class="bleed"><img id="t" src="a.png" alt=""></div></main>', null],
  ['vw between: not past it', 'main { max-width: 600px } .full { width: 100vw } img { width: 100% }', '<main><div class="full"><img id="t" src="a.png" alt=""></div></main>', null],
  ['position: absolute between: not past it', 'main { max-width: 600px; position: relative } .abs { position: absolute; left: 0 } img { max-width: 100% }', '<main><div class="abs"><img id="t" src="a.png" width="2000" alt=""></div></main>', 2000],
  ['a media query on the container: not from it', 'main { max-width: 600px } @media (min-width: 1000px) { main { max-width: none } } body { max-width: 1400px } img { width: 100% }', '<main><img id="t" src="a.png" alt=""></main>', 1400, true],
  ['a position that may apply but stays in flow', 'main { max-width: 600px } article:has(.x) { position: relative } img { max-width: 100% }', '<main><article><img id="t" src="a.png" width="2000" alt=""></article></main>', 600, true],
  ['flex item', 'main { max-width: 700px; display: flex } img { max-width: 100% }', '<main><div><img id="t" src="a.png" width="3000" alt=""></div><p>x</p></main>', 700],
];

describe('the bound of a fluid image', () => {
  const bound = (css: string, body: string) => {
    const doc = parse5.parse(page('', body));
    return new Layout([{ file: 'test.css', css }], doc).maxWidth(find(doc, 't'));
  };
  for (const [name, css, body, want] of BOUNDS) test(name, () => expect(bound(css, body)).toBe(want));
});

describe.skipIf(!chromium)('the browser never renders a fluid image wider than its bound', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  for (const [name, css, body, want, exact] of BOUNDS) {
    if (want === null) continue;
    test(name, async () => {
      for (const width of [1600, 390]) {
        await tab.setViewportSize({ width, height: 800 });
        await tab.setContent(page(css, body.replaceAll('src="a.png"', `src="${IMG}"`)));
        const w = await tab.evaluate(() => document.getElementById('t')!.getBoundingClientRect().width);
        expect(w, `${name} at ${width}px`).toBeLessThanOrEqual(want + 0.5);
        if (exact && width === 1600) expect(w, `${name} at ${width}px`).toBeCloseTo(want, 0);
      }
    });
  }
});

/** [name, css, body (#t is measured), the `sizes` the cascade writes] */
const FLUID: Array<[string, string, string, string]> = [
  ['the browser\'s body margin, a max-width column', 'main { max-width: 800px } img { max-width: 100% }', '<main><img id="t" src="a.png" width="2000" alt=""></main>', '(max-width: 815.98px) calc(100vw - 16px), 800px'],
  ['a centered padded container', 'body { margin: 0 } * { box-sizing: border-box } .c { max-width: 1200px; margin: 0 auto; padding: 0 16px } img { width: 100% }', '<div class="c"><img id="t" src="a.png" alt=""></div>', '(max-width: 1199.98px) calc(100vw - 32px), 1168px'],
  ['a 3-column grid from 768 px, 2 from 480', 'body { margin: 0 } .g { display: grid; gap: 16px; padding: 0 24px } @media (min-width: 480px) { .g { grid-template-columns: repeat(2, 1fr) } } @media (min-width: 768px) { .g { grid-template-columns: repeat(3, minmax(0, 1fr)) } } img { width: 100% }', '<div class="g"><div><img id="t" src="a.png" alt=""></div><div></div><div></div></div>', '(max-width: 479.98px) calc(100vw - 48px), (max-width: 767.98px) calc(50vw - 32px), calc(33.33vw - 26.67px)'],
  ['auto-fill columns of at least 200 px, capped container', 'body { margin: 0 } .g { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; max-width: 900px } img { width: 100% }', '<div class="g"><figure style="margin: 0"><img id="t" src="a.png" alt=""></figure></div>', ''],
  ['a span across two tracks', 'body { margin: 0 } .g { display: grid; grid-template-columns: repeat(4, 1fr); column-gap: 10px } .w { grid-column: span 2 } img { width: 100% }', '<div class="g"><div class="w"><img id="t" src="a.png" alt=""></div></div>', 'calc(50vw - 5px)'],
  ['equal flex columns', 'body { margin: 0 } .r { display: flex; gap: 12px } .r > * { flex: 1 } img { width: 100% }', '<div class="r"><div><img id="t" src="a.png" alt=""></div><div></div><div></div></div>', 'calc(33.33vw - 8px)'],
  ['wrapped flex items with a basis, by breakpoint', 'body { margin: 0 } .r { display: flex; flex-wrap: wrap } .r > * { flex: 0 0 100% } @media (min-width: 640px) { .r > * { flex-basis: 50% } } img { width: 100% }', '<div class="r"><div><img id="t" src="a.png" alt=""></div></div>', '(max-width: 639.98px) 100vw, 50vw'],
  ['a fixed size per breakpoint', 'img.a { width: 40px } @media (min-width: 768px) { img.a { width: 64px } }', '<img id="t" class="a" src="a.png" alt="">', '(max-width: 767.98px) 40px, 64px'],
  ['negative margins (a full-bleed image in a padded column)', 'body { margin: 0 } main { padding: 0 20px } .bleed { margin: 0 -20px } img { width: 100% }', '<main><div class="bleed"><img id="t" src="a.png" alt=""></div></main>', '100vw'],
  ['clamp() and min() in the container', 'body { margin: 0 } .c { width: min(90vw, 70rem); margin-inline: auto } img { width: 100% }', '<div class="c"><img id="t" src="a.png" alt=""></div>', '(max-width: 77.7753em) 90vw, 70em'],
  ['an image narrower than its column: min(source, column)', 'body { margin: 0 } img { max-width: 100% }', '<div><img id="t" src="a.png" width="600" alt=""></div>', '(max-width: 599.98px) 100vw, 600px'],
  ['padding in em', 'main { padding: 0 2em } img { width: 100% }', '<main><img id="t" src="a.png" alt=""></main>', 'calc(100vw - 16px - 4em)'],
  ['a measure in em of its own font size', 'body { margin: 0 } .prose { font-size: 1.125rem; max-width: 40em; margin: 0 auto; padding: 0 1em } img { width: 100% }', '<article class="prose"><p><img id="t" src="a.png" alt=""></p></article>', '(max-width: 47.2475em) calc(100vw - 2.25em), 45em'],
  ['a sidebar track and a fr track, from a breakpoint', 'body { margin: 0 } .l { display: grid; gap: 24px } @media (min-width: 768px) { .l { grid-template-columns: 240px 1fr } } img { width: 100% }', '<div class="l"><nav></nav><main><img id="t" src="a.png" alt=""></main></div>', '(max-width: 767.98px) 100vw, calc(100vw - 264px)'],
  ['unequal fr tracks, the second item auto-placed', 'body { margin: 0 } .g { display: grid; grid-template-columns: 2fr 1fr; gap: 30px } img { width: 100% }', '<div class="g"><div></div><div><img id="t" src="a.png" alt=""></div></div>', 'calc(33.33vw - 10px)'],
  ['unequal tracks, the cursor wraps to the next row', 'body { margin: 0 } .g { display: grid; grid-template-columns: 1fr 3fr; gap: 20px } img { width: 100% }', '<div class="g"><div></div><div></div><div><img id="t" src="a.png" alt=""></div></div>', 'calc(25vw - 5px)'],
  ['unequal tracks, placed by lines', 'body { margin: 0 } .g { display: grid; grid-template-columns: 1fr 2fr 1fr; column-gap: 16px } .w { grid-column: 2 / -1 } img { width: 100% }', '<div class="g"><div class="w"><img id="t" src="a.png" alt=""></div></div>', 'calc(75vw - 8px)'],
  ['named areas, the main column first in the grid and last in the markup', 'body { margin: 0 } .l { display: grid } @media (min-width: 640px) { .l { grid-template-columns: 1fr 300px; grid-template-areas: "main side"; column-gap: 20px } .m { grid-area: main } .s { grid-area: side } } img { width: 100% }', '<div class="l"><aside class="s"></aside><main class="m"><img id="t" src="a.png" alt=""></main></div>', '(max-width: 639.98px) 100vw, calc(100vw - 320px)'],
  ['equal tracks, placed in the second column', 'body { margin: 0 } .g { display: grid; grid-template-columns: repeat(3, 1fr) } .b { grid-column: 2 } img { width: 100% }', '<div class="g"><div class="b"><img id="t" src="a.png" alt=""></div></div>', '33.33vw'],
  ['a flex row: a fixed sidebar and a growing main', 'body { margin: 0 } .r { display: flex; gap: 16px } .side { width: 200px; flex-shrink: 0 } .main { flex: 1; min-width: 0 } img { width: 100% }', '<div class="r"><nav class="side"></nav><main class="main"><img id="t" src="a.png" alt=""></main></div>', 'calc(100vw - 216px)'],
  ['a media object: an avatar column and a body that grows', '.m { display: flex; gap: 12px; padding: 12px; border: 1px solid } .av { flex: none; width: 48px } .b { flex: 1 } img { width: 100% }', '<div class="m"><div class="av"></div><div class="b"><img id="t" src="a.png" alt=""></div></div>', 'calc(100vw - 102px)'],
  ['flex items growing unequally from a basis', 'body { margin: 0 } .r { display: flex } .a { flex: 2 1 0 } .b { flex: 1 1 100px; padding: 0 10px; box-sizing: border-box } img { width: 100% }', '<div class="r"><div class="a"></div><div class="b"><img id="t" src="a.png" alt=""></div></div>', 'calc(33.33vw + 46.67px)'],
  ['a fixed share in a row that fits, no wrapping', 'body { margin: 0 } .r { display: flex } .r > * { flex: 0 0 50% } img { width: 100% }', '<div class="r"><div><img id="t" src="a.png" alt=""></div><div></div></div>', '50vw'],
];

/** [name, css, body, sizes]: ranges the build cannot follow (bound pieces), beside ones it does */
const BOUNDED: Array<[string, string, string, string]> = [
  ['a fixed sidebar that overflows the narrowest screens', 'body { margin: 0 } .r { display: flex; gap: 16px } .side { width: 280px; flex-shrink: 0 } .main { flex: 1; min-width: 0 } img { width: 100% }', '<div class="r"><nav class="side"></nav><main class="main"><img id="t" src="a.png" alt=""></main></div>', '(max-width: 295.98px) 100vw, calc(100vw - 296px)'],
  ['a label sized by its text on phones, a grid from 640 px', 'body { margin: 0 } .r { display: flex } .b { flex: 1 } @media (min-width: 640px) { .r { display: grid; grid-template-columns: 200px 1fr } } img { width: 100% }', '<div class="r"><span>label</span><div class="b"><img id="t" src="a.png" alt=""></div></div>', '(max-width: 639.98px) 100vw, calc(100vw - 200px)'],
  ['a bound from a container where the range is not followed', 'body { margin: 0 } main { max-width: 500px } .r { display: flex } .b { flex: 1 } @media (min-width: 900px) { main { max-width: none } .r { display: block } } img { width: 100% }', '<main><div class="r"><span>label</span><div class="b"><img id="t" src="a.png" alt=""></div></div></main>', '(max-width: 499.98px) 100vw, (max-width: 899.98px) 500px, 100vw'],
];

describe('the width of a fluid image at every viewport width', () => {
  const sizes = (css: string, body: string) => {
    const doc = parse5.parse(page('', body));
    return new Layout([{ file: 'test.css', css }], doc).fluidSizes(find(doc, 't'))?.sizes ?? null;
  };
  for (const [name, css, body, want] of FLUID) if (want) test(name, () => expect(sizes(css, body)).toBe(want));
  test('auto-fill: a split at every column count', () => {
    // 200 px columns and 20 px gaps: 2 from 420 px, 3 from 640, 4 from 860; the container stops at 900
    expect(sizes(FLUID[3]![1], FLUID[3]![2])).toBe('(max-width: 419.98px) 100vw, (max-width: 639.98px) calc(50vw - 10px), (max-width: 859.98px) calc(33.33vw - 13.33px), (max-width: 899.98px) calc(25vw - 15px), 210px');
  });
  test('given up: a column count from items rendered later, an unknown media feature, an em the build cannot know', () => {
    expect(sizes('.r { display: flex } .r > * { flex: 1 } img { width: 100% }', '<div class="r"><template><div><img id="t" src="a.png" alt=""></div></template></div>')).toBeNull();
    expect(sizes('img { width: 100% } @media (hover: hover) { img { width: 50% } }', '<div><img id="t" src="a.png" alt=""></div>')).toBeNull();
    // a font size in vw, or one a state may change, or a lone monospace (whose default the browsers scale)
    expect(sizes('main { font-size: 2vw; padding: 0 2em } img { width: 100% }', '<main><img id="t" src="a.png" alt=""></main>')).toBeNull();
    expect(sizes('main { padding: 0 2em } main:hover { font-size: 20px } img { width: 100% }', '<main><img id="t" src="a.png" alt=""></main>')).toBeNull();
    expect(sizes('main { font-family: monospace; padding: 0 2em } img { width: 100% }', '<main><img id="t" src="a.png" alt=""></main>')).toBeNull();
  });
  test('given up at every width: a content-sized track or sibling', () => {
    expect(sizes('.g { display: grid; grid-template-columns: auto 1fr } img { width: 100% }', '<div class="g"><div></div><div><img id="t" src="a.png" alt=""></div></div>')).toBeNull();
    expect(sizes('.r { display: flex } .b { flex: 1 } img { width: 100% }', '<div class="r"><span>label</span><div class="b"><img id="t" src="a.png" alt=""></div></div>')).toBeNull();
  });
  test('an auto-placed item whose column is not known: the widest it may land in', () => {
    const doc = parse5.parse(page('', '<div class="g"><template><div><img id="t" src="a.png" alt=""></div></template></div>'));
    const f = new Layout([{ file: 'test.css', css: 'body { margin: 0 } .g { display: grid; grid-template-columns: 1fr 2fr; gap: 30px } img { width: 100% }' }], doc).fluidSizes(find(doc, 't'))!;
    expect(f.sizes).toBe('calc(66.67vw - 20px)');
    expect(f.pieces.every((p) => p.bound === 'widest')).toBe(true);
    // a sibling placed by its row: the item lands in some column, the widest of which bounds it
    expect(sizes('body { margin: 0 } .g { display: grid; grid-template-columns: 1fr 3fr } .x { grid-row: 1 } img { width: 100% }', '<div class="g"><div class="x"></div><div><img id="t" src="a.png" alt=""></div></div>')).toBe('75vw');
  });
  test('a range not followed gets a bound there; the others stay exact', () => {
    const doc = parse5.parse(page('', BOUNDED[0]![2]));
    const f = new Layout([{ file: 'test.css', css: BOUNDED[0]![1] }], doc).fluidSizes(find(doc, 't'))!;
    expect(f.pieces.map((p) => p.bound ?? 'exact')).toEqual(['fallback', 'exact']);
    for (const [, css, body, want] of BOUNDED) expect(sizes(css, body)).toBe(want);
  });
});

describe.skipIf(!chromium)('the browser renders a fluid image as wide as its sizes say, at every viewport width', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const WIDTHS = [320, 375, 390, 479, 480, 600, 639, 640, 767, 768, 900, 1024, 1199, 1200, 1280, 1440, 1920];
  for (const [name, css, body] of FLUID) {
    test(name, async () => {
      const doc = parse5.parse(page('', body));
      const f = new Layout([{ file: 'test.css', css }], doc).fluidSizes(find(doc, 't'));
      expect(f).not.toBeNull();
      for (const v of WIDTHS) {
        const p = f!.pieces.find((x) => v >= x.from && v < x.to) ?? (v < f!.pieces[0]!.from ? f!.pieces[0]! : null);
        await tab.setViewportSize({ width: v, height: 600 });
        await tab.setContent(page(css, body.replaceAll('src="a.png"', `src="${IMG}"`)));
        const w = await tab.evaluate(() => document.getElementById('t')!.getBoundingClientRect().width);
        expect(w, `${name} at ${v} px (sizes ${f!.sizes})`).toBeCloseTo(p!.k * v + p!.c, 0);
      }
    });
  }
});

describe.skipIf(!chromium)('the browser never renders an image wider than a bound piece says, and exactly as wide as the others', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const WIDTHS = [240, 260, 295, 296, 320, 375, 480, 500, 639, 640, 768, 899, 900, 1280, 1920];
  const cases: Array<[string, string, string, string]> = [
    ...BOUNDED.map(([n, c, b]) => [n, c, b, b] as [string, string, string, string]),
    // the rows a list renders: each in its column, none wider than the widest
    ['rows of a list in unequal tracks', 'body { margin: 0 } .g { display: grid; grid-template-columns: 1fr 2fr; gap: 30px } img { width: 100% }',
      '<div class="g"><template><div><img id="t" src="a.png" alt=""></div></template></div>',
      '<div class="g"><div><img class="row" src="a.png" alt=""></div><div><img class="row" src="a.png" alt=""></div><div><img class="row" src="a.png" alt=""></div></div>'],
  ];
  for (const [name, css, body, rendered] of cases) {
    test(name, async () => {
      const doc = parse5.parse(page('', body));
      const f = new Layout([{ file: 'test.css', css }], doc).fluidSizes(find(doc, 't'))!;
      expect(f).not.toBeNull();
      for (const v of WIDTHS) {
        const p = f.pieces.find((x) => v >= x.from && v < x.to) ?? f.pieces[0]!;
        await tab.setViewportSize({ width: v, height: 600 });
        await tab.setContent(page(css, rendered.replaceAll('src="a.png"', `src="${IMG}"`)));
        const ws = await tab.evaluate(() => [...document.querySelectorAll('#t, .row')].map((e) => e.getBoundingClientRect().width));
        const said = p.k * v + p.c;
        for (const w of ws) {
          if (p.bound) expect(w, `${name} at ${v} px (sizes ${f.sizes})`).toBeLessThanOrEqual(said + 0.5);
          else expect(w, `${name} at ${v} px (sizes ${f.sizes})`).toBeCloseTo(said, 0);
        }
        if (p.bound === 'widest') expect(Math.max(...ws), `${name} at ${v} px: the widest row`).toBeCloseTo(said, 0);
      }
    });
  }
});

const PNG_URL = 'https://x.test/img.png';

describe.skipIf(!chromium)('at every default font size, the width the browser reads from sizes is the width it renders', () => {
  // the browser picks the smallest of 1 px steps at least as wide as `sizes` says (at 1x): that is how it reads `sizes`
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  let html = '';
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const STEPS = Array.from({ length: 3000 }, (_, i) => `https://x.test/w${i + 1}.png ${i + 1}w`).join(', ');
  beforeAll(async () => {
    browser = await chromium!.launch();
    tab = await browser.newPage({ deviceScaleFactor: 1 });
    await tab.route('https://x.test/**', (r) => (r.request().url().endsWith('/') ? r.fulfill({ contentType: 'text/html', body: html }) : r.fulfill({ contentType: 'image/png', body: PNG })));
  }, 30_000);
  afterAll(async () => { await browser?.close(); });
  const cases: Array<[string, string, string]> = [
    ...FLUID.filter(([, , , want]) => want).map(([n, c, b]) => [n, c, b] as [string, string, string]),
    ...BOUNDED.map(([n, c, b]) => [n, c, b] as [string, string, string]),
    ['a padded rem container with a body margin (ends that mix px and em)', '.c { max-width: 60rem; padding: 0 1rem; margin: 0 auto } img { width: 100% }', '<div class="c"><img id="t" src="a.png" alt=""></div>'],
    ['an em breakpoint, a rem gap, a page root of 62.5%', 'html { font-size: 62.5% } body { margin: 0 } .g { display: grid; gap: 2rem } @media (min-width: 40em) { .g { grid-template-columns: 1fr 1fr } } img { width: 100% }', '<div class="g"><div><img id="t" src="a.png" alt=""></div><div></div></div>'],
  ];
  for (const [name, css, body] of cases) {
    test(name, async () => {
      const doc = parse5.parse(page('', body));
      const f = new Layout([{ file: 'test.css', css }], doc).fluidSizes(find(doc, 't'))!;
      expect(f).not.toBeNull();
      const cdp = await tab.context().newCDPSession(tab);
      for (const font of [12, 16, 20, 24]) {
        await cdp.send('Page.setFontSizes', { fontSizes: { standard: font, fixed: Math.round((font * 13) / 16) } });
        for (const v of [320, 480, 700, 768, 1024, 1280, 1920]) {
          await tab.setViewportSize({ width: v, height: 600 });
          html = page(css, body.replaceAll('src="a.png"', `src="${PNG_URL}"`) + `<img id="probe" style="position: absolute; width: 1px" sizes="${f.sizes}" srcset="${STEPS}" alt="">`);
          await tab.goto('https://x.test/');
          const [w, said] = await tab.evaluate(() => [document.getElementById('t')!.getBoundingClientRect().width, Number((document.getElementById('probe') as HTMLImageElement).currentSrc.replace(/.*\/w|\.png/g, ''))]);
          const bound = f.pieces.some((p) => p.bound);
          const msg = `${name} at ${v} px, default font ${font} px (sizes ${f.sizes}): rendered ${w}, sizes ${said}`;
          if (bound) expect(said, msg).toBeGreaterThanOrEqual(w - 1);
          else expect(Math.abs(said - w), msg).toBeLessThanOrEqual(1);
          // a browser that cannot read min()/max() in sizes skips those entries: what follows is the 16 px answer
          if (font === 16 && /\b(min|max)\(/.test(f.sizes)) {
            html = html.replace(`sizes="${f.sizes}"`, `sizes="${f.sizes.replace(/\b(min|max)\(/g, 'unknown-fn(')}"`);
            await tab.goto('https://x.test/');
            const old = await tab.evaluate(() => Number((document.getElementById('probe') as HTMLImageElement).currentSrc.replace(/.*\/w|\.png/g, '')));
            if (bound) expect(old, `${msg}, without min()/max()`).toBeGreaterThanOrEqual(w - 1);
            else expect(Math.abs(old - w), `${msg}, without min()/max(): ${old}`).toBeLessThanOrEqual(1);
          }
        }
      }
      await cdp.detach();
    }, 60_000);
  }
});

describe.skipIf(!chromium)('an unbounded auto-fill grid: exact while columns are few, then within 15% and never narrower than it is', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  test('repeat(auto-fill, minmax(200px, 1fr)), gap 16px', async () => {
    const css = 'body { margin: 0 } .g { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px } img { width: 100% }';
    const body = '<div class="g"><div><img id="t" src="a.png" alt=""></div></div>';
    const doc = parse5.parse(page('', body));
    const f = new Layout([{ file: 'test.css', css }], doc).fluidSizes(find(doc, 't'))!;
    expect(f.pieces.length).toBeLessThan(10);
    for (const v of [320, 415, 416, 631, 632, 900, 1280, 1500, 1711, 1712, 1920, 2200, 2560, 3000]) {
      const p = f.pieces.find((x) => v >= x.from && v < x.to) ?? f.pieces[0]!;
      await tab.setViewportSize({ width: v, height: 600 });
      await tab.setContent(page(css, body.replace('src="a.png"', `src="${IMG}"`)));
      const w = await tab.evaluate(() => document.getElementById('t')!.getBoundingClientRect().width);
      const said = p.k * v + p.c;
      if (v < 1712) expect(w, `at ${v} px`).toBeCloseTo(said, 0);
      else { expect(w, `at ${v} px`).toBeLessThanOrEqual(said + 0.5); expect(said / w, `at ${v} px`).toBeLessThanOrEqual(1.15); }
    }
  });
});
