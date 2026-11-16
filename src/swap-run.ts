// The rest of the swap (swap.ts loads it when a navigation needs it; docs/proposals/swap-navigation.md §4,
// §5): the page's HTML fetched and parsed, its page module imported, what both pages keep paired, the head
// planned, then the commit, one synchronous step: the old app destroyed, the body replaced around the kept
// elements, the head's own nodes exchanged, the new page mounted. Anything unexpected is a load instead.
import type { App, Intent } from './runtime/app.js';
import { instance } from './runtime/app.js';
import { vtTypes } from './links.js';
import { KEPT, type Prepared, type SwapState, entry, track } from './swap.js';
import { ident } from './transition.js';

/** a page module with swaps on, as it registers itself (compiler/index.ts): its mount, and the names it keeps */
interface PageModule { boot(): App | Promise<App>; kept: string[] }
/** set while the swap imports page modules: they do not mount themselves */
const SWAPPING = Symbol.for('sinter.swapping');
/** where each page module registers itself, by its URL (compiler/index.ts) */
const PAGES = Symbol.for('sinter.pages');
/** what the next page's code adopts, as from the early script (runtime/app.ts): a list's rows, a branch */
const ROWS = Symbol.for('sinter.early.rows'), BRANCH = Symbol.for('sinter.early');

interface Row { first: Node; nodes: Node[] | null; rbs: Bound[] | null }
interface Bound { el: Node & Record<symbol, unknown>; b: { k: string }; rows?: Row[]; end?: Comment; br?: number }

/**
 * The takeover (§3): the lists and branches the old app rendered inside the kept elements are marked on their
 * anchors as the early script marks what it rendered, so the next page's code adopts their nodes (a playing
 * `<audio>` in a row is not built again) instead of rendering them anew.
 */
export function handOver(rbs: unknown[], kept: Element[]) {
  for (const rb of rbs as Bound[]) {
    const { el, end, rows = [] } = rb, k = rb.b.k, nodes = (r: Row) => r.nodes ?? [r.first];
    if (end && kept.some((x) => x.contains(el))) {
      if (k == 'for') el[ROWS] = { rows: rows.map(nodes), end };
      else if (k == 'if' || k == 'ch') el[BRANCH] = { br: rb.br ?? 0, nodes: rows[0] ? nodes(rows[0]) : [], end };
    }
    for (const r of rows) if (r.rbs) handOver(r.rbs, kept);
  }
}

/**
 * The pairs of kept elements: each name both page modules keep, once on each page (the same element). Only
 * the names the page modules list count, so a marker injected into either page keeps nothing; a listed name
 * twice on the page shown, or not once on the next one, is a load (null).
 */
export function pairs(cur: ParentNode, next: ParentNode, was: string[], now: string[]): Array<[Element, Element]> | null {
  const out: Array<[Element, Element]> = [];
  for (const n of now) {
    if (!was.includes(n)) continue;
    const sel = `[${KEPT}="${n}"]`, a = cur.querySelectorAll(sel), b = next.querySelectorAll(sel);
    if (a.length > 1 || b.length != 1) return null;
    if (a[0]?.localName == b[0]!.localName) out.push([a[0]!, b[0]!]);
  }
  return out;
}

/**
 * The head nodes that belong to the page shown, grouped (an anchor with what it rendered is one group): what
 * the page's code finds by number (numbered from 0 on every page: a `data-sn` element, an anchor, a `sn-t-N`
 * template, embedded data, the messages), and the title. Always the new page's.
 */
export function owned(head: HTMLHeadElement): Node[] {
  const out: Node[] = [], kids = [...head.childNodes];
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i]!;
    if (n.nodeType == 8 && /^sn \d+$/.test((n as Comment).data)) {
      out.push(n);
      for (let depth = 1; depth && ++i < kids.length;) {
        const k = kids[i]!;
        out.push(k);
        if (k.nodeType == 8) depth += /^sn \d+$/.test((k as Comment).data) ? 1 : (k as Comment).data == '/sn' ? -1 : 0;
      }
    } else if (n.nodeType == 1) {
      const el = n as Element;
      if (el.localName == 'title' || el.hasAttribute('data-sn') || el.hasAttribute('data-sn-messages') || (el.localName == 'template' && /^sn-t-/.test(el.id))) out.push(el);
    }
  }
  return out;
}

