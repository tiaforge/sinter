// Page URLs (docs/static-pages.md, step 6 of the proposal): every page with a fixed path is written as a
// directory's index, `about.html` as `about/index.html`, served at `/about/`. This rewrites a built page's
// HTML for that: links to the app's pages become their URL (`/about.html` → `/about/`), and on a page that
// moved one folder down, every other relative URL is rebased so that it still points where it did.
import { posix } from 'node:path';
import { directoryUrl, movesToDirectory, pageUrl } from './prefetch-build.js';
import { languageOfFile } from './locales.js';

/** One page of the app: its file relative to the root, and its `data-sn-path` patterns. */
export interface PageEntry { rel: string; patterns: string[] }

const rootOf = (base: string) => (base.startsWith('/') ? base.replace(/\/?$/, '/') : '/');
/** a URL the move does not touch: empty, a fragment or query of this page, another scheme or host */
const OUTSIDE = /^(?:$|#|\?|[a-z][a-z\d+.-]*:|\/\/)/i;
const split = (u: string) => { const i = u.search(/[?#]/); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };

/**
 * Rewrites the URLs in a page's HTML: each `href` of a tag through `url(value, link)` (`link`: on an `<a>` or
 * `<area>`), and with `all`, every other URL too (`src`, `srcset`, `action`, `formaction`, `poster`,
 * `<object data>`, CSS `url()` in `style` and `<style>`, the language picker's files). A script's text and a
 * comment are left as they are; so is a link with `hreflang`, which names a language on purpose.
 */
function rewriteUrls(html: string, url: (u: string, link: boolean, at?: Map<string, string>) => string, all: boolean, marks = false): string {
  const srcset = (v: string) => v.split(',').map((c) => c.replace(/^(\s*)(\S+)/, (_, ws: string, u: string) => ws + url(u, false))).join(',');
  const css = (text: string) => (all ? text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q: string, u: string) => `url(${q}${url(u, false)}${q})`) : text);
  const decode = (v: string) => v.replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&');
  const encode = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&#34;');
  const tag = (t0: string) => {
    const name = /^<([a-zA-Z][\w-]*)/.exec(t0)?.[1]?.toLowerCase() ?? '';
    // the compiler's mark on a link in a row of a loop over an axis list (`data-sinter-pt`): read, and removed
    let at: Map<string, string> | undefined;
    const t = marks && (name === 'a' || name === 'area') && t0.includes(' data-sinter-pt=') ? t0.replace(/\sdata-sinter-pt="([^"]*)"/, (_, v: string) => {
      const w = v.split(' ');
      at = new Map(w.flatMap((x, i) => (i % 2 ? [] : [[decodeURIComponent(x), decodeURIComponent(w[i + 1] ?? '')] as [string, string]])));
      return '';
    }) : t0;
    const link = (name === 'a' || name === 'area') && !/\shreflang=/i.test(t);
    return t.replace(/(\s)(href|src|srcset|poster|action|formaction|data|style|data-sn-i18n)=("([^"]*)"|'([^']*)')/gi, (m, ws: string, attr: string, _q: string, d?: string, sq?: string) => {
      const v = d ?? sq ?? '', q = d !== undefined ? '"' : "'", a = attr.toLowerCase();
      let out = v;
      if (a === 'href') {
        if ((name === 'a' || name === 'area') && !link) return m;
        out = url(v, link, at);
      } else if (!all) return m;
      else if (a === 'srcset') out = srcset(v);
      else if (a === 'style') out = css(v);
      else if (a === 'data-sn-i18n') {
        try {
          const o = JSON.parse(decode(v)) as { files?: Record<string, string> };
          for (const k of Object.keys(o.files ?? {})) o.files![k] = url(o.files![k]!, false);
          out = encode(JSON.stringify(o));
        } catch { return m; }
      } else if (a === 'data' && name !== 'object') return m;
      else out = url(v, false);
      return `${ws}${attr}=${q}${out}${q}`;
    });
  };
  return html.replace(/<!--[\s\S]*?-->|(<script\b[^>]*>)[\s\S]*?<\/script>|(<style\b[^>]*>)([\s\S]*?)<\/style>|<[a-zA-Z][^>]*>/g, (m, script?: string, style?: string, styleText?: string) => {
    if (m.startsWith('<!--')) return m;
    if (script !== undefined) return tag(script) + m.slice(script.length);
    if (style !== undefined) return tag(style) + css(styleText!) + '</style>';
    return tag(m);
  });
}

/** `to` as a URL relative to the folder `dir` (both site paths), keeping a trailing slash */
const fromDir = (dir: string, to: string) => {
  const r = posix.relative(dir, to.replace(/\/$/, '') || '/');
  return to.endsWith('/') ? (r ? r + '/' : './') : r || '.';
};

/**
 * The HTML of a page written from the folder `from` (a site path: `/`, `/blog`) into the folder `to`, with
 * every relative URL rebased so that it points where it did (a page built once per language: `/` → `/de`).
 */
