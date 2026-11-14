// `line-height: normal` from a font file (builds): what the browser spaces lines of that font by, as
// a multiple of its size, for the space a list's rows take before their data (docs/first-paint.md).
// Browsers take it from the font's own metrics, and not all from the same table: the `hhea`
// ascender and descender (with or without its line gap), the `OS/2` typo values when the font sets
// USE_TYPO_METRICS, or its Windows ascent and descent. The smallest of them, without line gaps,
// holds in every engine: the space is a lower bound.
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { SYSTEM_FONTS, UNKNOWN_ZERO } from './compiler/system-fonts.js';

/** Tables the reader needs, as their bytes. */
type Tables = Map<string, Uint8Array>;

/** The `line-height: normal` of a font (ttf, otf, woff, woff2) as a multiple of its size, or null when the file cannot be read. */
export function normalLineHeight(bytes: Uint8Array): number | null {
  let tables: Tables | null;
  try { tables = tablesOf(bytes); } catch { return null; }
  if (!tables) return null;
  const head = tables.get('head'), hhea = tables.get('hhea'), os2 = tables.get('OS/2');
  if (!head || head.length < 54 || !hhea || hhea.length < 10) return null;
  const v = view(head), upm = v.getUint16(18);
  if (!upm || v.getUint32(12) !== 0x5f0f3cf5) return null;
  // the line gaps left out: not every engine adds them (Chromium on Linux does not with the typo metrics)
  const h = view(hhea);
  const out = [(h.getInt16(4) - h.getInt16(6)) / upm];
  if (os2 && os2.length >= 78) {
    const o = view(os2);
    const useTypo = (o.getUint16(62) & 0x80) !== 0;
    out.push(useTypo ? (o.getInt16(68) - o.getInt16(70)) / upm : (o.getUint16(74) + o.getUint16(76)) / upm);
  }
  const r = Math.min(...out.filter((x) => x > 0));
  return Number.isFinite(r) ? r : null;
}

/**
 * The advance width of the digit zero (`0`, U+0030) as a multiple of the font's size: what `1ch` is in that
 * font. Null when the file cannot be read or has no `0`.
 */
export function zeroWidth(bytes: Uint8Array): number | null {
  let tables: Tables | null;
  try { tables = tablesOf(bytes); } catch { return null; }
  const head = tables?.get('head'), hhea = tables?.get('hhea'), cmap = tables?.get('cmap'), hmtx = tables?.get('hmtx');
  if (!head || head.length < 54 || !hhea || hhea.length < 36 || !cmap || !hmtx) return null;
  try {
    const upm = view(head).getUint16(18);
    const gid = glyphOf(cmap, 0x30);
    const n = view(hhea).getUint16(34);
    if (!upm || !gid || !n) return null;
    const adv = view(hmtx).getUint16(Math.min(gid, n - 1) * 4);
    return adv ? adv / upm : null;
  } catch { return null; }
}

