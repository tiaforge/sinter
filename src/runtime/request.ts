// The request layer: every request (resources, actions, the session probe,
// islands) goes through one middleware chain, then fetch with a timeout. Nothing
// is sent again unless a retry policy says so (`configure({ retry })`, the retry module).
import { clearCached, clearPrefetched, config, PREFETCH_MARK, SinterError, type Middleware } from './config.js';
import type { Env } from './env.js';
import { prefetched } from './handoff.js';

export const TIMEOUT = 30_000;

export interface SendInit {
  method?: string;
  /** JSON-serialized unless FormData or URLSearchParams (sent form-encoded) */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  /** `low`: the browser schedules it after the default-priority requests (data nobody can see yet) */
  priority?: 'low';
  /**
   * The retry policy (the retry module): a policy name, or `false` for none. A write without one is
   * sent once; a GET without one uses the policy `retry.get` names, if any.
   */
  retry?: string | false;
  /** a write's retry: no further try once this aborts (a newer `latest` trigger replaced it); a running try is never aborted */
  stop?: AbortSignal;
}

/**
 * What the retry module gives `configure({ retry })`: `wrap` returns the function that sends a
 * request (`once`, a try through the whole middleware chain) as the policy says, or null when no
 * policy applies; for a write it adds the idempotency key to `headers`.
 */
export interface Retry {
  wrap(method: string, url: string, init: SendInit, headers: Headers, layer: RequestLayer, env: Env): ((once: () => Promise<Response>) => Promise<Response>) | null;
  has(name: string): boolean;
}

export interface RequestLayer {
  /** Sends a request and returns the parsed body; rejects with SinterError. */
  send(url: string, init?: SendInit): Promise<unknown>;
  /** Sends a request and returns the raw response; network errors reject with SinterError(0). */
  raw(url: string, init?: SendInit): Promise<Response>;
  /** Requests in flight. */
  readonly inflight: number;
  /** mutations (not GET/HEAD) settled so far, and in flight: a prefetch that overlapped one is dropped */
  readonly writes: number;
  readonly writing: number;
  /** requests in flight that wait between retries (no try is running), for the testing module's settle; set by the retry module */
  waiting?: number;
  /** dev builds: retries are logged here */
  log?: ((message: string) => void) | undefined;
}

export const isAbort = (e: unknown) => (e as Error)?.name == 'AbortError';

export const toError = (e: unknown) => (e instanceof SinterError ? e : new SinterError(0, null, (e as Error)?.message || 'network error'));

export function createRequestLayer(env: Env, chain: Middleware[]): RequestLayer {
  let inflight = 0, writes = 0, writing = 0;

  const terminal = async (req: Request): Promise<Response> => {
    const signal = req.signal, c = new AbortController(), abort = () => c.abort(signal.reason);
    signal.aborted ? abort() : signal.addEventListener('abort', abort);
    const timer = env.setTimeout(() => c.abort(), TIMEOUT, 'timeout');
    try {
      const ahead = req.headers.has(PREFETCH_MARK);
      let out = req;
      if (ahead) { const h = new Headers(out.headers); h.delete(PREFETCH_MARK); out = new Request(out, { headers: h }); }
      // the response the early file already requested for exactly this request, else a fetch; a
      // failed early request fails this one (a retry policy's next try fetches: it is taken once)
      const res = await ((!ahead && prefetched()?.take(req, c.signal)) || env.fetch(new Request(out, { signal: c.signal })));
      // the session is gone: cached data must not outlive it, whatever the app does next
      if (res.status == 401) clearCached(env);
      if (ahead && !res.ok) throw new SinterError(res.status, null, 'prefetch failed');
      return res;
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      if (c.signal.aborted) throw new SinterError(0, null, 'request timed out');
      throw toError(e);
    } finally {
      env.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };

  const run = chain.reduceRight<(r: Request) => Promise<Response>>((next, mw) => (r) => mw(r, next), terminal);

  async function raw(url: string, init: SendInit = {}): Promise<Response> {
    const target = new URL(url, env.href());
    if (target.origin != new URL(env.href()).origin && !config.origins.some((o) => new URL(o).origin == target.origin)) {
      throw new SinterError(0, null, `request to ${target.origin} refused: origin not allowed`);
    }
    const method = (init.method ?? 'GET').toUpperCase(), headers = new Headers(init.headers);
    let body = init.body as BodyInit | undefined;
    if (body == null || method == 'GET') body = undefined;
    else if (body instanceof URLSearchParams) {
      body = body.toString();
      headers.set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    } else if (!(body instanceof FormData)) {
      body = JSON.stringify(body);
      headers.set('Content-Type', 'application/json');
    }
    headers.has('Accept') || headers.set('Accept', 'application/json');
    // mutations outlive the page: a navigation right after a click must not cancel the write
    // (keepalive bodies are limited to 64 KiB; larger ones and uploads go without it)
    const keepalive = method != 'GET' && method != 'HEAD' && (body == null || (typeof body == 'string' && bytes(body) < 60_000));
    const write = method != 'GET' && method != 'HEAD';
    // no retry module configured: sent once (dev builds warn about a `data-sn-retry` naming no policy)
    const retry = init.retry === false ? null : config.retry?.wrap(method, url, init, headers, layer, env);
    const once = async () => {
      const res = await run(new Request(target, { method, headers, body: body ?? null, credentials: 'same-origin', signal: init.signal ?? null, keepalive, ...(init.priority ? { priority: init.priority } : {}) } as RequestInit));
      // also a 401 that middleware answered itself (fetch above clears before onUnauthorized runs)
      if (res.status == 401) clearCached(env);
      return res;
    };
    inflight++;
    if (write) writing++;
    try {
      return await (retry ? retry(once) : once());
    } catch (e) {
      throw isAbort(e) ? e : toError(e);
    } finally {
      inflight--;
      // what a mutation changed is not what was prefetched before it
      if (write) { writing--; writes++; clearPrefetched(env); }
    }
  }

  async function send(url: string, init?: SendInit): Promise<unknown> {
    return readBody(await raw(url, init));
  }

  const layer: RequestLayer = { send, raw, get inflight() { return inflight; }, get writes() { return writes; }, get writing() { return writing; } };
  return layer;
}

/** UTF-8 size of a string; a short one cannot reach the limit (at most 3 bytes per UTF-16 unit). */
const bytes = (s: string) => (s.length < 20_000 ? s.length : new TextEncoder().encode(s).length);

/** The parsed body of a response; rejects with SinterError unless it is 2xx. */
export async function readBody(res: Response): Promise<unknown> {
  const body = await parseBody(res);
  if (!res.ok) {
    const b = body as any, m = typeof body == 'string' ? body.length < 200 && body.trim() : b?.message ?? b?.error;
    const detail = typeof m == 'string' && m ? m : null;
    throw new SinterError(res.status, body, detail ?? `${res.status} ${res.statusText}`.trim(), detail);
  }
  return body;
}

/** 204 or empty → null; JSON content type → parsed; anything else → text. */
export async function parseBody(res: Response): Promise<unknown> {
  const text = res.status == 204 ? '' : await res.text();
  if (!text) return null;
  if (!/[/+]json\b/i.test(res.headers.get('Content-Type') ?? '')) return text;
  try { return JSON.parse(text); } catch { throw new SinterError(res.status, text, 'invalid JSON'); }
}
