// What `compile(…, { check: true })` hands the type checker: every expression of
// the page with its source position and the scope frames it sees. Plain data.

/** Where an expression (or a `type` attribute value) starts in its source file. */
export interface CheckLoc {
  file: string;
  line: number;
  col: number;
  /** include chain, innermost first (`page.html:12`), for messages */
  chain: string[];
}

/**
 * A scope frame: a `data-sn-state` object, a `data-sn-for` loop or a `data-sn-let` name. `init` is the
 * expression that creates it (the state literal, the list), or null when that
 * expression did not compile.
 */
export type CheckFrame =
  /**
   * `locs[i]`: where `names[i]` is written in the literal; `nested`: the object literals in the fields' initial
   * values, as the mask of the check's `State<T, M>` (a type literal: `{ "form": { "items": [{}] } }`)
   */
  | { kind: 'state'; names: string[]; init: number | null; locs?: CheckLoc[]; nested?: string }
  /** `loc`, `indexLoc`: where the item and index names are written */
  | { kind: 'loop'; item: string; index: string | null; init: number | null; loc?: CheckLoc; indexLoc?: CheckLoc }
  /** a `data-sn-let` name; `loc`: where the name is written; `waits`: it calls a helper of a lazy module, so it is `T | undefined` */
  | { kind: 'let'; name: string; init: number | null; loc?: CheckLoc; waits?: true }
  /** a form's `$error`: its last failed send, or null */
  | { kind: 'formError' }
  /** a component's props, typed by its `data-sn-props`; `alias`: written as a type the compiler cannot list, which may not hold a `Slot<T>` */
  | { kind: 'props'; component: string; type: TypeRef; names: string[]; alias?: boolean }
  /** `$slot` in a fill: the `T` of the slot's `Slot<T>`, and which slot of which component it is */
  | { kind: 'slot'; type: TypeRef; name: string; component: string }
  /** a branch: what follows is checked where `cond` holds (a `data-sn-if`, the negation of the ones before for `data-sn-else`), so it narrows; errors in it are its own expression's */
  | { kind: 'guard'; cond: string };

/** A type the checker writes for something other than a resource. */
export type TypeRef =
  /** written by the app (`type` on `<sn-event>`); errors in it point at `loc` */
  | { kind: 'ts'; text: string; loc: CheckLoc }
  /** a schema of OpenAPI spec number `spec` */
  | { kind: 'openapi'; spec: number; schema: unknown }
  /** what a resource on the page holds (`$result` in its `then`) */
  | { kind: 'resource'; resource: string }
  /** an item of a resource on the page, or a partial one */
  | { kind: 'item'; resource: string; partial?: boolean }
  /** an action (`archive`, `pgp.decrypt`): its arguments (`args`) or its awaited result */
  | { kind: 'call'; name: string; args?: boolean }
  /** one of these strings: the resource names a `data-sn-let` can be */
  | { kind: 'names'; names: string[] }
  /** a type sinter declares itself (\`Attrs\` for \`data-sn-attr\`) */
  | { kind: 'decl'; name: string };

