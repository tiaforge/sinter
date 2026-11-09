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

/** What the early file needs from the outside world: `configure({ env })` from the app's early module, else the browser. */
type EarlyEnv = Pick<Env, 'now' | 'href' | 'storage' | 'fetch'>;
const envOf = (): EarlyEnv => {
  const e = config.env, g = globalThis as typeof globalThis & Window;
  return { now: e?.now ?? Date.now, href: e?.href ?? (() => g.location.href), storage: e?.storage ?? (() => { try { return g.localStorage; } catch { return null; } }), fetch: e?.fetch ?? ((r) => fetch(r)) };
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
export type EarlyPage = () => { ir: Pick<EarlyIR, 'res' | 'path'>; fns: Fn[]; scopes(base: any): any[]; render(doc: Document, scopes: any[], base: any): void; locale?: typeof locale };

/** the configured locale source, for a page whose early functions read `$locale` (others carry no config) */
export const locale = () => config.locale;

/**
 * The early file's entry: renders the page's early part once the dictionary (if any) is there.
 * The early file is a deferred module: it runs after the parse, before the first paint (it blocks
 * rendering until it has run; a language file the picker added holds the paint until it is there).
 */
export function start(page: EarlyPage | null, messages: { use(): void; ready(): Promise<void> } | null, req: EarlyRequests | null = null, doc: Document = document): void {
  prime(page, messages, req, doc)();
}

/**
 * Starts the page's early requests at once and returns the render step. A page with early requests
 * loads its early file twice from one URL (the browser runs a module once): `async` before the
 * stylesheets, so the requests leave while they load (a deferred script waits for every
 * stylesheet), and as the render-blocking deferred stub that imports it and calls the render step
 * after the parse. Without early requests, `start` does both at once in the deferred file.
 */
export function prime(page: EarlyPage | null, messages: { use(): void; ready(): Promise<void> } | null, req: EarlyRequests | null = null, doc: Document = document): () => void {
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

/** The base scope: what is not available before data throws, and the binding (or request) is left to the page module. */
function scope(o: ReturnType<EarlyPage>, req: EarlyRequests | null): any {
  return new Proxy(Object.create(null), {
    get(_, k) {
      // `$locale`: `configure({ locale })` from the app's early module, on pages whose early functions read it
      const l = k == '$locale' ? o.locale?.() : null;
      if (l) return l.get();
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

/** `params`: adds a paginated resource's first-page parameters (`withParams`, imported only by a page that has one) */
export function requests(params?: typeof withParams): EarlyRequests {
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
  prepare(page, requests()).render(doc);
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
  try { v = f(s); } catch { return; }
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
  if (v == null || v === false || urlAllowed(el, n, v === true ? '' : '' + v, el.baseURI, schemesOf(config.urlSchemes))) set(el, v, n);
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
