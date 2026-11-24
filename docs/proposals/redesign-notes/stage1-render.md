# Stage 1: rows rendered from the first pass's compiled program

Running log of the spike (2026-11-23). Goal: the build stops compiling every constant component instance in the second
pass; known rows are *rendered* at build time from what the first pass compiled, the way the runtime renders live rows
from the same templates. General (any unrolled loop, not a static-page special case) and byte-identical to today.
Sibling notes: [decisions.md](decisions.md) (§1.3 the worklist, §5 what pass 2 does), [pipeline.md](pipeline.md),
[contract.md](contract.md) (§6 the oracle).

## What was built

**Pass 1, `worklist()`** (`compile.ts`, `nodesOf`/`rowsOf`/`expandCase`): while it evaluates a top-level unroll's rows
it also records, when rendering is on, a `RowRec` per row and per instance: a `Map` keyed by the compiled objects
(a `Binding`'s paint or a text node's value, an `if`'s branch, a loop's or recursion point's row records, a choice's
case with its props, a tree placement's case, the row's item). No string keys: the first version read
`this.decided`/`unrolls`/`rowPaint` by `prefix + instKey`, and hashing those keys (a full `instKey` per depth, ~800
characters at depth 8) cost 1 s of the 1.2 s the rendering took on the benchmark.

