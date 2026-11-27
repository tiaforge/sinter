// Numbered paths (IR v2) against the string matching they replace: the runtime's former `reach()`
// and `fill()`, kept here as the oracle, on random dependency and written paths, writer and reader
// scopes and marked rows. The build-time half (`staticReach`), the encoding (`decodeEntry`) and the
// runtime half (`passes`, `level`) together must answer as the oracle does, for every case.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../src/compiler/index.js';
import { compactIR, type IR } from '../src/ir.js';
import { decode, level, numberPaths, passes, pruneWrites, staticReach, type Entry } from '../src/paths.js';

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
      // (the table itself, of every write: `compactIR` leaves out the writes another one covers, `pruneWrites` below)
      const out = structuredClone(ir), ps = numberPaths(out);
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

describe('the table, over many first segments', () => {
  // numberPaths checks a write whose first segment is a name only against the dependencies with that
  // name or a pattern first: every pair must still be what staticReach decides
  const HEADS = ['$s0', '$s1', '$s12', '$r', '*', '#', '{i}', '{$i0}', '**', '~'];
  const mixed = (segs: string[], max: number) => [pick(HEADS.filter((h) => segs.includes(h) || h[0] == '$')), ...Array.from({ length: rnd(max) }, () => pick(segs))].join('.');
  test('random pages: each written path reaches exactly the dependencies staticReach lets it', () => {
    let reached = 0;
    for (let n = 0; n < 600; n++) {
      const deps = [...new Set(Array.from({ length: 1 + rnd(16) }, () => mixed(DEP_SEGS, 3)))];
      const writes = [...new Set(Array.from({ length: 1 + rnd(10) }, () => mixed(W_SEGS, 3)))];
      const ir: IR = {
        v: 2, resources: [], actions: [], templates: [],
        roots: [{ id: 0, tag: 'p', sid: 0, state: 0, b: [{ k: 'text', f: 0, d: [...deps] }, { k: 'on', n: 'click', f: 0, w: [...writes] }] }],
      };
      // (the table itself, of every write: `compactIR` leaves out the writes another one covers, `pruneWrites` below)
      const out = structuredClone(ir), ps = numberPaths(out);
      const depIds = out.roots[0]!.b[0]!.d as number[], wIds = out.roots[0]!.b[1]!.w as number[];
      writes.forEach((w, wi) => {
        const entries = (ps.r[wIds[wi]!] || []) as Entry[];
        const got = entries.map(decode);
        // in id order, as before the grouping
        expect(got.map((e) => e.d)).toEqual([...got.map((e) => e.d)].sort((a, b) => a - b));
        const want = deps.flatMap((d, di) => { const r = staticReach(w, d); return r ? [{ d: depIds[di]!, conds: r.conds }] : []; })
          .sort((a, b) => a.d - b.d);
        expect({ w, got: got.filter((e) => depIds.includes(e.d)).map((e) => ({ d: e.d, conds: e.conds })) }).toEqual({ w, got: want });
        reached += want.length;
      });
    }
    expect(reached).toBeGreaterThan(1000);
  });
});

