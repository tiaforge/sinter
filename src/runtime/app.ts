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
/** Two objects with the same keys, each the same value (Object.is). */
const sameEntries = (a: any, b: any): boolean => {
  let n = 0;
  for (const k in a) { if (!Object.is(a[k], b[k])) return false; n++; }
  for (const _ in b) n--;
  return n == 0;
};
/**
 * Two props objects of a component (`[name]: value`) with the same keys, each the same value (Object.is). The
 * compiler's own entries (`$f`, the tree slots' fills a component passes down; `$a`, its tag's attributes) are objects
 * it builds at each evaluation: those are the same when their entries are.
 */
const sameProps = (a: any, b: any): boolean => {
  if (!a || !b || typeof a != 'object' || typeof b != 'object') return false;
  let n = 0;
  for (const k in a) {
    const x = a[k], y = b[k];
    if (!Object.is(x, y) && !(k[0] == '$' && x && y && typeof x == 'object' && typeof y == 'object' && sameEntries(x, y))) return false;
    n++;
  }
  for (const _ in b) n--;
  return n == 0;
};
import { expand, readUrl as readFrom, withParams } from './url.js';
// the parts of the core this build's pages use (a site's build serves its own: src/core-parts.ts)
import * as F from './flags.js';

export { withParams };
import { clean, createResource, type Resource } from './store.js';

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
 * reconnecting (session probe, backoff, reload) is the caller's job, so a transport never
 * reconnects by itself. `names` are the event names the page maps; deliver at least those.
 */
export interface Transport {
  connect(url: string, onEvent: (name: string, payload: unknown) => void, onState: (state: 'open' | 'error') => void, names: string[]): void;
  /** start delivering another event name (islands subscribing later) */
  listen?(name: string): void;
  close(): void;
}

/**
 * A binding attached to one element in one scope. An `if`, `for` or choice is bound to its anchor's
 * start comment (`<!--sn 4-->`), which `el` then holds: those bindings never reach a feature module.
 */
export interface BoundBinding {
  b: Binding;
  el: Element;
  s: any;
}

/** Pagination state of one resource; a "move" is one page request, repeated exactly by reload. */
export interface Pager {
  /**
   * the resource's URL changed: back to the first page. With `model` (paginate), `why` says what changed it:
   * 0 its first URL after mount (the URL's page, restored), 2 anything later (page 1 and the parameter
   * deleted, unless Back or Forward caused it: then the URL's page)
   */
  reset(why?: number): void;
  /** `model` (paginate): the parameter may have changed (the URL did not): loads the page it names */
  follow?(): void;
  current(): unknown;
  params(move: unknown): Record<string, string> | null;
  appends(move: unknown): boolean;
  received(items: unknown[], total: number | null, move: unknown): void;
}

/**
 * A navigation, as every way in describes it: where from and to, how (`kind`), what started it (`trigger`:
 * the link, the element of a `navigate()` handler), the destination's history index on a traversal, the
 * signal that aborts it when a newer one comes, and its `source`: a click on a link (`link`), `navigate()`
 * (`call`), the core's `popstate` (`popstate`), or the browser's `navigate` event (`event`, which carries
 * the event, for the handler that intercepts it).
 */
export interface Intent {
  /** where from: the page's URL, set by `go` when the source leaves it out */
  from?: string; to: string; kind: 'push' | 'replace' | 'traverse';
  source: 'link' | 'call' | 'popstate' | 'event';
  trigger?: Element | null; index?: number; signal?: AbortSignal; event?: Event;
  /** what the source does when no handler can (the core runs it): a call loads `to`; an event says its own */
  load?(): void;
}
/**
 * What a handler decides for an intent: its name (`same`, `swap`) and what it does, run by the core once
 * every handler was asked. `run` returning false: it could not (the core loads the page). No `run`: it is
 * done elsewhere (the swap, for the `popstate` of a traversal it intercepted).
 */
export interface Decision { name: string; run?(): boolean | void | Promise<boolean | void> }
/** A navigation handler (links.ts `chain(app).add`): its decision, or nothing when the intent is not its. It acts only in `run`. */
export type Navigator = (i: Intent) => Decision | void | undefined;

