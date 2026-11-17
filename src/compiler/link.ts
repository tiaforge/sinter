// Shared definitions linked into each page (docs/proposals/compile-once.md, (5)). The first time a build needs a top-level
// definition, it compiles in place. The second time, it compiles as a unit (`Compiler.unitChild`, `recordChild`), twice:
// a compiler with its page's numbering, whose view of its page logs what it writes and what it reads (`Read`). First as
// a shadow, its numbering higher and its page's file marked, nothing of it kept; then as itself, its writes applied to the
// page. Where the two differ is what a page linking it renumbers (`merge`). The writes, the reads and its hand-outs of
// functions are kept as a flat plan. A later page with the same definitions before it, that reads alike everywhere the
// unit looked, replays the plan (`replay`): the objects copied, its ids and those of the definitions before it renumbered
// (`Span`), `fn()` replayed in order (so the table's dedupe and numbering are the page's own). A plan that does not hold
// changes nothing, and the page compiles in place; what a unit cannot be linked for refuses it.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Ref = { path: Step[] } | { at: 'el' | 'site' } | { self: 'opts' | 'page' | 'compiler' } | { prior: { u: number; i: number } };
type Change = { kind: 'set'; key: unknown; value: unknown; ifAbsent?: true } | { kind: 'add'; value: unknown } | { kind: 'prop'; key: string | number; value: unknown } | { kind: 'push'; value: unknown } | { kind: 'delete'; key: unknown };
type Op =
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd'; field: string; key: unknown }
  | { op: 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; change: Change };
/** a unit as it was recorded: its writes, its reads, its hand-outs of functions (and where each was written), its templates */
type Unit = {
  name: string;
  file: string;
  ops: Op[];
  /** what it read of its page (`Read`): a page it is linked into must read alike */
  reads: Read[];
  calls: Array<{ code: string; rec: number; site: unknown }>;
  templates: unknown[];
  t0: number;
  u0: number;
  uses: number;
  s0: number;
  sids: number;
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

/**
 * a path to each old object, from the compiler's fields: through properties and map keys first, through a list's
 * position only where no other path leads (a position says nothing of what is there: it is pinned, `runUnit`)
 */
function paths(c: any, old: Set<object>): Map<object, Step[]> {
  const out = new Map<object, Step[]>();
  let todo: Array<[unknown, Step[]]> = [], later: Array<[unknown, Step[]]> = [];
  for (const k of Object.keys(c)) if (!SKIP.has(k)) todo.push([c[k], [{ p: k }]]);
  while (todo.length) {
    for (let n = 0; n < todo.length; n++) {
      const [v, path] = todo[n]!;
      if (!v || typeof v !== 'object' || out.has(v) || !old.has(v) || Object.isFrozen(v)) continue;
      out.set(v, path);
      if ('nodeName' in (v as object)) continue;
      if (v instanceof Map) { for (const [k, x] of v) if (k === null || typeof k !== 'object') todo.push([x, [...path, { k }]]); }
      else if (Array.isArray(v)) v.forEach((x, i) => later.push([x, [...path, { i }]]));
      else if (!(v instanceof Set) && !(v instanceof WeakMap) && !(v instanceof WeakSet)) for (const k of Object.keys(v)) todo.push([(v as any)[k], [...path, { p: k }]]);
    }
    [todo, later] = [later, []];
  }
  return out;
}

const follow = (c: any, path: Step[]) => path.reduce((o: any, s) => (o == null ? undefined : 'p' in s ? o[s.p] : 'k' in s ? o.get(s.k) : o[s.i]), c);

/** a shallow copy of an object, to see what a call changed in it */
const shallow = (o: any) => (o instanceof Map ? new Map(o) : o instanceof Set ? new Set(o) : Array.isArray(o) ? o.slice() : Object.assign(Object.create(null), o));

// ---- recording a unit: a compiler of its own, whose view of its page logs what it reads (`Read`) and writes (`Op`)

/**
 * What a unit read of its page, which a page it is linked into must show alike (`replay` checks every one first): a key
 * looked up in a table, present or not; a table read whole, by its size (and its keys, when they are names); a value (a
 * field of the compiler or of the page info, an option, what a table holds at a key or a list at a position), by its
 * `shape`; an object of the page found again by its position in a list, by its own plain values (`flat`).
 */
export type Read =
  | { at: Step[]; key: unknown; has: boolean }
  | { at: Step[]; size: number; keys: string | null }
  | { at: Step[]; value: string }
  | { at: Step[]; flat: string };

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
/**
 * what a read sees of a value: JSON, an element of the page as `#node` (what is at it is read where it is read), or null
 * when it is not data (a function, a class's object)
 */
function shape(v: unknown): string | null {
  const seen = new Set<object>();
  let ok = true;
  const s = JSON.stringify(v, (_, x) => {
    if (typeof x === 'function') { ok = false; return undefined; }
    if (x && typeof x === 'object') {
      if ('nodeName' in x) return '#node';
      if (x instanceof Map) return { $map: [...x] };
      if (x instanceof Set) return { $set: [...x] };
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) { ok = false; return undefined; }
      if (seen.has(x)) return '#seen';
      seen.add(x);
    }
    return x;
  });
  return ok ? (s ?? 'undefined') : null;
}
/** an object's own plain values: what tells it from the others of its list */
const flat = (o: any) => JSON.stringify(Object.keys(o).filter((k) => o[k] === null || (typeof o[k] !== 'object' && typeof o[k] !== 'function')).sort().map((k) => [k, o[k]]));

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
/** a value read of the page at a path: its shape */
function readValue(rec: Rec, path: Step[], v: unknown) {
  const s = shape(v);
  if (s === null) rec.refuse(`reads ${pathText(path)}, which is not data`);
  else rec.read({ at: path, value: s });
}

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
    if (v && typeof v === 'object') this.rec.read({ at: [...this.path, { k }, { p: 'bad' }], value: shape((v as { bad?: unknown }).bad) ?? 'undefined' });
  }
  private whole() { if (!this.cache) this.rec.read({ at: this.path, size: this.base.size, keys: keysOf(this.base) }); }
  /** what the page has at a key: a table a wrapper too (what the unit adds to it is logged), a value read by its shape */
  private value(k: unknown, v: unknown) {
    if (this.mine.has(k)) return v;
    if (v && typeof v === 'object' && container(v)) {
      let w = this.wraps.get(k);
      if (!w) this.wraps.set(k, (w = wrap(v, [...this.path, { k }], this.rec)));
      return w;
    }
    if (!this.cache && (k === null || typeof k !== 'object')) readValue(this.rec, [...this.path, { k }], v);
    return v;
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
  override delete(x: unknown) { if (!this.mine.has(x)) look(this.rec, this.base, this.path, x); this.rec.write(this.path, { kind: 'delete', key: x } as Change); this.mine.add(x); return super.delete(x); }
  override clear() { this.rec.refuse(`clears ${pathText(this.path)}`); super.clear(); }
  private whole() { this.rec.read({ at: this.path, size: this.base.size, keys: keysOf(this.base) }); }
  override get size() { this.whole(); return super.size; }
  override forEach(f: (v: unknown, k: unknown, s: Set<unknown>) => void, self?: unknown) { this.whole(); super.forEach((v) => f.call(self, v, v, this)); }
  override values(): SetIterator<unknown> { this.whole(); return super.values(); }
  override keys(): SetIterator<unknown> { return this.values(); }
  override entries(): SetIterator<[unknown, unknown]> { this.whole(); return super.entries(); }
  override [Symbol.iterator]() { return this.values(); }
}

