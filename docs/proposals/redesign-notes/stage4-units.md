# Stage 4, spiked: a definition compiled once per build

Running log (2026-11-23), branch `units-spike`. The question ([compile-units.md](../compile-units.md), stage 4): what is
the smallest sound way to compile each shared definition (a recursion point, a `<sn-component use>` candidate) once
per build and place it on every page that needs it, with byte-identical output, under the type check too, and what it
buys. Today the linker (`src/compiler/link.ts`, [compile-once.md](../compile-once.md) (5)) records a top-level
definition on its second page and replays it on later pages numbered alike; it is off under `check`, in dev and in
small description compiles.

## How it is measured

Scripts in `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/units-agent/m/`:

- `instr.mjs` (+ `hooks.mjs`): a preload that wraps `Compiler.prototype.definition`, `compileDefinition`, `walkPage`
  and link.ts's `recordChild` and `replay` in the worktree's `dist/`, per `compile()` call. `SN_CLOCK=cpu` times the
  main thread's CPU. `timing.sh` runs the builds round after round, `tsum.mjs` gives medians.
- `reads.mjs` (+ `hooks2.mjs`): the linker's recorder as an instrument. Every top-level definition on every page is
  compiled through `recordChild` (which applies its writes, so the page is what it is otherwise), and what it read of
  its page (`Read`), what it added (its functions' code, its template table, its head templates' markup) and how the
  page was numbered before it are kept. `an2.mjs` groups the reads, `an3.mjs` compares a unit's products between pages
  numbered otherwise.
- `SN_UNITS_SHIFT_AUDIT=1` (in `compile.ts`, this branch): each page is compiled again with 3 templates, functions,
  state ids and use ids handed out before every top-level definition of its first pass, unlinked, and whether the
  output is the same is logged to `SN_UNITS_SHIFT_LOG`. `shift.mjs` does the same from outside, for whole builds.
- sinter-mail: a copy of `tiavision/sinter-html` in the scratch directory, its `@tiaforge-ui/sinter` resolving to this
  worktree; `bb.mjs` builds one route's app (12 identical pages, as the baselines in
  [sinter-mail.md](sinter-mail.md)), `scripts/mail-audit.mjs` its 16 pages of every route. The blog: `bench/astro`'s
  apps written by `mkblog.mjs` (`static-files`, `live-files`, `static-files` with the type check; 100 posts), and a
  variant (`u-var`, 20 live posts) where a third of the posts have one more bound element before the article and a
  third one more loop.
