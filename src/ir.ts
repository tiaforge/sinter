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
