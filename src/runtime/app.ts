// The runtime: mounts a compiled page, owns the store, the scheduler, the
// renderer, delegated events, actions and resource loading. Written as one
// closure so private state minifies to short local names.
import type { ActionDef, Binding, Fn, IR, NodeDef, ResourceDef, TemplateDef, UrlTemplate } from '../ir.js';
import { config, SinterError, type Middleware } from './config.js';
import type { Env } from './env.js';
import { createRequestLayer, isAbort, toError, type RequestLayer, type SendInit } from './request.js';
import { BAD_KEY, encodeSegment, schemesOf, STYLE_BAD, urlAllowed } from './security.js';
import { clean, createResource, type Resource } from './store.js';

export interface Feature {
  name: string;
  install(app: App): void;
}

export interface MountOptions {
  ir: IR;
  fns: Fn[];
  features?: Feature[];
  /** overrides for the testing module */
  env?: Env;
  request?: Middleware[];
  /** stream transports by URL (testing); default: EventSource */
  transport?: (url: string) => Transport | undefined;
}

/** A server event transport: SSE today, a shared worker later. */
export interface Transport {
  connect(url: string, onEvent: (name: string, data: string) => void, onState: (state: 'open' | 'error') => void, names: string[]): void;
  /** start delivering another event name (islands subscribing later) */
  listen?(name: string): void;
  close(): void;
}

export interface StateHandle<T = any> {
  get(): T;
  update(fn: (state: T) => void): void;
}

/** A binding attached to one element in one scope. */
export interface BoundBinding {
  b: Binding;
  el: Element;
  s: any;
}

/** Pagination state of one resource; a "move" is one page request, repeated exactly by refetch. */
export interface Pager {
  reset(): void;
  current(): unknown;
  params(move: unknown): Record<string, string> | null;
  appends(move: unknown): boolean;
  received(items: unknown[], total: number | null, move: unknown): void;
}

export interface ResourceLoader {
  def: ResourceDef;
  res: Resource;
  app: App;
  pager: Pager | null;
  load(move?: unknown): Promise<void>;
  refetch(): Promise<void>;
}

export interface App {
  readonly ir: IR;
  readonly fns: Fn[];
  readonly env: Env;
  readonly req: RequestLayer;
  /** the base scope: resources, status, magic names */
  readonly page: any;
  readonly transport: (url: string) => Transport | undefined;
  readonly ext: {
    optimistic?: { begin(fn: number, scope: any): () => void };
    paginate?: { pager(loader: ResourceLoader): Pager; page(name: string, target: string | number): void };
    persist?: {
      model(rb: BoundBinding, set: (v: unknown) => void): void;
      state(key: string, obj: Record<string, unknown>): void;
      saveState(key: string, obj: Record<string, unknown>): void;
    };
  };
  readonly beforeFlush: Array<(dirty: string[][]) => void>;
  readonly afterFlush: Array<(dirty: string[][]) => void>;
  readonly onListen: Array<(event: string) => void>;
  /** root state scopes: [sid, state object] */
  readonly states: Array<[number, any]>;
  /** pending debounce timers and waiting actions, for the testing module */
  busy: number;
  readonly isDirty: boolean;
  /** dev hooks: warnings by code (or text), and item preparation (freezing) */
  warn(code: number | string, ...args: unknown[]): void;
  prep?: <T>(item: T) => T;

  resource<T extends object = any>(name: string): Resource<T>;
  request(url: string, init?: SendInit): Promise<unknown>;
  optimistic<T>(change: () => void, run: () => Promise<T>): Promise<T>;
  on(event: string, fn: (payload: any) => void): () => void;
  state<T = any>(el: Element): StateHandle<T>;
  destroy(): void;

  url(tpl: UrlTemplate, scope: any): string;
  mark(path: string, scope?: any): void;
  flush(): void;
  record(change: () => void): () => void;
  storeFns(el: Element | null): Record<string, (...a: any[]) => unknown>;
  serverEvent(name: string, payload: unknown): void;
  addCleanup(fn: () => void): void;
}

/** Runtime binding: the bound binding plus last value and list/conditional state. */
interface RB extends BoundBinding {
  v?: unknown;
  /** evaluation scope: the binding's scope plus `$el`, created once */
  e?: any;
  /** for: rows; if: the rendered branch (0 or 1 entries) */
  rows?: Inst[];
  t?: TemplateDef;
  /** end marker of the rows / branch, inserted after the template anchor */
  end?: Comment;
  /** for: rows by key (when every key is unique and computed without a scope) and the round of the last reconcile */
  keys?: Map<string, Inst> | null;
  rr?: number;
  /** if: rendered branch (0 none, 1 if, 2 else), and the else anchor with its template */
  br?: number;
  else?: [Element, number] | null;
}

interface Inst {
  first: Node | null;
  nodes: Node[];
  rbs: RB[];
  s: any;
  key: string;
  item: unknown;
  i: number;
  /** re-evaluate every binding on the next walk */
  f: boolean;
  /** flush round it was created in */
  r: number;
}

