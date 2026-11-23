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
| a unit's check data once (stage 4, step 3) | cloud, `session_01AjKzdxUhXTUw7iSJ32w1x1` | `redesign/check-data-once` | `stage4-check-once.md` |
| a page file walked once (stage 3's leftover) | cloud, `session_01AjKze2EoiDyjazXQrsWJQk` | `redesign/page-walked-once` | `page-walked-once.md` |
| stage 5, A1 then A2: definitions that ship, from units | cloud, `session_01AjKzdxPCdJ5nbeXvwkXoP2` | `redesign/stage5-a1` | `stage5-a1.md` |
| stage 5, B1: the second pass from the first's walk | cloud, `session_01AjKzdxkDukbMzASz1qaYeA` | `redesign/stage5-b1` | `stage5-b1.md` |
| the evaluation's cost | local agent | merged as it lands | `evaluation.md` |
| the six bugs (three merged) | local agent | merged as they land | `bugs.md` |
| early scripts built once per shape | cloud, `session_01AjKzdxPErYYZv1d2K1hMsD` | `redesign/early-script-shapes` | `early-script-shapes.md` |

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
