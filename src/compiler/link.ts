// Shared definitions linked into each page (docs/proposals/compile-once.md, (5)). A top-level definition compiles as a unit
// of its own (`Compiler.unitChild`): a compiler with its page's numbering, its context and caches shared, and its tables
// forks of the page's (`fork`, `Overlay`), merged into the page after (`unitDelta`, `applyDelta`). The second time a build
// needs it, the unit is recorded (`recordChild`): its delta, what it changed of the shared objects, and its hand-outs of
// functions, kept as a flat plan (`keep`). A later page with the same definitions before it replays the plan (`replay`):
// the objects copied, template ids, use ids, state ids and function indices renumbered, `fn()` replayed in order (so the
// table's dedupe and numbering are the page's own). What it cannot account for makes a unit unlinkable: compiled as before.
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
  | { op: 'weakAdd'; field: string; key: unknown }
  | { op: 'weakDel'; field: string; key: unknown }
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
  s0: number;
  sids: number;
  at: any;
  atAfter: any;
  refs: Map<object, Ref>;
};
export type Refused = { refused: string };

/**
 * Every field of the `Compiler`, what it may hold (`fieldKind`), and how linking treats it: `table` diffed (a map, a
 * set, a list; `page` one level in), `weak` intercepted, `replayed` by `fn()` and the template list, `renumbered` (a
 * counter of ids), `at` recorded, `cache` never linked, `fixed` that a definition must not change (a unit that changes
 * it is refused), `restored` as it was, `linker` linking's own. A field not listed makes every unit unlinkable, and
 * `test/compiler/link-fields.test.ts` fails: a new field is classified here before it can be linked past.
 */
