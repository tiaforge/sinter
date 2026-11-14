# Proposal: bindable URL parameters and pagination in the URL

Status: implemented (2026-11-13), steps 1 to 5 of the [Plan](#plan); the guides are
[navigation.md](../navigation.md#the-url-and-the-history) and [pagination.md](../pagination.md#page-in-the-url).
Where the implementation departs from this text:
- A third server layer, `@tiaforge-ui/sinter/server` (merged from main meanwhile), reads array
  parameters and manifest version 2 like sinter-axum and Sinter.AspNetCore. All three now drop
  `__proto__`, `constructor` and `prototype` from URL parameters, as the browser does.
- A number or range model pushes once per burst of steps (spinner clicks, arrow keys: each a
  `change`), at the typing pause, not once per step.
- A `data-sn-on-input` handler on a checkbox, radio or select itself is a choice, a push, decided
  at build time; a handler higher up that hears `input` replaces.
- The typing pause, a number field's burst and the `change` listener are their own module
  (`@tiaforge-ui/sinter/typing`), loaded only by pages with a text, number or range model on
  `$url`; `location.ts` keeps the writes. Array reading is `runtime/lists.ts`, so an app's shared
  chunk carries it only when a page has array parameters.
- The compiler sends writes to an array parameter to `$l`, others to `$u`; a list written to a
  one-value parameter it cannot see keeps its last item, as a reload reads it.
- An object, function or instance written to `$url` is `SN212`; at run time it deletes the
  parameter with a dev warning. The list errors are `SN210` (bound as a list and as one value, or a
  list literal written to one value) and `SN211` (a bare list in a condition).
- `page-model` on an array parameter is `SN203`; the resource's own `src` or `when` reading its
  parameter is `SN401`.
- After a failed load, `page()` to the same page reloads it; a handler writing the same value
  changes nothing.
- A debounced handler, and an action's `then`/`catch`, keep the context of the event that started
  them; a form submitted by `run()` is not the user's (the browser trusts its `submit`).
- RealWorld's "Loading articles..." line shows only while there is nothing to show (one of the
  e2e suite's failures).

Decided with the user:
- `$url` parameters are bindable like state: `data-sn-model="$url.q"`.
- History behaves as a user expects from an SPA: Back steps through pages and filters, and a typed
  search is one entry. No attribute overrides the rule.
- Typing to the URL waits for the pause resources already use (250 ms). There is no
  `data-sn-debounce` on models and no custom pause.
- Array parameters are repeated keys, typed at build time. The server packages are released in sync,
  so changing their public URL functions is acceptable.
- Pagination in the URL is opt-in, with one attribute, `page-model`, on offset lists only.
  `start-page` is removed; the start page of keyset lists with `offset-param` is an accepted loss.
- Cursor-based lists (plain keyset, append) are not synced.
- Lists bound to the same parameter page together; no diagnostic.

## Goals

1. **Bindable `$url`.** `data-sn-model="$url.q"` works like a model on state.
2. **Debounced URL writes.** Typing into a URL-bound field writes the URL (and refetches) once per
   pause, not once per keystroke.
3. **Navigation.** Back and Forward restore what the user saw: field values, filters, the page of a
   list.
4. **Restoring a page.** A reload or a shared link shows the same state, in the first frame where
   the data allows (early file, embedded data).
5. **Easy pagination.** A list's page lives in the URL with one attribute, read at load and written
   back on every move.

Constraints: one way to do each thing (spec, Design principles), a small vocabulary, decisions at build
time, feature modules loaded only by pages that use them, and first-paint parity between the
runtime, the early file and the server packages.

## The case

A search page with filters and a paginated list is the common shape: RealWorld's home (tag, feed,
page), a mail folder, an admin table. Today:

- `$url.x = …` in a handler writes the URL with `replaceState` (`src/location.ts`), once per handler
  run, never adding a history entry; Back leaves the page.
- `data-sn-model` refuses `$url` (SN203: "takes a state path"), so a search field bound to the URL
  needs a handler and loses the model's first-frame fill and its typing pause.
- `start-page="$url.page"` reads the page once; `page()` never writes it back, so a list moved with
  buttons shows page 5 under `?page=3`, and reload, Back and shared links land on the wrong page.

## What sinter has to build on

- `$url` writes are already validated (`expr.ts`: path parameters are read-only, only
  `$url.<param>` can be assigned) and already enable the `location` feature.
- `$url` and models are already early-eligible: a `$url` model's control is filled in the first
  frame.
- Model keystrokes already mark changes as typing; a resource whose `src` changes only by typing
  waits 250 ms (`TYPING`, `runtime/app.ts`).
- `popstate` already re-reads `$url` and marks it.
- `start-page` as one plain `$url.<name>` read is already understood by the compiler (`URL_READ`),
  the early file and the manifest (`start`), so the first page is in the early request and the
  embedded data.
- `afterFlush` hooks (as `persist.ts` uses) run once per flush pass, after the render.

## Design

### 1. `$url` as a model target

```html
<input type="search" data-sn-model="$url.q">
<select data-sn-model="$url.sort">…</select>
<select multiple data-sn-model="$url.tag">…</select>
```

- `data-sn-model` (and a component's `data-sn-model`) accepts `$url.<param>` besides state paths.
  The SN203 texts become "takes a state path or a URL parameter such as `q` or `$url.q`".
- The setter of a `$url` model goes through the handler analysis, as a component model's does, so
  the existing assignment checks apply: a path parameter or `$url.a.b` is SN203.
- `$url` model with `data-sn-persist`: SN102, "the URL already keeps this value".
- Path parameters stay read-only: changing one is a link to another page.
- A number or range model on `$url` compares numerically, so `1.0` stays as typed although `$url`
  holds strings.

### 2. Values

- The compiled assignment to `$url.<name>` normalizes: strings stay; numbers are written as their
  string (`0` → `'0'`); `true` → `'1'`; `false`, `null`, `undefined`, `''` and `[]` delete the
  parameter; arrays become string arrays. So `$url` in memory equals what a reload reads, and a
  handler reading back its own write sees the string.
- Reads are plain JS truthiness, which the server's conditions match (`'0'` is non-empty, truthy).
- Arithmetic needs `+$url.page`; documented.

### 3. History

| Write | History |
| --- | --- |
| a handler run inside a trusted DOM event (a click, a select's `change`), and what it causes synchronously (`emit`, an action started by it, that action's `then`/`catch`) | push |
| a select, radio or checkbox model; a component model | push |
| `page()` | push |
| a text-field model (`input`): typing | at each pause; the first commit of a run pushes, later ones replace |
| a handler on `input` in a text field | replace, at once (as today) |
| resource and stream `then`, `sn-error` handlers, anything without a user event | replace |
| the pager's reset after a `src` change | replace (folds into a pending typing commit) |
| Back, Forward | never writes |

- A typing run ends at a push, at `change` on the field (Enter, or leaving it, which a click on a
  link does before navigating) and at popstate. `change` on a text-field `$url` model commits the
  pending write at once; the runtime already listens for `change` on every model.
- So typing "foo", Enter, then "bar" gives two entries; typing slowly, pausing between words, one.
- "Typing" keeps its documented definition (`input` of a text field with `data-sn-model`); to bind a
  field to the URL, use a model.

| You do | URL | Back |
| --- | --- | --- |
| type "sinter" | `?q=sinter` | before the search |
| pick a tag | `?q=sinter&tag=go` | before the tag |
| page › twice | `…&page=3` | page 2 |
| change the tag on page 3 | `…&tag=js`, `page` removed | page 3 with the old tag |
| open a result, Back | | the same results (usually from the bfcache) |

### 4. The write layer (`location.ts`)

- The kind is decided where the write happens, not guessed afterwards: `push`, `typing` or
  `replace`. The trusted-event context is set in the event dispatch, so `handle()` runs for
  `then`/`catch`, `sn-error` and custom events get it only when a user event caused them. The
  testing environment marks its simulated events as user events.
- Per flush pass the strongest kind wins (`push` > `typing` > `replace`); one `afterFlush` hook
  serializes and writes. A later pass of the same flush writes nothing new (the no-op rule) or
  replaces.
- Typing commits after one `TYPING` timer, counted as busy (so the testing module's `settle` waits).
  The loader and `location.ts` share a small core helper for "a timer counted as busy".
- Popstate re-reads `$url`, cancels a pending commit, ends the run, and never writes (re-serializing
  could differ from the address bar: unsafe names are dropped on read).
- No-op rule: a write whose query equals the current one does nothing.
- Serialization starts from the current `URLSearchParams` and sets or deletes the changed names:
  parameter order is kept. Path parameters never go to the query.
- History calls are wrapped (Safari throws when called too often); a dev warning, `$url` in memory
  kept.
- `Env` gains `pushState`; the testing environment gets a history stack (a push truncates forward
  entries; `back()` and `forward()` fire popstate, never across a `navigate`).
- Every `$url` write site enables the `location` feature explicitly; the JSON regex in the compiler
  goes.

### 5. Array parameters

- A `$url` parameter bound to `<select multiple>`, or to a checkbox with a `value` attribute, is an
  array; the IR lists them (`urlArrays`). This is decided at build time, unlike a state checkbox,
  which decides from its current value at run time; documented.
- An array parameter always reads as an array (absent: `[]`), written as repeated keys
  (`?tag=a&tag=b`). Others read the last value, as today.
- Errors (new codes): the same parameter bound as array and as scalar; a bare array parameter in a
  condition ("`$url.tag` is a list and always truthy; use `$url.tag.length`"); an array written to a
  scalar parameter where visible. A single value written to an array parameter is wrapped.
- Readers: the runtime, the early file, next-page prefetch (with the target page's list), the
  testing module.
- Server packages: `url_params` (sinter-axum, public, breaking) and `SinterUrl` return lists for array
  parameters; templates expand lists as repeated keys. A `when` reading an array parameter is not
  server-evaluable (the browser requests it). The manifest goes to version 2, which older packages
  refuse rather than embed the wrong data.

### 6. `page-model`

```html
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" items="articles" total="count"
  paginate="offset" page-size="10" offset-param="offset" page-model="$url.page"></sn-resource>

<button data-sn-on-click="page('articles', 'next')" data-sn-attr="{disabled: !$meta.articles.hasNext}">›</button>
<span data-sn-text="`${$meta.articles.from}–${$meta.articles.to} of ${$meta.articles.total}`"></span>
```

- On `paginate="offset"` only: there every move has a number when it is made, so the URL can be the
  single source. Keyset page numbers are often unknown; plain keyset and append move by cursor.
  Elsewhere SN401 with the reason; `page-model` joins the attributes that need `paginate`.
- The value is `$url.<query param>`. A path parameter, state or an expression is SN203: "`page-model`
  takes a URL parameter such as `$url.page`". (The syntax leaves room for state paths later.)
- The resource's own `src` or `when` reading the same parameter is an error: each page write would
  reset the list.
- The URL is the single source:
  - the pager keeps `requested`, the page of its last request; its request, refetches (`refresh`,
    `pageshow`, `online`) and retries are built from the parameter (`pageParams(toPage(…))`).
  - `page()` does not load: it computes the target and writes it (page 1 deletes the parameter), a
    push. `next`/`prev` count from `requested`, or from the shown page after a failed load; a target
    past `pages` is clamped when the total is known; with an unknown total, `next` is ignored while a
    page is loading; `prev`/`next` past the ends do nothing, as today. Writing the page already
    requested reloads it when the last load failed. On a resource whose `when` is false, `page()`
    does nothing.
  - the pager follows the parameter (it is among the resource's dependencies, as `start-page`'s
    were): it loads `toPage(param)` when that differs from `requested`, so a typed page field gets
    the pause and the pager's own write is no echo.
  - the first URL a resource gets after mount (at mount, or when a late `when` turns true, as
    RealWorld's `feed` waits for `user`) reads the parameter and never writes: `?page=3` restores.
    No clamp, no correction: `?page=abc` reads as page 1, as today.
  - a change caused by popstate never resets: it loads the parameter's page.
  - any other later change of the resource's URL (a `src` change, a later `when` turning true)
    resets to page 1 and deletes the parameter, a replace: changing a filter on page 3 starts at
    page 1, and Back restores page 3.
  - `when` turning false never writes.
- `$url.page` is the page asked for (it changes at once), `$meta.<name>.page` the page shown (it
  changes when the response arrives and stays after a failure). Highlight the active page with
  `$url.page`; show the range from `$meta`.
- Lists bound to the same parameter page together, and reset together; documented.
- The early file, preloads and embedded data are unchanged: `page-model` is read where
  `start-page` was.

### 7. `start-page` removed

- One SN401: "`start-page` is renamed to `page-model` (offset lists, a query parameter), which also
  writes the page back". Optional LSP quick fix.
- Lost: a start page from a path segment (`/blog/page/3`, a static-site convention sinter does not
  need: the data comes from the API or is embedded, and `?page=2` is crawlable), from an arbitrary
  expression, and for keyset lists with `offset-param` (shipped in 0.13.0); those lists start at
  page 1.

## Breaking changes

- `start-page` → `page-model`, offset lists only.
- `$url.x = …` from a user event now pushes a history entry (was `replaceState`).
- `false` written to `$url` deletes the parameter (was written as `false`).
- sinter-axum's `url_params` and Sinter.AspNetCore's `SinterUrl` return lists for array parameters;
  manifest version 2.

## Not in this proposal

- URL sync for keyset and append pagination (cursor positions in the URL).
- State paths in `page-model`.
- A custom typing pause.
- Writable path parameters.

## Plan

One commit each, on one branch:

1. **URL write layer:** compiled normalization, kinds at the write sites (trusted-event context in
   the dispatch), per-pass write, typing commits and `change` ending a run, popstate rules,
   `Env.pushState`, the testing history stack, the busy-timer helper.
2. **`$url` models** in the compiler (setter through the handler analysis, explicit feature,
   numeric comparison for number models).
3. **Array parameters**, including both server packages and manifest v2.
4. **`page-model`:** compiler, IR, pager; the `start-page` error in the same commit (the manifest's
   `start` field keeps its shape, so the servers keep working; their comments and READMEs follow).
5. **Docs and examples:** spec, attributes, pagination ("Page in the URL"), navigation (the history
   table), resources, diagnostics, testing, security (URL values reach models and `page-model`),
   llms.txt, CHANGELOG; RealWorld moves to `page-model`; recipes for pagination, search and a
   multi-select filter; a Playwright test (type, page, filter, Back, Forward, reload, shared link,
   history length); the optional quick fix.

Tests per step: compiler diagnostics; runtime kinds at each write site (including `sn-error` at mount
and `run()` from a `then`), typing runs, popstate, the no-op rule, order, arrays; the pager (`page()`
writes without loading, follows the parameter, fast double `next`, retry after a failure, late
`when` restoring, popstate never resetting, a filter change resetting, shared parameters); early file
and embed parity; `cargo test` and `dotnet test` for arrays and manifest v2; the bench for the early
file, the runtime and `location.ts`.
