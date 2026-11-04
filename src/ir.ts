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
  pageParam: string;
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
}

export interface EventDef {
  name: string;
  resource: string;
  op: 'upsert' | 'patch' | 'remove' | 'refetch';
  item: number | null;
  set: number | null;
  when: number | null;
  fallback: 'refetch' | null;
}

export interface SyncDef {
  src: UrlTemplate;
  events: EventDef[];
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
  b: Binding[];
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
}

export interface ActionDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: UrlTemplate;
  body: number | null;
  trigger: string;
  debounce: number;
  concurrency: 'block' | 'queue' | 'latest';
  optimistic: number | null;
  then: number | null;
  catch: number | null;
  /** paths `then` and `catch` may change */
  w: string[];
  /** element is a form (serialize, disable in block mode) */
  form: boolean;
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
    url(r.src, `${at}.src`);
    fn(r.when, `${at}.when`);
    if (r.paginate) {
      if (!['keyset', 'offset', 'append'].includes(r.paginate.mode)) errs.push(`${at}: bad paginate mode`);
      fn(r.paginate.cursor, `${at}.paginate.cursor`);
    }
  });
  o.syncs.forEach((s, i) => {
    url(s.src, `syncs[${i}].src`);
    s.events.forEach((e, j) => {
      const at = `syncs[${i}].events[${j}]`;
      if (!names.has(e.resource)) errs.push(`${at}: unknown resource ${e.resource}`);
      if (!['upsert', 'patch', 'remove', 'refetch'].includes(e.op)) errs.push(`${at}: bad op`);
      fn(e.item, `${at}.item`); fn(e.set, `${at}.set`); fn(e.when, `${at}.when`);
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
      } else if (b.k === 'for' || b.k === 'if' || b.k === 'else') {
        if (!o.templates[b.x!]) errs.push(`${ba}: bad template ${b.x}`);
        if (b.k !== 'else') fn(b.f, `${ba}.f`, false);
        if (b.y !== undefined && !list[b.y]?.b.some((x) => x.k === 'else')) errs.push(`${ba}: y must point at an else node`);
      } else fn(b.f, `${ba}.f`, false);
      if (b.k === 'model') fn(b.a, `${ba}.a`, false);
      for (const d of [...(b.d ?? []), ...(b.w ?? [])]) if (typeof d !== 'string' || !d) errs.push(`${ba}: bad path`);
    });
  });
  nodes(o.roots, 'roots', false);
  o.templates.forEach((t, i) => {
    if (t.id !== i) errs.push(`templates[${i}]: id must equal its index`);
    nodes(t.nodes, `templates[${i}].nodes`, true);
    fn(t.key, `templates[${i}].key`);
  });
  o.actions.forEach((a, i) => {
    const at = `actions[${i}]`;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method)) errs.push(`${at}: bad method`);
    if (!['block', 'queue', 'latest'].includes(a.concurrency)) errs.push(`${at}: bad concurrency`);
    url(a.url, `${at}.url`);
    for (const k of ['body', 'optimistic', 'then', 'catch'] as const) fn(a[k], `${at}.${k}`);
  });
  return errs;
}