/** the stylesheets of a head, by what they are: a link's resolved URL, a `<style>`'s text */
const sheets = (els: Iterable<Element>, base: URL) => new Map([...els].flatMap((el): Array<[string, Element]> =>
  el.localName == 'style' ? [['style:' + el.textContent, el]]
  : el.localName == 'link' && /(^|\s)stylesheet(\s|$)/i.test(el.getAttribute('rel') ?? '') && el.hasAttribute('href') ? [[new URL(el.getAttribute('href')!, base).href, el]]
  : []));

/** what only a load applies (a CSP `<meta>`, `<base>`, the language picker): a page that differs here is loaded */
export const fixed = (d: Document, base: URL) => JSON.stringify([
  [...d.querySelectorAll('head meta[http-equiv]')].map((m) => [m.getAttribute('http-equiv')!.toLowerCase(), m.getAttribute('content')]),
  [...d.querySelectorAll('head base[href]')].map((b) => new URL(b.getAttribute('href')!, base).href),
  // the language picker's settings, not its files: each page has its own dictionary files (loaded by `language`)
  [...d.querySelectorAll('script[data-sn-i18n]')].map((x) => { try { const { files: _, ...c } = JSON.parse(x.getAttribute('data-sn-i18n')!); return c; } catch { return x.getAttribute('data-sn-i18n'); } }),
]);

/** the built-in messages' state the picker, the language files and the messages module share (messages.ts) */
interface I18n { locale?: string; files?: Record<string, string>; dicts?: Record<string, Record<string, string>> }

/**
 * Built-in messages: the next page's dictionary for the current language (its language file holds that page's
 * keys) is loaded before it mounts, merged with what the page shown reads until the swap, and its files become
 * the ones `setLocale()` loads.
 */
async function language(doc: Document, base: URL) {
  const tag = doc.querySelector('script[data-sn-i18n]'), g = (globalThis as unknown as Record<symbol, I18n | undefined>)[Symbol.for('sinter.i18n')];
  if (!tag || !g?.locale) return;
  const files: Record<string, string> = {};
  for (const [l, f] of Object.entries((JSON.parse(tag.getAttribute('data-sn-i18n')!) as { files?: Record<string, string> }).files ?? {})) files[l] = new URL(f, base).href;
  const was = g.dicts?.[g.locale], file = files[g.locale];
  if (file) await import(/* @vite-ignore */ file);
  if (g.dicts) g.dicts[g.locale] = { ...was, ...g.dicts[g.locale] };
  g.files = files;
}

/**
 * The head: the title and sinter's own nodes are the new page's; its stylesheets that the page shown lacks go
 * in before the swap (loaded), those of the page shown's HTML that it lacks go at `done()`; styles added at run
 * time stay. Everything else (metas, links, scripts) stays as the first page had it: crawlers and link
 * previews load each page. Inserted styles get the document's nonce (`<meta name="csp-nonce">`): the policy
 * is the first page's. null: what only a load applies differs.
 */
export function heads(s: SwapState, doc: Document, base: URL): { ready: Promise<unknown>; done(): void; undo(): void } | null {
  const here = new URL(location.href);
  if (fixed(document, here) != fixed(doc, base)) return null;
  const nonce = document.querySelector<HTMLMetaElement>('meta[name=csp-nonce]')?.content;
  const old = owned(document.head), have = sheets(s.sheets, here), keep = new Set<Element>(), added: Element[] = [], loads: Promise<unknown>[] = [];
  const add = (n: Node) => {
    const x = document.adoptNode(n) as Element;
    if (x.localName == 'link') x.setAttribute('href', new URL(x.getAttribute('href')!, base).href);
    if (nonce && (x.localName == 'link' || x.localName == 'style')) (x as HTMLStyleElement).nonce = nonce;
    document.head.append(x);
    return x;
  };
  for (const [k, el] of sheets(doc.head.children, base)) {
    const same = have.get(k);
    if (same) { keep.add(same); continue; }
    const x = add(el) as HTMLLinkElement;
    added.push(x);
    if (x.localName == 'link') loads.push(new Promise((r) => { x.onload = x.onerror = r; }));
  }
  const own = owned(doc.head).map(add);
  return {
    ready: Promise.all(loads),
    done: () => {
      for (const n of old) (n as ChildNode).remove();
      for (const el of s.sheets) if (!keep.has(el)) el.remove();
      s.sheets = new Set([...keep, ...added]);
    },
    undo: () => { for (const n of [...added, ...own]) (n as ChildNode).remove(); },
  };
}

