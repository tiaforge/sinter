# Stage 5, A1 (then A2): definitions that ship come from per-build units

Running log (2026-11-23), cloud session, branch `redesign/stage5-a1`, started at b474ecc (the integration branch).
The brief is "A1 brief" in [stage5-assembly.md](stage5-assembly.md) (section 5); the bar is in
[compile-units.md](../compile-units.md), "How the work is run".

## Where the work stands (read this first)

- **Done**: step 0's oracle completed (section 1); the components route re-measured (section 2); **A1 built and
  verified on b474ecc** (sections 3 and 4): a second pass places a unit of its own before its walk, `SN_UNITS2=0`
  turns it off, `SN_UNITS2_AUDIT=1` audits it; canonically identical over the suite and sinter-mail, every other app
  byte for byte, no page heavier, sinter-mail's suite and bench holding. A later components-route page 108 → 72 ms (142
  → 88 with TypeScript), the build's compile −14% (−19%).
- **Next**: merge `ccr-9ebf49d5-gpdej8` (20 commits since b474ecc) and verify again; then A2 (section 5: its case
  does not occur in any app measured now).

## How it is measured

Scripts in this session's scratchpad (`m/`): `instr.mjs` + `hooks.mjs` (a preload: a loader hook appends a line to
`dist/compiler/compile.js` that hands the `Compiler` class to the preload, which wraps its methods, and one to
`dist/compiler/index.js` that wraps `compile()`; every method's inclusive time per `compile()` call, by pass, the
outermost call of a key counted), `bb.mjs` (one build of sinter-mail's route with N identical pages in that process:
`comp` is route iii, the `api-templates` body; TypeScript resolvable from the app or not), `sum.mjs` (ms per page by
key: page 1, page 2, the median of pages 3 to 12, the mean of all). The machine: 4 cores, load about 1 during the
timings (nothing else running). The thread CPU clock here ticks at 4 ms, too coarse for one call, so the times are
wall clock (`SN_CLOCK=wall`), three builds each, medians of the three.

## 1. Step 0's oracle, completed

- **The suite under `SN_CANON=1`** (every build compile outputs its canonical form; dev compiles are not
  canonicalized): 2,899 of 2,904 pass; plain, all 2,904 pass (302 files, 200 s). The five that fail are the five the
  previous agent predicted, each a test that pins a node id after a gap, and nothing else: `first-paint.test.ts`
  ("build-time constants…": expects `<p data-sn="5">`), `prefold.test.ts` ×3 (expect `<button data-sn="2">`, canonical
  `1`), `render-rows.test.ts` ("the ids of what follows the rows…": expects `data-sn="5"`/`"6"`, canonical `0`/`1`).
  Every behaviour test (`test/behaviour`, 108 files, which run the compiled page in happy-dom) and every browser
  test in `test/vite` (Chromium) passes against canonical output: **canonical output runs**.
- **sinter-mail against canonical builds** (`SN_CANON=1 node scripts/mail-audit.mjs <checkout> --suite --bench --runs 9
  --switch SN_CANON=1`: the second build canonical, the library's suite run with `SN_CANON=1` in its environment, the
  bench over the canonical build): `npm test` 234 passed, `npm run check` 5 pages 0 errors, `npm run typecheck` ok.
  (The baseline run before it reported `typecheck` FAILED: on a fresh clone `sinter/sinter.components.d.ts` does not
  exist until `npm run check` writes it, and the audit runs `typecheck` first. Not a sinter difference; on the second
  run it passes. Recorded for whoever runs the audit on a fresh clone.)
  Raw files: the 6 API pages' HTML and modules differ (numbering), the 10 file pages are the same bytes.
