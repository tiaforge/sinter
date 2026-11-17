// Spike (docs/proposals/compile-once.md, (5)): shared definitions compiled once per build and linked into each page.
// A top-level `definition()` call on one page is recorded as what it changed in the compiler (its *unit*); a later page
// that reaches the same definition with the same definitions before it replays the unit instead of compiling it: the
// objects the call created are copied, template ids, use ids and function indices are renumbered, and the function
// table's hand-outs are replayed in order (so its dedupe and numbering are the page's own). Generic over the
// `Compiler`'s fields; what it does not understand makes the unit unlinkable, and the page compiles it as before.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Ref = { path: Step[] } | { at: 'el' | 'site' } | { self: 'opts' | 'page' | 'compiler' } | { prior: { u: number; i: number } };
type Change = { kind: 'set'; key: unknown; value: unknown } | { kind: 'add'; value: unknown } | { kind: 'prop'; key: string | number; value: unknown } | { kind: 'push'; value: unknown };
type Op =
  | { op: 'mapSet'; path: string[]; key: unknown; value: unknown }
  | { op: 'setAdd'; path: string[]; value: unknown }
  | { op: 'push'; path: string[]; value: unknown }
  | { op: 'into'; path: string[]; key: unknown; values: unknown[] }
  | { op: 'intoSet'; path: string[]; key: unknown; values: unknown[] }
  | { op: 'intoMap'; path: string[]; key: unknown; entries: Array<[unknown, unknown]> }
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; change: Change };
export type Unit = {
  name: string;
  file: string;
  ops: Op[];
  calls: Array<{ code: string; rec: number }>;
  fnAt: Map<number, unknown>;
  templates: unknown[];
  t0: number;
  u0: number;
  uses: number;
  at: any;
  atAfter: any;
  refs: Map<object, Ref>;
};
export type Refused = { refused: string };

/** fields replayed by `fn()` itself, or kept as they are */
const SKIP = new Set(['fns', 'fnIndex', 'fnUses', 'fnAt', 'callAt', 'inDef', 'at', 'lineStarts', 'templates', 'defLink', 'graphs']);
const TID_KEYED = new Set(['headTemplates', 'templateAt', 'caseFill']);
const USE_KEYED = new Set(['useById']);
const container = (v: unknown) => v instanceof Map || v instanceof Set || Array.isArray(v);
/** shared as it is, never copied: frozen, or a parse5 source location (the parse cache's, which every copy of a node shares) */
const shared = (o: object) => Object.isFrozen(o) || ('startOffset' in o && 'endOffset' in o);

/** the compiler's fields, one level into plain objects (`page`), as shallow copies */
function snapshot(c: any) {
  const out = new Map<string, { path: string[]; kind: 'map' | 'set' | 'array'; copy: any; inner: Map<unknown, any> }>();
  const scalars = new Map<string, unknown>();
  const take = (path: string[], v: any) => {
    const key = path.join('.');
    if (v instanceof Map) {
      // the containers it holds, as they were: a list by its length, a set or a map as a copy
      const inner = new Map<unknown, any>();
      for (const x of v.values()) if (container(x)) inner.set(x, x instanceof Map ? new Map(x) : x instanceof Set ? new Set(x) : x.length);
      out.set(key, { path, kind: 'map', copy: new Map(v), inner });
    } else if (v instanceof Set) out.set(key, { path, kind: 'set', copy: new Set(v), inner: new Map() });
    else if (Array.isArray(v)) out.set(key, { path, kind: 'array', copy: v.slice(), inner: new Map() });
  };
  for (const k of Object.keys(c)) {
    if (SKIP.has(k)) continue;
    const v = c[k];
    if (v instanceof WeakMap || v instanceof WeakSet) continue;
    if (container(v)) take([k], v);
    else if (v === null || typeof v !== 'object') scalars.set(k, v);
    else if (Object.getPrototypeOf(v) === Object.prototype) {
      scalars.set(k, v);
      for (const p of Object.keys(v)) if (container(v[p])) take([k, p], v[p]);
    } else scalars.set(k, v);
  }
  return { out, scalars };
}

const at = (c: any, path: string[]) => path.reduce((o, p) => o?.[p], c);

