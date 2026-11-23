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