export function rebaseHtml(html: string, from: string, to: string): string {
  if (from === to) return html;
  return rewriteUrls(html, (u) => {
    const value = u.trim();
    if (OUTSIDE.test(value) || value.startsWith('/')) return u;
    const [path, rest] = split(value);
    return fromDir(to, posix.join(from, path)) + rest;
  }, true);
}

/**
 * The page's HTML with its URLs for its place in the output: links (`<a>`, `<area>`) to the app's pages
 * with a fixed path are written as those pages' URLs, root-relative ones root-relative, relative ones
 * relative; and when the page itself moves into a directory, its other relative URLs are rebased to it.
 * With `locales`, a page in a language (`de/about.html`) links to that language's pages: `/about.html` is
 * `/de/about/`; with `prefix`, a point's folder (`de/acme`: a language and an axis's value), to that folder's pages, which
 * a link names first.
 */
export function relocateHtml(html: string, page: PageEntry, pages: PageEntry[], base: string, locales: string[] = [], prefix?: string | null, other?: OtherPoint): string {
  const b = rootOf(base);
  const moved = movesToDirectory(page.rel, base, page.patterns);
  const oldDir = '/' + posix.dirname(page.rel).replace(/^\.$/, '');
  const newDir = moved ? '/' + page.rel.replace(/\.html?$/, '') : oldDir;
  // the page's point's folder (`de`, `de/acme`): given, else its language from its first folder
  const lang = prefix !== undefined ? prefix : languageOfFile(page.rel, locales);
  const targets = targetsOf(pages, base, lang);
  return relocateWith(html, page, base, locales, b, moved, oldDir, newDir, lang, targets, other);
}

/**
 * A link the page's own pages do not have (`pages`): a page at another point (docs/proposals/axes.md §5), given the
 * link's site path (from the base) and the entries of the axis lists the link's row names (`data-sinter-pt`): its site
 * path, an absolute URL (another origin's page), or null to leave the link as written. It throws for a link the page
 * cannot derive.
 */
export type OtherPoint = (site: string, at: Map<string, string> | null) => string | null;

/**
 * where each page with a fixed path is, by every path a link may name it with (site paths: from the base): one map
 * per list of pages, base and language, since every page of a build is relocated over the same list (built per page,
 * it grew with the square of the pages)
 */
const targetsKept = new WeakMap<PageEntry[], Map<string, Map<string, string>>>();
function targetsOf(pages: PageEntry[], base: string, lang: string | null): Map<string, string> {
  const k = `${base}\0${lang ?? ''}`;
  let byKey = targetsKept.get(pages);
  if (!byKey) targetsKept.set(pages, (byKey = new Map()));
  const kept = byKey.get(k);
  if (kept) return kept;
  const b = rootOf(base);
  const targets = new Map<string, string>();
  const add = (k: string, site: string) => { if (!targets.has(k)) targets.set(k, site); };
  const keysOf = (p: PageEntry) => {
    const url = pageUrl(p.rel, base, p.patterns);
    if (url === null) return null;
    const site = '/' + url.slice(b.length), noExt = '/' + p.rel.replace(/\.html?$/, '');
    const keys = [site, '/' + p.rel, noExt, noExt + '/'];
    if (/(^|\/)index\.html?$/.test(p.rel)) keys.push(site.replace(/\/?$/, '/'));
    return { site, keys };
  };
  // the page's folder (its language, its axes' values): its pages also by their paths without it, before any other
  // page's (a page outside the folder at the same path, `/about/` beside `/acme/about/`)
  // then the folders around it, nearest first: a page outside an axis is its language's (`de/acme`, then `de`)
  const folders = lang ? lang.split('/').map((_, i, a) => a.slice(0, a.length - i).join('/')) : [];
  for (const f of folders) for (const p of pages) {
    const k = keysOf(p);
    if (k && p.rel.startsWith(f + '/')) for (const x of k.keys) if (x.startsWith(`/${f}/`) || x === `/${f}`) add(x.slice(f.length + 1) || '/', k.site);
  }
  for (const p of pages) { const k = keysOf(p); if (k) for (const x of k.keys) add(x, k.site); }
  byKey.set(k, targets);
  return targets;
}

function relocateWith(html: string, page: PageEntry, base: string, locales: string[], b: string, moved: boolean, oldDir: string, newDir: string, lang: string | null, targets: Map<string, string>, other?: OtherPoint): string {
  // a link's target: a row's entry's page first, then the page's own pages, then another point's
  const target = (site: string, at?: Map<string, string>) => (other && at?.size ? other(site, at) : null) ?? targets.get(site) ?? (other ? other(site, null) : null);
  const absolute = (t: string) => /^[a-z][a-z\d+.-]*:/i.test(t);
  return rewriteUrls(html, (u, link, at) => {
    const value = u.trim();
    if (OUTSIDE.test(value)) return u;
    const [path, rest] = split(value);
    if (path.startsWith('/')) {
      // root-relative: only a link to a page changes (a page moving does not change where `/x` points)
      if (!link || !path.startsWith(b)) return u;
      const t = target('/' + path.slice(b.length), at);
      return t ? (absolute(t) ? t : b + t.slice(1)) + rest : u;
    }
    const site = posix.join(oldDir, path);
    const t = link ? target(site, at) : undefined;
    if (t) return (absolute(t) ? t : fromDir(newDir, t)) + rest;
    return moved ? fromDir(newDir, site) + rest : u;
  }, moved, true);
}

