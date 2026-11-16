// `data-sn-permanent`: an element that stays, untouched, across a navigation to another page that has
// an element with the same name (an audio player, an open drawer, a scroll container). SPIKE.
//
// Only pages with such an element load this module, so every other page keeps plain page loads. A
// click on a link to another page of the origin fetches that page's HTML (the same request a page
// load sends; nothing changes on the server), and if both pages hold the same names, the body is
// replaced in place: the marked elements are moved into the new body where it has theirs, the old
// page's app is destroyed and the new page's module runs. Anything unexpected is a page load.
//
// The kept element holds no bindings (the build checks it): the new page's compiled code finds only
// its own nodes, none of them inside a kept element.
import { links } from './links.js';
import type { App, Feature, Intent } from './runtime/app.js';
import { instance } from './runtime/app.js';

const ATTR = 'data-sn-permanent';
/** the early file and the page module meet through this global (handoff.ts): a swapped-in page has no early file */
const MEETING = Symbol.for('sinter.early.page');
/** one per document: a page bundle of its own may hold another copy of this module */
const STATE = Symbol.for('sinter.permanent');

interface State {
  /** the path the body shows: a traversal to another path swaps the body back */
  shown: string;
  /** a counter for the page modules' URLs: a module runs once per URL, a page shown again must run again */
  n: number;
  /** the navigation in progress: a newer one aborts it */
  busy: AbortController | null;
  /** the module scripts of the page shown */
  modules: string[];
  /** the page's scroll position on each entry a swap showed, by its key (`snK` in `history.state`), kept as it scrolls */
  y: Map<number, number>;
  /** the last entry key given */
  k: number;
}

const marked = (root: ParentNode) => {
  const m = new Map<string, Element[]>();
  for (const el of root.querySelectorAll(`[${ATTR}]`)) {
    const n = el.getAttribute(ATTR)!;
    m.set(n, [...(m.get(n) ?? []), el]);
  }
  return m;
};

const pathOf = (u: URL) => u.pathname + u.search;

/**
 * The head nodes that belong to the page shown, grouped (an anchor with what it rendered is one group):
 * what the page's code finds there, numbered from 0 on every page (a `data-sn` element, an anchor,
 * a `sn-t-N` template, embedded data, the messages), and the title. Always the new page's.
 */
function owned(head: HTMLHeadElement): Node[][] {
  const out: Node[][] = [], kids = [...head.childNodes];
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i]!;
    if (n.nodeType == 8 && /^sn \d+$/.test((n as Comment).data)) {
      const nodes: Node[] = [n];
      for (let depth = 1; depth && ++i < kids.length;) {
        const k = kids[i]!;
        nodes.push(k);
        if (k.nodeType == 8) depth += /^sn \d+$/.test((k as Comment).data) ? 1 : (k as Comment).data == '/sn' ? -1 : 0;
      }
      out.push(nodes);
    } else if (n.nodeType == 1) {
      const el = n as Element;
      if (el.localName == 'title' || el.hasAttribute('data-sn') || el.hasAttribute('data-sn-messages') || (el.localName == 'template' && /^sn-t-/.test(el.id))) out.push([el]);
    }
  }
  return out;
}

/** A stylesheet of the head, by what it is: a link's resolved URL, a `<style>`'s text. */
const sheets = (head: HTMLHeadElement, base: URL) => new Map([...head.children].flatMap((el): Array<[string, Element]> =>
  el.localName == 'style' ? [['style:' + el.textContent, el]]
  : el.localName == 'link' && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') ?? '') && el.hasAttribute('href') ? [[new URL(el.getAttribute('href')!, base).href, el]]
  : []));

/** What only a page load can change: a page that differs here is loaded. */
const fixed = (d: Document, base: URL) => JSON.stringify([
  [...d.querySelectorAll('head meta[http-equiv]')].map((m) => [m.getAttribute('http-equiv')!.toLowerCase(), m.getAttribute('content')]),
  [...d.querySelectorAll('head base[href]')].map((b) => new URL(b.getAttribute('href')!, base).href),
  [...d.querySelectorAll('script[data-sn-i18n]')].map((x) => x.getAttribute('data-sn-i18n')),
]);

