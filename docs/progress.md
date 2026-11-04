# sinter v0.1 — implementation progress

Spec: [spec.md](spec.md) (snapshot of the shared doc). This file tracks what is
built, what deviates, and what is left.

## Layout

| Path | Contents |
| --- | --- |
| `src/ir.ts` | IR v1 types shared by compiler and runtime |
| `src/compiler/` | `compile()`: HTML rewrite, includes, expression checking and codegen |
| `src/runtime/` | store, scheduler, renderer, actions, request layer, instance API |
| `src/sse.ts`, `src/optimistic.ts`, `src/paginate.ts`, `src/persist.ts` | feature modules |
| `src/vite.ts` | Vite adapter |
| `src/testing/` | `render`, `mockRequests`, `mockStream` |
| `test/` | Vitest suites (happy-dom) |

## Milestones

- [ ] M0 scaffold: package, tsconfig, test runner
- [ ] M1 compiler: HTML parse/rewrite, `<sn-include>`, attribute vocabulary, diagnostics
- [ ] M2 expressions: parse, scope resolution, sandbox rules, dirty-path analysis, codegen
- [ ] M3 runtime core: store, scheduler, bindings, keyed lists, if/else, model, events
- [ ] M4 request layer + actions: middleware, bodies, concurrency, then/catch, errors
- [ ] M5 SSE sync module
- [ ] M6 optimistic layers
- [ ] M7 pagination
- [ ] M8 persist, `$url`, `$now`, `$locale`, helpers
- [ ] M9 testing module
- [ ] M10 Vite plugin
- [ ] M11 security checks (URL allowlist, origins, sinks) and docs (`llms.txt`, custom data)

## Log

- 2026-11-04: spec imported, plan written.

## Deviations / open notes

(none yet)