**Pass 1, `finish` → `rowRenderer`**: for each committed top-level unroll, render its rows: clone the row template's
walked content (data-sn-* already stripped; nested anchors' content not cloned), then per `NodeDef` of the template, in
order: ROW bindings `writeFirstPaint` their recorded paint; a text node's comment slot (and its own comment) becomes the
text; an `if` and its `else` become the rendered kept branch; a loop its rendered rows; a choice the rendered case's
definition (`headTemplates`), a recursion point likewise, a tree placement its default (case 0). The block records what
compiling the rows in pass 2 would have done that the page keeps:

| effect of the inline path | how it is reproduced |
| --- | --- |
| `data-sn` ids the rows' bindings take (and `dropConstants` removes again) | counted: each element `NodeDef` with a binding other than a definition root's `$a` reads, and each text node; pass 2's walk adds the count to `nextId` at the block's first element |
| the loop's list compiled once at the first row element (`rowLets`, for its diagnostics) | `list` flag (some row has an element or a text template at its top); pass 2 compiles it in the walk's scope there |
| `foldedText` (SN501): each decided `if`'s condition and empty state list, each empty unrolled list | the attribute as written (`snSource`, recorded in `element()` before `stripSn`), pushed in pass 2 |
| `files`: the component files each inlined instance's `expandUse` reads | the origins' files of the definition's expanded markup (+ CSS file), added in pass 2 |
| resources the rows' bindings read (`used`, SN501) | deps `$r.<name>`/`$meta.<name>` of every binding rendered, marked used in pass 2 |
| `foldReads` of everything decided in the rows (`foldedState` → `fixedState`) | unioned into the loop's own key |

A rendered loop's nested decisions are **not** committed to `decided`/`unrolls`/`rowPaint`: pass 2 never looks them
up (it splices), and committing them was ~0.5 s of hashing on the benchmark. So whether pass 2 can splice must be known
in pass 1: where the loop is (slot content, a fill, where a component's markup starts — checked on the loop and on each
decided branch whose top node it is, because pass 2's `place` hands those down — or in `<head>`) is checked there
(`where`). Pass 2 checks again (`renderedHere`) and counts a disagreement as `second pass: …` (never seen).

**Under a build's minifier** (`minify` with a layout: in builds, the page's stylesheets, or the browser's own styles
when it has none, which is the benchmark's case): pass 2 minifies the markup its walk compiles, so a text node a
binding writes is a `<template data-sn-text>` there (an element, its text written later as it is) and an element whose
content a binding writes is left alone. `minifyMarkup` takes a `written` hook for rendered rows (`WRITTEN`, a module
WeakMap on the rendered nodes): such a text is the element it was, such an element owns its content, and a component
root whose tag binds class/style/attributes/visibility stays `opaque`. Empty texts stay in the block until the
minifier has run. Rows whose visibility, style, `hidden` or `contenteditable` a binding writes fall back (`minify`): the
layout reads those as changing. The first version minified rendered text (a trailing space at a block's edge, runs of
white space); the benchmark's content has none, so the build audit did not see it, the minifier test does.

**Pass 2, `expandConstants`**: a top-level unrolled loop (`pre === ''`, not in a row or an inlined instance) with a
rendered block is replaced by the block's nodes; its top elements are marked (`renderedAt`); `declare` and
`walkChildren` skip them (the first does the list compile and the ids).

**Switch**: on by default; `SN_RENDER=0` off. Dev builds render too (since "Dev renders" in stage2-coverage.md): their
`fns` has no `'0'` slots for what the old route would have compiled in the rows (dev runs no `compactTables`), so dev's
function numbering differs from the old route's; the audit compares dev without the slots (`withoutEmptySlots`). `SN_RENDER_LOG=1` prints, at exit, loops rendered and the fallback reasons with counts.

**Oracles**:
- `SN_RENDER_AUDIT=1` (`compileParts`): a compile whose pass 2 spliced a block is compiled again with rendering off;
  the two `CompiledParts` are serialised (as `differs()` does) and the first differing field and offset thrown.
  `SN_RENDER_AUDIT_LOG=<file>` appends each page checked. With a kept template (`templates`) the `check` field is left
  out of the comparison (the kept walk's unit goes with the first entry's compile only), and the second compile does
  not count a hit.
- `scripts/render-audit.mjs`: the four benchmark apps and the four examples built with `SN_RENDER=0` and on, each in
  its own process, `dist/` compared file by file.
- `test/compiler/render-rows.test.ts`: each case compiled both ways, equal results, and whether the block was spliced
  (or which reason kept it).

## Fallback reasons (the to-do list of the next stage)

| reason | what it is |
| --- | --- |
| `layout` | the page has stylesheets (`styles`, the images' styles, the minifier's): the layout, the space plan and the minifier read the rows' markup before pass 2 paints it |
| `styled` | a component with scoped CSS on the page (`data-sn-c`/`-r`/`-s` marks, `styles` from `uses`) |
| `images` | `images` on and an `img`/`picture`/`source`/`video`/`audio` in the rows (pass 2 rewrites images before the walk; image constants) |
| `links` | an `<a>`/`<area>` in rows of a page whose code reads `$url` or with axis lists (`hrefs`, same-page links, SN519) |
| `an id` | an `id` written in the rows' markup (`page.ids`, `componentIds`' SN209 count of uses) |
| `diagnostics` | the walk reported something in a template the rows use (pass 2 reports it per instance, with its chain) |
| `handler` | a handler a static tree keeps (`handlerOnly`) |
| `not painted` / `not written ahead` | a ROW binding with no build-time value, or one `firstPaintValue` refuses (objects, refused URLs/styles, select values) |
| `text` | a text node whose value is unknown or an object |
| `fill` | a tree placement that renders a fill (caller markup compiled in the caller's scope) |
| `tag attributes` | a choice's or recursion point's tag passes attributes to the root (`$a`) |
| `top-level choice` | a choice/recursion point expanded outside any loop (pass 2's `inlineInstance` compiles its props per use) |
| `minify` | under a build's minifier, a binding writes `hidden`, `style`, `contenteditable` or visibility (the layout reads those as changing) |
| `a sinter attribute` | an attribute the walk keeps for the runtime (`data-sn-options`, `-navigate`, …) in the rows' markup |
| `where it is`, `in the head` | the loop is slot content, a fill, where a component's markup starts, or in `<head>` |
| `no element`, `text at the top of a row` | nothing to hang the ids or the list compile on; a row whose top is text the walk would not see |
| `not inlined`, `else`, `for`, `choice`, `markup`, `no template` | structural cases pass 2 handles otherwise; defensive |

Counts seen (one build each, `node scripts/render-audit.mjs`):

| app | rendered | left to the second pass |
| --- | --- | --- |
| bench static / live / static-files / live-files | 100 loops (49,200 rows and instances) each | none |
| examples/static-site | 0 | `layout`: 9 loops, 87 rows |
| examples/multilingual-site | 0 | `layout`: 8 loops, 32 rows |
| examples/dashboard, examples/realworld | no unroll | — |

## Measurements

4 cores, other agents' builds running concurrently (load average 5–7), so on/off pairs are back to back; `ms` from
`bench/astro/run-sinter.mjs`.

First working version (string-keyed lookups), two rounds each:

| variant | off | on |
| --- | ---: | ---: |
| static | 15.1 / 15.9 s | 7.7 / 7.5 s |
| live | 18.1 / 21.5 s | 12.4 / 9.9 s |
| static-files | 24.6 / 19.3 s | 11.2 / 9.8 s |
| live-files | 23.3 / 21.2 s | 14.3 / 13.3 s |

After `RowRec` and skipping the nested commit (render-audit builds, same load):

| variant | off | on |
| --- | ---: | ---: |
| static | 15.2 s | 4.7 s |
| live | 16.7 s | 7.3 s |
| static-files | 17.4 s | 7.1 s |
| live-files | 18.9 s | 9.9 s |

Final (`7f98326`), two rounds back to back, load average 6 → 3:

| variant | off | on | |
| --- | ---: | ---: | ---: |
| static | 14.2 / 13.0 s | 4.6 / 4.2 s | ×3.1 |
| live | 16.4 / 16.2 s | 6.9 / 7.2 s | ×2.3 |
| static-files | 15.6 / 15.9 s | 6.4 / 6.8 s | ×2.4 |
| live-files | 19.0 / 20.2 s | 8.9 / 10.1 s | ×2.1 |

Peak memory drops too (static 539 → 422 MB).

### What is left per page (static, `node --cpu-prof`, 5.2 s wall, 101 pages)

`fromTemplate` 2.41 s in all, ~24 ms a page:

| phase | per page | notes |
| --- | ---: | --- |
| `decideFor` (pass 1's evaluation, per entry) | 15.1 ms | the worklist 8.9 ms, of which **7.5 ms is copying and freezing row items** (`deepFreeze` 3.8, `structuredClone` 2.8, `plainData` 0.9: each level clones and freezes its item, a part of the level above's frozen item, so O(depth × size)); `md.parse` (the folded helper) 1.7 ms; rendering 1.5 ms |
| pass 2 `walkPage` | 8.0 ms | `expandComponents` 3.9 ms (`componentFile` 2.8 ms: every component file read and kinded again per `Compiler`, `kindOfComponent` 1.9 ms; `choice`/`choicePool` 2.2 ms), `minify` 2.4 ms (the layout's `everyView`), the walk of what is left ~1 ms |
| pass 2 `finishPage` | 0.7 ms | |
| `keepTemplate` | 128 ms once | the kept walk and the check walk |

Outside the page compiles: vite's `templateOf` (one full compile of the template for its entries, 0.37 s), vite and
rollup, module loading, GC 0.6 s.

Next targets, in order: (1) the items' clone-and-freeze in `rowsOf` (a frozen item's parts are frozen already: clone
once at the top, freeze once); (2) per-`Compiler` component file reading/kinding and choice pools (cacheable per build
by file text, as `PARSED` is); (3) pass 2's `expandComponents` of a page whose body is one rendered loop: it expands
the loop's template content (choices, candidates) only for `expandConstants` to throw it away; (4) the minifier's
layout queries.

## Open problems

- Function-table dedupe by text: a live function whose code equals one a rendered row would have compiled (and dropped)
  takes its index at the row's place in pass 2's table today; compaction keeps that order. With rendering the live one
  is numbered where it first appears. Not seen in any test or app (row code has the item inlined as a literal, so it
  rarely equals live code), but possible; the audit would show it.
- `this.at` after the walk: the inline path leaves it at the last row element; with rendering it was left at the
  element before the block. Now the walk sets it at the block to the loop's template (where the rows were written), so
  a function compiled with no site of its own after a rendered block maps there (dev `at`, the source map).
- Dev builds: rendered since "Dev renders" (stage2-coverage.md); their function table has no slots for the rows, so
  byte identity with the old route holds only without the old route's `'0'` slots (`withoutEmptySlots`).
- Everything in the fallback table: the layout reading rows is the one that matters for the examples.
