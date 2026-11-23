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
