// @tiaforge-ui/sinter/early: what a page's early file runs before the first paint. It starts the
// requests of the resources whose URL is known before any data (the page module's request layer
// takes the responses), and renders, once, the bindings the compiler found renderable before any data: page-level values from state
// (persisted values read from storage) and helpers, and the branch of each such `data-sn-if`.
// No reactivity: the page module mounts later and takes the rendered DOM over (an early branch is
// adopted, not rendered again). The early file and the page bundle are bundled apart (they share
// one chunk, `runtime/security` and `url`, and hold copies of the rest), so what they
// share goes through a global: `start` (early file) and `rendered` (page module, from the core) meet there.
import { config } from './runtime/config.js';
import type { Env } from './runtime/env.js';
import { meeting, prefetched, setPrefetched, type Prefetched } from './runtime/handoff.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './runtime/security.js';
import { expand, readUrl, type withParams } from './runtime/url.js';
import type { EarlyIR } from './ir.js';

/** What the early requests read from the outside world: the clock, the location, fetch. */
type EarlyEnv = Pick<Env, 'now' | 'href' | 'fetch'>;
/** the browser's: before the first paint only an app early module could have configured another */
const browser = (): EarlyEnv => ({ now: Date.now, href: () => location.href, fetch: (r) => fetch(r) });
/**
 * `configure({ env })`, else the browser: for a page whose app has an early module (the compiler
 * passes it to `requests`), and for tests; only then does the early file carry the config.
 */
export const configured = (): EarlyEnv => {
  const e = config.env;
  return { now: e?.now ?? Date.now, href: e?.href ?? (() => location.href), fetch: e?.fetch ?? ((r) => fetch(r)) };
};

export { $k } from './runtime/keys.js';
/** for a page whose early requests include a paginated resource's first page (the compiler passes it to `requests`) */
export { withParams } from './runtime/url.js';

/** On a `data-sn-if` template the early chunk rendered: the branch, its nodes and end marker, for the runtime to adopt. */
export const EARLY = Symbol.for('sinter.early');
export interface EarlyBranch { br: number; nodes: Node[]; end: Comment }

type Fn = (...a: any[]) => any;

/**
 * The page's early part, built when the early file starts: the early requests (`ir.res`), the
 * function table, and its compiled renderer (compiler/early-render.ts): `scopes` over the base
 * scope, then `render` with them.
 */
export type EarlyPage = () => { ir: Pick<EarlyIR, 'res' | 'path' | 'emb'>; fns: Fn[]; scopes(base: any): any[]; render(doc: Document, scopes: any[], base: any): void; locale?: typeof locale };

/** the configured locale source, for a page whose early functions read `$locale` (others carry no config) */
export const locale = () => config.locale;

/**
 * The dev server's early module (builds use `observe`): renders the page's early part once the
 * dictionary (if any) is there. A deferred, render-blocking module: it runs after the parse, and
 * the first paint waits for it where the browser supports `blocking` (dev only; Firefox paints first).
 */
export function start(page: EarlyPage | null, messages: { use(): void; ready(): Promise<void> } | null, req: EarlyRequests | null = null, doc: Document = document): void {
  prime(page, messages, req, doc)();
}

/** Starts the page's early requests at once and returns the render step. */
function prime(page: EarlyPage | null, messages: { use(): void; ready(): Promise<void> } | null, req: EarlyRequests | null = null, doc: Document = document): () => void {
  messages?.use();
  let p: ReturnType<typeof prepare> | null = null;
  // the requests need no DOM: they start before anything waits
  try { if (page) (p = prepare(page(), req)).fetch(); } catch (e) { fail(e); }
  let ran = false;
  return () => {
    if (ran) return;
    ran = true;
    // started only now: a render stub that failed to load leaves the page module to mount by itself
    const m = meeting();
    m.started = true;
    void (async () => {
      await messages?.ready();
      // a failure is reported, and the page module mounts all the same
      try { p?.render(doc); } catch (e) { fail(e); }
      m.finish();
    })();
  };
}

/**
 * The early file's entry for a page without early requests or messages: renders at once (the early
 * file is a deferred module, run after the parse and before the first paint), and tells the page module.
 */
export function run(page: EarlyPage, doc: Document = document): void {
  const m = meeting();
  m.started = true;
  // a failure is reported, and the page module mounts all the same
  try { const p = page(), $ = scope(p, null); p.render(doc, p.scopes($), $); } catch (e) { fail(e); }
  m.finish();
}

