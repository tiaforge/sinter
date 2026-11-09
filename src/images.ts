// The adapter side of static images (docs/images.md): analyses source files and encodes the
// variants the compiler asks for, with sharp. Both are cached by content hash on disk, so a
// rebuild encodes only new or changed images. sharp is an optional dependency: without it,
// `loadImages` returns null and images stay as written.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ImageFormat, ImageInfo, ImageKind, ImageVariant } from './compiler/images.js';

type Sharp = typeof import('sharp').default;

/** bump when an encoder setting changes: the cached files' names change with it */
const SETTINGS = 1;
/** a PNG whose lossless WebP is more than this times its AVIF is a photo */
const PHOTO_RATIO = 2;
const EXT: Record<Exclude<ImageFormat, 'original'>, string> = { avif: 'avif', webp: 'webp', jpeg: 'jpg', png: 'png' };
export const MIME: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };

export interface Images {
  /** what the compiler's `ImageHost.info` returns */
  info(file: string): ImageInfo | null | undefined;
  /** analyses files `info` did not know (or that changed) */
  analyze(files: string[]): Promise<void>;
  /** the variant's file name: the source's name, the width and a hash of what the file holds */
  fileName(v: ImageVariant): string;
  encode(v: ImageVariant): Promise<Buffer>;
}

/** `dev`: AVIF at a lower effort, so the first request of a page is fast. Null without sharp. */
export async function loadImages(cacheDir: string, dev: boolean): Promise<Images | null> {
  let sharp: Sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    return null;
  }
  const known = new Map<string, { mtime: number; size: number; info: ImageInfo | null }>();
  const encoding = new Map<string, Promise<Buffer>>();
  const limit = queue(4);
  const ensureDir = () => { if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true }); };
  const effort = dev ? 2 : 4;

  const stat = (file: string) => { try { return statSync(file); } catch { return null; } };

  async function analyzeOne(file: string): Promise<ImageInfo | null> {
    const buf = readFileSync(file);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const metaFile = join(cacheDir, `${hash}.json`);
    if (existsSync(metaFile)) return { ...JSON.parse(readFileSync(metaFile, 'utf8')), bytes: buf.length, hash } as ImageInfo;
    let info: ImageInfo | null = null;
    try {
      const meta = await sharp(buf).metadata();
      const format = meta.format;
      if ((meta.pages ?? 1) > 1 || !['jpeg', 'png', 'webp', 'heif'].includes(format ?? '')) return null;
      const { width, height } = meta.autoOrient ?? { width: meta.width!, height: meta.height! };
      const stats = await sharp(buf).stats();
      const alpha = !stats.isOpaque;
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      const color = alpha ? null : `#${hex(stats.dominant.r)}${hex(stats.dominant.g)}${hex(stats.dominant.b)}`;
      let kind: ImageKind = 'photo';
      if (format === 'png') {
        // exact pixels unless they cost far more than a high-quality AVIF (measured on a small copy)
        const sample = sharp(buf).rotate().resize({ width: Math.min(256, width), withoutEnlargement: true });
        const [lossless, avif] = await Promise.all([
          sample.clone().webp({ lossless: true, effort: 4 }).toBuffer(),
          sample.clone().avif({ quality: 70, chromaSubsampling: '4:4:4', effort: 2 }).toBuffer(),
        ]);
        kind = lossless.length > PHOTO_RATIO * avif.length ? 'photo' : 'graphic';
      }
      info = { width, height, alpha, kind, color, bytes: buf.length, hash };
    } catch {
      return null;
    }
    ensureDir();
    const { bytes: _b, hash: _h, ...stored } = info;
    writeFileSync(metaFile, JSON.stringify(stored));
    return info;
  }

  function fileName(v: ImageVariant): string {
    const ext = v.format === 'original' ? extname(v.file).slice(1).toLowerCase() : EXT[v.format];
    const key = JSON.stringify([SETTINGS, v.hash, v.kind, v.format, v.width, v.height, v.crop ?? null, v.format === 'avif' ? effort : 0]);
    const stem = basename(v.file, extname(v.file)).replace(/[^\w-]+/g, '-');
    return `${stem}-${v.width}-${createHash('sha256').update(key).digest('base64url').slice(0, 8)}.${ext}`;
  }

  async function encodeOne(v: ImageVariant): Promise<Buffer> {
    if (v.format === 'original') return readFileSync(v.file);
    let img = sharp(v.file).rotate();
    if (v.crop) img = img.extract(v.crop);
    img = img.resize(v.width, v.height, { fit: 'fill' });
    const photo = v.kind === 'photo';
    switch (v.format) {
      case 'avif': return img.avif({ quality: photo ? 60 : 70, chromaSubsampling: photo ? '4:2:0' : '4:4:4', effort }).toBuffer();
      case 'webp': return img.webp({ lossless: true, effort: 4 }).toBuffer();
      case 'jpeg': return img.flatten({ background: '#ffffff' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      case 'png': return img.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    }
  }

  return {
    info(file) {
      const s = stat(file);
      if (!s) return null;
      const k = known.get(file);
      return k && k.mtime === s.mtimeMs && k.size === s.size ? k.info : undefined;
    },
    async analyze(files) {
      await Promise.all(files.map((file) => limit(async () => {
        const s = stat(file);
        if (!s) return;
        known.set(file, { mtime: s.mtimeMs, size: s.size, info: await analyzeOne(file) });
      })));
    },
    fileName,
    encode(v) {
      const name = fileName(v);
      let p = encoding.get(name);
      if (!p) {
        p = limit(async () => {
          const cached = join(cacheDir, name);
          if (existsSync(cached)) return readFileSync(cached);
          const buf = await encodeOne(v);
          ensureDir();
          writeFileSync(cached, buf);
          return buf;
        });
        encoding.set(name, p);
        p.catch(() => encoding.delete(name));
      }
      return p;
    },
  };
}

/** Runs at most `n` tasks at a time (libvips threads each one itself). */
function queue(n: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= n) await new Promise<void>((r) => waiting.push(r));
    running++;
    try { return await task(); } finally { running--; waiting.shift()?.(); }
  };
}
