# Stage 3: one compile per page

Running log (2026-11-23). Goal ([compile-units.md](../compile-units.md), stage 3): the second pass goes; what the
first pass decided is applied to its own result. Before structural work, what the second pass of a page whose blocks
were rendered still does, measured exactly, and the cheap things in it removed, byte for byte.

## How it is measured

- The preload of [floor.md](floor.md) (`instr.mjs`, `hooks.mjs`, `run.mjs`, `med.mjs`), copied to
  `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/stage3-agent/` and pointed at this
  worktree, `time` mode with the thread's CPU clock (`SN_CLOCK=cpu`: what the main thread spent, GC pauses on it
  included, the other agents' load not). `ab.sh` alternates saved `dist/`s round after round; tables give the median
  of 3 rounds, ms a page. The thread clock moves in ticks, so a phase called a few times a page reads 0 when it is
  cheap: compare phases that are a millisecond or more. `--cpu-prof --no-turbo-inlining` profiles say what is inside a
  phase (`under.mjs`, `tree.mjs` there: inclusive time per function below a frame).
- Byte identity: `identab.sh <dist>...` builds the five benchmark apps (100 posts) and the four examples with each
  saved `dist/`, `ident.mjs diff` compares two builds file by file.
- The machine: 4 cores, load average 14 to 18 while these were taken (other agents' builds).

## What the second pass of a rendered page does (`650f0e7`, static, 100 entries of one template)

`time` mode, CPU clock, ms a page; calls a page:

| phase | ms | calls |
| --- | ---: | ---: |
| pass 2 `walkPage` | 5.9 | 1 |
| `minify` (of it `minifyMarkup` 2.0) | 2.2 | 1 |
| `walkChildren` (`element` ×11: the page's own markup) | 0.9 | 10 |
| `expandComponents` (`expandUse` ×4, `choice` ×1) | 0.7 | 20 |
| `parseDocument` | 0.5 | 1 |
| `slotsPlaced` (`fileGraph` of 25 components) | 0.2 | 1 |
| `expandConstants` (the splice) | 0.15 | 11 |
| `accessible`, `strayAndRepeated`, `declare`, `canonical`, … | ≤ 0.1 each | |
| pass 2 `finishPage` (`serialize` most of it) | 0.5 | 1 |

After expansion the second pass's tree has 30 nodes (11 in templates): nothing but the minifier visits the rendered
block's ~2,000 nodes. `walkChildren` and `declare` skip it (`renderedAt`), `accessible` and `strayAndRepeated` run
before the splice. The profiles' larger figures for `walkChildren` (3.1 ms) were wall-clock samples under load, and
the walk in them included the kept template's own walk (`keepTemplate`, once a template).

So of the second pass, the minifier over the block is the only item that grows with the post; the rest is the
page's own markup (a dozen elements, its four components) compiled again per entry, about 3.5 ms.

## Changes

### 1. The minifier's layout questions, linear (`collapsesSpace`, `spaces`)

What the minifier asked of the layout for each of the block's elements (profile, static, under `minifyMarkup`):
`collapsesSpace` 51 % (each element walks its ancestors to the root, `cascaded` at each, in each view: quadratic in
the depth), `breakpoints` (every `everyView` reads every rule's media again), `childLayout`/`edgesStartLines` for
every element whose children are all elements.

- `collapsesSpace` answers per view and element (`wsMemo`): an element that decides nothing answers as its parent,
  so the walk to the root happens once per page. And when no rule declares `white-space` or `white-space-collapse`
  (`wsDeclared`, by the rules: the browser's own styles do not), an element with no `style` and no `data-sn-style`
  decides nothing without its declarations being matched. Not while a traced read logs what it reads (`reading`).
- `breakpoints()` is kept by the rules and the media base (`BREAKPOINTS`).
- `spaces` returns at once for an element with no text child (nothing to do; it asked the layout for the element's
  `childLayout` and `edgesStartLines` first), and asks `edgesStartLines` only when a text reaches an edge.

Every answer is the one the old code gave (the same questions, in the same views, of an unchanged tree); the layout's
caches are per element already (`cascades`), so the new ones are as valid as those.

CPU clock, median of 3 rounds A/B (`650f0e7` → this), ms a page:

| phase | static | live | static-files | live-files | static, type check |
| --- | ---: | ---: | ---: | ---: | ---: |
| `compile()`, build | 18.7 → 14.8 | 20.7 → 18.0 | 27.6 → 26.6 | 32.5 → 27.7 | 20.5 → 19.5 |
| pass 2 `walkPage` | 6.4 → 4.0 | 7.1 → 4.8 | 5.3 → 3.9 | 6.4 → 4.6 | 6.5 → 5.3 |
| of it `minify` | 2.7 → 0.7 | 2.6 → 0.7 | 1.7 → 0.7 | 2.5 → 0.9 | 2.6 → 0.8 |
| GC inside the compiles | 9.1 → 6.3 | 6.9 → 8.1 | 14.2 → 10.1 | 10.6 → 11.9 | 6.7 → 4.8 |

(Rows other than `minify` move by a millisecond from round to round at this load; `minify` moved the same way in
every round.) The nine apps are byte for byte the same; test/compiler and test/vite pass (1,334).

### 2. Pages' and layouts' documents parsed once per process (`parsedDocument`)

`parseDocument` parses a page three times (the document, again with the head blanked, the head's content as a
fragment): 0.4 ms for the benchmark's 400-byte page. A template's 100 entries parse the same text in each second
pass; a page file is parsed by its description and by both passes. The parsed document is now kept by its text (as
`parsedText` keeps components', cleared at 500 texts) and each compile takes a copy (`copyParsed`: every node and
attribute a new object, the positions shared, each property where the parser put one, so a document or a fragment
still has no `parentNode`). Nothing changes a position object (one place assigns a node a recorded one).

CPU clock, median of 3 rounds A/B (change 1 → this), ms a page: static pass 2 `walkPage` 4.2 → 3.6, `compile()`
16.2 → 14.8; static-files pass 2 `walkPage` 3.9 → 3.2, pass 1 `walkPage` 9.8 → 8.6, `compile()` 26.9 → 23.3. The
nine apps byte for byte the same.

## A template's entries: what differs between the kept first pass and the second pass's result

`fromTemplate` keeps one walked first pass per `<html data-sn-for>` template and evaluates it per entry
(`decideFor`); each entry's second pass is then a whole `Compiler` from the page's source. Read off the benchmark's
post template (`md-doc` → `$build` chooses `<md-tree>`, whose loop over the document's nodes is rendered):

| | kept first pass (walked, not finished) | second pass's result |
| --- | --- | --- |
| tree | the `$build` `if` and its `else` as templates; the loop as a row template; each `<sn-component use>` candidate (26 of the library's components) a shared definition | the kept branch's markup in place (as page markup, not template content), the block in place of the loop, no definitions |
| `data-sn` ids | handed out in the walk to the page's bound elements and anchors | handed out in the second walk, with the block's count added at its first element; not compacted, so every id after a decided branch or a block differs |
| functions | the definitions', the row templates', the branches', the page's | the page's own, the loop's list (compiled once at the block for its diagnostics, then dropped); `compactTables` renumbers by first use in the IR |
| constants the layout reads (`constants`) | evaluated, not written | written before the layout (`prefold`), which changes the markup the minifier, the layout and the ids see |
| SN501, `foldedText` | none of the decisions' | the decided conditions' and the block's reads |
| per entry | the entry's value swapped in (`fileData`), nothing written | its `data-sn-path` on `<html>` (`pagesOf`), the canonical link, the title and other first paints, the entry's JSON (live) |

So the second pass's result is not the kept walk patched: a decided branch's content was compiled in the first pass as
a template (paths from the template, its nodes in `templates`, a wrapper `t.a`), in the second as the page's markup
(`data-sn` ids, `roots`), so its bindings would have to be compiled again, which is the walk; and the walk's results
are spread over the compiler's fields with numbers inside code text (`$i<n>`, `$p<tid>`, `$s<sid>`), where
compaction covers templates and functions only. A copy of the walked first pass per entry would also cost what it
holds: for the benchmark, the library's definitions. Not reachable byte for byte here; what is, is the second
option: the second pass from a copy of the expanded, unwalked tree.

### 3. The second pass of a template's entries from the kept expansion (`keptExpansion`, `secondPass`)

`walkPage` is now `expandPage` (parse, layout, `pagesOf`, `expandComponents`, the expanded tree's checks:
`emptyStates`, `strayAndRepeated`, `accessible`, `slotsPlaced`) and `walkExpanded` (from `expandConstants` on). Nothing
in `expandPage` reads the decisions (`decided`, `unrolled`, `constants`, `rendered`) or whether the pass collects them
(`keepsAttrs` moved to `walkExpanded`, its first reader), and the first pass expands as the second does
(decisions.md §0). So `keepTemplate` copies its compiler after `expandPage` (`copyState`) before its walk goes on, and
each entry's second pass copies that copy again with its own options, writes its own path on `<html>` (`forEntry`:
the one thing `expandPage` writes from the entry) and goes on with `walkExpanded` and `finishPage`.

`copyState` is a deep copy of the compiler's fields: each object once (what shares what stays shared), arrays, maps,
sets and plain objects (parse5's nodes are plain objects), every `WeakMap`/`WeakSet` field and the module's node
marks (`WRITTEN`, `SHOWN`, `SCOPED`, `MARKED`, `REWROTE`, `RENDERED_FILE`, `OWN_SCRIPTS`, `INERT_FILLS`) for the
objects copied. Shared, never changed by a compile: the options, the component files' parsed markup (`SHARED`, marked
when `parsedText` parses it), functions, frozen values. A value of any other class refuses the copy (a counted
reason). The first copy looks every copied object up in every weak table (about 30,000 lookups for the benchmark's
600 objects); it lists what it found (`WeakEntries`), and the entries' copies copy those lists instead.

- Switch: `SN_ONE_PASS=0` (nothing kept, every second pass from the source). Log: `SN_PASS_LOG=1` prints at exit
  how many second passes started from a kept expansion and why the others parsed the page again;
  `SN_PASS_STATS=<file>` appends a line per second pass (with the test's name under vitest).
- Audit: `SN_ONE_PASS_AUDIT=1` compiles each entry the old way beside it and compares the whole `CompiledParts`. The
  old way evaluates the entry again first (`decideFor`): a second pass splices the rendered blocks it is handed and
  changes them (the image pipeline rewrites a block's `<img>`), so the two cannot share them. The first version of
  the audit did, and reported a difference that was the audit's own (template-pass.test.ts, images in a tree).
- Reasons a second pass parses and expands again: `off`, `a page of its own` (not a template's entry: every page
  file, the examples' pages), `an entry compiled alone` (its template's kept walk declines it: nothing decided, a
  constant the layout reads written into the first pass's markup, errors, a program that differs per entry), `an
  entry, no kept templates` (no `templates` cache: the probe, tests), and a refused copy (`a <class> in the state`,
  never seen).
- Tests: test/compiler/one-pass.test.ts (both ways equal and the route taken: a rendered tree, live parts beside it,
  a layout and a decided branch at the top; each reason; under the audit).

CPU clock, median of 3 rounds A/B (change 2 → this), ms a page; the second pass as `run` before and `secondPass`
(the copy included) after:

| | static | live | static, type check |
| --- | ---: | ---: | ---: |
| second pass | 4.07 → 3.39 | 6.41 → 6.13 | 4.97 → 3.56 |
| of it the copy (`copyState`) | – → 0.46 | – → 0.55 | – → 0.77 |
| `compile()`, build | 14.1 → 13.8 | 18.2 → 18.7 | 16.6 → 13.9 |

The copy takes about half of what the expansion cost (`expandComponents` 0.6 to 0.9, `slotsPlaced` 0.25, the rest
0.2). `scripts/pass-audit.mjs` (the five benchmark apps and the four examples, the route off and on): every file the
same; the template apps take the route for all 100 entries.

Checks: the whole suite passes (2,857); test/compiler and test/vite pass under `SN_ONE_PASS_AUDIT=1` (1,342, with
one-pass.test.ts) and test/compiler under `SN_RENDER_AUDIT=1` (1,061); under `SN_LINK_AUDIT=1` the link-review cases
that failed at a load of 22 time out the same with the route off and pass alone. sinter-mail
(`node scripts/mail-audit.mjs <copy> --switch SN_ONE_PASS`, a switch the script now takes): 42 files identical; its 16
pages are pages of their own (no template), so none takes the route.

Second passes over the whole suite by route (`SN_PASS_STATS`): `a page of its own` 1,893, `an entry, no kept
templates` 48, `kept` 46, `an entry compiled alone` 21, `off` 15 (one-pass.test.ts's own).

### Tried and not taken: a page of its own from its first pass's expansion

The same copy serves any page compiled twice: its second pass's expansion is its first pass's. `compilePasses` copied
the first pass after `expandPage` and the second pass went on from the copy (taken as it is, used once). Over the
suite under `SN_ONE_PASS_AUDIT=1` every one of 472 second passes took it and was the same. But a page of its own copies
once and without a listing, so it pays the lookup of every object in every weak table: for a page file of the
benchmark 0.7 to 1.0 ms, against 1.1 to 1.3 ms of expansion saved (CPU clock, 3 rounds A/B: second pass 4.1 to 4.7 →
3.2 plus the copy 0.7 to 1.0; `compile()` 23.6 to 25.5 → 24.3 to 29.1 at a load of 20 to 28). Within the noise, and a
page with nothing decided pays the copy for nothing, so it is not committed (a copy of the code: `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/stage3-agent/compile.change4.ts`, until the scratch space is cleared). A copy that knew which tables a node can be in (most are keyed by nodes, a few by `Use`,
`NodeDef`, `Binding` or fill chains) would cost about a third; that is the step that would make it pay.

## A page file per post: fewer than three walks (not done)

A page file is compiled three times: its description (`describeOnly`, vite's `describe`), and the page's two passes.
What blocks reading the description off the real compile's first pass, as `templates` keeps a template's:

- **The order.** Every page's compile needs every page's description first (pipeline-fixes.md, "The description per
  page"): whether the module imports the prefetch module, the Speculation Rules, links resolved against every page's
  patterns. vite describes all pages at the first page's compile (`appPages()`, `pageEntries()`). Keeping each page's
  first pass from then until its own compile holds 100 walked compilers (each with the library's 65 definitions
  compiled into it); or the cross-page parts become placeholders filled in `generateBundle`, which is a change of the
  build pipeline in `src/vite.ts` and of what the compiler writes, not of the passes.
- **Not the same compile.** A description is one pass that evaluates nothing and leaves out the definitions that
  describe nothing (`describesNothing`): its expansion is not the first pass's, so it cannot be kept for it either,
  and its fields (`prefetch`, `path`, `permanent`, `keptSource`, `keptBound`, `swapOff`, `loadEffect`) come from its
  own `finishPage`, where the build's come from the second pass. That they agree is not established; an audit like
  the template probe's (pipeline-fixes.md, section 3) would have to show it over the suite and the apps first.
- What did help page files here: change 2 (the description and both passes parse the page once), change 1 (their
  second pass's minifier).

## What is left before the second pass can be deleted

- A template's entry still walks its page's own markup in a second pass (`walkExpanded`: the splice, the minifier
  over the block, the layout, the walk of a dozen elements, `finishPage`), about 2.3 ms plus the copy; a page of its
  own walks its page twice. Deleting the second pass needs the first pass's walk to be the page's, with the
  decisions applied to its result: the analysis above says what that means (a decided branch's content compiled as
  page markup, not as a template; `data-sn` ids handed out after the blocks; the dropped definitions and templates
  compacted, which `compactTables` does for functions and templates only). That is assembly (compile-units.md, item
  5): numbers handed out once, at the end. It needs the walk to compile a branch's content before knowing whether it
  is a template's or the page's, which is stage 5's per-unit compile, not something stage 3 can patch in.
- Until then the route is a cost saving, and its fallbacks are what the second pass still does on its own: `a page of
  its own` (every page that is not a template's entry: 1,893 second passes over the suite, every page file of the
  benchmark, every page of the examples and of sinter-mail).

## Where it stands (`6c96a7a`)

CPU clock, median of 3 rounds A/B against `650f0e7`, ms a page; the second pass whole (`run` before; `secondPass`,
the copy included, for a template's entries after), load average 21 to 28 during the rounds:

| | static | live | static-files | live-files | static, type check |
| --- | ---: | ---: | ---: | ---: | ---: |
| second pass | 6.2 → 4.3 | 8.3 → 6.4 | 5.9 → 4.3 | 7.1 → 5.5 | 6.8 → 3.8 |
| of it the minifier | 2.2 → 1.0 | 2.3 → 1.0 | 1.9 → 0.7 | 2.2 → 0.7 | 2.4 → 0.6 |
| of it the copy | – → 0.6 | – → 0.9 | – | – | – → 0.5 |
| `compile()`, build | 16.7 → 15.7 | 19.8 → 17.6 | 25.7 → 26.5 | 27.6 → 26.4 | 18.3 → 14.4 |
| first pass's evaluation (`decideFor`, `settle`) | 9.0 → 10.4 | 10.0 → 10.0 | 10.7 → 12.3 | 10.3 → 10.9 | 9.7 → 8.9 |

(The evaluation is not changed by any of this; its rows say how much a phase moves from one round to the next at this
load.) Whole builds (`run-sinter.mjs`, 3 rounds back to back, base and now): at a load of 21 to 28 a build of the same
`dist/` took 7.5 s in one round and 16.2 s in the next, so they say nothing here; the CPU-clock tables are the
measurement.
