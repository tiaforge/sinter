# Stage 5, step B1: a page's second pass taken from its first pass's walk

Running log (2026-11-23), branch `redesign/stage5-b1`, started at `5f203af` (the integration branch as found).

## Where the work stands (read this first)

Continued on branch `redesign/stage5-b1b` (2026-11-23/24, second session; sections 11 to 20), then on
`redesign/stage5-b1c` (2026-11-24, third session; sections 21 on).

- **Done**: the route (`compileTwice` → `Compiler#fromWalk`) for pages of their own, with a unit placed (11), where
  folds ship nothing (12), rendered rows under the minifier's and the page's layout (15, 16), functions a dropped walk
  or the unit made first at the page's site, loops on pages that are not quiet (template entries compiled alone, 18).
  rendered rows with images and their image constants (19). Third session: a definition a dropped walk compiled first,
  compiled again where the route walks the branch; a unit whose definitions the page keeps, kept whole as the page's own
  and held (21). Suite under `SN_FROM_WALK_AUDIT=1`: 385 second passes routed (368 at the third session's start); the
  apps: the blog's page-file variants 200/200, static-site 6/6, multilingual-site 8/8, sinter-mail 3/16 (not run by
  this session: its repository could not be attached; the coordinator runs the mail audit).
- **Counted as done**: `no second pass (nothing decided)`: a page the route looked at that needs no second pass (52).
- **Written up, not built**: template entries (13; the coordinator holds them for stage 6's finding); prefold
  constants other than an image's own attributes in rows (realworld 1, sinter-mail 5, suite 48); the renderer's own
  fallbacks (18, stage 2/6's).
- **Next** (the coordinator's order, 2026-11-24, third session): (2) choices (16, §18), then (3) the old second-pass row
  route's fallbacks (what each needs, what is contained built), then (4) the list of what still needs the second pass, by
  reason, at this log's top. SN501 stays a refusal.
- **For a fresh session**: the route is `Compiler#fromWalk`/`fromWalkIn` and `compileTwice` in src/compiler/compile.ts;
  tests in test/compiler/from-walk.test.ts; check with the suite plain and under `SN_FROM_WALK_AUDIT=1`
  (`SN_FROM_WALK_STATS=<file>` for the counts), the test/compiler audits, `scripts/render-audit.mjs --switch SN_FROM_WALK
  --canon`, `scripts/pass-audit.mjs --switch SN_FROM_WALK`, `scripts/mail-audit.mjs <sinter-mail> --switch SN_FROM_WALK`
  with `SN_UNITS_VERIFY=1`; merge `ccr-9ebf49d5-gpdej8` before each report.

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

The suite under `SN_FROM_WALK_AUDIT=1` after the merge of the integration branch (`SN_FROM_WALK_STATS`, one line per
page that recorded and had a second pass; dev renders, which most behaviour tests are, do not record):

| route | second passes |
| --- | ---: |
| **taken** (audited: canonically the old route's) | **166** |
| values folded into the code (`foldValues`/`foldGain`: the second pass writes known resource values into code the walk compiled as reads) | 123 |
| nothing decided (a branch the build might decide, evaluated, not decided; evaluated again, writing) | 50 |
| a loop unrolled, not rendered (the old row route) | 49 |
| rendered rows and a layout (the minifier's included) | 48 |
| no branch the build may decide (not recorded for the route: loops and branches over written state) | 33 |
| constants the layout or the images read (prefold) | 26 |
| code a decided branch compiled first is compiled elsewhere too (its site would be the branch's) | 12 |
| a definition compiled first in a decided branch, used by the page | 9 |
| a choice decided | 9 |
| a loop unrolled on a page that is not quiet (whether it unrolls waits for the finished first pass) | 7 |
| diagnostics in a decided branch | 4 |
| ids in rendered rows | 2 |
| a resource read only in a decided branch (SN501) | 2 |
| over the expansion limit, an else-if decided, a decided if in a template that stays | 1 each |
| (pages with a unit placed: the build's; in the suite only the unit tests, 8 before the merge) | |

Apps (`pass-audit --switch SN_FROM_WALK`, after the merge): every file the same; static-site: rendered rows and a
layout 4, a unit placed 2; multilingual-site: rendered rows and a layout 8; realworld and the blog's page files: a unit
placed; the blog's template entries: the kept expansion's second pass (section 8); sinter-mail: a unit placed 16.

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

None. Two files run with B1 off, since they compare routes other than B1's and B1 takes one side only:

- test/compiler/one-pass.test.ts (stage 3's routes: it counts second passes by how they parse; a page of its own whose
  rows were rendered no longer parses at all with B1);
- test/compiler/units.test.ts (a page with and without the build's units, byte for byte: B1 takes the page without
  units, and its numbers there are the second pass's up to numbering).

The audits likewise: `SN_RENDER_AUDIT`, `SN_UNITS_AUDIT` and `SN_LINK_AUDIT` compare their own two routes with B1 off
(`withoutFromWalk`); they hold as on the integration branch (the units audit fails the same 62 tests there, by
construction: they count units placed). No expectation of a number changed: the route's ids are today's (document
order and each block's gap), and where a dropped walk leaves a gap in state or template numbers the canonical form is
what is compared.

## 7. What is left before the second pass can be deleted (B2)

- Values folded into code (`folds`, merged from the embedding workstream during B1): the second pass compiles reads of
  known resource values as literals; the walk compiled them as reads. The route takes a page only where folding gains
  nothing (`foldGain`); the rest (123 in the suite) needs the walk to fold, or the folding to be a step after the walk
  over the compiled code.
- A template's entries (`fromTemplate`/`secondPass`) still walk their page again from the kept expansion.
- Pages with a unit placed (every page of a build with shared definitions): finishing a first pass that shares the
  unit's objects would change them for the next page. The route needs the page's own copy of the unit's objects it
  keeps (A1's structural copy of `NodeDef`/`TemplateDef`/`Binding`s), or the unit's numbers at assembly.
- The other decisions: choices (dropped, inlined, rendered), recursion points, loops unrolled the old way, decided
  `if`s inside templates that stay and inside rows, constants the layout and the images read (`prefold`), else-ifs.
- The pre-walk passes over what the decisions change: the layout and the image pipeline over a branch's content and
  over rendered rows, the minifier with a layout over rows.

## 9. Numbers (same machine, quiet: load under 1 before each run)

- **page-compile** (`bench/page-compile`, 200 sections; `pc-ab.mjs`: one process, 40 compiles of each route
  interleaved, the first 5 dropped, median): 451 → 359 ms at the first commit; after `fwMarks` read by a made function,
  three runs: 403 → 314, 396 → 302, 408 → 322 ms (−22%; min 291 → 242). CPU profile, ms a compile: old route 246
  (first pass's walk 105 and evaluation 20, second pass 118), new 197 (walk 135, of it the recording about 12 and
  its garbage, evaluation without writing 19, `fromWalk` 8, finish 33). The output is byte for byte the old route's
  (`SN_FROM_WALK=0` against on: html 100,767 B, gzip 7,526; module 285,592, gzip 37,314, both).
- **The blog** (`run-sinter.mjs`, 100 posts, 3 rounds each way, ms): static 3272/2965/3010 off, 3064/2652/3052 on;
  live 3864/3315/3705 and 3893/3343/3418; static-files 4036/3703/3576 and 3572/3639/3771; live-files 5611/5771/5739
  and 5449/5767/5371; type check 2927/3209/3230 and 2885/3136/3200. The same within noise: the route is not taken
  there (template entries: off, section 8; page files: a unit placed, section 7); recording costs nothing visible.
- **The examples**: `pass-audit --switch SN_FROM_WALK`: the nine apps byte for byte the same; static-site 4 second
  passes with no branch the build may decide, 2 with a unit placed; multilingual-site 8 with no branch; realworld 1
  with a unit placed; dashboard none.
- **sinter-mail** (`mail-audit.mjs <checkout> --switch SN_FROM_WALK --suite --bench`, and `--canon`): 42 files byte for
  byte the same, raw and canonical (its 16 pages: a unit placed); its tests (234), `sinter check` and `tsc` pass; run
  time, the default build, before (5f203af) and after, first render ms: api newsletter-2000 29.3 / 28.8, corpus-static
  18.6 / 19.8, api-templates 102.6 / 73.9 and 38.6 / 33.6, api-fills 78.6 / 80.3 and 34.8 / 34.2 (noise: the outputs
  are the same bytes). (The first `--suite` run after a fresh clone fails `tsc` until `sinter check` has written
  `sinter.components.d.ts`; base's `sinter check` failed for its worktree's `dist/cli.js` lacking the executable bit.)
- **Page weight**: `npm run size -- --check` passes; every page and early chunk the same as at 5f203af (the feature
  modules differ by 60 B min between the two checkouts by their paths' length, not by this change); the apps'
  pages and modules byte for byte the same, so their gzip sizes are too.

## 10. After merging A1 (324b7a3, then 35bed5c): checks, and the next two steps

Merged; conflicts resolved as A1's (`unitPass` for every second pass, B1's fallback compiles included; `markScoped`
holds A1's `touchMark`; `SN_UNITS2_AUDIT` runs with B1 off like the other audits); units.test.ts and units2.test.ts run
with B1 off. Suite 2,975 green but units2's five before that change; under `SN_FROM_WALK_AUDIT=1` the same. On
test/compiler: `SN_RENDER_AUDIT` and `SN_LINK_AUDIT` pass, `SN_ONE_PASS_AUDIT` passes but for units2 (fixed since, and
units.test/units2.test pass under every audit), `SN_UNITS_AUDIT` fails the same 62 and `SN_UNITS2_AUDIT` the same 52 as
the integration head (by construction: they count units). `pass-audit --switch SN_FROM_WALK` and `render-audit --switch
SN_FROM_WALK --canon`: the nine apps the same. page-compile: 406 → 326, 389 → 306 ms.

**Next: pages with a unit placed** (every vite page with definitions). A1's `unitPass` + `holdUnit`/`restoreUnit` give
a second pass its own copy of what it changes of a unit; B1's route finishes the *first* pass, which shares the
first-pass unit's objects (stage 4), so it needs the same for the first pass's unit: every unit object the route and
`finishPage` change touched (`touch`) before, and the output copied off the unit before `restoreUnit`. Not started.

**Next: a template's entries, in place instead of a copy.** What the 7 ms copy is: `copyState` of the kept walk copies
every field; the kept walk holds what its walk compiled, the page (a dozen elements, two components) and, inside the
`$build` branch, the markdown library's 26 choice candidates compiled as definitions (their templates, `NodeDef`s,
bindings, scopes, the parsed markup of their content, check data, the side tables keyed by those nodes) and the
lookups of every copied object in every weak table on the first copy. All of the library's part is dead in the entry's
page (its templates are emptied by the route). In place: the route's own changes are few and known (the branch's
markup restored, rows spliced, table entries taken out and the new walk's added, `roots`, `fns`, `templates`' nodes,
ids), and each can be logged and undone; but `finishPage` changes nearly every live object after it (`prerender`
writes first paint into the markup and `dropConstants` drops bindings and nodes, `anchors` turns templates into
comments and moves their content to the head, `shareTemplates`, `groupStyles` replaces `node.b`, `compactTables`
renumbers templates and functions in place, the early file and the serializer read it all). Undoing those needs a
touch-before-write journal over the live page's objects (as `touch`/`restoreUnit` do for a unit), or `finishPage`
working on copies of only the live objects. The latter is the reachable step: a copy of the kept walk restricted to
what the entry's page keeps (after the dry run the dead templates and the tables' entries the dropped walks added are
known, and they are the library's bulk), whose cost is that of the page's own walk state, about the 0.5 ms the stage 3
expansion copy costs. Not built.

## 11. Pages with a unit placed (second session)

A first pass with a unit placed (stage 4: the page's shared definitions from the build's units, their objects shared by
every page) now takes the route like any other page. What it needed:

- **The unit's objects the route and `finishPage` change, held and given back.** `fromWalk` touches (`touch`) what it
  writes that a unit may own (resources', syncs', actions' records and the page's resource infos, the roots and their
  bindings, an element of `remove` and its parent's children, an emptied template); `settle`, `dropConstants` and
  `markScoped` touched already (A1). The output is copied off the unit (`detachOutput`) and the unit given back
  (`restoreUnit`) before anything else places it (the audit's compile, the next page). `SN_UNITS_VERIFY=1` (every
  object of the unit compared after every page) holds over the blog's page-file variants, sinter-mail and the tests.
- **A unit's definition the page keeps: refused** (`fromWalk`, counted). `finishPage` would anchor, share and number the
  unit's templates and markup, which other pages place. A unit's template nothing reaches is emptied (held) like any
  dropped one, and its head template goes with it (a definition's walk made it; `anchors` would normalize its markup).
- **What placing the unit added to the page's tables, taken out**: the second pass places none (its points are
  rendered). The placement is recorded like a dropped walk (`fwSizes`/`fwSince` around `placeUnits`: a list's range and
  its items, a map's or a set's keys; the plain fields it changed; the functions it made and their calls): its keys out
  of the maps and sets before the route's walks add theirs (the blog: `files`, `uses`, `defs`, `srcOf`, `tplEls`,
  `anchorEls`, `headTemplates`, `pointOf`, … 20 tables), its items out of the lists after them (positions checked by
  identity), its functions' calls subtracted (a function it made that the page calls too: refused, as a dropped walk's).
  Refused when it adds to a table numbered by position or changes a plain field (but `earlyDefs`).
- **Two bugs of the route found by the verifier**: the unit's own journal (`touched`) is a field of the compiler, which
  the route took for a table and cut by the dropped walks' positions (so a touched object was never given back); now
  in `FW_IGNORED` with the type check's bookkeeping (`checkParts`, `checkDone`, `frameOf`, `checkLast`, `checkOrder`:
  the check is the first pass's as its walk made it, as before).
- With a unit, the route requires the type check's unit order (`checkOrder`), as the old route does.

**Numbering**: the unit's dead definitions took state 0 (and their templates and functions the first numbers), so a page
with live state numbers it 1 where the old route numbers it 0 (bench-live-files: `r(t,e[1],1)` for `r(t,e[1],0)` in the
early file, one digit; canonically the same). This is the one use of the numbering freedom; everything else is byte for
byte (bench-static-files: all 203 files).

## 12. Values folded into code (second session)

The second pass compiles a read of a build-time constant down to a short primitive as its literal (`foldOf`); the walk
compiled every read as a read. The route now finishes the page from the walk and then checks (`shipsFold`) whether any
function the page ships (its table and the early file's) reads one of the folds down to such a value, as `foldGain`
reads them (a `$r` it cannot follow counts as one). Where none does, the second pass's folds change nothing that ships:
a fold acts on one expression at its fold sites (its code and its dependencies; a constant either way, so the same
bindings are dropped and the same functions left), and a function that ships has none. Where one does, the page is
compiled the old way, with the folds (and without them where a component script may change one, `foldsEscape`):
counted `values folded into the code that ships`; the finish was spent (one `finishPage`). Over the suite: 9 such
pages, 7 more never reach the route (`values folded into the code`: nothing else decided). Tests: from-walk.test.ts,
a static page whose reads fold (taken, byte for byte) and a live binding that reads one (compiled again).

## 13. A template's entries: what was measured, and why it is not built

Measured on this machine (4 cores, Xeon 2.3 GHz, Node 22; CPU profiles of bench-static, 100 entries, ms per entry):

| | ms |
| --- | ---: |
| the entry's evaluation (`decideFor`) | 5.8 |
| its second pass from the kept expansion (`secondPass`): copy of the expansion 0.4, walk 1.6 (of it the minifier 0.36), `finishPage` 0.5 | 2.4 |
| the route as built in section 8: copy of the kept walk (`copyState`, listed tables) | 5.5 |
| … then `fromWalk` (the rows' walk included) and `finishPage` | 0.8 + 0.7 |
| a copy of the second pass's *walked* state (no library, the rows in), listed: the floor of any copy of walked state | 2.8 |

The copy of the kept walk (5.5 ms, about 7,400 objects: `useById` 1,800, `fnAt`, `runtimePlacements`, `choiceGroups`,
`remove`, `tplEls`, …, most of them the library's 26 candidates) could be restricted to what the entry keeps, but even a
copy of a second pass's walked state, which has none of the library, costs more than the whole second pass (2.8 against
2.4): the generic copy of a walked compiler is the cost, not the dead part. A walk once per template and the rows per
entry ("transformed once per way the branches are decided") is a copy of walked state per entry too. What would pay:
an entry run on the kept walk in place and undone, with a journal over every object the route and `finishPage` change
(the page's markup, nodes, bindings, templates and tables, not only a unit's: `anchors`, `shareTemplates`,
`groupStyles`, `compactTables`, `settle` write nearly all of it). Its gain is bounded by the second pass's 2.4 ms less
`fromWalk` and `finishPage` (1.5 ms) and the journal: under 0.9 ms an entry (90 ms at 100 posts, 4%), against a journal
whose every missed write corrupts the next entry. And the live variant folds its entry's values into code that ships
(`post.slug` in the comments' URL): the walk would have to compile those reads as holes filled per entry (a change to
`foldOf`, and a per-entry check that every fold decision is the same). Not built; `entryFromWalk` stays behind
`SN_FROM_WALK_ENTRIES=1`. Where the folds ship nothing (bench-static, bench-static-typecheck: their 100 entries are byte
for byte the same with and without folds), section 12's check would apply to entries too.

## 14. What still needs the second pass (B2)

The suite under `SN_FROM_WALK_AUDIT=1` (`SN_FROM_WALK_STATS`, after merging the integration branch at 22152eb; 2,995
tests pass): taken 227; rendered rows and a layout 84; a loop unrolled, not rendered 65; nothing decided 51 (a
branch the build might decide, not decided: no second pass is needed there at all, the first pass is the output);
constants the layout or the images read (prefold) 38; a loop unrolled on a page that is not quiet 35; no branch the
build may decide 33 (not recorded); code a decided branch compiled first is compiled elsewhere too 12; values folded
into the code that ships 9; a definition compiled first in a decided branch, used by the page 9; a choice decided 9;
values folded into the code (nothing else decided) 7; diagnostics in a decided branch 4; ids in rendered rows 2; a
unit's definition the page keeps 2; a resource read only in a decided branch (SN501) 2; over the expansion limit, an
else-if decided, a decided if in a template that stays 1 each. Template entries (every `<html data-sn-for>` page) are
not routed (section 13).

The apps: the blog's page-file variants 100 of 100 routed (static and live); its three template variants not routed;
static-site rendered rows and a layout 4, prefold 2; multilingual-site rendered rows and a layout 8; realworld no
branch the build may decide 1; dashboard none; sinter-mail 3 routed, a resource read only in a decided branch 6,
prefold 6, code the unit compiled is compiled by the page too 1.

So B2 needs, by weight: the layout and the image pipeline over spliced rows (84 + the examples), loops unrolled the old
way (65 + 35: stage 2's row route), the prefold constants (38), the template entries (an in-place run, section 13), and
then the small reasons, each a case of a function or definition whose site or number belongs to a dropped walk.

### Numbers (this session, quiet but noisy machine: whole processes vary ±10%, so compiler time from CPU profiles)

Base: the integration head 22152eb; new: this branch merged with it. `compilePasses` per page, ms, 100 posts:
static-files 15.3 → 12.3, live-files 14.9 → 13.3; static 9.0 → 9.0, live 10.0 → 10.6, static-typecheck 10.1 → 9.5
(the template variants are not routed: noise). Whole process, medians of 7 interleaved: static-files 2,132 → 2,097 ms,
live-files 3,010 → 3,114 (noise); an earlier quiet run of 3: static-files 2,182 → 2,084, live-files 2,519 → 2,421.
400 posts (3 runs): static-files 7,251 → 6,418, live-files 8,355 → 8,332. page-compile medians 176 → 176, 191 → 161.
sinter-mail: 48 files byte for byte, raw and canonical; its suite (234 tests, `sinter check`, `tsc`) passes; run time
(first render ms, medians of 9, runs new / base / new back to back): api newsletter-2000 20.7 / 20.9 / 23.8, corpus-static
13.9 / 13.8 / 16.5, api-templates 55.7 / 64.4 / 62.4 and 24.3 / 27.1 / 28.4, api-fills 50.3 / 65.4 / 72.9 and 23.1 / 28.7 /
23.4 (the same bytes: noise). `npm run size -- --check`
passes; the apps' outputs are the same bytes but bench-live-files' state digit, so no page is heavier.

## 15. Rendered rows under the minifier with a layout (second session)

In a build the minifier runs with the page's stylesheets (its own `Layout`), and the second pass minifies the rows with
them in place; the route splices the rows after the first pass's minifier, which judged the white space beside the
`<template>` by what is past it (a sinter template that renders blocks is looked through) and each row's edges as its
template content's (unknown: "other"). `respaceRows` (after the splice, before the texts are merged): the texts that
meet at the rows' edges merged and collapsed as the minifier's first step does; then for each text from the one right
before the rows to the one right after them, the minifier's rule (`spaces`: in a container whose white space collapses,
white space alone beside a block-level box or an item, or at the box's edge, goes; a text loses its white space on such
a side), asked of a `Layout` over the walked page, with the rows' paints shown as the bindings they stand for
(`RenderedRows.shown`, as `walkExpanded` shows them). The rest of the rows' white space is the template content's,
judged alike. What the walk changed is not asked: the rows' parent or an element above it bound to anything but a
handler, a model or a text (its class, style or display taken off), or an element past the rows that is bound, or a
template there: refused (`rendered rows and a layout: a bound element around them`, 1 in the suite). The minifier
without a layout (a stylesheet from another origin) only drops comments: routed as before. Still refused: the page's
own layout (`this.layout`: `styles`, or the images' stylesheets), read before the walk by the late rows' space
(`planSpace`), the image pipeline and the dry run of constant classes and styles, all over the page without the rows
(the examples' 12 pages, 7 in the suite).

A route bug this exposed (test/vite/origins.test.ts): `renumberIds` numbered the page's ids again in document order but
left an embedded resource's id (`<sn-resource>` taken out by the walk, its data in `<script data-sn=N>`, `r.data`) as it
was, so it could meet an element's new id. Now the walk records where each such element stood (`fw.gone`: before the
next element or anchor that stays), the route points a record at a template it replaces to what took its place, and
`renumberIds` numbers it there and writes `embedded` and `r.data`; where its place is gone, refused (none in the suite).

Suite under `SN_FROM_WALK_AUDIT=1` after this (merged at 22152eb, 2,998 tests): taken 306; a loop unrolled, not
rendered 65; nothing decided 51; prefold 38; a loop unrolled on a page that is not quiet 35; no branch the build may
decide 33; code compiled first in a decided branch compiled elsewhere 12; values folded into code that ships 9; a
definition compiled first in a decided branch 9; a choice decided 9; values folded (nothing else decided) 7; rendered
rows and a layout 7 (+1 bound element); diagnostics in a decided branch 4; ids in rendered rows 2; a unit's definition
the page keeps 2; SN501 2; over the limit, an else-if decided, a decided if in a template that stays 1 each. The 43
template-pass entries compiled alone (no kept template) now route. Apps: unchanged from section 14 (their rows are under
the page's layout). Verified: suite plain and audited; RENDER/LINK/ONE_PASS audits pass, UNITS/UNITS2 the same 62/52;
render-audit --canon the eight apps the same; pass-audit byte for byte but bench-live-files' state digit; sinter-mail
48 files byte for byte raw and canonical; size check passes.

## 16. Rendered rows under the page's own layout (second session)

The page's layout (`this.layout`: `styles`, or the images' stylesheets) is read before the walk by the image pipeline,
the bound images' sizes in the walk, the late lists' space (`planSpace`) and the dry run of constants (whose constants
are prefold, refused anyway). It sizes nothing by its content (an `auto` width that would follow it, a content-sized
grid track: not known), and it answers a structural or sibling selector for an element beside a template as not known
(`siblingsUnknown`), which the second pass, with the rows in place, answers as it is. So what rendered rows can change
is what it was asked about the rows' parent's other children and what is in them, and what a `:has()` rule matches from
above. `layoutAround` refuses where the rows' parent holds, beside them, an image, a video, a frame or an object, or a
list whose space or content-sized box was planned, or where a stylesheet has a `:has()` rule (counted: `rendered rows and
a layout: an image beside them`, `…: a \`:has()\` rule`); else the layout's answers are the second pass's. The
examples route now, byte for byte (static-site 4 pages, its other 2 prefold; multilingual-site 8); the suite 325 (2 of
the 3 refusals are the tests of the reasons). Verified as section 15, on 3,010 tests.

### Numbers after section 16 (CPU profiles, `compilePasses` per build, ms, three builds each, base 22152eb → this)

static-site 197 / 195 / 210 → 187 / 178 / 169; multilingual-site 128 / 126 / 129 → 115 / 116 / 114; realworld 593 / 486 /
581 → 587 / 606 / 579 and dashboard 519 / 485 / 493 → 522 / 494 / 490 (not routed: no branch the build may decide; no
second pass). The blog: section 14's numbers (the page-file variants routed, the template variants not).

Commits of this session: 7af202e (units, folds), 0b4ee7f (the minifier's layout, embedded ids), and the one after
section 16 (the page's layout); each merged with the integration branch before it was pushed.

## 17. What B2 still needs, by reason: the suite, the apps, sinter-mail (merged at 2c9a08d)

Second passes by route, under `SN_FROM_WALK_AUDIT=1` (the suite, `SN_FROM_WALK_STATS`; 3,010 tests) and in one build of
each audit app (`pass-audit --switch SN_FROM_WALK`) and of sinter-mail's 16 pages (`mail-audit`). The blog's three
template variants (`<html data-sn-for>`, 100 entries each) are not counted by the route: every entry takes the second
pass from the kept expansion (section 13). Dashboard has no second pass.

| route | suite | blog (5 × 100) | static-site | multilingual | realworld | sinter-mail |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **taken** | **325** | **200** (page-file variants) | **4** | **8** | | **3** |
| a template's entry (`secondPass`, not routed) | — | 300 | | | | |
| a loop unrolled, not rendered (stage 2's row route) | 67 | | | | | |
| nothing decided (a branch the build might decide, not decided: no second pass needed) | 51 | | | | | |
| constants the layout or the images read (prefold) | 38 | | 2 | | | 6 |
| a loop unrolled on a page that is not quiet | 35 | | | | | |
| no branch the build may decide (not recorded) | 33 | | | | 1 | |
| code a decided branch compiled first is compiled elsewhere too | 18 | | | | | |
| values folded into code that ships | 9 | | | | | |
| a definition compiled first in a decided branch, used by the page | 9 | | | | | |
| a choice decided | 9 | | | | | |
| values folded, nothing else decided | 7 | | | | | |
| a unit's definition the page keeps | 6 | | | | | |
| diagnostics in a decided branch | 4 | | | | | |
| code the unit compiled is compiled by the page too | 4 | | | | | 1 |
| a resource read only in a decided branch (SN501) | 2 | | | | | 6 |
| ids in rendered rows | 2 | | | | | |
| rendered rows and a layout: an image beside them, a bound element around them, a `:has()` rule | 1 + 1 + 1 | | | | | |
| over the expansion limit, an else-if decided, a decided if in a template that stays | 1 each | | | | | |

So for the apps the second pass is left for: the template entries (300 blog pages), prefold constants (8 pages:
static-site 2, sinter-mail 6), the SN501 case (sinter-mail 6: a resource read only in a dropped branch, whose warning
the second pass reports), one unit case (sinter-mail 1), and realworld's one page whose branch is not recorded.

## 18. Toward B2: what each remaining refusal needs (second session, after the coordinator's order of 2026-11-24)

Done in this step (commits a196ecc and the next):

- **A function a dropped walk or the unit made first, called by the page too** (was `code a decided branch compiled first
  is compiled elsewhere too`, `code the unit compiled is compiled by the page too`): its site is the page's first call
  outside the dropped walks, which `fn()` records during the page's walk (`FW_WALKING`: a module variable, as
  `FW_COUNTING` is; the linker refuses a definition whose compile reads `fw`); refused where the page called it only
  after its walk, or where the page and the route's walks both call it (which comes first is not known). Its number
  stays the earlier one (numbering only). Suite 18 → 16 (most of the rest: the page calls it after the walk).
- **The unit's entries by name that the page reads** (found by sinter-mail: its `mail` namespace, added first by the
  unit, would have been taken out though the page imports it): the tables' entries by name that placing the unit added
  are watched during the page's walk (`fwWatchUnit`, the tables' own methods); one the page reads there refuses the
  route (`the page reads the unit's …`). And with a unit placed, a definition the route's walks compile is refused (the
  second pass places a unit of its own there, whose writes are not those).
- **SN501**: reporting it from the route is not sound: a resource a dropped walk read first and the page read after it
  leaves no trace of the page's read (`a.used` records first reads). Kept as a refusal; fixed two false refusals: the
  rows' reads count as reads, and the resets of the dropped walks' first reads come before any block is walked again.
- **Loops on a page that is not quiet** (35 → 1): such a page's loops unroll where its finished first pass is clean; the
  route finishes it and checks (`fwFinishAlike`: no dropped walk added a `$url` list's binding, a page model, a URL
  write, or a `$url` read on a page per entry; no signed-in guard; then the routed page's errors are the first pass's).
  Where the finish reports an error the page is compiled the old way (counted `…, not clean`).
- **The counts say what happened**: a reason is counted when a second pass follows; `no second pass (…)` where none does
  (`nothing decided`: 52); a page that recorded no branch the build may decide is counted under what its second pass
  applies (prefold, a choice, a loop, folds); a loop unrolled because rendering is off (`SN_RENDER=0`, the reference
  compiles of render-rows.test.ts and evaluation.test.ts) apart from the renderer's own fallbacks.
- `SN_RENDER_AUDIT` runs both of its compiles with B1 off (a page compiled with `SN_RENDER=0` beside it took B1);
  link-review-3/4 run with B1 off (they count links per pass, as units.test.ts).

**Prefold** (constants the layout or the images read; suite 57, static-site 2, realworld 1, sinter-mail 6), not built.
The second pass writes them into the markup before the minifier, the layout and the image pipeline run, and takes their
bindings off before its walk, which then compiles none of them. In the apps they are image attributes (static-site's
`docs/guide.html`: `<img data-sn-attr="{ src: node.url, alt: node.alt }">` in `node-image`, inside a row of the content
tree). The route would have to: write them into the walked page (their bindings' attributes are gone by then: found by
the constant's key from the element's site), take the bindings off before `settle` writes their raw values over the
pipeline's, run the image pipeline for those images only, with the first-pass `eager` rule (the first image of the
page outside templates; the unbound image counted), and put its rules into the page's image CSS in document order (the
pipeline gives one rule per image and joins them in order), and its variants into the build's. A class or a style the
layout reads would change the layout's answers anywhere (white space, every image's size): refused for good. Contained
case: only image `src`/`srcset`/`alt`/`width`/`height` in images; a step of its own.

**The renderer's fallbacks** (what keeps the old second-pass row route; `SN_RENDER_STATS` over the suite, loops):
no element in a row 52 (the behaviour fuzzers: rows that are only text or comments), text at the top of a row 21 (the
minifier and anchor fuzzers), the loop's place 9 (slot content and fills, component scopes), a value not written ahead
4, diagnostics per copy 4 (SN313 on a choice's case, a row changing its item), a handler in a row 3, a text failing at
build time 2, links in an instance in rows 2 (SN519's wording with the instance's chain), an id in a choice's case 2.
What would let the renderer cover each: a row's nodes rendered without an element anchor (a text row: the runtime's
text separators); a row starting with text as the old route's copies number it; slot content's scopes (the instance's
`$slot`); the copy's own diagnostics (reported at the copy's chain, as the old route words them); a handler kept as a
residue on a rendered node (the IR's per-node residue, stage 7's decision). These are stage 2's / stage 6's (the
renderer: `rowRenderer`, `render`, `fill`), which the stage 6 session works in now; not built here.

### Group 4: the small groups, what each needs (suite counts under `SN_FROM_WALK_AUDIT=1` at 30c3ef9)

- **A choice decided** (16; sinter-mail's file emails decide theirs inside rendered rows, which route): an
  `<sn-component use>` at the page's level whose candidate the evaluation decided. The route records only `<template>`s
  (`fwStart`); a choice would need the same record (its candidates' walks, as a decided branch's) and the second pass's
  three outcomes: dropped (its walks taken out), rendered (the case's rows spliced, as a loop's), inlined (the case's
  markup walked as the page's, `inlineInstance`'s scope and slot marks: what `fromWalk` does for a kept branch, plus the
  instance key prefix the rows below it are keyed by).
- **Code a decided branch compiled first, called by the page after its walk** (16): the page's call comes from the walk's
  tail (`defRootBindings`, `finishChoices`, `resolveSources` go over every definition, the dropped ones' too), so whether
  the second pass would call it at all is not known from the counts; needs the tail's calls attributed to what they are
  for (a definition, a choice) and those of dropped ones subtracted like a dropped walk's.
- **Values folded into code that ships** (9) and **folds only** (13, of which the template entries' tests 6 and the embed
  tests, built to fold, the rest): the walk would compile a fold site as a hole (`foldOf` given the fold's path, the
  literal pasted per page), with the fold's dependencies and the resource's use kept apart so that both forms can be
  given; a change to `expr.ts`'s analysis, the embedding workstream's. Where no fold ships the route already takes the
  page (section 12); a first pass that is its own output but for folds could be finished and checked the same way (built
  and measured: no page of the suite gains, every fold-only page there ships its folds; not kept).
- **A definition compiled first in a decided branch, used by the page** (9): its templates, functions and scope are the
  branch's walk's (numbered there, its prop lets in the branch's scope); the second pass compiles it at its first use
  outside. Needs a definition's compile to be independent of where it is first met (A1/A2's units for the second pass
  are that: placing a second-pass unit in the route, as the old route's second pass does, would give the page the same
  definitions).
- **A unit's definition the page keeps** (6) and **a definition the page compiles, a unit placed** (sinter-mail 2):
  the second pass places a unit of its own (finished: anchored and shared once), the route has the first pass's (not
  finished). Needs the route to place the second pass's unit (`placeUnits(…, second = true, livePoints)`) over the routed
  page before `finishPage`, taking the first pass's out: its definitions are compiled the same way, so what differs is
  which objects `finishPage` sees as the unit's (`finished`), and the numbers.
- **Diagnostics in a decided branch** (4): a dropped branch's diagnostics are the first pass's, which the second pass
  reports where it compiles that markup (a kept branch's, as the page's, at the page's position): needs the kept
  branch's diagnostics taken out with its walk and the new walk's put where they were (document order).
- **ids in rendered rows** (2), an else-if decided, a decided if in a template that stays, over the expansion limit (1
  each): shapes the second pass's expansion handles (`expandConstants` at every depth); each a case of the route's own.

## 19. Rendered rows with images, and prefold constants that are an image's own attributes (second session)

The second pass splices rendered rows before its image pipeline and writes the constants the images read (`prefold`)
before it too; the route spliced rows after the first pass's pipeline, so it refused rows with images and every page
with prefold constants. Now, at the splice, in the second pass's order: the rows' constants written and their binding
attributes taken off (`prefoldRows`: `prefold` over the rows, the keys it found noted), then the rows' images through
the pipeline (`imagesInRows`: a `Layout` over the walked page, the rows' paints shown as their bindings, the page's first
image eager only if no image outside templates comes before the rows: `RewriteContext.eagerTaken`, a new option of
images.ts), its variants and pending files added to the page's (`walk.images`), its rules the page's where the page had
none (rules new to a page that has rules of its own: refused, they go in document order). Allowed constants: an image's
`src`, `srcset`, `alt` only (`imageConstants`), on a clean first pass. A constant the rows did not take is one the
second pass writes elsewhere only if an element of the page outside the rows has its key (`prefoldsOutside`: as `prefold`
keys them; the walk took the attribute off): then refused; one inside rows that took none is painted there already by
the renderer, which the second pass's `prefold` finds no attribute on either (static-site's `guide.html`: its image's
`src` and `alt` written by the renderer, the constant a no-op in both). The image pipeline's context is one helper now
(`imageContext`, `walkExpanded`'s and the route's).

Also: where the route gives up after splicing (`spent`), the rows' nodes are put back as they were before the second
pass splices them (`snapTree` of each rendered block before the route, `restoreTree` after): the route had spaced and
merged them, which a fallback compile then shipped (static-site's `guide.html`, caught by the audit).

static-site: 6 of 6 pages routed, byte for byte. Suite: 368 routed (357), prefold 57 → 48. Verified as before: 3,015
tests plain and audited; RENDER/LINK/ONE_PASS pass, UNITS/UNITS2 62/52 as head; render-audit --canon 8 apps the same;
pass-audit byte for byte but bench-live-files' state digit; sinter-mail 48 files byte for byte raw and canonical with
`SN_UNITS_VERIFY=1` (its remaining prefold pages: 5, which write a class or an image outside rows); size check passes.

## 20. The second pass's unit in the route: what blocks it (not built)

`placeUnits` places a unit only on a page with nothing numbered yet (`unnumbered`: no template, function, state, use,
id or action): a unit's objects are shared by reference at the numbers they were made with, its templates and
functions first. A routed page is walked: its own templates, functions, states and ids are numbered from 0 already,
so the second pass's unit cannot be placed over it as it is. The ways it could: (a) the walk's numbers shifted by the
unit's counts before placing it (every template id, function index, `$s<n>`, `$i<n>`, use id and `data-sn` id the walk
handed out, in the IR, the code and the markup: `compactTables`' renaming, for every kind, on a page not finished yet),
then the second pass's unit placed, then the dropped definitions' templates replaced by the unit's; or (b) a unit
whose numbers are relative, placed at the page's current counts (a change to units.ts, A2's: its objects are shared,
so their numbers would have to be offsets resolved at assembly, which stage 5's assembly plan defers). Either is a step
of its own across units.ts and the route; neither is contained in `fromWalk`. Until then the 17 suite cases (9 + 6 +
sinter-mail's 2) take the second pass.

## 21. Definitions a dropped walk compiled first, and a unit's definitions the page keeps (third session)

Section 20 found the second pass's unit cannot be placed over a walked page (its numbers are absolute, the walk's from
0). Both refusals it was to serve are served without it:

- **A definition compiled first in a decided branch, used by the page** (9 in the suite): the route took the
  definition's `defs` entry out with the dropped walk, so the walk of the kept branch compiles it again, at the use and
  in the scope the second pass's walk compiles it at (its templates and functions numbered after the page's: numbering
  only, canonically the same; byte for byte in the tests but for the template's generated names). Allowed now; refused
  only where the first copy is still reached from the page (`dropped`: its root template live while the page holds
  another: the page would have it twice). The templates the route's walks make are kept as they make them (`t0`: only
  the first walk's are emptied where nothing reaches them): a cycle of definitions in a decided root chain
  (component-cache.test.ts' ping/pong) has a template nothing in the IR reaches that the second pass keeps too.
- **A unit's definition the page keeps** (6) and **a definition the page compiles, a unit placed** (sinter-mail 2):
  where the page keeps some of the unit's definitions (`fwKeepsUnit`: a point of one, or a use of one, where the route
  keeps the page: not in rendered rows, not in a branch or loop the second pass's expansion takes out, read from the
  branches' snapshots), the first pass's unit is kept whole as the page's own instead of taken out: every object of it
  held as it is (`holdWhole`, units.ts: a first pass's unit lists its objects now, `objects`) and given back after the
  output is copied off it (`detachOutput`, `restoreUnit`, as before), its additions to the tables kept (no takeout, no
  watched entries), its templates as they are; each of its definitions must be one the second pass compiles (a point
  left in the page, which its unit would hold, or one the page reaches), else refused (`a unit's definition the page
  does not keep, beside one it keeps`). The output is the page compiled with the definitions in place, which the second
  pass's unit is canonically (stage5-a1.md); `SN_UNITS_VERIFY=1` holds over the unit tests.
- **The walk's last steps for what the route walks again** (found on the way, a guard): `walkPage` finishes choices,
  definitions' root bindings, sources, write-through targets, tree fills and aliases after its walk; the route's walks
  came after that. Now the choices and definition roots they add are finished there (`finishChoices`,
  `defRootBindings` over the new ones), and a block that adds to the others is refused (`a block walked again adds to
  …`; none in the suite).

Suite under `SN_FROM_WALK_AUDIT=1`: 385 routed (368); the 15 refusals gone; three tests added (a definition used again
after the branch and by rows rendered there; the ping/pong cycle; the unit test now counts 6 routed, none refused).

