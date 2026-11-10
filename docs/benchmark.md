# Rendering benchmarks

**How fast is sinter's runtime at rendering and updating lists?** On the standard
[js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) operations, level with
ivi, ahead of Solid and Svelte 5 on CPU and behind Solid on memory. Against the official Chrome 156 results
table (208 keyed frameworks) it ranks 28th on CPU and 49th on memory.

Entry: [`bench/js-framework-benchmark`](../bench/js-framework-benchmark). Single runs vary by about
+-10% in totals and up to +-30% in script time; compare medians across runs before concluding.

## Headline: against ivi

`bench/js-framework-benchmark/self.mjs`: builds of this entry's page (and `ivi/`, the same page in ivi
5.1, written as ivi's own entry is) in headless Chrome for Testing 153 on a 4-core cloud VM, page loads
alternating, no js-framework-benchmark checkout. Script = from `click()` until the render's microtasks
are done; total = also laid out (`offsetHeight`); median of 6 page loads x 10 clicks (create 10k: x 3).
Memory: JS heap after a forced GC. Times in ms.

| operation | sinter script | sinter total | ivi 5.1 script | ivi 5.1 total |
| --- | ---: | ---: | ---: | ---: |
| create 1k | 4.60 | 41.60 | 5.90 | 43.50 |
| replace 1k | 8.20 | 40.80 | 10.50 | 48.60 |
| update 10th | 0.90 | 11.80 | 0.80 | 12.30 |
| select row | 0.60 | 0.60 | 0.50 | 0.50 |
| swap rows | 0.40 | 5.40 | 0.60 | 5.50 |
| remove row | 0.70 | 4.00 | 0.70 | 3.80 |
| append 1k | 3.90 | 48.20 | 5.90 | 49.20 |
| clear 1k | 4.30 | 4.40 | 4.70 | 4.80 |
| create 10k | 38.70 | 466.80 | 61.30 | 516.40 |

| memory (MB) | sinter | ivi 5.1 |
| --- | ---: | ---: |
| ready | 1.93 | 1.89 |
| 1k rows | 2.34 | 2.58 |
| run-clear x5 | 2.14 | 2.00 |

Within the noise of this setup (0.1 ms timer), sinter's script time is level with or below ivi's
everywhere except update every 10th (0.9 against 0.8 ms) and select row (0.6 against 0.5 ms). What
remains of the memory gap after the create-and-clear cycles (2.14 against 2.00 MB) is optimized code:
142 KB against 88 KB of `(code)` growth in the same heap snapshots, from the amount of code that runs.

## Against vanillajs and the official table

Clock pinned at 4.0 GHz (governor `performance`, min = max), which brings the standard deviation of a
benchmark from 10-16 ms down to 2-4 ms. Headless Chrome 156, 10 iterations, vanillajs in the same run.

| benchmark | vanillajs ms | sinter ms | ratio | vanillajs script | sinter script |
| --- | ---: | ---: | ---: | ---: | ---: |
| 01 create 1k | 48.1 | 49.0 | 1.02 | 2.8 | 3.5 |
| 02 replace 1k | 51.9 | 54.5 | 1.05 | 6.5 | 8.4 |
| 03 update every 10th | 36.0 | 41.1 | 1.14 | 1.8 | 3.8 |
| 04 select row | 8.7 | 10.1 | 1.16 | 1.1 | 2.0 |
| 05 swap rows | 41.6 | 49.1 | 1.18 | 0.7 | 5.5 |
| 06 remove row | 32.3 | 30.2 | 0.94 | 0.9 | 1.1 |
| 07 create 10k | 483.7 | 523.6 | 1.08 | 25.0 | 40.9 |
| 08 append 1k | 59.8 | 67.6 | 1.13 | 3.0 | 4.5 |
| 09 clear 1k | 26.4 | 26.5 | 1.01 | 20.8 | 22.2 |

`rank.mjs` in the same folder places a local run into the official results (`webdriver-ts/results.json`
of the checkout): every framework is scored by the geometric mean of its ratios to vanillajs measured on
the same machine, which ranks like the official score. Headless Chrome 156 (flatpak), 10 iterations
(the official run uses 15), Steam Deck, 208 keyed frameworks:

| | sinter rank | for comparison (official) |
| --- | ---: | --- |
| CPU, 9 benchmarks | **28** (geometric mean of the ratios 1.08) | vue-vapor 35, solid 50, svelte 5 75, vue 95, lit 106, react-hooks 161 |
| memory, 3 benchmarks | **49** (1.27; ready 1.20, 1,000 rows 1.17, run-clear 1.46) | solid 36, lit 71, svelte 5 81, vue 134, react-hooks 161 |

