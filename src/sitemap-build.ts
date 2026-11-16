// The sitemap (`sinter({ site })`, docs/static-pages.md#sitemap): every page a search engine should index, at the URL
// its canonical link names, with its languages as alternates. The build knows those URLs (page-urls.ts, the
// languages, the canonical links); this holds the parts that are plain data and XML: what a page's HTML says about
// being indexed, a pattern filled with values, and the files.

/** A value for a page whose path has parameters: its parameters by name, or one string for a pattern with one parameter. */
export type SitemapParams = string | Record<string, string>;

export interface SitemapOptions {
  /**
   * Values for the pages whose path has parameters, by the pattern as `data-sn-path` writes it
   * (`'/article/:slug'`): a list, or a function the build calls once (it may be async, to ask an API).
   * Each value fills the pattern's parameters; a pattern with none of these is left out of the sitemap.
   */
  paths?: Record<string, SitemapParams[] | (() => SitemapParams[] | Promise<SitemapParams[]>)>;
}

/** One `<url>` of the sitemap: its URL, and with languages each language's URL and the chooser's (`x-default`). */
export interface SitemapUrl { loc: string; alternates?: Record<string, string> }

/** The sitemap protocol's limit per file: more URLs are split into files under a sitemap index. */
export const SITEMAP_LIMIT = 50_000;

/** `sinter({ sitemap })`, checked: `false`, or `{ paths }` with a list or a function per pattern. */
export function sitemapOf(o: unknown, site: string | null): false | SitemapOptions {
  if (o === false) return false;
  if (o == null || o === true) return {};
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('sinter({ sitemap }): takes `false` or `{ paths }`, e.g. `sitemap: { paths: { \'/article/:slug\': () => slugs() } }`');
  const extra = Object.keys(o).filter((k) => k !== 'paths');
  if (extra.length) throw new Error(`sinter({ sitemap }): no option \`${extra[0]}\`; it takes \`paths\``);
  const paths = (o as SitemapOptions).paths;
  if (paths != null) {
    if (typeof paths !== 'object' || Array.isArray(paths)) throw new Error('sinter({ sitemap: { paths } }): takes an object from a pattern to its values, e.g. `{ \'/article/:slug\': () => slugs() }`');
    for (const [k, v] of Object.entries(paths)) {
      if (!k.startsWith('/') || !/\/:/.test(k)) throw new Error(`sinter({ sitemap: { paths } }): \`${k}\` is not a pattern with parameters; name a page's \`data-sn-path\` pattern, e.g. \`/article/:slug\` (pages with a fixed path are in the sitemap already)`);
      if (!Array.isArray(v) && typeof v !== 'function') throw new Error(`sinter({ sitemap: { paths } }): \`${k}\` takes a list of values or a function that returns one`);
    }
  }
  if (site === null && Object.keys(paths ?? {}).length) throw new Error('sinter({ sitemap }): a sitemap names absolute URLs, so it needs the site\'s origin: add `site: \'https://…\'`');
  return { ...(paths ? { paths } : {}) };
}

/** The parameter names of a pattern, in order: `['slug']` for `/article/:slug`. */
export const patternParams = (pattern: string) => pattern.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));

/** A pattern with one value's parameters, each encoded as a path segment; an error message for a value that does not fit. */
export function fillPattern(pattern: string, value: unknown): string | { error: string } {
  const names = patternParams(pattern);
  let params: Record<string, unknown>;
  if (typeof value === 'string') {
    if (names.length !== 1) return { error: `a string fills a pattern with one parameter; \`${pattern}\` has ${names.length}: give \`{ ${names.map((n) => `${n}: …`).join(', ')} }\`` };
    params = { [names[0]!]: value };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) params = value as Record<string, unknown>;
  else return { error: `\`${JSON.stringify(value)}\` is not a value for \`${pattern}\`: give a string or \`{ ${names.map((n) => `${n}: …`).join(', ')} }\`` };
  const extra = Object.keys(params).filter((k) => !names.includes(k));
  if (extra.length) return { error: `\`${pattern}\` has no parameter \`${extra[0]}\` (it has ${names.map((n) => `\`${n}\``).join(', ')})` };
  for (const n of names) {
    const v = params[n];
    if (typeof v !== 'string' && typeof v !== 'number') return { error: `the value for \`${pattern}\` has no \`${n}\`: ${JSON.stringify(value)}` };
    if (String(v) === '') return { error: `\`${n}\` is empty in a value for \`${pattern}\`: that URL is not the page's` };
  }
  return pattern.split('/').map((s) => (s.startsWith(':') ? encodeURIComponent(String(params[s.slice(1)])) : s)).join('/');
}

/** The head of a page's HTML (everything before `</head>`, or the whole page without one). */
const headOf = (html: string) => { const end = html.search(/<\/head\s*>/i); return end < 0 ? html : html.slice(0, end); };
const attrOf = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').replace(/&quot;|&#34;/g, '"') : null;
};
const tags = (html: string, name: string) => headOf(html).replace(/<!--[\s\S]*?-->|<template\b[\s\S]*?<\/template\s*>/gi, '').match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];

/** Whether a page's head asks search engines not to index it: `<meta name="robots" content="noindex">` (or `none`). */
export function noindex(html: string): boolean {
  return tags(html, 'meta').some((t) => (attrOf(t, 'name') ?? '').trim().toLowerCase() === 'robots' && /(^|[\s,])(noindex|none)($|[\s,])/i.test(attrOf(t, 'content') ?? ''));
}

/** The URL a page's canonical link names, as written in its built HTML, or null (none, or one a binding writes). */
export function canonicalOf(html: string): string | null {
  for (const t of tags(html, 'link')) {
    if (!(attrOf(t, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) continue;
    return attrOf(t, 'href');
  }
  return null;
}

const xml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** A `<urlset>`: each URL with its alternates (`xhtml:link`, the namespace only when a URL has some). */
export function urlset(urls: SitemapUrl[]): string {
  const langs = urls.some((u) => u.alternates);
  const body = urls.map((u) => {
    const alt = Object.entries(u.alternates ?? {}).map(([l, href]) => `\n    <xhtml:link rel="alternate" hreflang="${xml(l)}" href="${xml(href)}"/>`).join('');
    return `  <url>\n    <loc>${xml(u.loc)}</loc>${alt}\n  </url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${langs ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>\n${body}${body ? '\n' : ''}</urlset>\n`;
}

/**
 * The sitemap's files, at the output's root: `sitemap.xml` with every URL, or past the protocol's limit a sitemap
 * index there and the URLs in `sitemap-1.xml`, `sitemap-2.xml`, … (`root`: the absolute URL the output is served at).
 */
export function sitemapFiles(urls: SitemapUrl[], root: string, limit = SITEMAP_LIMIT): Array<{ fileName: string; source: string }> {
  if (urls.length <= limit) return [{ fileName: 'sitemap.xml', source: urlset(urls) }];
  const parts: Array<{ fileName: string; source: string }> = [];
  for (let i = 0; i < urls.length; i += limit) parts.push({ fileName: `sitemap-${parts.length + 1}.xml`, source: urlset(urls.slice(i, i + limit)) });
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.map((p) => `  <sitemap>\n    <loc>${xml(root + p.fileName)}</loc>\n  </sitemap>`).join('\n')}\n</sitemapindex>\n`;
  return [{ fileName: 'sitemap.xml', source: index }, ...parts];
}
