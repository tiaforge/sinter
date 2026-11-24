# Stage 4, step 3: a unit carries its type-check data once

Running log, branch `redesign/check-data-once` (from 09d202f). The design is
[stage4-units.md](stage4-units.md), "Step 3 (a unit's check data once)"; how the check works,
[typecheck.md](typecheck.md).

## Where it stands (read this first)

**Done.** Both parts of the design are built, merged with the integration branch at 8c88f5c, and verified (below):

- part 1 (efb3c08): a page's check unit holds a unit's part by reference;
- part 2 (f044bce): a part's shadow is written once per build per folder, its functions taken as shared by id;
- merge (b6f9272), and a per-page map made once (4740398);
- merge with the integration branch at 2a88005 (the "once per use" fix, below).

Commits on `redesign/check-data-once`: efb3c08, f044bce, b6f9272, and the last one (log, numbers). Switches:
`SN_CHECK_PARTS=0` (every page's shadow whole, as before), `SN_CHECK_PARTS_AUDIT=1` (both, compared file by file).

Results, before (8c88f5c, the integration branch) and after (this branch on it); medians of 4 builds, interleaved;
`check()` from one profiled build each (inclusive CPU ms, `tsc`'s wait included):

| case | wall before / after | CPU before / after | `check()` before / after | of it tsc (wait) | `unitCheck` |
| --- | ---: | ---: | ---: | ---: | ---: |
| sinter-mail API, 12 pages, TS | 4,076 / **3,443** | 6,850 / **6,130** | 1,087 / **525** | 256 / 251 | 145 / 3 |
| sinter-mail components, 12 pages, TS | 6,296 / **5,381** | 11,140 / **9,930** | 1,145 / **504** | 306 / 277 | 128 / 6 |
| blog, a page file per post, 100, check on | 4,793 / **4,226** | 8,430 / **7,710** | 864 / **304** | 192 / 199 | 90 / 4 |
| blog, one template, 100, check on | 3,123 / 3,059 | 5,530 / 5,420 | 152 / 188 | 134 / 168 | (no units) |
| `sinter check`, blog files | 5,078 / 5,292 | 8,840 / 9,260 | 820 / 885 | 179 / 180 | (no units) |

So on sinter-mail the check's own work besides `tsc` went from about 70 ms a page to about 23 ms a page (API:
831 to 274 ms for 12 pages), and on the blog from 6.7 to 1 ms a page. The one-template blog and `sinter check` place
no units (the CLI links with the linker; a template is one unit already): unchanged within the noise (five more
interleaved pairs of `sinter check`: 4,893 / 5,220, 5,232 / 5,259, 5,794 / 5,243, 5,335 / 5,158 ms wall).

What is left in `check()` on sinter-mail (API, 525 ms): `tsc` 251; the parts' templates, once per build (48); the
parts' info, once (20); the rest per page, a few ms each (the declarations, the page's own few functions, its ids
read and counted, its file written).

## The oracle

`node scripts/check-corpus.mjs <out.txt>` writes four apps under `.sinter/` (ignored) and builds each with Vite in a
child process (the build's error text), runs `sinter check` on it (stdout, stderr, exit code), and builds the clean
app with the check off to compare its dist; paths are shortened to `<app>`, stack frames left out. `--compare <ref>
<out>` diffs two outputs. Its apps, on `@fixture/ui` (test/fixtures/ui):

- **a**: errors in component markup used once (`x-row`), twice and in a loop over constants (`x-badge`), in a loop
  over a resource (`x-row`), as a choice candidate (`x-para`; `x-quote` ruled out by a branch: SN538), with a fill and
  a slot that passes data (`x-list`, `$slot.r`), in a recursive definition (`x-tree` on three pages and two folders),
  in a library component's props and fill (`ui-card`, `ui-tree`'s `node` slot), in a component reading a page resource
  with different types on two pages (`x-res`: `Person[]` on index, `string[]` on deep), in page markup,
  `data-sn-with`, handlers (`n.push`, `$event.detail` of a component event), a component's `<script lang="ts">`, and
  the choice page copied into `sub/` (its unit placed in another folder). 31 errors and a warning.
