# Markdown in userland: step 1 of the component-libraries proposal

[docs/proposals/component-libraries.md](../../docs/proposals/component-libraries.md), Plan step 1: a
spike that measures, before any compiler change. Markdown is parsed by an ordinary helper over
mdast and rendered by recursive `md-*` components dispatched with `<sn-component use>`, with today's
sinter. Two small sinter fixes were needed to make it run at all (below); nothing else in sinter
changed.

| file | what |
| --- | --- |
| [`src/md.js`](src/md.js) | `md.parse(source, options)`: mdast-util-from-markdown + GFM, positions dropped; the options of section 10 (`headings: 'strong'`, `images: 'link'`, `html: 'text' \| 'drop'`) applied to the tree. `md.kind(n)`: the dispatch key |
| [`scripts/components.mjs`](scripts/components.mjs) | writes the 24 components in `src/components/`: `md-doc`, `md-p`, `md-h1`…`md-h6`, `md-ul`, `md-ol`, `md-blockquote`, `md-code`, `md-hr`, `md-html`, `md-table`, `md-text`, `md-em`, `md-strong`, `md-del`, `md-inline-code`, `md-br`, `md-a`, `md-img`, `md-html-inline`. Blocks are chosen from a map of 14 candidates, inlines from 9 |
| [`article.html`](article.html) | a long article from the API (`/api/article`, 47.5 kB of markdown, 2,963 mdast nodes, every node type), parsed in a `data-sn-let` |
| [`comments.html`](comments.html) | 50 comments, parsed per keyed row with the user-content policy |
| [`tree.html`](tree.html) | the same article sent by the API as mdast (143 kB of JSON): no parse |
| [`stream.html`](stream.html) | streamed markdown, simulated: each click shows 2,000 more characters |
| [`data.mjs`](data.mjs), [`api.mjs`](api.mjs), [`server.mjs`](server.mjs) | the generated data; the API in Vite and in a Node server (with `@tiaforge-ui/sinter/server` for embedded data) |
| [`verify.mjs`](verify.mjs) | the rendered article against `mdast-util-to-hast` + `hast-util-to-html` |
| [`measure.mjs`](measure.mjs) | the measurements; [`results/2026-11-15.json`](results/2026-11-15.json) |

Every page sends `require-trusted-types-for 'script'` (a CSP `<meta>`); no run reported a violation.

```sh
npm run build                                  # repository root: sinter's dist/
cd bench/markdown && npm install
npx vite build && SINTER_EMBED=1 npx vite build
node server.mjs dist 4390 & node server.mjs dist-embed 4391 &
node verify.mjs                                # equal: 60255 characters of normalized HTML
node measure.mjs > results/<date>.json         # RUNS=5 by default
```

Headless Chromium on the session's cloud machine, no CPU or network throttling, loopback server with
gzip; median of 5 fresh contexts. Absolute numbers are one machine's; the ratios are the point.

## Correctness

The rendered article equals mdast-util-to-hast's HTML for the same tree once templates, comments,
sinter attributes and md-text's `<span>`s are taken out (`verify.mjs`), except whitespace to-hast adds
after a task checkbox and after `<br>`. Raw HTML is shown as text (`.md-raw`) and to-hast drops it, so
both are left out of the comparison.

## Results

### The parser's builds and Trusted Types

- **Confirmed:** Vite resolves `decode-named-character-reference` through its `browser` condition to
  `index.dom.js`, which decodes entities with `innerHTML`. Under `require-trusted-types-for 'script'`
  the first `&amp;` throws "This document requires 'TrustedHTML' assignment" and nothing renders.
  The spike aliases it to `index.js` (`vite.config.js`; `DOM_DECODER=1` keeps the browser build).
- `micromark`, `mdast-util-from-markdown` and the GFM extensions have `development` builds (asserts);
  Vite's production build takes `default`. `micromark-util-symbol` has none.
- **Size, parser alone** (minified, gzip): 35.2 kB with the safe decoder, 23.1 kB with the DOM one:
  the safe build carries `character-entities` (33 kB raw). The shared chunk of the spike's pages, the
  runtime with the parser, is 50.9 kB gzip; each page's own chunk 4.1-4.3 kB.

### Render time and bindings, a long article

| page | FCP ms | LCP ms | render after the API ms | `md.parse` calls | parse ms | script ms | heap MB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| article, fetched | 32¹ | 468 | 363 | page 4 | 188 | 325 | 9.3 |
| article, embedded | 520 | 1,292 | — | early 2, page 4 | 586 | 770 | 10.0 |
| article, embedded, early file only² | 548 | 548 | — | early 2 | 209 | 379 | 5.6 |
| tree from the API, fetched | 320 | 320 | 211 | 0 | 0 | 176 | 8.0 |
| tree, embedded | 316 | 316 | — | 0 | 0 | 196 | 10.8 |
| 50 comments, fetched | 196 | 196 | 144 | page 100 | 68 | 112 | 3.8 |
| 50 comments, embedded | 220 | 220 | — | early 100, page 100 | 158 | 146 | 4.4 |

¹ the page's re-render button. ² the page module blocked: what the early file paints.

