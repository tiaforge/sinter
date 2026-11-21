// What only the language axis has (docs/proposals/axes.md §4): pure functions over the site's languages, shared by the
// Vite plugin, the compiler and the server layer (`@tiaforge-ui/sinter/server`). Nothing here reads a file; the
// languages themselves come from the content module's `languages()` or the inlang project (`locales-build.ts`).

/** The site's languages: `base`, where a visitor without a choice lands, and every language in `list`. */
export interface Locales { base: string; list: string[] }

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
export function languageOfFile(rel: string, list: readonly string[]): string | null {
  const first = rel.split('/')[0]!;
  return list.includes(first) ? first : null;
}

/**
 * The visitor's language among the site's, from the tags they send in order: for each, the site's language with that
 * tag (any case), else the one with its language part (`de-AT` is `de`); else the base. The chooser page's script
 * (`chooserHtml`) and the server layers apply the same rule.
 */
export function chooseLanguage(l: Locales, tags: Iterable<string>): string {
  const find = (x: string) => {
    x = x.trim().toLowerCase();
    return l.list.find((c) => c.toLowerCase() == x) ?? l.list.find((c) => c.toLowerCase() == x.split('-')[0]);
  };
  for (const t of tags) { const v = find(t); if (v) return v; }
  return l.base;
}

/** a request's language tags, in the order they decide: the `locale` cookie the pages record, then `Accept-Language` */
export function requestLanguages(cookie: string | null, acceptLanguage: string | null): string[] {
  const out: string[] = [];
  for (const c of (cookie ?? '').split(';')) { const t = c.trim(); if (t.startsWith('locale=')) out.push(t.slice(7)); }
  for (const p of (acceptLanguage ?? '').split(',')) out.push(p.split(';')[0]!);
  return out;
}

/** the embed manifest's `locales`: the languages and the base their prefixes are under */
export const manifestLocales = (l: Locales, base: string): Locales & { at: string } => ({ ...l, at: base.replace(/\/?$/, '/') });

const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `<link rel="alternate" hreflang>` for each language's URL of a page, and `x-default` for its unprefixed URL
 * (the chooser); absolute (`origin`), as search engines want them.
 */
export function hreflangTags(origin: string, urls: Record<string, string>, unprefixed: string): string {
  return [...Object.entries(urls).map(([l, u]) => `<link rel="alternate" hreflang="${esc(l)}" href="${esc(origin + u)}">`), `<link rel="alternate" hreflang="x-default" href="${esc(origin + unprefixed)}">`].join('\n  ');
}

/**
 * The page at an unprefixed URL: it sends the visitor to a language. Without scripts (or on a site where no page
 * ships any), to the base language's URL (`fallback`). With `script`, first to the language the site's pages
 * recorded in the `locale` cookie, else the first of `navigator.languages` the site has (`de-AT` is `de`), else the
 * base (`chooseLanguage`'s rule), at the same path under that language's prefix (`/article/hello` →
 * `/de/article/hello`), query and fragment kept. `noindex`: search engines index the languages' pages, which
 * `hreflang` names.
 */
export function chooserHtml(o: { base: string; locales: Locales; fallback: string; urls: Record<string, string> | null; hreflang: string; script: boolean }): string {
  const links = o.locales.list.map((l) => `<a href="${esc(o.urls?.[l] ?? o.base + l + '/')}" hreflang="${esc(l)}">${esc(l)}</a>`).join(' ');
  const js = o.script ? `<script>(function(){var L=${JSON.stringify(o.locales.list)},B=${JSON.stringify(o.base)},c=/(?:^|; )locale=([^;]*)/.exec(document.cookie),f=function(x){if(!x)return;x=decodeURIComponent(x).toLowerCase();for(var i=0;i<L.length;i++)if(L[i].toLowerCase()==x)return L[i];for(i=0;i<L.length;i++)if(L[i].toLowerCase()==x.split("-")[0])return L[i]},l=f(c&&c[1]),n=navigator.languages||[navigator.language];for(var i=0;!l&&i<n.length;i++)l=f(n[i]);l=l||${JSON.stringify(o.locales.base)};${o.urls ? `location.replace(${JSON.stringify(o.urls)}[l]+location.search+location.hash)` : `var p=location.pathname;location.replace(B+l+"/"+(p.indexOf(B)==0?p.slice(B.length):p.replace(/^\\//,""))+location.search+location.hash)`}})()</script>\n` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(o.locales.list.join(' · '))}</title>
${js}<meta http-equiv="refresh" content="0; url=${esc(o.fallback)}"><meta name="robots" content="noindex">
  ${o.hreflang}
</head><body>${links}</body></html>
`;
}
