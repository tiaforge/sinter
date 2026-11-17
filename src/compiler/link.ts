// Shared definitions linked into each page (docs/proposals/compile-once.md, (5)). The first time a build needs a top-level
// definition, it compiles in place. The second time, it compiles as a unit (`Compiler.unitChild`, `recordChild`): a
// compiler with its page's numbering, whose view of its page logs what it writes (applied to the page as it goes on) and
// what it reads (`Read`). The writes, the reads and its hand-outs of functions are kept as a flat plan (`keep`). A later
// page with the same definitions before it, that reads alike everywhere the unit looked, replays the plan (`replay`): the
// objects copied, template ids, use ids, state ids and function indices renumbered, `fn()` replayed in order (so the
// table's dedupe and numbering are the page's own), names in code renamed by token. A plan that does not hold changes
// nothing, and the page compiles in place; what a unit cannot be linked for refuses it.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Ref = { path: Step[] } | { at: 'el' | 'site' } | { self: 'opts' | 'page' | 'compiler' } | { prior: { u: number; i: number } };
type Change = { kind: 'set'; key: unknown; value: unknown; ifAbsent?: true } | { kind: 'add'; value: unknown } | { kind: 'prop'; key: string | number; value: unknown } | { kind: 'push'; value: unknown } | { kind: 'delete'; key: unknown };
type Op =
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd'; field: string; key: unknown }
  | { op: 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; change: Change };
export type Unit = {
  name: string;
  file: string;
  ops: Op[];
  /** what it read of its page (`Read`): a page it is linked into must read alike */
  reads: Read[];
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
/** a unit's numbering (`Compiler.unitChild`): copied from its page, taken back after; renumbered when it is linked */
export const UNIT_NUMBERING = new Set(['fns', 'fnIndex', 'fnUses', 'fnAt', 'callAt', 'templates', 'codeAt', 'useIds', 'nextSid', 'nextId', 'actions']);
const TID_KEYED = new Set(['headTemplates', 'templateAt', 'caseFill']);
/** sets of template ids */
const TID_SETS = new Set(['dlTemplates']);
const USE_KEYED = new Set(['useById']);
const SID_KEYED = new Set(['stateAt']);
const container = (v: unknown) => v instanceof Map || v instanceof Set || Array.isArray(v);
/** shared as it is, never copied: frozen, or a parse5 source location (the parse cache's, which every copy of a node shares) */
const shared = (o: object) => Object.isFrozen(o) || ('startOffset' in o && 'endOffset' in o);


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

// ---- recording a unit: a compiler of its own, whose view of its page logs what it reads (`Read`) and writes (`Op`)

/**
 * What a unit read of its page, which a page it is linked into must show alike (`replay` checks every one first): a key
 * looked up in a table, present or not; a table read whole, by its size (and its keys, when they are names); a value
 * (a field of the compiler or of the page info, or an option), as JSON.
 */
export type Read =
  | { at: Step[]; key: unknown; has: boolean }
  | { at: Step[]; size: number; keys: string | null }
  | { at: Step[]; value: string };

/** a recording: the unit's writes in order, its reads, what it cannot be linked for, and the page's object behind each wrapper */
class Rec {
  readonly ops: Op[] = [];
  readonly reads: Read[] = [];
  private readonly seen = new Set<string>();
  readonly page = new WeakMap<object, object>();
  readonly where = new WeakMap<object, Step[]>();
  bad: string | null = null;
  read(r: Read) {
    const k = JSON.stringify(r);
    if (!this.seen.has(k)) { this.seen.add(k); this.reads.push(r); }
  }
  refuse(why: string) { this.bad ??= why; }
  write(path: Step[], change: Change) { this.ops.push({ op: 'old', target: { path }, change }); }
}

const pathText = (path: Step[]) => path.map((s) => ('p' in s ? s.p : 'k' in s ? `[${String(s.k)}]` : `[${s.i}]`)).join('.');
/** what a read sees of a value: JSON, or null when it is not data (a function, a class's object, a cycle) */
function json(v: unknown): string | null {
  const seen = new Set<object>();
  let ok = true;
  const s = JSON.stringify(v, (_, x) => {
    if (typeof x === 'function') { ok = false; return undefined; }
    if (x && typeof x === 'object') {
      const proto = Object.getPrototypeOf(x);
      if (x instanceof Map) return { $map: [...x] };
      if (x instanceof Set) return { $set: [...x] };
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) { ok = false; return undefined; }
      if (seen.has(x)) { ok = false; return undefined; }
      seen.add(x);
    }
    return x;
  });
  return ok ? (s ?? 'undefined') : null;
}

