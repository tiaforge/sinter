// Units (docs/proposals/redesign-notes/stage4-units.md): the shared definitions a first pass needs, compiled once per
// build and placed on each page that needs them. A first pass followed by a second is thrown away but for its decisions,
// which are keyed by place, not by number: a definition's numbers there never reach the output. So a page's definitions
// are compiled before its walk, where nothing is numbered yet (every counter 0), and on every later page they are put in
// the same place, at the same numbers: the unit's objects (templates, nodes, code, head templates' markup) are shared by
// reference, its weak tables overlaid on the page's, its writes to the page's own tables applied again. What a page then
// changes of a unit's objects is put back after its first pass (`restore`). A page whose first pass is its output (no
// second pass follows) is compiled again without units (`compilePasses`).
//
// A second pass's definitions ship (docs/proposals/redesign-notes/stage5-a1.md): they come from a unit of the second pass
// too, placed before its walk in the same way, so that its templates and functions come before the page's own and are
// numbered alike on every page (the output is the old route's up to numbering: `canon.ts`). What reads only the unit's
// definitions is done once when it is made (the candidates its choices take out, `anchors`, `shareTemplates` within
// it); a page holds the rest of what its passes write into the unit (its templates, nodes and bindings, its head
// templates' elements: `holdUnit`), copies its output off them and gives them back (`restoreUnit`).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readsHold, runUnit, UNIT_NUMBERING, type Op, type Read } from './link.js';
import type { CheckPart } from './check-unit.js';

/** a weak table of the page with a unit's beneath it: the page's entries first, the unit's where the page has none */
export class OverlayMap<K extends object, V> extends WeakMap<K, V> {
  private readonly gone = new WeakSet<K>();
  constructor(private readonly base: WeakMap<K, V>, private readonly unit: WeakMap<K, V>) { super(); }
  override get(k: K): V | undefined { return this.gone.has(k) ? undefined : this.base.has(k) ? this.base.get(k) : this.unit.get(k); }
  override has(k: K): boolean { return !this.gone.has(k) && (this.base.has(k) || this.unit.has(k)); }
  override set(k: K, v: V): this { this.gone.delete(k); this.base.set(k, v); return this; }
  override delete(k: K): boolean { const had = this.has(k); this.base.delete(k); if (this.unit.has(k)) this.gone.add(k); return had; }
}
export class OverlaySet<K extends object> extends WeakSet<K> {
  private readonly gone = new WeakSet<K>();
  constructor(private readonly base: WeakSet<K>, private readonly unit: WeakSet<K>) { super(); }
  override has(k: K): boolean { return !this.gone.has(k) && (this.base.has(k) || this.unit.has(k)); }
  override add(k: K): this { this.gone.delete(k); this.base.add(k); return this; }
  override delete(k: K): boolean { const had = this.has(k); this.base.delete(k); if (this.unit.has(k)) this.gone.add(k); return had; }
}

type Ref = { path: Array<{ p: string } | { k: unknown } | { i: number }> } | { at: 'el' | 'site' } | { self: 'opts' | 'page' | 'compiler' } | { prior: unknown };
/** a value of an operation: the unit's own object (or a plain value) as it is, or one of the page's, found on each page */
type Val = { v: unknown } | { ref: Ref };
type PageOp =
  | { op: 'weak'; field: string; key: Val; value: Val }
  | { op: 'weakAdd' | 'weakDel'; field: string; key: Val }
  | { op: 'old'; path: Array<{ p: string } | { k: unknown } | { i: number }>; kind: string; key?: Val; value?: Val; ifAbsent?: true };

