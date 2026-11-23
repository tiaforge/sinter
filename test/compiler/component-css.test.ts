// A component's styles in a file of their own: `<name>.css` beside its HTML (in `src/components/` or in the
// component's folder), scoped exactly as its `<style>` would be.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

function run(html: string, files: Record<string, string>) {
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) abs[`/p/src/components/${k}`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in abs) return abs[p]!; throw new Error('missing'); } });
}
const CARD = '<template data-sn-props="{ title: string }"><section class="card"><h2 data-sn-text="title"></h2></section></template>\n';
const CSS = '.card { padding: 7px; }\nh2 { color: red; }\n';
const PAGE = '<x-card data-sn-with="{ title: \'a\' }"></x-card>';

test('`<name>.css` beside the HTML is scoped as its `<style>` is, flat or in the component\'s folder; the build watches it', () => {
  const style = run(PAGE, { 'x-card.html': CARD + `<style>${CSS}</style>\n` });
  const flat = run(PAGE, { 'x-card.html': CARD, 'x-card.css': CSS });
  const folder = run(PAGE, { 'x-card/x-card.html': CARD, 'x-card/x-card.css': CSS });
  for (const out of [style, flat, folder]) expect(out.diagnostics).toEqual([]);
  expect(flat.styles).toEqual(style.styles);
  expect(folder.styles).toEqual(style.styles);
  expect(flat.styles[0]!.css).toContain('@scope ([data-sn-c="x-card"]');
  expect(flat.html).toBe(style.html);
  expect(flat.files).toContain('/p/src/components/x-card.css');
  expect(folder.files).toContain('/p/src/components/x-card/x-card.css');
});

test('a `<style>` and a `.css` file both: SN312, the styles are in one place', () => {
  const out = run(PAGE, { 'x-card.html': CARD + '<style>.card { margin: 0 }</style>\n', 'x-card.css': CSS });
  expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([expect.stringMatching(/^SN312 `<x-card>` has a `<style>` and `x-card\.css` beside it: a component's styles are in one place/)]);
});

test('a head component with a `.css` file: SN320 on the file', () => {
  const out = run('<!doctype html><html><head><x-seo></x-seo><title>t</title></head><body></body></html>', { 'x-seo.html': '<template><meta name="robots" content="noindex"></template>', 'x-seo.css': 'meta { color: red }' });
  const d = out.diagnostics.find((x) => x.code === 'SN320')!;
  expect(d.message).toMatch(/the head component `<x-seo>` has styles \(`x-seo\.css`\)/);
  expect(d.file).toBe('/p/src/components/x-seo.css');
});