/**
 * a list that logs: what is pushed; its length read as its size, an element by its shape, the list read through any other
 * way (a method, its iterator) by the shape of all of it; any other write is not linked
 */
function loggedList(base: unknown[], path: Step[], rec: Rec): unknown[] {
  const copy = base.slice(), n = base.length;
  const p: unknown[] = new Proxy(copy, {
    get(t, k, r) {
      if (k === 'push') return (...xs: unknown[]) => { for (const x of xs) rec.write(path, { kind: 'push', value: x }); return t.push(...xs); };
      if (k === 'length') rec.read({ at: path, size: n, keys: null });
      else if (typeof k === 'string' && /^\d+$/.test(k)) { if (+k < n) readValue(rec, [...path, { i: +k }], base[+k]); }
      else if (k === Symbol.iterator || (typeof k === 'string' && k !== 'constructor' && typeof (Array.prototype as any)[k] === 'function')) readValue(rec, path, base);
      const v = Reflect.get(t, k, r);
      return typeof v === 'function' && k !== 'constructor' ? v.bind(p) : v;
    },
    set(t, k, v) {
      if (!(typeof k === 'string' && /^\d+$/.test(k) && +k === t.length - 1 && t[+k] === v)) rec.refuse(`writes ${pathText(path)} in place`);
      return Reflect.set(t, k, v);
    },
  });
  return p;
}

/**
 * a weak table of a unit: its page's, read through (`view`: how it shows the unit what the page has), its own writes logged
 * (what it reads is not: weak tables are keyed by objects)
 */
class LoggedWeak {
  private readonly own: Map<object, unknown> | Set<object>;
  private readonly gone = new Set<object>();
  constructor(private readonly base: WeakMap<object, unknown> | WeakSet<object>, private readonly field: string, private readonly rec: Rec, private readonly view = (v: unknown) => v) { this.own = base instanceof WeakSet ? new Set() : new Map(); }
  has(k: object) { return !this.gone.has(k) && (this.own.has(k) || this.base.has(k)); }
  get(k: object) { return this.gone.has(k) ? undefined : this.own instanceof Map && this.own.has(k) ? this.own.get(k) : this.view((this.base as WeakMap<object, unknown>).get(k)); }
  set(k: object, v: unknown) { this.rec.ops.push({ op: 'weak', field: this.field, key: k, value: v }); this.gone.delete(k); (this.own as Map<object, unknown>).set(k, v); return this; }
  add(k: object) { this.rec.ops.push({ op: 'weakAdd', field: this.field, key: k }); this.gone.delete(k); (this.own as Set<object>).add(k); return this; }
  delete(k: object) { this.rec.ops.push({ op: 'weakDel', field: this.field, key: k }); const had = this.has(k); this.own.delete(k); if (this.base.has(k)) this.gone.add(k); return had; }
}

/**
 * Options that are the build's, the same for every page (or whose differences linking accounts for: `file`), which a unit
 * may read freely. Any other option it reads is a read of the page: a page it is linked into must have it alike. An image
 * host (`images`) is not data: its answers change as the build analyses images, so a definition with an image is compiled
 * on each page.
 */
const BUILD_OPTIONS = new Set(['root', 'dev', 'sourcemap', 'helpers', 'actions', 'config', 'readFile', 'listFiles', 'globCache', 'templates', 'definitions', 'collections',
  'collectionsError', 'prefetch', 'openapi', 'apis', 'complexity', 'expansionLimit', 'componentNames', 'libraries', 'checkCycles', 'lazy', 'lazyScript', 'lazyModule',
  'helperValues', 'helperFold', 'foldLog', 'prerender', 'changesRequests', 'observe', 'embed', 'componentCss', 'base', 'shift', 'file', 'decided', 'unrolled', 'constants', 'frozen', 'overLimit']);

