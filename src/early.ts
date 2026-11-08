// @tiaforge-ui/sinter/early: what a page's early file runs before the first paint. It starts the
// requests of the resources whose URL is known before any data (the page module's request layer
// takes the responses), and renders, once, the bindings the compiler found renderable before any data: page-level values from state
// (persisted values read from storage) and helpers, and the branch of each such `data-sn-if`.
// No reactivity: the page module mounts later and takes the rendered DOM over (an early branch is
// adopted, not rendered again). The early file and the page bundle are bundled apart (each holds
// its own copy of what it imports), so what they share goes through a global: `start` (early
// file) and `rendered` (page module, from the core) meet there.
import { config } from './runtime/config.js';
import type { Env } from './runtime/env.js';
import { meeting, prefetched, setPrefetched, type Prefetched } from './runtime/handoff.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './runtime/security.js';
import { expand, readUrl } from './runtime/url.js';
import type { Binding, EarlyIR, NodeDef } from './ir.js';

/** What the early file needs from the outside world: `configure({ env })` from the app's early module, else the browser. */
type EarlyEnv = Pick<Env, 'now' | 'href' | 'storage' | 'fetch'>;
const envOf = (): EarlyEnv => {
  const e = config.env, g = globalThis as typeof globalThis & Window;
  return { now: e?.now ?? Date.now, href: e?.href ?? (() => g.location.href), storage: e?.storage ?? (() => { try { return g.localStorage; } catch { return null; } }), fetch: e?.fetch ?? ((r) => fetch(r)) };
};

export { $k } from './runtime/security.js';

/** On a `data-sn-if` template the early chunk rendered: the branch, its nodes and end marker, for the runtime to adopt. */
export const EARLY = Symbol.for('sinter.early');
export interface EarlyBranch { br: number; nodes: Node[]; end: Comment }

type Fn = (...a: any[]) => any;

/** The page's early part, built when the early file starts. */
export type EarlyPage = () => { ir: EarlyIR; fns: Fn[] };

/**
 * The early file's entry: renders the page's early part once the dictionary (if any) is there.
 * The early file is a deferred module: it runs after the parse, before the first paint (it blocks
 * rendering until it has run; a language file the picker added holds the paint until it is there).
 */
export function start(page: EarlyPage | null, messages: { use(): void; ready(): Promise<void> } | null, req: EarlyRequests | null = null, doc: Document = document): void {
  const m = meeting();
  m.started = true;
  messages?.use();
  const fail = (e: unknown) => { setTimeout(() => { throw e; }); };
  let p: ReturnType<typeof prepare> | null = null;
  // the requests need no DOM: they start before anything waits
  try { if (page) (p = prepare(page(), req)).fetch(); } catch (e) { fail(e); }
  void (async () => {
    await messages?.ready();
    // a failure is reported, and the page module mounts all the same
    try { p?.render(doc); } catch (e) { fail(e); }
    m.finish();
  })();
}

/**
 * The early requests: the compiler has the early file import this only when the page has resources
 * to request early, so a page without them carries none of it (nor the URL templates). `read`: what
 * only requests may read (`$now`, `$url`); `send`: starts the requests whose URL is known.
 */
export interface EarlyRequests {
  read(key: PropertyKey, env: EarlyEnv, path: string[] | undefined): unknown;
  send(ir: EarlyIR, scopes: any[], base: any, fns: Fn[], env: EarlyEnv): void;
}

