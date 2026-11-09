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

function duration(v: unknown, what: string): number {
  const m = typeof v == 'string' ? /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(v.trim()) : null;
  if (!m) throw Error(`sinter: retry ${what} must be a duration such as '30s', '5m' or '1h', got ${JSON.stringify(v)}`);
  return +m[1]! * UNITS[m[2]!]!;
}

function policyOf(name: string, p: RetryPolicy): Policy {
  const [a, b] = p.backoff ?? ['1s', '30s'];
  const min = duration(a, `policy \`${name}\` backoff`), max = duration(b, `policy \`${name}\` backoff`);
  if (max < min) throw Error(`sinter: retry policy \`${name}\`: the longest wait is shorter than the first`);
  const retries = p.retries ?? Infinity;
  if (!(retries >= 0) || (retries != Infinity && !Number.isInteger(retries))) throw Error(`sinter: retry policy \`${name}\`: retries must be a whole number`);
  return { name, min, max, retries, maxAge: p.maxAge == null ? Infinity : duration(p.maxAge, `policy \`${name}\` maxAge`), key: p.key ?? 'Idempotency-Key' };
}

/** `Retry-After`, in milliseconds from now: seconds, or an HTTP date. Null when absent or unreadable. */
export function retryAfter(v: string | null, now: number): number | null {
  if (v == null || !v.trim()) return null;
  if (/^\d+$/.test(v.trim())) return +v.trim() * 1e3;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** A new idempotency key: a UUID, or 16 random bytes in hex where randomUUID is missing (plain-HTTP dev servers). */
export function newKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID == 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Writes waiting between tries, across the page: while there are any, leaving the page asks first. */
let held = 0, unlisten: (() => void) | null = null;
const ask = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ''; };
function holdWrite(env: Env, d: number) {
  held += d;
  if (held > 0 && !unlisten) unlisten = env.listen('beforeunload', ask);
  else if (held == 0 && unlisten) { unlisten(); unlisten = null; }
}

const aborted = () => new DOMException('', 'AbortError');

/** Waits `ms`; `online` ends the wait early; an abort of `signal` or `stop` rejects. */
function sleep(env: Env, ms: number, signals: Array<AbortSignal | null>): Promise<void> {
  return new Promise((ok, no) => {
    const offs: Array<() => void> = [];
    const end = (f: () => void) => { env.clearTimeout(t); for (const off of offs) off(); f(); };
    const t = env.setTimeout(() => end(ok), ms, 'backoff');
    offs.push(env.listen('online', () => end(ok)));
    for (const s of signals) {
      if (!s) continue;
      if (s.aborted) return end(() => no(aborted()));
      const on = () => end(() => no(aborted()));
      s.addEventListener('abort', on);
      offs.push(() => s.removeEventListener('abort', on));
    }
  });
}

export function retry(options: RetryOptions): Retry {
  const policies = new Map(Object.entries(options.policies).map(([n, p]) => [n, policyOf(n, p)]));
  if (options.get != null && !policies.has(options.get)) throw Error(`sinter: retry get names no policy: \`${options.get}\``);
  return {
    has: (name) => policies.has(name),
    wrap(method, url, init, headers, layer, env) {
      const write = method != 'GET' && method != 'HEAD', name = init.retry || undefined, n = write ? name : name ?? options.get;
      if (n == null) return null;
      const p = policies.get(n);
      if (!p) throw new SinterError(null, null, `unknown retry policy \`${n}\``);
      if (write && p.key && !headers.has(p.key)) headers.set(p.key, newKey());
      return (once) => send(p, write, once, `${method} ${url}`, init.signal ?? null, init.stop ?? null, layer, env);
    },
  };
}

/** the session probe's status (0: a network error); it has no retry policy of its own */
const probe = (layer: RequestLayer) => layer.raw(config.sessionProbe!, { retry: false }).then((r) => r.status, (e) => (e instanceof SinterError ? e.status ?? 0 : 0));

async function send(p: Policy, write: boolean, once: () => Promise<Response>, what: string, signal: AbortSignal | null, stop: AbortSignal | null, layer: RequestLayer, env: Env): Promise<Response> {
  const start = env.now(), deadline = start + p.maxAge, log = (m: string) => layer.log?.(`(${p.name}): ${what} ${m}`);
  let wait = p.min, tries = 0, waiting = false;
  /** the time of the policy's last allowed try, from now: its deadline, or what its remaining tries take at the longest wait */
  const last = () => Math.min(deadline, p.retries == Infinity ? Infinity : env.now() + (p.retries - tries + 1) * p.max * 1.25);
  const pause = async (ms: number) => {
    layer.waiting = (layer.waiting ?? 0) + 1;
    try { await sleep(env, ms, [signal, stop]); } finally { layer.waiting--; }
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
      if (res) {
        if (res.ok) { if (tries > 1) log(`succeeded on try ${tries}`); return res; }
        // a retried DELETE that finds nothing: the earlier try deleted it
        if (write && tries > 1 && res.status == 404 && what.startsWith('DELETE ')) { log(`found nothing on try ${tries}: deleted by an earlier try`); return new Response(null, { status: 204 }); }
        if (res.status < 500 && res.status != 429) return res;
      }
      const reason = err ? err.message : `${res!.status}`;
      // `Retry-After` on a 429 or 503: not sooner than that
      const after = res && (res.status == 429 || res.status == 503) ? retryAfter(res.headers.get('Retry-After'), env.now()) : null;
      let delay = jittered(wait, env.random, 0.25);
      wait = doubled(wait, p.max);
      if (after != null) delay = Math.max(delay, after);
      if (tries > p.retries || stop?.aborted || env.now() + delay > last()) {
        if (stop?.aborted) throw aborted();
        log(`failed (${reason}); gave up after ${tries} ${tries == 1 ? 'try' : 'tries'}`);
        if (res) return res;
        throw err;
      }
      if (write && !waiting) { waiting = true; holdWrite(env, 1); }
      log(`failed (${reason}); try ${tries + 1} in ${Math.round(delay / 1e3)} s`);
      await pause(delay);
      // after a network error the session probe decides: 2xx tries again, 401 ends it (the login
      // redirect), anything else waits longer
      if (err && config.sessionProbe) {
        for (;;) {
          const s = await probe(layer);
          if (s >= 200 && s < 300) break;
          if (s == 401) throw new SinterError(401, null, 'unauthorized');
          const d = jittered(wait, env.random, 0.25);
          wait = doubled(wait, p.max);
          if (env.now() + d > deadline) { log(`failed (${reason}); gave up after ${tries} ${tries == 1 ? 'try' : 'tries'}`); throw err; }
          await pause(d);
        }
      }
      if (stop?.aborted) throw aborted();
    }
  } finally {
    if (waiting) holdWrite(env, -1);
  }
}
