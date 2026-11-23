# Build pipeline fixes (outside the compiler)

The costs `profile.md` §2, §6 and §7 found outside the compiler, fixed in `src/vite.ts` and the modules it calls (not
`src/compiler/{compile,link,index}.ts`, which the compiler redesign restructures in parallel). Every fix keeps the output
byte-identical and adds no option.

## How it is measured

- **Apps**: `bench/astro`'s `writeSinterApp` into `bench/astro/out/`: `sinter-{static,live}-{100,400}` and
  `sinter-{static,live}-files-100`.
- **The floor** (the build's cost outside the compiler): a `node --cpu-prof` run of `bench/astro/run-sinter.mjs`, one
  fresh process per build. Floor = profile total − samples under `compile` (dist/compiler/index.js, the description's
  compiles included) − the GC samples that fall between two samples under `compile`. That is the same quantity as
  `profile.md` §6, counted more simply (its GC share came from a `PerformanceObserver`; this attributes a GC sample to
  the compiler when both neighbouring samples are in it), so its absolute numbers run ≈5–10 % above §6's; compare
  rows of this file with each other. Script: `floor.mjs` and `ab.sh` (alternates two `dist/` copies, before and after,
  run by run) in the session's scratchpad (`pf/`).
- The machine has 4 cores and other agents built and tested on it throughout; before and after were run back to back,
  alternating, and the tables give medians of 3 runs at n=100 and single runs at n=400 unless marked.
- **Byte identity**: before and after each change, `scripts/baseline.mjs --keep` (static-site, multilingual-site,
  dashboard, realworld, swap-csp, vite-i18n, axes) and the four n=100 bench apps, every output file diffed (`diff -r`:
  names, hashes in names, bytes). The baseline itself was checked to be deterministic (two builds of HEAD: identical).

## 1. The early script: one nested build per distinct source

`generateBundle` ran one nested `vite build` per page for its early script (plus one for the shared head script):
~15 ms each, 1.5 s per 100 pages. On a blog every post's early source is the same text: in `sinter-live-100` all
100 posts' head files are byte-identical. The page's early file is now built once per distinct
`(source, runtime names taken from the shared script, runtime names bundled in)`, and pages with the same one share its
output and the content-namespace keys its modules called (both depend on those inputs alone). Each page still gets its
own record (the shared modules' keys are filled into it afterwards).

- Chosen over one Rolldown build with every page as an input (which would change chunking and hashes) and over calling
  the bundler directly with one resolved config (which would have to reproduce what `vite build` applies: define,
  the target's transforms, minify). Deduplication keeps every byte and removes all of the cost where it matters;
  a site whose pages each have their own early source (realworld: 6 distinct of 8) still pays per distinct source.
- Test: `test/vite/early-builds.test.ts` (two pages with one source: one build, the bytes each has built alone; a third
  with another source: its own build).

| sinter-live-100 (floor, ms) | before | after |
|---|---:|---:|
| runs | 4,309 / 4,235 / 4,324 | 3,137 / 2,730 / 2,426 |
| median | **4,309** | **2,730** (−1.58 s, −15.8 ms per live page) |
| `resolveConfig` under it | 258 | 62 |
| sinter-live-400 (floor, one run each) | 17,616 | 9,317 (−8.3 s, −20.7 ms per live page) |

Static pages have no early script: unchanged. Byte identity: all 11 apps identical.

## 2. The size lines: gzip only what is printed, each text once

`reportRuntime` (the "JavaScript N kB gzip + M kB gzip shared" line per page) gzipped the page's chunk and every chunk it
imports, per page, also at `logLevel: 'warn'`, where Vite's logger prints no info line. `report` (the early script's
line) gzipped the page's early file and the shared head script per page, and walked the page's modules for the "in the
page bundle too" note.

- `reportRuntime` returns at once when info lines are not printed: the build's own logger below `info`. A custom logger
  (`customLogger`) gets every line, as before, whatever the level.
- `report` still measures the early file and the shared head script at every level (the first-paint budget's SN523
  warning needs them), but writes and walks for its info line only when it is printed (the page's modules: a thunk).
- Every gzip size is kept by the script's text for the build (`gzipSize`, cleared at `buildStart`): the shared chunks,
  the shared head script and, on a blog, every post's early file and identical page module are gzipped once.
- Lines checked identical (sorted; Vite's HTML step runs pages concurrently, so their order varies from build to build)
  at the default level, before and after, for realworld, dashboard, static-site, multilingual-site, sinter-live-100 and
  sinter-static-100. Test: `test/vite/size-report.test.ts` (warn: only the budget's two texts gzipped; info: the lines,
  with the written files' sizes, 4 gzips for 3 pages; a custom logger at `warn` gets the lines).

| | before | after |
|---|---:|---:|
| `reportRuntime` + `report`, inclusive, sinter-live-100 (3 runs) | 136 / 163 / 168 ms | 1 / 1 / 1 ms |
| the same, sinter-live-400 | 682 ms | 3 ms |
| floor sinter-live-100 (median of 3) | 2,931 | 2,875 |
| floor sinter-live-400 (one run) | 7,790 | 5,741 |

The floors are noisy here (±300 ms between runs on the shared machine) next to a 150 ms change; the inclusive times
are the measurement: −1.4 ms per live page at 100, −1.7 at 400. (At 400 the floor fell by 2 s, Vite's HTML step by
1.4 s; part of that is GC the gzip buffers caused, part noise.) Static pages log "no JavaScript" and gzipped nothing:
unchanged. Byte identity: all 11 apps identical.

## 3. The template probe: a description, not a compile

`configResolved` lists a `<html data-sn-for>` page's entries (`templateOf`, from `pagesInputs`) by compiling it as its
template with `prerender: true`: both passes, the first entry evaluated, only to read `pages`, `axes` and the
SN340/SN341 errors. Those are the walk's (`entryResource`, `axisResource`, `pagesOf`), so the probe is now a
description (`describeOnly: true`: one pass, nothing evaluated, the definitions that describe nothing left out). It runs
in dev too (`devEntry`), with the same answer.

- Checked: the description's and the compile's `[pages, axes, SN340/SN341]` compared on every probe (a temporary audit
  that threw on a difference) across test/vite, test/behaviour, test/cli, test/docs (1,303 tests), the bench apps and
  `scripts/baseline.mjs`'s apps (axes, locales): no difference. Test: `test/compiler/template-probe.test.ts` (axes at no
  value and at an outer value, a page's own entries with an SN340 entry, in a language).

| sinter-static-100 | before | after |
|---|---:|---:|
| compile under `templateOf` (2 probes: the build's and the source list's), 4 runs | 270 / 237 / 344 / 257 ms | 102 / 94 / 168 / 117 ms |

−150 ms of the fixed part of a build with a page per entry (the template apps, static or live). The floor as defined
above counts the probe as compiler time, so it does not move; the wall time does. Byte identity: all 11 apps identical.

## 4. The list of source pages: kept for the build

`sourceEntries()` (the build's input pages and every page compiled so far, resolved, deduplicated and sorted) was made
afresh on every call, and every page compile calls it many times: `entries()` (also from inside `describe`, for the
linking threshold), `appPages()` (what other pages request ahead, the Speculation Rules), and `entries()` asked
`templateOf` of every source page whether any has axes. In a build with a page file per post, each new page also reset
`appPages`'s cache (`seen` grew), so every page rebuilt the whole page list. Measured at 400 pages it is quadratic:
`sourceEntries` 158 ms at 100 pages, 2,530 ms at 400 (16×).

- A build keeps the list (and whether a source page has axes) while its input and `seen` are unchanged; it is
  dropped at `buildStart` (`vite build --watch`). Dev computes it afresh, as before (files come and go).
- A page that is compiled for the first time but is already one of the source pages (every page of a build, but a page
  that no input names) leaves the list and `appPages`'s cache as they were.
- Test: `test/vite/page-list.test.ts`: the pages `htmlInputs` returns, summed over a build, 20 for 10 pages and 80 for
  40 (before: 880 and 13,120), and every page still in each page's Speculation Rules.

| sinter-static-files (floor, ms) | before | after |
|---|---:|---:|
| n=100, 3 runs | 2,865 / 2,372 / 2,457 | 2,030 / 1,688 / 1,926 |
| n=100, median | **2,457** | **1,926** (−5.3 ms per page) |
| n=400, one run | **10,178** | **6,171** (−10 ms per page) |
| `sourceEntries` + `entries` under it, n=100 / n=400 | 175–234 / 2,873 ms | 1–2 / 7 ms |
| `appPages` outside `describe`, n=400 | 1,689 ms | 5 ms |

Template apps (`pageInputs`) never reset the cache and list few source pages: unchanged. Byte identity: all 11 apps
identical. Full suite green (2,743 tests).

## 5. SN325's check: each module's info read once

`guardLazy` (in `generateBundle`, every build) walks each page module's import graph with `getModuleInfo`, a call into
the bundler, for every module of every page: the pages reach mostly the same modules (the runtime's). The infos are
now read once per build. sinter-live-100: 34 ms → under 1 ms (−0.3 ms per live page). Byte identity: all 11 apps
identical. Test: `test/vite/lazy.test.ts`'s SN325 case built with two pages, each reported. Too small for a CHANGELOG
line of its own.

## 6. The early scripts that differ: one builder for the build

Section 1 left one nested build per distinct early source, and with a page file per post every post's source differs
(it names its own slug): `sinter-live-files-100` still ran 101 nested `vite build`s, 1.8 s of `generateBundle`.
`vite build` is `createBuilder(config, true)` and then `builder.build(environment)`; the build now makes that builder
once (`earlySession`) and runs every early script through it, one after another, the entry plugin reading the current
script's job. Same plugins, same pipeline, same bytes; the config is resolved and the environment set up once. Dev
keeps a `vite build` per page script (its own cache, with source maps). Where Vite has no `createBuilder`, as before.

Measured first, and dropped:

- **Several builds at once** (4 in flight): `generateBundle` 1.4–1.5 s against 1.4–1.5 s; the nested builds are bound
  by their JavaScript (Vite's plugin pipeline), not by Rolldown's native work, so they do not overlap.
- **Rolldown directly** (the entry plugin only): 1.75 ms a script against 13–17 ms for `vite build` and 9–11 ms for a
  reused builder (micro-benchmark of 40 small scripts), but not Vite's pipeline (its define, transforms, minifier
  settings) and not the same bytes.

| sinter-live-files-100 | before | after |
|---|---:|---:|
| sinter's `generateBundle` (Rolldown's plugin timings), 3 runs | 1.8 / 1.8 / 1.8 s | 1.4 / 1.3 / 1.3 s |

−0.45 s per 100 distinct early scripts (−4.5 ms a live page that has its own). The test of section 1 now also checks
that a build makes one builder. Byte identity: all 11 apps identical.

## Where the floor is now

Before (the tree at `a4a406c`) against after (this branch), the same method, alternating run by run. Medians; n=100:
3–6 runs each, n=400: 1–2. The machine was busier than in `profile.md`'s session (static-100's compile took ≈12 s
here against 8.9 s there), so every number here is ≈1.4× its quiet-machine value; the ratios carry over.

| app (floor, ms) | before | after | per page outside the compiler, before → after |
|---|---:|---:|---|
| sinter-static-100 | 2,187 | 2,214 | |
| sinter-static-400 | 4,197 | 4,242 | 6.7 → 6.8 ms (100→400) |
| sinter-live-100 | 4,812 | 2,560 | |
| sinter-live-400 | 14,775 | 5,416 / 6,203 (two runs, different load) | 33 → 10.6 ms (100→400) |
| sinter-static-files-100 | 2,516 | 2,221 | |
| sinter-static-files-400 | 9,905 | 5,180 | 24.6 → 9.9 ms (100→400; before, it grew with n) |
| sinter-live-files-100 | 5,327 | 4,019 | |

- **A live page over a static one** (template apps): 26 ms → ≈4 ms outside the compiler. On `profile.md`'s scale the
  live-100 floor goes from 3.9 s to ≈2.1 s (×0.53), the static one stays at ≈1.5 s; the template apps' wall time
  also loses the probe's ≈150 ms (counted as compiler time in the floor).
- **The fixed part** (≈1.5 s here, ≈1.1 s on the quiet machine) by item, static-100 (CPU profile, ms here): Node and
  module loading ≈390; Vite ≈525 (config bundling and `resolveConfig`, the module runner that loads the helpers,
  emptying `dist/`; the HTML step's per-page parse is in it too); sinter ≈500, of which the fold check's analysis
  ≈110–135, the SN534 cross-check ≈120 (per page: 1.2 ms), `project()` ×4 ≈40, `pageStyles` ≈50–80, `relocateHtml`
  ≈13; GC outside the compiler ≈130; Rolldown's JS ≈100; idle ≈100.
- **What is left for a live page**: Vite's HTML step on its larger HTML (≈2 ms; the page embeds the whole post as JSON,
  the compiler's choice), its module through Rolldown (≈1.6 ms), and, when its early source is its own (a page file
  per post), one nested bundle through the shared builder (≈13 ms: live-files-100 is still 1.8 s above static-files).

## Looked at, not changed

- **`buildEnd`'s SN534 cross-check** (≈1.2 ms per page: 120–140 ms at 100 posts, 430–540 ms at 400). Its cost is the
  helper calls themselves: `md.parse(post.body)` once more per post, in a fresh copy of the helpers module, the pages
  in reverse order. That is the check: the static fold check (`fold-check.ts`) does not see state kept inside an object
  (a table of ids, a counter in a member), and only running the calls again in another order does. No call repeats
  across posts, so there is nothing to share. Running it off the main thread (a worker loading its own copy) would hide
  it only behind Rolldown's native work, of which a build has ≈100–300 ms idle; not worth the machinery. Left as is.
- **Loading the helpers module** (≈240 ms fixed). Its fold check (`foldVerdicts`, ≈110–135 ms in a build) is not
  lazily avoidable: sinter-markdown's three helpers (`headings`, `parse`, `text`) reach the same 4 modules, and a
  verdict for `parse` alone analyzes all 4 (measured: the same module count; 99 ms warm, 269 ms cold for `parse` alone
  vs 162 ms for all three after it). 60 % of it is `parseModule` (acorn) of the library's source, the rest the walk.
  It could be skipped on a warm build only with an on-disk cache of the per-module analyses (`FoldCache` already keys
  them by mtime and size; `node_modules/.cache/sinter/` holds the image and font caches): ≈110 ms per build. Not done:
  a new persistent cache is a design decision, not a fix. The other ≈115 ms is Vite's module runner loading the module
  (`resolveConfig`, `ssrTransform` of the library), which the build needs.
- **`project()`** runs 4 times per build (configResolved's content load, the template probe, `helpersReady`,
  `buildStart`): 23 + 4 + 5 + 10 ms at 100 pages. Reusing the first in the build would save ≈15 ms; `buildStart` reads
  afresh on purpose (`--watch`). Left.
- **`pageStyles`' import scan** (`styles.ts` `scan`, 30–50 ms at 100 pages): each page resolves its scripts' imports
  again to find the stylesheets they import. A per-build cache of the resolutions would save most of it (≈0.4 ms per
  page). Left for a later pass: small.
- **Vite's HTML step on live pages** (now ≈+2 ms per live page over a static one, was +3). What we cause: the live
  post is 20.3 kB against 11.3 kB static, and 8.5 kB of the difference is `<script type="application/json" data-sn>`
  holding the whole post (title and markdown body) for the page module, which reads only its slug. Vite parses every
  page twice (its transform and its generateBundle), and runs `stripLiteral` (js-tokens) over every classic inline
  script, this JSON and the Speculation Rules included (≈30 ms per 100 pages). The page's bytes are the compiler's
  (embedding only what the module reads is a compiler change, and changes the output); nothing to do here.
- **The page modules through Rolldown** (≈1.6 ms per live page): one module per page, each its own text (it carries
  its slug), and one chunk per page; we emit nothing extra per page (the head scripts are assets, not chunks). Not
  ours to cut without changing the output.
- **`vite build`'s `emptyDir`** of the previous `dist/` (58–157 ms in the bench, which rebuilds into the same folder):
  Vite's, as in Astro's builds.

### The description per page (a page file per post: 5.7–7.2 ms per page)

It cannot come from the page's own compile inside `vite.ts` alone, because every page's compile needs every page's
description first:

1. `build()` passes `prefetch: prefetchPages(group).length ? id : null`: whether any page of the group can be
   requested ahead decides whether the page module imports the prefetch module, so it is in the module's bytes;
2. each page's HTML carries the Speculation Rules (`rulesJson` → `appPages()`: every page's paths, minus
   `data-sn-prefetch="off"` pages), and its links are resolved against every page's patterns (`pageEntries()`,
   `pointLinks`, `sitePaths`, `pointLevels`), which read `describe(file).path`;
3. the prefetch and swap modules (`prefetchModule(prefetchPages())`, `swapModule(swapPages())`) need every page's
   parts, kept names and `swapOff`. These are loaded through the `load` hook, which can wait for every page as the
   site core's `FLAGS` module already does (`everyPage`).

So the description's walk could go if the compiler exposed, separately:

- **the page's paths without a walk** (its `data-sn-path`, through its layout): a cheap read the build does for every
  page up front, for (2). `describeSource` is a full compile today;
- **the cross-page facts as late-bound holes**: the prefetch import (1) and the rules JSON (2) written as placeholders
  the plugin fills after every page has compiled (as `relocateHtml` and the shared-module marks are patched in
  `generateBundle`), so a page's compile no longer needs the others' descriptions;
- **the description's fields from the real compile** (`prefetch`, `path`, `prefetchOff`, `permanent`, `keptSource`,
  `keptBound`, `swapOff`, `loadEffect`, which `CompileResult` already has) guaranteed equal to a `describeOnly`
  compile's. They come from the second pass there, the description from a first pass that leaves out definitions that
  describe nothing; an audit like the probe's (section 3) would have to show they agree, and the prefetch and swap
  modules would wait for every page.

That is the compiler redesign's (compile-units' stage 3: one walk per page) to provide.
- **Tried and dropped: caching `pageStyles`' resolutions** for the build (each page resolves the app modules'
  imports again): no measurable change (the profiles' `scan` and `stylesOf` time 78–79 ms before, 59–106 ms after).
