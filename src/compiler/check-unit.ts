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
 * A scope frame: a `data-sn-state` object or a `data-sn-for` loop. `init` is the
 * expression that creates it (the state literal, the list), or null when that
 * expression did not compile.
 */
export type CheckFrame =
  | { kind: 'state'; names: string[]; init: number | null }
  | { kind: 'loop'; item: string; index: string | null; init: number | null };

export interface CheckExpr {
  src: string;
  /** `value` returns the expression; `handler` runs it as statements */
  mode: 'value' | 'handler';
  loc: CheckLoc;
  /** frames visible here, in the order sinter resolves them last: states outer to inner, then loops outer to inner */
  frames: number[];
  /** tag of the element the expression sits on, for `$el` */
  tag: string;
  /** DOM event that runs a handler, for `$event` */
  event: string | null;
  /** `$result` (then) or `$error` (catch) is in scope */
  result: boolean;
  error: boolean;
}

export interface CheckResource {
  name: string;
  /** value of `type`, a TypeScript type; null when absent */
  type: string | null;
  /** start of the `type` value, or of the element when absent */
  loc: CheckLoc;
  /** without `type`: the OpenAPI operation `src` matched and the schema of what `items` selects */
  openapi?: { spec: number; label: string; schema: unknown };
}

export interface CheckUnit {
  file: string;
  resources: CheckResource[];
  frames: CheckFrame[];
  exprs: CheckExpr[];
}
