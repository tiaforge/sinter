# Stage 5, step B1: a page's second pass taken from its first pass's walk

Running log (2026-11-23), branch `redesign/stage5-b1`, started at `5f203af` (the integration branch as found).

## Where the work stands (read this first)

- **Done**: the measurements (1, 2); the route for pages of their own (`compileTwice`): a first pass whose second pass
  would apply only page-level decided branches and rendered rows takes the second pass's result from its own walk
  (`Compiler#fromWalk`, 3, 4), behind `SN_FROM_WALK=0`, audited (`SN_FROM_WALK_AUDIT=1`), with counted fallbacks
  (5) and tests (test/compiler/from-walk.test.ts). page-compile: 451 → 359 ms.
- **Built, off by default**: a template's entries from a copy of the kept walk (`entryFromWalk`,
  `SN_FROM_WALK_ENTRIES=1`): audited over the blog's 100 entries, but the copy costs more than it saves (8).
- **Next**: the numbers (9), sinter-mail, page weight; then what B2 needs (7): pages with a unit placed (every page of
  a vite build that shares definitions) need the page's own copy of the unit's objects (A1's structural copy); a
  template's entries need a copy of the kept walk without the definitions the decided branches drop.

## How it is measured

- The machine: a cloud container, 4 cores (Intel Xeon @ 2.10GHz), 15 GB, Node 22.23.5, nothing else running
  (load under 1 before each run).
- `SN_APPLIED_LOG=<file>` (src/compiler/compile.ts, `appliedLog`): one line per second pass, the kinds of decision
  it applied and where (recorded by `expandConstants` as it applies them), the first pass's context (a layout, the
  image pipeline, a kept element), the test or page. Kinds: `if:<where>` a decided `data-sn-if`, `loop rendered` a
  block spliced, `loop unrolled:<where>` an unrolled loop compiled the old way, `choice dropped/inlined/rendered`,
  `point inlined`, `constants (prefold)` (`opts.constants`: values the layout or the images read), `over limit`;
  `<where>` is `page` (outside templates, rows and instances), `row`, `instance` or `template` (a template that stays).

## 1. Reference: whole builds on the integration branch as found (`5f203af`)

`node bench/astro/run-sinter.mjs`, 100 posts, 3 rounds, ms (median in bold):

| variant | round 1 | round 2 | round 3 | median |
| --- | ---: | ---: | ---: | ---: |
| static | 3646 | 3037 | 2747 | **3037** |
| live | 3386 | 3544 | 3415 | **3415** |
| static-files | 3579 | 3594 | 3986 | **3594** |
| live-files | 5539 | 5521 | 5699 | **5539** |
| static, type check | 3147 | 2902 | 3017 | **3017** |

page-compile (`node bench/page-compile/run.mjs 200 7`, 3 runs): median 419 / 375 / 361 ms, min 272 / 258 / 268.

## 2. What the second passes apply

### The suite (`SN_APPLIED_LOG` over `npx vitest run`: 300 files, 2,883 tests pass)

2,040 second passes. By what they apply:

| applies | second passes | of them with a layout / images / a kept element |
| --- | ---: | --- |
| loop rendered | 1,728 | layout+images 61, images 75, layout 6 |
| if:page | 92 | kept element 8 |
| if:page + loop rendered | 14 | |
| **routable by the plan (the three above)** | **1,834 (90%)** | |
| loop unrolled (the old row route, `SN_RENDER` reasons) with or without others | 160 | |
| constants (prefold), with others or alone | 52 | |
| choices (dropped, inlined, rendered) | 46 | |
| if:row / if:instance / if:template | 63 | |
| over limit | 1 | |

(A line counts in every row whose kind it has; the routable rows are exact.) Where the 1,728 `loop rendered` come
from: the behaviour fuzzers (wrapper 735, component 297, reactivity 118, anchor 95, minify 92), units 64,
render-rows 61, constant-differential 46, vite origins 34, link 30.

### The apps (`scripts/pass-audit.mjs`, both of its builds, so each page twice)

| app | second passes a build | applies | context |
| --- | ---: | --- | --- |
| the five blog variants | 100 each | if:page + loop rendered (`$build` chooses `<md-tree>`; its loop rendered) | images |
| static-site, multilingual-site | 6, 8 | loop rendered (12 pages); constants + loop rendered (2) | layout, images |
| realworld | 1 | constants (prefold) + if:template | layout, images |
| dashboard | 0 | | |
| page-compile | 1 | if:page (its 200 `if`s over state nothing writes) | |

