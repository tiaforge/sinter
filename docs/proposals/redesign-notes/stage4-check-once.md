# Stage 4, step 3: a unit carries its type-check data once

Running log, branch `redesign/check-data-once` (from 09d202f). The design is
[stage4-units.md](stage4-units.md), "Step 3 (a unit's check data once)"; how the check works,
[typecheck.md](typecheck.md).

## Where it stands (read this first)

- Done: the diagnostics corpus as a committed script (`scripts/check-corpus.mjs`), its reference from 09d202f
  (`scripts/check-corpus.ref.txt`); the bench (`bench/check-bench.mjs`); part 1 (a page holds a unit's check part by
  reference).
- Next: part 2 (a part's shadow written once per build, taken by `checkShared` as shared functions).

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