export const LINK_FIELDS: Record<string, { kinds: string[]; how: 'table' | 'weak' | 'replayed' | 'renumbered' | 'at' | 'cache' | 'fixed' | 'restored' | 'linker' }> = {
  actions: { kinds: ['Array'], how: 'table' },
  anchorEls: { kinds: ['Map'], how: 'table' },
  anchorStart: { kinds: ['Map'], how: 'table' },
  apiOfResource: { kinds: ['Map'], how: 'table' },
  at: { kinds: ['empty', 'object'], how: 'at' },
  attrSources: { kinds: ['Array'], how: 'table' },
  authOf: { kinds: ['Map'], how: 'table' },
  boundHrefs: { kinds: ['Set'], how: 'table' },
  branchGuard: { kinds: ['WeakMap'], how: 'weak' },
  callAt: { kinds: ['Map'], how: 'replayed' },
  calls: { kinds: ['Set'], how: 'table' },
  canonicalLink: { kinds: ['empty', 'object'], how: 'fixed' },
  caseFill: { kinds: ['Map'], how: 'table' },
  caseInst: { kinds: ['WeakMap'], how: 'weak' },
  caseScopes: { kinds: ['WeakMap'], how: 'weak' },
  chainCopyOf: { kinds: ['WeakMap'], how: 'weak' },
  check: { kinds: ['empty', 'object'], how: 'fixed' },
  childrenOf: { kinds: ['WeakMap'], how: 'weak' },
  choiceGroups: { kinds: ['Array'], how: 'table' },
  choices: { kinds: ['WeakMap'], how: 'weak' },
  codeAt: { kinds: ['Map'], how: 'table' },
  componentFiles: { kinds: ['Map'], how: 'table' },
  constants: { kinds: ['Map'], how: 'table' },
  constantSites: { kinds: ['Set'], how: 'table' },
  decided: { kinds: ['Map'], how: 'table' },
  declAt: { kinds: ['WeakMap'], how: 'weak' },
  defAttrs: { kinds: ['Map'], how: 'table' },
  defaultOf: { kinds: ['WeakMap'], how: 'weak' },
  defHosts: { kinds: ['WeakMap'], how: 'weak' },
  defLink: { kinds: ['object'], how: 'linker' },
  defRoots: { kinds: ['Map'], how: 'table' },
  defs: { kinds: ['Map'], how: 'table' },
  diagnostics: { kinds: ['Array'], how: 'table' },
  dlTemplates: { kinds: ['Set'], how: 'table' },
  dropped: { kinds: ['Set'], how: 'table' },
  dry: { kinds: ['empty', 'object'], how: 'fixed' },
  earlySites: { kinds: ['Map'], how: 'table' },
  embedded: { kinds: ['Map'], how: 'table' },
  emptyDefaults: { kinds: ['WeakMap'], how: 'weak' },
  enclosing: { kinds: ['WeakMap'], how: 'weak' },
  exprsOf: { kinds: ['Map'], how: 'table' },
  features: { kinds: ['Set'], how: 'table' },
  fileData: { kinds: ['Map'], how: 'table' },
  fileGlobs: { kinds: ['Array'], how: 'table' },
  files: { kinds: ['Set'], how: 'table' },
  fillDefs: { kinds: ['Array'], how: 'table' },
  fillOf: { kinds: ['WeakMap'], how: 'weak' },
  fillScopes: { kinds: ['WeakMap'], how: 'weak' },
  flows: { kinds: ['Array'], how: 'table' },
  fnAt: { kinds: ['Array'], how: 'replayed' },
  fnIndex: { kinds: ['Map'], how: 'replayed' },
  fns: { kinds: ['Array'], how: 'replayed' },
  fnUses: { kinds: ['Array'], how: 'replayed' },
  foldedFields: { kinds: ['Array'], how: 'table' },
  foldedUrl: { kinds: ['WeakSet'], how: 'weak' },
  folding: { kinds: ['object', 'empty'], how: 'fixed' },
  foldReads: { kinds: ['Map'], how: 'table' },
  foldScripts: { kinds: ['Map'], how: 'table' },
  foldWhy: { kinds: ['Map'], how: 'table' },
  forwarded: { kinds: ['WeakMap'], how: 'weak' },
  frameOf: { kinds: ['Map'], how: 'table' },
  frozen: { kinds: ['Set'], how: 'table' },
  graphs: { kinds: ['empty', 'Map'], how: 'cache' },
  head: { kinds: ['object', 'empty'], how: 'fixed' },
  headEl: { kinds: ['object', 'empty'], how: 'fixed' },
  headTemplates: { kinds: ['Map'], how: 'table' },
  hostUse: { kinds: ['WeakMap'], how: 'weak' },
  hrefs: { kinds: ['Array'], how: 'table' },
  idEls: { kinds: ['Map'], how: 'table' },
  includeOf: { kinds: ['WeakMap'], how: 'weak' },
  includes: { kinds: ['Array'], how: 'table' },
  includeTop: { kinds: ['WeakMap'], how: 'weak' },
  inDef: { kinds: ['number'], how: 'restored' },
  instAt: { kinds: ['WeakMap'], how: 'weak' },
  itemSchema: { kinds: ['Map'], how: 'table' },
  jsonOut: { kinds: ['Map'], how: 'table' },
  keptBound: { kinds: ['Set'], how: 'table' },
  keptDepth: { kinds: ['number'], how: 'fixed' },
  keptSlot: { kinds: ['Set'], how: 'table' },
  keptSource: { kinds: ['Map'], how: 'table' },
  landing: { kinds: ['WeakMap'], how: 'weak' },
  lastExpr: { kinds: ['empty', 'number'], how: 'fixed' },
  lastPath: { kinds: ['Array'], how: 'table' },
  lateDiags: { kinds: ['Array'], how: 'table' },
  lateNodes: { kinds: ['WeakSet'], how: 'weak' },
  layout: { kinds: ['empty', 'Layout'], how: 'fixed' },
  layoutBody: { kinds: ['WeakMap'], how: 'weak' },
  layoutFiles: { kinds: ['Map'], how: 'table' },
  lazyLoads: { kinds: ['Map'], how: 'table' },
  lazyMods: { kinds: ['Array'], how: 'table' },
  lineStarts: { kinds: ['Map'], how: 'cache' },
  listCompiled: { kinds: ['WeakSet'], how: 'weak' },
  markups: { kinds: ['WeakMap'], how: 'weak' },
  measured: { kinds: ['WeakMap'], how: 'weak' },
  needsMarkup: { kinds: ['boolean'], how: 'fixed' },
  nextId: { kinds: ['number'], how: 'fixed' },
  nextSid: { kinds: ['number'], how: 'renumbered' },
  noEarly: { kinds: ['Set'], how: 'table' },
  notUnrolled: { kinds: ['Set'], how: 'table' },
  opts: { kinds: ['object'], how: 'fixed' },
  origins: { kinds: ['WeakMap'], how: 'weak' },
  overLimit: { kinds: ['Map'], how: 'table' },
  page: { kinds: ['object'], how: 'table' },
  pageLang: { kinds: ['empty', 'string'], how: 'fixed' },
  pageModels: { kinds: ['Array'], how: 'table' },
  pagesDecl: { kinds: ['empty', 'object'], how: 'fixed' },
  pagesOut: { kinds: ['empty', 'object'], how: 'fixed' },
  painted: { kinds: ['Set'], how: 'table' },
  paintRules: { kinds: ['Array'], how: 'table' },
  paints: { kinds: ['Array'], how: 'table' },
  paintValue: { kinds: ['Map'], how: 'table' },
  passOn: { kinds: ['WeakMap'], how: 'weak' },
  pathList: { kinds: ['Array'], how: 'table' },
  pendingSpace: { kinds: ['Array'], how: 'table' },
  pendingTargets: { kinds: ['Array'], how: 'table' },
  permanentEls: { kinds: ['Array'], how: 'table' },
  permanentNames: { kinds: ['Array'], how: 'table' },
  persisted: { kinds: ['Set'], how: 'table' },
  pointCtx: { kinds: ['WeakMap'], how: 'weak' },
  pointOf: { kinds: ['Map'], how: 'table' },
  points: { kinds: ['WeakMap'], how: 'weak' },
  prefetchOff: { kinds: ['boolean'], how: 'fixed' },
  preloads: { kinds: ['Set'], how: 'table' },
  remoteUsed: { kinds: ['boolean'], how: 'fixed' },
  remoteWidths: { kinds: ['Set'], how: 'table' },
  remove: { kinds: ['Array'], how: 'table' },
  repeatedFills: { kinds: ['WeakSet'], how: 'weak' },
  repeatedIds: { kinds: ['Array'], how: 'table' },
  reportedOnce: { kinds: ['Set'], how: 'table' },
  resourceEls: { kinds: ['Map'], how: 'table' },
  resources: { kinds: ['Array'], how: 'table' },
  roots: { kinds: ['Array'], how: 'table' },
  rootStyled: { kinds: ['Set'], how: 'table' },
  rowOf: { kinds: ['WeakMap'], how: 'weak' },
  rowPaint: { kinds: ['Map'], how: 'table' },
  runtimePlacements: { kinds: ['Array'], how: 'table' },
  runtimeSlots: { kinds: ['WeakSet'], how: 'weak' },
  scopeStart: { kinds: ['WeakMap'], how: 'weak' },
  scripts: { kinds: ['Map'], how: 'table' },
  slotEls: { kinds: ['Array'], how: 'table' },
  slotOf: { kinds: ['WeakMap'], how: 'weak' },
  spaceN: { kinds: ['number'], how: 'fixed' },
  spacePlan: { kinds: ['Map'], how: 'table' },
  spaces: { kinds: ['Array'], how: 'table' },
  srcCalls: { kinds: ['Array'], how: 'table' },
  srcOf: { kinds: ['Map'], how: 'table' },
  stateAt: { kinds: ['Map'], how: 'table' },
  stateInits: { kinds: ['Array'], how: 'table' },
  swapOff: { kinds: ['boolean'], how: 'fixed' },
  syncs: { kinds: ['Array'], how: 'table' },
  tagIds: { kinds: ['WeakSet'], how: 'weak' },
  templateAt: { kinds: ['Map'], how: 'table' },
  templates: { kinds: ['Array'], how: 'replayed' },
  textAt: { kinds: ['Map'], how: 'table' },
  textFolded: { kinds: ['Set'], how: 'table' },
  textMarks: { kinds: ['Map'], how: 'table' },
  textRoots: { kinds: ['Array'], how: 'table' },
  tplEls: { kinds: ['Map'], how: 'table' },
  tplPainted: { kinds: ['Set'], how: 'table' },
  undecided: { kinds: ['Set'], how: 'table' },
  unheld: { kinds: ['Array'], how: 'table' },
  unlisted: { kinds: ['Set'], how: 'table' },
  unrolls: { kinds: ['Map'], how: 'table' },
  urlBinds: { kinds: ['Array'], how: 'table' },
  useById: { kinds: ['Map'], how: 'table' },
  useIds: { kinds: ['number'], how: 'renumbered' },
  useOf: { kinds: ['WeakMap'], how: 'weak' },
  uses: { kinds: ['Map'], how: 'table' },
  waitRules: { kinds: ['Array'], how: 'table' },
  waits: { kinds: ['Array'], how: 'table' },
  walk: { kinds: ['object', 'empty'], how: 'fixed' },
  walked: { kinds: ['number'], how: 'fixed' },
  writtenIn: { kinds: ['WeakMap'], how: 'weak' },
};

