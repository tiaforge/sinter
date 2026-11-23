# The per-page floor: what a page costs the compiler after stage 1

Running log (2026-11-23). Goal: bring what a benchmark page costs the compiler (24 ms a template page, ~50 ms a page
file per post, after [stage 1](stage1-render.md)) towards the ~4 ms that would put 100 posts level with Astro
([compile-units.md](../compile-units.md), "What a build costs"), with byte-identical output, and say what the smallest
route to one walk per page is. Out of scope here: `rowRenderer`'s fallback rules and how the later phases treat a
rendered block (stage 2, the coverage agent), the build pipeline in `src/vite.ts`.

## How it is measured

- The preload and load hook of [profile.md](profile.md) (`instr.mjs`, `hooks.mjs`), pointed at this worktree's
  `dist/`: `time` mode for inclusive ms per phase (wall time, the GC inside included), `count` mode for exact call
  counts, `--cpu-prof` for what is inside a phase. Scripts in
  `/tmp/claude-0/-home-user-sinter/07fc153f-c046-5b94-a69d-9a6973727684/scratchpad/floor-agent/` (`drive.sh`,
  `ab.sh`, `med.mjs`, `tree.mjs`, `q.mjs`, `ident.mjs`).
- The machine has 4 cores and other agents build on it (load average 4 to 9 throughout), so absolute times move by
  ±30 % from one run to the next. Every comparison is A/B: `ab.sh` copies each saved `dist/` in turn into the worktree
  and builds, round after round, and the tables give the median of the rounds. Compare columns, not tables.
- Byte identity: `ident.mjs build <label>` builds the five benchmark apps (static, live, static-files, live-files,
  static with the type check; 100 posts) and the four examples with whatever `dist/` holds; `ident.mjs diff` compares
  two labels file by file. The base is `130705b`'s `dist/`, kept aside. Plus `scripts/render-audit.mjs` (rendering
  off against on, with each commit's `dist/`).

## Where a page's compile went at the start (`130705b`)

`time` mode, one run each, ms a page (n = 100; template variants: 100 entries of one template):

| phase | static | live | static-files | live-files | static, type check |
| --- | ---: | ---: | ---: | ---: | ---: |
| `compile()`, build | 25.3 | 33.5 | 45.8 | 45.0 | 38.4 |
| pass 1 `decideFor` (template entries) | 16.1 | 19.0 | – | – | 23.0 |
| pass 1 `walkPage` | – | – | 12.5 | 12.6 | – |
| of it `definition` (the library, per page) | – | – | 5.7 | 5.7 | – |
| pass 1 `finishPage` | – | – | 24.4 | 22.4 | – |
| of it `prerender` | – | – | 18.1 | 16.4 | – |
| pass 2 `walkPage` | 7.0 | 9.9 | 7.7 | 8.2 | 12.0 |
| of it `expandComponents` | 2.5 | 3.2 | 2.5 | 2.2 | 4.0 |
| of it `minify` | 2.3 | 3.0 | 3.1 | 3.1 | 4.1 |
| pass 2 `finishPage` | 0.8 | 2.3 | 0.9 | 1.3 | 1.1 |
| `compile()`, describe | (4 for the build) | | 8.0 | 9.1 | |
| GC inside the compiles | 3.7 | 5.2 | 7.5 | 8.3 | 8.0 |

The CPU profile of the static build splits `decideFor` (16.6 ms a page) as: copying and freezing row items 7.4
(`deepFreeze` 4.2, `structuredClone` 3.1), `plainData` 0.8, the page's `md.parse` 1.8 (with its result's copy and
freeze, 2.6), rendering the rows 1.7, the rest of the worklist 3.4. `new Function` over the page's code is once per
entry and costs little (`prerender`'s own time, 0.6 ms). Pass 2's `walkPage` (8.5 ms in that profile):
`expandComponents` 3.2 (`componentFile` 2.4, of it `kindOfComponent` 1.6; `choicePool` 1.9), `minify` 2.2 (the
layout's `everyView`), the walk 1.2. `componentFile` is called 503 times a page in pass 2 now (13,400 before stage 1).

## Changes

### 1. Row items frozen once (`frozenData`)

`rowsOf` gave each row `deepFreeze({ v: structuredClone(item) }).v`, and a placement's data the same. A row's item is
a part of the item above it (a document's node in its parent's `children`), frozen already, so every level copied and
froze its whole subtree again: O(depth × size), and the garbage of it. `frozenData` shares what is frozen at every
depth already (`DEEP_FROZEN`: a `file:` value, a state's initial value, a helper's result, the row above's item) and
copies only the new objects around it (a case's props `{ node }`), frozen once.

What a copy guaranteed and still holds:
- Nothing a row evaluates can change an item, at any depth: everything it reaches is frozen (a write throws, the
  binding is `FAIL`, as before).
- A helper's result is still copied (`fresh`, `helperCalls`' `isResult`): a helper call takes a result it handed out
  by reference (`refOf`, for the build's cross-check) and anything else by value, so sharing one into a row would
  change which form a call is logged in. So is any part that `map`/`fromEntries` would not copy as `structuredClone`
  does (an array with holes or keys besides its indexes, an object reached twice): those take the old path.
- What the worklist accepts is unchanged: `listOf`/`plainData` are asked the same questions of the same values.
- Not kept: identity between a row's item and the data it came from (`y === x.children[0]` is now true at build
  time, as it is in the browser; it was false). Pass 2 compiles a row's item as a literal, so with rendering off
  such a comparison is false again: a page whose row compares objects by identity would differ between rendering on
  and off. No app or test does; the render audit would show it.

Tried and dropped: a memo of `plainData` for frozen data (heights in a `WeakMap`, so that each level's `listOf` does
not walk its subtree again). 550 calls a page, mostly over small values; the `WeakMap` cost what the walks did
(0.8 ms before, 1.1 ms after in the profile).

Static, `time` mode, median of 3 rounds A/B (ms a page): `decideFor` 19.0 → 12.5, GC in compiles 5.5 → 4.2,
`compile()` 32.4 → 23.9; the build (instrumented) 6.0 → 5.0 s.
