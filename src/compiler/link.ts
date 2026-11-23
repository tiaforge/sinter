// Shared definitions linked into each page (docs/proposals/compile-once.md, (5)). The first time a build needs a top-level
// definition, it compiles in place. The second time, it compiles as a unit (`Compiler.unitChild`, `recordChild`): a
// compiler with its page's numbering, whose view of its page logs what it writes (applied to the page) and what it reads
// (`Read`). The writes, the reads and its hand-outs of functions are kept as a flat plan (`keep`). Nothing in a plan is
// renumbered: it links only into a page numbered as its recording page was before the definition (the cache's key), with
// the same definitions before it, that reads alike everywhere the unit looked and hands out the same functions
// (`replay`). The page's own file is the one thing a plan names that differs: a string that is it, or a place on it.
// A plan that does not hold changes nothing, and the page compiles in place; what a unit cannot be linked for refuses it.
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
  root: string;
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
  axisListsOf: { kinds: ['empty', 'Map'], how: 'cache' },
  boundHrefs: { kinds: ['Set'], how: 'table' },
  branchGuard: { kinds: ['WeakMap'], how: 'weak' },
  callAt: { kinds: ['Map'], how: 'replayed' },
  calls: { kinds: ['Set'], how: 'table' },
  canonicalLink: { kinds: ['empty', 'object'], how: 'fixed' },
  caseFill: { kinds: ['Map'], how: 'table' },
  caseInst: { kinds: ['WeakMap'], how: 'weak' },
  caseScopes: { kinds: ['WeakMap'], how: 'weak' },
  chainCopyOf: { kinds: ['WeakMap'], how: 'weak' },
  // (the unit the type check reads, the page's whatever the definitions: its lists are `checkFrames`, `checkExprs` and `checkResources`)
  check: { kinds: ['empty', 'object'], how: 'fixed' },
  checking: { kinds: ['boolean'], how: 'fixed' },
  checkFrames: { kinds: ['Array'], how: 'table' },
  checkExprs: { kinds: ['Array'], how: 'table' },
  checkResources: { kinds: ['Array'], how: 'table' },
  childrenOf: { kinds: ['WeakMap'], how: 'weak' },
  choiceGroups: { kinds: ['Array'], how: 'table' },
  choiceDiags: { kinds: ['WeakMap'], how: 'weak' },
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
  emptyOf: { kinds: ['WeakMap'], how: 'weak' },
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
  foldedText: { kinds: ['Array'], how: 'table' },
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
  inDef: { kinds: ['number'], how: 'restored' },
  defWalk: { kinds: ['number'], how: 'restored' },
  instAt: { kinds: ['WeakMap'], how: 'weak' },
  itemSchema: { kinds: ['Map'], how: 'table' },
  jsonOut: { kinds: ['Map'], how: 'table' },
  keptBound: { kinds: ['Set'], how: 'table' },
  keptDepth: { kinds: ['number'], how: 'fixed' },
  keptNext: { kinds: ['Map'], how: 'table' },
  kindCycle: { kinds: ['Set'], how: 'cache' },
  kinding: { kinds: ['Set'], how: 'cache' },
  kinds: { kinds: ['WeakMap'], how: 'weak' },
  pageSpecs: { kinds: ['WeakMap'], how: 'weak' },
  keptSlot: { kinds: ['Set'], how: 'table' },
  keptSource: { kinds: ['Map'], how: 'table' },
  keptSpaceN: { kinds: ['Map'], how: 'table' },
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
  listTyped: { kinds: ['Map'], how: 'table' },
  librariesKeyText: { kinds: ['empty', 'string'], how: 'cache' },
  lineStarts: { kinds: ['Map'], how: 'cache' },
  listCompiled: { kinds: ['WeakSet'], how: 'weak' },
  markups: { kinds: ['WeakMap'], how: 'weak' },
  measured: { kinds: ['WeakMap'], how: 'weak' },
  needsMarkup: { kinds: ['boolean'], how: 'fixed' },
  needsToken: { kinds: ['Set'], how: 'table' },
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
  axisDecls: { kinds: ['Array'], how: 'fixed' },
  axesOut: { kinds: ['Array'], how: 'fixed' },
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
  guard: { kinds: ['empty', 'object'], how: 'fixed' },
  rootCopies: { kinds: ['Array'], how: 'table' },
  rootEls: { kinds: ['WeakSet'], how: 'weak' },
  signedIn: { kinds: ['empty', 'object'], how: 'fixed' },
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
  rendered: { kinds: ['Map'], how: 'table' },
  unrendered: { kinds: ['Map'], how: 'table' },
  renderedAt: { kinds: ['WeakMap'], how: 'weak' },
  renderedReads: { kinds: ['Set'], how: 'table' },
  renderedEmpty: { kinds: ['Array'], how: 'table' },
  renderedShown: { kinds: ['Array'], how: 'table' },
  renderedLate: { kinds: ['Array'], how: 'table' },
  snAttrs: { kinds: ['WeakMap'], how: 'weak' },
  keepsAttrs: { kinds: ['boolean'], how: 'fixed' },
  snSource: { kinds: ['WeakMap'], how: 'weak' },
  tplDiags: { kinds: ['Map'], how: 'table' },
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
  twin: { kinds: ['boolean'], how: 'fixed' },
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

