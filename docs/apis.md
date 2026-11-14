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
      defaults: {
        'GET /articles': { items: 'articles', total: 'articlesCount', key: 'slug' },
        'GET /user': { items: 'user' },
      },
    },
    billing: { base: process.env.BILLING_URL, openapi: 'specs/billing.yml' },
  },
  defaultApi: 'main',
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
| `defaults` | What the spec's operations return, by `METHOD /path` as the spec writes it: `items`, `total`, `key`, `type`, and `query` (query parameters the spec leaves out). |
| `operations` | Endpoints the spec does not have, with the same keys. |

`defaultApi` names the API a path without `api:` goes to; with one API it is that one. `site` is
built in: the page's own origin (`src="site:/config.json"`), declared like any other API.

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

The parameters `paginate` sends (`size-param`, `offset-param`, `page-param`, `direction-param`, the
cursor's fields) count as given, and are checked too. A parameter with `style: deepObject` accepts
`name[field]`.

A path matches the spec's paths as `src` always did: a literal segment matches the same literal, a
`{value}` matches a `{param}`, a literal path beats a templated one.

## What an endpoint returns, said once

`items`, `total`, `key` and `type` come from the API's `defaults` or `operations`, else from the
element, and the type from the spec. When the config has a value, a resource does not write it:
the same value is warning `SN518` (it says nothing), a different one error `SN330`. `order`,
`each`, `paginate`, `when`, `then`, `cache`, `refresh` and `early` stay on the element: they are how
the page uses the data.

`key` is never guessed. A list of objects without `key` is warning `SN517`: the resource is one
object holding the list, fine for a list that is only read, but an `upsert`, `patch` or `remove`
would act on the whole list.

## Resources that load with POST

```html
<sn-resource name="hits" src="/search" method="POST" body="{ q, limit: 20 }" key="id"></sn-resource>
```

A search or report endpoint that takes a request body. The body is sent as JSON, checked against
the request schema, and the resource reloads when it changes; loads with the same URL and body
share one request. A POST resource cannot have `cache`, `paginate` or `each`, and loads from the
page module only: it is not preloaded, requested early, prefetched or embedded.

## Requests

Every request to an API carries its `credentials` and `headers`: resources, actions, streams (where
the transport allows headers), the next-page prefetch and the early file, whose response the page
module takes when its request is the one the early file sent. A middleware that adds a header (a
token) still gets a request of its own.

- A preload link (`<link rel="preload" as="fetch">`) cannot carry headers: a resource of an API with
  `headers` gets none, and the early file's request is its first. `credentials: 'include'` writes
  `crossorigin="use-credentials"`.
- The server layers send the static headers with their own requests: the build's manifest lists
  them per placeholder (`@tiaforge-ui/sinter/server`, sinter-axum and Sinter.AspNetCore).

To treat APIs differently in a middleware, ask which one a request goes to:

```js
import { apiOf, configure } from '@tiaforge-ui/sinter';

configure({
  request: [(req, next) => (apiOf(req.url) == 'billing' ? next(withToken(req)) : next(req))],
});
```

## In the editor

`sinter lsp` completes the operations inside `src="…"` and an action's method attribute: type any
part of the path, the operation's id or summary, or the API's name (`comments` finds
`/articles/{slug}/comments`). Path parameters are placeholders to fill in. After `?` and `&` it
offers the declared query parameters. Hover shows the method and the absolute URL with the page's
values, the operation, and where `items`, `key` and `type` come from. Go to definition opens the
path in the spec, or its key in the config. `SN326`, `SN328`, `SN330` and `SN518` have quick fixes.

## Moving an app to `apis`

Configure the APIs, then:

```sh
npx sinter migrate            # prints the changes
npx sinter migrate --write    # rewrites the pages, components and layouts
```

It rewrites every URL that starts with an API's base into the path relative to it (with `api:` for
another API than the default), and edits nothing else. It prints what to add to the config: the
`defaults` every page agrees on (then remove those attributes: `SN518` and its quick fix point at
them) and the `operations` no spec declares. A same-origin path under no base is listed, not
changed: write `site:` in front if it is the page's own. It does not edit the Vite config, and a
second run changes nothing.

## In tests

```js
const { root } = await render(page, {
  requests: mockRequests({ 'GET /v1/contacts': [{ id: 1, name: 'Ada' }] }),
  apis: { main: { openapi: spec, headers: { 'X-Api': '2' } } },   // a parsed OpenAPI document
});
```
