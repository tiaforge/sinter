// The request layer: every request (resources, actions, the session probe,
// islands) goes through one middleware chain, then fetch with a timeout and
// one retry for idempotent requests on network errors.
import { config, SinterError, type Middleware } from './config.js';
import type { Env } from './env.js';

export const TIMEOUT = 30_000;
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

export interface SendInit {
  method?: string;
  /** JSON-serialized unless FormData */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RequestLayer {
  /** Sends a request and returns the parsed body; rejects with SinterError. */
  send(url: string, init?: SendInit): Promise<unknown>;
  /** Sends a request and returns the raw response; network errors reject with SinterError(0). */
  raw(url: string, init?: SendInit): Promise<Response>;
  /** Requests in flight. */
  readonly inflight: number;
}

export function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

export function createRequestLayer(env: Env, chain: Middleware[], onSettle?: () => void): RequestLayer {
  let inflight = 0;

  const terminal = async (req: Request): Promise<Response> => {
    const idempotent = IDEMPOTENT.has(req.method);
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const onAbort = () => ctl.abort(req.signal.reason);
      if (req.signal.aborted) ctl.abort(req.signal.reason);
      req.signal.addEventListener('abort', onAbort);
      const timer = env.setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT, 'timeout');
      try {
        const attemptReq = idempotent ? req.clone() : req;
        return await env.fetch(new Request(attemptReq, { signal: ctl.signal }));
      } catch (e) {
        if (req.signal.aborted) throw req.signal.reason ?? e;
        if (ctl.signal.aborted) throw new SinterError(0, null, 'request timed out');
        if (idempotent && attempt === 0 && !isAbort(e)) continue;
        throw new SinterError(0, null, (e as Error)?.message || 'network error');
      } finally {
        env.clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
      }
    }
  };

  const run = chain.reduceRight<(r: Request) => Promise<Response>>((next, mw) => (r) => mw(r, next), terminal);

  function build(url: string, init: SendInit): Request {
    const base = env.href();
    const target = new URL(url, base);
    const own = new URL(base).origin;
    const allowed = target.origin === own || config.origins.some((o) => { try { return new URL(o).origin === target.origin; } catch { return false; } });
    if (!allowed) throw new SinterError(0, null, `request to ${target.origin} refused: origin not allowed`);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body: BodyInit | undefined;
    if (init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD') {
      if (typeof FormData !== 'undefined' && init.body instanceof FormData) body = init.body;
      else {
        body = JSON.stringify(init.body);
        headers.set('Content-Type', 'application/json');
      }
    }
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const reqInit: RequestInit = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) reqInit.body = body;
    if (init.signal) reqInit.signal = init.signal;
    return new Request(target.href, reqInit);
  }

  async function raw(url: string, init: SendInit = {}): Promise<Response> {
    const req = build(url, init);
    inflight++;
    try {
      return await run(req);
    } catch (e) {
      if (e instanceof SinterError || isAbort(e)) throw e;
      throw new SinterError(0, null, (e as Error)?.message || 'network error');
    } finally {
      inflight--;
      onSettle?.();
    }
  }

  async function send(url: string, init: SendInit = {}): Promise<unknown> {
    const res = await raw(url, init);
    const body = await parseBody(res);
    if (!res.ok) throw new SinterError(res.status, body, errorMessage(res, body));
    return body;
  }

  return { send, raw, get inflight() { return inflight; } };
}

/** 204 or empty → null; JSON content type → parsed; anything else → text. */
export async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const ct = (res.headers.get('Content-Type') ?? '').toLowerCase();
  if (/[/+]json\b/.test(ct)) {
    try { return JSON.parse(text); } catch { throw new SinterError(res.status, text, 'invalid JSON'); }
  }
  return text;
}

function errorMessage(res: Response, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.message === 'string') return b.message;
    if (typeof b.error === 'string') return b.error;
  }
  if (typeof body === 'string' && body.length < 200 && body.trim()) return body.trim();
  return `${res.status} ${res.statusText}`.trim();
}
