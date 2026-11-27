// A helper's summary, read from its body (src/helper-flows.ts): which of its parameters' objects, at which paths, may be
// at which paths of its result. Accepted shapes, and each construct that leaves a helper without one.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { helperFlows } from '../src/helper-flows.js';

const flowsOf = (code: string, names: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'sn-hf-'));
  writeFileSync(join(dir, 'lib.ts'), code);
  writeFileSync(join(dir, 'helpers.ts'), `export * from './lib.ts';`);
  const f = helperFlows(join(dir, 'helpers.ts'), dir);
  return Object.fromEntries(names.map((n) => { const s = f(n); return [n, 'flows' in s ? s.flows.map((p) => `${p.sub.join('.')}<-${p.src.join('.')}`).sort() : s.why]; }));
};

describe('accepted shapes', () => {
  test('primitive results, members, elements, spreads, fresh objects of members, calls of other summarized functions', () => {
    expect(flowsOf(`
      export function key(m: { id: string }) { return \`\${m.id}!\`; }
      export const same = (x: object) => x;
      export function first(xs: object[]) { return xs[0] ?? null; }
      export function found(xs: Array<{ id: number }>, id: number) { return xs.find((x) => x.id === id); }
      export function opened(sel: { cursor: string }, key: string) { return { ...sel, cursor: key, keys: [] }; }
      export function ref(m: { a: string; b: object }) { return { a: m.a, nested: { b: m.b } }; }
      export function via(m: { a: string; b: object }) { return ref(m).nested; }
      function pad(n: number) { return String(n).padStart(2, '0'); }
      export function hm(d: Date) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    `, ['key', 'same', 'first', 'found', 'opened', 'ref', 'via', 'hm'])).toEqual({
      key: [], same: ['<-0'], first: ['<-0.0'], found: ['<-0.*'], opened: ['*<-0.*', 'cursor<-1'], ref: ['a<-0.a', 'nested.b<-0.b'], via: ['b<-0.b'], hm: [],
    });
  });

  test('locals keep what was stored in them: pushed, assigned to a member, put in a Map and taken back out', () => {
    expect(flowsOf(`
      export function pushed(p: object) { const out: object[] = []; out.push(p); return out; }
      export function member(p: object) { const o: any = {}; o.v = p; return o.v; }
      export function back(p: object) { const m = new Map<string, object[]>(); m.set('k', []); m.get('k')!.push(p); return [...m.values()][0]![0]; }
      export function looped(xs: object[]) { const out = []; for (const x of xs) out.push(x); return out; }
    `, ['pushed', 'member', 'back', 'looped'])).toEqual({ pushed: ['*<-0'], member: ['<-0'], back: expect.arrayContaining(['<-0']), looped: expect.arrayContaining(['*<-0.*']) });
  });

  test('iteration reads a Map as pairs too: a value taken out of `entries()` or a destructured pair still holds the object', () => {
    const r = flowsOf(`
      export function pair(p: object) { const m = new Map([['k', p]]); return [...m][0][1]; }
      export function entry(p: object) { return Object.entries({ k: p })[0][1]; }
      export function destructured(p: object) { const m = new Map([['k', p]]); for (const [, v] of m) return v; return null; }
      export function keysOf(p: object) { const m = new Map([[p, 1]]); return [...m.keys()][0]; }
    `, ['pair', 'entry', 'destructured', 'keysOf']);
    for (const k of ['pair', 'entry', 'destructured', 'keysOf']) expect(r[k], k).toContain('<-0');
  });
});

describe('rejected constructs: no summary, with why', () => {
  test.each([
    ['a write into a parameter\'s object', 'export function h(p: { n: number }) { p.n = 1; return 1; }', /a write into an object of a parameter/],
    ['a mutating method on a parameter', 'export function h(xs: number[]) { xs.push(1); return xs.length; }', /a write into an object of a parameter/],
    ['a write to module state', 'let last: object | null = null; export function h(p: object) { last = p; return 1; }', /a write to the module's `last`/],
    ['a read of module state another function writes', 'let last: object | null = null; export function h() { return last; }', /`last`, which the build cannot follow/],
    ['`this`', 'export function h() { return this; }', /`this`/],
    ['`arguments`', 'export function h(a: object) { return arguments[0]; }', /`arguments`/],
    ['an escaping closure', 'export function h(p: object) { return () => p; }', /a function that leaves the helper/],
    ['an unknown function', 'import { x } from "pkg"; export function h(p: object) { return x(p); }', /a call of `x`, which the build cannot read/],
    ['an unknown method', 'export function h(p: { go(): object }) { return p.go(); }', /the method `go\(\)`, which the build does not know/],
    ['recursion', 'export function h(n: number): number { return n ? h(n - 1) : 0; }', /it calls itself/],
    ['async', 'export async function h(p: object) { return p; }', /it is async/],
    ['a generator', 'export function* h(p: object) { yield p; }', /it is a generator/],
    ['a getter', 'export function h(p: object) { return { get v() { return p; } }; }', /a method or an accessor/],
    ['a caught value', 'export function h(p: object) { try { return p; } catch (e) { return e; } }', /`e`, a caught value/],
    ['eval', 'export function h(s: string) { return eval(s); }', /`eval`/],
  ])('%s', (_, code, why) => {
    expect(flowsOf(code, ['h']).h).toMatch(why);
  });
});