- **b**: a with a page holding a broken expression (the build stops at its compile error; `sinter check` prints it).
- **c**: every error fixed: the build passes; its dist with the check off is the same.
- **d**: a with an app `tsconfig.json`.

The corpus builds make 2 units and place 3 (x-tree on index, placed on deep and sub/more; the choice page's on
blocks, placed on sub/blocks): units are placed under the check. Its output is the same with `SN_UNITS=0` and with
`SN_CHECK_SHARE=0` (checked at 09d202f).

## Measurements (before)

Machine: 4 cores, Node 22.23.5, quiet (load 0.3), TypeScript 7.0.2. `node bench/check-bench.mjs <case> --runs 5
--prof`: each build in a fresh child process, the first run thrown away, the median of the next four; CPU is user +
sys of the build and the `tsc` children it waited for. The profile is one more run's `--cpu-prof`, inclusive ms of
the named functions (`spawnSync` is the wall time `tsc` was waited for).

| 09d202f | wall | CPU | `check()` | `shadowOf` | `checkShared` (incl. shadowOf, tsc) | tsc (wait) | `unitCheck` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter-mail API, 12 pages, TS | 4,381 | 7,310 | 1,376 | 396 | 1,182 | 294 | 144 |
| sinter-mail components, 12 pages, TS | 6,824 | 12,040 | 1,260 | 347 | 1,028 | 259 | 140 |
| blog, a page file per post, 100 | 5,018 | 8,950 | 1,130 | 300 | 956 | 268 | 79 |
| blog, one template, 100 | 3,122 | 5,420 | 288 | 7 | 152 | 137 | |
| `sinter check`, blog files | 4,839 | 8,480 | 890 | 253 | 765 | 194 | (no units) |

## Part 1: a page holds a unit's check part by reference

- `units.ts`: when a unit is made, each name's part (`Seg`) whose frames and expressions refer only to each other is
  copied once, numbered from 0 (`CheckPart`: `frames`, `exprs`, the making page's `file` and `base`). `unitCheck`
  then records `{ part, frameBase, exprBase, file, base }` in the compiler's `checkParts` and lengthens
  `checkFrames`/`checkExprs` by the part's counts, leaving holes; the scopes' frames (`frameOf`) as before. A part that
  refers outside itself, or a page inside a definition the linker records (`defLink.depth > 0`, whose lists are
  logged), copies as before.
- `check-unit.ts`: `checkUnitWithParts` is the page's check unit when units are placed under check: its `frames` and
  `exprs` are getters that fill the holes with the part's entries numbered and named as the page's (`partFrame`,
  `partExpr`: exactly the copy `unitCheck` made), its own enumerable fields those of a plain unit (so the units audit
  and every reader see the flat lists). `checkRaw(unit)` gives the lists with their holes and the parts;
  `checkFrameAt`/`checkExprAt` make one entry.
- `compile.ts`: the four places that write into an expression after recording it (`typeLast`, a choice's `guard`,
  `runTargets`' `run`, `broken`) go through `checkExpr(i)`, which makes a part's entry in the page's list first (and
  then reads it from the list, through the linker's log in a recorded definition). `checkParts` is in `LINK_FIELDS`
  (`linker`); it is null without units, so the editor's and `checkPage`'s compiles are as before.
- Checked: the corpus is the reference; `test/compiler` 1,063 passed; `SN_UNITS_AUDIT=1` over `test/compiler`,
  `test/units.test.ts` and `test/vite`: the same 62 failures as at 09d202f (the tests that count compiles, links and
  rendered rows), no page differs.
- Measured (3 runs): `unitCheck` 144 to 7 ms (sinter-mail API), 79 to 4 (blog files); `check()` gains what the compile
  lost (the flat lists are made when `shadowOf` reads them: `shadowOf` 396 to 633 ms): no gain by itself, as the
  design said. It is the form part 2 reads.

## Part 2: a part's shadow written once per build

`checkShared` (src/check/index.ts) is now two steps: `planShared` makes every file TypeScript is given (the folders'
shared modules, the pages) and where each page's functions are in its whole shadow; `checkShared` writes them, runs
`tsc` and lays the errors out as before.

- **A page that holds parts** (`checkRaw`, every part `ok`: no mark of ours in its text, nothing broken) is not
  written whole. Its shadow is its declarations and its own expressions only (`shadow`'s new options: `only`, the
  expressions to write; `frameAt`, frames read through the page's lists, a part's made when an own expression opens
  it; `info`, what the declarations read of the expressions and frames, `HeadInfo`: the specs, `$A`, and the `any`
  type names in frame-then-expression order, merged from the page's own and each part's, computed once per part).
  Its parts' functions come from the part's **template**: the part's functions written once per folder (and library
  of the page, and set of `any` names), the part's expressions named `\u0003<j>\u0003`, each with its lines, the
  functions it calls, and the names it reads. The page's functions are laid out as its whole shadow has them (the
  broken ones last), a part's at its place, by arithmetic.