export type BuildUnit = {
  names: string[];
  reads: Read[];
  /** the page's numbering after the unit (it had none before): copied onto each page */
  numbering: Record<string, unknown>;
  /** the unit's own entries of each weak table, beneath the page's */
  weak: Map<string, WeakMap<object, unknown> | WeakSet<object>>;
  /** writes into the page's own tables and objects, made again on each page */
  ops: PageOp[];
  at: Val;
  /** the unit's objects, which a page must not keep changed (`touch`) */
  own: WeakSet<object>;
  placed: number;
  /** the origins that name the page that made it (`file`, its name `base`, its path under the root `rel`): made again on each page */
  origins: Array<{ key: object; value: any }>;
  file: string;
  base: string;
  rel: string | null;
  /**
   * under the type check: the frames and expressions its definitions recorded, numbered from 0, by the top-level name
   * that recorded them (`segs`), and its scopes' frames; a page takes a name's part where its walk first needs that
   * definition, numbered from there (`unitCheck`)
   */
  check?: { frames: any[]; exprs: any[]; segs: Map<string, Seg>; frameOf: Array<{ key: object; at: number }> };
  /** its functions as the first pass's evaluation runs them, compiled once (`unitTable`): by the names they see */
  tables?: Map<string, { bind: (values: unknown[]) => void; fns: Map<string, ($: unknown) => unknown> | null }>;
  /** (`SN_UNITS_VERIFY=1`) each object's own values as it was made, which every page must leave as they were */
  prints?: Map<object, string>;
  /**
   * a second pass's unit (stage5-a1.md): what of it a page's passes write into (`irObjects`), each of which a page that
   * places it holds as it was (`holdUnit`) and gives back after its output is copied (`restoreUnit`): the second pass's
   * `finishPage` writes into what it assembles (function and template numbers, a binding of grouped styles, a row's
   * lookup), and the page's output is what it wrote
   */
  all?: object[];
  /** a second pass's: its head templates, by template id, finished (`anchors`, `shareTemplates`) */
  heads?: Array<[number, unknown]>;
  /** a second pass's: what reads only its definitions is done (`anchors`, `shareTemplates`): a page's passes skip its part */
  finished?: true;
  /** a second pass's: the forms its sharing kept (`shareRun`), against which a page shares what it adds, and its template count */
  share?: { kept: ReadonlyMap<string, number>; owner: ReadonlyMap<number, number>; count: number };
};
/**
 * A name's part of the unit's check data: where it is in the unit's lists, and (when it refers to nothing outside
 * itself) the part, numbered from 0, which each page holds by reference (`unitCheck`)
 */
type Seg = { f0: number; f1: number; e0: number; e1: number; part?: CheckPart };
export type UnitStore = Map<string, BuildUnit | { refused: string }>;

/** counts, for the log and the tests: units made, placed, and the pages that compiled their definitions in place, by reason */
export const UNIT_STATS = { made: 0, placed: 0, made2: 0, placed2: 0, fallback: new Map<string, number>() };
export const unitFallback = (why: string) => fallback(why);
const fallback = (why: string) => { UNIT_STATS.fallback.set(why, (UNIT_STATS.fallback.get(why) ?? 0) + 1); };

const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
/** `SN_UNITS=0` turns units off */
export const unitsOn = () => proc?.env.SN_UNITS !== '0';
/** (the second pass's units' audit compiles a page without them: `SN_UNITS2_AUDIT`, index.ts) */
let units2Forced: boolean | null = null;
export const forceUnits2 = (on: boolean | null): boolean | null => { const was = units2Forced; units2Forced = on; return was; };
/** `SN_UNITS2=0` turns the second pass's units off (stage5-a1.md); `SN_UNITS=0` turns both off */
export const units2On = () => units2Forced ?? (proc?.env.SN_UNITS2 !== '0' && unitsOn());

const follow = (c: any, path: Array<{ p: string } | { k: unknown } | { i: number }>) => path.reduce((o: any, s) => (o == null ? undefined : 'p' in s ? o[s.p] : 'k' in s ? o.get(s.k) : o[s.i]), c);
function resolve(c: any, r: Ref): unknown {
  if ('path' in r) return follow(c, r.path);
  if ('self' in r) return r.self === 'opts' ? c.opts : r.self === 'page' ? c.page : c;
  if ('at' in r) return r.at === 'site' ? c.at : c.at?.el;
  return undefined;
}
const val = (c: any, v: Val | undefined) => (v === undefined ? undefined : 'v' in v ? v.v : resolve(c, v.ref));

/** whether every counter and numbered table of the page is still empty: where a unit's numbers are its own */
function unnumbered(c: any): boolean {
  return c.templates.length === 0 && c.fns.length === 0 && c.nextSid === 0 && c.useIds === 0 && c.nextId === 0 && c.actions.length === 0;
}

/**
 * The page's definitions (`pointNames`), before its walk: placed from the build's units, made there the first time, or
 * (a fallback, counted) left to the walk to compile in place. Returns the unit placed or made, whose objects the page
 * must give back as they were (`restore`).
 */
