# Stage 6's evaluation: the first pass's rows, from one call per binding to a plan per template

Running log (2026-11-23). Branch `redesign/stage6-eval`, merged into `ccr-9ebf49d5-gpdej8` by the coordinating
session. Starting point: `evaluation.md`, "What is left (for stage 6)". Base: `c6557d4`.

## Where it stands (done; `df98a8c` merged with the integration branch at `de23476`)

- Built, default on, each behind its switch: the style written once per element (`StyleWrites`, `SN_STYLE_BATCH=0`),
  row programs (one function per template returning a row's values; `SN_ROW_FN=0`, `SN_ROW_FN_AUDIT=1` comparing every
  value, every paint list and every compile), the row's record an array by template layout, paints read back from the
  records, the render plan (a template's content copied from a flat list; a node's copy by its place), `file:` values
  copied and measured once (`SN_FILE_COPY=0`, `SN_FROZEN_HEIGHTS=0`), the unit's candidates read once
  (`SN_UNIT_CANDS=0`), and the `own` bug fixed as a guard (bugs.md, 7: provably masked, no output change).
- Every output byte the same: the five benchmark apps, the four examples, sinter-mail's 48 audit files and its
  2,000-element page against the integration branch's builds at each merge (`35bed5c`, `de23476`), and at the end
  against the same tree with this branch's ten commits reverted; `render-audit` (also `--switch SN_UNITS`), `pass-audit`
  same. `npx vitest run`: 3,002 passed. test/compiler under `SN_RENDER_AUDIT`, `SN_ONE_PASS_AUDIT`,
  `SN_FROM_WALK_AUDIT`, `SN_ROW_FN_AUDIT`: no difference (the last fails the 64 to 67 tests that count compiles, by
  construction); `SN_UNITS_AUDIT` the same 62 failures as the base; `SN_LINK_AUDIT` two timeouts at 5 s that pass with
  a longer timeout (the base times out too). sinter-mail's suite (`mail-audit --suite`): test, check and typecheck ok.
- Numbers (below, "The end"): sinter-mail's 2,000-element email's evaluation 231 → 79 ms a page (p25), its compile
  302 → 135 ms, its build 6.2 → 4.2 s; the 200-element one 38 → 16 ms; the file email 15.9 → 12.6 ms; the API page's
  pass-1 evaluation 5.7 → 3.7 ms. The blog's evaluation is where it was (5.7 → 5.5 ms): its cost is the library's parse,
  the data checks and the walk's and renderer's per-node work, not the evaluation of bindings (1,063 a page).
- Next (not started; "What is left" at the end): the blog's rendering and walk per node (a fill plan with every node's
  kind and copy's place, the decisions' keys built only for a loop the second pass compiles), the per-binding work
  left on the email (59 bindings an element: a paint program per element), the second pass's own codes compiled per
  page (API: 8 ms).

## How it is measured

On a quiet machine of its own (4 cores, load under 1, Node 22.23.5). The tools (not committed, rebuilt for this
machine; the earlier ones lived in another machine's scratch directory):

- `instr.mjs` + `hooks.mjs`: a preload (`node --import`) whose load hook appends to `dist/compiler/compile.js` a call
  that wraps `Compiler.prototype` methods (`decideFor`, `settle`, `prerender`, `fileConstants`, …; a method's pass is
  told by `collecting()`, `#1` / `#2`), and to `dist/compiler/index.js` a wrapper of `compile()`. Each call's wall
  time (`performance.now()`; the machine is idle, and `threadCpuUsage` here ticks at 4 ms). With `SN_COUNT=1` the hook
  also rewrites a few lines of the evaluation to count calls (row bindings run, proxy reads, rows walked, templates
  rendered, `writeFirstPaint` by kind).
- `ab.mjs`: A/B rounds interleaved, base and change each a fresh `run-sinter.mjs` build; per phase the p25, median and
  mean of its calls over the build's pages, the median of each over the rounds.
- `prof.mjs`, `lines.mjs`: a `--cpu-prof` profile's self and inclusive time by function under a frame, and a
  function's self time by source line (`positionTicks`).
- `ident.mjs`, `check-all.sh`, `check-mail.sh`: the byte comparison. The five benchmark apps at 100 posts and the four
  examples built with the base's `dist/` (a worktree at `c6557d4`) and with this checkout's, every file compared;
  sinter-mail's audit pages (`mail-audit.mjs --keep`, both builds, and `--gen 2000 --only file-gen`) compared with the
  base's.
- sinter-mail's apps (`mkmail.mjs`, as `evaluation.md`'s): 12 pages each of the newsletter through `mail.parse`
  (`file`), a 2,012-element generated email as a `file:` tree (`gen`), and a body from an API through the components
  (`api`, `templates: true`).