/** a wrapper over one of the page's tables (or a table in one), by its path: a map, a set or a list that logs */
function wrap(v: any, path: Step[], rec: Rec, cache = false): any {
  const w = v instanceof Map ? new LoggedMap(v, path, rec, cache) : v instanceof Set ? new LoggedSet(v, path, rec) : loggedList(v, path, rec);
  rec.page.set(w, v);
  rec.where.set(v, path);
  return w;
}

/** a key read of a table: what the page has at it; by an object of the page, it is not linked (no path leads there) */
function look(rec: Rec, page: Map<unknown, unknown> | Set<unknown>, path: Step[], k: unknown) {
  if (k !== null && typeof k === 'object') { if (page.has(k as never)) rec.refuse(`reads ${pathText(path)} by an object of the page`); return; }
  rec.read({ at: path, key: k, has: page.has(k as never) });
}
const keysOf = (t: Map<unknown, unknown> | Set<unknown>) => { const ks = [...t.keys()]; return ks.every((k) => k === null || typeof k !== 'object') ? JSON.stringify(ks) : null; };

class LoggedMap extends Map<unknown, unknown> {
  private readonly mine = new Set<unknown>();
  private readonly wraps = new Map<unknown, unknown>();
  constructor(private readonly base: Map<unknown, unknown>, private readonly path: Step[], private readonly rec: Rec, private readonly cache: boolean) {
    super();
    for (const [k, v] of base) Map.prototype.set.call(this, k, v);
  }
  private look(k: unknown) {
    if (this.mine.has(k)) return;
    if (!this.cache) { look(this.rec, this.base, this.path, k); return; }
    // a cache's entry is the same on every page, but for what a page learns of it as it compiles (a file found `bad`)
    const v = this.base.get(k);
    if (v && typeof v === 'object') this.rec.read({ at: [...this.path, { k }, { p: 'bad' }], value: json((v as { bad?: unknown }).bad) ?? 'undefined' });
  }
  private whole() { if (!this.cache) this.rec.read({ at: this.path, size: this.base.size, keys: keysOf(this.base) }); }
  /** a table the page had at this key: a wrapper too, so what the unit adds to it is logged */
  private value(k: unknown, v: unknown) {
    if (this.mine.has(k) || !v || typeof v !== 'object' || !container(v)) return v;
    let w = this.wraps.get(k);
    if (!w) this.wraps.set(k, (w = wrap(v, [...this.path, { k }], this.rec)));
    return w;
  }
  override get(k: unknown) { this.look(k); return this.value(k, super.get(k)); }
  override has(k: unknown) { this.look(k); return super.has(k); }
  override set(k: unknown, v: unknown) {
    // a cache's entry (a component file): kept where the page has one already
    if (!(this.cache && super.has(k))) this.rec.write(this.path, { kind: 'set', key: k, value: v, ...(this.cache ? { ifAbsent: true } : {}) } as Change);
    this.mine.add(k);
    this.wraps.delete(k);
    return super.set(k, v);
  }
  override delete(k: unknown) { this.look(k); this.rec.write(this.path, { kind: 'delete', key: k } as Change); this.mine.add(k); return super.delete(k); }
  override clear() { this.rec.refuse(`clears ${pathText(this.path)}`); super.clear(); }
  override get size() { this.whole(); return super.size; }
  override forEach(f: (v: unknown, k: unknown, m: Map<unknown, unknown>) => void, self?: unknown) { for (const [k, v] of this) f.call(self, v, k, this); }
  override *entries(): MapIterator<[unknown, unknown]> { this.whole(); for (const [k, v] of super.entries()) yield [k, this.value(k, v)]; }
  override *values(): MapIterator<unknown> { for (const [, v] of this.entries()) yield v; }
  override keys(): MapIterator<unknown> { this.whole(); return super.keys(); }
  override [Symbol.iterator]() { return this.entries(); }
}