/** the glyph of a code point from a `cmap` (format 12 or 4 of a Unicode subtable); 0 when none */
function glyphOf(cmap: Uint8Array, cp: number): number {
  const v = view(cmap), n = v.getUint16(2);
  const subs: Array<{ rank: number; off: number }> = [];
  for (let i = 0; i < n; i++) {
    const pid = v.getUint16(4 + i * 8), eid = v.getUint16(6 + i * 8), off = v.getUint32(8 + i * 8);
    const rank = pid === 3 && eid === 10 ? 0 : pid === 0 && eid >= 4 ? 1 : pid === 3 && eid === 1 ? 2 : pid === 0 ? 3 : -1;
    if (rank >= 0) subs.push({ rank, off });
  }
  for (const { off } of subs.sort((a, b) => a.rank - b.rank)) {
    const format = v.getUint16(off);
    if (format === 12) {
      const groups = v.getUint32(off + 12);
      for (let g = 0; g < groups; g++) {
        const at = off + 16 + g * 12, lo = v.getUint32(at), hi = v.getUint32(at + 4);
        if (cp >= lo && cp <= hi) return v.getUint32(at + 8) + (cp - lo);
      }
    } else if (format === 4) {
      const seg2 = v.getUint16(off + 6), ends = off + 14, starts = ends + seg2 + 2, deltas = starts + seg2, ranges = deltas + seg2;
      for (let i = 0; i < seg2; i += 2) {
        if (v.getUint16(ends + i) < cp) continue;
        const start = v.getUint16(starts + i);
        if (start > cp) break;
        const delta = v.getInt16(deltas + i), ro = v.getUint16(ranges + i);
        if (!ro) return (cp + delta) & 0xffff;
        const g = v.getUint16(ranges + i + ro + (cp - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      }
    }
  }
  return 0;
}

/**
 * The width of `0` in each family the stylesheets declare with `@font-face` (lower case), from its regular
 * Latin face's first file that reads; null for a family none of whose files can be read (its `ch` is not known).
 */
export async function familyZeroWidths(sheets: Array<{ file: string; css: string }>, read: (url: string, sheet: string) => Promise<Uint8Array | null>): Promise<Map<string, number | null>> {
  const faces = sheets.flatMap((s) => fontFaces(s.css).map((f) => ({ ...f, sheet: s.file })));
  const out = new Map<string, number | null>();
  for (const family of new Set(faces.map((f) => f.family))) {
    const mine = faces.filter((f) => f.family === family);
    let widest: number | null = null, unread = false;
    // every face may render `0` (a weight, an italic): the widest of them; one that cannot be read leaves it unknown
    for (const f of mine.filter((x) => x.latin)) {
      let r: number | null = null;
      for (const url of f.urls) {
        const bytes = await read(url, f.sheet).catch(() => null);
        if (bytes && (r = zeroWidth(bytes)) !== null) break;
      }
      // a face from the system (`local()`): a font the build does not have, at most `UNKNOWN_ZERO`
      if (r === null && f.local.length) r = UNKNOWN_ZERO;
      if (r === null) { unread = true; break; }
      if (f.sizeAdjust !== undefined) r = Math.max(r, r * f.sizeAdjust);
      widest = Math.max(widest ?? 0, r);
    }
    out.set(family, unread ? null : widest);
  }
  return out;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
const WANTED = new Set(['head', 'hhea', 'OS/2', 'cmap', 'hmtx']);

function tablesOf(b: Uint8Array): Tables | null {
  const sig = tag(b, 0);
  if (sig === 'wOFF') return woff(b);
  if (sig === 'wOF2') return woff2(b);
  if (sig === '\0\x01\0\0' || sig === 'OTTO' || sig === 'true') return sfnt(b);
  return null;
}

function sfnt(b: Uint8Array): Tables {
  const v = view(b), n = v.getUint16(4), out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16, t = tag(b, at);
    if (WANTED.has(t)) out.set(t, b.subarray(v.getUint32(at + 8), v.getUint32(at + 8) + v.getUint32(at + 12)));
  }
  return out;
}

function woff(b: Uint8Array): Tables {
  const v = view(b), n = v.getUint16(12), out: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20, t = tag(b, at);
    if (!WANTED.has(t)) continue;
    const off = v.getUint32(at + 4), comp = v.getUint32(at + 8), orig = v.getUint32(at + 12);
    const data = b.subarray(off, off + comp);
    out.set(t, comp < orig ? new Uint8Array(inflateSync(data)) : data);
  }
  return out;
}

/** the tags a WOFF2 table directory names by index (the spec's known-tag table) */
const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp',
  'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ',
  'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

function woff2(b: Uint8Array): Tables | null {
  const v = view(b);
  if (tag(b, 4) === 'ttcf') return null;
  const n = v.getUint16(12), compressed = v.getUint32(20);
  let at = 48;
  const base128 = () => {
    let x = 0;
    for (let i = 0; i < 5; i++) { const c = b[at++]!; x = x * 128 + (c & 0x7f); if (!(c & 0x80)) return x; }
    throw new Error('bad UIntBase128');
  };
  const dir: Array<{ tag: string; length: number; transformed: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const flags = b[at++]!, known = flags & 0x3f;
    const t = known === 63 ? tag(b, (at += 4) - 4) : KNOWN[known]!;
    const orig = base128();
    // glyf and loca are transformed unless their version is 3; every other table only with a version other than 0
    const version = flags >> 6, transformed = t === 'glyf' || t === 'loca' ? version !== 3 : version !== 0;
    dir.push({ tag: t, length: transformed ? base128() : orig, transformed });
  }
  const data = new Uint8Array(brotliDecompressSync(b.subarray(at, at + compressed)));
  const out: Tables = new Map();
  let off = 0;
  for (const d of dir) {
    // a transformed hmtx (its advances in another layout) is left out: not read
    if (WANTED.has(d.tag) && !(d.tag === 'hmtx' && d.transformed)) out.set(d.tag, data.subarray(off, off + d.length));
    off += d.length;
  }
  return out;
}

/**
 * A face of a stylesheet's `@font-face` rules: its family (lower case), the URLs of its files and the
 * fonts it takes from the system (`local()`, lower case), in order, and the metrics it overrides
 * (`ascent-override`, `descent-override`, `size-adjust`, as fractions), as fallback faces set them.
 */
export interface FontFace { family: string; urls: string[]; local: string[]; latin: boolean; regular: boolean; ascent?: number; descent?: number; sizeAdjust?: number }

/** The `@font-face` rules of a stylesheet. */
export function fontFaces(css: string): FontFace[] {
  const out: FontFace[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1]!;
    const fam = /font-family\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
    const src = /(?:^|;)\s*src\s*:\s*([^;]+)/i.exec(body)?.[1];
    if (!fam || !src) continue;
    const urls = [...src.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((u) => u[2]!.trim());
    const local = [...src.matchAll(/local\(\s*(['"]?)([^'")]+)\1\s*\)/gi)].map((u) => u[2]!.trim().toLowerCase());
    const pct = (name: string) => { const v = new RegExp(`${name}\\s*:\\s*([\\d.]+)%`, 'i').exec(body)?.[1]; return v === undefined ? {} : { [name === 'size-adjust' ? 'sizeAdjust' : name.split('-')[0]!]: Number(v) / 100 }; };
    const range = /unicode-range\s*:\s*([^;]+)/i.exec(body)?.[1];
    // a face for Latin text: no unicode-range, or one that covers A (U+0041)
    const latin = !range || range.split(',').some((r) => {
      const x = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(r.trim());
      if (!x) return false;
      const lo = parseInt(x[1]!.replace(/\?/g, '0'), 16), hi = x[2] ? parseInt(x[2], 16) : parseInt(x[1]!.replace(/\?/g, 'f'), 16);
      return lo <= 0x41 && 0x41 <= hi;
    });
    const w = /font-weight\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? '400', s = /font-style\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? 'normal';
    const regular = /^normal$/i.test(s) && (/^(400|normal)$/i.test(w) || /^\d+\s+\d+$/.test(w));
    if (urls.length || local.length) out.push({ family: fam.toLowerCase(), urls, local, latin, regular, ...pct('ascent-override'), ...pct('descent-override'), ...pct('size-adjust') });
  }
  return out;
}

/**
 * `line-height: normal` of each family the stylesheets declare with `@font-face` (lower case), from
 * its regular Latin face's file (the first one `read` gives); families whose file cannot be had are
 * left out. `read(url, sheet)`: a URL as the stylesheet `sheet` (a file) writes it.
 */
export async function familyLineHeights(sheets: Array<{ file: string; css: string }>, read: (url: string, sheet: string) => Promise<Uint8Array | null>): Promise<Map<string, number>> {
  const faces = sheets.flatMap((s) => fontFaces(s.css).map((f) => ({ ...f, sheet: s.file })));
  const out = new Map<string, number>();
  for (const family of new Set(faces.map((f) => f.family))) {
    const mine = faces.filter((f) => f.family === family);
    // the regular Latin face first, then any Latin face, then any
    const order = [...mine.filter((f) => f.latin && f.regular), ...mine.filter((f) => f.latin && !f.regular), ...mine.filter((f) => !f.latin)];
    for (const f of order) {
      let r: number | null = null;
      // overridden metrics are the face's, whatever its file; else its first file that reads, or the system font it takes
      if (f.ascent !== undefined && f.descent !== undefined) r = f.ascent + f.descent;
      for (const url of r === null ? f.urls : []) {
        const bytes = await read(url, f.sheet).catch(() => null);
        if (bytes && (r = normalLineHeight(bytes)) !== null) break;
      }
      for (const l of r === null ? f.local : []) if (SYSTEM_FONTS[l] !== undefined) { r = SYSTEM_FONTS[l]!; break; }
      // `size-adjust` scales the metrics (whether it scales overrides too is read both ways: the smaller)
      if (r !== null && f.sizeAdjust !== undefined) r = Math.min(r, r * f.sizeAdjust);
      if (r !== null) { out.set(family, r); break; }
    }
  }
  return out;
}