- **Each let is parsed twice per evaluation.** A let is inlined into every expression that reads it,
  and `doc` is read twice (the `md-doc` prop, and the list inside it): 4 parses on the fetched
  article (2 of `''` before the data, 2 of 47.5 kB), 100 for 50 comments. Parsing is 40-60% of the
  time from response to rendered (the parser alone: 69 ms per article in Node, ~95 ms in the page).
- **Bindings: 27,285 for 2,963 mdast nodes, about 9 per node**, almost all of them `for`s: every
  candidate of every `<sn-component use>` is a template with its own `for` over `use`. 5,477 for the
  50 comments.
- **Without the parse (tree from the API) LCP is 150 ms sooner** (320 against 468), with the parser
  still in the shared chunk: what a cached or build-time parse can win at most, with these components.

### The DOM, per node

Article, 2,963 mdast nodes:

| in `<main>` | count | per mdast node |
| --- | --- | --- |
| elements (not templates) | 2,831 | 0.96 |
| `<template>`s in place | 25,150 | 8.5 |
| of which `data-sn-def` candidates, empty | 20,840 | 7.0 |
| of which `data-sn-def` candidates, filled with a copy of their definition | 2,380 | 0.8 |
| nodes inside those templates' content | 16,230 | 5.5 |
| comments (end anchors) | 24,774 | 8.4 |
| text nodes | 1,612 | |

- **With 15 candidates, each dispatched node carries a template and an end comment per candidate**:
  14 + 14 for a block, 9 + 9 for an inline, whichever one renders. 2,831 elements cost 49,924
  templates and comments.
- A candidate that renders once keeps a full copy of its definition in its `content` (`defs.ts` fills
  it before the first clone), per place in the tree: 16,230 inert nodes.
- Every run of text is a `<span>`, as the proposal says: 1,461 of the 2,831 elements are `md-text`.
- CSS: `li + li` and `:first-child` see the templates; `.md > :first-child` matches the `<template>`.

### Embedded data: the early file and the takeover

- **The early file is 39.2 kB gzip + 2.8 kB shared, against `earlyBudget` 10 kB** (SN523 on the
  article, comments and stream pages): the early bindings call `md.parse`, so the parser and the
  entity table are in it. On the tree page, with no parse, it is 4.0 + 2.8 kB. "The early bindings
  of article.html" are 142 kB raw (90 kB on the tree page): each branch is inlined at each use.
- **The early file parses twice before the first paint**: 187-249 ms of blocking script (FCP 520-548
  ms against 32).
- **The article is not kept at takeover.** The page module adopts the 2,831 early elements, then
  evaluates the let again (4 more parses), gets new node objects, and replaces every row: unkeyed rows
  are keyed by item identity. LCP moves to 1,292 ms, 2.8× the fetched page. The tree page (the same
  objects) and the comments (keyed rows; their inner trees evaluated once) keep every early element.
  A let cache handed from the early file to the page module (step 10, the first open question) is
  what the article needs; without it embedding a parsed value costs more than fetching it.

### Re-parse per render, and per streamed chunk

- **A re-render with the same source** (`rev` changes, which the let reads): 2 parses and a new tree,
  so no element is kept (`firstParagraphKept: false`): 368 ms (median of 5).
- **Streaming**, 2,000 characters a chunk, 24 chunks to 47.5 kB: each chunk parses the whole prefix
  twice and replaces the tree: 69 ms for the first chunk, 382 ms for the last, 201 ms median: linear
  per chunk, quadratic over the stream.

### A walk at mount, 20,000 nodes

16,000 elements (1 in 10 with `data-sn`) and 4,000 comments, median of 25 in the page:

| | ms |
| --- | --- |
| `querySelectorAll('[data-sn]')` (today) | 0.2 |
| TreeWalker over elements and comments | 0.5 |
| TreeWalker over comments only | 0.3 |
| TreeWalker over both, testing each node (`data-sn` / a comment starting `sn`) | 1.4 |

A walk that finds comment anchors costs about 1 ms more than today's lookup on a page of 20,000
nodes, under 1% of this article's render.

### What the spike could not measure

- **LCP with the parser lazy.** A helper module may not reach a lazy package (`SN324`); a let cannot
  wait (step 10). The tree page bounds it: a lazy parser can at best match its 320 ms, minus the
  download, after which it parses as the fetched page does.
- Fills, tree slots and constant folding need the compiler (steps 2-9).

## sinter fixes this needed

Both in the same commit on this branch, with tests in `test/behaviour/recursion.test.ts`:

- **`<sn-component use>` inside a `data-sn-for` failed in Chromium** with `Cannot read properties of
  null (reading 'content')`: `defs.ts` looked the definition up with `tpl.ownerDocument`, which for a
  candidate inside a row not yet inserted is the row template's inert document. It now uses the
  document the app is mounted on. jsdom and happy-dom resolve the old lookup, so the unit tests did
  not see it; this spike is its reproduction in a browser.
- **Mutual recursion through `<sn-component use>` overflowed the stack with `embed: true`**:
  `early-render.ts` inlined each template's branch at each use, without end for templates that reach
  each other. Those are now written once into a table `B` and referenced; a template that does not reach
  itself is inlined as before, so other pages' early files do not change.