class LoggedSet extends Set<unknown> {
  private readonly mine = new Set<unknown>();
  constructor(private readonly base: Set<unknown>, private readonly path: Step[], private readonly rec: Rec) {
    super();
    for (const x of base) Set.prototype.add.call(this, x);
  }
  override has(x: unknown) { if (!this.mine.has(x)) look(this.rec, this.base, this.path, x); return super.has(x); }
  // every add is logged, a value the page had already too: another page may not have it
  override add(x: unknown) { this.rec.write(this.path, { kind: 'add', value: x }); this.mine.add(x); return super.add(x); }
  override delete(x: unknown) { this.rec.write(this.path, { kind: 'delete', key: x } as Change); this.mine.add(x); return super.delete(x); }
  override clear() { this.rec.refuse(`clears ${pathText(this.path)}`); super.clear(); }
  private whole() { this.rec.read({ at: this.path, size: this.base.size, keys: keysOf(this.base) }); }
  override get size() { this.whole(); return super.size; }
  override forEach(f: (v: unknown, k: unknown, s: Set<unknown>) => void, self?: unknown) { this.whole(); super.forEach((v) => f.call(self, v, v, this)); }
  override values(): SetIterator<unknown> { this.whole(); return super.values(); }
  override keys(): SetIterator<unknown> { return this.values(); }
  override entries(): SetIterator<[unknown, unknown]> { this.whole(); return super.entries(); }
  override [Symbol.iterator]() { return this.values(); }
}

/** a list that logs: what is pushed; a read of what the page had is a read of its length; any other write is not linked */
function loggedList(base: unknown[], path: Step[], rec: Rec): unknown[] {
  const copy = base.slice(), n = base.length;
  const p: unknown[] = new Proxy(copy, {
    get(t, k, r) {
      if (k === 'push') return (...xs: unknown[]) => { for (const x of xs) rec.write(path, { kind: 'push', value: x }); return t.push(...xs); };
      if (k === 'length' || k === Symbol.iterator || (typeof k === 'string' && /^\d+$/.test(k) && +k < n) || (typeof k === 'string' && typeof (Array.prototype as any)[k] === 'function')) rec.read({ at: path, size: n, keys: null });
      const v = Reflect.get(t, k, r);
      return typeof v === 'function' && k !== 'constructor' ? v.bind(p) : v;
    },
    set(t, k, v) {
      if (!(typeof k === 'string' && /^\d+$/.test(k) && +k === t.length - 1 && t[+k] === v) && k !== 'length') rec.refuse(`writes ${pathText(path)} in place`);
      return Reflect.set(t, k, v);
    },
  });
  return p;
}

/** a weak table of a unit: its page's, read through, its own writes logged (what it reads is not: weak tables are keyed by objects) */
class LoggedWeak {
  private readonly own: Map<object, unknown> | Set<object>;
  private readonly gone = new Set<object>();
  constructor(private readonly base: WeakMap<object, unknown> | WeakSet<object>, private readonly field: string, private readonly rec: Rec) { this.own = base instanceof WeakSet ? new Set() : new Map(); }
  has(k: object) { return !this.gone.has(k) && (this.own.has(k) || this.base.has(k)); }
  get(k: object) { return this.gone.has(k) ? undefined : this.own instanceof Map && this.own.has(k) ? this.own.get(k) : (this.base as WeakMap<object, unknown>).get(k); }
  set(k: object, v: unknown) { this.rec.ops.push({ op: 'weak', field: this.field, key: k, value: v }); this.gone.delete(k); (this.own as Map<object, unknown>).set(k, v); return this; }
  add(k: object) { this.rec.ops.push({ op: 'weakAdd', field: this.field, key: k }); this.gone.delete(k); (this.own as Set<object>).add(k); return this; }
  delete(k: object) { this.rec.ops.push({ op: 'weakDel', field: this.field, key: k }); const had = this.has(k); this.own.delete(k); if (this.base.has(k)) this.gone.add(k); return had; }
}

/**
 * Options that are the build's, the same for every page (or whose differences linking accounts for: `file`), which a unit
 * may read freely. Any other option it reads is a read of the page: a page it is linked into must have it alike.
 */
const BUILD_OPTIONS = new Set(['root', 'dev', 'sourcemap', 'helpers', 'actions', 'config', 'readFile', 'listFiles', 'globCache', 'templates', 'definitions', 'collections',
  'collectionsError', 'prefetch', 'openapi', 'apis', 'complexity', 'expansionLimit', 'componentNames', 'libraries', 'checkCycles', 'lazy', 'lazyScript', 'lazyModule',
  'helperValues', 'helperFold', 'foldLog', 'prerender', 'changesRequests', 'observe', 'embed', 'componentCss', 'base', 'shift', 'file', 'decided', 'unrolled', 'constants', 'frozen', 'overLimit']);