interface ActState {
  n: number;
  q: Array<() => void>;
  w: { run: () => void; drop: () => void } | null;
  c: AbortController | null;
  t: unknown;
  off: HTMLInputElement[] | null;
}

const instances = new WeakMap<object, App>();
const paths = new Map<string, string[]>();
const split = (p: string) => paths.get(p) ?? (paths.set(p, p.split('.')), paths.get(p)!);
/**
 * A dependency path: segments, scope names of `{name}` segments, and the position and
 * template of the row's own element `{$i<tid>}` (-1 if none).
 */
interface Dep { p: string[]; n: Array<string | undefined>; a: number; t: number }
const compiled = new WeakMap<object, Dep[]>();
const toDeps = (list: string[]) => list.map((d) => {
  const p = d.split('.'), a = p.findIndex((x) => x.startsWith('{$'));
  return { p, n: p.map((x) => (x[0] == '{' ? x.slice(1, -1) : undefined)), a, t: a < 0 ? -1 : +p[a]!.slice(3, -1) };
});
const depsOf = (key: object, list: string[] = []) => compiled.get(key) ?? (compiled.set(key, toDeps(list)), compiled.get(key)!);
/** Sentinel for "not written yet". */
const UNSET = {};
/** Fills `{name}` segments from a scope. */
const fill = (p: string, s?: any) => (s && p.includes('{') ? split(p).map((x) => (x[0] == '{' ? '' + s[x.slice(1, -1)] : x)) : split(p));
const range = (a: Node | null, stop: Node | null) => {
  const out: Node[] = [];
  for (let n = a; n && n != stop; n = n.nextSibling) out.push(n);
  return out;
};
const child = (s: any, props: object) => Object.assign(Object.create(s), props);
const after = (el: Element) => {
  const c = new Comment();
  el.after(c);
  return c;
};
const ET = EventTarget.prototype;

/** The instance mount() created on `root`; throws if none. */
export function instance(root: Document | Element): App {
  const app = instances.get(root);
  if (!app) throw Error('sinter: not mounted');
  return app;
}

