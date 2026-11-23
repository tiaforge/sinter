# The first pass's evaluation, per page

Running log (2026-11-23). Goal: bring down what the first pass's evaluation costs a page (`decideFor` →
`prerender(true)` for a template's entry, `settle()` → `prerender` for a page of its own), with byte-identical output,
without changing what is decided (the worklist's rules, the budget, the keys the second pass reads): only how often and
how expensively it is computed. Base: `d1e3a5c` (branch `ccr-9ebf49d5-gpdej8`).

## How it is measured

- The floor agent's preload (`instr.mjs`, `hooks.mjs`, `drive.sh`, `ab.sh`, `med.mjs`), copied to
  `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/eval-agent/` and pointed at this
  worktree; `time` mode on the thread's CPU clock (`SN_CLOCK=cpu`). `--cpu-prof` for what is inside a phase
  (`tree.mjs`, `selfunder.mjs`, `callers.mjs`, `lines.mjs`: inclusive time under a frame, self time under it, by
  caller, by source line).
- The evaluation's own sections, CPU clock, from a throwaway patch of `dist/compiler/compile.js` (`sect.py`: a
  `threadCpuUsage()` mark between the sections of `prerender`) and counters of the evaluations (how many `run`s, how
  many FAIL). Not committed.
- sinter-mail: `mkmail.mjs` there writes three apps of 12 pages each against this worktree (`mailapps/file`: the
  newsletter through `mail.parse`; `gen`: a 2,012-element generated email as a `file:` tree, the stress case; `api`: a
  body from an API through the components). Per page numbers there are the mean over the 12 (the first page makes the
  build's unit and costs more).
- The machine is loaded (load average 14 to 25 on 4 cores): wall times are not comparable from one run to the next;
  everything below is CPU clock, compared A/B.

## Where the evaluation goes at the start (`d1e3a5c`)

`time` mode, CPU clock, one run each, ms a page:

| | static | static-files | live | mail file | mail gen (2,012 el.) | mail API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `compile()`, build | 15.8 | 19.4 | 16.3 | 139 | 599 | 115 |
| the evaluation (`decideFor` / pass-1 `settle`) | 10.3 | 10.5 | 9.3 | 35.9 | 415 | 24.2 |
| pass-2 `prerender` | – | – | – | – | 11.6 | – |

The sections of `prerender`, CPU ms a page (sum over both passes; the patch, no profiler):

| section | static | static-files | live | mail file | mail gen | mail API |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| setup: candidates, the rows' code, the function table, `fileConstants`, state | 0.85 | 0.83 | 0.31 | 11.1 | 39.5 | 9.2 |
| the candidates evaluated (a template's page: its `md.parse` call) | 3.0 | 3.0 | 1.8 | 11.7 | 9.3 | 8.3 |
| the worklist and rendering (`finish`) | 7.9 | 7.0 | 5.4 | 13.9 | 368 | 0 |

Counts: a blog page evaluates 30 top-level candidates (27 FAIL) and 1,063 row bindings; a sinter-mail page evaluates
about 2,250 top-level candidates in each of its two passes, 99% of them FAIL (the unit's 355 templates' bindings,
which read a prop, `$.$p<n>`, which the scope throws `NOT` for); the generated email evaluates 131,000 row bindings
(59 per element: one per style property of the generated components, 55 of them).

What is inside, from the CPU profiles (ms a page under the profiler, which inflates by about 1.3):

- **Blog, template page** (13.3 under the profiler): the page's `md.parse` 4.1 (the parse 2.45, copying and freezing
  the result 0.77, the two `JSON.stringify` of the purity check and the call's wrapper 0.6, `foldLog` 0.13);
  rendering 4.0 (`clone` 1.7, of it `SHOWN.set` about a third; `fill` 0.9, `render` 0.4, `constantSources` 0.2); the
  worklist's walk 3.0 (`nodesOf`, `rowsOf`, `caseOf`, `frozenData`, `plainHeight`); `prerender`'s and `finish`'s own
  0.55 and 0.54.
- **Blog, a page file per post**: as the template page, and `plainData` of the loops' lists 1.6 (`plainHeight`).
- **Mail gen** (372 under the profiler): the walk 142 (`nodesOf`' own 68: pushing paints and decisions, `rec.set`,
  a `choiceKey` string for each of a choice's 65 candidates in every row), rendering 165 (`writeFirstPaint` 46: a
  style write splits and joins the element's whole `style` at every one of its 55 properties, a `null` one too;
  `fill`/`paint` 61, `clone` 16), `fileConstants` 23 (the tree copied and frozen, per pass).
- **Mail API** (64): `prerender`'s own 25 (the `Set` of every code, the case props' code strings made anew per
  page, `mine.join`), the scope's `get` 14 (its regex at every read, the `throw NOT` of 2,229 candidates),
  `writtenState` (computed by `prerender` and again by `worklist`).

## Changes

(below, one per commit)