export function requests(): EarlyRequests {
  let url: Record<string, string> | null = null, now: Date | null = null;
  return {
    read(k, env, path) {
      if (k == '$now') return (now ??= new Date(env.now()));
      if (k == '$url') return (url ??= readUrl(env.href(), path));
      throw Error('sinter: not available early');
    },
    /** the resources whose URL is known now: `when` holds and every value is there */
    send(ir, scopes, base, fns, env) {
      const here = env.href();
      for (const r of ir.res ?? []) {
        try {
          const s = r.scope < 0 ? base : scopes[r.scope];
          if (r.when != null && !fns[r.when]!(s)) continue;
          const u = new URL(expand(r.src, s, fns), here);
          if (u.origin == new URL(here).origin) (prefetched() ?? own(pending(env))).add(u.href, r.lo);
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
export function early(doc: Document, o: { ir: EarlyIR; fns: Fn[] }): void {
  prepare(o, requests()).render(doc);
}

function prepare(o: { ir: EarlyIR; fns: Fn[] }, req: EarlyRequests | null) {
  const { ir, fns } = o, env = envOf(), schemes = schemesOf(config.urlSchemes);
  // what is not available before data throws, and the binding (or request) is left to the page module
  const base = new Proxy(Object.create(null), {
    get(_, k) {
      if (k == '$locale' && config.locale) return config.locale.get();
      // for requests only: no early binding reads the clock or the URL
      if (req) return req.read(k, env, ir.path);
      throw Error('sinter: not available early');
    },
  });
  const read = (key: string): unknown => {
    try {
      const v = env.storage()?.getItem('sn:' + key);
      return v == null ? undefined : JSON.parse(v);
    } catch { return undefined; }
  };
  /** each node's scope: its state (persisted values applied, as the persist feature does at mount) */
  const scopesOf = (defs: NodeDef[], s0: any): any[] => {
    const scopes: any[] = [];
    defs.forEach((nd, i) => {
      let s = nd.p >= 0 ? scopes[nd.p] ?? s0 : s0;
      if (nd.state != null) {
        let obj: any = {};
        try { obj = fns[nd.state]!(s); } catch { /* a field that throws: none known */ }
        const v = nd.persist ? read(nd.persist) : undefined;
        if (v && typeof v == 'object') for (const k of Object.keys(obj)) if (Object.hasOwn(v, k)) obj[k] = (v as any)[k];
        s = Object.assign(Object.create(s), { ['$s' + nd.sid]: obj });
      }
      scopes[i] = s;
      for (const b of nd.b) if (b.k == 'model' && b.p != null) {
        const v = read(b.p);
        if (v !== undefined) try { fns[b.a!]!(s, v); } catch { /* ignored */ }
      }
    });
    return scopes;
  };
  const roots = scopesOf(ir.roots, base);
  return {
    fetch() { req?.send(ir, roots, base, fns, env); },
    render(doc: Document) {
      const byId = new Map<number, Element>();
      for (const el of doc.querySelectorAll('[data-sn]')) byId.set(+el.getAttribute('data-sn')!, el);
      bind(ir.roots, ir.roots.map((n) => byId.get(n.id!) ?? null), base, roots);
    },
  };

  function bind(defs: NodeDef[], els: Array<Element | null>, s0: any, scopes = scopesOf(defs, s0)) {
    const todo: Array<[Binding, Element, any]> = [];
    defs.forEach((nd, i) => {
      const el = els[i];
      if (el) for (const b of nd.b) todo.push([b, el, scopes[i]]);
    });
    // persisted values are in place before anything is written, as at mount
    for (const [b, el, s] of todo) {
      if (b.k == 'else') continue;
      let v: any;
      try { v = fns[b.f!]!(s); } catch { continue; }
      if (b.k == 'if') branch(el as HTMLTemplateElement, b, v, s, defs, els);
      else write(el as never, b, v);
    }
  }

  function branch(tpl: HTMLTemplateElement, b: Binding, v: unknown, s: any, defs: NodeDef[], els: Array<Element | null>) {
    const other = b.y != null ? els[b.y] as HTMLTemplateElement | null : null;
    const br = v ? 1 : other ? 2 : 0;
    if (!br) return;
    const [t, x] = br == 1 ? [tpl, b.x!] : [other!, defs[b.y!]!.b.find((e) => e.k == 'else')!.x!];
    const def = ir.templates[x];
    const content = t.content, one = content.firstChild == content.lastChild && content.firstChild?.nodeType == 1 && (content.firstChild as Element).localName != 'template';
    const frag = content.cloneNode(true) as DocumentFragment, nodes = [...frag.childNodes];
    const end = new Comment();
    tpl.after(end);
    end.before(...nodes);
    (tpl as any)[EARLY] = { br, nodes, end } satisfies EarlyBranch;
    if (!def) return;
    // the runtime's path walk: path[0] is a child of the content, the rest descend
    const found = def.nodes.map((nd) => {
      const path = nd.path!;
      let n: Node | null = one ? (path[0] == 0 ? nodes[0]! : null) : nodes[path[0]!] ?? null;
      for (let k = 1; k < path.length && n; k++) {
        n = n.firstChild;
        for (let c = path[k]!; c-- && n;) n = n.nextSibling;
      }
      return n && (n as Element).localName == nd.tag ? n as Element : null;
    });
    bind(def.nodes, found, Object.create(s));
  }

  /** As the runtime's first write. */
  function write(el: HTMLElement & HTMLInputElement & HTMLSelectElement, b: Binding, v: any) {
    const n = b.n!;
    switch (b.k) {
      case 'text': el.textContent = '' + (v ?? ''); break;
      case 'show': el.hidden = !v; break;
      case 'class':
        if (n) { if (v || el.hasAttribute('class')) el.classList.toggle(n, !!v); }
        else if (v?.[0]) el.classList.toggle(v[0], !!v[1]);
        break;
      case 'attr':
        if (/^(checked|selected|indeterminate|value)$/.test(n) && n in el) (el as any)[n] = n == 'value' ? (v == null || v === false || v === true ? '' : v) : v != null && v !== false;
        if (v == null || v === false) el.removeAttribute(n);
        else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), el.baseURI, schemes)) el.setAttribute(n, v);
        break;
      case 'style':
        if (v == null || v === false) el.style.removeProperty(n);
        else if (!STYLE_BAD.test(v)) el.style.setProperty(n, v);
        break;
      case 'model': {
        const has = (x: string) => Array.isArray(v) && v.map(String).includes(x);
        if (n == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
        else if (n == 'radio') el.checked = v != null && '' + v == el.value;
        else if (n == 'multi') for (const opt of el.options) opt.selected = has(opt.value);
        else if (el.value != (v ?? '')) el.value = v ?? '';
      }
    }
  }
}
