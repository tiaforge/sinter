// App configuration: the API origin, the JWT from localStorage on API requests, and the
// islands (browser work the pages' expressions cannot do).
import { configure } from '@tiaforge-ui/sinter';
import { errors } from './sinter.helpers.js';
import { API, json, token } from './session.js';
import './islands.js';

/** Adds `Authorization: Token …` to API requests; turns the current-user fetch into `{user: null}` when signed out. */
async function auth(req, next) {
  if (!req.url.startsWith(API)) return next(req);
  const isUser = req.method === 'GET' && req.url === `${API}/user`;
  const jwt = token.get();
  if (isUser && !jwt) return json({ user: null });
  if (jwt) {
    const headers = new Headers(req.headers);
    headers.set('Authorization', `Token ${jwt}`);
    req = new Request(req, { headers });
  }
  const res = await next(req);
  if (isUser) {
    // 4xx: the token is no good, sign out; 5xx, network and parse errors keep it ("unavailable")
    if (res.status >= 400 && res.status < 500) { token.clear(); return json({ user: null }); }
    if (res.ok && !(await res.clone().text())) return new Response(null, { status: 502, statusText: 'Empty response' });
  }
  return res;
}

// the API's origin is allowed by sinter({ origins }) in vite.config.js: every page adds it
configure({
  request: [auth],
  onError: () => {},
  // every server error into the form's `.error-messages` list (`data-sn-errors`), no field marked
  fieldErrors: (error) => ({ '': errors(error) }),
});