/**
 * The head, kept simple: the new page's own nodes (above) and the stylesheets it has and the page shown
 * lacks go in before the swap, the stylesheets loaded; at `done()`, the old page's own nodes and the
 * stylesheets only it had go. Everything else (metas, links, scripts) stays as the first page had it:
 * it is for crawlers and link previews, which load each page. null: what only a load can change differs.
 */
function heads(doc: Document, base: URL): { ready: Promise<unknown>; done(): void; undo(): void } | null {
  const here = new URL(location.href);
  if (fixed(document, here) != fixed(doc, base)) return null;
  const old = owned(document.head).flat(), have = sheets(document.head, here), keep = new Set<Element>();
  const added: Node[] = [], loads: Promise<unknown>[] = [];
  const add = (n: Node) => {
    // a parsed script never runs, and a link's URL is the fetched page's
    let x: Node;
    if (n.nodeType == 1 && (n as Element).localName == 'script') {
      const s = document.createElement('script');
      for (const a of (n as Element).attributes) s.setAttribute(a.name, a.value);
      s.textContent = n.textContent;
      x = s;
    } else {
      x = document.adoptNode(n);
      if ((x as Element).localName == 'link') (x as Element).setAttribute('href', new URL((x as Element).getAttribute('href')!, base).href);
    }
    document.head.append(x);
    added.push(x);
    return x;
  };
  for (const [k, el] of sheets(doc.head, base)) {
    const same = have.get(k);
    if (same) { keep.add(same); continue; }
    const x = add(el) as HTMLLinkElement;
    if (x.localName == 'link') loads.push(new Promise((r) => { x.onload = x.onerror = r; }));
  }
  for (const group of owned(doc.head)) for (const n of group) add(n);
  return {
    ready: Promise.all(loads),
    done: () => {
      for (const n of old) (n as ChildNode).remove();
      for (const el of have.values()) if (!keep.has(el)) el.remove();
    },
    undo: () => { for (const n of added) (n as ChildNode).remove(); },
  };
}

/**
 * Swaps the body for the page at `url`; false when it cannot (the caller loads the page). `kind`: a new
 * history entry, the current one replaced, or a traversal (the entry is already current).
 */