const fail = (e: unknown) => { setTimeout(() => { throw e; }); };

/**
 * The early script's entry in builds: a classic script in the head, run while the head is parsed,
 * before any of the body exists. It starts the early requests at once
 * and renders each early root as the parser closes it, from a MutationObserver: its callback is a
 * microtask at the end of the parser's task, so it runs before the browser can paint that element,
 * in every browser and with no `blocking` attribute. Nothing waits for the network: a message
 * binding whose dictionary has not arrived is skipped (the language file is loaded without holding
 * the paint) and tried again if it arrives before the parse ends; else the page module renders it.
 * At DOMContentLoaded a last pass renders what is left, and the page module may mount. Each pass
 * looks only at the elements the parser has added since: no query over the whole document.
 */
export function observe(page: EarlyPage | null, messages: { use(): void; state?(): I18nLike } | null = null, req: EarlyRequests | null = null, doc: Document = document): void {
  messages?.use();
  const m = meeting();
  m.started = true;
  let p: ReturnType<typeof prepare> | null = null;
  try { if (page) (p = prepare(page(), req)).fetch(); } catch (e) { fail(e); }
  if (!p) { m.finish(); return; }
  const prep = p, I = messages?.state?.();
  const waiting = () => !!I?.locale && !I.dicts?.[I.locale];
  /** the roots seen and not rendered yet; `pick`: rendered in this pass, by `data-sn` id */
  const pending = new Set<Element>();
  const add = (n: Node) => {
    if (n.nodeType != 1) return;
    if ((n as Element).hasAttribute('data-sn')) pending.add(n as Element);
    // a node inserted with children (a parser chunk, or a branch clone): its roots too
    if ((n as Element).firstElementChild) for (const el of (n as Element).querySelectorAll('[data-sn]')) pending.add(el);
  };
  const pass = (all: boolean) => {
    const pick = new Map<number, Element>();
    for (const el of pending) if (all || ready(el)) { pending.delete(el); pick.set(+el.getAttribute('data-sn')!, el); }
    if (!pick.size) return;
    live = pick;
    // a missing dictionary: `m` throws (its lookup reads this), so those bindings are left for later
    const trap = waiting() && I!.dicts ? (I!.dicts[I!.locale!] = new Proxy({}, { get() { throw NOT_YET; } })) : null;
    try { prep.render(doc); } catch (e) { fail(e); }
    if (trap && I!.dicts![I!.locale!] === trap) delete I!.dicts![I!.locale!];
    live = null;
  };
  let ended = false;
  const seen = (rs: MutationRecord[]) => { for (const r of rs) for (const n of r.addedNodes) add(n); };
  const o = new MutationObserver((rs) => { if (ended) return; seen(rs); pass(false); });
  // what is parsed already (`<html>`, the head so far)
  for (const el of doc.querySelectorAll('[data-sn]')) pending.add(el);
  o.observe(doc.documentElement, { childList: true, subtree: true });
  pass(false);
  if (I && waiting()) {
    const prev = I.loaded;
    I.loaded = (l) => { prev?.(l); if (!ended && retries.length) { const r = retries.splice(0); for (const f of r) f(); } };
  }
  const end = () => {
    if (ended) return;
    seen(o.takeRecords());
    o.disconnect();
    pass(true);
    ended = true;
    retries.length = 0;
    m.finish();
  };
  if (doc.readyState != 'loading') end(); else doc.addEventListener('DOMContentLoaded', end, { once: true });
}

const NOT_YET = Symbol('not yet');
/** what `observe` reads of the messages' shared state (messages.ts) */
interface I18nLike { locale?: string; dicts?: Record<string, unknown>; loaded?: (l: string) => void }
/** during an observing pass: the roots it renders, by `data-sn` id */
let live: Map<number, Element> | null = null;
/** the bindings skipped for a missing dictionary, tried again when it arrives */
const retries: Array<() => void> = [];

/** whether the parser has moved past `el`: it, or an ancestor, has a following node */
const closed = (el: Node) => {
  for (let n: Node | null = el; n && n.nodeType == 1; n = n.parentNode) if (n.nextSibling) return true;
  return false;
};
/**
 * A root to render now: closed, and the `data-sn-else` template that follows an `if` parsed too.
 * `<html>` and `<body>` at once: their attributes are all there when they are created, and no early
 * binding writes their content.
 */
