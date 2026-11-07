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
  /** `locs[i]`: where `names[i]` is written in the literal */
  | { kind: 'state'; names: string[]; init: number | null; locs?: CheckLoc[] }
  /** `loc`, `indexLoc`: where the item and index names are written */
  | { kind: 'loop'; item: string; index: string | null; init: number | null; loc?: CheckLoc; indexLoc?: CheckLoc }
  /** a `data-sn-let` name; `loc`: where the name is written */
  | { kind: 'let'; name: string; init: number | null; loc?: CheckLoc };

/** A type the checker writes for something other than a resource. */
export type TypeRef =
  /** written by the app (`type` on `<sn-event>`); errors in it point at `loc` */
  | { kind: 'ts'; text: string; loc: CheckLoc }
  /** a schema of OpenAPI spec number `spec` */
  | { kind: 'openapi'; spec: number; schema: unknown }
  /** an item of a resource on the page, or a partial one */
  | { kind: 'item'; resource: string; partial?: boolean }
  /** an action (`archive`, `pgp.decrypt`): its arguments (`args`) or its awaited result */
  | { kind: 'call'; name: string; args?: boolean }
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
  /** `$result` (then) or `$error` (catch) is in scope */
  result: boolean;
  error: boolean;
  /** type of `$result`, when the action matched an OpenAPI operation */
  resultType?: TypeRef;
  /** the value must be assignable to this (`data-sn-body`, `<sn-event>` `item` and `set`) */
  returns?: TypeRef;
  /** payload expressions (`<sn-event>`, `cursor`): the payload fields read, and the payload's type (null: any) */
  payload?: { names: string[]; type: TypeRef | null; states?: string[] };
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
  /** without `type`: the OpenAPI operation `src` matched and the schema of what `items` selects */
  openapi?: { spec: number; label: string; schema: unknown };
  /** `call`: the action and the `items` path into its result; with `type`, the result must fit it */
  call?: { name: string; items: string | null };
}

export interface CheckUnit {
  file: string;
  resources: CheckResource[];
  frames: CheckFrame[];
  exprs: CheckExpr[];
}
