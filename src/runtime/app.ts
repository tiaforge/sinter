// The runtime: mounts a compiled page, owns the store, the scheduler, the
// renderer, delegated events, actions and resource loading. Written as one
// closure so private state minifies to short local names.
import type { ActionDef, Binding, Fn, IR, NodeDef, PathRef, ResourceDef, TemplateDef, UrlTemplate } from '../ir.js';
import { decode, level as reachLevel, passes, type Reach } from '../paths.js';
import { config, SinterError, type Middleware } from './config.js';
import { envOf, type Env } from './env.js';
import { prefetched } from './handoff.js';
import { createRequestLayer, isAbort, readBody, toError, type RequestLayer, type SendInit } from './request.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './security.js';
import { expand, readUrl as readFrom, withParams } from './url.js';

export { withParams };
import { clean, createResource, type Resource } from './store.js';
import { TYPING } from './wait.js';

/** A shared GET's response, and its body, parsed on first read (a non-2xx status rejects there). */
export interface Got { res: Response; body(): Promise<unknown> }
const gotOf = (res: Response): Got => {
  let b: Promise<unknown> | null = null;
  return { res, body: () => (b ??= readBody(res)) };
};
/** what `get` returns for a response that is the data the store already holds: nothing is stored, and `done` gets it as `$result` */
export const UNCHANGED = Symbol('unchanged');

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

/** A binding attached to one element in one scope. */
export interface BoundBinding {
  b: Binding;
  el: Element;
  s: any;
}

/** Pagination state of one resource; a "move" is one page request, repeated exactly by refetch. */
export interface Pager {
  /**
   * the resource's URL changed: back to the first page. With `page-model`, `why` says what changed it:
   * 0 its first URL after mount (the URL's page, restored), 2 anything later (page 1 and the parameter
   * deleted, unless Back or Forward caused it: then the URL's page)
   */
  reset(why?: number): void;
  /** `page-model`: the parameter may have changed (the URL did not): loads the page it names */
  follow?(): void;
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
  /** `quiet`: a background reload (`refresh`): `$meta.loading` stays false, and a failure while already failing is not reported again */
  load(move?: unknown, quiet?: boolean): Promise<void>;
  refetch(hint?: object, quiet?: boolean): Promise<void>;
  /** whether a load is in flight */
  inflight(): boolean;
  /** called after each load settles (true: it succeeded, its content changed or not); feature modules add to it */
  readonly settled: Array<(ok: boolean) => void>;
  /** a load settled: calls `settled` (for feature modules that load themselves, as `each`) */
  settle(ok: boolean): void;
  /** for feature modules: the scope `src` and `when` are evaluated in */
  scope(): any;
  /**
   * a shared GET's body (concurrent loads of one URL share one request); a feature module may replace it, and return UNCHANGED.
   * `lo`: flags, 1: low priority (a resource only dialogs read), 2: a background load (no retry policy: `refresh` retries by itself)
   */
  get(url: string, signal: AbortSignal, lo?: number): Promise<unknown>;
  /** for feature modules: the shared GET's response, before its body is read */
  got(url: string, signal: AbortSignal, lo?: number): Promise<Got>;
  /** for feature modules: the collection items of a response body (`items` path, checked, cleaned) */
  items(body: unknown): any[];
  /** for feature modules: a failed load: `$meta.error`, then the unhandled-error path (`quiet`: only if it was not failing already) */
  failed(e: unknown, quiet?: boolean): void;
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
      /** restores a persisted state object, and saves it after each flush that changed its scope `sid` */
      state(key: string, obj: Record<string, unknown>, sid: number): void;
    };
    cache?: {
      /** the cached data for a request, if any and not older than the resource allows */
      read(def: ResourceDef, url: string): { t: number; items: unknown; total: number | null } | null;
      /** a load (or embedded data) stored `items`: cache them, and the resource's later changes */
      loaded(def: ResourceDef, r: Resource, url: string, items: unknown, total: number | null, appended: boolean): void;
      /** the resource was emptied (`when` is false): nothing to write until the next load */
      cleared(def: ResourceDef): void;
    };
    /** `refresh` on a resource: reloads it when its last load is that old */
    refresh?: { watch(loader: ResourceLoader): void };
    /** unchanged reloads (`ETag`, `Last-Modified`): a reload with the version of the data shown stores nothing */
    versions?: { watch(loader: ResourceLoader): void };
    /** next-page data the previous page requested for this request (taken once), if any and recent */
    prefetch?: { take(def: ResourceDef, url: string): { t: number; items: unknown; total: number | null } | null };
    /** a key filter's handler (`b.q`): whether this key event is for it (a match prevents its default) */
    keys?: (rb: BoundBinding, e: KeyboardEvent) => boolean;
    /** write-through: a mutation's 2xx response, applied to the resources it is about (before `then`) */
    apply?: (a: ActionDef, scope: any, url: string, body: unknown, result: unknown) => void;
    /** an action is sent: the form's marks and `$error` are cleared; the function reports a failure, true when the form shows it */
    /** action functions (call.ts): runs one with its context (an action's signal aborts on pagehide); what one throws as an `$error` */
    call?: { run(f: number, args: unknown, el: Element | null, signal?: AbortSignal): Promise<unknown>; error(e: unknown): SinterError };
    /** debounced handlers and actions (debounce.ts): runs `run` once, `ms` after the last call for `key` */
    debounce?: (key: object, ms: number, run: () => void) => void;
    /** `data-sn-confirm` (confirm.ts): runs `go` once the user agrees to `question` (at once when it is falsy) */
    confirm?: (question: unknown, go: () => void) => void;
    /** models of controls other than text fields (models.ts) */
    models?: (inner: ModelInner) => Models;
    /**
     * `$url` written (location.ts): `write` records a changed parameter and the history entry it asks
     * for (1 replace, 2 typing, 3 a number field's burst, 4 push; the strongest of a flush pass wins); `end` ends a typing run
     * (`change` on a text field bound to the URL), committing what waits;
     * `back`: the flush running follows Back or Forward (`popstate`), so nothing it causes writes the URL
     */
    location?: {
      write(name: string, kind: number): void;
      end(): void;
      readonly back: boolean;
      /** `page-model` (paginate.ts): sets a parameter (null deletes it) and writes it with `kind` */
      set(name: string, value: string | null, kind: number): void;
    };
    /** a form action's body (form.ts): the form's fields without `data-sn-body`, and `data-sn-encoding="form"` */
    form?: (el: Element, a: ActionDef, body: unknown) => unknown;
    /**
     * selection bindings (select.ts): given the renderer's internals, the check for a list whose rows
     * no other change reaches. `free`: the index may be used (no row was reconciled this round, none
     * waits in a closed dialog). 0: no selection's outer side changed; 1: the rows concerned were
     * rendered; 2: every row renders
     */
    select?: (inner: Inner) => (rb: BoundBinding, free: boolean) => number;
    /** nested items (nested.ts): changes an item under a resource's rows, through `fields`; the list `upsert(c.replies, x)` gives */
    nested?: {
      /** applies one change to an item from `names`; for write-through, one under `r` through `fields` (true when found) */
      change(res: (n: string) => Resource, op: 'patch' | 'remove', names: string[], item: unknown, set: any): void;
      apply(r: Resource, fields: string[], op: 'patch' | 'remove', item: unknown, set: any, byId: boolean): boolean;
      /** `upsert(c.replies, x)`: `owner` (from `names`) gets its list `field` with `item` in it */
      upsert(res: (n: string) => Resource, names: string[], owner: any, field: string, item: unknown): void;
    };
    /** shared definitions (defs.ts): an empty `<template data-sn-def>` gets its definition before it is first cloned */
    defs?: (tpl: HTMLTemplateElement) => void;
    /** components with a script (components.ts): a root's `cmp` binding, `v` its class module, props and class name */
    components?: (rb: BoundBinding, v: unknown) => void;
    fields?: { sent(el: Element, a: ActionDef): ((error: SinterError, request: { url: string; method: string }) => boolean) | undefined };
  };
  readonly beforeFlush: Array<(dirty: Dirty[]) => void>;
  readonly afterFlush: Array<(dirty: Dirty[]) => void>;
  readonly onListen: Array<(event: string) => void>;
  /** root state scopes: [sid, state object] */
  readonly states: Array<[number, any]>;
  /** pending debounce timers and waiting actions, for the testing module */
  busy: number;
  /**
   * the event whose handlers run, and what they cause (an action's `then`/`catch`, a debounced run,
   * `emit`): location.ts pushes a history entry for a `$url` write when it is the user's
   */
  readonly ev: Event | null;
  readonly isDirty: boolean;
  /** dev hooks: dev-only checks on, warnings by code (or text), and item preparation (freezing) */
  dev: boolean;
  /** for feature modules: the unhandled-error path (`sn-error` from `el`, then `onError`, then the dev console) */
  unhandled(error: SinterError, el: Element | null): void;
  /** dev builds: returns true for a handler's error (code 24) it reported; the core logs it otherwise */
  warn(code: number | string, ...args: unknown[]): unknown;
  prep?: <T>(item: T) => T;
  /** dev: a list's row keys, checked for duplicates */
  dupes?: (keys: unknown[]) => void;
  /** dev: an EventSource stream opened (its connection counts against HTTP/1.1's 6 per origin) */
  streamOpened?: (url: string) => void;

  resource<T extends object = any>(name: string): Resource<T>;
  request(url: string, init?: SendInit): Promise<unknown>;
  optimistic<T>(change: () => void, run: () => Promise<T>): Promise<T>;
  on(event: string, fn: (payload: any) => void): () => void;
  destroy(): void;

  url(tpl: UrlTemplate, scope: any): string;
  /** the scope of root node `i` (its state), or the page scope for -1 */
  scopeOf(i: number): any;
  /**
   * `path`: a node of the page's path table, or one of the paths the runtime marks itself by name
   * (`$locale`, `$r.<name>`, `$s<sid>.$error`, …: the table's `x`). `typing`: the change is a keystroke
   * in a text field, so a resource URL it changes waits for a pause
   */
  mark(path: number | string, scope?: any, typing?: boolean): void;
  flush(): void;
  /**
   * Runs `fn`, a server event's changes: what it marks is rendered before the next frame is painted
   * rather than in a microtask, so many events in one frame render once. Anything else that marks
   * (a handler, a response) still flushes at once, with these changes. Hidden pages and environments
   * without frames (the testing module) flush in a microtask, as for any change.
   */
  streamed(fn: () => void): void;
  /** records `change` as optimistic layers; the returned function settles them: committed when `ok`, else rolled back */
  record(change: () => void): (ok?: boolean) => void;
  storeFns(el: Element | null): Record<string, (...a: any[]) => unknown>;
  serverEvent(name: string, payload: unknown): void;
  /** runs handler `f` in `scope` and invalidates the paths it writes; `o`: the binding it runs for (dev builds name its place) */
  exec(f: number, scope: any, writes?: PathRef[], o?: { at?: Record<number, string> }): void;
  addCleanup(fn: () => void): void;
  /** runs `fn` now, or, on a page the browser prerenders (Speculation Rules), once it is shown */
  shown(fn: () => void): void;
}