/** The last argument of an action function (`data-sn-call`, `<sn-resource call>`). */
export interface CallContext {
  /** aborts when the page is hidden (pagehide) or, for a resource, when its inputs change */
  signal: AbortSignal;
  /** a request through the app's middleware chain (401 handling, origins, timeout); with the action's `data-sn-retry`, sent again as its policy says (its own `init.retry` wins) */
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
  refresh(hint?: object, quiet?: boolean): Promise<void>;
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
  /** for feature modules: the collection items of a response body (`select` path, checked, cleaned) */
  items(body: unknown): any[];
  /** for feature modules: a failed load: `$meta.error`, then the unhandled-error path (`quiet`: only if it was not failing already) */
  failed(e: unknown, quiet?: boolean): void;
  loading(on: boolean): void;
  /** for feature modules: a load stored `result` (what `select` selects): runs `then` */
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
    /** `retry`: the action's `data-sn-retry`, for each request the function sends (`ctx.request`), `stop` ending its tries */
    call?: { run(f: number, args: unknown, el: Element | null, signal?: AbortSignal, retry?: { retry: string; stop: AbortSignal }): Promise<unknown>; error(e: unknown): SinterError };
    /** debounced handlers and actions (debounce.ts): runs `run` once, `ms` after the last call for `key` */
    debounce?: (key: object, ms: number, run: () => void) => void;
    /** `data-sn-confirm` (confirm.ts): runs `go` once the user agrees to `question` (at once when it is falsy) */
    confirm?: (question: unknown, go: () => void) => void;
    /** models of controls other than text fields (models.ts) */
    models?: (inner: ModelInner) => Models;
    /**
     * `$url` written (location.ts): each write records the changed parameter and the history entry it
     * asks for (1 replace, 2 typing, 3 a number field's burst, 4 push; the strongest of a flush pass wins),
     * `kind` the strongest so far, `commit` writes the history now (false: the query did not change);
     * `back`: the flush running follows Back or Forward (`popstate`), so nothing it causes writes the URL
     */
    location?: {
      commit(kind: number): boolean;
      readonly kind: number;
      readonly back: boolean;
      /** `model` (paginate) (paginate.ts): sets a parameter (null deletes it) and writes it with `kind` */
      set(name: string, value: string | null, kind: number): void;
      /** a same-page link was followed (query-links.ts): its entry is pushed, `$url` read again; the flush is as after Back */
      arrive(): void;
      /** a new history entry (`Env.pushState`, else `history.pushState`) */
      push(url: string): void;
    };
    /**
     * typing and a number field's steps on `$url` (typing.ts): `flush` takes a pass's typing or burst,
     * `waits` whether a commit waits for its pause, `stop` drops it and ends the run
     */
    typing?: { flush(kind: number): void; waits(): boolean; stop(): void; finish(): void };
    /** the shared link listener is installed (links.ts) */
    links?: true;
    /** page loads' transitions get sinter's types (links.ts `loadTypes`) */
    types?: true;
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
      change(res: (n: string) => Resource, op: 'merge' | 'remove', names: string[], item: unknown, set: any): void;
      apply(r: Resource, fields: string[], op: 'merge' | 'remove', item: unknown, set: any, byId: boolean): boolean;
      /** `upsert(c.replies, x)`: `owner` (from `names`) gets its list `field` with `item` in it */
      upsert(res: (n: string) => Resource, names: string[], owner: any, field: string, item: unknown): void;
    };
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
  /** the bindings at the page's level, with their rows' (the swap hands kept elements' rows and branches to the next page) */
  readonly rbs: unknown[];
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
  /**
   * The navigation chain (links.ts: `chain(app)`, one per document, every app's handlers in their rank), on
   * pages with a feature that decides on navigations (same-page links, transitions, the swap): this app's
   * observers of what goes, `decide` (asks every handler, runs nothing) and `go` (runs the first decision,
   * else the source's fallback). Absent: `navigate()` loads the page and Back reads `$url`, as before.
   */
  onGo?: Array<(i: Intent) => void>;
  decide?(i: Intent): Decision | undefined;
  go?(i: Intent): Decision | undefined;

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
  /** for: rows; if, choice: the rendered branch (0 or 1 entries) */
  rows?: Inst[];
  /** for: its row template; choice: the template of the rendered case */
  t?: TemplateDef;
  /** the anchor's end comment (`<!--/sn-->`), after its rows or branch */
  end?: Comment;
  /**
   * for: rows by key, built on the second change of only marked rows since the rows rendered (null: scanned once, or
   * keys are explicit; a list whose keys repeat scans every time), and the round of the last reconcile
   */
  keys?: Map<unknown, Inst> | null;
  rr?: number;
  /** for: some rows wait for a re-evaluation (`Inst.f`) since the last walk over all of them */
  pf?: boolean;
  /** for: selection indexes of its rows (by binding), built on their second use (null: scanned once), dropped when the rows are rendered */
  sx?: Map<Binding, Sel | null>;
  /** for, unkeyed: the round its rows were adopted from the early script; until the next flush, rows match by position */
  ad?: number;
  /** if: rendered branch (0 none, 1 if, 2 else); choice: the rendered case + 1 (0 none) */
  br?: number;
  /**
   * the anchor of a wrapper's row or branch (`TemplateDef.a`), which has no comments: the anchor whose row or branch it is
   * (`u`) and that row or branch (`x`), whose first node is this anchor's branch's (or an empty comment while it has none)
   */
  u?: RB;
  x?: Inst;
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
/** How long a change from typing waits for the next keystroke (a resource's request; the URL's commit, typing.ts). */
export const TYPING = 250;
/** Sentinel for "not written yet". */
const UNSET = {};
const range = (a: Node | null, stop: Node | null) => {
  const out: Node[] = [];
  for (let n = a; n && n != stop; n = n.nextSibling) out.push(n);
  return out;
};
const child = (s: any, props: object) => Object.assign(Object.create(s), props);
/** an anchor's start comment, exactly: `<!--sn 4-->` at the page's top level, `<!--sn-->` in a row (`<!--snippet-->` is not) */
const isStart = (n: Node | null) => n?.nodeType == 8 && /^sn(?: \d+)?$/.test((n as Comment).data);
/** what a node's `tag` in the IR is: its tag name, `#` for a comment (an anchor's start) */
const nameOf = (n: Node) => (n.nodeType == 8 ? '#' : (n as Element).localName);
/** an anchor's end comment, after its start: the first `<!--/sn-->` that closes no anchor nested in between */
export function endOf(start: Node): Comment | null {
  let d = 0;
  for (let n = start.nextSibling; n; n = n.nextSibling) if (n.nodeType == 8) {
    const t = (n as Comment).data;
    if (t == '/sn') { if (!d--) return n as Comment; } else if (isStart(n)) d++;
  }
  return null;
}
/** The templates an anchor binding renders: a `for`'s or `if`'s (with its `else`), a choice's. */
const templatesOf = (b: Binding): number[] => (b.k == 'ch' ? b.c! : b.k == 'for' || b.k == 'if' ? (b.z != null ? [b.x!, b.z] : [b.x!]) : []);
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
const others = new WeakMap<TemplateDef, number[]>(), allDeps = new WeakMap<TemplateDef, number[]>();
/** set by the early script on the start comment of a `data-sn-for` whose rows it rendered from embedded data: each row's nodes, the end comment */
const EARLY_ROWS = Symbol.for('sinter.early.rows');
/** set by the early chunk (@tiaforge-ui/sinter/runtime/early) on the start comment of a `data-sn-if` or choice whose branch it rendered */
const EARLY = Symbol.for('sinter.early');
const simple = new WeakMap<TemplateDef, Simple | null>();
/** ROW: on each node of a simple row with handlers, its instance */
const ROW = Symbol('sinter.row');
type RowNode = Node & { [ROW]?: Inst };
const rowNodes = (x: Inst) => x.nodes ?? [x.first!];

/**
 * Goes to `url` as `navigate(url)` in a handler does, for app code (a redirect after a form, an island): the
 * page's navigation handlers first (a same-page link, a swap), else the page loads. Nothing mounted: it loads.
 */