So the plan's kinds cover the pages the route was for: every blog entry, page-compile, the examples' pages but
two, and 90% of the suite's second passes. The image pipeline (and, on the examples, the layout) runs on most of
them: the route has to give the image pipeline and the minifier the markup the second pass gives them, or fall back.

## 3. What differs between the first pass's walk and the second pass's result, and how the route makes them one

Stage 3's table (stage3-one-pass.md) for the kept walk, extended to a page of its own whose first pass decided only
page-level branches and rendered loops, and read off the canonical audit while the route was built. The first pass is
evaluated without writing into its markup when the route may be taken (`decideOnly`: `prerender(true)`, as
`decideFor` evaluates a kept template's entry), so its walk is as walked; the second pass's evaluation (`settle`)
then runs on the result, with the write set of what is left (decisions.md 7.1, item 2: decide with W1, paint with W2).

| | first pass's walk | second pass | the route |
| --- | --- | --- | --- |
| a decided branch's content | compiled as a template (`tplEls`, paths, its walk's additions to the tables), its markup changed by that walk (`stripSn`, text anchors, merged texts) | spliced in by `expandConstants` before the walk, walked as page markup | its markup put back as it was before the walk (`snapTree` at `fwStart`, `restoreTree`), the decisions inside it applied by `expandConstants` on it, spliced where the template was, walked as the page's (`walkChildren` over that range) in the scope, state index, dialog and form the template was walked in |
| the `data-sn-else` after it | the same, a template | the kept one spliced, the other gone | the same as the branch |
| the condition | compiled: a function, its reads (`used` resources, helpers) | not compiled; its text in `foldedText` | its function's calls taken off (`fnUses`), the resources the walk read first unread again and read by the new walk, else SN501 as the second pass reports it (fallback when it would) |
| a rendered loop | a template, its row template walked | the rows spliced (`splice`), what compiling them does that the page keeps (files, reads, uses, scoped roots, ids' gap, links) | the same splice, the walk over the rows (`renderedAt`: the list compiled for its diagnostics, the links, the ids' gap) |
| what the dropped walks added to the tables | there | never there | taken out: a list's entries by position, a map's or a set's by key (`fwMarks` before and after each recorded template: every table of the compiler and of the page info, and every plain field); what the new walk adds to a list put where the dropped walk's entries were (document order) |
| `roots` and their indexes | the anchors | the branch's nodes in their place | each block in place of its anchor (and its else); every index of a root renumbered once: a node's `p`, an `if`'s `y`, a resource's and a sync's `scope` |
| functions | the dropped walks' code in the table | not there | their calls taken off; a function nothing else calls `'0'` and out of the index (so the new walk compiles it again with its own site); one the dropped walk made first and something else calls: a fallback (its site would be the branch's) |
| templates the dropped walks made | in the table | never made | emptied (`nodes: []`) and out of `tplEls`; `compactTables` drops them |
| first paint, constants dropped | not written (`decideOnly`) | written by its own evaluation | the second pass's evaluation runs on the result (`finishPage` → `settle`, not collecting) |
| the walk's last steps | over the first walk | over the second | scoped styles' marks (`markScoped`), what it removes, which resources load late (`markLowPriority`, after the dead templates are emptied) run again |
| `data-sn` ids | the walk's order, a block's gap added at its first row | the same over its own walk | handed out again in document order with each rendered block's gap (`renumberIds`): today's numbering wherever the old walk's order is the document's, which it is (pre-order); a kept element's ids keep theirs |
| the type check's unit | the first pass's | the first pass's (`compileTwice` hands it on) | the first pass's: its lists' lengths as before the route |
| diagnostics | the walk's | its walk's | the first walk's, with any in a recorded template a fallback (none in the suite but the reason's test) |