export function placeUnits(c: any, store: UnitStore, key: string, second = false, live?: Set<string>): BuildUnit | null {
  const names: string[] = [...new Set<string>(c.pointNames)].filter((n) => !live || live.has(n));
  if (!names.length) return null;
  const why = (w: string) => fallback(second ? `pass 2: ${w}` : w);
  if (!unnumbered(c)) { why('numbered before its walk'); return null; }
  const k = `${names.join(',')}\u0002${key}`;
  // (a second pass's unit reads more of its page that differs between pages, as whether the page's own markup used a
  // component before, or a value the build writes into the code: up to `VARIANTS` units by one key, the first whose
  // reads hold placed)
  for (let v = 0; v < (second ? VARIANTS : 1); v++) {
    const kv = second ? `${k}\u0002p2\u0002${v}` : k;
    const known = store.get(kv);
    if (known && 'refused' in known) { why(known.refused); return null; }
    if (known) {
      if (!readsHold(c, known.reads)) {
        // (`SN_UNITS_WHY=1`: the read that differs, for the log)
        if (proc?.env.SN_UNITS_WHY) console.error(`sinter units: ${c.opts.file}${second ? ` (pass 2, ${v})` : ''} reads otherwise: ${JSON.stringify(known.reads.find((r) => !readsHold(c, [r])))?.slice(0, 400)}`);
        continue;
      }
      place(c, known);
      known.placed++;
      if (second) UNIT_STATS.placed2++; else UNIT_STATS.placed++;
      return known;
    }
    c.earlyDefs = true;
    const made = make(c, names, second);
    store.set(kv, made);
    if ('refused' in made) { why(made.refused); return null; }
    ownContainers(c, made);
    if (second) UNIT_STATS.made2++; else UNIT_STATS.made++;
    return made;
  }
  why(second ? `reads its page otherwise (${VARIANTS} units by its key)` : 'reads its page otherwise');
  return null;
}

/** how many second-pass units one key may have (`placeUnits`) */
const VARIANTS = 3;

/**
 * What of a second pass's unit a page's passes may write into: its templates (`TemplateDef`), their nodes and
 * bindings and what those hold (lists, paths, a style's parts), and its head templates' elements (their `id`, where they
 * are placed). Not their markup: a page writes into that only where it paints, which it holds itself (`touchEl`).
 */
function irObjects(templates: unknown[], heads: Array<[number, unknown]>, own: WeakSet<object>): object[] {
  const out = new Set<object>();
  const add = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || out.has(v) || !own.has(v) || 'nodeName' in v) return;
    out.add(v);
    if (depth > 6) return;
    for (const x of Array.isArray(v) ? v : Object.values(v)) add(x, depth + 1);
  };
  for (const t of templates) add(t, 0);
  for (const [, el] of heads) { if (own.has(el as object)) out.add(el as object); const a = (el as { attrs?: unknown }).attrs; if (a && typeof a === 'object' && own.has(a)) out.add(a); }
  return [...out];
}

/**
 * A second pass's unit, placed or made on this page: what of it the page's passes may write into (`irObjects`) held as
 * it is now (`touch`), so that it is given back after the page's output is copied off it (`restoreUnit`, compile.ts
 * `detachOutput`). Its numbers ship (the second pass is the output), the page's own after them: the unit's templates
 * and functions come first, at the same numbers on every page.
 */
export function holdUnit(c: any) {
  const u: BuildUnit | null = c.placedUnit;
  if (!u?.all) return;
  for (const o of u.all) touch(c, o);
}

