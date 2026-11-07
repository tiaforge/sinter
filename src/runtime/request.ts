// The request layer: every request (resources, actions, the session probe,
// islands) goes through one middleware chain, then fetch with a timeout and
// one retry for idempotent requests on network errors.
import { clearCached, config, SinterError, type Middleware } from './config.js';
import type { Env } from './env.js';

export const TIMEOUT = 30_000;

export interface SendInit {
  method?: string;
  /** JSON-serialized unless FormData or URLSearchParams (sent form-encoded) */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

export interface RequestLayer {
  /** Sends a request and returns the parsed body; rejects with SinterError. */
  send(url: string, init?: SendInit): Promise<unknown>;
  /** Sends a request and returns the raw response; network errors reject with SinterError(0). */
  raw(url: string, init?: SendInit): Promise<Response>;
  /** Requests in flight. */
  readonly inflight: number;
}

export const isAbort = (e: unknown) => (e as Error)?.name == 'AbortError';

export const toError = (e: unknown) => (e instanceof SinterError ? e : new SinterError(0, null, (e as Error)?.message || 'network error'));

export function createRequestLayer(env: Env, chain: Middleware[]): RequestLayer {
  let inflight = 0;

  const terminal = async (req: Request): Promise<Response> => {
    const signal = req.signal, idempotent = /^(GET|HEAD|OPTIONS|PUT|DELETE)$/.test(req.method);
    for (let retried = 0; ; retried++) {
      const c = new AbortController(), abort = () => c.abort(signal.reason);
      signal.aborted ? abort() : signal.addEventListener('abort', abort);
      const timer = env.setTimeout(() => c.abort(), TIMEOUT, 'timeout');
      try {
        const res = await env.fetch(new Request(idempotent ? req.clone() : req, { signal: c.signal }));
        // the session is gone: cached data must not outlive it, whatever the app does next
        if (res.status == 401) clearCached(env);
        return res;
      } catch (e) {
        if (signal.aborted) throw signal.reason ?? e;
        if (c.signal.aborted) throw new SinterError(0, null, 'request timed out');
        if (!idempotent || retried || isAbort(e)) throw toError(e);
      } finally {
        env.clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      }
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
    inflight++;
    try {
      const res = await run(new Request(target, { method, headers, body: body ?? null, credentials: 'same-origin', signal: init.signal ?? null, keepalive }));
      // also a 401 that middleware answered itself (fetch above clears before onUnauthorized runs)
      if (res.status == 401) clearCached(env);
      return res;
    } catch (e) {
      throw isAbort(e) ? e : toError(e);
    } finally {
      inflight--;
    }
  }

  async function send(url: string, init?: SendInit): Promise<unknown> {
    const res = await raw(url, init), body = await parseBody(res);
    if (!res.ok) {
      const b = body as any, m = typeof body == 'string' ? body.length < 200 && body.trim() : b?.message ?? b?.error;
      const detail = typeof m == 'string' && m ? m : null;
      throw new SinterError(res.status, body, detail ?? `${res.status} ${res.statusText}`.trim(), detail);
    }
    return body;
  }

  return { send, raw, get inflight() { return inflight; } };
}

/** UTF-8 size of a string; a short one cannot reach the limit (at most 3 bytes per UTF-16 unit). */
const bytes = (s: string) => (s.length < 20_000 ? s.length : new TextEncoder().encode(s).length);

/** 204 or empty → null; JSON content type → parsed; anything else → text. */
export async function parseBody(res: Response): Promise<unknown> {
  const text = res.status == 204 ? '' : await res.text();
  if (!text) return null;
  if (!/[/+]json\b/i.test(res.headers.get('Content-Type') ?? '')) return text;
  try { return JSON.parse(text); } catch { throw new SinterError(res.status, text, 'invalid JSON'); }
}