- **Ids**: a part's function gets its id in the folder's module the first time a page takes it with nothing of the
  page in it, by the same text as before (the template's text, the functions it calls named `$s<id>`); later pages
  read the id (`Tpl.ids`) and count it. A part's function that reads a resource of the page (by the template's
  names, `byName`) or a name typed per page (`fixed`) stays on that page, and so does what calls it; its text is the
  template's with the page's names. So the shared modules, the page files and the counts are the ones the whole
  shadows gave: `SN_CHECK_PARTS_AUDIT=1` plans both ways and throws on the first difference in any file, in where a
  page's lines map, or in which functions are shared.
- **Where errors are**: a page with an error anywhere (on its file or in a shared function it takes) has its whole
  shadow written in memory then (`shadowOf` over the flat lists) for its regions; its layout must be the one planned
  (else every page is checked whole: "laid out otherwise (please report)"). A clean page never is.
- `SN_CHECK_PARTS=0`: every page written whole, as before.

Found with the corpus's app e (no types module): a part's template was first cached by folder, but a folder has one
module per set of `any` names, and the ids are a module's; the template is now keyed by both.

Checked (on efb3c08 + part 2): the corpus (5 apps, its reference regenerated at 09d202f with app e) the same plain,
with `SN_CHECK_PARTS_AUDIT=1`, `SN_CHECK_SHARE=0`, `SN_UNITS=0` and `SN_CHECK_PARTS=0`; the whole suite 2,861 passed;
`render-audit` and `render-audit --switch SN_UNITS`, `pass-audit`, `mail-audit --switch SN_UNITS` (42 files): every
file the same; the blog's dist (a page file per post) the same with the check on and off.