/** fields replayed by `fn()` itself, or kept as they are */
const SKIP = new Set(['fns', 'fnIndex', 'fnUses', 'fnAt', 'callAt', 'inDef', 'at', 'lineStarts', 'templates', 'defLink', 'graphs']);
const TID_KEYED = new Set(['headTemplates', 'templateAt', 'caseFill']);
const USE_KEYED = new Set(['useById']);
const SID_KEYED = new Set(['stateAt']);
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
 * A unit's weak table: its page's, read through, with the unit's own writes kept apart (`own`, `gone`), so what it wrote
 * can be read back. A weak map's API, or a weak set's (`set` false).
 */
export class Overlay {
  readonly own: Map<object, unknown> | Set<object>;
  readonly gone = new Set<object>();
  constructor(readonly base: WeakMap<object, unknown> | WeakSet<object>, set: boolean) { this.own = set ? new Set() : new Map(); }
  has(k: object) { return !this.gone.has(k) && (this.own.has(k) || this.base.has(k)); }
  get(k: object) { return this.gone.has(k) ? undefined : this.own instanceof Map && this.own.has(k) ? this.own.get(k) : (this.base as WeakMap<object, unknown>).get(k); }
  set(k: object, v: unknown) { this.gone.delete(k); (this.own as Map<object, unknown>).set(k, v); return this; }
  add(k: object) { this.gone.delete(k); (this.own as Set<object>).add(k); return this; }
  delete(k: object) { const had = this.has(k); this.own.delete(k); if (this.base.has(k)) this.gone.add(k); return had; }
}