/** a unit's numbering (`Compiler.unitChild`): copied from its page, taken back after; renumbered when it is linked */
export const UNIT_NUMBERING = new Set(['fns', 'fnIndex', 'fnUses', 'fnAt', 'callAt', 'templates', 'codeAt', 'useIds', 'nextSid', 'nextId', 'actions']);
const container = (v: unknown) => v instanceof Map || v instanceof Set || Array.isArray(v);
/** shared as it is, never copied: frozen, or a parse5 source location (the parse cache's, which every copy of a node shares) */
const shared = (o: object) => Object.isFrozen(o) || ('startOffset' in o && 'endOffset' in o);


/**
 * Whether a read of a plain value (not an object) at a place sees what the last read there saw (`last`, by the place's
 * key): the read would add nothing, as `Rec.read` keeps the first of a place and a plain value is always data. A unit reads
 * some places of its page thousands of times (`page.locale` for every name an expression resolves): they are let through
 * without their JSON.
 */
function again(last: Map<unknown, unknown>, key: unknown, v: unknown): boolean {
  if (v !== null && (typeof v === 'object' || typeof v === 'function')) return false;
  if (last.has(key) && last.get(key) === v) return true;
  last.set(key, v);
  return false;
}

/** a step from a compiler field to an old object: a property, a map's key, a list's index */
type Step = { p: string } | { k: unknown } | { i: number };

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
  /** (the first read of a place is what the page had there: a later one may see what the unit wrote) */
  read(r: Read) {
    const k = 'has' in r ? JSON.stringify([r.at, r.key]) : JSON.stringify([Object.keys(r)[1], r.at]);
    if (!this.seen.has(k)) { this.seen.add(k); this.reads.push(r); }
  }
  refuse(why: string) { this.bad ??= why; }
  write(path: Step[], change: Change) { this.ops.push({ op: 'old', target: { path }, change }); }
  /** the page's objects the unit was handed, and what they reach; a copy of each plain one as it was; a path to each */
  readonly old = new Set<object>();
  readonly before = new Map<object, any>();
  readonly paths = new Map<object, Step[]>();
  /** what is not the page's to hand out: shared as it is, or the options */
  stop: (o: object) => boolean = shared;
  /**
   * An object of the page the unit is handed (by a table, the page info, a field), with its path when it has one: it and
   * what it reaches are the page's (`old`), each plain one copied as it is now, before the unit can change it (what it
   * changes is diffed against the copy, `runUnit`). What is under an element is the page's, and not walked.
   */
  hand(v: unknown, path: Step[] | null) {
    if (!v || typeof v !== 'object' || this.old.has(v)) return;
    const todo: Array<[unknown, Step[] | null]> = [[v, path]];
    for (let n = 0; n < todo.length; n++) {
      const [o, p] = todo[n]!;
      if (!o || typeof o !== 'object' || this.old.has(o) || this.stop(o)) continue;
      this.old.add(o);
      if (p && !this.paths.has(o)) this.paths.set(o, p);
      if ('nodeName' in o || o instanceof WeakMap || o instanceof WeakSet) continue;
      if (o instanceof Map) { for (const [k, x] of o) { todo.push([k, null], [x, p && (k === null || typeof k !== 'object') ? [...p, { k }] : null]); } }
      else if (o instanceof Set) { for (const x of o) todo.push([x, null]); }
      else if (Array.isArray(o)) o.forEach((x, i) => todo.push([x, p && [...p, { i }]]));
      else { this.before.set(o, shallow(o)); for (const k of Object.keys(o)) todo.push([(o as any)[k], p && [...p, { p: k }]]); }
    }
  }
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
  /** a cache's entries, by the `bad` each last read showed (`again`) */
  private readonly bads = new Map<unknown, unknown>();
  constructor(private readonly base: Map<unknown, unknown>, private readonly path: Step[], private readonly rec: Rec, private readonly cache: boolean) {
    super();
    for (const [k, v] of base) Map.prototype.set.call(this, k, v);
  }
  private look(k: unknown) {
    if (this.mine.has(k)) return;
    if (!this.cache) { look(this.rec, this.base, this.path, k); return; }
    // a cache's entry is the same on every page, but for what a page learns of it as it compiles (a file found `bad`)
    const v = this.base.get(k);
    if (v && typeof v === 'object' && !again(this.bads, v, (v as { bad?: unknown }).bad)) this.rec.read({ at: [...this.path, { k }, { p: 'bad' }], value: shape((v as { bad?: unknown }).bad) ?? 'undefined' });
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
    const prim = k === null || typeof k !== 'object';
    this.rec.hand(v, prim ? [...this.path, { k }] : null);
    if (!this.cache && prim) readValue(this.rec, [...this.path, { k }], v);
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
  override *entries(): MapIterator<[unknown, unknown]> { this.whole(); for (const [k, v] of super.entries()) { if (!this.mine.has(k)) this.rec.hand(k, null); yield [k, this.value(k, v)]; } }
  override *values(): MapIterator<unknown> { for (const [, v] of this.entries()) yield v; }
  override *keys(): MapIterator<unknown> { this.whole(); for (const k of super.keys()) { if (!this.mine.has(k)) this.rec.hand(k, null); yield k; } }
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
  override forEach(f: (v: unknown, k: unknown, s: Set<unknown>) => void, self?: unknown) { for (const v of this) f.call(self, v, v, this); }
  override *values(): SetIterator<unknown> { this.whole(); for (const x of super.values()) { if (!this.mine.has(x)) this.rec.hand(x, null); yield x; } }
  override keys(): SetIterator<unknown> { return this.values(); }
  override *entries(): SetIterator<[unknown, unknown]> { for (const x of this.values()) yield [x, x]; }
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
      // (what was added since a length it read: the length; `diagnostics.slice(d0)`)
      if (k === 'slice') return (a?: number, b?: number) => { if (b === undefined && a !== undefined && a >= n) rec.read({ at: path, size: n, keys: null }); else readValue(rec, path, base); return t.slice(a, b); };
      if (k === 'length') rec.read({ at: path, size: n, keys: null });
      else if (typeof k === 'string' && /^\d+$/.test(k)) { if (+k < n) { rec.hand(base[+k], [...path, { i: +k }]); readValue(rec, [...path, { i: +k }], base[+k]); } }
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
  get(k: object) {
    if (this.gone.has(k)) return undefined;
    if (this.own instanceof Map && this.own.has(k)) return this.own.get(k);
    const v = (this.base as WeakMap<object, unknown>).get(k);
    this.rec.hand(v, null);
    return this.view(v);
  }
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
const BUILD_OPTIONS = new Set(['root', 'dev', 'sourcemap', 'helpers', 'actions', 'config', 'readFile', 'listFiles', 'globCache', 'templates', 'definitions', 'componentCache', 'collections',
  'collectionsError', 'prefetch', 'openapi', 'apis', 'complexity', 'expansionLimit', 'componentNames', 'libraries', 'lazy', 'lazyScript', 'lazyModule',
  'helperValues', 'helperFold', 'foldLog', 'prerender', 'changesRequests', 'observe', 'embed', 'componentCss', 'base', 'file', 'decided', 'unrolled', 'constants', 'frozen', 'overLimit', 'rendered']);

/**
 * A top-level definition compiled as a unit (`unitChild`) and recorded as it compiles. Its writes are applied to the page,
 * which goes on as if it compiled in place, and kept as a plan with its reads and its hand-outs of functions. Nothing in
 * a plan is renumbered: a page links it only where it is numbered as the recording page was before the definition (the
 * cache's key says so, `Compiler.definition`), reads alike everywhere the unit looked, and hands out the same functions
 * (`replay`). A plan that names the recording page's file is not kept (another page would be named so).
 */
export function recordChild<T>(c: any, name: string, compile: (child: any) => T, prior: Map<object, { u: number; i: number }>): { result: T; unit: Plan | Refused } {
  for (const k of Object.keys(c)) if (!(k in LINK_FIELDS)) return { result: compile(c), unit: { refused: `\`${k}\` is not in LINK_FIELDS` } };
  const run = runUnit(c, name, compile, prior);
  // (for the tests: how many of the page's objects recording copied, which grows with what the unit touches, not the page)
  const stats = (globalThis as { __snLink?: { copied?: number } }).__snLink;
  if (stats && 'unit' in run) stats.copied = (stats.copied ?? 0) + run.copied;
  if ('refused' in run) return { result: run.result as T, unit: { refused: run.refused } };
  const plan = keep(run.unit);
  if ('refused' in plan.plan) return { result: run.result as T, unit: plan.plan };
  for (const [o, i] of plan.index) prior.set(o, { u: plan.plan.id, i });
  return { result: run.result as T, unit: plan.plan };
}

type Run = { result: unknown; unit: Unit; copied: number } | { result: unknown; refused: string };

/** the unit compiled, its view of its page logging what it reads and writes; its writes applied to the page */
function runUnit(c: any, name: string, compile: (child: any) => unknown, prior: Map<object, { u: number; i: number }>): Run {
  const rec = new Rec();
  const u = c.unitChild(), child = u.child;
  const T0 = c.templates.length, f0 = c.fns.length, u0 = c.useIds, s0 = c.nextSid, n0 = c.nextId, a0 = c.actions.length, atBefore = c.at;
  const defKeys = new Set(c.defs.keys());
  // the page's objects are those the unit is handed (`Rec.hand`), and the elements of the page it is compiled in
  rec.stop = (o) => shared(o) || o === c.opts || o === c || o === c.page;
  rec.hand(atBefore, null);
  let top = atBefore?.el;
  while (top?.parentNode) top = top.parentNode;
  const old = rec.old, before = rec.before;
  const pageNode = (v: any) => { if (!('nodeName' in v)) return false; let r = v; while (r.parentNode) r = r.parentNode; return r === top; };
  // the unit's view of its page: its own tables, the page info and the component files log; so do its own fields
  for (const k of u.own) child[k] = LINK_FIELDS[k]!.how === 'weak' ? new LoggedWeak(c[k], k, rec) : wrap(c[k], [{ p: k }], rec);
  child.componentFiles = wrap(c.componentFiles, [{ p: 'componentFiles' }], rec, true);
  const info: Record<string, unknown> = {};
  for (const k of Object.keys(c.page)) info[k] = container(c.page[k]) ? wrap(c.page[k], [{ p: 'page' }, { p: k }], rec) : c.page[k];
  // (an object of the page info, as the locale: read property by property, so what the unit does not use does not count)
  const views = new WeakMap<object, unknown>();
  const viewOf = (o: any, path: Step[]): unknown => {
    if (!o || typeof o !== 'object' || container(o) || 'nodeName' in o || Object.getPrototypeOf(o) !== Object.prototype) { readValue(rec, path, o); return o; }
    let w = views.get(o);
    if (!w) {
      rec.hand(o, path);
      views.set(o, (w = new Proxy(o, { get(t, k) { return typeof k === 'string' ? viewOf(t[k], [...path, { p: k }]) : t[k]; }, ownKeys(t) { readValue(rec, path, Object.keys(t)); return Reflect.ownKeys(t); } })));
      rec.page.set(w as object, o);
    }
    return w;
  };
  const pageLast = new Map<unknown, unknown>(), fieldLast = new Map<unknown, unknown>();
  child.page = new Proxy(info, {
    get(t, k) { if (typeof k === 'string' && !container(t[k]) && !rec.page.has(t[k] as object)) return again(pageLast, k, t[k]) ? t[k] : viewOf(t[k], [{ p: 'page' }, { p: k }]); return t[k as string]; },
    set(t, k, v) { rec.write([{ p: 'page' }], { kind: 'prop', key: k as string, value: v }); t[k as string] = v; return true; },
  });
  rec.page.set(child.page, c.page);
  const optRead = new Set<string>();
  child.opts = new Proxy(c.opts, { get(t, k) { if (typeof k === 'string') optRead.add(k); return t[k]; } });
  rec.page.set(child.opts, c.opts);
  // where its functions were written, which only a source map shows: with one, the page's, read through (what it looks
  // up is a precondition), its own logged; without, its own (a page that had the code keeps its own, `ifAbsent`)
  const sites = !!c.opts.sourcemap;
  child.codeAt = sites ? wrap(c.codeAt, [{ p: 'codeAt' }], rec) : new Map();
  for (const [k, f] of Object.entries(LINK_FIELDS)) {
    if (!(k in child) || (f.how !== 'fixed' && f.how !== 'restored') || k === 'page' || k === 'opts' || k === 'componentFiles') continue;
    let v = child[k], mine = false;
    Object.defineProperty(child, k, {
      configurable: true, enumerable: true,
      // (what it reads after writing it is its own)
      get() { if (!mine && !again(fieldLast, k, v)) { rec.hand(v, [{ p: k }]); readValue(rec, [{ p: k }], v); } return v; },
      set(x) { rec.write([], { kind: 'prop', key: k, value: x }); v = x; mine = true; },
    });
  }
  // (a place the page wrote a function at, read from the unit's copy of `fnAt`: the page's, by its code)
  const fnAtOwn: unknown[] = child.fnAt, pageFnAt: unknown[] = c.fnAt, pageFns: string[] = c.fns, pageCodeAt: Map<string, unknown> = c.codeAt;
  child.fnAt = new Proxy(fnAtOwn, { get(t, k, r) {
    const v = Reflect.get(t, k, r);
    if (typeof k === 'string' && /^\d+$/.test(k) && +k < f0 && v && v === pageFnAt[+k]) rec.hand(v, pageCodeAt.get(pageFns[+k]!) === v ? [{ p: 'codeAt' }, { k: pageFns[+k] }] : null);
    return v;
  } });
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
  if (!sites) for (const [x, y] of child.codeAt) ops.push({ op: 'old', target: { path: [{ p: 'codeAt' }] }, change: { kind: 'set', key: x, value: y, ifAbsent: true } as Change });
  for (const [x, y] of child.defs) if (!defKeys.has(x)) ops.push({ op: 'old', target: { path: [{ p: 'defs' }] }, change: { kind: 'set', key: x, value: y } });
  // what it changed of the page's plain objects (a use's list, a resource's `used`), against their path from the page's
  // fields: before its writes are applied (what it changed itself, not what they change)
  const where = rec.paths;
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
  // the page as compiled in place: the unit's writes applied to its objects, its numbering taken over
  const unwrap = (v: unknown) => (v && typeof v === 'object' ? rec.page.get(v) ?? v : v);
  applyOps(c, ops, unwrap);
  for (const k of UNIT_NUMBERING) if (k in c && k !== 'codeAt') c[k] = child[k];
  c.fnAt = fnAtOwn;
  c.at = child.at;
  // a check the unit left for the end of the page (a closure over its compiler): it reports to the page
  for (const k of Object.keys(c)) Object.defineProperty(child, k, { value: c[k], writable: true, configurable: true, enumerable: true });
  const refuse = (why: string): Run => ({ result, refused: why });
  if (rec.bad) return refuse(rec.bad);
  if (c.nextId !== n0) return refuse('`nextId` changed (node ids are not linked)');
  if (c.actions.length !== a0) return refuse('adds an action (`actions` is not linked)');
  for (const o of ops) {
    const f = o.op === 'old' && 'path' in o.target ? (o.target.path[0] as { p?: string })?.p : undefined;
    // (numberings of their own, kept out of the key: a fill's id, a lazy import's local name)
    if (f === 'fillDefs' || f === 'lazyLoads') return refuse(`writes \`${f}\``);
  }
  // the options it read that are the page's: alike on a page that links it
  for (const k of optRead) if (!BUILD_OPTIONS.has(k)) readValue(rec, [{ p: 'opts' }, { p: k }], c.opts[k]);
  if (rec.bad) return refuse(rec.bad);
  const templates = c.templates.slice(T0);
  const uses = c.useIds - u0, sids = c.nextSid - s0;
  // the objects of the page it refers to: by their path, made by an earlier unit, the element being compiled, or shared
  const refs = new Map<object, Ref>([[c.opts, { self: 'opts' }], [c.page, { self: 'page' }], [c, { self: 'compiler' }]]);
  if (atBefore) refs.set(atBefore, { at: 'site' });
  if (atBefore?.el) refs.set(atBefore.el, { at: 'el' });
  const atAfter = c.at;
  const todo: unknown[] = [ops.map((o) => ('change' in o ? o.change : o)).map((x) => unwrapDeep(x, unwrap)), templates, calls.map((x) => x.site), atAfter];
  const seenObj = new Set<object>(), pinned: Step[][] = [];
  while (todo.length) {
    const v = unwrap(todo.pop());
    if (!v || typeof v !== 'object' || seenObj.has(v) || shared(v) || refs.has(v)) continue;
    if (old.has(v) || rec.where.has(v) || prior.has(v) || pageNode(v)) {
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
    // (a wrapper the unit kept in an object of its own: the page's object it stands for, there and in the plan)
    const real = (x: unknown) => (x && typeof x === 'object' && rec.page.has(x) ? rec.page.get(x) : x);
    if (v instanceof Map) {
      if ([...v].some(([k, x]) => real(k) !== k || real(x) !== x)) { const es = [...v]; v.clear(); for (const [k, x] of es) v.set(real(k), real(x)); }
      for (const [k, x] of v) todo.push(k, x);
    } else if (v instanceof Set) {
      if ([...v].some((x) => real(x) !== x)) { const es = [...v]; v.clear(); for (const x of es) v.add(real(x)); }
      for (const x of v) todo.push(x);
    } else if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (real(v[i]) !== v[i]) v[i] = real(v[i]); todo.push(v[i]); } }
    else for (const k of Object.keys(v)) { const x = (v as any)[k]; if (typeof x === 'function') return refuse(`holds a function (\`${k}\`)`); if (real(x) !== x) (v as any)[k] = real(x); todo.push((v as any)[k]); }
  }
  // an object found again by its position in a list: the one there must be alike (its own plain values, as they were)
  for (const o of ops) if (o.op === 'old' && 'path' in o.target) pinned.push(o.target.path);
  for (const path of pinned) for (let n = 0; n < path.length; n++) {
    if (!('i' in path[n]!)) continue;
    const at = path.slice(0, n + 1), el = follow(c, at), b = before.get(el);
    if (!b) return refuse(`refers to a list of the page by position (${pathText(at)})`);
    rec.read({ at, flat: flat(b) });
  }
  const unit: Unit = { name, file: c.opts.file, root: c.opts.root, ops: ops.map((o) => unwrapOp(o, unwrap)), reads: rec.reads, calls, templates, t0: T0, u0, uses, s0, sids, atAfter, refs };
  return { result, unit, copied: before.size };
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
// the plan `R`, an object of the page `X`), copied as they are into a page that links it.
class R { constructor(readonly i: number) {} }
class X { constructor(readonly j: number) {} }
/**
 * the page's file, a whole string, and a place on it by its name (`<name>:<line>`, where a component's markup was
 * included from): the page it is linked into has its own. Text that otherwise holds its name refuses the plan.
 */
const FILE = Object.freeze({ file: true });
/** `<name>:<line>`, or `<path under the root>:<line>` (`rel`: where the app uses a library's component) */
class Line { constructor(readonly line: string, readonly rel: boolean) {} }
/** an object: its kind (an object, a list, a map, a set) and its values */
type Entry = { t: 0 | 1 | 2 | 3; proto: object | null; keys?: string[]; vals: unknown[] };
type PlanOp =
  | { op: 'weak'; field: string; key: unknown; value: unknown }
  | { op: 'weakAdd' | 'weakDel'; field: string; key: unknown }
  | { op: 'old'; target: { path: Step[] } | { prior: { u: number; i: number } }; kind: Change['kind']; key?: unknown; value?: unknown; ifAbsent?: true };
export type Plan = {
  id: number; name: string; file: string; rel: boolean; objs: Entry[]; ext: Ref[]; ops: PlanOp[]; reads: Read[]; calls: Array<{ rec: number; code: string; site: unknown }>;
  templates: unknown[]; atAfter: unknown; uses: number; sids: number;
};
let units = 0;

/**
 * the unit as a plan: what it created read once into a flat list (the page that recorded it goes on changing its
 * objects); refused where a string names the recording page's file, which a page linking it would not be
 */
function keep(u: Unit): { plan: Plan | Refused; index: Map<object, number> } {
  const objs: Entry[] = [], index = new Map<object, number>(), ext: Ref[] = [], extIndex = new Map<object, number>();
  const live: object[] = [];
  const base = u.file.slice(u.file.lastIndexOf('/') + 1), rel = relOf(u.root, u.file);
  let why: string | null = null;
  const uses = { rel: false };
  // (`key`: the property it is held at; an origin's `usedAt` names the page by its path under the root, any other place
  // by its name, which are one string on a page at the root)
  const enc = (v: any, key?: string): unknown => {
    if (typeof v === 'string') {
      if (v === u.file) return FILE;
      if (key === 'usedAt') { if (rel && v.startsWith(rel + ':') && /^\d+$/.test(v.slice(rel.length + 1))) { uses.rel = true; return new Line(v.slice(rel.length + 1), true); } }
      else if (v.startsWith(base + ':') && /^\d+$/.test(v.slice(base.length + 1))) return new Line(v.slice(base.length + 1), false);
      if (v.includes(base)) why ??= `names its page's file (${JSON.stringify(v.slice(0, 60))})`;
      return v;
    }
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
  const templates = u.templates.map((x) => enc(x)), calls = u.calls.map((x) => { enc(x.code); return { rec: x.rec, code: x.code, site: enc(x.site) }; }), atAfter = enc(u.atAfter);
  // each object once, its values classified (the list grows as they reach further)
  for (let n = 0; n < live.length; n++) {
    const v: any = live[n];
    if (v instanceof Map) { const vals: unknown[] = []; for (const [k, x] of v) vals.push(enc(k), enc(x)); objs[n] = { t: 2, proto: null, vals }; }
    else if (v instanceof Set) objs[n] = { t: 3, proto: null, vals: [...v].map((x) => enc(x)) };
    else if (Array.isArray(v)) objs[n] = { t: 1, proto: null, vals: v.map((x: unknown) => enc(x)) };
    else { const keys = Object.keys(v); objs[n] = { t: 0, proto: Object.getPrototypeOf(v), keys, vals: keys.map((k) => enc(v[k], k)) }; }
  }
  if (why) return { plan: { refused: why }, index };
  return { plan: { id: units++, name: u.name, file: u.file, rel: uses.rel, objs, ext, ops, reads: u.reads, calls, templates, atAfter, uses: u.uses, sids: u.sids }, index };
}

/** per page: the objects each unit linked into it made here */
type PageMaps = { outs: Map<number, unknown[]> };

/** whether the page `c` reads as the recording page did, everywhere the unit looked */
function readsHold(c: any, reads: Read[]): boolean {
  for (const r of reads) {
    if ('value' in r) { if (shape(follow(c, r.at)) !== r.value) return false; continue; }
    if ('flat' in r) { const o = follow(c, r.at); if (!o || typeof o !== 'object' || flat(o) !== r.flat) return false; continue; }
    const t = follow(c, r.at);
    if ('has' in r) { if (!(t instanceof Map || t instanceof Set) || t.has(r.key) !== r.has) return false; }
    else if (Array.isArray(t)) { if (r.keys !== null || t.length !== r.size) return false; }
    else if (!(t instanceof Map || t instanceof Set) || t.size !== r.size || (r.keys !== null && keysOf(t) !== r.keys)) return false;
  }
  return true;
}

/**
 * The unit linked into the page `c`, numbered as its recording page was before it (the cache's key); false when it
 * cannot be (nothing changed then): a read that differs, an object it refers to or writes into that is not there, or a
 * function it hands out that the page's table would number otherwise.
 */
/** a page's file under the root (`blog/post.html`), or null outside it */
function relOf(root: string, file: string): string | null {
  const r = String(root).replace(/\/+$/, '') + '/';
  return file.startsWith(r) ? file.slice(r.length) : null;
}

export function replay(c: any, u: Plan, maps: PageMaps): boolean {
  if (!readsHold(c, u.reads)) return false;
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
  // each function it hands out at the index it had where recorded (the page's table shares code it has already)
  const added = new Map<string, number>();
  let next = c.fns.length;
  for (const x of u.calls) {
    let i = c.fnIndex.get(x.code) ?? added.get(x.code);
    if (i === undefined) added.set(x.code, (i = next++));
    if (i !== x.rec) return false;
  }
  // from here on, the page changes
  const out: any[] = new Array(u.objs.length);
  for (let i = 0; i < u.objs.length; i++) { const e = u.objs[i]!; out[i] = e.t === 0 ? (e.proto === Object.prototype ? {} : Object.create(e.proto)) : e.t === 1 ? [] : e.t === 2 ? new Map() : new Set(); }
  const file: string = c.opts.file, base = file.slice(file.lastIndexOf('/') + 1), rel = relOf(c.opts.root, file);
  if (u.rel && rel === null) return false;
  const dec = (v: unknown): any => (v instanceof R ? out[v.i] : v instanceof X ? ext[v.j] : v === FILE ? file : v instanceof Line ? `${v.rel ? rel : base}:${v.line}` : v);
  // the function table: each hand-out again, in order, with where it was written
  for (const x of u.calls) {
    const n = c.fns.length, site = dec(x.site), i = c.fn(x.code, site ?? null);
    // (where the recording wrote none)
    if (site === undefined && i === n) c.fnAt[i] = undefined;
  }
  for (let i = 0; i < u.objs.length; i++) {
    const e = u.objs[i]!, o = out[i], v = e.vals;
    if (e.t === 0) { const keys = e.keys!; for (let k = 0; k < keys.length; k++) o[keys[k]!] = dec(v[k]); }
    else if (e.t === 1) { for (let k = 0; k < v.length; k++) o.push(dec(v[k])); }
    else if (e.t === 2) { for (let k = 0; k < v.length; k += 2) o.set(dec(v[k]), dec(v[k + 1])); }
    else for (let k = 0; k < v.length; k++) o.add(dec(v[k]));
  }
  maps.outs.set(u.id, out);
  for (const t of u.templates) c.templates.push(dec(t));
  u.ops.forEach((o, n) => {
    const t = targets[n];
    if (o.op === 'weak') { t.set(dec(o.key), dec(o.value)); return; }
    if (o.op === 'weakAdd') { t.add(dec(o.key)); return; }
    if (o.op !== 'old') { t.delete(dec(o.key)); return; }
    const key = dec(o.key), val = dec(o.value);
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
