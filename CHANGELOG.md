# Changelog

Attribute names, function names and diagnostic codes are public API. Before
1.0, renames are allowed but listed here.

## Unreleased

### Changed

- Size budgets: the minimal page may be 15 KB gzip (was 11.5 KB; 0.3.0 shipped at 12.1 KB) and the
  RealWorld article page 20 KB (was 16.5 KB, with 24 B to spare). CI now runs `npm run size -- --check`,
  so an overrun fails the build.

### Fixed

- `app.state(el).update()` now reaches bindings inside `data-sn-for` rows: an island that changes a
  row's field or a nested list in place re-renders those rows. Before, only bindings outside the
  rows updated.
- Assigning `$locale` re-sorts resources with `order` by the new locale's collation. The store's
  cached view was never dropped for a locale change.
- A resource whose `when` turned false no longer overwrites its page-load cache entry with an
  empty list on pagehide.
- The 64 KiB `keepalive` limit is measured in UTF-8 bytes. A mutation body of 22,000 to 60,000
  non-ASCII characters was sent with `keepalive` and refused by the browser.
- A resource cannot take a store function's name (`remove`, `patch`, …): new `SN209` case. Such a
  page compiled, but `sinter check` failed with an internal error on it.
- `validateIR` accepts pages with `data-sn-call` and `<sn-resource call>`.
- A URL with a second `?` in its query keeps it when pagination parameters are added.
- A form with a scalar control and a nested one under the same name (`a`, `a.b`) serializes
  (the later control wins) instead of throwing.
- An app destroyed before its `<sn-sync>` streams connected opens none; a cleanup added after
  `destroy()` runs at once.
- A debounced `data-sn-on-*` handler does not run when its element left the page meanwhile.
- Keyset pagination: an empty `next` page reports `from` and `to` as 0 instead of 1 and 0. Offset
  pagination: `page(name, 'prev')` on page 1 and `page(name, 'next')` on the last known page send
  no request.
- `bytes('')` returns an empty string, like `number('')`.
- The compiler closes three lint gaps: a literal origin followed by a value needs its `/`
  (`https://api.example.com{x}` let the value extend the host; the runtime's origin check still
  refused the request), `Object.assign()` and `Object.defineProperty()` on a resource item are
  `SN205` (on state, a write, or `SN203` in a value expression), and `constructor`, `__proto__`
  and `prototype` named literally as `Object.*` arguments are `SN207`.

## 0.3.0 (2026-11-07)

### New

- `sinter check` types `data-sn-attr` values: a global `SinterAttributes` interface (empty by
  default) lists attribute value types, and a library extends it. With tinystyle,
  `import type {} from '@tiaforge-ui/tinystyle/sinter'` in the types module makes
  `{'data-tone': bad ? 'danger' : 'sucess'}` a type error. Keys it does not list are unchecked,
  as before. The types module is now always part of the check, so its `declare global`
  augmentations apply.
- `showModal('id')` opens `<dialog id="id">` as a modal from a handler, for
  example after a request (`data-sn-then="…; showModal('detail')"`) or from a
  custom event. `close('id')` closes a dialog by id; `close()` still closes
  the nearest one. The id must be a string literal naming a `<dialog>` on the
  page or its partials: new diagnostic `SN309 unknown-dialog`.
- `data-sn-let="{ hits: suggestions(q), n: hits.length }"`: derived names for an element
  and its subtree, compiled into the expressions that read them (no runtime cost). Read-only;
  new diagnostic `SN209 name-conflict` when one shares a name with state or a loop variable.
- `data-sn-confirm="question"` asks before an action runs (nothing when the value is falsy);
  `configure({ confirm })` replaces `window.confirm`.
- `data-sn-encoding="form"` sends a form or `data-sn-body` as
  `application/x-www-form-urlencoded` (arrays as repeated keys); `ctx.request` accepts a
  `URLSearchParams` body.
- `data-sn-listbox="list-id"` on a text input: the combobox keys for a suggestion list (arrows
  mark an option, Enter/Tab pick it, Escape fires `dismiss`), in the new `listbox` module.
- `$error.detail`: the server's message or a thrown error's, `null` when there is none.
- `data-sn-debounce-<event>="ms"` delays only that event's handler, e.g. a debounced
  `data-sn-on-input` next to an immediate `data-sn-on-blur`; it overrides `data-sn-debounce`
  for that handler, `0` makes it immediate.

## 0.2.0 (2026-11-06)

### Faster

Compared with 0.1.0 in Chrome 156, production builds:

- Writes to an ordered resource patch its sorted list instead of re-sorting
  it. Into 5,000 items, one upsert, patch or remove takes 0.005 ms instead of
  10 ms, a burst of 50 upserts 0.19 ms instead of 7.2 ms. A server event
  landing in a rendered sorted list flushes in 0.14 ms instead of 1.35 ms at
  1,000 rows, 0.7 ms instead of 11.2 ms at 5,000. Ties in `order` keep arrival
  order, as before; `replace` costs the same.