/** everything reachable from the values, as a set (no WeakMaps: they cannot be walked) */
function reach(roots: unknown[], into = new Set<object>(), stop?: (o: object) => boolean) {
  const todo = [...roots];
  while (todo.length) {
    const v = todo.pop();
    if (!v || typeof v !== 'object' || into.has(v)) continue;
    if (stop?.(v)) continue;
    into.add(v);
    if (v instanceof Map) for (const [k, x] of v) { todo.push(k, x); }
    else if (v instanceof Set) for (const x of v) todo.push(x);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else if (!(v instanceof WeakMap) && !(v instanceof WeakSet)) for (const k of Object.keys(v)) todo.push((v as any)[k]);
  }
  return into;
}

/**
 * Runs `call` (a top-level `definition()`) and records what it changed. The unit holds a private copy of what the call
 * created, so the page that recorded it may go on changing its own.
 */
/** a step from a compiler field to an old object: a property, a map's key, a list's index */
type Step = { p: string } | { k: unknown } | { i: number };

/** the first path to each old object, from the compiler's fields: through properties, map keys and lists, not markup */
function paths(c: any, old: Set<object>): Map<object, Step[]> {
  const out = new Map<object, Step[]>();
  const todo: Array<[unknown, Step[]]> = [];
  for (const k of Object.keys(c)) if (!SKIP.has(k)) todo.push([c[k], [{ p: k }]]);
  for (let n = 0; n < todo.length; n++) {
    const [v, path] = todo[n]!;
    if (!v || typeof v !== 'object' || out.has(v) || !old.has(v) || Object.isFrozen(v)) continue;
    out.set(v, path);
    if ('nodeName' in (v as object)) continue;
    if (v instanceof Map) { for (const [k, x] of v) if (k === null || typeof k !== 'object') todo.push([x, [...path, { k }]]); }
    else if (Array.isArray(v)) v.forEach((x, i) => todo.push([x, [...path, { i }]]));
    else if (!(v instanceof Set) && !(v instanceof WeakMap) && !(v instanceof WeakSet)) for (const k of Object.keys(v)) todo.push([(v as any)[k], [...path, { p: k }]]);
  }
  return out;
}

const follow = (c: any, path: Step[]) => path.reduce((o: any, s) => (o == null ? undefined : 'p' in s ? o[s.p] : 'k' in s ? o.get(s.k) : o[s.i]), c);

/** a shallow copy of an object, to see what a call changed in it */
const shallow = (o: any) => (o instanceof Map ? new Map(o) : o instanceof Set ? new Set(o) : Array.isArray(o) ? o.slice() : Object.assign(Object.create(null), o));

/**
 * Runs `call` (a top-level `definition()`) and records what it changed. The unit holds a private copy of what the call
 * created, so the page that recorded it may go on changing its own.
 */
