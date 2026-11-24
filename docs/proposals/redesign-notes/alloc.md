# What a build allocates and what it keeps per page

The coordinator's item of 2026-11-24 (compile-units.md, status log, 00:20 entry): garbage collection and memory, the
largest cost nobody owned. Branch `redesign/alloc`, base `f395fa2` (the integration branch).

## Where it stands

- **Step 1 (retention) done, as findings; no code change kept.** The "0.7 MB a page" of peak memory is not memory
  the build keeps: after a forced collection the JS heap is 58 / 79 / 115 MB at 100 / 400 / 1,000 posts (static), about
  0.06 MB a page. Peak RSS is about 250 MB of process, Rolldown and code plus V8's heap at its high-water mark, and V8
  lets the old generation grow to about 4.4 times what was live after each mark-compact before it runs the next (3 of
  them in the 400-post build). So every MB that is live when a mark-compact runs costs about 4 MB of peak, and a build
  that ends before reaching the next limit peaks lower: that, not retention, is the slope from 100 to 400 posts.
- **Step 2 (allocation), first milestone**: attributed (below: 3.83 GB at 400 posts, 9.6 MB a page; 46 % of it is not the
  compiler's: markdown-it and sinter-markdown's tree, Vite's parse5, the SN534 cross check), and five local cuts in the
  compiler, byte-identical: 3,831 → 3,572 MB (−6.8 %); the GC's pauses −2 to −8 %, time and peak memory within noise.
  The compiler's own allocation is spread: the largest left is the first pass's rendered rows as DOM (≈0.8 GB, 2 MB
  a page), which is stage 6's ground (rows as text, assessed there).
- **Next**: what else is cheap in the compiler's share (iterators of Maps and Sets in the walk, `copyState`'s copy);
  the findings for the owner are in "Decisions for the owner" below.
- sinter-mail could not be attached in this session (the `add_repo` call was refused by the session's permission
  check); its audit is not run yet. Reported to the coordinator.

## How it is measured

Tools in `bench/tools/mem/` (plain Node scripts, as the rest of `bench/tools/`):

- `memrun.mjs <checkout> <app>`: a build in process with a probe plugin (`enforce: 'pre'` and `'post'`), at
  `buildStart`, every 100th HTML transform, `buildEnd`, `renderStart`, `generateBundle` (pre and post), `writeBundle`,
  `closeBundle` and the end: two forced collections, then `process.memoryUsage()`, `v8.getHeapStatistics()`, and
  (`MEM_SMAPS=1`) `/proc/self/smaps` by kind of mapping; `MEM_SNAP=<points>` writes heap snapshots there.
- a preload wrapping `compile()` (as `bench/tools/instr.mjs` does) for memory after every k-th compile, and snapshots
  after given compiles; `born.mjs <a> <b>`: objects alive at one snapshot and gone at the other (snapshot ids are
  stable within a process), by type and retainer path; `ret.mjs`, `root1.mjs`: retainer chains of a kind of object.
- `heapprof.mjs`: the sampling heap profiler through `node:inspector` over the whole build, with
  `includeObjectsCollectedByMajorGC` and `includeObjectsCollectedByMinorGC` (`HP_MAJOR_ONLY=1`: only the first, so
  what survives the young generation); `hpsum.mjs` by function (a builtin charged to its caller), file or inclusive
  frame; `hpratio.mjs` the share of each function's allocation that reached the old generation.
- `--trace-gc` summed by kind (`gcsum.mjs`); `--trace-gc-nvp` for each scavenge's bytes promoted.

Machine: 4 cores, 16 GB, Node 22.23, the benchmark apps of `bench/astro` written with `sinter-app.mjs`.

## Step 1: what holds memory

### The numbers reproduced (static, `run-sinter.mjs`, one process each)

| posts | build | peak RSS | heap after forced gc, all pages compiled | mark-compacts: heap before → after (MB) |
| ---: | ---: | ---: | ---: | --- |
| 100 | 2.3–2.9 s | 354–361 MB | 58 | 27 → 23; 107 → 54 |
| 400 | 6.2–7.3 s | 542–585 MB | 79 | 26 → 23; 116 → 70; 310 → 85 |
| 1,000 | 14.3–15.6 s | 781 MB | 115 | …; 92 → 70; 304 → 107; 449 → 111; 468 → 117 |

Live at 400: 855 MB in one run, 760 in another, 147 MB live after its last mark-compact. A page file per post: 602 MB
at 400, 785 at 1,000.

### Where the RSS is (400 posts, static, after forced collections)