/**
 * an option as a read sees it: its JSON, or null when it is not data. An image host (`images`) is not: its answers change
 * as the build analyses images, so a definition with an image is compiled on each page.
 */
const optionPrint = json;

/**
 * A top-level definition compiled as a unit (`unitChild`) and recorded as it compiles: the unit's tables, the page info,
 * the component files and its own fields log what it writes and reads of its page, its options what it reads of them.
 * The writes are applied to the page (the same objects: the page goes on as if compiled in place) and kept, with the
 * reads, as a plan (`keep`): a page linking it must read alike (`replay`). What it cannot be linked for refuses the plan.
 */
export function recordChild<T>(c: any, name: string, compile: (child: any) => T, prior: Map<object, { u: number; i: number }>): { result: T; unit: Plan | Refused } {
  for (const k of Object.keys(c)) if (!(k in LINK_FIELDS)) return { result: compile(c), unit: { refused: `\`${k}\` is not in LINK_FIELDS` } };
  const rec = new Rec();
  const u = c.unitChild(), child = u.child;
  const t0 = c.templates.length, f0 = c.fns.length, u0 = c.useIds, s0 = c.nextSid, n0 = c.nextId, a0 = c.actions.length, atBefore = c.at;
  const codeKeys = new Set(c.codeAt.keys()), defKeys = new Set(c.defs.keys());
  // the page as it is before the unit: its objects, and a copy of each plain one, to see what the unit changed in it
  const old = new Set<object>();
  let top = atBefore?.el;
  while (top?.parentNode) top = top.parentNode;
  reach([...Object.keys(c).filter((k) => !SKIP.has(k)).map((k) => c[k]), top, atBefore], old, (o) => shared(o) || o === c.opts);
  const before = new Map<object, any>();
  for (const o of old) if (!container(o) && !(o instanceof WeakMap) && !(o instanceof WeakSet) && !('nodeName' in o)) before.set(o, shallow(o));
  // the unit's view of its page: its own tables, the page info and the component files log; so do its own fields
  for (const k of u.own) child[k] = LINK_FIELDS[k]!.how === 'weak' ? new LoggedWeak(c[k], k, rec) : wrap(c[k], [{ p: k }], rec);
  child.componentFiles = wrap(c.componentFiles, [{ p: 'componentFiles' }], rec, true);
  const info: Record<string, unknown> = {};
  for (const k of Object.keys(c.page)) info[k] = container(c.page[k]) ? wrap(c.page[k], [{ p: 'page' }, { p: k }], rec) : c.page[k];
  child.page = new Proxy(info, {
    get(t, k) { if (typeof k === 'string' && !container(t[k]) && !rec.page.has(t[k] as object)) { const v = json(t[k]); if (v === null) rec.refuse(`reads the page's \`${k}\``); else rec.read({ at: [{ p: 'page' }, { p: k }], value: v }); } return t[k as string]; },
    set(t, k, v) { rec.write([{ p: 'page' }], { kind: 'prop', key: k as string, value: v }); t[k as string] = v; return true; },
  });
  rec.page.set(child.page, c.page);
  const optRead = new Set<string>();
  child.opts = new Proxy(c.opts, { get(t, k) { if (typeof k === 'string') optRead.add(k); return t[k]; } });
  rec.page.set(child.opts, c.opts);
  for (const [k, f] of Object.entries(LINK_FIELDS)) {
    if (!(k in child) || (f.how !== 'fixed' && f.how !== 'restored') || k === 'page' || k === 'opts' || k === 'componentFiles') continue;
    let v = child[k], mine = false;
    Object.defineProperty(child, k, {
      configurable: true, enumerable: true,
      // (what it reads after writing it is its own)
      get() { if (mine) return v; const j = json(v); if (j === null) rec.refuse(`reads \`${k}\` (${v?.constructor?.name})`); else rec.read({ at: [{ p: k }], value: j }); return v; },
      set(x) { rec.write([], { kind: 'prop', key: k, value: x }); v = x; mine = true; },
    });
  }
  // its hand-outs of functions, in order
  const calls: Array<{ code: string; rec: number }> = [];
  const fn0 = child.fn;
  child.fn = function (code: string, site?: unknown) { const i = fn0.call(child, code, site); calls.push({ code, rec: i }); return i; };
  let result: T;
  try { result = compile(child); } finally { delete child.fn; }
  // the page as compiled in place: the unit's writes applied to its objects, its numbering taken over
  const ops = rec.ops;
  for (const [x, y] of child.codeAt) if (!codeKeys.has(x)) ops.push({ op: 'old', target: { path: [{ p: 'codeAt' }] }, change: { kind: 'set', key: x, value: y, ifAbsent: true } as Change });
  for (const [x, y] of child.defs) if (!defKeys.has(x)) ops.push({ op: 'old', target: { path: [{ p: 'defs' }] }, change: { kind: 'set', key: x, value: y } });
  const unwrap = (v: unknown) => (v && typeof v === 'object' ? rec.page.get(v) ?? v : v);
  applyOps(c, ops, unwrap);
  for (const k of UNIT_NUMBERING) if (k in c) c[k] = child[k];
  c.at = child.at;
  // what it changed of the page's plain objects (a use's list, a resource's `used`): against their path from the page's fields
  const where = paths(c, old);
  for (const [o, b] of before as Map<any, any>) {
    const keys = new Set([...Object.keys(b), ...Object.keys(o)]);
    for (const k of keys) {
      if (o[k] === b[k]) continue;
      const path = prior.has(o) ? null : where.get(o);
      if (!prior.has(o) && !path) { rec.refuse(`changes an object of the page that has no key (${o.constructor?.name ?? 'object'}: ${Object.keys(o).slice(0, 6).join(', ')})`); continue; }
      if (!(k in o)) { rec.refuse(`deletes \`${k}\` of an object of the page`); continue; }
      ops.push({ op: 'old', target: prior.has(o) ? { prior: prior.get(o)! } : { path: path! }, change: { kind: 'prop', key: k, value: o[k] } });
    }
  }
  const refuse = (why: string) => ({ result, unit: { refused: why } as Refused });
  if (rec.bad) return refuse(rec.bad);
  if (child.nextId !== n0) return refuse('`nextId` changed (node ids are not renumbered)');
  if (child.actions.length !== a0) return refuse('adds an action (`actions` is not renumbered)');
  for (const o of ops) {
    const f = o.op === 'old' && 'path' in o.target ? (o.target.path[0] as { p?: string })?.p : undefined;
    // (numberings of their own, not renumbered yet: a fill's id, a lazy import's local name)
    if (f === 'fillDefs' || f === 'lazyLoads') return refuse(`writes \`${f}\` (not renumbered)`);
    // a numbered table read by a page's id: the page's numbering, not the unit's
    if (o.op === 'old' && 'path' in o.target && o.target.path.length === 1 && (TID_KEYED.has(f!) || USE_KEYED.has(f!) || SID_KEYED.has(f!)) && (o.change as any).kind !== 'set') return refuse(`writes \`${f}\` other than by a new key`);
  }
  for (const r of rec.reads) { const f = (r.at[0] as { p?: string })?.p; if ('key' in r && (TID_KEYED.has(f!) || USE_KEYED.has(f!) || SID_KEYED.has(f!))) return refuse(`reads \`${f}\` by the page's numbering`); }
  // the options it read that are the page's: alike on a page that links it
  for (const k of optRead) {
    if (BUILD_OPTIONS.has(k)) continue;
    const v = optionPrint(c.opts[k]);
    if (v === null) return refuse(`reads the option \`${k}\`, which is not data`);
    rec.read({ at: [{ p: 'opts' }, { p: k }], value: v });
  }
  const atAfter = c.at;
  const templates = c.templates.slice(t0);
  const fnAt = new Map<number, unknown>();
  for (let i = f0; i < c.fns.length; i++) fnAt.set(i, c.fnAt[i]);
  const uses = c.useIds - u0, sids = c.nextSid - s0;
  // the objects of the page it refers to: by their path, made by an earlier unit, the element being compiled, or shared
  const refs = new Map<object, Ref>([[c.opts, { self: 'opts' }], [c.page, { self: 'page' }], [c, { self: 'compiler' }]]);
  if (atBefore) refs.set(atBefore, { at: 'site' });
  if (atBefore?.el) refs.set(atBefore.el, { at: 'el' });
  const todo: unknown[] = [ops.map((o) => ('change' in o ? o.change : o)).map((x) => unwrapDeep(x, unwrap)), templates, [...fnAt.values()], atAfter];
  const seen = new Set<object>();
  while (todo.length) {
    const v = unwrap(todo.pop());
    if (!v || typeof v !== 'object' || seen.has(v) || shared(v) || refs.has(v)) continue;
    if (old.has(v) || prior.has(v)) {
      if (prior.has(v)) { refs.set(v, { prior: prior.get(v)! }); continue; }
      const path = where.get(v) ?? rec.where.get(v);
      if (!path) return refuse(`refers to an object of the page that has no key (${(v as any).constructor?.name ?? 'object'}: ${(v as any).nodeName ?? Object.keys(v).slice(0, 6).join(', ')})`);
      refs.set(v, { path });
      continue;
    }
    seen.add(v);
    if (typeof v === 'function') return refuse('holds a function');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== null) return refuse(`holds a ${(v as any).constructor?.name}`);
    if (v instanceof Map) for (const [k, x] of v) todo.push(k, x);
    else if (v instanceof Set) for (const x of v) todo.push(x);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else for (const k of Object.keys(v)) { if (typeof (v as any)[k] === 'function') return refuse(`holds a function (\`${k}\`)`); todo.push((v as any)[k]); }
  }
  const unit: Unit = { name, file: c.opts.file, ops: ops.map((o) => unwrapOp(o, unwrap)), reads: rec.reads, calls, fnAt, templates, t0, u0, uses, s0, sids, at: atBefore, atAfter, refs };
  return { result, unit: keep(unit, prior) };
}

