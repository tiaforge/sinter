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
