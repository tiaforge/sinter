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
| `test/` | Vitest suites (happy-dom) |

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
- [ ] M10 Vite plugin
- [ ] M11 diagnostics fixtures for every code, security corpus, `llms.txt`, `html-custom-data.json`
- [ ] M12 size budget check, real-browser (Playwright) suite

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
- Fixed: delegated listeners were only added for event types used by root
  elements, so handlers used only inside template rows never fired.

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

## Open / not yet done

- Vite plugin, `llms.txt`, VS Code custom data.
- Diagnostics fixture per code; XSS / clobbering / URL corpora.
- Size budget (5 KB core target) not measured yet; the core is likely above it.
- Playwright suite for Chromium/Firefox/WebKit.