/**
 * The file written where a moved page was (`about.html`): it sends the visitor and search engines to the
 * page's URL. A script keeps the query and fragment (`/task.html?id=3` → `/task/?id=3`, a link built at run
 * time); without scripts, the refresh goes to the URL alone.
 */
export function redirectHtml(to: string): string {
  const u = to.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  const js = JSON.stringify(to).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Moved</title>
<script>location.replace(${js} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${u}"><link rel="canonical" href="${u}"><meta name="robots" content="noindex">
</head><body><a href="${u}">${u}</a></body></html>
`;
}

/**
 * The page files each page module's code names at their old URL (SN521): `<quote><prefix>/<file>`, the file not
 * followed by a word character, `/` or `-`, which is `` new RegExp(`['"\`]${prefix}/${file}(?![\w/-])`) `` (escaped)
 * tested on each code for each file. By file, the codes that name it, in the order given; one pass over each code
 * instead of a pattern built and run per file and code (a page file per post moves every page: n² before).
 */
export function filesNamed(files: readonly string[], codes: ReadonlyArray<readonly [string, string]>, prefix: string): Map<string, string[]> {
  const want = new Set(files);
  let longest = 0;
  for (const f of files) longest = Math.max(longest, f.length);
  const lead = `${prefix}/`, out = new Map<string, string[]>();
  for (const [from, code] of codes) {
    const found = new Set<string>();
    for (let i = 0; i < code.length; i++) {
      const c = code.charCodeAt(i);
      if ((c !== 39 && c !== 34 && c !== 96) || !code.startsWith(lead, i + 1)) continue;
      const s = i + 1 + lead.length, end = Math.min(code.length, s + longest);
      for (let k = s + 1; k <= end; k++) {
        if (k < code.length && /[\w/-]/.test(code[k]!)) continue;
        const f = code.slice(s, k);
        if (!want.has(f) || found.has(f)) continue;
        found.add(f);
        let list = out.get(f);
        if (!list) out.set(f, (list = []));
        list.push(from);
      }
    }
  }
  return out;
}

/**
 * One rule of the site's URLs: `301` sends an old file URL to the page's URL; `200` serves a page's file
 * at a path it declares (`data-sn-path`). `file` is the page's file in the output, for a server that
 * rewrites to it (sinter-axum, `vite preview`); `to` is the path a host serves that file at.
 */
export interface Route { from: string; to: string; status: 301 | 200; file?: string }

const bare = (p: string) => p.replace(/\/+$/, '') || '/';

/**
 * The rules for every page (docs/static-pages.md#page-urls): a 301 from a moved page's file URL
 * (`/about.html`) to its URL (`/about/`), and a 200 rewrite from each path a page declares to its file,
 * except the path a host serves the file at anyway (`/login` for `login.html`). Fixed paths first, then
 * patterns (hosts read them in order, and Cloudflare Pages counts them apart).
 */
export function pageRoutes(pages: PageEntry[], base: string): Route[] {
  const b = rootOf(base), out: Route[] = [];
  for (const p of pages) {
    if (movesToDirectory(p.rel, base, p.patterns)) { out.push({ from: b + p.rel, to: directoryUrl(p.rel, base), status: 301 }); continue; }
    const index = /(^|\/)index\.html?$/.exec(p.rel);
    // where a host serves the file without a rule: `/login` for login.html, `/docs/` for docs/index.html
    const natural = index ? b + p.rel.slice(0, index.index + index[1]!.length) : b + p.rel.replace(/\.html?$/, '');
    for (const path of p.patterns) {
      if (bare(path) === bare(natural)) continue;
      out.push({ from: path, to: natural, status: 200, file: p.rel });
    }
  }
  const dynamic = (r: Route) => /[:*]/.test(r.from);
  return [...out.filter((r) => !dynamic(r)), ...out.filter(dynamic)];
}

/** `_redirects` (Netlify, Cloudflare Pages): the app's own rules first, then the pages' */
export function redirectsFile(routes: Route[], own: string | null): string {
  const lines = routes.map((r) => `${r.from}  ${r.to}  ${r.status}`);
  return `${own ? own.replace(/\s*$/, '\n\n') : ''}# written by sinter: the pages' URLs (docs/static-pages.md#page-urls)\n${lines.join('\n')}\n`;
}

