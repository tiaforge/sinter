// Numbered dependency paths (IR v2): the compiler's string paths become node ids of one trie per
// page, and which binding dependencies each written path can reach is decided here, at build time.
// The runtime keeps no segment names: a written path is a node id plus the values its `{name}`
// segments take from the writer's scope, and the reach table says which dependency nodes it touches
// and which runtime checks remain (row indexes, marked rows).
import type { ActionDef, Binding, IR, NodeDef, PathTable, ResourceDef } from './ir.js';

/**
 * A runtime check of one reach entry:
 * - `[0, k, lit]`: the written path's `k`th `{…}` value equals `lit` (a segment the dependency names);
 * - `[1, name, k]`: with a scope, the reader's `name` (a loop index) loosely equals the `k`th value;
 * - `[2, name, lit]`: with a scope, the reader's `name` loosely equals `lit` (a segment the write names);
 * - `[3, t]`: the row's own element of template `t` was marked (written through a callback).
 */
export type Cond = [0, number, string] | [1, string, number] | [2, string, string] | [3, number];

/**
 * A reach entry as the table stores it: a dependency node reached without checks, or
 * `[node, flags, ...conditions]` (flags 1: a `**` ended the match) for one reached with checks.
 */
export type Entry = number | [number, 0 | 1, ...Cond[]];

const special = (seg: string) => seg == '*' || seg == '#' || seg == '~' || seg == '**' || seg[0] == '{';

interface Static { segs: string[]; a: number; t: number }
const parse = (p: string): Static => {
  const segs = p.split('.'), a = segs.findIndex((x) => x.startsWith('{$'));
  return { segs, a, t: a < 0 ? -1 : +segs[a]!.slice(3, -1) };
};

/**
 * Whether written path `w` can reach dependency `d`, and what is left to check at runtime: the
 * build-time half of the runtime's former `reach()`, segment by segment. `{name}` segments of the
 * write are slots, filled from the writer's scope when it marks the path.
 */
export function staticReach(w: string, d: string): { conds: Cond[]; all: boolean } | null {
  const W = w.split('.'), D = parse(d), p = D.segs, a = D.a;
  if (a >= 0 && W.length <= a && W[W.length - 1] != '**') return null;
  const conds: Cond[] = [];
  const slot = (i: number) => W.slice(0, i).filter((x) => x[0] == '{').length;
  for (let i = 0, len = Math.min(p.length, W.length); i < len; i++) {
    const y = W[i]!, pi = p[i]!, isSlot = y[0] == '{';
    if (y == '**') return { conds, all: true };
    if (pi == '#') return W.length <= i + 1 ? { conds, all: true } : null;
    if (y == '#' || y == '~') {
      if (i != a) continue;
      if (y == '#') return null;
      conds.push([3, D.t]);
      continue;
    }
    if (y == '*') continue;
    if (pi[0] == '{') { conds.push(isSlot ? [1, pi.slice(1, -1), slot(i)] : [2, pi.slice(1, -1), y]); continue; }
    if (isSlot) { if (pi != '*') conds.push([0, slot(i), pi]); continue; }
    if (pi != y && pi != '*') return null;
  }
  return { conds, all: false };
}

/** Every path field of the IR, by visitor: `dep` for paths read, `write` for paths written. */
export function eachPath(ir: IR, dep: (p: any, set: (n: number) => void) => void, write: (p: any, set: (n: number) => void) => void) {
  const list = (o: any, key: string, f: typeof dep) => {
    const v = o[key] as Array<string | number> | undefined;
    if (v) v.forEach((p, i) => f(p as string, (n) => { v[i] = n; }));
  };
  const binding = (b: Binding) => {
    list(b, 'd', dep);
    if (b.s) list(b.s, 'd', dep);
    list(b, 'w', write);
    // a persisted model's write is matched against dirty paths too (the persist feature saves on a change)
    if (b.k == 'model' && b.p != null) b.w?.forEach((p) => dep(p, () => {}));
  };
  const nodes = (ns: NodeDef[]) => { for (const n of ns) n.b.forEach(binding); };
  nodes(ir.roots);
  for (const t of ir.templates) nodes(t.nodes);
  for (const r of ir.resources as ResourceDef[]) { list(r, 'deps', dep); list(r, 'w', write); }
  for (const s of ir.syncs ?? []) for (const e of s.events) list(e, 'w', write);
  for (const a of ir.actions as ActionDef[]) list(a, 'w', write);
}

