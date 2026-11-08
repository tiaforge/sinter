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
  error: { status: number | null; body: unknown; message: string } | null;
  loadedAt: number | null;
  pending: number;
  total: number | null;
  page?: number | null;
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
  /** hand out frozen lists (dev builds) */
  freeze?: boolean;
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
  /** `hint`: a server event's payload; an `each` resource reloads only the source it names */
  refetch(hint?: object): Promise<void>;
  subscribe(fn: (change: Change<T>) => void): () => void;
  keyOf(item: string | T): string;
  /**
   * Loads in flight: writes made while a load runs are replayed on top of its response,
   * so a stale response cannot undo them. `startLoad` returns a mark for `endLoad`.
   */
  startLoad(): number;
  endLoad(mark: number, loaded: boolean): void;
  addLayer(ops: Op[]): number;
  /** the rollback: the layer's changes are gone */
  dropLayer(id: number): void;
  /** the request succeeded: the layer goes into the base, in order (after the older layers settle) */
  commitLayer(id: number): void;
  setTotal(total: number | null): void;
  /** what the server last confirmed, without optimistic layers (in arrival order) */
  base(): { items: T[] | T | null; total: number | null };
  /** while set, upsert/patch/remove are recorded instead of applied */
  recording: Op[] | null;
  loader: { refetch(hint?: object): Promise<void> } | null;
  onDirty(what: 'data' | 'meta'): void;
}

