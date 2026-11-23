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