/** a value with each wrapper replaced by the page's table it stands for (one level: what a write hands over) */
function unwrapDeep(x: any, unwrap: (v: unknown) => unknown): any {
  if (!x || typeof x !== 'object') return x;
  const y = unwrap(x);
  if (y !== x) return y;
  if (!Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype && ('kind' in x || 'op' in x)) { const o: any = {}; for (const k of Object.keys(x)) o[k] = unwrap(x[k]); return o; }
  return x;
}
const unwrapOp = (o: Op, unwrap: (v: unknown) => unknown): Op => (o.op === 'old' ? { ...o, change: unwrapDeep(o.change, unwrap) } : o.op === 'weak' ? { ...o, key: unwrap(o.key), value: unwrap(o.value) } : { ...o, key: unwrap(o.key) as object });

/** writes applied to a page as they are: the objects themselves (the page that compiled them goes on with them) */
export function applyOps(c: any, ops: Op[], unwrap: (v: unknown) => unknown = (v) => v) {
  for (const o of ops) {
    if (o.op === 'weak') c[o.field].set(unwrap(o.key), unwrap(o.value));
    else if (o.op === 'weakAdd') c[o.field].add(unwrap(o.key));
    else if (o.op === 'weakDel') c[o.field].delete(unwrap(o.key));
    else if (o.op === 'old') {
      const t: any = follow(c, (o.target as { path: Step[] }).path), ch: any = o.change;
      if (ch.kind === 'set') { if (!(ch.ifAbsent && t.has(unwrap(ch.key)))) t.set(unwrap(ch.key), unwrap(ch.value)); }
      else if (ch.kind === 'add') t.add(unwrap(ch.value));
      else if (ch.kind === 'push') t.push(unwrap(ch.value));
      else if (ch.kind === 'delete') t.delete(unwrap(ch.key));
      else t[ch.key] = unwrap(ch.value);
    }
  }
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
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd' | 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; kind: Change['kind']; key?: unknown; value?: unknown; ifAbsent?: true };
export type Plan = {
  id: number; name: string; file: string; objs: Entry[]; ext: Ref[]; ops: PlanOp[]; reads: Read[]; strings: S[]; calls: Unit['calls'];
  fnAt: Array<[number, unknown]>; templates: unknown[]; t0: number; u0: number; uses: number; s0: number; sids: number; atAfter: unknown;
};
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
  const live: object[] = [], strings: S[] = [];
  const base = u.file.slice(u.file.lastIndexOf('/') + 1);
  // (`markup`: a string of a node or of an attribute, text the page wrote, where `US$5` is not a loop variable)
  const enc = (v: any, markup = false): unknown => {
    if (typeof v === 'string') {
      if (!(v.includes(base) || (markup ? NEEDS : NEEDS_CODE).test(v))) return v;
      const x = new S(v, !markup);
      strings.push(x);
      return x;
    }
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
      return { op: 'old', target: o.target, kind: ch.kind, ...('key' in ch ? { key: enc(ch.key) } : {}), ...('value' in ch ? { value: enc(ch.value) } : {}), ...(ch.ifAbsent ? { ifAbsent: true } : {}) } as PlanOp;
    }
    if (o.op === 'weak') return { op: 'weak', field: o.field, key: enc(o.key), value: enc(o.value) };
    return { op: o.op, field: o.field, key: enc(o.key) };
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
  return { id, name: u.name, file: u.file, objs, ext, ops, reads: u.reads, strings, calls: u.calls, fnAt, templates, t0: u.t0, u0: u.u0, uses: u.uses, s0: u.s0, sids: u.sids, atAfter };
}

