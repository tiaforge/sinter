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
