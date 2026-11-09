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
