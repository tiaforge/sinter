# Spike: less compiling, not more threads

Status: (1), (2) and (3) landed (2026-11-16) with tests (`test/compiler/template-pass.test.ts`, the next-page test in
`test/vite/pages.test.ts`). (4), a single pass, was spiked: not as designed. (5), shared definitions linked into each
page, was spiked as a generic record and replay: byte-identical, 31% off a non-template page's compile, 19% off that
build; to production as a refactor, with the spike as its oracle. The expression parse cache's key, found on the way, landed. The rarer re-runs are open. Builds on
[parallel-page-compile.md](parallel-page-compile.md), which removed the all-pairs loops inside one compile. This one asks
which compiles a build runs at all, and which of them repeat work that does not change. No threads.

As landed, the 100-post blog builds in 2.4 s instead of 4.7 s, and the 1,000-post one in 14.1 s instead of 37.9 s.

## Measured

`bench/collections`, 4 cores, Node 22. Each build in its own process, `main`'s `dist` and this branch's swapped in turn:

| | main | as landed |
| --- | ---: | ---: |
| 100 static posts | 4.7 s | 2.4 s |
| 100 posts with a live resource (a module per page) | 6.6 s | 4.2 s |
| 1,000 static posts | 37.9 s | 14.1 s |

The output is byte for byte `main`'s: every file of each build above, and of every example app (`examples/*`) built
with each `dist`. Per entry, replayed in-process: 30.2 ms on `main`, 25.1 ms with (2) alone, 8.5 ms with (1) and (2)
in the prototype; a build now runs one `describeOnly` compile per template instead of one per entry. The live build's
rest is Rolldown bundling 101 modules. Peak memory goes down too (100 static posts: 460 → 360 MB).

## Which compiles a build runs

For a `data-sn-pages` template with N entries (`main`, 100 static posts):

| Compile | Count | Each | What for |
| --- | ---: | ---: | --- |
| the template, as a template | 2 | 26 ms | its entries (`templatePages`) |
| `describeOnly`, per entry | N | 1.8 ms | the entry's path and what is requested ahead (`describe`) |
| pass 1, per entry | N | ~22 ms | the program, then evaluated to decide what is constant |
| pass 2, per entry | N | ~9 ms | the page written with those decisions |
| again with `canonicalLink: false` | static pages with a pattern path | both passes | the canonical link |
| again after `images.analyze` | pages with new images | both passes | the images' sizes |

Of pass 1's 22 ms, the walk takes 16, and 13 of that compiles the markdown library's recursive components into run-time
"shared definitions" (`definition`, `runtimePlacement`) that the finished, static page never ships. Only the
evaluation (`prerender`, about 2 ms) depends on the entry.

## (1) A template's first pass, once per build (landed)

The first pass of two entries of one template is the same program: the 136 compiled functions are identical, and the IR
and the template HTML differ only in values (title, path, canonical URL). The entry is a constant resource (`fx`) whose
value the walk never reads. Only `prerender()` reads it, through `fileConstants`. The worklist reads compiled functions
and bindings, never the DOM, so the decisions (`decided`, `unrolls`, `foldReads`, `overLimit`) are a function of the
program and the values alone, and they are keyed by source position (`instKey`), not by anything per-entry.