export interface CheckExpr {
  src: string;
  /** `value` returns the expression; `handler` runs it as statements */
  mode: 'value' | 'handler';
  loc: CheckLoc;
  /** frames visible here, in the order sinter resolves them last: states, then loops, then lets, each outer to inner */
  frames: number[];
  /** tag of the element the expression sits on, for `$el` */
  tag: string;
  /** DOM event that runs a handler, for `$event` */
  event: string | null;
  /** a trigger-time expression of an action `run('id')` starts (not a form): `$event` is null then */
  run?: boolean;
  /** `$result` (then) or `$error` (catch) is in scope */
  result: boolean;
  error: boolean;
  /** type of `$result`: the action's OpenAPI response or result, the resource's own type (`<sn-resource then>`) */
  resultType?: TypeRef;
  /** the value must be assignable to this (`data-sn-body`, `<sn-event>` `item` and `set`) */
  returns?: TypeRef;
  /** payload expressions (`<sn-event>`, `cursor`): the payload fields read, and the payload's type (null: any) */
  payload?: { as: '$event' | '$item'; type: TypeRef | null };
  /** checked only where this holds (`<sn-component>`: the data names this candidate), so the data is narrowed */
  guard?: string;
  /** the candidate the guard is for, and where its key is written: a guard that can never hold is SN538 there */
  guardAt?: { name: string; key: string; loc: CheckLoc };
  /** a component event's detail type (`data-sn-emits`), for `$event` of a handler on the component's tag */
  detail?: TypeRef;
  /** the compiler reported an error in it (it may not even parse); kept for editor completion, never type-checked */
  broken?: boolean;
  /**
   * in the markup of a shared definition (a component used inside itself): the copy its deeper uses render, beside
   * the copy inlined at the outermost use. Its errors are reported only where no other copy on the page reports them
   */
  def?: true;
}

export interface CheckResource {
  name: string;
  /** value of `type`, a TypeScript type; null when absent */
  type: string | null;
  /** start of the `type` value, or of the element when absent */
  loc: CheckLoc;
  /** start of the `name` value, where go to definition lands */
  nameLoc?: CheckLoc;
  /** without `type`: the OpenAPI operation `src` matched and the schema of what `select` selects */
  openapi?: { spec: number; label: string; schema: unknown };
  /** `call`: the action and the `select` path into its result; with `type`, the result must fit it */
  call?: { name: string; select: string | null };
  /** keyset without `jump`: `page()` takes a direction, not a page number */
  directions?: boolean;
  /**
   * a `file:` resource: `list` for a glob (`type` names one entry); `adds`, the fields sinter writes into each entry
   * (`slug`, `dir`, `path`, `body`), as a type; `values`, each file's value, which must fit the entry's type (with `type`)
   */
  file?: { list: boolean; adds: string | null; values: Array<{ file: string; json: string }> };
  /** `<html data-sn-for>`: the entry, typed as one item of the resource it names */
  item?: string;
  /** `content:` without `type`: the content module (absolute) and the collection, typed from its loader */
  content?: { module: string; name: string };
}

export interface CheckUnit {
  file: string;
  resources: CheckResource[];
  frames: CheckFrame[];
  exprs: CheckExpr[];
}

/**
 * A unit's part of the check data (units.ts, docs/proposals/redesign-notes/stage4-check-once.md): the frames and
 * expressions one shared definition recorded, numbered from 0 (frames' `init`, expressions' `frames`), held once per
 * build. `file` and `base` name the page the unit was made on, which each page that takes the part is named as.
 */
export interface CheckPart { id: number; frames: CheckFrame[]; exprs: CheckExpr[]; file: string; base: string }

/** A page's reference to a part: its frames from `frameBase`, its expressions from `exprBase`, named as `file` (`base`). */
export interface CheckPartRef { part: CheckPart; frameBase: number; exprBase: number; file: string; base: string }

/**
 * A page's check data with parts held by reference: the page's own frames and expressions where they are, nothing
 * (`undefined`) where a part's are, until something reads them (`frames`, `exprs`, `checkFrameAt`, `checkExprAt`).
 */
export interface CheckRaw { frames: Array<CheckFrame | undefined>; exprs: Array<CheckExpr | undefined>; parts: CheckPartRef[]; flat: boolean }

const RAW = Symbol.for('sinter.checkParts');

/** A page's parts and its lists as they are (holes where parts are), or undefined for a unit without parts. */
export function checkRaw(u: CheckUnit): CheckRaw | undefined {
  const r = (u as { [RAW]?: CheckRaw })[RAW];
  return r && r.parts.length ? r : undefined;
}

