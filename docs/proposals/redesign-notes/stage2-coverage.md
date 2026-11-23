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

## `styled`: components with scoped styles on the page

**Where the marks are decided (old route).** All in pass 2's `walkPage`, after the walk (`applyAliases`, then):
1. `data-sn-c` on `rootMarked(u)` of every `Use` in `this.uses` (when the page uses a component with CSS, or in dev
   builds): the root, or each branch of a chain root (`landingOf(u.shape)`), not a fill that is the root;
2. `data-sn-r` on those elements for the outer styled components whose root they are too (`landing`), and those
   names into `rootStyled` (their root rules are shipped outside the scope, `rootCss`);
3. (since a47fc86, merged here) `data-sn-c`/`-r` copied from each original to each copy `cloneTree` made of a root
   (`rootEls`, `rootCopies`): before it, a row of a loop over constants was a copy whose `Use` still named the
   template's element, so the rows carried no mark (the bug);
4. `data-sn-s` on slot content (`slotEls`) that has no `data-sn-c`: only the elements the expansion registered, so a
   copy in a row gets none.
`this.uses` is filled by `expandUse` (pass 2's expansion of the page, a loop template's content included, and each
`inlineInstance`), and decides which components' CSS is shipped (`styles`). The minifier leaves markup from a
component file with CSS as written (`opaque`, by origin).

**What stage 1 did.** Fell back on any page with a component with CSS.

**Now.**
- A clone of markup from a scoped component's file is `SCOPED` (the minifier's `opaque`).
- The first pass ran the same marking on its own markup, definitions included, so a template element carries the
  marks its instance's expansion gets. The clone takes them (inside an instance: `data-sn-c`, `-r`, `-s`; in rows a
  loop copies, `live` false: `data-sn-c` and `-r` as `rootCopies` gives them, no `-s`), after `prefold`'s writes and
  before the other paints (`MARKED`, written in `fill`), and they are stripped from the base attributes. Before
  a47fc86 was merged, the copies took none (the bug, reproduced in the previous commit).
- The block carries the components its instances expand (`RenderedRows.uses`, with their scoped CSS from the first
  pass): pass 2 registers them in `this.uses` (an empty list: nothing else of a `Use` is read for them) and loads
  their files, so their styles ship and the page's marks are written as in the old route; and the `data-sn-r` names
  (`rootStyled`).
- An image with marks falls back (`styled`): the image pipeline would read the marks the old route writes after it.

**Coverage.** static-site: 7 loops (27 rows) rendered, `fill` 2 / 60 left (the content trees of `guide` and
`getting-started`); multilingual-site: all 8 loops (32 rows) rendered. Benchmark and sinter-mail unchanged.

## `fill`: a tree placement that renders a fill

**What the old route does.** The inlined instance's tree placement places the fill (`placeStatic`: a copy of the
fill's nodes, `fillOf` chain, compiled in the caller's scope with the slot's data as `$slot`; the copies take the
fill's `slotEls` entries, so on a page with scoped styles its top elements get `data-sn-s="<caller>"` after the walk).

**What stage 1 did.** Fell back (it rendered a placement's default only).

**Now.** The first pass compiled the fill as the placement's case (`caseFill`, a head template walked in the
caller's scope with `$slot` as its item), and the worklist already records that case and its nodes; the renderer
renders `P.cases[k]` like the default. On a page with scoped styles, inside an instance, the fill's top elements take
`data-sn-s` with the caller of the fill's `slotEls` entry (`fillMarks`); a fill chain's branch with such an entry falls
back (`styled`: not followed, not seen).

**Two more things the audits found on the way.**
- *`fixedState`* (a stage 1 bug, seen with `SN_RENDER_AUDIT=1` only: the plain result has no such field): the old
  route's pass 2 freezes the state fields every binding it drops reads (`freeze(b.d)` in `dropConstants`), so a row
  reading the page's constant state (`data-sn-text="x + k"`) or a fill reading its caller's has `$s0.k` in
  `fixedState`. The rendered rows now hand the state their bindings read (`RenderedRows.state`) to the loop's
  `foldReads`, which the second pass's `frozen` carries.
- *An image as an instance's root on a styled page* (static-site's `node-image`): the old route marks it after the
  image pipeline rewrote it, so its `data-sn-c` comes after `srcset`, `width`, `decoding`… An image with nothing left
  to paint takes its marks in the second pass after `rewriteImages` (`RenderedRows.late`).

