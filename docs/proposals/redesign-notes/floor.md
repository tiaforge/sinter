# The per-page floor: what a page costs the compiler after stage 1

Running log (2026-11-23). Goal: bring what a benchmark page costs the compiler (24 ms a template page, ~50 ms a page
file per post, after [stage 1](stage1-render.md)) towards the ~4 ms that would put 100 posts level with Astro
([compile-units.md](../compile-units.md), "What a build costs"), with byte-identical output, and say what the smallest
route to one walk per page is. Out of scope here: `rowRenderer`'s fallback rules and how the later phases treat a
rendered block (stage 2, the coverage agent), the build pipeline in `src/vite.ts`.

## How it is measured

- The preload and load hook of [profile.md](profile.md) (`instr.mjs`, `hooks.mjs`), pointed at this worktree's
  `dist/`: `time` mode for inclusive ms per phase (wall time, the GC inside included), `count` mode for exact call
  counts, `--cpu-prof` for what is inside a phase. Scripts in
  `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/floor-agent/` (`drive.sh`,
  `ab.sh`, `med.mjs`, `tree.mjs`, `q.mjs`, `ident.mjs`).
- The machine has 4 cores and other agents build on it (load average 4 to 9 throughout), so absolute times move by
  ±30 % from one run to the next. Every comparison is A/B: `ab.sh` copies each saved `dist/` in turn into the worktree
  and builds, round after round, and the tables give the median of the rounds. Compare columns, not tables.
- Byte identity: `ident.mjs build <label>` builds the five benchmark apps (static, live, static-files, live-files,
  static with the type check; 100 posts) and the four examples with whatever `dist/` holds; `ident.mjs diff` compares
  two labels file by file. The base is `130705b`'s `dist/`, kept aside. Plus `scripts/render-audit.mjs` (rendering
  off against on, with each commit's `dist/`).

## Where a page's compile went at the start (`130705b`)

`time` mode, one run each, ms a page (n = 100; template variants: 100 entries of one template):

| phase | static | live | static-files | live-files | static, type check |
| --- | ---: | ---: | ---: | ---: | ---: |
| `compile()`, build | 25.3 | 33.5 | 45.8 | 45.0 | 38.4 |
| pass 1 `decideFor` (template entries) | 16.1 | 19.0 | – | – | 23.0 |
| pass 1 `walkPage` | – | – | 12.5 | 12.6 | – |
| of it `definition` (the library, per page) | – | – | 5.7 | 5.7 | – |
| pass 1 `finishPage` | – | – | 24.4 | 22.4 | – |
| of it `prerender` | – | – | 18.1 | 16.4 | – |
| pass 2 `walkPage` | 7.0 | 9.9 | 7.7 | 8.2 | 12.0 |
| of it `expandComponents` | 2.5 | 3.2 | 2.5 | 2.2 | 4.0 |
| of it `minify` | 2.3 | 3.0 | 3.1 | 3.1 | 4.1 |
| pass 2 `finishPage` | 0.8 | 2.3 | 0.9 | 1.3 | 1.1 |
| `compile()`, describe | (4 for the build) | | 8.0 | 9.1 | |
| GC inside the compiles | 3.7 | 5.2 | 7.5 | 8.3 | 8.0 |

