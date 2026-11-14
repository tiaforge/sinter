// @vitest-environment node
// `line-height: normal` from a font file (src/font-metrics.ts): the smallest of the metrics engines
// space lines by, so the reserved space of a list stays a lower bound. Synthetic fonts for each
// container format; with Playwright and a system font installed, the ratio against Chromium too.
import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { familyLineHeights, familyZeroWidths, fontFaces, normalLineHeight, zeroWidth } from '../src/font-metrics.js';
import { chromium } from './browser.js';

/** the three tables the reader uses: head (unitsPerEm), hhea and OS/2 (fsSelection, typo and win metrics) */
function tables(m: { upm: number; asc: number; desc: number; gap: number; typo?: [number, number, number]; win?: [number, number]; useTypo?: boolean }) {
  const head = new Uint8Array(54), hhea = new Uint8Array(36), os2 = new Uint8Array(96);
  const h = new DataView(head.buffer), hh = new DataView(hhea.buffer), o = new DataView(os2.buffer);
  h.setUint32(12, 0x5f0f3cf5); h.setUint16(18, m.upm);
  hh.setInt16(4, m.asc); hh.setInt16(6, m.desc); hh.setInt16(8, m.gap);
  o.setUint16(0, 4); o.setUint16(62, m.useTypo ? 0x80 : 0);
  const [ta, td, tg] = m.typo ?? [m.asc, m.desc, m.gap], [wa, wd] = m.win ?? [m.asc, -m.desc];
  o.setInt16(68, ta); o.setInt16(70, td); o.setInt16(72, tg); o.setUint16(74, wa); o.setUint16(76, wd);
  return [['head', head], ['hhea', hhea], ['OS/2', os2]] as Array<[string, Uint8Array]>;
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function ttf(t: Array<[string, Uint8Array]>): Uint8Array {
  const dir = 12 + t.length * 16, size = dir + t.reduce((a, [, b]) => a + b.length, 0);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000); v.setUint16(4, t.length);
  let off = dir;
  t.forEach(([tag, b], i) => { out.set(ascii(tag), 12 + i * 16); v.setUint32(12 + i * 16 + 8, off); v.setUint32(12 + i * 16 + 12, b.length); out.set(b, off); off += b.length; });
  return out;
}

function woff(t: Array<[string, Uint8Array]>): Uint8Array {
  const parts = t.map(([tag, b]) => ({ tag, b, z: new Uint8Array(deflateSync(b)) }));
  const dir = 44 + t.length * 20, size = dir + parts.reduce((a, p) => a + p.z.length, 0);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  out.set(ascii('wOFF')); v.setUint16(12, t.length);
  let off = dir;
  parts.forEach((p, i) => { const at = 44 + i * 20; out.set(ascii(p.tag), at); v.setUint32(at + 4, off); v.setUint32(at + 8, p.z.length); v.setUint32(at + 12, p.b.length); out.set(p.z, off); off += p.z.length; });
  return out;
}

function woff2(t: Array<[string, Uint8Array]>): Uint8Array {
  // known tags: head 1, hhea 2, OS/2 6; a cmap first (index 0, transform 0: null) to check the offsets follow the directory
  const cmap = new Uint8Array(7).fill(9);
  const all: Array<[number, Uint8Array]> = [[0, cmap], ...t.map(([tag, b]) => [({ head: 1, hhea: 2, 'OS/2': 6 } as Record<string, number>)[tag]!, b] as [number, Uint8Array])];
  const dir = all.flatMap(([k, b]) => [k, ...base128(b.length)]);
  const data = new Uint8Array(brotliCompressSync(Buffer.concat(all.map(([, b]) => b))));
  const out = new Uint8Array(48 + dir.length + data.length), v = new DataView(out.buffer);
  out.set(ascii('wOF2')); v.setUint32(4, 0x00010000); v.setUint16(12, all.length); v.setUint32(20, data.length);
  out.set(dir, 48); out.set(data, 48 + dir.length);
  return out;
}
function base128(n: number): number[] {
  const out = [n & 0x7f];
  while ((n = Math.floor(n / 128))) out.unshift((n & 0x7f) | 0x80);
  return out;
}

