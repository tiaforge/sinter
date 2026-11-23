// A component used in a list the build unrolls: each row is a copy of the loop's markup (`cloneTree`), and each copy's
// root is marked with the component's name (`data-sn-c`) as the use's own root is, so its scoped styles apply to every row.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(html: string, files: Record<string, string>) {
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) abs[`/p/src/components/${k}`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in abs) return abs[p]!; throw new Error('missing'); } });
}
const CARD = '<template data-sn-props="{ x: number }"><div class="card" data-sn-text="\'card \' + x"></div></template>\n<style>.card { color: red; }</style>\n';
const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
/** each card's opening tag, in order */
const cards = (html: string) => html.match(/<div class="card"[^>]*>/g) ?? [];

test('a styled component in a loop over constants: every unrolled row\'s root is marked, as one used on its own', () => {
  const out = run(page('<my-card data-sn-with="{ x: 0 }"></my-card><template data-sn-for="x in [1, 2]"><my-card data-sn-with="{ x }"></my-card></template>'), { 'my-card.html': CARD });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toMatch(/card 1.*card 2/s);
  expect(cards(out.html)).toEqual(Array(3).fill('<div class="card" data-sn-c="my-card">'));
  expect(out.styles[0]!.css).toContain('@scope ([data-sn-c="my-card"]');
});

test('in nested loops over constants, and inside an element of the row: every copy is marked', () => {
  const out = run(page('<template data-sn-for="r in [[1, 2], [3]]"><section><template data-sn-for="x in r"><my-card data-sn-with="{ x }"></my-card></template></section></template>'), { 'my-card.html': CARD });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toMatch(/card 1.*card 2.*card 3/s);
  expect(cards(out.html)).toEqual(Array(3).fill('<div class="card" data-sn-c="my-card">'));
});

test('a loop the browser renders keeps the mark in its template: the rows it clones carry it', () => {
  const out = run(page('<sn-resource name="xs" src="/api/xs"></sn-resource><template data-sn-for="x in xs"><my-card data-sn-with="{ x }"></my-card></template>'), { 'my-card.html': CARD });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(cards(out.html)).toEqual(['<div class="card" data-sn-c="my-card">']);
});