- A flush is about 2.5× cheaper per root binding: only bindings inside a
  `<dialog>` check for a closed one, and each binding keeps its parsed
  dependencies. One state change on a page with 4,000 root bindings: 0.18 ms
  instead of 0.44 ms.
- Identical expressions share one function in the compiled page module (the
  RealWorld article page has 60 instead of 112).

Row rendering (js-framework-benchmark) and mount time are unchanged. Pages are
0.6–0.8 KB gzip larger than with 0.1, mostly for the features below.

### New

- Local actions: `data-sn-call="ns.fn(args)"` calls a function from the actions
  module (`src/sinter.actions.js` or `.ts`) with the lifecycle of an action
  (busy, concurrency, optimistic layers, `then`/`catch`), and
  `<sn-resource call="…">` loads a resource from one, latest wins. Functions get
  a trailing context `{signal, request, el}`. New code `SN310 unknown-action`.
- `each="a in accounts"` on `<sn-resource>`: one request per list item, merged
  into one collection. A changed list loads only new sources and drops removed
  ones; a `refetch` event reloads only the source its payload names.
- `offset-param` on a keyset `<sn-resource>`: when the server also accepts an
  offset, `page(name, n)` jumps with it and `prev`/`next` continue by cursor;
  `$meta.<name>.page` is available. Without it, `SN304` now suggests it.
- `direction-values` on a keyset or append `<sn-resource>` maps sinter's
  directions to the values a server expects, e.g.
  `{first: 'forward', prev: 'backward', next: 'forward'}`. Directions not
  listed are sent by name, as before.
- `data-sn-debounce` on an element without a method delays its
  `data-sn-on-*` handlers: `<input data-sn-model="q" data-sn-on-input="query = q"
  data-sn-debounce="250">` updates `q` at once and `query` once typing pauses.
- `<sn-event>` expressions can read the state declared around their
  `<sn-sync>` (`when="mailbox === sel.mailbox"`), and `<sn-sync src>` is
  evaluated in that state's scope.
- A TypeScript helpers module (`src/sinter.helpers.ts`): export names are read
  with TypeScript syntax, type-only exports are not helpers, and
  `sinter check` accepts `.ts` import paths. Before, any type annotation in it
  failed every page's build with an acorn parse error.
- Helper and namespace modules may re-export with `export * from './x.js'`
  (relative paths only). Paraglide 2's message index is built this way, so
  `export * as m from './paraglide/messages.js'` used to find no messages
  (`SN206` on every `m.…()` call).

### Changed

- `<sn-event>`: a name declared by the surrounding state now shadows a payload
  field of the same name (before, it silently meant the payload field); a
  `sinter check` error when the payload is typed.
- `$error.status` (and `SinterError.status`) is `null` for a failed action
  call; its type is now `number | null`.
- Pagination cursor fields that are `null` or `undefined` are left out of the
  request instead of being sent empty, like URL template query parameters.
- `$meta.<name>.total` updates when the total or an optimistic removal changes
  it; before, it updated only when something on the page read the list.
- Resource lists are frozen in dev builds only, like their items (`SN205`
  refuses writes at build time). In production, code outside expressions that
  mutates `app.resource(name).all()` corrupts the store; copy it first.

## 0.1.0 (2026-11-05)

First implementation of the v0.1 spec: compiler, runtime, `sse`,
`optimistic`, `paginate`, `persist`, Vite plugin and testing module.

- `configure({ transport })` picks the `<sn-sync>` transport per stream URL;
  `@tiaforge-ui/sinter/ws` adds a WebSocket transport, and `llms.txt` has a
  SignalR recipe.
- `Transport.connect`'s `onEvent` now receives the parsed payload
  (`unknown`) instead of the raw string.
- `sinter check` type-checks expressions with the project's TypeScript:
  `type` on `<sn-resource>` and `<sn-event>`, OpenAPI specs
  (`sinter({ openapi })`), `sinter({ typecheck: true })` for `vite build`,
  `checkPage()` in `@tiaforge-ui/sinter/check`. New codes: `SN208`, `SN307`,
  `SN308`, `SN504`, `SN505`, `SN506`.
- `sinter lsp`: a language server with diagnostics as you type, type errors,
  hover, completion, go to definition and a did-you-mean quick fix; a VS Code
  extension in `editors/vscode`; setup for other editors in `docs/editors.md`.
- `Diagnostic` has an optional `span` (what an editor underlines).
- Diagnostics link to `docs/diagnostics.md`, generated from the compiler.
- The core's size budget is 11 KB min+gzip (was 5 KB, never met).
- `cache` on `<sn-resource>`: the page-load cache (sessionStorage, revalidated
  on every load, cleared on 401 and by `clearPersisted()`); the
  `@tiaforge-ui/sinter/cache` feature module.
- Dev builds warn when a stream is served over HTTP/1.1.
- Testing: `render({ session, storage })` and `memoryStorage()`.
