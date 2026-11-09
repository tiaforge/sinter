// App-wide configuration and the request middleware helpers. Configuration
// comes only from configure() in JavaScript, never from the DOM.
import { envOf, type Env } from './env.js';
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
  /**
   * server validation errors of a failed form action: `{ <control name>: message | message[] }`, or
   * null when the error is not about fields; default (`fieldErrors` below): a 4xx whose JSON body
   * has an `errors` object
   */
  fieldErrors: ((error: SinterError, form: HTMLFormElement) => Record<string, unknown> | null | undefined) | null;
  /** what `configure({ env })` overrides of the default environment (see `envOf`); the testing module sets a whole one */
  env: Partial<Env> | null;
}

export const config: Config = {
  request: [], sessionProbe: null, onError: null, locale: null, urlSchemes: [], origins: [], transport: null, fieldErrors: null,
  confirm: (question) => globalThis.confirm(question), env: null,
};

export function configure(options: Partial<Omit<Config, 'env'>> & { env?: Partial<Env> }): void {
  const { env, ...rest } = options;
  Object.assign(config, rest);
  if (env) config.env = { ...config.env, ...env };
}

/**
 * Adds origins to the allowlist (`configure({ origins })` replaces it): the page module calls this
 * with the build's `sinter({ origins })` after the app's config module has run, so an app lists its
 * API origins once, in the Vite config.
 */
export function $origins(list: string[]): void {
  config.origins = [...new Set([...config.origins, ...list])];
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
/** next-page data (the `prefetch` feature): requested when a link to another page is about to be followed, in sessionStorage */
export const PREFETCH_PREFIX = 'sn:p:';
/**
 * Marks a next-page prefetch on its way through the middleware chain (a header survives
 * `new Request(req, { headers })`, which middleware uses to add its own). Removed before the
 * request is sent; a prefetch answered with an error rejects there, and `onUnauthorized` passes
 * a marked request by, so no login redirect starts from a request the user did not make.
 */
export const PREFETCH_MARK = 'x-sinter-prefetch';

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

/** Removes the page-load cache and the next-page data; sinter calls it on every 401. */
export function clearCached(env: Env = envOf(config)): void {
  removeKeys(env.session(), CACHE_PREFIX);
  clearPrefetched(env);
}

/** Removes the next-page data; sinter calls it after every mutation, which may have changed it. */
export function clearPrefetched(env: Env): void {
  removeKeys(env.session(), PREFETCH_PREFIX);
}

/** Removes every persisted value (`sn:` keys) and the page-load cache, e.g. on logout. */
export function clearPersisted(): void {
  removeKeys(envOf(config).storage(), PERSIST_PREFIX);
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
    const allowed = options.origin ? target === new URL(options.origin).origin : target === new URL(envOf(config).href()).origin;
    if (!allowed) return next(req);
    const headers = new Headers(req.headers);
    headers.set(name, value);
    return next(new Request(req, { headers }));
  };
}

export function onUnauthorized(handler: (request: Request, response: Response) => Promise<Response>): Middleware {
  return async (req, next) => {
    const res = await next(req);
    return res.status === 401 && !req.headers.has(PREFETCH_MARK) ? handler(req, res) : res;
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
    const env = envOf(config);
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
  const env = envOf(config);
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

/**
 * The default reading of a field-error response (`configure({ fieldErrors })`): a 4xx whose JSON body
 * has an `errors` object of `name: message | message[]` (Rails, Laravel, RealWorld, ASP.NET's
 * ValidationProblemDetails); else null. Exported here, not from the fields module, so that a config
 * module can fall back to it without putting that module on every page.
 */
export function fieldErrors(error: SinterError): Record<string, unknown> | null {
  const st = error.status ?? 0, e = (error.body as any)?.errors;
  return st >= 400 && st < 500 && e && typeof e == 'object' && !Array.isArray(e) ? e : null;
}