| point | heap used | heapTotal | external | RSS | V8 pages (256 kB maps) | other anonymous |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| start | 13 | 23 | 4 | 75 | 14 | 10 |
| buildStart | 38 | 74 | 20 | 214 | 54 | 85 |
| all 400 pages compiled | 79 | 122–172 | 20 | 495–503 | 305 | 117–127 |
| generateBundle | 78 | 123 | 20 | 539 | 305 | 166 |
| end | 78 | 122 | 20 | 550 | 305 | 168 |

The V8 pages stay resident at their high-water mark (305 MB) after V8 has shrunk `heapTotal` to 122 MB; the rest grows
by about 80 MB over the build (Rolldown's native side, large objects, code). `external` and `arrayBuffers` do not move.
Without forced collections (`heapTotal` after each compile) the heap climbs by about 1 MB a page between mark-compacts
and falls back to 70–85 MB at each; the peak is the limit V8 sets after a mark-compact: 70 MB live → next one at 310.

### What is live per page (heap snapshots at `generateBundle`, 100 against 400 posts: +20.4 MB, 68 kB a page)

| what | per page | holder | needed until |
| --- | ---: | --- | --- |
| a `WeakMap`'s table (`DEEP_FROZEN`, compile.ts; and `WRITTEN`, 1 MB): 8 MB at 400 posts, mostly empty slots | ≈23 kB | the compiler's module | its capacity is the most entries live between two mark-compacts (the keys, frozen trees, die only at a mark-compact); V8 does not shrink the table when a collection empties it |
| the compiled page's HTML | 11 kB | Vite's `vite:build-html`: `processedHtml` (a map per environment) | Vite's `generateBundle` |
| the fold log's calls (each call's arguments: the post's body) | ≈10–27 kB | `foldCalls`, src/vite.ts | `buildEnd` (the SN534 cross check runs them again) |
| the post's source (8 kB), once | 8 kB | `buildReads`, `files.ts`'s `parsed`, the glob's entries (`body`, a slice of it) | the end of the page compiles (the glob's value; cleared at the next `buildStart`) |
| the rest (shapes, closures of Rolldown's output objects, code) | ≈5 kB | | |

None of these is held by accident: each is needed, or Vite's. The previous session's fix (the helpers' build-time memo,
stage6-eval.md round 3) took the one that was.

### What is live but not per page: the md.parse memo

sinter-markdown's `parseTree` is `memo(…, { maxSize: 8 MiB })` (packages/sinter-markdown/sinter/parse.ts): it keeps
the trees of the last ≈119 posts (keyed by their source) in the build too, where every post is parsed once (the
compiler keeps a page's calls itself, `FOLD_MEMO`). Measured by setting its `maxSize` to 1 (a local patch, reverted),
400 posts static, two rounds: live after the last mark-compact 83 / 84 → 73 / 75 MB, the GC's pauses 577 / 641 → 541 /
578 ms, peak RSS 550 / 559 → 550 / 544, build time within noise. Each tree lives about 119 pages, so all of it is
promoted, and it is ≈10 MB of the live heap V8 multiplies. It is the package's choice (it is the browser's cache too)
and at build time it serves an app whose pages parse the same source, so it is **a finding for the owner**, not a
change: either sinter-markdown's memo smaller, or the build's fold calling a memoized helper's function through its
memo only where the compiler does not keep the call itself.

### Why page garbage reaches the old generation

At 400 posts the build allocates 3.8 GB (below); a scavenge every 16 MB (the default young generation), 258 of them,
each promoting about 1.3 MB (`--trace-gc-nvp`: of what survived the scavenge before, 90–95 % survives again). What is
promoted (the sampling profile with only major-GC-collected objects: 592 MB in all) is mostly the first pass's
rendered rows: `clone` (75 % of what it allocates), `nodesOf` (48 %), `rowsOf` (44 %), `render` (34 %). They are not
kept across pages: between the 200th and the 205th compile no DOM node of a page died (snapshots by id), and of all
objects alive at a compile's end only 0.4 MB a page die later. A page's rendered rows are alive whenever a scavenge
comes during its compile, so V8 pretenures those allocation sites (allocates them in the old generation directly);
with `--no-allocation-site-pretenuring` the same build spends 630 ms in GC instead of 537 and peaks the same (558 MB).
So the old generation fills with about 1 MB of short-lived rows a page, and the build reaches the next limit.

What lives longer than a page and dies before the end (alive at the 200th compile, gone at the 205th: 1.9 MB, 0.4 MB
a page): md.parse's memo entries, code objects of the compiler's functions (460 in five pages: deoptimized and
compiled again), a `MessagePort`'s message buffer (0.23 MB), the evaluation's `fill` contexts.

Live pages: 116 MB after a forced collection while Vite's HTML step runs against 82 at `generateBundle`. The 35 MB
between are Vite's parse5 trees of the pages in flight (several pages' transforms wait at once; their text nodes are
`chars += c` cons strings, 70,000 of them), held by its `traverseHtml` visitor's closure. Vite's.

