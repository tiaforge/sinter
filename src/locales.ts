// What only the language axis has (docs/proposals/axes.md §4): pure functions over the site's languages, shared by the
// Vite plugin, the compiler and the server layer (`@tiaforge-ui/sinter/server`). Nothing here reads a file; the
// languages themselves come from the content module's `languages()` or the inlang project (`locales-build.ts`).

/**
 * The site's languages: `base`, where a visitor without a choice lands, and every language in `list`; `fallbacks`, a
 * language's chain before the base where it is not the default (`chain`)
 */
export interface Locales {
  base: string; list: string[]; fallbacks?: Record<string, string[]>;
  /** a language's URL segment and output folder where it is not its tag (`{ 'de-AT': 'at' }`) */
  paths?: Record<string, string>;
  /** more tags a visitor may send for a language (`{ no: ['nb', 'nn'] }`): they choose it, and `hreflang` lists them */
  codes?: Record<string, string[]>;
}

/** a language's URL segment and folder: its `paths` entry, else its tag */
export const segmentOf = (locale: string, l: Pick<Locales, 'paths'> | null | undefined): string => l?.paths?.[locale] ?? locale;

/** a site's base as the root of its paths: `/docs/` for `/docs`, and `/` for a relative base (`./`) or none */
export const siteRoot = (base: string | undefined): string => (base?.startsWith('/') ? base.replace(/\/?$/, '/') : '/');

/**
 * Paths under a language's prefix, after the site's base: `/article/:slug` is `/de/article/:slug`, the base itself
 * `/de/`. A path outside the base is left as written.
 */
export function prefixPaths(paths: readonly string[], locale: string, base?: string): string[] {
  const b = siteRoot(base);
  return paths.map((p) => (p.startsWith(b) ? b + locale + (p.length > b.length ? '/' + p.slice(b.length) : '/') : p));
}

/** the language a page's output file is in, from its first folder (`de/about.html` is `de`), or null */
export function languageOfFile(rel: string, list: readonly string[], paths?: Record<string, string>): string | null {
  const first = rel.split('/')[0]!;
  return list.find((l) => (paths?.[l] ?? l) === first) ?? null;
}

/**
 * The visitor's language among the site's (docs/proposals/axes.md §6), from the tags they send in order: for each, the
 * site's language with that tag (any case), else with the tag less its last subtag, one at a time (`zh-Hant-TW`, then
 * `zh-Hant`, then `zh`), else the first site language with the same language part (`de` reaches `de-DE`); else the
 * base. A language's `codes` are tags of it too (`nb` chooses `no`). The chooser page's script (`chooserHtml`),
 * `@tiaforge-ui/sinter/server`, sinter-axum and Sinter.AspNetCore apply this rule, and test/fixtures/choose-cases.json
 * is the cases each runs.
 */
export function chooseLanguage(l: Pick<Locales, 'base' | 'list' | 'codes'>, tags: Iterable<string>): string {
  const find = (x: string) => {
    let p = x.trim().toLowerCase();
    for (;;) {
      const hit = l.list.find((c) => c.toLowerCase() == p || !!l.codes?.[c]?.some((k) => k.toLowerCase() == p));
      if (hit) return hit;
      const j = p.lastIndexOf('-');
      if (j < 0) break;
      p = p.slice(0, j);
    }
    return l.list.find((c) => c.toLowerCase().split('-')[0] == p);
  };
  for (const t of tags) { const v = find(t); if (v) return v; }
  return l.base;
}

/**
 * A language's chain (docs/proposals/axes.md §6): the languages a value missing in it is looked up in, in order, itself
 * first. By default its tag less its last subtag, one at a time, where the site has that language (`de-AT → de`), as
 * BCP 47 lookup does (RFC 4647); `fallbacks` replaces that part. The base always ends it.
 */
export function chain(locale: string, l: Locales): string[] {
  const own = l.fallbacks?.[locale];
  const mid: string[] = [];
  if (own) mid.push(...own);
  else for (let p = locale, j = p.lastIndexOf('-'); j > 0; j = p.lastIndexOf('-')) { p = p.slice(0, j); const hit = l.list.find((c) => c.toLowerCase() == p.toLowerCase()); if (hit) mid.push(hit); }
  return [...new Set([locale, ...mid, l.base])];
}

