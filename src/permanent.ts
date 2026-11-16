// `data-sn-permanent`: an element that stays, untouched, across a navigation to another page that has
// an element with the same name (an audio player, an open drawer, a scroll container). SPIKE.
//
// SPIKE: only pages with such an element load this module (the proposal makes swaps the default, with a
// stub on every page that ships JavaScript; docs/proposals/swap-navigation.md). A
// navigation to another page of the origin (a link, `navigate()`, `location.assign`, Back and Forward)
// arrives as the browser's `navigate` event (the Navigation API; without it, nothing here runs and every
// navigation is a page load). The swap intercepts it: it fetches that page's HTML (the same request a
// page load sends; nothing changes on the server), and if both pages hold the same names, the body is
// replaced in place: the marked elements are moved into the new body where it has theirs, the old
// page's app is destroyed and the new page's module runs. Anything unexpected is a page load.
//
// The kept element holds no bindings (the build checks it): the new page's compiled code finds only
// its own nodes, none of them inside a kept element.
import { chain } from './links.js';
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
  /** the page's scroll position on each entry, by its key (`navigation.currentEntry.key`), kept as it scrolls */
  y: Map<string, number>;
  /** the entry of the last traversal the swap intercepted: its `popstate` is the swap's, not the core's */
  took: string | null;
  /** a URL the swap could not take: the load that follows is the browser's (else it would take it again) */
  skip: string | null;
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
 * Prepares the swap to the page at `url` (fetch, plan, the head, the modules preloaded) and gives the
 * commit, which needs no network; false when it cannot (the page is loaded), true when a newer navigation
 * aborted it (nothing to do). `kind`: a new entry, the current one replaced, or a traversal.
 */
async function prepare(s: State, url: URL, kind: Intent['kind'], signal?: AbortSignal): Promise<boolean | (() => Promise<boolean>)> {
  const push = kind != 'traverse';
  s.busy?.abort();
  const c = (s.busy = new AbortController());
  // the browser's navigation aborted (a newer one, a stop): so is the swap
  signal?.addEventListener('abort', () => c.abort());
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

  // what is left needs no network: the browser may commit the URL now (`precommitHandler` done), then this runs
  return async (): Promise<boolean> => {
    let committed = false, leaving: App | null = null;
    const swap = () => {
      // a newer navigation came while the transition waited for this callback: it has the page
      if (c.signal.aborted) return;
      committed = true;
      // the browser made the entry (`intercept()`); a redirect gives it another URL
      if (final.href != location.href) history.replaceState(history.state, '', final.href);
      s.shown = final.pathname;
      // the old app stays until the new one mounts (it destroys it): never a moment without one
    try { leaving = instance(document); leaving.ext.leaving = true; } catch { /* not mounted */ }
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
      const y = push ? 0 : (s.y.get(entry()) ?? 0);
      if (push && final.hash) document.getElementById(decodeURIComponent(final.hash.slice(1)))?.scrollIntoView();
      else scrollTo(0, y);
      track();
      // focus: the browser's (`focusReset`), as after a load, or where it was in a kept element
    };
    type VT = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void> };
    // a transition only where the app's CSS asks for page transitions (`@view-transition { navigation: auto }`,
    // with its `@media`: temper's is inside `prefers-reduced-motion: no-preference`), as a page load would
    const vt = wanted() ? (document as Document & { startViewTransition?: (f: () => void) => VT }).startViewTransition : undefined;
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
    // the new page did not mount (its module failed): the page is loaded, rather than left unbound
    try { const l = leaving as App | null; if (l && instance(document) === l) { l.destroy(); location.reload(); return true; } } catch { /* the new one is mounted, or none */ }
    // Back and Forward: the position was set at the swap, on the new page's markup before its data; what
    // renders above it moves the content (scroll anchoring keeps the wrong part in view). Set again once the
    // page's first loads are done (at most a second later), unless a newer navigation came meanwhile
    if (kind == 'traverse') {
      const key = entry(), y = s.y.get(key);
      let app: App | null = null;
      try { app = instance(document); } catch { /* not mounted */ }
      const names = app?.ir.resources.map((r) => r.name) ?? [];
      for (let t = 0; t < 40 && names.some((n) => app!.resource(n).meta.loading); t++) await new Promise((r) => setTimeout(r, 25));
      if (y != null && !c.signal.aborted && entry() === key) scrollTo(0, y);
    }
    return true;
  };
}

