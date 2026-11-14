# Proposal: APIs in the config

Status: implemented (2026-11-14), steps 1 to 6 of the [Plan](#plan); the guide is [apis.md](../apis.md).
Where the implementation departs from this text:
- `SN330` is the error for a different value; restating the configured value is its own warning,
  `SN518` (`redundant-shape`), as a code's severity is fixed. `SN327` is named `undeclared-query`,
  `SN329` `api-config`.
- `SN328` is an error from the start: nothing shipped between the steps.
- `sinter migrate` does not edit the Vite config (JavaScript it cannot rewrite safely): it prints the
  `defaults` and `operations` to add, and leaves the attributes they replace, which `SN518` and its
  quick fix then remove. A same-origin path under no base is reported, not rewritten, so that a
  second run changes nothing.
- The top-level `sinter({ openapi })` keeps its old behaviour (full URLs, warnings) with the
  deprecation warning, instead of becoming an API with base `''`, which would have made every
  existing app strict at once.
- Sinter.AspNetCore does not send the static headers yet (no .NET toolchain where this was built);
  the manifest field is additive and it ignores it.
- The next-page prefetch descriptions are compiled with the APIs too (found when comparing
  RealWorld's build before and after: byte for byte the same).

Decided with the user:
- The APIs an app calls are configured in JavaScript, in `sinter({ apis })`: base URL, OpenAPI spec,
  request settings. The base is read at build time; one build serves one set of API URLs.
- `src` stays, and so do the action method attributes (`data-sn-get` … `-delete`). Their value becomes
  a path relative to an API, `[api:]/path?query`, with `{expr}` values written in place as today.
  Without `apis`, a path is a same-origin path, exactly as today.
- A configured API is strict: every request a page makes to it must be an operation its spec or its
  config declares.
- Resources load with `GET` and do not write it. A resource that loads with `POST` says so with
  `method="POST"`; it cannot have `cache`.
- Operations are found by method and path, not by `operationId` (generated ids are unstable). Ids and
  summaries are search terms for completion.
- What an endpoint returns (`items`, `total`, `key`, `type`) is said once, in the spec or the config,
  from the start. The page says how it uses the data.
- With one API configured, it is the default; with several, `defaultApi` names it.
- An operation without a type (an `operations` entry without `type`, a spec operation without a JSON
  response) is warning `SN504`, as an untyped resource is today, so configuring `apis` never breaks a
  build.
- Endpoints outside every base (`/logout`, `/config.json` next to `base: '/api'`) go to a built-in API
  `site:`, base `''` (same origin), declared like any other: `src="site:/config.json"`.
- `key` has no default. Without `key` a resource is one object, so a default `id` would turn single
  objects into collections, and every rule to tell them apart (`_id` backends, `each`, APIs without a
  spec) was an exception. Instead, a list of objects without `key` is warning `SN517` (implemented on
  this branch).
- The server layers (sinter-axum, Sinter.AspNetCore, `@tiaforge-ui/sinter/server`) need no API config:
  they keep using the literal URLs the build writes, and send the static headers the manifest lists
  ([§6](#6-request-settings)).
- The early script is extended to send requests with their API's settings, so per-API credentials and
  headers do not cost early loading.

Reviewed on 2026-11-13. The review led to keeping `src` and the action attributes instead of renaming
them, and to several corrections below (`order` stays on the element, an unset `base` is an error,
the early script's limits, streams without `type`).

## The case

In a real app, a page's requests repeat things that belong to the API, not to the page:

- **The base URL**, on every resource and action. The RealWorld example writes
  `https://api.realworld.show/api` 26 times. Pointing a build at another environment means changing
  every page.
- **The shape of a response.** `items="user"`, `key="id"` and the type are properties of the endpoint
  and are repeated on every page that loads it.
- **Request settings** (credentials, headers) differ per API. Today they are set in a middleware that
  compares URLs.

The spec is consulted only after the fact: sinter matches a `src` to an operation to find its type.
A `src` that matches nothing is a warning (`SN504`), and an unknown query parameter is a warning
(`SN505`). Nothing makes a page use the spec, so the easy path for a person or an agent is to write
any URL and skip the checks.

## Design

### 1. APIs in the config

```js
// vite.config.js
sinter({
  apis: {
    main: {
      base: process.env.API_URL,
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
    billing: {
      base: process.env.BILLING_URL,
      openapi: 'specs/billing.yml',
      defaults: { 'GET /invoices': { items: 'invoices', key: 'id' } },
    },
  },
  defaultApi: 'main',
});
```

| Key | Meaning |
| --- | --- |
| `base` | The URL every path of this API is relative to: a same-origin path (`/api`) or an `https://` origin with an optional path, no trailing `/`. Left out, it is the spec's first `servers` URL with its variables' defaults. Written but `undefined` (an unset environment variable) is an error, not a fallback to the spec's server, which is often production. |
| `openapi` | A local JSON or YAML file (or a list), as `sinter({ openapi })` today. Optional. |
| `credentials`, `headers` | Static request settings for every request to this API ([§6](#6-request-settings)). |
| `defaults` | Per operation of the spec: `items`, `total`, `key`, `type`, and `query` (extra query parameter names the spec leaves out). An operation the spec does not have is an error. |
| `operations` | Endpoints the spec does not have: the same keys. An operation the spec already has is an error (it belongs in `defaults`), so a typo cannot create an endpoint without anyone noticing. |

`defaultApi` names the API a path without `api:` goes to. With one API it can be left out.

`site` is built in: base `''`, the page's own origin. It has no spec unless given one
(`apis: { site: { openapi: 'specs/site.yml' } }`), and its endpoints are declared in `operations` like
any API's, so `src="site:/config.json"` is checked too. Its `base` cannot be changed.

`sinter({ openapi })` and `sinter({ origins })` are replaced:

- **`openapi`** moves into an API's entry. The old key stays one release, read as one API with base
  `''`, with a deprecation warning.
- **`origins`** is computed from the APIs' bases. An origin that is no API (an image host) is still
  listed in `origins`.

The config is typed (`SinterOptions['apis']`), so the editor completes the keys in `vite.config.ts`.

#### No config: the implicit API

Without `apis`, every path goes to one implicit API: same origin, base `''`, no spec. It accepts any
path and checks only what it checks today. Nothing changes for an app that does not configure `apis`:
`src="/api/contacts"` means what it means now.

### 2. Paths

```text
[api:]/path[?query]
```

```html
<sn-resource name="contact" src="/contacts/{c.id}"></sn-resource>
<sn-resource name="articles" src="/articles?tag={$url.tag}&limit={10}"></sn-resource>
<sn-resource name="invoices" src="billing:/invoices?status={tab}"></sn-resource>
<button data-sn-delete="/contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
<form data-sn-post="/signup">…</form>
```

- **`api:`** names the API. Without it, the path goes to `defaultApi`.
- **The path** is relative to the API's base and starts with `/`, as the spec writes its paths.
  Interpolation, encoding, arrays in the query and `null` leaving a query parameter out work as today.
- **The method** comes from where the path is written: `GET` for a resource (or its `method`), the
  attribute's method for an action, `GET` for `<sn-sync>`.
- **An absolute URL** (`https://…`) is an error once `apis` is set. Its origin belongs in an API's
  base.

The compiler puts the base in front and compiles the same URL template as today. Loading, request
sharing, prefetching, the early script and the server layer see the same URLs as before.

A path written with the base still in it is caught by the checks. With `base: '/api'`,
`src="/api/contacts"` becomes `/api/api/contacts`, which matches no operation. The error names
`/contacts` as the closest one.

#### How a path is matched

The rules of today's matching (`matchOperation`) apply, against the API's paths and without the server
prefix:

- A literal segment matches the same literal. A segment that is one value, `{c.id}`, matches a
  `{param}`.
- A literal path beats a templated one: `/articles/feed` is the feed, `/articles/{slug}` an article.
- Mixed segments (`/files/{id}.json`) match by their literal parts.

The build decides the operation from what is written: `/articles/{kind}` is `GET /articles/{slug}`
and typed as an article. If `kind` is `'feed'` at runtime, the request reaches the feed endpoint
anyway. The build cannot see that; the spec's literal path is the way to name the feed.

#### What a configured API checks

| Check | Diagnostic |
| --- | --- |
| No operation of the API has this method and path | `SN326` error, the closest operation as "did you mean" |
| `api:` naming no API | `SN326` error |
| A query parameter the operation does not declare (nor `query` in the config) | `SN327` error (was the `SN505` warning) |
| A required query parameter left out | `SN327` error |
| An absolute URL | `SN328` error, with the API-relative path |

Query parameters that sinter adds itself count as given: `paginate`'s `size-param`, `offset-param`,
`page-param`, `direction-param` and the cursor's fields. They are checked against the operation's
parameters too, so a typo in `size-param` is an error. A parameter declared with `style: deepObject`
accepts `name[field]`.

### 3. What an endpoint returns, said once

`items`, `total`, `key` and `type` come from the first of these that has them:

1. the operation's entry in `defaults` or `operations`;
2. the element;
3. the spec, for `type` (as today).

When the config has a value, the element may not write it (`SN330`): the same value is a warning
(redundant), a different one an error, because two pages must not read different shapes from one
endpoint. The element's `type` still overrides the spec's (an escape for a spec that is wrong), as
today.

`key` is never inferred. A list of objects without `key` is warning `SN517`: the resource is one
object holding the list, which is fine for a list that is only read, but an `upsert`, `patch` or
`remove` would act on the whole list. The build reports it from the spec; for an `operations` entry,
whose `type` is a TypeScript type, `sinter check` and the editor report it.

`order`, `each`, `paginate` and its options, `when`, `then`, `cache`, `refresh` and `early` stay on the
element. They say how this page uses the data, and two pages may differ: one list sorted by name,
another by date.

This moves the shape off the element: a page that calls `remove(c)` depends on a `key` it no longer
shows. That is a trade against "all of it visible on the element". The hover, `sinter check` and the
generated types make it visible again for people and agents, and the shape is then the same on every
page that uses the endpoint, which the element alone never guaranteed.

The RealWorld `user` resource, written today on seven pages:

```html
<!-- today -->
<sn-resource cache name="user" src="https://api.realworld.show/api/user" items="user" then="guest = !$result" early="off"></sn-resource>
<!-- with apis -->
<sn-resource cache name="user" src="/user" then="guest = !$result" early="off"></sn-resource>
```

### 4. Resources

| Attribute | Change |
| --- | --- |
| `src` | a path relative to an API ([§2](#2-paths)) |
| `method` | new, optional: `POST` for an endpoint that loads data with a request body (search, reports, GraphQL). Default `GET`. |
| `body` | new, with `method="POST"`: a value expression sent as JSON, reloaded when it changes, checked against the request schema |
| `items`, `total`, `key`, `type` | only for endpoints with no configured value ([§3](#3-what-an-endpoint-returns-said-once)) |

A `POST` resource:
- is shared by URL and body;
- cannot have `cache` (a cached search or report would outlive the request that asked for it);
- loads from the page module only. The early script, the prefetcher and the server layer's embedding
  handle `GET` requests, so a `POST` resource is not started early, prefetched or embedded.

### 5. Actions and streams

**Actions** keep their method attributes. Their value is a path as in §2, and the method comes from
the attribute: `data-sn-delete="/contacts/{c.id}"` names `DELETE /contacts/{id}`. Everything else
about actions stays: `data-sn-body` is checked against the request schema, the response types
`$result`, write-through and field errors work as today. In the implicit API an action is unchanged.

**Streams:** `<sn-sync src="/events">` is a path as in §2, the method `GET`. Specs rarely describe
event streams, so a configured API declares the stream in `operations`, without `type` (a stream has
events, not one response; `<sn-event type>` types them). The transport is still chosen by
`configure({ transport })`, which gets the resolved URL as today; there is no transport key in the
config.

### 6. Request settings

- **Static settings:** `credentials` and `headers` from an API's entry apply to every request the page
  module makes to it: resources, actions, streams (where the transport allows headers) and the
  prefetcher. They are compiled into the page's bundle, so `headers` must not hold secrets.
- **The early script** sends each resource's request with its API's `credentials` and `headers`. Today
  it sends every request with the default `Accept` and same-origin credentials, and the page module
  takes the response only when its request still looks exactly like that (`src/early.ts`, `take`).
  With per-API settings:
  - the early file gets a table of the settings of the APIs that have any; a page whose APIs use the
    defaults carries none;
  - `take` compares the page module's request with what the early script sent (method, URL,
    credentials, headers), not with fixed defaults. A middleware that adds a header (a token) still
    makes the request different, so it still gets a request of its own, as today.
- **Preload links** (`<link rel="preload" as="fetch">`) cannot carry headers. For an API with
  `credentials: 'include'` the build writes `crossorigin="use-credentials"`; for an API with `headers`
  it writes no preload link, and the early script's request is the first.
- **The server layers** fetch the data they write into the page themselves. The manifest lists each
  request's static headers, and sinter-axum, Sinter.AspNetCore and `@tiaforge-ui/sinter/server` send
  them, so an API that needs one (a version header) answers them as it answers the browser.
- **Dynamic settings** (a token) stay in the request layer. To tell APIs apart without comparing URLs,
  a middleware calls `apiOf(request.url)`, which looks the URL up in a table of the page's API bases.
  The table is written once per page, so request definitions carry no extra strings.

### 7. Diagnostics

The prototype's codes are not released, so they are reused with their new meaning:

| Code | Name | Severity | Reported for |
| --- | --- | --- | --- |
| `SN326` | `unknown-operation` | error | a path no operation of the API matches with this method, or an `api:` naming no API; with "did you mean" |
| `SN327` | `undeclared-query` | error | a query parameter the operation does not declare, a required one left out |
| `SN328` | `absolute-url` | error | an `https://` URL in `src` or an action when `apis` is set, with the API-relative path and a quick fix |
| `SN329` | `endpoint-config` | error | `defaults` naming an operation the spec lacks, `operations` naming one it has, an invalid or `undefined` `base`, `defaultApi` naming no API |
| `SN330` | `configured-shape` | warning / error | the element restating a configured `items`, `total`, `key` or `type` (warning if equal, error if different) |
| `SN517` | `unkeyed-list` | warning | a list of objects without `key` (implemented) |

`SN505` is retired (now `SN327`). `SN504` remains for the implicit API, and for a configured operation
that has no type.

`SN207` is unchanged: a value can never choose the host. A path starts with a literal `/`, and the base
is a literal from the config.

### 8. Editor

**Completion** inside `src="…"` of `<sn-resource>` and `<sn-sync>`, and inside an action's method
attribute:

- **Candidates:** the operations of every API with the method the place implies: `GET` (or the
  resource's `method`) for a resource, the attribute's method for an action, stream operations for
  `<sn-sync>`. In the implicit API there is nothing to offer.
- **What a candidate matches:** its path, its `operationId`, its summary and its API's name. Typing
  `comments` finds `/articles/{slug}/comments`, `inv` finds `billing:/invoices`, `GetArt` finds
  `/articles` by its id.
- **Ranking:**
  1. `operationId` or path-segment prefix;
  2. a prefix of the whole path;
  3. a substring anywhere;
  4. fuzzy.

  Within a rank, the default API comes before the others, then shorter paths.
- **Who filters:** the server filters and ranks. The list is marked `isIncomplete`, so the editor asks
  again on every keystroke, and every item's `filterText` is the typed text; editors' own filters
  (VS Code's matches from the start of a word) would otherwise drop middle-of-path matches.
- **What is inserted:** the path, with `api:` only when it is not the default API. Path parameters
  become placeholders, because the spec's `{id}` is valid syntax on a page and would read a variable
  `id`:
  - **Editors that support snippets** (`snippetSupport`): `/articles/{${1:slug}}/comments`. The
    parameter's name is selected and replaced by what you type; Tab moves to the next.
  - **Other editors:** `/articles/{}/comments`. An empty value is an error, so nothing compiles until
    it is filled in.
  - Query parameters are not inserted. Completion after `?` and `&` offers the operation's declared
    parameters.

**Hover** on a path shows:

- the method and the absolute URL with the page's values, `GET https://api.example.com/v1/articles/{a.slug}/comments`;
- the spec's template, `/articles/{slug}/comments`;
- the API's name, the summary, the parameters (required ones marked) and the effective `items`, `key`
  and `type`, with where each comes from (spec, config, element);
- the spec or config file.

**Go to definition** on a path opens the operation in the spec, or its key in the config.

**Quick fixes:** `SN328` rewrites the URL to the API-relative path; `SN326` and `SN330` apply their
suggestion.

### 9. Migration: `sinter migrate`

Only an app that configures `apis` has anything to migrate:

```sh
npx sinter migrate            # prints the changes
npx sinter migrate --write    # applies them
```

- **Paths:** every `src` and action URL that starts with an API's base becomes the path relative to
  it, with `api:` when it is not the default API.
- **Shapes:** an element's `items`, `total`, `key` and `type` move to `defaults` when every page that
  uses the operation agrees on them. Where pages disagree, the attributes stay, with a report.
- **Endpoints no API declares:** an entry is written in `operations` for each, so the build lists what
  is missing from the spec.
- **Config:** `openapi` and `origins` move into `apis`.
- **Safety:** deterministic and idempotent. It uses the compiler's parser and edits only attribute
  values, so the rest of the markup is untouched byte for byte.

The examples are migrated with it, and their builds must produce the same page modules as before.
Docs, recipes and `llms.txt` keep their same-origin `src` examples, which stay valid, and gain a
section on `apis`.

## What happens to the prototype

The `operation` + `params` commit on this branch is reverted:

- **Reused:** `operations()` and `operationUrl()` in `compiler/openapi.ts`, the hover and completion
  module `lsp/operations.ts`, the query parameter checks, and the tests that compare a page's module
  with the URL it replaces.
- **Dropped:** the `operation` and `params` attributes, `operationId` as a reference, the base taken
  from `servers[0]` (now the default of `base`), and the RealWorld `profile.html` change.

## Not in this proposal

- **A base chosen at runtime** (one build promoted through environments).
- **Deriving `items` from the schema** (an object with one array property) without `defaults`. That
  can come later, once `defaults` shows which guesses would be right.
- **A default `key`** (see the decisions above).
- **Fetching a spec from a URL.** Builds stay deterministic, so specs are local files.
- **Generating TypeScript clients** from the specs.

## Plan

1. `apis` in the config: parsing, validation (`SN329`), `base`, `defaultApi`, `origins` computed, the
   old keys mapped with a warning. Nothing on pages changes yet.
2. Paths relative to an API in `src`, actions and `<sn-sync>`; the checks of a configured API
   (`SN326`, `SN327`, `SN328`); shapes from the config (§3, `SN330`). `SN328` is a warning in this
   step.
3. `method` and `body` on resources; static request settings per API, in the page module, the early
   script (`take` compares with what was sent), preload links and the server layers' manifest; `apiOf`.
4. Editor: completion (ranking, server-side filtering, snippets), hover, definition, quick fixes.
5. `sinter migrate`; the examples migrated; docs and `llms.txt`.
6. `SN328` becomes an error. Changelog entries.

Apps without `apis` are unaffected at every step.
