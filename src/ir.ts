// IR v1: the only contract between compiler and runtime. Plain JSON; every
// expression is an index into the page module's function table.

export const IR_VERSION = 1;

/** Literal string parts and function indexes, joined with encodeURIComponent. */
export type UrlTemplate = Array<string | number>;

export interface Paginate {
  mode: 'keyset' | 'offset' | 'append';
  size: number;
  sizeParam: string;
  /** keyset/append: object literal evaluated with the boundary item as `$.$p` */
  cursor: number | null;
  directionParam: string;
  /** keyset/append: the value sent for each direction, where it differs from the direction's name */
  directionValues?: Partial<Record<'first' | 'prev' | 'next' | 'last', string>>;
  pageParam: string;
  /** keyset: offset parameter that lets `page(name, n)` jump; the server skips (n - 1) * size items */
  offsetParam?: string;
}

export interface ResourceDef {
  name: string;
  src: UrlTemplate;
  /** key fields; null for a single-object resource */
  key: string[] | null;
  items: string | null;
  total: string | null;
  /** field, `-field` for descending */
  order: string | null;
  when: number | null;
  paginate: Paginate | null;
  /** state and `$url` paths that `src` and `when` read */
  deps: string[];
  /** index of the node (in `roots`) whose scope src/when are evaluated in, -1 for page scope */
  scope: number;
  /** `data-sn` id of an embedded `<script type="application/json">`, or null */
  data: number | null;
  /** `cache`: the oldest cached data to show, in ms (0: any age); absent when not cached */
  cache?: number;
  /** `refresh`: reload when this many ms have passed since the last load (whatever caused it) */
  refresh?: number;
  /** `call="ns.fn(args)"`: loaded from an action function instead of `src` (then empty) */
  call?: CallDef;
  /** `each="a in accounts"`: one request per list item (src evaluated with `item` in scope), merged into one collection */
  each?: { item: string; list: number; of?: string };
  /** `then`: handler run after each successful load, with `$result`; `w`: the state paths it writes */
  then?: number;
  w?: string[];
  /** only elements inside `<dialog>`s read it: requested with low priority */
  lo?: 1;
  /** the named OpenAPI schema of its items (`Article`): write-through matches response objects by it */
  sch?: string;
}

export interface EventDef {
  name: string;
  /** null for an event that only runs `then` */
  resource: string | null;
  op: 'upsert' | 'patch' | 'remove' | 'refetch' | null;
  item: number | null;
  set: number | null;
  when: number | null;
  fallback: 'refetch' | null;
  /** `then`: handler run after the change is applied; `w`: the state paths it writes */
  then?: number;
  w?: string[];
}

export interface SyncDef {
  src: UrlTemplate;
  events: EventDef[];
  /** index of the node (in `roots`) whose scope `src` and the events' expressions are evaluated in, -1 (or absent) for page scope */
  scope?: number;
}

export type BindingKind =
  | 'text' | 'attr' | 'class' | 'style' | 'show' | 'model' | 'prop'
  | 'for' | 'if' | 'else' | 'on';

export interface Binding {
  k: BindingKind;
  /** value / handler function index */
  f?: number;
  /** dependency paths: dot-separated, `*` any segment, `{name}` scope value */
  d?: string[];
  /** event name (`on`), control kind (`model`) */
  n?: string;
  /** action index (`on`), template id (`for`, `if`, `else`) */
  x?: number;
  /** model setter function index */
  a?: number;
  /** if: node index of the paired else template */
  y?: number;
  /** handler: paths it may change */
  w?: string[];
  /** model: persist key */
  p?: string;
  /** the expression reads `$el` */
  e?: 1;
  /** the expression reads a loop index, so it re-runs when only the row's position changed */
  i?: 1;
  /** handler on an element without a method: `data-sn-debounce` milliseconds */
  ms?: number;
  /** key filter (`on` for keydown/keyup): the `KeyboardEvent.key` to match, letters in lowercase */
  q?: string;
  /** key filter modifiers: 1 ctrl, 2 alt, 4 shift, 8 meta, 16 mod (Ctrl, or Meta on Apple), 32 Shift does not matter unless named */
  m?: number;
  /**
   * selection (a value binding in a row): the value is `row side === outer side` (`x`: `!==`). `r` and `o` are
   * the sides' functions, `d` the outer side's dependencies the row side does not read. When only those change,
   * the runtime re-evaluates the binding on the rows the comparison matched and matches, not on every row.
   */
  s?: { r: number; o: number; d: string[]; x?: 1 };
}