- **The bench, today against canonical** (Chromium, 9 runs each, medians [min–max], ms):

  | case | today | canonical |
  | --- | ---: | ---: |
  | api, newsletter-2000, first render | 32.7 [24.1–45.3] | 26.5 [23.3–37.8] |
  | api, same body again (script) | 9.4 [8.6–12.7] | 9.1 [8.9–13.3] |
  | api-templates, newsletter-2000, first render | 80.9 [71.7–88.6] | 97.4 [73.4–110.6] |
  | api-templates, same body again (script) | 70.5 [55.1–101.3] | 63.0 [54.3–75.8] |
  | api-templates, corpus-static, first render | 33.0 [26.8–39.4] | 31.7 [26.5–37.7] |
  | api-fills, newsletter-2000, first render | 92.0 [66.8–108.5] | 71.3 [63.9–98.4] |
  | api-fills, same body again (script) | 54.0 [49.6–76.2] | 53.0 [48.0–74.9] |
  | every case, re-evaluated (tick) script | 0.5 to 0.8 | 0.5 to 0.9 |

  No case moves beyond its own range (the noise of a first render is ±15 to 20 ms between runs of one build). The
  weight confirms the previous agent's finding: route iii's modules +322 B (`api-templates` 22,429 → 22,751 gzip),
  +316 (`api-fills`), +336 (`api-both`), and the route ii modules ±2 B.
- **Verdict**: the canonicalizer is trustworthy as an oracle for numbering (no gap found, so no fix and no new test
  was needed); canonical output runs in happy-dom, Chromium and sinter-mail's own suite; canonical function order
  must not be shipped (weight).

## 2. The components route, per phase, on a quiet machine

