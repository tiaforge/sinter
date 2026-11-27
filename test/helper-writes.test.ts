// Which parameters a helper writes into (src/helper-writes.ts; docs/spec.md, Method classes): a syntactic check with
// no false positives. Each write form, a `const` chain, a `for...of` element and a callback's element, a call that
// passes the parameter on (across modules), and what is not a write into a parameter.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exportWrites, functionWrites } from '../src/helper-writes.js';

/** the parameters `fn` writes, with what it does there */
const writes = (fn: unknown) => (functionWrites(fn, 'f') ?? []).map((w) => w?.what ?? null);

describe('a write into a parameter', () => {
  const cases: Array<[string, unknown, Array<string | null>]> = [
    ['an assignment to a member', (p: { n: number }) => { p.n = 1; }, ['`p.n = …`']],
    ['a compound assignment, deep', (p: { a: { n: number } }) => { p.a.n += 1; }, ['`p.a.n += …`']],
    ['an index', (p: number[]) => { p[0] = 1; }, ['`p[0] = …`']],
    ['`++`', (p: { n: number }) => { p.n++; }, ['`p.n++`']],
    ['`delete`', (p: { n?: number }) => { delete p.n; }, ['`delete p.n`']],
    ['`push()`', (_a: number, p: number[]) => { p.push(1); }, [null, '`p.push()`']],
    ['`sort()` as the result', (p: number[]) => p.sort(), ['`p.sort()`']],
    ['`splice()`, `reverse()`, `fill()` on a member', (p: { xs: number[] }) => p.xs.reverse(), ['`p.xs.reverse()`']],
    ['a Map\'s `set()`', (p: Map<string, number>) => { p.set('a', 1); }, ['`p.set()`']],
    ['a Set\'s `add()`', (p: { s: Set<number> }) => { p.s.add(1); }, ['`p.s.add()`']],
    ['`Object.assign()` onto it', (p: object) => Object.assign(p, { a: 1 }), ['`Object.assign(p, …)`']],
    ['through a `const` chain', (p: { items: number[] }) => { const items = p.items; items.push(1); }, ['`items.push()`']],
    ['through a `for...of` element', (p: Array<{ done: boolean }>) => { for (const x of p) x.done = true; }, ['`x.done = …`']],
    ['through a callback\'s element', (p: { items: Array<{ done: boolean }> }) => { p.items.forEach((x) => { x.done = true; }); }, ['`x.done = …`']],
    ['in a nested block and an arrow inside', (p: { n: number }) => { if (p) { [1].map(() => { p.n = 2; }); } }, ['`p.n = …`']],
    ['a default value', (p = { n: 0 }) => { p.n = 1; }, ['`p.n = …`']],
  ];
  for (const [what, fn, out] of cases) test(what, () => expect(writes(fn)).toEqual(out));
});

describe('not a write into a parameter', () => {
  const cases: Array<[string, unknown]> = [
    ['a copy', (p: number[]) => { const c = [...p]; c.sort(); return c; }],
    ['a spread copy of an object', (p: { n: number }) => { const c = { ...p }; c.n = 1; return c; }],
    ['a method that returns a new value', (p: number[]) => p.slice().sort()],
    ['`toSorted()`, `map()`, `filter()`', (p: number[]) => p.toSorted().map((x) => x * 2).filter(Boolean)],
    ['a parameter reassigned', (p: number[]) => { p = [...p]; p.push(1); return p; }],
    ['a shadowed parameter', (p: number[]) => { { const p = [1]; p.push(2); } return p; }],
    ['a callback\'s own parameter of the same name', (p: number[]) => [[1]].map((p) => { p.push(1); return p; })],
    ['a `let` chain, which may be reassigned', (p: { items: number[] }) => { let items = p.items; items = [...items]; items.push(1); return items; }],
    ['a local Date', (iso: string) => { const d = new Date(iso); d.setDate(1); return d; }],
    ['a member of an object it made', (p: { n: number }) => { const o = { n: p.n }; o.n = 2; return o; }],
    ['a call result\'s member', (p: { get(): { n: number } }) => { p.get().n = 1; }],
  ];
  for (const [what, fn] of cases) test(what, () => expect(writes(fn)).toEqual([]));
});

describe('a call that passes the parameter on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sn-hw-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/lib.ts'), [
    'export function sortInPlace(xs: number[]) { xs.sort(); }',
    'export function scrollTo(el: HTMLElement) { el.scrollTop = 0; }',
  ].join('\n'));
  writeFileSync(join(dir, 'src/h.ts'), [
    "import { sortInPlace } from './lib.ts';",
    "export { scrollTo } from './lib.ts';",
    'function bump(o: { n: number }) { o.n++; }',
    'export function viaLocal(t: { o: { n: number } }) { bump(t.o); }',
    'export function viaImport(a: number, xs: number[]) { sortInPlace(xs); return a; }',
    'export function twoSteps(t: { o: { n: number } }) { viaLocal(t); }',
    'export function copyFirst(xs: number[]) { sortInPlace([...xs]); }',
    'export const pure = (xs: number[]) => xs.length;',
  ].join('\n'));
  const at = (name: string) => (exportWrites(join(dir, 'src/h.ts'), name, dir) ?? []).map((w) => (w ? `${w.what} ${w.line}:${w.col} ${w.chain.join('>')}` : null));
  test('to a function of the module', () => expect(at('viaLocal')).toEqual(['`o.n++` 3:35 viaLocal>bump']));
  test('to an import', () => expect(at('viaImport')).toEqual([null, '`xs.sort()` 1:45 viaImport>sortInPlace']));
  test('through two calls', () => expect(at('twoSteps')).toEqual(['`o.n++` 3:35 twoSteps>viaLocal>bump']));
  test('a copy passed on is not', () => expect(at('copyFirst')).toEqual([null]));
  test('a re-export is read where it is declared', () => expect(at('scrollTo')).toEqual(['`el.scrollTop = …` 2:45 scrollTo']));
  test('a pure helper', () => expect(at('pure')).toEqual([null]));
});