/** The renderer's internals the models of controls other than text fields (models.ts) use. */
export interface ModelInner { evaluate(rb: any): any; deferred: Set<any> }
export interface Models { write(rb: any, v: unknown): void; read(rb: any): unknown; bound(rb: any): void; forget(rb: any): void; sync(): void }

/** The renderer's internals the selection index (select.ts) uses. */
export interface Inner {
  hit(deps: PathRef[] | undefined, s?: any): boolean;
  isSimple(t: TemplateDef): { vals: Array<[number, Binding]> } | null;
  walkSimple(x: any, t: TemplateDef, meta: any, force: number, only?: number): void;
  process(rb: any, level: number): boolean;
}

/** Runtime binding: the bound binding plus last value and list/conditional state. */
interface RB extends BoundBinding {
  v?: unknown;
  /** evaluation scope: the binding's scope plus `$el`, created once */
  e?: any;
  /** may be inside a closed dialog of its block */
  c?: boolean;
  /** for: rows; if: the rendered branch (0 or 1 entries) */
  rows?: Inst[];
  t?: TemplateDef;
  /** end marker of the rows / branch, inserted after the template anchor */
  end?: Comment;
  /** for: rows by key, built on demand (null: keys are explicit or not unique), and the round of the last reconcile */
  keys?: Map<unknown, Inst> | null;
  rr?: number;
  /** for: some rows wait for a re-evaluation (`Inst.f`) since the last walk over all of them */
  pf?: boolean;
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
  /** the running write's retry: aborted when a newer `latest` trigger replaces it while it waits */
  r: AbortController | null;
  off: HTMLInputElement[] | null;
}

const instances = new WeakMap<object, App>();
/**
 * A marked path: a node of the page's path table (-1: one nothing reads) and the values its `{name}`
 * segments took from the writer's scope, in order.
 */
export interface Dirty { w: number; v: string[] }
/** node lists in the IR (numbered by the compiler) */
const ids = (x: PathRef[] | undefined) => (x ?? []) as number[];
/** Sentinel for "not written yet". */
const UNSET = {};
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
const HANDLERS = Symbol('sinter.on');
/** a control's model binding, on the element (location.ts reads it) */
export const MODEL = Symbol('sinter.model');
/** an element's own `data-sn-state`: `[sid, state object]` (for feature modules: a form's `$error`) */
export const STATE = Symbol('sinter.state');