/**
 * Whether the app's stylesheets ask for transitions between pages: an `@view-transition` rule with
 * `navigation: auto` whose `@media` conditions hold, as a load would. Where the rule cannot be read (Firefox,
 * which runs no transitions between documents either) or a sheet is another origin's: no.
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
    try { if (!sheet.disabled && walk(sheet.cssRules)) return true; } catch { /* another origin's */ }
  }
  return false;
}

/** moves the kept element `o` to where `n` is, keeping what a move would reset (without `moveBefore`: scroll, focus, selection) */
function keepAt(o: Element, n: Element) {
  const p = n.parentNode as Element & { moveBefore?: (a: Node, b: Node | null) => void };
  if (p.moveBefore && p.isConnected && o.isConnected) p.moveBefore(o, n);
  else {
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

/** fetch, plan, prepare (§5): the commit, which needs no network, or false (a load instead) or null (aborted) */
export async function prepare(s: SwapState, i: Intent, signal?: AbortSignal): Promise<Prepared> {
  const url = new URL(i.to);
  s.busy?.abort();
  const c = (s.busy = new AbortController()), no = () => (c.signal.aborted ? null : false);
  signal?.addEventListener('abort', () => c.abort());
  // fetch: the request a load sends
  let res: Response, html: string;
  try {
    res = await fetch(url, { headers: { accept: 'text/html' }, signal: c.signal, credentials: 'same-origin' });
    html = await res.text();
  } catch { return no(); }
  if (c.signal.aborted) return null;
  // a response's URL has no fragment: the link's stays
  const final = new URL(res.url || url.href);
  if (!final.hash) final.hash = url.hash;
  if (!res.ok || final.origin != location.origin || !/^text\/html\b/.test(res.headers.get('content-type') ?? '')) return false;
  // plan: declarative shadow DOM attached where the parser can (Chromium's drops comments, sinter's anchors,
  // unless it is given a configuration: e2e/permanent/navigation-api/parse.cjs); `<noscript>` would be live
  // (the parse runs without scripting)
  // under a nonce policy, the page's own nonces become the document's before the parse: Chromium reports the
  // parsed page's inline styles against the document's policy (navigation-api/parse-csp.cjs), and they are
  // inserted with the document's nonce anyway
  const nonce = document.querySelector<HTMLMetaElement>('meta[name=csp-nonce]')?.content;
  if (nonce) html = html.replace(/(<(?:style|script|link)\b[^>]*?\snonce=)("[^"]*"|'[^']*'|[^\s>]+)/gi, (_, a: string) => `${a}"${nonce.replace(/"/g, '&quot;')}"`);
  const P = Document as unknown as { parseHTMLUnsafe?: (h: string, o: object) => Document };
  const doc = P.parseHTMLUnsafe ? P.parseHTMLUnsafe(html, { sanitizer: {} }) : new DOMParser().parseFromString(html, 'text/html');
  if (doc.body.hasAttribute('data-sn-failed') || doc.documentElement.getAttribute('data-sn-swap') == 'off') return false;
  for (const n of doc.querySelectorAll('noscript')) n.remove();
  // the next page's dictionary, then its page module (with the app's other modules: each runs once per
  // document), imported without mounting
  try { await language(doc, final); } catch { return no(); }
  const g = globalThis as unknown as Record<symbol, number>;
  let page: PageModule | undefined;
  g[SWAPPING] = (g[SWAPPING] ?? 0) + 1;
  try {
    const urls = [...doc.querySelectorAll('script[type=module][src]')].map((x) => new URL(x.getAttribute('src')!, final).href);
    await Promise.all(urls.map((u) => import(/* @vite-ignore */ u)));
    const pages = (globalThis as unknown as Record<symbol, Record<string, PageModule> | undefined>)[PAGES] ?? {};
    page = urls.map((u) => pages[u]).find(Boolean);
  } catch { return no(); }
  finally { g[SWAPPING]--; }
  if (!page || c.signal.aborted) return no();
  const kept = pairs(document, doc, s.kept, page.kept);
  if (!kept) return false;
  // prepare: the head's new stylesheets loaded
  const head = heads(s, doc, final);
  if (!head) return false;
  await head.ready;
  if (c.signal.aborted) { head.undo(); return null; }

  return async () => {
    let committed = false, booted: App | Promise<App> | undefined, failed = false;
    const commit = () => {
      // a newer navigation came while the transition waited for this callback: it has the page
      if (c.signal.aborted) return;
      committed = true;
      // the browser made the entry (`intercept()`); a redirect gives it another URL
      if (final.href != location.href) history.replaceState(history.state, '', final.href);
      try {
        const old = instance(document);
        handOver(old.rbs, kept.map(([o]) => o));
        old.destroy();
      } catch { /* not mounted */ }
      // the new content goes in after the old, in this one task: nothing is painted in between, and a playing
      // media element moved within a task does not pause
      const body = document.body, old = [...body.childNodes], stay = new Set<Node>(kept.map(([o]) => o));
      body.append(...[...doc.body.childNodes].map((n) => document.adoptNode(n)));
      for (const [o, n] of kept) keepAt(o, n);
      for (const n of old) if (!stay.has(n)) n.remove();
      head.done();
      // the body's and <html>'s own attributes
      for (const [from, to] of [[doc.body, body], [doc.documentElement, document.documentElement]] as const) {
        for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
        for (const a of from.attributes) to.setAttribute(a.name, a.value);
      }
      s.shown = final.pathname;
      s.kept = page!.kept;
      if (i.kind != 'traverse' && final.hash) document.getElementById(decodeURIComponent(final.hash.slice(1)))?.scrollIntoView();
      else scrollTo(0, i.kind == 'traverse' ? s.y.get(entry()) ?? 0 : 0);
      track(s);
      // the title, announced as a load would
      const live = (s.live ??= document.createElement('div'));
      live.setAttribute('role', 'status');
      live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
      live.textContent = '';
      body.append(live);
      setTimeout(() => { live.textContent = document.title; }, 100);
      // mount: the new page's code, in the same step
      try { booted = page!.boot(); } catch { failed = true; }
      return booted;
    };
    type VT = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void> };
    const vt = wanted() ? (document as Document & { startViewTransition?: (o: { update: () => unknown; types: string[] }) => VT }).startViewTransition : undefined;
    if (vt) {
      // the moments of a load's transition, for morphs (transition.ts): the page left before its snapshot,
      // the next once it is mounted; each kept element named, so it stays still while the page changes
      const activation = { navigationType: i.kind, entry: { url: final.href, index: i.index } }, none = () => {};
      const moment = (n: string) => dispatchEvent(Object.assign(new Event(n), { viewTransition: t, activation }));
      // a transition another navigation skips rejects all three: nothing to report
      const t: VT = vt.call(document, { update: async () => { commit(); if (committed) { await Promise.resolve(booted).catch(none); moment('sn-pagereveal'); } }, types: vtTypes(i.kind, s.at, i.index) });
      t.ready.catch(none);
      const named = kept.map(([o]) => o as HTMLElement);
      for (const el of named) {
        el.style.viewTransitionName = ident('keep ' + el.getAttribute(KEPT));
        el.style.setProperty('view-transition-class', 'sn-keep');
      }
      const off = () => { for (const el of named) { el.style.viewTransitionName = ''; el.style.removeProperty('view-transition-class'); } };
      t.finished.then(off, off);
      moment('sn-pageswap');
      await t.updateCallbackDone.catch(none);
    } else commit();
    if (!committed) { head.undo(); return; }
    // a page that did not mount is loaded, rather than left unbound
    let app: App | undefined;
    try { app = await booted; } catch { failed = true; }
    if (failed || !app) { location.reload(); return; }
    document.dispatchEvent(new CustomEvent('sn-page', { detail: { from: i.from, to: final.href, kind: i.kind } }));
    // Back and Forward: what renders above the position once the page's first data is there moves the content
    // (scroll anchoring keeps the wrong part in view): set again then, at most a second later
    if (i.kind == 'traverse') {
      const key = entry(), y = s.y.get(key);
      for (let t = 0; t < 40 && app.ir.resources.some((r) => app!.resource(r.name).meta.loading); t++) await new Promise((r) => setTimeout(r, 25));
      if (y != null && !c.signal.aborted && entry() === key) scrollTo(0, y);
    }
  };
}