/** the unit compiled on this page (its writes applied to it, as the linker's recorder does) and kept */
function make(c: any, names: string[], second = false): BuildUnit | { refused: string } {
  const d0 = c.diagnostics.length, g0 = c.choiceGroups.length, r0 = c.remove.length;
  // (a second pass's unit is finished as far as its own markup goes, below: the page must have no head template yet)
  if (second && c.headTemplates.size) return { refused: 'head templates before its walk' };
  // under the type check: its frames and expressions its own, numbered from 0, by the name whose definition recorded them
  // (the compiler's lists `checkFrames` and `checkExprs`, which its check unit holds). A second pass's unit records them
  // in lists of its own too, and keeps none: a second pass's check unit is never read (`compileTwice` returns the first
  // pass's), so its part copied into each page there (`unitCheck`) would be thrown away (stage5-a1.md)
  const check = c.check ? { file: c.check.file, resources: c.check.resources, frames: [] as any[], exprs: [] as any[] } : null;
  const segs = new Map<string, Seg>();
  const run = runUnit(c, names[0]!, (child: any) => {
    for (const n of names) {
      const f0 = check?.frames.length ?? 0, e0 = check?.exprs.length ?? 0;
      child.definition(n);
      if (check) segs.set(n, { f0, f1: check.frames.length, e0, e1: check.exprs.length });
    }
  }, new Map(), check ? { check, checkFrames: check.frames, checkExprs: check.exprs } : {});
  if ('refused' in run) return { refused: run.refused };
  if (c.diagnostics.length !== d0) return { refused: 'reports a diagnostic' };
  // its choices: finished here, once (their candidates are all its own), not by each page after its walk
  const groups = c.choiceGroups.slice(g0);
  c.finishChoices(groups);
  c.choiceGroups.length = g0;
  if (c.diagnostics.length !== d0) return { refused: 'reports a diagnostic' };
  const u = run.unit;
  let share: BuildUnit['share'];
  // a second pass's unit, finished where that reads only its definitions (the plan, stage5-assembly.md, A1): the
  // candidates its choices take out, out; its anchors made and its rows' paths counted (`anchors`); its subtrees written
  // alike kept once (`shareTemplates`). Every page that places it has these as they are; its own `finishPage` passes
  // leave the unit's part alone (`finished`)
  if (second) {
    for (const el of c.remove.slice(r0)) if (el.parentNode) { const kids = el.parentNode.childNodes, i = kids.indexOf(el); if (i >= 0) kids.splice(i, 1); el.parentNode = null; }
    c.anchors();
    const r = c.opts.prerender && !c.opts.dev ? c.shareRun() : { kept: new Map(), owner: new Map() };
    share = { kept: r.kept, owner: r.owner, count: c.templates.length };
    if (c.diagnostics.length !== d0) return { refused: 'reports a diagnostic' };
  }
  const heads: Array<[number, unknown]> | undefined = second ? [...c.headTemplates] : undefined;
  const numbering: Record<string, unknown> = {};
  for (const f of UNIT_NUMBERING) if (f !== 'codeAt') { const v = c[f]; numbering[f] = v instanceof Map ? new Map(v) : Array.isArray(v) ? v.slice() : v; }
  // what the unit made: what its writes and its templates reach that is not the page's
  const refs = u.refs as Map<object, Ref>;
  const own = new WeakSet<object>();
  let why: string | null = null;
  const todo: unknown[] = [u.templates, ...(second ? [numbering.templates, heads] : []), ...u.ops.flatMap((o: any) => (o.op === 'old' ? [o.change.key, o.change.value] : [o.key, o.value])), u.calls.map((x: any) => x.site), u.atAfter];
  const direct = new Set<unknown>(u.ops.flatMap((o: any) => (o.op === 'old' ? [o.change.key, o.change.value] : [o.key, o.value])));
  direct.add(u.atAfter);
  const seen = new Set<object>();
  const walkFrom = (root: unknown, top: boolean) => {
    const stack: Array<[unknown, boolean]> = [[root, top]];
    while (stack.length) {
      const [v, isTop] = stack.pop()!;
      if (!v || typeof v !== 'object') continue;
      if (refs.has(v)) { if (!isTop) why ??= `holds an object of its page (${(v as any).nodeName ?? Object.keys(v).slice(0, 5).join(', ')})`; continue; }
      if (seen.has(v) || Object.isFrozen(v) || ('startOffset' in v && 'endOffset' in v)) continue;
      seen.add(v);
      own.add(v);
      if (v instanceof Map) for (const [a, b] of v) stack.push([a, false], [b, false]);
      else if (v instanceof Set || Array.isArray(v)) for (const x of v) stack.push([x, false]);
      else for (const x of Object.values(v)) stack.push([x, false]);
    }
  };
  for (const v of todo) walkFrom(v, direct.has(v));
  if (why) return { refused: why };
  // the candidates of its choices that the page would take out after its walk: out now, before it is shared
  for (const el of c.remove) if (own.has(el) && el.parentNode) { const kids = el.parentNode.childNodes, i = kids.indexOf(el); if (i >= 0) kids.splice(i, 1); el.parentNode = null; }
  const enc = (v: unknown): Val => (v && typeof v === 'object' && refs.has(v) ? { ref: refs.get(v)! } : { v });
  const weak = new Map<string, WeakMap<object, unknown> | WeakSet<object>>();
  const ops: PageOp[] = [];
  // the page's file, which a unit's origins name (a definition's host: where it is used, the include chains of its
  // markup): those origins are the page's own on each page, with its file; any other text naming it refuses the unit
  const file: string = c.opts.file, base = file.slice(file.lastIndexOf('/') + 1), rel = relOf(c.opts.root, file);
  // (the name where it starts: `m.html` is not named by `mail-em.html`, a component's file in the same build)
  const nameRe = new RegExp(`(?<![\\w.-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const named = (x: unknown) => typeof x === 'string' && x.includes(base) && nameRe.test(x);
  const namesPage = (o: any) => !!o && typeof o === 'object' && (named(o.file) || named(o.usedAt) || (Array.isArray(o.chain) && o.chain.some(named)));
  const origins: Array<{ key: object; value: any }> = [];
  const frameOf: Array<{ key: object; at: number }> = [];
  for (const o of u.ops as Op[]) {
    if (check && o.op === 'old' && 'path' in o.target && o.target.path.length === 1 && (o.target.path[0] as { p?: string }).p === 'frameOf' && (o.change as any).kind === 'set') frameOf.push({ key: (o.change as any).key, at: (o.change as any).value });
    if (o.op === 'weak' && o.field === 'origins' && namesPage(o.value)) { origins.push({ key: o.key as object, value: o.value }); continue; }
    if (o.op !== 'old') {
      // (a unit's own key: its entry beneath the page's; the page's own object: the write made on each page)
      if (o.op !== 'weakDel' && o.key && typeof o.key === 'object' && !refs.has(o.key) && !(o.op === 'weak' && o.value && typeof o.value === 'object' && refs.has(o.value))) {
        let t = weak.get(o.field);
        if (!t) weak.set(o.field, (t = c[o.field] instanceof WeakSet ? new WeakSet() : new WeakMap()));
        if (o.op === 'weak') (t as WeakMap<object, unknown>).set(o.key, o.value); else (t as WeakSet<object>).add(o.key);
        continue;
      }
      ops.push(o.op === 'weak' ? { op: 'weak', field: o.field, key: enc(o.key), value: enc(o.value) } : { op: o.op, field: o.field, key: enc(o.key) });
      continue;
    }
    if (!('path' in o.target)) return { refused: 'writes into an earlier unit' };
    // (a second pass's: its head templates as finished, `heads`)
    if (second && o.target.path.length === 1 && (o.target.path[0] as { p?: string }).p === 'headTemplates') continue;
    const ch: any = o.change;
    ops.push({ op: 'old', path: o.target.path, kind: ch.kind, ...('key' in ch ? { key: enc(ch.key) } : {}), ...('value' in ch ? { value: enc(ch.value) } : {}), ...(ch.ifAbsent ? { ifAbsent: true } : {}) });
  }
  // (`SN_UNITS_FREEZE=1`, a debugging aid: every object the unit made frozen, so that a page changing one throws there)
  // (`SN_UNITS_FREEZE=<property>`: only the objects that have it)
  const fz = proc?.env.SN_UNITS_FREEZE;
  if (fz) for (const v of seen) if (!(v instanceof Map) && !(v instanceof Set) && (fz === '1' || Object.hasOwn(v, fz))) Object.freeze(v);
  const prints = proc?.env.SN_UNITS_VERIFY === '1' ? new Map([...seen].map((v) => [v, print(v)])) : undefined;
  // (what placing writes, shortened: a field of the compiler written many times, its last value; a candidate the page
  // would take out after its walk, out already)
  const lastProp = new Map<string, number>();
  ops.forEach((o, i) => { if (o.op === 'old' && o.path.length === 0 && o.kind === 'prop') lastProp.set(String((o.key as { v: unknown }).v), i); });
  const kept = ops.filter((o, i) => {
    if (o.op !== 'old') return true;
    if (o.path.length === 0 && o.kind === 'prop') return lastProp.get(String((o.key as { v: unknown }).v)) === i;
    if (o.path.length === 1 && (o.path[0] as { p?: string }).p === 'choiceGroups') return false;
    if (o.path.length === 1 && (o.path[0] as { p?: string }).p === 'remove' && o.kind === 'push' && o.value && 'v' in o.value) { const el = o.value.v as { parentNode?: unknown }; return !(own.has(el as object) && !el.parentNode); }
    return true;
  });
  ops.splice(0, ops.length, ...kept);
  const perPage = new Set(origins.map((x) => x.value));
  for (const x of perPage) { own.delete(x); if (Array.isArray(x.chain)) own.delete(x.chain); }
  for (const v of seen) {
    if (perPage.has(v) || [...perPage].some((x) => x.chain === v)) continue;
    const vals = v instanceof Map ? [...v.keys(), ...v.values()] : v instanceof Set || Array.isArray(v) ? [...v] : Object.values(v);
    const hit = vals.find(named);
    if (hit) return { refused: `names its page's file (${JSON.stringify(String(hit).slice(0, 60))})` };
  }
  const all = second ? irObjects(numbering.templates as unknown[], heads!, own) : undefined;
  if (check && !second) for (const seg of segs.values()) partOf(seg, check, file, base);
  return { names, reads: u.reads, numbering, weak, ops, at: enc(u.atAfter), own, placed: 0, origins, file, base, rel, ...(check && !second ? { check: { frames: check.frames, exprs: check.exprs, segs, frameOf } } : {}), ...(prints ? { prints } : {}), ...(all ? { all, heads, share, finished: true } : {}) };
}

