// `data-sn-transition`: the same thing on two pages morphs from one into the other across a
// navigation (cross-document view transitions; the page fade itself is the app's CSS, e.g.
// temper's). Only the pair is named, at the last moment: the element of the followed link's row on
// the old page (`pageswap`), the element with the same name on the new one (`pagereveal`), so a
// list of a thousand rows asks the browser to capture one element, not a thousand. Going back
// works the same way from the one named element of a detail page. A swap (swap-run.ts) fires the
// same two moments as `sn-pageswap` and `sn-pagereveal`, around its same-document transition.
// Page loads get sinter's transition types (`loadTypes`).
import { chain, links } from './links.js';
import { loadTypes } from './vt-types.js';
import type { App, Feature } from './runtime/app.js';

const KEY = 'sn:vt';
/** a pending name older than this is from a navigation that never reached a page with the feature: ignored */
export const PENDING_MAX = 10_000;
const ATTR = 'data-sn-vt';

/** a `<custom-ident>` for any name, the same on both pages */
export const ident = (v: string) => {
  let h = 2166136261;
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619);
  return 'sn-' + (h >>> 0).toString(36);
};

/**
 * The named element of `a`'s row: the first ancestor of `a` that holds any, if it holds exactly one.
 * An ancestor that also holds a link to another URL is past the row: nothing.
 */
const ofRow = (a: Element, els: HTMLElement[]) => {
  const href = a.getAttribute('href');
  for (let p = a.parentElement; p; p = p.parentElement) {
    if ([...p.querySelectorAll('a[href]')].some((x) => x.getAttribute('href') != href)) return undefined;
    const inside = els.filter((x) => p.contains(x));
    if (inside.length) return inside.length == 1 ? inside[0] : undefined;
  }
  return undefined;
};

/** how long a swap's reveal waits for the page's first responses, for a morph whose element renders from them */
export const REVEAL_MAX = 500;

interface SwapEvent extends Event {
  viewTransition: ViewTransitionLike | null;
  activation?: { entry?: { url?: string }; navigationType?: string } | null;
  /** a swap's reveal only (swap-run.ts): the transition's update waits for the promise */
  waitUntil?: (p: Promise<unknown>) => void;
}
interface ViewTransitionLike { finished: Promise<unknown> }

const transition: Feature = {
  name: 'transition',
  install(app: App) {
    const root = app.root, env = app.env;
    const still = () => env.reducedMotion ? env.reducedMotion() : !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let last: Element | null = null;
    const named = () => [...root.querySelectorAll(`[${ATTR}]`)] as HTMLElement[];
    // the class lets the app's CSS style every morph (`::view-transition-group(.sn-transition)`): the names are hashes
    const name = (el: HTMLElement, v: string, vt: ViewTransitionLike) => {
      el.style.viewTransitionName = ident(v);
      el.style.setProperty('view-transition-class', 'sn-transition');
      const off = () => { el.style.viewTransitionName = ''; el.style.removeProperty('view-transition-class'); };
      vt.finished.then(off, off);
    };
    // what started a navigation that goes ahead (a link, the element of a `navigate()` handler): noted,
    // never decided on, so the handlers and the browser go on as without it
    chain(app).onGo.push((i) => { last = i.trigger ?? null; });
    links(app);

    const swap = (e: Event) => {
      const { viewTransition: vt, activation } = e as SwapEvent;
      if (!vt) return;
      const els = named(), a = last?.closest('a[href]');
      let el: HTMLElement | undefined;
      // a followed link: the named element it is in or holds, else the one of its row (nearest common ancestor)
      if (a && activation?.entry?.url == new URL(a.getAttribute('href')!, env.href()).href) {
        el = els.find((x) => x.contains(a) || a.contains(x)) ?? ofRow(a, els);
      } else if (activation?.navigationType == 'traverse' && els.length == 1) el = els[0];
      last = null;
      // less motion asked for: no morph (the page's own fade is its CSS's, which temper turns off too)
      const v = still() ? null : el?.getAttribute(ATTR);
      // with the time: a page without this feature never takes it, and a later page must not act on it
      try { v ? env.session()?.setItem(KEY, JSON.stringify({ v, t: env.now() })) : env.session()?.removeItem(KEY); } catch { /* ignored */ }
      if (el && v) name(el, v, vt);
    };
    const reveal = (e: Event) => {
      const { viewTransition: vt, waitUntil } = e as SwapEvent;
      let v: string | null = null;
      try {
        const s = env.session(), e = JSON.parse(s?.getItem(KEY) ?? 'null') as { v: string; t: number } | null;
        s?.removeItem(KEY);
        if (e && env.now() - e.t <= PENDING_MAX) v = e.v;
      } catch { /* ignored */ }
      // one element only: two with one name would end the transition
      if (still()) v = null;
      const find = () => named().find((x) => x.getAttribute(ATTR) == v);
      if (!vt || !v) return;
      const el = find();
      if (el) return name(el, v, vt);
      // a swap (`waitUntil`): the element may render from the page's first response (an article's title inside
      // its `if`), which the cache or a prefetch did not have; the old page stays shown until it is there, the
      // responses are in, or REVEAL_MAX passed
      const loading = () => app.ir.resources.some((r) => app.resource(r.name).meta.loading);
      if (!waitUntil || !loading()) return;
      waitUntil(new Promise<void>((res) => {
        // (the hook stays, done: the app goes with the next swap)
        let done = 0;
        const check = (end?: 1) => {
          const el = find();
          if (done || (!end && !el && loading())) return;
          done = 1;
          if (el) name(el, v, vt);
          res();
        };
        app.afterFlush.push(() => check());
        env.setTimeout(() => check(1), REVEAL_MAX);
      }));
    };
    for (const p of ['', 'sn-']) {
      app.addCleanup(env.listen(p + 'pageswap', swap));
      app.addCleanup(env.listen(p + 'pagereveal', reveal));
    }
    loadTypes(app);
  },
};

export default transition;