describe('the metrics of a font', () => {
  const plain = tables({ upm: 1000, asc: 900, desc: -300, gap: 100 });
  test('each container: ttf, woff, woff2', () => {
    for (const f of [ttf(plain), woff(plain), woff2(plain)]) expect(normalLineHeight(f)).toBeCloseTo(1.2, 5);
  });
  test('the smallest of hhea and Windows ascent and descent, line gaps left out', () => {
    expect(normalLineHeight(ttf(tables({ upm: 2048, asc: 1854, desc: -434, gap: 67, win: [1854, 300] })))).toBeCloseTo(2154 / 2048, 5);
  });
  test('with USE_TYPO_METRICS, the typo values instead of Windows\'', () => {
    expect(normalLineHeight(ttf(tables({ upm: 1000, asc: 900, desc: -300, gap: 100, typo: [800, -200, 100], useTypo: true })))).toBeCloseTo(1, 5);
  });
  test('what is not a font: null', () => {
    expect(normalLineHeight(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(normalLineHeight(ttf(plain.filter(([t]) => t !== 'head')))).toBeNull();
  });
});

describe('the faces of the stylesheets', () => {
  test('@font-face rules: family, files, Latin, regular', () => {
    expect(fontFaces(`@font-face { font-family: 'Source Sans'; font-weight: 400; src: url(./a.woff2) format('woff2'), url("./a.woff") format('woff'); unicode-range: U+0000-00FF }
      @font-face { font-family: X; font-style: italic; src: url(b.woff2); unicode-range: U+0400-045F }`)).toEqual([
      { family: 'source sans', urls: ['./a.woff2', './a.woff'], local: [], latin: true, regular: true },
      { family: 'x', urls: ['b.woff2'], local: [], latin: false, regular: false },
    ]);
  });
  test('a family\'s ratio from its regular Latin face, the first file that reads', async () => {
    const files: Record<string, Uint8Array> = { 'b.woff2': woff2(tables({ upm: 1000, asc: 800, desc: -200, gap: 0 })), 'good.woff': woff(tables({ upm: 1000, asc: 1000, desc: -250, gap: 0 })) };
    const css = `@font-face { font-family: F; font-weight: 700; src: url(b.woff2) }
      @font-face { font-family: F; src: url(missing.woff2), url(good.woff) }`;
    const r = await familyLineHeights([{ file: '/app/a.css', css }], async (u) => files[u] ?? null);
    expect(r.get('f')).toBeCloseTo(1.25, 5);
  });
  test('a fallback face: its overrides, or the system font it takes, scaled by size-adjust', async () => {
    const r = await familyLineHeights([{ file: '/app/a.css', css: `@font-face { font-family: "Inter Fallback"; src: local("Arial"); ascent-override: 90%; descent-override: 22.4%; size-adjust: 107% }
      @font-face { font-family: Narrow; src: local('Arial'); size-adjust: 90% }
      @font-face { font-family: Plain; src: local(Helvetica Neue) }` }], async () => null);
    expect(r.get('inter fallback')).toBeCloseTo(1.124, 5);
    expect(r.get('narrow')).toBeCloseTo((2288 / 2048) * 0.9, 5);
    expect(r.get('plain')).toBeCloseTo(1.165, 5);
  });
});

const SYSTEM = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', '/usr/share/fonts/truetype/freefont/FreeSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', 'C:\\Windows\\Fonts\\arial.ttf'].filter((f) => existsSync(f));

describe.skipIf(!chromium || !SYSTEM.length)('Chromium spaces lines at least by the ratio, less the pixel it rounds away', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  beforeAll(async () => { browser = await chromium!.launch(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  for (const file of SYSTEM) test(file, async () => {
    const bytes = readFileSync(file), r = normalLineHeight(new Uint8Array(bytes))!;
    const tab = await browser.newPage();
    await tab.setContent(`<style>@font-face{font-family:T;src:url(data:font/ttf;base64,${bytes.toString('base64')})} span{font-family:T;line-height:normal}</style>${[12, 16, 23, 100].map((s) => `<div><span style="font-size:${s}px">Ag</span></div>`).join('')}`);
    await tab.evaluate(() => document.fonts.ready);
    const real = await tab.evaluate(() => [...document.querySelectorAll('span')].map((s) => [parseFloat((s as HTMLElement).style.fontSize), s.getBoundingClientRect().height]));
    for (const [size, h] of real) expect(r * size! - 1, `${size}px`).toBeLessThanOrEqual(h! + 0.01);
    await tab.close();
  });
});

/** head, hhea and hmtx with `n` full metrics, and a cmap mapping U+0030 to `gid` (format 4 by delta or by glyph array, or format 12) */
function zeroFont(o: { upm: number; advances: number[]; gid: number; format: 4 | 12; byArray?: boolean }): Array<[string, Uint8Array]> {
  const head = new Uint8Array(54), hhea = new Uint8Array(36);
  new DataView(head.buffer).setUint32(12, 0x5f0f3cf5); new DataView(head.buffer).setUint16(18, o.upm);
  new DataView(hhea.buffer).setUint16(34, o.advances.length);
  const hmtx = new Uint8Array(o.advances.length * 4 + 20);
  o.advances.forEach((a, i) => new DataView(hmtx.buffer).setUint16(i * 4, a));
  let sub: Uint8Array;
  if (o.format === 12) {
    sub = new Uint8Array(16 + 24); const v = new DataView(sub.buffer);
    v.setUint16(0, 12); v.setUint32(12, 2);
    v.setUint32(16, 0x20); v.setUint32(20, 0x2f); v.setUint32(24, 1);
    v.setUint32(28, 0x30); v.setUint32(32, 0x39); v.setUint32(36, o.gid);
  } else {
    // segments: [0x30, 0x39] and the closing 0xffff
    const seg2 = 4, arr = o.byArray ? 10 : 0;
    sub = new Uint8Array(16 + seg2 * 4 + arr * 2); const v = new DataView(sub.buffer);
    v.setUint16(0, 4); v.setUint16(6, seg2);
    const ends = 14, starts = ends + seg2 + 2, deltas = starts + seg2, ranges = deltas + seg2;
    v.setUint16(ends, 0x39); v.setUint16(ends + 2, 0xffff); v.setUint16(starts, 0x30); v.setUint16(starts + 2, 0xffff);
    v.setInt16(deltas + 2, 1);
    if (o.byArray) { v.setUint16(ranges, 4); v.setUint16(ranges + 4, o.gid); } else v.setInt16(deltas, o.gid - 0x30);
  }
  const cmap = new Uint8Array(12 + sub.length); const cv = new DataView(cmap.buffer);
  cv.setUint16(2, 1); cv.setUint16(4, 3); cv.setUint16(6, o.format === 12 ? 10 : 1); cv.setUint32(8, 12); cmap.set(sub, 12);
  return [['head', head], ['hhea', hhea], ['cmap', cmap], ['hmtx', hmtx]];
}
/** WOFF2 of these tables (known indices), `hmtx` transformed or not */
function woff2Zero(t: Array<[string, Uint8Array]>, hmtxTransformed = false): Uint8Array {
  const idx: Record<string, number> = { cmap: 0, head: 1, hhea: 2, hmtx: 3 };
  const dir = t.flatMap(([tag, b]) => [idx[tag]! | (tag === 'hmtx' && hmtxTransformed ? 1 << 6 : 0), ...base128(b.length), ...(tag === 'hmtx' && hmtxTransformed ? base128(b.length) : [])]);
  const data = new Uint8Array(brotliCompressSync(Buffer.concat(t.map(([, b]) => b))));
  const out = new Uint8Array(48 + dir.length + data.length), v = new DataView(out.buffer);
  out.set(ascii('wOF2')); v.setUint32(4, 0x00010000); v.setUint16(12, t.length); v.setUint32(20, data.length);
  out.set(dir, 48); out.set(data, 48 + dir.length);
  return out;
}

describe('the width of 0 in a font (1ch)', () => {
  test('format 4 by delta and by glyph array, format 12; a glyph past the last full metric takes its advance', () => {
    expect(zeroWidth(ttf(zeroFont({ upm: 1000, advances: [500, 600, 610], gid: 2, format: 4 })))).toBeCloseTo(0.61, 6);
    expect(zeroWidth(ttf(zeroFont({ upm: 2048, advances: [500, 1200, 1300], gid: 1, format: 4, byArray: true })))).toBeCloseTo(1200 / 2048, 6);
    expect(zeroWidth(ttf(zeroFont({ upm: 1000, advances: [500, 640], gid: 7, format: 12 })))).toBeCloseTo(0.64, 6);
  });
  test('each container; a WOFF2 whose hmtx is transformed is not read', () => {
    const t = zeroFont({ upm: 1000, advances: [500, 600, 610], gid: 2, format: 4 });
    for (const f of [woff(t), woff2Zero(t)]) expect(zeroWidth(f)).toBeCloseTo(0.61, 6);
    expect(zeroWidth(woff2Zero(t, true))).toBeNull();
    expect(zeroWidth(new Uint8Array(40))).toBeNull();
  });
  test('a family: the widest of its Latin faces; one unreadable face leaves it unknown', async () => {
    const files: Record<string, Uint8Array> = { 'r.ttf': ttf(zeroFont({ upm: 1000, advances: [500, 550], gid: 1, format: 4 })), 'b.ttf': ttf(zeroFont({ upm: 1000, advances: [500, 600], gid: 1, format: 4 })) };
    const read = async (u: string) => files[u] ?? null;
    const css = `@font-face { font-family: A; src: url(r.ttf) } @font-face { font-family: A; font-weight: 700; src: url(b.ttf) }
      @font-face { font-family: B; src: url(r.ttf) } @font-face { font-family: B; font-style: italic; src: url(missing.ttf) }
      @font-face { font-family: C; src: local(Arial) }`;
    const m = await familyZeroWidths([{ file: 'a.css', css }], read);
    expect(m.get('a')).toBeCloseTo(0.6, 6);
    expect(m.get('b')).toBeNull();
    expect(m.get('c')).toBe(0.7);
  });
});

const ZERO_FILES = [...SYSTEM, '/usr/share/fonts/opentype/inter/Inter-Regular.otf', '/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf'].filter((f) => existsSync(f));

describe.skipIf(!chromium || !ZERO_FILES.length)('Chromium draws 0 as wide as the file says', () => {
  let browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>;
  beforeAll(async () => { browser = await chromium!.launch(); }, 30_000);
  afterAll(async () => { await browser?.close(); });
  for (const file of ZERO_FILES) test(file, async () => {
    const bytes = readFileSync(file), z = zeroWidth(new Uint8Array(bytes))!;
    expect(z).not.toBeNull();
    const tab = await browser.newPage();
    await tab.setContent(`<style>@font-face{font-family:T;src:url(data:font/ttf;base64,${bytes.toString('base64')})} div{font:100px T;width:10ch}</style><div>0</div>`);
    await tab.evaluate(() => document.fonts.ready);
    expect(await tab.evaluate(() => document.querySelector('div')!.getBoundingClientRect().width / 1000)).toBeCloseTo(z, 3);
    await tab.close();
  });
});
