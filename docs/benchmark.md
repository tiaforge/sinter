# js-framework-benchmark results

Entry: [`bench/js-framework-benchmark`](../bench/js-framework-benchmark). Quick comparison against
Svelte with `bench/js-framework-benchmark/run.sh` (5 iterations, headless Chrome 156, local machine;
treat single runs as ±10 % — totals are dominated by paint time, which is noisy).

## 2026-11-04, after the list/flush optimizations

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

## Still behind Svelte (script time)

Row creation (01, 07, 08) and remove (06): per-row binding setup in `bindNodes`/`instantiate`.
