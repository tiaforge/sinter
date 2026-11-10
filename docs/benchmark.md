# js-framework-benchmark results

## 2026-11-10, sinter against itself, with ivi as the reference

`bench/js-framework-benchmark/self.mjs`: builds of this entry's page (and `ivi/`, the same page in ivi
5.1, written as ivi's own entry is) in headless Chrome for Testing 153 on a 4-core cloud VM, page loads
alternating, no js-framework-benchmark checkout. Script = from `click()` until the render's microtasks
are done; total = also laid out (`offsetHeight`); median of 6 page loads × 10 clicks (create 10k: × 3).
Memory: JS heap after a forced GC. "Before" is main at 813a3b0, "after" has the two changes below.

| operation | before script | total | after script | total | ivi 5.1 script | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| create 1k | 5.30 | 48.60 | 4.60 | 41.60 | 5.90 | 43.50 |
| replace 1k | 8.00 | 43.00 | 8.20 | 40.80 | 10.50 | 48.60 |
| update 10th | 1.00 | 11.90 | 0.90 | 11.80 | 0.80 | 12.30 |
| select row | 0.60 | 0.60 | 0.60 | 0.60 | 0.50 | 0.50 |
| swap rows | 0.90 | 6.70 | 0.40 | 5.40 | 0.60 | 5.50 |
| remove row | 0.60 | 3.40 | 0.70 | 4.00 | 0.70 | 3.80 |
| append 1k | 3.60 | 42.90 | 3.90 | 48.20 | 5.90 | 49.20 |
| clear 1k | 4.30 | 4.50 | 4.30 | 4.40 | 4.70 | 4.80 |
| create 10k | 42.10 | 456.40 | 38.70 | 466.80 | 61.30 | 516.40 |
| ready MB | 1.93 | | 1.93 | | 1.89 | |
| 1k rows MB | 2.39 | | 2.34 | | 2.58 | |
| run-clear x5 MB | 2.19 | | 2.14 | | 2.00 | |

- **Swapping two rows**: after the unchanged ends are trimmed, a middle whose first and last keys
  traded places, with the rows between them unchanged, is two moves. It used to build a key map,
  sequence and longest increasing subsequence over the 998 rows between them. Script 0.9 → 0.4 ms.
