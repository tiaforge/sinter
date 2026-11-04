# sinter v0.1 — implementation progress

Spec: [spec.md](spec.md) (snapshot of the shared doc). This file tracks what is
built, what deviates, and what is left.

## Layout

| Path | Contents |
| --- | --- |
| `src/ir.ts` | IR v1 types shared by compiler and runtime |
| `src/compiler/` | `compile()`: HTML rewrite, includes, expression checking and codegen, helper manifest |
| `src/runtime/` | store, scheduler, renderer, actions, request layer, config, helpers, security checks |
| `src/sse.ts`, `src/optimistic.ts`, `src/paginate.ts`, `src/persist.ts` | feature modules |
| `src/vite.ts` | Vite adapter |
| `src/testing/` | `render`, `mockRequests`, `mockStream` |
| `src/compiler/vocabulary.ts` | the attribute/element table; compiler, `llms.txt` and custom data derive from it |
| `test/` | Vitest suites (happy-dom); `test/compiler/golden/__out__` are file snapshots |
| `docs/recipes/` | the five `llms.txt` recipes, each with its executed test |
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
- Fixed: delegated listeners were only added for event types used by root
  elements, so handlers used only inside template rows never fired.
- Vite plugin with a real build test; diagnostics fixtures for all 21 codes;
  golden outputs; property-based list and layer tests; security tests;
  recipes; generated docs. 129 tests pass, typecheck clean.

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
- The compiler's browser-API list does not include very generic names (`name`,
  `open`, `print`, `event`); they are `SN201` instead of `SN202`.

## Open / not yet done

- **Size budget not met.** `npm run size` (rolldown bundle, oxc minify, gzip -9):

  | Module | min | gzip |
  | --- | ---: | ---: |
  | core (`mount`, `$k`) | 19.7 KB | 8.5 KB (target 5 KB; was 11.5 KB before the closure rewrite) |
  | sse | 3.2 KB | 1.4 KB |
  | paginate | 2.9 KB | 1.2 KB |
  | persist | 0.7 KB | 0.4 KB |
  | optimistic | 0.2 KB | 0.2 KB |
  | dev (dev builds only) | 1.4 KB | 0.8 KB |
  | contacts page (core + sse + optimistic + persist) | 23.6 KB | 9.9 KB |

  Marginal gzip cost inside the core: request layer + config ≈ 0.9 KB, store
  ≈ 0.9, app object/API ≈ 1.2, mount/bind ≈ 0.8, loaders ≈ 0.9, actions ≈ 0.7,
  lists ≈ 0.7, render ≈ 0.4, security ≈ 0.4, forms ≈ 0.3, models ≈ 0.3.
  Further trimming yields tens of bytes; reaching 5 KB needs either moving
  parts (actions, forms, models, loaders) into compiler-selected modules or a
  different budget definition.
- Playwright suite in real browsers (`<dialog>`/`commandfor`, bfcache,
  `EventSource`, focus preservation), with Trusted Types and strict CSP.
- List-update benchmark in CI.
- Release pipeline (CI-only trusted publishing with provenance).
- The docs site the diagnostics link to (`DOCS_URL` in `src/compiler/diagnostics.ts`)
  is a placeholder.
