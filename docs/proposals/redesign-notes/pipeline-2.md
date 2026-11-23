# Build pipeline, round 2: the fixed part, and a static page outside the compiler

Running log (2026-11-23). Goal ([compile-units.md](../compile-units.md); round 1 in [pipeline-fixes.md](pipeline-fixes.md)):
what a build costs outside the compiler, the fixed part of every build and the per-page cost of a static page, measured
on a quiet machine, then cut where the output stays byte for byte the same.

## Where it stands

- Measured (below): on this machine sinter's static blog at 100 posts takes 2.33 s (wall, process start to exit), Astro
  1.65 s. sinter's **fixed part is not the gap**: ≈1.1 s, against Astro's ≈1.35 s. The gap is per page: sinter
  12.2 ms a page (wall, 100→400), Astro ≈4 ms. Of sinter's 12.2 ms, ≈7 are the compiler's, ≈5 outside it.
- Fix 1 in: SN521's scan of the page modules (quadratic with a page file per post): −1.2 s at 1,000 page files.
- Fix 2 in: `pageStyles` scans each module's text for its imports once, not once per page: −0.33 ms a page.
- Next: the cross check (SN534), then the write-ups (Vite's HTML step, the fold check's cache).

## How it is measured

- The machine: 4 cores, nothing else running (load < 0.3 before each series). Node 22.23, Vite 8.3.5, Astro 7.4.13.
- **Wall time**: `node bench/astro/run-sinter.mjs <app>` from process start to exit (`wall.sh`), and the in-process
  figure it prints; Astro's is a whole process (`measure.mjs --only astro`, its caches removed before each run).
  The tables give **wall time** unless marked, so sinter and Astro compare like for like. `run-sinter.mjs` imports Vite
  in the process, so its in-process figure leaves out Node's start and the import of Vite (≈150 ms).
- Node's compile cache: Astro's CLI turns it on (`module.enableCompileCache()`, not under `CI`); so does Vite's CLI
  (`vite build`), `run-sinter.mjs` does not. Measured: Astro 1.65 s with it, 1.85 s without (`CI=1`); sinter via
  `vite build` 2.23 s with it, 2.25 s without. So it is worth ≈0.2 s to Astro and nothing measurable to sinter; the
  tables use each tool as a user runs it (Astro's CLI; sinter's `run-sinter.mjs`, which is within 0.1 s of `vite build`).
- **The floor** and the owners: `node --cpu-prof --cpu-prof-interval 500` of one `run-sinter.mjs` build, read by `own.mjs`:
  compile = samples under `compile` (dist/compiler/index.js), GC between two compile samples counted as the compiler's,
  floor = the rest. Each other sample goes to the first frame from the leaf that belongs to sinter (dist/, not under
  `compile`), the helpers (sinter-markdown), Vite (split by the functions on the stack: the HTML step, the module runner,
  the config file, `resolveConfig`, `emptyDir`), Rolldown's JS, or Node's module loader. Libraries a frame calls (acorn,
  parse5) count as their caller's.
- **Byte identity** (`snap.sh <label>`, `cmp.sh base <label>`): the five bench apps at 100 and static/static-files at
  400, `scripts/baseline.mjs --keep` (the four examples, swap-csp, vite-i18n, axes), `scripts/mail-audit.mjs`'s 48 files
  (both of its builds); every file diffed (names, hashes in names, bytes); and the log lines at `info` and `warn` of
  realworld, dashboard, static-site, multilingual-site, sinter-live-100 and sinter-static-100, each build's lines sorted
  (the HTML step runs pages concurrently), durations masked. The snapshot before any change is `base` (HEAD `d64bc0b`).
- Scripts in the session's scratchpad (`snap.sh`, `cmp.sh`, `logs.sh`, `wall.sh`, `ab.sh`, `own.mjs`, `cat.mjs`,
  `prof.mjs`); the apps in `bench/astro/out/` (also `sinter-static-1000`, `sinter-static-files-1000`).

## The measured breakdown (before any change)

### Wall time, sinter against Astro

| app | n=10 | n=100 | n=400 | fixed | per page (100→400) |
| --- | ---: | ---: | ---: | ---: | ---: |
| sinter static (wall; in-process in brackets) | 1.23 s (1.09) | 2.33 s (2.18) | 5.98 s (5.80) | ≈1.11 s | 12.2 ms |
| Astro (its CLI, compile cache on) | 1.39 s | 1.65–1.86 s | 3.04 s | ≈1.35 s | 3.9 ms |

Medians of 3. Astro's own log at 100 / 400 posts: content sync and types 0.89 / 1.71 s (its markdown parse, ≈2.7 ms a
post), static entrypoints (Vite) 0.17 / 0.32 s, generating the routes 0.16 / 0.46 s (≈1 ms a page), "101 pages built in
1.33 s" / "401 in 2.64 s"; the rest of the wall time (≈0.4 s) is Node's start and loading Astro. So Astro is ≈0.9 s
fixed inside its build plus ≈0.45 s of start, and ≈4.4 ms a page, 2.7 of it parsing markdown.

### The floor (the build with the compiler free), CPU profile, one run each

| app | total | compile + its GC | floor | floor per page |
| --- | ---: | ---: | ---: | --- |
| static-10 | 1,388 ms | 450 | **938** | |
| static-100 | 2,778 | 1,230 | **1,549** | 6.8 ms (10→100) |
| static-400 | 6,599 | 3,605 | **2,994** | 4.8 ms (100→400) |
| static-1000 | 14,242 | 8,174 | **6,069** | 5.1 ms (400→1000) |
| static-files-100 | 3,051 | 1,562 | 1,489 | |
| static-files-400 | 8,973 | 5,085 | 3,888 | 8.0 ms (100→400) |
| static-files-1000 | 23,371 | 11,166 | 12,205 | 13.9 ms (400→1000): grows with n |

