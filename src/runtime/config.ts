// App-wide configuration and the request middleware helpers. Configuration
// comes only from configure() in JavaScript, never from the DOM.
import { defaultEnv, type Env } from './env.js';
import type { Transport } from './app.js';

export type Middleware = (request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>;

export interface Config {
  request: Middleware[];
  sessionProbe: string | null;
  onError: ((error: SinterError, element: Element | null) => void) | null;
  locale: { get(): string; set(locale: string): void } | null;
  urlSchemes: string[];
  origins: string[];
  /** the transport for a `<sn-sync>` stream URL; `undefined` (or no function) means EventSource */
  transport: ((url: string) => Transport | undefined) | null;
  /** `data-sn-confirm`: asks the question; the action runs on true (window.confirm by default) */
  confirm: (question: string) => boolean | Promise<boolean>;
  env: Env;
}

export const config: Config = {
  request: [], sessionProbe: null, onError: null, locale: null, urlSchemes: [], origins: [], transport: null,
  confirm: (question) => globalThis.confirm(question), env: defaultEnv,
};

export function configure(options: Partial<Omit<Config, 'env'>> & { env?: Partial<Env> }): void {
  const { env, ...rest } = options;
  Object.assign(config, rest);
  if (env) config.env = { ...config.env, ...env };
}

/** `$error`: a non-2xx response, a network error (status 0), a refused request, or a failed action call (status null). */
export class SinterError extends Error {
  /**
   * @param detail what went wrong in words: the server's message or text, or a thrown error's
   *   message; null when there is none (`message` then falls back to the HTTP status)
   */
  constructor(readonly status: number | null, readonly body: unknown, message: string, readonly detail: string | null = null) {
    super(message);
    this.name = 'SinterError';
  }
}

const PERSIST_PREFIX = 'sn:';
const RETURN_KEY = 'sn:return';
/** page-load cache entries (`cache` on `<sn-resource>`), in sessionStorage */
export const CACHE_PREFIX = 'sn:c:';

function removeKeys(s: Storage | null, prefix: string) {
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch { /* storage failures are ignored */ }
}

/** Removes the page-load cache; sinter calls it on every 401. */
export function clearCached(env = config.env): void {
  removeKeys(env.session(), CACHE_PREFIX);
}

/** Removes every persisted value (`sn:` keys) and the page-load cache, e.g. on logout. */
export function clearPersisted(): void {
  removeKeys(config.env.storage(), PERSIST_PREFIX);
  clearCached();
}

// ---- middleware

export function credentials(mode: RequestCredentials): Middleware {
  return (req, next) => next(new Request(req, { credentials: mode }));
}

/** Adds a header to same-origin requests, or to requests to `options.origin` only. */
export function header(name: string, value: string, options: { origin?: string } = {}): Middleware {
  return (req, next) => {
    const target = new URL(req.url).origin;
    const allowed = options.origin ? target === new URL(options.origin).origin : target === new URL(config.env.href()).origin;
    if (!allowed) return next(req);
    const headers = new Headers(req.headers);
    headers.set(name, value);
    return next(new Request(req, { headers }));
  };
}

export function onUnauthorized(handler: (request: Request, response: Response) => Promise<Response>): Middleware {
  return async (req, next) => {
    const res = await next(req);
    return res.status === 401 ? handler(req, res) : res;
  };
}

export interface LoginRedirectOptions {
  to: string;
  returnUrl?: { allow: string[]; param?: string };
}

/**
 * Stores the return URL (same-origin, allowlisted prefixes only), clears
 * persisted state, navigates to login and never resolves.
 */
export function loginRedirect(options: LoginRedirectOptions) {
  return (): Promise<Response> => {
    const env = config.env;
    const here = new URL(env.href());
    const path = here.pathname + here.search + here.hash;
    let target = options.to;
    if (options.returnUrl && options.returnUrl.allow.some((p) => here.pathname.startsWith(p))) {
      try { env.session()?.setItem(RETURN_KEY, path); } catch { /* ignored */ }
      if (options.returnUrl.param) {
        const u = new URL(options.to, here);
        u.searchParams.set(options.returnUrl.param, path);
        target = u.origin === here.origin ? u.pathname + u.search + u.hash : options.to;
      }
    }
    clearPersisted();
    env.navigate(target);
    return new Promise<Response>(() => {});
  };
}

/** The return URL stored by loginRedirect, if it is same-origin and allowlisted; removes it. */
export function takeReturnUrl(allow: string[]): string | null {
  const env = config.env;
  let v: string | null = null;
  try {
    const s = env.session();
    v = s?.getItem(RETURN_KEY) ?? null;
    s?.removeItem(RETURN_KEY);
  } catch { return null; }
  if (!v || !v.startsWith('/') || v.startsWith('//')) return null;
  const u = new URL(v, env.href());
  if (u.origin !== new URL(env.href()).origin) return null;
  return allow.some((p) => u.pathname.startsWith(p)) ? u.pathname + u.search + u.hash : null;
}
