# Stage 2: coverage of rendered rows

Running log (2026-11-23). Stage 1 ([stage1-render.md](stage1-render.md)) renders a top-level unrolled loop's rows from
the first pass's compiled templates only where nothing reads or keeps the rows; everything else falls back to the
old route (`inlineInstance`, `cloneTree`, the row lets of pass 2) with a counted reason. This stage removes the
fallbacks that real sites hit, reason by reason, byte for byte, so that the old route can be deleted.

Checks for every step: `node scripts/render-audit.mjs` (the four benchmark apps and the four examples, both ways),
`SN_RENDER_LOG=1 node scripts/mail-audit.mjs <copy of sinter-html>` (sinter-mail's 16 pages, both ways),
`npx vitest run test/compiler` plain and with `SN_RENDER_AUDIT=1`, and a case per reason in
`test/compiler/render-rows.test.ts`.

`scripts/mail-audit.mjs` takes `--only <pages>` and `--gen <n>` (the generated newsletter's size) to time one file
email: a build of one page, both ways, in fresh processes.

## `minify`: style, show, `hidden` and `contenteditable` paints under a build's minifier

**What the old route does.** Pass 2 unrolls the rows (`cloneTree`) and minifies the page before the walk, so the
minifier's layout (the browser's own styles, or `minify.styles`) sees each row element with its bindings' attributes
as written: `data-sn-style` (the element's inline style may be anything: `'\0dynamic'` in `declsOf`),
`data-sn-show` and a `data-sn-attr` naming `hidden` or `style` (`mayChange`: not a block, not an item), and no
`style`, `hidden` or `contenteditable` attribute yet: those are painted after the walk (`prerender`).

**What stage 1 did.** The rendered block is painted before pass 2's minifier runs, so the minifier would read the
painted `style="display: inline"` or `hidden` as the element's own: the rows fell back.

**Now.** The first pass's walk records, for each element in a template that has `data-sn-*` attributes, its
attributes as the walk met them (`snAttrs`, before `stripSn`; only when rows are rendered). `rowRenderer` gives each
clone of such an element those attributes as `SHOWN`, and the block carries its list (`RenderedRows.shown`). Pass 2's
`minify` swaps them in for the minifier (its layout is built over them) and back after. So the minifier reads the
rendered row as the markup it stands for, and the `minify` reason is gone. (`WRITTEN` stays for the text nodes,
which were `<template data-sn-text>` elements there, and for component roots whose tag binds.)

**Coverage.**

| app | before | after |
| --- | --- | --- |
| bench (4 apps) | 100 loops, 49,200 rows each | same |
| static-site, multilingual-site | `layout` 9 / 87, 8 / 32 | same |
| sinter-mail, 16 pages | `minify`: 10 loops, 1,610 rows | 4 loops (640 rows) rendered; `images` 5 / 715, `fill` 1 / 255 |

**sinter-mail's file email** (`--only file-gen`, one page, Vite included, back to back, load average ~5):

| page | off (old route) | on |
| --- | ---: | ---: |
| `file-gen`, 212 elements (514 rows and instances) | 3.87 / 4.18 s | 1.67 / 1.79 s |
| `--gen 1000`, 992 elements (2,412 rows and instances) | 13.4 / 14.2 s | 2.57 / 2.16 s |

The whole 16-page audit build: 14.5 s off, 11.9 s on.

## A stage 1 bug on the way: a binding constant in every row, out of its place

The first pass's `prerender` writes a template binding that is constant in every row (`data-sn-class="{ on: true }"`)
into the template's markup and drops it (`tplPainted`). The rendered row cloned that markup, so the class came before
the row's own paints, where the old route paints all of the row's bindings after the walk, in binding order:
`<p class="on" title="1">` against `<p title="1" class="on">`. Not seen in the benchmark or the examples. Now the clone
starts from the element's attributes as the walk met them (`snAttrs` without the `data-sn-*`) and the row's paints
include that binding again (the worklist records it), in its place.

## `images`: the image pipeline reads the rows

**What the old route does.** The first pass collects every value attribute of an `<img>` in the rows as a constant,
per row (`collectConstants`, from `rowPaint`); pass 2's `prefold` writes them into the unrolled image before the image
pipeline, in its order (the element's own attributes, then its tag's, each in `FOLDED` order: text, show, attr, class,
style), removes the attributes, and records a written `src`/`srcset` (`foldedUrl`: relative to the page, not to the
component file). The image then has no binding (no `data-sn` id), and `rewriteImages` makes it a `<picture>` like a
written one: eager if it is the page's first image outside templates, its variants and rule in the page's lists.
A static `<img src>` in a row is rewritten there too, from the component file it was written in.

**What stage 1 did.** Fell back on any `img`, `picture`, `source`, `video`, `audio` or `image` in the rows.

**Now.**
- The rendered loop's paints of the bindings `collectConstants` reads (`constantSources`) are committed to `rowPaint`
  as before, so the first pass hands the second the same `constants` (and the same `frozen` state).
- An `<img>` (with `images`) is painted in `prefold`'s order and counts no id; a `src`/`srcset` it writes makes it
  relative to the page (`RENDERED_FILE`), else to its origin's file. An image whose bindings are not all folded (one
  reported on, one from `data-sn-href`, `data-sn-transition`, a handler) falls back (`images`), as before.
- The first pass's `rewriteImages` rewrote the template's own static images (lazy, in templates); `rewrote` records
  their attributes before, and the row renders the image it was (`REWROTE`; a `<picture>` the pipeline made becomes
  its image again), so pass 2's pipeline rewrites it as the old route's (eager or not).
- `picture`, `source`, `video`, `audio`: nothing reads them (the pipeline rewrites `img` only, and not in a written
  `<picture>`); no longer a reason.

**Coverage.** sinter-mail: 4 → 9 loops (640 → 1,355 rows) rendered; left: `fill` (1 loop, 255 rows: `file-fills`).
Benchmark and examples unchanged (no images in their rows; the examples fall back on `layout` first).
`file-static`, `file-newsletter`, `file-all` together: 5.7 s off, 4.3 s on (one build each, Vite included).

## `layout`: a page with stylesheets

**What the old route does, phase by phase** (pass 2, `walkPage`, on the unrolled rows):

| phase | what it reads of a row element |
| --- | --- |
| `prefold` | writes the constants the first pass collected for the rows (`collectConstants`: every `data-sn-style`, a `data-sn-class` some selector names, an image's attributes), per row (`prefix + constKey`), in its order, and removes those attributes; an element left with no binding takes no `data-sn` id in the walk |
| `minify` | its own layout (the minifier's or the page's stylesheets) over the attributes then: the folded ones written, the other bindings' `data-sn-*` as written, nothing else painted |
| `new Layout`, `planSpace`, (`snapshot`/dry run: pass 1 only) | the same attributes (the cascade, `data-sn-show`, `data-sn-attr` keys, inline styles; `\0dynamic` for an unfolded `data-sn-style`) |
| `rewriteImages` | the same, and the boxes the layout gives |
| the walk, `prerender` | compiles the rest and paints it after the walk, in binding order |

**What stage 1 did.** Fell back whenever the page had stylesheets.

**Now.** The block presents itself to those phases as the old route's rows:
- the folded attributes (the `constantSources` entries of the element's node, `foldsOf`; a key two entries share is
  `constants`, a fallback, since the first pass would drop it) are painted first, in `prefold`'s order (the element's
  own attributes, then its tag's, each in `FOLDED` order), and count no id;
- an element left with other bindings gets as `SHOWN` its attributes then plus its remaining `data-sn-*` (from
  `snAttrs`), and its other paints after;
- pass 2 swaps `SHOWN` in from before `minify` to after `rewriteImages` (the minifier, the layout, the space plan and
  the image pipeline read it), and back before `declare`;
- a component root whose tag's bindings are all folded is no longer `opaque` to the minifier (`prefold` took them off
  the tag).

The image fold of the previous step is this one's special case (an image folds all its value attributes).

**Coverage.** The examples' loops move to the next reason, `styled` (static-site 9 / 87, multilingual-site 8 / 32);
benchmark and sinter-mail unchanged (no stylesheets: 100 loops each; 9 loops, 1,355 rows). New cases: classes a
selector names and styles beside other bindings, under the minifier, beside a live list's space plan; images sized by
the stylesheets.
