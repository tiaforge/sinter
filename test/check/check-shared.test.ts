// The type check of many pages (`check({ share: true })`, what `vite build` and `sinter check` run): each function of
// the pages' shadows that repeats is checked once, in a module of its own beside them, and its errors are reported at
// every place it repeats. The diagnostics must be those of each page checked whole, in the same order: a component's
// error once per use with that use's include chain, a component that reads the page's resource typed by each page.
// And under a build's shared definitions (`definitions`), linked into each page with their check data.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { check, findTsc } from '../../src/check/index.js';
import { compile } from '../../src/compiler/index.js';
import type { Diagnostic } from '../../src/compiler/diagnostics.js';
import { checkOptionsOf, compileOptionsOf, project } from '../../src/project.js';

const tsc = findTsc(process.cwd());
const page = (body: string) => `<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

const FILES: Record<string, string> = {
  'src/sinter.types.ts': 'export interface Person { id: number; name: string }\nexport interface Node { label: string; children?: Node[] }\n',
  'src/components/x-bad.html': `<template data-sn-props="{ n: number; label: string }" data-sn-emits="{ bump: number }">
  <div data-sn-state="{ count: 0 }">
    <p data-sn-text="label.nope"></p>
    <button data-sn-on-click="count = count + label.toFixed(); emit('bump', n)">+</button>
  </div>
</template>
`,
  'src/components/x-res.html': '<template data-sn-props="{ k: string }"><button data-sn-text="people[0].name.toFixed() + k" data-sn-on-click="refresh(people)"></button></template>\n',
  'src/components/x-tree.html': `<template data-sn-props="{ node: Node }">
  <li><span data-sn-text="node.lable"></span><ul><template data-sn-for="c in node.children ?? []"><x-tree data-sn-with="{ node: c }"></x-tree></template></ul></li>
</template>
`,
  'a.html': page(`<p data-sn-text="(1).nope"></p>
<div data-sn-state="{ x: 1 }"><x-bad data-sn-with="{ n: x, label: 'a' }" data-sn-on-bump="x = $event.detail.foo"></x-bad><x-bad data-sn-with="{ n: 'two', label: 'b' }"></x-bad></div>`),
  'b.html': page(`<sn-resource name="people" src="/api/people" type="Person[]"></sn-resource>
<sn-resource name="root" src="/api/tree" type="Node"></sn-resource>
<x-res data-sn-with="{ k: 'a' }"></x-res><ul><x-tree data-sn-with="{ node: root }"></x-tree></ul>`),
  'c.html': page(`<sn-resource name="people" src="/api/names" type="string[]"></sn-resource>
<sn-resource name="root" src="/api/tree" type="Node"></sn-resource>
<x-res data-sn-with="{ k: 'c' }"></x-res><ul><x-tree data-sn-with="{ node: root }"></x-tree></ul>`),
  'sub/d.html': page(`<div data-sn-state="{ y: 2 }"><x-bad data-sn-with="{ n: y, label: 'd' }"></x-bad></div>`),
};

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sinter-check-shared-'));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
}

/** the pages' check, shared or each page whole; with `definitions`, compiled as a build does, through one cache */
function run(root: string, pages: string[], o: { share: boolean; definitions?: boolean }): { diagnostics: Diagnostic[]; compile: Diagnostic[] } {
  const p = project(root, {});
  const definitions = o.definitions ? new Map() : undefined;
  const units = [], compiled: Diagnostic[] = [];
  for (const f of pages) {
    const file = join(root, f);
    const out = compile(readFileSync(file, 'utf8'), { ...compileOptionsOf(p, file), file, dev: false, prerender: true, check: true, ...(definitions ? { definitions } : {}) });
    compiled.push(...out.diagnostics.filter((d) => d.severity === 'error'));
    if (out.check) units.push(out.check);
  }
  const r = check({ ...checkOptionsOf(p), units, tsc, share: o.share });
  return { diagnostics: r.diagnostics, compile: compiled };
}

const PAGES = ['a.html', 'b.html', 'c.html', 'sub/d.html'];
const text = (ds: Diagnostic[]) => ds.map((d) => `${d.file.replace(/^.*?sinter-check-shared-\w+\//, '')}:${d.line}:${d.col} ${d.severity} ${d.code} ${d.message}`);

test('the shared check reports what each page checked whole does, in the same order', () => {
  const root = app(FILES);
  const whole = run(root, PAGES, { share: false });
  const shared = run(root, PAGES, { share: true });
  expect(whole.compile).toEqual([]);
  // (the shared route was taken: the component's markup is in the shared module, not on the page)
  expect(existsSync(join(root, '.sinter/check/$shared-0.js'))).toBe(true);
  expect(readFileSync(join(root, '.sinter/check/$shared-0.js'), 'utf8')).toContain('label.nope');
  expect(readFileSync(join(root, '.sinter/check/a.html.js'), 'utf8')).not.toContain('label.nope');
  expect(text(shared.diagnostics)).toEqual(text(whole.diagnostics));
  expect(shared.diagnostics).toEqual(whole.diagnostics);
  const msgs = text(whole.diagnostics);
  // a component's error once per use, each with its use's chain
  expect(msgs.filter((m) => m.startsWith('src/components/x-bad.html:3:') && m.includes("Property 'nope' does not exist on type 'string'"))).toEqual([
    "src/components/x-bad.html:3:28 error SN208 Property 'nope' does not exist on type 'string'. (TS2339) (included from a.html:6)",
    "src/components/x-bad.html:3:28 error SN208 Property 'nope' does not exist on type 'string'. (TS2339) (included from a.html:6)",
    "src/components/x-bad.html:3:28 error SN208 Property 'nope' does not exist on type 'string'. (TS2339) (included from d.html:5)",
  ]);
  // the page's resource, typed by each page
  expect(msgs.filter((m) => m.startsWith('src/components/x-res.html'))).toEqual([
    "src/components/x-res.html:1:78 error SN208 Property 'toFixed' does not exist on type 'string'. Did you mean 'fixed'? (TS2551) (included from b.html:7)",
    "src/components/x-res.html:1:73 error SN208 Property 'name' does not exist on type 'string'. (TS2339) (included from c.html:7)",
  ]);
}, 60_000);

test('with a build\'s shared definitions, linked into each page with their check data: the same diagnostics', () => {
  const root = app(FILES);
  const whole = run(root, PAGES, { share: false });
  for (const share of [false, true]) expect(run(root, PAGES, { share, definitions: true }).diagnostics).toEqual(whole.diagnostics);
}, 60_000);

test('a broken expression on one page: TypeScript reports no type error anywhere, shared or not', () => {
  const root = app({ ...FILES, 'e.html': page('<p data-sn-text="1 +"></p><div data-sn-state="{ z: 3 }"><x-bad data-sn-with="{ n: z, label: \'e\' }"></x-bad></div>') });
  const pages = [...PAGES, 'e.html'];
  const whole = run(root, pages, { share: false }), shared = run(root, pages, { share: true });
  expect(whole.compile.map((d) => d.code)).toEqual(['SN401']);
  expect(whole.diagnostics).toEqual([]);
  expect(shared.diagnostics).toEqual(whole.diagnostics);
}, 60_000);
