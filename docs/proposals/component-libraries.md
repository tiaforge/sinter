# Proposal: component libraries, with markdown as the first

Status: draft, for review. Nothing here is implemented. Syntax names (`data-sn-slots`, `$slot`,
`<sn-children>`, `pure()`, `$file()`) are placeholders until the [Plan](#plan)'s first step has been
tried; the rules around them are what this proposal asks to settle.

Decided with the user while drafting:
- Markdown from the repo (built with the site) and markdown from an API (a string in a response)
  matter equally. Streaming and APIs that send a parsed tree are welcome, not the target.
- Parsing and rendering are separate parts. The parser returns a tree, not a stream of tokens.
- How a node looks is changed with slots, not with a map of components.
- Only the root component of a library declares the slots a caller can fill. The library's
  contract stays in one file.

Everything else is proposed here for review; [Decisions](#decisions) keeps the two apart.

## The case

An app wants to render markdown: a docs page from a file in the repo, an article body or a comment
from its API. Today it has two choices, and neither is sinter's:

- **An island** (`<md-view>` with markdown-it in a component script). Nothing is in the first frame,
  every node is built by hand in the script, a link cannot be the app's link, and the parser ships to
  every page that uses it, also for markdown that never changes.
- **HTML from somewhere else**, inserted as markup. sinter has no `innerHTML` binding, and markup from
  the network stays inert ([security.md](../security.md)). That is the right rule and stays.

What the app wants is what sinter does for everything else: markdown from the repo is plain HTML in
the page with no JavaScript; markdown from the API renders with the page's bindings, in the first
frame when its data is embedded; a link inside it prefetches like any link; an image from the repo
gets `srcset`, `width` and `height`; and the app decides how a heading or a link looks.

Markdown is the first case, not the only one. The same pieces serve a syntax-highlighted code
block, math, an icon set, a data table with custom cells, a tree view: **a library that turns a value
into a tree, and components that render the tree**. This proposal is about what such a library
needs from sinter. None of it is specific to markdown.

## What sinter has to build on

- **Recursion and runtime choice** ([components.md](../components.md#a-component-inside-itself)): a
  component may use itself through a `data-sn-for` or `data-sn-if`, compiled once as a shared
  definition, rendered in the first frame by the early script at any depth.
  ``<sn-component use="`md-${n.type}`">`` picks a component per node, and with a discriminated union
  `sinter check` narrows the node per candidate and fails when a node type has no component.
  **A markdown renderer can be written in userland today**, given a helper that parses.
- **Build-time constants** ([spec.md](../spec.md), Build-time constants): a binding over constants is
  written into the HTML, a `data-sn-if` over them is decided, and a `data-sn-for` over a constant
  list of up to 1,000 items is unrolled. But the evaluator runs no helpers, and shared definitions
  are never unrolled.
- **Slots** fill at build time, forward by hand (`<slot name="aside" slot="side">`) and show
  their own children when left empty. Slot content sees only the caller's scope. A recursive
  component's inner uses take no slot content (`SN314`).
- **Scoped slots were sketched as additive** in the [components proposal](components.md#scope):
  `<slot data-sn-let="{ item }">`, read by the slot content through `$slot`. This proposal uses that
  form.
- **Components and helpers come only from the app:** `src/components/`, and helper namespaces
  re-exported along relative paths only. Exporting components was deferred "until after the first
  release" ([components proposal, Decisions](components.md#decisions)); that was about using them
  outside sinter, which this proposal does not change.

So the gaps are five, and only the last is about markdown:

| Gap | Section |
| --- | --- |
| A package cannot ship components, helpers or types | [1](#1-libraries-ship-source) |
| A helper cannot run at build time, so constant markdown cannot be parsed there | [2](#2-pure-helpers-run-at-build-time) |
| A constant tree is not unrolled, so even a parsed tree would ship as rows | [3](#3-constant-trees-are-unrolled) |
| A caller cannot change how a node deep inside a tree looks | [4](#4-tree-slots) |
| A file's text cannot be brought into a page as a constant | [5](#5-a-files-text-as-a-constant) |

## Where markdown comes from

| Source | Example | Parsed | Shipped |
| --- | --- | --- | --- |
| **The repo** | docs, a README, page copy | by the compiler | HTML only: no parser, no bindings |
| **An API, as a string** | an article body, a comment | in the browser | the parser (lazy) and the renderer's bindings |
| An API, as a tree | a backend that stores mdast | not at all | the renderer's bindings; first frame with embedded data |
| A stream | model output | in the browser, the last block again | as from an API; rows by position, so only the last changes |

The first two are the target. Keeping parsing and rendering apart is what lets one library serve
all four: the repo needs only the parser, at build time; a tree from an API needs only the renderer;
a string needs both.

## Design

### 1. Libraries ship source

A library ships **source**: component `.html` files, helper modules and types. The app's sinter
compiles them, as it compiles the app's own components. That is the only way a library gets the
app's build-time constants, early script, embedded data, `sinter check` against the app's types and
the app's scoped-style rules. Precompiled output would lose all of them. Svelte libraries ship
`.svelte` files for the same reason.

- **Named in the config.** `sinter({ components: ['@acme/markdown'] })`. Explicit, so a typo fails
  the build, as `lazy` does. The package's `package.json` says where its parts are:
  `"sinter": { "components": "./components", "helpers": "./helpers.js" }`.
- **Prefix owned by the package.** Every component of `@acme/markdown` starts with the prefix it
  declares (`md-`). Two packages with one prefix, or an app component with a package's name, fail the
  build. There is no shadowing: a library's internal names are not the app's API
  ([Decisions](#decisions)).
- **Helpers as a namespace**, the one way the app uses them: `export * as md from '@acme/markdown'`
  in `src/sinter.helpers.ts`. Re-exports from a configured package are followed like relative ones,
  so `md.prase()` is `SN206` with a suggestion, and only the members a page uses reach its bundle.
- **Types.** A library's props, slot data and helper results name the package's own types.
  `data-sn-component` and `data-sn-slots` in a library resolve names against the library's types
  module, not the app's `sinter.types.ts`.
- **Public and internal components.** A library lists the components an app may use
  (`"public": ["md-doc", "md-inline"]`). Using any other one from the app is an error that names the
  public ones. Internal components are used only by the library's markup.
- **Styles.** A library's scoped styles go into a cascade layer below the app's
  (`@layer sinter-lib`), so an app rule wins without fighting specificity. Theming is through
  custom properties the library documents.
- **Diagnostics in library files** name the file in the package, then where the app uses it:
  `@acme/markdown/components/md-table.html:4 … used at src/pages/post.html:12`.
- **Versions.** The source format becomes a public API for libraries. A library declares the sinter
  versions it supports as a `peerDependency`; a component file that uses a feature the app's sinter
  does not have fails with the version that has it.

### 2. Pure helpers run at build time

A helper the library marks pure is run by the compiler when every argument is a build-time
constant. Its result joins the constants the evaluator already folds.

```js
// @acme/markdown/helpers.js
import { pure } from '@tiaforge-ui/sinter/helpers';
export const parse = pure((source, options) => toTree(source, options));
```

- **Opt-in and visible**, at the declaration. Unmarked helpers keep today's rule: never run at build
  time. App helpers can be marked too.
- **Run in Node**, loaded through Vite as `sinter check` loads modules. A throw is a build error with
  the helper's message, at the binding that called it.
- **Plain data only.** The result must be what the unrolling rule already calls plain data: JSON
  values, no `Date`, no class instance, no function. Anything else is an error that names the helper,
  not a silent fallback to the browser.
- **The locale.** A pure helper does not read `$locale`. One that takes a locale as an argument
  folds per language under `localePrefix`, as `number()` does.
- **Purity is trusted, not proven.** The compiler cannot see that a helper reads no clock and no
  random number. Dev builds run each folded call twice and warn when the results differ.
- **In the browser, a pure helper is memoized** by its last arguments (by identity), so a
  `data-sn-let="{ doc: md.parse(article.body) }"` re-parses only when the body changes, not on
  every render of the scope.

### 3. Constant trees are unrolled

Today a constant list is unrolled when its rows need nothing at run time. A constant tree should be
too: a shared definition instantiated over constant props is expanded at build time, at every depth,
and the definition leaves the page when nothing else instantiates it.

- **The same conditions as for lists**, applied to every level: every binding is `text`, `attr`,
  `class`, `style` or `show`, reads only the row and fixed state, and nothing has state of its own.
  `<sn-component use>` over a constant node type is decided like a `data-sn-if`.
- **A limit per tree**, not per list: the total node count of one use's expansion (a first guess is
  10,000, configurable). Over it, the tree is left to the runtime with a warning that names the use.
- **All or nothing at first.** A tree where one subtree needs run time (a fill with a handler, a code
  block with a copy button) is not unrolled in the first version. Unrolling everything else and
  keeping that subtree as a definition is a later step ([Open questions](#open-questions)).
- **Images and links after unrolling.** A local image in constant markdown becomes an `<img src>`
  literal, so the image pipeline has to run on the unrolled markup: it gets `<picture>`, `srcset`,
  `width` and `height` like an image written in the page. The relative path resolves against the
  markdown file ([5](#5-a-files-text-as-a-constant)).

With 2 and 3, `<md-doc data-sn-prop="{ doc: md.parse($file('./post.md')) }">` is plain HTML and the
page ships no JavaScript ([static-pages.md](../static-pages.md)). The compiler has no markdown code.

### 4. Tree slots

**A slot the root component declares is forwarded to every component inside its expansion that
places a slot of that name, at any depth.** This is the hand-written forwarding sinter has today,
done automatically through recursion. The one new concept is a slot that passes data to its content.

#### The root declares

```html
<!-- @acme/markdown/components/md-doc.html -->
<template data-sn-component="{ doc: Root }"
          data-sn-slots="{ link: { node: Link }; heading: { node: Heading }; code: { node: Code } }">
  <div class="md">…the nodes of doc.children…</div>
</template>
```

`data-sn-slots` lists the slots a caller can fill and the data each passes. With
`data-sn-component` and `data-sn-emits`, it is the library's whole contract.

#### Inner components place

```html
<!-- @acme/markdown/components/md-link.html -->
<template data-sn-component="{ node: Link }">
  <span>
    <slot name="link" data-sn-let="{ node }">
      <a data-sn-attr="{ href: node.url, title: node.title }">
        <template data-sn-children data-sn-for="c in node.children"><md-node data-sn-prop="{ node: c }"></md-node></template>
      </a>
    </slot>
  </span>
</template>
```

- The slot's own children are the default rendering, shown when nobody fills it.
- `data-sn-let` on the `<slot>` names what it passes. `sinter check` checks it against the root's
  declaration at every placement inside the root.
- `data-sn-children` marks the part of the default rendering that renders the node's children. A
  fill uses it through `<sn-children>` (below). At most one per placement.

#### The caller fills

```html
<template data-sn-for="c in comments" data-sn-key="c.id">
  <md-doc data-sn-prop="{ doc: md.parse(c.body, { headings: 'strong', images: 'link' }) }">
    <a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><sn-children></sn-children></a>
  </md-doc>
</template>
```

- A fill is written like slot content today: elements with `slot="<name>"`. It is rendered once per
  node that places the slot, so the compiler treats it as a template.
- **Scope:** the caller's scope, plus `$slot`, the data the placement passes. As for all slot
  content, none of the library's scope.
- **`<sn-children>`** in a fill renders what the placement marked `data-sn-children`: the node's
  children, rendered by the library, with the same fills active. So a link inside a quoted
  paragraph of a comment is still the comment's link, and the caller never names an internal
  component. `<sn-children>` for a placement that marks none is an error.

#### The rules

1. **Only root-declared slots reach through.** A slot an inner component places that the root does
   not declare is that component's own: the library may fill it, a caller cannot.
2. **The nearest declaring root wins, and it is a boundary.** A fill that renders another `md-doc`
   starts a new contract: the outer fills do not reach into it.
3. **An inner use that passes its own content for a slot keeps it**, as with forwarding today.
4. **An inner component used outside any root** has an ordinary slot that shows its default. Used
   through the root, it is the root's slot.
5. **Every declared slot is placed somewhere inside the root**, or the library fails its own build.
   A fill for a slot the root does not declare is `SN314`, with the declared names.
6. **Fills do not reach into slot content the caller passes** to the root; that content is the
   caller's markup and keeps its scope, as today.

#### How it compiles

Fills are markup the compiler sees, so a root use with fills compiles its shared definitions once
for that set of fills: a specialization (`sn-def-md-link~2`) in the head beside the plain ones. Uses
whose fills are the same markup (one fill in a `data-sn-for`, or one wrapper component used on many
pages) share it. Expect one or two specializations per page.

A fill that reads the caller's names (`c`, the comment of the row above) needs them deep inside the
definition. They become hidden props of the specialization, threaded through each level as the
definition's props are. The early script, embedded data and the unrolling of section 3 work on
specializations as on plain definitions: a constant article with a fill is still plain HTML.

#### App-wide looks

There is no shadowing. An app that wants its own links everywhere writes one wrapper:

```html
<!-- src/components/app-markdown.html -->
<template data-sn-component="{ doc: Root }">
  <md-doc data-sn-prop="{ doc }">
    <a slot="link" data-sn-attr="{ href: $slot.node.url }"><sn-children></sn-children></a>
  </md-doc>
</template>
```

Pages use `app-markdown`. The override is written down in one place, under the app's control, and
it reaches the library only through what the root declares.

### 5. A file's text as a constant

Markdown in the repo needs a way into a page. `$file('./post.md')` is the file's text as a
build-time constant string, resolved against the file that wrote it (a page, a layout or a
component). The dev server reloads the page when the file changes. When nothing folds it (it reaches
something that runs in the browser), it is inlined as a string literal, with a warning, since that
is rarely what the author wanted. A missing file is a build error.

The resolved path is kept with the string, so a pure helper's result can carry it, and relative
image paths and links in the markdown resolve against the markdown file, not the page.

Pages generated from a folder of markdown files (one page per post) are a separate proposal
([Not in this proposal](#not-in-this-proposal)).

### 6. What content may contain: parse options

Markdown written by users and markdown written by the team need different rules: a comment must not
add an `<h1>` to the page, may not embed images, and must not carry raw HTML. Those rules are
**options of the parser**, not slots that render nothing:

```html
<md-doc data-sn-prop="{ doc: md.parse(c.body, { headings: 'strong', images: 'link', html: 'text' }) }">
```

- The tree that comes back has no headings left: a table of contents built from it agrees with what
  is shown, which a slot rendering nothing would not.
- The policy is in one visible place per use, and folds at build time like the rest of the call.
- **Raw HTML** in markdown is never markup in sinter. The parser's options are `'drop'`, `'text'`
  (shown as written) and `'allow'` with a list of elements and attributes, which become tree nodes
  the library renders like any other. Trusted Types and the strict CSP keep working with no policy.
  The default is `'text'`.

### 7. Markdown from an API

- **The parser is a lazy package** ([lazy.md](../lazy.md)): it loads with the pages that parse in the
  browser, when they first render markdown. A page whose markdown all folds never loads it.
- **Not in the early script.** A parser there would make every early file of such pages much larger.
  Markdown from an API renders when the page module runs, also with embedded data, and the page
  reserves its space as for any content behind data. An API that sends the tree is in the first frame
  with embedded data, since then nothing has to parse.
- **Per-node cost.** A long article is thousands of rows, each with bindings that never change on
  their own: the whole tree changes when the string does. Step 1 of the [Plan](#plan) measures it.
  If it is too slow, the fix is a general one: a tree that changes only as a whole renders without
  per-node dependencies, and is replaced whole when its value changes. Rows keyed by position make a
  stream cheap, since only the last block is new.

### 8. The markdown library

- **One helper namespace**: `md.parse(source, options)` returns an mdast tree (CommonMark and GFM
  tables, task lists, strikethrough, autolinks), typed as a discriminated union. Further helpers read
  the tree: `md.headings(doc)` for a table of contents, `md.text(doc)` for a description or a
  reading time.
- **Public components**: `md-doc` (block content) and `md-inline` (one line: a title, a table
  cell). One internal component per node type.
- **Declared slots** on both roots, for every node type an app is likely to change: `heading`,
  `link`, `image`, `code`, `inlineCode`, `blockquote`, `table`. Adding one later is additive.
- **What it gets from sinter for free:** internal links prefetch; local images from the repo are
  optimized; headings get ids from their text, so `md.headings` and the anchors agree; a code block
  can be a fill that highlights at build time with a pure helper.
- **Where it lives** (this repository, a package beside `create`, or its own repository) is decided
  at step 6.

### 9. Diagnostics

New codes, numbered when implemented:

| Situation | Error |
| --- | --- |
| A configured package has no `"sinter"` field, or a part it names is missing | the package and the field |
| Two packages, or a package and the app, own the same prefix or name | both owners |
| An internal library component used by the app | the public ones |
| A pure helper's result is not plain data, or it threw at build time | the helper, at the call |
| A tree over the unrolling limit | a warning, at the use, with the count |
| A declared slot is placed nowhere inside the root | the library's own build |
| A placement passes data that does not fit the root's declaration | at the placement |
| `<sn-children>` in a fill whose placement marks no children | at the fill |
| `$file()` of a missing file, or one not folded | an error; a warning |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A token stream (markdown-it's open and close tokens) | Markdown is a tree, and so are sinter templates; the renderer would rebuild the nesting |
| A component map passed down the tree (`{ link: 'ugc-link' }`; react-markdown and MDX do this) | In JSX a component is a value; in sinter markup is. A map can be an expression, so the compiler knows less, and every node component has to pass it on |
| Shadowing (an app file named like a library component replaces it) | Silent, global, and makes every internal name public API. One wrapper with fills does the same, visibly |
| Inner components declare their own fillable slots | Flexible, but the contract spreads over every file of the library |
| A compiler hook a library registers for its tag | Arbitrary code inside the compiler, which `sinter check` and the editor cannot follow |
| HTML from the parser, inserted through the Sanitizer API | Fast, but loses per-node looks, conflicts with markup from the network staying inert, and is not in every browser sinter supports |

## Not in this proposal

- **Pages from a folder of markdown files** (a blog: one page per post, an index of them). It
  builds on `$file()` and pure helpers, and needs its own design for page paths.
- **Partial unrolling**: a constant tree with a subtree that needs run time.
- **Using sinter components outside sinter**: unchanged, still deferred.
- **Markdown from an API in the early script**, unless step 1 shows a case that needs it.

## Plan

1. **A spike in userland, no compiler change.** In an example app: `md.parse` as an ordinary helper
   over micromark and mdast, about fifteen recursive `md-*` components in `src/components/`, an
   article from the API and a comment list. Measure: render time and bindings for a long article
   (in `bench/`), bundle size, what the early script does. Write down where it hurts. This decides
   whether section 7's per-node fix is needed, and checks the slot syntax against real markup before
   it is fixed.
2. **Libraries ship source** (section 1): the config option, the `"sinter"` field, prefixes,
   public components, the layer, diagnostics in package files, `sinter check` and `sinter lsp` over
   them. Move the spike's components into a local package.
3. **Pure helpers at build time and `$file()`** (sections 2 and 5), with runtime memoization.
4. **Constant trees unrolled** (section 3), with the image pipeline running on the result. A docs
   page from a `.md` file ships no JavaScript: a test in `test/` and the `static-site` example.
5. **Tree slots** (section 4): `data-sn-slots`, placements, fills, `$slot`, `<sn-children>`,
   specializations with hidden props, in the early script and unrolling. Also useful on its own: a
   data table with custom cells is a test.
6. **The markdown library** (section 8) with parse options (section 6), its docs page, `llms.txt`,
   and a recipe with an article and its comments on one page.

Steps 2 to 5 are general features, each with its own tests and docs; step 6 is the first library.

## Open questions

- **Syntax names.** `data-sn-slots`, `$slot`, `data-sn-children` and `<sn-children>`, `pure()`,
  `$file()`: settled after step 1.
- **Fills as elements or as `<template slot>`.** Elements match today's slot content; a template
  makes it clearer that the fill is repeated, and allows text or several elements without a wrapper.
- **The unrolling limit**: per tree or per page, and its default.
- **Partial unrolling** (section 3), if step 4 shows trees that are constant except for a button.
- **Purity of a library's helpers**: trust the marker, or also run the dev check in `sinter check`.

## Decisions

Decided with the user while drafting:

| Question | Decision | Section |
| --- | --- | --- |
| The target sources | Markdown from the repo and from an API, equally | [Where markdown comes from](#where-markdown-comes-from) |
| Parser output | A tree, not tokens; parsing and rendering stay separate | [Where markdown comes from](#where-markdown-comes-from) |
| Changing how a node looks | Slots, not a map of components | [4](#4-tree-slots) |
| Which slots a caller can fill | Only those the root declares; the contract stays in one file | [4](#4-tree-slots) |

Proposed here, for review:

| Question | Proposal | Section |
| --- | --- | --- |
| How a library ships | As source, compiled by the app's sinter; named in the config | [1](#1-libraries-ship-source) |
| Internal components | Listed as such by the library; the app cannot use them | [1](#1-libraries-ship-source) |
| Running helpers at build time | Only those marked pure, with plain data as the result | [2](#2-pure-helpers-run-at-build-time) |
| Children inside a fill | Rendered by the library through a placeholder; the caller never names an internal component | [4](#4-tree-slots) |
| App-wide looks | A wrapper component with fills; no shadowing | [4](#4-tree-slots) |
| What content may contain | Parse options, not slots that render nothing; raw HTML shown as text by default | [6](#6-what-content-may-contain-parse-options) |
| Markdown from an API in the first frame | Not through the early script; a tree from the API is | [7](#7-markdown-from-an-api) |
| First step | A userland spike that measures before any compiler change | [Plan](#plan) |
