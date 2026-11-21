// Points (docs/proposals/axes.md §1): a page is built once per point, one value of each axis it is built over. Today
// the axes are the site's languages (`localePrefix`) and a page's own entries (`data-sn-for` on `<html>`); this module
// lists the points of every source page, where each is written, and which points are translations of each other, so
// the build's inputs, the collisions, the choosers and `hreflang` all come from one listing. Pure: the caller compiles
// the templates and checks the public folder.

/** an entry of a page per entry: its value, its path (the pattern filled from it) and its key */
export interface Entry { value: unknown; path: string; key: string }

/** one page to build: its source, its language (or null) and its entry (or null), written at `rel` (from the root) */
export interface Point { source: string; locale: string | null; entry: Entry | null; rel: string }

export interface Points {
  points: Point[];
  /** a page per entry with languages: each entry's path in each language that has it, by `source \0 key` */
  translations: Map<string, Map<string, string>>;
}

/** where a point is written: under its language's folder, at its entry's path (from the base) or its source's file */
export function pointRel(sourceRel: string, locale: string | null, entryRel: string | null): string {
  return (locale ? `${locale}/` : '') + (entryRel !== null ? `${entryRel}.html` : sourceRel);
}

/**
 * Every point of the sources, in order: for each source, each language (or one point without), and for a page per
 * entry each of that language's entries. An entry written where a plain page is (in any language), or where `public/`
 * has a file (`inPublic`), fails: the error names both.
 */
export function listPoints(o: {
  sources: Array<{ source: string; rel: string; entries: ((locale: string | null) => Entry[]) | null }>;
  locales: readonly string[] | null;
  /** the site's base, for an entry's path relative to it */
  base: string;
  inPublic?: (rel: string) => boolean;
}): Points {
  const langs = o.locales ?? [null];
  const b = o.base.startsWith('/') ? o.base.replace(/\/?$/, '/') : '/';
  const relOfPath = (path: string) => decodeURIComponent(path.startsWith(b) ? path.slice(b.length) : path.replace(/^\//, ''));
  // where the plain pages are, in every language: an entry may not be written there
  const taken = new Map<string, string>();
  for (const s of o.sources) if (!s.entries) for (const l of langs) {
    const rel = pointRel(s.rel, l, null);
    taken.set(rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, ''), rel);
  }
  const points: Point[] = [], translations = new Map<string, Map<string, string>>();
  for (const s of o.sources) {
    if (!s.entries) { for (const l of langs) points.push({ source: s.source, locale: l, entry: null, rel: pointRel(s.rel, l, null) }); continue; }
    // each language's entries (its own list with `{$locale}`), at its prefix; their keys pair the translations
    for (const l of langs) {
      for (const e of s.entries(l)) {
        const at = pointRel('', l, relOfPath(e.path)).replace(/\.html$/, '');
        const other = taken.get(at) ?? taken.get(at + '/');
        if (other) throw new Error(`sinter: ${s.rel}: the entry at \`${l ? `/${l}` : ''}${e.path}\` would be written where \`${other}\` is (data-sn-for on <html>)`);
        if (o.inPublic?.(at)) throw new Error(`sinter: ${s.rel}: the entry at \`${e.path}\` would be written where \`public/${at}.html\` is (data-sn-for on <html>)`);
        taken.set(at, `${s.rel} (${e.path})`);
        points.push({ source: s.source, locale: l, entry: e, rel: at + '.html' });
        if (l) {
          const k = `${s.source}\0${e.key}`;
          if (!translations.has(k)) translations.set(k, new Map());
          translations.get(k)!.set(l, e.path);
        }
      }
    }
  }
  return { points, translations };
}

/** a source's chooser for a page per entry's entry: at the base language's entry's path, else the first language's */
export function entryChooserPath(translations: Points['translations'], source: string, key: string, base: string): string | null {
  const by = translations.get(`${source}\0${key}`);
  return by ? (by.get(base) ?? [...by.values()][0]!) : null;
}