/** a unit's copy of one of its page's tables, one level deep (a list or a set in a map is copied too), and what it copied */
export function fork(v: Map<unknown, unknown> | Set<unknown> | unknown[], copies: Map<object, object>): Map<unknown, unknown> | Set<unknown> | unknown[] {
  const one = (x: unknown) => { if (!x || typeof x !== 'object' || !container(x)) return x; const y = x instanceof Map ? new Map(x) : x instanceof Set ? new Set(x) : (x as unknown[]).slice(); copies.set(y, x as object); return y; };
  return v instanceof Map ? new Map([...v].map(([k, x]) => [k, one(x)])) : v instanceof Set ? new Set(v) : v.slice();
}

/**
 * What a unit wrote in its own tables, as operations on its page's: against the copies it started from (`fork`), new
 * entries and items, and what it added to a list, a set or a map the page had (by its key); its weak tables' own entries.
 */
export function unitDelta(c: any, u: { child: any; own: string[]; copies: Map<object, object> }): Op[] | string {
  const ops: Op[] = [];
  for (const k of u.own) {
    const v = u.child[k], b = c[k];
    if (v instanceof Overlay) {
      if (v.own instanceof Map) for (const [x, y] of v.own) ops.push({ op: 'weak', field: k, key: x, value: y });
      else for (const x of v.own) ops.push({ op: 'weakAdd', field: k, key: x });
      for (const x of v.gone) ops.push({ op: 'weakDel', field: k, key: x });
    } else if (v instanceof Map) {
      for (const x of b.keys()) if (!v.has(x)) return `${k}: a key deleted`;
      for (const [x, y] of v) {
        if (!b.has(x)) { ops.push({ op: 'mapSet', path: [k], key: x, value: y }); continue; }
        const was = b.get(x);
        if (u.copies.get(y as object) !== was) { if (y !== was) ops.push({ op: 'mapSet', path: [k], key: x, value: y }); continue; }
        // the page's own list, set or map at this key, which the unit added to
        if (x !== null && typeof x === 'object') return `${k}: added to the value of an object key`;
        const target = { path: [{ p: k }, { k: x }] as Step[] };
        if (y instanceof Map) { for (const [p, q] of y) if (!was.has(p) || was.get(p) !== q) ops.push({ op: 'old', target, change: { kind: 'set', key: p, value: q } }); }
        else if (y instanceof Set) { for (const p of y) if (!was.has(p)) ops.push({ op: 'old', target, change: { kind: 'add', value: p } }); }
        else {
          for (let i = 0; i < was.length; i++) if ((y as unknown[])[i] !== was[i]) return `${k}: a list changed in place`;
          for (const p of (y as unknown[]).slice(was.length)) ops.push({ op: 'old', target, change: { kind: 'push', value: p } });
        }
      }
    } else if (v instanceof Set) {
      for (const x of b) if (!v.has(x)) return `${k}: an item deleted`;
      for (const x of v) if (!b.has(x)) ops.push({ op: 'setAdd', path: [k], value: x });
    } else {
      for (let i = 0; i < b.length; i++) if (v[i] !== b[i]) return `${k}[${i}] changed in place`;
      for (const x of v.slice(b.length)) ops.push({ op: 'push', path: [k], value: x });
    }
  }
  return ops;
}

