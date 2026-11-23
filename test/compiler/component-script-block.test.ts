// A single-file component: a top-level `<script>` in the component file is its script (`lang="ts"` for TypeScript),
// served as `<name>.html.script.ts` beside the file.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { inlineScriptModule, inlineScripts } from '../../src/compiler/components.js';

function run(html: string, files: Record<string, string>) {
  const abs: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) abs[`/p/src/components/${k}`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in abs) return abs[p]!; throw new Error('missing'); } });
}
const T = '<template data-sn-props="{ n: number }"><p data-sn-state="{ x: 1 }" data-sn-text="n"></p></template>\n';
const SCRIPT = (lang = ' lang="ts"') => `<script${lang}>\n  import { XAComponent } from './x-a.html';\n  export class XA extends XAComponent {}\n</script>\n`;
const PAGE = '<x-a data-sn-with="{ n: 1 }"></x-a>';
const msgs = (out: ReturnType<typeof run>) => out.diagnostics.map((d) => `${d.code} ${d.message}`);

test('its module is `<name>.html.script.ts` (or `.js` without `lang`), imported by the page with its class, flat or in a folder', () => {
  const ts = run(PAGE, { 'x-a.html': T + SCRIPT() });
  expect(ts.diagnostics).toEqual([]);
  expect(ts.module).toMatch(/import \{ XA as [\w$]+ \} from "\/src\/components\/x-a\.html\.script\.ts"/);
  const js = run(PAGE, { 'x-a/x-a.html': T + SCRIPT('') });
  expect(js.diagnostics).toEqual([]);
  expect(js.module).toContain('"/src/components/x-a/x-a.html.script.js"');
  // the same page as with the script in a file beside it
  const beside = run(PAGE, { 'x-a.html': T, 'x-a.ts': "import { XAComponent } from './x-a.html';\nexport class XA extends XAComponent {}\n" });
  expect(ts.html).toBe(beside.html);
  expect(ts.module.replace('x-a.html.script.ts', 'x-a.ts')).toBe(beside.module);
});

test('one script, in one place: two `<script>` blocks, a block and a file beside it, an unknown `lang` are SN312', () => {
  expect(msgs(run(PAGE, { 'x-a.html': T + SCRIPT() + SCRIPT() }))).toEqual([expect.stringMatching(/^SN312 `<x-a>` has 2 top-level `<script>` elements: a component has one script/)]);
  expect(msgs(run(PAGE, { 'x-a.html': T + SCRIPT(), 'x-a.ts': 'export class XA {}' }))).toEqual([expect.stringMatching(/^SN312 `<x-a>` has a `<script>` and `x-a\.ts` beside it: a component's script is in one place/)]);
  expect(msgs(run(PAGE, { 'x-a.html': T + SCRIPT(' lang="coffee"') }))).toEqual([expect.stringMatching(/^SN312 `lang="coffee"` is not a script language sinter takes/)]);
});

test('a top-level `<script>` with another type (JSON-LD) belongs in the template, as before', () => {
  expect(msgs(run(PAGE, { 'x-a.html': T + '<script type="application/ld+json">{}</script>\n' }))).toEqual([expect.stringMatching(/^SN312 a component file holds its `<template>`, `<style>` and `<script>`; `<script type="application\/ld\+json">` belongs inside the template/)]);
});

test('a head component with a `<script>`: SN312, as with a file beside it', () => {
  const out = run('<!doctype html><html><head><x-seo></x-seo><title>t</title></head><body></body></html>', { 'x-seo.html': '<template><meta name="robots" content="noindex"></template>\n' + SCRIPT() });
  expect(msgs(out)).toEqual([expect.stringMatching(/^SN312 the head component `<x-seo>` has a script \(`\/src\/components\/x-seo\.html\.script\.ts`\)/)]);
});

test('the module: the code at the file\'s lines and columns, with a map to the file', () => {
  const text = T + '\n' + SCRIPT();
  const [s] = inlineScripts(text);
  expect([s!.line, s!.col, s!.lang]).toEqual([3, 19, 'ts']);
  const m = inlineScriptModule(text, '/p/x-a.html')!;
  const lines = m.code.split('\n');
  expect(lines[3]).toBe(text.split('\n')[3]);
  expect(lines[4]).toBe(text.split('\n')[4]);
  expect(m.map.sources).toEqual(['/p/x-a.html']);
  expect(m.map.sourcesContent).toEqual([text]);
  // no segment on the lines before; then each line to its own line of the file
  expect(m.map.mappings).toBe(';;AAEA;AACA;AACA;AACA');
});