/**
 * Whether the app's stylesheets ask for transitions between pages: an `@view-transition` rule with
 * `navigation: auto` whose `@media` conditions hold. Where the rule cannot be read (Firefox, which runs
 * no transitions between documents either) or a sheet is another origin's: no.
 */
function wanted(): boolean {
  const walk = (rules: CSSRuleList): boolean => {
    for (const r of rules) {
      if ((r as { navigation?: string }).navigation === 'auto' && r.constructor.name == 'CSSViewTransitionRule') return true;
      if (r instanceof CSSMediaRule && !matchMedia(r.conditionText ?? r.media.mediaText).matches) continue;
      if ((r as CSSGroupingRule).cssRules && walk((r as CSSGroupingRule).cssRules)) return true;
    }
    return false;
  };
  if (typeof (globalThis as { CSSViewTransitionRule?: unknown }).CSSViewTransitionRule == 'undefined') return false;
  for (const sheet of document.styleSheets) {
    try { if (!sheet.disabled && walk(sheet.cssRules)) return true; } catch { /* another origin's: not readable */ }
  }
  return false;
}

type Nav = EventTarget & { currentEntry: { key: string } | null };
/** whether `intercept()` takes a `precommitHandler` (it holds the URL until the page is ready) */
const PRECOMMIT = typeof (globalThis as { NavigationPrecommitController?: unknown }).NavigationPrecommitController != 'undefined';
const nav = (): Nav | undefined => (globalThis as { navigation?: Nav }).navigation;
const entry = () => nav()?.currentEntry?.key ?? '';
/** the page's position on the current entry */
function track() { state().y.set(entry(), scrollY); }

function state(): State {
  const g = globalThis as Record<symbol, State | undefined>;
  if (g[STATE]) return g[STATE]!;
  const s: State = (g[STATE] = { shown: location.pathname, n: 0, busy: null, modules: [...document.querySelectorAll('script[type="module"][src]')].map((x) => (x as HTMLScriptElement).src), y: new Map(), took: null, skip: null });
  // each entry's position as it scrolls (not while a swap waits for its body: the address is the next
  // entry, the body still the last)
  addEventListener('scroll', () => { if (location.pathname == s.shown) track(); }, { passive: true });
  return s;
}

/** what the swap reads of a `navigate` event (the Navigation API) */
interface NavigateLike extends Event {
  canIntercept: boolean; hashChange: boolean; downloadRequest: string | null; formData: FormData | null;
  navigationType: Intent['kind'] | 'reload'; signal: AbortSignal; sourceElement?: Element | null; cancelable: boolean;
  destination: { url: string; key: string; index: number; sameDocument: boolean };
  intercept(o: { handler(): Promise<void>; precommitHandler?(): Promise<void>; scroll?: 'manual' | 'after-transition'; focusReset?: 'manual' | 'after-transition' }): void;
}