describe('a write list without the writes another of its writes covers', () => {
  // every question the runtime asks of a round's dirty paths, answered from the strings: what `index`, `hit`, `inside`
  // and `rowsOf` (src/runtime/app.ts) make of the list a handler marks, for one dependency
  const answers = (list: string[], dep: string, writer: any, reader: any, marked: Set<unknown>) => {
    let withScope = 0, any = 0, inside = false, all = false;
    const rows = new Set<string>();
    for (const w of list) {
      const r = staticReach(w, dep);
      if (!r) continue;
      const e = decode(r.conds.length ? [0, r.all ? 1 : 0, ...r.conds] : 0);
      const v = w.split('.').filter((x) => x[0] == '{').map((x) => (writer ? '' + writer[x.slice(1, -1)] : x));
      if (!passes(e, v)) continue;
      const isMarked = (t: number, s: any) => marked.has(s[items[t]!]);
      const l = level(e, v, reader, isMarked);
      withScope = Math.max(withScope, l);
      any = Math.max(any, level(e, v, undefined, isMarked));
      const W = w.split('.').length, D = dep.split('.').length;
      if (l > 0 && (w.endsWith('.**') ? W - 1 <= D : W > D)) inside = true;
      const c = e.conds.find((c) => (c[0] == 1 || c[0] == 2) && c[1] == '$i0');
      if (!c) all = true; else rows.add(String(c[0] == 1 ? v[c[2] as number] : c[2]));
    }
    return { withScope, any, inside, rows: all ? 'all' : [...rows].sort().join() };
  };
  const HEADS = ['$s0', '$s1', '$r.a', '$r.b'];
  const under = (segs: string[], max: number) => [pick(HEADS), ...Array.from({ length: rnd(max) }, () => pick(segs))].join('.');
  const page = (deps: string[], writes: string[], model?: Partial<IR['roots'][0]['b'][0]>): IR => ({
    v: 2, resources: [], actions: [], templates: [],
    roots: [{ id: 0, tag: 'p', sid: 0, state: 0, b: [{ k: 'text', f: 0, d: [...deps] }, model ? { k: 'model', f: 0, a: 0, n: 'text', w: [...writes], ...model } : { k: 'on', n: 'click', f: 0, w: [...writes] }] }],
  });

  test('random lists: every dependency gets the same answers from the list as from the whole one', () => {
    let shorter = 0, dropped = 0, reached = 0;
    for (let n = 0; n < 6000; n++) {
      const deps = [...new Set(Array.from({ length: 1 + rnd(10) }, () => (rnd(12) ? under(DEP_SEGS, 4) : pick(['$r', '$s0', '*', '{i}']))))];
      const covers = Array.from({ length: rnd(3) }, () => under(['a', 'b', '0'], 2) + '.**');
      const writes = [...new Set([...Array.from({ length: 1 + rnd(10) }, () => under(W_SEGS, 4)), ...covers])];
      const ir = page(deps, writes);
      pruneWrites(ir);
      const left = ir.roots[0]!.b[1]!.w as string[];
      // only writes leave, in their order, and never one that covers
      expect(writes.filter((w) => left.includes(w))).toEqual(left);
      if (left.length < writes.length) { shorter++; dropped += writes.length - left.length; }
      const rows = [{}, {}, {}], marked = new Set(rows.filter(() => rnd(2)));
      for (let k = 0; k < 4; k++) {
        const writer = rnd(4) ? { i: rnd(3), j: pick([0, 1, 2, 'a', '']), k: rnd(3) } : undefined;
        const reader = rnd(4) ? { i: rnd(3), j: rnd(3), $i0: rnd(3), $i1: rnd(3), x: pick(rows), y: pick(rows) } : undefined;
        for (const dep of deps) {
          const want = answers(writes, dep, writer, reader, marked), got = answers(left, dep, writer, reader, marked);
          if (JSON.stringify(got) != JSON.stringify(want)) expect({ dep, writes, left, writer, reader, got }).toEqual({ want });
          if (want.any) reached++;
        }
      }
    }
    // the cases cover lists that lose writes, and dependencies the lists reach
    expect(shorter).toBeGreaterThan(1000);
    expect(dropped).toBeGreaterThan(2000);
    expect(reached).toBeGreaterThan(20_000);
  });

  test('what is below the X of an `X.**` goes; X itself, another scope\'s writes, a pattern above X and the `**` stay', () => {
    const ir = page(['$s0.a.b', '$s1.q'], ['$s0.a', '$s0.**', '$s0.a.b', '$s0.rows.{i}.v', '$s0.rows.#', '$s0', '$s1.q', '$r.a.x', '*.a', '$s0.**.**']);
    pruneWrites(ir);
    expect(ir.roots[0]!.b[1]!.w).toEqual(['$s0.**', '$s0', '$s1.q', '$r.a.x', '*.a']);
    // a deeper `X.**` covers below X only
    const deep = page(['$r.a.list.{$i0}.n'], ['$r.a.list.**', '$r.a.list.{i}.n', '$r.a.total', '$r.a.list']);
    pruneWrites(deep);
    expect(deep.roots[0]!.b[1]!.w).toEqual(['$r.a.list.**', '$r.a.total', '$r.a.list']);
  });

  test('a write of X itself stays: it replaces an element, which a dependency on the list\'s structure reads', () => {
    const writes = ['$r.b.0.**', '$r.b.0'];
    const ir = page(['$r.b.#.a'], writes);
    pruneWrites(ir);
    expect(ir.roots[0]!.b[1]!.w).toEqual(writes);
    expect(answers(writes, '$r.b.#.a', undefined, undefined, new Set()).any).toBe(2);
    expect(answers(['$r.b.0.**'], '$r.b.#.a', undefined, undefined, new Set()).any).toBe(0);
  });

  test('a `**` below a dependency it reaches covers nothing: the runtime counts it as inside a value only from at or above', () => {
    const writes = ['$s0.a.b.**', '$s0.a.b.c'];
    const ir = page(['$s0.a'], writes);
    pruneWrites(ir);
    expect(ir.roots[0]!.b[1]!.w).toEqual(writes);
    // (the answer that would change: `$s0.a.b.c` is a change inside what `$s0.a` reads)
    expect(answers(writes, '$s0.a', undefined, undefined, new Set()).inside).toBe(true);
    expect(answers(['$s0.a.b.**'], '$s0.a', undefined, undefined, new Set()).inside).toBe(false);
  });

  test('a model keeps the path its control is bound to, its first; a persisted model keeps its list', () => {
    const writes = ['$s0.q', '$s0.**', '$s0.rows.{i}.v', '$s1.x'];
    const model = page(['$s0.q'], writes, {});
    pruneWrites(model);
    expect(model.roots[0]!.b[1]!.w).toEqual(['$s0.q', '$s0.**', '$s1.x']);
    const persisted = page(['$s0.q'], writes, { p: 'q' });
    pruneWrites(persisted);
    expect(persisted.roots[0]!.b[1]!.w).toEqual(writes);
  });

  test('the page module: a path only the writes left out named has no node', () => {
    const ir = page(['$s0.n'], ['$s0.**', '$s0.n', '$s0.other.deep']);
    const out = compactIR(ir);
    expect((out.roots[0]!.b[1]!.w as number[]).length).toBe(1);
    // `$s0`, its `**`, `$error` (the runtime's own) and `n` (read); `$locale`, `$now`, `$url`: no `other`, no `deep`
    expect(out.ps!.p.length).toBe(compactIR(page(['$s0.n'], ['$s0.**'])).ps!.p.length);
    expect(out.ps!.p.length).toBeLessThan(structuredClone(ir) && numberPaths(structuredClone(ir)).p.length);
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
