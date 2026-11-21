# Proposal: a token declared on the API, and pages that need a session

Status: implemented 2026-11-20. The guide is [apis.md](../apis.md#a-token). Where the implementation departs from
the first draft of this text, it says so under each decision.

Decided with the maintainer: the token is the API's (`sinter({ apis: { <name>: { token } } })`), beside its
`credentials` and `headers`; one store function, `signOut()`; the page guard is an attribute on the page,
`data-sn-signed-in`, a convenience and not security.

The rule this applies ([vocabulary](vocabulary.md)): one way to do each thing. A token an API issues was
a middleware every app wrote again, a listener per sign-in form, a helper for the first paint and an
`early="off"` per resource; it is one setting now, and `header()` is left for values that are no API's token.

## Why

An app whose API takes a token it keeps in localStorage (RealWorld, and the benchmark apps) wrote:

- a request middleware that adds `Authorization: Token <jwt>`, answers `GET /user` with `{user: null}` when nothing
  is stored, and signs out on a 4xx from `/user` (`src/sinter.config.js`, `src/session.js`);
- three `document` listeners (`signed-in`, `settings-saved`, `signed-out`) fed by `emit()` in three forms, which
  store or remove the token and clear the cache;
- a helper, `signedOut()`, so the header and the home banner know "signed out" before the first paint, used as
  `$meta.user.loadedAt ? !user : signedOut()`;
- `early="off"` on the `user` resource, and a 401 branch in the layout's `sn-error` handler;
- and, worse than all of it, it requested nothing early on any page: any `configure({ request })` turns early
  requests off app-wide (`changesRequests()`), since an early request cannot carry what a middleware adds.

And a bug beside it: `authOf` read `security: [{}, { Token: [] }]` (optional auth) as public, so such an operation
was preloaded without the token; a preload is matched by URL and credentials, not headers, so a signed-in visitor
could be handed the anonymous answer.

## What

```js
realworld: {
  openapi: 'openapi.yml',
  token: {
    storage: 'local:jwtToken',          // or 'session:<key>'
    scheme: 'Token',                    // the word before the token
    signIn: '/login',                   // where an action's 401 goes, with the return URL
    from: { 'POST /users/login': 'user.token', 'POST /users': 'user.token', 'PUT /user': 'user.token' },
  },
}
```

```html
<conduit-layout data-sn-path="/settings" data-sn-signed-in>
<conduit-layout data-sn-path="/ /tag/:tag" data-sn-signed-in="$url.feed == 'following'">
```

## Decisions

1. **Where it is read.** The request layer (`src/runtime/request.ts`, beside the API's static headers) and the early
   script (`src/early.ts`) read the token from the same storage on every request, so the early hand-off still
   matches (same URL, credentials and headers), a token stored at sign-in is used at once, and a swap needs nothing.
   The code is a module of its own (`src/token.ts`, `$tokens()` in the page module of an app with a token): the core
   keeps a few optional calls into it.
2. **The header and scheme** come from the spec's `securitySchemes` (`http` bearer: `Authorization: Bearer`; `apiKey`
   in a header: its name, no word), else `header`/`scheme` in the config. Two token schemes with different headers
   and no `header`: `SN329`.
3. **Which operations need it**: those whose `security` needs a token, plus `required`. Without a spec and without
   `required`, all of them. Operations that do not need it get it too when one is stored (`optional`).
   *Departure:* the runtime keeps only the GET paths that need it (`r`), not every method: only a GET is held back
   while signed out ("not sent"); a write is sent, and its 401 goes to `signIn` like any other. That keeps the table
   in every page module short (RealWorld: two paths instead of eleven operations).
4. **Signed out.** A GET that needs the token is not sent while none is stored; its resource is loaded, empty, with
   `loadedAt` set, synchronously at mount (before the first walk), so the early script can say the same: its status
   of such a resource reads the storage (`$so(…)`). `$meta.user.loadedAt && !user` is the signed-out branch in the
   first frame, and the page module adopts it.
5. **401.** A 401 that carried the token clears it (the page-load cache goes on any 401 already). A resource that
   needs it reads as signed out; a GET that does not is sent once more without it (the anonymous answer).
   *Departure:* "an action goes to `signIn`" applies to an action's 401 that nothing on the page shows, the same rule
   as `sn-error`: a form that reads `$error`, or a `data-sn-catch`, keeps its 401 (RealWorld's suite expects the
   settings form to show a 401 from `PUT /user`, and a sign-in form's 401 is a wrong password). The redirect is
   `loginRedirect`'s, with its return-URL rules.
6. **Stored.** After a 2xx of an operation in `from`, the token at that path of the body is stored. A change between
   none and one clears what sinter stored (`clearStored()`'s work, called internally).
7. **`signOut()`**: a store function and an export; in an app without a token API it is `SN347` (decided after review). It removes every API's token with what sinter stored, and the
   page's resources of those APIs load again, signed out. The name is free in the examples and recipes (RealWorld's
   helper was `signedOut`, gone with this).
8. **Build rules.** With a token, an API's operations are requested early by the early script with the token, never
   by a preload link (it cannot carry one, and its answer would go to the page's request anyway), and not embedded
   by the server layers, which have no visitor's token: they get no placeholder, so `sinter-embed.json` lists none and
   the TypeScript, Rust and C# layers skip them without a change of their own. Operations the spec says are public or
   answered with cookies are preloaded and embedded as before. `configure({ request })` no longer makes such an API
   late; other APIs keep today's rule. A middleware that changes a request the early script sent gets a request of
   its own and a dev warning (32).
9. **Optional auth.** `authOf` returns `optional` for `{}` beside a token alternative: preloaded only when nothing can
   add a token (no middleware, no API token), not embedded when a middleware may add one.
10. **Security.** The token goes only to its API's base; nothing of it is in the HTML or the bundle but its storage
    key; `session:` storage works. The docs keep recommending a session cookie where the API is yours.

### The page guard

11. **`data-sn-signed-in`** on `<html>` or the layout's tag on a page: empty, always; else a condition over `$url`
    only (`SN347` otherwise), which the early script evaluates before anything paints. With no token stored and the
    condition true, the early script goes to the API's `signIn` with the return URL (`location.replace`, the page
    hidden meanwhile) and does not let the page module mount. The page module's `signed-in` feature does it at mount
    without an early script (`firstPaint: false`, a swap to the page), after a 401 that took the token, and when a
    `$url` change makes the condition true (after each flush).
12. **Which API.** The one API with a token; with several, the one the page's resources use, and only one (`SN347`
    when it is not clear). It must have `signIn`.
13. **The sign-in page guarded** is a loop: `SN347` when the page's `data-sn-path` matches `signIn`'s path.
14. **Prerender**: the early script does not redirect a prerendered page; the feature waits until it is shown
    (`app.shown`). **Next-page data**: a guarded page's description carries the guard, and nothing is requested
    ahead for it while signed out. **Swaps** mount the page, so the feature runs.
15. **Static pages**: a guarded page always ships its early script and page module (a runtime reason, so
    `sinter({ static })` reports it as `SN322`).
16. **`signOut()`** on a guarded page leaves the visitor to the handler, which navigates on
    (`signOut(); navigate('/')` from settings goes home, not to sign in).
17. **Testing**: `render()` reports the redirect in `navigations` (`'replace /login'`), once: with `firstPaint`, the
    early script's, and the page module's same redirect after it is not counted again.
18. It is a convenience: the server refuses a visitor's requests without a valid token all the same.

## RealWorld, before and after

Removed: the auth middleware, `src/session.js`, the three listeners, `signedOut()`, the `emit()` calls that only
stored the token, `early="off"` on `user`, the layout's 401 branch, the three `<conduit-redirect>` guards and the
element itself, and `&& user` in the feed's `when`. Kept: a response-only middleware for the suite's rules (any 4xx
from `GET /user` signs out, an empty 200 is an error), which does not change the request, so the early hand-off
still matches.

Early requests per page (the early script; no page had any before, and no page has a preload link):

| Page | Before | After |
| --- | --- | --- |
| index | 0 | 4 (`user`, `articles` or `feed`, `tags`) |
| article | 0 | 3 (`user`, `article`, `comments`) |
| profile | 0 | 3 (`user`, `profile`, `articles`) |
| editor | 0 | 2 (`user`, `article` when editing) |
| login, register, settings | 0 | 1 (`user`) |

Signed out, `user` and `feed` are not requested at all (no 401 from `/user` in the console).

What each page loads, min+gzip (`npm run size`, the work branch before and after this; budgets unchanged):

| | Before | After | |
| --- | ---: | ---: | --- |
| minimal page (no token) | 11,522 B | 11,621 B | +99: the core's calls into the token module (`src/token.ts`, `src/signed-in.ts` are their own modules) |
| RealWorld article | 59,703 B | 62,182 B | +2,479; budget 63,488 |
| RealWorld index | 34,055 B | 37,013 B | +2,958 |
| RealWorld profile | 33,718 B | 36,236 B | +2,518 |
| RealWorld editor | 29,430 B | 32,228 B | +2,798 |
| RealWorld settings | 28,619 B | 31,364 B | +2,745 |
| RealWorld login, register | 28,453 / 28,464 B | 30,848 / 30,857 B | +2,395 / +2,393 |

By chunk (gzip): the shared early runtime +1,468 (its request code, which RealWorld carried none of while it requested
nothing early: the URL templates, a paginated list's first page, the hand-off; and the guard's redirect, about 0.2 KB),
each page's early file +100 to +330 (its requests, the API's settings once), the token module +530 (one chunk with the
config module), the core +270, each page module +60 to +90 (the token table), and the guard's module 331 on the three
guarded pages. Cut after review: the API settings are one table per early file, the early file no longer bundles the
config object, and `signIn` travels as a path when it is the path form. In exchange the API's requests leave while the head is parsed
instead of after the page module has loaded.
