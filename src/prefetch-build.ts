// Build side of the `prefetch` feature: one module with every page's description, imported by
// every page (a shared chunk in builds), that exports the installed feature.
import type { HelperManifest, PrefetchParts } from './compiler/compile.js';
import { PACKAGE } from './compiler/index.js';

/** pages hosts look for by name: written as they are, never as a directory */
const KEEP = /(^|\/)(index|404|200)\.html?$/;
const rootOf = (base: string) => (base.startsWith('/') ? base.replace(/\/?$/, '/') : '/');

/** the URL a page with a fixed path has as a directory's index: `/about/` for `about.html` */
export const directoryUrl = (rel: string, base: string) => rootOf(base) + rel.replace(/\.html?$/, '/');

/** `data-sn-path` that names only the URL the page has anyway (`/contact/` on `contact.html`): SN515, and ignored */
export function redundantPaths(rel: string, base: string, patterns: string[]): boolean {
  return patterns.length === 1 && !KEEP.test(rel) && patterns[0] === directoryUrl(rel, base);
}

/**
 * Whether a page is written as a directory's index (`about.html` as `about/index.html`, served at
 * `/about/`): a page without `data-sn-path` (or with only the URL it has anyway). Not `index.html`,
 * `404.html` or `200.html`, and not a page with `data-sn-path`: it answers at exactly those paths
 * (`/article/:slug`, `/login`), each a rewrite to its file, which stays where it is.
 */
export function movesToDirectory(rel: string, base: string, patterns: string[]): boolean {
  return /\.html?$/.test(rel) && !KEEP.test(rel) && (!patterns.length || redundantPaths(rel, base, patterns));
}

/** Where a page's HTML is written in the output, relative to it: `about/index.html` for a page that moves. */
export function pageFile(rel: string, base: string, patterns: string[]): string {
  return movesToDirectory(rel, base, patterns) ? rel.replace(/\.html?$/, '/index.html') : rel;
}

/**
 * The URL a link to a page names, under `base`: `/about/` for a page that moves, the first fixed path of
 * its `data-sn-path` (`/login`), `/docs/` for `docs/index.html`, `/404.html`; null for a page whose
 * paths all have parameters.
 */
export function pageUrl(rel: string, base: string, patterns: string[]): string | null {
  const b = rootOf(base);
  if (movesToDirectory(rel, base, patterns)) return directoryUrl(rel, base);
  if (patterns.length) return patterns.find((p) => !p.includes(':')) ?? null;
  const index = /(^|\/)index\.html?$/.exec(rel);
  return index ? b + rel.slice(0, index.index + index[1]!.length) : b + rel;
}

/**
 * The paths a page answers at: its `data-sn-path`, else where its file is served, under `base`: `/about/`
 * and `/about` for a page written as a directory (redirected to `/about/`), `/docs/` and
 * `/docs/index.html` for `docs/index.html`.
 */
export function pagePaths(rel: string, base: string, patterns: string[]): string[] {
  const b = rootOf(base);
  if (movesToDirectory(rel, base, patterns)) { const dir = directoryUrl(rel, base); return [dir, dir.slice(0, -1)]; }
  if (patterns.length) return patterns;
  const index = /(^|\/)index\.html?$/.exec(rel);
  if (index) { const dir = b + rel.slice(0, index.index + index[1]!.length); return [dir, dir + 'index.html']; }
  return [b + rel, b + rel.replace(/\.html?$/, '')];
}

/**
 * Speculation Rules (JSON) for same-origin links to the app's pages: `href_matches` takes URL
 * patterns, so `data-sn-path` patterns (`/article/:slug`) are used as they are, with any query and
 * fragment. Links that download or open elsewhere are left out. Eagerness `moderate`: the pointer
 * rests on the link (200 ms) or a press starts. Null when the app has no paths.
 */
