# Proposal: APIs in the config, operations on the page

Status: proposal, nothing implemented. It replaces the `operation` + `params` prototype on this branch
([What happens to the prototype](#what-happens-to-the-prototype)).

Decided with the user:
- The APIs an app calls are configured in JavaScript, in `sinter({ apis })`: base URL, OpenAPI spec,
  request settings.
- One syntax: every request on a page is an **operation**, `METHOD /path` with `{expr}` values written
  in place. `src` is removed, also when nothing is configured.
- Operations are referenced by method and path, not by `operationId` (generated ids are unstable). Ids
  and summaries remain search terms for completion.
- Endpoints the spec does not have are declared in the config, not in an HTML file (`<sn-resource>`
  elements in a file read as resources that load).
- What an endpoint returns (`items`, `key`, `type`) is said once, in the spec or the config, from the
  start. The page says only how it uses the data.
- With one API configured, it is the default.
- Actions and streams move to operations in the same change.

## The case

In a real app, a page's requests repeat things that belong to the API, not to the page:

- **The base URL**, on every resource and action, the same for every environment the build serves.
  The RealWorld example writes `https://api.realworld.show/api` 26 times.
- **The shape of a response.** `items="user"`, `key="id"` and the type are properties of the endpoint
  and are repeated on every page that loads it.
- **Request settings** (credentials, headers) differ per API. Today they are set per page module, or
  in a middleware that compares URLs.

The spec is consulted only after the fact: sinter matches a `src` to an operation to find its type.
A `src` that matches nothing is a warning (`SN504`), and an unknown query parameter is a warning
(`SN505`). Nothing makes a page use the spec, so the easy path for a person or an agent is to write
URLs and skip the checks.

## Design

### 1. APIs in the config

```js
// vite.config.js
sinter({
  apis: {
    main: {
      base: process.env.API_URL,            // default: the spec's first `servers` URL
      openapi: 'specs/main.yml',
      credentials: 'include',
      defaults: {                           // for operations in the spec
        'GET /user': { items: 'user' },
        'GET /articles': { items: 'articles', total: 'articlesCount', key: 'slug' },
      },
      operations: {                         // endpoints the spec does not have
        'GET /v0/stats/{range}': { items: 'stats', key: 'day', type: 'Stat[]' },
      },
    },
    billing: { base: process.env.BILLING_URL, openapi: 'specs/billing.yml' },
  },
});
```

| Key | Meaning |
| --- | --- |
| `base` | The URL every path of this API is relative to: a same-origin path (`/api`) or an `https://` origin with an optional path. No trailing `/`. Default: the spec's first `servers` URL with its variables' defaults, else `''`. |
| `openapi` | A local JSON or YAML file (or a list), as `sinter({ openapi })` today. Optional. |
| `credentials`, `headers` | Static request settings for every request to this API. Dynamic ones (a token) stay in the request layer, which now gets the API's name (see [Request settings](#7-request-settings)). |
| `defaults` | Per operation of the spec: `items`, `total`, `key`, `order`, `type`. An operation the spec does not have is an error. |
| `operations` | Endpoints the spec does not have: the same keys, and `type` is required. An operation the spec already has is an error (it belongs in `defaults`), so a typo cannot create an endpoint without anyone noticing. |
| `stream` | On an entry of `operations`: `'sse'` or `'ws'`, an endpoint for `<sn-sync>`. |

`sinter({ openapi })` and `sinter({ origins })` are replaced:

- **`openapi`** moves into an API's entry. The old key stays one release as `apis: { default: { openapi } }`, with a deprecation warning.
- **`origins`** is computed from the APIs' bases. An extra origin that is no API (an image host) is still allowed with `origins`.

The config is typed (`SinterOptions['apis']`), so the editor completes the keys in `vite.config.ts`.

#### No config: the implicit API

Without `apis`, a page has one implicit API: same origin, base `''`, no spec. It accepts any operation
and checks none, as `src` does today. The quick start stays one element:

```html
<sn-resource name="contacts" operation="GET /api/contacts" key="id"></sn-resource>
```

Once `apis` is set, the implicit API is gone, and every operation must be declared by a spec or by
`operations`.

### 2. Operations

```text
[api:]METHOD /path[?query]
```

```html
<sn-resource name="contact" operation="GET /contacts/{c.id}"></sn-resource>
<sn-resource name="articles" operation="GET /articles?tag={$url.tag}&limit={10}"></sn-resource>
<sn-resource name="invoices" operation="billing:GET /invoices?status={tab}"></sn-resource>
```

- **`api:`** names the API. It can be left out when there is one API, or for the API named
  `default`. With several APIs and no `default`, the name is required.
- **`METHOD`** is `GET`, `POST`, `PUT`, `PATCH` or `DELETE`, in capitals.
- **The path** is relative to the API's base and starts with `/`. It is written as the spec writes it,
  with values in braces where the spec has `{param}`. Interpolation, encoding, arrays in the query and
  `null` leaving a query parameter out all work as in `src` today.

The compiler resolves the operation at build time and compiles it to the same URL template that `src`
produces today, the base in front. Loading, request sharing, prefetching, the early script and the
server layer do not change.

#### How a path is matched

The rules of today's `src` matching (`matchOperation`) apply, without the server prefix (the base is
not written):

- A literal segment matches the same literal. A segment that is one value, `{c.id}`, matches a
  `{param}`.
- A literal path beats a templated one: `GET /articles/feed` is the feed, `GET /articles/{slug}` an
  article.
- Mixed segments (`/files/{id}.json`) match by their literal parts.

A value can stand where the spec has a literal segment only by being written as that literal. So
`GET /articles/{kind}` never reaches `/articles/feed`: it matches `/articles/{slug}`. That is the
spec's own meaning of the path.

#### What a configured API checks

| Check | Diagnostic |
| --- | --- |
| No operation of the API has this method and path | error, the closest operation as "did you mean" |
| A query parameter the operation does not declare | error (was the `SN505` warning) |
| A required query parameter left out | error |
| A `GET`-only element (a resource with no `body`) naming another method | error |
| `api:` naming no API, or left out with several and no `default` | error |

### 3. What an endpoint returns, said once

`items`, `total`, `key`, `order` and `type` come from the first of these that has them:

1. the operation's entry in `defaults` or `operations`;
2. the spec, for `type` (as today);
3. the element.

The page writes them only for an endpoint that configures none, which is every endpoint of the
implicit API. When the config has a value, the element may not write it. The same value is a warning
(redundant), and a different one is an error: two pages must not read different shapes from one
endpoint.

`each`, `paginate` and its options, `when`, `then`, `cache`, `refresh` and `early` stay on the
element. They say how this page uses the data, not what the endpoint returns.

The RealWorld `user` resource, written today on seven pages:

```html
<!-- today -->
<sn-resource cache name="user" src="https://api.realworld.show/api/user" items="user" then="guest = !$result" early="off"></sn-resource>
<!-- with apis -->
<sn-resource cache name="user" operation="GET /user" then="guest = !$result" early="off"></sn-resource>
```

### 4. Resources

| Attribute | Change |
| --- | --- |
| `src` | removed: `SN328` names the operation it becomes |
| `operation` | new: required, unless `call` is set |
| `body` | new: for a `POST` operation that loads data (search, reports, GraphQL); a value expression sent as JSON, reloaded when it changes |
| `items`, `total`, `key`, `order`, `type` | only for endpoints with no configured value ([§3](#3-what-an-endpoint-returns-said-once)) |

Requests are shared by URL today. A `POST` resource is shared by URL and body. Open question: a `POST`
resource with `cache` (see [Open questions](#open-questions)).

### 5. Actions

The five method attributes become one, with the method in its value. `operation` and
`data-sn-operation` match `call` and `data-sn-call` (a resource's and an action's local call):

```html
<!-- today -->
<button data-sn-delete="/api/contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
<form data-sn-post="/api/signup">…</form>
<!-- with operations -->
<button data-sn-operation="DELETE /contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
<form data-sn-operation="POST /signup">…</form>
```

- `data-sn-get`, `-post`, `-put`, `-patch` and `-delete` are removed (`SN328`).
- Every other action attribute stays as it is: `data-sn-body`, `-trigger`, `-debounce`, `-confirm`,
  `-optimistic`, `-then`, `-catch`, `-concurrency`, `-apply`, `-retry`, `-encoding`.
- What the spec already does for actions (the request schema checks `data-sn-body`, the response types
  `$result`, write-through) uses the operation directly, instead of matching a URL.
- Field errors: `configure({ fieldErrors })` gets `{ url, method, api, operation }`.

### 6. Streams

```html
<sn-sync operation="GET /events">…</sn-sync>
```

The operation is declared with `stream` in `operations` (specs rarely describe event streams), or is
in the spec. The implicit API accepts any. `configure({ transport })` still gets the resolved URL, and
also `{ api, operation }`, so choosing WebSocket or SignalR no longer has to test URL prefixes.

### 7. Request settings

- **Static settings:** `credentials` and `headers` from the config apply to every request to that API:
  resources, actions, streams (where the transport allows it), the early script and the prefetcher.
- **Dynamic settings:** the request layer stays the place for these. Each middleware's context gets
  `api` and `operation`, so `header('Authorization', token, { api: 'billing' })` can replace the URL
  checks middlewares do today.

### 8. Diagnostics

The prototype's codes are not released, so they are reused with their new meaning:

| Code | Name | Severity | Reported for |
| --- | --- | --- | --- |
| `SN326` | `unknown-operation` | error | no such method and path in the API, or no such API; with "did you mean" |
| `SN327` | `operation-params` | error | an undeclared or missing required query parameter, an empty `{}` value |
| `SN328` | `src-removed` | error | `src` on `<sn-resource>`/`<sn-sync>` and `data-sn-get` … `-delete`, with the operation to write (from today's matching) and a quick fix |
| `SN329` | `endpoint-config` | error | `defaults` naming an operation the spec lacks, `operations` naming one it has, `operations` without `type`, an invalid `base` |
| `SN330` | `configured-shape` | warning / error | the element restating a configured `items`, `key`, … (warning if equal, error if different) |

- **Retired:** `SN505` (now `SN327`). `SN504` remains for the implicit API, and for a configured
  operation whose spec gives no JSON response.
- **`SN207`, unchanged:** it still guards against a value choosing the host. A path must start with a
  literal `/`, and the base is a literal from the config, so no value can.

### 9. Editor

**Completion** inside `operation="…"` and `data-sn-operation="…"`:

- **Candidates:** the operations of every API. Resources are offered `GET` operations (and `POST`
  ones that return JSON), actions every method, `<sn-sync>` stream operations.
- **What a candidate matches:** its path, its `operationId`, its summary and its API's name. Typing
  `comments` finds `GET /articles/{slug}/comments`, `inv` finds `billing:GET /invoices`, and
  `GetArt` finds `GET /articles` by its id.
- **Ranking:**
  1. `operationId` or path-segment prefix;
  2. a prefix of the whole path;
  3. a substring anywhere;
  4. fuzzy.

  Within a rank, the default API comes before the others, then shorter paths.
- **Who filters:** the server filters and ranks itself. The list is marked `isIncomplete`, so the
  editor asks again on every keystroke, and every item's `filterText` is the typed text. Editors'
  own filters (VS Code's matches from the start of a word) would otherwise drop middle-of-path
  matches.
- **What is inserted:** the operation as written on the page (`billing:` only when needed). Path
  parameters become placeholders to fill in, because the spec's `{id}` is already valid syntax on a
  page and would read a variable `id`:
  - **Editors that support snippets** (`snippetSupport`): `GET /articles/{${1:slug}}/comments`. The
    parameter's name is selected and replaced by what you type; Tab moves to the next.
  - **Other editors:** `GET /articles/{}/comments`. An empty value is `SN327`, so nothing compiles
    until it is filled in.
  - Query parameters are not inserted. Completion inside the query offers the operation's declared
    parameters (`?` and `&` are trigger characters).

**Hover** on an operation shows:

- the absolute URL with the page's values, `GET https://api.example.com/v1/articles/{a.slug}/comments`;
- the spec's template, `/articles/{slug}/comments`;
- the API's name, the summary, the parameters (required ones marked) and the effective `items`, `key`
  and `type`, with where each comes from (spec, config, element);
- the spec or config file.

**Go to definition** on an operation opens its path in the spec, or its key in the config.

**Quick fixes:** `SN328` rewrites the attribute; `SN326` and `SN330` offer their suggestion.

### 10. Migration: `sinter migrate`

The change removes `src` from every page, so it ships with a tool that does the rewrite:

```sh
npx sinter migrate            # prints the changes
npx sinter migrate --write    # applies them
```

- **Rewrites:**
  - `src="/api/x/{y}"` becomes `operation="GET /x/{y}"`, with the API chosen by its base;
  - `data-sn-post="…"` becomes `data-sn-operation="POST …"`, and likewise for the other methods;
  - `<sn-sync src>` becomes `<sn-sync operation>`.
- **Shapes:** an element's `items`, `key` and `type` become `defaults` in the config when every page
  that uses the operation agrees on them. Where pages disagree, the attributes are left as they are,
  with a report.
- **Endpoints no API declares:** a stub is written in `operations` with `type: 'unknown'`. That is
  `SN329` until someone gives it a type, so the build lists what is missing from the spec.
- **Config:** it adds `apis` when the project has `openapi` or `origins`, and moves those keys into
  it.
- **Safety:** it is deterministic and idempotent, works through the same parser as the compiler and
  edits only attribute values, so the rest of the markup is untouched byte for byte.

The project's own pages, examples, recipes, docs and `llms.txt` are migrated with it. The examples are
the test: their builds must produce the same modules as before.

## What happens to the prototype

The `operation` + `params` commit on this branch:

- **Kept:** `operations()`, `findOperation()` and `operationUrl()` in `compiler/openapi.ts`;
  `operations.ts` in the LSP (hover, the GET filter, the spec file shown); the param checks
  (moved to the query); the tests that compare a page's module with the `src` it replaces.
- **Replaced:** the `params` attribute and its parser (values are written in the path);
  `operationId` as a reference (it becomes a search term); taking the base from `servers[0]`
  (it becomes the default of `base`).
- **Reverted:** the RealWorld `profile.html` change, migrated again with `sinter migrate`.

## Not in this proposal

- **Deriving `items` and `key` from the schema** (an object with one array property, an `id` field)
  without `defaults`. That can come later, once `defaults` shows which guesses would be right.
- **Fetching a spec from a URL.** Builds stay deterministic, so specs remain local files.
- **GraphQL** beyond a `POST` resource with a body.
- **Generating TypeScript clients** from the specs.

## Plan

1. `apis` in the config: parsing, validation (`SN329`), `base`, `origins` computed, the old keys
   mapped with a warning. Nothing on pages changes yet.
2. `operation` on resources and the implicit API; shapes from the config (§3, `SN330`); `SN326` and
   `SN327`. `src` still compiles, with `SN328` as a warning.
3. `data-sn-operation` on actions, `operation` on `<sn-sync>`; the API's name in the request layer,
   `transport` and `fieldErrors`; static request settings per API.
4. Editor: completion (ranking, server-side filtering, snippets), hover, definition, quick fixes.
5. `sinter migrate`; the examples, recipes, docs and `llms.txt` migrated.
6. `SN328` becomes an error and `src`, `data-sn-get` … `-delete` are removed. Changelog entry under
   "Removed".

Steps 2 to 5 leave `src` working, so the branch can be reviewed and tried in a real app before
step 6.

## Open questions

1. **Build once, deploy many.** `base` is read when the app builds, so staging and production need
   separate builds. Teams that promote one build through environments need the base at runtime: a
   compiled template that refers to the API by name, with `configure({ apis: { main: { base } } })`
   filling it in. That costs a lookup per request and complicates the early script and the server
   layer, which use the literal URL. Is that in scope?
2. **Server layer.** sinter-axum, Sinter.AspNetCore and `@tiaforge-ui/sinter/server` call the API
   in-process or upstream by URL. With a runtime base (question 1), they need the APIs too. The
   manifest could carry them by name.
3. **`POST` resources and `cache`.** The cache is keyed by URL. Keying by URL and body is easy, but a
   cached search result may be a privacy surprise. Allow it, or refuse `cache` on `POST`?
4. **Attribute name.** `data-sn-operation` is long on buttons. `data-sn-op` is shorter, but `op` already
   means something else on `<sn-event>` (`upsert`, `remove`). Keep the long name?
5. **The `default` API's name.** With one API it is the default whatever its name. With several, is a
   key literally named `default` the right way to pick one, or should there be `default: 'main'`?