## The breakdown at the start (`c6557d4`)

Counts a page (`SN_COUNT=1`):

| | blog post | mail file | mail gen (2,012 el.) | mail API |
| --- | ---: | ---: | ---: | ---: |
| row bindings run | 1,063 | 2,186 | 131,520 | 0 |
| reads through a row's proxy | 1,758 | 2,572 | 162,146 | 0 |
| rows and instances walked | 492 | 73 | 4,894 | 0 |
| templates rendered (rows, branches, instances) | 804 | 175 | 10,931 | 0 |
| `writeFirstPaint` in rendered rows: style / attr / text, class | 0 / 120 / 38 | 1,859 / 194 / 3 | 108,974 / 10,395 / 3 | 0 |
| candidates `prerender` runs (both passes; most fail at once) | 60 | 4,517 | 4,517 | 8,776 |

Wall ms a call, p25 / median / mean over the build's pages (3 rounds; the first pages pay V8's warm-up and, on
sinter-mail, the unit):

| | blog static | mail file | mail gen | mail API |
| --- | ---: | ---: | ---: | ---: |
| `compile()` | 8.38 / 10.0 / 12.9 | 36.7 / 44.6 / 126 | 300 / 344 / 431 | 131 / 144 / 288 |
| the evaluation (`decideFor`; pass-1 `settle`) | 5.45 / 6.82 / 7.74 | 14.4 / 18.6 / 22.8 | 235 / 258 / 271 | 9.1 / 12.8 / 13.0 |
| pass-2 `prerender` | 0.17 / 0.19 / 0.19 | 0.39 / 0.44 / 0.49 | 9.0 / 10.2 / 12.0 | 8.0 / 11.2 / 9.6 |
| `fileConstants`, pass 1 / pass 2 (p25) | 0.01 / 0.01 | 0.01 / 0.01 | 8.5 / 8.6 | 0.01 / 0.01 |

Inside the 2,012-element email's pass-1 evaluation (`--cpu-prof`, 200 µs, ms a page under the profiler, 355 in all):

| part | ms | what |
| --- | ---: | --- |
| `writeFirstPaint`'s style writes | 88 | each of an element's 55 style properties splits its whole `style` on `;`, trims, filters and joins it again (1,871 of its 2,173 ticks on those two lines) |
| filling the rows (`fill`, `paint`, `read`) | 60 | per binding per row: `defAttr`/`folded` lookups, the record's `Map.get`, `read`'s regex and `stateSites` of the same dependency list again |
| the worklist's walk (`nodesOf`'s own) | 52 | per binding: `out.paints.push([b, prefix, cw])` (a tuple and a `ConstantWrite` each: 506 + 217 ticks), `rec.set(b, cw)` 216, the plan loop |
| the evaluation proper (`run`: the compiled functions and the proxy) | 22 | 131,520 calls: `folding.start`/`end`, a `Map.get` by code, the try, the function, 1.2 reads each through the row's proxy (its trap: 3 ms) |
| `fileConstants` (both passes) | 30 | `structuredClone` and `deepFreeze` of the email's tree, every pass |
| cloning, `render`, `replace` | 26 | the template's content node by node, `Map.set` per node |
| `plainData` of the lists (`plainHeight`), `frozenData` | 15 | |

A blog post (`decideFor`, 8.1 ms under the profiler at 100 µs): the post's `md.parse` 2.7 (the library's parse, per
page by nature), `frozenPlain`'s walk of its tree 0.8, rendering 2.5 (`fill` 0.9, `clone` 0.8), the walk 1.8, of it
the row bindings' functions 0.34, `plainData`/`frozenData` of the lists 0.9.

A sinter-mail API page (`prerender`, both passes, 8.7 ms a call under the profiler): per call 4,396 candidates
collected (`value` over the unit's 355 templates' bindings, nearly all `tpl` and failing at their first step), 4,207
codes looked up, of which 2,096 compiled by the page's own `new Function` (in pass 2, where no unit is placed: the
page's own copy of the definitions; 0.66 ms a call), `unitTable`'s per-page map of the codes it uses, `usedCodes`'
`Set`, `failsFirst`'s regex per candidate, `writtenState` (twice).