export interface NodeDef {
  /** `data-sn` id (roots) */
  id?: number;
  /** child indexes from the template content root (template nodes) */
  path?: number[];
  tag: string;
  /** index of the nearest enclosing node in the same list that opens a state scope, -1 for none */
  p: number;
  /** state scope: initial value function and scope id (`$s<sid>`) */
  state?: number;
  sid?: number;
  /** persist key for the whole state object */
  persist?: string;
  /** the element is a `<dialog>` or inside one of its block, so its bindings wait while that dialog is closed */
  dl?: 1;
  /** the element has a `class` attribute in the source (a class binding's first write on a clone must remove the class), set when it has class bindings */
  cl?: 1;
  b: Binding[];
}

/**
 * The early chunk's part of a page: page nodes (by `data-sn` id) and `data-sn-if` templates with
 * only the bindings that can render before data; function indexes point into the early table.
 */
export interface EarlyIR {
  roots: NodeDef[];
  /** by template id; null for templates the early chunk does not render */
  templates: Array<{ nodes: NodeDef[] } | null>;
  /** resources the early file requests: URL template and `when` (function indexes into the early table), scope by index into `roots`, -1 for the page; `q`: a paginated resource's first-page query parameters */
  res?: Array<{ name: string; src: UrlTemplate; when: number | null; scope: number; q?: Record<string, string>; lo?: 1; xo?: 1 }>;
  /** `data-sn-path` patterns, when a request reads `$url` */
  path?: string[];
}

export interface TemplateDef {
  id: number;
  nodes: NodeDef[];
  /** for: loop variable, index variable, internal index name */
  item?: string;
  index?: string | null;
  ii?: string;
  /** for: explicit key function, or resource key fields */
  key?: number | null;
  keyFields?: string[] | null;
  /** for: function that finds the bound elements of one cloned row: (first content node) => elements, in `nodes` order */
  find?: number;
  /**
   * for, simple templates (value bindings and handlers only, no `$el`): creation function
   * `(first content node, scope, writers) => last values` that finds the elements, evaluates every
   * value binding inline and writes it through the runtime's per-kind writers; null (UNSET) for a
   * binding whose element is missing. The generic path creates rows of templates without one.
   */
  make?: number;
}

/** a local action call: `args` evaluates the arguments (an array), `run(args, ctx)` calls the function */
export interface CallDef {
  args: number;
  run: number;
}

export interface ActionDef {
  /** `CALL`: `data-sn-call`, with `call` set and an empty `url` */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'CALL';
  url: UrlTemplate;
  call?: CallDef;
  // absent fields take their default (the compiler writes only what differs): no body, trigger and
  // so on; the event that triggers it is its `on` binding's
  body?: number | null;
  debounce?: number;
  concurrency: 'block' | 'queue' | 'latest';
  optimistic?: number | null;
  then?: number | null;
  catch?: number | null;
  /** paths `then` and `catch` may change */
  w?: string[];
  /** element is a form (serialize, disable in block mode) */
  form?: boolean;
  /** `data-sn-confirm`: the question asked before the action runs (none when it is falsy) */
  confirm?: number;
  /** `data-sn-encoding="form"`: the body goes as application/x-www-form-urlencoded */
  enc?: 'form';
  /** write-through of the response (absent with `data-sn-apply="off"`, for GET and `call`) */
  ap?: ApplyDef;
}

