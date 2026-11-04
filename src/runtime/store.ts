// The store: one keyed (or single-object) cache per resource. It knows nothing
// about the DOM, fetch or SSE. Each resource holds a base (what the server last
// confirmed) and ordered optimistic layers; readers see base + layers.

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
  dev?: boolean;
  locale?: () => string | undefined;
  warn?: (msg: string, value?: unknown) => void;
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEP = '\u001f';

/** Copies own enumerable fields, dropping keys that could pollute prototypes. */
export function clean<T>(obj: T): T {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (!BAD_KEYS.has(k)) out[k] = (obj as Record<string, unknown>)[k];
  return out as T;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export class Resource<T extends object = any> {
  readonly meta: Meta = { loading: false, error: null, loadedAt: null, pending: 0, total: null };
  /** called on every visible data change ('data') or status change ('meta') */
  onDirty: (what: 'data' | 'meta') => void = () => {};
  /** set by the loader; refetch() delegates to it */
  loader: { refetch(): Promise<void> } | null = null;
  /** while set, upsert/patch/remove are recorded instead of applied (optimistic changes) */
  recording: Op[] | null = null;
  /** set by pagination: base total from the last load */
  baseTotal: number | null = null;

  private base = new Map<string, T>();
  private single: T | null = null;
  private layers: Array<{ id: number; ops: Op[] }> = [];
  private nextLayer = 1;
  private view: { list: readonly T[]; map: Map<string, T>; single: T | null } | null = null;
  private listeners = new Set<(c: Change<T>) => void>();
  private readonly orderField: string | null;
  private readonly desc: boolean;

  constructor(readonly name: string, readonly opts: ResourceOptions) {
    const o = opts.order;
    this.desc = !!o && o.startsWith('-');
    this.orderField = o ? o.replace(/^-/, '') : null;
  }

  get isCollection(): boolean {
    return this.opts.key !== null;
  }

  keyOf(item: T | string): string {
    if (typeof item === 'string') return item;
    const fields = this.opts.key;
    if (!fields) return '';
    if (this.opts.dev) {
      for (const f of fields) {
        if ((item as Record<string, unknown>)[f] === undefined) this.opts.warn?.(`resource \`${this.name}\`: item is missing key field \`${f}\``, item);
      }
    }
    return fields.map((f) => String((item as Record<string, unknown>)[f])).join(SEP);
  }

  // ---- reads (base + layers)

  get(key: string | T): T | undefined {
    if (!this.isCollection) return (this.visible().single ?? undefined) as T | undefined;
    return this.visible().map.get(this.keyOf(key));
  }

  all(): readonly T[] {
    return this.visible().list;
  }

  /** What expressions see: the ordered array, or the single object (null when absent). */
  value(): readonly T[] | T | null {
    return this.isCollection ? this.visible().list : this.visible().single;
  }

  has(key: string | T): boolean {
    return this.get(key) !== undefined;
  }

  // ---- base writes

  replace(items: T[] | T | null): void {
    if (this.isCollection) {
      const list = Array.isArray(items) ? items : [];
      if (this.opts.dev && !Array.isArray(items)) this.opts.warn?.(`resource \`${this.name}\`: expected an array of items`, items);
      this.base = new Map();
      for (const item of list) {
        const it = this.prepare(item);
        const k = this.keyOf(it);
        if (this.opts.dev && this.base.has(k)) this.opts.warn?.(`resource \`${this.name}\`: duplicate key \`${k.split(SEP).join(',')}\`; the last one wins`, item);
        this.base.delete(k);
        this.base.set(k, it);
      }
    } else {
      this.single = items == null ? null : this.prepare(items as T);
    }
    this.changed();
    this.emit({ resource: this.name, op: 'refetch' });
  }

  upsert(item: T): void {
    if (this.recording) { this.recording.push({ op: 'upsert', item }); return; }
    this.applyBase({ op: 'upsert', item });
    this.emit({ resource: this.name, op: 'upsert', item });
  }

  patch(key: string | T, fields: Partial<T>): void {
    const k = this.keyOf(key);
    if (this.recording) { this.recording.push({ op: 'patch', key: k, fields }); return; }
    this.applyBase({ op: 'patch', key: k, fields });
    this.emit({ resource: this.name, op: 'patch', key: k, fields });
  }

  remove(key: string | T): void {
    const k = this.keyOf(key);
    if (this.recording) { this.recording.push({ op: 'remove', key: k }); return; }
    this.applyBase({ op: 'remove', key: k });
    this.emit({ resource: this.name, op: 'remove', key: k });
  }

  refetch(): Promise<void> {
    return this.loader ? this.loader.refetch() : Promise.resolve();
  }

  subscribe(fn: (change: Change<T>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Applies a change message to the base. */
  apply(change: Change<T>): void {
    switch (change.op) {
      case 'upsert': return this.upsert(change.item);
      case 'patch': return this.patch(change.key, change.fields);
      case 'remove': return this.remove(change.key);
      case 'refetch': void this.refetch(); return;
    }
  }

  // ---- layers

  addLayer(ops: Op[]): number {
    const id = this.nextLayer++;
    this.layers.push({ id, ops });
    this.meta.pending = this.layers.length;
    this.changed();
    return id;
  }

  dropLayer(id: number): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.meta.pending = this.layers.length;
    this.changed();
  }

  // ---- internals

  setTotal(total: number | null): void {
    this.baseTotal = total;
    this.changed();
  }

  private prepare(item: T): T {
    return this.opts.dev ? deepFreeze(item) : item;
  }

  private applyBase(op: Op): void {
    if (this.isCollection) applyOp(this.base, op, this, null);
    else this.single = applySingle(this.single, op, this);
    this.changed();
  }

  changed(): void {
    this.view = null;
    this.onDirty('data');
  }

  private visible() {
    if (this.view) return this.view;
    let total = this.baseTotal;
    if (!this.isCollection) {
      let v = this.single;
      for (const l of this.layers) for (const op of l.ops) v = applySingle(v, op, this);
      this.view = { list: [], map: new Map(), single: v };
    } else {
      let map = this.base;
      if (this.layers.length) {
        map = new Map(this.base);
        const counter = { removed: 0 };
        for (const l of this.layers) for (const op of l.ops) applyOp(map, op, this, counter);
        if (total !== null) total = Math.max(0, total - counter.removed);
      }
      let list = [...map.values()];
      if (this.orderField) list = this.sort(list);
      this.view = { list: Object.freeze(list), map, single: null };
    }
    if (this.meta.total !== total) {
      this.meta.total = total;
      this.onDirty('meta');
    }
    return this.view;
  }

  private sort(list: T[]): T[] {
    const f = this.orderField!;
    const collator = new Intl.Collator(this.opts.locale?.(), { numeric: true });
    const dir = this.desc ? -1 : 1;
    return list.sort((a, b) => {
      const x = (a as Record<string, unknown>)[f], y = (b as Record<string, unknown>)[f];
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      if (typeof x === 'string' && typeof y === 'string') return collator.compare(x, y) * dir;
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }

  private emit(change: Change<T>): void {
    for (const fn of this.listeners) fn(change);
  }

  /** Freezes merged objects in dev builds. */
  freeze(item: T): T {
    return this.prepare(item);
  }
}

function applyOp<T extends object>(map: Map<string, T>, op: Op, r: Resource<T>, counter: { removed: number } | null): void {
  switch (op.op) {
    case 'upsert': {
      const item = r.freeze(op.item);
      const k = r.keyOf(item);
      map.set(k, item);
      return;
    }
    case 'patch': {
      const cur = map.get(op.key);
      if (!cur) return;
      map.set(op.key, r.freeze({ ...cur, ...clean(op.fields) }));
      return;
    }
    case 'remove':
      if (map.delete(op.key) && counter) counter.removed++;
      return;
  }
}

function applySingle<T extends object>(cur: T | null, op: Op, r: Resource<T>): T | null {
  switch (op.op) {
    case 'upsert': return r.freeze(op.item);
    case 'patch': return cur ? r.freeze({ ...cur, ...clean(op.fields) }) : cur;
    case 'remove': return null;
  }
}
