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
- Add a bullet to [CHANGELOG.md](CHANGELOG.md) under "Unreleased", in its Breaking, Added, Changed,
  Fixed or Performance subsection: a sentence or two for someone upgrading (what changed, what to do,
  a link to the doc), as the note at the top of the changelog describes. Implementation details and
  benchmark figures go in the commit message or the pull request. Attribute names, function names
  and diagnostic codes are public API.
- A feature that renders markup (a new attribute, root shape, slot or fill form, control-flow
  template, or a build-time optimization) adds its shapes to the fuzz tests. See
  [Fuzz tests](#fuzz-tests).

## Fuzz tests

Four seeded fuzz tests generate random pages, or random calls, and check that every way of computing them agrees. They
found bugs that hand-written tests missed: wrong output where features meet, over constants only,
or only after the page module takes over.

- `test/behaviour/component-fuzz.test.ts` nests components of every root shape (plain, `if`/`else`,
  another component's tag, a slot, a choice, a list; one without props, declared by its bare `<template>`), with fills, slot content,
  `<sn-component use>`, loops (with and without an empty state), branches and texts.
- `test/behaviour/anchor-fuzz.test.ts` nests lists (of objects, and of strings and numbers with duplicates and
  no key; with and without an empty state), branches, texts and elements inside a row.
- `test/behaviour/reactivity-fuzz.test.ts` runs random handlers over a page with lets over helpers: writes
  in place and reassigned, keyed and index-keyed rows moved and their own handlers, rows of strings with
  duplicates and no key with state of their own, store functions,
  `refresh()`, `page()` on a paginated resource and an `each` resource, `emit()` with listeners that write
  and that read, a nested synchronous click read around, an island whose prop setter fires an event
  mid-flush, `<sn-sync>` upserts, refresh events and a dropped stream, an optimistic action, actions whose
  `then` and `catch` read lets, a component with a let of its own, a `data-sn-persist` scope and the
  locale, with reads of lets stored between them. Three oracles: the same page with its helpers wrapped
  in `memo()` (page, state and stored reads equal by structure); every state scope marked whole after
  each settle changes nothing on the page (a write path that marks too little); and, on a third of the
  seeds, the early script's first paint taken over. `SN_FUZZ_DEPTH` makes the handlers and click scripts
  longer, `SN_FUZZ_FIRST` starts at another seed (run a long sweep in chunks side by side).
  It also writes through aliases (`sel = y; sel.n += 10`): direct, inside another object, in another list, a
  helper's element, one from `reduce()` the compiler cannot follow, and through the list they alias.
  And it renders computed lists, whose rows read their item without a dependency: a filter over state objects
  that reads a scalar, a helper that returns its argument or a part of it, a helper that returns new group
  objects holding the same items (inner rows read the group and the item), and a list of state fields
  (`col in [picked, other]`); written by the scalar alone, an item in place (through the list, an alias, an
  inner row's handler), both in one handler, the fields' arrays in place and replaced. One more oracle
  computes what those rows must show from the state itself, since marking a scope whole goes through the same
  evaluation of the list. Mutants it catches at the default seeds: kept rows of a computed list not rendered
  again (seed 1), and not rendered again unless a change of the flush is inside a value the list reads
  (seed 4).
- `test/memo-fuzz.test.ts` calls `memo()` with random argument lists: primitives that look alike (`0` and
  `-0`, `NaN`, `''` and `undefined`, strings that run into each other), plain objects and arrays of them in
  other orders, with holes or a null prototype, look-alikes of each list, and arguments that call through.
  Each call is compared by value with calling the function directly, equal arguments must give the same
  object, the caller's objects must be neither kept in a result nor frozen, every kept result must be
  frozen, and a small cache must drop its least recently used key and keep one just used.
  `SN_MEMO_SEEDS` sets the seeds (default 200). Mutants it catches at the default seeds: `-0` keyed as
  `0`, strings keyed without their length, a hole keyed as `undefined`, object keys sorted, a null
  prototype keyed as a plain object, no copy of the arguments, no freeze, no eviction, eviction in
  order of insertion rather than use. (The array's length in its key is redundant with its holes: that
  mutant is equivalent.)

Each page case compares the page after a state change with a fresh render of the new state, with the
build over constants (state nothing writes), and (component fuzz) with the early script's first
paint taken over by the page module, and with the first paint over the list as embedded data, itself
and taken over.

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

On a fresh clone, with Node 22 or later:

```sh
npm ci
npx playwright install chromium   # the browser checks; without it they are skipped locally (CI requires it)
npm run typecheck
npm test                          # no build needed: the tests run the TypeScript in src/
```

```sh
npm test          # vitest (happy-dom); CI runs typecheck, build and tests on every push (Node 22/24/26)
                  # browser checks run in Chromium; those for every engine also in Firefox and WebKit when
                  # Playwright has them (`npx playwright install firefox webkit`, or SINTER_FIREFOX /
                  # SINTER_WEBKIT=<executable>); CI installs all three and requires them
npx vitest run test/vite/locales.test.ts   # one file
npm run typecheck
npm run build     # dist/: what the package publishes, and what e2e/ and the examples install; npm test does not need it
npm run size      # size per page and module, with budgets
npm run bench     # store and flush benchmarks (docs/benchmark.md)
sudo bench/realnet/example-realworld.sh   # page loads on a bandwidth-limited network path, behind nginx (bench/realnet/README.md)
npm run docs      # regenerate llms.txt and llms-full.txt, html-custom-data.json (also the VS Code extension's), docs/diagnostics.md and docs/attributes.md
npm run release -- 0.3.0   # sinter, the create starter, sinter-markdown (its peer range from 0.3.0), sinter-axum and Sinter.AspNetCore all to 0.3.0, the starter's temper to the
                           # latest on npm, date the changelog,
                           # commit "Release 0.3.0", tag v0.3.0, dry-run every publish, print the push and publish
                           # commands (nothing pushed or published)
```

### Releasing

From GitHub's UI: Actions → Release → Run workflow (on `main`) → the version, such as `0.3.0`
(`0.3.0-rc.1` for a pre-release, published to npm under `next` instead of `latest`). The workflow runs
`npm run release -- 0.3.0 --no-check` (the bumps, the dated changelog, commit "Release 0.3.0", the publish dry
runs) and pushes the commit to a temporary branch, `release/v0.3.0`; runs CI on it; tags it `v0.3.0` only once
CI passed; publishes; then moves `main` to the release commit (merging it, if `main` moved on meanwhile), makes
the GitHub release, its notes the changelog's section, and deletes the branch.

Or locally: `npm run release -- 0.3.0`, `git push origin HEAD v0.3.0`, then on GitHub publish a release for
the tag `v0.3.0`.

Either way, the [Release workflow](.github/workflows/release.yml) checks that the tag is every package's version
(`scripts/release-check.mjs`), runs CI on the tagged commit, and publishes: `@tiaforge-ui/sinter` first, then
`create-sinter` and `@tiaforge-ui/sinter-markdown`, all with npm provenance; the two crates; the NuGet package.
It holds no tokens: each registry trusts the workflow through GitHub's OIDC token. A run that fails before the tag leaves
nothing behind (its branch is deleted), so it can simply be run again with the same version. Once tagged, a
failed publish is retried with "Re-run failed jobs", which skips what is already published.

Set up once:

- npm: for each of `@tiaforge-ui/sinter`, `create-sinter` and `@tiaforge-ui/sinter-markdown`, Settings →
  Trusted publishing → GitHub Actions: `tiaforge/sinter`, workflow `release.yml`, environment `release`.
- crates.io: for `sinter-axum` and `sinter-axum-macros`, Settings → Trusted Publishing: the same repository,
  workflow and environment.
- NuGet: a trusted publishing policy on nuget.org for `tiaforge/sinter`, `release.yml`, environment `release`,
  and the repository variable `NUGET_USER` (Settings → Secrets and variables → Actions → Variables) set to
  the nuget.org account that owns the policy.
- GitHub: the `release` environment (Settings → Environments; the first run makes it), with required
  reviewers if a release should wait for an approval.

Internal docs: [`docs/spec.md`](docs/spec.md) is the design spec the source comments cite, with its implementation log at
the end (what is built and where it departs from the spec), and
[`docs/proposals/`](docs/proposals) holds the design proposals, each with its status on its first lines.

## Packages and imports

| Import | Contents |
| --- | --- |
| `@tiaforge-ui/sinter` | `mount`, store, renderer, actions, request layer, instance API, `configure` |
| `@tiaforge-ui/sinter/sse` | `<sn-sync>`, SSE transport |
| `@tiaforge-ui/sinter/ws` | WebSocket transport for `<sn-sync>` |
| `@tiaforge-ui/sinter/optimistic` | optimistic layers |
| `@tiaforge-ui/sinter/paginate` | keyset, offset, append |
| `@tiaforge-ui/sinter/runtime/for` | fan-out resources (`<sn-resource for="a in accounts">`) |
| `@tiaforge-ui/sinter/persist` | `data-sn-persist` |
| `@tiaforge-ui/sinter/prefetch` | next-page data (added by the Vite plugin) |
| `@tiaforge-ui/sinter/compiler` | `compile()` |
| `@tiaforge-ui/sinter/vite` | Vite plugin |
| `@tiaforge-ui/sinter/check` | `check()` (used by `sinter check`), `checkPage()` for tests |
| `@tiaforge-ui/sinter/testing` | `render`, `mockRequests`, `mockStream` |
