// Retry policies (`configure({ retry: retry({ policies, get }) })`). A write is sent again only when
// its element names a policy (`data-sn-retry`); a GET uses the policy `get` names, if any. Between
// tries the request waits: the wait doubles from the policy's first to its longest (±25 %, the
// stream's rule); after a network error the session probe decides whether to try again (2xx), stop
// (401: the login redirect), or wait longer. A write carries an idempotency key, the same on every
// try. While a write waits, leaving the page asks first (`beforeunload`).
import { config, SinterError } from './runtime/config.js';
import type { Env } from './runtime/env.js';
import { isAbort, toError, type RequestLayer, type Retry } from './runtime/request.js';
import { doubled, jittered } from './backoff.js';

/** A duration as in `refresh` and `cache`: a number and `s`, `m`, `h` or `d`. */
type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;

export interface RetryPolicy {
  /** the first and the longest wait between tries; default `['1s', '30s']`. Equal values: a fixed interval */
  backoff?: [Duration, Duration];
  /** how many times the request is sent again after the first try; default: no limit */
  retries?: number;
  /** no new try once this long has passed since the first; default: no limit */
  maxAge?: Duration;
  /** the header carrying a write's idempotency key; `false` sends none. Default `Idempotency-Key` */
  key?: string | false;
}

export interface RetryOptions {
  policies: Record<string, RetryPolicy>;
  /** the policy every GET uses (resource loads, GET actions); absent: GETs are sent once */
  get?: string;
}

interface Policy { name: string; min: number; max: number; retries: number; maxAge: number; key: string | false }

const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

function duration(v: unknown, name: string): number {
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(v).trim());
  if (!m) throw Error(`sinter: retry policy \`${name}\`: ${JSON.stringify(v)} is not a duration such as '30s', '5m' or '1h'`);
  return +m[1]! * UNITS[m[2]!]!;
}

function policyOf(name: string, p: RetryPolicy): Policy {
  const [a, b] = p.backoff ?? ['1s', '30s'], min = duration(a, name), max = duration(b, name), retries = p.retries ?? Infinity;
  if (max < min || !(retries >= 0)) throw Error(`sinter: retry policy \`${name}\`: the longest wait is shorter than the first, or retries is negative`);
  return { name, min, max, retries, maxAge: p.maxAge == null ? Infinity : duration(p.maxAge, name), key: p.key ?? 'Idempotency-Key' };
}

/** `Retry-After`, in milliseconds from now: seconds, or an HTTP date. NaN when absent or unreadable. */
export const retryAfter = (v: string | null, now: number): number => (v?.trim() ? (/^\d+$/.test(v.trim()) ? +v * 1e3 : Date.parse(v) - now) : NaN);

/** A new idempotency key: a UUID, or 16 random bytes in hex where randomUUID is missing (plain-HTTP dev servers). */
export const newKey = (): string => crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Writes waiting between tries, across the page: while there are any, leaving the page asks first. */
let held = 0, unlisten: (() => void) | null = null;
const ask = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ''; };
function holdWrite(env: Env, d: number) {
  held += d;
  if (held && !unlisten) unlisten = env.listen('beforeunload', ask);
  else if (!held && unlisten) { unlisten(); unlisten = null; }
}

const aborted = () => new DOMException('', 'AbortError');

/** Waits `ms`; `online` ends the wait early; an abort of `signal` or `stop` rejects. */
const sleep = (env: Env, ms: number, signals: Array<AbortSignal | null>) => new Promise<void>((ok, no) => {
  const fail = () => end(no, aborted()), end = (f: (e?: any) => void, e?: unknown) => {
    env.clearTimeout(t);
    off();
    for (const s of signals) s?.removeEventListener('abort', fail);
    f(e);
  };
  const t = env.setTimeout(() => end(ok), ms, 'backoff'), off = env.listen('online', () => end(ok));
  for (const s of signals) s?.aborted ? fail() : s?.addEventListener('abort', fail);
});

