// The runtime: mounts a compiled page, owns the store, the scheduler, the
// renderer, delegated events, actions and resource loading.
import { IR_VERSION, type ActionDef, type Binding, type Fn, type IR, type NodeDef, type ResourceDef, type TemplateDef, type UrlTemplate } from '../ir.js';
import { config, SinterError, type Middleware } from './config.js';
import type { Env } from './env.js';
import { createRequestLayer, isAbort, type RequestLayer, type SendInit } from './request.js';
import { allowedSchemes, encodeSegment, srcsetAllowed, styleValueAllowed, URL_ATTRS, urlAllowed } from './security.js';
import { clean, Resource, type Op } from './store.js';

export interface Feature {
  name: string;
  install(app: App): void;
}

export interface MountOptions {
  ir: IR;
  fns: Fn[];
  features?: Feature[];
  dev?: boolean;
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

type Path = string[];

/** A binding attached to one node in one scope. */
interface RB {
  def: Binding;
  el: Element;
  scope: any;
  last: unknown;
  block: Block;
  list?: ListCtl;
  cond?: CondCtl;
}

interface Block { rbs: RB[] }

interface Inst {
  nodes: Node[];
  block: Block;
  scope: any;
  key: string;
  item: unknown;
  index: number;
  force: boolean;
}

interface ListCtl { tdef: TemplateDef; insts: Inst[] }
interface CondCtl { inst: Inst | null; branch: 'if' | 'else' | null; elseEl: Element | null }

interface ActState {
  pending: number;
  queue: Array<() => Promise<void>>;
  waiting: { run: () => Promise<void>; drop: () => void } | null;
  ctl: AbortController | null;
  timer: unknown;
  disabled: Element[] | null;
}

export interface StateHandle<T = any> {
  get(): T;
  update(fn: (state: T) => void): void;
}

const instances = new WeakMap<object, App>();
const TEXT_LIKE = new Set(['text']);
const qsaDoc = typeof Document !== 'undefined' ? Document.prototype.querySelectorAll : null;
const qsaEl = typeof Element !== 'undefined' ? Element.prototype.querySelectorAll : null;
const getAttr = typeof Element !== 'undefined' ? Element.prototype.getAttribute : null;

export function mount(root: Document | Element, options: MountOptions): App {
  if (instances.has(root)) throw new Error('sinter: already mounted on this root');
  const app = new App(root, options);
  instances.set(root, app);
  app.start();
  return app;
}

/** The instance mount() created on `root`; throws if none. */
export function instance(root: Document | Element): App {
  const app = instances.get(root);
  if (!app) throw new Error('sinter: no instance is mounted on this root');
  return app;
}

/** Splits a dependency/write path; `{name}` segments are filled from the scope. */
const pathCache = new Map<string, Path>();
function split(p: string): Path {
  let s = pathCache.get(p);
  if (!s) { s = p.split('.'); pathCache.set(p, s); }
  return s;
}

function overlaps(a: Path, b: Path): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i] && a[i] !== '*' && b[i] !== '*') return false;
  return true;
}

export class App {
  readonly ir: IR;
  readonly fns: Fn[];
  readonly dev: boolean;
  readonly env: Env;
  readonly req: RequestLayer;
  readonly resources = new Map<string, Resource>();
  readonly loaders = new Map<string, ResourceLoader>();
  /** feature hooks */
  readonly ext: {
    optimistic?: { begin(fn: number, scope: any): () => void };
    paginate?: { pager(loader: ResourceLoader): Pager; page(name: string, target: string | number): void };
    persist?: {
      model(rb: { def: Binding; scope: any; el: Element }, set: (v: unknown) => void): void;
      state(key: string, obj: Record<string, unknown>): void;
      saveState(key: string, obj: Record<string, unknown>): void;
    };
  } = {};
  readonly afterFlush: Array<(dirty: Path[]) => void> = [];
  /** the base scope: resources, status, magic names */
  readonly page: any;
  readonly host: Element;

  private dirty: Path[] = [];
  private current: Path[] = [];
  private scheduled = false;
  private flushing = false;
  private rootBlock: Block = { rbs: [] };
  private handlers = new WeakMap<Element, RB[]>();
  private models = new WeakMap<Element, RB>();
  private anchors = new WeakMap<Node, RB>();
  private stateEls = new WeakMap<Element, { sid: number; obj: any }>();
  private rootScopes: any[] = [];
  private shared = new Map<string, { users: number; ctl: AbortController; promise: Promise<unknown> }>();
  private rootStates: Array<{ sid: number; obj: any; json: string; persist?: string }> = [];
  private selects = new Set<RB>();
  private deferred = new Set<RB>();
  private actStates = new WeakMap<Element, ActState>();
  private types = new Set<string>(['toggle']);
  private ids = new Map<number, Element>();
  private serverListeners = new Map<string, Set<(payload: unknown) => void>>();
  private identities = new WeakMap<object, number>();
  private nextIdentity = 1;
  private cleanups: Array<() => void> = [];
  private warned = new Set<string>();
  readonly schemes: Set<string>;
  readonly transport: (url: string) => Transport | undefined;
  /** pending debounce timers and queued actions, for the testing module */
  busy = 0;

  constructor(readonly root: Document | Element, options: MountOptions) {
    if (!options.ir || options.ir.v !== IR_VERSION) throw new Error(`sinter: unsupported IR version ${options.ir?.v}`);
    this.ir = options.ir;
    this.fns = options.fns;
    this.dev = !!options.dev;
    this.env = options.env ?? config.env;
    this.req = createRequestLayer(this.env, options.request ?? config.request);
    this.schemes = allowedSchemes(config.urlSchemes);
    this.transport = options.transport ?? (() => undefined);
    this.host = (root as Document).documentElement ?? (root as Element);
    const app = this;
    const $url = this.readUrl();
    this.page = {
      $r: {}, $meta: {}, $url, $now: new Date(this.env.now()), $p: undefined,
      $f: this.storeFns(null),
      get $locale() { return config.locale?.get(); },
      set $locale(v: any) { config.locale?.set(v); app.mark('$locale'); },
    };
    for (const f of options.features ?? []) f.install(this);
  }