let nextPart = 0;
/** a plain copy of check data (its objects, arrays and values) */
const clone = (x: any): any => (Array.isArray(x) ? x.map(clone) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).map((k) => [k, clone(x[k])])) : x);
/**
 * A name's part, numbered from 0: when its frames' initial values and its expressions' frames are all its own (else
 * the page copies it as before, `unitCheck`, and finds the order broken)
 */
function partOf(seg: Seg, check: { frames: any[]; exprs: any[] }, file: string, base: string) {
  const inF = (i: number) => i >= seg.f0 && i < seg.f1, inE = (i: number | null | undefined) => i == null || (i >= seg.e0 && i < seg.e1);
  for (let i = seg.f0; i < seg.f1; i++) if ('init' in check.frames[i] && !inE(check.frames[i].init)) return;
  for (let i = seg.e0; i < seg.e1; i++) if (!check.exprs[i].frames.every(inF)) return;
  const frames = check.frames.slice(seg.f0, seg.f1).map((f) => { const c = clone(f); if ('init' in c && c.init != null) c.init -= seg.e0; return c; });
  const exprs = check.exprs.slice(seg.e0, seg.e1).map((e) => { const c = clone(e); c.frames = c.frames.map((i: number) => i - seg.f0); return c; });
  seg.part = { id: nextPart++, frames, exprs, file, base };
}