async function go(s: State, url: URL, kind: Intent['kind']): Promise<boolean> {
  const push = kind != 'traverse';
  s.busy?.abort();
  const c = (s.busy = new AbortController());
  let res: Response;
  try { res = await fetch(url, { headers: { accept: 'text/html' }, signal: c.signal, credentials: 'same-origin' }); }
  catch { return c.signal.aborted; }
  if (c.signal.aborted) return true;
  // a response's URL has no fragment: the link's stays
  const final = new URL(res.url || url.href);
  if (!final.hash) final.hash = url.hash;
  if (!res.ok || final.origin != location.origin || !/^text\/html\b/.test(res.headers.get('content-type') ?? '')) return false;
  const html = await res.text();
  if (c.signal.aborted) return true;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.body.hasAttribute('data-sn-failed')) return false;

  // the pairs: each name once on each page, the same element; one name in two places on either page
  // (markup injected with the attribute) is a page load. Nothing in common: a page load too
  const olds = marked(document), news = marked(doc);
  const pairs: Array<[Element, Element]> = [];
  for (const [n, els] of news) {
    const o = olds.get(n);
    if (els.length > 1 || (o && o.length > 1)) return false;
    if (o && o[0]!.localName == els[0]!.localName) pairs.push([o[0]!, els[0]!]);
  }
  if (!pairs.length) return false;
  // the new page's modules that the page shown does not have (the page module; in dev, not Vite's client): a
  // module both have runs once per document. The same modules on both (one page file, two paths): a page load
  const all = [...doc.querySelectorAll('script[type="module"][src]')].map((x) => new URL(x.getAttribute('src')!, final).href);
  const modules = all.filter((m) => !s.modules.includes(m));
  if (!modules.length) return false;

  // the head: the new page's own elements in, before the swap (its stylesheets loaded), the old page's out in it
  const head = heads(doc, final);
  if (!head) return false;
  // its modules fetched and parsed now, run after the swap: the URL, the body and the app change with no
  // request in between, so nothing sees the new URL without an app on the page (a fragment, not a query: a
  // module runs once per URL, the fragment is part of it, and the server never sees it)
  const n = ++s.n, urls = modules.map((m) => `${m.split('#')[0]}#sn-${n}`);
  const preloads = urls.map((u) => {
    const l = document.createElement('link');
    l.rel = 'modulepreload';
    l.href = u;
    document.head.append(l);
    return l;
  });
  await Promise.all([head.ready, ...preloads.map((l) => new Promise((r) => { l.onload = l.onerror = r; }))]);
  for (const l of preloads) l.remove();
  if (c.signal.aborted) { head.undo(); return true; }

  let committed = false;
  const swap = () => {
    // a newer navigation came while the transition waited for this callback: it has the page
    if (c.signal.aborted) return;
    committed = true;
    // a push or replace leaves the current entry: its position, now (the first page's was never recorded)
    if (kind != 'traverse') track();
    // the entries: the one left (on a push or replace, still current) and the new one restore no scroll of
    // their own while this document shows them (each entry has its own mode); the page's position is the
    // module's, by entry key. A traversal's entry is already current: its key and position are known
    manual();
    if (kind == 'push') history.pushState({ snK: ++s.k }, '', final.href);
    else if (kind == 'replace') history.replaceState({ snK: ++s.k }, '', final.href);
    else if (final.href != location.href) history.replaceState(history.state, '', final.href);
    manual();
    s.shown = final.pathname;
    try { instance(document).destroy(); } catch { /* not mounted */ }
    for (const el of [document.documentElement, document.body] as unknown as Array<Element & Record<symbol, unknown>>) {
      for (const k of Object.getOwnPropertySymbols(el)) if (k.description?.startsWith('sinter.')) delete el[k];
    }
    const body = document.body, old = [...body.childNodes];
    const kept = new Set(pairs.map(([o]) => o));
    // the new content goes in after the old, in this one task: nothing is painted in between, and a
    // playing media element moved within a task does not pause. moveBefore keeps more (an iframe's
    // document, focus, animations) where the browser has it
    const add = [...doc.body.childNodes].map((n) => document.adoptNode(n));
    body.append(...add);
    for (const [o, n] of pairs) {
      const p = n.parentNode as Element & { moveBefore?: (a: Node, b: Node | null) => void };
      if (p.moveBefore && p.isConnected && o.isConnected) p.moveBefore(o, n);
      else {
        // without moveBefore (WebKit), a move resets scroll positions and drops focus: put them back
        const scrolled = [o, ...o.querySelectorAll('*')].filter((x) => x.scrollTop || x.scrollLeft).map((x) => [x, x.scrollTop, x.scrollLeft] as const);
        const f = document.activeElement as (HTMLElement & Partial<HTMLInputElement>) | null, inside = !!f && o.contains(f);
        const sel = inside && typeof f!.selectionStart == 'number' ? [f!.selectionStart!, f!.selectionEnd ?? null, f!.selectionDirection] as const : null;
        p.insertBefore(o, n);
        for (const [x, t, l] of scrolled) { x.scrollTop = t; x.scrollLeft = l; }
        if (inside) {
          f!.focus({ preventScroll: true });
          try { if (sel) f!.setSelectionRange!(sel[0], sel[1], sel[2] ?? undefined); } catch { /* not a text control */ }
        }
      }
      n.remove();
    }
    for (const n of old) if (!kept.has(n as Element)) n.remove();
    head.done();
    // the body's and <html>'s own attributes
    for (const [from, to] of [[doc.body, body], [doc.documentElement, document.documentElement]] as const) {
      for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
      for (const a of from.attributes) to.setAttribute(a.name, a.value);
    }
    const y = push ? 0 : (s.y.get(history.state?.snK) ?? 0);
    if (push && final.hash) document.getElementById(decodeURIComponent(final.hash.slice(1)))?.scrollIntoView();
    else scrollTo(0, y);
    track();
    // focus: on what was focused if it was kept; else the document, as a page load leaves it
    const a = document.activeElement;
    if (a && a != document.body && !pairs.some(([o]) => o.contains(a))) (a as HTMLElement).blur?.();
  };
  type VT = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void> };
  const vt = (document as Document & { startViewTransition?: (f: () => void) => VT }).startViewTransition;
  if (vt) {
    // a transition another navigation skips rejects all three: nothing to report
    const t = vt.call(document, swap), no = () => {};
    t.ready.catch(no); t.finished.catch(no);
    await t.updateCallbackDone.catch(no);
  } else swap();
  if (!committed) { head.undo(); return true; }

  // the new page's modules: no early file ran, so the page module mounts by itself
  delete (globalThis as Record<symbol, unknown>)[MEETING];
  s.modules = all;
  for (const u of urls) {
    try { await import(/* @vite-ignore */ u); } catch (e) { setTimeout(() => { throw e; }); }
  }
  // Back and Forward: the position was set at the swap, on the new page's markup before its data; what
  // renders above it moves the content (scroll anchoring keeps the wrong part in view). Set again once the
  // page's first loads are done (at most a second later), unless a newer navigation came meanwhile
  if (kind == 'traverse') {
    const key = history.state?.snK, y = s.y.get(key);
    let app: App | null = null;
    try { app = instance(document); } catch { /* not mounted */ }
    const names = app?.ir.resources.map((r) => r.name) ?? [];
    for (let t = 0; t < 40 && names.some((n) => app!.resource(n).meta.loading); t++) await new Promise((r) => setTimeout(r, 25));
    if (y != null && !c.signal.aborted && history.state?.snK === key) scrollTo(0, y);
  }
  return true;
}

