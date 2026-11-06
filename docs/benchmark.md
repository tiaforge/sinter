# js-framework-benchmark results

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
