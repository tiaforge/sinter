// Numbered paths (IR v2) against the string matching they replace: the runtime's former `reach()`
// and `fill()`, kept here as the oracle, on random dependency and written paths, writer and reader
// scopes and marked rows. The build-time half (`staticReach`), the encoding (`decodeEntry`) and the
// runtime half (`passes`, `level`) together must answer as the oracle does, for every case.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../src/compiler/index.js';
import { compactIR, type IR } from '../src/ir.js';
import { decode, level, passes, staticReach, type Entry } from '../src/paths.js';

// ---- the oracle: src/runtime/app.ts before IR v2
interface Dep { p: string[]; n: Array<string | undefined>; a: number; t: number }
const toDep = (d: string): Dep => {
  const p = d.split('.'), a = p.findIndex((x) => x.startsWith('{$'));
  return { p, n: p.map((x) => (x[0] == '{' ? x.slice(1, -1) : undefined)), a, t: a < 0 ? -1 : +p[a]!.slice(3, -1) };
};
const fill = (p: string, s?: any) => (s && p.includes('{') ? p.split('.').map((x) => (x[0] == '{' ? '' + s[x.slice(1, -1)] : x)) : p.split('.'));
function reach({ p, n, a, t }: Dep, d: string[], s: any, marked: Set<unknown>, items: string[]): number {
  if (a >= 0 && d.length <= a && d[d.length - 1] != '**') return 0;
  let via = 2;
  for (let i = 0, len = Math.min(p.length, d.length); i < len; i++) {
    const y = d[i]!;
    if (y == '**') return 2;
    if (p[i] == '#') return d.length <= i + 1 ? 2 : 0;
    if (y == '#' || y == '~') {
      if (i != a) continue;
      if (y == '#' || (s && !marked.has(s[items[t]!]))) return 0;
      via = 1;
      continue;
    }
    if (y == '*' || (n[i] !== undefined && !s)) continue;
    if (n[i] !== undefined ? s[n[i]!] != y : p[i] != y && p[i] != '*') return 0;
  }
  return s ? 2 : via;
}

// ---- random cases
let seed = 7;
const rnd = (n: number) => ((seed = (seed * 16807) % 2147483647) % n);
const pick = <T>(a: T[]) => a[rnd(a.length)]!;
const DEP_SEGS = ['a', 'b', '0', '1', '2', '*', '#', '{i}', '{j}', '{$i0}', '{$i1}'];
const W_SEGS = ['a', 'b', '0', '1', '2', '*', '#', '~', '**', '{i}', '{j}', '{k}'];
const path = (segs: string[], max: number) => ['$s0', ...Array.from({ length: rnd(max) }, () => pick(segs))].join('.');
const items = ['x', 'y'];

describe('numbered paths answer as string matching did', () => {
  test('random dependency and written paths, writer and reader scopes, marked rows', () => {
    let reached = 0, checked = 0;
    for (let n = 0; n < 200_000; n++) {
      const dep = path(DEP_SEGS, 5), w = path(W_SEGS, 5);
      const rows = [{}, {}, {}], marked = new Set(rows.filter(() => rnd(2)));
      const writer = rnd(4) ? { i: rnd(3), j: pick([0, 1, 2, 'a', '']), k: rnd(3) } : undefined;
      const reader = rnd(3) ? { i: rnd(3), j: rnd(3), $i0: rnd(3), $i1: rnd(3), x: pick(rows), y: pick(rows) } : undefined;
      const want = reach(toDep(dep), fill(w, writer), reader, marked, items);
      // the runtime: the written node's slot values from the writer's scope, then the table's entry
      const slots = w.split('.').filter((x) => x[0] == '{').map((x) => x.slice(1, -1));
      const v = slots.map((name) => (writer ? '' + (writer as any)[name] : '{' + name + '}'));
      const r = staticReach(w, dep);
      const e = r && decode(r.conds.length ? [0, r.all ? 1 : 0, ...r.conds] : 0);
      const got = !e || !passes(e, v) ? 0 : level(e, v, reader, (t, s) => marked.has(s[items[t]!]));
      if (got !== want) expect({ dep, w, writer, reader, marked: rows.map((x) => marked.has(x)), got }).toEqual({ want });
      checked++;
      if (want) reached++;
    }
    // the cases cover both answers
    expect(checked).toBe(200_000);
    expect(reached).toBeGreaterThan(20_000);
    expect(checked - reached).toBeGreaterThan(20_000);
  });
});