export function record<T>(c: any, name: string, call: () => T, prior: Map<object, { u: number; i: number }>): { result: T; unit: Plan | Refused } {
  const pre = snapshot(c);
  const t0 = c.templates.length, u0 = c.useIds, atBefore = c.at;
  // what exists before the call: the compiler's state and the page's markup (from the element being compiled)
  const old = new Set<object>();
  let top = atBefore?.el;
  while (top?.parentNode) top = top.parentNode;
  reach([...Object.keys(c).filter((k) => !SKIP.has(k) && !(c[k] instanceof WeakMap)).map((k) => c[k]), top, atBefore], old, (o) => Object.isFrozen(o));
  // (the compiler's own tables: diffed as tables above, or replayed by `fn()`, or caches)
  const fieldBoxes = new Set<object>([...pre.out.values()].map((x) => at(c, x.path)));
  for (const k of Object.keys(c)) if (c[k] && typeof c[k] === 'object' && (container(c[k]) || SKIP.has(k))) fieldBoxes.add(c[k]);
  const before = new Map<object, any>();
  for (const o of old) if (o !== c && !fieldBoxes.has(o) && !(o instanceof WeakMap) && !(o instanceof WeakSet)) before.set(o, shallow(o));
  const weakNames = new Map<WeakMap<object, unknown>, string>();
  for (const k of Object.keys(c)) if (c[k] instanceof WeakMap) weakNames.set(c[k], k);
  const weak: Op[] = [];
  const set0 = WeakMap.prototype.set;
  WeakMap.prototype.set = function (this: WeakMap<object, unknown>, k: object, v: unknown) {
    const f = weakNames.get(this);
    if (f) weak.push({ op: 'weak', field: f, key: k, value: v });
    return set0.call(this, k, v) as never;
  };
  const calls: Array<{ code: string; rec: number }> = [];
  const fn0 = c.fn;
  c.fn = function (code: string, site?: unknown) { const i = fn0.call(c, code, site); calls.push({ code, rec: i }); return i; };
  const f0 = c.fns.length;
  let result: T;
  try { result = call(); } finally { WeakMap.prototype.set = set0; delete c.fn; }
  const refuse = (why: string) => ({ result, unit: { refused: why } as Refused });
  // (the element compiled last: the page goes on with it as the site of what it compiles next)
  const atAfter = c.at;
  // what changed in the compiler's tables
  const ops: Op[] = [];
  for (const [key, s] of pre.out) {
    const now = at(c, s.path);
    if (s.kind === 'map') {
      for (const k of s.copy.keys()) if (!now.has(k)) return refuse(`${key}: a key deleted`);
      for (const [k, v] of now) if (!s.copy.has(k) || s.copy.get(k) !== v) ops.push({ op: 'mapSet', path: s.path, key: k, value: v });
    } else if (s.kind === 'set') {
      for (const x of s.copy) if (!now.has(x)) return refuse(`${key}: an item deleted`);
      for (const x of now) if (!s.copy.has(x)) ops.push({ op: 'setAdd', path: s.path, value: x });
    } else {
      if (now.length < s.copy.length) return refuse(`${key}: shrank`);
      for (let i = 0; i < s.copy.length; i++) if (now[i] !== s.copy[i]) return refuse(`${key}[${i}] changed in place`);
      for (const x of now.slice(s.copy.length)) ops.push({ op: 'push', path: s.path, value: x });
    }
  }
  for (const [k, v] of pre.scalars) if (c[k] !== v && k !== 'useIds') return refuse(`\`${k}\` changed (${String(v)} → ${String(c[k])})`);
  for (const k of Object.keys(c)) if (!pre.scalars.has(k) && !pre.out.has(k) && !SKIP.has(k) && !(c[k] instanceof WeakMap) && !(c[k] instanceof WeakSet)) return refuse(`\`${k}\` added`);
  // what changed in the objects from before: each against its path from the compiler
  const where = paths(c, old);
  const changed: Array<{ target: object; change: Change }> = [];
  for (const [o, b] of before as Map<any, any>) {
    if (o instanceof Map) {
      for (const k of b.keys()) if (!o.has(k)) return refuse('a map from before lost a key');
      for (const [k, v] of o) if (!b.has(k) || b.get(k) !== v) changed.push({ target: o, change: { kind: 'set', key: k, value: v } });
    } else if (o instanceof Set) {
      for (const x of b) if (!o.has(x)) return refuse('a set from before lost an item');
      for (const x of o) if (!b.has(x)) changed.push({ target: o, change: { kind: 'add', value: x } });
    } else if (Array.isArray(o)) {
      if (o.length < b.length) return refuse('a list from before shrank');
      for (let i = 0; i < b.length; i++) if (o[i] !== b[i]) changed.push({ target: o, change: { kind: 'prop', key: i, value: o[i] } });
      for (const x of o.slice(b.length)) changed.push({ target: o, change: { kind: 'push', value: x } });
    } else {
      for (const k of Object.keys(b)) if (!(k in o)) return refuse(`\`${k}\` deleted from an object from before`);
      for (const k of Object.keys(o)) if (o[k] !== b[k]) changed.push({ target: o, change: { kind: 'prop', key: k, value: o[k] } });
    }
  }
  for (const x of changed) {
    const path = prior.has(x.target) ? null : where.get(x.target);
    if (!prior.has(x.target) && !path) {
      const t: any = x.target;
      const inWeak = Object.keys(c).filter((k) => c[k] instanceof WeakMap).find((k) => { let hit = false; return hit; });
      const sample = Array.isArray(t) ? t.slice(0, 2).map((e: any) => (e && typeof e === 'object' ? (e.nodeName ? '<' + e.tagName + '>' : '{' + Object.keys(e).slice(0, 5).join(',') + '}') : String(e))).join(' ') : '';
      return refuse(`changes an object from before that has no key (${t.constructor?.name ?? 'object'}: ${t.nodeName ?? Object.keys(t).slice(0, 6).join(', ')}; ${(x.change as any).key ?? x.change.kind}; ${sample}${inWeak ?? ''})`);
    }
    ops.push({ op: 'old', target: prior.has(x.target) ? { prior: prior.get(x.target)! } : { path: path! }, change: x.change });
  }
  ops.push(...weak);
  // an old object the unit refers to: by its path from the compiler, made by an earlier unit, the element being compiled, or shared
  const refs = new Map<object, Ref>([[c.opts, { self: 'opts' }], [c.page, { self: 'page' }], [c, { self: 'compiler' }]]);
  if (atBefore) refs.set(atBefore, { at: 'site' });
  if (atBefore?.el) refs.set(atBefore.el, { at: 'el' });
  const templates = c.templates.slice(t0);
  const fnAt = new Map<number, unknown>();
  for (let i = f0; i < c.fns.length; i++) fnAt.set(i, c.fnAt[i]);
  // what the call created: everything reachable from what it wrote, up to the old objects at its edge
  const created = new Set<object>();
  const todo: unknown[] = [ops.map((o) => ('change' in o ? o.change : o)), templates, [...fnAt.values()], atAfter];
  while (todo.length) {
    const v = todo.pop();
    if (!v || typeof v !== 'object' || created.has(v) || shared(v) || refs.has(v)) continue;
    if (old.has(v) || prior.has(v)) {
      if (prior.has(v)) { refs.set(v, { prior: prior.get(v)! }); continue; }
      const path = where.get(v);
      if (!path) return refuse(`refers to an object from before that has no key (${(v as any).constructor?.name ?? 'object'}: ${(v as any).nodeName ?? Object.keys(v).slice(0, 6).join(', ')})`);
      refs.set(v, { path });
      continue;
    }
    created.add(v);
    if (v instanceof Map) for (const [k, x] of v) todo.push(k, x);
    else if (v instanceof Set) for (const x of v) todo.push(x);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else for (const k of Object.keys(v)) todo.push((v as any)[k]);
  }
  for (const o of created) {
    if (typeof o === 'function') return refuse('holds a function');
    for (const k of Object.keys(o)) if (typeof (o as any)[k] === 'function') return refuse(`holds a function (\`${k}\` of ${Object.keys(o).slice(0, 5).join(', ')})`);
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== null) return refuse(`holds a ${o.constructor?.name}`);
  }
  const unit: Unit = { name, file: c.opts.file, ops, calls, fnAt, templates, t0, u0, uses: c.useIds - u0, at: atBefore, atAfter, refs };
  return { result, unit: keep(unit, prior) };
}

