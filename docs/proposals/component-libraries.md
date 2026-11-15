# Proposal: component libraries, with markdown as the first

Status: draft, revised after a first review. Nothing here is implemented. Syntax names
(`data-sn-slots`, `$slot`, `data-sn-tree`, `data-sn-children`, `<sn-children>`, `pure()`, `$file()`,
`derive`) are placeholders until the steps that introduce them; the rules around them are what this
proposal asks to settle.

Decided with the user while drafting:
- Markdown from the repo (built with the site) and markdown from an API (a string in a response)
  matter equally. Streaming and APIs that send a parsed tree are welcome, not the target.
- Parsing and rendering are separate parts. The parser returns a tree, not a stream of tokens.
- How a node looks is changed with slots, not with a map of components.
- Only the root component of a library declares the slots a caller can fill. The library's
  contract stays in one file.
- A bigger feature is fine where it is the right fit.

Everything else is proposed here; [Proposed decisions](#proposed-decisions) lists it.

## The case

An app wants to render markdown: a docs page from a file in the repo, an article body or a comment
from its API. Today it has two choices, and neither is sinter's:

- An island (`<md-view>` with markdown-it in a component script). Nothing is in the first frame,
  every node is built by hand in the script, a link cannot be the app's link, and the parser ships to
  every page that uses it, also for markdown that never changes.
- HTML from somewhere else, inserted as markup. sinter has no `innerHTML` binding, and markup from
  the network stays inert ([security.md](../security.md)). That rule stays.

What the app wants is what sinter does for everything else: markdown from the repo is plain HTML in
the page with no JavaScript; markdown from the API renders with the page's bindings; a link inside
it prefetches like any link; an image from the repo gets `srcset`, `width` and `height`; and the app
decides how a heading or a link looks.

The same pieces serve a syntax-highlighted code block, math, an icon set, a data table with custom
cells, a tree view: a library that turns a value into a tree, and components that render the tree.
Part 1 is what such libraries need from sinter, and none of it is about markdown. Part 2 is the
markdown library.

## What sinter has to build on

- **Recursion and runtime choice** ([components.md](../components.md#a-component-inside-itself)): a
  component may use itself through a `data-sn-for` or `data-sn-if`, compiled once as a shared
  definition. With embedded data, the early script renders such a tree in the first frame at any
  depth. ``<sn-component use="`md-${n.type}`">`` picks a component per node; with a discriminated
  union, `sinter check` narrows the node per candidate and fails when a node type has no component.
  A markdown renderer should be possible in userland today, given a helper that parses; step 1 of
  the [Plan](#plan) checks that.
- **Build-time constants** ([spec.md](../spec.md), Build-time constants): a binding over constants is
  written into the HTML, a `data-sn-if` over them is decided, and a `data-sn-for` over a constant
  list of up to 1,000 items is unrolled. The limits matter here:
  - the evaluator runs no helpers;
  - a row is unrolled only when none of its nodes is a nested template, so a constant list inside a
    constant list is not;
  - a `data-sn-if` is decided per template, and only when it reads no row, and inside a component
    only when every use agrees;
  - unrolling is two compile passes, not a fixpoint;
  - shared definitions are never unrolled.
- **The compile order.** In one pass, loops are unrolled, then the layout is computed and images are
  rewritten, then bindings are walked and constants written (`run()` in `compile.ts`). An `<img>`
  with a binding is skipped by the image pipeline, so a constant `src` that is only written later
  never becomes a `<picture>`. `compile()` is synchronous.
- **Slots** fill at build time, forward by hand (`<slot name="aside" slot="side">`) and show their
  own children when left empty. Slot content sees only the caller's scope. A recursive component's
  inner uses, and `<sn-component>`, take no slot content (`SN314`).
- **Scoped slots were sketched as additive** in the [components proposal](components.md#scope):
  `<slot data-sn-let="{ item }">`, read by the slot content through `$slot`. This proposal uses that
  form.
- **Helpers are synchronous.** A helper module that reaches a lazy package is `SN324`, and
  [lazy.md](../lazy.md) names a markdown body as the case to load with the page instead.
  `<sn-resource call>` runs an async local action, but once per resource: not per item, and not with
  `each`.
- **Components and helpers come only from the app:** `src/components/`, `ComponentName` as the union
  of the app's components, and helper namespaces re-exported along relative paths only. The helper
  manifest is read statically, without running the module. Exporting components was deferred "until
  after the first release" ([components proposal, Decisions](components.md#decisions)); that was
  about using them outside sinter, which this proposal does not change.

## The gaps

| Gap | Section |
| --- | --- |
| Slot content cannot receive data from the component | [1](#1-slots-that-pass-data) |
| A caller cannot change how a node deep inside a tree looks | [2](#2-tree-slots) |
| A helper cannot run at build time | [3](#3-pure-helpers-at-build-time) |
| Nested constant loops and constant trees are not unrolled, and constants are written after images | [4](#4-constant-trees-are-unrolled) |
| A file's text cannot be brought into a page as a constant | [5](#5-a-files-text-as-a-constant) |
| Data from an API cannot be parsed once per value, or with a package loaded on demand | [6](#6-derived-fields) |
| A package cannot ship components, helpers or types | [7](#7-libraries-ship-source) |

## Where markdown comes from

| Source | Example | Parsed | Shipped |
| --- | --- | --- | --- |
| The repo | docs, a README, page copy | by the compiler | HTML only: no parser, no bindings |
| An API, as a string | an article body, a comment | in the browser, once per value, as a derived field | the parser (on demand) and the renderer's bindings |
| An API, as a tree | a backend that stores mdast | not at all | the renderer's bindings; first frame with embedded data |
| A stream | model output | in the browser, again on each chunk | as from an API |

Keeping parsing and rendering apart lets one library serve all four. The renderer only ever sees a
tree: from the compiler, from a derived field, or from the API.

# Part 1: what libraries need from sinter

## 1. Slots that pass data

A component passes values to the content of a slot. This is useful without trees (a data table with
custom cells, a list with custom rows) and ships first.

```html
<!-- src/components/data-table.html -->
<template data-sn-component="{ rows: Row[]; columns: (keyof Row)[] }" data-sn-slots="{ cell: { row: Row; column: keyof Row } }">
  <table>…
    <template data-sn-for="r in rows" data-sn-key="r.id">
      <tr><template data-sn-for="c in columns"><td><slot name="cell" data-sn-let="{ row: r, column: c }"><span data-sn-text="r[c]"></span></slot></td></template></tr>
    </template>
  </table>
</template>
```

```html
<data-table data-sn-prop="{ rows: invoices, columns: ['number', 'customer', 'total'] }">
  <span slot="cell" data-sn-text="$slot.column === 'total' ? number($slot.row.total) : $slot.row[$slot.column]"></span>
</data-table>
```

- `data-sn-slots` on the template declares each slot that passes data, with the type of what it
  passes. A slot that passes nothing needs no declaration, as today. With `data-sn-component` and
  `data-sn-emits`, it completes the contract.
- `data-sn-let` on a `<slot>` names what it passes. `sinter check` checks it against the declaration.
- A fill is written like slot content today: the elements with `slot="<name>"`, in order. It is
  rendered at each placement, so inside a loop it is a template, instantiated per row.
- Scope: the caller's scope plus `$slot`. Inside a fill for another component, the inner `$slot`
  hides the outer one; keep it with `data-sn-let="{ outer: $slot.row }"` on the outer fill.
- Provenance flows through: `$slot.row` is the row the component got from its prop, so
  `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource.
- A literal `id` in a fill that is rendered more than once is an error, as for components.
- A fill for a slot the component does not have is `SN314`, the existing unknown-slot error.

## 2. Tree slots

A slot the root declares can be placed by any component inside the root's expansion, at any depth.
The caller fills it once, on the root.

### The root declares

```html
<!-- @acme/markdown/components/md-doc.html -->
<template data-sn-component="{ doc: Root }"
          data-sn-slots="{ link: { node: Link }; heading: { node: Heading }; code: { node: Code } }">
  <div class="md">…the nodes of doc.children…</div>
</template>
```

### Inner components place, explicitly

```html
<!-- @acme/markdown/components/md-link.html -->
<template data-sn-component="{ node: Link }">
  <span>
    <slot name="link" data-sn-tree data-sn-let="{ node }">
      <a data-sn-attr="{ href: node.url, title: node.title }">
        <template data-sn-children data-sn-for="c in node.children"><md-phrasing data-sn-prop="{ node: c }"></md-phrasing></template>
      </a>
    </slot>
  </span>
</template>
```

- `data-sn-tree` marks a placement of the nearest declaring root's slot of that name. A `<slot>`
  without it is the component's own slot, as today, and is never reached by a root's fill. A
  component from another library, or an app component, cannot capture a fill by having a slot with
  the same name.
- The slot's children are the default rendering, shown when nobody fills it.
- `sinter check` checks each placement's `data-sn-let` against the root's declaration.
- `data-sn-children` marks the part of the default rendering that renders the node's children. At
  most one per placement.
- Reach-through does not pass slot content to inner uses, so `SN314` stays as it is for recursive
  uses and `<sn-component>`.

### The caller fills

```html
<template data-sn-for="c in comments" data-sn-key="c.id">
  <md-doc data-sn-prop="{ doc: c.doc }">
    <a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><sn-children></sn-children></a>
  </md-doc>
</template>
```

- `<sn-children>` in a fill renders the part the placement marked `data-sn-children`: the node's
  children, rendered by the library, with the same fills active. A link inside a quoted paragraph of
  a comment is still the comment's link, and the caller never names an internal component.
- `<sn-children>` may be left out: the fill drops the children (an image shown as its alt text). It
  may appear at most once per fill. For a placement that marks no children it is an error.
- The marked part keeps the style scope of the component that placed it: it is a scope root of its
  own, so the library's rules reach it and the fill's component's rules stop at it, as they stop at
  any component root.

### The rules

1. Only root-declared slots reach through, and only to placements marked `data-sn-tree`.
2. A root written in caller markup (a page, a fill, slot content, an app component) starts a new
   contract: the outer fills do not reach into it.
3. A root used in library markup inside another root (`md-doc` rendering a table cell through
   `md-inline`) is not a boundary. The fills of slots it also declares pass into it; the declared
   data must be the same type.
4. Every declared slot is placed somewhere inside the root, or the library fails `sinter check`.
5. Fills do not reach into slot content the caller passes to the root.
6. In library markup, the candidates of ``<sn-component use>`` are the library's internal components
   whose names fit the convention or the map. The helper form is not allowed there: it would make
   every app component a candidate and the root's expansion unknown.

### What a fill may contain

A fill is compiled into the library's shared definitions, which are compiled with an empty scope and
take only props. What it reads from the caller has to be carried in. In the first version:

- Reads of the caller's scope (state, `data-sn-let` names, loop variables, props) and `$slot`: the
  names it reads become hidden inputs of the specialization (below), passed through every level,
  through `<sn-component use>` points and through `<sn-children>`. A `data-sn-let` name is captured
  as its value, as a prop is.
- Store functions on caller rows (`patch(c, …)`): each hidden input carries the sources it has at
  the use, as definition props do (`@def:<name>:<prop>`), per specialization.
- Handlers that write page-level state. A fill that writes state declared inside a caller's row is an
  error in the first version: a write needs a reference to that row's scope, not a value.
- `$el`, `$event` and `emit()`, as in the caller's markup. `emit()` names are checked against the
  component whose markup the fill is.

### How it compiles

A root use with fills compiles the library's shared definitions again for that set of fills: a
specialization, with its own `<template>`s in the head and its own functions. The key is:

- the source location of each fill (so the same text in two loops is two keys, with its own resolved
  names and types);
- the use's `data-sn-early` mode;
- whether the tree is unrolled ([4](#4-constant-trees-are-unrolled)).

Each specialization costs a copy of every definition the root reaches. Step 6 of the [Plan](#plan)
measures that cost per specialization.

`data-sn-early="off"` on a root use applies to its specialization as a whole, fills included: unlike
plain slot content, fills are compiled into the definitions.

### App-wide looks and wrappers

There is no shadowing. An app that wants its own links everywhere writes one wrapper:

```html
<!-- src/components/app-markdown.html -->
<template data-sn-component="{ doc: Root }" data-sn-slots="{ code: { node: Code } }">
  <md-doc data-sn-prop="{ doc }">
    <a slot="link" data-sn-attr="{ href: $slot.node.url }"><sn-children></sn-children></a>
    <slot name="code" slot="code" data-sn-let="{ node: $slot.node }"></slot>
  </md-doc>
</template>
```

- Pages use `app-markdown`. The override is written down in one place and reaches the library only
  through what the root declares.
- A wrapper that lets pages fill a slot declares it and forwards it, as slots are forwarded today:
  the forwarding `<slot>` passes the data on with its own `data-sn-let`. Left empty, it shows its
  children, so a wrapper can give a default fill.
- The app names library types by re-exporting them from `src/sinter.types.ts`
  (`export type { Root } from '@acme/markdown'`), so `data-sn-component` keeps one source of names.

## 3. Pure helpers at build time

A helper marked pure is run by the compiler when every argument is a build-time constant. Its result
joins the constants the evaluator already folds.

```js
// @acme/markdown/helpers.js
import { pure } from '@tiaforge-ui/sinter/helpers';
export const parse = pure((source, options) => toTree(source, options));
```

- Marked at the declaration, in a form the static manifest reader recognizes: `export const x =
  pure(…)` in the module that declares it, followed through re-exports as names are today. Unmarked
  helpers are never run at build time. App helpers can be marked too.
- The result must be plain data (JSON values; no `Date`, class instance or function). Anything else
  is an error at the call. A throw is a build error with the helper's message, at the call.
- A pure helper does not read `$locale`. One that takes a locale as an argument folds per language
  under `localePrefix`, as `number()` does.
- Purity is trusted, not proven. Dev builds run each folded call twice and warn when the results
  differ.
- Loading. `compile()` stays synchronous: the Vite plugin loads the pure helpers before compiling
  (with `ssrLoadModule`, as `sinter render` loads app modules) and passes them in. `sinter check` and
  `sinter lsp` load them the same way, so that what folds, and so `SN322` on static pages, agrees
  with the build; the LSP reloads them when their files change. Testing's `render()` and
  `firstPaint()` already take `helpers`.
- Trust. A pure helper is a dependency's code, run in Node in builds, the dev server and `sinter
  check`, as Vite plugins and the app's config are. A compiler hook was rejected for a different
  reason ([Alternatives](#alternatives-considered)): its output is markup the checker and the editor
  cannot follow. A pure helper's output is data with a type.
- In the browser, a `data-sn-let` whose value calls a pure helper is computed once per scope
  instance and kept until one of its dependencies changes. Today a let is inlined at each read, so
  every read would call the helper again.

## 4. Constant trees are unrolled

Folding a parsed document into HTML needs the unrolling of constants to go further than today. Most
of this is useful on its own, for nested constant data in any page.

1. **Nested constant loops.** A row that contains a template is unrolled when that template is
   itself over constants, at any depth.
2. **Decisions per instance.** A `data-sn-if` that reads the row, and a `<sn-component use>` over a
   constant node type, are decided per unrolled copy. Keys become instance paths: the template's
   file and offset, the component chain, and the item index at each level.
3. **Shared definitions over constants.** A recursion point instantiated over constant props is
   expanded at build time like a nested loop, and a definition leaves the page when nothing else
   instantiates it.
4. **One expansion, not two passes.** A constant tree is expanded directly, in the first pass, to a
   fixpoint: today's two-pass scheme decides one level per pass.
5. **Constants before layout and images.** Constant values are written before the layout is
   computed and images are rewritten, so a folded `<img src>` becomes a `<picture>` with `srcset`,
   `width` and `height`, and a folded class counts for `sizes`. Image analysis is already async with
   a recompile; that stays.

The conditions on rows stay as they are, at every level: bindings of kind `text`, `attr`, `class`,
`style` or `show` that read only the row and fixed state, no state of their own, and a first pass
with no errors but `SN322`. A tree with one subtree that needs run time (a fill with a handler, a code
block with a copy button) is not unrolled in the first version.

There is a limit on the nodes of one expansion, beyond the 1,000 items per list. It also bounds
layout and image work, which runs over the whole document. Its value comes from build times measured
in step 5; over it, the tree is left to the runtime with a warning at the use.

With 3 and 4, `<md-doc data-sn-prop="{ doc: md.parse($file('./post.md')) }">` is plain HTML, and
the page ships no JavaScript ([static-pages.md](../static-pages.md)). The compiler has no markdown
code.

## 5. A file's text as a constant

`$file('./post.md')` brings a file into a page at build time.

- The argument is a string literal, resolved against the file that wrote it (a page, a layout or a
  component) and confined to the project root.
- The value is `{ text, path }`, with `path` relative to the project root: a string alone cannot
  carry where it came from. A parser that takes it turns relative URLs in the document into root
  paths (`/content/posts/diagram.png`), and the image pipeline resolves a root path against the
  project root (`images.ts`), so the image is found whatever component renders it.
- It must fold. A `$file()` whose value would reach the browser is an error: it would put a whole
  document into the page module.
- The dev server reloads the page when the file changes. A missing file is a build error.

Pages generated from a folder of markdown files are not in this proposal
([Not in this proposal](#not-in-this-proposal)).

## 6. Derived fields

Markdown from an API has to be parsed in the browser. Parsing in a binding would mean a synchronous
parser loaded with the page, and a parse on every render that reads it. The parse belongs where the
data enters, not where it is read: a resource declares fields computed from each item.

```html
<sn-resource name="comments" src="/api/posts/{id}/comments" key="id"
             derive="{ doc: md.parse(item.body, { headings: 'strong', images: 'link', html: 'text' }) }"></sn-resource>
```

- `derive` is an object literal: each field is computed from `item` (each item of a collection, the
  value of a single resource) and read in bindings like any field (`c.doc`). `sinter check` types it
  from the helper's return type.
- It is computed wherever data enters the store: the response, sync events (`upsert`, `patch`),
  optimistic changes and their rollback, `cache`, next-page data and embedded data. For a change to
  an item, it is computed again only when a field it reads changed. Each value is parsed once.
- **A derived field may load a package on demand.** A helper called only from `derive` may reach a
  [lazy package](../lazy.md): the resource's data is applied once the response and the helper's
  modules have both arrived. They load in parallel, so the wait is the longer of the two, not their
  sum; the modules are preloaded on pages that have such a resource. Once loaded, every later apply
  is synchronous, so optimistic updates and sync events stay immediate. A binding that calls such a
  helper is `SN324`, with the hint to derive the field.
- Derived fields are not the API's data. They are left out of request bodies built from an item,
  `structuredClone` copies and the `cache` entries (one way: non-enumerable properties on the frozen
  item). A cached or prefetched item is derived again when it is applied.
- First frame. A binding that reads a derived field is not early: the early file would need the
  parser. The rest of the item (a comment's author and date) still renders early with embedded data.
  Rendering derived fields early, with their modules in the early file, is an
  [open question](#open-questions).
- A draft in state is not a resource. A live preview uses `<sn-resource call>` today, with an action
  that imports the parser.

This is not about markdown: a derived field can be a syntax-highlighted snippet, a parsed date, a
search key or any value computed once per item.

## 7. Libraries ship source

A library ships source: component `.html` files, their scripts, helper modules and types. The app's
sinter compiles them as it compiles the app's own components, which is the only way a library gets
the app's build-time constants, early script, embedded data, type checks and scoped styles.
Precompiled output would lose all of them. Svelte libraries ship `.svelte` files for the same
reason. This step comes last in the [Plan](#plan), once sections 1 to 6 have fixed the source format.

- Named in the config: `sinter({ components: ['@acme/markdown'] })`. The package's `package.json`
  says where its parts are: `"sinter": { "components": "./components", "helpers": "./helpers.js",
  "types": "./types.ts", "public": ["md-doc", "md-inline"] }`.
- Every component of a package starts with a prefix it owns (`md-`). Two packages with one prefix, or
  an app component with a package's name, fail the build. There is no shadowing.
- Public and internal components. `public` lists what the app may use; using another one is an error
  that names the public ones. `ComponentName`, the app's union for `<sn-component use>`, holds the
  public ones; a library's own `use` is checked against its own union, internal components included.
- Helpers are a namespace, the one way the app uses them: `export * as md from '@acme/markdown'` in
  `src/sinter.helpers.ts`. A re-export from a configured package is followed like a relative one.
- A library's props, slot data and helper results resolve type names against the library's types
  module, not the app's `sinter.types.ts`.
- Component scripts work as in the app: the generated base class and the `*/name.html` declarations
  cover library components, and `sinter render` finds their scripts.
- Files. Paths in configured packages are read even when their real path is outside the project
  root (a workspace link). In dev, configured packages are left out of Vite's dependency
  pre-bundling and watched, so a change to a linked library reloads the page.
- Styles. A library's scoped styles go into `@layer sinter-lib`, wrapping their `@scope` blocks.
  sinter declares that layer first in the page's stylesheet, so unlayered app CSS and the app's own
  layers win; an app can place it among its layers by declaring the order itself.
- Diagnostics in library files name the file in the package, then where the app uses it:
  `@acme/markdown/components/md-table.html:4 … used at src/pages/post.html:12`.
- The library author's checks. A library has no pages, and `sinter check` checks a component through
  the pages that use it. A library keeps fixture pages (`test/pages/`) that use its public components
  with the cases it supports; `sinter check` in the library's repository compiles those, and rule 4
  of [tree slots](#the-rules) is checked there and in the app's build.
- Versions. A library declares the sinter versions it supports as a `peerDependency`; the app's
  sinter checks the range. It cannot know which version introduced a feature newer than itself.

# Part 2: the markdown library

## 8. Parse options: what content may contain

Markdown written by users and markdown written by the team need different rules: a comment must not
add an `<h1>` to the page, may not embed images, and must not carry raw HTML. Those rules are options
of the parser, not slots that render nothing:

```html
derive="{ doc: md.parse(item.body, { headings: 'strong', images: 'link', html: 'text' }) }"
```

- The tree that comes back has no headings left, so a table of contents built from it agrees with
  what is shown. A slot that renders nothing would leave the heading in the tree.
- The policy is in one place per resource or use, and folds at build time like the rest of the call.
- Raw HTML in markdown is never markup in sinter. The options are `'drop'`, `'text'` (shown as
  written, the default) and `'allow'`, which keeps a fixed set of elements (`kbd`, `sub`, `sup`,
  `mark`, `details`, `summary`) with a fixed set of attributes, each rendered by its own component.
  `data-sn-attr` takes literal keys and sinter has no dynamic tag, so a list chosen by the caller
  cannot be rendered; the set grows with the library.
- Link and image URLs from the tree are `attr` bindings, so the runtime's scheme check refuses
  `javascript:` and other unsafe URLs without the parser's help.

## 9. The library

- One helper namespace. `md.parse(source, options)` is pure and returns an mdast tree (CommonMark,
  and GFM tables, task lists, strikethrough and autolinks), typed as a discriminated union. It takes
  a string or a `$file()` value. Further pure helpers read the tree: `md.headings(doc)` for a table of
  contents, `md.text(doc)` for a description or a reading time.
- One function in three places. In a page over constants, the compiler runs it. In `derive`, it loads
  on demand. An app that calls it in a binding loads it with the page.
- Public components: `md-doc` (block content) and `md-inline` (one line: a title, a table cell).
  `md-doc` uses `md-inline` for phrasing content, which rule 3 of [tree slots](#the-rules) covers.
  One internal component per node type.
- Declared slots on both roots, for the nodes an app is likely to change: `heading`, `link`,
  `image`, `code`, `inlineCode`, `blockquote`, `table`. Adding one later is additive.
- What sinter already does for it: internal links prefetch; local images from the repo are
  optimized; headings get ids from their text, so `md.headings` and the anchors agree; a code block's
  fill can highlight at build time with a pure helper.
- Where it lives (this repository, a package beside `create`, or its own repository) is decided at
  step 9.

## Limits

- A constant tree with any subtree that needs run time is not unrolled in the first version.
- Markdown from an API as a string is not in the first frame. Reserved space covers only paginated
  lists, so the body shifts the layout when it renders. An API that sends the tree avoids both.
- Each specialization of a library's definitions is a copy of every definition its root reaches.
- A stream that appends to a derived field's source parses the whole body again for each chunk.
- A fill cannot write state declared inside a caller's row.

## Diagnostics

New codes are numbered when implemented. `SN314` (unknown slot) and `SN324` (lazy package reached
synchronously) keep their meaning and gain cases.

| Situation | Diagnostic |
| --- | --- |
| A fill for a slot the component or root does not declare | `SN314`, with the declared names |
| A placement's data does not fit the declaration | at the placement |
| A declared slot is placed nowhere inside the root | in the library's `sinter check` and the app's build |
| `<sn-children>` twice in a fill, or for a placement that marks no children | at the fill |
| A literal `id` in a fill rendered more than once | at the fill |
| A fill writes state declared inside a caller's row | at the write |
| The helper form of `<sn-component use>` in library markup | at the use |
| A pure helper's result is not plain data, or it threw at build time | at the call |
| A tree over the expansion limit | warning, at the use, with the count |
| `$file()` with a non-literal argument, outside the project root, missing, or not folded | at the call |
| A binding calls a helper that reaches a lazy package | `SN324`, with the hint to derive the field |
| A configured package has no `"sinter"` field, or a part it names is missing | the package and the field |
| Two packages, or a package and the app, own the same prefix or name | both owners |
| The app uses an internal library component | the public ones |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A token stream (markdown-it's open and close tokens) | Markdown is a tree, and so are sinter templates; the renderer would rebuild the nesting |
| A component map passed down the tree (`{ link: 'ugc-link' }`; react-markdown and MDX do this) | In JSX a component is a value; in sinter markup is. A map can be an expression, so the compiler knows less, and every node component has to pass it on |
| Shadowing (an app file named like a library component replaces it) | Silent, global, and makes every internal name public API. One wrapper with fills does the same, visibly |
| Inner components declare their own fillable slots | The contract would spread over every file of the library |
| Reach-through by slot name alone, without `data-sn-tree` | Captures any component's slot of the same name, from another library or the app |
| A compiler hook a library registers for its tag | Its output is markup that `sinter check` and the editor cannot follow |
| Parsing in a binding, with the parser loaded with the page (lazy.md's advice today) | Works without a new feature, but loads the parser on every page that might show markdown and parses on every render that reads the body |
| Bindings that wait for a lazy package | Every binding would need a pending state, and the order of renders would depend on downloads. Derived fields keep the waiting at the point where data already arrives asynchronously |
| HTML from the parser, inserted through the Sanitizer API | Loses per-node looks, conflicts with markup from the network staying inert, and is not in every browser sinter supports |

## Not in this proposal

- Pages from a folder of markdown files (a blog: one page per post, an index of them). It builds on
  `$file()` and pure helpers, and needs its own design for page paths.
- Partial unrolling: a constant tree with a subtree that needs run time.
- Parsing in a worker.
- Using sinter components outside sinter: unchanged, still deferred.

## Plan

1. **A spike in userland, measuring only.** In an example app: `md.parse` as an ordinary helper over
   micromark and mdast, loaded with the page; about fifteen recursive `md-*` components; an article
   and a comment list from the API. Measure, in `bench/`: render time and binding count for a long
   article; the page and early files with embedded data (the parser pulled into the early file);
   re-parse cost per render and per streamed chunk. It cannot try fills or reach-through, which need
   the compiler; it shows where they are missed.
2. **Slots that pass data** (section 1), with a data table as the test. Useful on its own.
3. **Nested constant loops, decisions per instance, one expansion, and constants before layout and
   images** (section 4, items 1, 2, 4 and 5). Useful for any page with nested constant data.
4. **Pure helpers at build time and `$file()`** (sections 3 and 5): loading before compile, in the
   plugin, `sinter check` and `sinter lsp`; the cached `data-sn-let`.
5. **Constant trees** (section 4, item 3): a docs page from a `.md` file ships no JavaScript, with
   its images optimized. A test in `test/` and the `static-site` example. Sets the expansion limit.
6. **Tree slots** (section 2): `data-sn-tree`, `data-sn-children` and `<sn-children>`, nested roots,
   specializations with hidden inputs and their sources, early mode, unrolling of specializations.
   Measures the cost per specialization.
7. **Derived fields** (section 6), with lazy modules, in every way data enters the store.
8. **Libraries ship source** (section 7), once the format above is settled. The spike's components
   move into a local package with fixture pages.
9. **The markdown library** (Part 2), its docs page, `llms.txt`, and a recipe with an article and its
   comments on one page.

Steps 2, 3 and 7 do not depend on each other and can be built in any order.

## Open questions

- Syntax names, settled in the step that introduces each.
- Fills as elements, as slot content is today, or as `<template slot>`, which makes the repetition
  visible and allows text or several elements without a wrapper.
- Derived fields in the first frame: an opt-in that puts the helper's modules into the early file,
  measured against the early budget, for pages whose first content is markdown from an API.
- Whether a derived field is recomputed only for changed fields it reads, or for any change to the
  item (simpler, and cheap when parses are rare).
- How the image pipeline and `md.parse` agree on root paths when Vite's `base` or `publicDir` is
  set.
- The expansion limit: per tree or per page, and its value from step 5.
- Partial unrolling, if step 5 shows trees that are constant except for a button.
- Writes from a fill to state inside a caller's row: needed, or a fill emits instead.
- A pure-helper marker that survives a library's own build step, should libraries ever ship compiled
  helpers.

## Proposed decisions

| Question | Proposal | Section |
| --- | --- | --- |
| Slot data | `data-sn-slots` declares it, `<slot data-sn-let>` passes it, `$slot` reads it; ships before trees | [1](#1-slots-that-pass-data) |
| Reach-through | Explicit placements (`data-sn-tree`); a root in caller markup is a boundary, one in library markup is not | [2](#2-tree-slots) |
| Children inside a fill | Rendered by the library through `<sn-children>`, keeping the library's style scope | [2](#2-tree-slots) |
| Fills in the first version | Reads, store functions on caller rows, page-level writes; no writes to a caller row's state | [2](#what-a-fill-may-contain) |
| App-wide looks | A wrapper component with fills; no shadowing | [2](#app-wide-looks-and-wrappers) |
| Running helpers at build time | Only those marked `pure()`, plain data as the result, loaded before the synchronous compile, also by `check` and `lsp` | [3](#3-pure-helpers-at-build-time) |
| Constant folding | Nested loops, per-instance decisions, one expansion, constants before images; then trees | [4](#4-constant-trees-are-unrolled) |
| Files | `$file()` returns text and a root path, and must fold | [5](#5-a-files-text-as-a-constant) |
| Markdown from an API | Derived fields on the resource, parsed once per value, with the parser loaded on demand | [6](#6-derived-fields) |
| How a library ships | As source, named in the config, last in the plan | [7](#7-libraries-ship-source) |
| What content may contain | Parse options; raw HTML shown as text by default; `'allow'` is a fixed set | [8](#8-parse-options-what-content-may-contain) |
| First step | A spike that measures, before any compiler change | [Plan](#plan) |