/** Copies own enumerable fields, dropping keys that could pollute prototypes. */
export function clean<T>(obj: T): T {
  if (!obj || typeof obj != 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (!BAD_KEY.test(k)) out[k] = (obj as Record<string, unknown>)[k];
  return out as T;
}

/** One collator per locale: constructing one is costly in some engines. */
const collators = new Map<string, Intl.Collator>();
const collator = (l = '') => collators.get(l) ?? (collators.set(l, new Intl.Collator(l || undefined, { numeric: true })), collators.get(l)!);

export function createResource<T extends object = any>(name: string, o: ResourceOptions): Resource<T> {
  const meta: Meta = { loading: false, error: null, loadedAt: null, pending: 0, total: null };
  const coll = !!o.key, field = o.order?.replace(/^-/, ''), dir = o.order?.[0] == '-' ? -1 : 1;
  const subs = new Set<(c: Change<T>) => void>();
  const prep = (x: any) => (o.prep ? o.prep(x) : x);
  /** base items in arrival order, and each key's arrival number (ties in `order` keep arrival order) */
  let base = new Map<string, T>(), seq = new Map<string, number>(), next = 0;
  let single: T | null = null, total: number | null = null;
  /** `ok`: its request succeeded; it waits for the older layers to settle before it joins the base */
  let layers: Array<{ id: number; ops: Op[]; ok?: 1 }> = [], lastLayer = 0;
  /**
   * The base in display order, the locale it was sorted for, and the keys written since, with
   * their value before the first write. Reads patch it instead of sorting
   * again. Arrays handed out are never changed afterwards.
   */
  let sorted: T[] | null = null, sortedFor: string | undefined, touched = new Map<string, T | undefined>();
  /** Optimistic layers applied over the base: changed keys (null: removed), keys they add (arrival numbers), removals counted for `total`. */
  let over: { m: Map<string, T | null>; add: Map<string, number>; removed: number; s: T | null } | null = null;
  /** what readers see; rebuilt on the first read after a change */
  let view: { l: readonly T[]; get: (k: string) => T | undefined; s: T | null } | null = null;
  let journal: Op[] | null = null, loads = 0;

  const keyOf = (x: any): string => typeof x == 'string' ? x : (o.key ?? []).map((f) => {
    if (x[f] === undefined) o.warn?.(14, name, f);
    return x[f];
  }).join('\x1f');

  const kOf = (op: Op) => op.op == 'upsert' ? keyOf(op.item) : op.key;

  const merge = (cur: any, op: Op) => op.op == 'upsert' ? prep(op.item)
    : op.op == 'remove' ? null
    : cur && prep({ ...cur, ...clean(op.fields) });

  /** Applies one op to the base. */
  const apply = (op: Op) => {
    if (!coll) return void (single = merge(single, op));
    const k = kOf(op), cur = base.get(k), v = merge(cur, op);
    if (sorted && !touched.has(k)) touched.set(k, cur);
    if (v) { if (!cur) seq.set(k, next++); base.set(k, v); }
    else if (cur) { base.delete(k); seq.delete(k); }
  };

  /** By `order` (none: all equal, so arrival order decides). */
  const compare = (a: any, b: any) => {
    if (!field) return 0;
    const x = a[field], y = b[field];
    if (x == null || y == null) return +(x == null) - +(y == null);
    return dir * (typeof x == 'string' && typeof y == 'string' ? collator(sortedFor).compare(x, y) : +(x > y) - +(x < y));
  };

  /** A sorted copy of `list` without the `drop` items and with the `add` items (each with its arrival number). */
  function patch(list: readonly T[], drop: T[], add: Array<[T, number]>, arrival: (k: string) => number): T[] {
    const out = list.slice();
    /** the first index whose item does not sort before `v` (with arrival number `n`, after its ties) */
    const find = (v: T, n?: number) => {
      let lo = 0, hi = out.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1, c = compare(out[mid], v) || (n == null ? 0 : arrival(keyOf(out[mid])) - n);
        c < 0 ? (lo = mid + 1) : (hi = mid);
      }
      return lo;
    };
    for (const v of drop) {
      // among its ties, by identity; an item whose order field was changed in place is found by a scan
      let i = find(v);
      while (out[i] !== v && i < out.length && !compare(out[i], v)) i++;
      out.splice(out[i] === v ? i : out.indexOf(v), 1);
    }
    for (const [v, n] of add) out.splice(find(v, n), 0, v);
    return out;
  }

  /** The base in display order. */
  function baseList(): T[] {
    const locale = o.locale?.();
    if (sorted && locale === sortedFor && touched.size <= 64) {
      if (touched.size) {
        const drop: T[] = [], add: Array<[T, number]> = [];
        for (const [k, old] of touched) {
          if (old) drop.push(old);
          const v = base.get(k);
          if (v) add.push([v, seq.get(k)!]);
        }
        sorted = patch(sorted, drop, add, (k) => seq.get(k)!);
      }
    } else {
      sortedFor = locale;
      // a stable sort of the Map's arrival order
      sorted = [...base.values()].sort(compare);
    }
    touched = new Map();
    return sorted;
  }

  /** Recomputes the layers' effect and `meta.total` after any change; marks `meta` if the total changed. */
  function sync() {
    over = null;
    if (layers.length) {
      const m = new Map<string, T | null>(), add = new Map<string, number>();
      let removed = 0, n = next, s = single;
      for (const l of layers) for (const op of l.ops) {
        if (!coll) { s = merge(s, op); continue; }
        const k = kOf(op), cur = m.has(k) ? m.get(k) : base.get(k), v = merge(cur, op);
        if (v) { if (!cur) add.set(k, n++); m.set(k, v); }
        else { if (cur) removed++; m.set(k, null); add.delete(k); }
      }
      over = { m, add, removed, s };
    }
    const t = total == null ? null : Math.max(0, total - (over?.removed ?? 0));
    if (meta.total !== t) { meta.total = t; r.onDirty('meta'); }
  }

  /** A data change: readers rebuild their view; `meta` too when the pending count changed. */
  const changed = (pending?: boolean) => {
    view = null;
    sync();
    r.onDirty('data');
    if (pending) { meta.pending = layers.filter((l) => !l.ok).length; r.onDirty('meta'); }
  };

  function visible() {
    // a locale change re-sorts strings: a view sorted for another locale is stale
    if (view && !(coll && field && o.locale?.() !== sortedFor)) return view;
    if (!coll) return (view = { l: [], get: () => undefined, s: over ? over.s : single });
    let l: readonly T[] = baseList(), get = (k: string) => base.get(k);
    if (over) {
      const { m, add } = over, drop: T[] = [], put: Array<[T, number]> = [], at = (k: string) => add.get(k) ?? seq.get(k)!;
      for (const [k, v] of m) {
        const b = base.get(k);
        if (b) drop.push(b);
        if (v) put.push([v, at(k)]);
      }
      l = patch(l, drop, put, at);
      get = (k) => (m.has(k) ? m.get(k) ?? undefined : base.get(k));
    }
    // dev builds freeze what expressions see; the compiler refuses writes to resources (SN205)
    return (view = { l: o.freeze ? Object.freeze(l.slice()) : l, get, s: null });
  }

  function write(op: Op) {
    if (r.recording) return void r.recording.push(op);
    // a server write wins over a confirmed layer still waiting for an older one
    for (const l of layers) if (l.ok) l.ops = l.ops.filter((x) => coll && kOf(x) != kOf(op));
    journal?.push(op);
    apply(op);
    changed();
    for (const f of subs) f({ resource: name, ...op } as Change<T>);
  }

  /** Moves the confirmed layers at the bottom into the base; a running load replays them on its response. */
  function fold() {
    const done: Op[] = [];
    while (layers[0]?.ok) for (const op of layers.shift()!.ops) {
      journal?.push(op);
      // an item the server confirms gone leaves the total too, as the layer counted it
      if (op.op == 'remove' && total != null && (coll ? base.has(op.key) : single)) total--;
      apply(op);
      done.push(op);
    }
    changed(true);
    for (const op of done) for (const f of subs) f({ resource: name, ...op } as Change<T>);
  }

  const r: Resource<T> = {
    name, meta, key: o.key, isCollection: coll, keyOf, recording: null, loader: null, onDirty() {},
    get: (k) => (coll ? visible().get(keyOf(k)) : visible().s ?? undefined),
    has: (k) => r.get(k) !== undefined,
    all: () => visible().l,
    value: () => (coll ? visible().l : visible().s),
    replace(items) {
      if (coll) {
        base = new Map();
        seq = new Map();
        sorted = null;
        touched = new Map();
        for (const x of Array.isArray(items) ? items : []) {
          const k = keyOf(x);
          if (base.has(k)) o.warn?.(13, name, k);
          base.delete(k);
          base.set(k, prep(x));
          seq.set(k, next++);
        }
      } else single = items == null ? null : prep(items);
      changed();
      for (const f of subs) f({ resource: name, op: 'refetch' });
    },
    upsert: (item) => write({ op: 'upsert', item }),
    patch: (k, fields) => write({ op: 'patch', key: keyOf(k), fields }),
    remove: (k) => write({ op: 'remove', key: keyOf(k) }),
    refetch: (hint) => r.loader?.refetch(hint) ?? Promise.resolve(),
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
      for (const op of ops) apply(op);
      changed();
    },
    addLayer(ops) {
      layers.push({ id: ++lastLayer, ops });
      changed(true);
      return lastLayer;
    },
    dropLayer(id) {
      const n = layers.length;
      layers = layers.filter((l) => l.id != id);
      if (n != layers.length) fold();
    },
    commitLayer(id) {
      const l = layers.find((x) => x.id == id);
      if (l) { l.ok = 1; fold(); }
    },
    /** the total changes `meta` only: bindings that read the items do not re-run */
    setTotal(t) { total = t; sync(); },
    base: () => ({ items: coll ? [...base.values()] : single, total }),
  };
  return r;
}
