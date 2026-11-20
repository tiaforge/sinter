// @tiaforge-ui/sinter/runtime/early: what a page's early file runs before the first paint. It starts the
// requests of the resources whose URL is known before any data (the page module's request layer
// takes the responses), and renders, once, the bindings the compiler found renderable before any data: page-level values from state
// (persisted values read from storage) and helpers, and the branch of each such `data-sn-if`.
// No reactivity: the page module mounts later and takes the rendered DOM over (an early branch is
// adopted, not rendered again). The early file and the page bundle are bundled apart (they share
// one chunk, `runtime/security` and `url`, and hold copies of the rest), so what they
// share goes through a global: `start` (early file) and `rendered` (page module, from the core) meet there.
import { config, signInTarget } from './runtime/config.js';
import type { Env } from './runtime/env.js';
import { meeting, prefetched, setPrefetched, type EarlyApi, type Prefetched } from './runtime/handoff.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './runtime/security.js';
import { expand, readUrl, type withParams } from './runtime/url.js';
import type { lists } from './runtime/lists.js';

export { lists } from './runtime/lists.js';
import { toPage } from './runtime/pages.js';
import type { EarlyIR } from './ir.js';

/** What the early requests read from the outside world: the clock, the location, fetch. */
type EarlyEnv = Pick<Env, 'now' | 'href' | 'fetch'>;
/** the browser's: before the first paint only an app early module could have configured another */
const browser = (): EarlyEnv => ({ now: Date.now, href: () => location.href, fetch: (r) => fetch(r) });
/**
 * `setEnv()` (tests), else the browser: for a page whose app has an early module (the compiler
 * passes it to `requests`), and for tests; only then does the early file carry the config.
 */
export const configured = (): EarlyEnv => {
  const e = config.env;
  return { now: e?.now ?? Date.now, href: e?.href ?? (() => location.href), fetch: e?.fetch ?? ((r) => fetch(r)) };
};

export { $k } from './runtime/keys.js';
/** for a page whose early requests include a paginated resource's first page (the compiler passes it to `requests`) */
export { withParams } from './runtime/url.js';
/** a link's URL template (`data-sn-href`) the early bindings fill */
export { $href, $hv } from './runtime/url.js';

/** On the start comment of a `data-sn-if` (or a choice) the early chunk rendered: the branch, its nodes and the end comment, for the runtime to adopt. */
export const EARLY = Symbol.for('sinter.early');
export interface EarlyBranch { br: number; nodes: Node[]; end: Comment }

/** an anchor's start comment, exactly: `<!--sn 4-->` at the page's top level, `<!--sn-->` in a row (`<!--snippet-->` is not) */
const isStart = (n: Node | null) => n?.nodeType == 8 && /^sn(?: \d+)?$/.test((n as Comment).data);
/** a root's id: a `data-sn` element's, a root anchor's (`<!--sn 4-->`); null for any other node */
const idOf = (n: Node) => (n.nodeType == 1
  ? (n as Element).hasAttribute('data-sn') ? +(n as Element).getAttribute('data-sn')! : null
  : n.nodeType == 8 && (n as Comment).data.length > 3 && isStart(n) ? +(n as Comment).data.slice(3) : null);
/** an anchor's end comment: the first `<!--/sn-->` after its start that closes no anchor nested in between (null: not parsed yet) */
const endOf = (start: Node): Comment | null => {
  let d = 0;
  for (let n = start.nextSibling; n; n = n.nextSibling) if (n.nodeType == 8) {
    const t = (n as Comment).data;
    if (t == '/sn') { if (!d--) return n as Comment; } else if (isStart(n)) d++;
  }
  return null;
};
/** the page's roots: `data-sn` elements and anchors' start comments, under `top`, by id */
const rootsIn = (top: Node, f: (id: number, n: Node) => void) => {
  const tw = (top.ownerDocument ?? (top as Document)).createTreeWalker(top, 129 /* SHOW_ELEMENT | SHOW_COMMENT */);
  for (let n: Node | null = tw.currentNode; n; n = tw.nextNode()) {
    const id = idOf(n);
    if (id != null) f(id, n);
  }
};
/**
 * A head template's nodes, cloned: `<template id="sn-t-<id>">`; a negative `id` (`-1 - id`) is one
 * inside `<svg>` or `<math>`, whose head template holds that element: its children are the row
 */
