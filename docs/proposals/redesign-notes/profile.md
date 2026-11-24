# Build cost model (profile notes)

Measurement notes for the compiler redesign: where a `vite build` of the bench/astro apps spends its time, split
into fixed and per-page cost, by compiler pass, and outside the compiler. Static and live pages. All builds
`typecheck: false` unless marked `-tc`. Measured 2026-11-23 against the dist/ build in the tree at that time, Node
22.23, Vite 8.3.5, Rolldown 1.2.16, TypeScript 7.0.2, on a 4-core machine.

## How it was measured

- **Apps**: `writeSinterApp` into `bench/astro/out/` (git-ignored): `sinter-{static,live}-{10,100,400}`,
  `sinter-{static,live}-files-{10,100}`, and `sinter-static-{,files-}{10,100}-tc`. Every post has the same size
  (about 8.3 kB of markdown, 1,300 words, 420 nodes), whatever `n` is.
- **Wall time** (`plain`): `node bench/astro/run-sinter.mjs <root>`, one fresh process per build, one build at a time.
  The machine was shared. Another agent's vitest used 150–330 % CPU for part of the session. I ran every plain build
  again once the machine was idle, and the tables use the median of 2–4 runs (n=400 and `-tc`: the faster of 2).
  Runs vary by ±8 % even on an idle machine.
- **Phase timing and call counts**: a preload (`--import instr.mjs`) and an ESM load hook (`hooks.mjs`). The hook
  rewrites a few dist modules in memory as they load. Nothing on disk changes. It wraps the top-level functions
  `compile`, `compileParts`, `compilePasses`, `fromTemplate`, `keepTemplate`, `analyze`, `check`, `shadowOf`,
  `parseDocument`, `recordChild`, `replay` and others. It also appends `globalThis.__snHook(Compiler)` to
  compile.js, so the preload can wrap `Compiler.prototype` methods, and it wraps Vite's `build` export, so nested
  `vite.build` calls are timed.
  Each wrapped call is counted and labelled with its pass. A compiler whose `opts` carry `decided`, `unrolled` or
  `constants` is pass 2. `decideFor`, and a `walkPage` reached through `keepTemplate`, are pass 1. A call reached
  through `compile({describeOnly})` is `describe`. A method's time is counted only at its outermost call, so it is
  inclusive. Times are wall time and include the GC pauses that land inside them.
  - `time` mode times about 100 methods and adds 5–10 % to a build. `count` mode counts every Compiler method and
    adds about 25 %. Its counts are exact; ignore its times.
  - GC pauses come from a `PerformanceObserver('gc')`, matched against the time intervals of the `compile()` calls.
- **CPU profiles**: `node --cpu-prof`. Every sample is put into one category by the frames on its stack:
  compile(build), compile(describeOnly), check, helpers load, Vite build-html, sinter plugin, Rolldown JS side,
  module loading, GC, idle. Samples are also split into time windows between Vite hook marks. The marks come from
  two no-op plugins (`enforce: 'pre'` and `'post'`) passed inline by a copy of run-sinter (`run.mjs`).
- Scripts, raw JSON and profiles are in
  `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/profile-agent/`:
  `instr.mjs`, `hooks.mjs`, `run.mjs`, `an.mjs` (phase report), `table.mjs`, `prof2.mjs` (categories and windows),
  `q.mjs` (time under a stack pattern), `win.mjs`, `floor.mjs`, `res/*.json`, `prof/<app>/`.

## 1. Fixed vs per-page cost

Wall time in seconds (median of the plain runs), and a least-squares fit of `fixed + per-page × n`:

| app | n=10 | n=100 | n=400 | fixed | per page |
|---|---:|---:|---:|---:|---:|
| static (template) | 2.52 | 11.73 | 45.1 | **1.14 s** | **110 ms** |
| live (template) | 2.93 | 14.68 | 56.0 | **1.33 s** | **137 ms** |
| static-files | 2.87 | 15.90 | – | **1.42 s** | **145 ms** |
| live-files | 3.16 | 17.63 | – | **1.56 s** | **161 ms** |
| static `-tc` | 2.95 | 12.98 | – | 1.83 s | 112 ms |
| static-files `-tc` | 3.24 | 21.48 | – | 1.22 s | 203 ms |

