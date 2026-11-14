// Next-page data. When a link to another page of the app is about to be followed (the pointer
// rests on it, a touch or a press starts on it, it gets focus), the data that page loads first is
// requested now, and stored in sessionStorage for it: the next page shows it at once and
// revalidates, as with `cache`. The compiler describes each page (its `data-sn-path` patterns and
// the resources whose request only the URL decides); the build puts every page's description in
// one module, which every page gets.
import type { ResourceDef, UrlTemplate } from './ir.js';
import type { App, Feature } from './runtime/app.js';
import { PREFETCH_MARK, PREFETCH_PREFIX } from './runtime/config.js';
import { clean } from './runtime/store.js';
import { expand, readUrl } from './runtime/url.js';
import type { lists } from './runtime/lists.js';

export { lists } from './runtime/lists.js';

/** One page of the app, as the build describes it. */
export interface PrefetchPage {
  /** path patterns (`/article/:slug`), or the paths the page's file is served at */
  m: string[];
  /** the page's resources whose request only `$url` decides: URL template, `when`, `items`, `total`, `k` for a collection */
  r: Array<{ s: UrlTemplate; w?: number; i: string | null; t: string | null; k?: 1 }>;
  /** the functions the templates index */
  f: Array<(s: any) => any>;
  /** the page's array parameters (`IR.urlArrays`), read as lists */
  a?: string[];
}

/** prefetched data older than this is not shown */
export const MAX_AGE = 30_000;
/** how long the pointer rests on a link (or a link has focus) before its page's data is requested */
export const HOVER = 65;
/** entries larger than this (serialized) are not written */
const MAX_ENTRY = 256 * 1024;

const keyOf = (url: string, items?: string | null, total?: string | null) => PREFETCH_PREFIX + JSON.stringify([url, items, total]);
const pick = (path: string | null | undefined, body: unknown): any => (path ? path.split('.').reduce((x: any, k) => x?.[k], body) : body);
const segments = (p: string) => p.split('/').filter(Boolean);
const matches = (pattern: string, segs: string[]) => {
  const want = segments(pattern);
  return want.length == segs.length && want.every((w, i) => w[0] == ':' || w == segs[i]);
};

/** `l`: `lists`, passed by an app with a page that has array parameters (others carry none of it) */
export function prefetch(pages: PrefetchPage[], l?: typeof lists): Feature {
  return {
    name: 'prefetch',
    install(app: App) {
      const env = app.env, busy = new Set<string>();
      const read = (key: string) => {
        try {
          const v = env.session()?.getItem(key);
          return v ? (JSON.parse(v) as { t: number; items: unknown; total: number | null }) : null;
        } catch { return null; }
      };
      const write = (key: string, items: unknown, total: number | null) => {
        const s = env.session();
        let text: string;
        try { text = JSON.stringify({ t: env.now(), items, total }); } catch { return; }
        if (!s || text.length > MAX_ENTRY) return;
        try { s.setItem(key, text); } catch { /* full: next-page data is a hint, not worth evicting the cache for */ }
      };
      // what an earlier page prefetched and no page took
      try {
        const s = env.session(), old: string[] = [];
        for (let i = 0; s && i < s.length; i++) {
          const k = s.key(i);
          if (k?.startsWith(PREFETCH_PREFIX) && !((env.now() - (read(k)?.t ?? 0)) <= MAX_AGE)) old.push(k);
        }
        for (const k of old) s!.removeItem(k);
      } catch { /* storage failures are ignored */ }

      app.ext.prefetch = {
        take(def: ResourceDef, url: string) {
          const key = keyOf(url, def.items, def.total), e = read(key);
          if (!e) return null;
          try { env.session()?.removeItem(key); } catch { /* ignored */ }
          return env.now() - e.t <= MAX_AGE ? e : null;
        },
      };

      /** requests the data of the page `href` leads to, unless it is this page, another site, or not one of the app's pages */
      const go = (a: HTMLAnchorElement) => {
        // a same-page link stays in the page (query-links.ts): nothing to hand over
        if (app.ext.sameLink?.(a)) return;
        const here = new URL(env.href());
        let u: URL;
        try { u = new URL(a.getAttribute('href')!, here); } catch { return; }
        if (u.origin != here.origin || a.hasAttribute('download') || (a.target && a.target != '_self')) return;
        if (u.pathname == here.pathname && u.search == here.search) return;
        const net = (globalThis as any).navigator?.connection;
        if (net?.saveData || /2g/.test(net?.effectiveType ?? '')) return;
        const segs = segments(u.pathname), page = pages.find((p) => p.m.some((m) => matches(m, segs)));
        if (!page) return;
        const scope = { $url: l && page.a ? l(u.href, page.a, readUrl(u.href, page.m)) : readUrl(u.href, page.m) };
        // resources that read different parts of one response (`items`) share its request, as on the page
        const sent = new Map<string, Promise<unknown>>();
        for (const r of page.r) {
          let url: string;
          try {
            if (r.w != null && !page.f[r.w]!(scope)) continue;
            url = expand(r.s, scope, page.f);
          } catch { continue; }
          const key = keyOf(url, r.i, r.t), had = read(key);
          if (busy.has(key) || (had && env.now() - had.t < MAX_AGE / 3)) continue;
          // data this page has loaded from the same request: handed over, no request
          const own = app.ir.resources.find((d) => !d.paginate && d.items == r.i && d.total == r.t && app.resource(d.name).loader?.url?.() == url && app.resource(d.name).meta.loadedAt != null);
          if (own) { const b = app.resource(own.name).base(); write(key, b.items, b.total); continue; }
          busy.add(key);
          const w = app.req.writes;
          let req = sent.get(url);
          if (!req) sent.set(url, req = app.req.send(url, { priority: 'low', retry: false, headers: { [PREFETCH_MARK]: '1' } }));
          req.then((body) => {
            // a mutation ran meanwhile: the response may predate it
            if (app.req.writing || app.req.writes != w) return;
            let items = pick(r.i, body);
            if (r.k && !Array.isArray(items)) return;
            if (Array.isArray(items)) items = items.map(clean);
            const t = r.t ? pick(r.t, body) : null;
            write(key, items, t == null ? null : +t);
          }, () => {}).finally(() => busy.delete(key));
        }
      };

      let timer: unknown = null, at: Element | null = null;
      const cancel = () => { if (timer != null) env.clearTimeout(timer); timer = null; at = null; };
      const link = (e: Event) => (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      const later = (e: Event) => {
        const a = link(e);
        if (!a || a == at) return;
        cancel();
        at = a;
        timer = env.setTimeout(() => { timer = null; go(a); }, HOVER);
      };
      // a mouse or pen press is a click about to happen: at once. A touch may start a scroll: it waits as
      // a hover does, and the browser's pointercancel (it took the gesture for scrolling) ends the wait
      const press = (e: Event) => {
        if ((e as PointerEvent).pointerType == 'touch') return later(e);
        const a = link(e);
        if (a) { cancel(); go(a); }
      };
      const leave = (e: Event) => { if (at && !at.contains((e as PointerEvent).relatedTarget as Node | null)) cancel(); };
      const on: Array<[string, (e: Event) => void]> = [['pointerover', later], ['focusin', later], ['pointerout', leave], ['focusout', leave], ['pointerdown', press], ['pointercancel', cancel]];
      for (const [type, fn] of on) app.root.addEventListener(type, fn, { passive: true });
      app.addCleanup(() => { cancel(); for (const [type, fn] of on) app.root.removeEventListener(type, fn); });
    },
  };
}
