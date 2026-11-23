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

## Stages

Each is general (pages with live parts gain what their constant parts cost), measured on `bench/astro`, and lands
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

Outside the compiler, measured in `redesign-notes/profile.md`: what a build costs when `compile` is free.

## For a decision

Found by the research, not changed:

- **An error in markup that is never rendered stops unrolling.** An SN201 inside `data-sn-if="false"` is not reported,
  yet it keeps an unrelated loop over constants from unrolling, so the page ships a module (`decisions.md` §7.1).
- **A choice's props are not checked for being constant.** With `images` on, an `<img>` whose `src` comes from written
  state through a `<sn-component use>` prop is folded to a static `<picture>`; the same component used by its tag keeps
  its binding (`decisions.md` §7.3).
- **Linking is off whenever the build type-checks** (`contract.md` §4), which is every build with TypeScript installed.
- **Props as a run-time frame.** Binding a live use's props at run time, as shared definitions do, would make a
  unit's code independent of its use with no holes, at the price of a changed IR and other bytes. Not planned: the
  holes keep the output, and the runtime, as they are.

## Status log

- 2026-11-23: benchmark (`bench/astro`), research notes, this design. Stage 1 started as a spike in a worktree.