export function retry(options: RetryOptions): Retry {
  const policies = new Map(Object.entries(options.policies).map(([n, p]) => [n, policyOf(n, p)]));
  if (options.get != null && !policies.has(options.get)) throw Error(`sinter: retry get names no policy: \`${options.get}\``);
  return {
    has: (name) => policies.has(name),
    wrap(method, url, init, headers, layer, env) {
      const write = method != 'GET' && method != 'HEAD', n = write ? init.retry : init.retry || options.get;
      if (!n) return null;
      const p = policies.get(n);
      if (!p) throw new SinterError(null, null, `unknown retry policy \`${n}\``);
      if (write && p.key && !headers.has(p.key)) headers.set(p.key, newKey());
      return (once) => send(p, method, write, once, url, init.signal, init.stop, layer, env);
    },
  };
}

/** the session probe's status (0: a network error); it has no retry policy of its own */
const probe = (layer: RequestLayer) => layer.raw(config.sessionProbe!, { retry: false }).then((r) => r.status, (e) => e?.status ?? 0);

async function send(p: Policy, method: string, write: boolean, once: () => Promise<Response>, url: string, signal: AbortSignal | undefined, stop: AbortSignal | undefined, layer: RequestLayer, env: Env): Promise<Response> {
  const deadline = env.now() + p.maxAge, log = (m: string) => layer.log?.(`(${p.name}): ${method} ${url} ${m}`);
  let wait = p.min, tries = 0, waiting = false;
  /** the next wait: `wait` ±25 %, and the one after it twice as long, up to the longest */
  const next = () => { const d = jittered(wait, env.random, 0.25); wait = doubled(wait, p.max); return d; };
  const pause = async (ms: number) => {
    layer.waiting = (layer.waiting ?? 0) + 1;
    try { await sleep(env, ms, [signal ?? null, stop ?? null]); } finally { layer.waiting--; }
    if (stop?.aborted) throw aborted();
  };
  try {
    for (;;) {
      let res: Response | null = null, err: SinterError | null = null;
      try { res = await once(); } catch (e) {
        if (isAbort(e)) throw e;
        // a network error or a timeout (status 0); a refused request (also 0) is not sent again
        err = toError(e);
        if (err.status !== 0 || /refused/.test(err.message)) throw err;
      }
      tries++;
      const status = res?.status ?? 0;
      if (res?.ok) { if (tries > 1) log(`succeeded on try ${tries}`); return res; }
      // a retried DELETE that finds nothing: the earlier try deleted it
      if (status == 404 && tries > 1 && method == 'DELETE') return new Response(null, { status: 204 });
      if (res && status < 500 && status != 429) return res;
      const failed = `try ${tries} failed (${err?.message ?? status})`, quit = () => { log(`${failed}: gave up`); if (res) return res; throw err; };
      // `Retry-After` on a 429 or 503: not sooner than that. Too late for the policy's last try (its
      // deadline, or what its remaining tries take at the longest wait): fail now
      const delay = Math.max(next(), (status == 429 || status == 503) && retryAfter(res!.headers.get('Retry-After'), env.now()) || 0);
      if (stop?.aborted) throw aborted();
      if (tries > p.retries || env.now() + delay > Math.min(deadline, env.now() + (p.retries - tries + 1) * p.max * 1.25)) return quit();
      if (write && !waiting) { waiting = true; holdWrite(env, 1); }
      log(`${failed}; next in ${Math.round(delay / 1e3)} s`);
      await pause(delay);
      // after a network error the session probe decides: 2xx tries again, 401 ends it (the login
      // redirect), anything else waits longer
      for (let s; err && config.sessionProbe && !((s = await probe(layer)) >= 200 && s < 300);) {
        if (s == 401) throw new SinterError(401, null, 'unauthorized');
        const d = next();
        if (env.now() + d > deadline) return quit();
        await pause(d);
      }
    }
  } finally {
    if (waiting) holdWrite(env, -1);
  }
}
