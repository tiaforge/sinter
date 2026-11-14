// @vitest-environment node
// The space a list's rows take before its data arrives (Layout.reserve in src/compiler/layout.ts):
// a placeholder that is never taller than the rows that replace it, and exactly as tall where the
// stylesheets fix the rows' height. With Playwright installed, every case is also laid out in
// Chromium: the placeholder against the real rows, each bound text one line.
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Layout, PLACEHOLDER_BASE, type Reserved } from '../../src/compiler/layout.js';
import { chromium } from '../browser.js';
import type { Page } from 'playwright';

type El = DefaultTreeAdapterMap['element'];

/**
 * [name, css, body (the list is `<template id="t">`), rows, the placeholder's height at 1280 px and at
 * 390 px (null: no placeholder), how close: `exact` the stylesheets fix it (`Reserved.exact`), `tight`
 * one-line rows are as tall, `bound` the rows may be taller]
 */
type Fit = 'exact' | 'tight' | 'bound';
const CASES: Array<[string, string, string, number, [number, number] | null, Fit]> = [
  ['fixed height, a border', '.row { height: 56px; border-bottom: 1px solid }', '<ul><template id="t"><li class="row" data-sn-text="r.name"></li></template></ul>', 12, [684, 684], 'exact'],
  ['fixed height, border-box', '* { box-sizing: border-box } .row { height: 56px; padding: 8px; border-bottom: 1px solid }', '<ul><template id="t"><li class="row" data-sn-text="r.name"></li></template></ul>', 10, [560, 560], 'exact'],
  ['margins between rows collapse', 'ul { margin: 0; padding: 0 } .row { height: 40px; margin: 10px 0 }', '<ul><template id="t"><li class="row"></li></template></ul>', 5, [240, 240], 'exact'],
  ['a flex column with a gap', 'ul { display: flex; flex-direction: column; gap: 8px } li { height: 30px; margin-bottom: 2px }', '<ul><template id="t"><li></li></template></ul>', 4, [152, 152], 'exact'],
  ['a grid of fixed rows', '.g { display: grid; grid-template-columns: repeat(3, 1fr); grid-auto-rows: 100px; gap: 10px }', '<div class="g"><template id="t"><div class="card" data-sn-text="r.name"></div></template></div>', 7, [320, 320], 'exact'],
  ['an auto-fill grid: columns follow the width', 'body { margin: 0 } .g { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 20px; max-width: 1000px } .card { height: 120px }', '<div class="g"><template id="t"><div class="card"></div></template></div>', 12, [400, 820], 'exact'],
  ['one line of text, explicit line height', 'ul { padding: 0 } .row { padding: 8px; line-height: 24px }', '<ul><template id="t"><li class="row" data-sn-text="r.name"></li></template></ul>', 6, [240, 240], 'tight'],
  ['a heading and a paragraph', 'h3 { font-size: 20px; line-height: 1.2; margin: 0 0 4px } p { margin: 0; line-height: 1.5 } article { padding: 12px 0; border-top: 1px solid #ccc }',
    '<div><template id="t"><article><h3 data-sn-text="r.title"></h3><p data-sn-text="r.text"></p></article></template></div>', 3, [3 * (24 + 4 + 24 + 24 + 1), 3 * (24 + 4 + 24 + 24 + 1)], 'tight'],
  ['em and the font shorthand', '.row { font: 600 20px/1.2 sans-serif; padding: 0.5em 0 }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 4, [4 * (24 + 20), 4 * (24 + 20)], 'tight'],
  ['an avatar beside the text', '.row { display: flex; gap: 8px; align-items: center; padding: 4px 0 } img { width: 40px; height: 40px } .row span { line-height: 20px }',
    '<div><template id="t"><div class="row"><img src="a.png" alt=""><span data-sn-text="r.name"></span></div></template></div>', 5, [5 * 48, 5 * 48], 'tight'],
  // no family: the browser's default, serif, whose default on macOS (Times) the table counts as 1: 16 px less the rounded pixel
  ['line-height normal: the default font', '.row { font-size: 16px }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 5, [75, 75], 'bound'],
  // system-ui: the least of Segoe UI, San Francisco, Roboto, Cantarell, Ubuntu (1.121), DejaVu Sans, Noto Sans
  ['line-height normal: system-ui on every platform', '.row { font: 20px system-ui }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 2, [2 * (20 * (932 + 189) / 1000 - 1), 2 * (20 * (932 + 189) / 1000 - 1)], 'bound'],
  // a named system font, then the generic family: either may render it
  ['line-height normal: a stack, each face counted', '.row { font: 20px Verdana, Tahoma, sans-serif }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 2, [2 * 19, 2 * 19], 'bound'],
  // a family the build has no metrics for (a web font from a stylesheet it does not read, a locally installed font): 1
  ['line-height normal: a family without metrics counts as 1', '.row { font: 20px "Brand Sans", system-ui }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 2, [2 * 19, 2 * 19], 'bound'],
  ['rows side by side, a width of their own', 'ul { display: flex; gap: 10px; padding: 0 } li { width: 40px; height: 40px; margin: 0 2px }', '<ul><template id="t"><li></li></template></ul>', 6, [40, 40], 'exact'],
  ['a wrapping row of chips: rows per line from the container', 'body { margin: 0 } .chips { display: flex; flex-wrap: wrap; gap: 8px; max-width: 600px } .chip { width: 92px; height: 30px }',
    '<div class="chips"><template id="t"><span class="chip"></span></template></div>', 12, [2 * 30 + 8, 4 * 30 + 3 * 8], 'exact'],
  ['a branch inside the row counts as nothing', '.row { line-height: 20px }', '<div><template id="t"><div class="row"><span data-sn-text="r.name"></span><template data-sn-if="r.note"><p>note</p></template></div></template></div>', 3, [60, 60], 'bound'],
  ['a height per media query', '.row { height: 40px } @media (min-width: 600px) { .row { height: 60px } }', '<div><template id="t"><div class="row"></div></template></div>', 3, [180, 120], 'exact'],
  ['a font size in vw: its least in each range', 'body { margin: 0 } .row { font-size: 4vw; line-height: 1 }', '<div><template id="t"><div class="row" data-sn-text="r.name"></div></template></div>', 2, [2 * 0.04 * 240, 2 * 0.04 * 240], 'bound'],
  ['rows side by side: not followed', 'ul { display: flex } li { height: 30px }', '<ul><template id="t"><li></li></template></ul>', 4, null, 'bound'],
  ['absolute rows: not followed', 'li { position: absolute; height: 30px }', '<ul><template id="t"><li></li></template></ul>', 4, null, 'bound'],
  ['a grid with other items first: not followed', '.g { display: grid; grid-template-columns: 1fr 1fr } .g > * { height: 30px }', '<div class="g"><div>first</div><template id="t"><div></div></template></div>', 4, null, 'bound'],
  ['inline rows: not followed', 'span { line-height: 20px }', '<p><template id="t"><span data-sn-text="r.name"></span></template></p>', 4, null, 'bound'],
  ['two elements per row: not followed', '.a { height: 20px }', '<div><template id="t"><div class="a"></div><div class="a"></div></template></div>', 4, null, 'bound'],
];

/** [name, css, body, rows]: layouts where the space is a lower bound well below the rows; Chromium checks it is never above */
const BELOW: Array<[string, string, string, number]> = [
  ['a fluid image (Tailwind\'s reset), its attributes shrunk to the width it has', 'img { max-width: 100%; height: auto } ul { padding: 0 } li { list-style: none }', '<ul><template id="t"><li><img src="a.png" width="800" height="600" alt=""></li></template></ul>', 6],
  ['a flex row with smaller text: the item\'s own line height', 'body { font: 16px/1.5 Arial } ul { padding: 0 } li { display: flex } .meta { font-size: 12px }', '<ul><template id="t"><li><span class="meta" data-sn-text="r.x"></span></li></template></ul>', 6],
  ['a grid row with <small>', 'body { font: 16px/1.5 Arial } ul { padding: 0 } li { display: grid }', '<ul><template id="t"><li><small data-sn-text="r.x"></small></li></template></ul>', 6],
  ['a button in a flex row: the control\'s own font and line height', 'body { font: 16px/1.6 Arial } ul { padding: 0 } li { display: flex; align-items: center }', '<ul><template id="t"><li><button>Delete</button></li></template></ul>', 6],
  ['a select in a flex row', 'body { font: 16px/1.6 Arial } ul { padding: 0 } li { display: flex }', '<ul><template id="t"><li><select><option>One</option></select></li></template></ul>', 6],
  ['a block <code>: the smaller monospace default', 'ul { padding: 0 } li { display: flex } code { display: block }', '<ul><template id="t"><li><code data-sn-text="r.x"></code></li></template></ul>', 6],
  ['a closed <details>: its summary only', 'ul { padding: 0 } li { line-height: 20px }', '<ul><template id="t"><li><details><summary data-sn-text="r.x"></summary><p>one</p><p>two</p><p>three</p></details></li></template></ul>', 5],
  ['a negative margin in a flex row', 'ul { padding: 0 } li { display: flex } .a { height: 50px; margin-bottom: -20px }', '<ul><template id="t"><li><div class="a"></div></li></template></ul>', 6],
  ['a negative margin on an inline block', 'ul { padding: 0 } li { line-height: 20px } .a { display: inline-block; height: 60px; margin-bottom: -30px }', '<ul><template id="t"><li><span class="a"></span></li></template></ul>', 6],
];

const page = (css: string, body: string) => `<!doctype html><html><head><style>${css}</style></head><body>${body}<div id="after">after</div></body></html>`;

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

function reserve(css: string, body: string, rows: number): Reserved | null {
  const doc = parse5.parse(page('', body));
  return new Layout([{ file: 'test.css', css }], doc).reserve(find(doc, 't'), rows);
}

/** the placeholder's rule at a viewport width */
const ruleAt = (r: Reserved, width: number) => [...r.pieces].reverse().find((p) => p.from <= width)!.decls;
const heightAt = (r: Reserved, width: number) => Number(/height:([\d.]+)px/.exec(ruleAt(r, width))![1]);

describe('the space of a list\'s rows', () => {
  for (const [name, css, body, rows, want, fit] of CASES) test(name, () => {
    const r = reserve(css, body, rows);
    if (!want) return expect(r).toBeNull();
    expect(r).not.toBeNull();
    expect(heightAt(r!, 1280)).toBeCloseTo(want[0], 1);
    expect(heightAt(r!, 390)).toBeCloseTo(want[1], 1);
    expect(r!.exact).toBe(fit === 'exact');
  });

  test('rows side by side: the placeholder is as wide as the rows', () => {
    const r = reserve('ul { display: flex; gap: 10px } li { width: 40px; height: 40px; margin: 0 2px }', '<ul><template id="t"><li></li></template></ul>', 6)!;
    expect(ruleAt(r, 1280)).toContain('width:314px');
  });

  test('in a box as wide as its content: rows of a width of their own get a placeholder as wide, others none', () => {
    const css = '.row { display: flex; flex-wrap: wrap } .card { width: 300px; height: 80px; margin: 0 0 10px }';
    const doc = (body: string) => parse5.parse(page('', body));
    const d1 = doc('<div class="row"><div><template id="t"><div class="card"></div></template></div><aside>x</aside></div>');
    const r = new Layout([{ file: 't.css', css }], d1).reserve(find(d1, 't'), 3, { sized: true })!;
    expect(ruleAt(r, 1280)).toContain('width:300px');
    expect(heightAt(r, 1280)).toBe(260);
    const d2 = doc('<div class="row"><div><template id="t"><p class="text"></p></template></div><aside>x</aside></div>');
    expect(new Layout([{ file: 't.css', css: css + ' .text { line-height: 20px }' }], d2).reserve(find(d2, 't'), 3, { sized: true })).toBeNull();
  });

  test('in a list, an <li>; elsewhere a <div>', () => {
    expect(reserve('li { height: 10px }', '<ol><template id="t"><li></li></template></ol>', 2)!.tag).toBe('li');
    expect(reserve('p { height: 10px }', '<section><template id="t"><p></p></template></section>', 2)!.tag).toBe('div');
  });

  test('a grid placeholder spans the rows the items fill, over every column', () => {
    const r = reserve('.g { display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 50px }', '<div class="g"><template id="t"><div></div></template></div>', 9)!;
    expect(ruleAt(r, 1280)).toContain('grid-row:span 3');
    expect(ruleAt(r, 1280)).toContain('grid-column:1/-1');
  });

  test('not followed: a wrapping row whose basis is not its width, rows that skip their layout', () => {
    expect(reserve('ul { display: flex; flex-wrap: wrap } li { width: 300px; flex: 0 0 100px; height: 50px }', '<ul><template id="t"><li></li></template></ul>', 6)).toBeNull();
    expect(reserve('li { height: 50px; content-visibility: auto }', '<ul><template id="t"><li></li></template></ul>', 6)).toBeNull();
  });

  test('in a <p>, a <span> (a <div> would close the paragraph)', () => {
    expect(reserve('.r { display: block; height: 20px }', '<p><template id="t"><span class="r"></span></template></p>', 2)!.tag).toBe('span');
  });

  test('a row whose height a binding may change is not exact', () => {
    expect(reserve('.row { height: 40px } .big { height: 80px }', '<div><template id="t"><div class="row" data-sn-class="{big: r.big}"></div></template></div>', 2)?.exact ?? false).toBe(false);
  });
});

/** [name, css, body, the box whose width follows the list's content (its id), and whether others move with it] */
const SIZED: Array<[string, string, string, string | null, boolean]> = [
  ['a flex item without a basis, beside another', '.row { display: flex; flex-wrap: wrap }', '<div class="row"><div id="c"><template id="t"><p></p></template></div><div>side</div></div>', 'c', true],
  ['the grid system of RealWorld\'s theme: a basis only from 768 px', '.row { display: flex; flex-wrap: wrap } @media (min-width: 768px) { .col { flex: 0 0 75% } .side { flex: 0 0 25% } }',
    '<div class="row"><div class="col" id="c"><template id="t"><p></p></template></div><div class="side">side</div></div>', 'c', true],
  ['a flex item that grows from 0', '.row { display: flex } .row > div { flex: 1 1 0 }', '<div class="row"><div><template id="t"><p></p></template></div><div>side</div></div>', null, false],
  ['a flex item with a width', '.row { display: flex } .col { width: 100% }', '<div class="row"><div class="col"><template id="t"><p></p></template></div><div>side</div></div>', null, false],
  ['a block in a block', 'main { max-width: 800px }', '<main><section><template id="t"><p></p></template></section></main>', null, false],
  ['a float', '.f { float: left }', '<div class="f" id="c"><template id="t"><p></p></template></div><p>beside</p>', 'c', true],
  ['inside a stretched column item: up to the row', '.row { display: flex } .col { display: flex; flex-direction: column }', '<div class="row"><div class="col" id="c"><div><template id="t"><p></p></template></div></div><div>side</div></div>', 'c', true],
];

describe('the box whose width a list\'s rows decide', () => {
  for (const [name, css, body, want, siblings] of SIZED) test(name, () => {
    const doc = parse5.parse(page('', body));
    const r = new Layout([{ file: 'test.css', css }], doc).contentSized(find(doc, 't'));
    if (!want) return expect(r).toBeNull();
    expect(r?.el.attrs.find((a) => a.name === 'id')?.value).toBe(want);
    expect(r?.siblings).toBe(siblings);
  });
});

// ---- the same cases, laid out by Chromium

describe.skipIf(!chromium)('the browser: the placeholder is never taller than the rows, and as tall where exact', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  /** where `#after` is: below the rows (each bound text one word), or below the placeholder */
  const after = async (css: string, body: string, list: string) => {
    await tab.setContent(page(css, body.replace(/<template id="t">[\s\S]*<\/template>(?=<\/(ul|ol|div|section|p)>$)/, list)));
    return tab.evaluate(() => document.getElementById('after')!.getBoundingClientRect().top);
  };
  for (const [name, css, body, rows, want, fit] of [...CASES, ...BELOW.map(([n, c, b, r]) => [n, c, b, r, [0, 0], 'bound'] as const)]) {
    if (!want) continue;
    test(name, async () => {
      const r = reserve(css, body, rows)!;
      const row = /<template id="t">([\s\S]*)<\/template>/.exec(body)![1]!
        .replace(/<template data-sn-if[\s\S]*?<\/template>/g, '')
        .replace(/(<(\w+)[^>]*data-sn-text="[^"]*"[^>]*>)(<\/\2>)/g, '$1Word$3')
        .replaceAll('src="a.png"', `src="${IMG}"`);
      const rules = `.ph { ${PLACEHOLDER_BASE} }\n` + r.pieces.map((p) => (p.from ? `@media (min-width: ${p.from}px) { .ph.ph { ${p.decls} } }` : `.ph.ph { ${p.decls} }`)).join('\n');
      for (const width of [1280, 390]) {
        await tab.setViewportSize({ width, height: 900 });
        const real = await after(css, body, row.repeat(rows));
        const held = await after(css + rules, body, `<${r.tag} class="ph"></${r.tag}>`);
        expect(held, `${name} at ${width}px: not taller than the rows`).toBeLessThanOrEqual(real + 0.5);
        if (fit !== 'bound') expect(held, `${name} at ${width}px: as tall`).toBeCloseTo(real, 0);
      }
    });
  }
});