First numbers (3 runs, the profile's `checkShared` including `tsc`'s wait): sinter-mail API 4,381 / 7,310 ms (wall /
CPU) to 3,587 / 6,410, `checkShared` 1,182 to 652; blog files 5,018 / 8,950 to 4,273 / 7,920, `checkShared` 956 to
307. (The profile's `check` row at 09d202f also counted a compiler function named `check`, `foldVerdicts`'s; the
bench counts only `check/index.js`'s now.)

## Merged with the integration branch (8c88f5c)

The bug fixes change check diagnostics on purpose (a broken expression no longer silences other errors: shadows leave
the broken expressions out, `shadow`'s `broken: false`), so the corpus reference is **regenerated from the integration
branch** (8c88f5c, in a worktree, this branch's `scripts/check-corpus.mjs` copied in): app b now reports its type
errors. The one conflict was `shadow.ts`'s options (both kept) and `checkShared`'s body (this branch's, with
`broken: false` on every shadow `planShared` writes; a part is never broken, and a page's own broken expressions are
left out of its layout as of its whole shadow). On the merged tree the corpus is the new reference plain and with
`SN_CHECK_PARTS_AUDIT=1`, `SN_CHECK_SHARE=0`, `SN_UNITS=0`, `SN_CHECK_PARTS=0`.

## Checks on the merged tree (b6f9272)

- The corpus: the integration branch's reference, plain and with `SN_CHECK_PARTS_AUDIT=1`, `SN_CHECK_SHARE=0`,
  `SN_UNITS=0`, `SN_CHECK_PARTS=0`.
- `npx vitest run`: 2,905 passed. `SN_LINK_AUDIT=1`, `SN_RENDER_AUDIT=1`, `SN_ONE_PASS_AUDIT=1` on `test/compiler`:
  1,103 passed each. `SN_UNITS_AUDIT=1` on `test/compiler`, `test/units.test.ts`, `test/vite`: 64 failures, the same
  tests as on the integration branch itself (they count compiles, links, rendered rows), no page differs.
- `render-audit`, `render-audit --switch SN_UNITS`, `pass-audit`: all 25 builds the same; `mail-audit --switch
  SN_UNITS`: 42 files the same; the blog's dist with the check on and off the same.

## Tried, found, left

- Part 1 alone gains nothing (the copy moves from the compile to `check()`, where `shadowOf` reads the flat lists);
  it is the form part 2 reads, and the units audit's oracle (the flat lists equal the compile without units).
- A page with an error writes its whole shadow in memory for its regions (the error's place in the HTML). A clean
  build never does; an erroneous one pays what it paid before, for its pages with errors only.
- Not changed, recorded: the profile's `check` row before this work also counted the compiler's `foldVerdicts`'
  `check`; the parts path needs a part that refers only to itself (one that does not is copied, and the page compiled
  again without units, as before); `sinter check` (the CLI) does not place units, so it does not take parts.
- Left: `tsc` itself (one process, not incremental: about 250 ms here, most of it TypeScript's libs); the CLI could
  place units as builds do and then take parts too.

## Merged with the integration branch again (2a88005)

Three more check fixes landed: de37bb3 (a component used inside itself reports each error once per use: the
compiler marks a shared definition's copy, `CheckExpr.def`, and `parseTsc` drops a marked copy's error where an
unmarked copy on the same page reports it, finding the expression by the shadow's `blocks`), aba9144 (the build's
line counts errors and warnings apart), 78c8450 (an error in markup decided away is reported). The conflict was the
`ShadowInfo` of `checkShared`, which now takes `blocks`: with parts it is given the page's whole shadow, which
`checkShared` writes for every page with an error already, so the two rules compose without change:

- `def` is set when the expression is recorded (`defWalk`), so a part carries it, and the page's flat lists (read
  where the page has an error) have it where the copy had it.
- The pairing is per page and error, after the records are laid out on the page's whole shadow: an error of a
  shared function is put at the page's block before `parseTsc` sees it, whichever file (the folder's module, the
  page) `tsc` reported it in, so a marked copy and its unmarked twin pair as when every page was written whole.
  The corpus has the case (x-tree inlined on its pages and shared below, its unit's part placed on deep and
  sub/more): the four duplicate reports per app are gone in the integration branch's reference and in this branch's
  output, through parts.

The corpus reference is regenerated from 2a88005 again. Checked on the merged tree: the corpus is that reference
plain and with `SN_CHECK_PARTS_AUDIT=1`, `SN_CHECK_SHARE=0`, `SN_UNITS=0`, `SN_CHECK_PARTS=0`;
`test/check/check-shared.test.ts` 5 passed; `npx vitest run` 2,923 passed; `SN_LINK_AUDIT`, `SN_RENDER_AUDIT`,
`SN_ONE_PASS_AUDIT` on `test/compiler` 1,113 each; `SN_UNITS_AUDIT` 64 failures, the same tests as on 2a88005;
render-audit (both), pass-audit: 25 builds the same; mail-audit 42 files the same; the blog's dist with the check on
and off the same.