ms per page (wall, the preload's overhead included), medians of three builds of 12 identical `api-templates` pages.
"Later" is the median of pages 3 to 12.

| | no TypeScript: page 1 | page 2 | later | mean of 12 | TypeScript: page 1 | page 2 | later | mean of 12 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `compile()` | 1,350 | 645 | 111 | 262 | 1,552 | 770 | 142 | 318 |
| pass 1 `walkPage` (its unit: made on page 1, placed after) | 894 | 18 | 12.5 | 89 | 1,103 | 35 | 30 | 121 |
| pass 1 `settle` | 71 | 18 | 14.6 | 19.6 | 57 | 17 | 14 | 18 |
| pass 2 `walkPage` | 228 | 533 | 44 | 100 | 285 | 648 | 54 | 132 |
| of it: definitions (top level, inclusive) | 214 (compiled) | **515 (recorded)** | **27 (replayed)** | 86 | 283 | **632** | **36** | 112 |
| pass 2 `settle` | 34 | 44 | 12.3 | 17.6 | 32 | 31 | 8.2 | 14.8 |
| pass 2 `finishPage` (after `settle`) | 110 | 74 | **34** | 48 | 104 | 68 | **30** | 44 |
| of it: `shareTemplates` | 21 | 18 | **13** | 15 | 21 | 23 | 11 | 14 |
| `groupStyles` | 45 | 6 | 5.5 | 9.8 | 42 | 6 | 6 | 9 |
| `compactTables` | 2.7 | 2.3 | 1.5 | 1.7 | 2.7 | 2.6 | 1.3 | 1.7 |
| `anchors` | 1.4 | 1.5 | 1.4 | 1.4 | 1.5 | 2.2 | 1.4 | 1.6 |
| the description compile (each page) | 16.4 | | | | 16.7 | | | |

Whole builds (wall, 12 pages, this process): 3,968 to 4,307 ms without TypeScript, 5,721 to 6,108 with.

What this changes in the plan:

- The 110 ms (139 with TypeScript) of the plan's table is the **mean** over 12 pages of the second pass's definitions,
  most of it page 2's recording (515 ms, 632 with TypeScript) and page 1's compile (214, 283). A later page replays
  them in **27 ms (36)**. So per later page A1 buys the replay (27 to 36 ms) less a placement (stage 4's first-pass
  placement is about 5 ms), plus `shareTemplates` (13) and `anchors` (1.4) if they run once per unit: about 35 to 45
  ms of 111 to 142. Per build it buys page 2's recording (about 500 to 600 ms) and the later pages' replays (10 ×
  about 25), against making the unit once (a recording, about what page 2 costs today, on page 1 instead).
  Estimate: 0.7 to 0.9 s of a 3.1 s compile (12 pages), a quarter. The plan stands; its estimate per later page is
  smaller than the plan said, the per-build one about the same.
- `groupStyles` on a later page is 5.5 ms, not 14 (the 14 was the mean, page 1's 45 in it): not worth a per-unit form
  of its own in the first cut.
- The first pass is 12.5 + 14.6 ms of a later page; the second pass's settle 12 ms. Neither is A1's.

## 3. A1 as built

Files: `src/compiler/units.ts` (`placeUnits` with `second`, `make`'s finishing, `irObjects`, `holdUnit`, the
switch), `src/compiler/compile.ts` (`walkExpanded`'s placement, `livePoints`, `anchors` and `shareTemplates`/`shareRun`
leaving a finished unit's part alone, `definition` noting what the walk asks for, `finishPage`'s check, the second pass
in `compileTwice` with `detachOutput` and the fallback), `src/compiler/index.ts` (`SN_UNITS2_AUDIT`), `src/compiler/
link.ts` (two fields classified; the recorder's view of a map in the page info, below), `src/compiler/expr.ts` (one
check reordered, below).

- **Where**: a second pass (`decided`, `unrolled` or `constants`) places a unit before its walk when the switch is on
  and points are left in its tree: `livePoints(doc)` gives the components whose recursion points and choices'
  candidates (`points`) are still in the tree after the first pass's decisions are applied (not inside rendered
  rows). Those, in expansion's order (`pointNames`), are the unit's names. A page whose every instance the first pass
  decided (sinter-mail's file emails) has none and places nothing: its second pass compiles no definition today
  either. (The first cut took every name expansion found; the file pages then made units their walk never needed, and
  a unit compiled names the old walk does not, which `files` shows: `component-cache.test.ts` under the audit.)
- **Key**: the first pass's (names, `keepsAttrs`, the locale, the axis URL) plus "pass 2", and up to 3 units by one key
  (`VARIANTS`): a second pass's unit reads more of its page that differs between pages (whether the page's own markup
  used a component before: `uses`), and the first whose reads hold is placed. On sinter-mail's 16 pages one is enough
  now that file pages place none; the cap stays for builds whose pages differ so.
- **Made** on the first page that needs it, with the recorder, as stage 4 does (`runUnit`; its writes applied to the
  page, refused for what the recorder refuses and for a diagnostic), then **finished where that reads only its
  definitions**: its choices (as stage 4), the candidates they take out removed from its markup, `anchors()` (its head
  templates made, its rows' paths counted from their normalized markup, wrappers and text runs marked) and
  `shareRun()` (its subtrees written alike kept once, renamed to `$pp`). The forms its sharing kept and the owners it
  found are kept with it, and its head templates as finished (their writes in the ops are replaced by these).
- **Placed** as stage 4 places (numbering copied, weak tables overlaid, writes made again), its head templates set,
  then **held**: its templates, their nodes and bindings and what they hold (`irObjects`: 5,377 objects on sinter-mail's
  route iii, its 355 TemplateDef, 500 NodeDef and 4,736 Binding objects and their lists, not the 58,316 objects of the
  whole unit, holding which cost 21 ms a page), and its head
  templates' elements, each `touch`ed (copied as it is). `finishPage` writes into those (`groupStyles`' binding of
  grouped styles, a row's `find`/`make`, `compactTables`' numbers, the head templates' `id` and place), and the
  page's walk does too (the tag attributes of the page's uses on a definition's root, `defRootBindings`; a tree fill's
  cases, `finishTreeFills`), and the evaluation where it paints (`touchEl`, as in the first pass).
- **A page's `finishPage` over a finished unit**: `anchors()` skips the unit's nodes, templates and head templates;
  `shareTemplates()` does nothing unless the page added templates under the unit's definitions (a tree fill's cases:
  sinter-mail's `api-fills`), which it shares against the forms the unit's sharing kept, with the owners it found then
  (after sharing, a kept subtree is reached from several definitions, so owners computed again are not the old route's:
  the first try threw on that). The page's subtrees are shared as the old route shares them; the unit's are not
  visited.
- **The output** of such a second pass is copied off the unit's objects (`detachOutput`: its IR, the early file's,
  the function list and the source map's sites, `structuredClone`; 0.6 ms) and the unit given back (`restoreUnit`,
  0.9 ms). `SN_UNITS_VERIFY=1` checks every unit object after every page, as for the first pass.