/**
 * A write list without the paths another of its own writes covers, in place (the IR's paths still strings; call it on
 * a copy). A handler whose writes the compiler cannot follow (through an alias it cannot trace) writes everything
 * below every state scope and resource (`$s<sid>.**`, `$r.<name>.**`: compile.ts `applyAliases`) and, beside those,
 * every single path it found on the way: on a page with many scopes, a hundred paths a handler, each a mark per run.
 *
 * `X.**` reaches every dependency a write below `X` reaches, with no more checks than that write has (the checks
 * `staticReach` collects along `X` are the same for both, and it returns at `**`), and it reaches each as a change
 * anywhere inside the value: every question the runtime asks of a round's dirty paths (`hit`, `hits`, `inside`, the
 * rows a change reaches, a state scope changed) is whether some dirty path does, so with `X.**` in the list the other
 * path changes no answer (test/paths.test.ts asks them all of random lists). What stays as it is: a write of `X` itself
 * (it replaces the value, which a dependency on the structure of the list holding it reads, `#`; a change inside does
 * not), a model's first write (the path its control is bound to, which typing.ts reads there), the list of a persisted
 * model (persist.ts matches its paths as dependencies), and what a `X.**` that reaches a dependency shorter than `X`
 * would cover (the runtime's `inside` counts a `**` as inside a value only from at or above the dependency).
 */