/**
 * The check unit of a page that may take parts (a build's first pass with units): `frames` and `exprs` read as the
 * page's whole lists, a part's entries made the first time they are read (each a copy, numbered and named as the page's),
 * which is what copying the part into the page made (`flatten`). Its own enumerable fields are those of a plain unit,
 * in their order, so that it prints and compares as one.
 */
export function checkUnitWithParts(file: string, resources: CheckResource[], frames: Array<CheckFrame | undefined>, exprs: Array<CheckExpr | undefined>, parts: CheckPartRef[]): CheckUnit {
  const raw: CheckRaw = { frames, exprs, parts, flat: false };
  const u = { file, resources } as CheckUnit;
  const flat = () => { if (!raw.flat) { for (const p of parts) fillPart(raw, p); raw.flat = true; } };
  Object.defineProperty(u, 'frames', { enumerable: true, configurable: true, get() { flat(); return frames; } });
  Object.defineProperty(u, 'exprs', { enumerable: true, configurable: true, get() { flat(); return exprs; } });
  Object.defineProperty(u, RAW, { enumerable: false, value: raw });
  return u;
}

/** every entry of a part in the page's lists */
function fillPart(raw: CheckRaw, p: CheckPartRef) {
  for (let j = 0; j < p.part.frames.length; j++) if (raw.frames[p.frameBase + j] === undefined) raw.frames[p.frameBase + j] = partFrame(p, j);
  for (let j = 0; j < p.part.exprs.length; j++) if (raw.exprs[p.exprBase + j] === undefined) raw.exprs[p.exprBase + j] = partExpr(p, j);
}

/** the part a page index falls in, or undefined (parts are in the order the page took them, at increasing bases) */
function partAt(parts: CheckPartRef[], i: number, frames: boolean): CheckPartRef | undefined {
  let lo = 0, hi = parts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, p = parts[m]!, base = frames ? p.frameBase : p.exprBase, n = frames ? p.part.frames.length : p.part.exprs.length;
    if (i < base) hi = m - 1;
    else if (i >= base + n) lo = m + 1;
    else return p;
  }
  return undefined;
}

/** frame `i` of a page's lists (a part's made there the first time) */
export function checkFrameAt(raw: CheckRaw, i: number): CheckFrame | undefined {
  const f = raw.frames[i];
  if (f !== undefined) return f;
  const p = partAt(raw.parts, i, true);
  return p ? (raw.frames[i] = partFrame(p, i - p.frameBase)) : undefined;
}

/** expression `i` of a page's lists (a part's made there the first time) */
export function checkExprAt(raw: CheckRaw, i: number): CheckExpr | undefined {
  const e = raw.exprs[i];
  if (e !== undefined) return e;
  const p = partAt(raw.parts, i, false);
  return p ? (raw.exprs[i] = partExpr(p, i - p.exprBase)) : undefined;
}

/** a value of a part as the page's: every string naming the page the unit was made on names this one */
function swapped(p: CheckPartRef, x: unknown): any {
  if (typeof x === 'string') return x === p.part.file ? p.file : x.startsWith(p.part.base + ':') ? `${p.base}${x.slice(p.part.base.length)}` : x;
  if (Array.isArray(x)) return x.map((y) => swapped(p, y));
  if (x && typeof x === 'object') { const o: Record<string, unknown> = {}; for (const k of Object.keys(x)) o[k] = swapped(p, (x as Record<string, unknown>)[k]); return o; }
  return x;
}

/** frame `j` of a part, numbered and named as the page's */
export function partFrame(p: CheckPartRef, j: number): CheckFrame {
  const f = swapped(p, p.part.frames[j]);
  if ('init' in f && f.init != null) f.init += p.exprBase;
  return f;
}

/** expression `j` of a part, numbered and named as the page's */
export function partExpr(p: CheckPartRef, j: number): CheckExpr {
  const e = swapped(p, p.part.exprs[j]);
  e.frames = e.frames.map((i: number) => i + p.frameBase);
  return e;
}
