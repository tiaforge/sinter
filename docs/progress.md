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
| `scripts/release.mjs` | bump versions, date the changelog, commit and tag (`npm run release -- 0.3.0`) |

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
- 2026-11-06: identical expressions share one entry in the page's function table (`fn()` in the
  compiler keys by code). RealWorld article: 112 → 60 functions, 16,507 → 16,293 B gzip; index,
  profile and editor 28–55 B smaller. A first call costs about 5 µs per function in Chrome, so mount
  gains at most about 0.26 ms on the article page, not measurable in a page load's script time.
- 2026-11-08: `run('id')` (proposal reviewed the same day): a store function that starts the action
  of the element with that id through the trigger path (`trigger(rb, null)`), or `requestSubmit()`
  for a form; disabled (`:disabled`) and inert (`[inert]` on it or an ancestor) targets do nothing,
  a missing one warns (dev code 20). Compiler: element ids collected in `declare` (`PageInfo.ids`:
  action, in a row, count) for `SN311`; handlers' `run()`/`refresh()` calls (`flows`) give the
  `$event` typing of targets (`CheckExpr.run`, `RunEvent<E> = E | void`, because `E | null` is `E`
  without `strictNullChecks`) and the opt-in `SN509` cycle search. happy-dom does not match
  `:disabled` inside a disabled `<fieldset>` and passes the form as `requestSubmit()`'s submitter;
  the tests allow for both. Core +86 B gzip.

- 2026-11-08: loading optimizations without attributes (asked: "where there is a clear pattern we can just do"):
  preconnect links for origins literal `src`s name (compiler, `preconnects()`); low request priority for
  resources only dialogs read (`ResourceDef.lo`, from the function table's `$.$r.<name>`/`$.$meta.<name>`
  reads of nodes outside dialogs, templates inside dialogs tracked in `dlTemplates`; `SendInit.priority`,
  `fetchpriority` on the preload); a 250 ms pause for URL changes that keystrokes cause (the model
  handler marks its dirty paths as typing, `hits()` tells a loader whether only such marks reached it);
  refetch on persisted `pageshow` and `online` for resources no stream feeds. Core +230 B gzip.