export function mount(root: Document | Element, o: MountOptions): App {
  if (instances.has(root)) throw Error('sinter: already mounted');
  const { ir, fns } = o;
  if (ir?.v != 1) throw Error('sinter: unsupported IR');
  const env = o.env ?? config.env;
  const req = createRequestLayer(env, o.request ?? config.request);
  const schemes = schemesOf(config.urlSchemes);
  const resources = new Map<string, Resource>(), loaders: Array<{ def: ResourceDef; changed(): void; start(): void }> = [];
  const handlers = new WeakMap<Element, RB[]>(), models = new WeakMap<Element, RB>(), stateEls = new WeakMap<Element, [number, any]>();
  const acts = new WeakMap<Element, ActState>(), identities = new WeakMap<object, number>();
  const types = new Set<string>(), selects = new Set<RB>(), deferred = new Set<RB>();
  const listeners = new Map<string, Set<(p: unknown) => void>>(), cleanups: Array<() => void> = [];
  const shared = new Map<string, { n: number; c: AbortController; p: Promise<unknown> }>();
  const rootRbs: RB[] = [], rootScopes: any[] = [], found = new Map<number, Element>();
  let dirty: string[][] = [], cur: string[][] = [], scheduled = false, flushing = false, lastId = 0, round = 0;

  const res = (name: string): Resource => {
    const r = resources.get(name);
    if (!r) throw Error(`sinter: no resource ${name}`);
    return r;
  };
  const forward = (m: 'upsert' | 'patch' | 'remove') => (n: string, ...a: [any, any?]) => res(n)[m](...a);
  const warn = (code: number | string, ...args: unknown[]) => app.warn(code, ...args);
  const evaluate = (rb: RB): any => {
    try { return fns[rb.b.f!]!(rb.b.e ? (rb.e ??= child(rb.s, { $el: rb.el })) : rb.s); } catch (e) { warn(6, rb.b.k, rb.el.localName, (e as Error)?.message); }
  };
  /** Elements written through callbacks (`$.$m(row, …)`) since the last flush. */
  const marked = new Set<unknown>();
  /** Per flush round: how dirty paths reach a template's rows (0 not, 1 only marked elements, 2 any row). */
  let rowHits = new Map<TemplateDef, number>();

  /**
   * Whether a dependency (its `{name}` segments read from scope `s`, or any scope when `s` is
   * absent) and dirty path `d` are prefixes of each other; `*` matches any segment. A change
   * that ends above a row's own element, or only changes the list structure (`#`), does not
   * reach it: reconcile re-evaluates rows whose item or index changed. `~` reaches only rows
   * whose element was marked.
   */
  const overlaps = (dep: Dep, d: string[], s?: any) => reach(dep, d, s) > 0;

  /** 0: no overlap; 1: only through a marked element (`~`) of the row; 2: overlap. */
  function reach({ p, n, a, t }: Dep, d: string[], s?: any): number {
    if (a >= 0 && d.length <= a) return 0;
    let via = 2;
    for (let i = 0, len = Math.min(p.length, d.length); i < len; i++) {
      const y = d[i]!;
      if (y == '#' || y == '~') {
        if (i != a) continue;
        if (y == '#' || (s && !marked.has(s[ir.templates[t]!.item!]))) return 0;
        via = 1;
        continue;
      }
      if (y == '*' || (n[i] !== undefined && !s)) continue;
      if (n[i] !== undefined ? s[n[i]!] != y : p[i] != y && p[i] != '*') return 0;
    }
    return s ? 2 : via;
  }

  /** Dependencies of every binding in a template's rows, nested templates included. */
  const templateDeps = (t: TemplateDef): Dep[] => compiled.get(t) ?? (compiled.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...depsOf(b, b.d),
    ...(b.k == 'for' || b.k == 'if' || b.k == 'else' ? templateDeps(ir.templates[b.x!]!) : []),
  ]))), compiled.get(t)!);

  /** Whether any of `deps` overlaps a dirty path of the current flush. */
  const hit = (deps: Dep[], s?: any) => {
    for (const dep of deps) for (const d of cur) if (overlaps(dep, d, s)) return true;
    return false;
  };

  const app: App = {
    ir, fns, env, req, transport: o.transport ?? (() => undefined), ext: {},
    beforeFlush: [], afterFlush: [], onListen: [], states: [], busy: 0,
    get isDirty() { return dirty.length > 0 || scheduled; },
    warn() {},
    page: {
      $r: {}, $meta: {}, $url: readUrl(), $now: new Date(env.now()),
      $m: (el: unknown, v: unknown) => (marked.add(el), v),
      get $locale() { return config.locale?.get(); },
      set $locale(v: any) { config.locale?.set(v); app.mark('$locale'); },
    },
    resource: res as App['resource'],
    request: (url, init) => req.send(url, init),
    async optimistic(change, run) {
      const drop = app.record(change);
      try { return await run(); } finally { drop(); }
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      for (const l of app.onListen) l(event);
      return () => listeners.get(event)!.delete(fn);
    },
    state(el) {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = stateEls.get(e);
        if (s) return { get: () => s[1], update: (fn) => { fn(s[1]); app.mark('$s' + s[0]); } };
      }
      throw Error('sinter: no data-sn-state scope');
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
      instances.delete(root);
    },
    url(tpl, s) {
      let out = '', query = false;
      for (const p of tpl) {
        if (typeof p == 'string') { out += p; query ||= /[?#]/.test(p); continue; }
        const v = fns[p]!(s);
        // URL parsers turn %2E%2E back into `..`, so a path value cannot be a dot segment at all
        if (!query && (v == '.' || v == '..')) throw new SinterError(0, null, `refused \`${v}\` as a URL path value`);
        out += encodeSegment(v);
      }
      return out;
    },
    mark(path, s) {
      dirty.push(fill(path, s));
      if (!scheduled && !flushing) { scheduled = true; env.queueMicrotask(app.flush); }
    },
    flush() {
      scheduled = false;
      if (flushing) return;
      flushing = true;
      try {
        for (let pass = 0; dirty.length && pass < 100; pass++) {
          cur = dirty;
          dirty = [];
          for (const h of app.beforeFlush) h(cur);
          round++;
          rowHits = new Map();
          for (const l of loaders) if (hit(depsOf(l.def, l.def.deps))) l.changed();
          walk(rootRbs, false);
          syncSelects();
          for (const h of app.afterFlush) h(cur);
        }
      } finally {
        cur = dirty = [];
        marked.clear();
        flushing = false;
      }
    },
    record(change) {
      const rs = [...resources.values()];
      for (const r of rs) r.recording = [];
      let recs;
      try { change(); } finally { recs = rs.map((r) => [r, r.recording!] as const); for (const r of rs) r.recording = null; }
      const ids = recs.filter(([, ops]) => ops.length).map(([r, ops]) => [r, r.addLayer(ops)] as const);
      let done = false;
      return () => { if (!done) { done = true; for (const [r, id] of ids) r.dropLayer(id); } };
    },
    storeFns: (el) => ({
      refresh: (n: string) => res(n).refetch(),
      upsert: forward('upsert'),
      patch: forward('patch'),
      remove: forward('remove'),
      page: (n: string, t: string | number) => app.ext.paginate!.page(n, t),
      close: () => el?.closest('dialog')?.close(),
      reset: () => {
        const form = el?.closest('form');
        if (!form) return;
        form.reset();
        for (const c of form.elements) { const rb = models.get(c); if (rb) setModel(rb, readModel(rb)); }
      },
      emit: (n: string, detail?: unknown) => el?.dispatchEvent(new CustomEvent(n, { detail, bubbles: true })),
    }),
    serverEvent(name, payload) {
      for (const fn of listeners.get(name) ?? []) try { fn(payload); } catch (e) { console.error(e); }
    },
    addCleanup: (fn) => void cleanups.push(fn),
  };
  app.page.$f = app.storeFns(null);
  instances.set(root, app);
  for (const f of o.features ?? []) f.install(app);

  // ---- mount: one querySelectorAll, ids checked against the IR's tags
  const qsa = (root instanceof Document ? Document : Element).prototype.querySelectorAll;
  const bad = new Set<number>();
  for (const el of qsa.call(root, '[data-sn]')) {
    const id = +Element.prototype.getAttribute.call(el, 'data-sn')!;
    found.has(id) ? bad.add(id) : found.set(id, el);
  }
  for (const id of bad) { found.delete(id); warn(1, id); }
  for (const def of ir.resources) createLoader(def);
  listen('toggle');
  bindNodes(ir.roots, ir.roots.map((nd) => {
    const el = found.get(nd.id!);
    if (el?.localName == nd.tag) return el;
    warn(el ? 3 : 2, nd.id, el?.localName, nd.tag);
    return null;
  }), app.page, rootRbs);
  cleanups.push(env.listen('popstate', () => {
    const u = app.page.$url;
    for (const k in u) delete u[k];
    Object.assign(u, readUrl());
    app.mark('$url');
  }));
  if (ir.now) {
    let t: unknown;
    const tick = () => { t = env.setTimeout(() => { app.page.$now = new Date(env.now()); app.mark('$now'); tick(); }, 60_000, 'clock'); };
    tick();
    cleanups.push(() => env.clearTimeout(t));
  }
  for (const l of loaders) l.start();
  flushing = true;
  try { walk(rootRbs, true); syncSelects(); for (const h of app.afterFlush) h([]); } finally { flushing = false; }
  if (dirty.length) { scheduled = true; env.queueMicrotask(app.flush); }
  return app;

  // ---- scopes and bindings

  function readUrl() {
    const out = Object.create(null);
    for (const [k, v] of new URL(env.href()).searchParams) if (!BAD_KEY.test(k)) out[k] = v;
    return out;
  }

  function writeUrl() {
    const u = new URL(env.href()), q = new URLSearchParams();
    for (const [k, v] of Object.entries(app.page.$url)) if (v != null && v !== '') q.set(k, '' + v);
    u.search = '' + q;
    env.replaceState(u.pathname + u.search + u.hash);
  }

  /** One delegated capture listener per used event type, at the mount root. */
  function listen(type: string) {
    if (types.has(type)) return;
    types.add(type);
    ET.addEventListener.call(root, type, dispatch, true);
    cleanups.push(() => ET.removeEventListener.call(root, type, dispatch, true));
  }

  function bindNodes(defs: NodeDef[], els: Array<Element | null>, base: any, rbs: RB[]) {
    const scopes: any[] = [];
    defs.forEach((nd, i) => {
      const el = els[i];
      let s = scopes[nd.p] ?? base;
      if (nd.state != null && el) {
        const obj = fns[nd.state]!(s), sid = nd.sid!, key = nd.persist;
        s = child(s, { ['$s' + sid]: obj });
        stateEls.set(el, [sid, obj]);
        if (rbs == rootRbs) app.states.push([sid, obj]);
        if (key) {
          app.ext.persist?.state(key, obj);
          app.afterFlush.push((d) => d.some((p) => p[0] == '$s' + sid) && app.ext.persist?.saveState(key, obj));
        }
      }
      scopes[i] = s;
      if (rbs == rootRbs) rootScopes[i] = s;
      if (el) for (const b of nd.b) {
        const rb: RB = { b, el, s, v: UNSET };
        if (b.k == 'on') {
          handlers.get(el)?.push(rb) ?? handlers.set(el, [rb]);
          listen(b.n!);
          continue;
        }
        if (b.k == 'else') continue;
        if (b.k == 'model') {
          models.set(el, rb);
          listen('input');
          listen('change');
          if (el.localName == 'select') selects.add(rb);
          if (b.p != null) app.ext.persist?.model(rb, (v) => setModel(rb, v));
        }
        if (b.k == 'for') { rb.rows = []; rb.t = ir.templates[b.x!]; }
        if (b.k == 'if') { rb.br = 0; rb.else = b.y != null && els[b.y] ? [els[b.y]!, defs[b.y]!.b.find((x) => x.k == 'else')!.x!] : null; }
        rbs.push(rb);
      }
    });
  }

  // ---- rendering

  function walk(rbs: RB[], force: boolean) {
    for (const rb of rbs) {
      if (!process(rb, force) || !rb.rows) continue;
      const t = rb.t;
      let r = force || !t ? 2 : rowHits.get(t);
      if (r == null) {
        r = 0;
        // a mark counts as "only marked rows" for dependencies on this list's own element; others (outer rows) reach any row
        for (const dep of templateDeps(t!)) for (const d of cur) { const x = reach(dep, d); r = Math.max(r, x == 1 && dep.t != t!.id ? 2 : x); }
        rowHits.set(t!, r);
      }
      // only marked elements changed and the list did not move: visit their rows directly
      if (r == 1 && rb.keys && rb.rr != round) {
        for (const item of marked) {
          const x = Object(item) === item ? rb.keys.get(keyOf(t!, item, null)) : null;
          if (x && x.item === item) walk(x.rbs, false);
        }
        continue;
      }
      // otherwise skip rows no dirty path can reach (unless they moved or changed), and rows created in this round
      for (const x of rb.rows) if (x.r != round && (r || x.f)) { walk(x.rbs, force || x.f); x.f = false; }
    }
  }

  /** Evaluates and writes one binding if needed; false while it waits in a closed dialog. */
  function process(rb: RB, force: boolean): boolean {
    if (!force && !deferred.has(rb) && !(rb.b.d && hit(depsOf(rb.b, rb.b.d), rb.s))) return true;
    if (rb.el.closest('dialog:not([open])')) { deferred.add(rb); return false; }
    if (deferred.delete(rb)) force = true;
    const v = evaluate(rb), k = rb.b.k;
    if (k == 'for') reconcile(rb, v);
    else if (k == 'if') toggle(rb, v ? 1 : rb.else ? 2 : 0);
    else if (k == 'model') writeModel(rb, v);
    else if (!Object.is(v, rb.v)) { write(rb, v, rb.v == UNSET ? undefined : rb.v); rb.v = v; }
    return true;
  }

  function write(rb: RB, v: any, prev: any) {
    const el = rb.el as HTMLElement, n = rb.b.n!;
    switch (rb.b.k) {
      case 'text': {
        const t = el.firstChild as Text | null;
        v = '' + (v ?? '');
        if (t?.nodeType == 3 && !t.nextSibling) t.data = v;
        else el.textContent = v;
        break;
      }
      case 'show': el.hidden = !v; break;
      case 'prop': (el as any)[n] = v; break;
      case 'class':
        if (n) el.classList.toggle(n, !!v);
        else {
          if (prev?.[0] && prev[0] != v?.[0]) el.classList.remove(prev[0]);
          if (v?.[0]) el.classList.toggle(v[0], !!v[1]);
        }
        break;
      case 'attr':
        if (v == null || v === false) el.removeAttribute(n);
        else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), /^https?:/.test(el.baseURI) ? el.baseURI : env.href(), schemes)) el.setAttribute(n, v);
        else { el.removeAttribute(n); warn(7, n, el.localName, v); }
        break;
      case 'style':
        if (v == null || v === false) el.style.removeProperty(n);
        else if (STYLE_BAD.test(v)) { el.style.removeProperty(n); warn(8, n, v); }
        else el.style.setProperty(n, v);
    }
  }

  function syncSelects() {
    for (const rb of selects) writeModel(rb, evaluate(rb));
  }

  // ---- models

  function writeModel(rb: RB, v: any) {
    const el = rb.el as HTMLInputElement & HTMLSelectElement, k = rb.b.n;
    const has = (x: string) => Array.isArray(v) && v.map(String).includes(x);
    if (k == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
    else if (k == 'radio') el.checked = v != null && '' + v == el.value;
    else if (k == 'multi') for (const opt of el.options) opt.selected = has(opt.value);
    // loose comparison: '1.0' == 1 keeps a number input's text as typed
    else if (el.value != (v ?? '')) el.value = v ?? '';
  }

  /** The control's value for its model; undefined for an unchecked radio. */
  function readModel(rb: RB): unknown {
    const el = rb.el as HTMLInputElement & HTMLSelectElement, k = rb.b.n;
    if (k == 'number') return el.value === '' ? null : +el.value;
    if (k == 'radio') return el.checked ? el.value : undefined;
    if (k == 'multi') return [...el.selectedOptions].map((x) => x.value);
    if (k != 'checkbox') return el.value;
    const cur = evaluate(rb);
    if (!Array.isArray(cur)) return el.checked;
    const i = cur.map(String).indexOf(el.value);
    if (el.checked && i < 0) cur.push(el.value);
    if (!el.checked && i >= 0) cur.splice(i, 1);
    return cur;
  }

  function setModel(rb: RB, v: unknown) {
    if (v === undefined) return;
    try { fns[rb.b.a!]!(rb.s, v); } catch (e) { return warn(9, rb.el.localName, (e as Error)?.message); }
    for (const w of rb.b.w ?? []) app.mark(w, rb.s);
  }

  // ---- lists and conditionals

  function setRow(s: any, t: TemplateDef, item: unknown, i: number) {
    s[t.item!] = item;
    if (t.index) s[t.index] = i;
    s[t.ii!] = i;
    return s;
  }

  function keyOf(t: TemplateDef, item: any, s: any): string {
    if (t.key != null) return 'k' + fns[t.key]!(s);
    if (t.keyFields && item) return 'r' + t.keyFields.map((f) => item[f]).join('\x1f');
    if (Object(item) === item) return 'o' + (identities.get(item) ?? (identities.set(item, ++lastId), lastId));
    warn(10);
    return 'p' + typeof item + item;
  }

  function reconcile(rb: RB, v: any) {
    const t = rb.t!, old = rb.rows!, end = (rb.end ??= after(rb.el));
    const items: unknown[] = v == null ? [] : Array.isArray(v) ? v : Symbol.iterator in Object(v) ? [...v] : [];
    // each row owns the nodes from its first node up to the next row's first node
    const nodes = new Map(old.map((x, i) => [x, range(x.first, old[i + 1]?.first ?? end)]));
    const byKey = new Map(old.map((x) => [x.key, x])), pos = new Map(old.map((x, i) => [x, i])), seen = new Set<string>();
    let dup = false;
    const rows = items.map((item, i) => {
      const s = setRow(Object.create(rb.s), t, item, i);
      let key = keyOf(t, item, s);
      while (seen.has(key)) { warn(11, key.slice(1)); key += '#'; dup = true; }
      seen.add(key);
      const x = byKey.get(key);
      if (!x) return instantiate(rb.el as HTMLTemplateElement, t, s, key, item, i);
      byKey.delete(key);
      if (x.item !== item || x.i != i) { setRow(x.s, t, (x.item = item), (x.i = i)); x.f = true; }
      return x;
    });
    for (const x of byKey.values()) remove(x, nodes.get(x)!);
    // move the fewest rows: those outside a longest increasing subsequence of old positions
    const keep = lis(rows.map((x) => pos.get(x) ?? -1));
    let ref: Node = end;
    for (let i = rows.length; i--;) {
      const x = rows[i]!;
      if (!keep.has(i)) (ref as ChildNode).before(...(nodes.get(x) ?? x.nodes));
      ref = x.first ?? ref;
    }
    rb.rows = rows;
    rb.rr = round;
    rb.keys = dup || t.key != null ? null : new Map(rows.map((x) => [x.key, x]));
  }

  function toggle(rb: RB, br: number) {
    if (br == rb.br) return;
    const end = (rb.end ??= after(rb.el)), [old] = rb.rows ?? [];
    if (old) remove(old, range(old.first, end));
    rb.br = br;
    rb.rows = [];
    if (!br) return;
    const [anchor, tid] = br == 1 ? [rb.el, rb.b.x!] : rb.else!;
    const x = instantiate(anchor as HTMLTemplateElement, ir.templates[tid]!, Object.create(rb.s), '', null, 0);
    end.before(...x.nodes);
    rb.rows = [x];
  }

  function instantiate(tpl: HTMLTemplateElement, t: TemplateDef, s: any, key: string, item: unknown, i: number): Inst {
    const frag = tpl.content.cloneNode(true) as DocumentFragment;
    const els = t.nodes.map((nd) => {
      let n: any = frag;
      for (const j of nd.path!) n = n?.childNodes[j];
      return n?.localName == nd.tag ? n : null;
    });
    const rbs: RB[] = [];
    bindNodes(t.nodes, els, s, rbs);
    walk(rbs, true);
    const nodes = [...frag.childNodes];
    return { first: nodes[0] ?? null, nodes, rbs, s, key, item, i, f: false, r: round };
  }

  function remove(x: Inst, nodes: Node[]) {
    for (const n of nodes) (n as ChildNode).remove();
    const forget = (rbs: RB[]) => { for (const rb of rbs) { deferred.delete(rb); selects.delete(rb); for (const r of rb.rows ?? []) forget(r.rbs); } };
    forget(x.rbs);
  }

  // ---- events

  function dispatch(e: Event) {
    let el = e.target as Element | null;
    if (el?.nodeType != 1) el = (el as Node | null)?.parentElement ?? null;
    if (!el) return;
    if (e.type == 'toggle' && el.localName == 'dialog' && el.hasAttribute('open')) {
      for (const rb of [...deferred]) if (deferred.has(rb) && el.contains(rb.el)) { cur = []; walk([rb], true); }
    }
    // models update state before other handlers on the same event
    const m = models.get(el);
    if (m && /^(input|change)$/.test(e.type) && (e.type == 'input') == (m.b.n == 'text')) setModel(m, readModel(m));
    for (; el; el = el.parentElement) {
      const hs = handlers.get(el)?.filter((h) => h.b.n == e.type);
      if (hs?.length) {
        for (const h of hs) h.b.x != null ? trigger(h, e) : handle(h, h.b.f!, e, h.b.w);
        return;
      }
      if (el == root) return;
    }
  }

  /** Runs a handler expression and invalidates what it may have changed. */
  function handle(rb: RB, f: number, e: Event | null, writes: string[] | undefined, extra?: object) {
    const s = child(rb.s, { $el: rb.el, $event: e, $f: app.storeFns(rb.el), ...extra });
    try { fns[f]!(s); } catch (err) { console.error(err); }
    for (const w of writes ?? []) app.mark(w, s);
    if (writes?.some((w) => w.startsWith('$url'))) writeUrl();
  }

  // ---- actions

  function trigger(rb: RB, e: Event) {
    const a = ir.actions[rb.b.x!]!, el = rb.el;
    if (e.type == 'submit' || el.localName == 'a' || (e.type == 'click' && /^(button|input)$/.test(el.localName) && el.closest('form'))) e.preventDefault();
    if (!a.debounce) return fire(rb, a, e);
    const st = act(el);
    if (st.t) { env.clearTimeout(st.t); app.busy--; }
    app.busy++;
    st.t = env.setTimeout(() => { st.t = null; app.busy--; fire(rb, a, e); }, a.debounce, 'debounce');
  }

  function act(el: Element): ActState {
    if (!acts.has(el)) acts.set(el, { n: 0, q: [], w: null, c: null, t: null, off: null });
    return acts.get(el)!;
  }

  function fire(rb: RB, a: ActionDef, e: Event) {
    const st = act(rb.el), get = a.method == 'GET';
    if (!get && a.concurrency == 'block' && st.n) return;
    const s = child(rb.s, { $el: rb.el, $event: e });
    let url: string, body: unknown;
    try {
      url = app.url(a.url, s);
      body = a.body != null ? fns[a.body]!(s) : a.form && !get && a.method != 'DELETE' ? serialize(rb.el as HTMLFormElement) : undefined;
    } catch (err) {
      return unhandled(toError(err), rb.el);
    }
    const drop = a.optimistic != null ? app.ext.optimistic!.begin(a.optimistic, s) : () => {};
    if (get) {
      st.c?.abort();
      return void send(rb, a, st, url, body, drop, (st.c = new AbortController()));
    }
    const run = () => void send(rb, a, st, url, body, drop);
    if (!st.n) run();
    else if (a.concurrency == 'latest') { st.w ? st.w.drop() : app.busy++; st.w = { run, drop }; }
    else { app.busy++; st.q.push(run); }
  }

  async function send(rb: RB, a: ActionDef, st: ActState, url: string, body: unknown, drop: () => void, c?: AbortController) {
    const el = rb.el as HTMLFormElement;
    st.n++;
    el.setAttribute('aria-busy', 'true');
    if (a.form && a.concurrency == 'block' && !c && !st.off) {
      st.off = ([...el.elements] as HTMLInputElement[]).filter((x) => !x.disabled);
      for (const x of st.off) x.disabled = true;
    }
    try {
      const result = await req.send(url, { method: a.method, body, signal: c?.signal });
      if (c && st.c != c) return;
      drop();
      if (a.then != null) handle(rb, a.then, null, a.w, { $result: result });
    } catch (err) {
      drop();
      if (isAbort(err) || (c && st.c != c)) return;
      const error = toError(err);
      a.catch != null ? handle(rb, a.catch, null, a.w, { $error: error }) : unhandled(error, el);
    } finally {
      if (c && st.c == c) st.c = null;
      if (!--st.n) {
        for (const x of st.off ?? []) x.disabled = false;
        st.off = null;
        const next = st.q.shift() ?? st.w?.run;
        if (next && next == st.w?.run) st.w = null;
        if (next) { app.busy--; next(); } else el.removeAttribute('aria-busy');
      }
    }
  }

  /** The unhandled-error path: `sn-error` event, then `onError`, then the dev console. */
  function unhandled(error: SinterError, el: Element | null, resource?: string) {
    const target = el ?? root, ev = new CustomEvent('sn-error', { detail: { error, element: target, resource }, bubbles: true, cancelable: true });
    ET.dispatchEvent.call(target, ev);
    if (ev.defaultPrevented) return;
    config.onError?.(error, target as Element);
    warn(16, resource ? ` loading \`${resource}\`` : '', error.message, error);
  }

  // ---- resources

  function createLoader(def: ResourceDef) {
    const r = createResource(def.name, { key: def.key, order: def.order, locale: () => config.locale?.get(), warn, prep: (x) => (app.prep ? app.prep(x) : x) });
    r.onDirty = (what) => app.mark((what == 'data' ? '$r.' : '$meta.') + def.name);
    resources.set(def.name, r);
    Object.defineProperty(app.page.$r, def.name, { get: r.value, enumerable: true });
    app.page.$meta[def.name] = r.meta;
    let url: string | null = null, c: AbortController | null = null, seq = 0, again: Promise<void> | null = null;

    const resolve = () => {
      const s = def.scope < 0 ? app.page : rootScopes[def.scope] ?? app.page;
      try { return def.when != null && !fns[def.when]!(s) ? null : app.url(def.src, s); } catch (e) { warn(17, def.name, (e as Error).message); return null; }
    };
    const loading = (on: boolean) => { if (r.meta.loading != on) { r.meta.loading = on; r.onDirty('meta'); } };
    const pick = (path: string | null, body: unknown): any => (path ? path.split('.').reduce((x: any, k) => x?.[k], body) : body);
    const store = (body: unknown, m = l.pager?.current()) => {
      let items = pick(def.items, body);
      if (r.isCollection && !Array.isArray(items)) { warn(12, def.name, def.items ?? '(response)'); items = []; }
      if (Array.isArray(items)) items = items.map(clean);
      const t = def.total ? pick(def.total, body) : null, total = t == null ? null : +t;
      l.pager?.appends(m) && r.isCollection ? items.forEach(r.upsert) : r.replace(items);
      r.setTotal(total);
      l.pager?.received(items, total, m);
    };

    const l = {
      def, res: r, app, pager: null as Pager | null,
      start() {
        const el = def.data != null ? found.get(def.data) : null;
        let data;
        if (el) {
          if (el.localName == 'script' && el.parentElement?.localName == 'head') try { data = { v: JSON.parse(el.textContent!) }; } catch { warn(5, def.name); }
          else warn(4, def.name);
        }
        url = data ? resolve() : null;
        if (url == null) return l.changed();
        l.pager?.reset();
        store(data!.v);
        r.meta.loadedAt = env.now();
      },
      /** `src` or `when` may have changed: reload from the first page if the URL differs. */
      changed() {
        const u = resolve();
        if (u === url) return;
        url = u;
        l.pager?.reset();
        if (u != null) return void l.load();
        c?.abort();
        r.replace(r.isCollection ? [] : null);
        loading(false);
      },
      /** Repeats the current request; several calls in one task share one request. */
      refetch: () => (again ??= Promise.resolve().then(() => { again = null; return l.load(); })),
      async load(move?: unknown) {
        if (url == null) return;
        c?.abort();
        const ctl = (c = new AbortController()), n = ++seq, m = l.pager && (move ?? l.pager.current());
        loading(true);
        try {
          const body = await loadShared(withParams(url, m ? l.pager!.params(m) : null), ctl.signal);
          if (n != seq) return;
          store(body, m);
          r.meta.error = null;
          r.meta.loadedAt = env.now();
        } catch (e) {
          if (n != seq || isAbort(e)) return;
          const error = toError(e);
          r.meta.error = error;
          r.onDirty('meta');
          unhandled(error, null, def.name);
        } finally {
          if (n == seq) { c = null; loading(false); }
        }
      },
    };
    if (def.paginate) l.pager = app.ext.paginate!.pager(l);
    r.loader = l;
    loaders.push(l);
  }

  /** GETs `url`; concurrent loads of one URL share one request, aborted when no one waits. */
  function loadShared(url: string, signal: AbortSignal): Promise<unknown> {
    let e = shared.get(url);
    if (!e) {
      const c = new AbortController(), entry = { n: 0, c, p: req.send(url, { signal: c.signal }) };
      entry.p.catch(() => {}).finally(() => shared.get(url) == entry && shared.delete(url));
      shared.set(url, (e = entry));
    }
    const entry = e;
    entry.n++;
    return new Promise((ok, no) => {
      let done = false;
      const leave = () => { done = true; entry.n--; signal.removeEventListener('abort', abort); };
      const abort = () => {
        if (done) return;
        leave();
        if (!entry.n) { entry.c.abort(); shared.delete(url); }
        no(new DOMException('', 'AbortError'));
      };
      signal.aborted ? abort() : signal.addEventListener('abort', abort);
      entry.p.then((v) => done || (leave(), ok(v)), (err) => done || (leave(), no(err)));
    });
  }
}