const ready = (el: Element) => {
  if (el.localName == 'html' || el.localName == 'body') return true;
  const e = el.localName == 'template' ? el.nextElementSibling : null;
  return closed(el) && (!e || !e.hasAttribute('data-sn-else') || closed(e));
};

/** `$r` over the page's embedded data: each resource's items (by its `items` path), parsed once; another resource throws */
function embedded(emb: NonNullable<EarlyIR['emb']>): any {
  const got = new Map<string, unknown>();
  return new Proxy(Object.create(null), {
    get(_, name) {
      const e = typeof name == 'string' ? emb[name] : undefined;
      if (!e) throw Error('sinter: not available early');
      if (!got.has(name as string)) {
        const el = document.querySelector(`head > script[data-sn="${e.id}"]`);
        let v: any = JSON.parse(el!.textContent!);
        for (const k of e.items ? e.items.split('.') : []) v = v?.[k];
        got.set(name as string, v);
      }
      return got.get(name as string);
    },
  });
}

/** The base scope: what is not available before data throws, and the binding (or request) is left to the page module. */
function scope(o: ReturnType<EarlyPage>, req: EarlyRequests | null): any {
  let emb: any = null, url: any = null;
  return new Proxy(Object.create(null), {
    get(_, k) {
      // `$locale`: `configure({ locale })` from the app's early module, on pages whose early functions read it
      const l = k == '$locale' ? o.locale?.() : null;
      if (l) return l.get();
      // the resources whose data is embedded in the page: read from it (the head is parsed before any binding)
      if (k == '$r' && o.ir.emb) return (emb ??= embedded(o.ir.emb));
      // bindings over embedded data may read the URL (a page without early requests: read here)
      if (k == '$url' && o.ir.emb && !req) return (url ??= readUrl(location.href, o.ir.path));
      // for requests only: no early binding reads the clock or the URL
      if (req) return req.read(k, o.ir.path);
      throw Error('sinter: not available early');
    },
  });
}

/**
 * The early requests: the compiler has the early file import this only when the page has resources
 * to request early, so a page without them carries none of it (nor the URL templates). `read`: what
 * only requests may read (`$now`, `$url`); `send`: starts the requests whose URL is known.
 */
export interface EarlyRequests {
  read(key: PropertyKey, path: string[] | undefined): unknown;
  send(ir: Pick<EarlyIR, 'res'>, scopes: any[], base: any, fns: Fn[]): void;
}

/**
 * `params`: adds a paginated resource's first-page parameters (`withParams`, imported only by a page
 * that has one); `envOf`: where the environment comes from (`configured` where an app early module may set it)
 */
export function requests(params?: typeof withParams, envOf: () => EarlyEnv = browser): EarlyRequests {
  let url: Record<string, string> | null = null, now: Date | null = null, e: EarlyEnv | null = null;
  // the environment only requests read (the clock, the location, fetch): read when first needed, after the app's early module ran
  const env = () => (e ??= envOf());
  return {
    read(k, path) {
      if (k == '$now') return (now ??= new Date(env().now()));
      if (k == '$url') return (url ??= readUrl(env().href(), path));
      throw Error('sinter: not available early');
    },
    /** the resources whose URL is known now: `when` holds and every value is there (a paginated one: its first page) */
    send(ir, scopes, base, fns) {
      const here = env().href();
      for (const r of ir.res ?? []) {
        try {
          const s = r.scope < 0 ? base : scopes[r.scope];
          if (r.when != null && !fns[r.when]!(s)) continue;
          const t = expand(r.src, s, fns), u = new URL(r.q ? params!(t, r.q) : t, here);
          // another origin only when the build found it in `sinter({ origins })` (`xo`)
          if (r.xo || u.origin == new URL(here).origin) (prefetched() ?? own(pending(env()))).add(u.href, r.lo);
        } catch { /* not known early: the page module requests it */ }
      }
    },
  };
}

/**
 * The resource requests the early file started, by URL: each sent as the request layer sends a GET
 * with no middleware (Accept JSON, same-origin credentials), taken once by a request that is the
 * same at the end of the middleware chain.
 */