const manual = () => { try { history.scrollRestoration = 'manual'; } catch { /* ignored */ } };
/** the page's position on the current entry, by its key (one it has, else one given now) */
function track() {
  const s = state();
  let k = history.state?.snK;
  if (typeof k != 'number') {
    k = ++s.k;
    try { history.replaceState({ ...(history.state ?? {}), snK: k }, ''); } catch { /* ignored */ }
  }
  s.y.set(k, scrollY);
}

function state(): State {
  const g = globalThis as Record<symbol, State | undefined>;
  if (g[STATE]) return g[STATE]!;
  const s: State = (g[STATE] = { shown: location.pathname, n: 0, busy: null, modules: [...document.querySelectorAll('script[type="module"][src]')].map((x) => (x as HTMLScriptElement).src), y: new Map(), k: Date.now() });
  // each entry's position as it scrolls (a traversal makes another entry current before anything can
  // read the one left), and only once a swap happened (until then, entries are the browser's)
  // (not while a traversal waits for its body: the address is the next entry, the body still the last)
  addEventListener('scroll', () => { if (s.y.size && location.pathname == s.shown) track(); }, { passive: true });
  // the document goes (a reload, a link out of the app): the browser restores this entry's position again
  addEventListener('pagehide', () => { try { history.scrollRestoration = 'auto'; } catch { /* ignored */ } });
  addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted && s.y.size) manual(); });
  return s;
}

const permanent: Feature = {
  name: 'permanent',
  install(app: App) {
    const s = state();
    s.shown = location.pathname;
    // the swap's place among the navigation handlers (after same-page links): another path of this origin,
    // from a link, `navigate()` or Back and Forward across the entries a swap made (the path changed)
    app.nav.push((i) => {
      const u = new URL(i.to), here = new URL(location.href);
      const other = u.origin == here.origin && /^https?:$/.test(u.protocol) && (i.kind == 'traverse' ? u.pathname != s.shown : pathOf(u) != pathOf(here));
      if (i.peek) return other && 'swap';
      // the browser follows this one (the same page, the last handler passed): it wins over a pending swap
      if (!other) { if (i.kind != 'traverse') s.busy?.abort(); return; }
      const load = () => (i.kind == 'traverse' ? location.reload() : i.kind == 'replace' ? location.replace(u.href) : location.assign(u.href));
      go(s, u, i.kind).then((ok) => { if (!ok) load(); }, load);
      return 'swap';
    });
    links(app);
  },
};

export default permanent;