export function speculationRules(mode: 'prefetch' | 'prerender', paths: string[]): string | null {
  // a pattern matches with or without a trailing slash, as the runtime and the server match it
  const both = paths.flatMap((p) => (p.includes(':') ? [p.replace(/\/+$/, ''), p.replace(/\/*$/, '/')] : [p]));
  const patterns = [...new Set(both)].map((p) => p.split('/').map((s) => (s[0] === ':' && /^:\w+$/.test(s) ? s : s.replace(/[*?+(){}:\\]/g, '\\$&'))).join('/') + '\\?*#*');
  if (!patterns.length) return null;
  return JSON.stringify({
    [mode]: [{
      where: { and: [{ href_matches: patterns }, { not: { selector_matches: '[download], [target]:not([target="_self"]), [rel~="nofollow"]' } }] },
      eagerness: 'moderate',
    }],
  });
}

const CSP_META = /\bhttp-equiv\s*=\s*["']?content-security-policy["'\s>]/i;

/** whether the page declares a CSP in a `<meta>` (which then gets the rules' hash) */
export function hasCspMeta(html: string): boolean {
  return (html.match(/<meta\b[^>]*>/gi) ?? []).some((tag) => CSP_META.test(tag));
}

/**
 * A CSP the page declares itself (`<meta http-equiv="Content-Security-Policy">`) gets the inline
 * rules' hash, so it allows them and nothing else: in `script-src-elem` and `script-src` where
 * the page has them, else in a `script-src` copied from `default-src`. A directive that already
 * allows the rules (`'unsafe-inline'` without a hash or nonce, or `'inline-speculation-rules'`) is
 * left as it is: a hash would turn `'unsafe-inline'` off for the page's other inline scripts. A
 * CSP sent as a response header is out of the build's reach.
 */
export function withRulesHash(html: string, hash: string): string {
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!CSP_META.test(tag)) return tag;
    return tag.replace(/(\bcontent\s*=\s*")([^"]*)(")/i, (_, a: string, value: string, z: string) => a + addHash(value, hash) + z);
  });
}

function addHash(policy: string, hash: string): string {
  const token = `'${hash}'`;
  const dirs = policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/));
  const allows = (sources: string[]) => sources.includes("'inline-speculation-rules'") || sources.includes(token)
    || (sources.includes("'unsafe-inline'") && !sources.some((s) => /^'(sha(256|384|512)-|nonce-)/.test(s)));
  const targets = dirs.filter((d) => d[0]!.toLowerCase() === 'script-src-elem' || d[0]!.toLowerCase() === 'script-src');
  if (!targets.length) {
    const fallback = dirs.find((d) => d[0]!.toLowerCase() === 'default-src');
    if (!fallback || allows(fallback.slice(1))) return policy;
    dirs.push(['script-src', ...fallback.slice(1).filter((s) => s !== "'none'"), token]);
  }
  for (const d of targets) {
    if (allows(d.slice(1))) continue;
    // `'none'` allows nothing and cannot stand beside a source: the hash takes its place
    if (d[1] === "'none'") d.splice(1, 1);
    d.push(token);
  }
  return dirs.map((d) => d.join(' ')).join('; ');
}

/** The module: helpers imported as the page modules import them, then `prefetch([...pages])` as its default export. */
export function prefetchModule(pages: Array<{ paths: string[]; parts: PrefetchParts }>, helpers: HelperManifest): string {
  const user = new Set<string>(), ns = new Map<string, Set<string>>();
  for (const { parts } of pages) {
    for (const h of parts.helpers) user.add(h);
    for (const [n, members] of Object.entries(parts.namespaces)) for (const m of members) (ns.get(n) ?? ns.set(n, new Set()).get(n)!).add(m);
  }
  const lines = [`import { $k } from '${PACKAGE}';`, `import { prefetch } from '${PACKAGE}/prefetch';`];
  if (user.size && helpers.module) lines.push(`import { ${[...user].sort().join(', ')} } from ${JSON.stringify(helpers.module)};`);
  for (const [n, members] of ns) lines.push(`import { ${[...members].sort().map((m) => `${m} as ${n}$${m}`).join(', ')} } from ${JSON.stringify(helpers.namespaces[n]!.module)};`);
  lines.push('', 'void $k;', 'export default prefetch([');
  for (const { paths, parts } of pages) {
    lines.push(`  { m: ${JSON.stringify(paths)}, r: ${JSON.stringify(parts.res)}, f: [`);
    for (const f of parts.fns) lines.push(`    ${f},`);
    lines.push('  ] },');
  }
  lines.push(']);');
  return lines.join('\n') + '\n';
}
