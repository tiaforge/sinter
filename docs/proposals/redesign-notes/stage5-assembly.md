# Stage 5: assembly, second-pass units, live uses from units

Running log (2026-11-23), worktree branch `worktree-agent-a234e6423ae0817d0`, started at 09d202f.

## Where the work stands (read this first)

- **Done**: the measurements (1), the inventory of numbers (2), what relaxing byte identity buys (3), the plan (4),
  with each independent step written as a brief another session can take (5).
- **Built**: step 0, the canonicalizer (`src/compiler/canon.ts`, `SN_CANON=1`, the second-pass shift audit), with its
  results below: every second pass shifted over the apps, sinter-mail and test/compiler canonicalizes to the same.
- **Next step**: A1 (second-pass units placed before the walk, identical up to numbering; brief in 5), and B1 in
  parallel in another session (brief in 5). Before either turns on: the behaviour tests and sinter-mail's suite under
  `SN_CANON=1` (not run yet: the machine's load).

The bar (the owner, 2026-11-23, relaxed during this stage): the output may differ from today's in numbering and
generated names only (`data-sn` ids, anchor numbers, template ids and the names made from them, `$s<n>`, renamed loop
names, function-table indices and order, action/fill/lazy indices, the order of IR table entries that follows). The
oracle for such a step is a canonicalizer (renaming structural, never by regex over text), the whole suite,
sinter-mail's suite and run-time bench, and page weight (`npm run size -- --check`, gzip of the modules). Steps that
can stay byte-identical do. Not allowed without a separate decision: the IR's shape, the runtime, a heavier page.

## How it is measured

Scripts in `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/stage5-agent/m/`: the
floor agent's preload (`instr.mjs`, `hooks.mjs`, `run.mjs`) pointed at this worktree, `SN_CLOCK=cpu` (the main
thread's CPU clock), `SN_MODE=time`; `blog.sh` (the five blog variants, 100 posts), `mail.sh` (sinter-mail's three
routes, 12 pages each, `bb.mjs` from the stage 4 agent, with and without TypeScript), `sum.mjs` (ms per page by pass
and phase), `uses.mjs` (a second preload: every `Compiler#expr` call tallied by site, by whether it is inside a
component instance, and by the code it gives). sinter-mail is a copy of `tiavision/sinter-html` in
`stage5-agent/mail/sinter-html`, its `@tiaforge-ui/sinter` resolving to this worktree. One build each, load 18 to 25
on 4 cores: read columns against each other, not as absolute times.

## 1. What each goal would buy

CPU ms per page (blog: per post, 100; sinter-mail: the mean of 12 pages, so the first page's compile and the second's
recording are spread over them; examples: the whole build, 7 and 2 pages; page-compile: one compile of the 200-section
page).

| build | compile | pass 1 walk | pass 1 settle | pass 2 walk | of it: definitions | pass 2 finish | description |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| blog static (one template) | 12.8 | (kept: 1.0) | 7.8 | ~2.3 (entry from the kept expansion) | 0 | 0.85 | 1.3 |
| blog live | 17.2 | (kept: 1.2) | 10.1 | ~3.5 | 0 | 1.2 | 1.2 |
| blog static-files | 17.4 | 3.9 | 9.7 | 2.6 | 0 | 0.7 | 5.0 |
| blog live-files | 19.9 | 4.6 | 10.0 | 3.4 | 0 | 1.5 | 5.9 |
| blog static, type check | 14.3 | (kept: 1.6) | 8.6 | ~1.8 | 0 | 0.6 | 1.2 |
| sinter-mail file email | 131 | 84 | 40 | 5.5 | 0 | 0.7 | |
| sinter-mail file, TypeScript | 191 | 138 | 43 | 6.0 | 0 | 1.4 | |
| sinter-mail API | 116 | 90 | 20 | 3.3 | 0 | 2.4 | |
| sinter-mail API, TypeScript | 149 | 121 | 22 | 3.6 | 0 | 1.5 | |
| sinter-mail components | 276 | 78 | 16 | **127** | **110** (replay 36, recording 47) | **52** (shareTemplates 13, groupStyles 14) | |
| sinter-mail components, TypeScript | 364 | 137 | 18 | **161** | **139** (replay 44, recording 67) | **46** | |
| realworld, 7 pages (whole build) | 549 | 371 (definitions 77) | 113 | 19 (one page has a pass 2) | 0 | 3.4 | 187 |
| dashboard, 2 pages | 458 | 119 | 323 | none | | | 70 |
| page-compile, 200 sections | 490 | 225 | 34 | **157** | 0 | **51** | |