  // ---- public instance API

  resource<T extends object = any>(name: string): Resource<T> {
    const r = this.resources.get(name);
    if (!r) throw new Error(`sinter: resource \`${name}\` is not declared on this page`);
    return r as Resource<T>;
  }

  request(url: string, init: SendInit = {}): Promise<unknown> {
    return this.req.send(url, init);
  }

  /** Applies `change` as an optimistic layer and settles it when `run()` settles. */
  async optimistic<T>(change: () => void, run: () => Promise<T>): Promise<T> {
    const drop = this.record(change);
    try { return await run(); } finally { drop(); }
  }

  on(event: string, fn: (payload: any) => void): () => void {
    if (!this.serverListeners.has(event)) this.serverListeners.set(event, new Set());
    this.serverListeners.get(event)!.add(fn);
    for (const l of this.onListen) l(event);
    return () => this.serverListeners.get(event)?.delete(fn);
  }

  state<T = any>(el: Element): StateHandle<T> {
    let cur: Element | null = el;
    while (cur) {
      const s = this.stateEls.get(cur);
      if (s) {
        return {
          get: () => s.obj,
          update: (fn) => { fn(s.obj); this.mark(`$s${s.sid}`); },
        };
      }
      cur = cur.parentElement;
    }
    throw new Error('sinter: no data-sn-state scope encloses this element');
  }

  /** Unmounts: closes streams and timers. */
  destroy(): void {
    for (const c of this.cleanups.splice(0)) c();
    instances.delete(this.root);
  }

  // ---- for feature modules and loaders

  /** The scope a root node's bindings see (its own state scope if it opens one). */
  scopeFor(nodeIndex: number): any {
    return nodeIndex >= 0 ? this.rootScopes[nodeIndex] ?? this.page : this.page;
  }

