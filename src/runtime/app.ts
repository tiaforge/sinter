// The runtime: mounts a compiled page, owns the store, the scheduler, the
// renderer, delegated events, actions and resource loading. Written as one
// closure so private state minifies to short local names.
import type { ActionDef, Binding, Fn, IR, NodeDef, ResourceDef, TemplateDef, UrlTemplate } from '../ir.js';
import { config, SinterError, type Middleware } from './config.js';
import { envOf, type Env } from './env.js';
import { prefetched } from './handoff.js';
import { createRequestLayer, isAbort, toError, type RequestLayer, type SendInit } from './request.js';
import { BAD_KEY, schemesOf, STYLE_BAD, urlAllowed } from './security.js';
import { expand, readUrl as readFrom } from './url.js';
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
  /** stream transports by URL (testing); then `configure({ transport })`; default: EventSource */
  transport?: (url: string) => Transport | undefined;
}

/**
 * A server event transport (EventSource, WebSocket, SignalR, …). It delivers named events with
 * their parsed payload and reports `open` once connected and `error` when the connection is lost;
 * reconnecting (session probe, backoff, refetch) is the caller's job, so a transport never
 * reconnects by itself. `names` are the event names the page maps; deliver at least those.
 */
export interface Transport {
  connect(url: string, onEvent: (name: string, payload: unknown) => void, onState: (state: 'open' | 'error') => void, names: string[]): void;
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

/** The last argument of an action function (`data-sn-call`, `<sn-resource call>`). */
export interface CallContext {
  /** aborts when the page is hidden (pagehide) or, for a resource, when its inputs change */
  signal: AbortSignal;
  /** a request through the app's middleware chain (401 handling, origins, timeout) */
  request(url: string, init?: SendInit): Promise<unknown>;
  /** the element whose action this is; null for a resource */
  el: Element | null;
}

export interface ResourceLoader {
  def: ResourceDef;
  res: Resource;
  app: App;
  pager: Pager | null;
  /** first load (or embedded/cached data) */
  start(): void;
  /** `src`, `when` (or an `each` list) may have changed; `typing`: the change comes from a text field, so it waits for a pause */
  changed(typing?: boolean): void;
  /** the resolved URL of the current load (null: `when` is false, or not resolved yet) */
  url(): string | null;
  load(move?: unknown): Promise<void>;
  refetch(hint?: object): Promise<void>;
  /** for feature modules: the scope `src` and `when` are evaluated in */
  scope(): any;
  /** for feature modules: a shared GET (concurrent loads of one URL share one request) */
  get(url: string, signal: AbortSignal): Promise<unknown>;
  /** for feature modules: the collection items of a response body (`items` path, checked, cleaned) */
  items(body: unknown): any[];
  /** for feature modules: a failed load: `$meta.error`, then the unhandled-error path */
  failed(e: unknown): void;
  loading(on: boolean): void;
  /** for feature modules: a load stored `result` (what `items` selects): runs `then` */
  done(result: unknown): void;
}

export interface App {
  readonly ir: IR;
  readonly fns: Fn[];
  readonly env: Env;
  /** the element or document this instance is mounted on */
  readonly root: Document | Element;
  readonly req: RequestLayer;
  /** the base scope: resources, status, magic names */
  readonly page: any;
  readonly transport: (url: string) => Transport | undefined;
  readonly ext: {
    optimistic?: { begin(fn: number, scope: any): (ok?: boolean) => void };
    each?: { fanOut(loader: ResourceLoader): void };
    paginate?: { pager(loader: ResourceLoader): Pager; page(name: string, target: string | number): void };
    persist?: {
      model(rb: BoundBinding, set: (v: unknown) => void): void;
      state(key: string, obj: Record<string, unknown>): void;
      saveState(key: string, obj: Record<string, unknown>): void;
    };
    cache?: {
      /** the cached data for a request, if any and not older than the resource allows */
      read(def: ResourceDef, url: string): { t: number; items: unknown; total: number | null } | null;
      /** a load (or embedded data) stored `items`: cache them, and the resource's later changes */
      loaded(def: ResourceDef, r: Resource, url: string, items: unknown, total: number | null, appended: boolean): void;
      /** the resource was emptied (`when` is false): nothing to write until the next load */
      cleared(def: ResourceDef): void;
    };
    /** a key filter's handler (`b.q`): whether this key event is for it (a match prevents its default) */
    keys?: (rb: BoundBinding, e: KeyboardEvent) => boolean;
    /** write-through: a mutation's 2xx response, applied to the resources it is about (before `then`) */
    apply?: (a: ActionDef, scope: any, url: string, body: unknown, result: unknown) => void;
  };
  readonly beforeFlush: Array<(dirty: string[][]) => void>;
  readonly afterFlush: Array<(dirty: string[][]) => void>;
  readonly onListen: Array<(event: string) => void>;
  /** root state scopes: [sid, state object] */
  readonly states: Array<[number, any]>;
  /** pending debounce timers and waiting actions, for the testing module */
  busy: number;
  readonly isDirty: boolean;
  /** dev hooks: dev-only checks on, warnings by code (or text), and item preparation (freezing) */
  dev: boolean;
  warn(code: number | string, ...args: unknown[]): void;
  prep?: <T>(item: T) => T;
  /** dev: an EventSource stream opened (its connection counts against HTTP/1.1's 6 per origin) */
  streamOpened?: (url: string) => void;

  resource<T extends object = any>(name: string): Resource<T>;
  request(url: string, init?: SendInit): Promise<unknown>;
  optimistic<T>(change: () => void, run: () => Promise<T>): Promise<T>;
  on(event: string, fn: (payload: any) => void): () => void;
  state<T = any>(el: Element): StateHandle<T>;
  destroy(): void;