What each goal buys, from this:

- **(a) Second-pass units** (definitions that ship: sinter-mail's components route, any page that renders a tree from
  an API through components). On that route about **half the compile**: the second pass's definitions (110 ms a page,
  139 with TypeScript) become a placement (stage 4's first-pass placement costs 5.5 ms a page), and of `finishPage`'s
  52 ms the per-unit parts (`shareTemplates` 13, `anchors` 1.6, and `groupStyles` 14 where its groups are the unit's)
  could run once per unit. Nothing else measured ships definitions: 0 on the blog, the file and API routes, the
  examples, page-compile.
- **(b) The second pass derived from the first's walk.** page-compile: **the second pass is 208 of 490 ms (42%)**
  (its 200 `if`s over unwritten state are decided, so the whole page is walked again). Blog template entries 3 to
  5 ms of 13 to 17 (20 to 30%); page files 3.3 to 4.9 of 17 to 20 (20 to 25%), and with one walk the description's
  5 to 6 ms too (stage 3's leftover; needs the pipeline change). sinter-mail's file and API routes 4 to 8% (their
  first pass is the library's). realworld: one page of seven has a second pass (22 of 549 ms, 4%); dashboard none.
- **(c) Live uses from units.** Tallied (`uses.mjs`): on page-compile 400 of 3,400 analyses are inside the 200 uses
  of `x-card`, from **2** sites, and **every one gives other code** (the props are pasted: `q17`): nothing is reused,
  only substituted. The copy (`expandUse`) is 7 ms of 225; the uses' analyses about 10 ms (12% of `expr`'s 87 ms).
  So (c) buys page-compile at most 17 ms a pass (3.5%). realworld: 744 of 883 first-pass analyses are inside
  instances (91 instances), from 205 sites, giving 375 distinct codes: half the analyses repeat another use's code
  exactly. The copy is 12.6 ms of 549. Estimated: 40 to 60 ms of 549 (7 to 11%). Dashboard: 27 analyses in uses,
  nothing to buy. realworld spends more on something else: **77 ms compiling its shared definitions on pages whose
  first pass is their output** (units do not apply there: their numbers ship), which is goal (a)'s machinery, not (c)'s.

So the numbers pick the order: **(a) first** (half the compile where it applies, and the coordinator's preferred
place: nobody else is in `finishPage`/units.ts), **(b) second** (the largest general item: 20 to 42% of every page
with a second pass), **(c) last and only partly**: what it buys is a tenth of a live app's compile and almost nothing
on page-compile, against the largest change in the compiler (`analyze` split, the side tables). Its prerequisite for
(b) in general is not real either: (b) needs the branch's content compiled as page markup, which is a walk of that
content, not a unit. (c) is recommended to wait until (a) and (b) are in and a profile says the copy matters.

## 2. The numbers a compile hands out

From the code (`compile.ts`, `expr.ts`) and the stage 4 shift audit's findings:

| number | handed out | reaches the output as | inside code text? | after the walk from an order of events? |
| --- | --- | --- | --- | --- |
| node id `nextId` | the walk, at each bound root element, anchor, text mark (`element`, `textNode`, anchors in `forTemplate`/`ifTemplate`/choices/slots), rendered blocks (`+= r.rows.ids`), kept elements from `keptBase(name)` (`data-sn-permanent`: a fixed base per name), and **after the walk** `embedFolded` (`$.$d(<id>)` and `<script data-sn="<id>">`) | `data-sn="N"`, `<!--sn N-->`, `NodeDef.id`, early `emb[].id` | yes: `$.$d(N)` only | yes, but kept elements' ids are a fixed base per name (the swap matches them across pages): they must keep their rule |
| state id `nextSid` | the walk, per `data-sn-state` / component state | `NodeDef.sid`; `$.$s<sid>` in code and in path strings (`$s3.x`), `fixedState`, aliases | yes (identifier and member) | yes: `$s<n>` is a name; parsed back by pattern after the walk in `prerender`, `writtenState`, `fixedState` (stage 4) |
| template id (`templates.length`) | the walk (`newTemplate`), definitions, shared copies | `TemplateDef` index, `b.x`/`z`/`c`, `sn-t-<id>`, `$i<id>` (the runtime reads the row's template from it), `$p<id>`, `$sl<id>`, `<name>$<id>` | yes | `$i<id>` must equal the final index (runtime); the others are names only. `compactTables` already renumbers indices, `sn-t-`, `$i` (by regex) |
| function index (`fns`) | `fn()` throughout, deduped by code | IR `f a s.r s.o state key find make u when ...` (`mapFns`), source map | no | yes: `compactTables` already numbers them by first use in the IR (builds; dev does not compact) |
| use id `useIds` | `expandUse` | `@ev:<id>` sources, resolved away | no | does not reach the output |
| action index | `actions.push` | `ActionDef` order; an `on` binding's `x` names its action by index | no | yes (a table; not compacted today) |
| lazy helper module `lazyMods` | `lets` | `$lh$<i>` local, `$.$z(<i>, ...)` in code, `ir.lm` | yes | yes (a table) |
| lazy import `lazyLoads` | `expr` | `$l$<i>` local, `lazy` list | yes | yes |
| fill ids, `fillDefs` | fills | case templates (template ids) | via template ids | as templates |
| check frames / exprs | `recordExpr` | diagnostics positions only, not the output | no | n/a |

What reaches the output's bytes and is page-global inside code: `$s<sid>`, `$p<tid>`, `$sl<tid>`, `$i<tid>`, renamed
loop names, `$lh$<i>`, `$l$<i>`, `$.$z(<i>`, `$.$d(<id>)`. Every one of them is a name the IR declares or a call
with a literal argument: `TemplateDef.item/index/ii`, `NodeDef.sid` (`$s` + sid), `lazy`/`lazyHelpers` locals,
`ir.lm`, the fold scripts' ids. So a structural renamer can find all of them from the IR, never by pattern over text.

## 3. What relaxing byte identity buys, and what it costs

- **Canonical numbering by construction (a unit's numbers from a reserved range, shipped as they are) is still
  out**, for two reasons that are not byte identity: `$i<tid>` must equal the template's final index (the runtime
  reads the row's template from the loop index's name: `compactTables` comment), and a reserved range ships longer
  names (`$p1000003` against `$p3`, every occurrence: a heavier page). Dense tables (`markLowPriority` walks
  `templates` by index) are the third. So every shipped number is renumbered compactly at assembly whatever the bar;
  the renumbering inside code has to be structural either way.
- **What the freedom buys is the order.** Byte identity forces today's order: a definition's templates and functions
  after the page's own that precede it in the walk, node ids with a block's count added at its first element and the
  gaps of dropped templates and nodes kept. Freed: (a) a second pass can place its definitions *before* its walk at
  numbers that are the same on every page, exactly as stage 4 places first-pass units (template ids from 0, so every
  name a unit makes is the same on every page and `anchors()`/`shareTemplates()` over it are the same too), and the
  page's assembly then renumbers only what compaction renumbers today (indices, `sn-t-`, `$i`). (b) The second pass's
  ids can be handed out by assembly in document order from the first pass's walk, instead of reproducing the second
  walk's counter.
- **What it costs**: the canonicalizer and its tests (step 0, needed before any such step); the tests that pin
  numbers (counted in this worktree: `data-sn="N"` 107 in 16 files, `<!--sn N-->` 20 in 10, `sn-t-N` 23 in 10,
  `$s/$p/$i/$sl<N>` 146 in 21, function indices 8; an upper bound: a step changes only the pages it routes, which
  step 0's switch counts before anything is changed); gzip (to be measured per step: numbering moves bytes, not size).

## 4. The plan

Each step behind a switch, with an in-process audit comparing both routes (raw bytes for a byte-identical step, the
canonical form for one that is identical up to numbering), counted fallbacks, tests of both ways and the route, and
the app audits.

0. **The canonicalizer** (`src/compiler/canon.ts`; identical: changes no output). `canonical(parts)`: templates
   numbered in a fixed walk of the IR from the roots, functions by first reference in the same walk (`mapFns`' order
   over the canonical template order), node ids by first appearance in the markup (`data-sn`, anchor comments, fold
   scripts), the IR's declared names (`item/index/ii`, `$s<sid>`, lazy locals) renamed in code by parsing it (acorn,
   as `expr.ts`) and renaming identifiers, non-computed member properties and object keys that are one of those
   declared names, in paths by segment. Tests: equal under numbering, unequal under a changed binding, value,
   attribute or body; user text (`'x$1'`, `US$2`) untouched. **Oracle of the oracle**: the shift audit extended to the
   second pass (`SN_UNITS_SHIFT_AT=p2`: every number shifted before the second pass's walk), whose raw output differs
   and whose canonical form must not, over test/compiler and the apps. Deletes nothing; unlocks every relaxed step.
1. **A1: second-pass units placed before the walk** (up to numbering). The second pass's definitions (the live
   instances that stay recursion points) compiled into a unit at numbers from 0 and placed by sharing, as stage 4
   does for the first pass, keyed as the first pass's unit plus "pass 2". `anchors()` and `shareTemplates()` run on
   the unit's templates once when it is made (they read only definitions); per page, `compactTables` and
   `groupStyles` over the page with the unit's IR objects copied (structural copy of its `NodeDef`/`TemplateDef`/
   `Binding`s, not the replay of every write). Buys: 110 to 140 ms of a components-route page, about half its compile.
   Oracle: canonical audit (`SN_UNITS2_AUDIT`), mail-audit with the canonical comparison, sinter-mail's suite and
   bench, size. Deletes: the linker's second-pass path (with A2, the linker: the review is still the owner's).
2. **A2: finished first passes from units** (up to numbering; same machinery): a page whose first pass is its output
   places its definitions from a unit too (realworld: 77 ms of 549 compiles definitions on such pages). With A1 and A2
   nothing records or replays plans: `link.ts`' plan and replay go (after the owner's review).
3. **B1: the second pass from the first's walk, for pages whose only decisions are rendered blocks, decided branches
   and dropped constants** (up to numbering: node ids by assembly). The first pass records, per anchor of a decided
   `if`, the walk's context (scope, state index, the node list it was in); after `settle` the decided anchors are
   replaced by their branch's content walked as page markup in that context (the branch's own content only), rendered
   blocks spliced as the second pass does, constants written as `dropConstants` does already, the branch templates
   and their functions left for `compactTables`, ids handed out in document order at assembly. Buys: page-compile
   about 40%, a blog page 20 to 30%. Fallback (counted): a page with anything else decided, a diagnostic that differs
   by pass (SN501, `foldedText`), the layout reading a constant (`prefold`).
