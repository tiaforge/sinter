// @vitest-environment node
// A differential test of the reserved space (Layout.reserve, docs/first-paint.md#reserved-space): random
// lists from a small grammar of the CSS the build follows, laid out in Chromium, the placeholder against
// the rows. It must never be taller, at any width and default font size tried. Fixed seeds, so a failure
// names its case; SINTER_FUZZ=<n> runs n cases instead of the default, SINTER_FUZZ_SEED another start.
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Layout, PLACEHOLDER_BASE } from '../../src/compiler/layout.js';
import { chromium } from '../browser.js';
import type { CDPSession, Page } from 'playwright';

type El = DefaultTreeAdapterMap['element'];
const N = Number(process.env.SINTER_FUZZ ?? 60), SEED = Number(process.env.SINTER_FUZZ_SEED ?? 1);

/** mulberry32: a small seeded generator */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const maybe = (p: number) => next() < p;
  return { next, pick, maybe };
}

const LEN = ['0', '2px', '4px', '8px', '12px', '0.5em', '1em', '0.25rem', '1rem'];
const FAMILIES = ['Arial', 'system-ui', 'serif', 'monospace', 'Georgia', '"DejaVu Sans", sans-serif', 'Helvetica, Arial, sans-serif'];

function gen(seed: number): { css: string; body: string; rows: number } {
  const r = rng(seed), { pick, maybe } = r;
  const css: string[] = [`body { margin: 0; font: 16px/${pick(['1.2', '1.5', 'normal', '20px'])} ${pick(FAMILIES)} }`];
  const decls = (extra: string[] = []) => {
    const d = [...extra];
    if (maybe(0.5)) d.push(`padding: ${pick(LEN)} ${pick(LEN)}`);
    if (maybe(0.5)) d.push(`margin: ${maybe(0.2) ? '-4px' : pick(LEN)} 0 ${pick(LEN)}`);
    if (maybe(0.3)) d.push(`border-bottom: ${pick(['1px', '2px', 'thin'])} solid`);
    if (maybe(0.4)) d.push(`line-height: ${pick(['1', '1.25', '1.5', 'normal', '18px', '1.5rem'])}`);
    if (maybe(0.4)) d.push(`font-size: ${pick(['12px', '0.875rem', '1.25em', '20px', 'small', 'larger'])}`);
    if (maybe(0.2)) d.push(`font-family: ${pick(FAMILIES)}`);
    if (maybe(0.2)) d.push('box-sizing: border-box');
    return d.join('; ');
  };
  // the container
  const container = pick(['block', 'column', 'grid', 'autofill']);
  const tag = pick(['ul', 'div', 'section']);
  const cd = container === 'column' ? `display: flex; flex-direction: column; gap: ${pick(LEN)}`
    : container === 'grid' ? `display: grid; grid-template-columns: repeat(${pick([2, 3])}, 1fr); gap: ${pick(LEN)}`
      : container === 'autofill' ? `display: grid; grid-template-columns: repeat(auto-fill, minmax(${pick([150, 200, 260])}px, 1fr)); gap: ${pick(LEN)}` : '';
  css.push(`.c { margin: 0; padding: 0; list-style: none; ${cd} }`);
  // the row
  const rowTag = tag === 'ul' ? 'li' : pick(['div', 'article']);
  const rowDisplay = pick(['block', 'block', 'flex', 'grid']);
  css.push(`.r { display: ${rowDisplay}; ${decls(maybe(0.25) ? [`height: ${pick(['40px', '3em', '2.5rem'])}`] : maybe(0.15) ? [`min-height: ${pick(['30px', '2em'])}`] : [])} }`);
  if (maybe(0.3)) css.push(`.r + .r { margin-top: ${pick(LEN)} }`);
  if (maybe(0.2)) css.push(`.r:nth-child(${pick(['odd', 'even', '3n'])}) { padding-top: ${pick(LEN)} }`);
  if (maybe(0.15)) css.push(`.r:last-child { margin-bottom: ${pick(LEN)} }`);
  if (maybe(0.15)) css.push(`.r:first-child { border-top: 1px solid }`);
  // its content
  const kids: string[] = [];
  const n = Math.floor(r.next() * 4);
  for (let i = 0; i < n; i++) {
    const k = pick(['h3', 'p', 'span', 'small', 'button', 'img', 'code', 'br', 'div']);
    const cls = `k${i}`;
    if (k !== 'br' && k !== 'img' && maybe(0.6)) css.push(`.${cls} { ${decls()} }`);
    if (k === 'img') kids.push(`<img class="${cls}" src="a.png" width="${pick([40, 80, 400])}" height="${pick([30, 60, 300])}" alt="">`);
    else if (k === 'br') kids.push('<br>');
    else if (k === 'button') kids.push(`<button class="${cls}">Go</button>`);
    else kids.push(`<${k} class="${cls}" data-sn-text="r.x${i}"></${k}>`);
  }
  if (maybe(0.2)) css.push('img { max-width: 100%; height: auto }');
  const rows = 1 + Math.floor(r.next() * 8);
  return { css: css.join('\n'), body: `<${tag} class="c"><template id="t"><${rowTag} class="r">${kids.join('')}</${rowTag}></template></${tag}>`, rows };
}

