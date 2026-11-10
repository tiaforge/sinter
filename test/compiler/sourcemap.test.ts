import { SourceMap as NodeSourceMap } from 'node:module';
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  '/p/src/components/x-row.html': '<template data-sn-component="{ q: string }"><p>\n  <b data-sn-text="q.toUpperCase()"></b></p></template>',
};

const opts = (o: Partial<CompileOptions> = {}): CompileOptions => ({
  file: '/p/page.html', root: '/p', dev: true, sourcemap: true,
  readFile: (p) => { if (!(p in files)) throw new Error('missing'); return files[p]!; },
  helpers: { module: null, names: [], namespaces: {} },
  ...o,
});

const PAGE = [
  '<div data-sn-state="{ q: \'\', n: 0 }">',
  '  <input data-sn-model="q">',
  '  <p data-sn-text="q.length + n"></p>',
  '  <button data-sn-on-click="n = n + 1">+</button>',
  '  <x-row data-sn-prop="{ q }"></x-row>',
  '</div>',
].join('\n');

/** where `needle` in the module's function table maps to (1-based line and column); `after`: the needle on the first line holding this too */
function origin(module: string, map: NonNullable<ReturnType<typeof compile>['map']>, needle: string, after = needle) {
  const lines = module.split('\n');
  const table = lines.findIndex((l) => l.trimStart().startsWith('const fns = ['));
  const line = lines.findIndex((l, i) => i > table && l.includes(after) && l.includes(needle));
  expect(line, `\`${needle}\` in the module`).toBeGreaterThanOrEqual(0);
  const e = new NodeSourceMap({ file: "", sourceRoot: "", ...map }).findEntry(line, lines[line]!.indexOf(needle, lines[line]!.indexOf(after))) as { originalSource?: string; originalLine?: number; originalColumn?: number };
  return { file: e.originalSource, line: e.originalLine! + 1, col: e.originalColumn! + 1 };
}

describe('source maps', () => {
  const out = compile(PAGE, opts());

  test('the page module maps each expression to its attribute', () => {
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const map = out.map!;
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['/p/page.html', '/p/src/components/x-row.html']);
    expect(map.sourcesContent[0]).toBe(PAGE);
    // where each value starts in the markup
    expect(origin(out.module, map, '.length')).toEqual({ file: '/p/page.html', line: 3, col: 20 });
    expect(origin(out.module, map, '+ 1')).toEqual({ file: '/p/page.html', line: 4, col: 29 });
    expect(origin(out.module, map, "q: ''")).toEqual({ file: '/p/page.html', line: 1, col: 21 });
  });

  test('an expression from a component maps into the component', () => {
    expect(origin(out.module, out.map!, 'toUpperCase')).toEqual({ file: '/p/src/components/x-row.html', line: 2, col: 20 });
  });

  test('the module text is the same with and without a map', () => {
    const plain = compile(PAGE, opts({ sourcemap: false }));
    expect(plain.map).toBeUndefined();
    expect(plain.module).toBe(out.module);
  });

  test('the same input gives the same map', () => {
    expect(compile(PAGE, opts()).map).toEqual(out.map);
  });

  test('functions the compiler writes map to the markup: row lookups, and each expression inlined into them', () => {
    const page = [
      '<sn-resource name="people" src="/api/people" key="id"></sn-resource>',
      '<ul>',
      '  <template data-sn-for="p in people">',
      '    <li><b data-sn-text="p.name"></b> <i data-sn-text="p.age + 1"></i></li>',
      '  </template>',
      '</ul>',
    ].join('\n');
    const r = compile(page, opts());
    // find: the template; make: each binding's expression where it is inlined, the rest at the template
    expect(origin(r.module, r.map!, '(c) =>')).toEqual({ file: '/p/page.html', line: 3, col: 26 });
    expect(origin(r.module, r.map!, '(c, $, w) =>')).toEqual({ file: '/p/page.html', line: 3, col: 26 });
    expect(origin(r.module, r.map!, '$.p.name', '(c, $, w) =>')).toEqual({ file: '/p/page.html', line: 4, col: 26 });
    expect(origin(r.module, r.map!, '$.p.age + 1', '(c, $, w) =>')).toEqual({ file: '/p/page.html', line: 4, col: 56 });
    expect(origin(r.module, r.map!, 'w.t(', '(c, $, w) =>')).toEqual({ file: '/p/page.html', line: 3, col: 26 });
  });

  test('a form\'s `$error` state maps to its `data-sn-state`, the state inside it to its own place', () => {
    const page = '<form data-sn-state="{ a: 1 }">\n  <p data-sn-text="$error"></p></form>\n<form>\n  <p data-sn-text="$error"></p></form>';
    const r = compile(page, opts());
    expect(origin(r.module, r.map!, 'Object.assign')).toEqual({ file: '/p/page.html', line: 1, col: 22 });
    expect(origin(r.module, r.map!, 'a: 1', 'Object.assign')).toEqual({ file: '/p/page.html', line: 1, col: 22 });
    expect(origin(r.module, r.map!, '({ $error: null })')).toEqual({ file: '/p/page.html', line: 3, col: 1 });
  });

  test('the early module gets a map too', () => {
    // a helper keeps the binding out of the prerendered HTML: the early module renders it
    const page = '<div data-sn-state="{ n: 2 }">\n  <p data-sn-text="twice(n)"></p></div>';
    const early = compile(page, opts({ prerender: true, early: { module: null, src: '/early.js' }, helpers: { module: '/h.js', names: ['twice'], namespaces: {} } }));
    expect(early.early).toContain('twice(');
    expect(origin(early.early!, early.earlyMap!, 'twice(')).toEqual({ file: '/p/page.html', line: 2, col: 20 });
    // the early module writes its own state function: each field maps to its place in `data-sn-state`
    expect(origin(early.early!, early.earlyMap!, '"n": (', '"n": (')).toEqual({ file: '/p/page.html', line: 1, col: 23 });
  });
});

describe('places for the dev runtime', () => {
  const page = '<div data-sn-state="{ a: 1 }">\n  <p data-sn-text="a"></p>\n  <i data-sn-text="a"></i>\n  <button data-sn-on-click="a++">+</button></div>';

  test('dev builds: each binding names its own attribute, although identical code is one function', () => {
    const r = compile(page, opts({ sourcemap: false }));
    const ir = JSON.parse(/^const ir = (.*);$/m.exec(r.module)![1]!);
    const at = ir.roots.flatMap((n: { b: Array<{ at?: object }> }) => n.b.map((b) => b.at));
    const f = ir.roots[1].b[0].f;
    expect(ir.roots[2].b[0].f).toBe(f);
    expect(at).toEqual([{ [f]: '/p/page.html:2:20' }, { [f]: '/p/page.html:3:20' }, { [ir.roots[3].b[0].f]: '/p/page.html:4:29' }]);
  });

  test('production builds carry none of it', () => {
    const prod = compile(page, opts({ dev: false, sourcemap: false }));
    expect(prod.module).not.toMatch(/"at":|"src":"\/p/);
  });
});
