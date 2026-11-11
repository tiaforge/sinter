// Languages in the URL (`sinter({ localePrefix: true })`, docs/static-pages.md#languages): each page is built
// once per language of the inlang project, under that language's prefix (`/de/about/`), and each unprefixed URL
// (`/about/`, `/`, `/article/:slug`) is a language chooser. This holds the parts that are plain data and HTML:
// the languages, where a page in a language is, the chooser, and the `hreflang` links.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The site's languages: the inlang project's `locales`, its `baseLocale` the default. */
export interface Locales { base: string; list: string[] }

/**
 * The languages for `localePrefix`, from the inlang project's settings. `baseLocale` decides where every
 * visitor without a choice lands, so it must be there and among `locales` (no silent `en`).
 */
export function readLocales(root: string, project = 'project.inlang'): Locales {
  const file = resolve(root, project, 'settings.json');
  if (!existsSync(file)) throw new Error(`sinter({ localePrefix }): no inlang project at ${project}/settings.json: the languages come from it (\`baseLocale\`, \`locales\`)`);
  const s = JSON.parse(readFileSync(file, 'utf8')) as { baseLocale?: unknown; locales?: unknown };
  const list = Array.isArray(s.locales) ? s.locales.filter((l): l is string => typeof l === 'string') : [];
  if (typeof s.baseLocale !== 'string') throw new Error(`sinter({ localePrefix }): ${project}/settings.json has no \`baseLocale\`: it is the language a visitor without a choice is sent to`);
  if (!list.includes(s.baseLocale)) throw new Error(`sinter({ localePrefix }): \`baseLocale\` \`${s.baseLocale}\` is not among \`locales\` (${list.join(', ') || 'none'}) in ${project}/settings.json`);
  for (const l of list) if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l)) throw new Error(`sinter({ localePrefix }): \`${l}\` in \`locales\` is not a language tag (it becomes the URL's prefix, \`/${l}/\`)`);
  return { base: s.baseLocale, list };
}

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
 * base, at the same path under that language's prefix (`/article/hello` → `/de/article/hello`), query and fragment
 * kept. `noindex`: search engines index the languages' pages, which `hreflang` names.
 */
export function chooserHtml(o: { base: string; locales: Locales; fallback: string; urls: Record<string, string> | null; hreflang: string; script: boolean }): string {
  const links = o.locales.list.map((l) => `<a href="${esc(o.urls?.[l] ?? o.base + l + '/')}" hreflang="${esc(l)}">${esc(l)}</a>`).join(' ');
  const js = o.script ? `<script>(function(){var L=${JSON.stringify(o.locales.list)},B=${JSON.stringify(o.base)},c=/(?:^|; )locale=([^;]*)/.exec(document.cookie),f=function(x){if(!x)return;x=decodeURIComponent(x).toLowerCase();for(var i=0;i<L.length;i++)if(L[i].toLowerCase()==x)return L[i];for(i=0;i<L.length;i++)if(L[i].toLowerCase()==x.split("-")[0])return L[i]},l=f(c&&c[1]),n=navigator.languages||[navigator.language];for(var i=0;!l&&i<n.length;i++)l=f(n[i]);l=l||${JSON.stringify(o.locales.base)};var p=location.pathname;location.replace(B+l+"/"+(p.indexOf(B)==0?p.slice(B.length):p.replace(/^\\//,""))+location.search+location.hash)})()</script>\n` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(o.locales.list.join(' · '))}</title>
${js}<meta http-equiv="refresh" content="0; url=${esc(o.fallback)}"><meta name="robots" content="noindex">
  ${o.hreflang}
</head><body>${links}</body></html>
`;
}