**Coverage: the goal state.** Every loop of every app renders:

| app | stage 1 | now |
| --- | --- | --- |
| bench static / live / static-files / live-files | 100 loops, 49,200 rows each | same |
| examples/static-site | `layout` 9 loops, 87 rows | 9 loops, 87 rows rendered |
| examples/multilingual-site | `layout` 8 / 32 | 8 / 32 rendered |
| examples/dashboard, realworld | no unroll | no unroll |
| sinter-mail, 16 pages | `minify` 10 / 1,610 | 10 / 1,610 rendered |

All identical both ways. The 16-page sinter-mail build: 25.0 s off, 13.4 s on (load 6–7).

The tests now count the route on a compile of their own without `SN_LINK_AUDIT` (whose extra compiles moved the
process-wide counters: 11 failures under CI's link-audit job); the audited compile runs beside it.
`SN_RENDER_STATS=<file>` appends one line per loop (`<reason or rendered>\t<rows>`), so a run of many processes (the
suite) can be summed.

## The suite, and what the old route is still needed for

Merged with the integration branch at 1f956f1 (the floor agent's `frozenData` and `componentCache`): compiler tests
1,041 pass, plain, `SN_RENDER_AUDIT=1` and `SN_LINK_AUDIT=1`; the render audit and the sinter-mail audit are identical
with nothing left to the second pass. The whole suite: 2,837 pass plain; under `SN_RENDER_AUDIT=1` 2,836 pass and one
times out at 5 s under load (`test/check/check.test.ts`, the strictNullChecks case; it passes alone, audited), 234
pages checked both ways. Its loops (`SN_RENDER_STATS`), over every test:

| route | loops | rows |
| --- | ---: | ---: |
| rendered | 257 | 49,121 |
| `links` | 36 | 71 |
| `top-level choice` | 7 | 7 |
| `diagnostics` | 3 | 5 |
| `handler` | 3 | 29 |
| `text`, `not written ahead`, `an id` | 2 each | 2 each |

`tag attributes`, `where it is`, `in the head`, `a sinter attribute`, `minify`, `layout`, `styled`, `images`, `fill`:
none.

### What each remaining reason needs (not done)

- **`links`** (tests only: no app's rows hit it; a page whose code reads `$url`, or axis lists). The walk of each
  `<a>`/`<area>` pushes a `hrefs` entry (`element()`: a static `href` as `literal`; `attrBinding`/`hrefBinding`: a
  bound one with the prefixes of its code, `hrefPrefixes(entryValue(...))`, over the pass-2 code where the row's item
  is a JS literal, and `boundHrefs`), read by `seesSameLink` (same-page links) and `checkDroppedQuery` (SN519), and,
  with axis lists, `markAxisLink` writes `data-sinter-pt` from the row chain (`rowOf`: each level's list text and
  item, `axisEntryOf`). A rendered block would carry per link: the static entry (easy), the axis mark (computable in
  the first pass: each level's `snSource` and item are in the records), and for a bound `href` the prefixes the old
  route computes from code text with the item inlined, which is the part that would need the second pass's code (or
  a proof that the painted value gives the same prefixes): left.
- **`top-level choice`** (and recursion points outside loops). Pass 2's `expandConstants` inlines the case where the
  `<sn-component>` is (`inlineInstance`: the clone becomes the component's tag, the outer tags' plain attributes passed
  on, `expandUse` with the real `data-sn-with`), keyed `instAt = <ck>#0/` for the decisions inside, with
  `scopeStart`/`fillOf`/`childrenOf` handed to its nodes. The renderer can render it (`instance()`), but the splice is
  at a choice, not a loop: the ids, the list compile and the files are a loop's; `passOn` attributes; and a choice may
  be a component's root (`where it is`). Next in line: it is the last user of `inlineInstance`.
- **`diagnostics`**: the old route reports a template's diagnostics once per instance with its chain and position in
  pass 2; a rendered block would have to re-report each, per row, as pass 2 would word and place them. Left (a page
  with warnings in its rows is compiled the old way).
- **`an id`**: `declare` (`page.ids`) and `componentIds` (SN209, by the number of uses an expansion makes) read ids
  before the walk; the block would carry its ids and its uses' counts. Small; left.
- **Rows that keep something live** (`handler`, `not painted`/`not written ahead`, `text`, `a sinter attribute`):
  the residue. The old route walks the row element with the item as a let of literal code (`rowLets`:
  `(${jsLiteral(item)})`), so a kept binding's function is compiled from that text, numbered where the walk meets it
  (`data-sn` id, `fns` index, dedupe by text), and the element keeps `data-sn`. To bind the residue without re-walking:
  per kept binding, the pass-1 code with the item's name substituted by its literal through a structural hole (not
  by text pattern: `contract.md` §2), `this.fn` at the block's position in walk order, an id from `nextId` at the
  element's place (the count before it in the block), and the node pushed to `roots`/`paints` in order. That is the
  stage 3 machinery (assembling numbers) more than a coverage step; the 3 `handler` loops in the suite are the only
  cases seen.

### Can the old route be deleted?

Not yet: the remaining reasons above take it, so do dev builds (they never render: their function table keeps the
rows' slots), `SN_RENDER=0`, and the in-process audit (`SN_RENDER_AUDIT`) compares against it. On the measured apps
it is no longer taken at all. Once `top-level choice` and `links` are rendered and the others are judged acceptable to
refuse (a page with diagnostics or live parts in its rows could be the old route's only users, or rendered with a
residue), deleting it removes, by my count: the rows branch of `expandConstants` (~35 lines with the
`inlineInstance` call site), `inlineInstance` (28), `rowLets` and the `RowInfo`/`rowOf` plumbing (~40: `element()`,
`prefold`'s prefixes, `markAxisLink`), the nested commit of `unrolls`/`decided`/`rowPaint` in `finish` (~10) and the
row prefixes of `collectConstants`: about 150 lines, plus the fallback bookkeeping. `cloneTree` itself stays (slots,
fills, the dry run's snapshot use it).

## The rest, and the deletion

Running log (2026-11-23, continued). Merged at 4c3e26c. Counting changed first: `rowRenderer` no longer counts a
fallback where it gives up (a page whose first pass has errors never reaches the second pass's rows, so it was
counted for nothing); it records the reason by key (`unrendered`, handed to the second pass), and the second pass
counts it where the old route actually compiles the loop or the choice (`oldRoute`), with `dev` for a dev build. So
`SN_RENDER_STATS` now says what takes the old route. Under vitest a third column names the test.

### `links`

**What the old route does.** The walk of each row copy's `<a>`/`<area>` pushes `hrefs` entries: a static `href` as
`literal`, and a bound one with `hrefPrefixes(entryValue(r, e))` (`data-sn-attr`) or the template's literal start
(`data-sn-href`), plus `boundHrefs`; with axis lists `markAxisLink` appends `data-sinter-pt` from the row chain
(`rowOf`, innermost first). The note above assumed the prefixes come from code with the item inlined: they do not,
`entryValue` reads the AST of the attribute as written (`r.ast`), so a copy's entries are its template's.

**Now.** The renderer takes each link's entries from the first pass's walk of its template element (`hrefs`, in its
order; a guard falls back if a static or bound `href` has no entry there), and the second pass pushes them at the
block's first element in the walk (with each element's origin and source location, so SN519 reports where the old
route does). The axis mark is computed from the rows being rendered (each level's list as written, `snSource`, and its
item) and written after `prefold`'s writes, before the marks. Left: a pager link (SN519 may fire) inside an instance,
whose report the old route words with the instance's chain (`links`, a test).

### `top-level choice`

The first pass records the case as it records a row's (`expandCase` with a record), and the renderer renders it as an
instance (`instance()`); the second pass splices it where the candidate is (`splice`, shared with the loops), before
`inlineInstance`. Also needed: the second pass is now handed `rendered` when the page has decided choices but no
unrolled loop. Left: a choice whose rendered candidate was reported on in the first pass (SN313 on its tag:
`choiceDiags`), which the old route's expansion reports again (`diagnostics`), and one whose tag passes attributes on
(`passOn`, `choice`; not seen).

### `an id`

The ids the rows' markup writes are carried with the block (`idAttrs`) and declared by `declare` at the block (`page.ids`
counts, `dialogs`). Left: an id in a choice's or recursion point's definition (`componentIds`' SN209 counts the uses
the old route's expansion makes per instance).
