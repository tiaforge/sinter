# Stage 5, A1 (then A2): definitions that ship come from per-build units

Running log (2026-11-23), cloud session, branch `redesign/stage5-a1`, started at b474ecc (the integration branch).
The brief is "A1 brief" in [stage5-assembly.md](stage5-assembly.md) (section 5); the bar is in
[compile-units.md](../compile-units.md), "How the work is run".

## Where the work stands (read this first)

- **Done**: step 0's oracle completed (section 1: the suite and sinter-mail against canonical builds); the components
  route re-measured per phase on a quiet machine (section 2).
- **Next**: A1's first cut (section 3): the second pass places a unit of its own before its walk at numbers from 0,
  snapshotted whole when placed and given back whole after the page, its output copied first; then `anchors()` and
  `shareTemplates()` once per unit.

## How it is measured

Scripts in this session's scratchpad (`m/`): `instr.mjs` + `hooks.mjs` (a preload: a loader hook appends a line to
`dist/compiler/compile.js` that hands the `Compiler` class to the preload, which wraps its methods, and one to
`dist/compiler/index.js` that wraps `compile()`; every method's inclusive time per `compile()` call, by pass, the
outermost call of a key counted), `bb.mjs` (one build of sinter-mail's route with N identical pages in that process:
`comp` is route iii, the `api-templates` body; TypeScript resolvable from the app or not), `sum.mjs` (ms per page by
key: page 1, page 2, the median of pages 3 to 12, the mean of all). The machine: 4 cores, load about 1 during the
timings (nothing else running). The thread CPU clock here ticks at 4 ms, too coarse for one call, so the times are
wall clock (`SN_CLOCK=wall`), three builds each, medians of the three.

## 1. Step 0's oracle, completed

- **The suite under `SN_CANON=1`** (every build compile outputs its canonical form; dev compiles are not
  canonicalized): 2,899 of 2,904 pass; plain, all 2,904 pass (302 files, 200 s). The five that fail are the five the
  previous agent predicted, each a test that pins a node id after a gap, and nothing else: `first-paint.test.ts`
  ("build-time constants…": expects `<p data-sn="5">`), `prefold.test.ts` ×3 (expect `<button data-sn="2">`, canonical
  `1`), `render-rows.test.ts` ("the ids of what follows the rows…": expects `data-sn="5"`/`"6"`, canonical `0`/`1`).
  Every behaviour test (`test/behaviour`, 108 files, which run the compiled page in happy-dom) and every browser
  test in `test/vite` (Chromium) passes against canonical output: **canonical output runs**.
- **sinter-mail against canonical builds** (`SN_CANON=1 node scripts/mail-audit.mjs <checkout> --suite --bench --runs 9
  --switch SN_CANON=1`: the second build canonical, the library's suite run with `SN_CANON=1` in its environment, the
  bench over the canonical build): `npm test` 234 passed, `npm run check` 5 pages 0 errors, `npm run typecheck` ok.
  (The baseline run before it reported `typecheck` FAILED: on a fresh clone `sinter/sinter.components.d.ts` does not
  exist until `npm run check` writes it, and the audit runs `typecheck` first. Not a sinter difference; on the second
  run it passes. Recorded for whoever runs the audit on a fresh clone.)
  Raw files: the 6 API pages' HTML and modules differ (numbering), the 10 file pages are the same bytes.
- **The bench, today against canonical** (Chromium, 9 runs each, medians [min–max], ms):

  | case | today | canonical |
  | --- | ---: | ---: |
  | api, newsletter-2000, first render | 32.7 [24.1–45.3] | 26.5 [23.3–37.8] |
  | api, same body again (script) | 9.4 [8.6–12.7] | 9.1 [8.9–13.3] |
  | api-templates, newsletter-2000, first render | 80.9 [71.7–88.6] | 97.4 [73.4–110.6] |
  | api-templates, same body again (script) | 70.5 [55.1–101.3] | 63.0 [54.3–75.8] |
  | api-templates, corpus-static, first render | 33.0 [26.8–39.4] | 31.7 [26.5–37.7] |
  | api-fills, newsletter-2000, first render | 92.0 [66.8–108.5] | 71.3 [63.9–98.4] |
  | api-fills, same body again (script) | 54.0 [49.6–76.2] | 53.0 [48.0–74.9] |
  | every case, re-evaluated (tick) script | 0.5 to 0.8 | 0.5 to 0.9 |

  No case moves beyond its own range (the noise of a first render is ±15 to 20 ms between runs of one build). The
  weight confirms the previous agent's finding: route iii's modules +322 B (`api-templates` 22,429 → 22,751 gzip),
  +316 (`api-fills`), +336 (`api-both`), and the route ii modules ±2 B.
