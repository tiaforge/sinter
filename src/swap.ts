// Swaps (`sinter({ swap: true })`, docs/proposals/swap-navigation.md): a navigation to another page of the
// app fetches that page's HTML (the request a load sends; nothing changes on the server) and swaps its body
// in, keeping the elements both pages name with `data-sn-permanent`; the new page's code mounts in the
// same step. This is the stub every page that swaps carries: it decides, intercepts the browser's
// `navigate` event, and loads the rest (swap-run.ts) when a navigation needs it. Where the browser has no
// Navigation API, or one without `sourceElement` (Chromium 102 to 134, links.ts), it does nothing: every navigation
// stays a page load.
import { RANK, api, ask, asked, chain } from './links.js';
import type { App, Feature, Intent } from './runtime/app.js';

/** one page of the build's list (swap-build.ts): the paths it answers at, the names it keeps */
export interface SwapPage { m: string[]; k?: string[] }

/** what the stub and the rest share, once per document (an app goes at each swap, this stays) */
export interface SwapState {
  list: SwapPage[];
  /** the path the body shows: a traversal within it is the page's own (`$url` history) */
  shown: string;
  /** the names the page shown keeps (its page module's `kept`) */
  kept: string[];
  /** the navigation in progress: a newer one aborts it */
  busy: AbortController | null;
  /** each entry's scroll position, by its key */
  y: Map<string, number>;
  /** a URL the swap could not take: the load that follows is the browser's */
  skip: string | null;
  /** the stylesheets the page's HTML brought (not those added at run time) */
  sheets: Set<Element>;
  /** the live region that announces each page's title */
  live?: HTMLElement;
  /** the index of the entry the navigation in progress leaves (a traversal's direction) */
  at?: number;
  /** the swap in progress (a newer one replaces it; cleared when it commits) */
  run?: object;
  /** a page with nothing to run is shown (swapped in, no app mounted): Back and Forward load their entry */
  bare?: boolean;
}

/** what the stub reads of a `navigate` event */
export interface NavigateLike extends Event {
  cancelable: boolean; signal: AbortSignal;
  destination: { url: string; key: string; index: number };
  intercept(o: { handler(): Promise<void>; precommitHandler?(): Promise<void>; scroll?: 'manual'; focusReset?: 'manual' | 'after-transition' }): void;
}

/** what the rest gives back: the commit, which needs no network; false: a load instead; null: a newer navigation has the page */
export type Prepared = false | null | (() => Promise<void>);

const STATE = Symbol.for('sinter.swap');
export const KEPT = 'data-sn-permanent';
type Nav = EventTarget & { currentEntry: { key: string; index: number } | null };
const nav = () => (globalThis as { navigation?: Nav }).navigation;
/** the current entry's key */
export const entry = () => nav()?.currentEntry?.key ?? '';
/** records the page's position on the current entry */
export const track = (s: SwapState) => { s.y.set(entry(), scrollY); };

const segs = (p: string) => p.split('/').filter(Boolean);
/** the page of the list that answers at `path` (a pattern's `:name` is one segment) */
export const pageAt = (list: SwapPage[], path: string) => list.find((p) => p.m.some((m) => {
  const w = segs(m), h = segs(path);
  return w.length == h.length && w.every((x, i) => x[0] == ':' || x == h[i]);
}));

/** a traversal that loads its page (a reload of the entry): marked for the page that loads (cache.ts reads it once) */
export const back = () => { try { sessionStorage.setItem('sn:back', location.href); } catch { /* no storage: a plain load */ } };