/**
 * The shadow's offsets (`recordChild`): its templates and states numbered this much higher, its page's file named with
 * these marks where its folder (under the root) and its name begin. A number that differs by an offset between the two
 * compiles is the unit's own; text that differs by a mark is the page's file. Neither mark has a digit.
 */
const SHIFT_T = 1009, SHIFT_S = 2003, MARK_DIR = 'snLinkShadowDir', MARK_STEM = 'snLinkShadowStem';
/** a page's file by its parts: its folder under the root (`blog/`, or ''), its name and its extension; null outside the root */
function fileParts(root: string, file: string): { dir: string; stem: string; ext: string } | null {
  const r = String(root).replace(/\/+$/, '');
  if (!file.startsWith(r + '/')) return null;
  const rel = file.slice(r.length + 1), dir = rel.slice(0, rel.lastIndexOf('/') + 1), base = rel.slice(dir.length), dot = base.lastIndexOf('.');
  return { dir, stem: dot > 0 ? base.slice(0, dot) : base, ext: dot > 0 ? base.slice(dot) : '' };
}

type Run = { result: unknown; unit: Unit; enc: Encoded } | { result: unknown; refused: string };
/** a definition's ids on its page: its templates (`t`, `n` of them), its states (`s`, `ns`) and its uses (`u`, `nu`) */
export type Span = { t: number; n: number; s: number; ns: number; u: number; nu: number };

/** the page's plain objects as they were before a unit: what a shadow compile changed in them is put back */
function restore(before: Map<object, any>) {
  for (const [o, b] of before as Map<any, any>) {
    for (const k of Object.keys(o)) if (!(k in b)) delete o[k];
    for (const k of Object.keys(b)) if (o[k] !== b[k]) o[k] = b[k];
  }
}

/**
 * A top-level definition compiled as a unit (`unitChild`) and recorded as it compiles, twice. First as a shadow: its
 * templates and states numbered higher (`SHIFT_T`, `SHIFT_S`), its page's file named with marks, nothing of it kept (the
 * page's objects put back as they were). Then as itself, its writes applied to the page, which goes on as if it compiled
 * in place. Where the two differ is what a page linking it renumbers: a number by the offset, a string where its text
 * does (`merge`); anything else that differs, the unit is not linked. The plan (`keep`) holds the writes, the reads and
 * the hand-outs of functions; a page linking it must read alike (`replay`).
 */
export function recordChild<T>(c: any, name: string, compile: (child: any) => T, prior: Map<object, { u: number; i: number }>, spans: Span[]): { result: T; unit: Plan | Refused } {
  for (const k of Object.keys(c)) if (!(k in LINK_FIELDS)) return { result: compile(c), unit: { refused: `\`${k}\` is not in LINK_FIELDS` } };
  const parts = fileParts(c.opts.root, c.opts.file);
  if (!parts) return { result: compile(c), unit: { refused: 'the page is not under the root' } };
  // the page as it is before the unit: its objects, and a copy of each plain one, to see what the unit changed in it
  const old = new Set<object>();
  let top = c.at?.el;
  while (top?.parentNode) top = top.parentNode;
  reach([...Object.keys(c).filter((k) => !SKIP.has(k)).map((k) => c[k]), top, c.at], old, (o) => shared(o) || o === c.opts);
  const before = new Map<object, any>();
  for (const o of old) if (!container(o) && !(o instanceof WeakMap) && !(o instanceof WeakSet) && !('nodeName' in o)) before.set(o, shallow(o));
  const root = String(c.opts.root).replace(/\/+$/, '');
  let shadow: Run;
  try { shadow = runUnit(c, name, compile, prior, old, before, `${root}/${MARK_DIR}${parts.dir}${MARK_STEM}${parts.stem}${parts.ext}`); }
  catch { shadow = { result: null, refused: 'its shadow compile threw' }; }
  finally { restore(before); }
  const real = runUnit(c, name, compile, prior, old, before, null);
  if ('refused' in real) return { result: real.result as T, unit: { refused: real.refused } };
  if ('refused' in shadow) return { result: real.result as T, unit: { refused: shadow.refused } };
  const plan = merge(real.enc, shadow.enc, real.unit, shadow.unit, { parts, spans, t0: real.unit.t0, s0: real.unit.s0 });
  if ('refused' in plan) return { result: real.result as T, unit: plan };
  for (const [o, i] of real.enc.index) prior.set(o, { u: plan.id, i });
  return { result: real.result as T, unit: plan };
}

