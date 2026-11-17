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

**Recommendation.** Take it to production as the refactor the doc first proposed, now that the spike has mapped what a
definition writes: a definition writes its templates, functions and side tables into a unit of its own, and `link()`
merges it, with the record-and-replay kept as the test oracle (a page linked must equal the page compiled, over the
benchmark apps, the examples and the shapes above). Keeping the generic recorder as the mechanism is the faster
path, but every compiler change could add a write it does not see.

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
