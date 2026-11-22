// Google Fonts as the app's own CSS (builds, `sinter({ fonts })`, on by default). A page's
// `<link rel="stylesheet" href="https://fonts.googleapis.com/css…">` is downloaded at build time and
// bundled by Vite as one of the app's CSS assets, and the page preconnects to the origin of the font
// files. The fonts, their `font-display` and the look stay as they are; the page loses a render-
// blocking request to another origin, and the font files' connection is open when they are requested.
// A file, not an inline <style>: no `style-src` change for a Content Security Policy.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

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
export async function bundleFonts(html: string, sheet: (url: string) => Promise<string | null>): Promise<{ html: string; ids: Map<string, string>; failed: string[] }> {
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
 * Downloads a font file once (Google Fonts' files, fonts.gstatic.com), cached in `dir` by URL: the
 * build reads its metrics (`line-height: normal`, font-metrics.ts). Null when it cannot be had.
 */
export function fontFileDownloader(dir: string, fetchImpl: typeof fetch = fetch): (url: string) => Promise<Uint8Array | null> {
  const running = new Map<string, Promise<Uint8Array | null>>();
  return (url) => {
    let p = running.get(url);
    if (!p) {
      const file = join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.font`);
      p = (async () => {
        try { return new Uint8Array(readFileSync(file)); } catch { /* not cached yet */ }
        if (!/^https:\/\/fonts\.gstatic\.com\//.test(url)) return null;
        try {
          const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          try { mkdirSync(dir, { recursive: true }); writeFileSync(file, bytes); } catch { /* a read-only cache is fine */ }
          return bytes;
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

/** Whether a `unicode-range` covers Latin letters (`U+0000-00FF`, minified `U+00??`, `U+41-5A`). */
const coversLatin = (range: string) => range.split(',').some((r) => {
  const m = /^\s*U\+([0-9a-f?]+)(?:-([0-9a-f]+))?\s*$/i.exec(r);
  if (!m) return false;
  const lo = parseInt(m[1]!.replace(/\?/g, '0'), 16), hi = parseInt(m[2] ?? m[1]!.replace(/\?/g, 'f'), 16);
  return lo <= 0x41 && hi >= 0x5a;
});

/** Whether a `font-weight` (`400`, a variable font's `100 900`, `bold`) has the weight. */
const hasWeight = (prop: string, weight: number) => {
  const [lo, hi = lo] = (prop || '400').split(/\s+/).map((w) => (w == 'bold' ? 700 : w == 'normal' ? 400 : Number(w)));
  return lo! <= weight && weight <= hi!;
};

/**
 * The URL of a face's Latin file in a stylesheet (Google Fonts' or the app's own, e.g. Fontsource):
 * the `@font-face` with that family, a weight that is or spans the face's, and its style, that the
 * stylesheet marks `/* latin *\/` (Google's subsets), else the one whose `unicode-range` covers the
 * Latin letters, else the only one. Its woff2 source when it has several. Null when the stylesheet has none.
 */
export function fontFaceUrl(css: string, face: FontFaceRef): string | null {
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)].map((m) => ({ subset: m[1] ?? '', body: m[2]! }));
  const prop = (body: string, name: string) => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1]?.trim() ?? '';
  const matching = blocks.filter((b) => unquote(prop(b.body, 'font-family')).toLowerCase() == face.family.toLowerCase()
    && hasWeight(prop(b.body, 'font-weight'), face.weight) && (prop(b.body, 'font-style') || 'normal') == face.style);
  const pick = matching.find((b) => b.subset == 'latin') ?? matching.find((b) => coversLatin(prop(b.body, 'unicode-range'))) ?? (matching.length == 1 ? matching[0] : undefined);
  if (!pick) return null;
  const urls = [...pick.body.matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)\s*(?:format\(\s*['"]?([\w-]+))?/g)].map((m) => ({ url: m[1]!, format: m[2] ?? '' }))
    .filter((u) => !u.url.startsWith('data:'));
  return (urls.find((u) => u.format == 'woff2' || /\.woff2(?:[?#]|$)/i.test(u.url)) ?? urls[0])?.url ?? null;
}

const FONT_TYPES: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/**
 * The tag that preloads a font file (fonts load in CORS mode: `crossorigin`, or the preload goes
 * unused). `face`: dev only, the face it is for, which the dev check reads (`data-sn-font`).
 */
export const fontPreloadTag = (url: string, face?: FontFaceRef) => {
  const type = FONT_TYPES[/\.(\w+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase() ?? ''];
  return `<link rel="preload" as="font"${type ? ` type="${type}"` : ''} href="${url}" crossorigin${face ? ` data-sn-font="${`${face.family};${face.weight};${face.style}`.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"` : ''}>`;
};

const afterCharset = (html: string, tags: string) =>
  !tags ? html : /<meta\s+charset[^>]*>/i.test(html) ? html.replace(/<meta\s+charset[^>]*>/i, (m) => m + tags) : html.replace(/<head[^>]*>/i, (m) => m + tags);

/**
 * Builds: adds a preload, after `<meta charset>`, for each face the page's own bundled stylesheets
 * have (`sheets`: each as the page links it, `href` relative to the page or absolute, and its CSS; a
 * page's inline `<style>` with `href` ''). A relative font URL is resolved against its stylesheet's
 * `href`. Returns the page and the faces it preloads.
 */
export function preloadLocalFonts(html: string, sheets: Array<{ href: string; css: string }>, faces: FontFaceRef[]): { html: string; preloaded: FontFaceRef[] } {
  const preloaded: FontFaceRef[] = [], tags: string[] = [];
  for (const f of faces) {
    for (const s of sheets) {
      const url = fontFaceUrl(s.css, f);
      if (!url) continue;
      const href = /^([a-z][\w+.-]*:|\/)/i.test(url) || !s.href ? url : posix.join(posix.dirname(s.href.split(/[?#]/)[0]!), url);
      if (!html.includes(`href="${href}"`) && !tags.some((t) => t.includes(`href="${href}"`))) tags.push(fontPreloadTag(href));
      preloaded.push(f);
      break;
    }
  }
  return { html: afterCharset(html, tags.join('')), preloaded };
}

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
  return { html: afterCharset(html, tags.join('')), preloaded };
}

/**
 * Whether a stylesheet uses a family: a `font-family` or `font` declaration outside `@font-face`
 * lists it (quoted or not, any case), directly or through a custom property it reads with `var()`
 * whose value lists it (`--font-sans: Inter, sans-serif` … `font-family: var(--font-sans)`, also
 * through other custom properties), as token-based CSS sets fonts.
 */
export function usesFamily(css: string, family: string): boolean {
  const rules = stripComments(css).replace(/@font-face\s*\{[^}]*\}/gi, '');
  const want = family.toLowerCase();
  const lists = (value: string, shorthand = false) => {
    const parts = value.replace(/!important/i, '').split(',').map((p) => p.trim());
    // `font: italic 700 1rem/1.5 "A B", serif`: the first part ends with a family after the size
    if (shorthand) parts[0] = parts[0]!.replace(/^.*\d[\w%.]*(?:\/[\w%.]+)?\s+/, '');
    return parts.some((p) => unquote(p).toLowerCase() == want);
  };
  const reads = (value: string) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
  // the custom properties whose value lists the family, then those that read one of them, until none is added
  const props = [...rules.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:\s*([^;}]+)/g)].map((m) => ({ name: m[1]!, value: m[2]! }));
  const naming = new Set(props.filter((p) => lists(p.value)).map((p) => p.name));
  for (let added = true; added;) {
    added = false;
    for (const p of props) if (!naming.has(p.name) && reads(p.value).some((n) => naming.has(n))) { naming.add(p.name); added = true; }
  }
  for (const m of rules.matchAll(/(?:^|[;{\s])font(-family)?\s*:\s*([^;}]+)/gi)) {
    if (lists(m[2]!, !m[1]) || reads(m[2]!).some((n) => naming.has(n))) return true;
  }
  return false;
}

/**
 * The top-level `@font-face` rules of a stylesheet, where each starts and ends. One in `@media`, `@supports` or
 * `@layer` is not listed: moved out of it, it would apply where it did not. Comments and strings are skipped, so a
 * brace in one opens or closes nothing.
 */
function topFontFaces(css: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  let depth = 0, at = -1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c == '/' && css[i + 1] == '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? css.length : e + 1; continue; }
    if (c == '"' || c == "'") { for (i++; i < css.length && css[i] != c; i++) if (css[i] == '\\') i++; continue; }
    if (c == '{') {
      // a block at the top level whose prelude is `@font-face` (the last `@` before it starts the prelude, or the
      // prelude is something else and the test fails)
      if (!depth++) { const a = css.lastIndexOf('@', i); at = a >= 0 && /^@font-face\s*$/i.test(css.slice(a, i)) ? a : -1; }
      continue;
    }
    if (c == '}' && depth && !--depth && at >= 0) {
      out.push({ start: at, end: i + 1, body: css.slice(css.indexOf('{', at) + 1, i) });
      at = -1;
    }
  }
  return out;
}

/** a descriptor of an `@font-face` rule's body */
const faceProp = (body: string, name: string) => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, 'i').exec(stripComments(body))?.[1]?.trim() ?? '';
/** a face the author gave no `font-display` (or `auto`: the browser's choice) */
const unsetDisplay = (body: string) => /^(auto)?$/i.test(faceProp(body, 'font-display'));
/** the files a face names, in order (not `data:` ones, read like the others by `read`) */
const faceUrls = (body: string) => [...stripComments(body).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((m) => m[2]!.trim());

/**
 * Builds (docs/first-paint.md#fonts-after-the-load): the families (lower case) of a stylesheet's top-level faces
 * without `font-display` that are text fonts, read from their files: the family's first face for Latin text (no
 * `unicode-range`, or one with `A`), else its first face, whose file `isText` reads (true for a text font, false
 * for an icon font, null when the file cannot be read: the next file). A family none of whose files reads is not
 * listed: its faces stay as they are.
 */
export async function textFamilies(css: string, isText: (url: string) => Promise<boolean | null>): Promise<Set<string>> {
  const out = new Set<string>(), byFamily = new Map<string, string[]>();
  for (const { body } of topFontFaces(css)) {
    if (!unsetDisplay(body)) continue;
    const family = unquote(faceProp(body, 'font-family')).toLowerCase();
    byFamily.set(family, [...(byFamily.get(family) ?? []), body]);
  }
  for (const [family, bodies] of byFamily) {
    const latin = bodies.filter((b) => !faceProp(b, 'unicode-range') || coversLatin(faceProp(b, 'unicode-range')));
    face: for (const body of latin.length ? latin : bodies.slice(0, 1)) {
      for (const url of faceUrls(body)) {
        const t = await isText(url).catch(() => null);
        if (t === null) continue;
        if (t) out.add(family);
        break face;
      }
    }
  }
  return out;
}

/**
 * Builds (docs/first-paint.md#fonts-after-the-load): the `@font-face` rules a page loads after its window's `load`
 * event, taken out of a stylesheet, and the stylesheet without them. A face is deferred when its `font-display` is
 * `swap` (the author accepts text in the fallback font until the font arrives), or when it has none (or `auto`) and
 * its family is one of `text` (`textFamilies`: a text font, whose text the browser's default would hide while the
 * file loads; deferred, it gets `swap`), and it is none of `keep` (the faces `fonts.preload` names, meant to be
 * early: every subset of the family, weight and style). `block`, `fallback`, `optional`, and a face without
 * `font-display` of an icon font or of a file the build could not read, stay. Null when the stylesheet has nothing to defer.
 */
export function deferredFaces(css: string, keep: FontFaceRef[] = [], text: ReadonlySet<string> = new Set()): { css: string; faces: string[] } | null {
  const prop = faceProp;
  const unset = (body: string) => unsetDisplay(body) && text.has(unquote(prop(body, 'font-family')).toLowerCase());
  const moved = topFontFaces(css).filter(({ body }) => {
    if (prop(body, 'font-display').toLowerCase() != 'swap' && !unset(body)) return false;
    const family = unquote(prop(body, 'font-family')).toLowerCase(), weight = prop(body, 'font-weight');
    const style = (prop(body, 'font-style') || 'normal').split(/\s+/)[0]!.toLowerCase();
    return !keep.some((f) => f.family.toLowerCase() == family && hasWeight(weight, f.weight) && style == f.style);
  });
  if (!moved.length) return null;
  let rest = '', from = 0;
  for (const m of moved) { rest += css.slice(from, m.start); from = m.end; }
  // a face without `font-display` gets `swap` where it loads late: with the browser's default it would hide the
  // text, already painted in the fallback font, until its file arrived
  const swap = (face: string, body: string) => !unset(body) ? face : /font-display\s*:/i.test(stripComments(body))
    ? face.replace(/font-display\s*:\s*auto/i, 'font-display:swap') : face.replace(/\{/, '{font-display:swap;');
  return { css: rest + css.slice(from), faces: moved.map((m) => swap(css.slice(m.start, m.end), m.body)) };
}

/**
 * A deferred face's `url(…)`s, relative ones rebased from the stylesheet it was in (`from`, a directory of the
 * bundle) to the one it moves to (`to`). Vite writes them relative to their stylesheet under a relative base.
 */
export function rebaseFace(face: string, from: string, to: string): string {
  if (from == to) return face;
  return face.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q: string, u: string) => {
    if (/^([a-z][\w+.-]*:|\/|#)/i.test(u)) return m;
    const r = posix.relative(to, posix.join(from, u));
    return `url(${q}${r.startsWith('.') ? r : `./${r}`}${q})`;
  });
}

/**
 * The system fonts a fallback face is made of, by generic family and bold: their names for `local()` (Arial and
 * Times New Roman on Windows, macOS and iOS; Liberation, with the same metrics, on Linux) and their metrics as
 * `fitMetrics` reads them from Liberation's files. Android has neither (Roboto, Noto Serif): the face does not
 * apply there, and text waits in the plain generic font.
 */
const SYSTEM_FIT: Record<'sans-serif' | 'serif', Array<{ local: string[]; avg: number }>> = {
  'sans-serif': [
    { local: ['Arial', 'ArialMT', 'Liberation Sans'], avg: 0.43958 },
    { local: ['Arial Bold', 'Arial-BoldMT', 'Liberation Sans Bold'], avg: 0.4754 },
    { local: ['Arial Italic', 'Arial-ItalicMT', 'Liberation Sans Italic'], avg: 0.43958 },
    { local: ['Arial Bold Italic', 'Arial-BoldItalicMT', 'Liberation Sans Bold Italic'], avg: 0.4754 },
  ],
  'serif': [
    { local: ['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif'], avg: 0.39831 },
    { local: ['Times New Roman Bold', 'TimesNewRomanPS-BoldMT', 'Liberation Serif Bold'], avg: 0.42395 },
    { local: ['Times New Roman Italic', 'TimesNewRomanPS-ItalicMT', 'Liberation Serif Italic'], avg: 0.39993 },
    { local: ['Times New Roman Bold Italic', 'TimesNewRomanPS-BoldItalicMT', 'Liberation Serif Bold Italic'], avg: 0.41 },
  ],
};

/** the family of a web font's fitted fallback faces */
export const fallbackFamily = (family: string) => `${family} Fallback`;

/**
 * Builds (docs/first-paint.md#fonts-after-the-load): a fallback face for each deferred face of Latin text, of the
 * face's weight and style, in a family of its own (`fallbackFamily`: `Inter Fallback`), made of a system font
 * (`local()`) fitted to the web font's metrics: the text that paints before the font arrives takes the lines and
 * nearly the width it will have, so the swap moves little. `withFallbackFamilies` names the family after the web
 * font's in the stylesheets' font lists: the text is in it until the web font's face has loaded, and where it
 * never loads. (A face of the web font's own family would do in Chromium and WebKit, which use a family's loaded
 * faces while another loads; Firefox goes to the next family.) `metrics(url)`: `fitMetrics` of a face's file, null
 * for one that cannot be read or is no text font, which gets none; `listed(family)`: whether a font list names the
 * family (one that none does needs no fallback). `css`: the stylesheet the faces came from (its
 * font lists say whether a family is a serif; a monospace family gets no fallback face).
 * Returns the rules and the families (as the faces name them) that got one.
 */
export async function fallbackFaces(faces: string[], css: string, listed: (family: string) => boolean, metrics: (url: string) => Promise<{ ascent: number; descent: number; lineGap: number; avg: number } | null>): Promise<{ css: string; families: string[] }> {
  const prop = (body: string, name: string) => new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, 'i').exec(body)?.[1]?.trim() ?? '';
  const rules = stripComments(css).replace(/@font-face\s*\{[^}]*\}/gi, '');
  /** serif or sans-serif: the generic family of a font list of `css` that names the family (none for monospace), else by its name */
  const generic = (family: string): 'sans-serif' | 'serif' | null => {
    for (const m of rules.matchAll(/(?:^|[;{\s])(?:font(?:-family)?|--[\w-]+)\s*:\s*([^;}]+)/gi)) {
      const list = m[1]!.toLowerCase().split(',').map((p) => p.replace(/["']/g, '').trim());
      if (!list.some((p) => p.endsWith(family.toLowerCase()))) continue;
      if (list.some((p) => /monospace/.test(p))) return null;
      if (list.includes('serif') || list.includes('ui-serif')) return 'serif';
      if (list.some((p) => /sans-serif|system-ui/.test(p))) return 'sans-serif';
    }
    return /\bserif\b/i.test(family) && !/\bsans\b/i.test(family) ? 'serif' : 'sans-serif';
  };
  const pct = (x: number) => `${+(x * 100).toFixed(2)}%`;
  const done = new Set<string>(), out: string[] = [], families = new Set<string>();
  for (const face of faces) {
    const body = stripComments(face.slice(face.indexOf('{') + 1, face.lastIndexOf('}')));
    if (prop(body, 'unicode-range') && !coversLatin(prop(body, 'unicode-range'))) continue;
    const family = unquote(prop(body, 'font-family')), weight = prop(body, 'font-weight') || '400', style = (prop(body, 'font-style') || 'normal').toLowerCase();
    const key = `${family.toLowerCase()};${weight};${style}`;
    if (done.has(key)) continue;
    done.add(key);
    const g = generic(family), url = /url\(\s*['"]?([^'")\s]+)/.exec(body)?.[1];
    if (!g || !url || !listed(family)) continue;
    const m = await metrics(url).catch(() => null);
    if (!m || !m.avg) continue;
    const w = /^\d+$/.test(weight) ? Number(weight) : /^bold$/i.test(weight) ? 700 : 400;
    const sys = SYSTEM_FIT[g][(w >= 600 ? 1 : 0) + (style.startsWith('normal') ? 0 : 2)]!, adjust = m.avg / sys.avg;
    families.add(family);
    out.push(`@font-face{font-family:${JSON.stringify(fallbackFamily(family))};font-style:${style};font-weight:${weight};src:${sys.local.map((l) => `local(${JSON.stringify(l)})`).join(',')};size-adjust:${pct(adjust)};ascent-override:${pct(m.ascent / adjust)};descent-override:${pct(m.descent / adjust)};line-gap-override:${pct(m.lineGap / adjust)}}`);
  }
  return { css: out.join(''), families: [...families] };
}

/**
 * Builds: a stylesheet with each of `families`' fitted fallback family (`fallbackFamily`) named right after it
 * wherever a `font-family` or `font` declaration, or a custom property's value, lists the family (quoted or not,
 * any case): `font-family: Inter, sans-serif` becomes `font-family: Inter, "Inter Fallback", sans-serif`.
 * `@font-face` rules, and a list that names the fallback already, are left as they are.
 */
export function withFallbackFamilies(css: string, families: string[]): string {
  if (!families.length) return css;
  const by = new Map(families.map((f) => [f.toLowerCase(), f]));
  const rewrite = (part: string) => part.replace(/(^|[;{\s])(font-family|font|--[\w-]+)(\s*:\s*)([^;{}]+)/gi, (m, pre: string, name: string, colon: string, value: string) => {
    if (/ fallback["']?\s*(,|$|!)/i.test(value)) return m;
    let changed = false;
    const items = value.split(',').map((item, i) => {
      const imp = /\s*!important\s*$/i.exec(item)?.[0] ?? '', bare = imp ? item.slice(0, -imp.length) : item;
      // `font: italic 700 1rem/1.5 Inter, serif`: the first item ends with the family, after the size
      const fam = by.get(unquote(bare.trim()).toLowerCase()) ?? (name.toLowerCase() == 'font' && i == 0 ? [...by].find(([k]) => new RegExp(`\\d[\\w%.]*(?:\\/[\\w%.]+)?\\s+["']?${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'i').test(bare))?.[1] : undefined);
      if (!fam) return item;
      changed = true;
      return `${bare},${JSON.stringify(fallbackFamily(fam))}${imp}`;
    });
    return changed ? `${pre}${name}${colon}${items.join(',')}` : m;
  });
  // outside the `@font-face` rules (a face's own `font-family` is its name)
  let out = '', from = 0;
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) { out += rewrite(css.slice(from, m.index)) + m[0]; from = m.index! + m[0].length; }
  return out + rewrite(css.slice(from));
}
