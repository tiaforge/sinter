// Build side of the `prefetch` feature: one module with every page's description, imported by
// every page (a shared chunk in builds), that exports the installed feature.
import type { HelperManifest, PrefetchParts } from './compiler/compile.js';
import { PACKAGE } from './compiler/index.js';

/**
 * The paths a page answers at: its `data-sn-path` patterns, else where its file is served
 * (`/login.html` and `/login`; `/docs/` and `/docs/index.html` for `docs/index.html`), under `base`.
 */
export function pagePaths(rel: string, base: string, patterns: string[]): string[] {
  if (patterns.length) return patterns;
  const b = base.startsWith('/') ? base.replace(/\/?$/, '/') : '/';
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
  const patterns = [...new Set(paths)].map((p) => p.split('/').map((s) => (s[0] === ':' && /^:\w+$/.test(s) ? s : s.replace(/[*?+(){}:\\]/g, '\\$&'))).join('/') + '\\?*#*');
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
