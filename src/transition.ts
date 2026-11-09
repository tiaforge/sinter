// `data-sn-transition`: the same thing on two pages morphs from one into the other across a
// navigation (cross-document view transitions; the page fade itself is the app's CSS, e.g.
// temper's). Only the pair is named, at the last moment: the element of the followed link's row on
// the old page (`pageswap`), the element with the same name on the new one (`pagereveal`), so a
// list of a thousand rows asks the browser to capture one element, not a thousand. Going back
// works the same way from the one named element of a detail page.
import type { App, Feature } from './runtime/app.js';

const KEY = 'sn:vt';
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

interface SwapEvent extends Event { viewTransition: ViewTransitionLike | null; activation?: { entry?: { url?: string }; navigationType?: string } | null }
interface ViewTransitionLike { finished: Promise<unknown> }

const transition: Feature = {
  name: 'transition',
  install(app: App) {
    const root = app.root, env = app.env;
    let last: Element | null = null;
    const named = () => [...root.querySelectorAll(`[${ATTR}]`)] as HTMLElement[];
    // the class lets the app's CSS style every morph (`::view-transition-group(.sn-transition)`): the names are hashes
    const name = (el: HTMLElement, v: string, vt: ViewTransitionLike) => {
      el.style.viewTransitionName = ident(v);
      el.style.setProperty('view-transition-class', 'sn-transition');
      const off = () => { el.style.viewTransitionName = ''; el.style.removeProperty('view-transition-class'); };
      vt.finished.then(off, off);
    };
    const click = (e: Event) => { last = e.target as Element; };
    root.addEventListener('click', click, true);

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
      const v = el?.getAttribute(ATTR);
      try { v ? env.session()?.setItem(KEY, v) : env.session()?.removeItem(KEY); } catch { /* ignored */ }
      if (el && v) name(el, v, vt);
    };
    const reveal = (e: Event) => {
      const vt = (e as SwapEvent).viewTransition;
      let v: string | null = null;
      try { const s = env.session(); v = s?.getItem(KEY) ?? null; s?.removeItem(KEY); } catch { /* ignored */ }
      // one element only: two with one name would end the transition
      const el = v ? named().find((x) => x.getAttribute(ATTR) == v) : undefined;
      if (vt && el) name(el, v!, vt);
    };
    app.addCleanup(env.listen('pageswap', swap));
    app.addCleanup(env.listen('pagereveal', reveal));
    app.addCleanup(() => root.removeEventListener('click', click, true));
  },
};

export default transition;
