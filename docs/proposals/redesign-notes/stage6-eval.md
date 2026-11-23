# Stage 6's evaluation: the first pass's rows, from one call per binding to a plan per template

Running log (2026-11-23). Branch `redesign/stage6-eval`, merged into `ccr-9ebf49d5-gpdej8` by the coordinating
session. Starting point: `evaluation.md`, "What is left (for stage 6)". Base: `c6557d4`.

## Where it stands

- Measured (below): the evaluation proper (the compiled functions and the scope's proxy) is a small part of what a row
  costs. The order of magnitude is in the bookkeeping around each binding: writing a style property by splitting and
  joining the element's whole style (sinter-mail: 109,000 style writes a page), the worklist's per-binding records, the
  renderer's per-binding lookups, and the copies of a `file:` value.
- Next: see "Plan" below; each change is listed under "Changes" as it lands.

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
