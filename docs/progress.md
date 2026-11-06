# sinter v0.1 — implementation progress

Spec: [spec.md](spec.md) (snapshot of the shared doc). This file tracks what is
built, what deviates, and what is left.

## Layout

| Path | Contents |
| --- | --- |
| `src/ir.ts` | IR v1 types shared by compiler and runtime |
| `src/compiler/` | `compile()`: HTML rewrite, includes, expression checking and codegen, helper manifest |
| `src/runtime/` | store, scheduler, renderer, actions, request layer, config, helpers, security checks |
| `src/sse.ts`, `src/optimistic.ts`, `src/paginate.ts`, `src/persist.ts`, `src/cache.ts` | feature modules |
| `src/ws.ts` | WebSocket transport (imported by the app's config module, not a feature) |
| `src/vite.ts` | Vite adapter |
| `src/project.ts` | the app's helpers, config and types modules, found the same way by the plugin and the CLI; pages from the Vite config |
| `src/check/`, `src/cli.ts` | `sinter check`: shadow files, `tsc`, error mapping |
| `src/lsp/` | `sinter lsp`: JSON-RPC, the workspace of projects and open buffers, the TypeScript bridge, quick fixes |
| `editors/vscode/` | the VS Code extension: starts the project's `sinter lsp` |
| `src/compiler/diagnostic-docs.ts` | example, meaning and fix per code; `docs/diagnostics.md` is generated from it |
| `src/testing/` | `render`, `mockRequests`, `mockStream` |
| `src/compiler/vocabulary.ts` | the attribute/element table; compiler, `llms.txt` and custom data derive from it |
| `test/` | Vitest suites (happy-dom); `test/compiler/golden/__out__` are file snapshots |
| `docs/recipes/` | the nine `llms.txt` recipes, each with its executed test |
| `scripts/size.mjs` | min+gzip per module (`npm run size`) |

## Milestones

- [x] M0 scaffold: package, tsconfig, test runner
- [x] M1 compiler: HTML parse/rewrite, `<sn-include>`, attribute vocabulary, diagnostics
- [x] M2 expressions: parse, scope resolution, sandbox rules, dirty-path analysis, codegen
- [x] M3 runtime core: store, scheduler, bindings, keyed lists (LIS moves), if/else, model, events, closed dialogs
- [x] M4 request layer + actions: middleware, bodies, concurrency, then/catch, unhandled errors, 401
- [x] M5 SSE sync module: change messages, session probe, backoff, missed-event refetch, bfcache
- [x] M6 optimistic layers (actions and `app.optimistic()`)
- [x] M7 pagination: keyset, offset, append
- [x] M8 persist, `$url`, `$now`, `$locale`, helpers and namespaces
- [x] M9 testing module
- [x] M10 Vite plugin (transformIndexHtml, virtual page module, root-confined partials, full reload on change)
- [x] M11 diagnostics fixture per code, golden outputs + IR schema check, property-based tests,
      security corpus (URLs, CSS, injection, clobbering, pollution, origins), recipes with tests,
      generated `llms.txt` and `html-custom-data.json`
- [ ] M12 size budget: measured, not met (see below)
- [ ] M13 real-browser suite (Playwright on Chromium, Firefox, WebKit; Trusted Types + strict CSP run)
      (started: `e2e/transports` runs `<sn-sync>` over SSE, WebSocket and SignalR against real
      servers in headless Chrome)

## How it fits together

- The compiler resolves every identifier statically and emits one function per
  expression taking a scope object `$`: loop variables are `$.c`, state is
  `$.$s<n>.q`, resources `$.$r.contacts`, magic names `$.$url` etc., store
  functions `$.$f.patch`. Scopes are prototype chains (page → state → row).
- Dependency and write paths are strings like `$s0.draft.emails.{i}.value`;
  `{name}` is filled from the row scope at runtime, `*` matches any segment.
  A binding re-runs when one of its paths and a dirty path are prefixes of each
  other. Row-local reads (loop items) re-run only when the item is replaced.
- Resources hold base + optimistic layers; server events and `then` writes go
  to the base; an optimistic action records ops into a layer, dropped on settle.

## Log

- 2026-11-04: spec imported, plan written.
- 2026-11-04: compiler, runtime, feature modules and testing module in; the
  spec's test example passes. 38 behaviour tests (rendering, models, lists,
  actions, errors, 401, SSE, optimistic overlaps, pagination).