/** Operations applied to the page as they are (the objects themselves: the page that compiled them goes on with them). */
export function applyDelta(c: any, ops: Op[]) {
  for (const o of ops) {
    if (o.op === 'weak') c[o.field].set(o.key, o.value);
    else if (o.op === 'weakAdd') c[o.field].add(o.key);
    else if (o.op === 'weakDel') c[o.field].delete(o.key);
    else if (o.op === 'old') {
      const t: any = follow(c, (o.target as { path: Step[] }).path), ch = o.change;
      if (ch.kind === 'set') t.set(ch.key, ch.value); else if (ch.kind === 'add') t.add(ch.value); else if (ch.kind === 'push') t.push(ch.value); else t[ch.key] = ch.value;
    } else {
      const t = at(c, o.path);
      if (o.op === 'mapSet') t.set(o.key, o.value); else if (o.op === 'setAdd') t.add(o.value); else if (o.op === 'push') t.push(o.value);
    }
  }
}

/**
 * Refactor, step 2: a top-level definition compiled as a unit of its own (`unitChild`), recorded from what the unit holds.
 * Its own tables are what it wrote (no diff, no interception); its numbering is what it added to the page's copy; what it
 * changed of the page's shared objects (the page info, the component files, earlier definitions) is diffed from those
 * alone. Then it is merged into the page (`mergeUnit`), and kept as a plan like a recorded one.
 */