- **Numbers in new rows**: the text writer converted every value to a string (`'' + v`); for a number
  V8 does that through its number-to-string cache, which a heap snapshot after five create-and-clear
  cycles showed at 64 KB (the largest array that grew; ivi's heap had none). An element without
  content now takes a non-zero number as it is and the DOM converts it. Heap after the cycles 2.19 →
  2.14 MB, with 1,000 rows 2.39 → 2.34 MB.
- What remains of the gap to ivi after the cycles (2.14 against 2.00 MB) is optimized code: 142 KB
  against 88 KB of `(code)` growth in the same snapshots, from the amount of code that runs.
- Within the noise of this setup (0.1 ms timer), sinter's script time is level with or below ivi's
  everywhere except update every 10th (0.9 against 0.8 ms) and select row (0.6 against 0.5 ms).

What ivi does, from its source (`ivi/dist/lib/core.js`) and its README's internals section:
- **Keyed lists**: trims the common end and start, maps the new middle's keys, and runs its LIS only
  when a row moved (it tracks whether the old positions are still increasing). sinter does the same,
  and now also handles the two-row swap without the map.
- **Small, fixed-shape state**: one 32–36 byte node per template, component, text or list, with
  preallocated slot arrays and SMI flags, so its call sites stay monomorphic.
- **Precompiled templates**: a cloned static part plus opcodes that save references to the dynamic
  nodes on creation; sinter's compiled per-template lookup functions do the same job.
- **Right-to-left updates**: insertions use the next sibling, so no marker nodes; sinter keeps its
  `<template>` and an end comment per list.
- **DOM accessors captured once** (`Node.prototype` getters such as `firstChild`, called directly),
  `Element.prototype.moveBefore` when the browser has it. Text: `textContent` into an empty element,
  `nodeValue` of its text node after that, `createTextNode(v)` for text children (values passed as they
  are: numbers are converted by the DOM).


## 2026-11-08, row creation: what the lookup visits

sinter's own click-to-flush time (`profile.mjs`, median of 25 clicks per page load; create 10k: 5),
headless Chrome 156, page loads interleaved base / change / vanillajs. The clock was not at the pinned
4.0 GHz of the section below and another session loaded the machine (load 0.8–1.4 of 16 cores), so
the absolute figures run 20–30 % above that section's; compare within a column group.

| change | create 1k before | after | create 10k before | after | vanillajs 1k / 10k | kept |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| creation function walks only to elements with value bindings | 2.41, 2.32, 2.56 | 2.21, 2.05, 2.25 | 25.7, 22.9, 24.0 | 20.5, 18.8, 23.9 | 2.21 / 19.6 | yes |
| empty Text node in each text-bound element of the template content | 2.60, 2.60, 2.57, 2.59 | 2.77, 2.77, 2.79, 2.88 | | | 2.16 / 21.8 | no: slower |
| create-from-empty path in `reconcile()` (no key map, sequence or LIS) | 2.31, 2.38, 2.26, 2.33 | 2.33, 2.37, 2.18, 2.37 | 20.7, 21.5, 21.7, 21.4 | 24.1, 25.5, 26.2, 26.6 | 1.90 / 20.2 | no |
| row scope and instance as one object (upper bound, unshippable prototype) | 2.45, 2.24, 2.46 | 2.50, 2.32, 2.41 | 25.3, 20.6, 21.4 | 23.3, 28.4, 21.7 | 1.94 / 20.4 | no |

- The lookup: the benchmark row's remove link (`<a data-sn-on-click>` in the third cell) was walked
  to and tag-checked on every created row although only its handler, bound on the first click, needs
  it. Not visiting it saves two DOM accessor calls and two node wrappers per row, about 0.2 ms per
  1,000 rows; in this session sinter's create 1k equals vanillajs's.
- An empty Text node cloned with each row (so the first text write sets `data`) is slower than
  `textContent` on an empty element: that creates the Text node inside the browser with no JS wrapper,
  while `firstChild` makes one per text node.
- The skipped `reconcile()` bookkeeping for a list created from no rows is a few callbacks per row,
  too small to show; the 10k case got slower, likely from the second `instantiate` call site.
- The row scope (`Object.create` plus three stores) and the instance literal cost about 25 ns per row
  in the line profile, about 1 % of create 1k, and one object per list prototype would make the
  instance field reads polymorphic on pages with nested lists.

## 2026-11-08, pinned clock: before and after the three row changes

The machine (amd-pstate, boost to 5.09 GHz) ran the earlier sections in two clock modes 35–60 % apart,
so their medians flip between runs. For this section the clock was pinned at 4.0 GHz (governor
`performance`, min = max; see the memory notes), which brings the standard deviation of a benchmark
from 10–16 ms down to 2–4 ms. Headless Chrome 156, 10 iterations, vanillajs in the same run.
"Before" is 0.8.0 as released; "after" has selection bindings, simple rows without binding objects and
compiled row creation (the sections below).

| benchmark | vanillajs ms | before ms | after ms | ratio before → after | vanillajs script | before script | after script |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01 create 1k | 48.1 | 55.7 | 49.0 | 1.16 → 1.02 | 2.8 | 5.6 | 3.5 |
| 02 replace 1k | 51.9 | 59.2 | 54.5 | 1.14 → 1.05 | 6.5 | 10.7 | 8.4 |
| 03 update every 10th | 36.0 | 43.9 | 41.1 | 1.22 → 1.14 | 1.8 | 4.2 | 3.8 |
| 04 select row | 8.7 | 12.7 | 10.1 | 1.46 → 1.16 | 1.1 | 4.7 | 2.0 |
| 05 swap rows | 41.6 | 46.2 | 49.1 | 1.11 → 1.18 | 0.7 | 4.2 | 5.5 |
| 06 remove row | 32.3 | 32.9 | 30.2 | 1.02 → 0.94 | 0.9 | 1.1 | 1.1 |
| 07 create 10k | 483.7 | 529.9 | 523.6 | 1.10 → 1.08 | 25.0 | 43.5 | 40.9 |
| 08 append 1k | 59.8 | 60.2 | 67.6 | 1.01 → 1.13 | 3.0 | 5.1 | 4.5 |
| 09 clear 1k | 26.4 | 28.4 | 26.5 | 1.08 → 1.01 | 20.8 | 24.2 | 22.2 |

Rank in the official Chrome 156 table (208 keyed frameworks, `rank.mjs`): CPU 53 → **28**
(geometric mean of the ratios 1.08), memory **49** (1.27; ready 1.20, 1,000 rows 1.17, run-clear 1.46).
Of the earlier noisy estimate (CPU 46, memory 56) a part was the clock, not the code: compare the
pinned "before" column. Swap rows and append 1k look worse in the table but are not: sinter's own
click-to-flush time for a swap is 0.6–0.7 ms after against 0.8 before (vanillajs 0.04; median of 20
page loads, pinned), and append's script time fell 5.1 → 4.5. The benchmark's "script" figure also
carries browser work the trace files under script, and its totals are paint-bound.

## 2026-11-08, selection bindings and simple rows

Two runtime changes, measured on the entry against vanillajs on the same machine (headless Chrome 156,
Steam Deck); the ranking method is the section below.

| benchmark | before | after | vanillajs | ratio before → after |
| --- | ---: | ---: | ---: | ---: |
| 04 select row, script ms | 5.2 | 2.2 | 0.9 | 1.59 → 1.26 (total) |
| 04 select row, sinter's own flush ms | 4.1 | 0.7 first / 0.2 next | | |
| 01 create 1k rows, script ms | 6.25 | 6.2 | 3.2–3.9 | unchanged |
| 07 create 10k rows, script ms | 43.4 | 43.7 | 28.9 | unchanged |
| 21 ready memory MB | 0.68 | 0.68 | 0.57 | 1.19 → 1.19 |
| 22 run memory, 1,000 rows MB | 2.51 | 2.19 | 1.87 | 1.34 → 1.17 |
| 25 run-clear memory MB | 0.91 | 0.94 | 0.65 | 1.42 → 1.46 |

- Selection bindings: `{danger: row.id === selected}` is marked by the compiler; a change to `selected`
  re-evaluates it on the two rows concerned, through an index built on the first selection (0.5 ms
  for 1,000 rows) and dropped when the rows render for another reason. The benchmark's remaining
  select time is Chrome's event dispatch.
- Simple rows (value bindings and handlers only) keep no binding objects: one array of last values per
  row, elements found again from the row's first node when it renders, handlers bound on their first
  event. Memory per row 640 → 320 B over vanillajs. Creation time did not move: the per-row cost is
  the clone, the lookup and the writes, not the binding objects. The 30 KB more after five
  create-and-clear cycles do not come from the row registry (measured with it off); they are within
  what the larger core costs.
- Memory runs are deterministic to about 1 %: one iteration of sinter alone is enough to measure a
  change; vanillajs's figures above are reused.

## 2026-11-08, rank in the official Chrome 156 table

`bench/js-framework-benchmark/rank.mjs` places a local run into the official results
(`webdriver-ts/results.json` of the checkout, 207 keyed frameworks): every framework is scored by
the geometric mean of its ratios to vanillajs measured on the same machine, which ranks like the
official score. sinter 0.8.0 and vanillajs, headless Chrome 156 (flatpak), 10 iterations, Steam Deck:

| | rank of 208 | for comparison (official) |
| --- | ---: | --- |
| CPU, 9 benchmarks | 46 | vue-vapor 35, solid 50, svelte 5 75, vue 95, lit 106, react-hooks 161 |
| memory, 3 benchmarks | 56 | solid 36, lit 71, svelte 5 81, vue 134, react-hooks 161 |

| benchmark | sinter / vanillajs | svelte 5 | solid | react-hooks |
| --- | ---: | ---: | ---: | ---: |
| 01 create 1k | 1.03 | 1.10 | 1.08 | 1.24 |
| 02 replace 1k | 1.07 | 1.16 | 1.11 | 1.36 |
| 03 update every 10th | 1.02 | 1.17 | 1.13 | 1.57 |
| 04 select row | 1.59 | 1.85 | 1.19 | 2.04 |
| 05 swap rows | 1.54 | 1.18 | 1.15 | 7.97 |
| 06 remove row | 0.80 | 1.07 | 1.04 | 1.15 |
| 07 create 10k | 1.01 | 1.11 | 1.10 | 1.68 |
| 08 append 1k | 1.11 | 1.09 | 1.08 | 1.23 |
| 09 clear 1k | 1.09 | 1.32 | 1.32 | 2.14 |
| 21 ready memory | 1.19 | 1.20 | 1.05 | 2.12 |
| 22 run memory (1k rows) | 1.34 | 1.54 | 1.44 | 2.38 |
| 25 run-clear memory | 1.42 | 1.52 | 1.19 | 3.07 |

Paint time on this machine is noisy (10 runs, not the official 15), so the CPU rank is a band of
about 35–60. Swap rows (1.54; 1.0 against svelte on 2026-11-04) is the outlier to look at; remove
row below vanillajs is noise. Memory: 0.68 MB ready, 2.51 MB with 1,000 rows, 0.91 MB after
creating and clearing them five times (vanillajs 0.57 / 1.87 / 0.64).

## 2026-11-06, flush per root binding

Only bindings inside a `<dialog>` (marked by the compiler) check for a closed one; each binding
keeps its parsed dependencies. Real Chrome 156 (headless, minified bundle, median of 8 page loads,
each timing 1,500 flushes), and `npm run bench` in happy-dom:

| case | before ms | after ms |
| --- | ---: | ---: |
| Chrome: one state change, 4,000 root bindings | 0.49 | 0.18–0.24 |
| happy-dom: one state change, 100 root bindings | 0.016–0.024 | 0.004 |
| happy-dom: one state change, 2,000 root bindings | 0.41 | 0.10 |

Mount (4,000 bindings, about 40–47 ms, mostly first calls of the expression functions), creating
1,000 rows (2.1 ms), select and update every 10th row did not change beyond the run-order effect
seen when the variants swap places. About half of that mount time is V8 compiling each expression
function on its first call: 5 µs per function in Chrome 156.

Identical expressions now share one function in the page module. RealWorld, gzip of what each page
loads: article 16,507 → 16,293 B (112 → 60 functions), index 16,224 → 16,169, profile 16,249 →
16,196, editor 15,308 → 15,280; the other pages are unchanged. At 5 µs per function the article page
saves at most about 0.26 ms of mount; script time per page load (about 9 ms, API answering 404) did
not change measurably.

## 2026-11-06, after the store fixes (0.2 phase 2)

The store keeps its sorted list and patches it per write (binary search, arrival numbers break
ties so the order equals a full sort of arrival order); a full sort runs after `replace`, after a
locale change and when more than 64 keys changed since the last read. Collators are cached per
locale. Lists are frozen in dev builds only: in V8, copying or filtering a frozen 5,000-item
array takes 170–250 µs instead of 3–77 µs, and the compiler already refuses writes to resources
(SN205), as it does for the items, which only dev builds freeze.

| case (5,000 items ordered by name) | before ms | after ms |
| --- | ---: | ---: |
| upsert one (new name) | 9.9 | 0.007 |
| patch one (field outside the order) | 9.8 | 0.007 |
| remove one | 10.4 | 0.005 |
| burst of 50 upserts | 7.4 | 0.19 |
| replace all | 10.2 | 10.1 |
| upsert one, one optimistic layer pending | 10.0 | 0.009 |
| flush: one server upsert, 1,000 sorted rows | 1.6 | 0.20 |
| flush: one server upsert, 5,000 sorted rows | 11.3 | 0.77 |

`replace` still sorts from the response's order. Cost: the core grew by 481 B gzip (10,887 →
11,368 B); the minimal page is 11,707 B (budget 11,776 B).