// A unit as a plan: the objects it created as a flat list, their values classified once (a plain value, another object of
// the plan `R`, an object of the page `X`, a string to renumber `S`), and the numbers to renumber in each.
class R { constructor(readonly i: number) {} }
class X { constructor(readonly j: number) {} }
class S { constructor(readonly s: string) {} }
type Fix = [number, 'fn' | 'tid' | 'tids' | 'use'];
type Entry = { t: 0 | 1 | 2 | 3; proto: object | null; keys?: string[]; vals: unknown[]; fix?: Fix[] };
type PlanOp =
  | { op: 'mapSet'; path: string[]; key: unknown; value: unknown }
  | { op: 'setAdd' | 'push'; path: string[]; value: unknown }
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; kind: Change['kind']; key?: unknown; value: unknown };
export type Plan = { id: number; name: string; file: string; objs: Entry[]; ext: Ref[]; ops: PlanOp[]; calls: Unit['calls']; fnAt: Array<[number, unknown]>; templates: unknown[]; t0: number; u0: number; uses: number; atAfter: unknown };
let units = 0;
const NEEDS = /\$p\d|\$sl\d|sn-t-\d|#case\d/;

/** which of an object's numbers are template ids, function indices or use ids (as `copy` did, decided once) */
function fixesOf(o: any, keys: string[]): Fix[] | undefined {
  const out: Fix[] = [];
  const at = (k: string, kind: Fix[1]) => { const i = keys.indexOf(k); if (i >= 0) out.push([i, kind]); };
  if (typeof o.k === 'string' && !('tagName' in o) && !('nodeName' in o)) {
    if (typeof o.f === 'number') at('f', 'fn');
    if (typeof o.a === 'number') at('a', 'fn');
    if (typeof o.x === 'number' && (o.k === 'for' || o.k === 'if' || o.k === 'else')) at('x', 'tid');
    if (typeof o.z === 'number') at('z', 'tid');
    if (Array.isArray(o.c)) at('c', 'tids');
  }
  if (Array.isArray(o.nodes) && typeof o.id === 'number' && !('tag' in o)) { at('id', 'tid'); for (const k of ['key', 'find', 'make']) if (typeof o[k] === 'number') at(k, 'fn'); }
  if (typeof o.tid === 'number') at('tid', 'tid');
  if (Array.isArray(o.cases) && o.cases.every((x: unknown) => typeof x === 'number')) at('cases', 'tids');
  if (typeof o.id === 'number' && 'runtime' in o && 'outer' in o) at('id', 'use');
  return out.length ? out : undefined;
}