### Tried and not kept

- The kept template's entry let go at the entry's end (`Compiler.releaseEntry`: the tables `decideFor` clears first
  thing, cleared after the entry instead; `SN_ENTRY_RELEASE`). Two interleaved rounds at 400 posts: GC 593 / 589 →
  604 / 577 ms, peak 561 / 567 → 559 / 563 MB. No difference, consistent with the rows not living across pages.

## Step 3 (measured early: it decides what matters): the young generation's size

400 posts static, three interleaved rounds, `--max-semi-space-size` (MB), build ms / peak RSS / GC pauses (scavenges,
mark-compacts):

| semi-space | round 1 | round 2 | round 3 |
| --- | --- | --- | --- |
| default (16) | 6,300 / 552 / 579 (258, 3) | – / – / 578 | – / – / 583 |
| 32 | 6,188 / 617 / 469 (134, 3) | 5,872 / 589 / 482 | 6,526 / 623 / 548 |
| 64 | 6,193 / 703 / 427 (75, 3) | 5,960 / 703 / 424 | 6,185 / 706 / 436 |
| 128 | 5,968 / 835 / 399 (50, 3) | 6,003 / 838 / 402 | 6,455 / 832 / 439 |

A larger young generation cuts the GC's pauses by a quarter (64 MB: 580 → 430 ms) and costs 150 MB of peak memory; the
build's time does not move outside the machine's noise (the scavenger runs on four threads; a scavenge costs about 2 ms
with 1.4 MB surviving, at 128 MB about 7 ms). **Finding: not worth it**, and not something sinter can set for a user's
build.

## Step 2: what a build allocates

### By owner (400 posts static, the sampling heap profiler, collected objects included, base `f395fa2`)

3,831 MB in all (the young generation's 258 scavenges × ≈15 MB agree), 9.6 MB a page:

| owner | MB | a page | what |
| --- | ---: | ---: | --- |
| the compiler, its own code | ≈2,130 | 5.3 MB | the first pass's evaluation and its rendered rows (`finish`: 1,137 inclusive, of it `render`/`fill`/`instance` 650, `unroll`/`rowsOf`/`nodesOf` 360, the frozen-data checks 200), the second pass 500, the rest |
| the post's `md.parse` in the compile | ≈400 | 1.0 MB | markdown-it's tokenizer (`tokenize` 429 inclusive over both copies), sinter-markdown's tree, `memo`'s `freeze` of the result (with a property descriptor per property) |
| Vite's HTML step | 520 | 1.3 MB | parse5 (`traverseHtml`; its tokenizer builds text a code point at a time, `_emitCodePoint` 298 MB) |
| the SN534 cross check | 420 | 1.05 MB | every post's `md.parse` again in the fresh copy of the helpers, `memo`'s freeze, `resultKey` and the hash (16 MB) |
| Vite's and Rolldown's other JS | ≈250 | | `Object.values(bundle)` in Vite's `generateBundle` (18 MB, per page), Rolldown's plugin glue |
| the plugin (page URLs, heads, styles) | ≈110 | | `rewriteUrls` (`page-urls.ts`, 42 MB: a regex over every tag of every page) |

What reaches the old generation (only major-GC-collected objects sampled): 592 MB, of it the rendered rows 342 MB
(`clone` 75 % of its bytes, `nodesOf` 48 %, `rowsOf` 44 %, `render` 34 %; see step 1 for why), the md trees 60 MB, the
second pass 39 MB, the cross check 32 MB, the minifier 20 MB.

### The cuts (byte-identical; each is local, nothing it computes changes)

1. **`plainData`** (the evaluation's check that a value is JSON-like data, 146 MB): a pair `[value, depth]` was made for
   every value it looked at, a four-string array for every scalar test, a fresh `Map` for every call that has the
   frozen heights at hand, and its children iterated through the iterator protocol over a conditional iterable. Now two
   stacks side by side, a `typeof` test, the frozen height read first (as `plainHeight` reads it first: a known height
   answers before any table is made), the children by index. 146 → ≈60 MB.
2. **`fill`'s `paint`** (the rendered row's binding writer): a closure and its context made for every element filled;
   now one function of the fill, given the element. ≈17 MB.
3. **`element()`'s known attributes**: the `Set` of every known `data-sn-` name (from `ATTRS.map`) was built again for
   every element the walk meets, and `get`/`has` made `data-sn-${n}` and a predicate closure at every call. Now one
   module-level set, the names made once, plain loops. ≈35 MB.
4. **The folded texts' names** (`finish`'s SN501 check, and the route's `a resource read only in a decided branch`):
   the identifier regex ran over `foldedText`, which holds the same few loop and condition texts once for every
   rendered row (thousands a page), and its matches were flattened into a set even when every resource was read. Now
   each distinct text once, and only when a resource is unread (`foldedNames`). ≈44 MB.
5. **`frozenPlain`'s array keys**: an array's indexes were checked by `String(+k >>> 0)` one by one; with one own key more
   than its length and that key `length` in its place, its keys are exactly the indexes (a proxy's, in another order,
   checked as before). Allocation unchanged within the profile's noise (V8 caches small numbers' strings); kept for the
   time, measured below.