## 2026-11-06, runtime baseline for 0.2 (`npm run bench`)

`bench/runtime/`: the store alone and one flush on a mounted production page (no dev feature),
in Node 26.5 with happy-dom. Medians; runs on this machine vary by up to ±50 % between runs
(flush, 2,000 bindings: 0.39 and 0.62 ms), so compare within one run or across several.

Store, 5,000 items ordered by a string field, one write (or a burst), then one read:

| case | median ms |
| --- | ---: |
| upsert one (new name) | 9.9 |
| patch one (field outside the order) | 9.8 |
| remove one | 10.4 |
| burst of 50 upserts | 7.4 |
| replace all | 10.2 |
| upsert one, one optimistic layer pending | 10.0 |

Every write re-sorts the whole list from the Map's arrival order, so a patch that does not touch
the order field costs as much as replacing everything. Phase 2's gate: one upsert under 0.1 ms.

Flush, one state field of n changes (one text node written):

| root bindings | median ms |
| ---: | ---: |
| 100 | 0.031 |
| 500 | 0.128 |
| 2,000 | 0.620 |

Matching dirty paths costs about 0.2–0.3 µs per root binding, so integer dependency ids would
save little; they stay out of 0.2.

Flush, one server upsert into a sorted list (store + reconcile): 1.6 ms for 1,000 rows,
11.3 ms for 5,000.

