// The URLs a page is served at, from its file and its `data-sn-path` patterns (docs/static-pages.md#page-urls):
// shared by the build, the compiler and next-page data. Imports nothing, so the compiler can use it.

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