4. **B2: the second pass deleted**, as B1 covers the rest (the cases its fallbacks count). Then stage 3's leftovers:
   one walk per page file (with the pipeline's placeholders), the old row route.
5. **C: live uses from units**, only if a profile after A and B says the copy and the repeated analyses matter
   (today 3.5% of page-compile, 7 to 11% of realworld).

## 5. Briefs for separate sessions

Independent of step 0 and of each other once step 0 is merged:

- **A1 brief**: goal: sinter-mail's components route (pages that ship definitions) compiles its library once per
  build in the second pass too. Design: `walkExpanded` places units only when the pass is a first one (`!decided &&
  !unrolled && !constants`); let the second pass place a unit of its own (key: the first pass's key plus `p2`) before
  its walk, at numbers from 0 (stage 4 found nothing numbered before a walk), so its templates and functions come
  before the page's (today: after the page's 4 templates; `$p<tid>` and the function order change, the canonical form
  does not). What `finishPage` changes of the unit's objects must not reach the shared unit: `anchors()` (turns
  `<template>`s into comments, makes head templates, recomputes `path`s, sets `t.a`/`t.tx`/`t.w`), `shareTemplates()`
  (points bindings elsewhere, empties templates, renames to `$pp`), `groupStyles()` (rewrites `node.b`), the
  `find`/`make` hand-outs, `compactTables()` (renumbers `b.x/z/c/f`, `t.id`, `sn-t-` ids, `$i` names), and
  `placeTemplates()` (moves the head templates' DOM into the page). The first two read only the definitions: run them
  once when the unit is made and keep their products; the rest work on a per-page structural copy of the unit's
  `TemplateDef`/`NodeDef`/`Binding`s and a clone of its head templates' DOM (measure the copy against today's 36 ms
  replay; `SN_UNITS_VERIFY`/`SN_UNITS_FREEZE` find what else writes). Switch `SN_UNITS2=0`; audit `SN_UNITS2_AUDIT=1`
  (each page compiled both ways, `canonicalText` equal, first difference thrown); fallbacks counted by reason as
  `UNIT_STATS`. Files: `src/compiler/units.ts`, `compile.ts` (`walkExpanded`, `definition`, `finishPage`), `index.ts`.
  Oracle: the canonical audit over test/compiler, `mail-audit --switch SN_UNITS2` (raw files will differ on route
  iii; compare `SN_CANON=1` builds of both), sinter-mail's `--suite --bench`, `npm run size -- --check`, the gzip of
  route iii's modules. Buys 110 to 140 ms of a 276 to 364 ms page. Must not touch: the IR's shape, the runtime, the
  type check's units (`unitCheck`: another agent's).