Sizes (`npm run size`, gzip -9): minimal page 11,236 B (budget 11.5 KB), RealWorld pages
14,298 B (login) to 16,074 B (article, budget 16.5 KB), core 10,887 B.

Entry: [`bench/js-framework-benchmark`](../bench/js-framework-benchmark). Quick comparison against
Svelte with `bench/js-framework-benchmark/run.sh` (5 iterations, headless Chrome 156, local machine;
treat single runs as ±10 % — totals are dominated by paint time, which is noisy).

## 2026-11-04, after the row creation/remove work

Svelte figures are its stored results from the previous run (`run.sh` now measures sinter only).

| benchmark | sinter total | svelte total | sinter script | svelte script |
| --- | ---: | ---: | ---: | ---: |
| 01 create 1k rows | 56.7 | 60.7 | 8.5 | 8.5 |
| 02 replace 1k rows | 63.5 | 64.1 | 13.2 | 15.4 |
| 03 update every 10th (×16 slowdown) | 47.1 | 47.2 | 3.2 | 3.7 |
| 04 select row | 11.7 | 15.2 | 3.4 | 6.2 |
| 05 swap rows | 43.0 | 44.5 | 3.7 | 3.7 |
| 06 remove row | 41.1 | 35.5 | 1.1 | 1.5 |
| 07 create 10k rows | 543.6 | 641.8 | 61.2 | 71.2 |
| 08 append 1k rows | 70.1 | 65.9 | 9.7 | 6.9 |
| 09 clear 1k rows (×8) | 26.0 | 27.5 | 21.6 | 23.3 |
| **geometric mean (total) vs svelte** | **0.96** | 1.00 | | |