/** `fallbacks`, checked: each a site language's, naming site languages, without a cycle (an error names what is wrong) */
export function checkFallbacks(l: Locales): string | null {
  for (const [k, v] of Object.entries(l.fallbacks ?? {})) {
    if (!l.list.includes(k)) return `\`fallbacks\` names \`${k}\`, which is not one of the site's languages (${l.list.join(', ')})`;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `\`fallbacks.${k}\` is a list of the site's languages, e.g. \`['de-AT', 'de']\``;
    for (const x of v) {
      if (!l.list.includes(x)) return `\`fallbacks.${k}\` names \`${x}\`, which is not one of the site's languages (${l.list.join(', ')})`;
      if (x === k) return `\`fallbacks.${k}\` names \`${k}\` itself`;
      if (l.fallbacks?.[x]?.includes(k)) return `\`fallbacks.${k}\` and \`fallbacks.${x}\` name each other: a chain has no cycle`;
    }
  }
  return null;
}

/** a request's language tags, in the order they decide: the `locale` cookie the pages record, then `Accept-Language` */
export function requestLanguages(cookie: string | null, acceptLanguage: string | null): string[] {
  const out: string[] = [];
  for (const c of (cookie ?? '').split(';')) { const t = c.trim(); if (t.startsWith('locale=')) out.push(t.slice(7)); }
  for (const p of (acceptLanguage ?? '').split(',')) out.push(p.split(';')[0]!);
  return out;
}

/** the embed manifest's `locales`: the languages, the base their prefixes are under, and their segments and codes */
export const manifestLocales = (l: Locales, base: string): Locales & { at: string } => ({ base: l.base, list: l.list, at: base.replace(/\/?$/, '/'), ...(l.paths ? { paths: l.paths } : {}), ...(l.codes ? { codes: l.codes } : {}) });

const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `<link rel="alternate" hreflang>` for each language's URL of a page, and `x-default` for its unprefixed URL
 * (the chooser); absolute (`origin`), as search engines want them.
 */
export function hreflangTags(origin: string, urls: Record<string, string>, unprefixed: string, codes?: Record<string, string[]>): string {
  return [...Object.entries(urls).flatMap(([l, u]) => [l, ...(codes?.[l] ?? [])].map((t) => `<link rel="alternate" hreflang="${esc(t)}" href="${esc(origin + u)}">`)), `<link rel="alternate" hreflang="x-default" href="${esc(origin + unprefixed)}">`].join('\n  ');
}

/**
 * The page at an unprefixed URL: it sends the visitor to a language. Without scripts (or on a site where no page
 * ships any), to the base language's URL (`fallback`). With `script`, first to the language the site's pages
 * recorded in the `locale` cookie, else the first of `navigator.languages` the site has (`de-AT` is `de`), else the
 * base (`chooseLanguage`'s rule: a tag less its subtags, then `de` for `de-DE`), at the same path under that language's prefix (`/article/hello` →
 * `/de/article/hello`), query and fragment kept. `noindex`: search engines index the languages' pages, which
 * `hreflang` names.
 */
