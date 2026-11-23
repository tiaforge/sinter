# The compiler's front half, redesigned: units

Status: design and stage 1 in progress (2026-11-23). The research is in [redesign-notes/](redesign-notes/)
(`pipeline.md`, `decisions.md`, `contract.md`, `profile.md`), the benchmark in
[bench/astro](../../bench/astro/README.md). The [status log](#status-log) at the end says where the work stands; a
session that picks this up starts there.

Builds on [compile-once.md](compile-once.md) (fewer compiles per build) and replaces its linker and the
[static-trees spike](https://github.com/tiaforge/sinter/blob/ccr-3a318806-fp31ai/docs/proposals/static-trees.md).

## Why

The same 100 markdown posts build in 13.9 s with sinter and in 2.2 s with Astro 7.4. Of sinter's 12.4 s of CPU time,
9.0 s is `compile`, 2.0 s the garbage it makes, 0.2 s parsing markdown, and about 1.4 s everything else. Astro
writes its 101 pages in 0.2 s. To be level, a page of 420 component instances has to cost about 5 ms where it costs
90 ms.

Two attempts at that cost exist. The linker (`src/compiler/link.ts`) records what compiling a shared definition
changed in the compiler's tables and replays it on the next page; it took five reviews to make safe, links only in the
first pass, and is off whenever the build type-checks. The static-trees spike interprets a component's source over
constants beside the compiler and gives up on what it does not know. Both work around the same thing, and neither
helps a page with live parts.

## What is wrong

The compiler has no compiled form of a component. A component is a macro: each use copies its parsed file into the
page's DOM (`expandUse`), and the walk compiles the copy as if it were page markup, with the props pasted into the
code as text. About twenty side tables keyed by DOM node exist only to tell the walk which instance and whose scope a
copied node belongs to. Everything a compile learns is written into about 150 fields of one `Compiler` under numbers
handed out during the walk, so nothing it learns can be kept for the next use, the next pass or the next page without
recording and replaying those writes. That is what the linker does.

On top of that a page is compiled twice. The first pass compiles the page and evaluates it to decide what is constant;
the second is a fresh compile that is handed five maps of decisions and applies them. For a tree over constants this
is the worst case. The first pass compiles the tree's components once, as shared definitions, and its worklist
evaluates every instance against them: each nested condition and loop, each value. The second pass then discards that,
copies the source of every instance into the page, analyzes each copy again with its item as a JS literal, evaluates
each binding once more through `new Function`, writes the value and drops the binding.

The one place the compiler does compile a component once and render it many times is the shared definition, and
there it works: the first pass's evaluation of 420 instances costs about 20 ms, the second pass's recompile of them
about 65 ms.

## The design

**A component is compiled once, into a unit. A use of it is rendered from the unit: at build time where its inputs are
known, in the browser where they are not.** That is one mechanism for constant and for live uses. What differs is who
runs the unit's program, not which code path compiled it.

1. **The unit.** What compiling a component produces, independent of any use: its markup as a template with numbered
   nodes, its bindings and their functions with the props as a parameter (as a shared definition reads `$p`), what it
   declares (props, slots, events), and a summary of what it does (what it writes, what needs the runtime: handlers,
   state, a model, a script, `$el`). Numbers in a unit are local. A page's own markup, a loop's rows and a branch are
   units too: today's row templates.
2. **Rendering at build time.** Given known inputs, a unit's instance is its template with the values written in,
   branches chosen and loops unrolled, recursively: what the runtime does with live rows, done by the build, with the
   same value-writing code (`firstPaintValue`, `writeFirstPaint`). Nothing is compiled per instance. What an instance
   keeps for the browser (a handler, a value the markup cannot hold) is a residue, addressed by the node it belongs to.
3. **Binding at run time.** A use whose inputs are live is the unit's program placed on the page: its functions with
   the use's prop expressions substituted, through structural holes in the code, never by pattern on the text; its
   nodes numbered by the page. A recursive or chosen component is the unit linked as it is, with its props as a row.
4. **Deciding.** What is known is decided before anything is rendered, from the units' summaries: the write set of the
   page (writes are local by construction: props, lets and `$slot` cannot be assigned), closed over aliases. The
   decisions and the values come out of the same evaluation that renders.
5. **Assembling.** The page hands out its numbers once, at the end, in today's order (first appearance), over what the
   page ships. `compactTables` and `shareTemplates` already do this for templates and functions.

What stays as it is: everything after the walk (`finishPage`: anchors, the IR, the early and prefetch parts), the
layout, the images, the runtime, the IR, the diagnostics. The output stays byte for byte today's.

### What the research settled

- Most per-use work is the same work redone: validation, parsing, resolution, the shape of the generated code, the
  binding kinds (`pipeline.md` §4). The use decides only the prop expressions, the caller's names, the numbers, and its
  position.
- A unit cannot be a frozen fragment with numbers patched in. Two uses differ in which bindings exist at all (a known
  use has none), and props are code inside code (`contract.md` §2). Hence rendering (2) and holes (3).
- The layout, the images and `declare` read the whole expanded page before a binding is final (`pipeline.md` §6.1). A
  page tree exists before bindings are made; rendering and binding write into it. "No DOM" was never the goal: no copy
  that has to be compiled is.
- A single top-down pass cannot give today's bytes (`decisions.md` §7): decisions use the writes of the page before
  deciding, the values the writes that survive; an error anywhere stops every unroll; the budget is spent in candidate
  order. So deciding stays a step of its own (4), as cheap as an evaluation, and the page compiles once after it.
- `sinter check` checks a component's markup against its declared props, never against a use's types
  (`contract.md` §5): checking each unit once loses only repeated errors.

## Byte for byte, and the oracle

Every stage keeps the output identical, and each has a switch that turns it off, so one checkout builds both ways:

- `scripts/render-audit.mjs` (stage 1; later stages add to it) builds the four benchmark apps and `examples/*` both
  ways and diffs every file.
- An in-process audit in the manner of `SN_LINK_AUDIT`: a compile that takes the new route is compiled the old way
  beside it, and the results compared (`differs`). The whole suite runs under it, in CI.
- A stage is done when the old route it replaces is deleted, not when the new one exists beside it. Until then the
  log says which cases still take the old route, and why.

Two things today's output does that the research found wrong are not copied silently; they are listed for a decision
below.

## Component libraries: sinter-mail

[`@tiavision/sinter-mail`](https://github.com/tiavision/sinter-html) (the repository is `tiavision/sinter-html`)
is the library this design is held to, beside sinter-markdown: 67 generated components, one per tag, dispatched by
`<sn-component use>` on the node's type, with fills (`link`, `image`) and a script builder. It renders an email three
ways: from a file, folded into the page at build time; from an API, by its script; from an API through the components,
as shared definitions the runtime instantiates per node. It must keep working, and be as fast in the browser as it is
now, or faster.

- **It keeps working, and the browser does what it does today**, because no stage changes the output: the page, its
  module and the runtime are byte for byte the same, so what the browser runs is the same. `scripts/mail-audit.mjs`
  builds sinter-mail's pages over the three ways with a stage on and off and diffs them, and runs the library's own
  suite and run-time benchmarks against the checkout. It is part of each stage's check, with the baselines in
  `redesign-notes/sinter-mail.md`.
- **Its builds are the redesign's second measure.** A file email is a tree over constants through 67 components (stages
  1 to 3). A page with an email from an API compiles the library as definitions, per page and quadratic in the
  library until #96 (stage 4: once per build).
- **Faster in the browser** is not something the stages above give: they do not touch the runtime. It is a step of its
  own after them (stage 7 below), and the reason the unit keeps its props as a parameter. Today a tree node from an
  API costs the browser an anchor pair, a row scope, a template clone and a `find`, because a definition is a loop
  over one row. A unit the runtime instantiates directly could cost less. That changes the IR and the runtime, so it is
  measured on sinter-mail's benchmarks first and taken only if they show it.

Baselines against `main` (`redesign-notes/sinter-mail.md`; a 2,012-element newsletter in the browser, 12 pages at
build):

| Way | Build, 12 pages | In the browser, first render | JS, gzip |
| --- | ---: | ---: | ---: |
| a file, folded at build | 5.5 s (11 to 13 ms an element) | nothing to run | none |
| an API, the script builder | 2.8 s | 45 ms | 15.0 kB |
| an API, the components | 4.4 s | 107 to 120 ms | 22.3 kB |

Each page compiles the library's 65 definitions in the first pass (125 to 133 ms a page, on every way, the script
builder's included, only to decide `$build`), and with TypeScript installed 12 pages take 13 to 23 s. In the browser,
an element through the components is 5.4 row instances around one clone; a unit instantiated directly is estimated
at 25 to 35 ms off the 95 ms of script (from call counts, not prototyped), and the rest of the gap to the script
builder is the 8,448 style writes, which units do not change.

## Stages

Each is general (pages with live parts gain what their constant parts cost), measured on `bench/astro` and on
sinter-mail, and lands
with the suite green and the audit clean.

1. **Rows rendered at build time.** Where the first pass's worklist accepts a loop over constants (or a choice or
   recursion point) whose rows keep nothing live, the rows' markup is rendered there, from the compiled template and
   the values the worklist computed, and the second pass places it instead of copying and compiling each instance. No
   new rules: the worklist's own decide what is static. Removes most of the second pass for constant trees.
2. **Rows that keep something.** A rendered row with a residue (a handler that stays, a value that stays a binding, a
   fill that stays, a styled component's marks): the residue is bound to the rendered node. After this, the second
   pass's `inlineInstance`, `cloneTree` and row lets are deleted.
3. **One compile per page.** The second pass goes: what the first pass decided is applied to its own result (rendered
   rows placed, dropped templates and their functions compacted away, the nodes after them renumbered at assembly),
   instead of compiling the page again. `fromTemplate` becomes the ordinary case rather than a route of its own.
4. **Units kept per build.** A definition is compiled once per build with local numbers and linked into each page at
   assembly, under the type check too; a component's markup is checked once. `link.ts`, `LINK_FIELDS` and the link
   audit are deleted. The first pass no longer compiles a library per page.
5. **Live uses from units.** `analyze` is split into what a unit's attribute resolves to (once) and the substitution of
   a use's props (per use); `element()` reads the unit's table instead of scanning attributes. A use no longer copies
   the file: the side tables that trace copies go.
6. **Deciding from summaries.** The write set and the instance graph from the units, so that deciding does not need
   the page compiled first; a page with errors compiles the long way, as `fromTemplate` does today.

7. **Units at run time (not byte-identical; a decision of its own).** Where the browser instantiates a component per
   node (a tree from an API), the unit is instantiated as such instead of as a loop over one row. Only with numbers
   from sinter-mail's and sinter-markdown's run-time benchmarks, and with the page weight no larger.

### What a build costs, and what each stage leaves

Measured (`redesign-notes/profile.md`; 100 posts, medians, 4 cores). A build is a fixed part and a part per page:

| App | Fixed | Per page | of it: deciding (pass 1) | the second pass | garbage | outside the compiler |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| static, one template | 1.14 s | 110 ms | 19 ms | 91 ms | (in both) 20 ms | 6 ms |
| live, one template | 1.33 s | 137 ms | 19 ms | 93 ms | 21 ms | 28 ms |
| static, a page file per post | 1.42 s | 145 ms | 35 ms | 95 ms | 21 ms | 9 ms |
| live, a page file per post | 1.56 s | 161 ms | 35 ms | 100 ms | 22 ms | 28 ms |

Astro: 2.2 s for 100 posts, 4.7 s for 1,000, so about 1.9 s fixed and 2.8 ms a page. With sinter's fixed part and its
6 ms a page outside the compiler, a static page has about 4 ms for the compiler to be level at 100 posts. At 1,000
posts sinter's markdown parse alone (2.3 ms a post) is most of Astro's whole page, so level there is not expected:
close is.

- The second pass is 80% of the compiler, and per page it runs 244 `expandUse`, clones 5,964 nodes and calls `analyze`
  1,076 times for a page whose first pass needs 1 to 5 `expandUse`. Stages 1 and 2 remove it for constant trees;
  stage 3 for every page.
- Deciding (the first pass's evaluation, 17 to 19 ms a page) is the floor after that: 100 pages at 25 ms are 3.6 s.
  It is `new Function` over the page's code and a proxy scope per entry, with `deepFreeze`, `structuredClone` and
  `jsLiteral` of the data; rendering from units (stages 4 and 6) evaluates compiled closures instead. Being level
  with Astro needs this under 4 ms.
- A page file per post is walked three times (two passes and the description). Stage 3 makes it one.
- With the type check on, a template's entries collect check data that is thrown away (14 ms a page), and a page
  file per post compiles its definitions unshared and runs `tsc` over 101 shadow files (56 ms a page). Stage 4 checks
  a unit once.

Outside the compiler, a live page costs 23 ms more than a static one, none of it the compiler's: the early script is
one nested `vite build` per page (15 ms each), every chunk is gzipped for a report that `logLevel: 'warn'` does not
print (1 to 1.5 ms), and Vite's HTML plugin does more (3 ms). That is 3.9 s for 100 live pages with a free compiler,
more than Astro's whole build, so it is fixed beside the stages (the build pipeline, `src/vite.ts`): the early
scripts in one build, no gzip without a report, and the fixed part's avoidable pieces (a probe compile of the
template, 116 ms; every post's markdown parsed again at the end, 1.2 ms a page).

## For a decision

Found by the research, not changed:

- **An error in markup that is never rendered stops unrolling.** An SN201 inside `data-sn-if="false"` is not reported,
  yet it keeps an unrelated loop over constants from unrolling, so the page ships a module (`decisions.md` §7.1).
- **A choice's props are not checked for being constant.** With `images` on, an `<img>` whose `src` comes from written
  state through a `<sn-component use>` prop is folded to a static `<picture>`; the same component used by its tag keeps
  its binding (`decisions.md` §7.3).
- **Linking is off whenever the build type-checks** (`contract.md` §4), which is every build with TypeScript installed.
- **Props as a run-time frame.** Binding an inlined live use's props at run time, as shared definitions do, would
  make a unit's code independent of its use with no holes, at the price of a changed IR and other bytes. Not planned
  for inlined uses: the holes keep the output, and the runtime, as they are. Stage 7 is about the uses whose props
  are a frame already (definitions), and is a decision of its own.

## Status log

- 2026-11-23: benchmark (`bench/astro`), research notes, this design. Stage 1 started as a spike in a worktree.
  The cost model is measured (`redesign-notes/profile.md`): the second pass is 80% of the compiler, deciding the
  floor after it, and live pages pay 23 ms a page outside the compiler.
  sinter-mail added as a requirement and a gate; its baselines are being taken (`redesign-notes/sinter-mail.md`).
- 2026-11-23, 12:50 UTC: merged into the branch, both still in progress in their worktrees. Stage 1 (`renderRows`,
  `SN_RENDER=0` turns it off, `SN_RENDER_AUDIT=1` compiles both ways, `scripts/render-audit.mjs`,
  `test/compiler/render-rows.test.ts`): 100 static posts in 5.3 s (11.9 s with it off), 100 live posts in 6.2 s
  (12.3 s). The pipeline (`redesign-notes/pipeline-fixes.md`): one nested build per distinct early script, and no
  gzip for a report that is not printed, 16 to 21 ms off a live page. sinter-mail: its suite passes against `main`
  (234 tests), its baselines are in `redesign-notes/sinter-mail.md`, and `scripts/mail-audit.mjs <checkout>
  [--bench] [--suite]` builds 16 of its pages both ways and diffs them.
- 2026-11-23, 13:30 UTC: **stage 1 is in** (`redesign-notes/stage1-render.md`). On the merged branch, 100 posts,
  rendering off and on, one run each: static 13.6 s and 4.2 s, with the type check 14.2 s and 4.4 s, live 13.6 s and
  4.3 s, a page file per post 15.7 s and 6.8 s, live 16.8 s and 8.5 s. Astro: 2.2 s. The benchmark apps and the
  examples are byte for byte the same both ways, and the agent's run of the suite passes plain and audited (2,800).
  What it leaves: sinter-mail renders nothing yet (every loop falls back on `minify`: a style paint under the
  minifier), the examples' loops fall back on `layout`, and a template page still costs about 24 ms (15 ms the first
  pass's evaluation, half of it cloning and freezing row items; 8 ms the second pass). Two agents started on those:
  stage 2, coverage (`redesign-notes/stage2-coverage.md`), and the per-page floor (`redesign-notes/floor.md`). The
  pipeline agent has also landed the page list kept per build (quadratic before), the template probe as a description
  and the lazy-import check once per build.
- 2026-11-23, 13:55 UTC: the suite passes on the merged branch (2,809 tests). Stage 2, merged so far: style, show,
  hidden and contenteditable paints under the minifier, and rows with images. sinter-mail's file emails now render:
  9 of its 10 loops (1,355 of 1,610 rows; left: one loop on `fill`), byte for byte the same; its 212-element email
  builds in 1.7 s instead of 3.9 s, a 1,000-element one in 2.2 to 2.6 s instead of 13.4 s (the agent's runs). The
  examples still fall back on `layout`. Pipeline: one Vite builder per build for every early script (4.5 ms off each
  distinct one).
