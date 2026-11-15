# Proposal: component libraries, with markdown as the first

Status: draft, second revision. Nothing here is implemented. The first revision added eight new
names; this one builds on what sinter has instead, and adds two: `$slot` and the `Slot<T>` type. The
rest are rules for existing attributes and elements, listed in [What is new](#what-is-new).

Decided with the user while drafting:
- Markdown from the repo (built with the site) and markdown from an API (a string in a response)
  matter equally. Streaming and APIs that send a parsed tree are welcome, not the target.
- Parsing and rendering are separate parts. The parser returns a tree, not a stream of tokens.
- How a node looks is changed with slots, not with a map of components.
- Only the root component of a library declares the slots a caller can fill. The library's
  contract stays in one file.
- A bigger feature is fine where it is the right fit, but new vocabulary has to earn its place:
  generalize what sinter has before adding a name.

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

With this proposal, the two cases differ only in a resource's `src`:

```html
<sn-resource name="post" src="./post.md"></sn-resource>                     <!-- the repo: folded into HTML -->
<sn-resource name="post" src="/articles/{$url.slug}/body"></sn-resource>    <!-- an API: parsed in the browser -->

<div data-sn-let="{ doc: md.parse(post, { base: $meta.post.url }) }">
  <md-doc data-sn-prop="{ doc }"></md-doc>
</div>
```

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
- **Local files are read at build time where markup names them.** `<img src="./photo.jpg">` is a
  file next to the page, resolved by the compiler; a path starting with `/` resolves against the
  project root (`images.ts`).
- **Embedded data**: JSON written into the page's head (`<script type="application/json"
  data-sn-data>`), which the early script and the page module read as a resource's first value.
- **Helpers are pure by contract**: "same arguments, same result, nothing read or changed elsewhere"
  ([configuration.md](../configuration.md#helpers)). Nothing runs them at build time, and their
  manifest is read statically.
- **`data-sn-let`** names values computed from state, resources and loop variables. Each name is
  inlined into every expression that reads it, so it costs nothing at run time for cheap
  expressions, and evaluates a helper again at every read.
- **Lazy packages** ([lazy.md](../lazy.md)) load on first call. Helpers are synchronous, so a helper
  module that reaches a lazy package is `SN324`, and lazy.md names a markdown body as the case to load
  with the page instead. The lazy transform covers the app's modules, not `node_modules`.
- **`$meta.<name>`** is a resource's status: `loading`, `error`, `loadedAt`, `pending`, `total`,
  `live`.
- **Slots** fill at build time, forward by hand (`<slot name="aside" slot="side">`) and show their
  own children when left empty. Slot content sees only the caller's scope. A recursive component's
  inner uses, and `<sn-component>`, take no slot content (`SN314`).
- **Scoped slots were sketched as additive** in the [components proposal](components.md#scope):
  `<slot data-sn-let="{ item }">`, read by the slot content through `$slot`. This proposal uses that
  form.
- **Components and helpers come only from the app:** `src/components/`, `ComponentName` as the union
  of the app's components, and helper namespaces re-exported along relative paths only. Exporting
  components was deferred "until after the first release" ([components proposal,
  Decisions](components.md#decisions)); that was about using them outside sinter, which this
  proposal does not change.

## What is new

| Need | Built on | New |
| --- | --- | --- |
| Slot content that receives data | `<slot>`, `data-sn-let`, the `$event` family of names | `$slot`; `Slot<T>` in the props type |
| Fills that reach deep into a tree | slots and forwarding | a rule: a root's slot is filled at every placement in its package |
| A fill that wraps the node's children | slot fallback content | a rule: an empty fill gets the default's children |
| Helpers run at build time | helpers' purity contract, build-time constants | a rule: a helper over constants is run by the compiler |
| Constant trees folded into HTML | unrolling | its prerequisites |
| A file from the repo | `<sn-resource src>`, local images, embedded data | a rule: `./` and `../` name a file, read at build time |
| Where a resource came from | `$meta.<name>` | a field: `url` |
| Parse once per value, with a package loaded on demand | `data-sn-let`, lazy packages | two rules: a let over a helper is cached; it may wait for a lazy package |
| Components from a package | `src/components/`, helpers namespaces, the `lazy` option | a config option and an app-shaped folder |

Two of these rules change existing behaviour; see [Breaking changes](#breaking-changes).

## Where markdown comes from

| Source | Example | Parsed | Shipped |
| --- | --- | --- | --- |
| The repo | docs, a README, page copy | by the compiler | HTML only: no parser, no bindings |
| An API, as a string | an article body, a comment | in the browser, once per value, in a `data-sn-let` | the parser (on demand) and the renderer's bindings |
| An API, as a tree | a backend that stores mdast | not at all | the renderer's bindings; first frame with embedded data |
| A stream | model output | in the browser, again on each chunk | as from an API |

Keeping parsing and rendering apart lets one library serve all four. The renderer only ever sees a
tree.

# Part 1: what libraries need from sinter

## 1. Slots that pass data

A component passes values to the content of a slot. This is useful without trees (a data table with
custom cells, a list with custom rows) and ships first.

```html
<!-- src/components/data-table.html -->
<template data-sn-component="{ rows: Row[]; columns: (keyof Row)[]; cell: Slot<{ row: Row; column: keyof Row }> }">
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

- **Declared in the props type.** A member of type `Slot<T>` in `data-sn-component` is a slot that
  passes `T`, as Svelte 5 declares snippets among props. It is filled with slot content, never
  through `data-sn-prop` (passing it there is `SN313`). A slot that passes nothing needs no
  declaration, as today. The component's contract stays `data-sn-component` and `data-sn-emits`.
- **`data-sn-let` on a `<slot>`** names what it passes, for the slot's subtree, which is the fill:
  the attribute's meaning does not change. `sinter check` checks it against `T`.
- **`$slot`** is what the fill reads, as `$event` is what a handler reads: a value something else
  gives it. Inside a fill for another component, the inner `$slot` hides the outer one; keep it with
  `data-sn-let="{ outer: $slot.row }"` on the outer fill.
- A fill is written like slot content today: the elements with `slot="<name>"`, in order. It is
  rendered at each placement, so inside a loop it is a template, instantiated per row.
- Scope: the caller's scope plus `$slot`.
- Provenance flows through: `$slot.row` is the row the component got from its prop, so
  `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource.
- A literal `id` in a fill that is rendered more than once is an error, as for components.
- A fill for a slot the component does not have is `SN314`, the existing unknown-slot error.

### An empty fill gets the default's children

A slot's own children are shown when nobody fills it. The other direction completes it: **a fill
that is one empty element gets the child nodes of the placement's default element.** Empty means no
child nodes and no `data-sn-text`.

```html
<!-- placement: the default is one element, its content the node's children -->
<slot name="link" data-sn-let="{ node }"><a data-sn-attr="{ href: node.url }">…the children…</a></slot>

<!-- fill: the <a> is empty, so the library renders the children into it -->
<a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"></a>
```

- A fill with content of its own replaces the children: an image shown as its alt text is
  `<span slot="image" data-sn-text="$slot.node.alt"></span>`.
- The children keep the style scope of the component that placed them: they are a scope root of
  their own, so the library's rules reach them and the fill's component's rules stop at them, as they
  stop at any component root.
- The children are rendered by the library, so in a tree the same fills apply to them
  ([2](#2-tree-slots)), and the caller never names an internal component.
- A fill cannot put the children deeper inside itself or add a sibling to them (an icon after a
  link's text). CSS covers most such cases; see [Limits](#limits).

## 2. Tree slots

A slot the root declares is filled at every placement of that name inside the root's expansion, at
any depth. This is the forwarding sinter has today, done automatically, and only within a package.

```html
<!-- @acme/markdown: md-doc.html, the root -->
<template data-sn-component="{ doc: Root; link: Slot<{ node: Link }>; heading: Slot<{ node: Heading }>; code: Slot<{ node: Code }> }">
  <div class="md">…the nodes of doc.children…</div>
</template>

<!-- @acme/markdown: internal/md-link.html, deep inside -->
<template data-sn-component="{ node: Link }">
  <span><slot name="link" data-sn-let="{ node }"><a data-sn-attr="{ href: node.url, title: node.title }">…the children…</a></slot></span>
</template>
```

```html
<!-- a page -->
<template data-sn-for="c in comments" data-sn-key="c.id">
  <article data-sn-let="{ doc: md.parse(c.body, { headings: 'strong', base: $meta.comments.url }) }">
    <md-doc data-sn-prop="{ doc }"><a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"></a></md-doc>
  </article>
</template>
```

### The rules

1. **Within the root's package.** A root's declared slot is filled at every `<slot>` of that name in
   the components of the root's package (or, for a root in `src/components/`, the app's components)
   inside the root's expansion. A component from another package cannot capture a fill by having a
   slot with the same name. Inside a package, the author controls every name; a component that wants
   a slot of its own gives it another name.
2. **A root written in caller markup** (a page, a fill, slot content, a component of another
   package) starts a new contract: the outer fills do not reach into it.
3. **A root used in its own package's markup** inside another root (`md-doc` rendering a table cell
   through `md-inline`) is not a boundary. The fills of slots it also declares pass into it; their
   `Slot<T>` types must be the same.
4. **Every declared slot is placed** somewhere inside the root, or the library fails `sinter check`.
5. **Fills do not reach into slot content** the caller passes to the root.
6. **In a package's markup, the candidates of ``<sn-component use>``** are the package's own
   components whose names fit the convention or the map. The helper form is not allowed there: it
   would make every app component a candidate and the root's expansion unknown.
7. Reach-through passes no slot content to inner uses, so `SN314` stays as it is for recursive uses
   and `<sn-component>`.

### What a fill may contain

A fill is compiled into the package's shared definitions, which are compiled with an empty scope and
take only props. What it reads from the caller has to be carried in. In the first version:

- Reads of the caller's scope (state, `data-sn-let` names, loop variables, props) and `$slot`: the
  names it reads become hidden inputs of the specialization (below), passed through every level,
  through `<sn-component use>` points and into the children an empty fill gets. A `data-sn-let` name
  is captured as its value, as a prop is.
- Store functions on caller rows (`patch(c, …)`): each hidden input carries the sources it has at
  the use, as definition props do (`@def:<name>:<prop>`), per specialization.
- Handlers that write page-level state. A fill that writes state declared inside a caller's row is an
  error in the first version: a write needs a reference to that row's scope, not a value.
- `$el`, `$event` and `emit()`, as in the caller's markup. `emit()` names are checked against the
  component whose markup the fill is.

### How it compiles

A root use with fills compiles the package's shared definitions again for that set of fills: a
specialization, with its own `<template>`s in the head and its own functions. The key is the source
location of each fill (so the same text in two loops is two keys, with its own resolved names and
types), the use's `data-sn-early` mode, and whether the tree is unrolled
([4](#4-constant-trees-are-unrolled)). Each specialization costs a copy of every definition the root
reaches; step 6 of the [Plan](#plan) measures it.

`data-sn-early="off"` on a root use applies to its specialization as a whole, fills included: unlike
plain slot content, fills are compiled into the definitions.

### App-wide looks and wrappers

There is no shadowing. An app that wants its own links everywhere writes one wrapper:

```html
<!-- src/components/app-markdown.html -->
<template data-sn-component="{ doc: Root; code: Slot<{ node: Code }> }">
  <md-doc data-sn-prop="{ doc }">
    <a slot="link" data-sn-attr="{ href: $slot.node.url }"></a>
    <slot name="code" slot="code" data-sn-let="{ node: $slot.node }"></slot>
  </md-doc>
</template>
```

- Pages use `app-markdown`. The override is written down in one place and reaches the library only
  through what the root declares.
- A wrapper that lets pages fill a slot declares it and forwards it, as slots are forwarded today;
  the forwarding `<slot>` passes the data on with its own `data-sn-let`. Left empty, it shows its
  children, so a wrapper can give a default fill.
- The app names library types by re-exporting them from `src/sinter.types.ts`
  (`export type { Root } from '@acme/markdown'`), so `data-sn-component` keeps one source of names.
  `Slot` is exported by sinter, as `ComponentName` is generated by it.

## 3. Helpers over constants run at build time

Helpers are pure by contract. So **a helper call whose arguments are all build-time constants is run
by the compiler**, and its result joins the constants the evaluator already folds. There is no
marker.

- The result must be plain data (JSON values). A call that throws in Node, or returns anything else
  (a `Date`, a class instance, a function), is left to the browser, with a dev warning at the call,
  once. A page that must ship nothing says so with `static`, and `SN322` names the call that keeps it
  from folding.
- The built-in formatters keep their rules (folded only under `localePrefix`, for the cases
  configuration.md lists). A helper that takes a locale as an argument folds per language.
- Purity is trusted, not proven. Dev builds run each folded call twice and warn when the results
  differ.
- Loading. `compile()` stays synchronous: the Vite plugin loads the helpers module before compiling
  (with `ssrLoadModule`, as `sinter render` loads app modules) and passes it in. `sinter check` and
  `sinter lsp` load it the same way, so that what folds, and so `SN322`, agrees with the build; the
  LSP reloads it when its files change. Testing's `render()` and `firstPaint()` already take
  `helpers`.
- Trust. The helpers module and the packages it re-exports already run in the app; now they also run
  in Node, as Vite plugins and the app's config do. A compiler hook was rejected for a different
  reason ([Alternatives](#alternatives-considered)): its output is markup the checker and the editor
  cannot follow. A helper's output is data with a type.

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

## 5. Files as resources

**A resource whose `src` starts with `./` or `../` is a file in the project**, read at build time, as
`<img src="./photo.jpg">` is today.

```html
<sn-resource name="post" src="./post.md"></sn-resource>
```

- The path is a literal, resolved against the file that wrote it (a page, a layout or a component)
  and confined to the project root. An interpolation (`{…}`) in such a `src` is an error: pages per
  file are [not in this proposal](#not-in-this-proposal). A missing file is a build error.
- The value is the file's text, or for `.json` its parsed value, as response bodies are read today.
  It is a build-time constant: bindings over it fold, and so do helpers called over it
  ([3](#3-helpers-over-constants-run-at-build-time)).
- Whatever does not fold reaches the browser as embedded data: the value is written into the head
  as a `data-sn-data` slot is, so the first frame has it, with no request.
- There is nothing to load: no request, no preload, no `loading` state. `refresh`, `cache`,
  `paginate`, `each`, `call`, `when` and sync events on it are errors.
- The dev server reloads the page when the file changes.

### `$meta.<name>.url`

A resource's status gets one field: the URL it was last loaded from. For an API, the request's
absolute URL; for a file, its path from the project root (`/content/posts/post.md`). A parser that
takes it as a base resolves relative links and images in the document against it, so an image next
to a markdown file is found by the image pipeline (a path starting with `/` resolves against the
project root), and a relative link in an API's markdown resolves against the API.

## 6. Lets over helpers

Markdown from an API has to be parsed in the browser. `data-sn-let` is where a page names a value
computed from data, so that is where the parse goes, with two changes.

```html
<template data-sn-for="c in comments" data-sn-key="c.id">
  <article data-sn-let="{ doc: md.parse(c.body, { headings: 'strong', base: $meta.comments.url }) }">
    <md-doc data-sn-prop="{ doc }"></md-doc>
  </article>
</template>
```

1. **A let whose expression calls a helper is cached**: computed once per scope instance (each row
   has its own) and kept until one of its dependencies changes. A let without a helper call stays
   inlined, as today. So each comment is parsed once, and again only when its body changes.
2. **A let may call a helper that reaches a lazy package.** Its value is `undefined` until the
   package has arrived, and `sinter check` types it `T | undefined`; the package's arrival is one
   more dependency, which renders what reads the let. `<md-doc>` takes `doc?: Root` and renders
   nothing without it. The compiler preloads such a package on the page (as `data-sn-preload` does),
   so it downloads alongside the resource's request instead of after it. `SN324` then covers a helper
   that reaches a lazy package called anywhere but in a `data-sn-let`.

- A let that waits for a package is not early. The rest of the item (a comment's author and date)
  still renders early with embedded data. An app that wants the markdown itself in the first frame
  leaves the parser out of `lazy`: the helper is then synchronous, the let is early over embedded
  data, and the parser is in the early file, within the early budget's warning. Both are choices
  sinter has today.
- A draft in state is a let like any other: `data-sn-let="{ preview: md.parse(draft) }"` is a live
  preview, cached until the draft changes.
- Two views of one item parse it twice, once in each scope.
- The lazy transform applies to configured packages' modules as it does to the app's
  ([7](#7-libraries-ship-source)), so a library's helper that imports its parser is covered.

## 7. Libraries ship source

A library ships source: component `.html` files, their scripts, helper modules and types. The app's
sinter compiles them as it compiles the app's own components, which is the only way a library gets
the app's build-time constants, early script, embedded data, type checks and scoped styles.
Precompiled output would lose all of them. Svelte libraries ship `.svelte` files for the same
reason. This step comes last in the [Plan](#plan), once sections 1 to 6 have fixed the source format.

- **Named in the config**, as `lazy` names packages: `sinter({ components: ['@acme/markdown'] })`.
- **An app-shaped folder.** The package's `package.json` has `"sinter": "./sinter"`, a folder laid
  out like an app's `src/`: `components/`, `sinter.helpers.ts`, `sinter.types.ts`. Components in
  `components/internal/` are internal; the others are public. There is no list to keep in sync.
- **A prefix per package.** A package's component names share their first segment (`md-doc`,
  `md-link`: `md`), and the package owns it. Two packages with one prefix, or an app component with a
  package's prefix, fail the build. There is no shadowing.
- **Public and internal.** The app using an internal component is an error that names the public
  ones. `ComponentName` holds the app's and the public ones; a package's own `use` is checked against
  its own components, internal ones included.
- **Helpers are a namespace**, the one way the app uses them: `export * as md from '@acme/markdown'`
  in `src/sinter.helpers.ts`. A re-export from a configured package is followed like a relative one.
- A library's props, slot data and helper results resolve type names against the library's types
  module, not the app's `sinter.types.ts`.
- Component scripts work as in the app: the generated base class and the `*/name.html` declarations
  cover library components, and `sinter render` finds their scripts.
- **Files.** Paths in configured packages are read even when their real path is outside the project
  root (a workspace link). In dev, configured packages are left out of Vite's dependency
  pre-bundling and watched, so a change to a linked library reloads the page. The lazy transform
  covers their modules.
- **Styles.** A library's scoped styles go into `@layer sinter-lib`, wrapping their `@scope` blocks.
  sinter declares that layer first in the page's stylesheet, so unlayered app CSS and the app's own
  layers win; an app can place it among its layers by declaring the order itself.
- Diagnostics in library files name the file in the package, then where the app uses it:
  `@acme/markdown/sinter/components/internal/md-table.html:4 … used at src/pages/post.html:12`.
- **The library author's checks.** A library has no pages, and `sinter check` checks a component
  through the pages that use it. A library keeps fixture pages beside its folder that use its public
  components with the cases it supports; `sinter check` in the library's repository compiles those,
  and rule 4 of [tree slots](#the-rules) is checked there and in the app's build.
- **Versions.** A library declares the sinter versions it supports as a `peerDependency`; the app's
  sinter checks the range. It cannot know which version introduced a feature newer than itself.

# Part 2: the markdown library

## 8. Parse options: what content may contain

Markdown written by users and markdown written by the team need different rules: a comment must not
add an `<h1>` to the page, may not embed images, and must not carry raw HTML. Those rules are options
of the parser, not slots that render nothing:

```html
data-sn-let="{ doc: md.parse(c.body, { headings: 'strong', images: 'link', html: 'text', base: $meta.comments.url }) }"
```

- The tree that comes back has no headings left, so a table of contents built from it agrees with
  what is shown. A slot that renders nothing would leave the heading in the tree.
- The policy is in one place per use, and folds at build time like the rest of the call.
- Raw HTML in markdown is never markup in sinter. The options are `'drop'`, `'text'` (shown as
  written, the default) and `'allow'`, which keeps a fixed set of elements (`kbd`, `sub`, `sup`,
  `mark`, `details`, `summary`) with a fixed set of attributes, each rendered by its own component.
  `data-sn-attr` takes literal keys and sinter has no dynamic tag, so a list chosen by the caller
  cannot be rendered; the set grows with the library.
- Link and image URLs from the tree are `attr` bindings, so the runtime's scheme check refuses
  `javascript:` and other unsafe URLs without the parser's help.

## 9. The library

- **One helper namespace.** `md.parse(source, options)` returns an mdast tree (CommonMark, and GFM
  tables, task lists, strikethrough and autolinks), typed as a discriminated union. `options.base`
  resolves relative URLs. Further helpers read the tree: `md.headings(doc)` for a table of contents,
  `md.text(doc)` for a description or a reading time.
- **One function in three places.** Over a file resource, the compiler runs it. In a let over API
  data, it loads on demand when the app lists the parser in `lazy`, or with the page when it does not.
- **Public components**: `md-doc` (block content) and `md-inline` (one line: a title, a table
  cell). `md-doc` uses `md-inline` for phrasing content, which rule 3 of [tree slots](#the-rules)
  covers. One internal component per node type. Both take `doc` as optional and render nothing
  without it, for a let that waits.
- **Declared slots** on both roots, for the nodes an app is likely to change: `heading`, `link`,
  `image`, `code`, `inlineCode`, `blockquote`, `table`. Adding one later is additive.
- **What sinter already does for it:** internal links prefetch; local images from the repo are
  optimized; headings get ids from their text, so `md.headings` and the anchors agree; a code
  block's fill can highlight at build time with a helper over the constant code.
- Where it lives (this repository, a package beside `create`, or its own repository) is decided at
  step 9.

## Breaking changes

- **A resource `src` starting with `./` or `../`** was a request relative to the page's URL; it
  becomes a file read at build time, and a missing file fails the build. A page that fetches such a
  path at run time writes it from the root (`/data/x.json`). The error for a missing file says so.
- **Helpers over constants run at build time.** A helper that breaks the purity contract (reads the
  clock, a random number, a global) gets its result baked into the HTML. The dev check warns where
  two runs differ.
- **A let over a helper is cached.** A helper that breaks the purity contract no longer gives a new
  value at every read.

## Limits

- A constant tree with any subtree that needs run time is not unrolled in the first version.
- Markdown from an API as a string is in the first frame only when the parser is not lazy, and then
  the parser is in the early file. Reserved space covers only paginated lists, so a body that renders
  late shifts the layout. An API that sends the tree avoids both.
- A fill cannot place the node's children deeper inside itself, or beside other content.
- Each specialization of a package's definitions is a copy of every definition its root reaches.
- A stream that appends to a let's source parses the whole body again for each chunk.
- A fill cannot write state declared inside a caller's row.

## Diagnostics

New codes are numbered when implemented. Existing codes keep their meaning and gain cases.

| Situation | Diagnostic |
| --- | --- |
| A fill for a slot the component or root does not declare | `SN314`, with the declared names |
| A `Slot<T>` member passed through `data-sn-prop` | `SN313` |
| A placement's `data-sn-let` does not fit `T` | at the placement |
| A declared slot is placed nowhere inside the root | in the library's `sinter check` and the app's build |
| A literal `id` in a fill rendered more than once | at the fill |
| A fill writes state declared inside a caller's row | at the write |
| The helper form of `<sn-component use>` in a package's markup | at the use |
| A helper over constants that could not be folded | dev warning, at the call; `SN322` on a `static` page |
| A tree over the expansion limit | warning, at the use, with the count |
| A file `src` with an interpolation, outside the project root, or missing | at the resource |
| `refresh`, `cache`, `paginate`, `each`, `call`, `when` or sync events on a file resource | at the attribute |
| A helper that reaches a lazy package, called outside a `data-sn-let` | `SN324`, with the hint |
| A configured package has no `"sinter"` folder, or it lacks `components/` | the package |
| Two packages, or a package and the app, own the same prefix | both owners |
| The app uses an internal library component | the public ones |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A token stream (markdown-it's open and close tokens) | Markdown is a tree, and so are sinter templates; the renderer would rebuild the nesting |
| A component map passed down the tree (`{ link: 'ugc-link' }`; react-markdown and MDX do this) | In JSX a component is a value; in sinter markup is. A map can be an expression, so the compiler knows less, and every node component has to pass it on |
| Shadowing (an app file named like a library component replaces it) | Silent, global, and makes every internal name public API. One wrapper with fills does the same, visibly |
| Inner components declare their own fillable slots | The contract would spread over every file of the library |
| A `data-sn-slots` attribute for slot data (first revision) | A third declaration beside props and events; `Slot<T>` in the props type keeps two |
| A marker on placements that reach through (`data-sn-tree`, first revision) | Only needed against capture from outside the package, which the package rule already prevents |
| A placeholder for the children in a fill (`<sn-children>`, first revision) | An element and an attribute for what an empty fill can mean, mirroring fallback content; loses placing children deeper |
| A `pure()` marker on helpers (first revision) | Helpers are pure by contract already; a call that cannot fold stays in the browser |
| `$file()` for a file's text (first revision) | A resource with a file as its `src` does the same, with local images as the precedent, and makes repo and API markdown the same markup |
| Derived fields on resources (first revision) | A new attribute for what `data-sn-let` already names; a let also covers drafts in state. It parsed once per item for all views, where a let parses once per scope |
| A compiler hook a library registers for its tag | Its output is markup that `sinter check` and the editor cannot follow |
| Bindings that wait for a lazy package | Every binding would need a pending state. Only lets wait, and they read as `undefined`, as a resource that has not loaded reads as empty |
| HTML from the parser, inserted through the Sanitizer API | Loses per-node looks, conflicts with markup from the network staying inert, and is not in every browser sinter supports |

## Not in this proposal

- Pages from a folder of markdown files (a blog: one page per post, an index of them). It builds on
  file resources and helpers at build time, and needs its own design for page paths and
  interpolated file `src`s.
- Partial unrolling: a constant tree with a subtree that needs run time.
- Parsing in a worker.
- Using sinter components outside sinter: unchanged, still deferred.

## Plan

1. **A spike in userland, measuring only.** In an example app: `md.parse` as an ordinary helper over
   micromark and mdast, loaded with the page; about fifteen recursive `md-*` components; an article
   and a comment list from the API. Measure, in `bench/`: render time and binding count for a long
   article; the page and early files with embedded data (the parser pulled into the early file);
   re-parse cost per render, since lets are inlined today, and per streamed chunk. It cannot try
   fills or reach-through, which need the compiler; it shows where they are missed.
2. **Slots that pass data** (section 1): `Slot<T>`, `<slot data-sn-let>`, `$slot`, and the empty-fill
   rule, with a data table as the test. Useful on its own.
3. **Nested constant loops, decisions per instance, one expansion, and constants before layout and
   images** (section 4, items 1, 2, 4 and 5). Useful for any page with nested constant data.
4. **Helpers over constants at build time, file resources and `$meta.<name>.url`** (sections 3 and
   5): loading the helpers before compile, in the plugin, `sinter check` and `sinter lsp`.
5. **Constant trees** (section 4, item 3): a docs page from a `.md` file ships no JavaScript, with
   its images optimized. A test in `test/` and the `static-site` example. Sets the expansion limit.
6. **Tree slots** (section 2): reach-through within a package, nested roots, specializations with
   hidden inputs and their sources, early mode, unrolling of specializations. Measures the cost per
   specialization.
7. **Lets over helpers** (section 6): cached, and waiting for a lazy package, with the preload.
8. **Libraries ship source** (section 7), once the format above is settled. The spike's components
   move into a local package with fixture pages.
9. **The markdown library** (Part 2), its docs page, `llms.txt`, and a recipe with an article and its
   comments on one page.

Steps 2, 3 and 7 do not depend on each other and can be built in any order.

## Open questions

- Whether the `./` and `../` rule for `src` is acceptable as a breaking change, or needs a
  migration warning for one release first.
- Fills as elements, as slot content is today, or as `<template slot>`, which makes the repetition
  visible and allows text or several elements without a wrapper.
- Whether a library may declare that its parser is lazy, or only the app's `lazy` option does.
- Whether a let that waits for a package should expose that through `$meta`, for a placeholder, or
  `data-sn-if` on the let is enough.
- How the image pipeline and `md.parse` agree on root paths when Vite's `base` or `publicDir` is
  set.
- The expansion limit: per tree or per page, and its value from step 5.
- Partial unrolling, if step 5 shows trees that are constant except for a button.
- Writes from a fill to state inside a caller's row: needed, or a fill emits instead.

## Proposed decisions

| Question | Proposal | Section |
| --- | --- | --- |
| New vocabulary | `$slot` and `Slot<T>`; everything else is a rule for what exists | [What is new](#what-is-new) |
| Slot data | Declared as `Slot<T>` in the props type, passed with `<slot data-sn-let>`, read through `$slot`; ships before trees | [1](#1-slots-that-pass-data) |
| Children inside a fill | An empty fill gets the default's children, keeping the library's style scope | [1](#an-empty-fill-gets-the-defaults-children) |
| Reach-through | Within the root's package; a root in caller markup is a boundary, one in its package's markup is not | [2](#2-tree-slots) |
| Fills in the first version | Reads, store functions on caller rows, page-level writes; no writes to a caller row's state | [2](#what-a-fill-may-contain) |
| App-wide looks | A wrapper component with fills; no shadowing | [2](#app-wide-looks-and-wrappers) |
| Helpers at build time | Every helper over constants, by its purity contract; what cannot fold stays in the browser | [3](#3-helpers-over-constants-run-at-build-time) |
| Constant folding | Nested loops, per-instance decisions, one expansion, constants before images; then trees | [4](#4-constant-trees-are-unrolled) |
| Files from the repo | A resource `src` starting with `./` or `../`; what does not fold becomes embedded data | [5](#5-files-as-resources) |
| Base URLs | `$meta.<name>.url` | [5](#metanameurl) |
| Markdown from an API | A let over the parser: cached per scope, waiting for a lazy package | [6](#6-lets-over-helpers) |
| How a library ships | As source, named in the config, an app-shaped folder, last in the plan | [7](#7-libraries-ship-source) |
| What content may contain | Parse options; raw HTML shown as text by default; `'allow'` is a fixed set | [8](#8-parse-options-what-content-may-contain) |
| First step | A spike that measures, before any compiler change | [Plan](#plan) |
