// @vitest-environment node
// Components through the Vite plugin: scoped styles go into the page's stylesheet, wrapped in
// native @scope from the component's roots to nested components and slot content; Chromium applies them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-components-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(join(root, 'src/components'), { recursive: true });
  writeFileSync(join(root, 'src/components/x-card.html'), `<template data-sn-component="{ title: string }">
  <section class="card"><h2 data-sn-text="title"></h2><p class="own">own</p><x-inner></x-inner><slot></slot></section>
</template>
<style>
  @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
  .card { padding: 7px; }
  p { color: rgb(0, 0, 255); }
  .card .mine { font-weight: 900; }
</style>
`);
  writeFileSync(join(root, 'src/components/x-inner.html'), '<template data-sn-component=""><div class="inner"><p class="nested">nested</p></div></template>\n');
  writeFileSync(join(root, 'src/components/x-page.html'), `<template data-sn-component=""><main><x-card data-sn-prop="{ title: 'In page' }"><p class="mine">slot</p></x-card></main></template>
<style>p { text-decoration: underline; }</style>
`);
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>c</title></head><body>
<div data-sn-state="{ t: 'Hello' }"><x-card data-sn-prop="{ title: t }"><p class="page">from the page</p></x-card></div>
<x-page></x-page>
</body></html>`);
});

test('a build: scoped styles in the page\'s stylesheet, roots and slot content marked, Chromium scopes them', async () => {
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const cssFile = readdirSync(join(out, 'assets')).find((f) => f.endsWith('.css'))!;
  expect(cssFile).toBeDefined();
  expect(html).toContain(`<link rel="stylesheet" crossorigin href="/assets/${cssFile}">`);
  const css = readFileSync(join(out, 'assets', cssFile), 'utf8');
  expect(css).toMatch(/@keyframes pulse/);
  expect(css).toContain('@scope (:has(> [data-sn-c="x-card"]), :has(> [data-sn-s="x-card"])) to (:scope > :not([data-sn-c="x-card"], [data-sn-s="x-card"]), :scope > * [data-sn-c], :scope > * [data-sn-s])');
  expect(css).not.toMatch(/@scope[^{]*\{[^}]*@keyframes/);
  expect(html).toContain('<section class="card" data-sn-c="x-card">');
  expect(html).toContain('<div class="inner" data-sn-c="x-inner">');
  // slot content: the page's, and the one x-page passes into x-card
  expect(html).toContain('<p class="page" data-sn-s="">');
  expect(html).toContain('<p class="mine" data-sn-s="x-page">');
  if (!chromium) return;
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.setContent(html.replace(/<link rel="stylesheet"[^>]*>/, `<style>${css}</style>`).replace(/<script[\s\S]*?<\/script>/g, ''));
    const style = (sel: string) => tab.$eval(sel, (el) => { const s = getComputedStyle(el); return { color: s.color, weight: s.fontWeight, deco: s.textDecorationLine, pad: s.padding }; });
    expect((await style('.card')).pad).toBe('7px');
    expect((await style('.own')).color).toBe('rgb(0, 0, 255)');
    // a nested component and slot content are not the card's
    expect((await style('.nested')).color).not.toBe('rgb(0, 0, 255)');
    expect((await style('.page')).color).not.toBe('rgb(0, 0, 255)');
    // slot content is its caller's: x-page's styles reach what it passes into the card, also through the card's markup
    expect((await style('.mine')).deco).toBe('underline');
    expect((await style('.mine')).weight).not.toBe('900');
    expect((await style('x-page .own, main .own')).deco).not.toBe('underline');
  } finally {
    await browser.close();
  }
}, 60_000);
