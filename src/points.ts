// Points (docs/proposals/axes.md §1): a page is built once per point, one value of each axis it is built over: the
// site's languages (`localePrefix`), the axes `data-sn-for` on `<html>` declares (`tenant in tenants`), and a page's own
// entries. This module lists the points of every source page, where each is written, and which points are
// translations of each other, so the build's inputs, the collisions, the choosers and `hreflang` all come from one
// listing. Pure: the caller compiles the templates and checks the public folder.

/** an entry of a page per entry: its value, its path (the pattern filled from it) and its key */
export interface Entry { value: unknown; path: string; key: string }

/**
 * one axis's value at a point: the entry of its list, its key, and the path segment its pages' URLs are under; for a
 * value on its own domain (`origin`), no segment, and the folder its files are written under (outermost: `dist/acme/`).
 * `list` is the list's `src` (`content:tenants`), which names the axis across pages.
 */
export interface AxisValue { value: unknown; key: string; segment: string | null; folder?: string; origin?: string; list?: string }

/**
 * one page to build: its source, its language (or null), its axes' values (outer first) and its entry (or null),
 * written at `rel` (from the root)
 */
export interface Point { source: string; locale: string | null; axes: AxisValue[]; entry: Entry | null; rel: string }

/** one combination of a source's axes' values, and its own entries (null: the page has none, it is one page there) */
export interface Variant { axes: AxisValue[]; entries: Entry[] | null }

export interface Points {
  points: Point[];
  /** a page per entry with languages: each entry's path in each language that has it, by `translationKey` */
  translations: Map<string, Map<string, string>>;
}

/** how the languages are in URLs: a language's segment where it is not its tag (`paths`), and a language on its own domain */
export interface LanguageUrls { paths?: Record<string, string>; domains?: Record<string, string> }

/** a language's segment: its `paths` entry, else its tag */
const segOf = (locale: string, l?: LanguageUrls | null) => l?.paths?.[locale] ?? locale;

/**
 * the prefix of a point's URLs: its language's segment (none for a language on its own domain), then each axis's
 * (`de/acme`), or ''
 */
export const pointPrefix = (locale: string | null, axes: readonly AxisValue[], l?: LanguageUrls | null) => [locale && !l?.domains?.[locale] ? segOf(locale, l) : null, ...axes.map((a) => a.segment)].filter(Boolean).join('/');

/** which entries are translations of each other: one source, the same axes' values, the same key */
export const translationKey = (source: string, axes: readonly AxisValue[], key: string) => [source, ...axes.map((a) => a.key), key].join('\0');

/** the folder a point's files are written under: its origins' folders, then `pointPrefix` (`acme/de`) */
export const pointFolder = (locale: string | null, axes: readonly AxisValue[], l?: LanguageUrls | null) => [locale && l?.domains?.[locale] ? segOf(locale, l) : null, ...axes.flatMap((a) => (a.folder ? [a.folder] : [])), pointPrefix(locale, axes, l)].filter(Boolean).join('/');

/**
 * the origin a point is served from: one of its axes' values' own (`https://acme-shop.com`), or its language's
 * (`languages({ domains })`), with the folder its files are under
 */
export const pointOrigin = (axes: readonly AxisValue[], locale?: string | null, l?: LanguageUrls | null): { folder: string; origin: string } | null => {
  const a = axes.find((x) => x.folder && x.origin);
  if (a) return { folder: a.folder!, origin: a.origin! };
  const d = locale ? l?.domains?.[locale] : undefined;
  return d ? { folder: segOf(locale!, l), origin: d } : null;
};

/** where a point is written: under its folder (`pointFolder`), at its entry's path (from the base) or its source's file */
export function pointRel(sourceRel: string, locale: string | null, entryRel: string | null, axes: readonly AxisValue[] = [], l?: LanguageUrls | null): string {
  const at = pointFolder(locale, axes, l);
  return (at ? `${at}/` : '') + (entryRel !== null ? `${entryRel}.html` : sourceRel);
}