As landed (`fromTemplate` in `src/compiler/compile.ts`, compile's `templates` option, which the Vite plugin passes in
builds and clears with the build's reads):

- `run()` is `walkPage()` (parse, expand, walk: the program) and `finishPage()`. A template's first entry is walked and
  the `Compiler` kept, by file, language and HTML.
- Each entry swaps its value into the entry's `fileData`, clears what the evaluation writes, and runs
  `prerender(true)`: it evaluates as before, records what it would paint, and writes nothing into the markup, so every
  entry starts from the same walk. Then `collectConstants` (the constants of rows come from the evaluation) and pass 2.
- Not shared, known from the walk: a page that compiles its own URL into its program (`$canonical` at a fixed path,
  `localeUrl()` from its translations; `PageInfo.readsUrl`). As a backstop, the first other entry is walked too, once,
  and its program must be the kept one (the functions, in order), or the template is not shared.
- Compiled the usual way, per entry: nothing to decide (the first pass is the page), a constant the layout or the images
  read that the first pass writes into its own markup and drops (a top-level class), the dry run, errors (in either
  pass), a type check, the canonical-link re-run. A template whose first two entries gain nothing is not evaluated for
  the next ones.
- The fold log: each entry logs the helper calls it would on its own.

Each guard has a test that fails without it. Dev is unchanged: the dev server compiles one entry per request. The
template compile in `templatePages` (once per build, ~50 ms) still runs on its own.

## (2) Component files parsed once per process (landed)

`parsedFiles` is a field of `Compiler`, so each compile (each pass, each entry, each page) parses every component it
uses again. `fileGraph` and `dataSlotsOf` parse the same text once more without caching. A component's parsed tree is
a function of its text, and every use already takes a `freshCopy`. One module-level map, by text, now
serves all three places, read-only: 17% of a post's compile, and it applies to every page with components, in dev too.
Landed with a bound: the map is cleared when it holds 2,000 texts (the editor and the dev server see one per edit).

## (3) The per-entry `describeOnly` compile (landed)

`describe()` compiled each entry in full (without prerender) to learn its `path`, which is the entry's own `page.path`,
and what it requests ahead. That reads only `$url`, never the entry (a request over the entry is not prefetchable), so
entries' descriptions differ only in their path. The Vite plugin now describes one entry per template and language and
gives every other entry that description at its own path (`entryDescription`): 100 compiles become one. A compiler test
checks the invariant (a `$url` request, one over the entry, a language prefix), and a build test that the next-page
module lists each entry at its own path with its request.

## (4) Do we need two passes at all? (spike: not as designed)

The idea: pass 1 exists because "what writes state, which decides what is constant, is known only after a walk"
(`compilePasses`). That holds for `data-sn-state`, not for `file:`, `content:` and the entry, which nothing can write.
A page whose decisions read only those could decide while it expands and skip pass 1.

**The ceiling.** One page per post (`measure.mjs --files`, 100 posts, not `data-sn-pages`, so (1) does not apply),
per page: pass 1 walks for 13.7 ms, evaluates for 1.8 ms and writes its own output for 2.3 ms; pass 2 takes 6.9 ms.
Pass 2 given the decisions is the page (that is today's design), so a single pass would cost about 7–9 ms instead of
25. Most of the walk (over 80%, from the profile) compiles the markdown library's shared definitions.

**Why the oracle does not work as designed.** The hook exists: `expandConstants` is a top-down expansion that, at each
`data-sn-if`, `<sn-component use>` candidate, recursion point and `data-sn-for`, looks a decision up by instance key,
and carries each unrolled row's item (`rowOf`). Evaluating the expression there instead is not the hard part: names
resolve through rows, `data-sn-let`, the host's `data-sn-prop` in the caller's context, `file:` values and the helper
fold. The hard part is *when* pass 1 decides. The worklist decides on the compiled program, not the markup. It unrolls
a loop only when every row is static markup, and "static" is written in terms of the walk's output: each binding's
kind (`ROW`), whether its dependencies are fixed (`fixed`, `known`), `$el` (`b.e`) and writes (`b.w`), item 6's
handlers that stay (`handlerOnly`), state on a node (`n.state`, `n.sid`), tree-slot fills and the fills that stay in
the browser (`placementOf`, `fillStays`), a choice's props as code, the page's expansion budget across trees, and
instances with one key that must agree. An oracle on the markup has none of that before the walk. It would have to
re-derive it (in effect a second front end that must agree with the first on every rule), or unroll optimistically
in the walk and back out when a row turns out not to be static, which the `Compiler`'s state (numbering, tables,
diagnostics in order) does not allow. Either is a rewrite of the compiler's front half, and every disagreement is a
page that renders differently from today. No prototype: the outcome was clear from the rules before writing one, and
a partial oracle would not be byte-identical.

**What would reach most of the ceiling instead**, without changing what is decided:

- *Shared definitions compiled once per build and linked into each page*: spiked, see the next section.
- *Pass 1 stops after its evaluation when a second pass follows*: its own output (2.3 ms, 9%) is discarded today.
  Safe for the decisions; the catch is errors reported after the evaluation (SN345, the dropped query, URL arrays),
  which decide whether there is a second pass. A pass 2 with errors falls back to the full path, as in (1), but an
  error only pass 1's output would have had needs those checks moved before the evaluation. Small win, not taken.
- *Decisions cached across builds*, keyed by everything a page reads (its HTML, component files, data files, the
  helpers module): unchanged pages skip pass 1 on a rebuild. That's caching, not a faster cold build.

## (5) Shared definitions, linked (spiked: built, byte-identical, 31% of a non-template page)

Measured on the blog of one page per post (`--files`), in-process, by instrumenting `definition()`:

- **What it would save.** The top-level `definition()` calls take 12–13 ms of a 25–28 ms page, all in pass 1 (pass 2
  inlines what pass 1 decided). Each page compiles the same four top-level definitions (`md-paragraph`, `md-heading`,
  `md-thematic-break`, `md-blockquote`, the first candidates of `md-block`'s choice), with the rest of the library
  nested in them.
- **They are page-independent, as far as this shows.** With template ids (`$p<tid>`, `$sl<tid>`, `sn-t-<tid>`) and
  function indices renumbered by first appearance, each definition's functions, templates and markup are identical
  across all 100 pages. These pages all have one shape; a page with other components or templates before its first
  recursion point is the next check.
- **The floor of a linker.** Copying what the definitions added (their head templates' markup and their template
  table) takes about 1 ms per page.
- **What a linker must carry.** Per page, the definitions write into 29 tables and counters of the `Compiler` and 12
  weak maps: 116 templates, 93 functions (each through the function table's dedupe, so a copy must replay `fn()` in
  order, which also keeps the numbering byte-identical), about 1,100 `origins`, about 400 entries each in `points`,
  `choices`, `pointCtx`, `scopeStart` and `passOn`, plus `pointOf`, `choiceGroups`, `runtimePlacements` (which
  `finishTreeFills` pairs with the page's own fills), `defRoots`/`defAttrs`, `headTemplates`, `templateAt`, `tplEls`,
  `attrSources` (the layout's constants), `textAt`/`textMarks`, `codeAt` (source maps, SN534), `uses`, `useIds`,
  `files`, `layoutFiles`, `remove`, and the counters. Template ids also appear inside the functions' code and in the
  markup's ids.

Estimate: a page's definitions at 2–3 ms instead of 12 ms, about 35% of a page's compile that is not `data-sn-pages`
(a template's entries already walk once, (1)). A copy of the tables' entries by hand, with renumbering, against a
generic record-and-replay of the `Compiler`'s state, is the choice; both are fragile while definitions write straight
into the page's tables. The way to build it is to make a definition a unit of its own first (its templates, functions
and side tables in one object, local numbering, with one explicit merge into the page), with byte-identical output at
each step, and cache that unit per build. A large refactor of the compiler's front half, worth it if sites with many
pages that are not `data-sn-pages` matter.

### The linker, spiked (branch `link-spike`, local)

Built as a generic record and replay (`src/compiler/link.ts`; compile's `definitions`, which the Vite plugin passes in
builds, `SN_NO_LINK` switches it off), not as the refactor first:

- **The unit** is a top-level `definition()` call with the definitions nested in it, keyed by the pass, the units
  already linked on the page (the chain), its name and the definitions the page has. A build compiles it the first time
  as before, records it the second time, and links it from the third.
- **Recording** diffs the compiler's tables (its maps, sets and lists, one level into `page`), intercepts writes to its
  weak maps, records each `fn()` hand-out, and diffs every object that existed before the call (a shallow copy each).
  An object from before is referred to by its path from a compiler field (properties, map keys, list indices, never
  markup children), by the earlier unit that made it, as the element being compiled, or shared (frozen, or a parse5
  source location). Anything else, a function among what it made, or a class instance makes the unit unlinkable, and
  the page compiles it.
- **A plan.** The unit is kept as a flat list of the objects it made, each value classified once (a plain value, another
  object of the plan, an object of the page, a string to renumber) with the numbers to renumber in each. Replaying it
  makes the objects, fills them, renumbers template ids, use ids and function indices, replays `fn()` in order (the
  table's dedupe and numbering are the page's own), applies the recorded changes, and sets `at`.
- **Found on the way** and changed in the compiler: a placement's default shape was a closure over its elements; it is
  data now (`DefaultShape`, `shapeChildren`). Units of one page share objects (one unit's `at` and source sites are the
  next one's), so the page keeps one map of what its units made.

Measured, every output byte-identical:

| | not linked | linked |
| --- | ---: | ---: |
| a page of the one-page-per-post blog, compiled in-process (median of 7) | 24.8 ms | 17.0 ms |
| that build (`--files`, 100 posts; two runs) | 4.7, 4.6 s | 3.9, 3.7 s |
| the `data-sn-pages` blogs (static, live) | 2.5, 3.8 s | 2.5, 3.9 s |

The template blogs do not change: each template's first entry is the only page that compiles the definitions, so they
are seen once and never recorded. A unit replays in about 1.2 ms where compiling it takes about 3 (from the page totals: four units, 7.8 ms saved); the first deep-copy
version took 6.5 ms per page, the plan removed most of it. Checked: the three benchmark builds and the four example
apps, every file the same as without linking; `vitest run` 2,133 passed with linking on in every build;
`test/compiler/link.test.ts` compiles six page shapes (the tree alone, a loop and a condition before it, another
component before it, a fill of the tree's slot, state with a handler, two trees) in rounds through one cache: 34
links, no refusal, each page as compiled alone. Breaking the `fn()` replay or the renumbering fails it.

What it does not cover yet, and the risk: the recorder is generic, so what it diffs is what it can see. A change it
cannot see (a property of an object no field reaches, a non-enumerable one, a write to a weak map that is not a field)
would be linked as missing, silently. Builds with `typecheck` and dev builds do not link. Recording walks the
compiler's state (about 250 ms once per build). The describe compiles (`describeOnly`) do not link.

**The refactor, as done (2026-11-17).** A definition compiles as a unit of its own, always: a child `Compiler` with
the page's numbering, its context and caches shared, its tables forks of the page's (`fork`; a weak table an `Overlay`
over the page's), merged back as a delta (`unitDelta`, `applyDelta`). The suite passed with every definition compiled
that way before it became the only way (which did not show that a definition reads nothing else of its page; see
the review below). Linking records that unit
(`recordChild`), not a diff of the whole compiler: the generic recorder and its patching of `WeakMap` and `WeakSet` are
gone. What is still diffed is what a unit changes of the objects it shares with its page (the page info, the component
files, earlier definitions). The safety net: `LINK_FIELDS` classifies every field (`test/compiler/link-fields.test.ts`),
and `SN_LINK_AUDIT` checks every compile in the suite against itself linked, on its own page and on one with every
numbering offset (CI job `link-audit`). Found by them and fixed: weak sets not seen, state ids, actions (refused),
comparison sides and loop names not renumbered, a component's `uses` overwritten. Every build of the benchmark and the
examples is byte-identical to `main`'s.

Traced: the audit reaches every definition the suite compiles. Of the suite's 1,382 audited compiles, the 81 that
compile shared definitions all link them (6 also refuse one), and none compiles one it does not link or refuse. The page
that seemed to escape it had no shared definition at all: its tree is a build-time constant, which the compiler expands
per instance as it goes. What the audit cannot check is what no fixture holds: no audited page has an action inside a
definition, which `test/compiler/link.test.ts` covers across pages (actions in a definition are refused, not renumbered).

**The review, and what changed (2026-11-17).** An independent review of the branch found 12 ways a linked page could
differ from the same page compiled in place, none of which a fixture held. Each is now a scenario in
`test/compiler/link-review.test.ts` (pages compiled in order through one cache over three rounds, each compared with
itself compiled alone):

- The claim above, that a definition reads nothing else of its page, was wrong. A unit reads the page's flags and sets
  (a feature the recording page had already was not recorded), per-page options (`$locale`, `localeUrl()`'s
  translations, an image host), and what earlier compiles learned of a component file (found `bad`).
- Writes the unit made to its own fields (`remoteImages`' helper, a definition's diagnostics) were not merged back. That
  was a regression even with linking off.
- Renaming in code went by regular expression: `x$1` in a string literal was taken for a loop variable.
- Fill ids, the dialog templates' set (`dlTemplates`) and lazy imports were not renumbered.
- `replay` could throw halfway through a page instead of refusing it.
- Cache keys nested the whole chain of earlier keys, so they grew exponentially with the number of components in a choice.
- A diagnostic in a definition named the recording page's file.
- Every definition paid the unit's cost in dev and in the editor, where nothing links.

The recorder is now a log, not a diff. A unit's view of its page is made of wrappers (`LoggedMap`, `LoggedSet`, a list
proxy, `LoggedWeak`, a proxy over the page info and the options, accessors on its own fields). Each write is applied to
the page and kept as an operation. Each read of what the unit did not write itself becomes a precondition (`Read`): a
key present or not, a table's size and keys, a value by its shape (JSON, an element as `#node`), an option by its shape
(an image host is not data: its answers change as the build analyses images, so a definition that reads it is refused).
`replay` checks every precondition and resolves every target before it changes anything. A plan that does not hold
changes nothing: the page compiles that definition, and the rest of the page, in place. Fill ids and lazy imports refuse
the unit. A definition compiles in place unless the build links: the first time a build needs it, and always in dev, in
`check` and inside another unit. Only the second sighting records. Chain keys are the short ids of the earlier units.

**The second review (2026-11-17).** Another independent review found 6 more ways, each now a scenario in
`test/compiler/link-review-2.test.ts`. It also found that most of the first review's scenarios tested nothing: their
`x-link` had two root elements, did not compile (SN312) on any page, and only part of the result was compared. They
now put the extra markup inside the root, compare the whole result, and fail if a component does not compile. The six:

- Replacing the recording page's file name by substring hit unrelated text: `club.html` became `cluc.html`, and a page
  named `text.html` turned `x-text.html` into `x-about.html` in the build's files.
- A value read from one of the page's tables (a resource's `key` or `offset-param`, whether `#save` has an action) was
  a precondition by its key only, not by what is there.
- An object of the page found again by its position in a list: with two resources declared in the other order, a loop
  took the other one's key fields.
- A function the recording page had already got no place in the source map where it was new.
- A check a unit leaves for the end of its page (a closure over the unit's compiler: SN210, SN211) reported into the
  unit's tables, gone by then; the recording page lost the error.
- Renaming by pattern renamed the user's own names (`node.v$2`, a `$p2` in text), or left a unit unlinked by accident.

What changed after it, renaming by comparing the unit with a shadow compile of it numbered otherwise, did not last
past the third review, below.

**The third review (2026-11-17), and no renumbering.** A third review found 5 more differences, each a scenario in
`test/compiler/link-review-3.test.ts`. Three were renumbering again: the user's text in a later definition taken for an
earlier one's names (`US$2` became `US$4`), a use id inside a string (`@ev:<id>:<event>`), and keys naming an earlier
definition's template in the paths a unit writes to and reads. It also found that the audit had never checked
renumbering: every unit read `nextId`, which the audit's offset page shifts, so linking onto that page never happened,
and the comparison was of a page with itself. Two more scenarios of the second review passed without linking anything
(a read of a page resource after the unit changed it made two contradictory preconditions).

Measured before deciding: of the 392 definitions the target benchmark links, none needed renumbering. Every page that
linked was numbered as its recording page was. Renumbering was the part that kept breaking and bought nothing measured, so
it is gone:

- A plan is not renumbered. The cache key holds how the page is numbered before the definition (templates, states,
  uses, nodes, functions, actions) besides the chain of definitions before it, so a page numbered otherwise has a plan
  of its own, recorded on its second page. `replay` checks the reads, every target, and that each function it hands out
  gets the index it had where recorded (the page's table shares code it has already); then it copies the objects as
  they are.
- The page's own file is the one thing a plan names that differs between pages: a string that is the file, or a place
  on it (`<name>:<line>`, `<path under the root>:<line>`), becomes the linking page's. Any other text holding the page's
  file name refuses the plan, so `club.html` on `b.html` is never touched. In practice that is a diagnostic in a
  definition, which then compiles on each page.
- The shadow compile, `merge`, the spans, the renaming of strings and `fixesOf` are removed, and so is the `shift`
  option.
- The first read of a place is the precondition; a later one may see what the unit wrote. A definition first seen on a
  page that linked another one is recorded there. A function whose code the page had written before the unit takes the
  page's site, but not one whose code only the unit wrote (the recording page's source map).
- The audit compiles each page three times through one cache, and every round is compared with the page compiled
  alone: where first seen, where recorded, where linked. A plan recorded on the page must link into it again. It then links
  the page's plans into the page under another name and in another folder.

Suite: 2,223 tests, plain and audited. Of 1,807 audited compiles, 425 recorded a plan and all 425 linked it into the
page again. Every build of the benchmark and the examples is byte-identical to `main`'s. `--files` links 392
definitions with 4 recordings and no refusal: a page compiles in 22.1–22.5 ms instead of 34.3–34.4 (in-process, median
of 7, two runs). A variant where a third of the posts have one more bound element before the article and a third one
more loop links 376 definitions with 12 recordings (four per kind of page): 24.3–24.5 ms instead of 35.1–36.5.

**The fourth review (2026-11-17).** It found two differences and two places linking never happened, each a scenario in
`test/compiler/link-review-4.test.ts`, and a cost:

- A library's definition recorded on a page at the root and linked into one in a folder said where the app uses it as
  `c.html:1`, not `blog/c.html:1`: at the root, the page's name and its path under the root are one string. A place is
  now told by where it is held: an origin's `usedAt` is the path under the root, any other the name.
- With a source map, a function whose code the page had written before the definition took the definition's site, the
  recording page's too. With `sourcemap`, the unit now reads the page's `codeAt` through, and what it looks up is a
  precondition. Without one a site shows nowhere, and the unit keeps its own.
- Localized pages linked nothing: every unit read the page's locale whole, and with it the page's own URLs. Objects of
  the page info are now read property by property.
- A warning before the tree stopped linking: the first pass reads the diagnostics added since a point
  (`slice(d0)`), which read the whole list, and a diagnostic names its file. Such a `slice` now reads the length only.
- Recording walked and copied the whole page for each unit, so a page was quadratic in its definitions: 100 small ones,
  61 ms compiled alone and 1.1 s where recorded. A unit now copies the page's objects as it is handed them (`Rec.hand`:
  by a table, the page info, a field), with their paths: about two per definition here, whatever the page's size, and
  150–270 ms where recorded. A wrapper a unit keeps in an object of its own is put back as the page's object.
- The audit compiled only pages that did not link, so a build's pages were never audited. Under `SN_LINK_AUDIT`, a
  compile that links is now compiled alone beside it and compared.

Suite: 2,234 tests, plain and audited; of 1,931 audited compiles, 549 recorded a plan and all linked it into the page
again. Every build is byte-identical to `main`'s, three variants of `--files` included. A page of `--files` compiles in
21.2–21.3 ms instead of 33.8–35.7; the variant with three kinds of post in 22.5–25.0 ms instead of 33.5–37.6; a
localized one (`localePrefix`, two languages, 605 files) links 792 definitions with 4 recordings, and builds in 7.9–8.7 s
instead of 10.3.

Found on the way and landed: the expression parse cache keyed its trees by one string of the kind, the options and the
text, a new string hashed at every lookup (7% of the definitions' time). Keyed by the options, then by the text (the
attribute's own string, whose hash the engine keeps): 6–9% off a page's compile, output unchanged. Memoizing
`normalize` (3% of the definitions' self time) changed nothing measurable.

The two rarer re-runs are full recompiles, which a patch of the first result could replace: `canonicalOnly` (a static
page with a pattern path, whose canonical link is the only difference) and the compile after `images.analyze`. Neither
is hit by this benchmark.

## Work left

Ranked by what it buys for its risk. Each keeps the output byte for byte: check every step by building
`bench/collections` (static, live, `--files`) and `examples/*` with `main`'s `dist` and the branch's swapped in turn,
and diffing the output trees. Swap the contents of `dist/`: a symlinked package is loaded from this checkout either way.

1. **A definition as a unit of its own, then linked (5).** About 35% of a page's compile that is not `data-sn-pages`.
   Step 1, no speedup yet: `definition()` writes into a `DefinitionUnit` (its templates, functions, the side tables
   listed in (5), local template ids and function indices) and one `link()` merges it into the page, replaying
   `fn()` in order so the function table's dedupe and numbering stay as they are. Step 2: keep units per build, by
   component and the options they read; link a copy per page. First check that a definition is page-independent on
   pages of other shapes (components and templates before the first recursion point, a fill from the page, a
   library component), with the renumbering probe of (5).
2. **Pass 1 stops after its evaluation when a second pass follows.** About 9% of a two-pass page. What pass 1 writes
   after its evaluation is thrown away when pass 2 runs. The catch: errors reported after the evaluation (SN345, the
   dropped query, URL arrays) decide today whether pass 2 runs at all, so those checks move before the evaluation.
   A pass 2 with errors falls back to the full path, as `fromTemplate` does.
3. **The two rarer full recompiles, as patches.** A static page whose path is a pattern compiles again only to drop its
   canonical link (`canonicalOnly`), and a page with images not analysed yet compiles again after `images.analyze`.
   Neither happens in the benchmark; each doubles its page's compile where it does.
4. **The template compile in `templatePages`.** About 50 ms once per build: the template is compiled to list its
   entries, separately from the walk (1) keeps. With the same options it could be that walk.
5. **Garbage collection**, 10–12% of a compile throughout: profile allocation in the walk (`cloneTree`, `freshCopy`,
   scopes) now that fewer passes run.
6. **Decisions cached across builds**, by everything a page reads: a rebuild skips pass 1 for unchanged pages.
   Caching, not a faster cold build; only if rebuild time matters.

Not worth taking up: the single pass as designed (4), and memoizing `normalize` (measured, no change).

## Not pursued

- Threads: see the two earlier spikes.
- GC is 10–12% of the compile throughout. Fewer passes allocate less; it is the next thing to profile after (1)–(3).
