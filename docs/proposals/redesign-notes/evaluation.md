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

Numbers: `time` mode, CPU clock, the per-call distribution of each phase over a build's pages (100 blog pages, 12
sinter-mail pages), p25 / median, the median of the A/B rounds (`pq.mjs`). The 25th percentile is the one to read:
with the load at 20 to 26 the CPU clock of a call runs long whenever the core's sibling is busy, and the sum over a
build moved by ±15% from one round to the next.

### 1. The worklist's walk: what a row asks of its template once per evaluation, a row's scope a plain object

- **A node's bindings read once** (`bindPlan`): for every node of a row's template, which of its bindings `nodesOf`
  skips (a handler that stays, `else`, a value that is neither painted nor a text), which stops the row, which it
  paints, and an `if`'s or `for`'s key (`instKey`), with their code. Before, every row asked all of it again for every
  binding (`handlerOnly`'s regexes, `fixed`, `paintable`, `instKey`'s string). `known` is asked per row only for a
  dependency on a state field: it reads the evaluation's states and the model being evaluated (`own`), which change
  between `prerender`'s candidates; for anything else its answer is the program's. Likewise per evaluation: a choice's
  candidates' keys (`choiceKey`, 65 strings a row on sinter-mail), a node's element (`elOf`, which searched
  `this.paints` for every anchor), a case's props as code (a new string per row, hashed again for the table), and
  `handlerOnly` by binding (also what `rowRenderer` asks).
- **A row's scope** was a `Proxy` over the scope it is in, so a name read in a row went through one trap per level
  above it. It is a plain object now, whose prototype is the evaluation's own scope (which answers its names or throws
  `NOT`) and which holds the names of every row it is in, the innermost's last: the lookup the proxies made, in one
  step. (A chain of objects, one per row, each the prototype of the next, was tried first: slower than the proxies at
  depth, 4 to 8 times at 12 levels in a micro-benchmark, since V8 turns every object used as a prototype into a
  prototype map.) Writes are not possible in either: an expression that is not a handler cannot assign (SN203), and
  only handlers that are not evaluated are left in rows.
- **The candidates a choice in a row does not render** were one `[prefix + key, false, deps]` each (64 a row on
  sinter-mail, with their strings); they are one entry now (`NotRendered`), spelled out where the decisions are
  committed (`decidedEntries`, in order) or filtered (`choose`). When the rows are rendered nothing is spelled out:
  only the dependencies are read, and the state sites of the same dependency list are added to a loop's reads once
  (`stateSites` was called 130,000 times a page on the same list).

What is decided is unchanged: the same questions in the same order, the same evaluations; the benchmark apps, the
examples and sinter-mail's 16 pages are byte for byte the base's. Tests: `test/compiler/evaluation.test.ts` (nested
rows whose names shadow each other, a row named `constructor`, choices in rows rendered and not and through one kept
template, `decidedEntries`).

| ms a call, p25 / median | base | 1 |
| --- | ---: | ---: |
| blog static, `decideFor` | 6.83 / 8.96 | 6.48 / 7.92 |
| blog static, `compile()` | 11.09 / 13.04 | 9.74 / 11.69 |
| mail gen, pass-1 `prerender` | 288 / 324 | 225 / 266 |
| mail gen, `compile()` | 366 / 425 | 285 / 347 |
| mail API, pass-1 `prerender` | 11.5 / 13.4 | 11.8 / 13.8 (nothing to walk there) |

(3 rounds of the blog, 2 of each sinter-mail app.)

(On the loaded machine of the time. Measured again on a quieter one after the merge of `3e2f2d8`, below, the plain
scope turned out slower than the proxies on the blog: see 2.)

### Merged `3e2f2d8`

