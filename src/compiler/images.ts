// Static images: an `<img src="./photo.jpg">` becomes a `<picture>` with a `<source>` per format and
// `srcset` widths, plus `width`/`height`, lazy loading and a stylesheet rule (height: auto, the
// dominant color as background). Pure: what an image is (size, transparency, kind, color) comes
// from the adapter's `ImageHost`, which analyses files with sharp and encodes the variants this
// returns. See docs/images.md.
import type { DefaultTreeAdapterMap } from 'parse5';
import { boxSizesCss, type Affine, type FixedBox, type FluidSizes, type StyleSheet } from './layout.js';

type P5Element = DefaultTreeAdapterMap['element'];
type P5Node = DefaultTreeAdapterMap['node'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

export type ImageKind = 'photo' | 'graphic';
/** `original`: the source file as it is (tiny images) */
export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png' | 'original';

/** What the adapter knows about a source file. */
export interface ImageInfo {
  /** after EXIF orientation */
  width: number;
  height: number;
  /** has transparent pixels */
  alpha: boolean;
  kind: ImageKind;
  /** dominant color (`#rrggbb`) of an opaque image, else null */
  color: string | null;
  bytes: number;
  /** content hash of the source file */
  hash: string;
}

/** One file the adapter encodes: a source, cropped (in source pixels, after orientation) and resized. */
export interface ImageVariant {
  file: string;
  /** the source's content hash */
  hash: string;
  kind: ImageKind;
  format: ImageFormat;
  width: number;
  height: number;
  crop?: { left: number; top: number; width: number; height: number };
}

export interface ImageHost {
  /** the source at this absolute path; `undefined`: not analysed yet (reported in `pending`), `null`: not an image to optimize */
  info(file: string): ImageInfo | null | undefined;
  /** the URL a variant is served from */
  url(v: ImageVariant): string;
  /** widths for fluid images (default `FLUID_WIDTHS`) */
  widths?: number[];
  /** add `vite-ignore`, so Vite's HTML processing leaves the variants' URLs alone */
  ignore?: boolean;
  /** what the page module imports for the images' rules (`ImageResult.css`), which the adapter serves */
  stylesheet?: string;
  /** the stylesheets the page loads, in order: fixed sizes in them are boxes (layout.ts) */
  styles?: StyleSheet[];
}

export interface ImageResult {
  /** source files `info()` did not know yet: analyse them and compile again */
  pending: string[];
  variants: ImageVariant[];
  /** rules for the rewritten images, imported by the page module; empty when there are none */
  css: string;
}

export const FLUID_WIDTHS = [480, 960, 1440, 1920, 2560];
/** SN514: an image in the rows of an `auto-fit` grid */
export const AUTO_FIT_ROWS = 'this image is in a `repeat(auto-fit, …)` grid whose items are the rows of a `data-sn-for`: its columns stretch when there are fewer items than fit in a row, and how many rows there are is known only at runtime, so its size is not; it gets an upper bound instead';
export const AUTO_FIT_HINT = 'use `repeat(auto-fill, …)` (the same columns, without stretching a short list) and the image gets exact sizes, or write `sizes`';
/** sources smaller than this get no `<source>`: the original file, with dimensions */
export const TINY_BYTES = 4096;
/** boxes up to this area also get a 3x file */
const SMALL_BOX = 300 * 300;
const OPTIMIZED = /\.(jpe?g|png|webp|avif)$/i;
const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp' };

export interface RewriteContext {
  host: ImageHost;
  root: string;
  /** the file an element came from (a partial's for included markup) */
  fileOf(el: P5Element): string;
  warn(el: P5Element, attr: string, code: 'SN511' | 'SN512' | 'SN514', message: string, hint: string): void;
  /** the box the page's stylesheets give the element (layout.ts), when the adapter passed them */
  layout?: (el: P5Element) => FixedBox | 'fluid' | null;
  /** an upper bound of a fluid image's width from its containers (layout.ts) */
  maxWidth?: (el: P5Element) => number | null;
  /** a fluid image's rendered width at every viewport width, as `sizes` (layout.ts); `intrinsic`: its source width */
  fluidSizes?: (el: P5Element, intrinsic?: number) => FluidSizes | null;
  /** the stylesheets' box width (`box`) or a fluid image's bound (`bound`) at every default font size (layout.ts), when it follows it */
  scaled?: (el: P5Element, what: 'box' | 'bound') => Affine | null;
  /** after `fluidSizes()` gave up: the `auto-fit` grid with template rows that was why, if it was */
  autoFitRows?: () => P5Element | null;
}

/** Rewrites every static `<img>` under `doc` in place; returns what the adapter encodes and the page's rules. */
export function rewriteImages(doc: P5Parent, ctx: RewriteContext): ImageResult {
  const result: ImageResult = { pending: [], variants: [], css: '' };
  const rules = new Set<string>();
  const seen = new Set<string>();
  let first = true;
  const visit = (parent: P5Parent, inTemplate: boolean) => {
    for (const node of [...parent.childNodes] as P5Node[]) {
      if (!('tagName' in node)) continue;
      const el = node as P5Element;
      if (el.tagName === 'template') { visit((el as P5Template).content, true); continue; }
      if (el.tagName === 'img') {
        const eager = first && !inTemplate;
        if (!inTemplate) first = false;
        const out = rewriteOne(el, eager, ctx);
        if (out === 'pending') {
          const f = sourceFile(el, ctx)!;
          if (!result.pending.includes(f)) result.pending.push(f);
        } else if (out) {
          for (const v of out.variants) {
            const key = ctx.host.url(v);
            if (!seen.has(key)) { seen.add(key); result.variants.push(v); }
          }
          if (out.rule) rules.add(out.rule);
        }
        continue;
      }
      visit(el, inTemplate);
    }
  };
  visit(doc, false);
  result.css = [...rules].join('\n') + (rules.size ? '\n' : '');
  return result;
}

const attrOf = (el: P5Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const setAttr = (el: P5Element, name: string, value: string) => {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = value; else el.attrs.push({ name, value });
};
const removeAttr = (el: P5Element, name: string) => { el.attrs = el.attrs.filter((a) => a.name !== name); };

/** The absolute path of a local, optimizable `src`, or null. */
function sourceFile(el: P5Element, ctx: RewriteContext): string | null {
  const src = attrOf(el, 'src')?.trim();
  if (!src || /^[a-z][a-z\d+.-]*:|^\/\/|[?#]/i.test(src) || !OPTIMIZED.test(src)) return null;
  let path: string;
  try { path = decodeURI(src); } catch { return null; }
  const from = ctx.fileOf(el);
  const dir = from.slice(0, from.lastIndexOf('/')) || '/';
  return normalize(path.startsWith('/') ? `${ctx.root}/${path}` : `${dir}/${path}`);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return '/' + out.join('/');
}

interface Style { decls: Array<[string, string]> }

function parseStyle(text: string | undefined): Style {
  const decls: Array<[string, string]> = [];
  for (const part of (text ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) { if (part.trim()) decls.push([part.trim(), '']); continue; }
    decls.push([part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim()]);
  }
  return { decls };
}

const styleValue = (s: Style, prop: string) => s.decls.findLast(([p]) => p === prop)?.[1].toLowerCase();

/** `object-position` as percentages (x, y); lengths count as the center. */
function position(value: string | undefined): [number, number] {
  const words = (value ?? '').split(/\s+/).filter(Boolean);
  const X: Record<string, number> = { left: 0, center: 50, right: 100 };
  const Y: Record<string, number> = { top: 0, center: 50, bottom: 100 };
  const pct = (w: string | undefined, axis: Record<string, number>) => {
    if (w === undefined) return 50;
    if (w in axis) return axis[w]!;
    const m = /^(-?\d+(?:\.\d+)?)%$/.exec(w);
    return m ? Math.min(100, Math.max(0, Number(m[1]))) : 50;
  };
  if (words.length === 1) return words[0] === 'top' || words[0] === 'bottom' ? [50, Y[words[0]]!] : [pct(words[0], X), 50];
  let [a, b] = words;
  if (a === 'top' || a === 'bottom' || b === 'left' || b === 'right') [a, b] = [b, a];
  return [pct(a, X), pct(b, Y)];
}

const dims = (v: string | undefined) => (v === undefined ? null : /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);

function rewriteOne(el: P5Element, eager: boolean, ctx: RewriteContext): 'pending' | null | { variants: ImageVariant[]; rule: string | null } {
  if (el.attrs.some((a) => a.name.startsWith('data-sn-') || a.name === 'srcset')) return null;
  if ((el.parentNode as P5Element | null)?.tagName === 'picture') return null;
  const file = sourceFile(el, ctx);
  if (!file) return null;
  const info = ctx.host.info(file);
  if (info === undefined) return 'pending';
  if (!info) return null;
  const aw = dims(attrOf(el, 'width')), ah = dims(attrOf(el, 'height'));
  if (Number.isNaN(aw) || Number.isNaN(ah) || aw === 0 || ah === 0) return null;
  const style = parseStyle(attrOf(el, 'style'));
  // the stylesheets' box (with the inline style in their cascade), else the attributes and the inline style
  const css = ctx.layout?.(el) ?? null;
  const box = css === 'fluid' ? null : css;
  const fit = (box ? box.fit : styleValue(style, 'object-fit')) ?? 'fill';
  const objectPosition = box ? box.position ?? undefined : styleValue(style, 'object-position');
  if (fit === 'none' || fit === 'scale-down') return null;
  const name = attrOf(el, 'src')!.trim();

  const ratio = info.width / info.height;
  // the box: the stylesheets', or both attributes, or one and the source's ratio, or the source's size
  const bw = box ? Math.round(box.width) : aw ?? (ah !== null ? Math.round(ah * ratio) : info.width);
  const bh = box ? Math.round(box.height ?? box.width / ratio) : ah ?? (aw !== null ? Math.round(aw / ratio) : info.height);
  const mismatch = (box ? box.height !== null : aw !== null && ah !== null) && Math.abs(bw / bh - ratio) / ratio > 0.01;
  let crop: ImageVariant['crop'];
  /** the image's width inside the box, in CSS pixels; null: fluid */
  let display: number | null = null;
  /** the file's ratio equals the box's, so `height: auto` keeps the box */
  let keepsRatio = true;
  let w0 = info.width, h0 = info.height;
  if (mismatch && fit === 'cover') {
    const r = bw / bh;
    const [px, py] = position(objectPosition);
    if (ratio > r) {
      const cw = Math.round(info.height * r);
      crop = { left: Math.round((info.width - cw) * px / 100), top: 0, width: cw, height: info.height };
    } else {
      const ch = Math.round(info.width / r);
      crop = { left: 0, top: Math.round((info.height - ch) * py / 100), width: info.width, height: ch };
    }
    w0 = crop.width; h0 = crop.height;
    display = bw;
    // the file now has the box's ratio: the fit and position do nothing, and need no inline style
    if (!box || box.inlineFit) {
      style.decls = style.decls.filter(([p]) => p !== 'object-fit' && p !== 'object-position');
      const text = style.decls.map(([p, v]) => (v ? `${p}: ${v}` : p)).join('; ');
      if (text) setAttr(el, 'style', text); else removeAttr(el, 'style');
    }
  } else if (mismatch && fit === 'contain') {
    display = Math.min(bw, Math.round(bh * ratio));
    keepsRatio = false;
  } else {
    if (mismatch) {
      if (box) ctx.warn(el, 'src', 'SN512', `the stylesheets show \`${name}\` at ${bw} × ${bh}, another ratio than the file (${info.width} × ${info.height}), so it is stretched`,
        'add `object-fit: cover` to the rule that sizes it (the build makes the cropped file)');
      else ctx.warn(el, 'width', 'SN512', `\`width="${bw}" height="${bh}"\` has another ratio than \`${name}\` (${info.width} × ${info.height}), so the image is stretched`,
        'add `style="object-fit: cover"` to crop it to the box (the build makes the cropped file), or fix the attributes');
      keepsRatio = false;
    }
    // a box from the stylesheets is fixed; one from the attributes only when smaller than the source
    // (attributes equal to the source are its ratio), and not when the stylesheets size the image
    if (box) display = bw;
    else if (css !== 'fluid' && (aw !== null || ah !== null)) display = bw < info.width ? bw : null;
  }

  // a fluid image: its width at every viewport width (layout.ts), else an upper bound from its containers
  const fluid = display === null && ctx.fluidSizes ? ctx.fluidSizes(el, w0) : null;
  if (display === null && !fluid && attrOf(el, 'sizes') === undefined && ctx.autoFitRows?.()) ctx.warn(el, 'src', 'SN514', AUTO_FIT_ROWS, AUTO_FIT_HINT);
  const bound = display === null ? (fluid ? fluid.max : ctx.maxWidth ? ctx.maxWidth(el) : null) : null;
  let widths: number[];
  if (fluid?.constant) {
    // a fixed width in every range (40 px on phones, 64 px elsewhere): exactly 1x, 2x (and 3x for small ones) of each
    widths = [...new Set(fluid.constant.flatMap((w) => [w, 2 * w, ...(w * w / (w0 / h0) <= SMALL_BOX ? [3 * w] : [])]).map((w) => Math.min(w, w0)))];
  } else if (display !== null) {
    const small = display * (display / (w0 / h0)) <= SMALL_BOX;
    const want = [1, 2, ...(small ? [3] : [])].map((d) => d * display!);
    if (w0 < 2 * display) {
      ctx.warn(el, 'src', 'SN511', `\`${name}\` is ${w0} px wide${crop ? ' after the crop' : ''}; the ${display} px box needs ${2 * display} px to be sharp on 2x screens`,
        `use a source at least ${2 * display} px wide${crop ? ' (after cropping to the box\'s ratio)' : ''}`);
    }
    widths = [...new Set(want.map((w) => Math.min(w, w0)))];
  } else {
    // a fluid image no wider than `bound` CSS px needs at most 3x of it (a DPR-3 phone)
    const cap = bound !== null ? Math.min(w0, 3 * bound) : w0;
    widths = (ctx.host.widths ?? FLUID_WIDTHS).filter((w) => w <= cap * 0.9);
    widths.push(cap);
  }
  widths.sort((a, b) => a - b);
  const height = (w: number) => Math.max(1, Math.round(w * h0 / w0));

  const tiny = info.bytes < TINY_BYTES && !crop;
  const fallback: ImageFormat = tiny ? 'original' : info.kind === 'graphic' || info.alpha ? 'png' : 'jpeg';
  const formats: ImageFormat[] = tiny ? [] : [info.kind === 'graphic' ? 'webp' : 'avif'];
  const variant = (format: ImageFormat, w: number): ImageVariant => ({
    file, hash: info.hash, kind: info.kind, format, width: w, height: height(w), ...(crop ? { crop } : {}),
  });
  const variants: ImageVariant[] = [];
  const srcset = (format: ImageFormat) => widths.map((w) => {
    const v = variant(format, w);
    variants.push(v);
    return `${ctx.host.url(v)} ${w}w`;
  }).join(', ');

  const lazy = (attrOf(el, 'loading') ?? (eager ? 'eager' : 'lazy')) === 'lazy';
  // a width in rem or em grows with the visitor's default font size: `sizes` says so in em
  const grows = (w: Affine | null | undefined): w is Affine => !!w && Math.abs(w.b) > 1e-6;
  const boundScaled = !fluid && bound !== null ? ctx.scaled?.(el, 'bound') : null;
  const fluidSizes = fluid ? fluid.sizes : grows(boundScaled) ? boxSizesCss(boundScaled) : bound !== null ? `(max-width: ${bound}px) 100vw, ${bound}px` : '100vw';
  const boxScaled = display !== null && box && display === bw ? ctx.scaled?.(el, 'box') : null;
  if (grows(boxScaled)) {
    // the box at a 24 px default (Firefox's and Chrome's larger setting) on a 2x screen
    const w24 = Math.min(w0, Math.round(2 * (boxScaled.a + 24 * boxScaled.b)));
    if (!widths.includes(w24)) { widths.push(w24); widths.sort((a, b) => a - b); }
  }
  const sizes = attrOf(el, 'sizes') ?? (display !== null ? (grows(boxScaled) ? boxSizesCss(boxScaled) : `(max-width: ${display}px) 100vw, ${display}px`) : lazy ? `auto, ${fluidSizes}` : fluidSizes);
  // the fallback `src`: the 1x file of a box, else the largest up to 1280 px
  const at = display !== null ? Math.min(display, w0) : [...widths].reverse().find((w) => w <= 1280) ?? widths[0]!;
  const main = tiny ? variant('original', w0) : variant(fallback, at);
  const src = ctx.host.url(main);
  if (tiny) variants.push(main);

  const sources: P5Element[] = formats.map((f) => element('source', [
    { name: 'type', value: MIME[f]! }, { name: 'srcset', value: srcset(f) }, { name: 'sizes', value: sizes },
    ...(ctx.host.ignore ? [{ name: 'vite-ignore', value: '' }] : []),
  ]));
  setAttr(el, 'src', src);
  if (!tiny) {
    setAttr(el, 'srcset', srcset(fallback));
    variants.push(main);
    setAttr(el, 'sizes', sizes);
  }
  setAttr(el, 'width', String(bw));
  setAttr(el, 'height', String(bh));
  if (attrOf(el, 'loading') === undefined && lazy) setAttr(el, 'loading', 'lazy');
  if (attrOf(el, 'decoding') === undefined) setAttr(el, 'decoding', 'async');
  if (ctx.host.ignore) setAttr(el, 'vite-ignore', '');

  if (sources.length) {
    const parent = el.parentNode!;
    const picture = element('picture', []);
    picture.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(el as never), 1, picture as never);
    for (const s of sources) { s.parentNode = picture; picture.childNodes.push(s as never); }
    el.parentNode = picture;
    picture.childNodes.push(el as never);
  }

  const decls = [...(keepsRatio ? ['height:auto'] : []), ...(info.color ? [`background-color:${info.color}`] : [])];
  const rule = decls.length ? `:where(img[src="${src.replace(/["\\]/g, (c) => `\\${c}`)}"]){${decls.join(';')}}` : null;
  return { variants, rule };
}

function element(tagName: string, attrs: Array<{ name: string; value: string }>): P5Element {
  return { nodeName: tagName, tagName, attrs, namespaceURI: 'http://www.w3.org/1999/xhtml' as P5Element['namespaceURI'], childNodes: [], parentNode: null } as P5Element;
}
