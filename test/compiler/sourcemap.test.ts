import { SourceMap as NodeSourceMap } from 'node:module';
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  '/p/partials/row.html': '<p>\n  <b data-sn-text="q.toUpperCase()"></b></p>',
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
  '  <sn-include src="./partials/row.html"></sn-include>',
  '</div>',
].join('\n');

/** where the function holding `needle` in the module maps to (1-based line and column) */
function origin(module: string, map: NonNullable<ReturnType<typeof compile>['map']>, needle: string) {
  const lines = module.split('\n');
  const table = lines.findIndex((l) => l.trimStart().startsWith('const fns = ['));
  const line = lines.findIndex((l, i) => i > table && l.includes(needle));
  expect(line, `\`${needle}\` in the module`).toBeGreaterThanOrEqual(0);
  const e = new NodeSourceMap({ file: "", sourceRoot: "", ...map }).findEntry(line, lines[line]!.indexOf(needle)) as { originalSource?: string; originalLine?: number; originalColumn?: number };
  return { file: e.originalSource, line: e.originalLine! + 1, col: e.originalColumn! + 1 };
}

describe('source maps', () => {
  const out = compile(PAGE, opts());

  test('the page module maps each expression to its attribute', () => {
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const map = out.map!;
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['/p/page.html', '/p/partials/row.html']);
    expect(map.sourcesContent[0]).toBe(PAGE);
    // where each value starts in the markup
    expect(origin(out.module, map, '.length')).toEqual({ file: '/p/page.html', line: 3, col: 20 });
    expect(origin(out.module, map, '+ 1')).toEqual({ file: '/p/page.html', line: 4, col: 29 });
    expect(origin(out.module, map, "q: ''")).toEqual({ file: '/p/page.html', line: 1, col: 21 });
  });

  test('an expression from a partial maps into the partial', () => {
    expect(origin(out.module, out.map!, 'toUpperCase')).toEqual({ file: '/p/partials/row.html', line: 2, col: 20 });
  });

  test('the module text is the same with and without a map', () => {
    const plain = compile(PAGE, opts({ sourcemap: false }));
    expect(plain.map).toBeUndefined();
    expect(plain.module).toBe(out.module);
  });

  test('the same input gives the same map', () => {
    expect(compile(PAGE, opts()).map).toEqual(out.map);
  });

  test('the early module gets a map too', () => {
    // a helper keeps the binding out of the prerendered HTML: the early module renders it
    const page = '<div data-sn-state="{ n: 2 }">\n  <p data-sn-text="twice(n)"></p></div>';
    const early = compile(page, opts({ prerender: true, early: { module: null, src: '/early.js' }, helpers: { module: '/h.js', names: ['twice'], namespaces: {} } }));
    expect(early.early).toContain('twice(');
    expect(origin(early.early!, early.earlyMap!, 'twice(')).toEqual({ file: '/p/page.html', line: 2, col: 20 });
  });
});
