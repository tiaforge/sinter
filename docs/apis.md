# APIs

Configure the APIs your app calls once, in the Vite config. Pages then write paths, not URLs: the
build puts each API's base in front, checks every path against its OpenAPI spec, and sends each
API's credentials and headers.

```js
// vite.config.js
sinter({
  apis: {
    main: {
      base: process.env.API_URL,          // default: the spec's first server
      openapi: 'specs/main.yml',
      credentials: 'include',
      default: true,                      // paths without `api:` (with one API, it is that one)
      defaults: {
        'GET /articles': { select: 'articles', total: 'articlesCount', key: 'slug' },
        'GET /user': { select: 'user' },
      },
    },
    billing: { base: process.env.BILLING_URL, openapi: 'specs/billing.yml' },
  },
});
```

```html
<sn-resource name="user" src="/user"></sn-resource>
<sn-resource name="articles" src="/articles?tag={$url.tag}&limit={10}"></sn-resource>
<sn-resource name="invoices" src="billing:/invoices?status={tab}" key="id"></sn-resource>
<button data-sn-delete="/articles/{a.slug}" data-sn-optimistic="remove(a)">Delete</button>
```

Without `apis` nothing changes: `src="/api/contacts"` is a same-origin URL, as before.

## The config

| Key | Meaning |
| --- | --- |
| `base` | The URL every path of the API is relative to: a same-origin path (`/api`) or an `https://` URL, without a trailing `/`. Left out, the spec's first `servers` URL. Written but `undefined` (an environment variable that is not set) is an error, not a fallback to the spec's server, which is often production. |
| `openapi` | Local OpenAPI 3 files (JSON or YAML), one or a list. Optional. |
| `credentials` | `'omit'`, `'same-origin'` (default) or `'include'`, for every request to the API. |
| `headers` | Static headers for every request to the API. They are compiled into the page bundle: no secrets. |
| `defaults` | What the spec's operations return, by `METHOD /path` as the spec writes it: `select`, `total`, `key`, `type`, and `query` (query parameters the spec leaves out). |
| `operations` | Endpoints the spec does not have, with the same keys. |
| `default` | `true`: paths without `api:` go to this API. With one API it is that one. |