- Runtime rewritten as closures (private state minifies to short names);
  dev warnings, freezing and the outside-write detector moved to the `dev`
  feature module, which the compiler adds to dev builds only. Lists and if
  blocks use one end-marker comment instead of recursive node bookkeeping.
  The size script now minifies fully (Vite's lib mode keeps whitespace in ES
  output, which had inflated earlier numbers).
- js-framework-benchmark entry added (`bench/js-framework-benchmark`, results in
  [benchmark.md](benchmark.md)); flush and reconcile optimized from ~1.2× to ~0.94× Svelte.
  Found while optimizing: index reads across lists (`names[i]` in a row of another list)
  missed structure changes; fixed with a test.
- RealWorld example (`examples/realworld`), run against the official e2e suite: 130–133/140.
  Bugs it found in sinter, each fixed with a test: parenthesized expressions failed to parse;
  inlined partials shifted node paths (adjacent text merges in the browser); a load answered
  after a local write wiped that write (writes during a load are now replayed); mutations were
  cancelled by navigations (now sent with `keepalive`).
- URL templates omit query parameters whose value is `null`/`undefined` (spec addition, 2026-11-04).
- `data-sn-path` on `<html>` (spec addition, decided 2026-11-04 for the RealWorld app):
  path parameters in `$url`, read-only, several patterns per page. Server rewrites are not
  generated yet; the compiler puts the patterns in the IR (`ir.path`) so the Vite plugin can later.
- Fixed: delegated listeners were only added for event types used by root
  elements, so handlers used only inside template rows never fired.
- Vite plugin with a real build test; diagnostics fixtures for all 21 codes;
  golden outputs; property-based list and layer tests; security tests;
  recipes; generated docs. 129 tests pass, typecheck clean.
- 2026-11-05: pluggable stream transports. `configure({ transport })` picks one per `<sn-sync>`
  URL (EventSource otherwise); `@tiaforge-ui/sinter/ws` is a WebSocket transport (`{event, data}`
  messages or a `decode` function; http(s) stream URLs are opened as ws(s), so the compiler's URL
  rules are unchanged); SignalR is an `llms.txt` recipe with its adapter in the app. Transports now
  deliver parsed payloads (SignalR and WebSocket adapters parse themselves). `render()` falls back
  to the configured transport for stream URLs without a mock.