- Per-page cost is linear from 100 to 400 pages: static 102 ms/page (10→100) vs 111 ms/page (100→400), live 131
  vs 138. The small rise comes from GC on a bigger heap (max RSS 560 → 900 MB static, 680 → 1,450 MB live) and from
  the early-script builds (section 7).
- On these numbers, Astro's whole build (2.4–2.9 s) costs about what sinter's fixed cost plus 10–15 pages does.

## 2. Where the fixed cost goes

This is the CPU profile of `sinter-static-10` (2.71 s), cut into windows between Vite hook marks.
`sinter-live-files-10` is shown where it differs.

| window | wall ms | what it is |
|---|---:|---|
| process start → `vite` imported | 157 | Node boot and importing Vite and Rolldown (99 ms in the module loader) |
| → config loaded | 140 | Vite bundles and loads `vite.config.js`, which imports the sinter plugin's dist modules (97 ms module loading) |
| → `configResolved` | 28 | `project()`, the project read (18 ms; 30–37 ms over its 3–4 calls in a build) |
| → `buildStart` | 514 | **helpers module ≈ 240 ms**: `loadHelpers` 121 ms (sync part, almost all `fold-check` `analyze` of the helpers' exports) plus about 115 ms of Vite's module runner (`ssrTransformScript`, inlined evaluation of sinter-markdown). **Template probe compile 116 ms** (`templateOf` from `pagesInputs` in `configResolved`: a full `compile` of `blog/post.html` to find its entries; template apps only). Module loading 42, Rolldown setup 33, GC 27, idle 21 |
| → first `transformIndexHtml` | 305 | the first page compile, cold JIT (234 ms; the first `compile()` takes 137–336 ms against 110–150 steady), and `describe` (19 ms template; 146 ms in live-files-10, where all 11 pages are described up front, the first in 64 ms) |
| page loop | – | per page (sections 3–4) |
| last page → `buildEnd` | 150 | `buildEnd`'s SN534 `crossCheck`: a fresh copy of the helpers module loaded again, and **every post's markdown parsed again** (about 1.2 ms/page, linear: 121 ms at 100 pages, 453 ms at 400) |
| `buildEnd` → done | ~50 | render, `generateBundle`, write. Static: tiny. Live: see section 7 |

- **TypeScript is never loaded into the build process.** With `typecheck: true` the plugin spawns `tsc` as a child
  process in `buildEnd` (`spawnSync`). That costs 200–210 ms for the template app (2 shadow units) and 3.3 s for
  101 shadows (section 5).
- **File writes** are negligible: `writeBundle` → done is under 10 ms static and under 50 ms for 400 HTML pages.
- Of the ~1.1 s fixed cost in this tree, the parts the compiler owns are: the template probe compile (≈120 ms), JIT
  warm-up of the first page (≈100–200 ms more than a steady page), the helpers' fold check (≈120 ms), and the
  crossCheck's fixed part. Vite and Node (boot, config, module runner, Rolldown setup) are ≈500 ms, which we cannot
  avoid.

## 3. Per-page cost by phase (n=100)

### `Compiler.run` calls per page

These counts come from the instrumentation (exact), not from profile estimates.

| app | build `compile()` calls | `Compiler.run` per page | `walkPage` per page | describe compiles |
|---|---|---|---|---|
| static / live (template) | 103: 100 entries + index + 2 probe (`templateOf`) | **1** (pass 2) + **1 `decideFor`** (pass 1 evaluation only: the template's pass 1 is walked **twice for the whole build**, by `keepTemplate` and its check of a second entry) | 1 | 2 for the whole build |
| static-files / live-files | 101 | **2** (pass 1 and pass 2: `compilePasses`) | 2 | **101**: one `describeOnly` compile (another walk) per page |

So a page in the files apps is walked **3 times** (pass 1, pass 2, describe). A template entry is walked **once**
(pass 2) and evaluated once more (`decideFor`).

### Inclusive ms per page

`time` instrumentation, quiet machine. The numbers are wall time and include the GC that lands inside each phase.
Indented rows are part of the row above them.

| phase (ms/page) | static | live | static-files | live-files |
|---|---:|---:|---:|---:|
| p1: template walk (`keepTemplate`), amortized | 0.8 | 0.8 | – | – |
| p1: `walkPage` | 2.0¹ | 1.8¹ | 10.7 | 11.7 |
|   p1: `definition` (shared definitions) | 1.1¹ | 0.8¹ | 4.7 | 5.0 |
|   p1: `replay` (linked definitions) | – | – | 3.3 | 3.5 |
| p1: `finishPage` | 0.3¹ | 0.3¹ | 23.8 | 23.5 |
| p1: `decideFor` (entry re-evaluation) | 18.7 | 17.0 | – | – |
|   p1: `prerender` (in `finishPage` / `decideFor`) | 18.6 | 16.9 | 17.5 | 17.3 |
| **pass 1 total** | **≈19.5** | **≈18** | **≈34.5** | **≈35** |
| p2: `walkPage` | 86.3 | 87.5 | 94.2 | 92.2 |
|   p2: `expandConstants` | **48.4** | 49.0 | 54.2 | 52.3 |
|     p2: `inlineInstance` | 24.0 | 23.7 | 25.6 | 25.2 |
|     p2: `cloneTree` | 13.3 | 13.8 | 15.8 | 14.6 |
|   p2: `walkChildren` (element, bindings, expr) | 29.5 | 30.0 | 31.8 | 32.2 |
|     p2: `expr` | 11.1 | 11.7 | 13.0 | 12.5 |
|   p2: markup `minify` | 3.7 | 4.1 | 3.9 | 3.2 |
|   p2: parse5 `parseDocument`, Layout, images, declare, resolveSources | < 1 together | | | |
| p2: `finishPage` | 4.6 | 6.3 | 5.8 | 6.6 |
|   p2: `prerender` | 3.6 | 4.7 | 4.9 | 5.0 |
| **pass 2 total** | **≈91** | **≈94** | **≈100** | **≈99** |
| `compile()` build, total | **113.2** | **114.9** | **135.2** | **134.9** |
| `compile()` describeOnly | 0.3 | 0.4 | **5.7** | **7.2** |
| GC inside `compile()` (included above) | 19.0 | 19.4 | 22.1 | 21.4 |

¹ The 3 non-template compiles (2 probe compiles and the index page) divided by 100. They are not per-entry work.

The CPU profile of the same apps agrees. It excludes GC from each frame and has no instrumentation overhead. For
static-100 it gives: compile 8.9 s; p2 `run` 7.1 s, of which `walkPage` 6.4 s, `expandConstants` 3.7 s,
`inlineInstance` 1.8 s, `cloneTree` 1.0 s, `walkChildren` 2.1 s, top-level `expandComponents` (the one not under
`expandConstants`) only 0.2 s, `finishPage` 0.45 s; p1 `decideFor` 1.7 s; `analyze` (all) 0.56 s; markdown `parse`
inside compile 0.28 s.

### The whole build per page (n=100, CPU profile, ms/page)

| | static | live | static-files | live-files |
|---|---:|---:|---:|---:|
| compile (build), excluding GC | 89 | 98 | 111 | 119 |
| compile (describeOnly), excluding GC | 0.3 | 0.3 | 5.8 | 6.5 |
| GC (90–94 % of it inside compile) | 21 | 23 | 25 | 29 |
| everything else (Vite, Rolldown, plugin, idle) | 14 | 36 | 18 | 38 |
| of which fixed (section 2), amortized over 100 pages | ≈9 | ≈10 | ≈10 | ≈11 |

## 4. Per-instance work (exact counts per page, n=100, `count` mode)

A post renders 244 component uses (`expandUse`) and 96 recursion points (markdown nodes, `inlineInstance`). Its
pass 2 clones about 6,000 nodes. Template apps: pass 1 is the template's, walked twice for the whole build, so its
per-page share is under 10 for every row. The `p1 (tpl)` column is that, per page. The columns are the same for
static and live apart from the live section's +10 elements and +15 fns.

| call | static p1 (tpl) | static p2 | files p1 | files p2 | files describe |
|---|---:|---:|---:|---:|---:|
| `expandUse` | 1 | **244** | 5 | 244 | 4 |
| `expandComponents` | 7 | **1,616** | 27 | 1,615 | 21 |
| `inlineInstance` | 0 | **96** | 0 | 96 | 0 |
| `cloneTree` (nodes cloned) | 4 | **5,964** | 4 | 5,964 | 0 |
| `element` | 9 | **413** | 32 | 412 | 23 |
| `bindings` | 3 | 455 | 22 | 455 | 18 |
| `expr` | 9 | **792** | 27 | 792 | 10 |
| `analyze` | 16 | **1,076** | 48 | 1,076 | 14 |
| `parseExpression` | 17 | 1,358 | 135 | 1,358 | 22 |
| `fn` | 3 | **326** | 171 | 326 | 6 |
| `definition` / `recursionPoint` | 5 / 5 | 0 / 0 | 13 / 13 | 0 / 0 | 0 / 8 |
| `componentFile` | 55 | **13,425** | 551 | 13,414 | 691 |
| `libOfFile` / `crossesPackage` | 3 / 1 | 908 / 494 | 12 / 5 | 908 / 494 | 10 / 4 |
| `Layout` methods | 10 | 8,615 | 562 | 8,597 | 0 |
| `tag` (origins) | 14 | 3,653 | 75 | 3,652 | 62 |
| pass-1 evaluation keys: `siteKey`, `instKey`, `choiceKey`, `stateSites` | – | 1,650 / 1,406 / 912 / 0 | 1,498 / 1,472 / 912 / 1,406 | | |

What the counts show:

- **Pass 1 is cheap because it shares definitions.** A post's pass 1 expands 5 uses and walks 32 elements. Its
  evaluation (`prerender`, about 18 ms) visits every instance by key: about 1,400–1,500 `instKey`/`siteKey` calls
  and 1,400 `stateSites` calls.
- **Pass 2 undoes the sharing.** It expands every instance as markup: 244 `expandUse`, 96 `inlineInstance`, 6,000
  cloned nodes and 1,600 `expandComponents` calls. Then it walks the result again: 413 elements, 792 `expr`, 1,076
  `analyze`, 326 `fn`. All of this is for a page that ends up static. Measured per call: `expandConstants` ≈ 0.5 ms
  per instance, `cloneTree` ≈ 2.2 µs per node, `expr` ≈ 14 µs, `element` ≈ 70 µs inclusive.
- `componentFile` is called **13,400 times per page** in pass 2, 55 times per use. That is 4–6 ms/page in profiles,
  from lookups that could be resolved once per use. The same goes for `libOfFile` (908) and `crossesPackage` (494,
  ≈1.4 ms/page).
- In files apps, pass 1 creates **171 `fn` per page**, against 3 per entry in the template app (linked definitions'
  replays).

## 5. Type checking on

| | typecheck off | `typecheck: true` | added |
|---|---:|---:|---:|
| static (template), n=100 wall | 11.73 s | 12.98 s | **+1.25 s** |
| static-files, n=100 wall | 15.90 s | 21.48 s | **+5.6 s** |
| static, n=10 / static-files, n=10 | 2.52 / 2.87 s | 2.95 / 3.24 s | +0.43 / +0.37 s |

Where the added time goes (`time` instrumentation):

| | static-100-tc | static-files-100-tc |
|---|---:|---:|
| `check()` in `buildEnd` (all) | 213 ms | **4,000 ms** |
|   `shadowOf` (writing shadow TS per unit) | 17 ms (2 units) | 719 ms (101 units, 7.2 ms each) |
|   `tsc` child process (spawnSync) | ≈195 ms | **≈3,280 ms (≈33 ms/page)** |
| compile per page, `check` collection on (vs off) | 127.0 (113.2): **+14 ms** | 157.6 (135.2): **+22 ms** |
|   of which pass-1 `walkPage` | 1.8 (2.0) | **29.0 (10.7): +18 ms** |
|   of which pass-2 `walkPage` | 98.1 (86.3): **+12 ms** | 96.2 (94.2): +2 ms |

- **Template app**: `fromTemplate` keeps the check of the template's first pass only once per template. But every
  entry's pass-2 compiler still gets `opts.check` and collects its frames and expressions, which are then thrown
  away (`const { check: _, ...rest } = out`). That waste is ≈12 ms/page, about 1.2 s of the 1.25 s added.
- **Files app**:
  - Pass 1 under `check` does not share definitions. `definition` goes from 4.7 to 22.9 ms/page, and
    `expandComponents` calls from 27 to 337 per page.
  - Then `tsc` checks 101 near-identical shadows: 3.3 s, the biggest single item.
- Compiler collection costs ≈1.6–2.2 s per 100 pages; `tsc` costs ≈0.2 s per template, or ≈33 ms per separate page.

## 6. The floor: the build with `compile` free

Floor = CPU-profile total − compile(build) − compile(describeOnly) − the GC inside compile. The GC share is measured
per app with the GC observer: 74–81 % at n=10, 89–97 % at n≥100. The profiled totals are within a few % of the
plain medians.

| app | n=10 | n=100 | n=400 | floor fixed | floor per page |
|---|---:|---:|---:|---:|---:|
| static | 0.99 s | **1.53 s** | 3.43 s | 0.92 s | **6.3 ms** |
| live | 1.39 s | **3.88 s** | 13.8 s | ≈1.1 s | **28 ms** (10→100), **33 ms** (100→400) |
| static-files | 1.18 s | **1.98 s** | – | 1.09 s | **8.9 ms** (describe's walk counted as compile) |
| live-files | 1.43 s | **4.11 s** | – | 1.13 s | **30 ms** |

- **Static pages: the floor is 1.5 s at 100 pages**, which leaves ≈1 s of Astro's ≈2.5 s for the compiler. That is
  ≈10 ms per page including its GC, against 113 today. At 400 pages the floor is 3.4 s.
- Per-page non-compile cost **scales linearly from 100 to 400 pages** (static 6.0 → 6.3 ms/page). Nothing outside
  the compiler is quadratic for static pages (live pages grow 28 → 33 ms/page, section 7), with one exception: `sourceEntries()` in files apps (below).
- Outside the compiler, per static page:
  - **Vite build-html** ≈2 ms/page: parse5 `traverseHtml` of each emitted page, 201 ms at 100, 657 ms at 400.
  - `crossCheck` re-parsing markdown ≈1.2 ms/page.
  - Plugin `compileHtml` around the compile (`relocateHtml`, `pageStyles`/`stylesOf`, prefetch rules) ≈1–2 ms/page.
  - Rolldown and writing < 1 ms/page.
  - **Minification:** markup minify is inside the compiler (3.5–4 ms/page in pass 2). Vite/Rolldown JS minify is
    under 25 ms per build.
- Files apps add ≈1.3 ms/page for `entries()`/`sourceEntries()`: 125 ms at 100 pages, called per page from
  `prefetchPages`. This is likely O(n) per call, so O(n²) per build, and should be measured at 400 before relying
  on it. They also add `describe` (≈6 ms/page, counted as compile here).
- **Nothing outside the compiler matters on its own for static pages. For live pages it does: the floor is already
  3.9–4.1 s at 100 pages, more than Astro's whole build**, even with a free compiler (section 7).

## 7. Live pages

The extra cost of a live page **is not in the compiler.** Compile per page is 114.9 ms live vs 113.2 static
(template), and 134.9 vs 135.2 (files). Pass 2's `finishPage` grows by 1.7 ms (prerender of the runtime parts,
`earlyParts` 0.3, `injectScript` 0.1), and pass 1 is the same. The prefetch descriptions cost 0.4 ms/page for a
template app (2 describe compiles for the build) and 7.2 ms/page for files apps (101 describe compiles, the
`describeOnly` walk).

The live page's cost outside the compiler (live-100 minus static-100 floor: 3.88 − 1.53 = **2.35 s = 23.5 ms/page**):

| item | live-100 | per page | at 400 |
|---|---:|---:|---:|
| **Early script: one nested `vite.build()` per page** (`earlyScript` in sinter's `generateBundle`: `resolveConfig`, plugins, Rolldown build), plus one for the shared head | **1.50 s** (101 builds; first 33 ms, then 12–16 ms) | **15 ms** | 7.3 s / 401 = 18 ms |
| Vite build-html: more markup per page (parse) and the `post` `transformIndexHtml` injecting scripts and modulepreloads | 508 vs 201 ms static | **+3.1 ms** | 1.08 s + 0.88 s |
| `reportRuntime`: gzips every page chunk to log its size, also at `logLevel: 'warn'` | 102–158 ms | **1.0–1.5 ms** | 451 ms |
| Main Rolldown: transforming and rendering the 100 page modules and chunks (`renderStart` → first nested build) | ≈160 ms | **1.6 ms** | – |
| main thread idle or `(program)` while Rolldown works natively | ≈300 ms | ≈3 ms | 1.7 s idle |

- `resolveConfig` alone is 250–280 ms of the nested builds at 100 pages (870 ms at 400): `searchForWorkspaceRoot`
  and `loadEnv` `access` calls per build. Rolldown's JS-side setup (`bindingifyPlugin`, `#build`) is ≈450 ms.
- **The page module through Rolldown is cheap (≈2 ms/page). The early script's per-page `vite.build` is the cost:
  ≈15–18 ms/page, about two thirds of the live overhead.** One Rolldown build with every page's early entry as an
  input, or no bundler for a file that only imports the shared runtime, would bring the live floor to ≈1.8–2 s at
  100 pages.

## What this implies

1. **The compiler is 75–85 % of every build, and pass 2 is 80 % of the compiler.**
   - Pass 2 costs 86–94 ms/page: about half expanding constant component trees per instance (`expandConstants`,
     `inlineInstance`, `cloneTree`: 6,000 nodes cloned per page), and about a third walking that markup again
     (`walkChildren`: 413 elements, 792 expressions, 1,076 `analyze` calls).
   - Pass 1 is 18 ms/page (template) or 35 ms/page (files), and most of that is the evaluation (`prerender`), not
     the walk.
   - A design that writes a static instance's markup straight from its shared definition and the evaluated values,
     without expanding, cloning and walking it again, removes most of the 110 ms. Pass 1's evaluation (18 ms) is
     then the next floor.
2. **GC is a fifth of the build** (19–22 ms/page, 90 %+ inside compile). It comes from cloned trees, per-instance
   maps (`origins`, `rowOf`, `instAt`, …) and expression ASTs. It will shrink with pass 2, not separately.
3. **Budget.** At 100 posts, the static floor is 1.5 s. Matching Astro's ≈2.5 s needs compile + GC ≤ ≈10 ms/page.
   Matching it at 400 posts needs ≤ ≈2–3 ms/page, on top of a 3.4 s floor that is already above Astro's 100-post
   time. Fixed cost (≈1.1 s, of which the compiler owns ≈0.3–0.4 s: probe compile, JIT warm-up, fold check) is not
   the problem.
4. **Live pages need work outside the compiler.**
   - One `vite.build` per page for the early script costs 15–18 ms/page. That alone is ≈1.5 s per 100 pages, more
     than the whole static floor.
   - `reportRuntime`'s gzip at `warn` level (≈1–1.5 ms/page) is pure waste.
   - Fix both, or live pages stay above Astro whatever the compiler does.
5. **Files apps walk each page 3 times** (pass 1, pass 2, describe). The describe walk (6–7 ms/page) and
   `sourceEntries()` (≈1.3 ms/page, probably O(n²)) should go when one compile serves both.
6. **Type checking:**
   - Template app: stop collecting `check` data in every entry's pass 2 (≈12 ms/page, thrown away).
   - Files apps: keep shared definitions under `check` (+18 ms/page now), and don't hand `tsc` one shadow per
     identical page (3.3 s per 100 pages).
7. **Small things worth taking with the redesign:**
   - `componentFile` is called 13,400 times per page (55 per use).
   - `crossCheck` parses every post's markdown again (≈1.2 ms/page).
   - The template probe compile in `configResolved` (≈120 ms) only reads the entry list.