`site` is
built in: the page's own origin (`src="site:/config.json"`), declared like any other API. `file` is
built in too, and cannot name an API (`SN329`): `src="file:./intro.txt"` reads a file of the project at
build time ([resources.md](resources.md#files)).

The build reads `base` when it runs: one build serves one set of API URLs. `sinter({ origins })` is
only needed for origins that are no API (an image host); the APIs' origins are allowed on every page.

`sinter({ openapi })` without `apis` still types resources as before, with a deprecation warning.

## Paths

`[api:]/path?query`, with `{…}` values written in place as in any URL template. A `null` query
value leaves the parameter out. The method comes from where the path is written: `GET` for a
resource, the attribute for an action (`data-sn-post`), `GET` for `<sn-sync src>`.

A configured API accepts only the operations it declares, in its spec or in `operations`:

| You wrote | Report |
| --- | --- |
| `src="/contacs"` | `SN326` `GET /contacs` is no operation of the API `main`. Did you mean `/contacts`? |
| `src="/api/contacts"` with `base: '/api'` | `SN326`, with `/contacts` as the closest |
| `src="/articles?tagg={t}"` | `SN327` declares no query parameter `tagg`. Did you mean `tag`? |
| a required query parameter left out | `SN327` needs the query parameter `from` |
| `src="https://api.example.com/v1/x"` | `SN328` names the origin of the API `main`: write `/x` |
| `operations` without `type` for a resource | `SN504` warning (untyped), as for any resource without a type |

The parameters `paginate` sends (the names in its `params`, or its API's `paginate.params`, and the
cursor's fields) count as given, and are checked too. A parameter with `style: deepObject` accepts
`name[field]`.

A path matches the spec's paths as `src` always did: a literal segment matches the same literal, a
`{value}` matches a `{param}`, a literal path beats a templated one.

## What an endpoint returns, said once

`select`, `total`, `key` and `type` come from the API's `defaults` or `operations`, else from the
element, and the type from the spec. When the config has a value, a resource does not write it:
the same value is warning `SN518` (it says nothing), a different one error `SN330`. `order`,
`for`, `paginate`, `when`, `then`, `cache`, `refresh` and `early` stay on the element: they are how
the page uses the data.

`key` is never guessed. A list of objects without `key` is warning `SN517`: the resource is one
object holding the list, fine for a list that is only read, but an `upsert`, `merge` or `remove`
would act on the whole list.

## Resources that load with POST

```html
<sn-resource name="hits" src="/search" method="POST" body="{ q, limit: 20 }" key="id"></sn-resource>
```

A search or report endpoint that takes a request body. The body is sent as JSON, checked against
the request schema, and the resource reloads when it changes; loads with the same URL and body
share one request. A POST resource cannot have `cache`, `paginate` or `for`, and loads from the
page module only: it is not preloaded, requested early, prefetched or embedded.

## Requests

Every request to an API carries its `credentials` and `headers`: resources, actions, streams (where
the transport allows headers), the next-page prefetch and the early file, whose response the page
module takes when its request is the one the early file sent. A middleware that adds a header
still gets a request of its own (a dev warning says so); a token goes on the API instead ([a token](#a-token)).

- A preload link (`<link rel="preload" as="fetch">`) cannot carry headers: a resource of an API with
  `headers` gets none, and the early file's request (which sends them) is its first.
  `credentials: 'include'` writes `crossorigin="use-credentials"`.
- Early requests leave before request middleware runs. When the config module may change requests
  (`header()`, or a `request` middleware that does not pass the request on untouched; `onUnauthorized` does,
  [first paint](first-paint.md#request-middleware-and-sign-in) says what counts), nothing of an API without a `token` is requested early: a request
  without what the middleware adds would be refused and sent again ([first paint](first-paint.md#request-middleware-and-sign-in)).
  An API with a `token` keeps its early requests whatever the middleware.
- The spec's `security` refines that per operation (the operation's, else the document's):
  - public (`security: []`) or a cookie (`apiKey` with `in: cookie`, `mutualTLS`): preloaded and requested
    early even with middleware, since what it adds does not change the answer;
  - optional (an alternative `{}` beside one with a token): the answer may differ with a token (a signed-in
    view), so it is not preloaded when something may add one: a preload carries no token, and the browser
    hands its answer to the page's request, token or not;
  - a token the app adds (`http` bearer or basic, `apiKey` in a header or the query, OAuth): not
    requested before the page module at all, as with `early="off"`, nor embedded by the server
    layers: an early request would be refused;
  - no `security`: the config decides, as without a spec.
- With a `token` on the API: everything but public and cookie operations is requested early by the early file,
  with the token, never by a preload link, and not embedded by the server layers (they have no visitor's token).
  An optional operation is the exception under `embed: true`: the server embeds its signed-out answer, which a
  visitor with no token stored is shown in the first paint, with no request; with a token stored, the early file
  requests it with the token and the page shows that answer instead (the embedded one is not used, early or at mount).
- A session cookie needs none of this: the browser sends it with preloads and early requests. Prefer it
  to a token in localStorage when you control the API.
- The server layers send the static headers with their own requests: the build's manifest lists
  them per placeholder (`@tiaforge-ui/sinter/server`, sinter-axum and Sinter.AspNetCore).

To treat APIs differently in a middleware, ask which one a request goes to (a token is the API's own:
[a token](#a-token)):

```js
import { apiOf, configure } from '@tiaforge-ui/sinter';

configure({
  request: [(req, next) => (apiOf(req.url) == 'billing' ? next(withToken(req)) : next(req))],
});
```

## A token

An API that issues a token the page keeps (a JWT in localStorage) declares it, and nothing else is written:
no middleware, no listener on sign-in, no early-request switches.

```js
// vite.config.js: sinter({ apis })
realworld: {
  openapi: 'openapi.yml',
  token: {
    storage: 'local:jwtToken',          // or 'session:<key>' (sessionStorage)
    scheme: 'Token',                    // the word before it; default from the spec, else Bearer
    signIn: '/login',                   // where an action's 401 goes, with the return URL
    from: { 'POST /users/login': 'user.token', 'POST /users': 'user.token', 'PUT /user': 'user.token' },
  },
}
```

| Key | Meaning |
| --- | --- |
| `storage` | Where the token is: `'local:<key>'` or `'session:<key>'`. Read on every request, so a token stored at sign-in is used at once, across swaps too. |
| `header` | The header it goes in. Default: the spec's `securitySchemes` (`http` bearer: `Authorization`; `apiKey` in a header: its `name`), else `Authorization`. |
| `scheme` | The word before the token, `''` for none. Default: `Bearer` for `http` bearer, or for `Authorization` without a spec; none for an `apiKey`. |
| `signIn` | Where a 401 of an action that nothing on the page shows goes: a path (the return URL stored for `takeReturnUrl`), or `loginRedirect`'s options, `{ to: '/login', returnUrl: { allow: ['/'], param: 'next' } }`. |
| `from` | The operations whose 2xx response issues a token, and where it is in the body. |
| `required` | Operations that need the token besides those the spec's `security` says. Without a spec and without `required`: every operation. |

What happens:

- **Sent.** The token goes to that API's requests only (its origin and base), beside its static headers: resources,
  actions, the next-page prefetch and the early file's requests, which send it the same way, so the page module takes
  their responses. Operations the spec says need no token get it too when one is stored.
- **Signed out.** A GET whose operation needs the token is not sent while none is stored: its resource is loaded, empty
  (`null` or `[]`), with `loadedAt` set, at mount. The early script knows it as well, so "signed out" is
  `$meta.user.loadedAt && !user` in the first frame, with no request and no helper.
- **Stored.** After a 2xx of an operation in `from`, the token is stored. Between no token and one (signing in,
  signing out, a 401), what sinter stored for the previous visitor goes, as `clearStored()` does.
- **401.** A 401 from the API clears the token (and the page-load cache, as on any 401). A resource that needs it then
  reads as signed out; one that does not is sent again without it (the anonymous answer). An action's 401 that
  nothing shows (no `data-sn-catch`, a form that does not read `$error`) goes to `signIn`.
- **`signOut()`.** The store function (and the export, for app code) removes every API's token with what sinter
  stored, and the page's resources of those APIs load again, signed out (in an app without a token it does nothing). `data-sn-on-click="signOut(); navigate('/')"`.

A middleware that only reads responses keeps the early requests: RealWorld's turns any 4xx from `GET /user` into a 401
(the suite signs out on those), and the request the early file sent is still the one the page sends. One that changes
a request the early file sent gets a request of its own, and a dev warning names it.

The token never appears in the HTML or the bundle; only its storage key does. It is sent to no other origin. A
token in localStorage is readable by any script on the page: where the API is yours, a session cookie (`HttpOnly`,
`Secure`, `SameSite=Lax`) is still the better choice ([first paint](first-paint.md#request-middleware-and-sign-in)).

### Pages that need a session

```html
<html data-sn-signed-in>                                   <!-- always -->
<conduit-layout data-sn-path="/ /tag/:tag" data-sn-signed-in="$url.feed == 'following'">  <!-- when -->
```

`data-sn-signed-in` on a page's `<html>`, or its layout's tag, sends a visitor with no token stored to the API's
`signIn`, with the return URL, in the current history entry. A value is a condition over `$url` only. The early
script does it before anything paints (nothing is requested, the page module does not mount); the page module does
it at mount without one (`firstPaint: false`, a swap to the page), after a 401 that took the token, and when a
`$url` change makes the condition true. `signOut()` leaves the visitor to the handler, which navigates on. A
prerendered page waits until it is shown; another page does not request a guarded page's data ahead while signed out.
A guarded page always ships its early script and page module.

Refused at build time (`SN347`): no API with a `token`, an API without `signIn`, two APIs with a token the page could
mean, a condition that reads more than `$url`, the attribute on the sign-in page itself (a loop).

It is a convenience, not security: the server still refuses the requests of a visitor without a valid token.

## In the editor

`sinter lsp` completes the operations inside `src="…"` and an action's method attribute: type any
part of the path, the operation's id or summary, or the API's name (`comments` finds
`/articles/{slug}/comments`). Path parameters are placeholders to fill in. After `?` and `&` it
offers the declared query parameters. Hover shows the method and the absolute URL with the page's
values, the operation, and where `select`, `key` and `type` come from. Go to definition opens the
path in the spec, or its key in the config. `SN326`, `SN328`, `SN330` and `SN518` have quick fixes.

## Moving an app to `apis`

Configure the APIs, then:

```sh
npx sinter migrate            # prints the changes
npx sinter migrate --write    # rewrites the pages, components and layouts
```

What it does:

- **Renames.** First, as without `apis`: every rename the compiler reports is written (`data-sn-prop` →
  `data-sn-with`, `refresh('people')` → `refresh(people)`, …), until a pass finds none. A change that is
  not a rename (an old value the message describes) is left for you, as the build reports it.
- **URLs.** Every URL that starts with an API's base becomes the path relative to it, with `api:` for
  another API than the default.
- **The page's own paths.** In a file it migrates, a same-origin path under no base (`/config.json`
  with `base: '/api'`) becomes `site:/config.json` when no operation of the default API matches it.
  When one matches, it is listed: write `site:` if it is the page's own. In a file migrated before, such
  a path stays (it may be the API's, not declared yet) and is listed if no operation matches it.
- **What to add to the config,** printed: the `defaults` every page agrees on, the `operations` no spec
  declares, and the query parameters the spec leaves out (`query`, those `paginate` sends included).
  A likely typo of a query parameter, or a required one left out, is listed for you instead.
- **The attributes the config then says.** Once the config has the `defaults`, `--write` removes the
  `select`, `total`, `key` and `type` it restates (`SN518`), with the space before each.

Run it, add what it prints to the config, and run it again with `--write`. It edits only attribute
values and those attributes, never the Vite config, and a second run changes nothing. On RealWorld,
one run gives the example as it is in this repository, which builds byte for byte as before.

## In tests

`render()` takes `token` on an API, with the storage the test passes: `render(page, { apis: { main: { openapi: spec,
token: { storage: 'local:jwt' } } }, storage })`, a `memoryStorage()` with the token set or not. A guard's redirect
is in `navigations` (`'replace /login'`).

```js
const { root } = await render(page, {
  requests: mockRequests({ 'GET /v1/contacts': [{ id: 1, name: 'Ada' }] }),
  apis: { main: { openapi: spec, headers: { 'X-Api': '2' } } },   // a parsed OpenAPI document
});
```
