// Google Fonts as the app's own CSS (builds, `sinter({ fonts })`, on by default). A page's
// `<link rel="stylesheet" href="https://fonts.googleapis.com/css…">` is downloaded at build time and
// bundled by Vite as one of the app's CSS assets, and the page preconnects to the origin of the font
// files. The fonts, their `font-display` and the look stay as they are; the page loses a render-
// blocking request to another origin, and the font files' connection is open when they are requested.
// A file, not an inline <style>: no `style-src` change for a Content Security Policy.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where a rewritten link points: a module id the plugin resolves to the downloaded stylesheet. */
export const FONTS_PREFIX = '/__sinter-fonts/';

// Google Fonts answers by user agent: a current Chrome gets woff2 with unicode-range subsets
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const unescape = (s: string) => s.replace(/&amp;/g, '&');

/** The Google Fonts stylesheet links of a page: the tag, its `href` as written, and the URL. */
export function googleFontLinks(html: string): Array<{ tag: string; href: string; url: string }> {
  return [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /\brel=["']?stylesheet\b/i.test(m[0]))
    .map((m) => ({ tag: m[0], href: /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1] ?? '' }))
    .map((l) => ({ ...l, url: unescape(l.href) }))
    .filter((l) => /^https:\/\/fonts\.googleapis\.com\/css2?\?/.test(l.url));
}

/** The origins the stylesheet's `url(…)`s load from (the font files: fonts.gstatic.com). */
export function fontOrigins(css: string): string[] {
  return [...new Set([...css.matchAll(/url\(\s*['"]?(https:\/\/[^/'")\s]+)/g)].map((m) => m[1]!))];
}

/** The module id a stylesheet URL is bundled under. */
export const fontId = (url: string) => `${FONTS_PREFIX}${createHash('sha256').update(url).digest('base64url').slice(0, 12)}.css`;

/**
 * Rewrites a page: each Google Fonts link points at its module id, and a preconnect to the font
 * files' origin follows `<meta charset>`. `sheet(url)` gives the downloaded CSS, or null (the link
 * stays, and `failed` names it). Returns the page, the ids it now links, and the URLs that failed.
 */
export async function inlineFonts(html: string, sheet: (url: string) => Promise<string | null>): Promise<{ html: string; ids: Map<string, string>; failed: string[] }> {
  const ids = new Map<string, string>(), failed: string[] = [], origins = new Set<string>();
  for (const l of googleFontLinks(html)) {
    const css = await sheet(l.url);
    if (css == null) { failed.push(l.url); continue; }
    for (const o of fontOrigins(css)) origins.add(o);
    const id = fontId(l.url);
    ids.set(id, l.url);
    html = html.replace(l.tag, l.tag.replace(l.href, id));
  }
  // fonts are fetched in CORS mode: the preconnect needs `crossorigin` to be used for them
  const pre = [...origins].filter((o) => !html.includes(`<link rel="preconnect" href="${o}"`)).map((o) => `<link rel="preconnect" href="${o}" crossorigin>`).join('');
  if (pre) html = /<meta\s+charset[^>]*>/i.test(html) ? html.replace(/<meta\s+charset[^>]*>/i, (m) => m + pre) : html.replace(/<head[^>]*>/i, (m) => m + pre);
  return { html, ids, failed };
}

/**
 * Downloads a stylesheet once per build, cached in `dir` by URL (so a later build needs no network);
 * null when it cannot be had. `fetchImpl` for tests.
 */
export function fontDownloader(dir: string, fetchImpl: typeof fetch = fetch): (url: string) => Promise<string | null> {
  const running = new Map<string, Promise<string | null>>();
  return (url) => {
    let p = running.get(url);
    if (!p) {
      const file = join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.css`);
      p = (async () => {
        try { return readFileSync(file, 'utf8'); } catch { /* not cached yet */ }
        try {
          const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return null;
          const css = await res.text();
          try { mkdirSync(dir, { recursive: true }); writeFileSync(file, css); } catch { /* a read-only cache is fine */ }
          return css;
        } catch { return null; }
      })();
      running.set(url, p);
    }
    return p;
  };
}

/**
 * A font face to preload (`sinter({ fonts: { preload } })`): a family name for its regular face
 * (400, normal), or the family with a weight and style.
 */
export type FontPreload = string | { family: string; weight?: number; style?: 'normal' | 'italic' };
export type FontFaceRef = { family: string; weight: number; style: 'normal' | 'italic' };

export const faceOf = (p: FontPreload): FontFaceRef =>
  typeof p == 'string' ? { family: p, weight: 400, style: 'normal' } : { family: p.family, weight: p.weight ?? 400, style: p.style ?? 'normal' };

/** How a face is named in messages: `Source Sans Pro 400`, `… 700 italic`. */
export const faceName = (f: FontFaceRef) => `${f.family} ${f.weight}${f.style == 'italic' ? ' italic' : ''}`;

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The URL of a face's Latin file in a Google Fonts stylesheet: the `@font-face` with that family,
 * weight and style that the stylesheet marks `/* latin *\/` (Google's subsets), else the one whose
 * `unicode-range` covers U+0000-00FF, else the only one. Null when the stylesheet has none.
 */
export function fontFaceUrl(css: string, face: FontFaceRef): string | null {
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)].map((m) => ({ subset: m[1] ?? '', body: m[2]! }));
  const prop = (body: string, name: string) => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim() ?? '';
  const matching = blocks.filter((b) => unquote(prop(b.body, 'font-family')).toLowerCase() == face.family.toLowerCase()
    && Number(prop(b.body, 'font-weight') || 400) == face.weight && (prop(b.body, 'font-style') || 'normal') == face.style);
  const pick = matching.find((b) => b.subset == 'latin') ?? matching.find((b) => /U\+0000-00FF/i.test(prop(b.body, 'unicode-range'))) ?? (matching.length == 1 ? matching[0] : undefined);
  return pick ? /url\(\s*['"]?([^'")\s]+)/.exec(pick.body)?.[1] ?? null : null;
}

/**
 * The tag that preloads a font file (fonts load in CORS mode: `crossorigin`, or the preload goes
 * unused). `face`: dev only, the face it is for, which the dev check reads (`data-sn-font`).
 */
export const fontPreloadTag = (url: string, face?: FontFaceRef) =>
  `<link rel="preload" as="font" type="font/woff2" href="${url}" crossorigin${face ? ` data-sn-font="${`${face.family};${face.weight};${face.style}`.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"` : ''}>`;

/**
 * Adds a preload, after `<meta charset>`, for each face whose Latin file one of the page's Google
 * Fonts stylesheets has (`sheet(url)`: the downloaded CSS). Returns the page and the faces it
 * preloads; a page without such a stylesheet is unchanged. `dev`: the tags name their face.
 */
export async function preloadFonts(html: string, sheet: (url: string) => Promise<string | null>, faces: FontFaceRef[], dev = false): Promise<{ html: string; preloaded: FontFaceRef[] }> {
  const links = googleFontLinks(html);
  if (!faces.length || !links.length) return { html, preloaded: [] };
  const sheets = (await Promise.all(links.map((l) => sheet(l.url)))).filter((c): c is string => c != null);
  const preloaded: FontFaceRef[] = [], tags: string[] = [];
  for (const f of faces) {
    const url = sheets.map((c) => fontFaceUrl(c, f)).find(Boolean);
    if (url && !html.includes(`href="${url}"`)) { preloaded.push(f); tags.push(fontPreloadTag(url, dev ? f : undefined)); }
  }
  const pre = tags.join('');
  if (pre) html = /<meta\s+charset[^>]*>/i.test(html) ? html.replace(/<meta\s+charset[^>]*>/i, (m) => m + pre) : html.replace(/<head[^>]*>/i, (m) => m + pre);
  return { html, preloaded };
}

/**
 * Whether a stylesheet uses a family: a `font-family` or `font` declaration outside `@font-face`
 * lists it (quoted or not, any case).
 */
export function usesFamily(css: string, family: string): boolean {
  const rules = stripComments(css).replace(/@font-face\s*\{[^}]*\}/gi, '');
  const want = family.toLowerCase();
  for (const m of rules.matchAll(/(?:^|[;{\s])font(-family)?\s*:\s*([^;}]+)/gi)) {
    const parts = m[2]!.replace(/!important/i, '').split(',').map((p) => p.trim());
    // `font: italic 700 1rem/1.5 "A B", serif`: the first part ends with a family after the size
    if (!m[1]) parts[0] = parts[0]!.replace(/^.*\d[\w%.]*(?:\/[\w%.]+)?\s+/, '');
    if (parts.some((p) => unquote(p).toLowerCase() == want)) return true;
  }
  return false;
}
