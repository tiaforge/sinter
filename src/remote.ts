// Images from the API (docs/images.md, step 2): the `src` and `srcset` of an `<img>` bound to
// data, as URLs of a resizing service. The compiler decides the widths (from the box the
// stylesheets give the image) and passes them in; this only builds the URLs, from the app's
// template. A URL from another origin than the allowed ones is written as it is, with no srcset.

export interface RemoteConfig {
  /** `{url}` (percent-encoded), `{url:raw}`, `{w}`, `{h}`, `{q}` */
  url: string;
  /** for a box cropped by `object-fit: cover`, with `{h}`; null: `url`, by width only */
  cover: string | null;
  /** `'self'` and origins (`https://uploads.example.com`) */
  origins: string[];
  quality: number;
}

export interface Remote {
  /** the 1x file's URL (`w` px wide; `r`: height / width of a cover crop, else 0), or `v` as it is */
  src(v: unknown, w: number, r: number): unknown;
  /** the `srcset` for `ws`, or null when `v` is not sent through the service */
  set(v: unknown, ws: number[], r: number): string | null;
}

export function remote(c: RemoteConfig): Remote {
  /** the image as the template takes it: a same-origin path, else the absolute URL; null when not sent */
  const source = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v) return null;
    let u: URL;
    try { u = new URL(v, document.baseURI); } catch { return null; }
    if (!/^https?:$/.test(u.protocol) || /\.(svg|gif)$/i.test(u.pathname)) return null;
    const self = u.origin === location.origin;
    if (!(self ? c.origins.includes('self') : c.origins.includes(u.origin))) return null;
    return self ? u.pathname + u.search : u.href;
  };
  const url = (s: string, w: number, r: number) => {
    const h = r && c.cover ? Math.round(w * r) : 0;
    return (h ? c.cover! : c.url).replace(/\{(url:raw|url|w|h|q)\}/g, (_, k: string) =>
      k === 'url' ? encodeURIComponent(s) : k === 'url:raw' ? s : k === 'w' ? String(w) : k === 'h' ? String(h) : String(c.quality));
  };
  return {
    src(v, w, r) { const s = source(v); return s === null ? v : url(s, w, r); },
    set(v, ws, r) { const s = source(v); return s === null ? null : ws.map((w) => `${url(s, w, r)} ${w}w`).join(', '); },
  };
}

/** The presets: each is a template (`imgproxy:<base URL>` for imgproxy). */
export function preset(url: string): { url: string; cover: string | null } {
  if (url === 'cloudflare') return { url: '/cdn-cgi/image/width={w},quality={q},format=auto/{url:raw}', cover: '/cdn-cgi/image/width={w},height={h},fit=cover,quality={q},format=auto/{url:raw}' };
  if (url === 'vercel') return { url: '/_vercel/image?url={url}&w={w}&q={q}', cover: null };
  if (url === 'netlify') return { url: '/.netlify/images?url={url}&w={w}&q={q}', cover: '/.netlify/images?url={url}&w={w}&h={h}&fit=cover&q={q}' };
  if (url.startsWith('imgproxy:')) {
    const base = url.slice('imgproxy:'.length).replace(/\/+$/, '');
    return { url: `${base}/insecure/rs:fit:{w}:0/q:{q}/plain/{url}`, cover: `${base}/insecure/rs:fill:{w}:{h}/q:{q}/plain/{url}` };
  }
  return { url, cover: null };
}

/** What an app writes in `sinter({ images: { remote } })`. */
export interface RemoteImages {
  /** a URL template (`{url}`, `{url:raw}`, `{w}`, `{q}`) or a preset: `cloudflare`, `vercel`, `netlify`, `imgproxy:<base URL>` */
  url: string;
  /** for a box cropped by `object-fit: cover`: a template with `{h}` (a preset brings its own) */
  cover?: string;
  /** the image origins sent through the service: `'self'` and origins such as `https://uploads.example.com` */
  origins: string[];
  /** `{q}` (default 75) */
  quality?: number;
}

/** The config the compiler and the runtime use; throws on a template or origin that cannot work. */
export function resolveRemote(o: RemoteImages): RemoteConfig {
  if (!o || typeof o.url !== 'string' || !o.url) throw new Error('sinter: images.remote.url is a URL template or a preset (cloudflare, vercel, netlify, imgproxy:<base URL>)');
  const p = preset(o.url);
  const cover = o.cover ?? p.cover;
  const hasUrl = (t: string) => t.includes('{url}') || t.includes('{url:raw}');
  if (!hasUrl(p.url) || !p.url.includes('{w}')) throw new Error(`sinter: images.remote.url needs {url} (or {url:raw}) and {w}: ${o.url}`);
  if (cover != null && (!hasUrl(cover) || !cover.includes('{w}') || !cover.includes('{h}'))) throw new Error(`sinter: images.remote.cover needs {url} (or {url:raw}), {w} and {h}: ${cover}`);
  if (!Array.isArray(o.origins) || !o.origins.length) throw new Error("sinter: images.remote.origins lists the image origins to send through the service, e.g. ['self', 'https://uploads.example.com']");
  const origins = o.origins.map((x) => {
    if (x === 'self') return x;
    let u: URL | null = null;
    try { u = new URL(x); } catch { /* below */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.origin !== x.replace(/\/$/, '')) throw new Error(`sinter: images.remote.origins: \`${x}\` is not an origin (scheme, host and port, like https://uploads.example.com)`);
    return u.origin;
  });
  const quality = o.quality ?? 75;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('sinter: images.remote.quality is a whole number from 1 to 100');
  return { url: p.url, cover: cover ?? null, origins, quality };
}