const tplOf = (id: number) => document.getElementById('sn-t-' + (id < 0 ? -1 - id : id)) as HTMLTemplateElement | null;
const cloneOf = (id: number): Node[] => {
  const t = tplOf(id)!;
  return [...((id < 0 ? t.content.firstChild! : t.content).cloneNode(true) as ParentNode).childNodes];
};
/**
 * What an anchor's writer returns while one of its templates is not parsed yet: an anchor in the head comes
 * before the head templates, which are last in the head. The observer tries it again in a later pass.
 */
const WAIT = Symbol('wait');

type Fn = (...a: any[]) => any;

/**
 * The page's early part, built when the early file starts: the early requests (`ir.res`), the
 * function table, and its compiled renderer (compiler/early-render.ts): `scopes` over the base
 * scope, then `render` with them.
 */
export type EarlyPage = () => { ir: Pick<EarlyIR, 'res' | 'path' | 'urlArrays' | 'emb' | 'si'>; fns: Fn[]; scopes(base: any): any[]; render(doc: Document, scopes: any[], base: any): void; locale?: typeof locale; lists?: typeof lists };

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
  let p: ReturnType<typeof prepare> = null, gone = false;
  // the requests need no DOM: they start before anything waits
  try { if (page) { p = prepare(page(), req); gone = !p; p?.fetch(); } } catch (e) { fail(e); }
  let ran = false;
  return () => {
    // sent to sign in: the page module does not mount
    if (ran || gone) return;
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
  try { const p = page(), $ = scope(p, null); if (away(p, $)) return; p.render(doc, p.scopes($), $); } catch (e) { fail(e); }
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
  let p: ReturnType<typeof prepare> = null, gone = false;
  try { if (page) { p = prepare(page(), req); gone = !p; p?.fetch(); } } catch (e) { fail(e); }
  // sent to sign in: the page module does not mount
  if (gone) return;
  if (!p) { m.finish(); return; }
  const prep = p, I = messages?.state?.();
  const waiting = () => !!I?.locale && !I.dicts?.[I.locale];
  /** every root seen, by id: `data-sn` elements and anchors' start comments; `fresh`: any since the last pass */
  const roots = new Map<number, Node>();
  let fresh = false, held = 0;
  const root = (id: number, n: Node) => { roots.set(id, n); fresh = true; };
  const add = (n: Node) => {
    // a node inserted with children (a parser chunk, or a branch clone): it and its roots; else it, if it is one
    // (an element, or an anchor's start comment: the parser adds comments too, one more check per node)
    if (n.firstChild) rootsIn(n, root);
    else { const id = idOf(n); if (id != null) root(id, n); }
  };
  const pass = (all: boolean) => {
    // every root seen so far: its attribute-like bindings are written at once (its attributes are all there when the
    // parser inserts it), its content bindings once the parser has closed it (`w`, each binding once). A pass runs
    // when roots were added or a content binding is still waiting
    if (!all && !fresh && !held) return;
    fresh = false;
    live = { pick: roots, all, waiting: new Set() };
    const cur = live;
    // a missing dictionary: `m` throws (its lookup reads this), so those bindings are left for later
    const trap = waiting() && I!.dicts ? (I!.dicts[I!.locale!] = new Proxy({}, { get() { throw NOT_YET; } })) : null;
    try { prep.render(doc); } catch (e) { fail(e); }
    if (trap && I!.dicts![I!.locale!] === trap) delete I!.dicts![I!.locale!];
    live = null;
    held = cur.waiting.size;
  };
  let ended = false;
  const seen = (rs: MutationRecord[]) => { for (const r of rs) for (const n of r.addedNodes) add(n); };
  const o = new MutationObserver((rs) => { if (ended) return; seen(rs); pass(false); });
  // what is parsed already (`<html>`, the head so far: its anchors too)
  rootsIn(doc.documentElement, root);
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
/** during an observing pass: the roots it renders, by id */
let live: { pick: Map<number, Node>; all: boolean; waiting: Set<Node> } | null = null;
/** observing: the bindings already written, by node (a root whose content waits is rendered again by later passes) */
const wrote = new WeakMap<Node, Set<string>>();
let fnIds = new WeakMap<Fn, number>(), fnN = 0;
/** a content binding (text, a control's value, an anchor) waits for the parser to close its element, or to parse the anchor's end */
const content = (el: Node, wr: unknown) => el.nodeType == 8 || wr === text || wr === model || !!(wr as { c?: 1 }).c;
/** the bindings skipped for a missing dictionary, tried again when it arrives */
const retries: Array<() => void> = [];

/** whether the parser has moved past `el`: it, or an ancestor, has a following node */
const closed = (el: Node): boolean => {
  for (let n: Node | null = el; n && n.nodeType == 1; n = n.parentNode) if (n.nextSibling) return true;
  return false;
};
/**
 * A root to render now: an element closed, an anchor whose end comment is parsed. `<html>` and
 * `<body>` at once: their attributes are all there when they are created, and no early binding
 * writes their content.
 */
const ready = (el: Node) => {
  if (el.nodeType == 8) return !!endOf(el);
  const n = (el as Element).localName;
  return n == 'html' || n == 'body' || closed(el);
};

/** the JSON of the head's embedded data element `data-sn="<id>"`, parsed */
const json = (id: number) => JSON.parse(document.querySelector(`head > script[data-sn="${id}"]`)!.textContent!);

/** `$r` over the page's embedded data: each resource's data (by its `select` path), parsed once; another resource throws */
function embedded(emb: NonNullable<EarlyIR['emb']>): any {
  const got = new Map<string, unknown>();
  return new Proxy(Object.create(null), {
    get(_, name) {
      const e = typeof name == 'string' ? emb[name] : undefined;
      if (!e) throw Error('sinter: not available early');
      if (!got.has(name as string)) {
        let v: any = json(e.id);
        for (const k of e.select ? e.select.split('.') : []) v = v?.[k];
        // a list without `key` (`ls`) is `[]` when empty, as in the page module
        got.set(name as string, v ?? (e.ls ? [] : v));
      }
      return got.get(name as string);
    },
  });
}

/** The base scope: what is not available before data throws, and the binding (or request) is left to the page module. */
function scope(o: ReturnType<EarlyPage>, req: EarlyRequests | null): any {
  let emb: any = null, url: any = null;
  // array parameters as lists: only a page that has them passes `lists` (and carries it)
  const more = (h: string, u: any) => (o.lists ? o.lists(h, o.ir.urlArrays!, u) : u);
  return new Proxy(Object.create(null), {
    get(_, k) {
      // a state field the build computed, embedded in the head (parsed when the early script runs: the head is there)
      if (k == '$d') return json;
      // `$locale`: `configure({ locale })` from the app's early module, on pages whose early functions read it
      const l = k == '$locale' ? o.locale?.() : null;
      if (l) return l.get();
      // the resources whose data is embedded in the page: read from it (the head is parsed before any binding)
      if (k == '$r' && o.ir.emb) return (emb ??= embedded(o.ir.emb));
      // the URL, as the page module reads it (a page with early requests reads it there, once for both)
      if (k == '$url' && !req) return (url ??= more(location.href, readUrl(location.href, o.ir.path)));
      // the clock is for requests only: no early binding reads it
      if (req) return req.read(k, o.ir.path, more);
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
  read(key: PropertyKey, path: string[] | undefined, more?: (href: string, url: any) => any): unknown;
  send(ir: Pick<EarlyIR, 'res'>, scopes: any[], base: any, fns: Fn[]): void;
}

/**
 * `params`: adds a paginated resource's first-page parameters (`withParams`, imported only by a page
 * that has one); `envOf`: where the environment comes from (`configured` where an app early module may set it)
 */
export function requests(params?: typeof withParams, envOf: () => EarlyEnv = browser): EarlyRequests {
  let url: Record<string, string | string[]> | null = null, now: Date | null = null, e: EarlyEnv | null = null;
  // the environment only requests read (the clock, the location, fetch): read when first needed, after the app's early module ran
  const env = () => (e ??= envOf());
  return {
    read(k, path, more = (_, u) => u) {
      if (k == '$now') return (now ??= new Date(env().now()));
      if (k == '$url') { const h = env().href(); return (url ??= more(h, readUrl(h, path))); }
      throw Error('sinter: not available early');
    },
    /** the resources whose URL is known now: `when` holds and every value is there (a paginated one: its first page) */
    send(ir, scopes, base, fns) {
      const here = env().href();
      for (const r of ir.res ?? []) {
        try {
          const s = r.scope < 0 ? base : scopes[r.scope];
          if (r.when != null && !fns[r.when]!(s)) continue;
          let q = r.q;
          // `model` (paginate): page n's parameters (the pager's pageParams)
          if (r.sp) { const n = toPage(fns[r.sp.f]!(s)); if (n > 1) q = { ...r.sp.qn, [r.sp.k]: String(r.sp.o ? (n - 1) * r.sp.s : n) }; }
          const t = expand(r.src, s, fns), u = new URL(q ? params!(t, q) : t, here);
          // another origin only when the build found it in `sinter({ origins })` (`xo`)
          if (r.xo || u.origin == new URL(here).origin) (prefetched() ?? own(pending(env()))).add(u.href, r.lo, r.a);
        } catch { /* not known early: the page module requests it */ }
      }
    },
  };
}

/**
 * The resource requests the early file started, by URL: each sent as the request layer sends a GET
 * with no middleware (Accept JSON, its API's credentials and static headers, `a`), taken once by a
 * request that is the same at the end of the middleware chain.
 */
function pending(env: EarlyEnv): Prefetched {
  const started = new Map<string, { res: Promise<Response>; c: AbortController; cr: RequestCredentials; h: Headers }>();
  return {
    add(url, lo, a) {
      if (started.has(url)) return;
      const h = new Headers(a?.h), cr = a?.c ?? 'same-origin', t = a?.t, v = t ? token(t) : null;
      // signed out: an operation that needs the token is not requested (the page module reads it as signed out)
      if (t && v == null && a!.r) return;
      h.has('Accept') || h.set('Accept', 'application/json');
      // the API's token, as the request layer adds it: the page's request is then the same, and takes this response
      if (v != null) h.has(t!.h) || h.set(t!.h, t!.p + v);
      const c = new AbortController(), res = env.fetch(new Request(url, { headers: h, credentials: cr, signal: c.signal, ...(lo ? { priority: 'low' } : {}) } as RequestInit));
      res.catch(() => {});
      started.set(url, { res, c, cr, h });
    },
    take(req: Request, signal: AbortSignal) {
      const e = started.get(req.url), h = [...req.headers];
      if (!e) return undefined;
      // a middleware that changed the request (a header, credentials) gets a request of its own
      if (req.method != 'GET' || req.credentials != e.cr || h.length != [...e.h].length || h.some(([k, v]) => e.h.get(k) !== v)) return null;
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

/** whether no token is stored under `k` (`s`: `l`ocal or `s`ession storage): the resources that need it are loaded, empty, at mount */
export const $so = (s: 'l' | 's', k: string): boolean => token({ s, k, h: '', p: '' }) == null;

/** an API's token, from its storage (`setEnv()`'s in tests), as the request layer reads it; null when none is stored */
const token = (t: NonNullable<EarlyApi['t']>): string | null => {
  try { return (t.s == 's' ? (config.env?.session ? config.env.session() : globalThis.sessionStorage) : (config.env?.storage ? config.env.storage() : globalThis.localStorage))?.getItem(t.k) || null; } catch { return null; }
};

/** Renders a page's early part (tests; the early file goes through `start`). */
export function early(doc: Document, page: ReturnType<EarlyPage>): void {
  prepare(page, requests(undefined, configured))?.render(doc);
}

/**
 * `data-sn-signed-in`: with no token stored (and the condition true), the visitor goes to sign in now, in the current
 * history entry, and nothing is requested or rendered (the page is hidden meanwhile, and the page module never
 * mounts). A prerendered page renders: the page module sends the visitor on once it is shown.
 */
function away(o: ReturnType<EarlyPage>, base: any): boolean {
  const g = o.ir.si;
  if (!g || (document as Document & { prerendering?: boolean }).prerendering) return false;
  try { if (token({ ...g.t, h: '', p: '' }) != null || (g.f != null && !o.fns[g.f]!(base))) return false; } catch { return false; }
  const e = config.env;
  if (!e) document.documentElement.hidden = true;
  let session: Storage | null = null;
  try { session = e?.session ? e.session() : sessionStorage; } catch { /* none */ }
  (e?.replace ?? ((u: string) => location.replace(u)))(signInTarget(g.i, e?.href ? e.href() : location.href, session));
  return true;
}

function prepare(o: ReturnType<EarlyPage>, req: EarlyRequests | null) {
  const { ir, fns } = o, base = scope(o, req);
  if (away(o, base)) return null;
  const roots = o.scopes(base);
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

/** the roots by id (`data-sn` elements, anchors' start comments), in the order given */
export function byId(doc: Document, ids: Array<number | undefined>): Array<Node | null> {
  // observing: the roots of this pass, each once, when the parser has closed it
  if (live) { const l = live.pick; return ids.map((i) => l.get(i!) ?? null); }
  const m = new Map<number, Node>();
  rootsIn(doc.documentElement, (id, n) => m.set(id, n));
  return ids.map((i) => m.get(i!) ?? null);
}

/** a branch's node: the runtime's path walk (path[0] a node of the clone, the rest descend), checked against its tag (`#`: an anchor's start comment) */
export function at(nodes: Node[], path: number[], tag: string): Node | null {
  let n: Node | null = nodes[path[0]!] ?? null;
  for (let k = 1; k < path.length && n; k++) {
    n = n.firstChild;
    for (let c = path[k]!; c-- && n;) n = n.nextSibling;
  }
  return n && (n.nodeType == 8 ? '#' : (n as Element).localName) == tag ? n : null;
}

/** one binding's first write: its value in `s` (one that throws is the page module's), written by `wr` */
export function w(el: Node | null, f: Fn, s: any, wr: (el: any, v: any, n: string) => unknown, n = ''): void {
  if (!el) return;
  let done: Set<string> | null = null, key = '';
  if (live) {
    // observing: each binding once; a content binding of an element the parser has not closed yet waits
    let id = fnIds.get(f);
    if (id == null) fnIds.set(f, (id = fnN++));
    key = id + ' ' + n + ' ' + (content(el, wr) ? 'c' : 'a');
    done = wrote.get(el) ?? new Set<string>();
    if (done.has(key)) return;
    if (!live.all && content(el, wr) && !ready(el)) { live.waiting.add(el); return; }
    done.add(key);
    wrote.set(el, done);
  }
  let v: any;
  try { v = f(s); } catch (e) {
    // a message whose dictionary is on its way: tried again when it arrives (observe)
    if (e === NOT_YET) retries.push(() => w(el, f, s, wr, n));
    return;
  }
  // an anchor whose template the parser has not reached yet (one in the head): the next pass tries it again
  if (wr(el, v, n) === WAIT && live) { done!.delete(key); live.waiting.add(el); }
}

/** A branch at its start comment: template `tid` cloned before the end comment, left on the start for the runtime to adopt, rendered by `r` over `s`. */
function branch(start: Comment, br: number, tid: number, r: Branch | 0 | undefined, s: any): void | typeof WAIT {
  const end = endOf(start);
  if (!end) return;
  if (!tplOf(tid)) return WAIT;
  const nodes = cloneOf(tid);
  end.before(...nodes);
  (start as any)[EARLY] = { br, nodes, end } satisfies EarlyBranch;
  if (r) { r(nodes, s); fixer?.(nodes); }
}
type Branch = (nodes: Node[], s: any) => void;

/**
 * A `data-sn-if` at its start comment: the branch to show (1 template `x`, 2 its `data-sn-else` template
 * `z`, none), cloned before the end comment and left on the start for the runtime to adopt; `a`/`b`
 * render the branch's bindings over its nodes.
 */
export function iff(start: Comment, v: unknown, x: number, z: number | null, a: Branch | 0, b: Branch | 0, s: any): void | typeof WAIT {
  if (v || z != null) return branch(start, v ? 1 : 2, v ? x : z!, v ? a : b, Object.create(s));
}

/**
 * A choice (`<sn-component use>`) at its start comment: `v` is `[case, props]` or null; the case's
 * definition (template `ts[case]`) is cloned before the end comment with the props as its row's item
 * `item[case]`, and left on the start for the runtime to adopt (`br`: the case + 1).
 */
export function ch(start: Comment, v: [number, unknown] | null, ts: number[], items: string[], rs: Array<Branch | 0>, s: any): void | typeof WAIT {
  if (!v || ts[v[0]] == null) return;
  const k = v[0], sc = Object.create(s);
  sc[items[k]!] = v[1];
  return branch(start, k + 1, ts[k]!, rs[k], sc);
}

/** set on the start comment of a `data-sn-for` whose rows `each` rendered: each row's nodes and the end comment, for the page module to adopt */
export const EARLY_ROWS = Symbol.for('sinter.early.rows');
export interface EarlyRows { rows: Node[][]; end: Comment }

/**
 * A `data-sn-for` over embedded data, at its start comment: a clone of template `x` per item, before the end
 * comment, each rendered by `r` over a scope with the loop variable (and index). The rows are left on the start:
 * the page module adopts them (binds them instead of new clones) when its list has the same number of items,
 * else removes them.
 */
export function each(start: Comment, list: unknown, x: number, r: Branch | 0, item: string, index: string | null, s: any): void | typeof WAIT {
  const end = endOf(start);
  if (!Array.isArray(list) || !list.length || !end) return;
  if (!tplOf(x)) return WAIT;
  const rows: Node[][] = [];
  list.forEach((v, i) => {
    const nodes = cloneOf(x);
    end.before(...nodes);
    rows.push(nodes);
    if (r) { const sc = Object.create(s); sc[item] = v; if (index) sc[index] = i; r(nodes, sc); fixer?.(nodes); }
  });
  (start as any)[EARLY_ROWS] = { rows, end } satisfies EarlyRows;
}

/**
 * The texts `slot` wrote: in place of a placeholder (`texts`: the text by the placeholder), or after the node that is the placeholder itself (`texts`: the text by itself; a
 * row or case whose first node is the text). A rendered row's or branch's node list takes them, as what the page
 * module removes or adopts.
 */
const texts = new WeakMap<Node, Node>();
/**
 * `fix`, once `slot` has written a text (a row's or branch's list needs no fixing before): reached only from
 * `slot`, so a site whose early bindings write no text node bundles none of it
 */
let fixer: typeof fix | undefined;
const fix = (nodes: Node[]) => {
  const out = nodes.flatMap((n) => { const x = texts.get(n) ?? n, t = x.nextSibling; return t && texts.get(t) == t && !nodes.includes(t) ? [x, t] : [x]; });
  nodes.splice(0, nodes.length, ...out);
};

// the writers, as the runtime's first write
export const text = (el: HTMLElement, v: any) => { el.textContent = '' + (v ?? ''); };
/** `<template data-sn-text>` (a content binding, `c`): the text node after `el` (the start of its anchor, or the node before it in a row), in place of its empty comment */
export const slot = /* @__PURE__ */ Object.assign((el: ChildNode, v: any) => {
  fixer = fix;
  const s = el.nextSibling as CharacterData | null;
  v = '' + (v ?? '');
  if (s?.nodeType == 3) s.data = v;
  else if (v) { const t = new Text(v); if (s?.nodeType == 8 && !s.data) { s.replaceWith(t); texts.set(s, t); } else { el.after(t); texts.set(t, t); } }
}, { c: 1 as const });
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