- **Verdict**: the canonicalizer is trustworthy as an oracle for numbering (no gap found, so no fix and no new test
  was needed); canonical output runs in happy-dom, Chromium and sinter-mail's own suite; canonical function order
  must not be shipped (weight).

## 2. The components route, per phase, on a quiet machine

ms per page (wall, the preload's overhead included), medians of three builds of 12 identical `api-templates` pages.
"Later" is the median of pages 3 to 12.

| | no TypeScript: page 1 | page 2 | later | mean of 12 | TypeScript: page 1 | page 2 | later | mean of 12 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `compile()` | 1,350 | 645 | 111 | 262 | 1,552 | 770 | 142 | 318 |
| pass 1 `walkPage` (its unit: made on page 1, placed after) | 894 | 18 | 12.5 | 89 | 1,103 | 35 | 30 | 121 |
| pass 1 `settle` | 71 | 18 | 14.6 | 19.6 | 57 | 17 | 14 | 18 |
| pass 2 `walkPage` | 228 | 533 | 44 | 100 | 285 | 648 | 54 | 132 |
| of it: definitions (top level, inclusive) | 214 (compiled) | **515 (recorded)** | **27 (replayed)** | 86 | 283 | **632** | **36** | 112 |
| pass 2 `settle` | 34 | 44 | 12.3 | 17.6 | 32 | 31 | 8.2 | 14.8 |
| pass 2 `finishPage` (after `settle`) | 110 | 74 | **34** | 48 | 104 | 68 | **30** | 44 |
| of it: `shareTemplates` | 21 | 18 | **13** | 15 | 21 | 23 | 11 | 14 |
| `groupStyles` | 45 | 6 | 5.5 | 9.8 | 42 | 6 | 6 | 9 |
| `compactTables` | 2.7 | 2.3 | 1.5 | 1.7 | 2.7 | 2.6 | 1.3 | 1.7 |
| `anchors` | 1.4 | 1.5 | 1.4 | 1.4 | 1.5 | 2.2 | 1.4 | 1.6 |
| the description compile (each page) | 16.4 | | | | 16.7 | | | |

Whole builds (wall, 12 pages, this process): 3,968 to 4,307 ms without TypeScript, 5,721 to 6,108 with.

What this changes in the plan:

- The 110 ms (139 with TypeScript) of the plan's table is the **mean** over 12 pages of the second pass's definitions,
  most of it page 2's recording (515 ms, 632 with TypeScript) and page 1's compile (214, 283). A later page replays
  them in **27 ms (36)**. So per later page A1 buys the replay (27 to 36 ms) less a placement (stage 4's first-pass
  placement is about 5 ms), plus `shareTemplates` (13) and `anchors` (1.4) if they run once per unit: about 35 to 45
  ms of 111 to 142. Per build it buys page 2's recording (about 500 to 600 ms) and the later pages' replays (10 ×
  about 25), against making the unit once (a recording, about what page 2 costs today, on page 1 instead).
  Estimate: 0.7 to 0.9 s of a 3.1 s compile (12 pages), a quarter. The plan stands; its estimate per later page is
  smaller than the plan said, the per-build one about the same.
- `groupStyles` on a later page is 5.5 ms, not 14 (the 14 was the mean, page 1's 45 in it): not worth a per-unit form
  of its own in the first cut.
- The first pass is 12.5 + 14.6 ms of a later page; the second pass's settle 12 ms. Neither is A1's.

## 3. The design of the first cut

(to be filled with the change)

## Log

- 19:10 UTC: suite plain and canonical, sinter-mail baseline and canonical (`--suite --bench`), per-phase timings.