export function recordChild<T>(c: any, name: string, compile: (child: any) => T, prior: Map<object, { u: number; i: number }>): { result: T; unit: Plan | Refused } {
  for (const k of Object.keys(c)) if (!(k in LINK_FIELDS)) return { result: compile(c), unit: { refused: `\`${k}\` is not in LINK_FIELDS` } };
  const u = c.unitChild(), child = u.child;
  const t0 = c.templates.length, f0 = c.fns.length, u0 = c.useIds, s0 = c.nextSid, n0 = c.nextId, a0 = c.actions.length, atBefore = c.at;
  const codeKeys = new Set(c.codeAt.keys()), defKeys = new Set(c.defs.keys());
  // what the unit can reach of the page: its shared fields, the definitions before it, and the page's markup
  const old = new Set<object>();
  let top = atBefore?.el;
  while (top?.parentNode) top = top.parentNode;
  reach([...u.shared.map((k: string) => c[k]), [...c.defs.values()], top, atBefore], old, (o) => shared(o));
  // the shared fields' tables (`componentFiles`, `page`'s), diffed as tables; the compiler's own tables are no old objects
  const pre = snapshot(c);
  for (const key of [...pre.out.keys()]) if (!u.shared.includes(pre.out.get(key)!.path[0])) pre.out.delete(key);
  const boxes = new Set<object>(Object.keys(c).map((k) => c[k]).filter((v) => container(v) || v instanceof WeakMap || v instanceof WeakSet));
  for (const s of pre.out.values()) boxes.add(at(c, s.path));
  const before = new Map<object, any>();
  for (const o of old) if (!boxes.has(o) && !(o instanceof WeakMap) && !(o instanceof WeakSet)) before.set(o, shallow(o));
  // the unit's hand-outs of functions, in order (its own method: nothing global)
  const calls: Array<{ code: string; rec: number }> = [];
  const fn0 = child.fn;
  child.fn = function (code: string, site?: unknown) { const i = fn0.call(child, code, site); calls.push({ code, rec: i }); return i; };
  let result: T;
  try { result = compile(child); } finally { delete child.fn; }
  const refuse = (why: string) => { c.mergeUnit(u); return { result, unit: { refused: why } as Refused }; };
  if (child.nextId !== n0) return refuse('`nextId` changed (node ids are not renumbered)');
  if (child.actions.length !== a0) return refuse('adds an action (`actions` is not renumbered)');
  // what it wrote: every entry of its own tables, the definitions and source sites it added
  const delta = unitDelta(c, u);
  if (typeof delta === 'string') return refuse(delta);
  const ops: Op[] = [...delta];
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
  for (const [x, y] of child.codeAt) if (!codeKeys.has(x)) ops.push({ op: 'mapSet', path: ['codeAt'], key: x, value: y });
  for (const [x, y] of child.defs) if (!defKeys.has(x)) ops.push({ op: 'mapSet', path: ['defs'], key: x, value: y });
  // what it changed of the page's shared objects, against their path from the page's fields
  const where = paths(c, old);
  for (const [o, b] of before as Map<any, any>) {
    const changes: Change[] = [];
    if (o instanceof Map) {
      for (const k of b.keys()) if (!o.has(k)) return refuse('a shared map lost a key');
      for (const [k, v] of o) if (!b.has(k) || b.get(k) !== v) changes.push({ kind: 'set', key: k, value: v });
    } else if (o instanceof Set) {
      for (const x of b) if (!o.has(x)) return refuse('a shared set lost an item');
      for (const x of o) if (!b.has(x)) changes.push({ kind: 'add', value: x });
    } else if (Array.isArray(o)) {
      if (o.length < b.length) return refuse('a shared list shrank');
      for (let i = 0; i < b.length; i++) if (o[i] !== b[i]) changes.push({ kind: 'prop', key: i, value: o[i] });
      for (const x of o.slice(b.length)) changes.push({ kind: 'push', value: x });
    } else {
      for (const k of Object.keys(b)) if (!(k in o)) return refuse(`\`${k}\` deleted from a shared object`);
      for (const k of Object.keys(o)) if (o[k] !== b[k]) changes.push({ kind: 'prop', key: k, value: o[k] });
    }
    if (!changes.length) continue;
    const target = prior.has(o) ? { prior: prior.get(o)! } : where.has(o) ? { path: where.get(o)! } : null;
    if (!target) return refuse(`changes a shared object that has no key (${o.constructor?.name ?? 'object'}: ${o.nodeName ?? Object.keys(o).slice(0, 6).join(', ')})`);
    for (const change of changes) ops.push({ op: 'old', target, change });
  }
  const atAfter = child.at;
  const templates = child.templates.slice(t0);
  const fnAt = new Map<number, unknown>();
  for (let i = f0; i < child.fns.length; i++) fnAt.set(i, child.fnAt[i]);
  const uses = child.useIds - u0, sids = child.nextSid - s0;
  // the page goes on with the unit merged in, as compiled in place
  c.mergeUnit(u);
  // the objects of the page it refers to: by their path, made by an earlier unit, the element being compiled, or shared
  const refs = new Map<object, Ref>([[c.opts, { self: 'opts' }], [c.page, { self: 'page' }], [c, { self: 'compiler' }]]);
  if (atBefore) refs.set(atBefore, { at: 'site' });
  if (atBefore?.el) refs.set(atBefore.el, { at: 'el' });
  const todo: unknown[] = [ops.map((o) => ('change' in o ? o.change : o)), templates, [...fnAt.values()], atAfter];
  const seen = new Set<object>();
  while (todo.length) {
    const v = todo.pop();
    if (!v || typeof v !== 'object' || seen.has(v) || shared(v) || refs.has(v)) continue;
    if (old.has(v) || prior.has(v)) {
      if (prior.has(v)) { refs.set(v, { prior: prior.get(v)! }); continue; }
      const path = where.get(v);
      if (!path) return { result, unit: { refused: `refers to a shared object that has no key (${(v as any).constructor?.name ?? 'object'}: ${(v as any).nodeName ?? Object.keys(v).slice(0, 6).join(', ')})` } };
      refs.set(v, { path });
      continue;
    }
    seen.add(v);
    if (typeof v === 'function') return { result, unit: { refused: 'holds a function' } };
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== null) return { result, unit: { refused: `holds a ${(v as any).constructor?.name}` } };
    if (v instanceof Map) for (const [k, x] of v) todo.push(k, x);
    else if (v instanceof Set) for (const x of v) todo.push(x);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else for (const k of Object.keys(v)) { if (typeof (v as any)[k] === 'function') return { result, unit: { refused: `holds a function (\`${k}\`)` } }; todo.push((v as any)[k]); }
  }
  const unit: Unit = { name, file: c.opts.file, ops, calls, fnAt, templates, t0, u0, uses, s0, sids, at: atBefore, atAfter, refs };
  return { result, unit: keep(unit, prior) };
}