  /** GETs `url`; concurrent loads of one URL share one request, aborted when no one waits. */
  loadShared(url: string, signal: AbortSignal): Promise<unknown> {
    let entry = this.shared.get(url);
    if (!entry) {
      const ctl = new AbortController();
      const e = { users: 0, ctl, promise: this.req.send(url, { signal: ctl.signal }) };
      e.promise.then(() => {}, () => {}).finally(() => { if (this.shared.get(url) === e) this.shared.delete(url); });
      this.shared.set(url, e);
      entry = e;
    }
    const e = entry;
    e.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        if (--e.users === 0) { e.ctl.abort(); this.shared.delete(url); }
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      e.promise.then(
        (v) => { if (done) return; done = true; e.users--; signal.removeEventListener('abort', onAbort); resolve(v); },
        (err) => { if (done) return; done = true; e.users--; signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  }

  readonly onListen: Array<(event: string) => void> = [];

  serverEvent(name: string, payload: unknown): void {
    for (const fn of this.serverListeners.get(name) ?? []) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  hasServerListener(name: string): boolean {
    return (this.serverListeners.get(name)?.size ?? 0) > 0;
  }

  addCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  warn(msg: string, value?: unknown): void {
    if (!this.dev) return;
    if (value === undefined) { if (this.warned.has(msg)) return; this.warned.add(msg); }
    console.warn(`sinter: ${msg}`, ...(value === undefined ? [] : [value]));
  }

  /** Runs `change` with every resource recording, then adds one layer per touched resource. */
  record(change: () => void): () => void {
    const recs = new Map<Resource, Op[]>();
    for (const r of this.resources.values()) { r.recording = []; recs.set(r, r.recording); }
    try { change(); } finally { for (const r of this.resources.values()) r.recording = null; }
    const layers: Array<[Resource, number]> = [];
    for (const [r, ops] of recs) if (ops.length) layers.push([r, r.addLayer(ops)]);
    let dropped = false;
    return () => {
      if (dropped) return;
      dropped = true;
      for (const [r, id] of layers) r.dropLayer(id);
    };
  }

  /** Resolves a URL template in a scope. */
  url(tpl: UrlTemplate, scope: any): string {
    let s = '';
    for (const p of tpl) s += typeof p === 'string' ? p : encodeSegment(this.fns[p]!(scope));
    return s;
  }

  // ---- scheduling

  mark(path: string, scope?: any): void {
    let segs = split(path);
    if (scope && path.includes('{')) segs = segs.map((s) => (s[0] === '{' ? String(scope[s.slice(1, -1)]) : s));
    this.dirty.push(segs);
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.flushing) return;
    this.scheduled = true;
    this.env.queueMicrotask(() => this.flush());
  }

  get isDirty(): boolean {
    return this.dirty.length > 0 || this.scheduled;
  }

  flush(): void {
    this.scheduled = false;
    if (this.flushing) return;
    this.flushing = true;
    try {
      let guard = 0;
      while (this.dirty.length) {
        if (++guard > 100) { console.error('sinter: flush did not settle after 100 rounds'); this.dirty = []; break; }
        const dirty = this.dirty;
        this.dirty = [];
        this.current = dirty;
        if (this.dev) this.detectOutside(dirty);
        for (const l of this.loaders.values()) if (l.def.deps.some((d) => this.isDirtyPath(split(d), null))) l.srcChanged();
        this.walk(this.rootBlock, false);
        for (const rb of this.selects) this.writeModel(rb, this.eval(rb));
        for (const h of this.afterFlush) h(dirty);
        if (this.dev) this.snapshot();
      }
    } finally {
      this.current = [];
      this.flushing = false;
    }
  }

  private isDirtyPath(dep: Path, scope: any): boolean {
    let d = dep;
    if (scope) for (let i = 0; i < d.length; i++) {
      const s = d[i]!;
      if (s[0] === '{') { if (d === dep) d = [...dep]; d[i] = String(scope[s.slice(1, -1)]); }
    }
    for (const p of this.current) if (overlaps(d, p)) return true;
    return false;
  }

  private depsDirty(rb: RB): boolean {
    const deps = rb.def.d;
    if (!deps) return false;
    for (const d of deps) if (this.isDirtyPath(split(d), rb.scope)) return true;
    return false;
  }

  private detectOutside(dirty: Path[]): void {
    for (const s of this.rootStates) {
      let json: string;
      try { json = JSON.stringify(s.obj); } catch { continue; }
      if (json !== s.json && !dirty.some((p) => p[0] === `$s${s.sid}`)) {
        const names = Object.keys(s.obj).join('`, `');
        this.warn(`state \`${names}\` changed outside sinter: use \`update()\``);
      }
    }
  }

  private snapshot(): void {
    for (const s of this.rootStates) {
      try { s.json = JSON.stringify(s.obj); } catch { /* not serializable */ }
    }
  }

  // ---- mount

  start(): void {
    const list = this.root.nodeType === 9 ? qsaDoc!.call(this.root as Document, '[data-sn]') : qsaEl!.call(this.root as Element, '[data-sn]');
    const bad = new Set<number>();
    for (const el of Array.from(list)) {
      const id = Number(getAttr!.call(el, 'data-sn'));
      if (!Number.isInteger(id)) continue;
      if (this.ids.has(id)) bad.add(id);
      this.ids.set(id, el);
    }
    for (const id of bad) { this.ids.delete(id); this.warn(`duplicate \`data-sn="${id}"\`; not bound`); }

    for (const def of this.ir.resources) this.createResource(def);

    const els: Array<Element | null> = this.ir.roots.map((nd) => {
      const el = this.ids.get(nd.id!);
      if (!el) { this.warn(`missing \`data-sn="${nd.id}"\`; not bound`); return null; }
      if (el.localName !== nd.tag) { this.warn(`\`data-sn="${nd.id}"\` is on <${el.localName}>, expected <${nd.tag}>; not bound`); return null; }
      return el;
    });
    this.bindNodes(this.ir.roots, els, this.page, this.rootBlock);

    for (const t of this.types) {
      const fn = (e: Event) => this.dispatch(e);
      this.root.addEventListener(t, fn, true);
      this.cleanups.push(() => this.root.removeEventListener(t, fn, true));
    }
    if (this.ir.now) this.tickNow();
    if (this.ir.resources.length || this.ir.roots.some((n) => n.b.some((b) => b.d?.some((d) => d.startsWith('$url'))))) {
      this.cleanups.push(this.env.listen('popstate', () => this.refreshUrl()));
    }
    for (const l of this.loaders.values()) l.start();
    this.current = [];
    this.flushing = true;
    try { this.walk(this.rootBlock, true); } finally { this.flushing = false; }
    for (const rb of this.selects) this.writeModel(rb, this.eval(rb));
    this.snapshot();
    if (this.dirty.length) this.schedule();
  }

  private createResource(def: ResourceDef): void {
    const r = new Resource(def.name, {
      key: def.key, order: def.order, dev: this.dev, locale: () => config.locale?.get(),
      warn: (m, v) => this.warn(m, v),
    });
    r.onDirty = (what) => this.mark(what === 'data' ? `$r.${def.name}` : `$meta.${def.name}`);
    this.resources.set(def.name, r);
    Object.defineProperty(this.page.$r, def.name, { get: () => r.value(), enumerable: true });
    this.page.$meta[def.name] = r.meta;
    const loader = new ResourceLoader(this, def, r);
    this.loaders.set(def.name, loader);
    r.loader = loader;
  }

  /** Embedded `<script type="application/json" data-sn-data>` payload for a resource, if valid. */
  embedded(def: ResourceDef): { value: unknown } | null {
    if (def.data == null) return null;
    const el = this.ids.get(def.data);
    if (!el || el.localName !== 'script' || el.parentElement?.localName !== 'head') {
      this.warn(`embedded data for \`${def.name}\` must be a <script> in <head>; ignored`);
      return null;
    }
    try { return { value: JSON.parse(el.textContent ?? '') }; } catch {
      this.warn(`embedded data for \`${def.name}\` is not valid JSON; ignored`);
      return null;
    }
  }

  private bindNodes(defs: NodeDef[], els: Array<Element | null>, base: any, block: Block): void {
    const scopes: any[] = [];
    defs.forEach((nd, i) => {
      const el = els[i];
      let scope = nd.p >= 0 ? (scopes[nd.p] ?? base) : base;
      if (nd.state !== undefined && el) {
        const obj = this.fns[nd.state]!(scope);
        if (nd.persist) this.ext.persist?.state(nd.persist, obj);
        scope = Object.create(scope);
        scope[`$s${nd.sid}`] = obj;
        this.stateEls.set(el, { sid: nd.sid!, obj });
        if (block === this.rootBlock) this.rootStates.push({ sid: nd.sid!, obj, json: '', ...(nd.persist ? { persist: nd.persist } : {}) });
        if (nd.persist) {
          const key = nd.persist, sid = nd.sid!;
          this.afterFlush.push((dirty) => { if (dirty.some((p) => p[0] === `$s${sid}`)) this.ext.persist?.saveState(key, obj); });
        }
      }
      scopes[i] = scope;
      if (block === this.rootBlock) this.rootScopes[i] = scope;
      if (!el) return;
      for (const b of nd.b) this.bind(b, el, scope, block, defs, els);
    });
  }

  private bind(def: Binding, el: Element, scope: any, block: Block, defs: NodeDef[], els: Array<Element | null>): void {
    const rb: RB = { def, el, scope, last: undefined, block };
    switch (def.k) {
      case 'on': {
        const list = this.handlers.get(el) ?? [];
        list.push(rb);
        this.handlers.set(el, list);
        this.types.add(def.n!);
        if (def.x !== undefined) {
          const a = this.ir.actions[def.x]!;
          if (a.debounce || a.concurrency) { /* per-element state is created lazily */ }
        }
        return;
      }
      case 'else':
        return;
      case 'model':
        this.models.set(el, rb);
        this.types.add('input').add('change');
        if (el.localName === 'select') this.selects.add(rb);
        if (def.p !== undefined) this.ext.persist?.model(rb, (v) => this.setModel(rb, v));
        break;
      case 'for':
        rb.list = { tdef: this.ir.templates[def.x!]!, insts: [] };
        this.anchors.set(el, rb);
        break;
      case 'if':
        rb.cond = { inst: null, branch: null, elseEl: def.y !== undefined ? els[def.y] ?? null : null };
        this.anchors.set(el, rb);
        if (rb.cond.elseEl) this.anchors.set(rb.cond.elseEl, rb);
        void defs;
        break;
    }
    block.rbs.push(rb);
  }

  // ---- rendering

  private walk(block: Block, force: boolean): void {
    for (const rb of block.rbs) {
      if (!this.process(rb, force)) continue;
      if (rb.list) for (const inst of rb.list.insts) { const f = force || inst.force; inst.force = false; this.walk(inst.block, f); }
      else if (rb.cond?.inst) this.walk(rb.cond.inst.block, force);
    }
  }

  /** Evaluates and writes one binding if needed; false if it is deferred (closed dialog). */
  private process(rb: RB, force: boolean): boolean {
    if (this.inClosedDialog(rb.el)) { this.deferred.add(rb); return false; }
    if (this.deferred.delete(rb)) force = true;
    if (!force && !this.depsDirty(rb)) return true;
    const v = this.eval(rb);
    switch (rb.def.k) {
      case 'for': this.reconcile(rb, v); return true;
      case 'if': this.toggleIf(rb, !!v); return true;
      case 'model': this.writeModel(rb, v); return true;
    }
    if (!force && Object.is(v, rb.last)) return true;
    const prev = rb.last;
    rb.last = v;
    this.write(rb, v, prev);
    return true;
  }

  private inClosedDialog(el: Element): boolean {
    const d = el.closest('dialog');
    return !!d && !(d as HTMLDialogElement).open && !d.hasAttribute('open');
  }

  private eval(rb: RB): unknown {
    const scope = Object.create(rb.scope);
    scope.$el = rb.el;
    try {
      return this.fns[rb.def.f!]!(scope);
    } catch (e) {
      this.warn(`binding \`${rb.def.k}\` on <${rb.el.localName}> threw: ${(e as Error)?.message}`);
      return undefined;
    }
  }

  private write(rb: RB, v: unknown, prev: unknown): void {
    const el = rb.el as HTMLElement;
    const name = rb.def.n!;
    switch (rb.def.k) {
      case 'text': el.textContent = v == null ? '' : String(v); return;
      case 'show': el.hidden = !v; return;
      case 'attr': {
        if (v == null || v === false) { el.removeAttribute(name); return; }
        const s = v === true ? '' : String(v);
        const lname = name.toLowerCase();
        const base = /^https?:/.test(el.ownerDocument.baseURI) ? el.ownerDocument.baseURI : this.env.href();
        if ((URL_ATTRS.has(lname) && !urlAllowed(s, lname, el.localName, base, this.schemes))
          || ((lname === 'srcset' || lname === 'imagesrcset') && !srcsetAllowed(s, el.localName, base, this.schemes))) {
          el.removeAttribute(name);
          this.warn(`refused URL in \`${name}\` on <${el.localName}>`, s);
          return;
        }
        el.setAttribute(name, s);
        return;
      }
      case 'class': {
        if (name === '') {
          const [k, on] = Array.isArray(v) ? v : [null, false];
          const [pk] = Array.isArray(prev) ? prev : [null];
          if (pk && pk !== k) el.classList.remove(String(pk));
          if (k) el.classList.toggle(String(k), !!on);
          return;
        }
        el.classList.toggle(name, !!v);
        return;
      }
      case 'style': {
        if (v == null || v === false) { el.style.removeProperty(name); return; }
        const s = String(v);
        if (!styleValueAllowed(s)) { el.style.removeProperty(name); this.warn(`refused style value for \`${name}\``, s); return; }
        el.style.setProperty(name, s);
        return;
      }
      case 'prop': (el as unknown as Record<string, unknown>)[name] = v; return;
    }
  }

  // ---- models

  private writeModel(rb: RB, v: unknown): void {
    const el = rb.el as HTMLInputElement & HTMLSelectElement;
    switch (rb.def.n) {
      case 'checkbox': {
        const on = Array.isArray(v) ? v.map(String).includes(el.value) : !!v;
        if (el.checked !== on) el.checked = on;
        return;
      }
      case 'radio': {
        const on = v != null && String(v) === el.value;
        if (el.checked !== on) el.checked = on;
        return;
      }
      case 'multi': {
        const vals = Array.isArray(v) ? v.map(String) : [];
        for (const o of Array.from(el.options)) { const on = vals.includes(o.value); if (o.selected !== on) o.selected = on; }
        return;
      }
      default: {
        const s = v == null || (typeof v === 'number' && Number.isNaN(v)) ? '' : String(v);
        if (el.value === s) return;
        if (rb.def.n === 'number' && el.value !== '' && Number(el.value) === v) return;
        el.value = s;
      }
    }
  }

  private readModel(rb: RB): { value: unknown } | null {
    const el = rb.el as HTMLInputElement & HTMLSelectElement;
    switch (rb.def.n) {
      case 'number': return { value: el.value === '' ? null : Number(el.value) };
      case 'checkbox': {
        const cur = this.eval(rb);
        if (Array.isArray(cur)) {
          const i = cur.map(String).indexOf(el.value);
          if (el.checked && i < 0) cur.push(el.value);
          else if (!el.checked && i >= 0) cur.splice(i, 1);
          return { value: cur };
        }
        return { value: el.checked };
      }
      case 'radio': return el.checked ? { value: el.value } : null;
      case 'multi': return { value: Array.from(el.selectedOptions).map((o) => o.value) };
      default: return { value: el.value };
    }
  }

  private setModel(rb: RB, v: unknown): void {
    try {
      this.fns[rb.def.a!]!(rb.scope, v);
    } catch (e) {
      this.warn(`model on <${rb.el.localName}> could not be set: ${(e as Error)?.message}`);
      return;
    }
    for (const w of rb.def.w ?? []) this.mark(w, rb.scope);
  }

  // ---- lists and conditionals

  private keyOf(tdef: TemplateDef, item: unknown, scope: any): string {
    if (tdef.key != null) return 'k:' + String(this.fns[tdef.key]!(scope));
    if (tdef.keyFields && item && typeof item === 'object') {
      return 'r:' + tdef.keyFields.map((f) => String((item as Record<string, unknown>)[f])).join('\u001f');
    }
    if (item !== null && (typeof item === 'object' || typeof item === 'function')) {
      let id = this.identities.get(item as object);
      if (!id) { id = this.nextIdentity++; this.identities.set(item as object, id); }
      return 'o:' + id;
    }
    this.warn('a `data-sn-for` over primitive values needs `data-sn-key`');
    return 'p:' + typeof item + ':' + String(item);
  }

  private rowScope(parent: any, tdef: TemplateDef, item: unknown, index: number): any {
    const s = Object.create(parent);
    s[tdef.item!] = item;
    if (tdef.index) s[tdef.index] = index;
    s[tdef.ii!] = index;
    return s;
  }

  private reconcile(rb: RB, value: unknown): void {
    const ctl = rb.list!;
    const tdef = ctl.tdef;
    const items: unknown[] = value == null ? [] : Array.isArray(value) ? value : typeof value === 'object' && Symbol.iterator in (value as object) ? Array.from(value as Iterable<unknown>) : [];
    const old = ctl.insts;
    const byKey = new Map<string, Inst>();
    old.forEach((inst) => byKey.set(inst.key, inst));
    const parent = rb.el.parentNode!;
    const endRef = old.length ? lastNode(this, old[old.length - 1]!)?.nextSibling ?? null : rb.el.nextSibling;

    const next: Inst[] = [];
    const seen = new Set<string>();
    const oldIndex = new Map<Inst, number>();
    old.forEach((inst, i) => oldIndex.set(inst, i));
    items.forEach((item, i) => {
      const probe = this.rowScope(rb.scope, tdef, item, i);
      let key = this.keyOf(tdef, item, probe);
      if (seen.has(key)) {
        this.warn(`duplicate key in \`data-sn-for\`: ${key.slice(2)}`);
        let n = 1;
        while (seen.has(`${key}#${n}`)) n++;
        key = `${key}#${n}`;
      }
      seen.add(key);
      const reuse = byKey.get(key);
      if (reuse) {
        byKey.delete(key);
        if (reuse.item !== item || reuse.index !== i) {
          reuse.item = item;
          reuse.index = i;
          reuse.scope[tdef.item!] = item;
          if (tdef.index) reuse.scope[tdef.index] = i;
          reuse.scope[tdef.ii!] = i;
          reuse.force = true;
        }
        next.push(reuse);
      } else {
        next.push(this.createInst(rb, tdef, probe, key, item, i));
      }
    });
    for (const gone of byKey.values()) this.removeInst(gone);

    // move with a longest-increasing-subsequence pass over reused rows
    const seq = next.map((inst) => oldIndex.get(inst) ?? -1);
    const keep = lis(seq);
    let ref: Node | null = endRef;
    for (let i = next.length - 1; i >= 0; i--) {
      const inst = next[i]!;
      if (seq[i] === -1 || !keep.has(i)) {
        for (const n of allNodes(this, inst)) parent.insertBefore(n, ref);
      }
      ref = inst.nodes[0] ?? ref;
    }
    ctl.insts = next;
  }

  private createInst(rb: RB, tdef: TemplateDef, scope: any, key: string, item: unknown, index: number): Inst {
    const tpl = rb.el as HTMLTemplateElement;
    return this.instantiate(tpl, tdef, scope, key, item, index);
  }

  private instantiate(tpl: HTMLTemplateElement, tdef: TemplateDef, scope: any, key: string, item: unknown, index: number): Inst {
    const frag = tpl.content.cloneNode(true) as DocumentFragment;
    const nodes = Array.from(frag.childNodes);
    const els = tdef.nodes.map((nd) => {
      let n: Node | undefined = frag;
      for (const i of nd.path!) n = n?.childNodes[i];
      return n && (n as Element).localName === nd.tag ? (n as Element) : null;
    });
    const block: Block = { rbs: [] };
    this.bindNodes(tdef.nodes, els, scope, block);
    const inst: Inst = { nodes, block, scope, key, item, index, force: false };
    this.walk(block, true);
    return inst;
  }

  private removeInst(inst: Inst): void {
    for (const n of allNodes(this, inst)) n.parentNode?.removeChild(n);
    this.forget(inst.block);
  }

  private forget(block: Block): void {
    for (const rb of block.rbs) {
      this.deferred.delete(rb);
      this.selects.delete(rb);
      if (rb.list) for (const i of rb.list.insts) this.forget(i.block);
      if (rb.cond?.inst) this.forget(rb.cond.inst.block);
    }
  }

  private toggleIf(rb: RB, on: boolean): void {
    const c = rb.cond!;
    const want = on ? 'if' : c.elseEl ? 'else' : null;
    if (want === c.branch) return;
    if (c.inst) { this.removeInst(c.inst); c.inst = null; }
    c.branch = want;
    if (!want) return;
    const anchor = (want === 'if' ? rb.el : c.elseEl!) as HTMLTemplateElement;
    const tdef = this.ir.templates[want === 'if' ? rb.def.x! : this.elseTid(rb)]!;
    const inst = this.instantiate(anchor, tdef, Object.create(rb.scope), want, null, 0);
    const parent = anchor.parentNode!;
    const ref = anchor.nextSibling;
    for (const n of allNodes(this, inst)) parent.insertBefore(n, ref);
    c.inst = inst;
  }

  private elseTid(rb: RB): number {
    const list = rb.block === this.rootBlock ? this.ir.roots : this.ir.templates.find((t) => t.nodes.some((n) => n.b.includes(rb.def)))!.nodes;
    return list[rb.def.y!]!.b.find((b) => b.k === 'else')!.x!;
  }

  /** Nodes of an instance in document order, including rows of lists anchored at its top level. */
  instNodes(inst: Inst): Node[] {
    const out: Node[] = [];
    for (const n of inst.nodes) {
      out.push(n);
      const rb = this.anchors.get(n);
      if (!rb) continue;
      if (rb.list) for (const i of rb.list.insts) out.push(...this.instNodes(i));
      else if (rb.cond?.inst && (rb.cond.branch === 'if' ? rb.el : rb.cond.elseEl) === n) out.push(...this.instNodes(rb.cond.inst));
    }
    return out;
  }

  // ---- events

  private dispatch(e: Event): void {
    const target = e.target as Node | null;
    if (!target) return;
    if (e.type === 'toggle') {
      const d = target as HTMLDialogElement;
      if (d.localName === 'dialog' && (d.open || d.hasAttribute('open'))) this.openDialog(d);
    }
    const start = (target.nodeType === 1 ? target : target.parentElement) as Element | null;
    if (!start) return;
    // models update state before other handlers on the same event
    if (e.type === 'input' || e.type === 'change') {
      const rb = this.models.get(start);
      if (rb && (e.type === 'input') === TEXT_LIKE.has(rb.def.n!)) {
        const v = this.readModel(rb);
        if (v) this.setModel(rb, v.value);
      }
    }
    let el: Element | null = start;
    const stop = this.root.nodeType === 9 ? null : this.root;
    while (el) {
      const list = this.handlers.get(el)?.filter((rb) => rb.def.n === e.type);
      if (list && list.length) {
        for (const rb of list) {
          if (rb.def.x !== undefined) this.trigger(rb, e);
          else this.handle(rb, rb.def.f!, e, rb.def.w);
        }
        return;
      }
      if (el === stop) return;
      el = el.parentElement;
    }
  }

  private openDialog(d: Element): void {
    const rbs = [...this.deferred].filter((rb) => d.contains(rb.el));
    if (!rbs.length) return;
    this.current = [];
    this.flushing = true;
    try {
      for (const rb of rbs) {
        if (!this.deferred.has(rb)) continue;
        if (!this.process(rb, true)) continue;
        if (rb.list) for (const i of rb.list.insts) this.walk(i.block, true);
        else if (rb.cond?.inst) this.walk(rb.cond.inst.block, true);
      }
    } finally { this.flushing = false; }
    if (this.dirty.length) this.schedule();
  }

  /** Store and DOM functions available to handlers; writes go to the base. */
  storeFns(el: Element | null): Record<string, (...a: any[]) => unknown> {
    return {
      refresh: (name: string) => this.resource(name).refetch(),
      upsert: (name: string, item: any) => this.resource(name).upsert(item),
      patch: (name: string, key: any, fields: any) => this.resource(name).patch(key, fields),
      remove: (name: string, key: any) => this.resource(name).remove(key),
      page: (name: string, target: string | number) => {
        if (!this.ext.paginate) throw new Error('sinter: page() needs @tiaforge/sinter/paginate');
        this.ext.paginate.page(name, target);
      },
      close: () => { (el?.closest('dialog') as HTMLDialogElement | null)?.close(); },
      reset: () => this.resetForm(el),
      emit: (name: string, detail?: unknown) => { el?.dispatchEvent(new CustomEvent(name, { detail, bubbles: true })); },
    };
  }

  private resetForm(el: Element | null): void {
    const form = el?.closest('form');
    if (!form) return;
    form.reset();
    for (const c of Array.from(form.elements)) {
      const rb = this.models.get(c);
      if (rb) { const v = this.readModel(rb); if (v) this.setModel(rb, v.value); }
    }
  }

  /** Runs a handler expression and invalidates what it may have changed. */
  private handle(rb: RB, fn: number, e: Event | null, writes: string[] | undefined, extra?: Record<string, unknown>): void {
    const scope = Object.create(rb.scope);
    scope.$el = rb.el;
    scope.$event = e;
    scope.$f = this.storeFns(rb.el);
    if (extra) Object.assign(scope, extra);
    const urlBefore = writes?.some((w) => w.startsWith('$url')) ? JSON.stringify(this.page.$url) : null;
    try {
      this.fns[fn]!(scope);
    } catch (err) {
      console.error('sinter: handler threw', err);
    } finally {
      for (const w of writes ?? []) this.mark(w, scope);
      if (urlBefore !== null && urlBefore !== JSON.stringify(this.page.$url)) this.writeUrl();
    }
  }

  // ---- actions

  private actState(el: Element): ActState {
    let s = this.actStates.get(el);
    if (!s) { s = { pending: 0, queue: [], waiting: null, ctl: null, timer: null, disabled: null }; this.actStates.set(el, s); }
    return s;
  }

  private trigger(rb: RB, e: Event): void {
    const def = this.ir.actions[rb.def.x!]!;
    const el = rb.el;
    if (def.form && e.type === 'submit') e.preventDefault();
    else if (el.localName === 'a') e.preventDefault();
    else if ((el.localName === 'button' || el.localName === 'input') && el.closest('form') && e.type === 'click') e.preventDefault();
    if (def.debounce > 0) {
      const st = this.actState(el);
      if (st.timer != null) { this.env.clearTimeout(st.timer); this.busy--; }
      this.busy++;
      st.timer = this.env.setTimeout(() => { st.timer = null; this.busy--; this.fire(rb, def, e); }, def.debounce, 'debounce');
      return;
    }
    this.fire(rb, def, e);
  }

  private fire(rb: RB, def: ActionDef, e: Event): void {
    const st = this.actState(rb.el);
    if (def.method !== 'GET' && def.concurrency === 'block' && (st.pending > 0)) return;
    const scope = Object.create(rb.scope);
    scope.$el = rb.el;
    scope.$event = e;
    let url: string, body: unknown;
    try {
      url = this.url(def.url, scope);
      body = this.body(def, rb.el, scope);
    } catch (err) {
      this.unhandled(err instanceof SinterError ? err : new SinterError(0, null, (err as Error).message), rb.el);
      return;
    }
    let drop: (() => void) | null = null;
    const startLayer = () => {
      if (def.optimistic == null) return;
      if (!this.ext.optimistic) throw new Error('sinter: data-sn-optimistic needs @tiaforge/sinter/optimistic');
      drop = this.ext.optimistic.begin(def.optimistic, scope);
    };

    if (def.method === 'GET') {
      st.ctl?.abort();
      const ctl = new AbortController();
      st.ctl = ctl;
      startLayer();
      void this.send(rb, def, st, url, body, () => drop?.(), ctl);
      return;
    }
    startLayer();
    const run = () => this.send(rb, def, st, url, body, () => drop?.(), null);
    if (st.pending === 0) { void run(); return; }
    if (def.concurrency === 'latest') {
      st.waiting?.drop();
      if (!st.waiting) this.busy++;
      st.waiting = { run, drop: () => drop?.() };
    } else {
      this.busy++;
      st.queue.push(run);
    }
  }

  private body(def: ActionDef, el: Element, scope: any): unknown {
    if (def.body != null) return this.fns[def.body]!(scope);
    if (def.method === 'GET' || def.method === 'DELETE') return undefined;
    if (def.form) return serializeForm(el as HTMLFormElement);
    return undefined;
  }

  private async send(rb: RB, def: ActionDef, st: ActState, url: string, body: unknown, drop: () => void, ctl: AbortController | null): Promise<void> {
    const el = rb.el;
    st.pending++;
    el.setAttribute('aria-busy', 'true');
    if (def.form && def.concurrency === 'block' && def.method !== 'GET' && !st.disabled) {
      st.disabled = Array.from((el as HTMLFormElement).elements).filter((c) => !(c as HTMLInputElement).disabled);
      for (const c of st.disabled) (c as HTMLInputElement).disabled = true;
    }
    try {
      const result = await this.req.send(url, { method: def.method, body, ...(ctl ? { signal: ctl.signal } : {}) });
      if (ctl && st.ctl !== ctl) return;
      drop();
      if (def.then != null) this.handle(rb, def.then, null, def.w, { $result: result });
    } catch (err) {
      drop();
      if (isAbort(err) || (ctl && st.ctl !== ctl)) return;
      const error = err instanceof SinterError ? err : new SinterError(0, null, (err as Error)?.message ?? 'error');
      if (def.catch != null) this.handle(rb, def.catch, null, def.w, { $error: error });
      else this.unhandled(error, el);
    } finally {
      st.pending--;
      if (ctl && st.ctl === ctl) st.ctl = null;
      if (st.pending === 0) {
        if (st.disabled) { for (const c of st.disabled) (c as HTMLInputElement).disabled = false; st.disabled = null; }
        const next = st.queue.shift() ?? (st.waiting ? st.waiting.run : null);
        if (next) {
          if (!st.queue.length && st.waiting && next === st.waiting.run) st.waiting = null;
          this.busy--;
          void next();
        } else el.removeAttribute('aria-busy');
      }
    }
  }

  /** The unhandled-error path: `sn-error` event, then `onError`, then the dev console. */
  unhandled(error: SinterError, element: Element | null, resource?: string): void {
    const target = element ?? this.host;
    const detail: Record<string, unknown> = { error, element: target };
    if (resource) detail.resource = resource;
    const ev = new CustomEvent('sn-error', { detail, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
    if (config.onError) config.onError(error, target);
    if (this.dev) console.error(`sinter: unhandled error${resource ? ` loading \`${resource}\`` : ''}: ${error.message}`, error);
  }

  // ---- $url, $now

  private readUrl(): Record<string, string> {
    const obj: Record<string, string> = Object.create(null);
    for (const [k, v] of new URL(this.env.href()).searchParams) if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') obj[k] = v;
    return obj;
  }

  private refreshUrl(): void {
    const next = this.readUrl();
    const cur = this.page.$url;
    for (const k of Object.keys(cur)) delete cur[k];
    Object.assign(cur, next);
    this.mark('$url');
  }

  private writeUrl(): void {
    const u = new URL(this.env.href());
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(this.page.$url as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    this.env.replaceState(u.pathname + (qs ? `?${qs}` : '') + u.hash);
  }

  private tickNow(): void {
    const tick = () => {
      this.page.$now = new Date(this.env.now());
      this.mark('$now');
      handle = this.env.setTimeout(tick, 60_000, 'clock');
    };
    let handle = this.env.setTimeout(tick, 60_000, 'clock');
    this.cleanups.push(() => this.env.clearTimeout(handle));
  }
}

/** Loads one resource through the request layer: shared requests, latest wins. */
export class ResourceLoader {
  url: string | null = null;
  pager: Pager | null = null;
  private ctl: AbortController | null = null;
  private seq = 0;
  private refetching: Promise<void> | null = null;
  constructor(readonly app: App, readonly def: ResourceDef, readonly res: Resource) {
    if (def.paginate) {
      if (!app.ext.paginate) throw new Error('sinter: paginated resources need @tiaforge/sinter/paginate');
      this.pager = app.ext.paginate.pager(this);
    }
  }

  /** The resolved `src`, or null while `when` is falsy. */
  resolve(): string | null {
    const scope = this.evalScope();
    try {
      if (this.def.when != null && !this.app.fns[this.def.when]!(scope)) return null;
      return this.app.url(this.def.src, scope);
    } catch (e) {
      this.app.warn(`resource \`${this.def.name}\`: src could not be resolved: ${(e as Error).message}`);
      return null;
    }
  }

  evalScope(): any {
    return this.app.scopeFor(this.def.scope);
  }

  start(): void {
    const emb = this.app.embedded(this.def);
    const url = this.resolve();
    if (emb && url) {
      this.url = url;
      this.pager?.reset();
      this.store(emb.value);
      this.res.meta.loadedAt = this.app.env.now();
      return;
    }
    this.srcChanged();
  }

  /** `src` or `when` may have changed: reload from the first page if the URL differs. */
  srcChanged(): void {
    const url = this.resolve();
    if (url === this.url) return;
    this.url = url;
    this.pager?.reset();
    if (url === null) {
      this.abort();
      this.res.replace(this.res.isCollection ? [] : null);
      this.setLoading(false);
      return;
    }
    void this.load();
  }

  /** Repeats the current request; several calls in one task share one request. */
  refetch(): Promise<void> {
    if (this.refetching) return this.refetching;
    this.refetching = new Promise<void>((resolve) => this.app.env.queueMicrotask(resolve)).then(() => {
      this.refetching = null;
      return this.url === null ? undefined : this.load();
    });
    return this.refetching;
  }

  abort(): void {
    this.ctl?.abort();
    this.ctl = null;
  }

  /** Loads the current URL (with a page move's parameters) and replaces or appends to the base. */
  async load(move?: unknown): Promise<void> {
    if (this.url === null) return;
    this.abort();
    const ctl = new AbortController();
    this.ctl = ctl;
    const seq = ++this.seq;
    const m = this.pager ? (move ?? this.pager.current()) : null;
    const url = withParams(this.url, this.pager ? this.pager.params(m) : null);
    this.setLoading(true);
    try {
      const body = await this.app.loadShared(url, ctl.signal);
      if (seq !== this.seq) return;
      this.store(body, m);
      this.res.meta.error = null;
      this.res.meta.loadedAt = this.app.env.now();
    } catch (err) {
      if (seq !== this.seq || isAbort(err)) return;
      const error = err instanceof SinterError ? err : new SinterError(0, null, (err as Error)?.message ?? 'error');
      this.res.meta.error = { status: error.status, body: error.body, message: error.message };
      this.res.onDirty('meta');
      this.app.unhandled(error, null, this.def.name);
    } finally {
      if (seq === this.seq) { this.ctl = null; this.setLoading(false); }
    }
  }

  /** Writes a response body to the base. */
  store(body: unknown, move: unknown = this.pager?.current()): void {
    const { items, total } = this.extract(body);
    if (this.pager?.appends(move) && this.res.isCollection) {
      for (const it of items as object[]) this.res.upsert(it);
    } else this.res.replace(items as never);
    this.res.setTotal(total);
    this.pager?.received(items as unknown[], total, move);
  }

  private extract(body: unknown): { items: unknown; total: number | null } {
    let items = this.def.items ? pick(body, this.def.items) : body;
    if (this.res.isCollection && !Array.isArray(items)) {
      this.app.warn(`resource \`${this.def.name}\`: \`items\` path \`${this.def.items ?? '(response)'}\` is not an array`, items);
      items = [];
    }
    if (Array.isArray(items)) items = items.map((x) => clean(x));
    const t = this.def.total ? pick(body, this.def.total) : null;
    return { items, total: typeof t === 'number' ? t : t == null ? null : Number(t) };
  }

  private setLoading(on: boolean): void {
    if (this.res.meta.loading === on) return;
    this.res.meta.loading = on;
    this.res.onDirty('meta');
  }
}

/** Pagination state of one resource; a "move" is one page request, repeated exactly by refetch. */
export interface Pager {
  reset(): void;
  current(): unknown;
  params(move: unknown): Record<string, string> | null;
  appends(move: unknown): boolean;
  received(items: unknown[], total: number | null, move: unknown): void;
}

function pick(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function withParams(url: string, params: Record<string, string> | null): string {
  if (!params) return url;
  const [path, hash = ''] = url.split('#') as [string, string?];
  const [base, query = ''] = path.split('?') as [string, string?];
  const sp = new URLSearchParams(query);
  for (const [k, v] of Object.entries(params)) sp.set(k, v);
  const qs = sp.toString();
  return base + (qs ? `?${qs}` : '') + (hash ? `#${hash}` : '');
}

function lastNode(app: App, inst: Inst): Node | null {
  const all = app.instNodes(inst);
  return all[all.length - 1] ?? null;
}

function allNodes(app: App, inst: Inst): Node[] {
  return app.instNodes(inst);
}

/** Indexes (into `seq`) of a longest increasing subsequence, ignoring -1 entries. */
export function lis(seq: number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    const v = seq[i]!;
    if (v < 0) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]!]! < v) lo = m + 1; else hi = m; }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) { out.add(k); k = prev[k]!; }
  return out;
}

