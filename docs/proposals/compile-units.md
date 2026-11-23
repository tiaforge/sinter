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
- **Found by the type-check work, recorded and not changed** (`redesign-notes/typecheck.md`): a number-literal prop
  read with a member (`n.toFixed()` with `n: 1`) is pasted as `1.toFixed()`, a syntax error in the bundler; a broken
  expression on any page silences every type error on every page; a recursive component used both inline and as a
  definition on one page reports its errors twice; the build counts warnings in "type error(s)". And a correction to
  `contract.md` §5: components see the page's resources, so some of a component's functions are typed per page
  (`$meta`, `refresh`, `upsert`); those stay on their pages when the check shares functions.
- **Dev builds and the old route.** Decided: dev's function numbering may change, and dev compiles (the dev server,
  `render()` from the testing module) render rows as builds do. A dev page's table has no `0` slots for the rows any
  more; the render audit compares dev without them (`withoutEmptySlots`). The old route (`inlineInstance`, the row
  lets) is now needed only for per-copy diagnostics, rows that keep a handler, and the shapes the renderer leaves
  (`redesign-notes/stage2-coverage.md`, "Dev renders").
- **Four things outside the compiler** (`redesign-notes/pipeline-2.md`, "Decisions for the owner", with numbers;
  decided 2026-11-23: the fold check's disk cache and the Speculation Rules go ahead, the other two stay as they
  are for now):
  the SN534 cross check off the critical path (0.23 s at 100 posts, 0.5 s at 400; a failing build would then have
  emptied `dist/`); Vite's HTML step skipped for pages it does not change (1 ms a page; an app's own HTML plugins
  would no longer see those pages, unless it is done only where there are none); an on-disk cache of the fold
  check (110 ms a build); the Speculation Rules inline in every page listing every page when each post is a page
  file (4.7 kB of a 15.7 kB page at 100 posts, 47 kB of 58 kB at 1,000: a pattern or the rules file would make it
  linear, and changes the pages' bytes).
- **A build with only type-check warnings passes** since the fix that counts errors and warnings apart; it failed
  before. Under `strict` it still fails.
- **Props as a run-time frame.** Binding an inlined live use's props at run time, as shared definitions do, would
  make a unit's code independent of its use with no holes, at the price of a changed IR and other bytes. Not planned
  for inlined uses: the holes keep the output, and the runtime, as they are. Stage 7 is about the uses whose props
  are a frame already (definitions), and is a decision of its own.

## What is next (the owner's instructions, 2026-11-23)

1. **Stage 5 starts once the agents now running have finished and are merged** (dev rendering, the six bug fixes,
   embedding, the evaluation's cost, stage 4's check data). Besides what its entry above says, stage 3 found that it
   has to bring assembly: the first pass's walk compiles a decided branch's content as page markup, and ids and
   numbers are handed out at the end, so that the second pass's result comes from the first's walk.
2. **Stage 3's leftovers, as soon as stage 5 makes them possible** (`redesign-notes/stage3-one-pass.md`): the
   second pass deleted; a page file walked once, not three times (its description needs every page's description
   first: late-bound placeholders in `src/vite.ts`, and an audit that a real compile's description fields are a
   `describeOnly` compile's); a cheaper copy so that a page of its own starts its second pass from its first's
   expansion. And stage 2's: the old second-pass row route deleted once dev renders and per-copy diagnostics and
   rows that keep a handler are covered.
3. **Stage 4's last step waits for a review**: the linker's deletion (`redesign-notes/stage4-units.md`).

## How the work is run

One session coordinates (it merges into `ccr-9ebf49d5-gpdej8`, one branch at a time, and runs the full suite and the
audits there); each workstream has a log in `redesign-notes/` with, at its top, where it stands and what is next.
Workstreams run as agents in worktrees of the coordinating session's machine or, since 2026-11-23 evening, as
cloud sessions with a machine each (the one machine was at a load of 18 to 25 on 4 cores with six agents, and its
timings were not usable). A cloud session pushes to a branch of its own:

| Workstream | Where | Branch | Log |
| --- | --- | --- | --- |
| stage 5, B1 continued: rendered rows and a layout, then what B2 needs (pages with a unit and folds merged) | cloud, `session_01AjKzdx4aCc4CWZp4zJDc1m` | `redesign/stage5-b1b` | `stage5-b1.md` |
| stage 6 continued: the blog's walk and render per node (the evaluation is done and merged) | cloud, `session_01AjKzdxcYo9FzUYyj9yNBZn` | `redesign/stage6-eval` | `stage6-eval.md` |

**The bar, as the owner set it on 2026-11-23:** the output need not be byte for byte today's where only numbering
and generated names differ (`data-sn` ids, anchor numbers, template, state and function numbers, renamed loop
names), provided a canonicalizing comparison shows the two equal (stage 5 builds it), the suite passes, sinter-mail's
suite and run-time benchmark hold, and no page gets heavier. The IR's shape and the runtime do not change without a
decision of their own (stage 7). A step that can stay byte-identical does.

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
- 2026-11-23, 14:00 UTC: **the pipeline fixes are in** (`redesign-notes/pipeline-fixes.md`; six fixes in
  `src/vite.ts`, output identical over 11 apps, suite green). Outside the compiler a live page costs 10.6 ms instead
  of 33 (4 ms more than a static one, not 26): 100 live pages with a free compiler are about 2.1 s instead of 3.9 s.
  Static pages are unchanged there (6.8 ms a page). Left, and why, in the log: the fixed part (about 1.1 s on a quiet
  machine), 13 ms for each distinct early script, and the description compile of a page file (5.7 to 7.2 ms), which
  needs the compiler to give a page's paths without a walk and the cross-page parts as placeholders (stage 3). A live
  post's page embeds the whole post as JSON (8.5 kB of its 20.3 kB) where its module reads only the slug: the
  compiler's choice, not changed.
- 2026-11-23, 14:30 UTC: `main` merged in (#109, the scoped-styles fix for unrolled rows; #110). Stage 2: pages with
  stylesheets and with scoped styles render (`layout` and `styled` are gone as reasons). What still falls back in
  any real app is `fill` only: static-site 2 of 9 loops, sinter-mail 1 of 10, multilingual-site and the benchmark
  none; every tree the same both ways (`render-audit`, `mail-audit`). The floor: row items frozen once (`frozenData`)
  and component files read once per build (`componentCache`): the first pass's evaluation 19 to 12.5 ms a page, the
  second pass's walk 7.5 to 4.9 ms. On the merged branch, loaded machine, off and on: static 11.3 and 3.2 s, live
  11.9 and 4.1 s, a page file per post 14.4 and 6.6 s. Open: `render-rows.test.ts` fails under `SN_LINK_AUDIT`
  (it counts splices, which the audit's extra compiles add to); the coverage agent has it.
- 2026-11-23, 15:05 UTC: **stage 2 covers every app** (`redesign-notes/stage2-coverage.md`): fills and images
  render too, and nothing falls back in the benchmark apps, the four examples or sinter-mail's 16 pages (10 of 10
  loops, 1,610 rows), all byte for byte the same both ways. sinter-mail's 1,000-element file email builds in 2.0 to
  2.6 s instead of 13.4 to 14.6 s. It found and fixed two stage 1 bugs (a paint out of order; `fixedState` of rows
  reading state) and made the render tests pass under `SN_LINK_AUDIT`. The old route is not deleted yet: over the
  whole suite, `links` (36 loops), `top-level choice` (7), `diagnostics`, `handler`, `text`, `not written ahead` and
  `an id` still take it, and dev builds never render. The floor so far: the first pass stops at its decisions when a
  second follows (`settle`), `plainData` once per evaluation. On the merged branch, 100 posts, off and on (load 4 to
  6): static 12.0 and 3.6 s, with the type check 13.0 and 3.8 s, live 13.4 and 4.5 s, a page file per post 13.2 and
  5.0 s, live 16.1 and 6.7 s. Started: the rest of stage 2 (the reasons above, then deleting the old route), and the
  type check once per component (part of stage 4).
- 2026-11-23, 15:25 UTC: **the floor's first round is in** (`redesign-notes/floor.md`). The compiler's own time
  per page, base and now: a template page 24.1 and 15.6 ms, a page file per post 39.3 and 25.1 ms. Whole builds, 100
  posts, medians under load: static 3.0 s, with the type check 3.4 s, live 3.9 s, a page file per post 4.4 s, live
  7.5 s; 400 static posts 9.1 s (45 s with rendering off). Astro: 2.2 s, so static is about 8 ms a page behind; the
  4 ms target is not reached. What a template page's 15 ms are: the first pass's evaluation 7 to 8 (the page's own
  `md.parse` 3, rendering 2, the worklist's walk of 420 instances 2.5), the second pass 5 (the minifier's layout
  queries over rendered rows 2.3, the page's own markup 1). A page file per post: the library's definitions compiled
  on every page 8.7, the evaluation 10, the second pass 5.5, the description 4. One difference recorded, not seen in
  any app or test: a row's item compared to its parent's data by identity (`y === x.children[0]`) is true at build
  time now, as in the browser, and false with rendering off. Started: a spike of stage 4, definitions compiled once
  per build (`redesign-notes/stage4-units.md`). Stage 3 (one walk per page) waits for the rest of stage 2, which
  works in the same code.
- 2026-11-23, 15:50 UTC: the type check, first change merged (`redesign-notes/typecheck.md`): a shadow function
  that repeats (a component's markup gives the same ones on every page and at every use) is given to `tsc` once, and
  its errors are laid out at every place they were reported before; the diagnostics corpus is byte for byte the
  reference. With the check on (the agent's medians, load 4 to 8): 100 posts, a page file each, 12.6 s to 8.4 s
  (`tsc` 9.8 s to 0.86 s); one template 5.1 s to 4.4 s; sinter-mail's 12 API pages with TypeScript 21.3 s to 8.0 s.
  `SN_CHECK_SHARE=0` turns it off. Still running: the rest of stage 2, the stage 4 spike.
- 2026-11-23, 16:05 UTC: **stage 4, measured and planned** (`redesign-notes/stage4-units.md`; no unit store yet).
  What it found: a definition reads nothing of its page that differs between pages except the numbering before it
  (and page options, which go in a unit's key); and when a second pass follows, the first pass's definition numbers
  never reach the output (`SN_UNITS_SHIFT_AUDIT=1` hands out other numbers and compares: sinter-mail's 42 files, the
  blog and 118 suite compiles identical). So the library a page compiles per page today is a first-pass compile
  whose numbers are thrown away: it can be compiled once per build without holes in the code. Today, without
  TypeScript, the linker covers these builds at a price (recording a page costs 2 to 2.5 compiles; a replay is a
  third of a later sinter-mail page: 72,176 objects); with TypeScript nothing links (a later sinter-mail API page:
  238 ms of definitions in a 307 ms compile). Estimated saving: 36 to 48% of a sinter-mail API build's compile, 60
  to 64% with TypeScript. Rejected: canonical numbering (compaction does not normalize `$p`, `$sl`, loop names,
  `$s`), typed holes everywhere (not needed for the first pass), extending the linker. The agent goes on with the
  implementation: units placed by reference where the first pass only reads them, their functions compiled once
  per build for the evaluation, then the type check's frames; the linker is deleted after a review.
- 2026-11-23, 16:30 UTC: stage 2, the rest (merged): links in rows, a choice outside any loop and ids in rows
  render. Over the suite the second pass still takes the old route for per-copy diagnostics (3 loops), a handler
  that stays (3), an id in a case's definition, and render-rows' own fallback cases; and for every dev compile
  (1,493 loops), which is what keeps the old route from being deleted (see "For a decision"). A profile of the
  static build as it is (CPU, loaded machine): per page, the first pass's evaluation 14.5 ms (the page's `md.parse`
  4.8, the worklist 4, rendering 3.8), the second pass 14 (`walkChildren` 3.1, `minify` 2.9, `expandComponents`
  1.8), garbage 8.3; outside the compiler, Vite's HTML parse 3.5 and the end-of-build cross check running the
  helpers again 2.9. Started: stage 3, one walk per page (`redesign-notes/stage3-one-pass.md`).
- 2026-11-23, 17:00 UTC: dev may render (decided): dev's function numbering may change, an agent is on it. The
  type check (merged, `redesign-notes/typecheck.md`, "Where it stands"): the first pass stops at its decisions under
  the check too; shared definitions link under the check, their check data with them; `sinter check` links its
  pages' definitions as the build does; shadows written faster. From 4c3e26c to now, with the check on (the agent's
  medians, load 9 to 16): 100 posts with a page file each 30.0 s to 13.9 s, one template 5.3 s to 4.6 s,
  sinter-mail's 12 API pages with TypeScript 38.8 s to 9.2 s; `sinter check` on the blog 12.8 s to 8.7 s. The
  diagnostics corpus is byte for byte the reference. Stage 3, first change (merged,
  `redesign-notes/stage3-one-pass.md`): the minifier's layout questions over rendered rows are linear, the second
  pass's `minify` 2.7 to 0.7 ms a page.
- 2026-11-23, 17:10 UTC: **the type-check work is in** (five changes; `redesign-notes/typecheck.md`). What is left
  there is stage 4's: check data is still copied into each page by the linker's replay (12 ms a page on sinter-mail)
  and each page's whole shadow is still written in memory (50 ms a page); a unit kept per build would carry its
  check data once. Four things it found are under "For a decision".
- 2026-11-23, 17:20 UTC: the bugs under "For a decision" are to be fixed (decided): a choice's props not checked
  for being constant, `1.toFixed()`, a broken expression silencing every type error, a recursive component's errors
  twice, warnings counted as type errors, and the error in unrendered markup that stops unrolling without being
  reported. An agent has them, one commit each, a failing test first (`redesign-notes/bugs.md`); these change the
  output for the affected cases on purpose and leave the rest byte for byte.
- 2026-11-23, 17:45 UTC: embedding (decided, an agent has it; `redesign-notes/embed-fields.md`): a run-time
  expression that reads a value the build knows gets the value written into its code, so nothing is embedded for
  it; what cannot be written as a literal is embedded with only the paths read; what can escape stays whole. Today
  a post with a live section embeds the whole post as JSON (8,481 bytes of 20,345) for one read of `post.slug`.
  Stage 3, second change (merged): pages' and layouts' documents parsed once per process. Stage 4 has units on its
  branch (`units-spike`, not merged: it conflicts with the type check's changes to the check unit, one of its
  tests fails after a hand merge; the agent has the details): a first pass's definitions compiled once per build
  and placed on each page, the unit's objects shared. Its measurements, CPU ms per later page, linker's replay and
  placement: sinter-mail API 25.7 and 5.6, file email 34.7 and 7.4, blog with a page file per post 3.7 and under
  0.1; a sinter-mail API page's compile 67 to 38 ms. Compiling the unit's functions once per build bought little
  (20 to 18.5 ms): the evaluation's cost is collecting candidates and the worklist's run, which is stage 6.
- 2026-11-23, 18:30 UTC: **units are in** (stage 4, first part; `src/compiler/units.ts`, `SN_UNITS=0` off,
  `SN_UNITS_AUDIT=1`): a first pass's definitions are compiled once per build and placed on each page, the unit's
  objects shared and put back after each page. On the merged branch: 1,422 tests of test/compiler, test/vite and
  test/check pass, and `render-audit --switch SN_UNITS`, `pass-audit` and `mail-audit --switch SN_UNITS` report
  every file the same. The agent's CPU ms per later page, off and on: sinter-mail API 67 and 38 (with TypeScript 343
  and 63), file email 102 and 57, the components route 164 and 120 (its second pass still replays the library), the
  blog with a page file per post 19.8 and 15.7 (with TypeScript 44.7 and 20.9). Next there, in this order: a unit
  carries its check data once; second-pass units only if they pay; then a review before the linker is deleted
  (what it still covers is in `redesign-notes/stage4-units.md`). **Stage 3 stops short of its goal**
  (`redesign-notes/stage3-one-pass.md`): the second pass is not deleted, it is about 30% cheaper (6.2 to 4.3 ms a
  page): the minifier linear, documents parsed once, and a template's entries start their second pass from a copy of
  the kept expansion (`SN_ONE_PASS=0` off, `SN_ONE_PASS_AUDIT=1`, `scripts/pass-audit.mjs`). Deriving the second
  pass's result from the first's walk is not reachable byte for byte: a decided branch is compiled as a template in
  the first pass and as page markup in the second, `data-sn` ids after a block differ and are not compacted, and
  numbers sit inside code; it needs assembly with numbers handed out at the end (stage 5). A page file is still
  walked three times: its description needs every page's description first, a pipeline change. Started: the
  evaluation's cost (`redesign-notes/evaluation.md`), the largest item left per page (8 to 12 ms).
- 2026-11-23, 18:40 UTC: stage 4, where it stands (`redesign-notes/stage4-units.md`; the agent ran out of room and
  stopped with a design, no code since the merge). Check data once per unit is designed, not built: a page with a
  unit costs about 90 ms to check on top of `tsc` (15 its copy of the unit's check part, 39 its whole shadow, 36
  keying its functions by text), nearly all of it the unit's part, the same text on every page but for its numbers;
  the design holds a unit's part in the check unit by reference, then writes a part's shadow once per build. A new
  agent takes it after the bug fixes land, which change check diagnostics. Second-pass units are stage 5's: the
  components route replays the library in its second pass (25 to 30 ms a page, 71 with TypeScript), and sharing
  there has to survive `finishPage`; `anchors()` and `shareTemplates()` could run once per unit, but
  `compactTables()`, `groupStyles()`, `checkUrlArrays()` and `placeTemplates()` are the page's own assembly.
- 2026-11-23, 19:00 UTC: byte identity relaxed to "identical up to numbering" (see "How the work is run"); stage 5
  started, measuring and planning first (`redesign-notes/stage5-assembly.md`); new workstreams go to cloud sessions
  with a machine each, the first two started (table above); agents no longer run the full suite, the coordinating
  session does at each merge.
- 2026-11-23, 19:30 UTC: **dev renders** (merged; `redesign-notes/stage2-coverage.md`, "Dev renders"): dev compiles
  take the rendered route, the `dev` fallback (1,493 loops over the suite) is gone, the render audit compares dev
  results without the empty slots. It fixed three differences between the routes that builds had too: a chain root
  reached through a tag root in slot content was not marked for scoped styles; white space after a written text
  survived the minifier; a folded state's source-map site. No dev-server speed-up could be shown at this machine's
  load. **Embedding** (merged; `redesign-notes/embed-fields.md`): a read of a build-time value down to a primitive
  is written into the code in the second pass, what is left is embedded with only the keys read, what can escape
  stays whole; the benchmark's live post goes from 20,345 to 11,811 bytes with no JSON script, the live build's
  `dist/` from 2.33 to 1.44 MB; nothing else in any app changes. It also found and fixed a run-time bug: since URL
  templates compile to code, a `file:`, `content:` or entry value read in the browser was `null` in every build
  (the benchmark's comments request was never sent). Left whole: lists, `select`, dev, pages with `merge`/`upsert`/
  `remove`. **Bugs**, three of six merged: a choice's props must be constants; `(1).toFixed()`; a broken expression
  no longer silences every type error. **Stage 5** is measured and planned (`redesign-notes/stage5-assembly.md`) and
  its step 0, the canonicalizer (`src/compiler/canon.ts`, `SN_CANON=1`), is merged. What its numbers say: second-pass
  units are half the compile of a page that ships definitions (sinter-mail's components route: 110 to 139 of 276 to
  364 ms) and nothing elsewhere; the second pass is 42% of a large live page's compile and 20 to 30% of a blog
  page's; live uses from units would buy 3.5% of that live page and 7 to 11% of realworld, so they wait for a
  profile after the other two. Reserved number ranges are still out (the runtime reads a row's template from the
  loop index's name, and longer names ship); what the relaxed bar buys is the order numbers are handed out in.
- 2026-11-23, 19:45 UTC: on the integration branch after the merges above: 1,464 tests of test/compiler, test/vite,
  test/check pass. Four cloud sessions run (table under "How the work is run"): check data once, a page file
  walked once, B1, and A1, which first finishes step 0's oracle (the behaviour tests and sinter-mail's suite and
  bench under `SN_CANON=1`, not run yet). A caution from stage 5's measurements for every renumbering step:
  canonical function order makes each module of sinter-mail's components route 322 B gzip heavier (4.8%), so the
  canonical form is the oracle, not the order to ship. Still local: the evaluation's cost, bugs 4 to 6.
- 2026-11-23, 20:00 UTC: a cost of the embedding change, found by timing: each live post's early script now has
  the post's slug folded into it (and requests the comments early, which it never did: the value was `null`), so
  the benchmark's 100 early scripts are 100 distinct sources and 100 nested builds at about 13 ms each: the live
  template build went from about 4.2 to 5.1 s. A cloud session builds early scripts once per shape, the literals
  substituted afterwards (`redesign-notes/early-script-shapes.md`). The evaluation's first change (a row's template
  asked once, a row's scope a plain object: a 2,012-element email's evaluation 324 to 266 ms) conflicts with the
  merged bug fix in the worklist and went back to its agent. Check data once, part 1 (a page holds a unit's check
  part by reference) is pushed on its branch; no gain until part 2. Timings on the coordinating machine, load 8,
  three runs each, 100 posts: static 3.6 to 4.5 s, with the type check 3.8 s, live 5.1 s, a page file per post 4.4
  to 5.7 s, live 7.0 to 8.0 s.
- 2026-11-23, 20:30 UTC: **the six bugs are fixed and merged** (`redesign-notes/bugs.md`; a test, a fix and a
  changelog bullet each): a choice's props must be constants (it was worse than recorded: without images too, a
  rendered row wrote the state's first value as static text); `(1).toFixed()`; a broken expression no longer
  silences every type error (`tsc` skips semantic errors when any file has a syntax error: the build's shadows now
  leave broken expressions out); a component used inside itself reports each error once per use; the build counts
  errors and warnings apart; an error in markup decided away is reported. One behaviour to confirm with the owner:
  a build whose type check finds only warnings now prints them and passes (it failed before, counting them as
  errors); under `strict` it still fails. **The full suite passes on the integration branch** (2,905 tests, before
  bugs 4 to 6; 1,479 of test/compiler, test/vite, test/check after). **Quiet-machine times** (a cloud session, 4
  cores, nothing else running, 100 posts, medians of 3, at 5f203af, before embedding): static 3.04 s, with the type
  check 3.02 s, live 3.42 s, a page file per post 3.59 s, live 5.54 s; page-compile 361 to 419 ms. Astro: 2.2 s.
  **The canonical form holds as an oracle** (the A1 session): under `SN_CANON=1` every behaviour and browser test
  passes and 5 of 2,904 tests fail, each pinning a node id after a gap; sinter-mail's suite passes against canonical
  builds. The evaluation's first change is merged (a row's template asked once, a row's scope a plain object). Check
  data once has both parts on its branch (sinter-mail's 12 API pages with TypeScript 4.4 to 3.6 s on a quiet
  machine) and is re-verifying over the bug fixes.
- 2026-11-23, 20:45 UTC: **early scripts per shape, first milestone merged** (`redesign-notes/early-script-shapes.md`,
  `src/early-shapes.ts`, `SN_EARLY_SHAPES=0` off, `SN_EARLY_SHAPES_AUDIT=1`): pages whose early sources differ only
  in literals of one kind share one placeholder build, the first two of each group also built alone as a check.
  Nested builds for 100 live posts: 101 to 7 (400 posts: 401 to 10). The session's quiet-machine medians: live 4.01
  to 3.16 s, live with a page file per post 5.04 to 4.16 s; every app's files identical, the suite green under its
  audit (2,908). On the coordinating machine after the merge (load 6, three runs): static 2.9 to 3.4 s, live 3.1 to
  3.5 s, live with a page file per post 4.2 to 4.6 s; 1,482 tests of test/compiler, test/vite, test/check pass.
- 2026-11-23, 21:00 UTC: **early scripts per shape, done and merged** (the session's quiet-machine medians: 100
  live posts 4.27 to 3.24 s, with a page file each 5.31 to 4.32 s; 400: 13.4 to 9.7 s and 17.9 to 13.8 s;
  `generateBundle` 1,135 to 128 ms at 100 posts, and 439 to 186 ms at 400 with the entry chunk found through one
  index per bundle; one nested build is about 9 ms of Rolldown's own work, so their number is the lever). Its limit
  is under "For a decision". 1,482 tests of test/compiler, test/vite, test/check pass after the merge. A page file
  walked once: its first goal is pushed on its branch (a page of its own described off its head without a walk, 2.5
  to 3 ms to 0.2 ms a page; a page file per post 2.89 to 2.74 s on a quiet machine), and it found a bug in stage 3's
  kept-expansion route, fixed on that branch: `copyState` copied the options' objects, which the compiler compares
  by identity, so a template that uses a component library compiled its entries after the first differently. Check
  data once went back to its session for the conflict with bug fixes 4 to 6.
- 2026-11-23, 21:30 UTC: merged and done: **check data once** (`redesign-notes/stage4-check-once.md`; on a quiet
  machine the check step of sinter-mail's 12 API pages with TypeScript 1,087 to 525 ms, the build 4.08 to 3.44 s;
  the components route 6.30 to 5.38 s; the blog with a page file per post 4.79 to 4.23 s; reconciled by its session
  with the "once per use" fix) and **a page file described without a walk** (`redesign-notes/page-walked-once.md`,
  `SN_LATE_DESCRIBE=0` off, `SN_DESCRIBE_AUDIT=1`: 2.8 to 3.0 ms to 0.25 ms a page; a page file per post 2.85 to
  2.74 s, live 3.39 to 3.21 s; sinter-mail's audit pages 5.9 to 4.9 s; swap, embed, prerender 'auto', entries and
  signed-in pages keep the old description). With it, the fix of stage 3's kept-expansion route (`optionsReach`: a
  template using a component library compiled its entries after the first differently, silently) and a per-entry
  page in `mail-audit`. Three more evaluation changes merged (a kept template's program read once for its entries;
  `failsFirst`; a frozen helper result shared): a blog page's evaluation about 9.0 to 5.9 ms by the agent's medians.
  After these merges: 1,493 tests of test/compiler, test/vite, test/check pass; `pass-audit` nine apps the same,
  `mail-audit --switch SN_ONE_PASS` 48 files identical. **Astro on a quiet machine: 1.73 s** for the 100 posts (the
  2.2 s above was taken on the loaded machine), against about 3.0 s for the static blog. B1's first route is on its
  branch (a page of its own whose second pass applies only page-level decided branches and rendered rows takes its
  result from the first pass's walk, today's ids kept: page-compile 451 to 359 ms; none of the nine apps routed
  yet: template entries next; a page with a unit placed needs A1's copy); it went back to its session to merge the
  integration branch. Early scripts: the session was asked for a variant that can be proven (opaque placeholders).
- 2026-11-23, 21:45 UTC: A1 is built on its branch (`redesign-notes/stage5-a1.md`): a second pass that ships
  definitions places a unit of its own before its walk; sinter-mail's components route, a later page 108 to 72 ms
  (142 to 88 with TypeScript); sinter-mail's 42 files canonically identical, every other app byte for byte, gzip 17 B
  lighter in total; it fixed three leaks of first-pass units its verifier found. It merges the integration branch
  next. A session started on what a build costs outside the compiler (the fixed 1.1 s; a static page's 6 to 7 ms:
  Vite's HTML step, the cross check that runs every helper call again), now as large a share as the compiler.
- 2026-11-23, 22:00 UTC: **the full suite passes on the integration branch: 2,934 tests** (306 files), after check
  data once, a page described without a walk and the three evaluation changes. Two more evaluation changes merged
  after it (a frozen helper result shared; a page with a unit looks its codes up in the unit's table): 1,496 tests
  of test/compiler, test/vite, test/check pass.
- 2026-11-23, 22:10 UTC: **one consistent table on a quiet machine** (the page-walked-once session: 4 cores, Node
  22.23.5, idle, medians of 5, 100 posts, at 6a3283d; `redesign-notes/page-walked-once.md`): static 2.00 s, with the
  type check 2.14 s, live 2.39 s, a page file per post 2.40 s, live 2.96 s; Astro 7.4, three runs: 1.73 s. This
  morning: 13.6 to 16.8 s. A caution on the comparison: `run-sinter.mjs` reports the build's time inside its
  process, Astro's figure is a whole process; on the coordinating machine the whole process is about 0.2 s more than
  the in-process figure. The pipeline-2 session measures both like for like. So the static blog is 0.3 to 0.5 s
  behind Astro at 100 posts.
- 2026-11-23, 22:20 UTC: **early scripts per shape, proven and merged** (`redesign-notes/early-script-shapes.md`,
  "Proof"; the owner asked whether the sharing could be proven safe). The placeholder is now a free identifier the
  minifier knows nothing about, replaced in the built output by each page's literal: a correct minifier preserves
  the program for every value of a name it cannot know, the generated source only reads the name, and a literal put
  for a read-only free name is the program with that binding. The session checked the argument and closed the holes
  it found: Vite steps that read literal values (`import()`, `import.meta.glob`, `new URL(…, import.meta.url)`,
  workers, `require`: no lifting in such a program), `delete "x"`, directives and keys (not lifted), a string
  statement that could become a directive (parenthesized), `define` keys, `1.x`; the output is checked per shape
  (every occurrence of a name a reference, none written or declared, no `with`). No page of any app, of the
  suite's apps or of sinter-mail differs from its own build (1,000 benchmark pages audited); only a test's
  deliberate folds differ, by 3 to 19 bytes, with the same behaviour. Grouping by kind and length is gone, so 100
  or 400 live posts need 3 nested builds (7 and 10 before, 101 and 401 without sharing); `generateBundle` 70 ms at
  100 posts. `SN_EARLY_SHAPES=kinds` keeps the earlier scheme, `0` turns sharing off. 1,500 tests of test/compiler,
  test/vite, test/check pass after the merge.
- 2026-11-23, 22:35 UTC: **the evaluation's first round is done and merged** (`redesign-notes/evaluation.md`; five
  changes, byte for byte): CPU ms a page, base and now, the evaluation's mean and `compile()`'s: the blog 10.7 to 7.7
  and 16.9 to 12.8; with the type check 9.2 to 5.7 and 14.1 to 10.7; sinter-mail's file email 38.0 to 25.9; its
  2,012-element email 355 to 281; its API route 17.9 to 14.1. Garbage inside compiles 20 to 30% less. What is left
  there is one compiled-function call per binding per row through a proxy scope (131,000 bindings on the big email),
  rendering per row, and the library's own parse; a cloud session takes it as stage 6's evaluation: one function per
  template returning a row's values and decisions, a render plan per template. A rule it recorded as wrong goes to
  that session to fix: `known`'s exclusion of the current model's persisted path leaks into the worklist's last
  walk, so whether a persisted model's own field counts as known depends on where it is read (in no app or test).
  No agent is left on the coordinating machine; every workstream is a cloud session now.
- 2026-11-23, 22:50 UTC: **like for like on the coordinating machine, now idle** (load under 2; c4fa7e4; five runs
  each, medians; 100 posts; the whole process from start to exit, and in brackets the build's time inside it):
  static 2.65 s (2.49), with the type check 2.71 s (2.57), live 3.19 s (2.97), a page file per post 3.25 s (3.08),
  live 4.24 s (4.04); **Astro 7.4 cold, whole process: 2.05 s** (1.98 to 2.40). This machine is slower than the
  cloud sessions' (Astro 1.73 s there). So the static blog is 0.6 s behind Astro here, 1.29 times its time; the
  process outside the build is about 0.17 s of that.
- 2026-11-23, 23:00 UTC: **the build outside the compiler, first milestone merged** (`redesign-notes/pipeline-2.md`;
  1,504 tests of test/compiler, test/vite, test/check pass after it). Its measurement, like for like on a quiet
  machine (whole processes): the static blog 2.33 s, Astro 1.65 s (1.85 s without the compile cache its CLI turns
  on). **sinter's fixed part, about 1.1 s, is below Astro's, about 1.35 s; the gap is per page: 12.2 ms against about
  4** (the compiler's about 7, outside it about 5). Three fixes, byte for byte: SN521's scan of the page modules was
  quadratic with a page file per post (1.2 s at 1,000 page files); `pageStyles` scanned the helpers' import tree per
  page (0.33 ms a page); the project read twice, not four times. Coming as write-ups for a decision: the SN534
  cross check in a worker (0.2 s at 100 posts, 0.5 s at 400, but a build that fails SN534 would then have emptied
  `dist/`), Vite's HTML step for a static page (its parse of the body is 0.7 ms a page and it changes nothing in a
  static post: bypassing it is a decision), an on-disk cache for the fold check (110 ms). The check-data-once
  session is archived (done and merged).
- 2026-11-23, 23:15 UTC: **A1 is merged: definitions that ship come from a unit** (`redesign-notes/stage5-a1.md`,
  `SN_UNITS2=0` off, `SN_UNITS2_AUDIT=1`): a second pass with recursion points left in its tree places a unit of its
  own before its walk. The first step to use the relaxed bar: with it on and off, sinter-mail's components-route
  files differ in numbering only (7 of 48 raw; all 48 identical under `SN_CANON=1`, checked on the coordinating
  machine), every other app byte for byte (`render-audit --switch SN_UNITS2`: eight apps the same). The session's
  numbers on a quiet machine, sinter-mail's components route: a later page 108 to 72 ms (142 to 88 with TypeScript),
  the page that used to record 661 to 88; gzip 24 B lighter over the 48 files, three files 1 B heavier; sinter-mail's
  suite and run-time bench hold; the suite 2,945. It fixed a crash the merge exposed (a template's entry placed a
  unit in its second pass without giving it back: every such pass now goes through `unitPass`) and a substring test
  in stage 4's check of a page's file name. 1,515 tests of test/compiler, test/vite, test/check pass after the merge.
  The B1 session was told A1's copy has landed and asked to merge the integration branch before anything else.
- 2026-11-23, 23:30 UTC: **the build outside the compiler, done for what needs no decision** (merged;
  `redesign-notes/pipeline-2.md`). Like for like on a quiet machine, whole processes, 10 / 100 / 400 static posts:
  sinter 1.20 / 2.22 / 5.21 s, Astro 1.39 / 1.65 to 1.86 / 3.04 s. Fixed part about 1.2 s against 1.35 s; per page
  10.0 ms against 3.9, of sinter's about 6 the compiler's and 3.9 outside it (the new floor: 1.0 s and 3.9 ms a
  page). To be level at 100 posts the compiler has about 2.7 ms a page as things are, about 6 with the four
  decisions above taken; the library's own markdown parse is 1.8 of it. **B1, done for now on its branch**
  (`redesign-notes/stage5-b1.md`): a page of its own whose second pass would apply only page-level decided branches
  and rendered rows, with nothing folded into code that ships, takes its result from the first pass's walk, today's
  ids kept: page-compile 364 to 289 ms, byte for byte; 166 second passes routed over the suite. It does not move
  the benchmark yet: pages with a unit placed fall back (A1's copy has landed since), and template entries are off
  because copying the kept walk costs 7 ms against 3 saved. It conflicts with A1 and went back to its session to
  merge, then to take pages with units, and to see whether an entry can run on the kept walk in place.
- 2026-11-23, 23:45 UTC: decided by the owner: the Speculation Rules for apps with a page file per post (the same
  links prefetched, the list no longer in every page) and the fold check's on-disk cache go ahead; the pipeline
  session has both. The SN534 cross check and Vite's HTML step stay as they are.
- 2026-11-24, 00:00 UTC: **the full suite passes on the integration branch: 2,956 tests** (310 files), with A1, the
  proven early scripts, the pipeline fixes and the evaluation's five changes together; `render-audit` eight apps
  the same (the static blog 11.0 s with rendering off, 2.7 s on), `pass-audit` nine the same. **B1 is merged**
  (`redesign-notes/stage5-b1.md`, `SN_FROM_WALK=0` off, `SN_FROM_WALK_AUDIT=1`): a page of its own whose second pass
  would apply only page-level decided branches and rendered rows, with nothing folded into code that ships, takes
  its result from its first pass's walk, today's numbering kept. On the coordinating machine: page-compile 338 to
  278 ms (median of 9); `pass-audit --switch SN_FROM_WALK` nine apps the same; 1,534 tests of test/compiler,
  test/vite, test/check pass. The session's suite: 2,975, plain and audited (193 second passes routed; fallbacks:
  values folded 124, nothing decided 50, a loop unrolled the old way 49, rows and a layout 48, a unit placed 35).
  No app's build is routed yet: the blog's page files and realworld have a unit placed, the example sites rows and
  a layout, the blog's template entries go through the kept expansion. That session ran out of room and is
  archived; a new one continues from its log: template entries by a copy of the kept walk restricted to what an
  entry keeps (the whole copy costs 7 ms against 3 saved), pages with a unit, the folds.
- 2026-11-24, 00:20 UTC: **the Speculation Rules are folded, merged** (`redesign-notes/pipeline-2.md`,
  `SN_RULES_FOLD=0` gives the old output): from 16 plain paths in a rule, one URL pattern whose regular-expression
  group matches exactly the listed paths (a trie, branches with the same rest as character classes), exact for
  every URL and the same JSON on every page of a group, so the one CSP hash stays. Not folded, listed as before:
  percent-encoded, non-ASCII and syntax characters, segments that start with a dot, `:param` patterns, lists under
  16 (template apps unchanged). Rejected: a page listing only the pages it links to (a hash per page breaks CSP by
  hash). The session's evidence: Chromium's preload candidates the same for the list and the pattern over page
  files with prefetch-off pages, public files, near misses, script-added links, a `localePrefix` app, the real
  outputs of five apps, and 65 fuzzed sets (2,495 candidates). At 1,000 page files a page goes from 58.2 to 11.4 kB
  (gzip 6.6 to 1.3), the build outside the compiler from 10.3 to 6.3 s, the whole build from 19.4 to 15.1 s. Checked
  on the coordinating machine at 100 page files: a post 15,712 to 11,277 bytes (gzip 1,754 to 1,258), its rules
  script 4,683 to 248 bytes, the page identical apart from that script; 1,538 tests of test/compiler, test/vite,
  test/check pass. Next from that session: the fold check's cache. Stage 6 has four changes on its branch (a row's
  values in one call per template, its record an array; styles written at once; a `file:` value frozen once).
- 2026-11-24, 00:40 UTC: **stage 6's evaluation, first milestone merged** (`redesign-notes/stage6-eval.md`;
  `SN_ROW_FN=0` off, `SN_ROW_FN_AUDIT=1` compares every value, paint list and compile; `SN_FILE_COPY=0`). It measured
  first and found the evaluation proper was not the cost on the 2,012-element email: 131,520 compiled calls with
  their proxy are 22 of 355 ms; the style writes 88, the renderer's lookups 60, the walk's records 52. So: styles
  written once per element, a row's values from one function per template (a helper-calling code stays a call of
  its own), a row's record an array by the template's layout, paints read from the records, a `file:` value copied
  and frozen once per file. The session's numbers on an idle machine, ms a call, median: that email's first-pass
  evaluation 223 to 88, its compile 286 to 136, its second pass's prerender 8.2 to 0.24; the blog's evaluation
  unchanged (6.8 and 6.7: its cost is cloning and filling rows and the walk). Checked on the coordinating machine
  after the merge: 1,546 tests of test/compiler, test/vite, test/check pass; `render-audit` eight apps the same;
  `mail-audit --gen 2000` 48 files identical (that build 31.2 s with rendering off, 6.2 s as it is now). Next there:
  a render plan per template for the blog's rendering, the unit's candidates kept on the unit, the `own` bug.
- 2026-11-24, 01:00 UTC: **A1 and A2 are done and merged** (`redesign-notes/stage5-a1.md`). A2: a first pass that
  is its output is compiled again with a unit (not under the type check). Its audit found a bug of A1's (a
  definition's tag-attribute bindings made by the unit were renumbered in place for the next page), fixed with a
  test; pages with a source map place no second-pass unit (a shared function's site would move). The session's
  numbers on the merged tree: a later components-route page 97 to 66 ms (112 to 70 with TypeScript), a template's
  entry with a live tree 280 to 52 ms; its suite 2,980, the units audit and verifier over the whole suite with no
  difference, CI's link-audit job passing. Checked on the coordinating machine: 1,551 tests of test/compiler,
  test/vite, test/check pass; `mail-audit --switch SN_UNITS2` under `SN_CANON=1` 48 files identical; `render-audit
  --switch SN_UNITS2` eight apps the same. **The linker's review is ready** (`redesign-notes/stage4-units.md`, "What
  the linker still covers that units do not" and "What deleting it removes"): after A1 and A2 it still serves a
  unit's fallbacks (none in any app measured), a finished first pass under the type check, definitions reached
  first from a fill's case after the walk, description compiles past the threshold, and `SN_UNITS2=0`; deleting it
  removes about 330 of `link.ts`' 881 lines (the plan and its replay; the recorder stays, it makes the units), 40
  lines of `definition()`, the `definitions` options in `src/vite.ts`, 60 lines of the audit in `index.ts`, six test
  files (703 lines) and the CI job. It waits for the owner.
- 2026-11-23, 22:30 UTC by the machine's clock (the times of the entries above ran about three hours ahead of it;
  their order is right): **the full suite passes at `22152eb`: 2,992 tests, 312 files**; `pass-audit` nine apps the
  same. **The fold check's on-disk cache is merged** (`redesign-notes/pipeline-2.md`; `SN_FOLD_CACHE=0` off): the
  check's analyses are kept under `node_modules/.cache` by the modules' text, the session's `foldVerdicts` 106 to
  132 ms cold, 4 to 9 ms warm, output identical with and without; 1,552 tests of test/compiler, test/vite,
  test/check and the cache's 7 pass after the merge (`de23476`). With it both pipeline decisions the owner took
  (3 and 4) are in. **A timing scare, not a regression.** Five whole-process runs at `de23476` gave medians of
  static 3.03 s, typecheck 3.32, live 3.36, page per file 3.60 and 4.20, Astro 1.95, against 2.65 s for static in
  the 22:50 entry with Astro the same, which read as 0.4 s lost. Switching each recent stage off in turn
  (`SN_FROM_WALK`, `SN_RULES_FOLD`, `SN_UNITS2`, `SN_ROW_FN`) showed nothing, so five revisions were built side by
  side and timed interleaved against the same app, six rounds, in-process ms, median: static `c4fa7e4` 2,529,
  `e23cae1` 2,483, `7e210e5` 2,520, `c32efa4` 2,486, `de23476` 2,368; page per file 3,091, 3,029, 3,246, 3,261,
  3,024. Then whole process, seven interleaved rounds: `c4fa7e4` 3.00 s, `de23476` 2.85 s static and 3.11 s live,
  Astro 1.92 s. So nothing merged since `c4fa7e4` cost time and the head is the fastest of the five; this machine's
  speed moves by 10 to 20 percent between runs minutes apart, and a figure from one run cannot be set against a
  figure from another. **From here a timing in this log is only a comparison when both sides were run interleaved
  in the same rounds.** On this machine today that is static 2.85 s and live 3.11 s against Astro's 1.92 s; the
  quiet machine's figures (2.22 s against 1.65 to 1.86 s, the 23:30 entry) stand as the better measure of the gap.
- 2026-11-23, 22:55 UTC: **stage 5's B1 continued, first milestone merged** (`redesign-notes/stage5-b1.md` §11 to
  §14; `SN_FROM_WALK=0` off). Pages with a unit placed now take the route from the first pass's walk (the unit's
  objects are touched and given back, a unit's definition the page keeps refuses the route, what placing the unit
  added to the page's tables is taken out like a dropped walk), and pages with folds do where no shipped function
  reads a folded value (`shipsFold`; else compiled the old way). It fixed a bug of the route on the way (the unit's
  journal `touched` cut as if it were a table). In the suite 227 compiles take the route (193 before), "values
  folded" as a refusal 124 to 16; the blog's page per file 100 of 100. The session's numbers, compiler ms a page
  from a CPU profile, 100 posts: page per file static 15.3 to 12.3, live 14.9 to 13.3; the template variants and
  page-compile unchanged. Its checks: suite 2,995 plain and under `SN_FROM_WALK_AUDIT=1`, the render, link and
  one-pass audits, `pass-audit` byte-identical except one state number in the live page-per-file app (a dead unit
  took `$s0`: the one use so far of the freedom in numbering). Checked on the coordinating machine after the merge
  (`da15772`): 1,562 tests of test/compiler, test/vite, test/check pass; `render-audit --switch SN_FROM_WALK
  --canon` eight apps the same; `mail-audit --switch SN_FROM_WALK` under `SN_CANON=1` 48 files byte for byte.
  Interleaved, whole process, six rounds, median: page per file static 2.89 s with the route, 3.10 s without; live
  3.40 s and 3.72 s; the template's static 2.59 s; Astro 1.82 s. **Template entries are measured and not built**
  (§13): a copy of a second pass's walked state costs 2.8 ms an entry against the 2.4 ms the second pass takes, so
  no design that copies per entry pays; doing it in place with a journal over all of `finishPage` would save under
  0.9 ms an entry, and live entries need the folds' holes. So for a template's entries the second pass stays as
  the cheaper route until the walk itself is cheaper (stage 6's ground). §14 lists what deleting the second pass
  (B2) still needs: rendered rows with a layout (84 compiles in the suite), unrolled loops (65 and 35), prefold
  (38), entries. Next there: rendered rows and a layout. Also from a profile of the 400-post static build at
  `de23476` (6.5 s): the compiler 3.6 s, of it the first pass's deciding 2.2 s and the second pass 1.05 s; the
  garbage collector 0.76 s; Vite's own code 0.74 s; the markdown parser 0.36 s.
- 2026-11-23, 23:15 UTC: **stage 6's evaluation is done and merged** (`redesign-notes/stage6-eval.md`, top and "The
  end"; `246d90e`). Since its first milestone: the render plan (a template's content copied from a flat list, a
  node's copy by its place), the unit's candidates read once for the build (`SN_UNIT_CANDS=0`), a `file:` value's
  heights measured once (`SN_FROZEN_HEIGHTS=0`), two questions asked once per binding, and the `own` bug fixed as a
  guard (`bugs.md` 7: provably masked, no output could change; a test pins it). The session's numbers, wall ms, 25th
  percentile, before against after with its ten commits reverted on the same tree, output byte-identical:
  sinter-mail's 2,012-element email's first-pass evaluation 231 to 79, its compile 302 to 135, its build 6.2 to
  4.2 s; the 200-element one 38 to 16; the file email 15.9 to 12.6; the API page's first pass 7.0 to 4.8 (its
  second pass 8.3 unchanged: its own codes are compiled per page). **The blog did not move** (static `decideFor`
  5.72 to 5.50 ms a page): its cost is the library's parse, the data checks and the walk's and renderer's work per
  node, not the evaluation of bindings (1,063 a page). Its checks: full suite 3,002 before its last merge, every
  bench app, example and sinter-mail page byte-identical at each merge. Checked on the coordinating machine after
  the merge: 1,564 tests of test/compiler, test/vite, test/check pass; `render-audit --switch SN_ROW_FN --canon`
  eight apps the same; `mail-audit --switch SN_ROW_FN --gen 2000` under `SN_CANON=1` 48 files byte for byte.
  **What that leaves for the benchmark against Astro**: a blog post costs the compiler about 8 to 9 ms (deciding
  5.5, the second pass 2.4) and the build about 4 ms more outside it, against Astro's 3.9 ms a page for everything.
  The session continues on the blog's per-node walk and render (a fill plan, the decisions' keys only where the
  second pass compiles a loop), measured part by part first, target the compiler under 4 ms a page on the static
  template variant, and was asked to commit its measuring tools. Outside the compiler the two decisions not taken
  (the SN534 cross check, Vite's HTML step) are now a larger share of what is left.
- 2026-11-23, 23:25 UTC: **the full suite passes at `246d90e`: 3,005 tests, 314 files**; `pass-audit` nine apps
  the same. The stage 6 session's measuring tools are committed (`bench/tools/`, with a README: the method wrapper,
  the interleaved A/B, the profile readers, the byte comparison, sinter-mail's apps) and merged (`0ca7df5`). Whole
  process, 100 posts, seven interleaved rounds on the coordinating machine, median: static 2.38 s, with the type
  check 2.46 s, live 2.67 s, a page file per post 2.80 s static and 3.30 s live; Astro 1.72 s.
- 2026-11-23, 23:35 UTC: **stage 5's B1 continued, second milestone merged** (`redesign-notes/stage5-b1.md` §11 to
  §15; `2e00858`). Rendered rows under the minifier with a layout take the route from the first pass's walk
  (`respaceRows`: the minifier's white-space rule applied again at the rows' edges, the rows' paints shown as
  bindings; refused where a bound element is around or beside the rows). A bug of the route it exposed is fixed: an
  embedded resource's id (its `<sn-resource>` removed by the walk) was not renumbered and could collide with an
  element's; it is numbered where its element stood. In the suite 320 second passes take the route (193 when the
  session started), "rows and a layout" as a refusal 48 to 8; a template's entry compiled alone routes. Its checks:
  suite 3,008 plain and under `SN_FROM_WALK_AUDIT=1`, the render, link and one-pass audits. Checked on the
  coordinating machine after the merge: 1,567 tests of test/compiler, test/vite, test/check pass; `render-audit
  --switch SN_FROM_WALK --canon` eight apps the same; `mail-audit --switch SN_FROM_WALK` under `SN_CANON=1` 48
  files byte for byte. Still refused: a page whose own layout reads it without the rows (styles and images:
  `planSpace`, the image pipeline, the dry run), which is the examples' 12 pages. Next there: that written up
  precisely, then loops unrolled the old way (100 in the suite).
- 2026-11-23, 23:45 UTC: **stage 6 continued, the blog measured part by part and two steps merged**
  (`redesign-notes/stage6-eval.md`, "Round 2"; `2c9a08d`). Where a blog post's compile goes (a profile at 50 µs,
  ms a page under the profiler, which inflates by about 1.5; 15.9 in all, 8.6 ms wall at the 25th percentile): the
  first pass's deciding 8.8, of it the post's `md.parse` 2.8 (markdown-it and the tree; not the compiler's), the
  data checks 1.6, the walk 2.6, rendering 2.5 (`fill`'s own 0.84, `clone` 0.61), the rest 0.6; the second pass
  from the kept walk 4.0 (`walkChildren` 2.3, a definition compiled 0.86, the minifier 0.78); `keepTemplate`,
  `copyState` and the rest 3.1. Nothing in the deciding is above 0.9: it is work per node everywhere. The steps: a
  frozen object's height kept where it is frozen (`plainData` no longer walks a helper's tree), and what `fill`
  asks of each node asked once per template (`nodeInfo`, `ifInfo`, `forInfo`), `constantSources` and the written
  state once per evaluation. Its numbers, seven interleaved rounds against `0efedb8`: the blog's `decideFor` 5.06 to
  4.72 ms at the 25th percentile (median 6.00 to 5.50), `compile()` 7.82 to 7.41; the 2,012-element email's first
  pass 70 to 66; output byte-identical. Checked on the coordinating machine after the merge: 1,567 tests of
  test/compiler, test/vite, test/check pass; `render-audit --switch SN_ROW_FN --canon` eight apps the same;
  `mail-audit --switch SN_ROW_FN` under `SN_CANON=1` 48 files byte for byte. **How close**: about 7.4 ms a page
  against the 4 ms target, of which the library's parse is nearly 2. Shaving per-node work gives a few percent a
  step; the coordinator asked the session to assess a larger step before going on: a rendered row that keeps
  nothing live written as markup text from a plan per template, not as nodes that are cloned, walked again by the
  second pass, minified and serialized.
- 2026-11-23, 23:58 UTC: **the full suite passes at `03658b3`: 3,008 tests, 314 files. Stage 5's B1 continued,
  third milestone merged** (`redesign-notes/stage5-b1.md` §16 and §17; `06abf41`): rendered rows under the page's
  own layout take the route where nothing the layout sizes is beside them (`layoutAround` refuses beside an image, a
  video, a frame, an object, a list whose space was planned, or under a `:has()` rule). The examples route now
  (static-site 4 of 6 pages, multilingual-site 8 of 8); in the suite 325 second passes take the route (193 when the
  session started). Its numbers, the compiler's ms from CPU profiles, base `22152eb`: a page file per post 15.3 to
  12.3 static and 14.9 to 13.3 live; static-site 197 to 178 a build, multilingual-site 128 to 115; the template
  variants, realworld and dashboard unchanged (not routed). Its checks: 3,010 tests plain and under
  `SN_FROM_WALK_AUDIT=1`, sinter-mail's suite and bench. Checked on the coordinating machine after the merge: 1,569
  tests of test/compiler, test/vite, test/check pass; `render-audit --switch SN_FROM_WALK --canon` eight apps the
  same; `mail-audit --switch SN_FROM_WALK` under `SN_CANON=1` 48 files byte for byte. **How far the second pass is
  from deletable** (§17, a table by reason for the suite, the apps and sinter-mail): in the apps it is left for a
  template's entries (the blog's 300 pages), constants the layout or the images read (8 pages: static-site 2,
  sinter-mail 6), a resource read only in a dropped branch whose warning the second pass reports (sinter-mail 6),
  one unit case (sinter-mail 1) and one page of realworld whose branch is not recorded; in the suite besides those:
  loops unrolled and not rendered (67 and 35: stage 2's old row route), nothing decided (51, needs no second pass),
  not recorded (33), and small groups (code or a definition first compiled in a dropped branch 18 + 9 + 4, folds
  that ship 9 + 7, choices 9, a unit's definition kept 6). The session goes on with those toward B2; the template's
  entries wait for stage 6's assessment of rows as text, which would make the kept walk small enough to copy.