const page = (css: string, body: string) => `<!doctype html><html><head><style>${css}</style></head><body>${body}<div id="after">after</div></body></html>`;

function find(doc: DefaultTreeAdapterMap['document']): El {
  const walk = (n: DefaultTreeAdapterMap['parentNode']): El | null => {
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue;
      if (c.attrs.some((a) => a.name === 'id' && a.value === 't')) return c;
      const x = walk(c.tagName === 'template' ? (c as DefaultTreeAdapterMap['template']).content : c);
      if (x) return x;
    }
    return null;
  };
  return walk(doc)!;
}

describe.skipIf(!chromium)('random lists in Chromium: the placeholder is never taller than the rows', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  let tab: Page;
  let cdp: CDPSession;
  beforeAll(async () => { browser = await chromium!.launch(); tab = await browser.newPage(); cdp = await tab.context().newCDPSession(tab); await cdp.send('Page.enable'); }, 30_000);
  afterAll(async () => { await browser?.close(); });

  const after = async (css: string, body: string, list: string) => {
    await tab.setContent(page(css, body.replace(/<template id="t">[\s\S]*<\/template>/, `<template></template>${list}`)));
    return tab.evaluate(() => document.getElementById('after')!.getBoundingClientRect().top);
  };

  test(`${N} cases from seed ${SEED}`, async () => {
    let held = 0;
    for (let i = 0; i < N; i++) {
      const seed = SEED * 100_003 + i, { css, body, rows } = gen(seed);
      const doc = parse5.parse(page('', body));
      const r = new Layout([{ file: 'fuzz.css', css }], doc).reserve(find(doc), rows);
      if (!r) continue;
      held++;
      const row = /<template id="t">([\s\S]*)<\/template>/.exec(body)![1]!.replace(/(<(\w+)[^>]*data-sn-text="[^"]*"[^>]*>)(<\/\2>)/g, '$1Word$3')
        // an image of the ratio its attributes state, as on a real page
        .replace(/src="a\.png" width="(\d+)" height="(\d+)"/g, (_, w: string, h: string) => `src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}" width="${w}" height="${h}"`);
      const rules = `.ph { ${PLACEHOLDER_BASE} }\n` + r.pieces.map((p) => (p.from ? `@media (min-width: ${p.from}px) { .ph.ph { ${p.decls} } }` : `.ph.ph { ${p.decls} }`)).join('\n');
      for (const [width, font] of [[1280, 16], [390, 16], [800, 12], [390, 10]] as const) {
        await tab.setViewportSize({ width, height: 900 });
        await cdp.send('Page.setFontSizes', { fontSizes: { standard: font, fixed: Math.round((font * 13) / 16) } });
        const real = await after(css, body, row.repeat(rows));
        const ph = await after(css + '\n' + rules, body, `<${r.tag} class="ph"></${r.tag}>`);
        expect(ph, `seed ${seed} (${rows} rows) at ${width}px, default font ${font}px:\n${css}\n${body}\n${rules}`).toBeLessThanOrEqual(real + 0.5);
      }
    }
    // the grammar is mostly what the build follows: most cases hold space
    expect(held).toBeGreaterThan(N / 3);
  }, 600_000);
});
