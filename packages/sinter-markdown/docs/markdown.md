# Markdown

`@tiaforge-ui/sinter-markdown` renders markdown in a sinter app: from a file in the repo, as plain
HTML at build time, and from an API, parsed in the browser. It is a [component
library](https://github.com/tiaforge/sinter/blob/main/docs/libraries.md): a parser, `md.parse`, that
returns a tree, and components, `<md-doc>` and `<md-inline>`, that render it. How a kind of node looks is
changed with slots.

```html
<sn-resource name="post" src="file:./post.md"></sn-resource>
<main data-sn-let="{ doc: md.parse(post) }">
  <md-doc data-sn-prop="{ doc }"></md-doc>
</main>
```

The [recipe](recipes/article-with-comments.html) puts an article and its comments on one page.

## Setup

```sh
npm install @tiaforge-ui/sinter-markdown
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter({ components: ['@tiaforge-ui/sinter-markdown'] })],
});
```

```ts
// src/sinter.helpers.ts: the helpers, as the namespace `md`
export * as md from '@tiaforge-ui/sinter-markdown';

// src/sinter.types.ts: the tree's types, for your own declarations
export type { Root, Heading, Link, TocEntry } from '@tiaforge-ui/sinter-markdown';
```

## Three places, one function

`md.parse(source, options)` is a pure function, so sinter runs it wherever its argument is:

| Markdown | Where it is parsed | What the page ships |
| --- | --- | --- |
| A file: `src="file:./post.md"` | at build time | the article as plain HTML, no JavaScript ([static pages](https://github.com/tiaforge/sinter/blob/main/docs/static-pages.md)) |
| A string from an API, in a `data-sn-let` | in the browser, once per source and options (md.parse keeps its trees) | the parser with the page |
| The same, with the parser lazy | in the browser, once the parser has loaded | the parser in a chunk of its own, loaded when a let first needs it |
| A tree from an API (`md.parse` run on the server, `<md-doc data-sn-prop="{ doc: article.doc }">`) | on the server, once per document | no parser: the fastest way to show an API's markdown ([Performance](#performance)) |

To make the parser lazy, list the package in `lazy`:

```js
sinter({ components: ['@tiaforge-ui/sinter-markdown'], lazy: ['@tiaforge-ui/sinter-markdown'] })
```

A let that calls `md.parse` is then `undefined` until the parser has arrived, and its arrival renders
what reads the let; `<md-doc>` with no `doc` renders an empty `<div class="md">`. `md.headings` and
`md.text` live in a module that does not import the parser, so they stay ordinary helpers either way.
Measure first: the parser is about 36 kB gzip, and a page whose main content is markdown may reach
its LCP sooner with the parser loaded with the page (or with `data-sn-preload`).

A parser in the early script is not worth it: with embedded data, a let over `md.parse` puts the
parser into the early file, four times sinter's early budget (`SN523`). Markdown from an API is in the
first frame only when the API sends the tree (`md.parse` run on the server), which `<md-doc>` renders
like any other data.

## `md.parse(source, options)`

`source` is the markdown (`null` and `undefined` are an empty document). The result is a tree of
plain data, typed by the package (`Root`): CommonMark, and GFM tables, task lists, strikethrough and
autolinks. Footnotes are not supported. Positions are left out, and so are definitions: references
(`[text][ref]`) come back as links and images. Entities are decoded (`&amp;` is `&`).

The options are the policy for one use. What a document may not contain is taken out of the tree, so
what reads the tree (a table of contents) agrees with what is shown:

| Option | Values | |
| --- | --- | --- |
| `headings` | `'keep'` (default), `'strong'` | `'strong'`: every heading becomes a paragraph of strong text |
| `images` | `'keep'` (default), `'link'` | `'link'`: every image becomes a link to it, with the alt text as its text |
| `html` | `'text'` (default), `'drop'`, `'allow'` | raw HTML is never markup. `'text'` shows it as written, `'drop'` removes it, `'allow'` keeps `<kbd>`, `<sub>`, `<sup>`, `<mark>` and `<details>` with `<summary>`, with only `open` of their attributes, and shows the rest as written |
| `base` | a folder from the project root, `'/content/posts/'` | relative image and link URLs become root paths under it, so the image pipeline finds an image next to the markdown file. Links to other `.md` files, `#fragments`, `?queries` and absolute URLs stay as written |

For readers' content (comments, reviews):

```html
data-sn-let="{ doc: md.parse(c.body, { headings: 'strong', images: 'link', html: 'text' }) }"
```

An unknown value is an error that lists the values (`md.parse: \`html\` is 'drop', 'text', 'allow'`).

## `md.headings(doc)` and `md.text(node)`

```html
<nav><template data-sn-for="h in md.headings(doc)">
  <a data-sn-attr="{ href: '#' + h.id }" data-sn-text="h.text"></a>
</template></nav>
<p class="summary" data-sn-text="md.text(doc).slice(0, 160)"></p>
<p class="time" data-sn-text="Math.ceil(md.text(doc).split(/\s+/).length / 230) + ' min read'"></p>
```

- `md.headings(doc)` lists the headings at any depth (in quotes and lists too) as `{ depth, id, text }`.
  `id` is the heading's anchor in `<md-doc>`: `md-` and a slug of its text, as GitHub writes slugs
  (`## Getting started` is `id="md-getting-started"`), with `-1`, `-2` for repeats. The prefix is there
  because an id written from data could shadow a global another script reads (DOM clobbering, sinter's
  `SN503`). A heading node carries the slug (`node.slug`), so a heading fill writes the same id.
- `md.text(node)` is the plain text of a document, a node or a list of nodes: inline content run
  together, blocks separated by a blank line, an image as its alt text. For a description or a reading
  time.

Both are pure: over a file they run at build time. In the browser they walk the tree at each read,
which is cheap (about 0.1–0.2 ms on a 47.5 kB article).

### The tree is kept and frozen

A let or a prop is evaluated where it is read, and `<md-doc>` reads its `doc` at every node, so
`md.parse` keeps the trees it returns: the same source and options give the same tree, parsed once,
whichever let, prop or row asks. Equal options are one policy (`{}` and `{ html: 'text' }`). The tree
is frozen, at every depth, and shared: to change one, change a copy (`structuredClone(doc)`). About
8 MiB of trees are kept, the least recently used dropped first.

## `<md-doc>` and `<md-inline>`

| | Renders | Root |
| --- | --- | --- |
| `<md-doc data-sn-prop="{ doc }">` | the blocks of a document | `<div class="md">` |
| `<md-inline data-sn-prop="{ doc }">` | one line: the content of the paragraphs and headings, without their elements, with a space between two of them (a title, a label); other blocks are left out | `<span class="md">` |

- `doc` is optional: with none, the root is empty. Its root is always there, so the tag may carry a
  `class`, attributes and handlers.
- `<md-inline>` is phrasing content, a `<span>` with only phrasing content inside, so it is valid in
  a heading, a label, a link or a paragraph: `<h1><md-inline data-sn-prop="{ doc: md.parse(post.title)
  }"></md-inline></h1>`. Parse a title with the options that fit a line; a list or a code block in it
  is not rendered.
- The HTML is what a markdown renderer writes, with no wrapper of its own but one: `<h2 id="md-…">`,
  `<p>`, `<em>`, `<a href title>`, `<pre><code class="language-ts">`, `<ul>`/`<ol start>`, a task's
  `<input type="checkbox" disabled>` in an `<li class="task-list-item">`, `<blockquote>`, `<hr>`, and a
  table in a `<div class="md-table">` (the one wrapper, see the `table` slot).
- Lists and branches are marked by comments in the page, as everywhere in sinter, so prose CSS sees
  plain HTML: `.md h2 + p`, `.md li:first-child` and `.md > * + *` match as they would in static HTML.
- A link's and an image's URL are attribute bindings, so sinter refuses `javascript:` and other unsafe
  schemes, in the browser and at build time, whatever the parser let through.
- An image is a plain `<img>`. From a file it is a local image, optimized as any image in a page
  (`<picture>`, `srcset`, `width` and `height`). From an API it is written as given, and is not sent
  through the app's resizing service (`images.remote`): readers' content may name any image. Fill the
  `image` slot to resize it.

## Slots

`<md-doc>` declares one slot per kind of node an app is likely to change; `<md-inline>` declares the
ones it can render, `link`, `image` and `inlineCode`. A fill changes that kind of node wherever it is
in the tree, in a list item, a quote or a table cell. Each passes the node as `$slot.node`, and a
`<slot>` inside the fill is the default element's children:

| Slot | `$slot.node` | Default |
| --- | --- | --- |
| `heading` | `Heading` (`depth`, `slug`, `children`) | `<h1 id="md-…">`…`<h6>` |
| `link` | `Link` (`url`, `title`, `children`) | `<a href title>` |
| `image` | `Image` (`url`, `alt`, `title`) | `<img src alt title>` |
| `code` | `Code` (`lang`, `meta`, `value`) | `<pre><code class="language-…">` |
| `inlineCode` | `InlineCode` (`value`) | `<code>` |
| `blockquote` | `Blockquote` (`children`) | `<blockquote>` |
| `table` | `Table` (`align`, `children`) | `<div class="md-table"><table>…</table></div>` |

```html
<md-doc data-sn-prop="{ doc }">
  <!-- readers' links -->
  <a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a>
  <!-- a heading with a link to itself: an if chain over the depth -->
  <template slot="heading" data-sn-if="$slot.node.depth === 1"><h1 data-sn-attr="{ id: 'md-' + $slot.node.slug }"><slot></slot></h1></template>
  <template data-sn-else><h2 data-sn-attr="{ id: 'md-' + $slot.node.slug }"><slot></slot> <a data-sn-attr="{ href: '#md-' + $slot.node.slug }">#</a></h2></template>
  <!-- a table that scrolls: the fill places the whole table -->
  <div slot="table" class="scroll"><slot></slot></div>
  <!-- a code block with a caption -->
  <figure slot="code"><pre><code data-sn-text="$slot.node.value"></code></pre><figcaption data-sn-text="$slot.node.lang"></figcaption></figure>
</md-doc>
```

- The table's default is a wrapper around the `<table>` because the HTML parser moves a `<slot>`
  written inside a `<table>` out of it: a fill cannot write `<table><slot></slot></table>`, so it
  places the whole table, or renders its own from `$slot.node`.
- A fill is the page's markup: it reads the page's state and helpers, and its handlers write the page's
  state. Over a file, a fill that reads only constants is expanded at build time with the rest of the
  tree, the ones above included. Two kinds render in the browser instead: a fill that holds a
  component with slots of its own (another `<md-doc>`), and one your wrapper passes on with
  `<slot name="link" slot="link">`; on a static page, `SN322` names the fill and why. A code block's fill can highlight at build time with a helper of yours over `$slot.node.value`.
- To give every page the same looks, write a wrapper component whose root is `<md-doc>` with your
  fills, and use it instead
  ([app-wide looks](https://github.com/tiaforge/sinter/blob/main/docs/components.md#tree-slots)).
  Name the package's types in your own declarations through `src/sinter.types.ts`.

## Styles

The components carry no CSS. Style the tree under `.md`, which both roots have:

```css
.md > * + * { margin-block-start: 1em; }
.md .task-list-item { list-style: none; }
.md .md-table { overflow-x: auto; }
```

## Performance

The 300-block article of sinter's markdown measurements (47.5 kB of markdown, every node type) in headless
Chromium on one machine over loopback, served gzipped, median of 21 runs, the three pages interleaved in one
session (2026-11-16). The comparison is the RealWorld example's article body: the same markdown through marked
and DOMPurify into `innerHTML`, without Trusted Types (`innerHTML` with a string needs a policy).

| Page | LCP | Script | Page module (gzip) | On the wire (gzip) | Comments |
| --- | ---: | ---: | ---: | ---: | ---: |
| tree from the API (`md.parse` on the server) | 120 ms | 36 ms | 4.4 kB | 14.0 kB | 3,090 |
| markdown from the API, `md.parse` in the page | 156 ms | 63 ms | 42.8 kB | 11.3 kB | 3,090 |
| RealWorld's island (marked + DOMPurify) | 160 ms | 8 ms | (marked and DOMPurify) | 11.3 kB | 2 |

- Every page renders the same 1,365 elements (the island 1,370: marked writes newlines between blocks as text).
- The parse is most of the difference between the first two rows: markdown-it, run cold, then the tree. The
  tree is about 25 % larger on the wire than its markdown; the page needs no parser at all.
- The island's script time leaves out the browser's own parsing of the HTML string, which is in its LCP.
- The comments are the anchors of lists and branches, which keep the page live: a change to the source renders
  again what changed. A row or branch that is only another branch, or only a text, has none of its own.
- From a file (`file:`), the article is HTML at build time and ships no JavaScript: LCP 56–60 ms in an earlier
  session of the same machine.

## Limits

- A raw HTML block is CommonMark's: a line that starts with a tag (`<div>`, `<script>`) makes the whole
  block raw, so the markdown after it on those lines is shown as written too.
- `<details>` under `html: 'allow'` is kept when its start and end are blocks of their own between
  the same siblings (`<details>` … blank line … blocks … blank line … `</details>`); otherwise it is
  shown as written.
- Links between markdown files stay as written; a page per markdown file is not part of sinter yet.
- Parsing a stream parses the whole source again for each chunk.