/** one compile of a unit (`recordChild`): as a shadow (`shadowFile`: the page's file as it reads it), or as itself */
function runUnit(c: any, name: string, compile: (child: any) => unknown, prior: Map<object, { u: number; i: number }>, old: Set<object>, before: Map<object, any>, shadowFile: string | null): Run {
  const rec = new Rec();
  const u = c.unitChild(), child = u.child;
  const T0 = c.templates.length, f0 = c.fns.length, u0 = c.useIds, S0 = c.nextSid, n0 = c.nextId, a0 = c.actions.length, atBefore = c.at;
  const defKeys = new Set(c.defs.keys()), pageCodeAt: Map<string, unknown> = c.codeAt;
  // a shadow's numbering, higher (as `shift` does: templates with nothing in them)
  const t0 = shadowFile ? T0 + SHIFT_T : T0, s0 = shadowFile ? S0 + SHIFT_S : S0;
  if (shadowFile) { for (let i = T0; i < t0; i++) child.templates.push({ id: i, nodes: [] }); child.nextSid = s0; }
  // the unit's view of its page: its own tables, the page info and the component files log; so do its own fields
  const file = c.opts.file, seen = new WeakMap<object, unknown>();
  const view = shadowFile ? (v: any) => {
    if (!v || typeof v !== 'object' || v.file !== file) return v;
    let w = seen.get(v);
    if (!w) seen.set(v, (w = { ...v, file: shadowFile }));
    return w;
  } : undefined;
  for (const k of u.own) child[k] = LINK_FIELDS[k]!.how === 'weak' ? new LoggedWeak(c[k], k, rec, k === 'origins' ? view : undefined) : wrap(c[k], [{ p: k }], rec);
  child.componentFiles = wrap(c.componentFiles, [{ p: 'componentFiles' }], rec, true);
  const info: Record<string, unknown> = {};
  for (const k of Object.keys(c.page)) info[k] = container(c.page[k]) ? wrap(c.page[k], [{ p: 'page' }, { p: k }], rec) : c.page[k];
  child.page = new Proxy(info, {
    get(t, k) { if (typeof k === 'string' && !container(t[k]) && !rec.page.has(t[k] as object)) readValue(rec, [{ p: 'page' }, { p: k }], t[k]); return t[k as string]; },
    set(t, k, v) { rec.write([{ p: 'page' }], { kind: 'prop', key: k as string, value: v }); t[k as string] = v; return true; },
  });
  rec.page.set(child.page, c.page);
  const optRead = new Set<string>();
  child.opts = new Proxy(c.opts, { get(t, k) { if (k === 'file' && shadowFile) return shadowFile; if (typeof k === 'string') optRead.add(k); return t[k]; } });
  rec.page.set(child.opts, c.opts);
  // where its functions were written: its own (a page's own the page puts first when it links them, as `fn()` does)
  child.codeAt = new Map();
  for (const [k, f] of Object.entries(LINK_FIELDS)) {
    if (!(k in child) || (f.how !== 'fixed' && f.how !== 'restored') || k === 'page' || k === 'opts' || k === 'componentFiles') continue;
    let v = child[k], mine = false;
    Object.defineProperty(child, k, {
      configurable: true, enumerable: true,
      // (what it reads after writing it is its own)
      get() { if (!mine) readValue(rec, [{ p: k }], v); return v; },
      set(x) { rec.write([], { kind: 'prop', key: k, value: x }); v = x; mine = true; },
    });
  }
  // its hand-outs of functions, in order, each with where it was written
  const calls: Unit['calls'] = [];
  const fn0 = child.fn;
  child.fn = function (code: string, site?: unknown) {
    const i = fn0.call(child, code, site);
    calls.push({ code, rec: i, site: child.codeAt.get(code) ?? (site !== undefined ? site : child.at) });
    return i;
  };
  let result: unknown;
  try { result = compile(child); } finally { delete child.fn; }
  const ops = rec.ops;
  for (const [x, y] of child.codeAt) ops.push({ op: 'old', target: { path: [{ p: 'codeAt' }] }, change: { kind: 'set', key: x, value: y, ifAbsent: true } as Change });
  for (const [x, y] of child.defs) if (!defKeys.has(x)) ops.push({ op: 'old', target: { path: [{ p: 'defs' }] }, change: { kind: 'set', key: x, value: y } });
  // (before its writes are applied: what it changed itself, not what they change)
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
  const unwrap = (v: unknown) => (v && typeof v === 'object' ? rec.page.get(v) ?? v : v);
  if (!shadowFile) {
    // the page as compiled in place: the unit's writes applied to its objects, its numbering taken over
    applyOps(c, ops, unwrap);
    for (const k of UNIT_NUMBERING) if (k in c && k !== 'codeAt') c[k] = child[k];
    for (const [x, y] of child.codeAt) if (!pageCodeAt.has(x)) pageCodeAt.set(x, y);
    // (a function new to the page whose code the page had written before: there, as `fn()` puts it)
    for (let i = f0; i < c.fns.length; i++) if (pageCodeAt.has(c.fns[i])) c.fnAt[i] = pageCodeAt.get(c.fns[i]);
    c.at = child.at;
    // a check the unit left for the end of the page (a closure over its compiler): it reports to the page
    for (const k of Object.keys(c)) Object.defineProperty(child, k, { value: c[k], writable: true, configurable: true, enumerable: true });
  }
  const refuse = (why: string): Run => ({ result, refused: why });
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
  for (const k of optRead) if (!BUILD_OPTIONS.has(k)) readValue(rec, [{ p: 'opts' }, { p: k }], c.opts[k]);
  if (rec.bad) return refuse(rec.bad);
  const templates = child.templates.slice(t0);
  const uses = child.useIds - u0, sids = child.nextSid - s0;
  // the objects of the page it refers to: by their path, made by an earlier unit, the element being compiled, or shared
  const refs = new Map<object, Ref>([[c.opts, { self: 'opts' }], [c.page, { self: 'page' }], [c, { self: 'compiler' }]]);
  if (atBefore) refs.set(atBefore, { at: 'site' });
  if (atBefore?.el) refs.set(atBefore.el, { at: 'el' });
  const atAfter = child.at;
  const todo: unknown[] = [ops.map((o) => ('change' in o ? o.change : o)).map((x) => unwrapDeep(x, unwrap)), templates, calls.map((x) => x.site), atAfter];
  const seenObj = new Set<object>(), pinned: Step[][] = [];
  while (todo.length) {
    const v = unwrap(todo.pop());
    if (!v || typeof v !== 'object' || seenObj.has(v) || shared(v) || refs.has(v)) continue;
    if (old.has(v) || prior.has(v)) {
      if (prior.has(v)) { refs.set(v, { prior: prior.get(v)! }); continue; }
      const path = where.get(v) ?? rec.where.get(v);
      if (!path) return refuse(`refers to an object of the page that has no key (${(v as any).constructor?.name ?? 'object'}: ${(v as any).nodeName ?? Object.keys(v).slice(0, 6).join(', ')})`);
      refs.set(v, { path });
      pinned.push(path);
      continue;
    }
    seenObj.add(v);
    if (typeof v === 'function') return refuse('holds a function');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== Map.prototype && proto !== Set.prototype && proto !== null) return refuse(`holds a ${(v as any).constructor?.name}`);
    if (v instanceof Map) for (const [k, x] of v) todo.push(k, x);
    else if (v instanceof Set) for (const x of v) todo.push(x);
    else if (Array.isArray(v)) for (const x of v) todo.push(x);
    else for (const k of Object.keys(v)) { if (typeof (v as any)[k] === 'function') return refuse(`holds a function (\`${k}\`)`); todo.push((v as any)[k]); }
  }
  // an object found again by its position in a list: the one there must be alike (its own plain values, as they were)
  for (const o of ops) if (o.op === 'old' && 'path' in o.target) pinned.push(o.target.path);
  for (const path of pinned) for (let n = 0; n < path.length; n++) {
    if (!('i' in path[n]!)) continue;
    const at = path.slice(0, n + 1), el = follow(c, at), b = before.get(el);
    if (!b) return refuse(`refers to a list of the page by position (${pathText(at)})`);
    rec.read({ at, flat: flat(b) });
  }
  const unit: Unit = { name, file, ops: ops.map((o) => unwrapOp(o, unwrap)), reads: rec.reads, calls, templates, t0, u0, uses, s0, sids, atAfter, refs };
  return { result, unit, enc: encode(unit) };
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
/**
 * a string to renumber, as text and holes: a template id (`[0, n]`), a state id (`[1, n]`), the page's folder under the
 * root (`[2]`) and its name (`[3]`)
 */