Script time only (`profile.mjs`, click to end of flush, median of 25, real Chrome):

| | sinter before | sinter after | svelte |
| --- | ---: | ---: | ---: |
| create 1k | 4.71 | 2.72 | 2.45 |
| append 1k | 5.45 | 2.77 | 2.64 |
| create 10k | 50.6 | 28.0 | 27.9 |
| remove 1 | 1.38 | 0.21 | 0.41 |
| clear 1k | 4.97 | 4.21 | 8.11 |

Changes: handler/model/state registries live on the element (symbol properties) instead of
WeakMaps; listeners are registered once from the IR; rows are keyed by the item object
itself; template nodes are found with `firstChild`/`nextSibling`; reconcile trims the common
prefix and suffix before matching keys, builds no row scope unless a key expression needs it,
and walks moved rows only when the template reads its index. Tried and dropped: reusing path
prefixes when locating template nodes (no gain).

## 2026-11-04, after the list/flush optimizations (earlier)

| benchmark | sinter total | svelte total | sinter script | svelte script |
| --- | ---: | ---: | ---: | ---: |
| 01 create 1k rows | 59.2 | 60.7 | 11.6 | 8.5 |
| 02 replace 1k rows | 67.2 | 64.1 | 17.3 | 15.4 |
| 03 update every 10th (×16 slowdown) | 37.7 | 47.2 | 2.9 | 3.7 |
| 04 select row | 12.0 | 15.2 | 3.7 | 6.2 |
| 05 swap rows | 44.5 | 44.5 | 4.3 | 3.7 |
| 06 remove row | 36.9 | 35.5 | 3.5 | 1.5 |
| 07 create 10k rows | 563.4 | 641.8 | 80.9 | 71.2 |
| 08 append 1k rows | 73.5 | 65.9 | 11.1 | 6.9 |
| 09 clear 1k rows (×8) | 25.1 | 27.5 | 21.4 | 23.3 |
| **geometric mean (total) vs svelte** | **0.94** | 1.00 | | |
| compressed size (KB) | 9.4 | 9.7 | | |

Before the optimizations (same setup), sinter was last of seven frameworks on 03
(64.5 ms; script 18.7 ms) and about 1.2× Svelte overall.

## What changed

- Mutator calls (`push`, `splice`, …) mark the list structure (`list.#`), not its elements; rows
  with the same item at the same index are left alone, rows that only moved re-run just the
  bindings that read their index (compiler flag `i`).
- Replacing a list (`data = …`) does not re-evaluate surviving rows; reconcile handles them.
- Writes through callback elements (`data.forEach(row => row.x = …)`) mark the element at
  runtime (`$m(row, …)`, path segment `~`); only rows holding a marked element re-run, found
  through the list's key map.
- A list binding over a plain path depends on `list.#` (structure or element replaced), not on
  element fields.
- Per flush, templates whose bindings no dirty path can reach are skipped entirely.
- Rows created in a flush are not evaluated twice; no scope allocation unless `$el` is read;
  text bindings update their text node; dialog checks only where a template contains a dialog;
  one insertion when filling and one `replaceChildren` when clearing a list.

## Notes

- Runs on this machine vary ±10 % (totals) and up to ±30 % (script, single runs); compare
  medians across runs before concluding.
- `run.sh` takes about 2.5 minutes for all nine benchmarks (sinter only); `profile.mjs` about 30 s.
