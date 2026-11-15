# Contributing

## Before you open a pull request

**Open an issue first and wait for the maintainer's go-ahead.** This applies to features, behavior
changes and refactors. A pull request without an agreed issue may be closed, however good the code
is. Small fixes (typos, a broken link) can go straight to a pull request.

Link the issue from the pull request.

## Pull requests

- Keep one change per pull request, with tests (`npm test`).
- Run `npm run typecheck` and `npm test` before you push; CI runs typecheck, build and tests on
  every push (Node 22, 24 and 26).
- If you change an attribute, an element or a diagnostic, run `npm run docs` and commit the
  regenerated files.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under "Unreleased". Attribute names, function names and
  diagnostic codes are public API.
- A feature that renders markup (a new attribute, root shape, slot or fill form, control-flow
  template, or a build-time optimization) adds its shapes to the fuzz tests. See
  [Fuzz tests](#fuzz-tests).

## Fuzz tests

Two seeded fuzz tests generate random markup and check that every way of rendering it agrees. They
found bugs that hand-written tests missed: wrong output where features meet, over constants only,
or only after the page module takes over.

- `test/behaviour/component-fuzz.test.ts` nests components of every root shape (plain, `if`/`else`,
  another component's tag, a slot, a choice, a list), with fills, slot content,
  `<sn-component use>`, loops, branches and texts.
- `test/behaviour/anchor-fuzz.test.ts` nests lists, branches, texts and elements inside a row.

Each case compares the page after a state change with a fresh render of the new state, with the
build over constants (state nothing writes), and (component fuzz) with the early script's first
paint taken over by the page module.

When you develop a feature:
- Add its shapes to the generator: a component in `COMPONENTS`, a case in `markup()`, or a field in
  the generated data. The fuzz then covers it combined with everything already there.
- Before you open the pull request, run more seeds than CI does:
  `SN_FUZZ_SEEDS=3000 npx vitest run test/behaviour/component-fuzz.test.ts`.
- A failing seed names its case. Turn its minimal repro into a test of its own, next to the fix.
  Don't skip or allow-list a seed to get green.

## License and sign-off

sinter is MIT licensed. Please sign off your commits with `git commit -s` (Developer Certificate of
Origin). It isn't enforced and there is no CLA.

## Development

```sh
npm test          # vitest (happy-dom); CI runs typecheck, build and tests on every push (Node 22/24/26)
                  # browser checks run in Chromium; those for every engine also in Firefox and WebKit when
                  # Playwright has them (`npx playwright install firefox webkit`, or SINTER_FIREFOX /
                  # SINTER_WEBKIT=<executable>); CI installs all three and requires them
npm run typecheck
npm run build     # dist/
npm run size      # size per page and module, with budgets
npm run bench     # store and flush benchmarks (docs/benchmark.md)
npm run docs      # regenerate llms.txt and llms-full.txt, html-custom-data.json (also the VS Code extension's), docs/diagnostics.md and docs/attributes.md
npm run release -- 0.3.0   # sinter, the create starter, sinter-axum and Sinter.AspNetCore all to 0.3.0, the starter's temper to the
                           # latest on npm, date the changelog,
                           # commit "Release 0.3.0", tag v0.3.0, dry-run every publish, print the push and publish
                           # commands (nothing pushed or published)
```

## Packages and imports

| Import | Contents |
| --- | --- |
| `@tiaforge-ui/sinter` | `mount`, store, renderer, actions, request layer, instance API, `configure` |
| `@tiaforge-ui/sinter/sse` | `<sn-sync>`, SSE transport |
| `@tiaforge-ui/sinter/ws` | WebSocket transport for `<sn-sync>` |
| `@tiaforge-ui/sinter/optimistic` | optimistic layers |
| `@tiaforge-ui/sinter/paginate` | keyset, offset, append |
| `@tiaforge-ui/sinter/each` | fan-out resources (`each="a in accounts"`) |
| `@tiaforge-ui/sinter/persist` | `data-sn-persist` |
| `@tiaforge-ui/sinter/prefetch` | next-page data (added by the Vite plugin) |
| `@tiaforge-ui/sinter/compiler` | `compile()` |
| `@tiaforge-ui/sinter/vite` | Vite plugin |
| `@tiaforge-ui/sinter/check` | `check()` (used by `sinter check`), `checkPage()` for tests |
| `@tiaforge-ui/sinter/testing` | `render`, `mockRequests`, `mockStream` |