function pending(env: EarlyEnv): Prefetched {
  const started = new Map<string, { res: Promise<Response>; c: AbortController }>();
  return {
    add(url: string, lo?: 1) {
      if (started.has(url)) return;
      const c = new AbortController(), res = env.fetch(new Request(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: c.signal, ...(lo ? { priority: 'low' } : {}) } as RequestInit));
      res.catch(() => {});
      started.set(url, { res, c });
    },
    take(req: Request, signal: AbortSignal) {
      const e = started.get(req.url), h = [...req.headers];
      // a middleware that changed the request (a header, credentials) gets a request of its own
      if (!e || req.method != 'GET' || req.credentials != 'same-origin' || h.length != 1 || h[0]![0].toLowerCase() != 'accept' || h[0]![1] != 'application/json') return null;
      started.delete(req.url);
      const abort = () => e.c.abort(signal.reason);
      signal.aborted ? abort() : signal.addEventListener('abort', abort, { once: true });
      return e.res;
    },
    sweep() {
      for (const e of started.values()) e.c.abort();
      started.clear();
    },
  };
}

const own = (s: Prefetched) => (setPrefetched(s), s);

/** Renders a page's early part (tests; the early file goes through `start`). */
export function early(doc: Document, page: ReturnType<EarlyPage>): void {
  prepare(page, requests(undefined, configured)).render(doc);
}

function prepare(o: ReturnType<EarlyPage>, req: EarlyRequests | null) {
  const { ir, fns } = o, base = scope(o, req), roots = o.scopes(base);
  return {
    fetch() { req?.send(ir, roots, base, fns); },
    render(doc: Document) { o.render(doc, roots, base); },
  };
}

// ---- what the compiled renderer calls (compiler/early-render.ts); a page's early file bundles only those it uses

/** a persisted value (`sn:<key>`), parsed; undefined when there is none or it cannot be read */
const read = (key: string): unknown => {
  try {
    const v = (config.env?.storage ? config.env.storage() : globalThis.localStorage)?.getItem('sn:' + key);
    return v == null ? undefined : JSON.parse(v);
  } catch { return undefined; }
};

/** a state scope over `s`: the state's fields */
export function st(s: any, init: Fn, sid: number, obj?: any): any {
  if (!obj) try { obj = init(s); } catch { obj = {}; /* a field that throws: none known */ }
  return Object.assign(Object.create(s), { ['$s' + sid]: obj });
}

/** a persisted state's scope: its fields, the stored values applied (as the persist feature does at mount) */
export function sp(s: any, init: Fn, sid: number, persist: string): any {
  let obj: any = {};
  try { obj = init(s); } catch { /* a field that throws: none known */ }
  const v = read(persist);
  if (v && typeof v == 'object') for (const k of Object.keys(obj)) if (Object.hasOwn(v, k)) obj[k] = (v as any)[k];
  return st(s, init, sid, obj);
}

/** a persisted model's stored value, set through its setter before anything is written */
export function pm(s: any, key: string, set: Fn): void {
  const v = read(key);
  if (v !== undefined) try { set(s, v); } catch { /* ignored */ }
}

/** the root elements by `data-sn` id, in the order given */
export function byId(doc: Document, ids: Array<number | undefined>): Array<Element | null> {
  // observing: the roots of this pass, each once, when the parser has closed it
  if (live) { const l = live; return ids.map((i) => l.get(i!) ?? null); }
  const m = new Map<number, Element>();
  for (const el of doc.querySelectorAll('[data-sn]')) m.set(+el.getAttribute('data-sn')!, el);
  return ids.map((i) => m.get(i!) ?? null);
}

/** a branch's element: the runtime's path walk (path[0] a node of the clone, the rest descend), checked against its tag */
export function at(nodes: Node[], path: number[], tag: string): Element | null {
  let n: Node | null = nodes[path[0]!] ?? null;
  for (let k = 1; k < path.length && n; k++) {
    n = n.firstChild;
    for (let c = path[k]!; c-- && n;) n = n.nextSibling;
  }
  return n && (n as Element).localName == tag ? n as Element : null;
}

/** one binding's first write: its value in `s` (one that throws is the page module's), written by `wr` */
export function w(el: Element | null, f: Fn, s: any, wr: (el: any, v: any, n: string) => void, n = ''): void {
  if (!el) return;
  let v: any;
  try { v = f(s); } catch (e) {
    // a message whose dictionary is on its way: tried again when it arrives (observe)
    if (e === NOT_YET) retries.push(() => w(el, f, s, wr, n));
    return;
  }
  wr(el, v, n);
}

