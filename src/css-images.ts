// CSS backgrounds (docs/images.md, step 3): `background` / `background-image` with `url()` of a
// local JPEG, PNG, WebP or AVIF get `image-set()` with AVIF (photos) or lossless WebP (graphics) and
// a JPEG/PNG fallback, after the original declaration, which stays for browsers without
// `image-set()` types. A rule that sizes the background (`background-size`, or a size in the
// shorthand) gets 1x and 2x files, the source counting as 2x; a rule that does not keeps the
// image's intrinsic size, so only the format changes (a 2x file would halve it). The adapter
// passes CSS as Vite outputs it: dev, between Vite's CSS compiler and its post-processing;
// builds, the finished stylesheets in `generateBundle`.
import * as csstree from 'css-tree';
import { TINY_BYTES, type ImageFormat, type ImageInfo, type ImageVariant } from './compiler/images.js';

export interface CssImageHost {
  /** the source file of a `url()` as the stylesheet has it, or null to leave it alone */
  source(url: string): string | null;
  info(file: string): ImageInfo | null | undefined;
  analyze(files: string[]): Promise<void>;
  /** where a variant is served */
  url(v: ImageVariant): string;
}

const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
const BACKGROUND = /^(background|background-image)$/i;
/** a cheap check before parsing: nothing to do without a background url() */
const CANDIDATE = /background(?:-image)?\s*:[^;}]*url\(/i;

export async function rewriteCssImages(css: string, host: CssImageHost): Promise<{ css: string; variants: ImageVariant[] } | null> {
  if (!CANDIDATE.test(css)) return null;
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, { positions: true, parseCustomProperty: false, onParseError: () => {} });
  } catch {
    return null;
  }
  // declarations to rewrite, with the files they name
  interface Found { end: number; prop: string; value: csstree.Value; important: boolean; sized: boolean; urls: string[] }
  const found: Found[] = [];
  csstree.walk(ast, {
    visit: 'Rule',
    enter(rule: csstree.Rule) {
      const decls = rule.block.children.toArray().filter((d): d is csstree.Declaration => d.type === 'Declaration');
      // sized in this rule: background-size other than auto, or `position / size` in the shorthand
      const sized = decls.some((d) => (d.property.toLowerCase() === 'background-size' && !/^\s*auto(\s+auto)?\s*$/i.test(csstree.generate(d.value)))
        || (d.property.toLowerCase() === 'background' && /\//.test(csstree.generate(d.value).replace(/url\([^)]*\)/gi, ''))));
      for (const d of decls) {
        if (!BACKGROUND.test(d.property) || d.value.type !== 'Value' || !d.loc) continue;
        const urls: string[] = [];
        csstree.walk(d.value, { visit: 'Url', enter(u: csstree.Url) { const file = host.source(u.value); if (file) urls.push(file); } });
        // already an image-set (written by hand or by an earlier pass): left alone
        if (!urls.length || /image-set\(/i.test(csstree.generate(d.value))) continue;
        found.push({ end: d.loc.end.offset, prop: d.property, value: d.value, important: !!d.important, sized, urls });
      }
    },
  });
  if (!found.length) return null;
  const pending = [...new Set(found.flatMap((f) => f.urls))].filter((f) => host.info(f) === undefined);
  if (pending.length) await host.analyze(pending);

  const variants: ImageVariant[] = [];
  let out = '', last = 0;
  for (const f of found) {
    // the value again, each optimizable url() replaced by its image-set()
    const value = csstree.clone(f.value) as csstree.Value;
    let changed = false;
    csstree.walk(value, {
      visit: 'Url',
      enter(node: csstree.Url, item, list) {
        const file = host.source(node.value);
        const info = file ? host.info(file) : null;
        if (!file || !info || info.bytes < TINY_BYTES || !list) return;
        list.replace(item, list.createItem({ type: 'Raw', value: imageSet(file, info, f.sized, variants, host) }));
        changed = true;
      },
    });
    if (!changed) continue;
    out += css.slice(last, f.end) + `;${f.prop}:${csstree.generate(value)}${f.important ? '!important' : ''}`;
    last = f.end;
  }
  if (!variants.length) return null;
  return { css: out + css.slice(last), variants };
}

/** `image-set()` for one file: 1x and 2x (the source as 2x) when the rule sizes it, else 1x only */
function imageSet(file: string, info: ImageInfo, sized: boolean, variants: ImageVariant[], host: CssImageHost): string {
  const graphic = info.kind === 'graphic';
  const best: ImageFormat = graphic ? 'webp' : 'avif';
  const fallback: ImageFormat = graphic || info.alpha ? 'png' : 'jpeg';
  const v = (format: ImageFormat, width: number): string => {
    const variant: ImageVariant = { file, hash: info.hash, kind: info.kind, format, width, height: Math.max(1, Math.round(width * info.height / info.width)) };
    variants.push(variant);
    return `url("${host.url(variant).replace(/["\\]/g, (c) => `\\${c}`)}")`;
  };
  const half = Math.max(1, Math.round(info.width / 2));
  const options = sized
    ? [[best, half, '1x'], [best, info.width, '2x'], [fallback, half, '1x'], [fallback, info.width, '2x']] as const
    : [[best, info.width, '1x'], [fallback, info.width, '1x']] as const;
  return `image-set(${options.map(([f, w, x]) => `${v(f, w)} type("${MIME[f]}") ${x}`).join(',')})`;
}