- **Fallbacks**, counted in `UNIT_STATS.fallback` as `pass 2: <reason>`; the page's second pass is then compiled again
  without units (the old route, whose definitions the linker links): `its unit refused` (with the refusal's own
  reason: a definition that reports a diagnostic, what the recorder refuses), `definitions of its own beside its unit`
  (a definition compiled after the walk, from a fill's case, beside the unit's: their subtrees would be shared
  together), `templates of its own inside its unit's rows` (a tree fill whose slot is inside a definition's row: its
  cases hang under a template whose form the unit's sharing took without them), `a definition of its unit it does not
  compile` (a net: the unit's names are the walk's), and, without a second compile, `numbered before its walk`,
  `reads its page otherwise (3 units by its key)`, `head templates before its walk`.
- **The switch**: `SN_UNITS2=0` turns the second pass's units off (and `SN_UNITS=0` both kinds). On by default.
- **The audit**: `SN_UNITS2_AUDIT=1` compiles each page without the second pass's units and through them (the
  build's store, or a fresh one: where made, then where placed), and compares the results' `canonicalText` where a
  second-pass unit was made or placed, every field byte for byte where none was; the first difference throws.
- **What a page wrote into a unit's objects without holding them**, found by `SN_UNITS_VERIFY=1` (each found first in
  a first pass's unit, stage 4's, where it was there before this work: the same failures at b474ecc under
  `SN_UNITS_AUDIT=1 SN_UNITS_VERIFY=1`, 18 of them; for a second pass's unit, whose output ships, each would put one
  page's writes into the next page's output), now held and given back:
  - the scoped styles' marks (`data-sn-c`, `data-sn-r`, `data-sn-s`, written on each use's root after the walk): on a
    unit's elements, held before they are marked (`touchMark`);
  - the tag attributes a page's uses pass to a definition (`pointAttrs` adds to the definition's map in `defAttrs`,
    which the unit made, and widens a handler binding's writes): held;
  - the page info's lists, sets and maps that the unit created (`page.aliases ??= []`, `objectFields`, `mutated`,
    `listWrites`, `urlWrites`: every page that placed the unit added to the unit's own, and the next page saw them):
    each page now gets its own copy of each when the unit is placed or made (`ownContainers`).
  Tests: `units2.test.ts` "scoped styles…", "pages that pass other attributes…" (fails without the hold), "a state the
  page made first, wrapped for `$error`…".
- **Two changes outside the route, byte for byte**: the recorder's view of an object in the page info now logs a
  `Map` inside it by key (as it logs the page info's own tables), not as one value: the second pass's build-time
  constants (`page.folds.values`, a file email's whole tree) were read whole by every definition's names; and
  `foldOf` (expr.ts) asks the map `has(name)` without checking its `size` first (a recorder reads a size as every key).
  Neither changes what a compile gives (`foldOf` returned null for an empty map either way).

## 4. Results (A1, on b474ecc)

**The suite**: `npx vitest run` 2,915 passed (302 files plus `units2.test.ts`). One run earlier in the work had
`test/vite/trusted-types.test.ts` ("tree slots under Trusted Types…", the early script's fills over embedded data) fail
once under the suite's load; it passed 5 of 5 runs alone and in every later full run: a timing flake of that browser
test, recorded.

**Tests whose expectations changed**: none of the suite's expected numbers changed (the route places no unit on any
page of the suite but the units tests' own: a page that ships definitions needs a store, which only builds pass).
Adapted knowingly: `test/compiler/units.test.ts` (its two tests compare each page through a build's units with the page
compiled without them byte for byte; pages whose second pass now places a unit of its own are compared up to
numbering, `SN_CANON=1`, the rest byte for byte as before; its pages moved to `units-pages.ts`, shared with the new
tests). New: `test/compiler/units2.test.ts` (10 tests: the route and its numbers, both orders, two rounds; a page that
ships nothing byte for byte; the switch; under the type check; scoped styles, a definition's tag attributes and the
page info's lists under `SN_UNITS_VERIFY`; the fallbacks `templates of its own inside its unit's rows` and `its unit
refused`).

**The audits** (test/compiler; failures compared with the same audit at b474ecc, in a worktree of it):

| audit | b474ecc | A1 | only A1's |
| --- | --- | --- | --- |
| `SN_UNITS2_AUDIT=1 SN_UNITS_VERIFY=1` (the whole suite) | (new) | 54 failed, 2,861 passed | none is a difference or a unit object changed: link-review-3/4/5 (11), one-pass (5), render-rows (36): tests that count compiles, links or rendered rows, which the audit's compiles add to; units2 (2): its counts |
| `SN_UNITS_AUDIT=1` | 62 failed | 70 failed | the 8 of `units2.test.ts` that count its route: this audit compiles with the second pass's units off (its route is the first pass's, byte for byte; adapted: `auditedUnits` forces them off) |
| `SN_RENDER_AUDIT=1` | 0 | 1 | `units2.test.ts`, the rows fallback's count (the audit's compiles count it again) |
| `SN_ONE_PASS_AUDIT=1` | 0 | 0 | |
| `SN_LINK_AUDIT=1` | 0 | 2 | `units2.test.ts`, the two fallback counts |
| `SN_UNITS_AUDIT=1 SN_UNITS_VERIFY=1` (render-rows, link-review, one-pass, libraries) | 18 unit objects changed (first-pass units) | 0 | (fixed: the scoped styles' marks, `defAttrs`, the page info's containers) |

**The apps** (`scripts/render-audit.mjs --switch SN_UNITS2`: the four benchmark apps of 100 posts and the four
examples): every file the same, raw (no page of theirs has points left in a second pass) and with `SN_CANON=1`.
`scripts/pass-audit.mjs`: every file the same. No fallback of A1's counted in any of them (`UNIT_STATS`, per build).

**The components route, before and after** (12 identical `api-templates` pages, one build in one process, wall ms
with the preload, medians of three builds each, the route off (`SN_UNITS2=0`) and on, in the same conditions):

| | off: page 1 | page 2 | later | mean | build's compile | on: page 1 | page 2 | later | mean | build's compile |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no TypeScript: `compile()` | 1,270 | 661 | **108** | 243 | 2,917 | 1,666 | 88 | **72** | 209 | **2,503** |
| pass 2 `walkPage` | 254 | 515 | 41 | 96 | 1,148 | 641 | 20 | 17 | 69 | 833 |
| of it: the unit made (page 1) / placed | | | | | | 625 | 6.2 | 3.3 | | |
| definitions compiled, recorded, replayed / held | 234 | 493 | 26 | 82 | 986 | (in the unit) | 5.9 | 3.8 | | |
| pass 2 `finishPage` | 115 | 65 | 33 | 45 | 536 | 106 | 26 | 24 | 31 | 375 |
| of it: `shareTemplates` | 22 | 18 | 13.4 | 14 | 166 | 0.7 | 0.5 | 0.1 | 0.2 | 3 |
| `restoreUnit` (and VERIFY off) | | | | | | 2.8 | 2.4 | 0.9 | | 16 |
| with TypeScript: `compile()` | 1,407 | 773 | **142** | 295 | 3,537 | 1,886 | 117 | **88** | 240 | **2,882** |
| pass 2 `walkPage` | 303 | 659 | 55 | 132 | 1,584 | 760 | 25 | 19 | 81 | 970 |

Whole builds (wall, no preload difference between the two): without TypeScript 3,962 to 4,234 ms off, 3,526 to 4,120
on; with TypeScript 5,729 to 5,983 off, 5,049 to 5,615 on. So: a later page −36 ms (−33%), −54 ms with TypeScript
(−38%: its second pass no longer copies a check part it throws away); page 2 is a page like the others now instead of
the linker's recording; page 1 pays the unit's making with the recorder (625 ms; 745 with TypeScript) where today it
compiled in place (234) and page 2 recorded (493). The build's compile −414 ms (−14%), −655 with TypeScript (−19%).
Making a unit with a recorder costs two to three compiles; a unit compiler with fresh tables (stage 4's plan step 2)
would cost one, and is the next thing that would pay on this route (about 400 ms a build).

**sinter-mail** (`scripts/mail-audit.mjs <checkout> --switch SN_UNITS2`): raw, the three route iii pages differ (their
HTML and modules: numbering), the other 39 files are the same bytes; with `SN_CANON=1` and `SN_UNITS_VERIFY=1`, all
42 files the same. Units: one second-pass unit made, placed on the other two pages; no fallback. Its suite against the
default build: `npm test` 234 passed, `check` 5 pages 0 errors, `typecheck` ok. The bench (9 runs, medians [min–max],
ms), before (b474ecc) and after:

| case | before | after |
| --- | ---: | ---: |
| api-templates, newsletter-2000, first render | 80.9 [71.7–88.6] | 73.8 [66.9–81.7] |
| api-templates, same body again (script) | 70.5 [55.1–101.3] | 57.1 [51.9–85.0] |
| api-templates, corpus-static, first render | 33.0 [26.8–39.4] | 28.9 [26.1–34.5] |
| api-fills, newsletter-2000, first render | 92.0 [66.8–108.5] | 81.1 [65.3–97.5] |
| api-fills, same body again (script) | 54.0 [49.6–76.2] | 53.3 [43.4–82.0] |
| api-fills, corpus-static, first render | 35.6 [26.8–43.1] | 30.1 [26.0–38.3] |
| api (route ii, unchanged), newsletter-2000, first render | 32.7 [24.1–45.3] | 23.9 [21.7–32.0] |
| every case, re-evaluated (tick) script | 0.5 to 0.8 | 0.5 to 0.7 |

Within noise everywhere (route ii, whose output is the same bytes, moves as much as route iii): the browser runs
the same program, numbered otherwise.

**Weight** (gzip -9 of every .html and .js, `scripts/render-audit.mjs`/`mail-audit.mjs --keep`, off against on):

| build | total gzip, off → on | worst file |
| --- | ---: | ---: |
| sinter-mail, 16 pages | 100,656 → 100,639 (−17) | `assets/api-both.js` 6,605 → 6,606 (+1; raw 103,820 → 103,803) |
| bench-static, -live, -static-files, -live-files; static-site, multilingual-site, dashboard, realworld | the same bytes | 0 |

Route iii's files: `api-templates.js` −8, `api-fills.js` −1, `api-both.js` +1, their pages −6, −2, −1. The noise of
gzip over renumbered digits is a few bytes either way per file (step 0 measured −2 to +3 B for files whose content
differed by numbering only: dashboard's HTML +3 B with 4 fewer raw bytes); +1 B on a 6.6 kB module is within it. The
unit's functions stay together (before the page's, as the library's were together after them), which is why the
canonical order's +322 B does not appear. `npm run size -- --check`: passes.


## Log

- 19:10 UTC: suite plain and canonical, sinter-mail baseline and canonical (`--suite --bench`), per-phase timings.
- 20:20 UTC: A1 built and verified (sections 3, 4), committed.