/**
 * A `data-sn-if`: the branch to show (1 its own, 2 the `data-sn-else` template `other`), cloned after
 * the template and left on it for the runtime to adopt; `a`/`b` render the branch's bindings over its nodes.
 */
export function iff(tpl: HTMLTemplateElement, v: unknown, other: HTMLTemplateElement | null, a: Branch | 0, b: Branch | 0, s: any): void {
  const br = v ? 1 : other ? 2 : 0;
  if (!br) return;
  const frag = (br == 1 ? tpl : other!).content.cloneNode(true) as DocumentFragment, nodes = [...frag.childNodes];
  const end = new Comment();
  tpl.after(end);
  end.before(...nodes);
  (tpl as any)[EARLY] = { br, nodes, end } satisfies EarlyBranch;
  const r = br == 1 ? a : b;
  if (r) r(nodes, Object.create(s));
}
type Branch = (nodes: Node[], s: any) => void;

/** set on a `data-sn-for` template whose rows `each` rendered: each row's nodes and the end marker, for the page module to adopt */
export const EARLY_ROWS = Symbol.for('sinter.early.rows');
export interface EarlyRows { rows: Node[][]; end: Comment }

/**
 * A `data-sn-for` over embedded data: a clone of the template per item, after it, each rendered by `r` over a scope
 * with the loop variable (and index). The rows are left on the template: the page module adopts them (binds them
 * instead of new clones) when its list has the same number of items, else removes them.
 */
export function each(tpl: HTMLTemplateElement, list: unknown, r: Branch | 0, item: string, index: string | null, s: any): void {
  if (!Array.isArray(list) || !list.length) return;
  const end = new Comment(), rows: Node[][] = [];
  tpl.after(end);
  list.forEach((v, i) => {
    const nodes = [...(tpl.content.cloneNode(true) as DocumentFragment).childNodes];
    end.before(...nodes);
    rows.push(nodes);
    if (r) { const sc = Object.create(s); sc[item] = v; if (index) sc[index] = i; r(nodes, sc); }
  });
  (tpl as any)[EARLY_ROWS] = { rows, end } satisfies EarlyRows;
}

// the writers, as the runtime's first write
export const text = (el: HTMLElement, v: any) => { el.textContent = '' + (v ?? ''); };
export const show = (el: HTMLElement, v: any) => { el.hidden = !v; };
export const cls = (el: HTMLElement, v: any, n: string) => { if (v || el.hasAttribute('class')) el.classList.toggle(n, !!v); };
/** a class binding without a name: `[name, on]` */
export const pair = (el: HTMLElement, v: any) => { if (v?.[0]) el.classList.toggle(v[0], !!v[1]); };
/** an attribute the compiler found needs no URL check: not a URL attribute, or a value whose scheme is fixed (`'/a/' + x`) */
export const set = (el: HTMLElement, v: any, n: string) => {
  if (/^(checked|selected|indeterminate|value)$/.test(n) && n in el) (el as any)[n] = n == 'value' ? (v == null || v === false || v === true ? '' : v) : v != null && v !== false;
  if (v == null || v === false) el.removeAttribute(n);
  else el.setAttribute(n, v === true ? '' : '' + v);
};
/** a URL attribute whose value may have any scheme: written only if the scheme is allowed */
export const attr = (el: HTMLElement, v: any, n: string) => {
  if (v == null || v === false || urlAllowed(el, n, v === true ? '' : '' + v, document.baseURI, schemesOf(config.urlSchemes))) set(el, v, n);
};
export const style = (el: HTMLElement, v: any, n: string) => {
  if (v == null || v === false) el.style.removeProperty(n);
  else if (!STYLE_BAD.test(v)) el.style.setProperty(n, v);
};
export const model = (el: HTMLInputElement & HTMLSelectElement, v: any, n: string) => {
  const has = (x: string) => Array.isArray(v) && v.map(String).includes(x);
  if (n == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
  else if (n == 'radio') el.checked = v != null && '' + v == el.value;
  else if (n == 'multi') for (const opt of el.options) opt.selected = has(opt.value);
  else if (el.value != (v ?? '')) el.value = v ?? '';
};