/** Serializes a form's named controls to nested JSON, or FormData if it has a file input. */
export function serializeForm(form: HTMLFormElement): unknown {
  const controls = Array.from(form.elements) as any[] as Array<HTMLInputElement & { selectedOptions: HTMLCollectionOf<HTMLOptionElement> }>;
  if (controls.some((c) => c.localName === 'input' && c.type === 'file')) return new FormData(form);
  const out: Record<string, unknown> = Object.create(null);
  const counts = new Map<string, number>();
  for (const c of controls) if (c.name && c.type === 'checkbox') counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  for (const c of controls) {
    if (!c.name || c.disabled) continue;
    const type = c.type;
    if (['submit', 'button', 'reset', 'image'].includes(type) || c.localName === 'button' || c.localName === 'fieldset' || c.localName === 'output') continue;
    let value: unknown;
    if (type === 'checkbox') {
      if ((counts.get(c.name) ?? 0) > 1) {
        const arr = (getPath(out, c.name) as unknown[] | undefined) ?? [];
        if (c.checked) arr.push(c.value);
        setPath(out, c.name, arr);
        continue;
      }
      value = c.checked;
    } else if (type === 'radio') {
      if (!c.checked) continue;
      value = c.value;
    } else if (type === 'number' || type === 'range') {
      value = c.value === '' ? null : Number(c.value);
    } else if (c.localName === 'select' && c.multiple) {
      value = Array.from(c.selectedOptions).map((o) => o.value);
    } else value = c.value;
    setPath(out, c.name, value);
  }
  return out;
}

const BAD = new Set(['__proto__', 'constructor', 'prototype']);

function segments(name: string): string[] {
  const out: string[] = [];
  name.replace(/([^.[\]]+)|\[(\d*)\]/g, (_m, a: string | undefined, b: string | undefined) => { out.push(a ?? b ?? ''); return ''; });
  return out;
}

function getPath(obj: Record<string, unknown>, name: string): unknown {
  let cur: unknown = obj;
  for (const s of segments(name)) { if (cur == null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[s]; }
  return cur;
}

function setPath(obj: Record<string, unknown>, name: string, value: unknown): void {
  const segs = segments(name);
  if (segs.some((s) => BAD.has(s))) return;
  let cur: Record<string, unknown> = obj;
  segs.forEach((s, i) => {
    if (i === segs.length - 1) { cur[s] = value; return; }
    if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = /^\d+$/.test(segs[i + 1]!) ? [] : Object.create(null);
    cur = cur[s] as Record<string, unknown>;
  });
}
