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
- **Next: step 2**, the allocation by function (measured below: 3.8 GB in the 400-post build, 9.6 MB a page) and cuts
  in the compiler's own share; then step 3's numbers (measured below already, a finding).
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