/** the unit as a plan: what it created read once into a flat list (the page that recorded it goes on changing its objects) */
function keep(u: Unit, prior: Map<object, { u: number; i: number }>): Plan {
  const id = units++;
  const objs: Entry[] = [], index = new Map<object, number>(), ext: Ref[] = [], extIndex = new Map<object, number>();
  const live: object[] = [];
  const enc = (v: any): unknown => {
    if (typeof v === 'string') return v === u.file || NEEDS.test(v) ? new S(v) : v;
    if (!v || typeof v !== 'object') return v;
    if (shared(v)) return v;
    const r = u.refs.get(v);
    if (r) { let j = extIndex.get(v); if (j === undefined) { extIndex.set(v, (j = ext.push(r) - 1)); } return new X(j); }
    let i = index.get(v);
    if (i === undefined) { index.set(v, (i = objs.push(null as never) - 1)); live.push(v); }
    return new R(i);
  };
  const ops: PlanOp[] = u.ops.map((o) => {
    if (o.op === 'old') {
      const ch: any = o.change;
      return { op: 'old', target: o.target as never, kind: ch.kind, ...('key' in ch ? { key: enc(ch.key) } : {}), value: enc(ch.value) };
    }
    if (o.op === 'weak') return { op: 'weak', field: o.field, key: enc(o.key), value: enc(o.value) };
    if (o.op === 'mapSet') return { op: 'mapSet', path: o.path, key: enc(o.key), value: enc(o.value) };
    return { op: o.op as 'setAdd' | 'push', path: (o as any).path, value: enc((o as any).value) };
  });
  const templates = u.templates.map(enc), fnAt: Array<[number, unknown]> = [...u.fnAt].map(([k, v]) => [k, enc(v)]), atAfter = enc(u.atAfter);
  // each object once, its values classified (the list grows as they reach further)
  for (let n = 0; n < live.length; n++) {
    const v: any = live[n];
    if (v instanceof Map) { const vals: unknown[] = []; for (const [k, x] of v) vals.push(enc(k), enc(x)); objs[n] = { t: 2, proto: null, vals }; }
    else if (v instanceof Set) objs[n] = { t: 3, proto: null, vals: [...v].map(enc) };
    else if (Array.isArray(v)) objs[n] = { t: 1, proto: null, vals: v.map(enc) };
    else { const keys = Object.keys(v); objs[n] = { t: 0, proto: Object.getPrototypeOf(v), keys, vals: keys.map((k) => enc(v[k])), ...(fixesOf(v, keys) ? { fix: fixesOf(v, keys) } : {}) }; }
  }
  for (const [o, i] of index) prior.set(o, { u: id, i });
  return { id, name: u.name, file: u.file, objs, ext, ops, calls: u.calls, fnAt, templates, t0: u.t0, u0: u.u0, uses: u.uses, atAfter };
}

/** per page: how the units linked into it renumber what they recorded, and the objects each made here */
type PageMaps = { tid: Map<number, number>; fn: Map<number, number>; use: Map<number, number>; outs: Map<number, unknown[]>; strs: Map<string, string> };