  url(tpl: UrlTemplate, scope: any): string;
  /** the scope of root node `i` (its state), or the page scope for -1 */
  scopeOf(i: number): any;
  /** `typing`: the change is a keystroke in a text field, so a resource URL it changes waits for a pause */
  mark(path: string, scope?: any, typing?: boolean): void;
  flush(): void;
  /** records `change` as optimistic layers; the returned function settles them: committed when `ok`, else rolled back */
  record(change: () => void): (ok?: boolean) => void;
  storeFns(el: Element | null): Record<string, (...a: any[]) => unknown>;
  serverEvent(name: string, payload: unknown): void;
  /** runs handler `f` in `scope` and invalidates the paths it writes */
  exec(f: number, scope: any, writes?: string[]): void;
  addCleanup(fn: () => void): void;
}

/** Runtime binding: the bound binding plus last value and list/conditional state. */
interface RB extends BoundBinding {
  v?: unknown;
  /** evaluation scope: the binding's scope plus `$el`, created once */
  e?: any;
  /** may be inside a closed dialog of its block */
  c?: boolean;
  /** the binding's dependencies (shared by every row of a template), looked up on the first flush that tests them */
  d?: Dep[] | undefined;
  /** for: rows; if: the rendered branch (0 or 1 entries) */
  rows?: Inst[];
  t?: TemplateDef;
  /** end marker of the rows / branch, inserted after the template anchor */
  end?: Comment;
  /** for: rows by key, built on demand (null: keys are explicit or not unique), and the round of the last reconcile */
  keys?: Map<unknown, Inst> | null;
  rr?: number;
  /** for: selection indexes of its rows (by binding), built on demand, dropped when the rows are rendered */
  sx?: Map<Binding, Sel>;
  /** if: rendered branch (0 none, 1 if, 2 else), and the else anchor with its template */
  br?: number;
  else?: [Element, number] | null;
}

/** A selection binding's index over one list's rows: rows by row-side value, and the rows the comparison holds for. */
interface Sel { m: Map<unknown, Inst[]>; on: Set<Inst> }

/**
 * A simple row template (value bindings and handlers only, with a lookup function): its rows keep no
 * binding objects. `vals`: the value bindings with their node index, in order (a row's `v` is parallel
 * to it); `hs`: the handlers, bound to an element on its first event.
 */
interface Simple { vals: Array<[number, Binding]>; hs: Array<[number, Binding]> }

interface Inst {
  first: Node | null;
  /** the row's nodes; null for a one-element row (`first` is the element) */
  nodes: Node[] | null;
  /** the row's bound bindings, or null for a row of a simple template: its values are in `v`, by `Simple.vals` */
  rbs: RB[] | null;
  v: unknown[] | null;
  /** simple rows: their template, for handlers bound on their first event */
  t?: TemplateDef;
  s: any;
  key: unknown;
  item: unknown;
  i: number;
  /** re-evaluate on the next walk: 0 no, 1 bindings that read the index, 2 all */
  f: number;
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
/** How long a URL change from typing waits for the next keystroke before the resource is requested. */
const TYPING = 250;
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
/** Per-element registries, kept on the element (cheaper than WeakMaps on the row creation path). */
const HANDLERS = Symbol('sinter.on'), MODEL = Symbol('sinter.model'), STATE = Symbol('sinter.state');
/** HANDLERS: one handler binding, or an array when the element has several */
type Tagged = Element & { [HANDLERS]?: RB | RB[]; [MODEL]?: RB; [STATE]?: [number, any] };
const indexReaders = new WeakMap<TemplateDef, boolean>();
const others = new WeakMap<TemplateDef, Dep[]>(), selOf = new WeakMap<TemplateDef, Binding[]>();
/** row templates: whether each holds one element (see oneElement()) */
const prepared = new WeakMap<HTMLTemplateElement, boolean>();
/** set by the early chunk (@tiaforge-ui/sinter/early) on a `data-sn-if` template whose branch it rendered */
const EARLY = Symbol.for('sinter.early');
const simple = new WeakMap<TemplateDef, Simple | null>(), SIMPLE = new Set(['text', 'attr', 'class', 'style', 'show', 'prop', 'on']);
/** ROW: on each node of a simple row with handlers, its instance */
const ROW = Symbol('sinter.row');
type RowNode = Node & { [ROW]?: Inst };
const rowNodes = (x: Inst) => x.nodes ?? [x.first!];

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
  const env = o.env ?? envOf(config);
  const req = createRequestLayer(env, o.request ?? config.request);
  const schemes = schemesOf(config.urlSchemes);
  const resources = new Map<string, Resource>(), loaders: Array<{ def: ResourceDef; changed(typing?: boolean): void; start(): void; refetch(): Promise<void> }> = [];
  const acts = new WeakMap<Element, ActState>();
  /** props set on custom elements not defined yet, by element: the latest value of each */
  const early = new WeakMap<Element, Map<string, unknown>>();
  const types = new Set<string>(), selects = new Set<RB>(), deferred = new Set<RB>();
  const listeners = new Map<string, Set<(p: unknown) => void>>(), cleanups: Array<() => void> = [];
  const shared = new Map<string, { n: number; c: AbortController; p: Promise<unknown> }>();
  /** `showModal(id)`, `close(id)`: the dialog of this mount root with that id; `run(id)`: any element */
  const byId = (id: string, s = '[id]') => [...root.querySelectorAll(s)].find((d) => d.id === id);
  const dialog = (id: string) => byId(id, 'dialog') as HTMLDialogElement | undefined;
  const rootRbs: RB[] = [], rootScopes: any[] = [], found = new Map<number, Element>();
  let dirty: string[][] = [], cur: string[][] = [], scheduled = false, flushing = false, round = 0, destroyed = false;
  /** dirty paths of this round that keystrokes in text fields produced */
  const typed = new Set<string[]>();

