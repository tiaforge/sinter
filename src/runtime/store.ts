// The store: one keyed (or single-object) cache per resource. It knows nothing
// about the DOM, fetch or SSE. Each resource holds a base (what the server last
// confirmed) and ordered optimistic layers; readers see base + layers.
import { BAD_KEY } from './security.js';

export type Change<T = any> =
  | { resource: string; op: 'upsert'; item: T }
  | { resource: string; op: 'patch'; key: string; fields: Partial<T> }
  | { resource: string; op: 'remove'; key: string }
  | { resource: string; op: 'refetch' };

export type Op =
  | { op: 'upsert'; item: any }
  | { op: 'patch'; key: string; fields: any }
  | { op: 'remove'; key: string };

export interface Meta {
  loading: boolean;
  error: { status: number; body: unknown; message: string } | null;
  loadedAt: number | null;
  pending: number;
  total: number | null;
  page?: number;
  pages?: number | null;
  from?: number | null;
  to?: number | null;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export interface ResourceOptions {
  key: string[] | null;
  order: string | null;
  locale?: () => string | undefined;
  warn?: (code: number, ...args: unknown[]) => void;
  /** applied to every stored item (dev builds freeze them) */
  prep?: <T>(item: T) => T;
}

/** The public store handle (`app.resource(name)`), plus the hooks loaders and features use. */
export interface Resource<T extends object = any> {
  readonly name: string;
  readonly meta: Meta;
  readonly key: string[] | null;
  readonly isCollection: boolean;
  get(key: string | T): T | undefined;
  has(key: string | T): boolean;
  all(): readonly T[];
  /** what expressions see: the ordered array, or the single object (null when absent) */
  value(): readonly T[] | T | null;
  replace(items: T[] | T | null): void;
  upsert(item: T): void;
  patch(key: string | T, fields: Partial<T>): void;
  remove(key: string | T): void;
  refetch(): Promise<void>;
  subscribe(fn: (change: Change<T>) => void): () => void;
  keyOf(item: string | T): string;
  /**
   * Loads in flight: writes made while a load runs are replayed on top of its response,
   * so a stale response cannot undo them. `startLoad` returns a mark for `endLoad`.
   */
  startLoad(): number;
  endLoad(mark: number, loaded: boolean): void;
  addLayer(ops: Op[]): number;
  dropLayer(id: number): void;
  setTotal(total: number | null): void;
  /** while set, upsert/patch/remove are recorded instead of applied */
  recording: Op[] | null;
  loader: { refetch(): Promise<void> } | null;
  onDirty(what: 'data' | 'meta'): void;
}

/** Copies own enumerable fields, dropping keys that could pollute prototypes. */
export function clean<T>(obj: T): T {
  if (!obj || typeof obj != 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (!BAD_KEY.test(k)) out[k] = (obj as Record<string, unknown>)[k];
  return out as T;
}

export function createResource<T extends object = any>(name: string, o: ResourceOptions): Resource<T> {
  const meta: Meta = { loading: false, error: null, loadedAt: null, pending: 0, total: null };
  const coll = !!o.key, field = o.order?.replace(/^-/, ''), dir = o.order?.[0] == '-' ? -1 : 1;
  const subs = new Set<(c: Change<T>) => void>();
  const prep = (x: any) => (o.prep ? o.prep(x) : x);
  let base = new Map<string, T>(), single: T | null = null, total: number | null = null;
  let layers: Array<{ id: number; ops: Op[] }> = [], lastLayer = 0;
  let view: { l: readonly T[]; m: Map<string, T>; s: T | null } | null = null;
  let journal: Op[] | null = null, loads = 0;

  const keyOf = (x: any): string => typeof x == 'string' ? x : (o.key ?? []).map((f) => {
    if (x[f] === undefined) o.warn?.(14, name, f);
    return x[f];
  }).join('\x1f');

  const merge = (cur: any, op: Op) => op.op == 'upsert' ? prep(op.item)
    : op.op == 'remove' ? null
    : cur && prep({ ...cur, ...clean(op.fields) });

  /** Applies one op to a keyed map; counts removals of present items. */
  const applyTo = (m: Map<string, T>, op: Op, removed?: { n: number }) => {
    const k = op.op == 'upsert' ? keyOf(op.item) : op.key, v = merge(m.get(k), op);
    if (v) m.set(k, v);
    else if (m.delete(k) && removed) removed.n++;
  };

  const changed = (what: 'data' | 'meta' = 'data') => {
    view = null;
    r.onDirty('data');
    if (what == 'meta') r.onDirty('meta');
  };

  function visible() {
    if (view) return view;
    let t = total, m = base, s = single;
    const removed = { n: 0 };
    for (const l of layers) for (const op of l.ops) coll ? (m == base && (m = new Map(base)), applyTo(m, op, removed)) : (s = merge(s, op));
    if (t != null) t = Math.max(0, t - removed.n);
    const l = [...m.values()];
    if (field) {
      const c = new Intl.Collator(o.locale?.(), { numeric: true });
      l.sort((a: any, b: any) => {
        const x = a[field], y = b[field];
        if (x == null || y == null) return +(x == null) - +(y == null);
        return dir * (typeof x == 'string' && typeof y == 'string' ? c.compare(x, y) : +(x > y) - +(x < y));
      });
    }
    view = { l: Object.freeze(l), m, s };
    if (meta.total !== t) { meta.total = t; r.onDirty('meta'); }
    return view;
  }

  function write(op: Op) {
    if (r.recording) return void r.recording.push(op);
    journal?.push(op);
    coll ? applyTo(base, op) : (single = merge(single, op));
    changed();
    for (const f of subs) f({ resource: name, ...op } as Change<T>);
  }

  const r: Resource<T> = {
    name, meta, key: o.key, isCollection: coll, keyOf, recording: null, loader: null, onDirty() {},
    get: (k) => (coll ? visible().m.get(keyOf(k)) : visible().s ?? undefined),
    has: (k) => r.get(k) !== undefined,
    all: () => visible().l,
    value: () => (coll ? visible().l : visible().s),
    replace(items) {
      if (coll) {
        base = new Map();
        for (const x of Array.isArray(items) ? items : []) {
          const k = keyOf(x);
          if (base.has(k)) o.warn?.(13, name, k);
          base.delete(k);
          base.set(k, prep(x));
        }
      } else single = items == null ? null : prep(items);
      changed();
      for (const f of subs) f({ resource: name, op: 'refetch' });
    },
    upsert: (item) => write({ op: 'upsert', item }),
    patch: (k, fields) => write({ op: 'patch', key: keyOf(k), fields }),
    remove: (k) => write({ op: 'remove', key: keyOf(k) }),
    refetch: () => r.loader?.refetch() ?? Promise.resolve(),
    subscribe: (fn) => (subs.add(fn), () => subs.delete(fn)),
    startLoad() {
      loads++;
      journal ??= [];
      return journal.length;
    },
    endLoad(mark, loaded) {
      const ops = journal!.slice(mark);
      if (--loads == 0) journal = null;
      if (!loaded || !ops.length) return;
      for (const op of ops) coll ? applyTo(base, op) : (single = merge(single, op));
      changed();
    },
    addLayer(ops) {
      layers.push({ id: ++lastLayer, ops });
      meta.pending = layers.length;
      changed('meta');
      return lastLayer;
    },
    dropLayer(id) {
      const n = layers.length;
      layers = layers.filter((l) => l.id != id);
      meta.pending = layers.length;
      if (n != layers.length) changed('meta');
    },
    setTotal(t) { total = t; changed(); },
  };
  return r;
}