Paint time on that machine is noisy, so treat the CPU rank as a band rather than a point. Swap rows and
append 1k look worse in the table than they are: sinter's own click-to-flush time for a swap is 0.6-0.7
ms (vanillajs 0.04; median of 20 page loads, pinned), and the benchmark's "script" figure also carries
browser work the trace files under script; its totals are paint-bound.

Memory runs are deterministic to about 1%.

## Against Svelte

`run.sh` (5 iterations, headless Chrome 156, local machine; totals are dominated by paint time, which is
noisy, so treat single runs as +-10%). Svelte figures are stored results from the same setup.

| benchmark | sinter total | svelte total | sinter script | svelte script |
| --- | ---: | ---: | ---: | ---: |
| 01 create 1k rows | 56.7 | 60.7 | 8.5 | 8.5 |
| 02 replace 1k rows | 63.5 | 64.1 | 13.2 | 15.4 |
| 03 update every 10th (x16 slowdown) | 47.1 | 47.2 | 3.2 | 3.7 |
| 04 select row | 11.7 | 15.2 | 3.4 | 6.2 |
| 05 swap rows | 43.0 | 44.5 | 3.7 | 3.7 |
| 06 remove row | 41.1 | 35.5 | 1.1 | 1.5 |
| 07 create 10k rows | 543.6 | 641.8 | 61.2 | 71.2 |
| 08 append 1k rows | 70.1 | 65.9 | 9.7 | 6.9 |
| 09 clear 1k rows (x8) | 26.0 | 27.5 | 21.6 | 23.3 |
| **geometric mean (total) vs svelte** | **0.96** | 1.00 | | |

Script time only (`profile.mjs`, click to end of flush, median of 25, real Chrome):

| | sinter | svelte |
| --- | ---: | ---: |
| create 1k | 2.72 | 2.45 |
| append 1k | 2.77 | 2.64 |
| create 10k | 28.0 | 27.9 |
| remove 1 | 0.21 | 0.41 |
| clear 1k | 4.21 | 8.11 |

## Runtime cost of state and data

`bench/runtime/` (`npm run bench`): the store alone and one flush on a mounted production page, in Node
26.5 with happy-dom. Medians; runs on one machine vary by up to +-50%, so compare within a run.

Store, 5,000 items ordered by a string field, one write (or a burst), then one read:

| case | median ms |
| --- | ---: |
| upsert one (new name) | 0.007 |
| patch one (field outside the order) | 0.007 |
| remove one | 0.005 |
| burst of 50 upserts | 0.19 |
| replace all | 10.1 |
| upsert one, one optimistic layer pending | 0.009 |

The store keeps its sorted list and patches it per write (binary search); a full sort runs after
`replace`, after a locale change and when more than 64 keys changed since the last read. Collators are
cached per locale.

A server event applied to a mounted page (store + reconcile): one upsert into a sorted list of 1,000
rows flushes in 0.20 ms, into 5,000 rows in 0.77 ms.

Flush after one state change, 4,000 root bindings, in real Chrome 156 (minified bundle, median of 8
page loads, each timing 1,500 flushes): 0.18-0.24 ms. In happy-dom: 0.004 ms with 100 root bindings,
0.10 ms with 2,000. Mounting 4,000 bindings takes about 40-47 ms, about half of it V8 compiling each
expression function on its first call (5 us per function in Chrome 156). Identical expressions share
one function in the page module.

## What makes list updates cheap

- **Keyed lists** trim the common start and end, map the keys of the middle, and compute a longest
  increasing subsequence only when a row moved. A middle whose first and last keys traded places is
  handled as two moves.
- **Bindings are tracked per path.** Mutator calls (`push`, `splice`, ...) mark the list structure, not
  its elements; rows with the same item at the same index are left alone, and rows that only moved
  re-run just the bindings that read their index. Per flush, templates no dirty path can reach are
  skipped.
- **Selection bindings** such as `{danger: row.id === selected}` are marked by the compiler: a change
  to `selected` re-evaluates them on the two rows concerned.
- **Simple rows** (value bindings and handlers only) keep no binding objects: one array of last values
  per row, with handlers bound on their first event. Memory per row is 320 B over vanillajs.
- **Compiled templates**: a cloned static part plus per-template lookup functions that find the
  dynamic nodes; text bindings update their text node, and numbers are passed to the DOM as they are.
- **Frozen lists in dev builds only**: in V8, copying or filtering a frozen 5,000-item array takes
  170-250 us instead of 3-77 us.

## Limits

- Single runs are noisy (see the notes at the top); the rank is a band, not a point.
- Numbers come from headless Chrome on one machine at a time, so absolute times differ between sections
  (different hardware and clocks); compare within a table.
- `run.sh` takes about 2.5 minutes for all nine benchmarks; `profile.mjs` about 30 s.
- Firefox and Safari were not benchmarked.