class S { constructor(readonly parts: Parts) {} }
type Parts = Array<string | [0 | 1, number] | [2 | 3]>;
type Fix = [number, 'fn' | 'tid' | 'tids' | 'use' | 'sid'];
/** an object: its kind (an object, a list, a map, a set), its values, the numbers fixed after it is filled (`fix`) and as it is (`at`: 0 a template id, 1 a state id) */
type Entry = { t: 0 | 1 | 2 | 3; proto: object | null; keys?: string[]; vals: unknown[]; fix?: Fix[]; at?: Array<[number, 0 | 1]> };
type PlanOp =
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd' | 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; kind: Change['kind']; key?: unknown; value?: unknown; ifAbsent?: true; nk?: 0 | 1; nv?: 0 | 1 };
type PlanRead = Read & { nk?: 0 };
export type Plan = {
  id: number; name: string; file: string; spans: Span[]; objs: Entry[]; ext: Ref[]; ops: PlanOp[]; reads: PlanRead[]; calls: Array<{ rec: number; code: unknown; site: unknown }>;
  templates: unknown[]; t0: number; u0: number; uses: number; s0: number; sids: number; atAfter: unknown;
};
/** a unit read once into a flat list, its values as they are (`merge` sets what to renumber) */
type Encoded = { objs: Entry[]; ext: Ref[]; ops: PlanOp[]; calls: Plan['calls']; templates: unknown[]; atAfter: unknown; index: Map<object, number> };
let units = 0;

/** which of an object's numbers are function indices, use ids and template ids by what the object is (as `copy` did, decided once) */
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