- 2026-11-05: type checking, phase 2 of the adoption roadmap (`type=` only; OpenAPI is phase 3).
  `compile(…, { check: true })` returns a check unit (expressions with positions and scope frames);
  `src/check/` writes one checked JS file per page to `.sinter/check/` and runs the project's `tsc`
  (TypeScript 7's native `tsc` works; no in-process compiler API is needed). New `type` attribute on
  `<sn-resource>`, `SN208 type-error`, `SN504 untyped-resource`, `sinter check` CLI,
  `sinter({ typecheck, types })`. The untyped RealWorld example (377 expressions) checks with no errors;
  that is a test.
- 2026-11-05: type checking, phase 3: OpenAPI. `sinter({ openapi })` loads JSON/YAML specs (`yaml` is now a
  dependency, required only when a spec is configured); `src/compiler/openapi.ts` matches resources to
  GET operations in every build (`SN307`, `SN308`, `SN505`); `src/check/openapi-types.ts` converts schemas
  to TypeScript. RealWorld now uses the Conduit spec (`examples/realworld/openapi.yml`): 15 of 15
  resources typed with no annotations, 0 errors (a test); a planted `article.titel` reports
  "Property 'titel' does not exist on type 'Article'. Did you mean 'title'?".
- 2026-11-05: type checking, last phase: actions match OpenAPI operations by method (`data-sn-body`
  against the request schema, typed `$result`: 20 of RealWorld's 23 `then` handlers), `type` on
  `<sn-event>` (payload typed, `item`/`set` checked against the resource, `SN506 untyped-event`), `cursor`
  typed as the resource's item, `checkPage()` for tests, and the "Typed resources, state and events"
  recipe. A value that is wrong as a whole is reported by TypeScript on the shadow's `return`; that line
  now maps to the expression's start.
- 2026-11-05: pre-launch fixes. The core's size budget is now 11 KB min+gzip (10.1 KB today); 5 KB
  was never met. `docs/diagnostics.md` is generated from `src/compiler/diagnostic-docs.ts` (example,
  meaning and fix per code) and ships in the package; diagnostics link to its section on GitHub
  (`github.com/tiaforge/sinter`).
- 2026-11-05: editor integration, phase 1: `sinter lsp` (`src/lsp/`: JSON-RPC framing, a
  `Workspace` of projects, pages, partials and open buffers, the LSP glue). Compiler diagnostics as you
  type; partials are compiled through the pages that include them; Vite entries are compiled on load
  (about 0.4 s for RealWorld, mostly Vite's config resolution); file watching reloads the project when
  helpers, types, specs or the Vite config change. `Diagnostic.span` gives attribute- and element-level
  diagnostics their full range. Reading the Vite config moved from `cli.ts` to `viteProject()` in
  `project.ts`. Tests drive the server over in-memory streams (`test/lsp/`).
- 2026-11-05: editor integration, phase 2: `src/lsp/typescript.ts` starts the project's
  `tsc --lsp --stdio` (TypeScript 7) per project, keeps one shadow per page open in it (written to
  `.sinter/lsp/` once so its tsconfig includes them, then changed in memory), pulls errors 300 ms after
  the last compile and maps them with TypeScript's range; hover maps the cursor into the shadow
  (`shadowPosition()` in `shadow.ts`) and the range back. Before TypeScript 7, the `sinter check`
  pipeline runs on save (tested with a fake TypeScript 5 package). `check()` is split into
  `writeSupport`, `shadowOf` and `typeDiagnostic` so both share them. RealWorld over stdio: a planted
  `article.titel` is reported 340 ms after the edit; a hover takes 6 ms.
- 2026-11-05: editor integration, phase 3: completion (`completionItem/resolve` forwarded to
  TypeScript), go to definition and the did-you-mean quick fix (`src/lsp/quickfix.ts`, which reads the
  suggestion from the message, so TypeScript's suggestions work too). In check mode the compiler keeps
  expressions with errors as `broken` (written last in the shadow; their TypeScript errors dropped,
  also in `sinter check`); state and loop frames and resources carry the location of their names, and
  the shadow maps its declarations there. `src/lsp/spec-location.ts` finds a schema or property in the
  spec with `yaml`'s source ranges. RealWorld over stdio: completion after `article.` 22 ms,
  definition of `title` → `openapi.yml:561` 23 ms.
- 2026-11-05: editor integration, phase 4: the VS Code extension (`editors/vscode`, plain CommonJS,
  `vscode-languageclient` 10.1.2, packaged with `@vscode/vsce` 4.0.0 to a 694 KB `.vsix`). It starts
  the `sinter lsp` of the nearest installation above each HTML file, one client per installation;
  middleware keeps a client away from files of a nested project. Its `html-custom-data.json` is kept
  current by the docs test. `docs/editors.md`: setup for VS Code, Neovim, Helix and Emacs. Tested with
  fakes for `vscode` and the client (`test/vscode/`); not yet run inside VS Code itself.
- 2026-11-05: data across page loads (roadmap item 3), phase 1. Sharing one stream across tabs was
  dropped (it changes what servers see per connection; the 6-connection limit is HTTP/1.1's). Instead,
  dev builds warn (code 18) when an EventSource stream's origin was reached over HTTP/1.1
  (`protocolOf()` in `dev.ts`, from Resource Timing; the SSE module calls `app.streamOpened` for
  default-transport streams only), and the spec, README and `llms.txt` say to serve streams over HTTP/2.
- 2026-11-05: item 3, phase 2: the page-load cache. `cache` on `<sn-resource>` (value: max age,
  `SN401` if malformed) compiles to `ResourceDef.cache` and adds the `cache` feature
  (`src/cache.ts`, 757 B gzip). The loader reads the entry on start (after embedded data) and reports
  every load to the feature (`fill`/`store` split in `createLoader`); the feature writes after loads
  and on `pagehide` for resources whose base changed (store `base()`, subscriptions fire for confirmed
  writes only). The request layer clears `sn:c:` entries on any 401, at `fetch` and after the
  middleware chain; `clearPersisted()` clears them too. `render({ session, storage })` and
  `memoryStorage()` in the testing module. Core: 10.30 → 10.53 KB gzip.
- 2026-11-05: RealWorld uses `cache` on all 9 resources and calls `clearPersisted()` on sign-in and
  sign-out. The e2e suite (local backend, `spa`) found that cached data set `loadedAt`, so the
  editor's and settings' login-redirect guard (`$meta.user.loadedAt && !user`) fired on a cached
  `user: null`: 5 tests failed reproducibly. `loadedAt` now stays null until the server answers
  (e582d83). After that: 134/140, the same 5 known failures plus 1 `page.goto` load timeout that
  passes alone (the baseline without cache had 5 such timeouts in one run).

- 2026-11-06: 0.2 roadmap, phase 1: benchmarks. `npm run bench` (`bench/runtime/`, its own Vitest
  config, not part of `npm test`) times the store (5,000 items ordered by name: ~10 ms per write,
  because every write re-sorts from arrival order) and one flush (0.2–0.3 µs per root binding;
  1.6 / 11.3 ms for one upsert into 1,000 / 5,000 sorted rows). `npm run size` measures a minimal page
  and every RealWorld page from a production build; budgets moved from the core to pages. Vitest 5
  dropped `bench()`, so the cases are plain tests that print tables.

- 2026-11-06: 0.2 phase 2, store fixes. The sorted list is patched per write instead of re-sorted
  (one upsert on 5,000 items: 9.9 → 0.007 ms); ties keep arrival order exactly, which the property
  test now checks against a full sort. `meta.total` is computed when the total or a layer changes,
  not when the list is read: a page that shows only `$meta.x.total` updates, and a load no longer
  needs a second flush pass. `setTotal` marks only `meta`. Lists are frozen in dev builds only
  (frozen arrays are 3–50× slower to copy and filter in V8). Core +481 B gzip.

- 2026-11-06: 0.2 phases 3–4 (builder calls, per-page core) stopped after measuring: positional
  builder calls save 250–345 B gzip per RealWorld page (~2 %), a per-page core about 0.3 KB on two
  pages (every page uses lists, conditionals and handlers). Both stay possible features.

- 2026-11-06: flush cost per root binding. A profile of one flush on a page with 4,000 root bindings
  showed two per-binding costs besides matching: every binding that matched ran
  `el.closest('dialog:not([open])')`, and every binding tested did a `WeakMap` lookup for its parsed
  dependencies, plus a `Set` lookup in the deferred set. The compiler now marks nodes that are a
  `<dialog>` or inside one of their block (`dl` in the IR; it replaces the runtime's
  `querySelector('dialog')` per row template), bindings keep their parsed dependencies, and the
  deferred set is consulted only when non-empty. Chrome 156, one change on 4,000 root bindings:
  0.49 → 0.18–0.24 ms; happy-dom (`npm run bench`), 2,000 root bindings: 0.41 → 0.10 ms. Row
  creation, select and update of 1,000 rows and mount unchanged within noise. Core −30 B gzip.

## Decisions and deviations

- `CompileOptions` gains optional `moduleSrc` (URL of the injected
  `<script type="module" src>`; an inline module script would break
  `script-src 'self'`) and `config` (app config module imported before mount).
- `MountOptions` gains `env`, `request` and `transport` seams for the testing module.
- `Transport.connect` takes a 4th argument, the event names to listen for
  (EventSource needs them), plus an optional `listen(name)` for late subscribers.
- Subscribers of `resource.subscribe()` get `{ op: 'refetch' }` after each full load.
- A plain `data-sn-on-<event>` handler and an action on the same element both
  run, the handler first.
- `helper(draft)` in a handler invalidates the whole `draft` root (opaque call);
  built-in helpers, namespace members and store functions do not invalidate.
- `render()` options also accept `files` (partials for `<sn-include>`). Mock
  responses are held until `settle()`, so `flush()` can observe optimistic state.
- Payload scopes (`<sn-event>`, `cursor`) resolve unknown identifiers to payload
  fields before the browser-API check, so fields like `name` work.
- Diagnostics in partials append the include chain to the message.
- `loginRedirect` stores the return URL in sessionStorage (`sn:return`);
  `takeReturnUrl(allow)` reads it back after login.
- `.` / `..` in a URL *path* interpolation is refused at runtime (reported via
  `onError`) instead of being encoded as `%2E`/`%2E%2E`: WHATWG URL parsing,
  and so `fetch`, turns `%2E%2E` back into a `..` segment. Query values are
  still encoded as specified.
- `SN503` fires for any non-literal `id`/`name` value (row-local reads have no
  dependency paths, so "bound from data" means "not a literal").
- Type checking turns off `strictNullChecks` and `noImplicitAny`: bindings that read `null` render
  nothing at runtime, one attribute cannot narrow another (`data-sn-if="x"` around `x.y`), and
  `{ error: null }` state stays unchecked unless it has a JSDoc cast. With them on, the untyped
  RealWorld example had 26 errors, none of them bugs.
- OpenAPI types come from sinter's own schema converter, not `openapi-typescript`: that package builds
  its output with the TypeScript 5 compiler API and declares `typescript@^5` as a peer, which conflicts
  with TypeScript 7 projects (this one included). The converter also turns named schemas into named
  declarations, so messages say `type 'Article'` instead of spelling out the object.
- `type` on `<sn-resource>` is any TypeScript type over the types module's exports (`Contact[]`,
  `Page<Article>`); the shadow file brings the exports into scope with a JSDoc `@import`, so state casts
  use plain names too.
- The compiler's browser-API list does not include very generic names (`name`,
  `open`, `print`, `event`); they are `SN201` instead of `SN202`.

## Open / not yet done

- **Size budgets per page since 2026-11-06** (0.2 roadmap, decision 2): the minimal page (one resource, one
  text binding) ≤ 11.5 KB gzip, replacing "core ≤ 11 KB", and the RealWorld article page ≤ 16.5 KB, with
  every other RealWorld page reported (baseline in [benchmark.md](benchmark.md)). The table below is the
  core budget's last measurement. Until then: **11 KB for the core, met** (it was 5 KB until 2026-11-05, which the core never reached). `npm run size` (rolldown bundle, oxc minify, gzip -9), 2026-11-05:

  | Module | min | gzip |
  | --- | ---: | ---: |
  | core (`mount`, `$k`) | 23.5 KB | 10.1 KB (11.5 KB before the closure rewrite) |
  | sse | 3.1 KB | 1.4 KB |
  | paginate | 2.9 KB | 1.2 KB |
  | persist | 0.7 KB | 0.4 KB |
  | optimistic | 0.2 KB | 0.2 KB |
  | dev (dev builds only) | 1.4 KB | 0.8 KB |
  | contacts page (core + sse + optimistic + persist) | 27.2 KB | 11.4 KB |

  The list performance work of 2026-11-05 (bench/swap, js-framework-benchmark) added 354 B gzip to
  the core (9,944 → 10,298 B), and compiled pages carry one element-lookup function per
  `data-sn-for` template (RealWorld's 7 pages: 18 functions, 275 B gzip in all).

  Marginal gzip cost inside the core: request layer + config ≈ 0.9 KB, store
  ≈ 0.9, app object/API ≈ 1.2, mount/bind ≈ 0.8, loaders ≈ 0.9, actions ≈ 0.7,
  lists ≈ 0.7, render ≈ 0.4, security ≈ 0.4, forms ≈ 0.3, models ≈ 0.3.
  Further trimming yields tens of bytes; 5 KB would need either moving
  parts (actions, forms, models, loaders) into compiler-selected modules or a
  different budget definition.
- Playwright suite in real browsers (`<dialog>`/`commandfor`, bfcache,
  `EventSource`, focus preservation), with Trusted Types and strict CSP.
- List-update benchmark in CI.
- Release pipeline (CI-only trusted publishing with provenance).
