// Page URLs (docs/static-pages.md, step 6 of the proposal): every page with a fixed path is written as a
// directory's index, `about.html` as `about/index.html`, served at `/about/`. This rewrites a built page's
// HTML for that: links to the app's pages become their URL (`/about.html` → `/about/`), and on a page that
// moved one folder down, every other relative URL is rebased so that it still points where it did.
import { posix } from 'node:path';
import { directoryUrl, movesToDirectory, pageUrl } from './prefetch-build.js';

/** One page of the app: its file relative to the root, and its `data-sn-path` patterns. */
export interface PageEntry { rel: string; patterns: string[] }

const rootOf = (base: string) => (base.startsWith('/') ? base.replace(/\/?$/, '/') : '/');
/** a URL the move does not touch: empty, a fragment or query of this page, another scheme or host */
const OUTSIDE = /^(?:$|#|\?|[a-z][a-z\d+.-]*:|\/\/)/i;
const split = (u: string) => { const i = u.search(/[?#]/); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };

/**
 * The page's HTML with its URLs for its place in the output: links (`<a>`, `<area>`) to the app's pages
 * with a fixed path are written as those pages' URLs, root-relative ones root-relative, relative ones
 * relative; and when the page itself moves into a directory, its other relative URLs (`src`, `srcset`,
 * `href`, `action`, `poster`, CSS `url()`, the language picker's files) are rebased to it.
 */
export function relocateHtml(html: string, page: PageEntry, pages: PageEntry[], base: string): string {
  const b = rootOf(base);
  const moved = movesToDirectory(page.rel, base, page.patterns);
  const oldDir = '/' + posix.dirname(page.rel).replace(/^\.$/, '');
  const newDir = moved ? '/' + page.rel.replace(/\.html?$/, '') : oldDir;
  // where each page with a fixed path is, by every path a link may name it with (site paths: from the base)
  const targets = new Map<string, string>();
  for (const p of pages) {
    const url = pageUrl(p.rel, base, p.patterns);
    if (url === null) continue;
    const site = '/' + url.slice(b.length), noExt = '/' + p.rel.replace(/\.html?$/, '');
    for (const k of [site, '/' + p.rel, noExt, noExt + '/']) targets.set(k, site);
    if (/(^|\/)index\.html?$/.test(p.rel)) targets.set(site.replace(/\/?$/, '/'), site);
  }
  const fromDir = (dir: string, to: string) => {
    const r = posix.relative(dir, to.replace(/\/$/, '') || '/');
    return to.endsWith('/') ? (r ? r + '/' : './') : r || '.';
  };
  const url = (u: string, link: boolean): string => {
    const value = u.trim();
    if (OUTSIDE.test(value)) return u;
    const [path, rest] = split(value);
    if (path.startsWith('/')) {
      // root-relative: only a link to a page changes (a page moving does not change where `/x` points)
      if (!link || !path.startsWith(b)) return u;
      const t = targets.get('/' + path.slice(b.length));
      return t ? b + t.slice(1) + rest : u;
    }
    const site = posix.join(oldDir, path);
    const t = link ? targets.get(site) : undefined;
    if (t) return fromDir(newDir, t) + rest;
    return moved ? fromDir(newDir, site) + rest : u;
  };
  const srcset = (v: string) => v.split(',').map((c) => c.replace(/^(\s*)(\S+)/, (_, ws: string, u: string) => ws + url(u, false))).join(',');
  const css = (text: string) => (moved ? text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q: string, u: string) => `url(${q}${url(u, false)}${q})`) : text);
  const decode = (v: string) => v.replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&');
  const encode = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&#34;');
  const tag = (t: string) => {
    const name = /^<([a-zA-Z][\w-]*)/.exec(t)?.[1]?.toLowerCase() ?? '';
    return t.replace(/(\s)(href|src|srcset|poster|action|formaction|data|style|data-sn-i18n)=("([^"]*)"|'([^']*)')/gi, (m, ws: string, attr: string, _q: string, d?: string, s?: string) => {
      const v = d ?? s ?? '', q = d !== undefined ? '"' : "'", a = attr.toLowerCase();
      let out = v;
      if (a === 'href') out = url(v, name === 'a' || name === 'area');
      else if (a === 'srcset') out = moved ? srcset(v) : v;
      else if (a === 'style') out = css(v);
      else if (a === 'data-sn-i18n') {
        if (!moved) return m;
        try {
          const o = JSON.parse(decode(v)) as { files?: Record<string, string> };
          for (const k of Object.keys(o.files ?? {})) o.files![k] = url(o.files![k]!, false);
          out = encode(JSON.stringify(o));
        } catch { return m; }
      } else if (a === 'data' && name !== 'object') return m;
      else out = moved ? url(v, false) : v;
      return `${ws}${attr}=${q}${out}${q}`;
    });
  };
  // the markup's tags; a script's or comment's text is left as it is, a style's `url()`s rebased
  return html.replace(/<!--[\s\S]*?-->|(<script\b[^>]*>)[\s\S]*?<\/script>|(<style\b[^>]*>)([\s\S]*?)<\/style>|<[a-zA-Z][^>]*>/g, (m, script?: string, style?: string, styleText?: string) => {
    if (m.startsWith('<!--')) return m;
    if (script !== undefined) return tag(script) + m.slice(script.length);
    if (style !== undefined) return tag(style) + css(styleText!) + '</style>';
    return tag(m);
  });
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

