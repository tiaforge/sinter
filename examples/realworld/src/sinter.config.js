// App configuration: the RealWorld suite's rules for the current user, and the islands (browser work the
// pages' expressions cannot do). The token itself is the API's (apis.js).
import { configure } from '@tiaforge-ui/sinter';
import './islands.js';

const USER = 'https://api.realworld.show/api/user';

/**
 * `GET /user`: any 4xx means the token is no good, so it is answered as a 401 (sinter then signs out); an empty 200
 * is an error ("unavailable"), as are 5xx, network and parse errors, which keep the token. Response only: the request
 * the early script sent is the one this sends, so its response is used.
 */
async function currentUser(req, next) {
  const res = await next(req);
  if (req.method !== 'GET' || req.url !== USER) return res;
  if (res.status >= 400 && res.status < 500) return new Response(res.body, { status: 401, headers: res.headers });
  if (res.ok && !(await res.clone().text())) return new Response(null, { status: 502, statusText: 'Empty response' });
  return res;
}

/**
 * A GET that sent the token and was answered 401 is sent again without it: the reads of articles, profiles and comments are
 * public, and a token the API rejects (an old one, a made-up one) must not take them down, or sign the reader out, which sinter
 * does on any 401. Whether the token is good is `GET /user`'s to say (above). Some APIs (the official Nitro one) refuse a bad token
 * on these reads; others ignore it. A read that needs the token (`/articles/feed`) answers 401 again and keeps it.
 */
async function publicReads(req, next) {
  const res = await next(req);
  if (res.status !== 401 || req.method !== 'GET' || req.url === USER || !req.headers.has('Authorization')) return res;
  const headers = new Headers(req.headers);
  headers.delete('Authorization');
  const again = await next(new Request(req, { headers }));
  return again.status === 401 ? res : again;
}

// the API's origin is allowed by sinter({ apis }) (apis.js): every page adds it
configure({
  request: [currentUser, publicReads],
  // the forms show the server's errors in their `.error-messages` list (`$error`), no field marked
  fieldErrors: () => null,
});