### The fixed part, by owner (static-10, ms; the whole floor less ≈10 pages)

| owner | ms | what |
| --- | ---: | --- |
| Node: module loading | 263 | Node's start, Vite (55 modules, ≈100 ms), the plugin (221 modules, ≈110 ms: 73 of sinter's, css-tree's 123 ≈40 ms, parse5, acorn, acorn-typescript, yaml; all used by a static build), the config file |
| Vite: the module runner | 112 | the helpers module and, at the end, its fresh copy (`ssrTransform` of sinter-markdown, run inline) |
| sinter: the fold check | ≈110 | `foldVerdicts` inclusive (acorn's parse of the helpers' modules, the walk); cached for the fresh copy |
| Rolldown's JS | 69 | its plugin dispatch |
| GC (outside the compiler) | 67 | |
| Vite: the HTML step | 50 | ≈10 pages |
| Vite: `resolveConfig` and the rest | ≈60 | the build's, the helpers' runner's, the fresh copy's |
| sinter: `project()` | 35 | 4 calls (configResolved twice, the probe, buildStart) |
| SN534's cross check | 32 | the fresh copy's calls (10 posts) |
| sinter: the rest of the plugin | ≈60 | `vite.js`, `components-build.js`, `head.js`, `styles.js` |
| idle / program | 56 | |

Measured apart: the plugin's import is 110 ms (Vite's 100); the helpers' fresh copy at the end of a build is ≈60 ms
warm (`loadHelpers({ fresh: true })`, the fold check cached) and the first copy 350 ms cold (with the fold check and
Vite's imports).

### Per static page outside the compiler (ms a page, from 400 and 1,000 pages)

| item | static 100→400 | static 400→1000 | static-files 400→1000 | what |
| --- | ---: | ---: | ---: | --- |
| Vite's HTML step | 1.0 | 0.9 | 4.2 | `traverseHtml` (parse5) of every page in its transform; its `generateBundle`, which looks each page's chunk up with `Object.values(bundle).find` (quadratic: 56 ms at 400, 373 at 1,000) |
| SN534's cross check | 0.8 | 0.8 | 0.6 | every post's `md.parse` again (≈60 % of it), the memo's `freeze` of the result (20 %), `resultKey` and the hash (15 %) |
| GC outside the compiler | 0.9 | 1.4 | 3.8 | |
| `pageStyles` | 0.5 | 0.3 | 0.5 | the regex scan of the helpers' import tree, per page (sinter-markdown resolves outside `node_modules`, so its parser's source is scanned on every page) |
| Rolldown's JS | 0.4 | 0.2 | 0.5 | |
| sinter's plugin (`vite.js`) | 0.3 | 0.4 | 2.2 | static-files: SN521's scan, quadratic (fix 1) |
| other (page-urls, head, program) | ≈0.6 | | | |

Static-files pages also grow with n: each page's Speculation Rules list every page (58 kB a page at 1,000 posts against
15.7 kB at 100), which is what makes Vite's HTML step and GC grow there. That is the page's bytes (the rules' JSON,
`rulesJson`): left, see below.

## Fix 1: SN521's scan, one pass per page module

`sinter:pages`' `generateBundle`, for every page that moves (`blog/post-1.html` → `blog/post-1/index.html`: every page
of a site with a file per page), built a `RegExp` for every page and tested it on that page's module (empty for a
static page): n² patterns. Now every module is read once for every page file it names (`filesNamed` in
`src/page-urls.ts`: at each quote followed by the base's path and `/`, the names in the page list that end where the
pattern's lookahead allows), the first time a page moves, and each moved page reports the modules that name it, in the
same order. Test: `test/vite/files-named.test.ts` (the old pattern as the oracle, on cases and 300 random ones).

| sinter's `generateBundle` (self time, CPU profile) | before | after |
| --- | ---: | ---: |
| static-files-100 | 21 ms | – |
| static-files-400 | 192 ms | < 9 ms |
| static-files-1000 | 1,174 ms | < 27 ms |
| floor, static-files-1000 | 12,205 ms | 10,954 ms |

Byte identity: every file of the bar, and the log lines, the same as `base`.

## Fix 2: `pageStyles`' scan, each module's import list once

For the box sizes of images and lists, every page's stylesheets are collected (`pageStyles`, `src/styles.ts`), with the
CSS the app's modules import: from the config, the early module, the helpers and the actions module, each module's
imports are followed through the project's own files. Each page ran the comment-stripping regex and the import regex
over every one of those modules again. On the blog, `src/sinter.helpers.ts` re-exports sinter-markdown, which resolves
to a folder outside `node_modules` (a workspace link, as in the benchmark), so every page scanned the markdown parser's
whole source. The import list is now kept by the module's file while its text is the same string (`read` already keeps
the text by mtime), and the resolution of each import still runs per page (its importer may differ). Test:
`test/vite/page-styles-scan.test.ts` (two pages, the same stylesheets; the module edited, the new order; a page's own
module script scanned as it is).

| `pageStyles` and `styles.ts` (CPU profile, outside the compiler) | before | after |
| --- | ---: | ---: |
| static-100 | 60 ms | 26 ms |
| static-400 | 213 ms | 82 ms (−0.33 ms a page) |

Byte identity: every file of the bar, and the log lines, the same as `base`.

## Looked at, not changed (so far)

- **Node's compile cache**: nothing measurable for sinter (above).
- **Lazy imports of what a static build does not use**: every module the plugin loads is used by the static blog's
  build (css-tree by the components' styles, yaml by the posts' front matter, acorn-typescript by the helpers' fold
  check); `check/` is imported by `project.js` and `components-build.js` for `typeExports`, a few ms.