export function withParams(url: string, params: Record<string, string> | null): string {
  if (!params) return url;
  const [path, hash] = url.split('#'), [base, query] = path!.split('?'), q = new URLSearchParams(query);
  for (const k in params) q.set(k, params[k]!);
  return `${base}?${q}${hash ? '#' + hash : ''}`;
}

/** Indexes (into `seq`) of a longest increasing subsequence, ignoring -1 entries. */
export function lis(seq: number[]): Set<number> {
  const tails: number[] = [], prev: Array<number | undefined> = [];
  seq.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; seq[tails[m]!]! < v ? (lo = m + 1) : (hi = m); }
    prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const keep = new Set<number>();
  for (let k = tails.at(-1); k != null; k = prev[k]) keep.add(k);
  return keep;
}

/** Serializes a form's named controls to nested JSON, or FormData if it has a file input. */
export function serialize(form: HTMLFormElement): unknown {
  const controls = [...form.elements] as Array<HTMLInputElement & { selectedOptions: HTMLCollectionOf<HTMLOptionElement> }>;
  if (controls.some((c) => c.type == 'file')) return new FormData(form);
  const out = Object.create(null), boxes: Record<string, number> = {};
  for (const c of controls) if (c.type == 'checkbox') boxes[c.name] = (boxes[c.name] ?? 0) + 1;
  for (const c of controls) {
    const { name, type } = c, segs = name?.match(/[^.[\]]+/g);
    if (!segs || c.disabled || /^(submit|button|reset|image|fieldset|output)$/.test(type) || (type == 'radio' && !c.checked) || segs.some((s) => BAD_KEY.test(s))) continue;
    const k = segs.pop()!;
    let o = out;
    segs.forEach((s, i) => (o = o[s] ??= /^\d+$/.test(segs[i + 1] ?? k) ? [] : Object.create(null)));
    if (type == 'checkbox' && boxes[name]! > 1) (o[k] ??= []).push(...(c.checked ? [c.value] : []));
    else o[k] = type == 'checkbox' ? c.checked
      : /^(number|range)$/.test(type) ? (c.value === '' ? null : +c.value)
      : type == 'select-multiple' ? [...c.selectedOptions].map((x) => x.value)
      : c.value;
  }
  return out;
}