**What this says about the shape of step 1.** A combined function per template that returns a row's values in one
call takes away the 22 ms of the evaluation proper and nothing else: the 131,520 functions themselves are cheap, and
the scope's proxy is 3 ms. What costs is what is done with each value (`writeFirstPaint`, the records, the renderer's
lookups): 88 + 60 + 52 ms. So the order is: the style written once per element; the records and the renderer driven
by a plan per template (what each node and binding is, asked once, and positions instead of lookups); the combined
function as the way the plan's values are computed (one call a row, a `try` per value, no `folding` bracket for a
value that calls no helper), behind its switch and its audit; then the fixed per-page work (`fileConstants`, the
unit's candidates).

## Plan

1. The renderer: an element's style bindings written at once (`StyleWrites`), what a row's element and its bindings
   are asked once per node (`fillPlan`), a dependency list read once per render (`read`).
2. The row program: per template, one compiled function returning the row's values (pure codes; a code that calls a
   helper or reads `$z` stays a `run` of its own, in its place), the row's record as an array by binding position, the
   paints recorded flat; the per-binding route behind `SN_ROW_FN=0`, `SN_ROW_FN_AUDIT=1` comparing every value and
   the whole compile.
3. The render plan: the clone as a flat list by position, a node's clone by index.
4. `fileConstants` once per value (`FROZEN_COPY`), the unit's candidates kept on the unit.
5. The bug: `own` past its candidate.

## Changes

(each with its A/B numbers; byte for byte against the base unless said)

### 1. Rendering a row: an element's styles written at once, its node read once, a dependency list once