/** the unit put on a page that is numbered as it was made (nothing yet), reading its page alike */
function place(c: any, u: BuildUnit) {
  for (const [f, v] of Object.entries(u.numbering)) c[f] = v instanceof Map ? new Map(v) : Array.isArray(v) ? v.slice() : v;
  for (const [f, t] of u.weak) c[f] = t instanceof WeakSet ? new OverlaySet(c[f], t) : new OverlayMap(c[f], t as WeakMap<object, unknown>);
  for (const o of u.ops) {
    if (o.op === 'weak') { c[o.field].set(val(c, o.key), val(c, o.value)); continue; }
    if (o.op === 'weakAdd') { c[o.field].add(val(c, o.key)); continue; }
    if (o.op === 'weakDel') { c[o.field].delete(val(c, o.key)); continue; }
    if (o.op !== 'old') continue;
    const t: any = follow(c, o.path), key = val(c, o.key), v = val(c, o.value);
    if (o.kind === 'set') { if (!(o.ifAbsent && t.has(key))) t.set(key, v); }
    else if (o.kind === 'add') t.add(v);
    else if (o.kind === 'push') t.push(v);
    else if (o.kind === 'delete') t.delete(key);
    else t[key as string] = v;
  }
  c.at = val(c, u.at);
  ownContainers(c, u);
  if (u.heads) for (const [tid, tpl] of u.heads) c.headTemplates.set(tid, tpl);
  // its origins that name its page: this page's
  const file: string = c.opts.file, base = file.slice(file.lastIndexOf('/') + 1), rel = relOf(c.opts.root, file);
  const swap = (x: unknown, key?: string): unknown => {
    if (typeof x !== 'string') return x;
    if (x === u.file) return file;
    if (key === 'usedAt' && u.rel !== null && x.startsWith(u.rel + ':')) return `${rel}${x.slice(u.rel.length)}`;
    if (x.startsWith(u.base + ':')) return `${base}${x.slice(u.base.length)}`;
    return x;
  };
  const made = new Map<object, unknown>();
  for (const { key, value } of u.origins) {
    let o = made.get(value);
    if (!o) {
      o = Object.fromEntries(Object.entries(value).map(([k, x]) => [k, k === 'chain' && Array.isArray(x) ? x.map((y) => swap(y)) : swap(x, k)]));
      made.set(value, o);
    }
    c.origins.set(key, o);
  }
}