const permanent: Feature = {
  name: 'permanent',
  install(app: App) {
    const s = state(), N = nav();
    s.shown = location.pathname;
    // no Navigation API: no swaps, every navigation is the browser's
    if (!N) return;
    const c = chain(app);
    // what started a link or `navigate()` the browser goes on with (no handler decided): the event it causes has no `sourceElement` for a call
    let trigger: Element | null = null;
    c.onGo.push((i) => {
      if (i.source == 'link' || i.source == 'call') trigger = i.trigger ?? null;
      // the load after a swap that could not: the browser's, once (deciding changes nothing, so it is cleared here)
      else if (i.source == 'event' && s.skip != null && s.skip == i.to) queueMicrotask(() => { s.skip = null; });
    });
    // the browser's navigations to another document of this origin, and traversals: intents for the chain
    const on = (ev: Event) => {
      const e = ev as NavigateLike;
      if (!e.canIntercept || e.hashChange || e.downloadRequest != null || e.formData || e.navigationType == 'reload') return;
      // `history.pushState` (a `$url` write, a same-page link) fires it too: not a navigation to another page
      if (e.destination.sameDocument && e.navigationType != 'traverse') return;
      // what the browser keeps: a form's navigation (GET too), a link to another site, a download, another
      // target, and what the page takes out (`data-sn-swap="off"`)
      const from = e.sourceElement;
      // (a form's navigation names its submitter, a button or input, as the source)
      if (from && (from.localName == 'form' || (from as HTMLButtonElement).form || from.matches('[rel~=external],[download],[target]:not([target=_self]),[data-sn-swap=off]'))) return;
      // the entry being left: its position, before the browser makes another one current
      track();
      // its fallback, once the swap could not: a load of its URL, or a reload if the URL committed already
      // (after that navigation settled)
      const to = e.destination.url, kind = e.navigationType;
      const load = () => (location.href == to ? setTimeout(() => location.reload()) : kind == 'replace' ? location.replace(to) : location.assign(to));
      c.go({ from: location.href, to, kind, source: 'event', trigger: e.sourceElement ?? trigger, index: e.destination.index, signal: e.signal, event: e, load });
      trigger = null;
    };
    N.addEventListener('navigate', on);
    app.addCleanup(() => N.removeEventListener('navigate', on));
    // the swap's decision: a `navigate` event to another page of this origin, or a traversal to an entry of
    // another path; and the `popstate` of a traversal it intercepted (decided, done: the core does nothing)
    c.nav.push((i) => {
      // the traversal's `popstate`, once: decided (the core reads no `$url` for it), cleared when run
      if (i.source == 'popstate') return s.took != null && s.took === entry() ? { name: 'swap', run: () => { s.took = null; } } : undefined;
      if (i.source != 'event') return;
      const e = i.event as NavigateLike, u = new URL(i.to);
      if (u.origin != location.origin || !/^https?:$/.test(u.protocol)) return;
      // entries of the page shown (its `$url` history): the core's
      if (i.kind == 'traverse' && u.pathname == s.shown) return;
      if (s.skip == u.href) return;
      return {
        name: 'swap',
        run: () => new Promise<boolean>((done) => {
          if (i.kind == 'traverse') s.took = e.destination.key;
          // focus in a kept element stays there; else the browser resets it, as after a load
          const keep = !!document.activeElement?.closest(`[${ATTR}]`);
          // the fetch and the plan before the URL changes where the browser waits for it (`precommitHandler`:
          // a second click before the page is ready replaces this navigation, as with page loads); else in
          // the handler, after the URL changed (WebKit commits it at once)
          let p: Promise<boolean | (() => Promise<boolean>)> | null = null;
          const ready = () => (p ??= prepare(s, u, i.kind, e.signal));
          const fail = () => { s.skip = u.href; done(false); throw new Error('sinter: the page is loaded instead'); };
          e.intercept({
            scroll: 'manual', focusReset: keep ? 'manual' : 'after-transition',
            // a traversal has none: one that cannot swap must not become a new entry (it commits, then reloads);
            // nor has a navigation that cannot be canceled (the browser's own Back, without activation)
            ...(PRECOMMIT && i.kind != 'traverse' && e.cancelable ? { async precommitHandler() { if ((await ready()) === false) fail(); } } : {}),
            async handler() {
              const r = await ready();
              if (r === false) fail();
              done(typeof r == 'function' ? await r() : true);
            },
          });
        }),
      };
    });
  },
};

export default permanent;