6. **The minifier's comment pass** (`minify.ts`, `comments`): a new list of children was made for every element it
   visits; now only for one that loses a comment or whose texts meet, the others' list kept as it is. `visit` 50 → 26 MB.

7. **The fold log's arguments** (`foldLog`, and the cross check's replay, `fold-cross.ts`): each argument was
   `structuredClone`d, so the post's body a call reads was kept twice until `buildEnd` (and cloned again there); a string
   or another primitive is now kept as it is, an object copied as before (`cloneArg`). Heap after a forced collection
   once the 400 pages are compiled: 79.4 → 76.1 MB (≈8 kB a page); the same after `buildEnd`, where the log goes.

Sampling heap profile, 400 posts static: 3,831 MB → 3,615 MB (cuts 1 to 5) → 3,572 MB (6).

### Before and after (whole process, interleaved rounds: base `f395fa2` and this branch alternating within each round)

Five rounds at 100 and 400 posts, medians; build ms / peak RSS MB / GC pauses ms (scavenges in their count):

| app | base | this branch |
| --- | --- | --- |
| static 100 | 2,500 / 358 / 194 (78) | 2,480 / 354 / 184 (74) |
| live 100 | 3,098 / 483 / 261 (86) | 2,996 / 486 / 250 (81) |
| a page file per post, 100 | 2,967 / 369 / 216 (90) | 3,040 / 360 / 211 (87) |
| static 400 | 6,449 / 561 / 600 (259) | 6,320 / 559 / 572 (243) |
| live 400 | 8,018 / 846 / 818 (290) | 7,856 / 837 / 803 (272) |
| a page file per post, 400 | 8,029 / 598 / 718 (306) | 8,141 / 609 / 702 (293) |

Three rounds at 1,000 posts (cuts 1 to 5), medians:

| app | base | this branch |
| --- | --- | --- |
| static 1,000 | 15,052 / 787 / 1,590 (630) | 14,969 / 760 / 1,527 (598) |
| live 1,000 | 19,645 / 1,585 / 2,516 (713) | 18,945 / 1,578 / 2,318 (670) |
| a page file per post, 1,000 | 19,137 / 826 / 1,952 (753) | 19,194 / 819 / 1,878 (720) |

Checked: `bench/tools/ident.mjs` against the base, nine apps (the five benchmark variants at 100 posts and the four
examples), every file the same; `pass-audit` and `render-audit --canon`, every app "same"; 1,569 tests of
test/compiler, test/vite, test/check, check-cli and fold-cache.

### Live pages at 1,000 posts: Vite's HTML step holds every page's tree at once

The live variant peaks at 1.4–1.6 GB at 1,000 posts (static: 0.76–0.79). After a forced collection while Vite's HTML
step runs, 275 MB are live; once it is done, 121 MB. `vite:build-html`'s transform parses the page (`traverseHtml`)
and keeps the tree in its visitor's closure until the `this.resolve` of the page's module script and its asset URLs
have settled (`await Promise.all(setModuleSideEffectPromises)`); Rolldown starts every page's transform at once, so
every live page's parse5 tree (its text nodes `chars += c` cons strings) is alive together: ≈155 kB a page, and V8's
high-water is 950 MB. Static pages have no module script to resolve and their trees go sooner (35 MB at 400 posts).
Vite's code; the only lever sinter has is the one already in "Decisions for the owner" of pipeline-2.md (Vite's HTML
step for pages it does not change), and live pages are pages it changes.

## Decisions for the owner

1. **sinter-markdown's parse memo at build time** (step 1): ≈10 MB live through the build, ≈119 post trees, each
   promoted; 6–10 % of the GC at 400 posts. Either a smaller `maxSize` in the package (its browser cache too), or the
   build's fold calling a memoized helper's own function where the compiler keeps the page's calls itself.
2. **The young generation's size** (step 3): `--max-semi-space-size=64` buys a quarter of the GC's pauses for 150 MB of
   peak and no time. Not recommended; it is the user's flag in any case.
3. Already on the owner's list (pipeline-2.md): the SN534 cross check (11 % of what the build allocates) and Vite's HTML
   step (14 %).
