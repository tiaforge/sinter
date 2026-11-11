// Lazy packages and lazy component scripts, the runtime side (docs/lazy.md): one cached `import()`
// per package or script. A failed load is not cached, so the next call tries again, and it is
// reported as an `$error`: when the build gave the chunk's URL, the URL is requested again to tell a
// stale page (a deploy removed the chunk: `stale`) from the network (`status: 0`) and from a module
// that threw (`status: null`). The build side is `lazy-build.ts`.
import { SinterError } from './runtime/config.js';

const MARK = '__SN_CHUNK__';

/**
 * A loader: `load()` imports once and caches the module. `file`: the chunk's URL relative to `base`
 * (the loader's own module), or null when it is not known (dev).
 */
export function lazy<M>(load: () => Promise<M>, file: string | null, base: string): () => Promise<M> {
  let p: Promise<M> | null = null;
  const url = file && !file.startsWith(MARK) ? new URL(file, base).href : null;
  return () => (p ??= load().catch(async (e: unknown) => {
    p = null;
    throw await loadError(e, url);
  }));
}

/** The `$error` of a failed load: stale (a 404 or 410, or a host's HTML page), the network, or what the module threw. */
export async function loadError(e: unknown, url: string | null): Promise<SinterError> {
  if (e instanceof SinterError) return e;
  const said = e instanceof Error ? e.message : String(e);
  if (url) {
    let r: Response;
    try { r = await fetch(url, { cache: 'no-store' }); } catch { return new SinterError(0, null, `could not load ${url}: the network failed`, null); }
    const type = r.headers.get('content-type') ?? '';
    if (r.status == 404 || r.status == 410 || (r.ok && !/javascript|ecmascript/i.test(type))) {
      return new SinterError(null, null, 'this page is out of date: reload it', null, true);
    }
    if (!r.ok) return new SinterError(r.status, null, `could not load ${url}: ${r.status}`, null);
  }
  return new SinterError(null, e, said, said || null);
}