/** per page: how the units linked into it renumber what they recorded, and the objects each made here */
type PageMaps = { tid: Map<number, number>; fn: Map<number, number>; use: Map<number, number>; sid: Map<number, number>; outs: Map<number, unknown[]>; strs: Map<string, string> };

/** whether the page `c` reads as the recording page did, everywhere the unit looked */
function readsHold(c: any, reads: Read[]): boolean {
  for (const r of reads) {
    if ('value' in r) {
      const opt = r.at.length === 2 && (r.at[0] as { p?: string }).p === 'opts' ? (r.at[1] as { p: string }).p : null;
      if ((opt !== null ? optionPrint(c.opts[opt]) : json(follow(c, r.at))) !== r.value) return false;
      continue;
    }
    const t = follow(c, r.at);
    if ('has' in r) { if (!(t instanceof Map || t instanceof Set) || t.has(r.key) !== r.has) return false; }
    else if (Array.isArray(t)) { if (r.keys !== null || t.length !== r.size) return false; }
    else if (!(t instanceof Map || t instanceof Set) || t.size !== r.size || (r.keys !== null && keysOf(t) !== r.keys)) return false;
  }
  return true;
}

/** a name of a page in code: an identifier token renamed, a string's text as markup is (`x$1` in a string is the user's) */
let tokenizer: ((s: string, o: object) => Iterable<{ type: { label: string }; start: number; end: number }>) | null = null;
function codeTokens(s: string): Array<{ ident: boolean; start: number; end: number }> | null {
  tokenizer ??= (globalThis as any).process?.getBuiltinModule?.('node:module')?.createRequire(import.meta.url)('acorn').tokenizer ?? null;
  if (!tokenizer) return null;
  try {
    const out: Array<{ ident: boolean; start: number; end: number }> = [];
    for (const t of tokenizer(s, { ecmaVersion: 'latest', allowHashBang: false })) out.push({ ident: t.type.label === 'name', start: t.start, end: t.end });
    return out;
  } catch { return null; }
}

