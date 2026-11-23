// Build side of the `prefetch` feature: one module with every page's description, imported by
// every page (a shared chunk in builds), that exports the installed feature.
import type { HelperManifest, PrefetchParts } from './compiler/compile.js';
import { helperImports, PACKAGE } from './compiler/index.js';

/** pages hosts look for by name: written as they are, never as a directory */
export { directoryUrl, movesToDirectory, pageFile, pagePaths, pageUrl, redundantPaths } from './page-paths.js';

/**
 * Speculation Rules (JSON) for same-origin links to the app's pages: `href_matches` takes URL
 * patterns, so `data-sn-path` patterns (`/article/:slug`) are used as they are, with any query and
 * fragment. Links that download or open elsewhere are left out. Eagerness `moderate`: the pointer
 * rests on the link (200 ms) or a press starts. `prerender` and `prefetch` list the paths of each:
 * with both (`prerender: 'auto'`), the prerender rule leaves out what a prefetched page's paths match
 * (`/article/new` beside `/article/:slug`), so a link is prerendered only when no other page can be its
 * target. Null when the app has no paths.
 */
export function speculationRules(lists: { prefetch?: string[]; prerender?: string[] }, samePage = false): string | null {
  // a pattern matches with or without a trailing slash, as the runtime and the server match it
  const patternsOf = (paths: string[]) => {
    const both = paths.flatMap((p) => (p.includes(':') ? [p.replace(/\/+$/, ''), p.replace(/\/*$/, '/')] : [p]));
    const one = (p: string) => p.split('/').map((s) => (s[0] === ':' && /^:\w+$/.test(s) ? s : s.replace(/[*?+(){}:\\]/g, '\\$&'))).join('/') + '\\?*#*';
    const unique = [...new Set(both)], plain = unique.filter(plainPath);
    // many plain paths (a page file per post): one pattern whose group matches exactly those paths, where the list,
    // in every page's head, grew with the pages (so with the square of them over a site)
    // (`SN_RULES_FOLD=0`: the list as it was, to compare the two)
    if (plain.length < FOLD_FROM || process.env.SN_RULES_FOLD === '0') return unique.map(one);
    const at = unique.findIndex(plainPath);
    return [...unique.slice(0, at).map(one), pathsPattern(plain), ...unique.slice(at).filter((p) => !plainPath(p)).map(one)];
  };
  const prefetch = patternsOf(lists.prefetch ?? []), prerender = patternsOf(lists.prerender ?? []);
  const rule = (patterns: string[], not: string[]) => [{
    where: { and: [
      { href_matches: patterns },
      ...(not.length ? [{ not: { href_matches: not } }] : []),
      { not: { selector_matches: '[download], [target]:not([target="_self"]), [rel~="nofollow"]' } },
      // same-page links stay in the page (query-links.ts): not the page's own URL with another query.
      // Relative to the document, `?*` is its own path with any query (and fragment)
      ...(samePage ? [{ not: { href_matches: '?*', relative_to: 'document' } }] : []),
    ] },
    eagerness: 'moderate',
  }];
  if (!prefetch.length && !prerender.length) return null;
  return JSON.stringify({
    ...(prerender.length ? { prerender: rule(prerender, prefetch) } : {}),
    ...(prefetch.length ? { prefetch: rule(prefetch, []) } : {}),
  });
}

/** from this many plain paths in a rule, one pattern matches them all (a few pages keep their readable list) */
const FOLD_FROM = 16;

/**
 * A path a URL pattern's literal and a regular expression read the same way: from `/`, of the characters a URL's
 * path keeps as they are (no percent-encoding, no `.` or `..` segment, no empty segment), none a pattern's syntax.
 */
const plainPath = (p: string) => /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/?)*$/.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p) && !p.includes(':');

/**
 * One URL pattern for these plain paths, each with any query and fragment: `/(…)` with a regular expression that
 * matches exactly them (a trie of the paths, the branches that end alike written once, as a character class). A URL
 * pattern matches a regular-expression group against the URL's path as parsed, which for a plain path is the path
 * itself, as the literal pattern it stands for matched; and the whole path is in the group (a `?` after it would
 * start the pattern's query).
 */
export function pathsPattern(paths: readonly string[]): string {
  interface Node { end: boolean; kids: Map<string, Node> }
  const root: Node = { end: false, kids: new Map() };
  for (const p of paths) {
    let n = root;
    for (const c of p.slice(1)) { let k = n.kids.get(c); if (!k) n.kids.set(c, (k = { end: false, kids: new Map() })); n = k; }
    n.end = true;
  }
  const esc = (c: string) => (c === '.' ? '\\.' : c);
  const cls = (cs: string[]) => {
    if (cs.length === 1) return esc(cs[0]!);
    const codes = cs.map((c) => c.charCodeAt(0)).sort((a, b) => a - b), parts: string[] = [];
    for (let i = 0; i < codes.length;) {
      let j = i;
      // (ranges within digits or letters only)
      while (j + 1 < codes.length && codes[j + 1] === codes[j]! + 1 && /[0-9A-Za-z]{2}/.test(String.fromCharCode(codes[j]!, codes[j + 1]!))) j++;
      // (`-` and `/` escaped: a class's syntax under the `v` flag)
      const ch = (n: number) => { const c = String.fromCharCode(n); return c === '-' || c === '/' ? `\\${c}` : c; };
      parts.push(j - i >= 2 ? `${ch(codes[i]!)}-${ch(codes[j]!)}` : codes.slice(i, j + 1).map(ch).join(''));
      i = j + 1;
    }
    return `[${parts.join('')}]`;
  };
  const memo = new Map<Node, string>();
  const re = (n: Node): string => {
    let out = memo.get(n);
    if (out !== undefined) return out;
    // the branches by what follows their character: those alike become one class
    const by = new Map<string, string[]>();
    for (const [c, k] of [...n.kids].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const rest = re(k);
      const cs = by.get(rest);
      if (cs) cs.push(c); else by.set(rest, [c]);
    }
    const alts = [...by].map(([rest, cs]) => cls(cs) + rest);
    out = !alts.length ? '' : n.end ? `(?:${alts.join('|')})?` : alts.length > 1 ? `(?:${alts.join('|')})` : alts[0]!;
    memo.set(n, out);
    return out;
  };
  return `/(${re(root)})\\?*#*`;
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
  // array parameters: only an app with a page that has them passes `lists` (and carries it)
  const ls = pages.some((p) => p.parts.a);
  // the URL helpers the pages' functions call
  const uses = [...new Set(pages.flatMap((p) => p.parts.uses ?? []))].sort();
  const lines = [`import { $k } from '${PACKAGE}/runtime';`, `import { ${['prefetch', ...(ls ? ['lists'] : []), ...uses].join(', ')} } from '${PACKAGE}/runtime/prefetch';`];
  lines.push(...helperImports([...user].sort(), Object.fromEntries([...ns].map(([n, m]) => [n, [...m].sort()])), helpers));
  lines.push('', 'void $k;', 'export default prefetch([');
  for (const { paths, parts } of pages) {
    lines.push(`  { m: ${JSON.stringify(paths)}, r: ${JSON.stringify(parts.res.map(({ q: _q, sp: _sp, ...r }) => r))}, ${parts.a ? `a: ${JSON.stringify(parts.a)}, ` : ''}${parts.g ? `g: ${JSON.stringify(parts.g)}, ` : ''}f: [`);
    for (const f of parts.fns) lines.push(`    ${f},`);
    lines.push('  ] },');
  }
  lines.push(ls ? '], lists);' : ']);');
  return lines.join('\n') + '\n';
}