/** the unit as a flat list, read once (the page that recorded it goes on changing its objects), its strings as they are */
function encode(u: Unit): Encoded {
  const objs: Entry[] = [], index = new Map<object, number>(), ext: Ref[] = [], extIndex = new Map<object, number>();
  const live: object[] = [];
  const enc = (v: any): unknown => {
    if (!v || typeof v !== 'object' || shared(v)) return v;
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
  const templates = u.templates.map((x) => enc(x)), calls = u.calls.map((x) => ({ rec: x.rec, code: x.code as unknown, site: enc(x.site) })), atAfter = enc(u.atAfter);
  // each object once, its values classified (the list grows as they reach further)
  for (let n = 0; n < live.length; n++) {
    const v: any = live[n];
    if (v instanceof Map) { const vals: unknown[] = []; for (const [k, x] of v) vals.push(enc(k), enc(x)); objs[n] = { t: 2, proto: null, vals }; }
    else if (v instanceof Set) objs[n] = { t: 3, proto: null, vals: [...v].map((x) => enc(x)) };
    else if (Array.isArray(v)) objs[n] = { t: 1, proto: null, vals: v.map((x: unknown) => enc(x)) };
    else {
      const keys = Object.keys(v), fix = fixesOf(v, keys);
      objs[n] = { t: 0, proto: Object.getPrototypeOf(v), keys, vals: keys.map((k) => enc(v[k])), ...(fix ? { fix } : {}) };
    }
  }
  return { objs, ext, ops, calls, templates, atAfter, index };
}

/**
 * A unit's plan from its two compiles (`recordChild`): the same objects, values and reads, but where the shadow's differ
 * by its offsets. A string that differs is renumbered at those places (`S`), a number by its kind; anything else that
 * differs (a number by another amount, a string not by an offset or a mark, an object of another kind) refuses it. Text
 * alike in both that names an earlier definition's template or state refuses it too: what it names is renumbered on a
 * page that links it, and text alike is not.
 */
function merge(a: Encoded, b: Encoded, u: Unit, w: Unit, ctx: { parts: { dir: string; stem: string }; spans: Span[]; t0: number; s0: number }): Plan | Refused {
  let why: string | null = null;
  const no = (w: string) => { why ??= w; return undefined; };
  // text alike in both that names a template or a state of an earlier definition on this page: renumbered as that one is
  // (`Span`); one of the page's own before them, or between them, refuses it (nothing says where it is on another page)
  const t1 = ctx.spans[0]?.t ?? ctx.t0, s1 = ctx.spans[0]?.s ?? ctx.s0;
  const EARLIER = /(\$p|\$sl|\$i|\$s|sn-t-|#case|\w\$)(\d+)/g;
  const inSpan = (n: number, st: boolean) => ctx.spans.some((x) => (st ? n >= x.s && n < x.s + x.ns : n >= x.t && n < x.t + x.n));
  const alike = (s: string): Parts | null | undefined => {
    if (!/\d/.test(s)) return undefined;
    let out: Parts | undefined, last = 0;
    for (const m of s.matchAll(EARLIER)) {
      const n = +m[2]!, st = m[1] === '$s';
      if (st ? n >= ctx.s0 : n >= ctx.t0) continue;
      if (st ? n < s1 : n < t1) { no(`names the page's own ${st ? 'state' : 'template'} (${m[0]})`); return null; }
      if (!inSpan(n, st)) { no(`names a ${st ? 'state' : 'template'} between definitions (${m[0]})`); return null; }
      const at = m.index + m[1]!.length;
      (out ??= []).push(s.slice(last, at), [st ? 1 : 0, n]);
      last = at + m[2]!.length;
    }
    if (out) out.push(s.slice(last));
    return out;
  };
  /** a string's text and holes from its two compiles, or null */
  const text = (x: string, y: string): Parts | null => {
    const out: Parts = [];
    let lit = '', i = 0, j = 0;
    const hole = (h: Parts[number]) => { if (lit) out.push(lit); lit = ''; out.push(h); };
    const digit = (s: string, k: number) => k < s.length && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57;
    while (i < x.length || j < y.length) {
      const mark = y.startsWith(MARK_DIR, j) ? MARK_DIR : y.startsWith(MARK_STEM, j) ? MARK_STEM : null;
      if (mark) {
        const t = mark === MARK_DIR ? ctx.parts.dir : ctx.parts.stem;
        j += mark.length;
        if (!x.startsWith(t, i) || !y.startsWith(t, j)) return null;
        hole([mark === MARK_DIR ? 2 : 3]);
        i += t.length; j += t.length;
        continue;
      }
      if (digit(x, i) && digit(y, j)) {
        let i2 = i, j2 = j;
        while (digit(x, i2)) i2++;
        while (digit(y, j2)) j2++;
        const p = x.slice(i, i2), q = y.slice(j, j2), d = +q - +p;
        if (p === q) lit += p;
        else if (d === SHIFT_T) hole([0, +p]);
        else if (d === SHIFT_S) hole([1, +p]);
        else return null;
        i = i2; j = j2;
        continue;
      }
      if (i < x.length && j < y.length && x[i] === y[j]) { lit += x[i]; i++; j++; continue; }
      return null;
    }
    if (lit) out.push(lit);
    return out;
  };
  /**
   * a value from its two compiles: the real one's, a string to renumber, or a number's kind (`num`); a function's index
   * (`any`) may differ by anything (the shadow's code is its own, shared with none of the page's)
   */
  const val = (x: unknown, y: unknown, num?: ((k: 0 | 1) => void) | 'any'): unknown => {
    if (x instanceof R) return y instanceof R && y.i === x.i ? x : no('its objects differ');
    if (x instanceof X) return y instanceof X && y.j === x.j ? x : no('the objects of the page it refers to differ');
    if (typeof x === 'string') {
      if (typeof y !== 'string') return no('a string differs');
      if (x === y) { const p = alike(x); return p ? new S(p) : x; }
      const p = text(x, y);
      return p ? new S(p) : no(`a string differs (${JSON.stringify(x.slice(0, 60))})`);
    }
    if (typeof x === 'number' && typeof y === 'number' && x !== y) {
      if (num === 'any') return x;
      if (num && y - x === SHIFT_T) { num(0); return x; }
      if (num && y - x === SHIFT_S) { num(1); return x; }
      return no(`a number differs (${x})`);
    }
    return Object.is(x, y) ? x : no('a value differs');
  };
  if (a.objs.length !== b.objs.length || a.ops.length !== b.ops.length || a.calls.length !== b.calls.length || a.templates.length !== b.templates.length || u.reads.length === undefined) return { refused: 'its shadow compile differs in shape' };
  if (JSON.stringify(a.ext) !== JSON.stringify(b.ext)) return { refused: 'its shadow compile refers to other objects of the page' };
  const recs = new Set(a.calls.map((x) => x.rec));
  // the lists of template ids an object holds (`tids`): renumbered with it, not by their values
  const tidsLists = new Set<number>();
  for (const e of a.objs) for (const [k, kind] of e.fix ?? []) if (kind === 'tids' && e.vals[k] instanceof R) tidsLists.add((e.vals[k] as R).i);
  const objs: Entry[] = a.objs.map((e, n) => {
    const f = b.objs[n]!;
    if (f.t !== e.t || f.proto !== e.proto || f.vals.length !== e.vals.length || JSON.stringify(f.keys) !== JSON.stringify(e.keys)) return no('its objects differ') ?? e;
    // (a number its kind renumbers, `fixesOf`: by what it is, an offset of the kind's or none; any other, by its offset)
    const fixed = new Map((e.fix ?? []).map(([k, kind]) => [k, kind])), at: Array<[number, 0 | 1]> = [];
    const vals = e.vals.map((x, k) => {
      const kind = fixed.get(k) ?? (tidsLists.has(n) ? 'tid' : undefined);
      if (kind === 'fn') { if (typeof x === 'number' && !recs.has(x)) no('holds a function it did not hand out'); return val(x, f.vals[k], 'any'); }
      // (a template or a state the unit does not own: the page's own before the definitions refuses it, `alike`)
      if (kind === 'tid' && typeof x === 'number' && x < ctx.t0 && !inSpan(x, false)) no(`holds the page's own template ${x}`);
      if (kind) return val(x, f.vals[k], (d) => { if (d !== (kind === 'sid' ? 1 : 0) || kind === 'use') no(`a number differs (${kind} ${String(x)})`); });
      return val(x, f.vals[k], (d) => at.push([k, d]));
    });
    return { ...e, vals, ...(at.length ? { at } : {}) };
  });
  const ops: PlanOp[] = a.ops.map((o, n) => {
    const p = b.ops[n]!;
    if (o.op !== p.op || JSON.stringify((o as any).target ?? (o as any).field) !== JSON.stringify((p as any).target ?? (p as any).field) || (o as any).kind !== (p as any).kind) return no('its writes differ') ?? o;
    if (o.op !== 'old') return { ...o, key: val(o.key, p.key), ...('value' in o ? { value: val((o as any).value, (p as any).value) } : {}) } as PlanOp;
    let nk: 0 | 1 | undefined, nv: 0 | 1 | undefined;
    const out: any = { ...o, ...('key' in o ? { key: val(o.key, (p as any).key, (k) => { nk = k; }) } : {}), ...('value' in o ? { value: val(o.value, (p as any).value, (k) => { nv = k; }) } : {}) };
    if (nk !== undefined) out.nk = nk;
    if (nv !== undefined) out.nv = nv;
    return out;
  });
  const calls = a.calls.map((x, n) => ({ rec: x.rec, code: val(x.code, b.calls[n]!.code), site: val(x.site, b.calls[n]!.site) }));
  const templates = a.templates.map((x, n) => val(x, b.templates[n]));
  const atAfter = val(a.atAfter, b.atAfter);
  // its reads: alike, but for a key named by its own numbering (renumbered as a string is)
  if (u.reads.length !== w.reads.length) return { refused: 'its shadow compile reads other things of the page' };
  const reads: PlanRead[] = u.reads.map((r, n) => {
    const q = w.reads[n]!;
    // (a set of template ids read by one: the id renumbered; the page's own before the definitions refuses it)
    if ('has' in r && 'has' in q && typeof r.key === 'number' && TID_SETS.has((r.at[0] as { p?: string }).p!) && r.at.length === 1) {
      if (r.has !== q.has || (q.key !== r.key && q.key !== r.key + SHIFT_T)) return no(`its shadow compile reads ${pathText(r.at)} otherwise`) ?? r;
      if (r.key < ctx.t0 && !inSpan(r.key, false)) return no(`reads ${pathText(r.at)} by the page's own template ${r.key}`) ?? r;
      return { ...r, nk: 0 as const };
    }
    if (JSON.stringify(r) === JSON.stringify(q)) return r;
    // (a key named by the unit's numbering, looked up or on the way: renumbered as a string)
    const key = (x: unknown, y: unknown) => (x === y ? x : typeof x === 'string' && typeof y === 'string' ? ((p) => (p ? new S(p) : undefined))(text(x, y)) : undefined);
    const { at: ra, key: rk, ...rest } = r as any, { at: qa, key: qk, ...qrest } = q as any;
    if (JSON.stringify(rest) !== JSON.stringify(qrest) || ra.length !== qa.length) return no(`its shadow compile reads ${pathText(r.at)} otherwise`) ?? r;
    const at: Step[] = ra.map((st: any, k: number) => ('k' in st && 'k' in qa[k] ? { k: key(st.k, qa[k].k) } : JSON.stringify(st) === JSON.stringify(qa[k]) ? st : { k: undefined }));
    const kk = 'key' in r ? key(rk, qk) : null;
    if (at.some((st) => 'k' in st && st.k === undefined) || kk === undefined) return no(`its shadow compile reads ${pathText(r.at)} otherwise`) ?? r;
    return { ...r, at, ...('key' in r ? { key: kk } : {}) } as PlanRead;
  });
  if (why) return { refused: why };
  return { id: units++, name: u.name, file: u.file, spans: ctx.spans, objs, ext: a.ext, ops, reads, calls, templates, t0: u.t0, u0: u.u0, uses: u.uses, s0: u.s0, sids: u.sids, atAfter };
}

/** per page: how the units linked into it renumber what they recorded, and the objects each made here */
type PageMaps = { outs: Map<number, unknown[]> };

/** whether the page `c` reads as the recording page did, everywhere the unit looked */
function readsHold(c: any, reads: PlanRead[], key: (k: unknown, nk?: 0) => unknown): boolean {
  for (const read of reads) {
    const r = read.at.some((st) => 'k' in st && st.k instanceof S) ? { ...read, at: read.at.map((st) => ('k' in st ? { k: key(st.k) } : st)) } : read;
    if ('value' in r) { if (shape(follow(c, r.at)) !== r.value) return false; continue; }
    if ('flat' in r) { const o = follow(c, r.at); if (!o || typeof o !== 'object' || flat(o) !== r.flat) return false; continue; }
    const t = follow(c, r.at);
    if ('has' in r) { if (!(t instanceof Map || t instanceof Set) || t.has(key(r.key, r.nk)) !== r.has) return false; }
    else if (Array.isArray(t)) { if (r.keys !== null || t.length !== r.size) return false; }
    else if (!(t instanceof Map || t instanceof Set) || t.size !== r.size || (r.keys !== null && keysOf(t) !== r.keys)) return false;
  }
  return true;
}

/** The unit linked into the page `c`; false when it cannot be (nothing changed then). */
export function replay(c: any, u: Plan, maps: PageMaps, spans: Span[]): boolean {
  const parts = fileParts(c.opts.root, c.opts.file);
  if (!parts || spans.length !== u.spans.length) return false;
  const T0 = c.templates.length, U0 = c.useIds, S0 = c.nextSid;
  // the ids of the definitions before it, where they are on this page; its own after them
  const tid = new Map<number, number>(), sid = new Map<number, number>(), use = new Map<number, number>(), fns = new Map<number, number>();
  for (let k = 0; k < spans.length; k++) {
    const x = u.spans[k]!, y = spans[k]!;
    if (x.n !== y.n || x.ns !== y.ns || x.nu !== y.nu) return false;
    for (let i = 0; i < x.n; i++) tid.set(x.t + i, y.t + i);
    for (let i = 0; i < x.ns; i++) sid.set(x.s + i, y.s + i);
    for (let i = 0; i < x.nu; i++) use.set(x.u + i, y.u + i);
  }
  for (let i = 0; i < u.templates.length; i++) tid.set(u.t0 + i, T0 + i);
  for (let i = 0; i < u.sids; i++) sid.set(u.s0 + i, S0 + i);
  for (let i = 0; i < u.uses; i++) use.set(u.u0 + i, U0 + i);
  const num = (k: 0 | 1, n: number) => (k === 0 ? tid.get(n) : sid.get(n)) ?? n;
  const str = (x: S) => { let o = ''; for (const p of x.parts) o += typeof p === 'string' ? p : p[0] === 0 || p[0] === 1 ? num(p[0], p[1]!) : p[0] === 2 ? parts.dir : parts.stem; return o; };
  const key = (k: unknown, nk?: 0) => (k instanceof S ? str(k) : nk === 0 ? num(0, k as number) : k);
  if (!readsHold(c, u.reads, key)) return false;
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
  // from here on, the page changes
  const fix = { fn: (n: number) => fns.get(n) ?? n, tid: (n: number) => tid.get(n) ?? n, use: (n: number) => use.get(n) ?? n, sid: (n: number) => sid.get(n) ?? n };
  // the objects: made, then filled
  const out: any[] = new Array(u.objs.length);
  for (let i = 0; i < u.objs.length; i++) { const e = u.objs[i]!; out[i] = e.t === 0 ? (e.proto === Object.prototype ? {} : Object.create(e.proto)) : e.t === 1 ? [] : e.t === 2 ? new Map() : new Set(); }
  const dec = (v: unknown): any => (v instanceof R ? out[v.i] : v instanceof X ? ext[v.j] : v instanceof S ? str(v) : v);
  // the function table: each hand-out again, in order, with where it was written
  for (const x of u.calls) {
    const n = c.fns.length, site = dec(x.site), i = c.fn(dec(x.code), site ?? null);
    // (where the recording wrote none)
    if (site === undefined && i === n) c.fnAt[i] = undefined;
    fns.set(x.rec, i);
  }
  for (let i = 0; i < u.objs.length; i++) {
    const e = u.objs[i]!, o = out[i], vals = e.vals;
    const v = e.at ? vals.slice() : vals;
    if (e.at) for (const [k, kind] of e.at) v[k] = num(kind, vals[k] as number);
    if (e.t === 0) {
      const keys = e.keys!;
      for (let k = 0; k < keys.length; k++) o[keys[k]!] = dec(v[k]);
    } else if (e.t === 1) { for (let k = 0; k < v.length; k++) o.push(dec(v[k])); }
    else if (e.t === 2) { for (let k = 0; k < v.length; k += 2) o.set(dec(v[k]), dec(v[k + 1])); }
    else for (let k = 0; k < v.length; k++) o.add(dec(v[k]));
  }
  // the numbers to renumber by what the object is, once every object is filled (a list of template ids may come later)
  for (let i = 0; i < u.objs.length; i++) {
    const e = u.objs[i]!;
    if (!e.fix) continue;
    const o = out[i];
    for (const [k, kind] of e.fix) { const key = e.keys![k]!; o[key] = kind === 'tids' ? o[key].map(fix.tid) : fix[kind](o[key]); }
  }
  maps.outs.set(u.id, out);
  for (const t of u.templates) c.templates.push(dec(t));
  u.ops.forEach((o, n) => {
    const t = targets[n];
    if (o.op === 'weak') { t.set(dec(o.key), dec(o.value)); return; }
    if (o.op === 'weakAdd') { t.add(dec(o.key)); return; }
    if (o.op !== 'old') { t.delete(dec(o.key)); return; }
    // (a table of the page keyed by its numbering: the key renumbered; a set of template ids: the value)
    const field = 'path' in o.target && o.target.path.length === 1 ? (o.target.path[0] as { p?: string }).p ?? '' : '';
    const k = o.key;
    const key = typeof k === 'number' ? (TID_KEYED.has(field) ? fix.tid(k) : USE_KEYED.has(field) ? fix.use(k) : SID_KEYED.has(field) ? fix.sid(k) : o.nk !== undefined ? num(o.nk, k) : k) : dec(k);
    const val = typeof o.value === 'number' ? (TID_SETS.has(field) ? fix.tid(o.value) : o.nv !== undefined ? num(o.nv, o.value) : o.value) : dec(o.value);
    if (o.kind === 'set') { if (!(o.ifAbsent && t.has(key))) t.set(key, val); }
    else if (o.kind === 'add') t.add(val);
    else if (o.kind === 'push') t.push(val);
    else if (o.kind === 'delete') t.delete(key);
    else t[key as string] = val;
  });
  c.useIds += u.uses;
  c.nextSid += u.sids;
  c.at = dec(u.atAfter);
  return true;
}
