# js-framework-benchmark results

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