- **`StyleWrites`**: the style bindings of an element a rendered row made, written one after another as
  `writeFirstPaint(el, 'style', name, v, true)` writes each, without splitting and joining the whole `style` at every
  one. The declarations are a list with each one's property; a write filters the list by property as
  `writeFirstPaint` filters the split value (the split of a join of declarations with no `;` and no space at either
  end is the list itself; a declaration that has one is split again at the next write, as `writeFirstPaint` would
  split it). The attribute is added and removed where `writeFirstPaint` adds and removes it (its place among the
  element's attributes), and its value written once at the end of the element's bindings: nothing reads or writes it
  in between, as an element with a `data-sn-attr` of `style` writes one at a time. `SN_STYLE_BATCH=0` turns it off.
- **`fillPlan`**: what filling a row's element asks of its node, the same in every row: the bindings it writes in
  their order (not a definition root's `$a`, not `else`, not what `prefold` writes first) and why the rows cannot be
  rendered if one cannot be (a handler that stays, a kind no row paints), asked at the same place in the order as
  before, so a fallback's reason is the same.
- **`read`**: a dependency list once per render (its resources and its state's sites, the same items in the same
  order: a list read again adds nothing to the two sets).

Test: random sequences of style writes (another case of a property, one written twice, `;` and spaces in values,
`null`; no style, an empty one, one with declarations; another attribute written in between) through `StyleWrites` and
through `writeFirstPaint` one at a time give the same attributes (checked to fail when a declaration with a `;` or a
space is not split again).

A/B, wall ms a call, p25 / median / mean (3 rounds; API 2): mail gen pass-1 `prerender` 233 / 256 / 268 → 148 / 168 /
177 (`compile()` 300 / 344 / 431 → 214 / 242 / 341); mail file 13.0 / 16.4 / 20.4 → 13.3 / 14.8 / 20.9; blog static
`decideFor` 5.45 / 6.82 / 7.74 → 5.68 / 7.43 / 8.08 (no style bindings there; within the rounds' spread). Every app
and sinter-mail page byte for byte the base's; test/compiler 1,122 passed, also under `SN_RENDER_AUDIT=1`.

### 2. A row's values in one call per template; the row's record an array by position

- **The row program** (`rowProgram`, `progOf` in the worklist): per template (its node list), one function that
  returns the row's values at their places in the record, each code's value in a `try` of its own (FAIL for one that
  throws, as `run` makes it, for that binding alone). Its codes: every binding of the template that the walk may paint
  or decide (a kind a row paints, an `if`, a `for`; not a choice's or a placement's, which are fewer and stay `run`s),
  from the same code text the table compiled (`($) => (…)` is evaluated in place, any other shape as its own arrow
  called with the row's scope). Its names (the helpers' folding wrappers, the formatters, the stubs, `$k`, `$href`…)
  are the table's, bound to this evaluation's values: the function is made from a factory compiled once per source
  and names (`ROW_FACTORIES`, the same text whichever page asks; bounded for a dev server), and the codes at their
  places are kept by the template's nodes (`ROW_PARTS`, checked against the codes and the names at each use), so a
  unit's templates are read once for the build, a kept template's once for its entries.
- **What it does not change.** The walk asks exactly what it asked: each binding's plan, `known` per row for a state
  field, `fixed`, `handlerOnly`, the budget, `firstPaintValue`, the order of the decisions and paints. Only where a
  value comes from: the row program's place, or `run` when it has none. A code that names an app helper, a
  namespace's member or a lazy module (`$.$z`) is not in the program (`pure`): it runs on its own, in its place,
  inside `folding`'s bracket, so a helper's calls, its memo, `foldWhy` (SN322) and SN534 are what they were. Why the
  order of the rest cannot matter: an expression cannot assign (SN203), the scope's data is frozen, its proxies only
  answer or throw, and the names left (`$k`, `$href`, `$hq`, `$hv`, the stubs that throw, the formatters in the page's
  language, whose locale is put back in a `finally`) have no effect but their result. A code the program evaluates and
  the walk never asks for (a binding after a stop, one whose dependencies are not known) is a value nobody reads.
  Every code in a program is in the table (`rowCodes` lists every template's row codes), so `run` would have run it.
- **The record** (`RowRec`) is an array laid out by the template (`rowLayout`): the row's item at 0, node `i` at
  `base[i]` (a choice's case, a placement's, an `if`'s kept branch's own record), its binding `j` at
  `base[i] + 1 + j` (`firstPaintValue`'s pair or null, a text's value or `UNDEFINED`, an `if`'s value, a loop's rows).
  An `if`'s branch now records into a record of its own at its node's place (it shared the row's `Map`). The paints the
  walk collects for `rowPaint` are flat, three entries a binding (`paintsOf` spells them out where they are committed,
  in their order). `RowRec`'s readers are `rowRenderer`'s alone (stage 5 B1 reads rows through it too).
- **Switch and audit.** `SN_ROW_FN=0`: every value its own call (`run`), as before. `SN_ROW_FN_AUDIT=1`: every value
  of a row program run again on its own and compared (`sameValue`), and every compile done again with `SN_ROW_FN=0`
  and its result compared field by field (as `SN_RENDER_AUDIT` does). `SN_ROW_FN_LOG=1` prints the fallbacks.

Fallbacks seen (`SN_ROW_FN_LOG=1`): none on the benchmark apps, the examples and sinter-mail's pages but codes that
call a helper (the blog's `md.*` calls in its page template, none in rows).

Tests: a row program's values at their places (a block body called, FAIL for a throw, an empty place); a value that
throws, FAIL for its binding alone; a helper's call among a row's pure values, an undefined text, branches in a row;
choices in rows and a tree; each both ways and rendered and not. test/compiler under `SN_ROW_FN_AUDIT=1`: no value and
no compile differs; the 64 tests that count compiles, links or rendered rows fail by construction (every compile is
done twice), as under `SN_UNITS_AUDIT`.

A/B against change 1, wall ms a call, p25 / median / mean: mail gen pass-1 `prerender` 131 / 166 / 166 → 118 / 130 /
141 (`compile()` 189 / 233 / 315 → 179 / 194 / 288); mail file 14.0 / 15.5 / 20.7 → 13.1 / 16.0 / 20.6; blog static
`decideFor` 5.31 / 6.56 / 7.31 → 5.42 / 6.61 / 7.48 (5 rounds: the same). A first version made each page's programs
anew (their source and key strings, a `bindPlan` of every node): 1.8 ms a page on the mail file's 65 components with
few rows each; hence `ROW_PARTS` by the template's nodes.

### 3. A row's paints read back from its records where they are committed; the pairs that are the same, one each

- **`replayPaints`**: rendering, the walk records every paint at its place in the row's record and collects no list of
  them (`out.paints` was 131,520 pushes of three a page on the 2,012-element email, 5 ms; a rendered loop reads only
  the paints of the bindings the layout and the images read, `constB`, none there). Where a loop is committed, its
  paints are read back from the records in the walk's order (each node's bindings in order, an `if`'s kept branch at
  its place, a loop's rows, a choice's case, a placement's, each row's prefix as the walk made it): all of them for a
  loop the second pass compiles (`rowPaint`, by prefix), only `constB`'s for a rendered one, through the templates from
  which one of `constB` is reachable (`reaching`: the template graph walked backwards from the templates that hold
  one). Without rendering the walk collects them as before. `SN_ROW_FN_AUDIT=1` collects both and compares them, loop
  by loop (checked to throw when the read-back leaves a kind out).
- **`firstPaintValue`'s pairs that do not depend on the binding** (`['style', null]`, `['attr', null]`, `show`'s and
  `class`'s two each): one frozen pair each, not a new one per binding (sinter-mail: 55 style writes an element, most
  `null`); `isPrimitive` without an array per call.

Tests: rows the second pass compiles on a page with stylesheets (rows, a branch, nested rows, a tree through choices),
and rendered rows whose class or style a stylesheet reads, both routes, rendered and not.

A/B against change 2, wall ms a call, p25 / median / mean (3 rounds; blog 5): mail gen pass-1 `prerender` 116 / 142 /
141 → 105 / 123 / 132 (`compile()` 171 / 208 / 283 → 167 / 188 / 280); blog static `decideFor` 5.48 / 6.80 / 7.68 →
5.73 / 7.19 / 7.93 (nothing of it runs there: no stylesheet, no style binding; the blog's rounds move by ±0.3 ms
between runs).

### 4. A `file:` value copied and frozen once, not in every pass

`fileConstants` copied and froze each `file:` value for the evaluator in every pass (`deepFreeze(structuredClone(v))`):
~8.5 ms a pass on the 2,012-element email. A file's parsed value is already one object for every page and pass that
reads it (`fileValue` keeps it by path and text; `select` reads a part of it), and nothing writes it: the compile's
other uses of `fileData` read it (keys, entries, an axis list's JSON, the embedded JSON). So its frozen copy is made
once per value (`FROZEN_COPY`, a `WeakMap` by the value: it lives as long as the parse does). A value made for one
page (a list `order` sorts anew) is a new object and copied as before; a glob's list is frozen once already
(`globCache`). What changes: two passes, and two pages reading one file, see one frozen copy instead of one each; the
evaluator only reads it, and what it hands on (a row's item, a part of it) was shared already within a pass
(`frozenData`). One identity could show: a helper whose result is its argument (a frozen file value), shared as
`frozenPlain` shares it, names that object by reference in the build's fold log (`refs`) in the second pass too, where
it was a copy of its own before. `SN_FILE_COPY=0`: a copy per pass.

Test: a page reading two files, compiled twice and with `SN_FILE_COPY=0`: the same.

A/B against change 3 (3 rounds): mail gen `fileConstants` 8.19 / 8.40 → 0.03 / 0.02 ms a pass (p25, passes 1 / 2),
pass-2 `prerender` 8.77 → 0.27, `compile()` 173 / 182 / 291 → 155 / 172 / 269. Nothing else reads a `file:` value
that large: the blog's list is a glob (frozen once already), the mail file's email is a string.

### Merged `35bed5c` (the integration branch)

Base for the byte comparisons from here on: `35bed5c` (the build outside the compiler, stage 5 A1 in units.ts and
compile.ts). After the merge: every app, example and sinter-mail page byte for byte that base's; `render-audit` (also
`--switch SN_UNITS`) and `pass-audit` the same; test/compiler 1,140 passed plain and under `SN_RENDER_AUDIT`,
`SN_ONE_PASS_AUDIT`, `SN_LINK_AUDIT`, `SN_FROM_WALK_AUDIT`; under `SN_UNITS_AUDIT` the same 62 tests fail as on the base
(they count compiles). sinter-mail's own suite (`mail-audit --suite`): `npm test` 234 passed, `npm run check` clean;
`npm run typecheck` fails on `mail-width.ts` (`root`, `props`, `emit` not on its class) on the base as well: the
checkout's, not this work's.

### 5. A rendered loop's paints collected for the layout's bindings only; a row program for two values or more

Measured after the merge, base against this branch (blog static, 7 rounds): `decideFor` p25 5.17 → 5.48 ms. The
profile said why: on the blog the read-back of change 3 ran for every rendered loop (its `constB` is not empty: the
images' attributes), 0.3 ms a page, and its row programs hold 1.25 values a call (816 values in 654 calls a page:
small templates), where a function and an array cost about what they save. So: rendering, the walk collects the
paints of `constB`'s bindings as it goes (`constB` is the program's, which the walk does not change: computed at the
first paint the walk could collect, where it was computed at the first rendered loop before), and reads back from the
records only for a loop the second pass compiles; a template with one value in its program has none (its value is its
own call). The program of a template is found on its layout for the evaluation (`fnOf`), not in a map per row.

blog static, 9 rounds, base `35bed5c` → this: `decideFor` 5.21 / 6.76 / 7.35 → 5.36 / 6.71 / 7.55 (the same within
the rounds). mail gen against change 4 (3 rounds): pass-1 `prerender` 83.2 / 94.2 → 79.6 / 95.0.

### 6. The render plan: a template's content copied from a flat list, a node's copy found by its place

- **`cloneList`**: a template's content as `render` copies it, made once per renderer (per evaluation) and template:
  its nodes in the order a walk meets them (an element, its children, then a template's content unless it is an
  anchor's), each with where its copy goes (the node whose copy holds it, or the row's fragment; in a template's
  content or not), and each node's place in the list. `render` copies the list in a loop (`clone` makes one node, with
  everything it did before: the attributes before paint, the ids, the uses, the links, the marks of scoped styles,
  `shownOf`, `WRITTEN`, `RENDERED_FILE`, in the same order, the same preorder), and `fill` finds a node's copy by its
  place (a `Map` per row with every node's copy, built as it went, before). An image the first pass rewrote in the
  template (its `<picture>`) is the image it was, at the picture's place too, as before.
- **A case's component files** (a placement's case, which the old route's expansion reads where it renders): listed
  once per template (`caseFilesOf`), not walked again in every row.
- **`StyleWrites`** only for an element with a style binding (it was made for every bound element).

A/B against change 5 (9 rounds blog; 3 the email), wall ms a call, p25 / median / mean: blog static `decideFor` 5.41 /
6.70 / 7.40 → 5.19 / 6.31 / 7.30 (`compile()` 8.27 / 9.69 → 8.00 / 9.51); mail gen pass-1 `prerender` 78.1 / 85.4 →
77.5 / 85.1. Byte for byte the base's; test/compiler 1,140 passed, also under `SN_RENDER_AUDIT=1`.

### 7. The bug: a persisted model's own path past its candidate (redesign-notes/bugs.md, 7)

Decided from the code's intent (the comment at `own`: "a persisted model's own state path: its initial value is the
fallback when storage has none", for that model's first paint): `own` holds only while its candidate is evaluated, and
is null again after the candidates, for the texts and the worklist's `finish` walk. What changes in the output:
nothing, for any page, and that is proven rather than measured: every `known` after the loop is behind `fixed` of the
same dependencies, `fixed` refuses written fields, and every persisted path is written (`writtenState`); the state
proxies are reached only through reads the dependencies name. So no test can fail before the fix; the test added pins
the behaviour (the model last against the model first: the same page, both routes, rendered and not) and passes on
both sides. The fix matters for what comes next: once deciding reads the units' summaries instead of `fixed` over the
page's writes, `known` alone would have let the last model's field through.

### 8. A unit's part of the evaluation's candidates read once for the build; its table served as it is

On a page with a unit placed (sinter-mail's pages), `prerender` asked every binding of the unit's 4,000 bound template
elements whether it is a candidate (`value`, `decide`, `fixed` of each) in each pass, ran each candidate (4,396 a call:
nearly all a definition's bindings, which read a prop first and fail without running, `failsFirst`), and built a map
of the unit table's functions it uses (`unitTable`'s `out`, 4,000 entries a page).

- **`unitCands`** (`BuildUnit.evalCands`, the unit's own): the unit's elements are the first of a page's `tplEls`
  (placed before the page's walk: `place` records how many, `BuildUnit.placedEls`); of their bindings, in order, the
  unit keeps each that `value` would take but for `fixed` (which reads the page's writes and resources, asked on each
  page) and each `if` (`decide` asks the page), and leaves out a value candidate whose code fails at its first step: its
  evaluation is FAIL without running it, and a template's value that is FAIL does nothing (no paint, no record; `run`'s
  bracket resets `folding` and records nothing). An `if` that fails is kept: it marks its key undecided. Checked on each
  page (the same elements in the same order, the same codes), else every binding is asked as before (counted:
  `unitFallback`). Left out of the candidates, their codes are left out of `used` too: they are the unit's, served by
  the unit's table, never compiled by the page (`mine` is what the unit's table does not have).
- **`unitTable`** returns the unit's table as it is (a map of all its functions): the evaluation asks for nothing but
  the codes it uses (its candidates', its states', its texts', the rows' `rowCodes`), and those it finds there as in the
  per-page map it was built from. `SN_UNIT_CANDS=0`: every binding asked on every page.

Test: the units tests' pages through one build's units, twice over (the first page makes the unit), the same with
`SN_UNIT_CANDS=0`; test/compiler also under `SN_UNITS_VERIFY=1` (no unit object left changed).

A/B against change 6 (3 rounds), mail API: candidates a call 4,396 → 612; pass-1 `prerender` p25 / median / mean 5.92 /
7.19 / 9.40 → 3.69 / 4.35 / 7.73 (`settle` 7.19 / 8.61 → 4.72 / 5.74). The second pass places a unit of its own (A1)
and reads its candidates the same way; its `prerender` (8.3 ms) is now the page's own codes, compiled by the page's own
`new Function` and each run once, its first call compiling it (V8 compiles a function's body at its first call).

### 9. A `file:` value's heights measured once for the build

`plainData` measures how deep each list's items nest (`plainHeight`, bounded by `PLAIN_DEPTH`), keeping the heights of
frozen data for one evaluation. On the 2,012-element email every level of the tree is a list the walk measures, on
every page, of the one frozen copy every page reads (change 4). That copy's heights are now measured once, where it is
made (`measureFrozen`, `FROZEN_HEIGHTS`, a `WeakMap` by object: frozen data cannot change), and `plainHeight` reads them
after its own maps. Only for the copy: making every frozen object's height global (a `WeakMap` for all of them, or
one for `DEEP_FROZEN` and the heights together) was tried first: the blog's trees are new on every page, so it gained
nothing there and paid a `WeakMap` insert per object (0.1 to 0.15 ms a page in two runs of 7 and 9 rounds).
`SN_FROZEN_HEIGHTS=0`: measured by each evaluation.

A/B against change 8 (3 rounds; blog 9): mail gen pass-1 `prerender` p25 / median 80.4 / 95.3 → 76.0 / 84.6; blog
static `decideFor` 5.47 / 6.87 → 5.53 / 6.79 (the same).

### 10. Per binding, two questions asked once: whether its paint is the layout's, whether its dependencies read anything

- The walk asked `constB.has(b)` for every paint of every row (131,520 a page on the email): asked once per plan entry
  and evaluation (`constOf`, on the `BindPlan`, by an evaluation token).
- The renderer read every painted binding's dependencies in every row (`read`: a set lookup at least); a binding whose
  dependencies name no resource and no state's site (a definition's bindings read only their props) adds nothing to
  the rows' reads, so `fillPlan` says so once (`rd`) and the row does not ask.

A/B against change 9 (3 rounds): mail gen pass-1 `prerender` p25 / median 75.5 / 88.4 → 74.9 / 81.2.


## The end: before and after

Wall ms a call, p25 / median / mean over the build's pages, A/B interleaved on the idle machine: **before** is this
branch's tree with its ten commits reverted (the integration branch `de23476` with everything else merged: its output
is byte for byte this branch's), **after** is this branch (7 rounds for the blog, 3 for sinter-mail). Whole builds: the
median of the rounds' `run-sinter.mjs` times.

| app | phase | before | after |
| --- | --- | ---: | ---: |
| blog static | `decideFor` | 5.72 / 7.08 / 8.06 | 5.50 / 6.86 / 7.74 |
| | `compile()` | 9.06 / 10.6 / 13.5 | 8.57 / 10.1 / 13.4 |
| | build | 2.93 s | 2.78 s |
| blog live | `decideFor` | 5.71 / 7.48 / 8.39 | 5.81 / 7.67 / 8.47 |
| | `compile()`, build | 10.6 / 12.4 / 16.1, 3.63 s | 10.5 / 12.5 / 16.0, 3.57 s |
| blog static-files | pass-1 `settle` | 6.38 / 7.87 / 8.75 | 6.36 / 7.71 / 8.41 |
| | `compile()`, build | 14.1 / 16.1 / 19.7, 3.67 s | 14.1 / 15.3 / 18.9, 3.56 s |
| blog live-files | pass-1 `settle` | 6.30 / 7.64 / 8.74 | 6.39 / 7.85 / 8.86 |
| | `compile()`, build | 16.1 / 18.0 / 21.6, 4.39 s | 16.4 / 17.9 / 22.0, 4.24 s |
| blog static, type check | `decideFor` | 5.83 / 7.10 / 7.84 | 5.68 / 7.05 / 7.96 |
| | `compile()`, build | 9.30 / 10.7 / 13.8, 3.10 s | 9.12 / 10.4 / 14.1, 3.10 s |
| mail file email (`mail.parse`) | pass-1 `settle` | 15.9 / 19.7 / 23.2 | 12.6 / 15.1 / 20.5 |
| | `compile()`, build | 40.3 / 44.1 / 131, 2.86 s | 37.9 / 41.7 / 129, 2.81 s |
| mail 200-element email | pass-1 `settle` | 38.1 / 41.4 / 48.9 | 16.3 / 19.9 / 25.5 |
| | pass-2 `prerender` | 1.23 / 1.62 / 1.53 | 0.22 / 0.25 / 0.29 |
| | `compile()`, build | 64.3 / 77.1 / 167, 3.00 s | 40.5 / 48.8 / 140, 2.61 s |
| mail 2,012-element email | pass-1 `settle` | 231 / 273 / 264 | 78.8 / 90.7 / 104 |
| | pass-2 `prerender` | 8.83 / 9.61 / 11.6 | 0.27 / 0.31 / 0.34 |
| | `compile()`, build | 302 / 347 / 417, 6.17 s | 135 / 149 / 244, 4.19 s |
| mail API (components) | pass-1 `settle` | 6.95 / 8.80 / 11.4 | 4.79 / 6.25 / 9.31 |
| | pass-2 `prerender` | 8.39 / 10.8 / 11.3 | 8.26 / 8.76 / 9.80 |
| | `compile()`, build | 64.8 / 75.5 / 230, 3.82 s | 63.5 / 67.8 / 226, 3.87 s |

Against this work's start (`c6557d4`, before the integration branch's other merges), the blog's phases are the same
within the rounds (static `decideFor` 5.77 / 7.37 → 5.98 / 7.63 in a 5-round run on a warmer machine, live 6.08 / 8.00
→ 5.79 / 7.55): the blog does not gain from this work, and nothing of it costs the blog more than the rounds' spread.

## Fallbacks, by reason

- Row programs (`SN_ROW_FN_LOG=1`): a code that names an app helper, a namespace's member or a lazy module is its own
  call in its place (the blog's `md.*` calls are in its page template, not in rows: none in rows of any app); a
  template with one value has no program (by design, change 5); a template whose values do not compile together: none
  seen.
- The unit's candidates (`unitFallback`): a page whose unit's elements or codes are not the unit's: none seen; the page
  that makes the unit asks every binding (it has no list yet).
- Rendering's own fallbacks (`SN_RENDER_LOG=1`) are unchanged: the examples' `layout`.

## Tried and dropped

- **A combined function as the whole of step 1.** The measurement first: the evaluation proper was 22 of 355 ms on the
  email and 0.34 of 8 ms on the blog, so the row program is one piece of the plan, not its order of magnitude. Its first
  version made every page's programs anew (source, key, a `bindPlan` of every node: 1.8 ms a page on the mail file's 65
  components with few rows); hence `ROW_PARTS` by the template's nodes. Programs of one value cost about what they
  save (the blog: 1.25 values a call): none for one value.
- **The row's names as parameters (no proxy).** The proxy is 3 ms of the email's 355 and nothing on the blog; rewriting
  `$.name` in code text to locals needs a tokenizer to be safe (a string literal can hold `$.x`). Not done.
- **Every frozen object's height for the build** (a `WeakMap` for all, or `DEEP_FROZEN` and the heights in one): the
  blog's trees are new on every page, so it paid a `WeakMap` insert per object and gained nothing; kept for a `file:`
  value's copy only.
- **The read-back of every rendered loop's paints** (change 3): on the blog it ran for every loop (its images'
  attributes are the layout's); the walk collects those as it goes now (change 5).

## What is left

- **The blog** (`decideFor` ~5.5 ms steady): the post's `md.parse` (~1.8, the library's), `frozenPlain`'s walk of its
  tree (~0.5; a mark shared with `memo()` would need a change to the shipped `memo`), the lists' `plainData` and the
  case props' `frozenData` copies (~0.6), the walk per node (`nodesOf`: the decisions' key strings, `prefix + key`, made
  for every `if` in every row though only a loop the second pass compiles reads them; `bindPlan`'s loop), rendering per
  node (`fill`'s lookups by node: a fill plan with each node's kind and its copy's place would replace them; `clone`'s
  attribute copies, which are the output's).
- **The email** (79 ms for 2,012 elements, 131,520 bindings): ~0.6 µs a binding left, spread over the walk (the plan
  loop, `firstPaintValue`, the record), the renderer (the acts loop, `StyleWrites.write`) and the clone. The next step
  there is a paint program per element: one function from the row's values to the element's attributes (its style's
  declarations joined in one pass), generated from the same plan, with `writeFirstPaint` as its reference.
- **The API page's second pass** (8 ms): its own codes, compiled by the page's `new Function` and each run once, so each
  is compiled at its first call. A cache of compiled codes by text across pages (as `ROW_FACTORIES` does for row
  programs) would take it to what the unit's codes cost.
- **`rowRenderer`'s per-evaluation setup** (`tplOf`, `anchors`, `hostOf`, the plans): per entry of a kept template;
  could be kept with the evaluation's program (`evalProgram`) as the walk's memo is.