The CPU profile of the static build splits `decideFor` (16.6 ms a page) as: copying and freezing row items 7.4
(`deepFreeze` 4.2, `structuredClone` 3.1), `plainData` 0.8, the page's `md.parse` 1.8 (with its result's copy and
freeze, 2.6), rendering the rows 1.7, the rest of the worklist 3.4. `new Function` over the page's code is once per
entry and costs little (`prerender`'s own time, 0.6 ms). Pass 2's `walkPage` (8.5 ms in that profile):
`expandComponents` 3.2 (`componentFile` 2.4, of it `kindOfComponent` 1.6; `choicePool` 1.9), `minify` 2.2 (the
layout's `everyView`), the walk 1.2. `componentFile` is called 503 times a page in pass 2 now (13,400 before stage 1).

## Changes

### 1. Row items frozen once (`frozenData`)

`rowsOf` gave each row `deepFreeze({ v: structuredClone(item) }).v`, and a placement's data the same. A row's item is
a part of the item above it (a document's node in its parent's `children`), frozen already, so every level copied and
froze its whole subtree again: O(depth × size), and the garbage of it. `frozenData` shares what is frozen at every
depth already (`DEEP_FROZEN`: a `file:` value, a state's initial value, a helper's result, the row above's item) and
copies only the new objects around it (a case's props `{ node }`), frozen once.

What a copy guaranteed and still holds:
- Nothing a row evaluates can change an item, at any depth: everything it reaches is frozen (a write throws, the
  binding is `FAIL`, as before).
- A helper's result is still copied (`fresh`, `helperCalls`' `isResult`): a helper call takes a result it handed out
  by reference (`refOf`, for the build's cross-check) and anything else by value, so sharing one into a row would
  change which form a call is logged in. So is any part that `map`/`fromEntries` would not copy as `structuredClone`
  does (an array with holes or keys besides its indexes, an object reached twice): those take the old path.
- What the worklist accepts is unchanged: `listOf`/`plainData` are asked the same questions of the same values.
- Not kept: identity between a row's item and the data it came from (`y === x.children[0]` is now true at build
  time, as it is in the browser; it was false). Pass 2 compiles a row's item as a literal, so with rendering off
  such a comparison is false again: a page whose row compares objects by identity would differ between rendering on
  and off. No app or test does; the render audit would show it.

Tried here and dropped: a memo of `plainData` for frozen data in a module `WeakMap`. Under the load of the time the
profile could not tell it from noise (0.8 ms before, 1.1 ms after); taken later in another form (change 4).

Static, `time` mode, median of 3 rounds A/B (ms a page): `decideFor` 19.0 → 12.5, GC in compiles 5.5 → 4.2,
`compile()` 32.4 → 23.9; the build (instrumented) 6.0 → 5.0 s.

### 2. Component files read and kinded once per build (`componentCache`)

Every `Compiler` looked each component up afresh (`componentFile`): the file and the five files that may sit beside it
(four script extensions, `.css`, `.early.*`; read through the build's `buildReads`, but a missing file is an error
thrown again each time), its kind (`kindOfComponent`, a parse5 parse of the whole file), its inline scripts (another
parse). A library's `<sn-component use>` pool (`choicePool`) looks up every component of the library, so each page's
pass 2 did this for all 26 of sinter-markdown's components.

A build now keeps what `componentFile` found, by tag, folder, root and the libraries (`componentCache`, a `Map`
`src/vite.ts` passes to the build's compiles beside `globCache` and clears with the build's reads at `buildStart`:
dev and the editor pass none, so they read afresh as before; under `--watch` each build starts empty,
test/vite/build-caches.test.ts). Each compile takes a shallow copy of its own, without the library object (its own
compile's): what a compile marks on a component as it expands it (`bad`, `css`, `rawCss`, `dataSlots`, and its
diagnostics, SN312 and SN320 among them) is still marked and reported per compile. Kinding a component looks up the
components its markup names, which fills `componentFiles` (the order `choicePool` and SN547's suggestions see): a hit
looks those up first, in the order kinding did. A component on a cycle of tags is not kept (its kind depends on where
the walk entered the cycle; `kindCycle`). New `Compiler` fields `kindCycle` and `librariesKeyText` are `cache` in
`LINK_FIELDS`, and the option is a `BUILD_OPTIONS` entry. test/compiler/component-cache.test.ts: compiles sharing a
cache in several orders give what each gives alone; a later compile reads no component file but those on a cycle; a
compile's marks are its own.

Pass 2's `componentFile` calls are 503 a page; with a warm cache none reads a file. Static, `time` mode, median of 3
rounds A/B (base, change 1, change 2), ms a page: pass 2 `expandComponents` 2.6 / 2.3 / 0.7, pass 2 `walkPage`
7.5 / 6.4 / 4.9, `compile()` 26.6 / 18.0 / 16.2, GC in compiles 3.7 / 2.2 / 2.0. A page file per post (3 rounds, a
loaded machine): pass 1 `expandComponents` 4.0 → 2.1, pass 2 3.8 → 1.4, `compile()` describe 10.5 → 8.8.

### 3. The first of two passes stops at its decisions (`settle`, `quietFinish`)

`compilePasses` ran the first pass's whole `finishPage` (anchors, `shareTemplates`, the early parts, the tables and
their compaction, the serialized markup, the descriptions) and then, when it had decided anything, threw all of it
away: the second pass reads the first's maps (`decided`, `unrolls`, `constants`, `overLimit`, `rendered`, the folded
state), and of its result only the diagnostics, to know whether it is `clean`. `finishPage`'s first line is now
`settle()` (`buildOnlyInIfs`, `prerender`, the drops, `collectConstants`), and `compilePasses` runs it on its own; when
a second pass follows and nothing in the rest of `finishPage` can report an error, the first pass stops there.

Which errors the rest can report, from its call graph (a script over `compile.ts`): SN347 (`signedInGuard`), SN210 and
SN211 and the `$url` list messages of models and bindings (`checkUrlArrays`), SN345 (a page per entry reading its
pattern's parameters). The rest is warnings (SN519, SN542, SN543), late diagnostics (SN344) and SN322, which `clean`
does not count. `quietFinish()` is true when none of their sources is on the page (`signedIn`, `pagesDecl`, `urlBinds`,
`pageModels`, `page.urlWrites`); otherwise, and with the type check (whose unit the first pass hands on), the first pass
finishes as before. test/compiler/first-pass-stop.test.ts: a page with SN347 still keeps its loop as a template.

Pages that are walked twice gain: a page file per post. Template entries (`fromTemplate`) evaluate with `decideFor` and
never ran a first `finishPage`. Static files, `time` mode with the thread's CPU time as the clock (from here on: the
machine's load moves wall time too much), median of 2 rounds, base / change 2 / this, ms a page: pass 1's finish
21.5 / 13.1 / 9.7 (`settle` alone), `compile()` 37.9 / 25.4 / 22.9.

### 4. `plainData` measures frozen data once per evaluation

What `plainData` walked after change 1: the worklist asks it of each level's list items (`listOf`), of each case's
props (`{ node }`, the node's whole subtree) and of a placement's data, and each of those is a part of the level
above, so the walks were still O(depth × size) (1.3 ms a page in the CPU profile, the largest item of `decideFor`
left). With a `Map` the worklist keeps for one evaluation, `plainData` records the height of each object frozen at
every depth that it measured (`plainHeight`), and a later question about it, or about something new around it, stops
there. The bound is kept exactly: a part's height counts from where it is reached, and anything the recursive walk
cannot answer (past the bound, a cycle, a getter that throws) goes to the original walk. Elsewhere (state fields,
helper arguments and results) `plainData` is called as before. Tests in test/compiler/row-items.test.ts (the bound
through a measured part, the non-plain cases against the original).

Static, CPU clock, median of 3 rounds A/B: `decideFor` 7.7 → 7.2 ms a page.

## Where a page's compile is now (`4175871`)

`time` mode on the thread's CPU clock (what the main thread spent; the GC pauses on it included, the other
processes' load not), median of 3 rounds A/B against `130705b`, ms a page, base → now:

| phase | static | live | static-files | live-files | static, type check |
| --- | ---: | ---: | ---: | ---: | ---: |
| `compile()`, build | 24.1 → 15.6 | 28.2 → 17.3 | 39.3 → 25.1 | 40.6 → 28.0 | 22.6 → 13.6 |
| pass 1 `decideFor` | 14.7 → 8.2 | 15.3 → 7.8 | – | – | 13.5 → 6.8 |
| pass 1 `walkPage` | – | – | 9.9 → 8.7 | 11.2 → 10.8 | – |
| of it `definition` | – | – | 4.9 → 4.9 | 4.5 → 6.1 | – |
| pass 1 finish (`finishPage`, now `settle` alone) | – | – | 21.2 → 10.1 | 20.9 → 9.5 | – |
| of it `prerender` | – | – | 15.6 → 9.8 | 15.2 → 9.3 | – |
| pass 2 `walkPage` | 7.0 → 5.5 | 8.7 → 6.2 | 6.9 → 4.7 | 7.4 → 5.4 | 7.0 → 5.0 |
| of it `expandComponents` | 2.6 → 0.7 | 2.7 → 0.8 | 2.3 → 0.5 | 2.3 → 0.7 | 2.8 → 0.6 |
| of it `minify` | 2.5 → 2.4 | 2.5 → 2.3 | 2.5 → 2.0 | 2.7 → 2.1 | 2.2 → 2.2 |
| pass 2 `finishPage` | 0.7 → 0.6 | 2.1 → 1.4 | 0.8 → 0.9 | 1.3 → 1.7 | 0.9 → 0.8 |
| `compile()`, describe | (4 a build) | (4 a build) | 6.5 → 4.2 | 7.1 → 6.4 | (4 a build) |

(Rows that moved the wrong way by less than 1.5 ms, `definition` in live-files among them, are within what one round
differs from the next on this machine.)

### What is left, per page, and what it would take

A template page (static), ~15 ms of the compiler's CPU:

- `decideFor`, ~7–8 ms: the page's `md.parse` call ~3 ms of it (the parse 1.5, its result copied and frozen
  `deepFreeze(structuredClone(...))` ~0.9, `memo`'s own freeze 0.4, the second call and its `JSON.stringify`
  comparison, `resultKey` for the cross-check); rendering the rows (`rowRenderer`: cloning the template's content
  and filling it, ~2 ms; the coverage agent's); the worklist's walk over 420 instances (`nodesOf`, `rowsOf`,
  `caseOf`, the scope proxies, `plainData` ~0.7) ~2.5 ms. Per page by nature: the evaluation of a page's own data.
  Under 4 ms needs evaluation from compiled closures over units (stages 4 and 6) rather than `new Function` over
  the page's code with a proxy scope per row, and a helper result that is frozen already (the library's `memo`
  freezes its trees) not copied again: that is a contract between the helper module and the compiler (a mark the
  two module instances share), not done here.
- Pass 2 `walkPage`, ~5 ms: the minifier's layout queries over the rendered rows ~2.3 ms (the coverage agent's: a
  rendered block's text is known, its layout questions are not cached); parsing the page again 0.4; the walk of what
  the rows left (the page's own markup) ~1; `slotsPlaced`/`fileGraph` ~0.5 (per compile, order-dependent on
  `componentFiles`, so not cached per build).
- Pass 2 `finishPage` ~0.7, GC ~2–3.

A page file per post (static), ~25 ms plus ~4 ms of description:

- Pass 1 `walkPage` ~8.7: the library's 65 definitions compiled per page, partly linked (`definition` ~5, `replay`
  ~3.5 of it). Stage 4 (units per build) removes it.
- `settle` ~10: the same evaluation as `decideFor`, plus the drops.
- Pass 2 ~5.5, as a template page's.
- The description, ~4 ms (a third walk, `describeOnly`), which vite needs before the page compiles.

## The smallest route to one walk per page

- **Template pages are walked once already** (the kept template's walk, once for all entries, then one evaluation
  and one pass-2 walk per entry). What pass 2 still does for a fully rendered entry is the page's own markup:
  parse, layout merge, its few components, the splice, the minifier, the walk of what is left, the finish. The
  smallest step is to start each entry's pass 2 from a copy of the kept walk's tree instead of from the source: the
  decided branches outside rows (md-doc's `$build` chooses `<md-tree>` over `<md-view>`) are what makes the walk
  differ from the kept one, and what renumbers what follows them. That is stage 3's "decisions applied to the first
  pass's result, numbers handed out at assembly" for the page's top level only; rows are already rendered.
- **A page file per post is walked three times.** Pass 1 now stops at its decisions (change 3), so its two walks
  are the real cost: (1) the description's walk could be pass 1's own if vite kept the described `Compiler` and the
  page compile went on from it (today `describeOnly` skips what describes nothing, so the walks differ; the
  description would have to be read off a full pass 1 walk, at ~8.7 ms instead of ~4, which pays off as soon as the
  page compile reuses it); (2) the kept-template route cannot serve files that differ in a resource's `src` and a
  literal (`post-3.md`, `'post-3'`) without treating such pages as entries of one template, which is a new rule,
  not a cache: not done. Stage 4 (definitions per build) takes ~5 ms of the pass-1 walk whatever the route.

### Whole builds

`node bench/astro/run-sinter.mjs`, wall time, 4 rounds back to back (base `130705b`, now with rendering on, now with
`SN_RENDER=0`, which compiles every row in the second pass as before stage 1), median, seconds; the load average was
3 to 13 during the rounds:

| app | base | now | now, `SN_RENDER=0` |
| --- | ---: | ---: | ---: |
| static, 100 | 4.08 | 2.99 | 11.60 |
| static with the type check, 100 | 4.70 | 3.42 | 12.65 |
| live, 100 | 4.32 | 3.85 | 12.25 |
| static-files, 100 | 6.28 | 4.39 | 14.44 |
| live-files, 100 | 8.70 | 7.53 | 16.85 |
| static, 400 | 13.90 | 9.06 | 45.32 |

Astro: 2.2 s for 100 posts. The static build is ~1.1 s fixed plus ~6 ms a page outside the compiler plus ~15 ms of
compile (CPU) a page; the gap to Astro at 100 posts is now ~0.8 s, about 8 ms a page.