/** What a mutation is about and what its response holds, for the `apply` feature (write-through). */
export interface ApplyDef {
  /**
   * provenance: what the URL and body read. `r`: the resource; `v`: the loop variable when it is a
   * row of that list; `p`: a sub-path inside the item (`['author']`); `s`: the named schema there
   */
  tg: Array<{ r: string; v?: string; p?: string[]; s?: string }>;
  /** response paths holding an object of a named schema (`''`: the response itself; `a`: an array of them) */
  rs?: Array<{ p: string; s: string; a?: 1 }>;
  /** the request body's wrapper property, when the request schema is `{ wrapper: {…} }` */
  rq?: string;
  /** index in `tg` of the entity the request body describes (its fields are fields of that schema) */
  u?: number;
  /** the operation matched an OpenAPI spec (rules that need schemas apply) */
  t?: 1;
}

export interface IR {
  v: 1;
  resources: ResourceDef[];
  syncs: SyncDef[];
  roots: NodeDef[];
  templates: TemplateDef[];
  actions: ActionDef[];
  /** page uses `$now` */
  now?: boolean;
  /** `data-sn-path` patterns; `:name` segments of the first match join `$url` */
  path?: string[];
}

export type Fn = (scope: any, value?: any) => any;

/** Structural check of an IR against v1; returns problems (empty when valid). */
export function validateIR(ir: unknown, fnCount: number): string[] {
  const errs: string[] = [];
  const o = ir as IR;
  const fn = (v: unknown, at: string, nullable = true) => {
    if (v === null && nullable) return;
    if (v === undefined && nullable) return;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= fnCount) errs.push(`${at}: bad function index ${String(v)}`);
  };
  const url = (u: unknown, at: string) => {
    if (!Array.isArray(u) || !u.length || typeof u[0] !== 'string') { errs.push(`${at}: URL template must start with a literal`); return; }
    u.forEach((p, i) => (typeof p === 'string' ? undefined : fn(p, `${at}[${i}]`, false)));
  };
  if (!o || o.v !== 1) return ['v must be 1'];
  for (const k of ['resources', 'syncs', 'roots', 'templates', 'actions'] as const) if (!Array.isArray(o[k])) errs.push(`${k} must be an array`);
  if (errs.length) return errs;
  const names = new Set<string>();
  o.resources.forEach((r, i) => {
    const at = `resources[${i}]`;
    if (!/^[A-Za-z_]\w*$/.test(r.name)) errs.push(`${at}: bad name`);
    if (names.has(r.name)) errs.push(`${at}: duplicate name ${r.name}`);
    names.add(r.name);
    if (r.call) { fn(r.call.args, `${at}.call.args`, false); fn(r.call.run, `${at}.call.run`, false); if (r.src.length) errs.push(`${at}: a call resource has no src`); }
    else url(r.src, `${at}.src`);
    fn(r.when, `${at}.when`); fn(r.then, `${at}.then`);
    for (const d of r.w ?? []) if (typeof d !== 'string' || !d) errs.push(`${at}: bad path`);
    if (r.paginate) {
      if (!['keyset', 'offset', 'append'].includes(r.paginate.mode)) errs.push(`${at}: bad paginate mode`);
      fn(r.paginate.cursor, `${at}.paginate.cursor`);
    }
  });
  o.syncs.forEach((s, i) => {
    url(s.src, `syncs[${i}].src`);
    s.events.forEach((e, j) => {
      const at = `syncs[${i}].events[${j}]`;
      // without a resource and op, the event only runs `then`
      if (e.resource === null && e.op === null) { if (e.then === undefined) errs.push(`${at}: needs a resource or then`); }
      else {
        if (!names.has(e.resource!)) errs.push(`${at}: unknown resource ${e.resource}`);
        if (!['upsert', 'patch', 'remove', 'refetch'].includes(e.op!)) errs.push(`${at}: bad op`);
      }
      fn(e.item, `${at}.item`); fn(e.set, `${at}.set`); fn(e.when, `${at}.when`); fn(e.then, `${at}.then`);
      for (const d of e.w ?? []) if (typeof d !== 'string' || !d) errs.push(`${at}: bad path`);
    });
  });
  const kinds = new Set(['text', 'attr', 'class', 'style', 'show', 'model', 'prop', 'for', 'if', 'else', 'on']);
  const nodes = (list: NodeDef[], at: string, inTemplate: boolean) => list.forEach((n, i) => {
    const a = `${at}[${i}]`;
    if (inTemplate ? !Array.isArray(n.path) : !Number.isInteger(n.id)) errs.push(`${a}: needs ${inTemplate ? 'path' : 'id'}`);
    if (n.p >= i) errs.push(`${a}: parent scope must come first`);
    if (n.state !== undefined) { fn(n.state, `${a}.state`, false); if (!Number.isInteger(n.sid)) errs.push(`${a}: state needs sid`); }
    n.b.forEach((b, j) => {
      const ba = `${a}.b[${j}]`;
      if (!kinds.has(b.k)) errs.push(`${ba}: bad kind ${b.k}`);
      if (b.k === 'on') {
        if (!b.n) errs.push(`${ba}: on needs an event name`);
        if (b.x !== undefined) { if (!o.actions[b.x]) errs.push(`${ba}: bad action ${b.x}`); } else fn(b.f, `${ba}.f`, false);
        if (b.q !== undefined && (typeof b.q !== 'string' || !b.q || !/^key(down|up)$/.test(b.n!))) errs.push(`${ba}: bad key filter`);
        if (b.m !== undefined && (!Number.isInteger(b.m) || b.q === undefined)) errs.push(`${ba}: bad key modifiers`);
      } else if (b.k === 'for' || b.k === 'if' || b.k === 'else') {
        if (!o.templates[b.x!]) errs.push(`${ba}: bad template ${b.x}`);
        if (b.k !== 'else') fn(b.f, `${ba}.f`, false);
        if (b.y !== undefined && !list[b.y]?.b.some((x) => x.k === 'else')) errs.push(`${ba}: y must point at an else node`);
      } else fn(b.f, `${ba}.f`, false);
      if (b.k === 'model') fn(b.a, `${ba}.a`, false);
      if (b.s !== undefined) {
        if (!['text', 'attr', 'class', 'style', 'show', 'prop'].includes(b.k) || !inTemplate) errs.push(`${ba}: s belongs to a value binding in a template`);
        else { fn(b.s.r, `${ba}.s.r`, false); fn(b.s.o, `${ba}.s.o`, false); if (!Array.isArray(b.s.d) || !b.s.d.length) errs.push(`${ba}: s needs outer paths`); }
      }
      for (const d of [...(b.d ?? []), ...(b.w ?? []), ...(b.s?.d ?? [])]) if (typeof d !== 'string' || !d) errs.push(`${ba}: bad path`);
    });
  });
  nodes(o.roots, 'roots', false);
  o.templates.forEach((t, i) => {
    if (t.id !== i) errs.push(`templates[${i}]: id must equal its index`);
    nodes(t.nodes, `templates[${i}].nodes`, true);
    fn(t.key, `templates[${i}].key`);
    fn(t.find, `templates[${i}].find`);
    fn(t.make, `templates[${i}].make`);
  });
  o.actions.forEach((a, i) => {
    const at = `actions[${i}]`;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CALL'].includes(a.method)) errs.push(`${at}: bad method`);
    if (!['block', 'queue', 'latest'].includes(a.concurrency)) errs.push(`${at}: bad concurrency`);
    if (a.method === 'CALL') {
      if (!a.call) errs.push(`${at}: CALL needs call`);
      else { fn(a.call.args, `${at}.call.args`, false); fn(a.call.run, `${at}.call.run`, false); }
      if (a.url.length) errs.push(`${at}: a call action has no url`);
    } else url(a.url, `${at}.url`);
    for (const k of ['body', 'optimistic', 'then', 'catch'] as const) fn(a[k], `${at}.${k}`);
  });
  return errs;
}