/**
 * A list, set or map of the page info that the unit made (a field it created: `page.aliases ??= []`, `objectFields`,
 * `mutated`, `listWrites`, `urlWrites`): the page's own copy of it, which the page goes on to add to; the unit's stays as
 * it was made. (Before this, every page that placed the unit added to the unit's, and the next page saw them.)
 */
function ownContainers(c: any, u: BuildUnit) {
  for (const o of u.ops) {
    if (o.op !== 'old' || o.kind !== 'prop' || o.path.length !== 1 || (o.path[0] as { p?: string }).p !== 'page') continue;
    const k = String(val(c, o.key)), v = c.page[k];
    if (!v || typeof v !== 'object' || !u.own.has(v)) continue;
    c.page[k] = v instanceof Map ? new Map(v) : v instanceof Set ? new Set(v) : Array.isArray(v) ? v.slice() : v;
  }
}

/** a page's file under the root (`blog/post.html`), or null outside it */
function relOf(root: string, file: string): string | null {
  const r = String(root).replace(/\/+$/, '') + '/';
  return file.startsWith(r) ? file.slice(r.length) : null;
}

/** an object's own values, shallow: plain values as they are, objects by identity */
const ids = new WeakMap<object, number>();
let nextPrintId = 0;
function print(v: object): string {
  const one = (x: unknown) => (x && (typeof x === 'object' || typeof x === 'function') ? `#${ids.get(x as object) ?? (ids.set(x as object, ++nextPrintId), nextPrintId)}` : JSON.stringify(x) ?? String(x));
  if (v instanceof Map) return [...v].map(([a, b]) => `${one(a)}=${one(b)}`).join(',');
  if (v instanceof Set || Array.isArray(v)) return [...v].map(one).join(',');
  return Object.keys(v).map((k) => `${k}:${one((v as any)[k])}`).join(',');
}

/**
 * A unit's object that a page is about to change (a merge of the page's own uses into a definition: `finishTreeFills`,
 * `defRootBindings`, `finishChoices`, ...): as it is now, to be put back after the page's first pass (`restoreUnit`).
 */
export function touch(c: any, o: unknown) {
  const u: BuildUnit | null = c.placedUnit;
  if (!u || !o || typeof o !== 'object' || !u.own.has(o) || c.touched.has(o)) return;
  c.touched.set(o, o instanceof Map ? new Map(o) : o instanceof Set ? new Set(o) : Array.isArray(o) ? o.slice() : { ...o });
}

/** the unit's objects the page changed, put back as they were; with `SN_UNITS_VERIFY=1`, every one of them checked */
export function restoreUnit(c: any) {
  const u: BuildUnit | null = c.placedUnit;
  if (!u) return;
  for (const [o, b] of c.touched as Map<any, any>) {
    if (o instanceof Map) { o.clear(); for (const [k, v] of b) o.set(k, v); }
    else if (o instanceof Set) { o.clear(); for (const v of b) o.add(v); }
    else if (Array.isArray(o)) o.splice(0, o.length, ...b);
    else { for (const k of Object.keys(o)) if (!(k in b)) delete o[k]; Object.assign(o, b); }
  }
  c.touched.clear();
  if (u.prints) for (const [o, p] of u.prints) {
    const now = print(o);
    if (now !== p) throw new Error(`sinter units: ${c.opts.file} changed an object of ${u.finished ? 'a second pass\'s unit' : 'a unit'} (${(o as any).constructor?.name ?? 'object'}): ${p.slice(0, 300)}\n  now ${now.slice(0, 300)}`);
  }
}

/**
 * Under the type check: the part of the unit's check data that its definition `name` recorded, put into the page's
 * check where the walk first needs that definition, which is where the page compiled in place records it: its frames
 * and expressions numbered from the page's counts there, its scopes' frames too, and the page that made it named as
 * this one. A page whose walk takes the names in another order than the unit compiled them (the definitions nested in
 * each would be others) is compiled again without units (`unitCheckOrder`).
 */