export function navigate(url: string, o?: { replace?: boolean }): void {
  const app = instances.get(document);
  if (app) app.storeFns(null).navigate(url, o);
  else if (o?.replace) location.replace(url); else location.assign(url);
}

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
  // (the test suite's flags: the parts this page uses turn on; nothing in a build)
  F.use?.(ir);
  const env = o.env ?? envOf(config);
  const req = createRequestLayer(env, o.request ?? config.request);
  const schemes = schemesOf(config.urlSchemes);
  const resources = new Map<string, Resource>(), loaders: Array<{ def: ResourceDef; changed(typing?: boolean): void; start(): void; refresh(): Promise<void> }> = [];
  const acts = new WeakMap<Element, ActState>();
  /** props set on custom elements not defined yet, by element: the latest value of each */
  const early = new WeakMap<Element, Map<string, unknown>>();
  const deferred = new Set<RB>();
  /**
   * Open dialogs the event being handled is about to close (its default action, which runs after the
   * handlers and their flush): their bindings wait as in a closed dialog, so what a handler clears
   * (`draft = null` on a Cancel button) is not painted while the dialog is still showing.
   */
  const closing = new Set<Element>();
  const listeners = new Map<string, Set<(p: unknown) => void>>(), cleanups: Array<() => void> = [];
  const shared = new Map<string, { n: number; c: AbortController; p: Promise<Got> }>();
  /** `openDialog(id)`, `closeDialog(id)`: the dialog of this mount root with that id; `run(id)`: any element */
  const byId = (id: string, s = '[id]') => [...root.querySelectorAll(s)].find((d) => d.id === id);
  const dialog = (id: string) => byId(id, 'dialog') as HTMLDialogElement | undefined;
  const rootRbs: RB[] = [], rootScopes: any[] = [], found = new Map<number, Element | Comment>();
  /** the head templates, by template id (`<template id="sn-t-<id>">`), found once */
  const tpls: HTMLTemplateElement[] = [];
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
  /** The item has `r`'s key fields: a list or a `merge()` that may come from several resources tries only those it can be in (the others would warn 14). */
  const keyed = (r: Resource, item: any) => item != null && r.key!.every((f) => item[f] !== undefined);
  /**
   * `merge(item, …)`, `remove(item)`: the compiler passes the resources the item can come from; it is
   * changed in the one that holds it, by key (a single resource is the item itself)
   */
  const byItem = (m: 'merge' | 'remove') => (names: string[], item: any, set?: any) => {
    // a source under a row (`comments>replies`): the nested module, loaded with it, does it all (the rows too:
    // a few bytes there, which pages without nested lists do not load, rather than in the core)
    if (app.ext.nested) return app.ext.nested.change(res, m, names, item, set);
    for (const n of names) {
      const r = res(n);
      if (r.isCollection ? keyed(r, item) && r.has(item) : true) return void (m == 'merge' ? r.merge(item, set) : r.remove(item));
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
    /** `<template data-sn-text>`: the text node after `el`, found from it at each write; an empty comment holds its place until it has text */
    x(el: HTMLElement, _n: string, v: any) {
      const s = el.nextSibling as CharacterData | null;
      v = '' + (v ?? '');
      // a text run's own node (`TemplateDef.tx`)
      if (el.nodeType == 3) return void ((el as unknown as Text).data = v);
      if (s?.nodeType == 3) { if (s.data !== v) s.data = v; } else if (v) s?.nodeType == 8 && !s.data ? s.replaceWith(v) : el.after(v);
    },
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
    p: F.PROP ? (el: HTMLElement, n: string, v: any) => {
      (el as any)[n] = v;
      // not defined yet, or defined but not upgraded yet (a row cloned from a template)
      if (early.has(el) || !(el instanceof (customElements.get(el.localName) ?? Boolean))) upgrade(el, n, v);
    } : undefined,
    /** `has`: the element may have the class (it is not a new clone of an element without a `class` attribute) */
    c(el: HTMLElement, n: string, v: any, has: unknown) { if (v || has) el.classList.toggle(n, !!v); },
    a(el: HTMLElement, n: string, v: any) {
      // form state: the attribute is only the default once the user has changed the control
      if (/^(checked|selected|indeterminate|value)$/.test(n) && n in el) (el as any)[n] = n == 'value' ? (v == null || v === false || v === true ? '' : v) : v != null && v !== false;
      if (v == null || v === false) el.removeAttribute(n);
      // relative URLs by the base of the document rows go into (a clone's own is its template's, about:blank)
      // an unchanged value is not written again: a playing <audio>'s `src` set to the same value restarts it,
      // an <iframe>'s reloads it
      else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), doc.baseURI, schemes)) { if (el.getAttribute(n) !== v) el.setAttribute(n, v); }
      else { el.removeAttribute(n); warn(7, n, el.localName, v); }
    },
    s: F.STYLE ? (el: HTMLElement, n: string, v: any) => {
      if (v == null || v === false) el.style.removeProperty(n);
      else if (STYLE_BAD.test(v)) { el.style.removeProperty(n); warn(8, n, v); }
      else el.style.setProperty(n, v);
    } : undefined,
    /** a style group (`Binding.g`): its values `v` in the order of its names; only those that differ from `prev` are written */
    // On the first write to an element with no inline style (a new clone of a template element without a
    // `style` attribute), an unset entry has nothing to remove: it is skipped, not a removeProperty call per
    // name (a group of 50 names, 2,000 elements: 100,000 calls that change nothing).
    g: F.STYLE ? (el: HTMLElement, g: number, v: any, prev?: any) => {
      const names = ir.sg![g]!;
      const fresh = !prev && !el.hasAttribute('style');
      for (let i = 0; i < names.length; i++) {
        const x = v?.[i];
        if (fresh ? x != null && x !== false : !prev || !Object.is(x, prev[i])) W.s!(el, names[i]!, x);
      }
    } : undefined,
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
  /** a path node's depth in the trie, computed once */
  const depthOf = new Int32Array(par.length).fill(-1);
  const depth = (n: number): number => {
    if (depthOf[n]! >= 0) return depthOf[n]!;
    let k = 0;
    for (let m = n; m >= 0; m = par[m]!) k++;
    return (depthOf[n] = k);
  };
  /**
   * Whether a change of the current round reaches a dependency of `rb` from inside the value it reads: the
   * written path is longer than the dependency's, or it ends in `**` (a change anywhere below its parent, the
   * whole of a state scope included) at or above the dependency.
   */
  const inside = (rb: RB): boolean => {
    // (no change in this round: a first render, outside a flush)
    if (!cur.length) return false;
    for (const n of ids(rb.b.d)) if (each(n, (d, e) => level(e, d, rb.s) > 0 && (d.w < 0 || (kinds[d.w] == '**' ? depth(d.w) - 1 <= depth(n) : depth(d.w) > depth(n))))) return true;
    return false;
  };

  /**
   * Dependencies of every binding in a template's rows, nested templates included. Templates that reach each
   * other (components used inside one another) are each visited once per call, and only a whole result is kept:
   * one kept while another was half done would miss what that one reads.
   */
  const templateDeps = (t: TemplateDef, seen?: Set<TemplateDef>): number[] => {
    if (!seen && allDeps.has(t)) return allDeps.get(t)!;
    const s = seen ?? new Set<TemplateDef>();
    if (s.has(t)) return [];
    s.add(t);
    const d = t.nodes.flatMap((nd) => nd.b.flatMap((b) => [...ids(b.d), ...templatesOf(b).flatMap((x) => templateDeps(ir.templates[x]!, s))]));
    if (!seen) allDeps.set(t, d);
    return d;
  };

  /**
   * The template's dependencies without the outer sides of its selection bindings: what reaches a row
   * for any other reason. The selection bindings of the template's own nodes.
   */
  const otherDeps = (t: TemplateDef): number[] => others.get(t) ?? (others.set(t, t.nodes.flatMap((nd) => nd.b.flatMap((b) => [
    ...(b.s ? ids(b.d).filter((d) => !b.s!.d.includes(d)) : ids(b.d)),
    ...templatesOf(b).flatMap((x) => templateDeps(ir.templates[x]!)),
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
      // a state field the build computed (a helper over constants), embedded in the head: a fresh copy per read
      $d: (id: number) => { try { return JSON.parse(found.get(id)!.textContent!); } catch { return undefined; } },
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
    rbs: rootRbs,
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
      // a flush scheduled before `destroy()` (a frame's, a microtask's) finds nothing to update
      if (flushing || destroyed) return;
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
      openDialog: (id: string) => { const d = dialog(id); if (d && !d.open) d.showModal(); },
      refresh: (...n: string[]) => { for (const x of n) res(x).refresh(); },
      // `upsert(c.replies, x)`: the item that holds the list gets it as a patch
      upsert: (n: string | string[], a: any, f?: string, x?: any) => Array.isArray(n) ? app.ext.nested!.upsert(res, n, a, f!, x) : res(n).upsert(a),
      merge: byItem('merge'),
      remove: byItem('remove'),
      page: (n: string, t: string | number) => app.ext.paginate!.page(n, t),
      closeDialog: (id?: string) => (id ? dialog(id) : el?.closest('dialog'))?.close(),
      emit: (n: string, detail?: unknown) => el?.dispatchEvent(new CustomEvent(n, { detail, bubbles: true, cancelable: true })),
      // to this page with only parameters it reads changed: as a same-page link (no load); else the browser navigates
      // the navigation chain where a feature installed one (links.ts), else the page loads
      navigate: (url: string, o?: { replace?: boolean }) => {
        const to = new URL(url, app.env.href()).href;
        if (app.go) app.go({ to, kind: o?.replace ? 'replace' : 'push', source: 'call', trigger: el });
        else if (o?.replace) (app.env.replace ?? ((u: string) => location.replace(u)))(to);
        else app.env.navigate(to);
      },
      // the element's action, as if its trigger fired (a form is submitted); disabled or inert: nothing
      run: (id: string) => {
        const t = F.ACTION ? byId(id) : undefined, h = t && handlersOf(t as Tagged), rb = h && (Array.isArray(h) ? h : [h]).find((x) => x.b.x != null);
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
  const sel = F.LIST || F.BRANCH ? app.ext.select?.({ hit, isSimple, walkSimple, process }) : undefined;

  // ---- mount: one walk over elements and comments (`data-sn` elements, anchors' start comments), ids checked against the IR's tags
  const bad = new Set<number>();
  const tw = doc.createTreeWalker(root, 129 /* SHOW_ELEMENT | SHOW_COMMENT */);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    // a comment: `<!--sn 4-->` is root 4 (`<!--sn-->`, an anchor in a row, is none)
    const t = n.nodeType == 8 ? (n as Comment).data : null;
    const a = t == null ? Element.prototype.getAttribute.call(n, 'data-sn') : t.length > 3 && isStart(n) ? t.slice(3) : null;
    if (a == null) continue;
    const id = +a;
    found.has(id) ? bad.add(id) : found.set(id, n as Element | Comment);
  }
  for (const id of bad) { found.delete(id); warn(1, id); }
  if (F.RESOURCE) for (const def of ir.resources) createLoader(def);
  // back from the bfcache, or online again: the data may have changed meanwhile. Resources a stream
  // feeds are reloaded by the stream module when it reconnects.
  const again = () => { for (const l of loaders) if (!l.def.fed) void l.refresh(); };
  app.addCleanup(env.listen('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) again(); }));
  app.addCleanup(env.listen('online', again));
  // prerendered (Speculation Rules): the page loaded while nobody saw it, maybe minutes ago, and
  // streams wait (app.shown). Shown: everything is reloaded, then the waiting work runs
  if (waiting) {
    const on = () => {
      if (doc.prerendering) return;
      doc.removeEventListener('prerenderingchange', on);
      const w = waiting!;
      waiting = null;
      for (const l of loaders) void l.refresh();
      for (const fn of w) fn();
    };
    doc.addEventListener('prerenderingchange', on);
    app.addCleanup(() => doc.removeEventListener('prerenderingchange', on));
  }
  // a form's reset (`<button type="reset">`, `form.reset()`): its models take the values it restored. The event comes
  // before the browser restores them, so the models read the fields once it has
  if (F.MODEL) {
    const on = (e: Event) => {
      const form = e.target as HTMLFormElement;
      env.setTimeout(() => {
        if (destroyed || e.defaultPrevented) return;
        for (const c of form.elements ?? []) { const rb = (c as Tagged)[MODEL]; if (rb) setModel(rb, readModel(rb)); }
      }, 0, 'task');
    };
    ET.addEventListener.call(root, 'reset', on, true);
    cleanups.push(() => ET.removeEventListener.call(root, 'reset', on, true));
  }
  // one delegated capture listener per event type the page binds, rows included, at the mount root: the compiler listed them
  if (F.EVENTS) for (const type of ir.ev ?? []) {
    ET.addEventListener.call(root, type, dispatch, true);
    cleanups.push(() => ET.removeEventListener.call(root, type, dispatch, true));
  }
  bindNodes(ir.roots, ir.roots.map((nd) => {
    const el = found.get(nd.id!);
    if (el && nameOf(el) == nd.tag) return el as Element;
    warn(el ? 3 : 2, nd.id, el && nameOf(el), nd.tag);
    return null;
  }), app.page, rootRbs);
  cleanups.push(env.listen('popstate', () => {
    // a handler may take Back or Forward (the swap, to another path); else the page reads `$url` again
    if (app.go?.({ to: env.href(), kind: 'traverse', source: 'popstate' })) return;
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
        if (F.MODEL && b.k == 'model') {
          el[MODEL] = rb;
          models?.bound(rb);
          if (b.p != null) app.ext.persist?.model(rb, (v) => setModel(rb, v));
        }
        if (F.LIST && b.k == 'for') { rb.rows = []; rb.t = ir.templates[b.x!]; }
        if (F.BRANCH && (b.k == 'if' || b.k == 'ch')) rb.br = 0;
        rbs.push(rb);
      }
    }
  }

  // ---- rendering

  /** Walks bindings in document order; `force`: 0 dirty ones only, 1 also those reading a loop index, 2 all. */
  function walk(rbs: RB[], force: number) {
    for (const rb of rbs) {
      if (!process(rb, force) || !(F.LIST || F.BRANCH) || !rb.rows) continue;
      const t = rb.t;
      // Two forces: 2 renders everything below (a change inside a value, which no path names below it; the takeover of
      // rows the early script rendered); 3, for a row whose item or props were replaced by other values, stops at the
      // components below: a component's row (a definition's, a choice case's: its item the props) renders forced only
      // when its own props changed (`x.f`, set by reconcile or toggle), else as any row the round's changes reach. A
      // component's markup reads its props, its own state and what paths track, nothing of the scope above it, so a
      // force from above reaches it only through its props.
      const bound = force != 2 && !!t?.item?.startsWith('$p');
      let r = (force && !bound) || !t ? 2 : rowHits.get(t);
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
      // only marked elements changed and the list did not move: visit their rows directly. The first time since the
      // rows rendered, a scan finds them (an index over every row would cost more than it saves once); after that, the
      // rows by key, kept while no row is rendered (`null`: scanned once; a list with explicit or repeated keys scans)
      if (r == 1 && rb.rr != round) {
        let keys = rb.keys;
        if (keys === null && t!.key == null) keys = rb.keys = new Map(rb.rows.map((x) => [x.key, x]));
        if (keys && keys.size == rb.rows.length) {
          for (const item of marked) {
            const x = Object(item) === item ? keys.get(keyOf(t!, item, null)) : null;
            if (x && x.item === item) walkRow(x, t!, 0);
          }
        } else {
          for (const x of rb.rows) if (marked.has(x.item)) walkRow(x, t!, 0);
          rb.keys ??= null;
        }
        continue;
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
      for (const x of rb.rows) if (x.r != round && (r || x.f)) { walkRow(x, t!, bound ? x.f : x.f == 2 || force == 2 ? 2 : Math.max(force, x.f)); x.f = 0; }
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
      if (el && (force >= 2 || (force == 1 && b.i) || (b.d && hit(b.d, x.s)))) {
        const val = evalB(b, x.s, el, null);
        if (!Object.is(val, prev)) { write(b, el, val, prev == UNSET ? undefined : prev, prev == UNSET); v[j] = val; }
      }
      if (only >= 0) break;
    }
  }

  /** Evaluates and writes one binding if needed; false while it waits in a closed dialog. */
  function process(rb: RB, level: number): boolean {
    const force = level >= 2 || (level == 1 && !!rb.b.i);
    if (!force && !(deferred.size && deferred.has(rb)) && !(rb.b.d && hit(rb.b.d, rb.s))) return true;
    // (an anchor's start comment is in its parent element, which a dialog's check reads)
    if (F.DIALOG && rb.c && waits(rb.el.nodeType == 1 ? rb.el as Element : rb.el.parentElement)) { deferred.add(rb); return false; }
    if (deferred.size) deferred.delete(rb);
    const v = evaluate(rb), k = rb.b.k;
    if (F.LIST && k == 'for') reconcile(rb, v);
    else if (F.BRANCH && (k == 'if' || k == 'ch')) toggle(rb, pick(rb.b, v), v?.[1]);
    else if (F.MODEL && k == 'model') writeModel(rb, v);
    else if (k == 'cmp') app.ext.components!(rb, v);
    else if (!Object.is(v, rb.v)) { write(rb.b, rb.el, v, rb.v == UNSET ? undefined : rb.v, rb.v == UNSET); rb.v = v; }
    return true;
  }

  /** In a closed dialog, or one the current event closes: a binding there waits until it opens. */
  function waits(el: Element | null): boolean {
    if (!el) return false;
    if (el.closest('dialog:not([open])')) return true;
    for (const d of closing) if (d.contains(el)) return true;
    return false;
  }

  /** Writes the bindings that wait in a dialog that is open (it opened, or an expected close did not happen). */
  function reveal(d: Element) {
    for (const rb of [...deferred]) if (deferred.has(rb) && d.contains(rb.el)) { cur = []; walk([rb], 2); }
    // a select's options inside the dialog render after its model: set its value again
    syncSelects();
  }

  /**
   * The open dialog the default action of `e` closes, before the handlers run: a `close` or
   * `request-close` command button, a submit of a `method="dialog"` form, Escape in a dialog that
   * closes on it. A handler may still prevent it: a task later the dialog renders if it stayed open.
   */
  function closes(e: Event, el: Element): Element | null {
    let d: Element | null | undefined = null;
    if (e.type == 'click') {
      const b = el.closest('button');
      if (!b || b.disabled) return null;
      const c = b.getAttribute('command'), t = b.getAttribute('commandfor');
      if (t && (c == 'close' || c == 'request-close')) d = (b as any).commandForElement ?? dialog(t);
      else if (b.type == 'submit' && b.form && (b.getAttribute('formmethod') ?? b.form.getAttribute('method'))?.toLowerCase() == 'dialog') d = b.form.closest('dialog');
    } else if (e.type == 'submit') {
      const s = (e as SubmitEvent).submitter, f = el as HTMLFormElement;
      if ((s?.getAttribute('formmethod') ?? f.getAttribute('method'))?.toLowerCase() == 'dialog') d = f.closest('dialog');
    } else if (e.type == 'keydown' && (e as KeyboardEvent).key == 'Escape' && !e.defaultPrevented) {
      d = el.closest('dialog[open]');
      let modal = false;
      try { modal = !!d?.matches(':modal'); } catch { /* no :modal */ }
      if (d && !modal && !/^(any|closerequest)$/.test(d.getAttribute('closedby') ?? '')) d = null;
    }
    return d?.localName == 'dialog' && d.hasAttribute('open') ? d : null;
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
      case 'text': n ? W.x(el, n, v) : W.t(el, n, v); break;
      case 'show': W.h(el, n, v); break;
      case 'prop': if (F.PROP) W.p!(el, n, v); break;
      case 'class':
        // a new element without a class attribute cannot have the class: skip removing it
        if (n) W.c(el, n, v, !fresh || el.hasAttribute('class'));
        else {
          if (prev?.[0] && prev[0] != v?.[0]) el.classList.remove(prev[0]);
          if (v?.[0]) el.classList.toggle(v[0], !!v[1]);
        }
        break;
      case 'attr': W.a(el, n, v); break;
      case 'style': if (F.STYLE) b.g != null ? W.g!(el, b.g, v, prev) : W.s!(el, n, v);
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
   * keeps its row. An item without the key fields (a helper's own object) keys by identity. A
   * string, number or other primitive keys by its type and value (`p…`), to which `reconcile` adds its occurrence.
   */
  function keyOf(t: TemplateDef, item: any, s: any): unknown {
    if (t.key != null) return 'k' + fns[t.key]!(s);
    if (Object(item) === item) {
      if (t.keyFields?.every((f) => item[f] != null)) return 'r' + t.keyFields.map((f) => item[f]).join('\x1f');
      for (const r of resources.values()) if (r.isCollection && keyed(r, item) && r.get(item) === item) return 'o' + r.name + '\x1f' + r.keyOf(item);
      return item;
    }
    return 'p' + typeof item + item;
  }

  function reconcile(rb: RB, v: any) {
    const items: unknown[] = v == null ? [] : Array.isArray(v) ? v : Symbol.iterator in Object(v) ? [...v] : [];
    // rows the early script rendered from the page's embedded data: adopted (bound, not cloned again) when there
    // are as many items, else removed; the row's values are written again, so a changed item still renders right
    const pre: { rows: Node[][]; end: Comment } | undefined = (rb.el as any)[EARLY_ROWS];
    // a primitive's key with its occurrence among equal values (`['a', 'b', 'a']`: `a`, `b`, `a` 1): duplicates are
    // rows of their own, the first `a` staying the first, so a list of strings needs no `data-sn-key`
    const seen = new Map<unknown, number>(), key = (item: unknown, s: any) => {
      const k = keyOf(rb.t!, item, s);
      if (typeof k != 'string' || k[0] != 'p') return k;
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return n ? k + '\x1f' + n : k;
    };
    if (pre) {
      delete (rb.el as any)[EARLY_ROWS];
      const t = rb.t!, tpl = tplOf(t.id);
      if (!rb.rows!.length && pre.rows.length == items.length) {
        rb.end = pre.end;
        rb.rows = items.map((item, i) => {
          const s = setRow(Object.create(rb.s), t, item, i);
          return instantiate(tpl, t, s, key(item, s), item, i, pre.rows[i]);
        });
        rb.rr = round;
        rb.pf = true;
        if (t.key == null && !t.keyFields) rb.ad = round;
        return;
      }
      cut(rb.el, pre.end);
      rb.end = pre.end;
    }
    const t = rb.t!, old = rb.rows!, end = rb.end ?? endFor(rb), tpl = tplOf(t.id), start = rb.el as unknown as Comment;
    const n = items.length, m = old.length, rows: Inst[] = new Array(n), moved = t.ri;
    // a first render inside a branch or row still being built: each row renders in place, in order, before the end
    const inPlace = !m && !end.isConnected ? end : undefined;
    // a scope is only needed up front for an explicit key expression
    const scopes = t.key != null ? items.map((item, i) => setRow(Object.create(rb.s), t, item, i)) : null;
    const keys = items.map((item, i) => key(item, scopes?.[i]));
    app.dupes?.(keys);
    // the takeover: the page module's items for an unkeyed list the early script rendered are new objects with the
    // same contents (a let over a helper, computed again), so the rows it adopted take the new keys and match by
    // position, written again
    if (rb.ad != null && round <= rb.ad + 1 && n == m) old.forEach((x, i) => (x.key = keys[i]));
    rb.ad = undefined;
    // a component's definition (a component inside itself): one row, its item the props, a new object at each
    // evaluation. The same values again keep the row as it is, as a choice's case does (`toggle`)
    const props = t.item!.startsWith('$p');
    // a change of the round inside a value the list reads (a deeper path, a `**`): what its rows hold may have changed
    // in place, so a row whose item changed renders to the bottom (force 2); else to the components whose props changed
    let dp: boolean | undefined;
    const deep = () => (dp ??= inside(rb));
    const reuse = (x: Inst, i: number) => {
      const item = items[i];
      if (x.item !== item && !(props && sameProps(x.item, item) && !deep())) { setRow(x.s, t, (x.item = item), (x.i = i)); x.f = deep() ? 2 : 3; }
      else if (x.i != i) { setRow(x.s, t, item, (x.i = i)); if (moved) x.f ||= 1; }
      // a computed list's row (`dv`): its item may have changed in place, which only the list depends on: the row renders
      // forced, to the bottom when the change is inside a value the list reads (`deep`), else to the components whose
      // props changed. Not a component's own row (a definition's list of its props): its item is the props, which
      // `sameProps` and `deep` have judged above
      if (t.dv && !props) x.f = x.f == 2 || deep() ? 2 : 3;
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
      else { seq.push(-1); rows[i] = instantiate(tpl, t, scopes?.[i] ?? setRow(Object.create(rb.s), t, items[i], i), keys[i], items[i], i, undefined, inPlace, rb); }
    }
    // collect the nodes of rows that go or move before the DOM changes
    const keep = lis(seq), moving = new Map<Inst, Node[]>(), gone: number[] = [];
    seq.forEach((o, k) => { if (o >= 0 && !keep.has(k)) moving.set(rows[a + k]!, nodesOf(o)); });
    for (let o = a; o < oe; o++) if (!used[o - a]) gone.push(o);
    if (m && gone.length == m) {
      // every old row goes (cleared, or all keys new): when the list owns its parent, drop them in
      // one operation; removing 5,000 rows one by one costs more than building the new ones
      const parent = end.parentNode!;
      if (parent.firstChild == start && parent.lastChild == end) parent.replaceChildren(start, end);
      else cut(start, end);
    } else for (const node of gone.flatMap(nodesOf)) (node as ChildNode).remove();
    if (deferred.size || models) for (const o of gone) if (old[o]!.rbs) forget(old[o]!.rbs!);
    const ref = ne < n ? rows[ne]!.first ?? end : end;
    if (!seq.some((o) => o >= 0)) {
      // only new rows in the middle: insert each straight before the reference (going through a
      // fragment first moves every node twice); rows rendered in place are there already
      const parent = ref.parentNode!;
      for (let i = inPlace ? ne : a; i < ne; i++) for (const node of rowNodes(rows[i]!)) parent.insertBefore(node, ref);
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

  /**
   * An `if` (`br`: 0 none, 1 its template, 2 its `data-sn-else`) or a choice, `<sn-component use>` (`br`: the case
   * its value names + 1, 0 none; `item`: that candidate's props). A branch the early chunk rendered is adopted when it
   * is the one to show, else removed. The same case of a choice again: its row takes the new props, as a definition's
   * one row does; another branch: the row is replaced by an instance of that branch's template.
   */
  function toggle(rb: RB, br: number, item?: unknown) {
    const ch = rb.b.k == 'ch', pre: { br: number; nodes: Node[]; end: Comment } | undefined = (rb.el as any)[EARLY];
    if (pre) {
      delete (rb.el as any)[EARLY];
      rb.end = pre.end;
      if (pre.br == br) {
        rb.br = br;
        // none on both sides (a kept element's branch the page before did not show): nothing to adopt
        if (br) make(rb, br, item, pre.nodes);
        else rb.rows = [];
        return;
      }
      cut(rb.el, pre.end);
    }
    if (br == rb.br) {
      const x = rb.rows?.[0];
      // a new props object: the row takes it and renders again, forced, since what its props hold may have changed
      // in place (the case's bindings read it through the row's item, which no dirty path names). Not when each
      // prop is the same value and no change of the round reached the choice from inside a value it reads (a
      // write below the dependency it reached): then nothing the props hold changed, and the walk visits the
      // row's bindings that changes reach, as a list's row with the same item. Each render makes a new props
      // object, so without this a recursive component re-renders its whole subtree whenever any prop's
      // dependency changes (a tree of 2,000 elements: every binding of every element).
      if (ch && x && x.item !== item) {
        const deep = inside(rb);
        if (!sameProps(x.item, item) || deep) { setRow(x.s, rb.t!, (x.item = item), 0); walkRow(x, rb.t!, deep ? 2 : 3); }
      }
      return;
    }
    // a wrapper's anchor has no end comment: its branch ends where its row or branch does
    const end: ChildNode = rb.u ? after(rb) : rb.end ?? endFor(rb);
    // same id, same control: the focused element of an if's old branch goes with it, its twin in the new one takes focus
    const f = doc.activeElement;
    // what is between the start and the end (a wrapper's anchor: from its row's first node), its bindings forgotten
    for (const n of range(rb.u ? rb.x!.first : rb.el.nextSibling, end)) (n as ChildNode).remove();
    forget([rb]);
    rb.rows = [];
    rb.br = br;
    rb.t = undefined;
    // in a branch or row still being built, the new branch renders in place; on the page, it is built apart and
    // inserted at once
    if (br) end.isConnected ? end.before(...rowNodes(make(rb, br, item))) : make(rb, br, item, undefined, end);
    if (rb.u) {
      // the wrapper's row (and the wrappers it is the branch of) starts with the new branch, or an empty comment
      let n = rb.rows[0]?.first;
      if (!n) end.before((n = new Comment()));
      for (let q: RB | undefined = rb; q?.x; q = q.u) q.x.first = n;
    }
    if (!ch && f?.id && !f.isConnected) (doc.getElementById(f.id) as HTMLElement | null)?.focus();
  }

  /** The branch an if's or choice's value names: an if's 1, its else 2; a choice's case + 1; 0 none. */
  function pick(b: Binding, v: any): number {
    return b.k == 'ch' ? (v ? v[0] + 1 : 0) : v ? 1 : b.z != null ? 2 : 0;
  }

  /** The branch `br` of an if or choice (`item`: the case's props): an instance of its template, its only row. */
  function make(rb: RB, br: number, item: unknown, nodes?: Node[], at?: Node): Inst {
    // an if's branch adds no names to the scope (a choice's case adds its props): it reads its anchor's own
    const ch = rb.b.k == 'ch', t = ir.templates[ch ? rb.b.c![br - 1]! : br == 1 ? rb.b.x! : rb.b.z!]!, s = ch ? Object.create(rb.s) : rb.s;
    if (ch) setRow(s, (rb.t = t), item, 0);
    return (rb.rows = [instantiate(tplOf(t.id), t, s, ch ? keyOf(t, item, s) : '', ch ? item : null, 0, nodes, at, rb)])[0]!;
  }

  /**
   * The node after a wrapper's row or branch: the next row's first node in a list, else what follows the anchor it is the
   * branch of (an if's or choice's one row has no next)
   */
  function after(rb: RB): ChildNode {
    const u = rb.u!;
    return u.u ? after(u) : (u.rows![rb.x!.i + 1]?.first as ChildNode) ?? u.end!;
  }

  /**
   * The end comment of an anchor bound for the first time, without an early render: what is between it and
   * the start is an early render that failed (no mark was left on the start), and goes. A start without
   * an end (a comment-stripping minifier) gets one, with a dev warning.
   */
  function endFor(rb: RB): Comment {
    const start = rb.el as unknown as Comment;
    let end = endOf(start);
    if (!end) { warn(31, start.data); start.after((end = new Comment('/sn'))); }
    else cut(start, end);
    return (rb.end = end);
  }

  /** What the early script rendered between an anchor's comments, which the page module does not adopt: all of it, nested anchors' rows and texts too. */
  function cut(start: Node, end: Node) {
    while (start.nextSibling && start.nextSibling != end) start.nextSibling.remove();
  }

  /** A head template by template id (`<template id="sn-t-<id>">`), found once. */
  function tplOf(tid: number): HTMLTemplateElement {
    return tpls[tid] ??= doc.getElementById('sn-t-' + tid) as HTMLTemplateElement;
  }

  /**
   * `pre`: nodes the early chunk already rendered from this template, bound instead of a clone. `at`: a node outside
   * the page (in a branch or row still being built) to put the clone before, ahead of its bindings, so its nested
   * anchors render in place: each node is moved once, not once per level of anchors around it.
   */
  function instantiate(tpl: HTMLTemplateElement, t: TemplateDef, s: any, key: unknown, item: unknown, i: number, pre?: Node[], at?: Node, u?: RB): Inst {
    if (!pre && (t.a || t.tx)) {
      // a text run (`tx`): one text node, its binding's own. A wrapper (`a`): no clone and no comments; its anchor is
      // bound without a start or end comment, and its branch, rendered where the row would go (in place before `at`,
      // else apart), is the row's nodes; an empty comment stands in while there is none, so that the row has a first node
      const b = t.nodes[0]!.b[0]!, x: Inst = { first: null, nodes: null, rbs: null, v: null, s, key, item, i, f: 0, r: round };
      const rb: RB = { b, el: t.a ? u!.el : (x.first = new Text()) as unknown as Element, s, v: UNSET, u, x };
      x.rbs = [rb];
      if (t.tx) {
        if (at) (at as ChildNode).before(x.first!);
        process(rb, 2);
        return x;
      }
      const v = evaluate(rb);
      if ((rb.br = pick(b, v))) x.nodes = rowNodes(make(rb, rb.br, v?.[1], undefined, at));
      if (!x.nodes?.length) { x.nodes = [new Comment()]; if (at) (at as ChildNode).before(x.nodes[0]!); }
      x.first = x.nodes[0]!;
      return x;
    }
    // foreign content (`w`): the rows are the children of the `<svg>` or `<math>` the head template holds (a clone of
    // that element holds a row's nodes as a fragment would, until they are inserted)
    const content: Node = t.w ? tpl.content.firstChild! : tpl.content, one = t.o;
    const top: Node = pre ? (one ? pre[0]! : content) : one ? content.firstChild!.cloneNode(true) : content.cloneNode(true);
    const first = pre ? pre[0] ?? null : one ? top : top.firstChild;
    // (never with `pre`; foreign content's rows are the children of the clone, inserted by the caller)
    if (at && !t.w) (at as ChildNode).before(top); else at = undefined;
    const defs = t.nodes, rbs: RB[] = [];
    // A node and what the early script rendered after it: a nested anchor's branch or rows, up to its end comment.
    const extent = (n: Node): Node => ((n as any)[EARLY] ?? (n as any)[EARLY_ROWS])?.end ?? (isStart(n) ? endOf(n) ?? n : n);
    // one path step: an anchor's start and end are a node each (as the compiler counts them), what is rendered between them none
    const step = (n: Node): Node | null => { const e = extent(n); return e != n ? e : n.nextSibling; };
    const find = (): Array<Element | null> => {
      // an adopted early row may hold the branches and rows the early script rendered for its nested templates:
      // the compiled lookup counts siblings and would land on those, so it walks the paths and steps over them
      if (t.find != null && !pre) return fns[t.find]!(first);
      // if/else branches, adopted rows (and IR compiled before lookup functions): path[0] picks a child of the content
      const els: Array<Element | null> = new Array(defs.length);
      for (let k = 0; k < defs.length; k++) {
        const path = defs[k]!.path!;
        let node: Node | null = first;
        for (let c = path[0]!; c-- && node;) node = step(node);
        for (let x = 1; x < path.length && node; x++) {
          node = node.firstChild;
          for (let c = path[x]!; c-- && node;) node = step(node);
        }
        els[k] = node && nameOf(node) == defs[k]!.tag ? (node as Element) : null;
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
      else if (!one) for (let c = at ? first : top.firstChild; c && c != at; c = c.nextSibling) nodes.push(c);
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

  /** A simple row template (the compiler's `sm`: a lookup function, only value bindings and handlers; no state, model, nested template or dialog): its value bindings and handlers. */
  function isSimple(t: TemplateDef): Simple | null {
    let v = simple.get(t);
    if (v === undefined) {
      const pick = (on: boolean) => t.nodes.flatMap((nd, k) => nd.b.filter((b) => (b.k == 'on') == on).map((b): [number, Binding] => [k, b]));
      v = t.sm ? { vals: pick(false), hs: pick(true) } : null;
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
    // (handlers bound on their first event are in the rows of a simple template: a list's or a branch's)
    if (h != null || !(F.LIST || F.BRANCH)) return h;
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
      if (F.DIALOG) {
        if (e.type == 'toggle' && el.localName == 'dialog' && el.hasAttribute('open') && !closing.has(el)) reveal(el);
        const d = closes(e, el);
        if (d && !closing.has(d)) {
          closing.add(d);
          // the close runs after this event's handlers, in the same task; if it did not (prevented), render now
          env.setTimeout(() => { closing.delete(d); if (!destroyed && d.hasAttribute('open')) reveal(d); }, 0, 'task');
        }
      }
      // models update state before other handlers on the same event
      const m = F.MODEL ? (el as Tagged)[MODEL] : undefined;
      if (m && /^(input|change)$/.test(e.type) && (m.b.ms || (e.type == 'input') == (m.b.n == 'text'))) {
        // `data-sn-model-debounce` (debounce.ts): it writes once the field pauses, as an event's write that is
        // not typing (the pause is over), with the value the field has then; a text field's `change` (Enter,
        // leaving it) ends the pause
        if (m.b.ms) {
          const u = ev, now = m.b.n == 'text' && e.type == 'change';
          if (now || (e.type == 'input') == (m.b.n == 'text')) app.ext.debounce!(m, now ? 0 : m.b.ms, () => m.el.isConnected && as(u, () => setModel(m, readModel(m))));
        } else setModel(m, readModel(m), e.type == 'input' && !m.el.localName.includes('-'));
      }
      for (; el; el = el.parentElement) {
        const h = handlersOf(el as Tagged), hs = h && (Array.isArray(h) ? h : [h]).filter((x) => x.b.n == e.type && (x.b.q == null || app.ext.keys!(x, e as KeyboardEvent)));
        if (hs?.length) {
          // a debounced handler (debounce.ts) runs once, with the last event, if its element is still on the page
          const u = ev;
          for (const h of hs) F.ACTION && h.b.x != null ? trigger(h, e) : h.b.ms ? app.ext.debounce!(h, h.b.ms, () => h.el.isConnected && as(u, () => handle(h, h.b.f!, e, h.b.w))) : handle(h, h.b.f!, e, h.b.w);
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
    if (!acts.has(el)) acts.set(el, { n: 0, q: [], w: null, r: null, off: null });
    return acts.get(el)!;
  }

  function fire(rb: RB, a: ActionDef, e: Event | null) {
    // `then` and `catch` run in the context of what triggered the action (a user's event, or not)
    const st = act(rb.el), u = ev;
    if (a.concurrency == 'block' && st.n) return;
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
    const run = () => void send(rb, a, st, url, body, drop, u);
    if (!st.n) run();
    else if (a.concurrency == 'latest') { st.w ? st.w.drop() : app.busy++; st.w = { run, drop }; st.r?.abort(); }
    else { app.busy++; st.q.push(run); }
    }
  }

  async function send(rb: RB, a: ActionDef, st: ActState, url: string, body: unknown, drop: (ok?: boolean) => void, u: Event | null) {
    const el = rb.el as HTMLFormElement, s = rb.s;
    // where the element is now: an optimistic remove may take its row away before an error reports
    const up: Element[] = [];
    for (let x = el.parentElement; x; x = x.parentElement) up.push(x);
    st.n++;
    // server errors on the form (fields.ts): its marks cleared and its `$error` null while it is sent again
    const fs = app.ext.fields?.sent(el, a);
    el.setAttribute('aria-busy', 'true');
    if (a.form && a.concurrency == 'block' && !st.off) {
      st.off = ([...el.elements] as HTMLInputElement[]).filter((x) => !x.disabled);
      for (const x of st.off) x.disabled = true;
    }
    try {
      const result = a.call
        ? await app.ext.call!.run(a.call.run, body, el, undefined, a.retry ? { retry: a.retry, stop: (st.r = new AbortController()).signal } : undefined)
        : await req.send(url, { method: a.method, body, ...(a.retry ? { retry: a.retry, stop: (st.r = new AbortController()).signal } : {}) });
      // a success keeps the optimistic change, under what `then` writes
      drop(true);
      // write-through lands between the commit and `then`, so `then` still has the last word
      if (a.ap) app.ext.apply?.(a, s, url, body, result);
      if (a.then != null) as(u, () => handle(rb, a.then!, null, a.w, { $result: result }));
    } catch (err) {
      drop();
      if (isAbort(err)) return;
      const error = a.call ? app.ext.call!.error(err) : toError(err);
      // shown on the form (every message on its field, or its markup reads `$error`): handled
      if (fs?.(error, { url, method: a.method }) && a.catch == null) return;
      as(u, () => a.catch != null ? handle(rb, a.catch, null, a.w, { $error: error }) : unhandled(error, el.isConnected ? el : up.find((x) => x.isConnected) ?? null));
    } finally {
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
    const r = createResource(def.name, { key: def.key ?? null, order: def.order ?? null, locale: () => config.locale?.get(), warn, prep: (x) => (app.prep ? app.prep(x) : x), freeze: app.dev, list: def.ls });
    r.onDirty = (what) => app.mark((what == 'data' ? '$r.' : '$meta.') + def.name);
    resources.set(def.name, r);
    Object.defineProperty(app.page.$r, def.name, { get: r.value, enumerable: true });
    app.page.$meta[def.name] = r.meta;
    // fed by a server-event stream: connecting until its first open (src/sse.ts keeps it current)
    if (def.fed) r.meta.live = 'connecting';
    /** `had`: the resource has had a URL (its first one after mount restores a `model` (paginate) page) */
    let url: string | null = null, c: AbortController | null = null, seq = 0, again: Promise<void> | null = null, loud = false, had = false, typing: unknown = null, posted: unknown;

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
      try {
        if (def.when != null && !fns[def.when]!(s)) return null;
        const u = app.url(def.src, s);
        if (def.body == null) return u;
        // `method="POST"`: a load is its URL and its body
        posted = fns[def.body]!(s);
        return u + '\0' + JSON.stringify(posted ?? null);
      } catch (e) { warn(17, def.name, (e as Error).message); return null; }
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
      let items = pick(def.select, body);
      if (r.isCollection && !Array.isArray(items)) { warn(12, def.name, def.select ?? '(response)'); items = []; }
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
        let items = pick(def.select, body);
        if (!Array.isArray(items)) { warn(12, def.name, def.select ?? '(response)'); items = []; }
        return items.map(clean);
      },
      start() {
        const el = def.data != null ? found.get(def.data) as Element | undefined : null;
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
          const ahead = app.ext.prefetch && !def.call && !def.each && !def.paginate && def.body == null;
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
        // a `file:` resource: a constant read at build time, never loaded (`loadedAt` null)
        if (!def.fx) r.meta.loadedAt = new Date(env.now());
        l.done(v);
        l.settle(true);
      },
      /** `src` or `when` may have changed: reload from the first page if the URL differs. From typing: once the typing pauses. */
      changed(soft?: boolean) {
        if (def.fx) return;
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
      refresh: (_hint, quiet) => {
        if (def.fx) return Promise.resolve();
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
            : def.body != null
            ? await loadShared(url.slice(0, url.indexOf('\0')), ctl.signal, (def.lo ?? 0) | (quiet ? 2 : 0), { key: url, body: posted }).then((g) => g.body())
            : await l.get(req, ctl.signal, (def.lo ?? 0) | (quiet ? 2 : 0));
          if (n != seq) return;
          // UNCHANGED (the versions module): nothing to store; `then` still runs, with what that data's load stored
          loaded = body !== UNCHANGED;
          v = loaded ? store(body, req, m) : body;
          ok = true;
          r.meta.error = null;
          r.meta.loadedAt = new Date(env.now());
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
  /** a GET shared by every load of one URL; `post`: a POST resource's load, shared by URL and body (`key`) */
  function loadShared(target: string, signal: AbortSignal, lo = 0, post?: { key: string; body: unknown }): Promise<Got> {
    const url = post?.key ?? target;
    let e = shared.get(url);
    if (!e) {
      const c = new AbortController(), entry = { n: 0, c, p: req.raw(target, { signal: c.signal, ...(post ? { method: 'POST', body: post.body } : {}), ...(lo & 1 ? { priority: 'low' as const } : {}), ...(lo & 2 ? { retry: false as const } : {}) }).then(gotOf) };
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