- The machine had a load of 8 to 16 on 4 cores throughout (other agents' builds): absolute times are 2 to 3 times what
  a quiet machine gives. Compare columns; times are the main thread's CPU, medians of the rounds.

## 1. What a page spends on definitions today

CPU ms, `timing.sh` (rounds as given). "Definitions" is the time in top-level `compileDefinition`, `recordChild` and
`replay`; "later pages" are pages 3 to 12 (3 to 100), after the linker has recorded.

| build (12 pages; the blog 101) | wall ms | compile, all pages | definitions, all pages | page 1 | page 2 | a later page: definitions | a later page: whole compile | a later page: compiled / linked units |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter-mail, file email | 6,692 | 2,275 | 1,434 | 326 | 686 | 31 | 88 | 0 / 1 |
| sinter-mail, file email, TypeScript | 28,592 | 4,554 | 3,073 | 288 | 270 | 267 | 365 | 63 defs / 0 |
| sinter-mail, API (script builder) | 6,109 | 1,952 | 1,307 | 332 | 731 | 24 | 73 | 0 / 1 |
| sinter-mail, API, TypeScript | 31,015 | 3,905 | 2,922 | 398 | 257 | 238 | 307 | 63 defs / 0 |
| sinter-mail, API through the components | 15,614 | 3,983 | 2,461 | 658 | 1,171 | 62 | 178 | 0 / 2 |
| sinter-mail, components, TypeScript | 40,798 | 8,034 | 6,195 | 738 | 532 | 507 | 656 | 126 defs / 0 |
| blog, static-files | 14,780 | 2,823 | 547 | 0 (index) | 44 | 4.0 | 21 | 0 / 4 |
| blog, live-files | 10,532 | 2,845 | 470 | 0 (index) | 53 | 3.8 | 24 | 0 / 4 |
| blog, static-files, TypeScript | 33,317 | 4,960 | 2,261 | 45 | 33 | 22 | 46 | 19 defs / 0 |

- **Without TypeScript, the linker works in these builds**: page 1 compiles the library (sinter-mail: 63 definitions
  under one top-level unit, `mail-a`, the dispatch's first candidate; the blog: 19 definitions under four
  units), page 2 compiles and records them, which costs 2 to 2.5 times a compile (sinter-mail: 800 ms against 330),
  and every later page replays them. A replay is not free: on sinter-mail it is 36 ms of a 94 ms page (the plan is
  72,176 objects, 52,338 writes, 4,658 function hand-outs and 6,250 DOM nodes: the dispatch's 65 `<sn-component use>`
  over 64 candidates each is 4,160 candidate clones, each a recursion point with its weak-table entries, 4,030 of them
  removed after the walk), on the blog 4 ms of 27.
- **With TypeScript nothing links**: every page compiles every definition. sinter-mail: 63 definitions, 238 ms of a
  314 ms page (75%); the components route does it in both passes (126). The blog: 19 definitions, 18 of 41 ms.
- Of a whole build's compile time, the definitions are 66% (sinter-mail API, no TypeScript; most of it the first two
  pages), 75% with TypeScript; the blog's files variant 18%, with TypeScript 43%. With TypeScript the wall time is
  dominated by `tsc` (about 18 s of sinter-mail's 31 s here), which is the type-check agent's.

## 2. What a definition reads of its page

Every top-level definition on every page recorded (`reads.mjs`), its `Read`s grouped by what they read. "Differs" is
the number of places read whose value is not the same on every page of the build that compiles that unit; "some pages"
the places read on some of those pages only.

| read | reads per unit | differs between pages | read on some pages only | essential? |
| --- | ---: | ---: | ---: | --- |
| `dlTemplates` has (a dialog template set, by template id) | 218 (mail), 15 (blog) | 0 | 46 (`u-var`) | artifact: keys are the unit's own template ids, absent on every page |
| `defAttrs` has (by `$p<tid>`) | 126, 14 | 1 (`u-var`) | 104 (`u-var`) | artifact: the unit's own `$p<tid>` keys; "differs" only because the page's numbering shifted them |
| `srcOf` has (sources by `@def:<name>:<prop>`) | 126, 14 | 0 | 0 | the page's: another definition of the same name's sources (none on any page) |
| `layoutFiles` has (by component name) | 128, 12 | 0 | 0 | build-constant (whether a component is a layout) |
| `componentFiles[*].bad` | 69, 20 | 0 | 0 | build-constant for a file (what it is found to be), learned per page |
| `uses` has (by component name) | 64, 6 | 0 | 0 | the page's: whether the page used the component before (order of first use: `once()`, `componentIds`) |
| `page.namespaces` (helper namespaces, by property) | 14, 2.5 | 0 | 0 | build-constant (the helpers module) |
| `page.locale`, `page.axisUrl`, `page.lazy`, `canonicalLink`, `keepsAttrs` | 1 each | 0 | 0 | the page's options; essential where a definition uses `$locale`, `localeUrl()`, `$canonical`; key them |
| `check` (the whole check unit, by value) | 1 | 0 here, but the page's expressions before it make it differ on any page that has some | | essential under `check`: the unit's frames and expressions are numbered from the page's |
| `nextId`, `inDef`, `diagnostics` (length) | 1 each | `nextId` 2 of 2 (`mail-audit`) | | artifact: the unit hands out no node id; diagnostics before it only by count |
| numbering before it (templates, states, uses, node ids, functions, actions: the linker's key) | | 4 keys over 16 pages (`mail-audit`), 3 over 20 (`u-var`), 1 (`bb.mjs`, the blog) | | see 3 |

Over sinter-mail's 16 audit pages (every route, pass 1 and 2), the blog's 100 posts and the varied blog, **nothing a
definition reads differs between pages except how the page is numbered before it**, and what the page's earlier
markup used (`uses`, `srcOf`), which is the same everywhere here. Refused: none. The reads that are not numbering are
either build-constant (component files, layouts, helpers) or page options (locale, axis URL, lazy, canonical link),
which belong in a unit's key.

## 3. How a definition's numbers reach the output

`an3.mjs`: a unit's products on pages numbered otherwise before it, compared token by token.

| what differs before the definition | its code | its head markup | its tables |
| --- | --- | --- | --- |
| state ids, use ids, node ids, function count (`mail-audit`: 3 of 4 keys; `u-var`: one more bound element) | identical (4,223 functions) | identical | function indices only (`"f": N`, `key`, `find`) |
| one more template before it (`u-var`: a loop before the article) | `$p<tid>` (15), `n$<tid>`, `i$<tid>`, `b$<tid>` (renamed loop names) | `sn-t-<tid>` | template ids (`x`, `c`), `$i<tid>`, `$sl<tid>`, `$p<tid>`, function indices |

In a page that ships a definition (the components route's second pass), after `compactTables`:

- `sn-t-<n>` (head template ids) and `$i<n>` (loop indices) are renumbered by first appearance; functions are
  deduplicated and renumbered in order.
- `$p<tid>` (a definition's item), `$sl<tid>` (a tree slot's item), `<name>$<tid>` (a loop name renamed inside a
  component) and `$s<sid>` keep the walk's numbers: they are page-global and inside code strings
  (`probe3.mjs`: a page with two templates before the tree ships `$p3, $p4, $p7` where the page without them ships
  `$p1, $p2, $p5`).
- Use ids do not reach the output (`@ev:<id>` sources are resolved away); definitions hand out no node ids (the
  linker refuses one that does).

So a definition compiled with numbers of its own cannot be placed by copying (option (b), "canonical numbering by
construction", fails: the numbers inside code are not normalized), and placing it by renumbering needs every
`$p`/`$sl`/`$i`/loop-rename/`$s` in code to be a hole.

**But in the first pass they do not reach the output at all.** A first pass followed by a second is thrown away but for
its decisions (`decided`, `unrolled`, `constants`, `rendered`, `overLimit`, `frozen`), and those are keyed by place
(`instKey`, `siteKey`), not by number. The shift audit:

- sinter-mail's 16 audit pages, every definition of the first pass shifted by 3 of everything: 42 files, byte for byte
  the same (and the same both ways with the render switch).
- The varied blog, without and with TypeScript (80 definitions shifted): every file the same, the check too.
- `test/compiler` under `SN_UNITS_SHIFT_AUDIT=1`: 1,292 compiles with first-pass definitions; 118 have a second pass
  and are all the same; the 1,174 that differ all ship their first pass (no second pass follows: tests without
  `prerender`, or nothing decided). None differs where a second pass follows. (13 tests fail under the audit
  because they count compiles, which the audit adds to.)

In the builds measured, every page that compiles definitions in its first pass has a second pass (sinter-mail's three
routes, the blog): the library compile that stage 4 is about is a first-pass compile whose numbers are thrown away.
Only sinter-mail's components route compiles them again in its second pass, where they ship.

## The design the numbers point to

Rejected, with the evidence:

- **(b) Canonical numbering by construction**, a unit's bytes page-independent so that placing it is copying: the
  output keeps `$p<tid>`, `$sl<tid>`, renamed loop names and `$s<sid>` with the walk's page-global numbers inside code
  (3), which `compactTables` does not normalize; normalizing them changes the bytes. Reserving a per-definition range
  in the page's tables (numbers far above the page's) breaks the compiler at once: `templates` and `fns` are dense
  lists that it walks by index (`SN_HOLE` in `shift.mjs`: every page fails in `markLowPriority`).
- **(a) Local numbering with every number inside code a typed hole**, everywhere: right for the second pass (where the
  definitions ship), but it touches the five places that make names from template ids (`compileDefinition`,
  `recursionPoint`'s `$p`, `runtimePlacement` and `finishTreeFills`' `$sl`, `forTemplate`'s `$i` and renamed loop
  names), the seven that make state names (`expr.ts` `emitName` and paths, `stateOf`'s aliases, `cmp`, form
  `$error`), use-id sources (`@ev:`), fill ids and lazy imports, and every reader that parses code by pattern after
  the walk (`$s(\d+)` in `prerender`, `writtenState`, `fixedState`; `$i\d+` in `compactTables`; `$p` in
  `shareTemplates`). Not needed for what stage 4 is about, as the shift audit shows: the library compile on every page
  is a first-pass compile, and the first pass's numbers are thrown away.
- **Extending the linker** (record on first sight, renumber the plan, log the check unit): the plan is a copy of
  everything the definition wrote, weak tables included (72,176 objects for sinter-mail), and replaying it is 33% of a
  later page's compile there; renumbering a generic plan is what three reviews broke. Not taken.

Chosen, **(c) first-pass units**: a top-level definition of a first pass is compiled once per build, in a compiler of
its own (fresh tables, not views of a page), with names that cannot meet a page's, and placed on each page by a typed
copy that renumbers only *structural* numbers (template indices and function indices in the IR's fields). Its strings
are never renamed, because in a first pass followed by a second they do not reach the output (3); a page whose first
pass turns out to be its output compiles again without units.

- **Names.** One function per kind makes the names from numbers (`$p`, `$sl`, `$i`, loop renames, `sn-t-`); on a page
  it is the number, as now. A unit compiles with its numbers counted from 0 and its names from a base unique in the
  build (unit k: 1,000,000·(k+1) and up), so a unit's `$p1000003` is the same on every page and no page has it.
- **What it may read.** Its own tables are empty and its own; shared as now: the component files and their caches,
  the build's options. The page info is a view that logs: what the measured units read (helper namespaces, the locale,
  the axis URL, lazy modules, the canonical link) goes into the unit's key; any other read of the page (its resources,
  dialogs, ids, `uses`) makes the unit fall back for that page, counted by reason. That is a log of a handful of page
  properties, not of 150 tables: the reads in 2 that are tables are of the unit's own keys, which a fresh compiler
  answers alike.
- **Placing it.** Its templates are appended at the page's count; its function hand-outs replayed through the page's
  `fn()` in order (the page's dedupe and numbering), giving a map from the unit's indices to the page's; template ids
  and function indices are renumbered in the typed fields that hold them (`Binding` `f a x z c s`, `TemplateDef`
  `key find make`, `NodeDef` `state`, the keys of `headTemplates`, `templateAt`, `tplDiags`, `defs`' `tid`, choice
  cases). Its DOM and the weak tables keyed by it are copied per page (the page's walk and `remove` change them), or
  overlaid where nothing changes them; which is cheaper is measured in the slice. A unit is checked once when it is made:
  compiled at two local bases, every number of its products that differs must sit in a field the copy renumbers, or the
  unit falls back (`untyped number`).
- **Fallbacks, by reason**: the unit hands out a state id (its `$s<sid>` is page-global in code and parsed back by
  pattern), a node id, an action, a fill id, a lazy import or a use-id source (`@ev:`); it reads the page (above); the
  page's first pass is its output (no second pass: `prerender` off, nothing decided; recompiled without units); dev
  and describe compiles. None of these occurs in sinter-mail's 16 pages or the blog (0 states, 0 node ids, 0 refusals;
  every page has a second pass).
- **Under the type check**, the first pass is finished, but only its check unit is kept (`compilePasses`), so the same
  holds for its numbers; the check unit's frames are numbered from the page's (`CheckExpr.frames`, a typed field: an
  offset at placement). If the type-check agent's "a component's markup checked once" lands first, a unit carries no
  check data after the build's first page, which is simpler still; either composes.
- **The second pass** (sinter-mail's components route compiles the library there too, and ships it): its definitions'
  names reach the output, so a unit there is placed only where the page's template count before it is the unit's
  (true on all 16 audit pages) and its names are the page's numbers, with function indices renumbered as above. A
  step after the first-pass units.

## What it buys (estimate from 1)

CPU ms of the compile under the load above; a quiet machine is about 2.5 times faster. "Units" assumes one compile of
the library per build (as page 1 today) and a placement per later page between today's replay (upper) and a tenth of
it (lower: the unit's DOM shared).

| build | definitions today | with units | saved | of the build's compile |
| --- | ---: | ---: | ---: | ---: |
| sinter-mail API, 12 pages | 1,307 | 360 to 600 | 0.7 to 0.95 s | 36 to 48% |
| sinter-mail API, TypeScript | 2,922 | 420 to 660 | 2.3 to 2.5 s | 60 to 64% |
| sinter-mail components, TypeScript (both passes) | 6,195 | about 1,500 (pass 2 still per page until its step) | 4.7 s | 58% |
| blog static-files, 100 posts | 547 | 85 to 440 | 0.1 to 0.45 s | 4 to 16% |
| blog static-files, TypeScript | 2,261 | 85 to 440 | 1.8 to 2.2 s | 37 to 44% |

With TypeScript the wall time is mostly `tsc` (sinter-mail: 18 of 31 s here), which this does not touch.

## The plan, in landable steps (each byte-identical, each with its switch and audit)

0. **The oracle** (this branch): `SN_UNITS_SHIFT_AUDIT=1` checks the claim the design rests on, that a first pass's
   definition numbers never reach the output when a second pass follows. Run it over the whole suite in CI beside
   `SN_LINK_AUDIT`; it logs, it does not throw, because pages that ship their first pass differ by design.
1. **Names through one function** (`tidName`), at the five sites above and the head templates' ids. No change in
   bytes; the shift audit and the suite as they are.
2. **`src/compiler/units.ts`: the unit compiler and its merge.** `unitCompiler(page)`: a `Compiler` with fresh tables,
   the build's caches, the logged page view, its counters and names those of the page at the definition (so nothing
   is renumbered yet). `definition()` compiles every definition through it when `SN_UNITS` is on and merges its tables
   into the page by appending; nothing is kept across pages yet. This is the step that shows a fresh compiler is
   equivalent to compiling in the page (the reads of 2 say it should be): `SN_UNITS_AUDIT=1` compiles each page both
   ways and throws on the first difference, over the suite, the render audit's apps and sinter-mail.
3. **The typed copy**: placement at any page count, function hand-outs replayed, the two-base check, the copy or
   overlay of the unit's DOM; the unit kept in the build's map. From here a build compiles each first-pass definition
   once. Fallbacks counted (`__snUnits`).
4. **The first pass that ships**: detected after the walk; the page compiled again without units, counted.
5. **Check**: the check unit's frames and expressions carried and offset (or nothing, if checking once has landed).
   The linker's `this.check` condition goes.
6. **The second pass**, keyed by the page's template count, names as the page's.
7. **The linker deleted**: `definition()`'s cache path and `defLink`, `unitChild`, `src/compiler/link.ts` (865 lines:
   the recorder, its wrappers, `keep`, `replay`), `LINK_FIELDS` and `UNIT_NUMBERING`, the `definitions` option and its
   plumbing in `src/vite.ts`, `test/compiler/link*.test.ts` (seven files) and the `SN_LINK_AUDIT` CI job; the
   `INERT_FILLS`-style workarounds that exist so that a field need not be classified.

Estimate: step 1 half a day; 2 to 4, the core, three to four days with their audits (the risk is the typed copy, which
the two-base check turns from a wrong page into a fallback); 5 a day (less after checking once); 6 one to two days;
7 half a day. About a week and a half of agent time, with one independent review after step 3, as the linker had.

## Status

- Measurements 1 to 3 and the shift audit: done (above).
- The slice (steps 1 to 4) is not built: the honest answer to "the smallest sound way" is the plan above, whose core
  (a fresh unit compiler and a typed, renumbering copy of what it made) is a refactor of `definition()`'s products of
  its own. What this branch has is the evidence that makes it smaller than option (a): no number inside code needs to
  be a hole for the per-page library compile.
- Checks of this branch (the shift audit is the only code, and only under its variable): `npx vitest run
  test/compiler` 1,045 passed; `SN_RENDER_AUDIT=1` the same; `SN_LINK_AUDIT=1` 1,043 passed and two that timed out at
  5 s under a load of 16 (`link.test.ts`, `link-review-3.test.ts`), both passing when run alone; `scripts/mail-audit.mjs`
  42 files identical.

## The implementation (after the coordinator's go-ahead)

### Placement: the unit put first, shared, and given back (`src/compiler/units.ts`)

Measured before building it: before a first pass's walk nothing is numbered on any page (templates, functions,
states, use ids, node ids, actions all 0: `prewalk.mjs` over sinter-mail's 16 pages and the blog), and the shift audit
extended to the whole first pass (`SN_UNITS_SHIFT_AT=walk`: everything shifted from before the walk) leaves every
page with a second pass the same (sinter-mail's 42 files; the varied blog with and without TypeScript, 72 pages).
So a page's definitions can be compiled **before** its walk, at numbers that are the same on every page, and the
unit's objects need no renumbering at all: placing it is sharing it. Plan step 1 (names through one function) is not
needed.

- **Which definitions**: the names of the page's own recursion points and candidates, in the order expansion found
  them (`pointNames`), all compiled into one unit before the walk. The key: those names, `keepsAttrs`, the locale, the
  axis URL.
- **Made** on the first page that needs it with the linker's recorder (`runUnit`, its writes applied to the page):
  what it read of its page is the unit's precondition (`readsHold` on each page that places it), what it wrote the
  unit's content. Refused, counted: what the recorder refuses (actions, fill ids, lazy imports, node ids), a
  diagnostic, an object of its page held inside one of its own, text that names its page's file elsewhere than in an
  origin. The candidates its choices would take out after the walk are taken out before it is shared.
- **Placed**: the numbering (function table, template list, counters) copied, the weak tables overlaid
  (`OverlayMap`/`OverlaySet`: the page's entries, then the unit's), the writes into the page's own tables made again
  (by value: the unit's own objects as they are), and the origins that name the page that made it (a definition's
  host, the include chains) made anew with this page's file (as the linker's `FILE`/`Line` did).
- **What a page changes of a unit's objects**, found by `SN_UNITS_VERIFY=1` (each unit object's own values printed
  when made and checked after every page) and `SN_UNITS_FREEZE=<property>` (those objects frozen, so the write
  throws where it is): `finishTreeFills` (a tree placement's cases and choice), `finishChoices`, `defRootBindings`,
  `addSources`, `componentScope` and the root's state id (a fill case walking a definition's default children), the
  evaluation's paints into template markup, its folded texts, `dropConstants`. Each such write `touch`es the object
  first (a shallow copy, once per page); `restoreUnit` puts them back when the first pass is done
  (`compilePasses`). Two other leaks found on the way: the unit's numbering was the making page's own list, which the
  page went on to extend (copied now), and the origins naming the making page's file (`defFiles` counted it as a
  component file on the next page, which made a rendered row fall back).
- **A first pass that is finished** (its output, its diagnostics read, or under `check` for now) is compiled again
  without units (`a first pass that is finished`), and so is one whose unit was refused after compiling before the
  walk.

Placement and the walk it leaves, CPU ms per later page (pages 3 to 12, 3 to 101), units off and on, one
instrumented build each (load 14 to 16):

| build | replay (off) | placement (on) | first pass's walk, off / on | page compile, off / on | whole build's compile, off / on |
| --- | ---: | ---: | ---: | ---: | ---: |
| sinter-mail API, 12 pages | 25.7 | 5.6 | 53 / 20 | 67 / 38 | 1,760 / 1,380 |
| sinter-mail file email | 34.7 | 7.4 | 70 / 19 | 102 / 57 | 2,127 / 1,598 |
| sinter-mail components route | 62.2 (both passes) | 5.5 (+ the second pass's replay 30) | 61 / 19 | 164 / 120 | 3,601 / 3,468 |
| blog static-files, 101 | 3.7 | under 0.1 | 7.0 / 2.4 | 19.8 / 15.7 | 2,401 / 1,898 |
| blog live-files | 4.0 | under 0.1 | 9.2 / 4.0 | 27.5 / 22.7 | 3,040 / 2,516 |

Making the unit costs what the linker's recording did, once per build instead of the linker's compile and record
(sinter-mail: 860 ms CPU on the first page, against 276 + 603). The components route still compiles and links the
library in its second pass (plan step 6). The blog with the type check is unchanged: under `check` nothing is placed
yet.

Byte for byte: `scripts/render-audit.mjs --switch SN_UNITS` (the four benchmark apps and the four examples, units off
and on): every file the same; `scripts/mail-audit.mjs` with `SN_UNITS=0` and on, both of its builds kept and diffed:
42 files the same (and the same with `SN_UNITS_VERIFY=1`); the varied blog with and without TypeScript the same.
`test/compiler` passes plain (1,046), and under `SN_UNITS_AUDIT=1` no page differs (the 60 failures are the tests
that count compiles, links or rendered rows, which the audit's extra compiles change, and timeouts).

### Under the type check

A unit made under `check` records its frames and expressions in a check unit of its own (`runUnit`'s `own` fields,
neither logged nor applied to the page), by the top-level name whose definition recorded them. A page takes a name's
part at its first `definition()` of it, which is where compiling in place records it: its frames and expressions
numbered from the page's counts there (`init` and `frames` are the only numbers in them), its scopes' frames
(`frameOf`) too, the page that made it named as this one in the locations. A walk that takes the names in another
order than the unit compiled them is compiled again without units (`checkOrder`). With a unit placed, a first pass
under check is no longer finished: its check unit is complete after the walk (nothing after it writes one), and the
second pass's output takes it, as `compilePasses` does when it is finished. The part is copied per page (its numbers
are the page's); it is recorded once. With 519bbe5 the shadows' functions that repeat are given to `tsc` once, so
the copies cost the compile only.

| build | later page, off / on | whole build's compile, off / on | wall, off / on |
| --- | ---: | ---: | ---: |
| sinter-mail API, TypeScript, 12 pages | 343 / 63 | 4,183 / 1,839 | 7.8 / 5.0 s |
| sinter-mail file email, TypeScript | 353 / 68 | 4,380 / 1,866 | 8.0 / 5.6 s |
| sinter-mail components, TypeScript | 551 / 333 (the second pass still compiles the library: 225) | 7,042 / 5,254 | 11.4 / 9.3 s |
| blog static-files, TypeScript, 101 | 44.7 / 20.9 | 4,728 / 2,553 | 14.4 / 9.1 s |

(CPU ms, one build each, load 13 to 16; every output file the same both ways.)

### Evaluation: the unit's functions compiled once per build

`prerender` compiles every function the evaluation may run in one `new Function` per page. The unit's (on
sinter-mail 4,223 codes) are now compiled once per build (`unitTable`): one table over all of the unit's code, whose
free names (the helpers as stubs or folding calls, the formatters, `$k`, `$href`…) are `let` variables of the
table's scope that each page binds to its own values before it evaluates; the page compiles only what is left. A
unit table that does not compile falls back to the page compiling everything (counted). It bought less than
expected: on sinter-mail a later page's walk went from 20 to 18.5 ms (API), 18.5 to 17.9 (file email): the
`new Function` over the unit's code was not the evaluation's cost. What `prerender` spends now (17 ms a page on
sinter-mail under the profiler, 7.6 of it its own) is collecting the candidates and the rows' code over every
template, the unit's 355 included, and the worklist's evaluation (`run`, the scope proxy): stage 6's work.

### Placement, shortened

- The unit's choices (65 `<sn-component use>` groups on sinter-mail, all candidates its own) are finished once when
  it is made, not by every page after its walk (`finishChoices` was 5.6 ms a page).
- What placing writes is shortened when the unit is made: a compiler field the unit wrote many times (`lastExpr`
  4,665 times, `inDef`) is written once, its last value; the 4,030 candidates its choices take out after the walk
  are out already, so the page's list does not take them.

### Reconciled with the type check's changes (b41fab5)

The check unit's lists are now the compiler's own fields (`checkFrames`, `checkExprs`, f910e52): a unit is made with
fresh ones of its own (`runUnit`'s `own`), and `unitCheck` pushes a name's part into the page's. Under check the first
pass already stops at its decisions (2bc2a73); with a unit placed it does so only where the walk took the unit's check
data in the unit's order (`checkOrder`), else it is compiled again without units. Checks on the merged tree: build;
`test/compiler test/vite test/check` 1,414 (eight timed out at 5 s under a load of 19 to 25 and pass alone); under
`SN_UNITS_AUDIT` no page differs (71 failures: tests that count compiles, links or rendered rows, and timeouts);
`SN_RENDER_AUDIT` 1,055 passed; `SN_LINK_AUDIT` 1,042 and 13 timeouts that pass alone; `render-audit --switch
SN_UNITS` every file the same; `mail-audit` 42 files the same, and the same with units off and on.

## Where stage 4 stands, and what is left (for the review before the linker goes)

### What the linker still covers that units do not

Units place a first pass's definitions in builds. Everything else that compiles a shared definition still goes through
`definition()`'s linker path (`opts.definitions`) or compiles in place:

| case | units | linker today | measured where |
| --- | --- | --- | --- |
| the second pass's definitions (live instances that stay recursion points; sinter-mail's components route compiles the library again there and ships it) | **yes since stage 5's A1** (`stage5-a1.md`): a unit of the second pass, placed before its walk, its numbers first (identical up to numbering); the linker only for A1's fallbacks: a unit refused, definitions of the page's own beside the unit's, a fill's cases inside a unit's rows, more than 3 units by one key, and `SN_UNITS2=0` | records on the 2nd page, replays (27 ms a later page on sinter-mail, 36 with TypeScript) where A1 falls back | the components route; nothing else measured has live definitions in its second pass |
| a first pass that is finished: no second pass (`prerender` off, nothing decided), `quietFinish` false (a signed-in guard, `data-sn-pages`, URL bindings, page models), a walk that takes the unit's names in another order under check | compiled again without units (counted, `a first pass that is finished`) | links | 0 pages of sinter-mail, the blog and the examples; most of the suite's pages (no `prerender`) |
| a unit that is refused (an action, a fill id, a lazy import, a node id, a diagnostic, its page's file in its text, an object of its page in one of its own) | compiled in place, then compiled again | links what it can (refuses the same kinds) | none in the apps |
| definitions not among the page's own recursion points and candidates (reached first from a fill's case after the walk, `finishTreeFills`) | compiled in place on each page | links | not counted yet |
| `describeOnly` (the per-page description compiles, `describedDefinitions` past `LINK_DESCRIPTIONS`) | no (`describesNothing` leaves most out) | links | |
| `<html data-sn-for>` templates (`keepTemplate`) | no | no (walked once per template already) | |
| dev, `sinter check`, the editor | no | no | |

So deleting the linker today would cost the components route its second-pass replay (it would compile the library
there on every page again, about 225 ms CPU a page here) and every finished first pass its links. Plan step 6
(second-pass units) is the precondition; the finished first passes cost only what they cost before the linker.

**After stage 5's A1** (`stage5-a1.md`): the second pass's definitions come from units, so what deleting the linker
would cost there is only A1's fallbacks, compiled in place instead of linked (none occurs in sinter-mail's 16 pages,
the benchmark apps or the examples). What still goes through it: a first pass that is finished (A2's case; see
`stage5-a1.md` for how often it occurs now), a refused unit's page, definitions reached first from a fill's case after
the walk, `describeOnly` compiles past `LINK_DESCRIPTIONS`. The recorder (`runUnit`, `Rec`, `readsHold`) makes both
kinds of units and stays; the plan and its replay (`keep`, `Plan`, `replay`, `recordChild`) are what the deletion
removes.

### What deleting it removes, and what it must keep

Units are made with the linker's recorder: `runUnit`, `Rec`, the logged wrappers, `readsHold`, `applyOps`,
`LINK_FIELDS`/`UNIT_NUMBERING` and `unitChild` stay (or are replaced by a unit compiler with fresh tables, plan step
2, whose equivalence the recorder's reads measure today). What goes:

- `src/compiler/link.ts`: the plan (`keep`, `Plan`, `R`/`X`/`Line`/`FILE`, `replay`, `PageMaps`, `recordChild`), about
  330 of its 881 lines; the rest moves to `units.ts` as the recorder.
- `src/compiler/compile.ts`: `definition()`'s cache path and `defLink` (about 40 lines, 5063 to 5104), the
  `definitions` option.
- `src/vite.ts`: `definitions`, `describedDefinitions`, `LINK_DESCRIPTIONS`, `SN_NO_LINK` (13 lines that name them).
- `src/compiler/index.ts`: `auditedLink`, `audited` (about 60 lines).
- Tests: `link.test.ts`, `link-review.test.ts`, `-2` to `-5` (703 lines); `link-fields.test.ts` (45) stays while the
  recorder classifies fields.
- CI: the `link-audit` job (`.github/workflows/ci.yml`, lines 55 to 90).

### The audit once `SN_LINK_AUDIT` is gone

`SN_UNITS_AUDIT=1` (`src/compiler/index.ts`, `auditedUnits`): every compile again without units, where it makes a
unit, where it places one, and placed under another name and in another folder, every field compared; it runs under
check too (the type check's unit is a field). `SN_UNITS_VERIFY=1` beside it: every unit object's own values after every
page (what a page changes and does not give back). It replaces the link audit's job in CI one for one; the link audit's
rounds through one cache are what it does with units. What it does not do yet that the link audit did: compile pages
of other shapes into one cache (the link-review scenarios); `test/compiler/units.test.ts` does that for eight shapes in
both orders, plain and under check, and the link-review scenarios should be ported to it before they are deleted.

### Plan steps left, as the coordinator ordered them

2. **Second-pass units.** Where the names ship, a unit placed by sharing would have to survive `finishPage`, which
   rewrites what a definition made (`anchors`, `shareTemplates`, `compactTables`, `groupStyles`, `checkUrlArrays`):
   sharing there means copying, i.e. the linker's replay. What a second-pass unit can drop is the linker's key by the
   page's whole numbering: on sinter-mail's 16 pages its pass-2 units have the same template count before them (4)
   and differ in the function count, state and use ids only, which reach the output through the function table alone
   (measurement 3). So: a pass-2 unit keyed by the template count, its function indices renumbered at placement by
   replaying its hand-outs through the page's `fn()` (a typed renumbering of `Binding`/`TemplateDef`/`NodeDef` fields,
   checked at creation with two bases). Gain: the 2nd page's recording and the extra recordings of differently
   numbered pages, not the replay itself. Not started.
3. **Check data once.** A unit's check part is copied into each page now (`unitCheck`: numbers offset, locations
   renamed). To reference it instead, the check unit needs a form that holds a unit's part by reference with its
   offsets (`{ unit, frameBase, exprBase, file }`) and `check()` (src/check/index.ts) has to lay a page's shadow out of
   the parts it links: its `checkShared` already writes each repeated function once, so a unit's part can be one
   shared block whose functions are numbered by the unit, not by the page. That changes `CheckUnit` and the shadow
   writer: the type-check agent's code. Not started.

## After stage 3 (merged at 0203435)

- **`copyState` and units compose**: a kept template's walk passes `units: undefined`, so no unit object reaches a
  copied compiler. Checked: `test/compiler/template-pass.test.ts`, `one-pass.test.ts` and `units.test.ts` pass plain,
  and under `SN_UNITS_AUDIT` no page differs (the 15 failures there are the tests' compile counts, which the audit
  triples).

### Where a check build's time goes now (sinter-mail, 12 pages, `--cpu-prof`, load 15 to 20)

| | API route | components route |
| --- | ---: | ---: |
| `check()` | 1,579 ms | 2,216 ms |
| of it `checkShared` (all pages' shadows in memory, functions keyed by text, the pages and shared modules written) | 1,575 | 2,214 |
| of that `shadowOf` (each page's whole shadow) | 466 (39 a page) | 836 (70 a page) |
| of that one `tsc` | 677 | 632 |
| so the rest of `checkShared` (the text keys and the layout) | about 430 (36 a page) | about 750 (62 a page) |
| `unitCheck` (each page's copy of the unit's check part, renumbered; 177 ms of it the copy with the file renamed) | 186 (15 a page) | 214 (18 a page) |
| the second pass's `replay` (the linker; it links under check now too) | | 783 (71 a page) |

So the check of a page with a unit costs about 90 ms a page on top of `tsc` (15 for the copy, 39 for its shadow, 36
for keying the shadow's functions by text), nearly all of it the unit's part, which is the same text on every page
but for its numbers.

### Step 3 (a unit's check data once): the design, not built yet

What makes every page's part different is only its numbers: the frames' and expressions' indices (`$e<i>`, the
frames a function opens) and the page's file in the locations. So:

1. **The check unit holds a unit's part by reference.** `CheckUnit` gets `parts: Array<{ part: CheckPart; at: number;
   frameBase: number; exprBase: number }>` (`at`: where the walk took it, between the page's own expressions), and
   the part's frames and expressions stay in the unit, numbered from 0. `unitCheck` records the reference instead of
   copying. Every reader of `frames`/`exprs` by index (`typeDiagnostic`, the regions, the LSP's `checkPage`, the
   compiler's own `checkExprs[i]` writes after a part, `frameOf` of a unit's scope) reads through one accessor that
   resolves a page index to (part, local index). Byte-identity oracle: `flatten(unit)` (the copy `unitCheck` makes
   today) equals what the compiler gives without units, under `SN_UNITS_AUDIT`.
2. **The part's shadow once per build.** A part's functions are written by `shadow()` once, with its own names
   (`$u<k>_<i>`) and its frames' functions calling one another by those names; `checkShared` takes them as one
   shared block per folder (they repeat by construction) instead of finding them by text on every page. A page's
   shadow is then its declarations, its own functions, and calls into the part where its expressions open a part's
   frame. The page's errors in a part's function are laid out where its whole shadow would have had them, exactly as
   `checkShared` does for a shared function now (its `byId` → each page's position): the layout code is reused.
3. **Where it can differ**: a part function that names something the page's declarations type for that page
   (`pageNamed`: its resources, `$meta`, …) cannot be shared; such a part is written on each page as now (the
   fallback). A definition reading a page's resource by name is already a unit read of the page (a precondition).

Order: the accessor and the reference first (byte-identical, `SN_UNITS_AUDIT` and the diagnostics corpus: removes
the 15 ms copy), then the part's shadow once (removes most of the 75 ms), each with `SN_CHECK_SHARE=0` still
checking every page whole for comparison. The corpus reference is to be regenerated from the integration branch when
this starts (a bug-fix agent is changing some check diagnostics on purpose).

### Step 2 (second-pass units): the answer is stage 5

Measured on the components route (CPU, under check and without): the second pass replays the library's plan at 25
to 30 ms a page without TypeScript and 71 ms a page with it (the plan carries the check unit's lists since f910e52),
against about 225 ms to compile it. What a placement by sharing would have to survive is `finishPage` on the
definitions it ships:

- `anchors()` turns the head templates' `<template>`s into comments and recomputes every row node's `path`;
- `shareTemplates()` merges subtrees across definitions and renames their props to `$pp` in code;
- `compactTables()` drops the templates nothing on the page reaches, renumbers the rest and their `$i<n>`, and
  renumbers and dedupes the functions in the page's order;
- `groupStyles()`, `checkUrlArrays()` and `placeTemplates()` rewrite code and move the head templates into the page.

The first two are the same on every page for one unit (they read only the definitions), so they could run once when
the unit is made: a copy-on-write boundary exists there. The last two are the page's assembly: which of the unit's
templates are live, and every function's final index, depend on the page. Placing a shared unit there means doing
that assembly over the unit's objects without changing them, i.e. stage 5's assembly (numbers handed out at the end,
over what the page ships). Keying a second-pass unit by the template count would remove the recordings (one per
differently numbered page), not the per-page replay, so it is not built.
