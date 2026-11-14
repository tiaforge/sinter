// Dev only: the dev server's resizing service for images from the API (docs/images.md, step 2).
// No image service resizes localhost, so `/@sinter/remote?url=…&w=…&h=…&q=…` does: it fetches the
// source (only from the configured origins; a same-origin path from the dev server itself, so
// Vite's proxy applies), resizes it with sharp and answers in the best format the browser's
// `Accept` names. Results are kept in memory for the dev server's life.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RemoteConfig } from './remote.js';

type Sharp = typeof import('sharp').default;

/** The URLs the page uses in dev: the same placeholders, answered by `remoteMiddleware`. */
export function devRemote(c: RemoteConfig, base: string): RemoteConfig {
  const at = `${base}@sinter/remote?url={url}&w={w}`;
  return { ...c, url: `${at}&q={q}`, cover: c.cover ? `${at}&h={h}&q={q}` : null };
}

export function remoteMiddleware(c: RemoteConfig, warn: (m: string) => void) {
  let sharp: Promise<Sharp | null> | null = null;
  const cache = new Map<string, Promise<{ type: string; body: Buffer }>>();
  const MAX = 50 * 1024 * 1024;

  async function make(source: string, w: number, h: number, q: number, accept: string): Promise<{ type: string; body: Buffer }> {
    sharp ??= import('sharp').then((m) => m.default, () => null);
    const s = await sharp;
    if (!s) throw new Error('sharp is not installed (npm install -D sharp)');
    const res = await fetch(source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX) throw new Error(`${source}: larger than 50 MB`);
    const input = Buffer.from(await res.arrayBuffer());
    if (input.length > MAX) throw new Error(`${source}: larger than 50 MB`);
    let img = s(input, { failOn: 'error' }).rotate().resize(w, h || undefined, { fit: h ? 'cover' : 'inside', withoutEnlargement: true });
    if (/image\/avif/.test(accept)) return { type: 'image/avif', body: await img.avif({ quality: Math.round(q * 0.8) }).toBuffer() };
    if (/image\/webp/.test(accept)) return { type: 'image/webp', body: await img.webp({ quality: q }).toBuffer() };
    const { hasAlpha } = await s(input).metadata();
    if (hasAlpha) return { type: 'image/png', body: await img.png().toBuffer() };
    img = img.flatten({ background: '#ffffff' });
    return { type: 'image/jpeg', body: await img.jpeg({ quality: q, mozjpeg: true }).toBuffer() };
  }

  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = req.url ?? '';
    const at = raw.indexOf('/@sinter/remote?');
    if (at < 0) return next();
    const p = new URLSearchParams(raw.slice(raw.indexOf('?', at) + 1));
    const url = p.get('url') ?? '', w = Number(p.get('w')), h = Number(p.get('h') ?? 0), q = Number(p.get('q') ?? c.quality);
    const fail = (status: number, message: string) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain'); res.end(`sinter: ${message}`); };
    if (!Number.isInteger(w) || w < 1 || w > 4096 || !Number.isInteger(h) || h < 0 || h > 4096 || !Number.isInteger(q) || q < 1 || q > 100) return fail(400, 'w, h and q are whole numbers (w and h up to 4096, q up to 100)');
    // a path is the dev server's own (through its proxy); anything else must be an allowed origin
    let source: string;
    if (url.startsWith('/') && !url.startsWith('//')) {
      if (!c.origins.includes('self')) return fail(403, `same-origin images are not in images.remote.origins: ${url}`);
      source = `http://${req.headers.host}${url}`;
    } else {
      let u: URL;
      try { u = new URL(url); } catch { return fail(400, `not a URL: ${url}`); }
      if (!c.origins.includes(u.origin)) return fail(403, `${u.origin} is not in images.remote.origins`);
      source = u.href;
    }
    const accept = String(req.headers.accept ?? '');
    const format = /image\/avif/.test(accept) ? 'avif' : /image\/webp/.test(accept) ? 'webp' : 'legacy';
    const key = `${source}\0${w}\0${h}\0${q}\0${format}`;
    let job = cache.get(key);
    if (!job) { job = make(source, w, h, q, accept); cache.set(key, job); job.catch(() => cache.delete(key)); }
    job.then(({ type, body }) => {
      res.setHeader('Content-Type', type);
      res.setHeader('Vary', 'Accept');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    }, (e: Error) => { warn(`images from the API: ${e.message}`); fail(502, e.message); });
  };
}
