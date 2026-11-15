# Markdown in userland: step 1 of the component-libraries proposal

The Plan's step 1 in the component-libraries proposal (`docs/proposals/component-libraries.md`, on
branch `ccr-ad93e367-x7ugq8`): a spike that measures, before any compiler change. Markdown is parsed
by an ordinary helper over mdast and rendered by recursive `md-*` components dispatched with
`<sn-component use>`, with today's sinter. Two small sinter fixes were needed for it to run at all
(below). Nothing else in sinter changed. The API runs inside the example, as in `examples/dashboard`:
Vite middleware in dev and preview, and `server.mjs` for the measured builds.

| file | what |
| --- | --- |
| [`src/md.js`](src/md.js) | `md.parse(source, options)`: mdast-util-from-markdown + GFM, positions dropped, and the options of section 10 (`headings: 'strong'`, `images: 'link'`, `html: 'text' \| 'drop'`) applied to the tree. `md.kind(n)` is the dispatch key |
| [`scripts/components.mjs`](scripts/components.mjs) | writes the 24 components in `src/components/`: `md-doc`, `md-p`, `md-h1`…`md-h6`, `md-ul`, `md-ol`, `md-blockquote`, `md-code`, `md-hr`, `md-html`, `md-table`, `md-text`, `md-em`, `md-strong`, `md-del`, `md-inline-code`, `md-br`, `md-a`, `md-img`, `md-html-inline`. Blocks are chosen from a map of 14 candidates, inlines from 9 |
| [`article.html`](article.html) | a long article from the API (`/api/article`, 47.5 kB of markdown, 2,963 mdast nodes, every node type), parsed in a `data-sn-let` |
| [`comments.html`](comments.html) | 50 comments, parsed per keyed row with the user-content policy. Comment 2 is `Fish &amp;amp; chips` |
| [`tree.html`](tree.html) | the same article sent by the API as mdast (143 kB of JSON), with no parse |
| [`stream.html`](stream.html) | streamed markdown, simulated: each click shows 2,000 more characters |
| [`island.html`](island.html), [`src/island.js`](src/island.js) | the comparison point: the article rendered the way RealWorld renders its body (`examples/realworld/src/markdown.js`, the same code, marked 16.4.1 and DOMPurify 3.3.0) |
| [`data.mjs`](data.mjs), [`api.mjs`](api.mjs), [`server.mjs`](server.mjs) | the generated data, and the API in Vite and in a Node server (with `@tiaforge-ui/sinter/server` for embedded data) |
| [`verify.mjs`](verify.mjs) | the rendered article against `mdast-util-to-hast` + `hast-util-to-html`, plus prose selectors and the DOM shape |
| [`measure.mjs`](measure.mjs) | the measurements. Results are in [`results/2026-11-15.json`](results/2026-11-15.json) |