/** The unit linked into the page `c`; false when it cannot be (nothing changed then). */
export function replay(c: any, u: Plan, maps: PageMaps): boolean {
  // the objects of the page it refers to, first: a unit that cannot be linked changes nothing
  const ext: unknown[] = [];
  for (const r of u.ext) {
    const v = 'prior' in r ? maps.outs.get((r.prior as any).u)?.[(r.prior as any).i] : 'self' in r ? (r.self === 'opts' ? c.opts : r.self === 'page' ? c.page : c) : 'at' in r ? (r.at === 'site' ? c.at : c.at?.el) : follow(c, r.path);
    if (v === undefined) return false;
    ext.push(v);
  }
  const T0 = c.templates.length, U0 = c.useIds;
  for (let i = 0; i < u.templates.length; i++) maps.tid.set(u.t0 + i, T0 + i);
  for (let i = 0; i < u.uses; i++) maps.use.set(u.u0 + i, U0 + i);
  const file = c.opts.file, strs = maps.strs;
  const str = (s: string) => {
    let o = strs.get(s);
    if (o === undefined) {
      o = s === u.file ? file : s.replace(/\$(p|sl)(\d+)/g, (_, k, n) => `$${k}${maps.tid.get(+n) ?? n}`).replace(/sn-t-(\d+)/g, (_, n) => `sn-t-${maps.tid.get(+n) ?? n}`).replace(/#case(\d+)\//g, (_, n) => `#case${maps.tid.get(+n) ?? n}/`);
      strs.set(s, o!);
    }
    return o!;
  };
  // the function table: each hand-out again, in order
  const f0 = c.fns.length;
  for (const x of u.calls) maps.fn.set(x.rec, c.fn(str(x.code), null));
  const fix = { fn: (n: number) => maps.fn.get(n) ?? n, tid: (n: number) => maps.tid.get(n) ?? n, use: (n: number) => maps.use.get(n) ?? n };
  // the objects: made, then filled
  const out: any[] = new Array(u.objs.length);
  for (let i = 0; i < u.objs.length; i++) { const e = u.objs[i]!; out[i] = e.t === 0 ? (e.proto === Object.prototype ? {} : Object.create(e.proto)) : e.t === 1 ? [] : e.t === 2 ? new Map() : new Set(); }
  const dec = (v: unknown): any => (v instanceof R ? out[v.i] : v instanceof X ? ext[v.j] : v instanceof S ? str(v.s) : v);
  for (let i = 0; i < u.objs.length; i++) {
    const e = u.objs[i]!, o = out[i], vals = e.vals;
    if (e.t === 0) {
      const keys = e.keys!;
      for (let k = 0; k < keys.length; k++) o[keys[k]!] = dec(vals[k]);
    } else if (e.t === 1) { for (let k = 0; k < vals.length; k++) o.push(dec(vals[k])); }
    else if (e.t === 2) { for (let k = 0; k < vals.length; k += 2) o.set(dec(vals[k]), dec(vals[k + 1])); }
    else for (let k = 0; k < vals.length; k++) o.add(dec(vals[k]));
  }
  // the numbers to renumber, once every object is filled (a list of template ids may come later in the plan)
  for (let i = 0; i < u.objs.length; i++) {
    const e = u.objs[i]!;
    if (!e.fix) continue;
    const o = out[i];
    for (const [k, kind] of e.fix) { const key = e.keys![k]!; o[key] = kind === 'tids' ? o[key].map(fix.tid) : fix[kind](o[key]); }
  }
  maps.outs.set(u.id, out);
  for (const [rec, site] of u.fnAt) { const i = maps.fn.get(rec); if (i !== undefined && i >= f0) c.fnAt[i] = dec(site); }
  for (const t of u.templates) c.templates.push(dec(t));
  for (const o of u.ops) {
    if (o.op === 'weak') { c[o.field].set(dec(o.key), dec(o.value)); continue; }
    if (o.op === 'old') {
      const t: any = 'prior' in o.target ? maps.outs.get(o.target.prior.u)?.[o.target.prior.i] : follow(c, o.target.path);
      if (o.kind === 'set') t.set(dec(o.key), dec(o.value));
      else if (o.kind === 'add') t.add(dec(o.value));
      else if (o.kind === 'push') t.push(dec(o.value));
      else t[dec(o.key) as string] = dec(o.value);
      continue;
    }
    const target = at(c, o.path), field = o.path.join('.');
    if (o.op === 'mapSet') {
      const k = o.key, key = typeof k === 'number' && TID_KEYED.has(field) ? fix.tid(k) : typeof k === 'number' && USE_KEYED.has(field) ? fix.use(k) : dec(k);
      target.set(key, dec(o.value));
    } else if (o.op === 'setAdd') target.add(dec(o.value));
    else target.push(dec(o.value));
  }
  c.useIds += u.uses;
  c.at = dec(u.atAfter);
  return true;
}