// A unit as a plan: the objects it created as a flat list, their values classified once (a plain value, another object of
// the plan `R`, an object of the page `X`, a string to renumber `S`), and the numbers to renumber in each.
class R { constructor(readonly i: number) {} }
class X { constructor(readonly j: number) {} }
/** a string to renumber: in code (`code`), or in markup, where only the names nothing else writes are renumbered */
class S { constructor(readonly s: string, readonly code: boolean) {} }
type Fix = [number, 'fn' | 'tid' | 'tids' | 'use' | 'sid'];
type Entry = { t: 0 | 1 | 2 | 3; proto: object | null; keys?: string[]; vals: unknown[]; fix?: Fix[] };
type PlanOp =
  | { op: 'mapSet'; path: string[]; key: unknown; value: unknown }
  | { op: 'setAdd' | 'push'; path: string[]; value: unknown }
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd'; field: string; key: unknown }
  | { op: 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; kind: Change['kind']; key?: unknown; value: unknown };
export type Plan = { id: number; name: string; file: string; objs: Entry[]; ext: Ref[]; ops: PlanOp[]; calls: Unit['calls']; fnAt: Array<[number, unknown]>; templates: unknown[]; t0: number; u0: number; uses: number; s0: number; sids: number; atAfter: unknown };
let units = 0;
const NEEDS = /\$p\d|\$sl\d|\$s\d|sn-t-\d|#case\d/;
/** code also names a loop's index by its template (`$i<tid>`) and a loop variable that would clash in a component (`n$<tid>`) */
const NEEDS_CODE = /\$p\d|\$sl\d|\$s\d|\$i\d|\w\$\d|sn-t-\d|#case\d/;

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
  // a node with state: its initializer's function; anything with a state id (a node, a state's init, a scope's entry, a use)
  if (typeof o.tag === 'string' && Array.isArray(o.b) && typeof o.state === 'number') at('state', 'fn');
  // a comparison's sides (a binding's `s`): their functions
  if (typeof o.r === 'number' && typeof o.o === 'number' && Array.isArray(o.d) && Object.keys(o).every((k) => ['r', 'o', 'd', 'x'].includes(k))) { at('r', 'fn'); at('o', 'fn'); }
  if (typeof o.sid === 'number') at('sid', 'sid');
  return out.length ? out : undefined;
}

/** the unit as a plan: what it created read once into a flat list (the page that recorded it goes on changing its objects) */
function keep(u: Unit, prior: Map<object, { u: number; i: number }>): Plan {
  const id = units++;
  const objs: Entry[] = [], index = new Map<object, number>(), ext: Ref[] = [], extIndex = new Map<object, number>();
  const live: object[] = [];
  // (`markup`: a string of a node or of an attribute, text the page wrote, where `US$5` is not a loop variable)
  const enc = (v: any, markup = false): unknown => {
    if (typeof v === 'string') return v === u.file || (markup ? NEEDS : NEEDS_CODE).test(v) ? new S(v, !markup) : v;
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
    if (o.op === 'weakAdd' || o.op === 'weakDel') return { op: o.op, field: o.field, key: enc(o.key) };
    if (o.op === 'mapSet') return { op: 'mapSet', path: o.path, key: enc(o.key), value: enc(o.value) };
    return { op: o.op as 'setAdd' | 'push', path: (o as any).path, value: enc((o as any).value) };
  });
  const templates = u.templates.map((x) => enc(x)), fnAt: Array<[number, unknown]> = [...u.fnAt].map(([k, v]) => [k, enc(v)]), atAfter = enc(u.atAfter);
  // each object once, its values classified (the list grows as they reach further)
  for (let n = 0; n < live.length; n++) {
    const v: any = live[n];
    if (v instanceof Map) { const vals: unknown[] = []; for (const [k, x] of v) vals.push(enc(k), enc(x)); objs[n] = { t: 2, proto: null, vals }; }
    else if (v instanceof Set) objs[n] = { t: 3, proto: null, vals: [...v].map((x) => enc(x)) };
    else if (Array.isArray(v)) objs[n] = { t: 1, proto: null, vals: v.map((x: unknown) => enc(x)) };
    else {
      const keys = Object.keys(v), markup = 'nodeName' in v || keys.every((k) => k === 'name' || k === 'value' || k === 'namespace' || k === 'prefix');
      objs[n] = { t: 0, proto: Object.getPrototypeOf(v), keys, vals: keys.map((k) => enc(v[k], markup)), ...(fixesOf(v, keys) ? { fix: fixesOf(v, keys) } : {}) };
    }
  }
  for (const [o, i] of index) prior.set(o, { u: id, i });
  return { id, name: u.name, file: u.file, objs, ext, ops, calls: u.calls, fnAt, templates, t0: u.t0, u0: u.u0, uses: u.uses, s0: u.s0, sids: u.sids, atAfter };
}