**CSP.** Every `md-*` page has `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`
(a `<meta>`) and records `securitypolicyviolation` events: there were none. The island page has no
`require-trusted-types-for`, because it writes `innerHTML`, as RealWorld does. The repository has no
browser suite under Trusted Types to borrow (see [Contradictions](#contradictions)). The strictest
CSP it tests is `script-src 'self'` in `e2e/navigation`.

```sh
npm run build                                  # repository root: sinter's dist/
cd examples/markdown && npm install
npx vite build && SINTER_EMBED=1 npx vite build && DOM_DECODER=1 npx vite build --outDir dist-dom
node server.mjs dist 4390 & node server.mjs dist-embed 4391 & node server.mjs dist-dom 4392 &
node verify.mjs                                # equal: 60255 characters of normalized HTML, then selectors and shape
node measure.mjs > results/<date>.json         # RUNS=5 by default
npx vite                                       # dev, with the API
```

**Method.** Headless Chromium (Playwright's) on the session's cloud machine, with no CPU or network
throttling. The server is on loopback with gzip. Each figure is the median of 5 runs, each in a
fresh context. LCP and FCP come from `PerformanceObserver` with buffered entries. "Rendered" is the
last DOM mutation (a `MutationObserver` from an init script) before the page is quiet for 300 ms,
and "after the API" is that time minus the API resource's `responseEnd`. Script and style/layout
times come from CDP `Performance.getMetrics`, and heap from CDP `Runtime.getHeapUsage` after a forced
GC. `md.parse` counts its own calls and time, separately in the early file's copy and in the page
module's copy. Absolute numbers are for one machine; the ratios are what matters.

## Correctness

The rendered article equals mdast-util-to-hast's HTML for the same tree, after the following are
removed from both:
- templates, comments and sinter attributes;
- md-text's `<span>`s (unwrapped);
- the whitespace to-hast writes after a task checkbox and after `<br>`.

Raw HTML is shown as text (`.md-raw`) and to-hast drops it, so both sides leave it out. Comment 2
renders as `Fish &amp; chips, and &amp; in code.`

## Results

### The parser's builds and Trusted Types

Export maps (`npm view … exports` and the installed `package.json`s):

| package | conditions | touches the DOM |
| --- | --- | --- |
| `decode-named-character-reference` 1.3.0 | `browser` → `index.dom.js`, `default` → `index.js` | `index.dom.js:5,13`: `document.createElement('i')`, then `element.innerHTML = …` |
| `micromark` 4.0.3 | `development` → `dev/index.js`, `default` | `dev/lib/create-tokenizer.js` imports `debug` (a dependency of micromark) |
| `debug` 4.4.3 | `browser` field → `src/browser.js` | `src/browser.js:119-140` reads `window` and `navigator.userAgent`, and `:251` returns `localStorage`, all guarded |
| `mdast-util-from-markdown`, GFM extensions, `devlop` | `development` → asserts | no |
| `micromark-util-symbol` | none | no |

- **Production build** (`vite build`): Vite takes the `browser` condition. Under Trusted Types every
  parse of a source with an entity throws "This document requires 'TrustedHTML' assignment" (one
  `require-trusted-types-for` violation, sample `Element innerHTML|&amp;`).
  - On the article, which is one let, nothing renders.
  - On the comment list, 19 of the 50 comments render their author and an empty body, the page goes
    on, and the only trace is a console error per comment.

  The spike aliases the decoder to `index.js` (`vite.config.js`; `DOM_DECODER=1` keeps the browser
  build).
- **Dev** (`vite`): the `development` condition bundles `micromark/dev` with `debug`'s browser build
  (45 `createDebug` references in the pre-bundled `mdast-util-from-markdown.js`). It renders under
  the CSP with no error, since `debug`'s access is guarded. The alias keeps dev on the safe decoder
  too.
- **Size of the parser alone** (minified, gzip): 35.2 kB with the safe decoder against 23.1 kB with
  the DOM one. The difference is `character-entities` (33 kB raw). In the build it is the `md` chunk
  (35.2 kB), and the runtime's shared chunk is a further 15.4 kB. Each page's own chunk is 4.1-4.3 kB.
  The island's marked + DOMPurify chunk is 20.5 kB.

### Render time and bindings, a long article

| page | FCP ms | LCP ms | after the API ms | `md.parse` calls | parse ms | script ms | heap MB | elements |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| article, fetched | 40¹ | 424 | 346 | page 4 | 182 | 315 | 9.3 | 2,831 |
| article, embedded | 484 | 1,164 | — | early 2, page 4 | 538 | 651 | 10.0 | 2,831 |
| article, embedded, early file only² | 472 | 472 | — | early 2 | 197 | 336 | 5.6 | 2,831 |
| tree from the API, fetched | 264 | 264 | 178 | 0 | 0 | 148 | 8.0 | 2,831 |
| tree, embedded | 252 | 252 | — | 0 | 0 | 152 | 10.8 | 2,831 |
| **island: marked + DOMPurify (RealWorld)** | 188 | **188** | 120 | — | — | 10 | 2.2 | 1,370 |
| 50 comments, fetched | 200 | 200 | 143 | page 100 | 71 | 114 | 3.7 | 646 |
| 50 comments, embedded | 188 | 188 | — | early 100, page 100 | 137 | 123 | 4.3 | 646 |

¹ the FCP is the page's re-render button. ² the page module is blocked, so this is what the early file paints.

- **The RealWorld island is 2.3× faster to LCP** than the components (188 against 424 ms), and is
  still faster than the components with no parse at all (264 ms). Loaded with the page, its renderer
  does not hold the article, which is the case `examples/realworld/src/markdown.js:6` describes.
  Most of the gap is rendering, not parsing: the island creates 1,370 elements with one `innerHTML`.
- **Each let is parsed twice per evaluation.** A let is inlined into every expression that reads it,
  and `doc` is read twice (by the `md-doc` prop and by the list inside it).
  - The fetched article makes 4 parses: 2 of `''` before the data, then 2 of 47.5 kB.
  - The 50 comments make 100.

  Parsing is about half of the time from response to rendered: 182 of 346 ms for the article, about
  90 ms per parse in the page and 82 ms in Node.
- **Bindings: 27,285 for 2,963 mdast nodes**, about 9 per node. Almost all are `for`s: every
  candidate of every `<sn-component use>` is a template with its own `for` over `use`. The comments
  have 5,308; the island has 654 (the page's own).
- **Without the parse (tree from the API), LCP is 160 ms sooner** (264 against 424 ms), with the same
  bytes. That is the most a cached or build-time parse can win with these components.

### The DOM, per node

Article, 2,963 mdast nodes, in `<main>`:

| | count | per mdast node |
| --- | --- | --- |
| elements (not templates) | 2,831 | 0.96 |
| `<template>`s in place | 25,150 | 8.5 |
| … `data-sn-def` candidates, empty | 20,840 | 7.0 |
| … candidates filled with a copy of their definition | 2,380 | 0.8 |
| nodes inside those templates' `content` | 16,230 | 5.5 |
| comments (end anchors) | 24,774 | 8.4 |

- **With ~15 candidates, each dispatched node carries a template and an end comment for every
  candidate**, whichever one renders: 14 + 14 for a block and 9 + 9 for an inline. The 2,831
  elements cost 49,924 templates and comments.
- A candidate that renders keeps a full copy of its definition in its `content`, per place in the
  tree, because `defs.ts` fills it before the first clone: 16,230 inert nodes.

**Shape against to-hast's HTML** (`verify.mjs`):
- Extra elements: 1,475 `<span>`s and 7 `<pre>`s.
  - The `<span>`s are 1,461 `md-text` plus 14 `md-html-inline`: a text binding needs an element, so
    every run of text has one.
  - The `<pre>`s are raw HTML blocks, shown as text.
- The one-plain-root rule forced no wrapper beyond those. It forced separate components instead:
  six heading components (`md-h1`…`md-h6`) and two list components, since a root cannot be chosen.
- Inline whitespace is kept: the text compares equal once the spans are unwrapped. The spike has no
  whitespace-only text nodes; to-hast has 911 (newlines between blocks, which do not render).

**Prose CSS** (`verify.mjs`, visible elements matched in `#article` by each selector, against the
same markup without anchors):

| selector | spike | plain HTML |
| --- | --- | --- |
| `li:first-child` | 0 | 63 |
| `li:last-child` | 63 | 63 |
| `li:nth-child(odd)` | 88 | 113 |
| `tr:nth-child(even)` | 27 | 18 |
| `h2 + p` | **0** | 25 |
| `p + p` | **0** | 53 |
| `.md > * + *` | 335 | 327 |
| `.md > :first-child` | 0 | 1 |
| `:is(p, li) > :first-child` | 0 | 338 |
| `ul:empty` | 0 | 0 |

- Adjacent-sibling selectors fail between every pair of dispatched blocks, not only at the first
  row, because 14 empty candidate templates sit before each block.
- `* + *` matches the first block as well.
- `:last-child` still works, since end anchors are comments.

### Embedded data: the early file and the takeover

- **The early file is 39.2 kB gzip, plus 2.8 kB shared, against `earlyBudget` (10,000 bytes)** on the
  article, comments and stream pages (`SN523`).
  - The early bindings call `md.parse`, so the parser and the entity table are in the early file.
  - The tree page, which has no parse, has 4.0 + 2.8 kB.
  - The early bindings are 142 kB raw on the article page and 90 kB on the tree page, because each
    branch is inlined at each use.
- **The early file parses twice before the first paint**: about 200 ms of blocking script, so the
  FCP is 472-484 ms against 40.
- **The takeover replaces the article.** Method: an init script marks every element in `<main>` on
  `DOMContentLoaded`, after the early file and before the async page module, and the marks are
  counted again after the page is quiet.
  - The page module evaluates the let again (4 more parses), gets new node objects, and replaces
    every row of the unkeyed lists, which are matched by item identity. 1 of 2,831 marked elements
    is left (`md-doc`'s root), and LCP moves to 1,164 ms, 2.7× the fetched page.
  - The tree page (the same objects) and the comments (keyed rows, inner trees evaluated once) keep
    all 2,831 and all 646.

### Re-parse per render, and per streamed chunk

- **A re-render with the same source** (`rev` changes, and the let reads it) makes 2 parses and a new
  tree, and no element is kept: 296 ms (median of 5).
- **Streaming**: 24 chunks of 2,000 characters, to 47.5 kB. Each chunk parses the whole prefix twice
  and replaces the tree. The first chunk takes 47 ms, the last 336 ms, and the median is 157 ms: the
  cost per chunk is linear in the length so far, and quadratic over the stream.

### A walk at mount, 20,000 nodes

The page has 16,000 elements (1 in 10 with `data-sn`) and 4,000 comments. Each figure is the median of
25 in the page:

| | ms |
| --- | --- |
| `querySelectorAll('[data-sn]')` (today) | 0.2 |
| TreeWalker over elements and comments | 0.5 |
| TreeWalker over comments only | 0.2 |
| TreeWalker over both, testing each node (`data-sn`, or a comment starting `sn`) | 1.2 |

### What the spike could not measure

- **LCP with the parser lazy.** A helper module may not reach a lazy package (`SN324`), and a let
  cannot wait (step 10). The tree page bounds it: a lazy parser can at best reach the tree page's
  264 ms, minus the download.
- Fills, tree slots and constant folding need the compiler (steps 2-9).

## Contradictions

Places where the code or the measurements disagree with the proposal's "What sinter has to build on",
or with the docs it relies on. Lines refer to `docs/proposals/component-libraries.md` at `1ecc1ab`.

- **Lines 63-65**, "the definition it clones is named by that static attribute (`src/defs.ts`)…
  With embedded data, the early script renders a tree in the first frame at any depth": before
  `5d22ab8`, neither held for choices.
  - `src/defs.ts:12` (at `39fe727`) looked the definition up in `tpl.ownerDocument`, which is null
    for a candidate inside a row that is not yet inserted, so the code threw a TypeError in Chromium.
    jsdom and happy-dom do not reproduce it.
  - `src/compiler/early-render.ts:101-106` (at `39fe727`) inlined a branch at each use without end
    for components that reach each other, which overflowed the stack with `embed: true`.
- **Lines 66-69, the anchors**: "`li:first-child` does not match the first row" understates it for
  choices. With N candidates, N empty templates sit before every dispatched row, so `+` fails between
  any two rows (`h2 + p` 0 of 25) and `:is(p, li) > :first-child` matches nothing (0 of 338).
- **Lines 80-82**, "The page module computes state again on mount": confirmed. As a consequence, a let
  over a helper that returns new objects replaces adopted unkeyed rows
  (`src/runtime/app.ts:1016-1022` keys by identity; `:1029-1046` adopts and then reconciles).
- **Lines 122-124, RealWorld's "lazy renderer"**: loaded with the page, the island is the fastest
  option measured (LCP 188 ms). The components are 2.3× slower at the same place, so the comparison
  point is not met.
- **Lines 926-931**, "the first `&amp;` throws under Trusted Types, so nothing renders": that holds for
  one let. In a list, each failing row renders empty and the page goes on silently.
- **Line 932** ("The library has a browser test with entities under Trusted Types") and the row at
  **line 1223** ("tested under Trusted Types"): `docs/security.md:112-113` says "The browser test suite
  runs with Trusted Types enforced and a strict CSP, and fails on any violation report". No such suite
  exists: no test or e2e file sets `require-trusted-types-for`, and the only CSP in a browser test is
  `script-src 'self'` (`e2e/navigation/index.html:6`, with its probe in `e2e/navigation/run.mjs:31`).

## sinter fixes this needed

Both fixes are in `5d22ab8`, with tests in `test/behaviour/recursion.test.ts` and CHANGELOG entries in
`11b7306`:

- **`<sn-component use>` inside a `data-sn-for` failed in Chromium** with `Cannot read properties of
  null (reading 'content')`. `defs.ts` now looks the definition up in the document the app is mounted
  on. The unit test passes on jsdom with or without the fix; this example is the reproduction in a
  browser.
- **Mutual recursion through `<sn-component use>` overflowed the stack with `embed: true`.** A
  template that reaches itself is now written once into a table `B` in the early file and
  referenced. Other templates are inlined as before, so other pages' early files do not change. The
  regression test fails without the fix.

## Again on step 2: anchors as comments

`results/2026-11-15-step2.json`: the same measurements, built against `impl/anchors-as-comments` at `ec931ff`
(docs/proposals/component-libraries.md, step 2), same machine and method, the page modules rebuilt. Base is
`results/2026-11-15.json`.

| | step 1 | step 2 |
| --- | ---: | ---: |
| `<template>`s in `<main>` (article) | 25,150 | 0 |
| comments (article) | 24,774 | 8,218 (2.8 per node) |
| bindings (article): anchors (comments ÷ 2) and element bindings | 27,285 | ≈6,240 |
| LCP, article fetched | 424 ms | 316 ms |
| after the API, article | 346 ms | 255 ms |
| LCP, tree from the API | 264 ms | 160 ms |
| LCP, article embedded | 1,164 ms | 736 ms |
| LCP, RealWorld island (the bar) | 188 ms | 168 ms |
| heap, article | 9.3 MB | 5.9 MB |
| re-render with the same source | 296 ms | 179 ms |
| stream, median / last chunk | 157 / 336 ms | 100 / 179 ms |

The island moved by 11 % between the runs: read the rows against it. Prose CSS (`verify.mjs`) now matches
plain HTML: `li:first-child` 63/63, `h2 + p` 25/25, `p + p` 53/53, `tr:nth-child(even)` 18/18,
`li:nth-child(odd)` 113/113. Left: `.md > * + *` 334/327 (the 7 raw-HTML `<pre>`s) and `:is(p, li) > :first-child`
368/338 (the text `<span>`s), the spike's own extra elements.