- **B1 brief**: goal: a page whose second pass applies only rendered blocks, decided branches and constants takes
  its result from the first pass's walk. Files: `compile.ts` (`compilePasses`, `walkExpanded`, `ifTemplate`,
  `settle`, `finishPage`), `index.ts`. First measure: how many second passes have only those decisions (a log by
  reason over the suite and the apps). Hand the ids out in document order with no gaps at assembly: that is the
  canonical order (step 0), so the new route's raw output can be compared with the old route's `SN_CANON=1` output,
  and it is lighter than today's (the block's count is not added). Oracle: canonical audit over test/compiler,
  `pass-audit`/`render-audit` with `SN_CANON=1`, the behaviour tests, page-compile's numbers. Must not touch:
  `prerender`/`worklist`/`rowRenderer` (the evaluation agent's), units.ts.

## Step 0, built: the canonicalizer (`src/compiler/canon.ts`)

- `canonical(parts)` renumbers as the plan says (templates from the roots depth first; functions in the order a
  compile makes them, as far as the IR shows it (`fnOrder`): the resources' own, the markup depth first, then what
  `finishPage` makes; state ids by node; node ids by markup order; the embedded data's ids (`data`, `json`, `embed`)
  with them; the names made from template ids (`$i`, `$p`, `$sl`, renamed loop names) and `$s<sid>` renamed in code by
  acorn and in paths (the IR's, `fixedState`, an action's `ap`) by segment). The type check's unit is left out.
  `canonicalText(parts)` is what an audit compares. `test/compiler/canon.test.ts`: two hand-made results numbered
  otherwise are equal; a changed value, binding kind, attribute or function body is not; `'x$1'` and `` `US$2` `` in
  code are untouched; a real compile with `SN_CANON=1` is the plain one with its node-id gap closed.
- `SN_CANON=1`: `compile()` outputs the canonical form (not in dev). The app audits compare canonical builds with it:
  `render-audit --switch SN_CANON`, `pass-audit` and `mail-audit` pass the environment to their children (and
  `mail-audit --switch SN_CANON=1` builds its second tree canonical).
- **The oracle of the oracle**: `SN_UNITS_SHIFT_AUDIT=1 SN_UNITS_SHIFT_AT=p2` hands out 3 of every number before the
  second pass's walk (and, as stage 4's audit does, before each first-pass definition), compiles again and logs
  whether the raw and the canonical forms agree. Results (`stage5-agent/m/shift.sh`):

  | where | second passes shifted, raw differs | of them canonical the same | first passes (definitions shifted) |
  | --- | ---: | ---: | ---: |
  | page-compile | 1 | 1 | |
  | blog live (100 entries) | 100 | 100 (after the embedded data's ids were added) | |
  | blog live-files | 100 | 100 | |
  | blog static, static-files, typecheck | 1 (the rest have no numbers: static pages) | 1 | |
  | the four examples | 9 | 9 (after `fixedState`'s dropped states were added) | |
  | sinter-mail's 16 pages, both builds | 12 (the components route's shipped library among them) | 12 | |
  | test/compiler (final run of the five files with templates' entries; earlier whole runs before the last fixes) | 139 + 6 (whole run), 60 (the five files, after the fix) | all: the 6 were the embedded data's place in the markup (`\u0001sn-json:<id>\u0001`: added); 3 earlier ones dev compiles (dev keeps the shift's own functions: dev is no longer shifted) | 1,237 the same; 1 a dev compile; 12 earlier an action's `ap` paths (added) |

- **How far canonical numbering is from today's**: test/compiler with `SN_CANON=1`: 1,067 of 1,073 pass; the 5 that
  fail (render-rows, first-paint, prefold ×3) pin a node id after a gap (`data-sn="5"` where canonical is `4`). On the
  benchmark apps, the static ones are byte for byte the same canonical (no numbers); the live blog differs in node ids
  only: the section after the rendered post is `data-sn="304"` today (the block's count is added) and `1` canonical.
  Weight (`render-audit --switch SN_CANON --keep`, `gz.mjs`, gzip -9 summed over each app's .html and .js):

  | app | HTML gzip, today → canonical | JS gzip |
  | --- | ---: | ---: |
  | blog live, 100 posts | 210,657 → 210,000 (−657) | 140,146 → 139,319 (−827) |
  | blog live-files | 224,513 → 224,077 (−436) | 127,448 → 126,698 (−750) |
  | blog static, static-files | the same bytes | none |
  | realworld | 11,020 → 11,014 | 84,781 → 84,758 |
  | dashboard | 2,096 → 2,099 (+3) | 33,807 → 33,807 |
  | multilingual-site | 11,515 → 11,512 | 12,891 → 12,890 |
  | static-site | 4,925 → 4,925 | 14,441 → 14,437 |

  | sinter-mail, its 16 pages (`mail-audit --switch SN_CANON=1 --keep`) | 23,231 → 23,229 | the six API pages' modules: 23,370 → **24,340 (+970, +4.2%)**; raw 322,029 → 320,767 (−1,262) |

  On sinter-mail's components route the canonical **function order** is worse for gzip: +322 B (+4.8%) on each
  6.6 kB page module, though 420 B smaller raw. Today the library's functions are made together (its definitions
  are compiled at once), so similar code is adjacent; the canonical order (templates depth first from the roots)
  interleaves them. So the canonical order is an oracle, **not** an output order: a step that renumbers keeps today's
  relative order where it can (A1 places the unit's functions together, before the page's: to be measured), and
  every such step measures gzip on route iii. Elsewhere canonical numbering is lighter where it changes anything (the closed gaps are fewer digits); the noise of gzip over
  renumbered digits is a few bytes either way per app (dashboard's +3 B HTML with 4 B fewer raw). So the order a
  relaxed step hands node ids out in can be the canonical one (document order, no gaps) at no cost in weight; the
  function order cannot be, as sinter-mail shows.
- **Not yet checked**: that canonical output *runs* (the behaviour tests in a browser under `SN_CANON=1`) and
  sinter-mail's suite against canonical builds. Both are part of the oracle of any step that turns renumbering on;
  canonical output is only an oracle until then.

## Log

- 18:20 UTC: merged to 09d202f, built, measurements 1 and 2 taken; render-audit on the four examples at the base:
  every file the same.
- 19:00 UTC: step 0 committed (2f9946f), then made complete by the shift audit: the embedded data's ids (a
  resource's `data`, `json`, `embed`, the `\u0001sn-json:<id>\u0001` place in the markup), states named only by
  `fixedState`, an action's `ap` paths. `SN_CANON=1` over test/compiler: 5 tests pin a node id after a gap.
- 19:40 UTC: merged `ccr-9ebf49d5-gpdej8` (5f203af); test/compiler 1,084 passed. Stopped here (out of room): A1 and B1
  are not started; their briefs (5) are what the next session takes, after running the behaviour tests and
  sinter-mail's `--suite` under `SN_CANON=1` (the one part of step 0's oracle not run).