export function pruneWrites(ir: IR): void {
  const deps = new Set<string>(), lists = new Set<string[]>(), kept = new Set<unknown>(), first = new Set<unknown>();
  const own = (o: { w?: unknown }) => { if (o.w) lists.add(o.w as string[]); };
  const nodes = (ns: NodeDef[]) => { for (const n of ns) for (const b of n.b) { if (b.k == 'model') (b.p != null ? kept : first).add(b.w); own(b); } };
  eachPath(ir, (p) => deps.add(p), () => {});
  nodes(ir.roots);
  for (const t of ir.templates) nodes(t.nodes);
  ir.resources.forEach(own);
  for (const s of ir.syncs ?? []) s.events.forEach(own);
  ir.actions.forEach(own);
  // the `X` of a write `X.**` that covers (`X` plain names below a state scope or a resource): null when it does not
  const covers = new Map<string, string | null>();
  const cover = (w: string): string | null => {
    let x = covers.get(w);
    if (x !== undefined) return x;
    const m = /^((?:\$s\d+|\$r\.[^.{*#~]+)(?:\.[^.{*#~]+)*)\.\*\*$/.exec(w), n = m ? m[1]!.split('.').length : 0;
    x = m && ![...deps].some((d) => d.split('.').length < n && staticReach(w, d)) ? m[1]! : null;
    covers.set(w, x);
    return x;
  };
  for (const l of lists) {
    if (kept.has(l) || l.some((p) => typeof p != 'string')) continue;
    const xs = l.map(cover).filter((x) => x != null);
    if (!xs.length) continue;
    const out = l.filter((p, i) => (!i && first.has(l)) || !xs.some((x) => p.startsWith(x + '.') && p != x + '.**'));
    if (out.length < l.length) l.splice(0, l.length, ...out);
  }
}

/** The paths the runtime marks by itself, by name in the table's `x`: the page's fixed inputs, each resource, each state scope. */
export function fixedPaths(ir: Pick<IR, 'resources' | 'roots' | 'templates' | 'lm'>): string[] {
  const sids = new Set<number>();
  for (const n of [...ir.roots, ...ir.templates.flatMap((t) => t.nodes)]) if (n.sid != null) sids.add(n.sid);
  return [
    '$locale', '$url', '$now',
    ...ir.resources.flatMap((r) => [`$r.${r.name}`, `$meta.${r.name}`, ...(r.paginate?.model ? [`$url.${r.paginate.model}`] : [])]),
    ...[...sids].sort((a, b) => a - b).flatMap((s) => [`$s${s}.**`, `$s${s}.$error`]),
    // a lazy helper module has arrived (lets.ts)
    ...(ir.lm ?? []).map((_, i) => `$lz.${i}`),
  ];
}

/**
 * Numbers the IR's paths in place (call it on a copy): one trie of every path read or written,
 * numbered in pre-order with children sorted by name, so the same page always gets the same ids.
 * Returns the table the runtime reads instead of the names.
 */
export function numberPaths(ir: IR, withNames = false): PathTable {
  const deps = new Set<string>(), writes = new Set<string>(fixedPaths(ir));
  eachPath(ir, (p) => deps.add(p), (p) => writes.add(p));
  type T = { kids: Map<string, T>; id: number };
  const top: T = { kids: new Map(), id: -1 };
  const insert = (p: string) => {
    let t = top;
    for (const s of p.split('.')) { let c = t.kids.get(s); if (!c) t.kids.set(s, (c = { kids: new Map(), id: -1 })); t = c; }
  };
  for (const p of [...deps, ...writes]) insert(p);
  const parents: number[] = [], kinds: Record<number, string> = {}, names: string[] = [];
  const visit = (t: T, parent: number) => {
    for (const k of [...t.kids.keys()].sort()) {
      const c = t.kids.get(k)!;
      c.id = parents.length;
      parents.push(parent);
      names.push(k);
      if (special(k)) kinds[c.id] = k;
      visit(c, c.id);
    }
  };
  visit(top, -1);
  const idOf = (p: string) => { let t = top; for (const s of p.split('.')) t = t.kids.get(s)!; return t.id; };
  // the reach table: for each written node, the dependency nodes it can touch, with what remains to check
  const reach: Array<Entry[] | 0> = parents.map(() => 0);
  const depList = [...deps].sort((a, b) => idOf(a) - idOf(b));
  // a write whose first segment is a plain name reaches only the dependencies that start with that
  // name or with a pattern (`*`, `#`, `{…}`), which staticReach decides at the first segment: grouped
  // once, so each write is checked against its group rather than every dependency
  const head = (p: string) => { const i = p.indexOf('.'); return i < 0 ? p : p.slice(0, i); };
  const open = (seg: string) => seg == '*' || seg == '#' || seg[0] == '{';
  const byHead = new Map<string, string[]>(), anyHead: string[] = [];
  for (const d of depList) { const h = head(d); if (open(h)) anyHead.push(d); else { let g = byHead.get(h); if (!g) byHead.set(h, (g = [])); g.push(d); } }
  const candidates = (w: string): string[] => {
    const h = head(w);
    if (special(h)) return depList;
    const own = byHead.get(h) ?? [];
    return anyHead.length ? [...own, ...anyHead].sort((a, b) => idOf(a) - idOf(b)) : own;
  };
  for (const w of [...writes].sort((a, b) => idOf(a) - idOf(b))) {
    const out: Entry[] = [];
    for (const d of candidates(w)) {
      const r = staticReach(w, d);
      // without checks left, whether a `**` ended the match changes nothing
      if (r) out.push(r.conds.length ? [idOf(d), r.all ? 1 : 0, ...r.conds] : idOf(d));
    }
    if (out.length) reach[idOf(w)] = out;
  }
  const x: Record<string, number> = {};
  for (const p of fixedPaths(ir)) x[p] = idOf(p);
  // an array the IR shares between two fields is numbered once
  const num = (p: string, set: (n: number) => void) => { if (typeof p == 'string') set(idOf(p)); };
  eachPath(ir, num, num);
  // trailing nodes nothing writes need no entry
  while (reach.length && reach[reach.length - 1] === 0) reach.pop();
  return { p: parents, ...(Object.keys(kinds).length ? { k: kinds } : {}), r: reach, x, ...(withNames ? { n: names } : {}) };
}

/** Whether dirty path `d` (a node, -1 for none) is a change inside state scope `sid`: its top segment is `$s<sid>`. */
export const inState = (ps: PathTable, d: { w: number }, sid: number) => {
  let n = d.w;
  while (n >= 0 && ps.p[n]! >= 0) n = ps.p[n]!;
  return n >= 0 && n == ps.p[ps.x[`$s${sid}.**`]!];
};

/** A reach entry for the runtime: the dependency node, whether a `**` ended the match, and the checks left. */
export interface Reach { d: number; all: boolean; conds: Cond[] }
const NONE: Cond[] = [];
export const decode = (e: Entry): Reach => (typeof e == 'number' ? { d: e, all: false, conds: NONE } : { d: e[0], all: e[1] == 1, conds: e.slice(2) as Cond[] });

/** The checks that need no scope: a segment the dependency names, written as a scope value, is that value. */
export const passes = (e: Reach, v: string[]) => !e.conds.some((c) => c[0] == 0 && v[c[1]] !== c[2]);

/**
 * How a dirty path with values `v` reaches a dependency through entry `e` (whose scope-free checks
 * passed), the dependency's `{name}` segments read from scope `s` (any scope when absent): 0 not,
 * 1 only through a marked element (`~`) of the row, 2 it does. `marked(t, s)`: whether the row element
 * of template `t` in scope `s` was marked.
 */
export function level(e: Reach, v: string[], s: any, marked: (t: number, s: any) => boolean): number {
  if (!s) return e.all || !e.conds.some((c) => c[0] == 3) ? 2 : 1;
  for (const c of e.conds) {
    if (c[0] == 1 ? s[c[1]] != v[c[2]] : c[0] == 2 ? s[c[1]] != c[2] : c[0] == 3 && !marked(c[1], s)) return 0;
  }
  return 2;
}