  const res = (name: string): Resource => {
    const r = resources.get(name);
    if (!r) throw Error(`sinter: no resource ${name}`);
    return r;
  };
  const forward = (m: 'upsert' | 'patch' | 'remove') => (n: string, ...a: [any, any?]) => res(n)[m](...a);
  const warn = (code: number | string, ...args: unknown[]) => app.warn(code, ...args);
  /** `rb`: keeps the `$el` scope of a bound binding; a simple row's binding makes one per evaluation */
  const evalB = (b: Binding, s: any, el: Element, rb: RB | null): any => {
    try { return fns[b.f!]!(b.e ? (rb ? (rb.e ??= child(s, { $el: el })) : child(s, { $el: el })) : s); } catch (e) { warn(6, b.k, el.localName, (e as Error)?.message); }
  };
  const evaluate = (rb: RB): any => evalB(rb.b, rb.s, rb.el, rb);
  /** The writers, one per binding kind: `(element, name, value)`; a template's creation function calls them too. */
  const W = {
    U: UNSET,
    t(el: HTMLElement, _n: string, v: any) {
      const t = el.firstChild as Text | null;
      v = '' + (v ?? '');
      if (t?.nodeType == 3 && !t.nextSibling) t.data = v;
      else el.textContent = v;
    },
    h(el: HTMLElement, _n: string, v: any) { el.hidden = !v; },
    p(el: HTMLElement, n: string, v: any) {
      (el as any)[n] = v;
      // not defined yet, or defined but not upgraded yet (a row cloned from a template)
      if (early.has(el) || !(el instanceof (customElements.get(el.localName) ?? Boolean))) upgrade(el, n, v);
    },
    /** `has`: the element may have the class (it is not a new clone of an element without a `class` attribute) */
    c(el: HTMLElement, n: string, v: any, has: unknown) { if (v || has) el.classList.toggle(n, !!v); },
    a(el: HTMLElement, n: string, v: any) {
      // form state: the attribute is only the default once the user has changed the control
      if (/^(checked|selected|indeterminate|value)$/.test(n) && n in el) (el as any)[n] = n == 'value' ? (v == null || v === false || v === true ? '' : v) : v != null && v !== false;
      if (v == null || v === false) el.removeAttribute(n);
      else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), /^https?:/.test(el.baseURI) ? el.baseURI : env.href(), schemes)) el.setAttribute(n, v);
      else { el.removeAttribute(n); warn(7, n, el.localName, v); }
    },
    s(el: HTMLElement, n: string, v: any) {
      if (v == null || v === false) el.style.removeProperty(n);
      else if (STYLE_BAD.test(v)) { el.style.removeProperty(n); warn(8, n, v); }
      else el.style.setProperty(n, v);
    },
  };

  /** Elements written through callbacks (`$.$m(row, …)`) since the last flush. */
  const marked = new Set<unknown>();
  /** debounced handlers' pending timers */
  const timers = new WeakMap<RB, unknown>();
  /** action calls' signal: aborts when the page is hidden */
  let hide = new AbortController();
  /** runs an action function; it counts as busy (for the testing module's settle) while it runs */
  async function invoke(run: number, args: unknown, ctx: CallContext): Promise<unknown> {
    app.busy++;
    try { return await fns[run]!(args, ctx); } finally { app.busy--; }
  }
  /** a failed call: SinterErrors as they are, anything else with status null */
  const callError = (e: unknown) => {
    if (e instanceof SinterError) return e;
    const detail = (e instanceof Error ? e.message : typeof e == 'string' ? e : '') || null;
    return new SinterError(null, e, detail ?? String(e), detail);
  };
  /** Per flush round: how dirty paths reach a template's rows (0 not, 1 only marked elements, 2 any row). */
  let rowHits = new Map<TemplateDef, number>();

  /**
   * Whether a dependency (its `{name}` segments read from scope `s`, or any scope when `s` is
   * absent) and dirty path `d` are prefixes of each other; `*` matches any segment. A change
   * that ends above a row's own element, or only changes the list structure (`#`), does not
   * reach it: reconcile re-evaluates rows whose item or index changed. `~` reaches only rows
   * whose element was marked. A path ending in `**` (an island's `update()`) reaches everything
   * under its prefix, at any depth.
   */
  const overlaps = (dep: Dep, d: string[], s?: any) => reach(dep, d, s) > 0;

  /** 0: no overlap; 1: only through a marked element (`~`) of the row; 2: overlap. */
  function reach({ p, n, a, t }: Dep, d: string[], s?: any): number {
    if (a >= 0 && d.length <= a && d[d.length - 1] != '**') return 0;
    let via = 2;
    for (let i = 0, len = Math.min(p.length, d.length); i < len; i++) {
      const y = d[i]!;
      if (y == '**') return 2;
      // a list's structure dependency: reached by changes to the list itself or a whole element, not element fields
      if (p[i] == '#') return d.length <= i + 1 ? 2 : 0;
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

  /** Whether a binding in a template's rows (nested templates included) reads a loop index. */
  const readsIndex = (t: TemplateDef): boolean => indexReaders.get(t) ?? (indexReaders.set(t, t.nodes.some((nd) => nd.b.some((b) =>
    b.i || ((b.k == 'for' || b.k == 'if' || b.k == 'else') && readsIndex(ir.templates[b.x!]!))))), indexReaders.get(t)!);

  /** Dependencies of every binding in a template's rows, nested templates included. */
  const templateDeps = (t: TemplateDef): Dep[] => compiled.get(t) ?? (compiled.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...depsOf(b, b.d),
    ...(b.k == 'for' || b.k == 'if' || b.k == 'else' ? templateDeps(ir.templates[b.x!]!) : []),
  ]))), compiled.get(t)!);

  /**
   * The template's dependencies without the outer sides of its selection bindings: what reaches a row
   * for any other reason. The selection bindings of the template's own nodes.
   */
  const otherDeps = (t: TemplateDef): Dep[] => others.get(t) ?? (others.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...(b.s ? toDeps((b.d ?? []).filter((d) => !b.s!.d.includes(d))) : depsOf(b, b.d)),
    ...(b.k == 'for' || b.k == 'if' || b.k == 'else' ? templateDeps(ir.templates[b.x!]!) : []),
  ]))), others.get(t)!);
  const sels = (t: TemplateDef): Binding[] => selOf.get(t) ?? (selOf.set(t, t.nodes.flatMap((nd) => nd.b.filter((b) => b.s))), selOf.get(t)!);

  /** Whether any of `deps` overlaps a dirty path of the current flush. */
  const hit = (deps: Dep[], s?: any) => {
    for (const dep of deps) for (const d of cur) if (overlaps(dep, d, s)) return true;
    return false;
  };
  /** 0: no dirty path reaches `deps`; 1: only keystrokes do; 2: some other change does. */
  const hits = (deps: Dep[]) => {
    let k = 0;
    for (const d of cur) if (deps.some((dep) => overlaps(dep, d))) k = typed.has(d) ? k || 1 : 2;
    return k;
  };

  const app: App = {
    ir, fns, env, req, root, transport: o.transport ?? (() => undefined), ext: {},
    beforeFlush: [], afterFlush: [], onListen: [], states: [], busy: 0,
    get isDirty() { return dirty.length > 0 || scheduled; },
    dev: false,
    warn() {},
    page: {
      $r: {}, $meta: {}, $url: readUrl(), $now: new Date(env.now()),
      $m: (el: unknown, v: unknown) => (marked.add(el), v),
      get $locale() { return config.locale?.get(); },
      set $locale(v: any) {
        config.locale?.set(v);
        app.mark('$locale');
        // ordered lists sort strings by locale
        for (const def of ir.resources) if (def.order) app.mark('$r.' + def.name);
      },
    },
    resource: res as App['resource'],
    request: (url, init) => req.send(url, init),
    async optimistic(change, run) {
      const settle = app.record(change);
      let ok = false;
      try { const v = await run(); ok = true; return v; } finally { settle(ok); }
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
      for (const l of app.onListen) l(event);
      return () => listeners.get(event)!.delete(fn);
    },
    state(el) {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = (e as Tagged)[STATE];
        // `**`: the island may have changed anything under the state, rows included
        if (s) return { get: () => s[1], update: (fn) => { fn(s[1]); app.mark('$s' + s[0] + '.**'); } };
      }
      throw Error('sinter: no data-sn-state scope');
    },
    destroy() {
      destroyed = true;
      for (const c of cleanups.splice(0)) c();
      instances.delete(root);
    },
    scopeOf: (i) => (i < 0 ? app.page : rootScopes[i] ?? app.page),
    url: (tpl, s) => expand(tpl, s, fns),
    mark(path, s, typing) {
      const d = fill(path, s);
      dirty.push(d);
      if (typing) typed.add(d);
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
          for (const l of loaders) { const k = hits(depsOf(l.def, l.def.deps)); if (k) l.changed(k == 1); }
          walk(rootRbs, 0);
          syncSelects();
          for (const h of app.afterFlush) h(cur);
        }
      } finally {
        cur = dirty = [];
        typed.clear();
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
      return (ok) => { if (!done) { done = true; for (const [r, id] of ids) ok ? r.commitLayer(id) : r.dropLayer(id); } };
    },
    storeFns: (el) => ({
      showModal: (id: string) => { const d = dialog(id); if (d && !d.open) d.showModal(); },
      refresh: (...n: string[]) => { for (const x of n) res(x).refetch(); },
      upsert: forward('upsert'),
      patch: forward('patch'),
      remove: forward('remove'),
      page: (n: string, t: string | number) => app.ext.paginate!.page(n, t),
      close: (id?: string) => (id ? dialog(id) : el?.closest('dialog'))?.close(),
      reset: () => {
        const form = el?.closest('form');
        if (!form) return;
        form.reset();
        for (const c of form.elements) { const rb = (c as Tagged)[MODEL]; if (rb) setModel(rb, readModel(rb)); }
      },
      emit: (n: string, detail?: unknown) => el?.dispatchEvent(new CustomEvent(n, { detail, bubbles: true, cancelable: true })),
      // the element's action, as if its trigger fired (a form is submitted); disabled or inert: nothing
      run: (id: string) => {
        const t = byId(id), h = t && handlersOf(t as Tagged), rb = h && (Array.isArray(h) ? h : [h]).find((x) => x.b.x != null);
        if (!rb) return warn(20, id);
        if (t.matches(':disabled') || t.closest('[inert]')) return;
        t.localName == 'form' ? (t as HTMLFormElement).requestSubmit() : trigger(rb, null);
      },
    }),
    serverEvent(name, payload) {
      for (const fn of listeners.get(name) ?? []) try { fn(payload); } catch (e) { console.error(e); }
    },
    exec(f, s, writes) {
      try { fns[f]!(s); } catch (err) { console.error(err); }
      for (const w of writes ?? []) app.mark(w, s);
      if (writes?.some((w) => w.startsWith('$url'))) writeUrl();
    },
    // after destroy(), nothing waits for the next one: run it now
    addCleanup: (fn) => void (destroyed ? fn() : cleanups.push(fn)),
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
  // action calls see the page leave through ctx.signal
  if (ir.actions.some((x) => x.call) || ir.resources.some((x) => x.call)) {
    app.addCleanup(env.listen('pagehide', () => { hide.abort(); hide = new AbortController(); }));
  }
  // back from the bfcache, or online again: the data may have changed meanwhile. Resources a stream
  // feeds are refetched by the stream module when it reconnects.
  const fed = new Set(ir.syncs.flatMap((s) => s.events.map((e) => e.resource)));
  const again = () => { for (const l of loaders) if (!fed.has(l.def.name)) void l.refetch(); };
  app.addCleanup(env.listen('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) again(); }));
  app.addCleanup(env.listen('online', again));
  // listeners for every event type the page binds, rows included
  listen('toggle');
  for (const nd of [...ir.roots, ...ir.templates.flatMap((t) => t.nodes)]) for (const b of nd.b) {
    if (b.k == 'on') listen(b.n!);
    if (b.k == 'model') { listen('input'); listen('change'); }
  }
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
  // what the early file requested and no resource took (its URL changed, or a middleware changed the
  // request): the loads above reached the end of the chain already, unless a middleware waits first
  if (prefetched()) env.setTimeout(() => prefetched()?.sweep(), 0);
  flushing = true;
  try { walk(rootRbs, 2); syncSelects(); for (const h of app.afterFlush) h([]); } finally { flushing = false; }
  if (dirty.length) { scheduled = true; env.queueMicrotask(app.flush); }
  return app;

  // ---- scopes and bindings

  /** Query parameters, then the `:name` segments of the first `data-sn-path` pattern that matches. */
  function readUrl() {
    return readFrom(env.href(), ir.path);
  }

  function writeUrl() {
    const u = new URL(env.href()), q = new URLSearchParams();
    const fromPath = new Set((ir.path ?? []).flatMap((p) => p.split('/').filter((s) => s[0] == ':').map((s) => s.slice(1))));
    for (const [k, v] of Object.entries(app.page.$url)) if (v != null && v !== '' && !fromPath.has(k)) q.set(k, '' + v);
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

  /**
   * Only elements the compiler marked as in a dialog of their own block (`dl`) are checked for a
   * closed dialog; dialogs outside a template defer the whole list.
   */
  function bindNodes(defs: NodeDef[], els: Array<Element | null>, base: any, rbs: RB[]) {
    // scopes of elements that declare state (and their descendants); most rows have none
    let scopes: any[] | null = null;
    for (let i = 0; i < defs.length; i++) {
      const nd = defs[i]!, el = els[i] as Tagged | null;
      let s = scopes?.[nd.p] ?? base;
      if (nd.state != null && el) {
        const obj = fns[nd.state]!(s), sid = nd.sid!, key = nd.persist;
        s = child(s, { ['$s' + sid]: obj });
        el[STATE] = [sid, obj];
        if (rbs == rootRbs) app.states.push([sid, obj]);
        if (key) {
          app.ext.persist?.state(key, obj);
          app.afterFlush.push((d) => d.some((p) => p[0] == '$s' + sid) && app.ext.persist?.saveState(key, obj));
        }
      }
      if (s !== base) (scopes ??= [])[i] = s;
      if (rbs == rootRbs) rootScopes[i] = s;
      if (el) for (const b of nd.b) {
        const rb: RB = { b, el, s, v: UNSET, c: !!nd.dl };
        if (b.k == 'on') {
          const h: RB | RB[] | undefined = el[HANDLERS];
          el[HANDLERS] = h == null ? rb : Array.isArray(h) ? (h.push(rb), h) : [h, rb];
          continue;
        }
        if (b.k == 'else') continue;
        if (b.k == 'model') {
          el[MODEL] = rb;
          if (el.localName == 'select') selects.add(rb);
          if (b.p != null) app.ext.persist?.model(rb, (v) => setModel(rb, v));
        }
        if (b.k == 'for') { rb.rows = []; rb.t = ir.templates[b.x!]; }
        if (b.k == 'if') { rb.br = 0; rb.else = b.y != null && els[b.y] ? [els[b.y]!, defs[b.y]!.b.find((x) => x.k == 'else')!.x!] : null; }
        rbs.push(rb);
      }
    }
  }

  // ---- rendering

  /** Walks bindings in document order; `force`: 0 dirty ones only, 1 also those reading a loop index, 2 all. */
  function walk(rbs: RB[], force: number) {
    for (const rb of rbs) {
      if (!process(rb, force) || !rb.rows) continue;
      const t = rb.t;
      let r = force || !t ? 2 : rowHits.get(t);
      if (r == null) {
        r = 0;
        // a mark counts as "only marked rows" for dependencies on this list's own element; others (outer rows) reach any row
        for (const dep of otherDeps(t!)) for (const d of cur) { const x = reach(dep, d); r = Math.max(r, x == 1 && dep.t != t!.id ? 2 : x); }
        rowHits.set(t!, r);
      }
      // only a selection's outer side changed: the rows it concerns, through the index; rows that were
      // just reconciled (some re-rendered, the index stale) or wait in a closed dialog render as usual
      if (!r) {
        const ss = sels(t!);
        if (ss.some((b) => hit(depsOf(b.s!, b.s!.d), rb.s))) {
          if (rb.rr != round && !deferred.size) { for (const b of ss) select(rb, b); continue; }
          r = 2;
        }
      }
      rb.sx = undefined;
      // only marked elements changed and the list did not move: visit their rows directly
      if (r == 1 && rb.rr != round) {
        const keys = rb.keys === undefined ? (rb.keys = t!.key != null ? null : new Map(rb.rows.map((x) => [x.key, x]))) : rb.keys;
        if (keys && keys.size == rb.rows.length) {
          for (const item of marked) {
            const x = Object(item) === item ? keys.get(keyOf(t!, item, null)) : null;
            if (x && x.item === item) walkRow(x, t!, 0);
          }
          continue;
        }
      }
      // otherwise skip rows no dirty path can reach (unless they moved or changed), and rows created in this round
      for (const x of rb.rows) if (x.r != round && (r || x.f)) { walkRow(x, t!, Math.max(force, x.f)); x.f = 0; }
    }
  }

  function walkRow(x: Inst, t: TemplateDef, force: number) {
    if (x.rbs) walk(x.rbs, force);
    else walkSimple(x, t, isSimple(t)!, force);
  }

  /**
   * A simple row's bindings (`only`: just that one of `meta.vals`): the elements are found again from
   * `first`, each binding that is forced or reached is evaluated and written when its value changed.
   */
  function walkSimple(x: Inst, t: TemplateDef, meta: Simple, force: number, only = -1) {
    const els: Array<Element | null> = fns[t.find!]!(x.first), vals = meta.vals, v = x.v!;
    for (let j = only < 0 ? 0 : only; j < vals.length; j++) {
      const [k, b] = vals[j]!, el = els[k], prev = v[j];
      if (el && (force == 2 || (force == 1 && b.i) || (b.d && hit(depsOf(b, b.d), x.s)))) {
        const val = evalB(b, x.s, el, null);
        if (!Object.is(val, prev)) { write(b, el, val, prev == UNSET ? undefined : prev, prev == UNSET); v[j] = val; }
      }
      if (only >= 0) break;
    }
  }

  /** Evaluates and writes one binding if needed; false while it waits in a closed dialog. */
  function process(rb: RB, level: number): boolean {
    const force = level == 2 || (level == 1 && !!rb.b.i);
    if (!force && !(deferred.size && deferred.has(rb)) && !(rb.b.d && hit(rb.d ??= depsOf(rb.b, rb.b.d), rb.s))) return true;
    if (rb.c && rb.el.closest('dialog:not([open])')) { deferred.add(rb); return false; }
    if (deferred.size) deferred.delete(rb);
    const v = evaluate(rb), k = rb.b.k;
    if (k == 'for') reconcile(rb, v);
    else if (k == 'if') toggle(rb, v ? 1 : rb.else ? 2 : 0);
    else if (k == 'model') writeModel(rb, v);
    else if (!Object.is(v, rb.v)) { write(rb.b, rb.el, v, rb.v == UNSET ? undefined : rb.v, rb.v == UNSET); rb.v = v; }
    return true;
  }

  /**
   * A selection binding (`row.id === selected`) whose outer side may have changed: re-evaluates it on
   * the rows it held for and the rows whose row side equals the new outer value; the others keep their
   * value. The index is built from the rows on first use and kept while no row is rendered.
   */
  function select(rb: RB, b: Binding) {
    const s = b.s!, f = s.x ? 0 : 1, t = rb.t!, meta = isSimple(t), j = meta ? meta.vals.findIndex((y) => y[1] == b) : -1;
    if (!hit(depsOf(s, s.d), rb.s)) return;
    // the binding's current value in a row (undefined when its element is missing), and its re-evaluation
    const cur = (x: Inst) => (meta ? x.v![j] : x.rbs!.find((y) => y.b == b)?.v);
    const run = (x: Inst) => { if (meta) walkSimple(x, t, meta, 2, j); else { const y = x.rbs!.find((y) => y.b == b); if (y) process(y, 2); } };
    const safe = (i: number, sc: any) => { try { return fns[i]!(sc); } catch { return undefined; } };
    let e = rb.sx?.get(b);
    if (!e) {
      const m = new Map<unknown, Inst[]>(), on = new Set<Inst>();
      for (const x of rb.rows!) {
        const k = safe(s.r, x.s), a = m.get(k);
        a ? a.push(x) : m.set(k, [x]);
        if (+!!cur(x) == f) on.add(x);
      }
      (rb.sx ??= new Map()).set(b, (e = { m, on }));
    }
    for (const x of [...e.on, ...(e.m.get(safe(s.o, rb.s)) ?? [])]) {
      run(x);
      if (+!!cur(x) == f) e.on.add(x); else e.on.delete(x);
    }
  }

  /**
   * A property set before its custom element is defined is an own property that would hide the
   * class's setter: once defined, the latest values are set again, through the class.
   */
  function upgrade(el: any, n: string, v: unknown) {
    let m = early.get(el);
    if (!m) {
      early.set(el, (m = new Map()));
      customElements.whenDefined(el.localName).then(() => {
        early.delete(el);
        for (const [k, x] of m!) { delete el[k]; el[k] = x; }
      });
    }
    m.set(n, v);
  }

  /** Writes a binding's value to its element; `fresh`: the first write (an element from a template may lack the attribute). */
  function write(b: Binding, e: Element, v: any, prev: any, fresh: boolean) {
    const el = e as HTMLElement, n = b.n!;
    switch (b.k) {
      case 'text': W.t(el, n, v); break;
      case 'show': W.h(el, n, v); break;
      case 'prop': W.p(el, n, v); break;
      case 'class':
        // a new element without a class attribute cannot have the class: skip removing it
        if (n) W.c(el, n, v, !fresh || el.hasAttribute('class'));
        else {
          if (prev?.[0] && prev[0] != v?.[0]) el.classList.remove(prev[0]);
          if (v?.[0]) el.classList.toggle(v[0], !!v[1]);
        }
        break;
      case 'attr': W.a(el, n, v); break;
      case 'style': W.s(el, n, v);
    }
  }

  /** Sets each select's value again, as its options may have changed; one in a closed dialog waits, as in process(). */
  function syncSelects() {
    for (const rb of selects) {
      if (rb.c && rb.el.closest('dialog:not([open])')) deferred.add(rb);
      else writeModel(rb, evaluate(rb));
    }
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

  /** `typing`: a keystroke in a text field (`input` on an `<input>`/`<textarea>`), not a paste-like whole change */
  function setModel(rb: RB, v: unknown, typing?: boolean) {
    if (v === undefined) return;
    try { fns[rb.b.a!]!(rb.s, v); } catch (e) { return warn(9, rb.el.localName, (e as Error)?.message); }
    for (const w of rb.b.w ?? []) app.mark(w, rb.s, typing);
  }

  // ---- lists and conditionals

  function setRow(s: any, t: TemplateDef, item: unknown, i: number) {
    s[t.item!] = item;
    if (t.index) s[t.index] = i;
    s[t.ii!] = i;
    return s;
  }

  /** A row's identity: the explicit key, the resource key, or the item object itself. */
  function keyOf(t: TemplateDef, item: any, s: any): unknown {
    if (t.key != null) return 'k' + fns[t.key]!(s);
    if (t.keyFields && item) return 'r' + t.keyFields.map((f) => item[f]).join('\x1f');
    if (Object(item) === item) return item;
    warn(10);
    return 'p' + typeof item + item;
  }

  function reconcile(rb: RB, v: any) {
    const t = rb.t!, old = rb.rows!, end = (rb.end ??= after(rb.el)), tpl = rb.el as HTMLTemplateElement;
    const items: unknown[] = v == null ? [] : Array.isArray(v) ? v : Symbol.iterator in Object(v) ? [...v] : [];
    const n = items.length, m = old.length, rows: Inst[] = new Array(n), moved = readsIndex(t);
    // a scope is only needed up front for an explicit key expression
    const scopes = t.key != null ? items.map((item, i) => setRow(Object.create(rb.s), t, item, i)) : null;
    const keys = items.map((item, i) => keyOf(t, item, scopes?.[i]));
    if (app.dev && new Set(keys).size < n) {
      const k = keys.find((k, i) => keys.indexOf(k) != i);
      warn(11, typeof k == 'string' ? k.slice(1) : 'the same object twice');
    }
    const reuse = (x: Inst, i: number) => {
      const item = items[i];
      if (x.item !== item) { setRow(x.s, t, (x.item = item), (x.i = i)); x.f = 2; }
      else if (x.i != i) { setRow(x.s, t, item, (x.i = i)); if (moved) x.f ||= 1; }
      rows[i] = x;
    };
    // rows with the same keys at the start and the end stay where they are
    let a = 0, oe = m, ne = n;
    while (a < oe && a < ne && old[a]!.key === keys[a]) reuse(old[a]!, a++);
    while (a < oe && a < ne && old[oe - 1]!.key === keys[ne - 1]) reuse(old[--oe]!, --ne);
    // the middle: match by key, create the rest
    const byKey = new Map<unknown, number>(), used = new Uint8Array(oe - a), seq: number[] = [];
    for (let o = a; o < oe; o++) byKey.set(old[o]!.key, o);
    for (let i = a; i < ne; i++) {
      const o = byKey.get(keys[i]);
      if (o != null && !used[o - a]) { used[o - a] = 1; seq.push(o); reuse(old[o]!, i); }
      else { seq.push(-1); rows[i] = instantiate(tpl, t, scopes?.[i] ?? setRow(Object.create(rb.s), t, items[i], i), keys[i], items[i], i); }
    }
    // each old row owns the nodes from its first node up to the next old row's first node;
    // collect them for rows that go or move before the DOM changes
    const nodesOf = (o: number) => range(old[o]!.first, old[o + 1]?.first ?? end);
    const keep = lis(seq), moving = new Map<Inst, Node[]>(), gone: number[] = [];
    seq.forEach((o, k) => { if (o >= 0 && !keep.has(k)) moving.set(rows[a + k]!, nodesOf(o)); });
    for (let o = a; o < oe; o++) if (!used[o - a]) gone.push(o);
    if (m && gone.length == m) {
      // every old row goes (cleared, or all keys new): when the list owns its parent, drop them in
      // one operation; removing 5,000 rows one by one costs more than building the new ones
      const parent = end.parentNode!;
      if (parent.firstChild == tpl && parent.lastChild == end) parent.replaceChildren(tpl, end);
      else while (tpl.nextSibling != end) tpl.nextSibling!.remove();
    } else for (const node of gone.flatMap(nodesOf)) (node as ChildNode).remove();
    if (deferred.size || selects.size) for (const o of gone) if (old[o]!.rbs) forget(old[o]!.rbs!);
    const ref = ne < n ? rows[ne]!.first ?? end : end;
    if (!seq.some((o) => o >= 0)) {
      // only new rows in the middle: insert each straight before the reference (going through a
      // fragment first moves every node twice)
      const parent = ref.parentNode!;
      for (let i = a; i < ne; i++) for (const node of rowNodes(rows[i]!)) parent.insertBefore(node, ref);
    } else {
      // move the fewest rows: those outside a longest increasing subsequence of old positions
      let at: Node = ref;
      for (let k = seq.length; k--;) {
        const x = rows[a + k]!;
        if (!keep.has(k)) (at as ChildNode).before(...(moving.get(x) ?? rowNodes(x)));
        at = x.first ?? at;
      }
    }
    rb.rows = rows;
    rb.rr = round;
    rb.keys = undefined;
    rb.sx = undefined;
  }

  function toggle(rb: RB, br: number) {
    // a branch the early chunk rendered: adopted when it is the one to show, else removed
    const pre: { br: number; nodes: Node[]; end: Comment } | undefined = (rb.el as any)[EARLY];
    if (pre) {
      delete (rb.el as any)[EARLY];
      if (pre.br == br) {
        const [anchor, tid] = br == 1 ? [rb.el, rb.b.x!] : rb.else!;
        rb.end = pre.end;
        rb.br = br;
        rb.rows = [instantiate(anchor as HTMLTemplateElement, ir.templates[tid]!, Object.create(rb.s), '', null, 0, pre.nodes)];
        return;
      }
      for (const n of pre.nodes) (n as ChildNode).remove();
      pre.end.remove();
    }
    if (br == rb.br) return;
    const end = (rb.end ??= after(rb.el)), [old] = rb.rows ?? [];
    if (old) {
      for (const n of range(old.first, end)) (n as ChildNode).remove();
      if (old.rbs) forget(old.rbs);
    }
    rb.br = br;
    rb.rows = [];
    if (!br) return;
    const [anchor, tid] = br == 1 ? [rb.el, rb.b.x!] : rb.else!;
    const x = instantiate(anchor as HTMLTemplateElement, ir.templates[tid]!, Object.create(rb.s), '', null, 0);
    end.before(...rowNodes(x));
    rb.rows = [x];
  }

  /** `pre`: nodes the early chunk already rendered from this template, bound instead of a clone. */
  function instantiate(tpl: HTMLTemplateElement, t: TemplateDef, s: any, key: unknown, item: unknown, i: number, pre?: Node[]): Inst {
    const content = tpl.content, one = prepared.get(tpl) ?? oneElement(tpl);
    const top: Node = pre ? (one ? pre[0]! : content) : one ? content.firstChild!.cloneNode(true) : content.cloneNode(true);
    const first = pre ? pre[0] ?? null : one ? top : top.firstChild;
    const defs = t.nodes, rbs: RB[] = [];
    const find = (): Array<Element | null> => {
      if (t.find != null) return fns[t.find]!(first);
      // if/else branches (and IR compiled before lookup functions): path[0] picks a child of the content
      const els: Array<Element | null> = new Array(defs.length);
      for (let k = 0; k < defs.length; k++) {
        const path = defs[k]!.path!;
        let node: Node | null = first;
        for (let c = path[0]!; c-- && node;) node = node.nextSibling;
        for (let x = 1; x < path.length && node; x++) {
          node = node.firstChild;
          for (let c = path[x]!; c-- && node;) node = node.nextSibling;
        }
        els[k] = node && (node as Element).localName == defs[k]!.tag ? (node as Element) : null;
      }
      return els;
    };
    // a fragment's nodes, after the bindings ran: a nested list adds its rows and end marker to it
    const collect = () => { const nodes: Node[] = []; if (pre) nodes.push(...pre); else if (!one) for (let c = top.firstChild; c; c = c.nextSibling) nodes.push(c); return nodes; };
    const meta = isSimple(t);
    if (meta) {
      // only value bindings and handlers: no binding objects. The values are written once and kept in
      // one array; the elements are found again when the row renders; handlers bind on their first event
      let v: unknown[] | null = null;
      // the compiled creation function; one that throws (an expression error) gives way to the generic
      // path, which evaluates binding by binding and names the failing one
      if (t.make != null) try { v = (fns[t.make] as (c: Node | null, s: any, w: typeof W) => unknown[])(first, s, W); } catch { v = null; }
      if (!v) {
        const els = find();
        v = new Array(meta.vals.length);
        for (let j = 0; j < meta.vals.length; j++) {
          const [k, b] = meta.vals[j]!, el = els[k];
          if (!el) { v[j] = UNSET; continue; }
          write(b, el, (v[j] = evalB(b, s, el, null)), undefined, true);
        }
      }
      const nodes = one ? null : collect(), x: Inst = { first, nodes, rbs: null, v, t, s, key, item, i, f: 0, r: round };
      if (meta.hs.length) for (const n of nodes ?? [top]) if (n.nodeType == 1) (n as RowNode)[ROW] = x;
      return x;
    }
    bindNodes(defs, find(), s, rbs);
    walk(rbs, 2);
    const nodes = one ? null : collect();
    return { first: nodes ? nodes[0] ?? null : first, nodes, rbs, v: null, s, key, item, i, f: 0, r: round };
  }

  /**
   * Once per row template: whether it holds one element (a <tr>, an <li>), so rows clone just that
   * and no fragment. Not a nested <template>: an anchor needs a parent for its end marker.
   */
  function oneElement(tpl: HTMLTemplateElement): boolean {
    const content = tpl.content, f = content.firstChild;
    const one = !!f && f == content.lastChild && f.nodeType == 1 && (f as Element).localName != 'template';
    prepared.set(tpl, one);
    return one;
  }

  /** A row template with a lookup function whose elements only have value bindings and handlers (no state, model, nested template or dialog). */
  function isSimple(t: TemplateDef): Simple | null {
    let v = simple.get(t);
    if (v === undefined) {
      const pick = (on: boolean) => t.nodes.flatMap((nd, k) => nd.b.filter((b) => (b.k == 'on') == on).map((b): [number, Binding] => [k, b]));
      v = t.find != null && t.nodes.every((nd) => !nd.dl && nd.state == null && nd.b.every((b) => SIMPLE.has(b.k))) ? { vals: pick(false), hs: pick(true) } : null;
      simple.set(t, v);
    }
    return v;
  }

  /** Drops removed bindings from the deferred and select sets. */
  function forget(rbs: RB[]) {
    for (const rb of rbs) {
      deferred.delete(rb);
      selects.delete(rb);
      for (const r of rb.rows ?? []) if (r.rbs) forget(r.rbs);
    }
  }

  /**
   * The element's handler bindings: bound at mount, or, for an element in a row of a simple template,
   * on its first event (the row is found above it, the element among the row's bound elements).
   */
  function handlersOf(el: Tagged): RB | RB[] | undefined {
    const h = el[HANDLERS];
    if (h != null) return h;
    let a: Element | null = el, x: Inst | undefined;
    while (a && a != root && !(x = (a as RowNode)[ROW])) a = a.parentElement;
    if (!x) return undefined;
    const t = x.t!, els: Array<Element | null> = fns[t.find!]!(x.first), k = els.indexOf(el);
    const rbs = k < 0 ? [] : isSimple(t)!.hs.filter((y) => y[0] == k).map(([, b]): RB => ({ b, el, s: x!.s, v: UNSET, c: false }));
    return rbs.length ? (el[HANDLERS] = rbs.length == 1 ? rbs[0]! : rbs) : undefined;
  }

  // ---- events

  function dispatch(e: Event) {
    let el = e.target as Element | null;
    if (el?.nodeType != 1) el = (el as Node | null)?.parentElement ?? null;
    if (!el) return;
    if (e.type == 'toggle' && el.localName == 'dialog' && el.hasAttribute('open')) {
      for (const rb of [...deferred]) if (deferred.has(rb) && el.contains(rb.el)) { cur = []; walk([rb], 2); }
      // a select's options inside the dialog render after its model: set its value again
      syncSelects();
    }
    // models update state before other handlers on the same event
    const m = (el as Tagged)[MODEL];
    if (m && /^(input|change)$/.test(e.type) && (e.type == 'input') == (m.b.n == 'text')) setModel(m, readModel(m), e.type == 'input' && !m.el.localName.includes('-'));
    for (; el; el = el.parentElement) {
      const h = handlersOf(el as Tagged), hs = h && (Array.isArray(h) ? h : [h]).filter((x) => x.b.n == e.type && (x.b.q == null || app.ext.keys!(x, e as KeyboardEvent)));
      if (hs?.length) {
        for (const h of hs) h.b.x != null ? trigger(h, e) : h.b.ms ? later(h, e) : handle(h, h.b.f!, e, h.b.w);
        // a bubbling custom event is a notification: it goes on up until a handler prevents it. Otherwise handled:
        // any handler or action ran; for keys, a filter matched (it prevents the default), an action or a
        // debounced handler ran, or a plain handler prevented the default. A key it did not prevent goes on up.
        if (e instanceof CustomEvent && e.bubbles ? e.defaultPrevented : !/^key/.test(e.type) || e.defaultPrevented || hs.some((h) => h.b.x != null || h.b.ms)) return;
      }
      if (el == root) return;
    }
  }

  /** Runs a handler expression and invalidates what it may have changed. */
  function handle(rb: RB, f: number, e: Event | null, writes: string[] | undefined, extra?: object) {
    app.exec(f, child(rb.s, { $el: rb.el, $event: e, $f: app.storeFns(rb.el), ...extra }), writes);
  }

  /** A debounced handler: runs once `ms` after the last event, with that event. */
  function later(rb: RB, e: Event) {
    const t = timers.get(rb);
    if (t) { env.clearTimeout(t); app.busy--; }
    app.busy++;
    // the element may have left the page (its row removed) while the handler waited
    timers.set(rb, env.setTimeout(() => { timers.delete(rb); app.busy--; if (rb.el.isConnected) handle(rb, rb.b.f!, e, rb.b.w); }, rb.b.ms!, 'debounce'));
  }

  // ---- actions

  /** `e` is null for `run()`: no event, no default to prevent */
  function trigger(rb: RB, e: Event | null) {
    const a = ir.actions[rb.b.x!]!, el = rb.el;
    // an action does not end a custom event's walk: it prevents only native defaults
    if (e && !(e instanceof CustomEvent) && (e.type == 'submit' || el.localName == 'a' || (e.type == 'click' && /^(button|input)$/.test(el.localName) && el.closest('form')))) e.preventDefault();
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

  function fire(rb: RB, a: ActionDef, e: Event | null) {
    const st = act(rb.el), get = a.method == 'GET';
    if (!get && a.concurrency == 'block' && st.n) return;
    const s = child(rb.s, { $el: rb.el, $event: e });
    let url = '', body: unknown;
    try {
      // a call's arguments are taken when it is triggered, like a request's URL and body
      if (a.call) body = fns[a.call.args]!(s);
      else {
        url = app.url(a.url, s);
        const fields = a.form && !get && a.method != 'DELETE';
        // form encoding: the fields as the browser would submit them (FormData), then as one of its bodies
        body = a.body != null ? fns[a.body]!(s) : fields ? (a.enc == 'form' ? new FormData(rb.el as HTMLFormElement) : serialize(rb.el as HTMLFormElement)) : undefined;
        if (a.enc == 'form') body = formBody(body);
      }
    } catch (err) {
      return unhandled(toError(err), rb.el);
    }
    // a question first: the action runs only when the user agrees
    const question = a.confirm != null ? fns[a.confirm]!(s) : null;
    if (question) {
      const yes = config.confirm(String(question));
      if (yes instanceof Promise) return void yes.then((y) => y && go());
      if (!yes) return;
    }
    go();
    function go() {
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
  }

  async function send(rb: RB, a: ActionDef, st: ActState, url: string, body: unknown, drop: (ok?: boolean) => void, c?: AbortController) {
    const el = rb.el as HTMLFormElement, s = rb.s;
    st.n++;
    el.setAttribute('aria-busy', 'true');
    if (a.form && a.concurrency == 'block' && !c && !st.off) {
      st.off = ([...el.elements] as HTMLInputElement[]).filter((x) => !x.disabled);
      for (const x of st.off) x.disabled = true;
    }
    try {
      const result = a.call
        ? await invoke(a.call.run, body, { signal: hide.signal, request: (u: string, i?: SendInit) => req.send(u, i), el })
        : await req.send(url, { method: a.method, body, signal: c?.signal });
      // a superseded GET's change is rolled back; a success keeps it, under what `then` writes
      if (c && st.c != c) return drop();
      drop(true);
      // write-through lands between the commit and `then`, so `then` still has the last word
      if (a.ap) app.ext.apply?.(a, s, url, body, result);
      if (a.then != null) handle(rb, a.then, null, a.w, { $result: result });
    } catch (err) {
      drop();
      if (isAbort(err) || (c && st.c != c)) return;
      const error = a.call ? callError(err) : toError(err);
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
    const r = createResource(def.name, { key: def.key, order: def.order, locale: () => config.locale?.get(), warn, prep: (x) => (app.prep ? app.prep(x) : x), freeze: app.dev });
    r.onDirty = (what) => app.mark((what == 'data' ? '$r.' : '$meta.') + def.name);
    resources.set(def.name, r);
    Object.defineProperty(app.page.$r, def.name, { get: r.value, enumerable: true });
    app.page.$meta[def.name] = r.meta;
    let url: string | null = null, c: AbortController | null = null, seq = 0, again: Promise<void> | null = null, typing: unknown = null;

    const scope = () => app.scopeOf(def.scope);
    /** `call`: the arguments of the current load; the identity of a load is its arguments' JSON */
    let args: unknown[] = [], calls = 0;
    const resolve = () => {
      const s = scope();
      if (def.call) {
        try {
          if (def.when != null && !fns[def.when]!(s)) return null;
          args = fns[def.call.args]!(s);
          try { return 'call:' + JSON.stringify(args); } catch { return `call:#${++calls}`; }
        } catch (e) { warn(17, def.name, (e as Error).message); return null; }
      }
      try { return def.when != null && !fns[def.when]!(s) ? null : app.url(def.src, s); } catch (e) { warn(17, def.name, (e as Error).message); return null; }
    };
    const loading = (on: boolean) => { if (r.meta.loading != on) { r.meta.loading = on; r.onDirty('meta'); } };
    const pick = (path: string | null, body: unknown): any => (path ? path.split('.').reduce((x: any, k) => x?.[k], body) : body);
    const fill = (items: any, total: number | null, m: unknown) => {
      l.pager?.appends(m) && r.isCollection ? items.forEach(r.upsert) : r.replace(items);
      r.setTotal(total);
      l.pager?.received(items, total, m);
    };
    /** stores a response; `req` is the URL it came from, for the page-load cache */
    const store = (body: unknown, req: string, m = l.pager?.current()) => {
      let items = pick(def.items, body);
      if (r.isCollection && !Array.isArray(items)) { warn(12, def.name, def.items ?? '(response)'); items = []; }
      if (Array.isArray(items)) items = items.map(clean);
      const t = def.total ? pick(def.total, body) : null, total = t == null ? null : +t;
      fill(items, total, m);
      if (def.cache != null) app.ext.cache?.loaded(def, r, req, items, total, !!l.pager?.appends(m));
      return items;
    };
    /** the request URL for the current page of `u` */
    const request = (u: string, m = l.pager?.current()) => withParams(u, m ? l.pager!.params(m) : null);

    const fail = (e: unknown) => {
      const error = toError(e);
      r.meta.error = error;
      r.onDirty('meta');
      unhandled(error, null, def.name);
    };
    const l: ResourceLoader = {
      def, res: r, app, pager: null as Pager | null,
      scope, get: loadShared, failed: fail, loading, url: () => url,
      done: (v) => def.then != null && app.exec(def.then, child(scope(), { $result: v }), def.w),
      items(body) {
        let items = pick(def.items, body);
        if (!Array.isArray(items)) { warn(12, def.name, def.items ?? '(response)'); items = []; }
        return items.map(clean);
      },
      start() {
        const el = def.data != null ? found.get(def.data) : null;
        let data;
        if (el) {
          if (el.localName == 'script' && el.parentElement?.localName == 'head') try { data = { v: JSON.parse(el.textContent!) }; } catch { warn(5, def.name); }
          else warn(4, def.name);
        }
        url = data ? resolve() : null;
        if (url == null) {
          // the page-load cache: show the last confirmed data now; changed() revalidates
          const u = def.cache != null && app.ext.cache ? resolve() : null;
          if (u != null) {
            l.pager?.reset();
            const hit = app.ext.cache!.read(def, request(u));
            // loadedAt stays null: it means the server answered during this page load, and
            // guards such as `$meta.user.loadedAt && !user` must not act on another page's data
            if (hit) fill(hit.items, hit.total, l.pager?.current());
          }
          return l.changed();
        }
        l.pager?.reset();
        const v = store(data!.v, request(url));
        r.meta.loadedAt = env.now();
        l.done(v);
      },
      /** `src` or `when` may have changed: reload from the first page if the URL differs. From typing: once the typing pauses. */
      changed(soft?: boolean) {
        if (typing != null) { env.clearTimeout(typing); typing = null; app.busy--; }
        if (soft) { app.busy++; typing = env.setTimeout(() => { typing = null; app.busy--; l.changed(); }, TYPING, 'debounce'); return; }
        const u = resolve();
        if (u === url) return;
        url = u;
        l.pager?.reset();
        if (u != null) return void l.load();
        c?.abort();
        r.replace(r.isCollection ? [] : null);
        if (def.cache != null) app.ext.cache?.cleared(def);
        loading(false);
      },
      /** Repeats the current request; several calls in one task share one request. */
      refetch: () => (again ??= Promise.resolve().then(() => { again = null; return l.load(); })),
      async load(move?: unknown) {
        if (url == null) return;
        c?.abort();
        const ctl = (c = new AbortController()), n = ++seq, m = l.pager && (move ?? l.pager.current());
        const mark = r.startLoad();
        let loaded = false, v;
        loading(true);
        try {
          const req = withParams(url, m ? l.pager!.params(m) : null);
          const body = def.call
            ? await invoke(def.call.run, args, { signal: ctl.signal, request: (u: string, i?: SendInit) => app.req.send(u, i), el: null })
            : await loadShared(req, ctl.signal, def.lo);
          if (n != seq) return;
          v = store(body, req, m);
          loaded = true;
          r.meta.error = null;
          r.meta.loadedAt = env.now();
        } catch (e) {
          if (n != seq || isAbort(e)) return;
          fail(def.call ? callError(e) : e);
        } finally {
          // writes made while this load ran win over its (older) response
          r.endLoad(mark, loaded);
          if (n == seq) { c = null; loading(false); }
        }
        // after the store and `$meta` have the response, so `then` sees them
        if (loaded) l.done(v);
      },
    };
    if (def.each) app.ext.each!.fanOut(l);
    if (def.paginate) l.pager = app.ext.paginate!.pager(l);
    r.loader = l;
    loaders.push(l);
  }

  /** GETs `url`; concurrent loads of one URL share one request, aborted when no one waits. `lo`: low priority (a resource only dialogs read). */
  function loadShared(url: string, signal: AbortSignal, lo?: 1): Promise<unknown> {
    let e = shared.get(url);
    if (!e) {
      const c = new AbortController(), entry = { n: 0, c, p: req.send(url, { signal: c.signal, ...(lo ? { priority: 'low' as const } : {}) }) };
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
  const [path, hash] = url.split('#'), i = path!.indexOf('?'), base = i < 0 ? path! : path!.slice(0, i), q = new URLSearchParams(i < 0 ? '' : path!.slice(i + 1));
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
/**
 * A body as form fields (`data-sn-encoding="form"`): a form's own fields, or an object's keys with
 * arrays as repeated keys; null and undefined values are left out. Files stay multipart.
 */
export function formBody(body: unknown): URLSearchParams | FormData | null {
  if (body == null) return null;
  if (body instanceof FormData) {
    const out = new URLSearchParams();
    for (const [k, v] of body) {
      if (typeof v != 'string') return body;
      out.append(k, v);
    }
    return out;
  }
  if (body instanceof URLSearchParams) return body;
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    for (const x of Array.isArray(v) ? v : [v]) if (x != null) out.append(k, typeof x == 'object' ? JSON.stringify(x) : String(x));
  }
  return out;
}

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
    // a container at each step; a scalar written there earlier (`a`, then `a.b`) is replaced
    segs.forEach((s, i) => (o = typeof o[s] == 'object' && o[s] ? o[s] : (o[s] = /^\d+$/.test(segs[i + 1] ?? k) ? [] : Object.create(null))));
    if (type == 'checkbox' && boxes[name]! > 1) (o[k] ??= []).push(...(c.checked ? [c.value] : []));
    else o[k] = type == 'checkbox' ? c.checked
      : /^(number|range)$/.test(type) ? (c.value === '' ? null : +c.value)
      : type == 'select-multiple' ? [...c.selectedOptions].map((x) => x.value)
      : c.value;
  }
  return out;
}
