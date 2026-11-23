# A page of its own: fewer walks per build

Running log (2026-11-23). Goal ([compile-units.md](../compile-units.md), "What is next", item 2; stage 3's leftovers in
[stage3-one-pass.md](stage3-one-pass.md)): a page that is a file of its own (every page of the examples, of
sinter-mail's apps, the benchmark's `static-files`/`live-files`) is walked three times per build: its description
(`describeOnly`, `src/vite.ts`), its first pass, its second pass. (1) the description without a walk of its own; (2) the
second pass from the first pass's expansion, as a template's entries do; (3) anything else paid twice.

## Where it stands

- **Goal 1 is in** (`SN_LATE_DESCRIBE=0` off, `SN_DESCRIBE_AUDIT=1` the audit): a build's page of its own is described
  off its head (`pageHead`: the document parsed, the layout merged, no walk), and what it can have requested ahead is
  read off its build compile's first pass; the page modules' prefetch import is decided once every page has compiled.
  Source pages built per language (`localePrefix`) have their paths read the same way (`describeSource`, a whole
  compile before). Every file the same over the nine apps of `pass-audit`, the seven of `baseline.mjs` and
  sinter-mail's 48. About 2.4 ms a page of the description's 2.5 to 3 ms.
- **Goal 2 was built and is not taken**: a page of its own's second pass from a copy of its first pass's expansion,
  the copy made cheap by side tables that list their keys. It saves the second pass's expansion (0.6 to 0.9 ms on a
  benchmark post, 2 to 2.8 ms on a sinter-mail API page) and pays the copy (0.45 to 0.55, 1.3) and the listing in the
  first pass (0.15 to 0.2): nothing on the benchmark, about 1 ms on sinter-mail's heavier pages. Not worth a new class
  of risk, and stage 5's derivation of the second pass from the first's walk would remove it. Measured below.
- **It found a bug in stage 3's template route** (merged): `copyState` copied the options' objects, so a component
  file's `lib` in the kept expansion was a copy of the options' library, which the compiler compares by identity; a
  template page using a component library compiled every entry after the first differently (sinter-mail's fills page
  as a page per entry: 4 more functions, other ids). Fixed (`optionsReach`: what the options reach is shared, as both
  passes of the old route share it), and `scripts/mail-audit.mjs` now builds that page per entry, so `--switch
  SN_ONE_PASS` catches it (it reports the difference at the base commit, none now).
- Next: goal 3 (below, "Left").

## The design, as built

### Goal 1: the description without its own walk

What the build's pages read of each other, and when (`src/vite.ts`):

| field | read by | when |
| --- | --- | --- |
| `path` | `urls` (its own `$canonical`), axis URLs, the Speculation Rules (`appPages`), links (`relocateHtml`, in `generateBundle`), routes | before or as a page compiles |
| `off` (`data-sn-prefetch="off"`), `swapOff` | the Speculation Rules | as a page compiles (the rules are in its HTML) |
| `parts` (what can be requested ahead) | the page module's prefetch import (`prefetchPages(group).length`), the prefetch module | the import: as each page compiles; the module: in `load` |
| `effect` | the rules under `prerender: 'auto'` only | as a page compiles |
| `keep`, `keptSource`, `keptBound` | swaps: SN346 after each compile, the swap module | as a page compiles |

So: (a) `path`, `off` and `swapOff` come from the page's head without a walk (`pageHead` in `src/compiler/compile.ts`:
the document parsed (cached), the layout merged, the entry's path written, then the same `pathPatterns` the walk calls
and the two attributes on `<html>`). (b) `parts` are read only through the prefetch import and the prefetch module:
both now wait for every page (`latePages`, `lateWait`: the pages compiled *or failed*, so a failing page fails the
build at once instead of holding the others for `everyPage`'s 30 s). A page is compiled with the import guessed from
the pages compiled so far (`prefetchLater`), and its module is written again in `load` when every page decides
otherwise (`moduleWith`: the compiler keeps what it needs to write the page module, and its source map, with another
`prefetch`; nothing else of a page depends on it). (c) `effect` and what a swap keeps are read as pages compile: under
`prerender: 'auto'` and `swap` the description is compiled as before (counted fallbacks).

Where `parts` come from is the part that needed the audit. The first version took them from the build compile's result,
and `SN_DESCRIBE_AUDIT=1` found three ways that differs from the description:

1. **`loadEffect`** on every benchmark post: the description (no prerender) sees a component with a script that the
   build decides away. Only `prerender: 'auto'` reads it, which stays on the old route.
2. **`embed: true`**: the build compile embeds the resources that only the URL decides (`def.data`), the description
   does not, so the build's `parts` lose them. `embed` stays on the old route.
3. **A resource in a branch the build decides** (`<template data-sn-if="cfg.on"><sn-resource src="/api/d/{$url.id}">`
   over a `file:` constant, or a component holding one): the second pass compiles the decided branch as page markup,
   so its resource is the page's and is requested ahead; the description compiles the branch as a template, whose
   resources are not (since the merge of the bug fixes, a `<sn-resource>` in a `<template>`, directly or through a
   component, is SN102, so a valid page no longer shows this; the reading below stays, being what a description reads
   by construction). So the build compile's result is not the description, and the route reads `parts` off the build's
   **first pass** instead, right after its walk (`firstPrefetch`, `CompiledParts.firstPrefetch`, `describedPrefetch`):
   the first pass compiles a branch as a template as the description does, and `prefetchParts()` reads only what the
   walk made (resources, functions, `pathList`, `$url` lists). The one thing it reads from `finishPage` is the
   signed-in guard: a page with `data-sn-signed-in` has its description compiled after its compile (counted,
   `LATE_STATS.late`). The description leaves out definitions that describe nothing (`describesNothing`), which by
   construction add nothing to `parts`.

The audit compiles each page's description the old way at the moment the old route did (before the first page
compiles: a first version described them later and compared against a description that had not run yet) and throws
on the first field the route reads differently; it also counts what the build compile's own fields would have
changed (`sinter describe audit: {...}` at exit).