/**
 * Every point of the sources, in order: for each source, each language (or one point without), each variant of its
 * axes (`variants`; a source without axes has one, without values), and for a page per entry each of that variant's
 * entries. An entry written where a plain page is (in any language or variant), or where `public/` has a file
 * (`inPublic`), fails: the error names both. `entries` is the form for a source with entries and no axes.
 */
export function listPoints(o: {
  sources: Array<{ source: string; rel: string; entries?: ((locale: string | null) => Entry[]) | null; variants?: ((locale: string | null) => Variant[]) | null }>;
  locales: readonly string[] | null;
  /** the languages' segments where they are not their tags, and their domains (`languages({ paths, domains })`) */
  languages?: LanguageUrls;
  /** the site's base, for an entry's path relative to it */
  base: string;
  inPublic?: (rel: string) => boolean;
}): Points {
  const langs = o.locales ?? [null];
  const b = o.base.startsWith('/') ? o.base.replace(/\/?$/, '/') : '/';
  const relOfPath = (path: string) => decodeURIComponent(path.startsWith(b) ? path.slice(b.length) : path.replace(/^\//, ''));
  const variantsOf = (s: (typeof o.sources)[number], l: string | null): Variant[] =>
    s.variants ? s.variants(l) : [{ axes: [], entries: s.entries ? s.entries(l) : null }];
  const all = o.sources.map((s) => ({ s, by: langs.map((l) => [l, variantsOf(s, l)] as const) }));
  // where the plain pages are, in every language and variant: an entry may not be written there
  const taken = new Map<string, string>();
  for (const { s, by } of all) for (const [l, vs] of by) for (const v of vs) {
    if (v.entries) continue;
    if (l && o.languages?.domains?.[l] && v.axes.some((a) => a.origin)) throw new Error(`sinter: ${s.rel}: the language \`${l}\` has its own domain, and a tenant of this page has its own too; a page is on one domain`);
    const rel = pointRel(s.rel, l, null, v.axes, o.languages);
    taken.set(rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, ''), rel);
  }
  const points: Point[] = [], translations = new Map<string, Map<string, string>>();
  for (const { s, by } of all) for (const [l, vs] of by) for (const v of vs) {
    if (!v.entries) { points.push({ source: s.source, locale: l, axes: v.axes, entry: null, rel: pointRel(s.rel, l, null, v.axes, o.languages) }); continue; }
    // each entry at its path under the point's folder; their keys pair the translations
    for (const e of v.entries) {
      const at = pointRel('', l, relOfPath(e.path), v.axes, o.languages).replace(/\.html$/, '');
      const shown = `${v.axes.map((a) => (a.folder ? `${a.origin ?? a.folder} ` : '')).join('')}${l ? `/${segOf(l, o.languages)}` : ''}${v.axes.map((a) => (a.segment ? `/${a.segment}` : '')).join('')}${e.path}`;
      const other = taken.get(at) ?? taken.get(at + '/');
      if (other) throw new Error(`sinter: ${s.rel}: the entry at \`${shown}\` would be written where \`${other}\` is (data-sn-for on <html>)`);
      if (o.inPublic?.(at)) throw new Error(`sinter: ${s.rel}: the entry at \`${e.path}\` would be written where \`public/${at}.html\` is (data-sn-for on <html>)`);
      taken.set(at, `${s.rel} (${e.path})`);
      points.push({ source: s.source, locale: l, axes: v.axes, entry: e, rel: at + '.html' });
      if (l) {
        const k = translationKey(s.source, v.axes, e.key);
        if (!translations.has(k)) translations.set(k, new Map());
        translations.get(k)!.set(l, e.path);
      }
    }
  }
  return { points, translations };
}

/** a source's chooser for a page per entry's entry: at the base language's entry's path, else the first language's */
export function entryChooserPath(translations: Points['translations'], key: string, base: string): string | null {
  const by = translations.get(key);
  return by ? (by.get(base) ?? [...by.values()][0]!) : null;
}