- 2026-11-08: write-through (designed in the roadmap doc's "Write-through (0.9)" tab, decisions there). Compiler:
  `ExprResult.reads` (member chains rooted at a resource or a row; `LoopEntry.resources` for `cond ? feed : articles`),
  `ResourceDef.sch` from `namedSchema()` (`$ref`, identical inline copy, or inline projection: RealWorld's list
  response inlines an Article without `body`), `ActionDef.ap` from `applyDef()` (provenance with named sub-paths,
  response entities, request wrapper, the body's target), `SN510` from the `then` AST. Runtime: `src/apply.ts`
  (rules 1–4, unchanged fields skipped because a base write drops a waiting layer's changes to the item: the
  overlapping-actions test caught that), one hook in `send()`. The RealWorld check test doubles as the acceptance:
  12 handlers removed.
- 2026-11-09: next-page data (pitch item: "Astro for dynamic content", prefetch). Compiler: `prefetchParts()`
  (`CompiledParts.prefetch`, `CompileResult.prefetch`): `data-sn-path` patterns and the resources whose `src`/`when`
  read only `$url`, constants and helpers. `src/prefetch-build.ts`: `pagePaths()` (a file's served paths) and
  `prefetchModule()`; the Vite plugin describes every HTML entry once (`/@sinter/prefetch.js`, invalidated on HTML
  changes in dev) and passes `prefetch` to `compile()`, whose page module adds the feature. Runtime: `src/prefetch.ts`
  (delegated pointer/focus/touch listeners, 65 ms rest, handover of this page's own data, sessionStorage `sn:p:`),
  `ext.prefetch.take()` in the loader's start before the cache, `writes`/`writing` on the request layer (a mutation
  clears entries; an overlapping prefetch is dropped), the `x-sinter-prefetch` mark (removed before fetch; errors
  reject there; `onUnauthorized` skips it). Chosen over "use the prefetched response instead of a request": the next
  page revalidates, so the preload links and early requests are still taken (no unused preloads) and nothing older
  than one round trip stays on screen. The document itself is not prefetched (a `<link rel=prefetch>` cost 90 B gzip
  for a request a CDN usually answers fast; Speculation Rules would need `inline-speculation-rules` in the CSP or a
  response header). Real browser (RealWorld build, Chromium, API mocked at 1.5 s): hover → article and comments
  requested, the user handed over; the article showed 215 ms after the click, the fresh data at 1,591 ms. Size: feature
  1,366 B gzip; core +153 B; RealWorld article 19,971 → 21,306 B gzip, budget raised from 20 to 22 KB.
- 2026-11-09: Speculation Rules (`speculationRules()` in `prefetch-build.ts`, written by the plugin into every page; CSP hash
  logged in `closeBundle`) and prerender awareness (`app.shown()`; the SSE module connects through it; activation refetches
  every loader). `CompileResult.path` carries `data-sn-path` so pages without prefetchable data still get rules. Chromium,
  RealWorld build: `/article/post-1` fetched on hover with `Sec-Purpose: prefetch`, the navigation used it; with
  `'prerender'` the browser asked for `prefetch;prerender` but reported `PrerenderingDisabledByDevTools` (Playwright, also
  without request interception), so activation is covered by `test/behaviour/speculation.test.ts` only. Default stays
  `'prefetch'`: prerender runs pages nobody may see (requests, islands' side effects).
- 2026-11-09: `data-sn-transition` (`src/transition.ts`; compiled to an attribute binding writing `data-sn-vt`). Names are
  given at `pageswap`/`pagereveal` only, to the followed row's element and its match. A row is the nearest ancestor of the
  link holding named elements without links elsewhere (the first version climbed to `<body>`: a link to `/about` named the
  first row's image; the behaviour test caught it). Chromium, RealWorld: list → article morphs
  (`::view-transition-group(sn-1k2g1wp)` beside `root`, only the clicked title named); back to the list fades only: Playwright's
  Chromium reloads it (no bfcache) and the rows render after the first paint, which is when the browser captures.
  temper: `@view-transition { navigation: auto; }` in `core.css` (on by default, off with `navigation: none` in the app's CSS).
- 2026-11-09: holding the first paint while a morph is pending (`HOLD_SCRIPT`: a MutationObserver makes the async page
  module deferred and render-blocking before the parser prepares it). Tried first on a bare page with the module delayed
  400 ms: first paint 35 ms without the element, 420 ms with it. RealWorld back to a reloaded list: morphs, 3 of 3.
  `view-transition-class: sn-transition` on the named pair. Per-link prefetch opt-out dropped: the browser's rules can
  only skip a link by a marker in the page; `<html data-sn-prefetch="off">` is build-time and stripped.
- 2026-11-09: `e2e/navigation` (headless Chrome over `bench/swap/cdp.mjs`, which takes `CHROME_ARGS` now): hover → data and
  HTML prefetched; first paint with the prefetched title; morph forward and back. Its first run found that the back morph
  had passed by timing: the hold script waits for the mount, not for responses, so the list needs `cache` (it has it now,
  and the step slows the API to 1.5 s). Building with `prefetch: false` fails steps 2 to 5.
- 2026-11-09: touch presses wait like a hover (pointercancel ends it); the pending morph name carries its time (10 s).
  CI runs `e2e/navigation` (green on GitHub's Chrome, 13 s). CSP: tried in Chromium under `script-src 'self'`: inline rules
  blocked, rules from a `Speculation-Rules` header served as `application/speculationrules+json` work, as `application/json`
  rejected. So `speculation: { delivery: 'header' }` (a fixed-name `speculation-rules.json`; dev and preview send the header
  and type) and `docs/navigation.md` with the CSP part near the top; the README no longer mentions CSP. `e2e/navigation` now
  runs under that policy, and a step fails on any violation.
- 2026-11-09: Speculation Rules delivery, decided after testing each option in Chromium (not committed in between: header by
  default, then a `<link rel="prefetch">` default). No in-page file form exists (`<script src>`: "External speculation rules
  are not yet supported"; `<meta http-equiv>`, `<link rel=speculationrules>`: ignored). A `<link rel="prefetch">` is reused for
  the navigation only for cacheable HTML (`max-age=60` yes; none, `no-cache`, `max-age=0`, `no-store` no). So: inline by
  default (no server setup), the build adds the hash to a CSP `<meta>` (works, tested), a header CSP needs
  `'inline-speculation-rules'`; dev warns (code 22, buffered `ReportingObserver`: tested, it gets the report from before mount).
  `delivery: 'header'` stays the opt-in that no CSP blocks. `e2e/navigation` runs under a `script-src 'self'` `<meta>`.
- 2026-11-09: data and fonts before the first paint, from Lighthouse on RealWorld (bench/realworld/lighthouse.mjs). The early
  requests waited for the stylesheets (the early file is deferred) and skipped other origins; the article title (the LCP)
  needs its data and its font. A/B, mobile, median of 5 (LCP): base 3.0 s, Google Fonts inlined 2.8 s, early requests from an
  `async` file 2.8 s, both 2.3 s; desktop unchanged (1.0–1.1 s). Decided: (1) a page with early requests splits its early file:
  loaded `async` before the stylesheets (starts the requests), rendered by a ~60-byte render-blocking stub that imports it (one
  module per URL), instead of the prototype's second, near-duplicate requests file (3.2 kB gzip a page); one script cannot do
  both (an async render-blocking module that awaits the parse does not hold the paint, see Messages). (2) Other origins
  requested early only when listed in `sinter({ origins })` (the build's copy of `configure({ origins })`), on by default for
  those. (3) `<sn-resource early="off">` for a resource a middleware answers or changes (RealWorld's `user` logged a 401 from
  its preload). (4) Google Fonts inlined by default (the Angular CLI does; its RealWorld demo has the preconnect), cached in
  `node_modules/.cache/sinter/fonts`. Not done: other third-party CSS (the app's call), `font-display` (a visual choice),
  non-blocking CSS (the build cannot know what affects layout). The RealWorld article page's budget: 26 KB (its early file
  now carries the request code). Tested in Chromium under a `script-src 'self'` header CSP: no violations.

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
  text binding) ≤ 15 KB gzip (11.5 KB until 2026-11-07: 0.3's features took it to 12.1 KB, and the
  budget was raised rather than features moved out of the core), replacing "core ≤ 11 KB", and the
  RealWorld article page ≤ 20 KB (16.5 KB until 2026-11-07, when it stood at 16.9 KB), with every other RealWorld page reported (baseline in
  [benchmark.md](benchmark.md)). CI runs `npm run size -- --check`. The table below is the
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