### Goal 2: the second pass from the first pass's expansion (built, measured, not taken)

What was built: `compileTwice` copied the first pass after `expandPage` (`keptExpansion`, stage 3's copy) before its
walk went on, and the second pass took that copy as it was (used once) with the second pass's options, then went on
with `walkExpanded` and `finishPage` (`SN_OWN_PASS=0` off, audited by `SN_ONE_PASS_AUDIT=1`, which compiled the page
again with both passes afresh: a second pass changes the rendered blocks it splices). Every file was the same over
the nine apps and sinter-mail's 42, under the audit too, once the bug below was fixed.

The copy's cost, which stopped stage 3 here, is now understood: a benchmark post's copy is 646 objects (72 of them
positions) and 129 side-table entries; what cost was looking each object up in each of the 51 weak tables (43 of the
compiler's, 7 of the module's marks of nodes, `INERT_FILLS`). Two changes: the module's marks are looked up for nodes
only (they are keyed by parse5 nodes), which stays (`copyState`, also cheaper for a template's first copy); and a
compiler that would be copied got tables that listed their keys while its expansion ran (a `WeakMap` subclass whose
`set` pushes a new key), so the copy copied their listed entries whose keys it had copied. The copy went from about
0.7 to 1.0 ms (stage 3) to 0.45 to 0.55 ms; the listing cost its expansion about 0.15 to 0.2 ms (every `set` a call
into a subclass method). Per page, wall clock, quiet machine, three rounds:

| | second pass's expansion saved | the copy | listing, in the first pass |
| --- | ---: | ---: | ---: |
| benchmark post (`static-files`) | 0.58 to 0.88 | 0.45 to 0.56 | 0.15 to 0.20 |
| sinter-mail API page (fills) | 2.0 to 2.8 | 1.26 to 1.38 | (in the noise of a 23 ms expansion) |

So nothing on the benchmark and about 1 ms of a sinter-mail page's 40 to 60 ms: not taken. What would make it pay is
an expansion that is not copied at all (the second pass's expansion is the first's: stage 5's "the second pass derived
from the first's walk" removes the question).

The bug the route found, in `copyState` and so in stage 3's template route too: it deep-copied every object the state
reaches but the options object itself, so what the options *hold* and the state refers to became copies: a component
file's `lib` (`CompileLibrary`, from `opts.libraries`). The compiler compares libraries by identity (`internalUse`'s
`libOfFile(file) === def.lib`, a tree placement's `packageOf(u) === pkg`, `closeComponentName`). With the copy, a
component file read before the copy carried the copied library and one read after it the options' own: sinter-mail's
pages of their own failed to build (65 SN339 errors: every use of `<mail-node>` inside an internal component, in a
shared definition expanded in the walk, looked foreign), and its fills page as a `data-sn-for` template compiled every
entry after the first with 4 more functions (a tree placement resolved otherwise), silently. Sharing only the libraries
fixes both; the fix shares everything the options reach to three levels (not the build's caches, whose entries a
compile copies anyway), since both passes of the old route are handed the same objects (`optionsReach`). A unit test
of the divergence was not found in the time given (a recursive internal component, a choice, a tree placement with a
fill, each alone, compile the same both ways at the base commit); the gate is `mail-audit.mjs`'s page per entry.

## Measurements

The machine: 4 cores, Node 22.23.5, no other agent on it (load average under 0.2 idle; a build itself raises it to
about 4). Base: the integration branch at `2a88005`; new: this branch merged with it (`81c9b3a`). Both `dist/`s
saved and copied in turn round after round (`bench/astro/out/ab.sh`, git-ignored with the other scripts there:
`phase-time.sh` wraps `Compiler.prototype`'s phases with a timer in a copy of `dist/`, `incl.mjs`/`leaves.mjs` read CPU
profiles).

Per benchmark post (`static-files-100`), wall clock, ms, 3 rounds:

| phase | base | new |
| --- | ---: | ---: |
| description: expansion, walk, finish | 1.10-1.16, 1.32-1.51, 0.34-0.42 | - |
| description: the head read (`readHead`) | - | 0.22-0.26 |
| first pass's expansion | 0.64-0.67 | 0.88-0.93 (it warms the caches the description warmed) |
| second pass's expansion | 0.63-0.75 | 0.68-0.73 |

So about 2.5 ms a page.

Whole builds, wall clock, ms, median of 5 rounds (3 at 400):

| app | base | new |
| --- | ---: | ---: |
| static-files, 100 | 2847 | 2736 |
| live-files, 100 | 3389 | 3206 |
| static-files, 400 | 9154 | 8721 |
| live-files, 400 | 12473 | 11134 |
| static, 100 (a template: unchanged) | 2095 | 2211 |
| live, 100 | 2676 | 2599 |
| static with the type check, 100 | 2325 | 2295 |
| examples/static-site | 577 | 560 |
| examples/multilingual-site | 596 | 580 |
| examples/dashboard (swaps: old route) | 1225 | 1130 |
| examples/realworld (swaps: old route) | 1578 | 1555 |
| sinter-mail, 16 pages and 3 entries (`mail-audit`'s build, 3 runs) | 5836-5984 | 4790-5080 |
| Astro 7, 100 posts (`measure.mjs --only astro`) | 1726 | |

Rows on the old route (templates, swaps) move by their noise (about ±8 %). sinter-mail gains most: its descriptions
walked the library's 65 components on every page.

### The five blog variants at 100 posts, on the merged tree (`6a3283d`, integration branch at `68aae20`)

Same machine, idle, median of 5 rounds back to back, wall clock (`ab.sh`):

| app | ms | rounds |
| --- | ---: | --- |
| static | 2000 | 1994 2036 2080 1989 2000 |
| static with the type check | 2135 | 2102 2140 2133 2224 2135 |
| live | 2385 | 2406 2564 2371 2385 2336 |
| static-files (a page file per post) | 2401 | 2344 2470 2433 2401 2397 |
| live-files | 2957 | 2759 3038 2797 2970 2957 |
| Astro 7, 100 posts (`measure.mjs --only astro`, 3 runs) | 1726 | 1755 1726 1716 |

On `6a3283d`: the suite passes (2,934); test/compiler and test/vite pass under the describe, one-pass, render and link
audits (1,413); the units audit fails the base commit's 62 tests and the two count-based render-rows tests.

## Checks

- `scripts/pass-audit.mjs --switch SN_LATE_DESCRIBE` (a switch it now takes): the nine apps the same, before and after
  the merge; `scripts/baseline.mjs --keep` with all routes off and on: the seven apps the same; `scripts/mail-audit.mjs
  --switch` `SN_LATE_DESCRIBE`, `SN_ONE_PASS`, `SN_UNITS`, `SN_RENDER`: 48 files identical (42 before the page per entry
  was added). The same builds under `SN_DESCRIBE_AUDIT=1` (and `SN_ONE_PASS_AUDIT=1`) pass.
- `npx vitest run`: 2,869 before the merge, all pass; after it 2,930, all pass but the test removed in `81c9b3a`.
- test/compiler and test/vite under `SN_DESCRIBE_AUDIT`, `SN_ONE_PASS_AUDIT`, `SN_RENDER_AUDIT`, `SN_LINK_AUDIT`: pass;
  under `SN_UNITS_AUDIT` the base commit's 62 failures (tests that count compiles, links and rendered rows, and
  content.test.ts's kept template check) and, after the merge, two new count-based render-rows tests.
- Tests: `test/vite/late-describe.test.ts` (both ways equal, the route and each fallback counted, under the audit,
  `pageHead` against a `describeOnly` compile).

## Tried and dropped

- Taking `parts` from the build compile's result (see above: three differences).
- Describing every page at the old moment only under the audit: kept (it is what the audit compares with).

## Left

- Swaps (`swap: true`) still describe each page by a compile: SN346 reads every page's kept elements as each page
  compiles, and the swap module. Both could wait for every page (an error after the last compile instead of at the
  page's), with `keep`, `keptSource`, `keptBound`, `swapOff` read off the first pass as `parts` are (to audit).
- `prerender: 'auto'` reads each page's load effect in its HTML (the rules): the description's differs from the build
  compile's on every benchmark post (a component script decided away), so it would need its own first-pass reading and
  the rules as a placeholder filled in `generateBundle` (the CSP hash too).
- `embed: true`: the build compile embeds what only the URL decides; the first pass may too (`def.data`): to audit.
- Goal 2 is moot once stage 5 derives the second pass from the first's walk; until then not worth its cost.