/** The unit linked into the page `c`; false when it cannot be (nothing changed then). */
export function replay(c: any, u: Plan, maps: PageMaps): boolean {
  if (!readsHold(c, u.reads)) return false;
  // the objects of the page it refers to, and those it changes: all there, or nothing changes
  const ext: unknown[] = [];
  for (const r of u.ext) {
    const v = 'prior' in r ? maps.outs.get((r.prior as any).u)?.[(r.prior as any).i] : 'self' in r ? (r.self === 'opts' ? c.opts : r.self === 'page' ? c.page : c) : 'at' in r ? (r.at === 'site' ? c.at : c.at?.el) : follow(c, r.path);
    if (v === undefined) return false;
    ext.push(v);
  }
  const targets: any[] = [];
  for (const o of u.ops) {
    if (o.op !== 'old') { if (!c[o.field]) return false; targets.push(c[o.field]); continue; }
    const t: any = 'prior' in o.target ? maps.outs.get(o.target.prior.u)?.[o.target.prior.i] : follow(c, o.target.path);
    const ok = o.kind === 'set' ? t instanceof Map : o.kind === 'add' ? t instanceof Set : o.kind === 'push' ? Array.isArray(t) : o.kind === 'delete' ? t instanceof Map || t instanceof Set : t !== null && typeof t === 'object';
    if (!ok) return false;
    targets.push(t);
  }
  const T0 = c.templates.length, U0 = c.useIds, S0 = c.nextSid;
  const tid = new Map(maps.tid), sid = new Map(maps.sid);
  for (let i = 0; i < u.templates.length; i++) tid.set(u.t0 + i, T0 + i);
  for (let i = 0; i < u.sids; i++) sid.set(u.s0 + i, S0 + i);
  const file = c.opts.file, base = u.file.slice(u.file.lastIndexOf('/') + 1), mine = file.slice(file.lastIndexOf('/') + 1), strs = maps.strs;
  const tidOf = (n: string) => tid.get(+n) ?? n;
  const markup = (s: string) => s.replace(/\$(p|sl)(\d+)/g, (_, k, n) => `$${k}${tidOf(n)}`).replace(/sn-t-(\d+)/g, (_, n) => `sn-t-${tidOf(n)}`).replace(/#case(\d+)\//g, (_, n) => `#case${tidOf(n)}/`).replace(/\$s(\d+)/g, (_, n) => `$s${sid.get(+n) ?? n}`);
  // (in code, also a loop's index and a clashing loop variable, named by their template: only in a name, not in a string)
  const ident = (s: string) => markup(s).replace(/^\$i(\d+)$/, (_, n) => `$i${tidOf(n)}`).replace(/^([\w$]*\w)\$(\d+)$/, (_, a, n) => `${a}$${tidOf(n)}`);
  // the page's file: a string that is it, or names it by its base name (a diagnostic, a module's source)
  const named = (s: string) => (s === u.file ? file : base !== mine && s.includes(base) ? s.split(u.file).join(file).split(base).join(mine) : s);
  const str = (s: string, code: boolean): string | null => {
    const key = code ? s : `\u0000${s}`;
    const had = strs.get(key);
    if (had !== undefined) return had;
    let o: string;
    if (!code) o = markup(named(s));
    else if (!NEEDS_CODE.test(s)) o = named(s);
    else {
      const toks = codeTokens(s);
      if (!toks) return null;
      let out = '', last = 0;
      for (const t of toks) { out += s.slice(last, t.start) + (t.ident ? ident(s.slice(t.start, t.end)) : markup(s.slice(t.start, t.end))); last = t.end; }
      o = named(out + s.slice(last));
    }
    strs.set(key, o);
    return o;
  };
  // every string renamed first (code the tokenizer cannot read is not linked)
  const done = new Map<S, string>();
  for (const x of u.strings) { const o = str(x.s, x.code); if (o === null) return false; done.set(x, o); }
  const codes: string[] = [];
  for (const x of u.calls) { const o = str(x.code, true); if (o === null) return false; codes.push(o); }
  // from here on, the page changes
  for (const [k, v] of tid) maps.tid.set(k, v);
  for (const [k, v] of sid) maps.sid.set(k, v);
  for (let i = 0; i < u.uses; i++) maps.use.set(u.u0 + i, U0 + i);
  // the function table: each hand-out again, in order
  const f0 = c.fns.length;
  u.calls.forEach((x, i) => maps.fn.set(x.rec, c.fn(codes[i], null)));
  const fix = { fn: (n: number) => maps.fn.get(n) ?? n, tid: (n: number) => maps.tid.get(n) ?? n, use: (n: number) => maps.use.get(n) ?? n, sid: (n: number) => maps.sid.get(n) ?? n };
  // the objects: made, then filled
  const out: any[] = new Array(u.objs.length);
  for (let i = 0; i < u.objs.length; i++) { const e = u.objs[i]!; out[i] = e.t === 0 ? (e.proto === Object.prototype ? {} : Object.create(e.proto)) : e.t === 1 ? [] : e.t === 2 ? new Map() : new Set(); }
  const dec = (v: unknown): any => (v instanceof R ? out[v.i] : v instanceof X ? ext[v.j] : v instanceof S ? done.get(v) : v);
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
  u.ops.forEach((o, n) => {
    const t = targets[n];
    if (o.op === 'weak') { t.set(dec(o.key), dec(o.value)); return; }
    if (o.op === 'weakAdd') { t.add(dec(o.key)); return; }
    if (o.op !== 'old') { t.delete(dec(o.key)); return; }
    // (a table of the page keyed by its numbering: the key renumbered; a set of template ids: the value)
    const field = 'path' in o.target && o.target.path.length === 1 ? (o.target.path[0] as { p?: string }).p ?? '' : '';
    const k = o.key, key = typeof k === 'number' && TID_KEYED.has(field) ? fix.tid(k) : typeof k === 'number' && USE_KEYED.has(field) ? fix.use(k) : typeof k === 'number' && SID_KEYED.has(field) ? fix.sid(k) : dec(k);
    if (o.kind === 'set') { if (!(o.ifAbsent && t.has(key))) t.set(key, dec(o.value)); }
    else if (o.kind === 'add') t.add(typeof o.value === 'number' && TID_SETS.has(field) ? fix.tid(o.value) : dec(o.value));
    else if (o.kind === 'push') t.push(dec(o.value));
    else if (o.kind === 'delete') t.delete(key);
    else t[key as string] = dec(o.value);
  });
  c.useIds += u.uses;
  c.nextSid += u.sids;
  c.at = dec(u.atAfter);
  return true;
}