function state(list: SwapPage[]): SwapState {
  const g = globalThis as Record<symbol, SwapState | undefined>;
  if (g[STATE]) return g[STATE]!;
  const s: SwapState = (g[STATE] = {
    list, shown: location.pathname, kept: pageAt(list, location.pathname)?.k ?? [], busy: null, y: new Map(), skip: null,
    // Vite's dev styles come from modules, not from the page
    sheets: new Set(document.head.querySelectorAll('link[rel~=stylesheet],style:not([data-vite-dev-id])')),
  });
  // a page with nothing to run, swapped in, has no app to take Back and Forward: each loads its entry
  nav()!.addEventListener('navigate', (ev) => {
    const e = ev as NavigateLike & { navigationType: string; canIntercept: boolean };
    // (marked as Back or Forward for the page that loads: its resources come back as they were left, cache.ts)
    if (s.bare && e.canIntercept && e.navigationType == 'traverse') e.intercept({ async handler() { back(); location.reload(); } });
  });
  // per-page app code listens for `sn-page`: after each mount, the first one included
  queueMicrotask(() => document.dispatchEvent(new CustomEvent('sn-page', { detail: { to: location.href, kind: 'load' } })));
  return s;
}

export function swap(list: SwapPage[]): Feature {
  return {
    name: 'swap',
    install(app: App) {
      // the page's app swaps the page (an app mounted on an element of it does not); none without the Navigation API
      if (!api() || app.root !== document) return;
      const s = state(list), c = chain(app);
      // the position of the entry each navigation leaves (a swap's, a same-page link's, Back's), before
      // another entry is current
      c.onGo.push(() => { track(s); s.at = nav()?.currentEntry?.index; });
      c.add((i: Intent) => {
        if (i.source != 'event') return;
        const e = i.event as NavigateLike, u = new URL(i.to);
        if (u.origin != location.origin) return;
        // the load after a swap that could not: the browser's, once
        if (s.skip == u.href) { s.skip = null; return; }
        // a link the page takes out; a traversal within the page shown (its `$url` entries)
        if (i.trigger?.matches('[data-sn-swap=off]') || (i.kind == 'traverse' && u.pathname == s.shown)) return;
        // only to a page the build lists: any other URL is the browser's, requested once
        if (!pageAt(s.list, u.pathname)) return;
        return {
          name: 'swap',
          run: () => {
            const me = (s.run = {});
            // aborted by a history write (a `$url` write, a script's `replaceState`), not by another navigation: the
            // swap goes on, as a page load would; before the URL committed, the navigation again, after (Back) a load
            e.signal.addEventListener('abort', () => setTimeout(() => {
              const l = asked.last as NavigateLike & { navigationType?: string; destination: { sameDocument?: boolean } } | undefined;
              if (s.run !== me || !l?.destination.sameDocument || l.navigationType == 'traverse') return;
              if (location.pathname != s.shown) location.reload();
              else {
                ask(i.to);
                (nav() as unknown as { navigate(u: string, o: object): { finished?: Promise<unknown> } }).navigate(i.to, { history: i.kind == 'replace' ? 'replace' : 'push' }).finished?.catch(() => {});
              }
            }));
            // a load instead, once: before the URL committed, of the URL; after, a reload (its guards were asked)
            const fail = () => {
              s.skip = u.href;
              setTimeout(() => {
                if (location.href == u.href) return location.reload();
                ask(u.href);
                i.kind == 'replace' ? location.replace(u) : location.assign(u);
              });
              throw Error('sinter: loaded instead');
            };
            let p: Promise<Prepared> | undefined;
            // the fetch and the plan before the URL changes where the browser waits (a second click before the page
            // is ready replaces this navigation, as with loads); else in the handler, after it changed
            const ready = () => (p ??= import('./swap-run.js').then((m) => m.prepare(s, i, e.signal)).catch(() => (e.signal.aborted ? null : false)));
            // false: a load instead; null: a newer navigation has the page
            e.intercept({
              scroll: 'manual',
              // focus in a kept element stays there; else the browser resets it, as after a load
              focusReset: document.activeElement?.closest(`[${KEPT}]`) ? 'manual' : 'after-transition',
              // the URL held until the page is ready, where the browser can (one without it ignores the option); none
              // for a traversal (one that cannot swap must not become a new entry), nor for a navigation that cannot
              // be canceled (the browser's own Back without activation)
              ...(i.kind != 'traverse' && e.cancelable ? { async precommitHandler() { if ((await ready()) === false) fail(); } } : {}),
              async handler() {
                const commit = await ready();
                if (commit === false) fail();
                if (commit) await commit();
              },
            });
          },
        };
      }, RANK.swap);
    },
  };
}