export function chooserHtml(o: { base: string; locales: Locales; fallback: string; urls: Record<string, string> | null; hreflang: string; script: boolean }): string {
  const seg = (l: string) => segmentOf(l, o.locales);
  const links = o.locales.list.map((l) => `<a href="${esc(o.urls?.[l] ?? o.base + seg(l) + '/')}" hreflang="${esc(l)}">${esc(l)}</a>`).join(' ');
  // the rule's tables: each language's codes (`chooseLanguage`) and, for a page at the same path, each one's segment
  const codes = o.locales.codes ? `,K=${JSON.stringify(o.locales.codes)}` : '', segs = o.locales.paths ? `,S=${JSON.stringify(o.locales.paths)}` : '';
  const js = o.script ? `<script>(function(){var L=${JSON.stringify(o.locales.list)},B=${JSON.stringify(o.base)}${codes}${segs},c=/(?:^|; )locale=([^;]*)/.exec(document.cookie),f=function(x){if(!x)return;var p=decodeURIComponent(x).trim().toLowerCase(),i,j;for(;;){for(i=0;i<L.length;i++)if(L[i].toLowerCase()==p${codes ? '||(K[L[i]]||[]).some(function(k){return k.toLowerCase()==p})' : ''})return L[i];j=p.lastIndexOf("-");if(j<0)break;p=p.slice(0,j)}for(i=0;i<L.length;i++)if(L[i].toLowerCase().split("-")[0]==p)return L[i]},l=f(c&&c[1]),n=navigator.languages||[navigator.language];for(var i=0;!l&&i<n.length;i++)l=f(n[i]);l=l||${JSON.stringify(o.locales.base)};${o.urls ? `location.replace(${JSON.stringify(o.urls)}[l]+location.search+location.hash)` : `var p=location.pathname;location.replace(B+${segs ? '(S[l]||l)' : 'l'}+"/"+(p.indexOf(B)==0?p.slice(B.length):p.replace(/^\\//,""))+location.search+location.hash)`}})()</script>\n` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(o.locales.list.join(' · '))}</title>
${js}<meta http-equiv="refresh" content="0; url=${esc(o.fallback)}"><meta name="robots" content="noindex">
  ${o.hreflang}
</head><body>${links}</body></html>
`;
}

/**
 * A URL's literal start in the page's language, when it names one of the site's pages (docs/proposals/axes.md §5): a
 * link template's (`/article/{slug}`), whose values are filled in the browser, and the API's `signIn`. `pages` are the
 * site's page paths as written, without a language (fixed paths, file URLs and patterns: `/about/`, `/article/:slug`).
 * The start names a page when its complete segments match one's, a `:name` matching any, and a last, partial segment
 * starts one of that page's or is a `:name`'s; anything else (an API, a file, another origin, a start already in a
 * language, `/` alone) is left as written.
 */
export function inLanguage(start: string, locale: string, l: Locales, base: string | undefined, pages: readonly string[]): string {
  const segs = siteRoot(base) && start.slice(siteRoot(base).length).split('/');
  if (start.startsWith(siteRoot(base)) && l.list.some((x) => segmentOf(x, l) === segs[0]) && segs.length > 1) return start;
  return inPoint(start, segmentOf(locale, l), base, pages);
}

/**
 * A URL's literal start under a point's prefix (`de/acme`: its language's segment and its axes'), when it names one of
 * the pages there (`pages`, their paths without the prefix): as `inLanguage`, for every axis of the point; a start
 * already under the prefix is left as written
 */
export function inPoint(start: string, prefix: string, base: string | undefined, pages: readonly string[]): string {
  const b = siteRoot(base);
  if (!prefix || !start.startsWith(b) || start.startsWith('//') || start.startsWith(`${b}${prefix}/`)) return start;
  const cut = start.search(/[?#]/), path = cut < 0 ? start : start.slice(0, cut);
  const rest = path.slice(b.length), segs = rest.split('/');
  // the last segment is partial unless the path ends there (a `/`, `?` or `#` after it)
  const partial = cut < 0 && !rest.endsWith('/') ? segs.pop()! : null;
  if (rest.endsWith('/')) segs.pop();
  if (!segs.length && !partial) return start;
  const names = pages.some((p) => {
    if (!p.startsWith(b)) return false;
    const ps = p.slice(b.length).split('/');
    if (ps.at(-1) === '' && ps.length > 1) ps.pop();
    if (ps.length < segs.length + (partial !== null ? 1 : 0)) return false;
    if (cut >= 0 && partial === null && ps.length !== segs.length) return false;
    if (!segs.every((s, i) => ps[i]![0] === ':' || ps[i] === s)) return false;
    return partial === null || ps[segs.length]![0] === ':' || ps[segs.length]!.startsWith(partial);
  });
  return names ? prefixPaths([path], prefix, base)[0]! + start.slice(path.length) : start;
}
