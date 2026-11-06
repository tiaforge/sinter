# Changelog

Attribute names, function names and diagnostic codes are public API. Before
1.0, renames are allowed but listed here.

## Unreleased

- Writes to an ordered resource patch its sorted list instead of re-sorting it:
  one upsert into 5,000 items takes 0.007 ms instead of 10 ms. Ties in `order`
  keep arrival order, as before.
- `$meta.<name>.total` updates when the total or an optimistic removal changes
  it; before, it updated only when something on the page read the list.
- Resource lists are frozen in dev builds only, like their items (`SN205`
  refuses writes at build time). In production, code outside expressions that
  mutates `app.resource(name).all()` corrupts the store; copy it first.
- `npm run size` budgets pages (minimal page, RealWorld article) instead of the
  core; `npm run bench` times the store and the flush.

- Local actions: `data-sn-call="ns.fn(args)"` calls a function from the actions
  module (`src/sinter.actions.js` or `.ts`) with the lifecycle of an action
  (busy, concurrency, optimistic layers, `then`/`catch`), and
  `<sn-resource call="…">` loads a resource from one, latest wins. Functions get
  a trailing context `{signal, request, el}`. New code `SN310 unknown-action`.
- `$error.status` (and `SinterError.status`) is `null` for a failed action call;
  its type is now `number | null`.
- `data-sn-debounce` on an element without a method delays its
  `data-sn-on-*` handlers: `<input data-sn-model="q" data-sn-on-input="query = q"
  data-sn-debounce="250">` updates `q` at once and `query` once typing pauses.
- `<sn-event>` expressions can read the state declared around their
  `<sn-sync>` (`when="mailbox === sel.mailbox"`); before, those names silently
  meant payload fields. A state name shadows a payload field of the same name,
  a `sinter check` error when the payload is typed. `<sn-sync src>` is also
  evaluated in that state's scope now.
- Pagination cursor fields that are `null` or `undefined` are left out of the
  request instead of being sent empty, like URL template query parameters.
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

- A TypeScript helpers module (`src/sinter.helpers.ts`) works: its export
  names are read with TypeScript syntax, type-only exports are not helpers,
  and `sinter check` accepts `.ts` import paths. Before, any type annotation
  in it failed every page's build with an acorn parse error.
- Helper and namespace modules may re-export with `export * from './x.js'`;
  the members are followed (relative paths only). Paraglide 2's message index
  is built this way, so `export * as m from './paraglide/messages.js'` found
  no messages (`SN206` on every `m.…()` call).

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
