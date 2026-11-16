// Swaps (`sinter({ swap: true })`, docs/proposals/swap-navigation.md): a navigation to another page of the
// app fetches that page's HTML (the request a load sends; nothing changes on the server) and swaps its body
// in, keeping the elements both pages name with `data-sn-permanent`; the new page's code mounts in the
// same step. This is the stub every page that swaps carries: it decides, intercepts the browser's
// `navigate` event, and loads the rest (swap-run.ts) when a navigation needs it. Where the browser has no
// Navigation API it does nothing: every navigation stays a page load.
import { RANK, chain } from './links.js';
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

function state(list: SwapPage[]): SwapState {
  const g = globalThis as Record<symbol, SwapState | undefined>;
  if (g[STATE]) return g[STATE]!;
  const s: SwapState = (g[STATE] = {
    list, shown: location.pathname, kept: pageAt(list, location.pathname)?.k ?? [], busy: null, y: new Map(), skip: null,
    // Vite's dev styles come from modules, not from the page
    sheets: new Set(document.head.querySelectorAll('link[rel~=stylesheet],style:not([data-vite-dev-id])')),
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
      if (!nav() || app.root !== document) return;
      const s = state(list), c = chain(app);
      // the position of the entry each navigation leaves (a swap's, a same-page link's, Back's), before
      // another entry is current
      c.onGo.push(() => { track(s); s.at = nav()?.currentEntry?.index; });
      c.add((i: Intent) => {
        if (i.source != 'event') return;
        const e = i.event as NavigateLike, u = new URL(i.to);
        if (u.origin != location.origin || s.skip == u.href) return;
        // a link the page takes out; a traversal within the page shown (its `$url` entries)
        if (i.trigger?.matches('[data-sn-swap=off]') || (i.kind == 'traverse' && u.pathname == s.shown)) return;
        // only to a page the build lists: any other URL is the browser's, requested once
        if (!pageAt(s.list, u.pathname)) return;
        return {
          name: 'swap',
          run: () => {
            // a load instead, once: before the URL committed, of the URL; after, a reload
            const fail = () => {
              s.skip = u.href;
              setTimeout(() => (location.href == u.href ? location.reload() : i.kind == 'replace' ? location.replace(u) : location.assign(u)));
              throw Error('sinter: loaded instead');
            };
            let p: Promise<Prepared> | undefined;
            // the fetch and the plan before the URL changes where the browser waits (a second click before the page
            // is ready replaces this navigation, as with loads); else in the handler, after it changed
            const ready = () => (p ??= import('./swap-run.js').then((m) => m.prepare(s, i, e.signal), () => false as const));
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