The image pipeline, the layout and the minifier read the markup before the walk: a decided branch's content as a
template's in the first pass and as the page's in the second (an image's eagerness, the layout's selectors, white space
at the edges), and rendered rows not at all in the first. Where that can differ the route falls back (counted): a
layout and a branch with elements, an image in a decided branch or in rendered rows, rendered rows and a minifier with
a layout (the browser's own styles count). The minifier without stylesheets only merges texts and drops comments,
which the rows' splice does as the second pass's does (the audit holds over the suite's minifier fuzzer).

## 4. Changes

1. `SN_APPLIED_LOG` (measurement, section 2).
2. The route (`fromWalk`, `fwStart`/`fwEnd`, `decideOnly`, `settleAgain`, `fwPlausible`, `renumberIds`,
   `markScoped`; `walkChildren` takes a range; `fn()` counts calls while a recorded template is walked; the new field
   `fw` in `LINK_FIELDS` as `fixed`, never set inside a definition; `copyState` copies it as it copies any plain
   object). `compileTwice`: when a first pass that may take the route (a recorded page-level branch over constants,
   or a loop over constants) is not finished, it is evaluated without writing; the route is tried when its decisions
   are only those; else the old route with these decisions, evaluated again writing only where its output or its
   constants need it (`settleAgain`: no decision at all, a constant the layout reads, a first pass that is finished).
3. Switch `SN_FROM_WALK=0`; audit `SN_FROM_WALK_AUDIT=1` (each routed page compiled the old way beside it and compared
   up to numbering, `canonicalText`; each page that recorded and fell back compared byte for byte); counts
   `SN_FROM_WALK_LOG=1` (at exit) and `SN_FROM_WALK_STATS=<file>` (a line per second pass, with the test).
4. The app audits take `--canon` (both builds with `SN_CANON=1`) and print the route's counts; `pass-audit.mjs` takes
   `--switch`.

## 5. Fallbacks by reason

To be filled from the milestone run (the suite under the audit, the apps).

## 8. A template's entries from a copy of the kept walk (built, off by default)

`entryFromWalk` (`SN_FROM_WALK_ENTRIES=1`): the kept template's walk records its page-level branches; each entry's
evaluation (`decideFor`) decides; when the route may be taken (`fromWalk(next, true)`, nothing changed), the kept
walk is copied (`copyState`, the evaluation's tables left empty: `FW_FRESH`; the side tables of the original listed
once per template, by the original's objects, so that each later copy looks up nothing: `sources`), the copy's paths
and canonical link written for the entry (`entryUrls`: the walk wrote the first entry's; `<html>`'s path is off it
already), and `fromWalk` makes it the entry's second pass. Over the blog's three template variants all 100 entries
take it, canonically the same as the old route (the audit; `pass-audit --switch SN_FROM_WALK`: bench-static and
bench-static-typecheck byte for byte, bench-live different only in `$s` numbering inside its early chunks).

It does not pay: the kept walk holds what the walk of the `$build` branch compiled, the markdown library's definitions
(26 choice candidates), and a copy of it costs about 7 ms an entry (CPU profile of one bench-static build:
`copyState` 706 ms over 100 entries) against 3.2 ms for the second pass from the kept expansion (`secondPass` 321 ms);
the build went from 3.4 s to 4.0 s. What would make it pay: a copy without what the decided branches drop (the
definitions they compiled are nothing's in the entry's page), or a kept walk transformed once per way the page-level
branches are decided (the same for every entry of the blog) and copied per entry with only its rows to splice.

## 6. Tests whose expectations changed

- test/compiler/one-pass.test.ts, "a page of its own (not a template's entry)": the page (a loop rendered) now takes
  its second pass from its walk, so nothing parses it again (`{}` where it counted one `a page of its own`); the old
  count is kept as an assertion with `SN_FROM_WALK=0`.

No expectation of a number changed: the route's ids are today's (document order plus each block's gap).

## 7. What is left before the second pass can be deleted (B2)

- A template's entries (`fromTemplate`/`secondPass`) still walk their page again from the kept expansion.
- Pages with a unit placed (every page of a build with shared definitions): finishing a first pass that shares the
  unit's objects would change them for the next page. The route needs the page's own copy of the unit's objects it
  keeps (A1's structural copy of `NodeDef`/`TemplateDef`/`Binding`s), or the unit's numbers at assembly.
- The other decisions: choices (dropped, inlined, rendered), recursion points, loops unrolled the old way, decided
  `if`s inside templates that stay and inside rows, constants the layout and the images read (`prefold`), else-ifs.
- The pre-walk passes over what the decisions change: the layout and the image pipeline over a branch's content and
  over rendered rows, the minifier with a layout over rows.