/** The nearest `data-sn-state` scope of `el`: its state id and object (testing's `state(el)`). */
export function scopeState(el: Element): [number, any] | null {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const s = (e as Tagged)[STATE];
    if (s) return s;
  }
  return null;
}
/** HANDLERS: one handler binding, or an array when the element has several */
export type Tagged = Element & { [HANDLERS]?: RB | RB[]; [MODEL]?: RB; [STATE]?: [number, any] };
const indexReaders = new WeakMap<TemplateDef, boolean>();
const others = new WeakMap<TemplateDef, number[]>(), allDeps = new WeakMap<TemplateDef, number[]>();
/** row templates: whether each holds one element (see oneElement()) */
const prepared = new WeakMap<HTMLTemplateElement, boolean>();
/** set by the early script on a `data-sn-for` template whose rows it rendered from embedded data: each row's nodes, the end marker */
const EARLY_ROWS = Symbol.for('sinter.early.rows');
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
  if (ir?.v != 2 || !ir.ps) throw Error('sinter: unsupported IR');
  const env = o.env ?? envOf(config);
  const req = createRequestLayer(env, o.request ?? config.request);
  const schemes = schemesOf(config.urlSchemes);
  const resources = new Map<string, Resource>(), loaders: Array<{ def: ResourceDef; changed(typing?: boolean): void; start(): void; refetch(): Promise<void> }> = [];
  const acts = new WeakMap<Element, ActState>();
  /** props set on custom elements not defined yet, by element: the latest value of each */
  const early = new WeakMap<Element, Map<string, unknown>>();
  const types = new Set<string>(), deferred = new Set<RB>();
  const listeners = new Map<string, Set<(p: unknown) => void>>(), cleanups: Array<() => void> = [];
  const shared = new Map<string, { n: number; c: AbortController; p: Promise<Got> }>();
  /** `showModal(id)`, `close(id)`: the dialog of this mount root with that id; `run(id)`: any element */
  const byId = (id: string, s = '[id]') => [...root.querySelectorAll(s)].find((d) => d.id === id);
  const dialog = (id: string) => byId(id, 'dialog') as HTMLDialogElement | undefined;
  const rootRbs: RB[] = [], rootScopes: any[] = [], found = new Map<number, Element>();
  let dirty: Dirty[] = [], cur: Dirty[] = [], scheduled = false, flushing = false, round = 0, destroyed = false;
  /** inside `streamed()`; a flush waits for the next frame */
  let streaming = 0, framed = false;
  /** dirty paths of this round that keystrokes in text fields produced */
  const typed = new Set<Dirty>();
  /** `app.ev`; `synth`: a submit `run()` causes */
  let ev: Event | null = null, synth = false;
  /** runs `fn` with `push` as `u`: the context of the event that caused it */
  const as = (u: Event | null, fn: () => void) => { const was = ev; ev = u; try { fn(); } finally { ev = was; } };

  const res = (name: string): Resource => {
    const r = resources.get(name);
    if (!r) throw Error(`sinter: no resource ${name}`);
    return r;
  };
  /**
   * `patch(item, …)`, `remove(item)`: the compiler passes the resources the item can come from; it is
   * changed in the one that holds it, by key (a single resource is the item itself)
   */
  const byItem = (m: 'patch' | 'remove') => (names: string[], item: any, set?: any) => {
    // a source under a row (`comments>replies`): the nested module, loaded with it, does it all (the rows too:
    // a few bytes there, which pages without nested lists do not load, rather than in the core)
    if (app.ext.nested) return app.ext.nested.change(res, m, names, item, set);
    for (const n of names) {
      const r = res(n);
      if (r.isCollection ? item != null && r.has(item) : true) return void (m == 'patch' ? r.patch(item, set) : r.remove(item));
    }
  };
  const warn = (code: number | string, ...args: unknown[]) => app.warn(code, ...args);
  /** `rb`: keeps the `$el` scope of a bound binding; a simple row's binding makes one per evaluation */
  const evalB = (b: Binding, s: any, el: Element, rb: RB | null): any => {
    try { return fns[b.f!]!(b.e ? (rb ? (rb.e ??= child(s, { $el: el })) : child(s, { $el: el })) : s); } catch (e) { warn(6, b, el, e); }
  };
  const evaluate = (rb: RB): any => evalB(rb.b, rb.s, rb.el, rb);
  /** The writers, one per binding kind: `(element, name, value)`; a template's creation function calls them too. */
  const W = {
    U: UNSET,
    t(el: HTMLElement, _n: string, v: any) {
      const t = el.firstChild as Text | null;
      // an element without content (a new row) takes a number as it is: the DOM converts it, while
      // converting here would fill V8's number-to-string cache (64 KB after creating 1,000 rows). Not
      // 0 or NaN: DOM implementations that treat a falsy value as no text (the test DOM) would drop them
      if (!t && typeof v == 'number' && v) { el.textContent = v as any; return; }
      v = '' + (v ?? '');
      // the same text is not written again: an adopted early row, or a server-rendered one, keeps its text node
      // (a write counts as new content for the browser's paint timing, LCP)
      if (t?.nodeType == 3 && !t.nextSibling) { if (t.data !== v) t.data = v; }
      else if (el.textContent !== v) el.textContent = v;
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
      // relative URLs by the base of the document rows go into (a clone's own is its template's, about:blank)
      else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), doc.baseURI, schemes)) el.setAttribute(n, v);
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
  /** Per flush round: how dirty paths reach a template's rows (0 not, 1 only marked elements, 2 any row). */
  let rowHits = new Map<TemplateDef, number>();
  /** Per flush round: the rows of a template the round's changes select by their index (null: any row). */
  let rowSel = new Map<TemplateDef, Set<number> | null>();

  // ---- dependency paths: the compiler numbered them and decided which written path reaches which
  // dependency (`paths.ts`); what is left here are the checks against runtime values

  const ps = ir.ps!, par = ps.p, kinds = ps.k ?? {};
  const slotsOf: string[][] = [], entriesOf: Reach[][] = [];
  /** a node's path, top-down */
  const up = (n: number) => { const a: number[] = []; for (; n >= 0; n = par[n]!) a.unshift(n); return a; };
  /** the scope names of a written node's `{name}` segments, top-down */
  const slots = (w: number) => slotsOf[w] ??= up(w).flatMap((n) => (kinds[n]?.[0] == '{' ? [kinds[n]!.slice(1, -1)] : []));
  /** the dependency nodes a written node can reach */
  const entries = (w: number) => entriesOf[w] ??= (ps.r[w] || []).map(decode);
  /** the template whose row element a dependency node reads (its first `{$i<tid>}` segment), -1 for none */
  const ownOf = (n: number) => { const k = up(n).map((x) => kinds[x]).find((k) => k?.startsWith('{$')); return k ? +k.slice(3, -1) : -1; };
  /**
   * Per flush round: by dependency node, the dirty paths that may reach it with their entries (the
   * checks that need no scope passed). The first one is in `tD`/`tE`, further ones in `tX` as pairs,
   * `tC` of them; all is stamped with the round (read only in a flush, whose rounds start at 1) and
   * reused, so a flush allocates nothing here.
   */
  const N = par.length, tR = new Int32Array(N), tC = new Int32Array(N), tD: Dirty[] = [], tE: Reach[] = [], tX: Array<Array<Dirty | Reach>> = [];
  function index(list: Dirty[]) {
    for (const d of list) if (d.w >= 0) for (const e of entries(d.w)) {
      if (e.conds.length && !passes(e, d.v)) continue;
      const n = e.d;
      if (tR[n] != round) { tR[n] = round; tC[n] = 0; tD[n] = d; tE[n] = e; continue; }
      const x = tX[n] ??= [], c = tC[n]++ * 2;
      x[c] = d;
      x[c + 1] = e;
    }
  }
  /** calls `f` for each dirty path of the round that may reach dependency node `n`, with its entry; stops when it returns true */
  const each = (n: number, f: (d: Dirty, e: Reach) => unknown): boolean => {
    if (tR[n] != round) return false;
    if (f(tD[n]!, tE[n]!)) return true;
    for (let x = tX[n]!, j = 0, c = tC[n]! * 2; j < c; j += 2) if (f(x[j] as Dirty, x[j + 1] as Reach)) return true;
    return false;
  };

  /**
   * How dirty path `d` reaches a dependency through entry `e`, its `{name}` segments read from scope
   * `s` (any scope when absent): 0 not, 1 only through a marked element (`~`) of the row, 2 it does.
   * A change that ends above a row's own element, or only changes the list structure (`#`), does not
   * reach it (the compiler left no entry): reconcile re-evaluates rows whose item or index changed.
   */
  const isMarked = (t: number, s: any) => marked.has(s[ir.templates[t]!.item!]);
  const level = (e: Reach, d: Dirty, s?: any) => (e.conds.length ? reachLevel(e, d.v, s, isMarked) : 2);

  /** Whether a binding in a template's rows (nested templates included) reads a loop index. */
  // (a component used inside itself makes a template its own descendant: the entry is set before it is computed)
  const readsIndex = (t: TemplateDef): boolean => indexReaders.get(t) ?? (indexReaders.set(t, false), indexReaders.set(t, t.nodes.some((nd) => nd.b.some((b) =>
    b.i || ((b.k == 'for' || b.k == 'if' || b.k == 'else') && readsIndex(ir.templates[b.x!]!))))), indexReaders.get(t)!);

  /** Dependencies of every binding in a template's rows, nested templates included. */
  const templateDeps = (t: TemplateDef): number[] => allDeps.get(t) ?? (allDeps.set(t, []), allDeps.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...ids(b.d),
    ...(b.k == 'for' || b.k == 'if' || b.k == 'else' ? templateDeps(ir.templates[b.x!]!) : []),
  ]))), allDeps.get(t)!);

  /**
   * The template's dependencies without the outer sides of its selection bindings: what reaches a row
   * for any other reason. The selection bindings of the template's own nodes.
   */
  const otherDeps = (t: TemplateDef): number[] => others.get(t) ?? (others.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...(b.s ? ids(b.d).filter((d) => !b.s!.d.includes(d)) : ids(b.d)),
    ...(b.k == 'for' || b.k == 'if' || b.k == 'else' ? templateDeps(ir.templates[b.x!]!) : []),
  ]))), others.get(t)!);

  /** Whether a dirty path of the current flush reaches one of `deps`. */
  const hit = (deps: PathRef[] | undefined, s?: any) => {
    for (const n of ids(deps)) if (tR[n] == round && ((!tE[n]!.conds.length && !tC[n]) || each(n, (d, e) => level(e, d, s)))) return true;
    return false;
  };
  /** 0: no dirty path reaches `deps`; 1: only keystrokes do; 2: some other change does. */
  const hits = (deps: PathRef[] | undefined) => {
    let k = 0;
    for (const n of ids(deps)) each(n, (d) => { k = typed.has(d) ? k || 1 : 2; });
    return k;
  };

  /**
   * The rows of `t` that the round's changes reach, by index: a change written through the row's own
   * element (`rows[i].done = …`, a `{$i<tid>}` segment) reaches the row at that index only. Null when
   * some change may reach any row (a write through another list indexed by the row's index included).
   */
  function rowsOf(t: TemplateDef): Set<number> | null {
    if (rowSel.has(t)) return rowSel.get(t)!;
    const out = new Set<number>();
    let all = false;
    for (const n of otherDeps(t)) if (each(n, (d, e) => {
      const c = e.conds.find((c) => (c[0] == 1 || c[0] == 2) && c[1] == t.ii);
      if (!c) return (all = true);
      // the index loosely equals the value (as `s[name] != value` compares it): the value as a number
      const i = Number(c[0] == 1 ? d.v[c[2]] : c[2]);
      if (Number.isInteger(i) && i >= 0) out.add(i);
    })) break;
    const r = all ? null : out;
    rowSel.set(t, r);
    return r;
  }

  const doc = (root.ownerDocument ?? root) as Document & { prerendering?: boolean };
  /** work that waits until a prerendered page is shown; null once it is (or when it never was prerendered) */
  let waiting: Array<() => void> | null = doc.prerendering ? [] : null;
  const app: App = {
    ir, fns, env, req, root, transport: o.transport ?? (() => undefined), ext: {},
    beforeFlush: [], afterFlush: [], onListen: [], states: [], busy: 0,
    get isDirty() { return dirty.length > 0 || scheduled; },
    get ev() { return ev; },
    dev: false,
    warn() {},
    unhandled,
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
    destroy() {
      destroyed = true;
      for (const c of cleanups.splice(0)) c();
      instances.delete(root);
    },
    scopeOf: (i) => (i < 0 ? app.page : rootScopes[i] ?? app.page),
    url: (tpl, s) => expand(tpl, s, fns),
    mark(path, s, typing) {
      const w = typeof path == 'number' ? path : ps.x[path] ?? -1;
      // the written path's `{name}` segments, as the writer's scope has them
      const d: Dirty = { w, v: w < 0 ? [] : slots(w).map((n) => (s ? '' + s[n] : '{' + n + '}')) };
      dirty.push(d);
      if (typing) typed.add(d);
      if (scheduled || flushing) return;
      if (streaming && env.frame && !env.hidden?.()) {
        // a frame flush only runs when no microtask flush took these changes first
        if (!framed) { framed = true; env.frame(() => { framed = false; if (!scheduled && dirty.length) app.flush(); }); }
      } else { scheduled = true; env.queueMicrotask(app.flush); }
    },
    streamed(fn) {
      streaming++;
      try { fn(); } finally { streaming--; }
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
          rowSel = new Map();
          index(cur);
          for (const l of loaders) { const k = hits(l.def.deps); if (k) l.changed(k == 1); }
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
      // `upsert(c.replies, x)`: the item that holds the list gets it as a patch
      upsert: (n: string | string[], a: any, f?: string, x?: any) => Array.isArray(n) ? app.ext.nested!.upsert(res, n, a, f!, x) : res(n).upsert(a),
      patch: byItem('patch'),
      remove: byItem('remove'),
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
        if (t.localName != 'form') return trigger(rb, null);
        synth = true;
        try { (t as HTMLFormElement).requestSubmit(); } finally { synth = false; }
      },
    }),
    serverEvent(name, payload) {
      for (const fn of listeners.get(name) ?? []) try { fn(payload); } catch (e) { console.error(e); }
    },
    exec(f, s, writes, o) {
      try { fns[f]!(s); } catch (err) { warn(24, o, f, err) ?? console.error(err); }
      for (const w of writes ?? []) app.mark(w, s);
    },
    // after destroy(), nothing waits for the next one: run it now
    addCleanup: (fn) => void (destroyed ? fn() : cleanups.push(fn)),
    shown: (fn) => void (waiting ? waiting.push(fn) : fn()),
  };
  app.page.$f = app.storeFns(null);
  instances.set(root, app);
  for (const f of o.features ?? []) f.install(app);
  /** controls other than text fields (models.ts), on pages with such a model */
  const models = app.ext.models?.({ evaluate, deferred });
  /** the selection index (select.ts), on pages with selection bindings */
  const sel = app.ext.select?.({ hit, isSimple, walkSimple, process });

  // ---- mount: one querySelectorAll, ids checked against the IR's tags
  const qsa = (root instanceof Document ? Document : Element).prototype.querySelectorAll;
  const bad = new Set<number>();
  for (const el of qsa.call(root, '[data-sn]')) {
    const id = +Element.prototype.getAttribute.call(el, 'data-sn')!;
    found.has(id) ? bad.add(id) : found.set(id, el);
  }
  for (const id of bad) { found.delete(id); warn(1, id); }
  for (const def of ir.resources) createLoader(def);
  // back from the bfcache, or online again: the data may have changed meanwhile. Resources a stream
  // feeds are refetched by the stream module when it reconnects.
  const fed = new Set((ir.syncs ?? []).flatMap((s) => s.events.map((e) => e.resource)));
  const again = () => { for (const l of loaders) if (!fed.has(l.def.name)) void l.refetch(); };
  app.addCleanup(env.listen('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) again(); }));
  app.addCleanup(env.listen('online', again));
  // prerendered (Speculation Rules): the page loaded while nobody saw it, maybe minutes ago, and
  // streams wait (app.shown). Shown: everything is refetched, then the waiting work runs
  if (waiting) {
    const on = () => {
      if (doc.prerendering) return;
      doc.removeEventListener('prerenderingchange', on);
      const w = waiting!;
      waiting = null;
      for (const l of loaders) void l.refetch();
      for (const fn of w) fn();
    };
    doc.addEventListener('prerenderingchange', on);
    app.addCleanup(() => doc.removeEventListener('prerenderingchange', on));
  }
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
      let s = scopes?.[nd.p ?? -1] ?? base;
      if (nd.state != null && el) {
        const obj = fns[nd.state]!(s), sid = nd.sid!, key = nd.persist;
        s = child(s, { ['$s' + sid]: obj });
        el[STATE] = [sid, obj];
        if (rbs == rootRbs) app.states.push([sid, obj]);
        if (key) {
          app.ext.persist?.state(key, obj, sid);
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
          models?.bound(rb);
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
        for (const n of otherDeps(t!)) each(n, (d, e) => { const x = level(e, d); r = Math.max(r!, x == 1 && ownOf(n) != t!.id ? 2 : x); });
        rowHits.set(t!, r);
      }
      // only a selection's outer side changed: the rows it concerns, through the index; rows that were
      // just reconciled (some re-rendered, the index stale) or wait in a closed dialog render as usual
      if (!r && sel && (r = sel(rb, rb.rr != round && !deferred.size)) == 1) continue;
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
      // changes written through a row index (`rows[i].v = …`) reach the rows at those indexes only, when
      // no row waits for a re-evaluation (the list was not reconciled since the last full walk)
      if (t && r == 2 && !force && !rb.pf && rb.rr != round) {
        const at = rowsOf(t!);
        if (at) {
          for (const i of at) { const x = rb.rows[i]; if (x && x.r != round) walkRow(x, t!, 0); }
          continue;
        }
      }
      // otherwise skip rows no dirty path can reach (unless they moved or changed), and rows created in this round
      for (const x of rb.rows) if (x.r != round && (r || x.f)) { walkRow(x, t!, Math.max(force, x.f)); x.f = 0; }
      rb.pf = false;
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
      if (el && (force == 2 || (force == 1 && b.i) || (b.d && hit(b.d, x.s)))) {
        const val = evalB(b, x.s, el, null);
        if (!Object.is(val, prev)) { write(b, el, val, prev == UNSET ? undefined : prev, prev == UNSET); v[j] = val; }
      }
      if (only >= 0) break;
    }
  }

  /** Evaluates and writes one binding if needed; false while it waits in a closed dialog. */
  function process(rb: RB, level: number): boolean {
    const force = level == 2 || (level == 1 && !!rb.b.i);
    if (!force && !(deferred.size && deferred.has(rb)) && !(rb.b.d && hit(rb.b.d, rb.s))) return true;
    if (rb.c && rb.el.closest('dialog:not([open])')) { deferred.add(rb); return false; }
    if (deferred.size) deferred.delete(rb);
    const v = evaluate(rb), k = rb.b.k;
    if (k == 'for') reconcile(rb, v);
    else if (k == 'if') toggle(rb, v ? 1 : rb.else ? 2 : 0);
    else if (k == 'model') writeModel(rb, v);
    else if (k == 'cmp') app.ext.components!(rb, v);
    else if (!Object.is(v, rb.v)) { write(rb.b, rb.el, v, rb.v == UNSET ? undefined : rb.v, rb.v == UNSET); rb.v = v; }
    return true;
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

  /** Sets each select's value again, as its options may have changed (models.ts). */
  function syncSelects() { models?.sync(); }

  // ---- models: text fields here, other controls in models.ts

  function writeModel(rb: RB, v: any) {
    const el = rb.el as HTMLInputElement;
    if (rb.b.n != 'text') models!.write(rb, v);
    else if (el.value != (v ?? '')) el.value = v ?? '';
  }

  /** The control's value for its model. */
  function readModel(rb: RB): unknown {
    return rb.b.n != 'text' ? models!.read(rb) : (rb.el as HTMLInputElement).value;
  }

  /** `typing`: a keystroke in a text field (`input` on an `<input>`/`<textarea>`), not a paste-like whole change */
  function setModel(rb: RB, v: unknown, typing?: boolean) {
    if (v === undefined) return;
    try { fns[rb.b.a!]!(rb.s, v); } catch (e) { return warn(9, rb.b, rb.el, e); }
    for (const w of rb.b.w ?? []) app.mark(w, rb.s, typing);
  }

  // ---- lists and conditionals

  function setRow(s: any, t: TemplateDef, item: unknown, i: number) {
    s[t.item!] = item;
    if (t.index) s[t.index] = i;
    s[t.ii!] = i;
    return s;
  }

  /**
   * A row's identity: the explicit key, the resource key, or the item object itself. A list the
   * compiler cannot trace to a resource (a helper's result: `t in visible(tasks, q)`) keys an item
   * that is a keyed resource's current item by that resource's key, so a patch (a new object)
   * keeps its row.
   */
  function keyOf(t: TemplateDef, item: any, s: any): unknown {
    if (t.key != null) return 'k' + fns[t.key]!(s);
    if (t.keyFields && item) return 'r' + t.keyFields.map((f) => item[f]).join('\x1f');
    if (Object(item) === item) {
      for (const r of resources.values()) if (r.isCollection && r.get(item) === item) return 'o' + r.name + '\x1f' + r.keyOf(item);
      return item;
    }
    warn(10);
    return 'p' + typeof item + item;
  }

  function reconcile(rb: RB, v: any) {
    const items: unknown[] = v == null ? [] : Array.isArray(v) ? v : Symbol.iterator in Object(v) ? [...v] : [];
    // rows the early script rendered from the page's embedded data: adopted (bound, not cloned again) when there
    // are as many items, else removed; the row's values are written again, so a changed item still renders right
    const pre: { rows: Node[][]; end: Comment } | undefined = (rb.el as any)[EARLY_ROWS];
    if (pre) {
      delete (rb.el as any)[EARLY_ROWS];
      const t = rb.t!, tpl = rb.el as HTMLTemplateElement;
      if (!rb.rows!.length && !rb.end && pre.rows.length == items.length) {
        rb.end = pre.end;
        rb.rows = items.map((item, i) => {
          const s = setRow(Object.create(rb.s), t, item, i);
          return instantiate(tpl, t, s, keyOf(t, item, s), item, i, pre.rows[i]);
        });
        rb.rr = round;
        rb.pf = true;
        return;
      }
      for (const n of pre.rows.flat()) (n as ChildNode).remove();
      pre.end.remove();
    }
    const t = rb.t!, old = rb.rows!, end = (rb.end ??= after(rb.el)), tpl = rb.el as HTMLTemplateElement;
    const n = items.length, m = old.length, rows: Inst[] = new Array(n), moved = readsIndex(t);
    // a scope is only needed up front for an explicit key expression
    const scopes = t.key != null ? items.map((item, i) => setRow(Object.create(rb.s), t, item, i)) : null;
    const keys = items.map((item, i) => keyOf(t, item, scopes?.[i]));
    app.dupes?.(keys);
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
    // each old row owns the nodes from its first node up to the next old row's first node
    const nodesOf = (o: number) => range(old[o]!.first, old[o + 1]?.first ?? end);
    // two rows swapped and the rows between them unchanged (swapping two items): two moves, no key map
    if (oe - a == ne - a && oe - a > 1 && old[a]!.key === keys[ne - 1] && old[oe - 1]!.key === keys[a]) {
      let j = a + 1;
      while (j < oe - 1 && old[j]!.key === keys[j]) j++;
      if (j == oe - 1) {
        const x = old[a]!, y = old[oe - 1]!, xs = nodesOf(a), ys = nodesOf(oe - 1), after = old[oe]?.first ?? end, parent = end.parentNode!;
        for (const node of ys) parent.insertBefore(node, xs[0]!);
        if (oe - a > 2) for (const node of xs) parent.insertBefore(node, after);
        reuse(y, a);
        for (let k = a + 1; k < oe - 1; k++) reuse(old[k]!, k);
        reuse(x, ne - 1);
        rb.rows = rows;
        rb.rr = round;
        rb.pf = true;
        rb.keys = undefined;
        rb.sx = undefined;
        return;
      }
    }
    // the middle: match by key, create the rest
    const byKey = new Map<unknown, number>(), used = new Uint8Array(oe - a), seq: number[] = [];
    for (let o = a; o < oe; o++) byKey.set(old[o]!.key, o);
    for (let i = a; i < ne; i++) {
      const o = byKey.get(keys[i]);
      if (o != null && !used[o - a]) { used[o - a] = 1; seq.push(o); reuse(old[o]!, i); }
      else { seq.push(-1); rows[i] = instantiate(tpl, t, scopes?.[i] ?? setRow(Object.create(rb.s), t, items[i], i), keys[i], items[i], i); }
    }
    // collect the nodes of rows that go or move before the DOM changes
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
    if (deferred.size || models) for (const o of gone) if (old[o]!.rbs) forget(old[o]!.rbs!);
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
    rb.pf = true;
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
    app.ext.defs?.(tpl);
    const content = tpl.content, one = prepared.get(tpl) ?? oneElement(tpl);
    const top: Node = pre ? (one ? pre[0]! : content) : one ? content.firstChild!.cloneNode(true) : content.cloneNode(true);
    const first = pre ? pre[0] ?? null : one ? top : top.firstChild;
    const defs = t.nodes, rbs: RB[] = [];
    // A node and what the early script rendered after it: a nested template's branch or rows, up to their end marker.
    const extent = (n: Node): Node => ((n as any)[EARLY] ?? (n as any)[EARLY_ROWS])?.end ?? n;
    const find = (): Array<Element | null> => {
      // an adopted early row may hold the branches and rows the early script rendered for its nested templates:
      // the compiled lookup counts siblings and would land on those, so it walks the paths and steps over them
      if (t.find != null && !pre) return fns[t.find]!(first);
      // if/else branches, adopted rows (and IR compiled before lookup functions): path[0] picks a child of the content
      const els: Array<Element | null> = new Array(defs.length);
      for (let k = 0; k < defs.length; k++) {
        const path = defs[k]!.path!;
        let node: Node | null = first;
        for (let c = path[0]!; c-- && node;) node = extent(node).nextSibling;
        for (let x = 1; x < path.length && node; x++) {
          node = node.firstChild;
          for (let c = path[x]!; c-- && node;) node = extent(node).nextSibling;
        }
        els[k] = node && (node as Element).localName == defs[k]!.tag ? (node as Element) : null;
      }
      return els;
    };
    // an adopted row ends after its last node and what the early script rendered after that (read before the
    // bindings run: adopting takes the markers off)
    const stop = pre?.length && !one ? extent(pre[pre.length - 1]!).nextSibling : null;
    // a fragment's nodes, after the bindings ran: a nested list adds its rows and end marker to it; an adopted
    // row's are its nodes and the branches and rows of its nested templates between and after them
    const collect = () => {
      const nodes: Node[] = [];
      if (pre) for (let c: Node | null = pre[0] ?? null; c && c != stop; c = c.nextSibling) nodes.push(c);
      else if (!one) for (let c = top.firstChild; c; c = c.nextSibling) nodes.push(c);
      return nodes;
    };
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
    app.ext.defs?.(tpl);
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
      models?.forget(rb);
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
    // the outermost event (location.ts decides whether it is the user's): what its handlers, and what
    // sinter dispatches while handling it (`emit`, `sn-error`), write to `$url` may push an entry. A
    // submit `run()` causes has none, though the browser trusts it.
    const was = ev;
    if (!synth) ev ??= e;
    try {
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
          // a debounced handler (debounce.ts) runs once, with the last event, if its element is still on the page
          const u = ev;
          for (const h of hs) h.b.x != null ? trigger(h, e) : h.b.ms ? app.ext.debounce!(h, h.b.ms, () => h.el.isConnected && as(u, () => handle(h, h.b.f!, e, h.b.w))) : handle(h, h.b.f!, e, h.b.w);
          // a bubbling custom event is a notification: it goes on up until a handler prevents it. Otherwise handled:
          // any handler or action ran; for keys, a filter matched (it prevents the default), an action or a
          // debounced handler ran, or a plain handler prevented the default. A key it did not prevent goes on up.
          if (e instanceof CustomEvent && e.bubbles ? e.defaultPrevented : !/^key/.test(e.type) || e.defaultPrevented || hs.some((h) => h.b.x != null || h.b.ms)) return;
        }
        if (el == root) return;
      }
    } finally {
      ev = was;
    }
  }

  /** Runs a handler expression and invalidates what it may have changed. */
  function handle(rb: RB, f: number, e: Event | null, writes: PathRef[] | undefined, extra?: object) {
    app.exec(f, child(rb.s, { $el: rb.el, $event: e, $f: app.storeFns(rb.el), ...extra }), writes, rb.b);
  }

  // ---- actions

  /** `e` is null for `run()`: no event, no default to prevent */
  function trigger(rb: RB, e: Event | null) {
    const a = ir.actions[rb.b.x!]!, el = rb.el;
    // an action does not end a custom event's walk: it prevents only native defaults
    if (e && !(e instanceof CustomEvent) && (e.type == 'submit' || el.localName == 'a' || (e.type == 'click' && /^(button|input)$/.test(el.localName) && el.closest('form')))) e.preventDefault();
    const u = ev;
    a.debounce ? app.ext.debounce!(el, a.debounce, () => as(u, () => fire(rb, a, e))) : fire(rb, a, e);
  }

  function act(el: Element): ActState {
    if (!acts.has(el)) acts.set(el, { n: 0, q: [], w: null, c: null, r: null, off: null });
    return acts.get(el)!;
  }

  function fire(rb: RB, a: ActionDef, e: Event | null) {
    // `then` and `catch` run in the context of what triggered the action (a user's event, or not)
    const st = act(rb.el), get = a.method == 'GET', u = ev;
    if (!get && a.concurrency == 'block' && st.n) return;
    const s = child(rb.s, { $el: rb.el, $event: e });
    let url = '', body: unknown;
    try {
      // a call's arguments are taken when it is triggered, like a request's URL and body
      if (a.call) body = fns[a.call.args]!(s);
      else {
        url = app.url(a.url, s);
        if (a.body != null) body = fns[a.body]!(s);
        // a form's own fields, and form encoding (form.ts): on pages that have such an action
        if (app.ext.form) body = app.ext.form(rb.el, a, body);
      }
    } catch (err) {
      return unhandled(toError(err), rb.el);
    }
    // a question first (confirm.ts): the action runs only when the user agrees
    a.confirm != null ? app.ext.confirm!(fns[a.confirm]!(s), go) : go();
    function go() {
    const drop = a.optimistic != null ? app.ext.optimistic!.begin(a.optimistic, s) : () => {};
    if (get) {
      st.c?.abort();
      return void send(rb, a, st, url, body, drop, u, (st.c = new AbortController()));
    }
    const run = () => void send(rb, a, st, url, body, drop, u);
    if (!st.n) run();
    else if (a.concurrency == 'latest') { st.w ? st.w.drop() : app.busy++; st.w = { run, drop }; st.r?.abort(); }
    else { app.busy++; st.q.push(run); }
    }
  }

  async function send(rb: RB, a: ActionDef, st: ActState, url: string, body: unknown, drop: (ok?: boolean) => void, u: Event | null, c?: AbortController) {
    const el = rb.el as HTMLFormElement, s = rb.s;
    // where the element is now: an optimistic remove may take its row away before an error reports
    const up: Element[] = [];
    for (let x = el.parentElement; x; x = x.parentElement) up.push(x);
    st.n++;
    // server errors on the form (fields.ts): its marks cleared and its `$error` null while it is sent again
    const fs = app.ext.fields?.sent(el, a);
    el.setAttribute('aria-busy', 'true');
    if (a.form && a.concurrency == 'block' && !c && !st.off) {
      st.off = ([...el.elements] as HTMLInputElement[]).filter((x) => !x.disabled);
      for (const x of st.off) x.disabled = true;
    }
    try {
      const result = a.call
        ? await app.ext.call!.run(a.call.run, body, el)
        : await req.send(url, { method: a.method, body, signal: c?.signal, ...(a.retry ? { retry: a.retry, stop: (st.r = new AbortController()).signal } : {}) });
      // a superseded GET's change is rolled back; a success keeps it, under what `then` writes
      if (c && st.c != c) return drop();
      drop(true);
      // write-through lands between the commit and `then`, so `then` still has the last word
      if (a.ap) app.ext.apply?.(a, s, url, body, result);
      if (a.then != null) as(u, () => handle(rb, a.then!, null, a.w, { $result: result }));
    } catch (err) {
      drop();
      if (isAbort(err) || (c && st.c != c)) return;
      const error = a.call ? app.ext.call!.error(err) : toError(err);
      // shown on the form (every message on its field, or its markup reads `$error`): handled
      if (fs?.(error, { url, method: a.method }) && a.catch == null) return;
      as(u, () => a.catch != null ? handle(rb, a.catch, null, a.w, { $error: error }) : unhandled(error, el.isConnected ? el : up.find((x) => x.isConnected) ?? null));
    } finally {
      if (c && st.c == c) st.c = null;
      st.r = null;
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
    // the prototype's method: a control named `dispatchEvent` cannot shadow it; DOMs that wrap forms in a Proxy (happy-dom) refuse it as receiver
    try { ET.dispatchEvent.call(target, ev); } catch { target.dispatchEvent(ev); }
    if (ev.defaultPrevented) return;
    config.onError?.(error, target as Element);
    warn(16, resource ? ` loading \`${resource}\`` : '', error.message, error);
  }

  // ---- resources

  function createLoader(def: ResourceDef) {
    const r = createResource(def.name, { key: def.key ?? null, order: def.order ?? null, locale: () => config.locale?.get(), warn, prep: (x) => (app.prep ? app.prep(x) : x), freeze: app.dev });
    r.onDirty = (what) => app.mark((what == 'data' ? '$r.' : '$meta.') + def.name);
    resources.set(def.name, r);
    Object.defineProperty(app.page.$r, def.name, { get: r.value, enumerable: true });
    app.page.$meta[def.name] = r.meta;
    // fed by a server-event stream: connecting until its first open (src/sse.ts keeps it current)
    if (app.ir.syncs?.some((s) => s.events.some((e) => e.resource == def.name))) r.meta.live = 'connecting';
    /** `had`: the resource has had a URL (its first one after mount restores a `page-model` page) */
    let url: string | null = null, c: AbortController | null = null, seq = 0, again: Promise<void> | null = null, loud = false, had = false, typing: unknown = null;

    const scope = () => app.scopeOf(def.scope ?? -1);
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
    const pick = (path: string | null | undefined, body: unknown): any => (path ? path.split('.').reduce((x: any, k) => x?.[k], body) : body);
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

    const fail = (e: unknown, quiet?: boolean) => {
      // a background reload that fails while the resource is failing already reports nothing new
      const known = quiet && r.meta.error != null, error = toError(e);
      r.meta.error = error;
      r.onDirty('meta');
      if (!known) unhandled(error, null, def.name);
    };
    const l: ResourceLoader = {
      def, res: r, app, pager: null as Pager | null, settled: [],
      settle(ok) { for (const f of l.settled) f(ok); },
      scope, got: loadShared, get: (u, signal, lo) => loadShared(u, signal, lo).then((g) => g.body()), failed: fail, loading, url: () => url,
      inflight: () => c != null,
      // no user event causes a load's `then`: its `$url` writes replace
      done: (v) => def.then != null && as(null, () => app.exec(def.then!, child(scope(), { $result: v }), def.w)),
      items(body) {
        let items = pick(def.items, body);
        if (!Array.isArray(items)) { warn(12, def.name, def.items ?? '(response)'); items = []; }
        return items.map(clean);
      },
      start() {
        const el = def.data != null ? found.get(def.data) : null;
        let data;
        if (el) {
          // empty: the server that fills it did not (no data, an error, its time ran out), so the page requests it
          if (el.localName == 'script' && el.parentElement?.localName == 'head') { if (el.textContent!.trim()) try { data = { v: JSON.parse(el.textContent!) }; } catch { warn(5, def.name); } }
          else warn(4, def.name);
        }
        url = data ? resolve() : null;
        if (url == null) {
          // the data the previous page prefetched for this request, else the page-load cache: shown
          // now, and changed() revalidates
          const ahead = app.ext.prefetch && !def.call && !def.each && !def.paginate;
          const u = ahead || (def.cache != null && app.ext.cache) ? resolve() : null;
          if (u != null) {
            l.pager?.reset(0);
            const q = request(u), hit = (ahead && app.ext.prefetch!.take(def, q)) || (def.cache != null && app.ext.cache?.read(def, q));
            // loadedAt stays null: it means the server answered during this page load, and
            // guards such as `$meta.user.loadedAt && !user` must not act on another page's data
            if (hit) fill(hit.items, hit.total, l.pager?.current());
          }
          return l.changed();
        }
        had = true;
        l.pager?.reset(0);
        const v = store(data!.v, request(url));
        r.meta.loadedAt = env.now();
        l.done(v);
        l.settle(true);
      },
      /** `src` or `when` may have changed: reload from the first page if the URL differs. From typing: once the typing pauses. */
      changed(soft?: boolean) {
        if (typing != null) { env.clearTimeout(typing); typing = null; app.busy--; }
        if (soft) { app.busy++; typing = env.setTimeout(() => { typing = null; app.busy--; l.changed(); }, TYPING, 'debounce'); return; }
        const u = resolve();
        if (u === url) return l.pager?.follow?.();
        url = u;
        if (u != null) {
          l.pager?.reset(had ? 2 : 0);
          had = true;
          return void l.load();
        }
        c?.abort();
        r.replace(r.isCollection ? [] : null);
        if (def.cache != null) app.ext.cache?.cleared(def);
        loading(false);
      },
      /** Repeats the current request; several calls in one task share one request (quiet only if every call was). */
      refetch: (_hint, quiet) => {
        if (!quiet) loud = true;
        return (again ??= Promise.resolve().then(() => { again = null; const q = !loud; loud = false; return l.load(undefined, q); }));
      },
      async load(move?: unknown, quiet?: boolean) {
        if (url == null) return;
        c?.abort();
        const ctl = (c = new AbortController()), n = ++seq, m = l.pager && (move ?? l.pager.current());
        const mark = r.startLoad();
        let loaded = false, ok = false, v;
        if (!quiet) loading(true);
        try {
          const req = withParams(url, m ? l.pager!.params(m) : null);
          const body = def.call
            ? await app.ext.call!.run(def.call.run, args, null, ctl.signal)
            : await l.get(req, ctl.signal, (def.lo ?? 0) | (quiet ? 2 : 0));
          if (n != seq) return;
          // UNCHANGED (the versions module): nothing to store; `then` still runs, with what that data's load stored
          loaded = body !== UNCHANGED;
          v = loaded ? store(body, req, m) : body;
          ok = true;
          r.meta.error = null;
          r.meta.loadedAt = env.now();
        } catch (e) {
          if (n != seq || isAbort(e)) return;
          fail(def.call ? app.ext.call!.error(e) : e, quiet);
          l.settle(false);
        } finally {
          // writes made while this load ran win over its (older) response
          r.endLoad(mark, loaded);
          if (n == seq) { c = null; loading(false); }
        }
        if (!ok) return;
        if (quiet) r.onDirty('meta');
        // after the store and `$meta` have the response, so `then` sees them
        l.done(v);
        l.settle(true);
      },
    };
    if (def.each) app.ext.each!.fanOut(l);
    if (def.paginate) l.pager = app.ext.paginate!.pager(l);
    app.ext.versions?.watch(l);
    app.ext.refresh?.watch(l);
    r.loader = l;
    loaders.push(l);
  }

  /**
   * GETs `url`; concurrent loads of one URL share one request, aborted when no one waits. `lo`: low
   * priority (a resource only dialogs read). Each waiter sees the response and reads the body only
   * if it needs it (parsed once; a non-2xx status rejects there).
   */
  function loadShared(url: string, signal: AbortSignal, lo = 0): Promise<Got> {
    let e = shared.get(url);
    if (!e) {
      const c = new AbortController(), entry = { n: 0, c, p: req.raw(url, { signal: c.signal, ...(lo & 1 ? { priority: 'low' as const } : {}), ...(lo & 2 ? { retry: false as const } : {}) }).then(gotOf) };
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