The bug fix there (a case's props are evaluated only when `fixed` and `known`; a tree placement's data likewise) is in
the worklist: kept, with the props' code cached per case. A new base dist from `3e2f2d8` for the byte comparisons from
here on (the embedding change there alters the live benchmark's pages on purpose).

### 2. Rendering a row: a clone plan per element; the row's scope a proxy again

- **What cloning a template's element reads of it** (`clonePlan`, per evaluation, by element): whether a `data-sn-*`
  keeps it from rendering, its attributes before paint and the copy's own (`REWROTE`, `snAttrs`, filtered), its id,
  its use, its marks of scoped styles (with and without `data-sn-s`), whether its component's styles are scoped and
  whether its tag binds what it shows. Every row filtered and tested all of it again, element by element. Likewise
  what `prefold` writes on a node, sorted, and the bindings it stands for (`foldOf`, a sort and a `Set` per element
  per row before).
- **The attributes before paint** (what the second pass's minifier, layout and images read on a rendered element)
  were a module `WeakMap` (`SHOWN`), written for every element with bindings in every row (a third of `clone`'s own
  time: an ephemeron table's insert), and listed beside it. They travel with the rendered rows now
  (`RenderedRows.shown`: element and attributes, in the order the rows made them), and the second pass swaps them in
  from there; `SHOWN` is gone.
- **A style written where there is none** (`writeFirstPaint` on a row's fresh copy): the one declaration, or none,
  without splitting and joining the element's style; an attribute set to `null` that is not there is not filtered out
  of a copy of the list. sinter-mail's generated components write 55 style properties an element, most of them `null`.
  Only on a rendered row's own copies (`fresh`), whose attribute lists nothing else holds.
- **The row's scope is a proxy again.** Measured on the quieter machine, change 1's plain object cost the blog more
  than the proxies did (`rowScope` and its copy of the enclosing rows' names 1.1 ms a page under the profiler): a
  blog row reads its own item, at the first proxy, nearly always, and copying every enclosing name into each row's
  object is paid for every row. On sinter-mail the gain of change 1 was the rest of it.

Tests: rendered styles and attributes (none yet, an empty `style`, one there, removed), a template's elements copied
into several instances.

ms a call, p25 / median, base (`3e2f2d8`) → 1 and 2 (5 rounds of the blog template, 3 of the others):

| | base | 1 + 2 |
| --- | ---: | ---: |
| blog static, `decideFor` | 6.37 / 8.20 | 4.56 / 6.62 |
| blog static, `compile()` | 10.08 / 11.76 | 8.00 / 10.12 |
| blog live, `decideFor` | 6.92 / 9.05 | 4.77 / 6.62 |
| blog static-files, pass-1 `settle` | 7.96 / 10.37 | 6.89 / 8.01 |
| mail file, pass-1 `settle` | 23.5 / 26.9 | 20.0 / 22.7 |
| mail gen, pass-1 `settle` | 338 / 388 | 229 / 265 |
| mail gen, `compile()` | 418 / 459 | 291 / 342 |
| mail API, pass-1 `settle` | 11.9 / 12.0 | 11.8 / 12.0 |

### 3. A kept template's program read once for its entries; an expression that fails at its first step

- **`evalProgram`** (a `Compiler` field, `cache` in `LINK_FIELDS`): what `prerender(true)` reads of the program alone,
  kept by a kept template's compiler (`fromTemplate` → `decideFor`) for its next entry: the candidates, the state
  written (`writtenState`), whether it chooses, the texts, the codes it may run, and their table compiled once, with
  the names the codes see (the helpers' folding wrappers, the formatters, the stubs) as `let` variables each entry
  binds to its own values before it evaluates (as `unitTable` does for a unit). And what the worklist reads of the
  program (`WalkMemo`: `bindPlan`'s plans, a choice's keys, a node's element, `handlerOnly`, a case's props code), per
  kept template instead of per entry. `shape`: the program's sizes when it was read; a program that differs is read
  again. Not kept: what reads the entry (`known` of a state field, every evaluation), pages of their own (one
  evaluation each), a compiler with a unit placed (`unitTable` is the unit's own cache).
- **`failsFirst`**: an expression whose first step reads a name off the evaluation's scope that the scope never answers
  (not a state, `$r`, `$meta`, `$w`, `$build`, `$z`) throws `NOT` there before anything else happens: the leftmost
  operand of any expression is evaluated first. `prerender`'s own `run` returns FAIL for it without running it. On
  sinter-mail, 2,229 of a page's 2,250 candidates are a definition's bindings, which read a prop (`$.$p<n>…`) first:
  each was a call, a proxy trap, a regex and a `throw`, in both passes.

Tests: every entry's values through one table (a folded helper's call, a text, rows), two rounds over the entries
against each compiled alone; `failsFirst`'s cases; a page with definitions the same rendered and not.

ms a call, p25 / median (5 rounds blog, 3 others), 2 → 3: blog static `decideFor` 4.41 / 5.70 → 4.11 / 5.82 (the
mean over the build's pages 7.0 → 7.2: within the noise; under the profiler `prerender`'s own time 0.6 → 0.2 ms a
page); blog live 4.51 / 5.99 → 4.75 / 6.87 (noise); mail file pass-1 `prerender` 19.1 / 20.0 → 15.9 / 19.6; mail API
pass-1 `settle` 11.3 / 12.0 → 8.0 / 10.6 (mean 16.2 → 12.8).