describe('the table', () => {
  test('random pages: what the runtime reads from the table is what the compiler decided, pair by pair', () => {
    for (let n = 0; n < 400; n++) {
      const deps = [...new Set(Array.from({ length: 1 + rnd(12) }, () => path(DEP_SEGS, 4)))];
      const writes = [...new Set(Array.from({ length: 1 + rnd(8) }, () => path(W_SEGS, 4)))];
      const ir: IR = {
        v: 2, resources: [], actions: [], templates: [],
        roots: [{ id: 0, tag: 'p', sid: 0, state: 0, b: [{ k: 'text', f: 0, d: [...deps] }, { k: 'on', n: 'click', f: 0, w: [...writes] }] }],
      };
      const out = compactIR(ir), ps = out.ps!;
      const depIds = out.roots[0]!.b[0]!.d as number[], wIds = out.roots[0]!.b[1]!.w as number[];
      writes.forEach((w, wi) => {
        const got = new Map(((ps.r[wIds[wi]!] || []) as Entry[]).map(decode).map((e) => [e.d, e]));
        deps.forEach((d, di) => {
          const want = staticReach(w, d), e = got.get(depIds[di]!);
          if (!want) { if (e) expect({ w, d, got: e }).toBeUndefined(); return; }
          expect({ w, d, conds: e?.conds }).toEqual({ w, d, conds: want.conds });
          if (want.conds.length) expect(e!.all).toBe(want.all);
        });
        // nothing that is not one of the page's dependencies
        for (const k of got.keys()) expect(depIds).toContain(k);
      });
    }
  });
});

describe('the path table', () => {
  const page = `<html><body><section data-sn-state="{ rows: [{ v: 1 }, { v: 2 }], q: '' }">
    <input data-sn-model="q"><p data-sn-text="q"></p>
    <template data-sn-for="(r, i) in rows"><p><input data-sn-model="rows[i].v"><b data-sn-text="rows[i].v"></b></p></template>
    <button data-sn-on-click="rows.push({ v: 0 })">add</button>
  </section></body></html>`;
  const parts = () => compileParts(page, { file: '/p/x.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } });

  test('is the same for the same page, and numbers every path of the page module', () => {
    const a = compactIR(parts().ir), b = compactIR(parts().ir);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const paths = JSON.stringify(a).match(/"(d|w|deps)":\[[^\]]*\]/g)!;
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) expect(p).toMatch(/^"(d|w|deps)":\[(\d+(,\d+)*)?\]$/);
  });

  test('leaves the compiler\'s IR as it was', () => {
    const ir = parts().ir, before = JSON.stringify(ir);
    compactIR(ir);
    expect(JSON.stringify(ir)).toBe(before);
    expect((ir.roots.flatMap((n) => n.b.flatMap((b) => b.d ?? []))).every((d) => typeof d == 'string')).toBe(true);
  });

  test('a write through the row index reaches the row\'s bindings with the index left to check', () => {
    const ir: IR = compactIR(parts().ir), ps = ir.ps!;
    const model = ir.templates[0]!.nodes[0]!.b[0]!, w = model.w![0] as number;
    const reached = ((ps.r[w] || []) as Entry[]).map(decode);
    const e = reached.find((x) => x.d == model.d![0])!;
    // `rows.{$i0}.v` written from a row: the reader's row index equals the writer's
    expect(e.conds).toEqual([[1, '$i0', 0]]);
  });
});
