// A token an API is given in `sinter({ apis: { <name>: { token } } })` (docs/apis.md#a-token): the request layer
// sends it to that API's requests only, read from its storage on every request, so a token stored at sign-in is
// used at once, across swaps too. What needs it is not sent while none is stored (a resource loads empty: signed
// out); a 401 clears it; an action's 401 that nothing on the page shows goes to the sign-in page; a response the
// config names stores a new one.
// The page module installs this (`$tokens()`) when one of its APIs has a token: other apps carry none of it.
import { apiFor, config, clearStored, SinterError, type ApiSettings, type LoginRedirectOptions } from './runtime/config.js';
import type { Env } from './runtime/env.js';
import { tokens, type TokenHooks } from './runtime/request.js';

type Token = NonNullable<ApiSettings['t']>;
/** where a sign-in goes from `href`: `signInTarget`'s (runtime/config.ts) */
type To = (i: string | LoginRedirectOptions, href: string, session: Storage | null) => string;

/** an app whose `signIn`s are paths needs none of loginRedirect's options: `signInTarget`'s path form, the return URL stored */
let to: To = (i, href, s) => {
  const u = new URL(href);
  try { s?.setItem('sn:return', u.pathname + u.search + u.hash); } catch { /* ignored */ }
  return i as string;
};
/** where the sign-in of `i` (an API's `signIn`) goes from the page now, the return URL stored (also the sign-in guard's, src/signed-in.ts) */
export const signInOf = (i: string | LoginRedirectOptions, env: Env): string => to(i, env.href(), env.session());
/** for the page module of an app with a `signIn` of loginRedirect's options: `$tokens(signInTarget)` */
export { signInTarget } from './runtime/config.js';

const storage = (t: Token, env: Env) => (t.s == 's' ? env.session() : env.storage());

/** the stored token, or null (no storage, nothing stored, or storage refused) */
export function read(t: Token, env: Env): string | null {
  try { return storage(t, env)?.getItem(t.k) || null; } catch { return null; }
}

/** stores (or, `null`, removes) the token; between none and one, whose data the page has changes: persisted state and cached data go */
function write(t: Token, env: Env, v: string | null): void {
  const had = read(t, env) != null;
  try { const s = storage(t, env); v == null ? s?.removeItem(t.k) : s?.setItem(t.k, v); } catch { /* storage refused: nothing kept */ }
  if (had != (v != null)) clearStored();
}

/** the operation of `keys` (`METHOD /path`, a `{…}` segment matching any one) a request calls */
const match = (keys: string[], method: string, path: string): string | undefined => {
  const segs = path.split('/');
  return keys.find((k) => {
    const i = k.indexOf(' '), want = k.slice(i + 1).split('/');
    return k.slice(0, i) == method && want.length == segs.length && want.every((w, j) => w[0] == '{' || w == segs[j]);
  });
};

/** a URL's path relative to its API's base, without the query */
const pathOf = (a: ApiSettings, url: string, href: string) => url.slice(new URL(a.b || '/', href).href.replace(/\/$/, '').length).split(/[?#]/)[0] || '/';

/** whether a GET needs the token (`r`: the paths that do; absent, every one): signed out, it is not sent */
const needs = (t: Token, method: string, path: string) => method == 'GET' && (!t.r || !!match(t.r.map((p) => 'GET ' + p), method, path));

const pick = (at: string, body: any) => at.split('.').reduce((x, k) => x?.[k], body);

/** whether a GET of this URL needs a token that is not stored: not sent, the resource reads as signed out */
const out = (url: string, env: Env) => {
  const a = apiFor(url, env.href()), t = a?.t;
  return !!t && read(t, env) == null && needs(t, 'GET', pathOf(a, url, env.href()));
};

const hooks: TokenHooks = {
  skip(l, req, m) {
    const d = l.def, r = l.res, env = l.app.env;
    if (d.call || d.body != null || !out(req, env)) return false;
    if (!l.pager?.appends(m)) r.replace(r.isCollection ? [] : null);
    r.setTotal(null);
    l.pager?.received([], null, m, null);
    r.meta.error = null;
    r.meta.loadedAt = new Date(env.now());
    l.loading(false);
    r.onDirty('meta');
    l.done(r.value());
    l.settle(true);
    return true;
  },
  async send(a, method, url, headers, go, env) {
    const t = a.t!, path = pathOf(a, url, env.href()), need = needs(t, method, path), v = read(t, env);
    // signed out: a GET that needs the token is not sent (its resource reads as signed out)
    if (v == null && need) throw new SinterError(401, null, 'signed out: no token is stored');
    if (v != null) headers.has(t.h) || headers.set(t.h, t.p + v);
    let res = await go();
    if (res.status == 401 && v != null) {
      // the token is no good: gone, and with it what was loaded with it
      write(t, env, null);
      // a load that works without one: the anonymous answer
      if (!need && method == 'GET') { headers.delete(t.h); res = await go(); }
    } else if (res.ok && t.f) {
      const at = t.f[match(Object.keys(t.f), method, path) ?? ''];
      let x: unknown;
      if (at) try { x = pick(at, await res.clone().json()); } catch { /* no JSON: no token */ }
      if (typeof x == 'string' && x) write(t, env, x);
    }
    return res;
  },
  signIn(url, env) {
    const t = apiFor(url, env.href())?.t;
    if (!t?.i) return false;
    // as loginRedirect: the return URL stored, what the visitor kept dropped, then away
    const u = signInOf(t.i, env);
    clearStored();
    env.navigate(u);
    return true;
  },
  signOut(env, app) {
    let had = false;
    for (const a of config.apis) if (a.t && read(a.t, env) != null) { had = true; write(a.t, env, null); }
    // nobody was signed in: what the page kept is dropped all the same
    if (!had) clearStored();
    // the handler says where to go next: not the page's sign-in guard
    tokens.out = true;
    // the resources of those APIs load again: signed out
    for (const d of app?.ir.resources ?? []) {
      const l = app!.resource(d.name).loader, u = l?.url?.();
      if (u && !d.call && apiFor(u, env.href())?.t) void l!.refresh();
    }
  },
};

/**
 * The page module, for an app with a token: the request layer sends it (once is enough; the testing module calls it too).
 * `target`: `signInTarget`, passed by an app with a `signIn` of loginRedirect's options (`{ to, returnUrl }`).
 */
export function $tokens(target?: To): void {
  tokens.on = hooks;
  if (target) to = target;
}