/** per page: how the units linked into it renumber what they recorded, and the objects each made here */
type PageMaps = { tid: Map<number, number>; fn: Map<number, number>; use: Map<number, number>; sid: Map<number, number>; outs: Map<number, unknown[]>; strs: Map<string, string> };

/** The unit linked into the page `c`; false when it cannot be (nothing changed then). */
export function replay(c: any, u: Plan, maps: PageMaps): boolean {
  // the objects of the page it refers to, first: a unit that cannot be linked changes nothing
  const ext: unknown[] = [];
  for (const r of u.ext) {
    const v = 'prior' in r ? maps.outs.get((r.prior as any).u)?.[(r.prior as any).i] : 'self' in r ? (r.self === 'opts' ? c.opts : r.self === 'page' ? c.page : c) : 'at' in r ? (r.at === 'site' ? c.at : c.at?.el) : follow(c, r.path);
    if (v === undefined) return false;
    ext.push(v);
  }
  const T0 = c.templates.length, U0 = c.useIds, S0 = c.nextSid;
  for (let i = 0; i < u.templates.length; i++) maps.tid.set(u.t0 + i, T0 + i);
  for (let i = 0; i < u.uses; i++) maps.use.set(u.u0 + i, U0 + i);
  for (let i = 0; i < u.sids; i++) maps.sid.set(u.s0 + i, S0 + i);
  const file = c.opts.file, strs = maps.strs;
  const tidOf = (n: string) => maps.tid.get(+n) ?? n;
  // (in code, also a loop's index and a clashing loop variable, named by their template: only for this unit's and earlier ones')
  const str = (s: string, code = true) => {
    const key = code ? s : `\u0000${s}`;
    let o = strs.get(key);
    if (o === undefined) {
      o = s === u.file ? file : s.replace(/\$(p|sl)(\d+)/g, (_, k, n) => `$${k}${tidOf(n)}`).replace(/sn-t-(\d+)/g, (_, n) => `sn-t-${tidOf(n)}`).replace(/#case(\d+)\//g, (_, n) => `#case${tidOf(n)}/`).replace(/\$s(\d+)/g, (_, n) => `$s${maps.sid.get(+n) ?? n}`);
      if (code && s !== u.file) o = o!.replace(/\$i(\d+)(?!\d)/g, (_, n) => `$i${tidOf(n)}`).replace(/(\w)\$(\d+)(?!\d)/g, (_, a, n) => `${a}$${tidOf(n)}`);
      strs.set(key, o!);
    }
    return o!;
  };
  // the function table: each hand-out again, in order
  const f0 = c.fns.length;
  for (const x of u.calls) maps.fn.set(x.rec, c.fn(str(x.code), null));
  const fix = { fn: (n: number) => maps.fn.get(n) ?? n, tid: (n: number) => maps.tid.get(n) ?? n, use: (n: number) => maps.use.get(n) ?? n, sid: (n: number) => maps.sid.get(n) ?? n };
  // the objects: made, then filled
  const out: any[] = new Array(u.objs.length);
  for (let i = 0; i < u.objs.length; i++) { const e = u.objs[i]!; out[i] = e.t === 0 ? (e.proto === Object.prototype ? {} : Object.create(e.proto)) : e.t === 1 ? [] : e.t === 2 ? new Map() : new Set(); }
  const dec = (v: unknown): any => (v instanceof R ? out[v.i] : v instanceof X ? ext[v.j] : v instanceof S ? str(v.s, v.code) : v);
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
    if (o.op === 'weakAdd' || o.op === 'weakDel') { if (o.op === 'weakAdd') c[o.field].add(dec(o.key)); else c[o.field].delete(dec(o.key)); continue; }
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
      const k = o.key, key = typeof k === 'number' && TID_KEYED.has(field) ? fix.tid(k) : typeof k === 'number' && USE_KEYED.has(field) ? fix.use(k) : typeof k === 'number' && SID_KEYED.has(field) ? fix.sid(k) : dec(k);
      target.set(key, dec(o.value));
    } else if (o.op === 'setAdd') target.add(dec(o.value));
    else target.push(dec(o.value));
  }
  c.useIds += u.uses;
  c.nextSid += u.sids;
  c.at = dec(u.atAfter);
  return true;
}