export function unitCheck(c: any, name: string) {
  const u: BuildUnit | null = c.placedUnit, k = u?.check;
  if (!k || !c.checking || c.checkDone.has(name)) return;
  const seg = k.segs.get(name);
  if (!seg) return;
  c.checkDone.add(name);
  // (a name later in the unit's order than one taken already, whose part comes after it: the order holds)
  const at = u!.names.indexOf(name);
  if (at < c.checkLast) c.checkOrder = false;
  c.checkLast = Math.max(c.checkLast, at);
  const F = c.checkFrames.length, E = c.checkExprs.length;
  const file: string = c.opts.file, base = file.slice(file.lastIndexOf('/') + 1);
  // the part by reference (where the page's lists are the build's: not in a definition the linker records, which copies)
  if (seg.part && c.checkParts && c.defLink.depth === 0) {
    c.checkFrames.length = F + seg.f1 - seg.f0;
    c.checkExprs.length = E + seg.e1 - seg.e0;
    c.checkParts.push({ part: seg.part, frameBase: F, exprBase: E, file, base });
    for (const x of k.frameOf) if (x.at >= seg.f0 && x.at < seg.f1) c.frameOf.set(x.key, F + x.at - seg.f0);
    return;
  }
  const frame = (i: number) => (i >= seg.f0 && i < seg.f1 ? F + i - seg.f0 : (c.checkOrder = false, i));
  const expr = (i: number | null | undefined) => (i == null ? i : i >= seg.e0 && i < seg.e1 ? E + i - seg.e0 : (c.checkOrder = false, i));
  const swap = (x: any): any => {
    if (typeof x === 'string') return x === u!.file ? file : x.startsWith(u!.base + ':') ? `${base}${x.slice(u!.base.length)}` : x;
    if (Array.isArray(x)) return x.map(swap);
    if (x && typeof x === 'object') { const o: any = {}; for (const key of Object.keys(x)) o[key] = swap(x[key]); return o; }
    return x;
  };
  for (let i = seg.f0; i < seg.f1; i++) { const f = swap(k.frames[i]); if ('init' in f) f.init = expr(f.init); c.checkFrames.push(f); }
  for (let i = seg.e0; i < seg.e1; i++) { const e = swap(k.exprs[i]); e.frames = e.frames.map(frame); c.checkExprs.push(e); }
  for (const x of k.frameOf) if (x.at >= seg.f0 && x.at < seg.f1) c.frameOf.set(x.key, F + x.at - seg.f0);
}

/**
 * The evaluation's functions that are the unit's (`prerender`), compiled once per build: one table of all of the unit's
 * function code, over the names the page's evaluation gives them (its helpers, as stubs or folding calls, the
 * formatters), which each page binds to its own before it evaluates (`bind`: they are variables of the table's scope,
 * not constants of it). The map holds the unit's functions the page uses; null when the table does not compile (the
 * page then compiles all it uses, as without units).
 */
export function unitTable(u: BuildUnit, params: Map<string, unknown>, used: string[]): Map<string, ($: unknown) => unknown> | null {
  const names = [...params.keys()], key = names.join(',');
  const tables = (u.tables ??= new Map());
  let t = tables.get(key);
  if (!t) {
    const codes = [...new Set((u.numbering.fns as string[]).filter((c) => c !== '0' && /^\(/.test(c)))];
    let made: [(v: unknown[]) => void, Array<($: unknown) => unknown>] | null = null;
    try {
      // eslint-disable-next-line no-new-func -- build time only: the unit's compiled expressions, the evaluation's names bound per page
      made = new Function(`"use strict"; let ${names.join(', ')}; return [(v) => { [${names.join(', ')}] = v; }, [\n${codes.join(',\n')}\n]];`)() as [(v: unknown[]) => void, Array<($: unknown) => unknown>];
    } catch { made = null; }
    t = { bind: made ? made[0] : () => {}, fns: made ? new Map(codes.map((c, i) => [c, made![1][i]!])) : null };
    tables.set(key, t);
  }
  if (!t.fns) { fallback('a unit whose functions do not compile together'); return null; }
  const out = new Map<string, ($: unknown) => unknown>();
  t.bind([...params.values()]);
  for (const c of used) { const f = t.fns.get(c); if (f) out.set(c, f); }
  return out;
}
