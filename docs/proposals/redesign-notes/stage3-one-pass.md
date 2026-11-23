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
