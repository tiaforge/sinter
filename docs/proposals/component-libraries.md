# Proposal: component libraries, with markdown as the first

Status: draft, fifth revision, after four reviews. Nothing here is implemented. It builds on what
sinter has wherever it can; what is new is listed in [What is new](#what-is-new). Sections are
numbered in the order of the [Plan](#plan). Every design choice is recorded in
[Decisions](#decisions); what is left depends on measurements ([Open questions](#open-questions)).

Constraints set by the user:
- Markdown from the repo (built with the site) and markdown from an API (a string in a response)
  are the target, equally. Streaming and APIs that send a parsed tree should work too, but do not
  drive the design.
- Parsing and rendering are separate parts. The parser returns a tree, not a stream of tokens.
- How a node looks is changed with slots, not with a map of components.
- Only the root component of a library declares the slots a caller can fill. The library's
  contract stays in one file.
- A bigger feature is fine where it fits best, but existing concepts are generalized before a name
  is added.

## Goals

- Markdown from the repo is plain HTML in the page, with optimized images and no JavaScript.
- Markdown from an API renders with the page's bindings, parsed once per value, with the parser
  loaded only where it is used, and with the same elements as the same markdown from the repo.
- An app changes how any node looks, per use or app-wide, without naming a library's internal
  components.
- What user-written markdown may contain is decided in one place, and raw HTML never becomes markup.
- A library ships components, helpers and types that the app's sinter compiles like its own.
- Every piece is general: none of the compiler's work is specific to markdown.

## The case

An app wants to render markdown: a docs page from a file in the repo, an article body or a comment
from its API. Today it has two choices, and neither is sinter's:

- An island (`<md-view>` with markdown-it in a component script). Nothing is in the first frame,
  every node is built by hand in the script, a link cannot be the app's link, and the parser ships to
  every page that uses it, also for markdown that never changes.
- HTML from somewhere else, inserted as markup. sinter has no `innerHTML` binding, and markup from
  the network stays inert ([security.md](../security.md)). That rule stays.

With this proposal:

```html
<sn-resource name="post" src="file:./post.md"></sn-resource>                <!-- the repo: folded into HTML -->
<sn-resource name="post" src="/articles/{$url.slug}/body"></sn-resource>    <!-- an API: parsed in the browser -->

<article data-sn-let="{ doc: md.parse(post) }">
  <md-doc data-sn-prop="{ doc }"></md-doc>
</article>
```

The same pieces serve a syntax-highlighted code block, math, an icon set, a data table with custom
cells, a tree view: a library that turns a value into a tree, and components that render the tree.
[Design](#design) is what such libraries need from sinter, and none of it is about markdown.
[The markdown library](#the-markdown-library) is the first library.

## What sinter has to build on

- **Recursion and runtime choice** ([components.md](../components.md#a-component-inside-itself)): a
  component may use itself through a `data-sn-for` or `data-sn-if`, compiled once as a shared
  definition (`<template id="sn-def-…">` in the head). Each inner use becomes an empty
  `<template data-sn-def>` in place, with a `for` over its props; the definition it clones is named
  by that static attribute (`src/defs.ts`). ``<sn-component use>`` becomes one such template per
  candidate, each with its own `for` that evaluates `use`. With embedded data, the early script
  renders a tree in the first frame at any depth.
- **Anchors.** Every `data-sn-if` and `data-sn-for` keeps its `<template>` in place and inserts an
  end comment after what it renders (`runtime/app.ts`); so does every recursion point and every
  candidate. A `<template>` is an element, so `:first-child`, `:nth-child`, `+` and `>` count it:
  `li:first-child` does not match the first row of a list today, and with N candidates of
  `<sn-component use>`, N empty templates sit before every dispatched row, so `+` fails between any
  two rows. Measured in step 1 on the article: `li:first-child` 0 of 63, `h2 + p` 0 of 25, `p + p`
  0 of 53, `:is(p, li) > :first-child` 0 of 338, and `tr:nth-child(even)` with its parity flipped.
  The compiler's layout model counts
  it too: reserved space and `sizes` treat "the template, right before row 1" as a sibling
  (`compiler/layout.ts`, spec.md Reserved space).
- **Ids.** Root bindings, `if`s and `for`s have node ids (`data-sn`); templates have ids of their own
  in the IR; templates inside rows have neither, only a path. An `else` is a root node of its own,
  linked to its `if`.
- **Addressing.** Root nodes are found with one `querySelectorAll('[data-sn]')` at mount. Inside a
  row, nodes are found by sibling-index paths, checked by tag name. A keyed list gives each row the
  nodes from its first node to the next row's first node; a row made only of a nested template has
  that template as its first node.
- **Early to page.** The early script marks each template it rendered with a `Symbol.for` property
  (`EARLY`, `EARLY_ROWS`), and the page module reads it per node, also to step over nested content in
  adopted rows. `runtime/handoff.ts` holds prefetched responses and a meeting flag. The page module
  computes state again on mount.
- **One root element.** A component's template has exactly one plain element at its top, not a
  `<template>`, a `<slot>` or a component. A text binding sits on an element: `data-sn-text` sets an
  element's content. In step 1 the rule forced no wrapper elements, but a component per heading
  level and per kind of list (`md-h1` … `md-h6`, `md-ul`, `md-ol`), and a `<span>` around every run
  of text that sits beside an element (1,475 of them).
- **Text in parsed HTML.** Two text nodes side by side in HTML come back from the parser as one, and
  an empty one as none. Today each text binding has an element of its own, so this never matters.
- **Build-time constants** ([spec.md](../spec.md), Build-time constants): a binding over constants is
  written into the HTML, a `data-sn-if` over them is decided, and a `data-sn-for` over a constant
  list of up to 1,000 items is unrolled. A prop given as a literal, or left out, already decides a
  `data-sn-if` per use, before the walk. The evaluator runs the built-in messages, and under
  `localePrefix` some formatters, but no app helpers. The limits that matter here:
  - only state fields and literal props are constants; no resource is;
  - a row is unrolled only when none of its nodes is a nested template, and none has a handler;
  - a state-based `data-sn-if` is decided per template, only when it reads no row, and inside a
    component only when every use agrees;
  - unrolling is two full compile passes, not a fixpoint;
  - shared definitions are never unrolled.
- **The compile order.** In `run()` in `compile.ts`: loops are unrolled; the layout is computed,
  reserved space planned and images rewritten; the walk compiles bindings, reading the layout for
  bound images; the evaluator writes constants, so it can only run after the walk. An `<img>` with a
  `data-sn-*` attribute is skipped by the image pipeline. `compile()` is synchronous.
- **Scopes at run time.** A row's scope is `Object.create` of its parent's, so a definition's rows
  already chain to the scope of the row the tree was used in.
- **Sources.** A resource's `src` is a request. With `sinter({ apis })` it is `[api:]/path`, where
  `site` is a built-in API name. The image pipeline reads every `src` without a scheme as a file
  (`photo.jpg`, `./photo.jpg`, or `/img/x.jpg` from the project root).
- **Embedded data**: JSON in a placeholder in the page's head (`<script type="application/json"
  data-sn-data>`), read by the early script and the page module as a resource's first value.
- **Helpers are pure by contract**: "same arguments, same result, nothing read or changed elsewhere"
  ([configuration.md](../configuration.md#helpers)). Their manifest is read statically. The early
  file imports each helper from the module that declares it; the page module imports namespace
  members from the namespace's module.
- **`data-sn-let`** names values computed from state, resources and loop variables. A name "is
  compiled into every expression that reads it, so it is always current, costs no runtime and is
  tracked like the expression itself" (spec.md, Derived names); a helper in a let is called again at
  every read. Entries are `name: expression`, with no shorthand, and may not reuse a name in scope
  (`SN209`). A component's props are lets internally. State may be changed in place
  (`data.splice(…)` in the benchmark), so the same object can hold new contents.
- **Lazy packages** ([lazy.md](../lazy.md)): every call into the package returns a promise. A helper
  module that reaches one is `SN324`, and lazy.md names a markdown body as the case to load with the
  page instead; the RealWorld example notes that a lazy renderer was what held its largest element
  (`examples/realworld/src/markdown.js`). Loaded with the page, that island (marked and DOMPurify,
  writing `innerHTML`, so not under Trusted Types) is the fastest option step 1 measured: LCP 188 ms,
  1,370 elements, 120 ms from the response to the rendered article, against 424 ms, 2,831 elements
  and 346 ms for the userland components. The gap is mostly rendering, not parsing; it is the bar
  steps 2 to 4 are measured against. A component script that imports a lazy package loads with
  it, whole, when the component first renders. The lazy transform and its import walk cover the
  app's modules, not `node_modules`. `<sn-resource call>` runs an async action function; it does not
  combine with `each` and is not early.
- **Slots** fill at build time: the caller's content goes into the `<slot>` of that name, and a
  plain slot inside a `data-sn-for` renders it once per row. Two `<slot>`s of one name in a file are
  `SN312`, also in two branches of one `if`/`else`. An empty slot shows its own children. A `<slot>`
  belongs to the component whose file it is written in, so one inside content passed to another
  component forwards (`<slot name="aside" slot="side">`). Slot content sees only the caller's scope.
  A recursive component's inner uses take no slot content (`SN314`), and `<sn-component>` drops it.
  A `<slot>` written on a page is left in the HTML, with no diagnostic.
- **Bugs this proposal touches**, independent of it: the tag's attributes on a recursion point are
  dropped with no diagnostic (the tag becomes `<template data-sn-def>`); a `<template data-sn-for>`
  inside `<svg>` crashes the compiler (parse5 gives a foreign `template` no `content`). The step 1
  spike found and fixed two more, on its branch: `defs.ts` looked a definition up in the inert
  document of a row not yet inserted (a TypeError in Chromium that jsdom and happy-dom do not
  reproduce), and the early renderer inlined definitions that reach each other without end, which
  overflowed the stack with embedded data.
- **Scoped slots were sketched as additive** in the [components proposal](components.md#scope), as
  `<slot data-sn-let="{ item }">` read through `$slot`. `data-sn-let` takes no shorthand, so this
  proposal keeps `$slot` and passes the data with `data-sn-prop`.
- **Components and helpers come only from the app:** a flat `src/components/`, `ComponentName` as a
  generated global union of the app's components, and helper namespaces re-exported along relative
  paths only. Exporting components was "left for after the first release" ([components proposal,
  Decisions](components.md#decisions)); that was about using them outside sinter, which this
  proposal does not change.

## What is new

| Need | Built on | New |
| --- | --- | --- |
| Lists and trees that CSS sees as plain elements | `if` and `for` anchors, shared definitions in the head | anchors as comments in place, every template in the head |
| A template chosen by a value (`<sn-component use>`, fills) | `if` anchors, shared definitions | a third kind of anchor, the choice |
| Slot content that receives data | `<slot>`, `data-sn-prop`, magic names such as `$event` | `$slot`; `Slot<T>` in the props type |
| A fill that places the node's children | `<slot>` and the innermost-first lookup of names | a rule: a `<slot>` is filled by the nearest markup given content for it |
| A heading whose fill picks its level | `SN312`, `if`/`else` | a rule: one slot may be placed in each branch of one chain |
| A root that is not one plain element | `data-sn-if`, component tags, `<slot>` | a rule: a root renders at most one element |
| Text without an element | `data-sn-text`, `<template>` | `data-sn-text` on a `<template>`; a text node as a binding target |
| Fills that reach deep into a tree | slots, the runtime scope chain | a rule: a placement of a slot the component does not declare is filled by the root |
| Constant trees folded into HTML | unrolling, literal props | a constant pre-pass, nested loops, decisions per instance, a worklist |
| Helpers run at build time | the purity contract, the evaluator, messages at build time | a rule, with a static check of what each helper may reach |
| A file from the repo | `<sn-resource src>`, `site`, embedded data | the `file:` source |
| Parse once per value, with a package loaded on demand | `data-sn-let`, lazy component scripts | two rules: a let over a helper is cached; it may wait for a lazy helper module |
| Components from a package | `src/components/`, helper namespaces, the `lazy` option | `sinter({ components })`, the `"sinter"` field, `components/internal/`, `@layer sinter-lib` |

The behaviour of existing pages that changes is listed in [Breaking changes](#breaking-changes).

## Where markdown comes from

| Source | Example | Parsed | Shipped |
| --- | --- | --- | --- |
| The repo | docs, a README, page copy | by the compiler | HTML only: no parser, no bindings |
| An API, as a string | an article body, a comment | in the browser, once per value, in a `data-sn-let` | the parser and the renderer's bindings |
| An API, as a tree | a backend that stores mdast | not at all | the renderer's bindings; first frame with embedded data |
| A stream | model output | in the browser, again on each chunk | as from an API |

Keeping parsing and rendering apart lets one library serve all four. The renderer only ever sees a
tree, and with [1](#1-anchors-as-comments) it renders the same elements whichever way it was
rendered.

## Design

### 1. Anchors as comments

Every place sinter renders a variable number of nodes is marked in the DOM by a start and an end
comment, and its templates live in the head.

```html
<!-- today -->
<ul><template data-sn="4"></template><li>a</li><li>b</li><!----></ul>

<!-- proposed -->
<head>… <template id="sn-t-1"><li>…</li></template> …</head>
<ul><!--sn 4--><li>a</li><li>b</li><!--/sn--></ul>
```

Comments are not elements, so `li:first-child`, `:nth-child`, `h2 + p` and `.md > * + *` match the
rendered elements as they would plain HTML. This holds for every list and branch in sinter, not only
for markdown, and markdown from an API renders the same elements as markdown folded from the repo.
The DOM is not identical: `childNodes` also holds the comments and any text separators
([3](#text-without-an-element)).

#### Three kinds of anchor

| Kind | Renders | Templates |
| --- | --- | --- |
| `if` | one branch of an `if`/`else` chain, or nothing | one per branch, fixed |
| `for` | one instance of its template per item | one, fixed |
| choice | one instance of a template chosen by a value | one of a fixed set, by the binding's value |

- An `if`/`else` chain becomes one anchor pair with a template per branch; the `else` is no longer a
  node of its own in the IR.
- The choice is new. ``<sn-component use>`` becomes one choice anchor whose value is the candidate,
  where today it is one anchor and one evaluation of `use` per candidate. Measured in step 1, a
  2,963-node article dispatched over 14 block and 9 inline candidates renders 2,831 elements beside
  25,150 `<template>`s and 24,774 comments (8.5 and 8.4 per node) and 27,285 bindings, almost all of
  them candidates' `for`s; the 2,380 candidates that rendered also keep a copy of their definition in
  their `content` (16,230 inert nodes). A choice anchor makes that two comments and one evaluation
  per node. A fill uses the same anchor ([4](#how-it-compiles)).

#### Ids and templates

- A root anchor's start comment carries its node id (`<!--sn 4-->`). An anchor inside a row carries
  none (`<!--sn-->`): it is found by its path, as nodes in rows are today.
- Templates are found from the IR (`sn-t-<template id>`), not from the comment, and cached once per
  template.
- An author's comment that starts with `sn` is an error at compile time.

#### Shared definitions are head templates

Today a shared definition (a component used inside itself, a candidate of `<sn-component use>`) is
the one template that already lives in the head (`<template id="sn-def-<name>">`). Each place that
uses it is an empty `<template data-sn-def>` in the body, which `defs.ts`, and the same code in
`early.ts`, fill with a copy of the definition before it is first cloned.

With every template in the head, a definition is a head template like any other, which several
anchors point to:

- the empty `<template data-sn-def>` in the body, the `data-sn-def` attribute, the `defs` feature
  (`src/defs.ts`) and its copy in the early script go away;
- an anchor of a recursion point, or a choice among candidates, instantiates the definition's head
  template directly, as a `for` instantiates its row template;
- `sn-def-<name>` and `sn-t-<id>` become one way to name a template in the head: by template id,
  with the component's name kept in dev builds for reading.

The definition stays as a concept: one template, compiled once, that the whole tree reuses.

#### Finding anchors

- **The page module** finds root nodes with a walk over the mount root that visits elements and
  comments (a `TreeWalker` for both), replacing `querySelectorAll('[data-sn]')`. It also visits
  author comments and text separators. Measured in step 1 on a page of 20,000 nodes: 0.2 ms for
  `querySelectorAll`, 0.5 ms for the walk, 1.4 ms with a test per node. The cost is negligible.
- **Inside rows,** paths count comments as nodes, as they count templates today, and a nested anchor
  is skipped from its start comment to its end comment.
- **The early script** sees comments as the parser inserts them (`MutationObserver` reports comment
  nodes too): one more `nodeType` check per added node. An anchor is ready when its end comment is
  parsed, which replaces waiting for the `else` sibling. Its first scan covers anchors already parsed
  in the head.
- **Handing over** stays per node: the early script puts `EARLY` and `EARLY_ROWS` on the start
  comment instead of the template element, and the page module reads them there. `handoff.ts` does
  not change. A start comment without them but with nodes before its end comment is an early render
  that failed, and the page module clears it; today that case would duplicate.

#### What else changes

- **The layout model.** Reserved space, `sizes` and paint CSS treat the template as the element
  before row 1, and a trailer template after the rows (`layout.ts`: `withRow`, `rowSibling`,
  `rowStructural`, `around`, `siblingsUnknown`, `TRAILER`). They are reworked to count no element
  there, and spec.md's Reserved space paragraph is rewritten. This is a large part of step 2.
- **The anchor is a `Comment`.** Code that treats the bound node as an element changes: the dialog
  check (`closest('dialog:not([open])')`), `BoundBinding.el`'s type, `prepared` and the `else`
  pairing. `$el` in an `if`, `for` or choice expression has no element and is an error.
- **Foreign content.** A template's content in the head is parsed as HTML. For an anchor inside
  `<svg>` or `<math>`, the compiler wraps the head template's content in that element and clones the
  wrapper's children, so `<circle>` is SVG. This also fixes the crash on `<template data-sn-for>`
  inside `<svg>`.
- **Raw text.** An anchor or `<template data-sn-text>` inside `<textarea>` or `<title>` is text to
  the parser; that is an error, where today it is silent.
- **Head weight.** Every template moves before `<body>` in the byte stream. Templates the early
  script never instantiates go at the end of the body instead; step 2 measures the bytes before the
  first byte of the body in `bench/first-paint`.
- **The early renderer's size.** It inlines each template's code at every place it is used, so
  the early bindings of step 1's article are 142 kB before compression. Templates the early file
  renders are written once into a table and referenced, as the spike's fix already does for
  definitions that reach each other; with one choice anchor per node, that also leaves one
  dispatch per node in the early file.
- **Dev checks.** A missing, duplicate or unpaired anchor comment is a dev warning, as a missing
  `data-sn` element is today. That is also how a comment-stripping minifier is noticed.
- **Benchmarks.** One-element rows, the hot path of `bench/js-framework-benchmark`, are unchanged:
  they clone the template's first child and find nodes with compiled paths. A nested template's
  content is no longer cloned with every row; a never-true `if` in a row becomes two comments where
  it was one template. The js-framework-benchmark and the live grids must not get slower.
- Pages that ship no JavaScript are unchanged: folded markup has no anchors.

### 2. Slots that pass data

A component passes values to the content of a slot. This is useful without trees (a data table with
custom cells, a list with custom rows).

```html
<!-- src/components/data-table.html -->
<template data-sn-component="{ rows: Row[]; columns: (keyof Row)[]; cell: Slot<{ row: Row; column: keyof Row }> }">
  <table>…
    <template data-sn-for="r in rows" data-sn-key="r.id">
      <tr><template data-sn-for="c in columns"><td><slot name="cell" data-sn-prop="{ row: r, column: c }"><span data-sn-text="r[c]"></span></slot></td></template></tr>
    </template>
  </table>
</template>
```

```html
<data-table data-sn-prop="{ rows: invoices, columns: ['number', 'customer', 'total'] }">
  <span slot="cell" data-sn-text="$slot.column === 'total' ? number($slot.row.total) : $slot.row[$slot.column]"></span>
</data-table>
```

#### The declaration: `Slot<T>`

- A member of type `Slot<T>` in `data-sn-component` is a slot that passes `T`. It is a type, not a
  value: the fill stays markup.
- The props must be a type literal for the compiler to see it, as for a component used inside
  itself; a slot in a type alias is an error.
- `Slot<T>` members are left out of the props everywhere else: `data-sn-prop` on the tag (passing
  one there is `SN313`), the script's generated base class (`this.props`), and the check for
  required props.
- Every slot may be left unfilled; the placement's own children are its default. `?` on a `Slot<T>`
  member is an error.
- Slots that pass data are named. A slot that passes nothing needs no declaration, as today.
- `Slot<T>` is not allowed in `data-sn-head` or a layout's declaration.
- `Slot` is a global type sinter generates, as `ComponentName` is. A type the app exports as `Slot`
  is an error that asks for another name.
- For a library author, turning a plain slot into a `Slot<T>` changes what an unnamed `<slot>` in a
  caller's fill means (below): a breaking change of the library, for its version.

#### The placement: `data-sn-prop` on a `<slot>`

`data-sn-prop` passes values to what renders inside, on a component's tag and now on a `<slot>`. It
takes shorthand and is checked against `T` as a tag's props are against the props type.

#### The fill: `$slot`

- A fill is written like slot content today: the elements with `slot="<name>"`, in order. A
  `<template slot="<name>">` is for what an element cannot be: an `if`/`else` chain
  (`<template slot="heading" data-sn-if>`) or a text (`<template slot="label" data-sn-text>`).
- Its scope is the caller's scope plus `$slot`, the values the placement passes, as a handler reads
  `$event`.
- Inside a fill for another component, the inner `$slot` hides the outer one; keep the outer value
  with `data-sn-let="{ outer: $slot.row }"` on the outer fill.
- Provenance flows through: `$slot.row` is the row the component got from its prop, so
  `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource, as `$event.detail`
  already carries sources.
- A fill for a slot the component does not have is `SN314`, the existing unknown-slot error.
- Whether a slot is filled cannot be tested in the component; an unfilled slot shows its default.

#### One slot in each branch of a chain

`SN312` counts placements that can render together. Two `<slot>`s of one name in different branches
of one `if`/`else` chain cannot, so they are allowed; for a slot that passes nothing, its content is
copied into each branch at build time, as a slot inside a `for` already renders its content per row,
and only one branch renders. This is what lets a heading fill pick its level
([below](#a-slot-inside-a-fill)).

#### A `<slot>` inside a fill

Today a `<slot>` belongs to the component whose file it is written in. That stays, as the special
case of one rule:

**A `<slot>` is filled by the nearest enclosing markup that is given content for it: a component,
given slot content by its caller, or a fill, given children by its placement.**

It is the innermost-first lookup sinter already uses for names in expressions. A fill is used by its
placement as a component is used by its tag:

| Caller and component | Placement and fill |
| --- | --- |
| the tag uses the component | the placement uses the fill |
| `data-sn-prop` on the tag | `data-sn-prop` on the placement |
| the tag's children are the slot content | the children of the element the placement's default renders are the fill's content |
| `<slot>` in the component | `<slot>` in the fill |
| props read by name | values read as `$slot.x`, since the fill also sees the caller's scope |
| an empty slot shows its children | an unfilled placement shows its default |

What a placement gives its fill, in the first version: its default slot, nothing named. The default
is a root ([3](#3-the-component-root)); the fill's content is the child nodes of the element it
renders, per branch. So:

- An unnamed `<slot>` inside a fill of a slot that passes data is the node's children. They are the
  component's markup: they keep its scope and its style scope, as slot content keeps its author's.
- A named `<slot>` inside a fill finds nothing in the fill and is the enclosing component's slot, as
  today, rendered once per placement.
- A fill of a slot that passes nothing is given nothing, so every `<slot>` inside it is the enclosing
  component's, as today. No existing page changes meaning.
- A component's own default slot cannot be placed inside a fill of a data slot, since the fill's
  `<slot>` is the children there; give it a name.

```html
<!-- placement: the default renders one element, whose children are what a fill's <slot> gets -->
<slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }">…the children…</a></slot>

<!-- fill: the children, then an icon -->
<a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot> ↗</a>

<!-- a heading fill that picks its level: a chain, with the children in each branch -->
<template slot="heading" data-sn-if="$slot.node.depth === 1"><h1 class="title"><slot></slot></h1></template>
<template data-sn-else><h2 class="title"><slot></slot></h2></template>
```

The cases at the edge:

- **Forwarding passes the children on.** A `<slot>` that is itself a fill (`<slot name="link"
  slot="link" data-sn-prop="…">` in a wrapper) gives its own fill what its placement gave it, so a
  page's fill of the wrapper's `link` can place `<slot>` too.
- **Names on the default's element.** The children move into the fill, so names the default's
  element declares (`data-sn-let`, `data-sn-state`) would be lost to them; a placement whose
  children read such names is an error in the library. Put them on the `<slot>` (`data-sn-prop`) or
  inside.
- A placement whose default renders no element (text, nothing) gives no children; a `<slot>` in its
  fill is an error that names the placement.
- A fill without a `<slot>` drops the children, as an image shown as its alt text does:
  `<span slot="image" data-sn-text="$slot.node.alt"></span>`.
- Two unnamed `<slot>`s that can render together in one fill are `SN312`.
- A `<slot>` that no component or fill encloses (on a page, or in a page's slot content) is an
  error. Today it is left in the HTML.

#### Literal ids in repeated markup

A literal `id` in markup that renders more than once (anything a `for` repeats, a fill inside a
template, or a fill of a slot placed more than once) is a warning, in pages and components alike.
Today it is unchecked in a page's loop.

### 3. The component root

A component's root exists so that what a caller writes on the tag (`class`, `id`, `aria-*`,
handlers, `data-sn-class`, `data-sn-transition`) lands on exactly one element. Today that is spelled
one way: one plain element. The rule becomes the guarantee itself:

**A component's root renders at most one element.**

| Root | Renders at most one element because |
| --- | --- |
| a plain element | as today |
| a `data-sn-if` / `data-sn-else` chain | each branch is a root; without an `else`, nothing renders when no branch holds |
| a component tag | its root renders at most one element |
| `<sn-component use>` | each candidate's root does |
| a `<slot>` | its default is a root, and so is every fill |

```html
<!-- ui-button.html: an <a> or a <button> -->
<template data-sn-component="{ href?: string; label: string }">
  <template data-sn-if="href"><a data-sn-attr="{ href }" data-sn-text="label"></a></template>
  <template data-sn-else><button type="button" data-sn-text="label"></button></template>
</template>

<!-- primary-button.html: a variant, with no wrapper -->
<template data-sn-component="{ href?: string; label: string }">
  <ui-button class="primary" data-sn-prop="{ href, label }"></ui-button>
</template>
```

The same applies outside markdown: a button that is a link or a button, a heading whose level is a
prop, variants of a design system's components (today each needs a `<div>` around the component it
specializes), a dispatcher that picks a block per type, a component that renders nothing without
data, and an element an app can swap for its own.

- A root that is not a plain element is an `if` or a choice like any other: anchored by comments
  ([1](#1-anchors-as-comments)), decided at build time when its condition is constant (then nothing
  but the element is left), and otherwise replaced when its condition changes, as an `if` branch is
  replaced today. Focus on the old element is lost, a handler on the tag sees the new `$el`, and a
  debounced or pending handler on the old element is dropped with it.
- Whitespace at the top of a component's template, between branch templates, is dropped.

#### What keeps a plain root

- **A component with a script.** It runs on its root (`this.root`, `connected()`,
  `disconnected()`); replacing the root would restart it.
- **A component with `data-sn-state` on its root**, which includes optional props' defaults. An
  `if` root would reset it, a `<slot>` root has no element of the component's to put it on, and a
  component tag's root belongs to the other component. Such components give defaults with `??` in
  their expressions, or keep a plain root.

#### The tag's attributes

- They are copied onto every branch at build time. The rule that one attribute on both the tag and
  the root is an error is checked per branch.
- With a component tag as root, they pass on to that component's tag, joined as `class` is today,
  down to the element that renders. One element is then the root of several uses: the compiler's
  map from a root to its use becomes a list (implementation work).
- With a `<slot>` as root, they land on the fill. One attribute on both the tag and the fill is an
  error at the tag, which names the fill.
- **On a shared definition** (a recursion point, a candidate of `<sn-component use>`), the tag's
  attributes are compiled in the scope where the tag is written and written onto the root the
  definition renders, read through the run-time scope chain as fills are
  ([4](#what-a-fill-may-contain)). Today they are dropped silently. `<sn-component>` keeps refusing
  other attributes (`SN101`).
- A root that may render nothing takes no `id`, `data-sn-model`, action (`data-sn-post`, …) or
  `data-sn-transition` on its tag: each would point at or depend on an element that may not exist.
  That is an error.

#### Scoped styles

- `data-sn-c` stays one name: the component whose markup the element is.
- When a component's root is another component's tag, the outer component's rules can only reach
  that element (its own markup inside is slot content, which `data-sn-s` already scopes). The
  compiler marks the element with the outer names in a second attribute (`data-sn-r`, written by the
  compiler like `data-sn-c`) and emits the outer component's root rules against it, outside
  `@scope`. A shared `@scope` would not work: the element would be both the scope's root and its
  limit, and the outer rules would reach the inner component's markup.
- An `if` root's branches each carry the marker.
- A `<slot>` as root: the component's root rules apply to its default, never to a fill; an instance
  whose slot is filled has no element with the component's marker. A fill is the caller's markup and
  keeps the caller's styles.

#### Text without an element

`data-sn-text` on a `<template>` renders a text node: the attribute that sets an element's text, on
the element sinter uses for "no element of its own".

```html
<template data-sn-for="p in highlight(title, q)">
  <template data-sn-if="p.match"><mark data-sn-text="p.text"></mark></template>
  <template data-sn-else><template data-sn-text="p.text"></template></template>
</template>
```

- Search highlighting, a list joined with commas and "and", a translated sentence with a link in it,
  and every run of text in a markdown paragraph need it. In step 1's article, 1,461 of the 2,831
  elements are `<span>`s that exist only to hold a run of text.
- **One node slot.** A text binding always occupies exactly one node: a `Text`, or an empty comment
  while its value is empty. So sibling paths do not shift with the value.
- **Separators.** In HTML written at build time, in HTML the early script renders as the page is
  parsed, and in the content of every template in the head, the compiler writes an empty comment
  (`<!---->`) between a text binding and a neighbouring text node, so each text node is found after
  the parser has merged them. A constant text folds into the HTML as text, with no comment, when
  nothing beside it runs.
- **Outside rows,** a text binding has no element for a `data-sn` id, so it is an anchor pair with
  its text between (`<!--sn 7-->text<!--/sn-->`), which needs no separator.
- **A target in the IR.** A text node is a new kind of node in the IR, the runtime's row paths
  (which check tag names today) and the early script's writers.
- **Robustness.** A row's first node is never a text node (a row that would start with one starts
  with its anchor), and a write finds its text from the node before it, so a text node that browser
  translation or an extension replaced is found again rather than written while detached.
- `data-sn-text` with `data-sn-if` or `data-sn-for` on the same `<template>` is an error.

### 4. Tree slots

A root's declared slot is filled at placements deep inside the root's expansion.

```html
<!-- @acme/markdown: components/md-doc.html, the root -->
<template data-sn-component="{ doc?: Root; link: Slot<{ node: Link }>; heading: Slot<{ node: Heading }>; code: Slot<{ node: Code }> }">
  <div class="md">…the nodes of doc.children, when there is a doc…</div>
</template>

<!-- @acme/markdown: components/internal/md-link.html, deep inside; its root is the slot -->
<template data-sn-component="{ node: Link }">
  <slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url, title: node.title }">…the children…</a></slot>
</template>
```

```html
<!-- a page -->
<template data-sn-for="c in comments" data-sn-key="c.id">
  <article data-sn-let="{ doc: md.parse(c.body, { headings: 'strong' }) }">
    <md-doc data-sn-prop="{ doc }"><a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a></md-doc>
  </article>
</template>
```

#### The rules

1. **A tree placement is a `<slot>` that passes data and whose name its own component does not
   declare.** `md-link` declares no `link`, so its `<slot name="link" data-sn-prop>` is a tree
   placement. A plain `<slot name>` and a placement of a component's own declared slot are never
   filled from outside. A tree placement whose name is close to one its component declares (`cel`
   beside `cell`) is reported at the placement with a suggestion.
2. **It is filled by the nearest enclosing root that declares the name**, within the root's package
   (or, for a root in `src/components/`, the app's components). The `Slot<T>` types must agree. A
   tree placement with no enclosing root that declares it is an error at the use that leaves it
   without one.
3. **A root written in caller markup** (a page, a fill, slot content, a component of another
   package) starts a new contract: the outer fills do not reach into it.
4. **A root used in its own package's markup** inside another root (`md-doc` rendering a table cell
   through `md-inline`) is not a boundary. The fills of slots it also declares pass into it; a fill
   written directly on that inner root's tag wins for its expansion, as the nearer one.
5. **Every declared slot is placed** somewhere inside the root, or the library fails `sinter check`.
6. **Fills do not reach into slot content** the caller passes to the root.
7. **In a component that declares slots, or contains a tree placement, ``<sn-component use>`` takes
   the convention or the map form**, whose candidates are the components of its package that fit.
   The helper form would make every component a candidate and the expansion unknown, so it is an
   error there, found by the library's own check.

Inner uses get no slot content from reach-through, so `SN314` stays as it is for recursive uses. An
inner use that passes direct content for a name it does not declare is `SN314` too.

#### What a fill may contain

A fill is compiled once, keyed by its source location, in the caller's scope: it reads the caller's
state, `data-sn-let` names, loop variables and props as any markup there does. At run time, the
tree's rows chain to the scope of the row where the root is used (`Object.create`, as today), so the
fill's reads resolve through that chain; only `$slot` and the choice of the fill travel down the tree
as props.

- So a fill may read, write state (also state declared in the caller's row), call store functions on
  caller rows with their provenance, and use `$el`, `$event` and `emit()` as the caller's markup
  does. `emit()` names are checked against the component whose markup the fill is.
- A change to state a fill reads renders the fills that read it, not every level of the tree.
- This needs the runtime names of the tree's own loop variables and state to be unique, so that no
  library name shadows a caller's on the chain. Today's renaming is partial; step 5 completes it.

#### How it compiles

Each fill is a template of its own. A placement is a choice anchor ([1](#three-kinds-of-anchor))
between its default and the fill the root's use passed down, so the library's definitions are
compiled once, whatever the fills. A fill's template is keyed by its source location (the same text
in two loops is two templates, each with its own resolved names and types) and the use's
`data-sn-early` mode. `data-sn-early="off"` on a root use applies to its fills as well: unlike plain
slot content, fills are templates the tree instantiates.

#### App-wide looks and wrappers

There is no shadowing. An app that wants its own links everywhere writes one wrapper:

```html
<!-- src/components/app-markdown.html: its root is the <md-doc> tag -->
<template data-sn-component="{ doc?: Root; code: Slot<{ node: Code }> }">
  <md-doc data-sn-prop="{ doc }">
    <a slot="link" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a>
    <slot name="code" slot="code" data-sn-prop="{ node: $slot.node }"></slot>
  </md-doc>
</template>
```

- Pages use `app-markdown`; a page's `class` on it lands on `md-doc`'s root. The override is written
  down in one place and reaches the library only through what the root declares.
- `<slot>` inside the link's fill is the link's children. `<slot name="code" slot="code">` is itself
  the fill of `code`, so it is `app-markdown`'s own `code` slot: a page's fill for `code` forwards to
  `md-doc`, with the data passed on and the children too. Left unfilled by the page, it shows its
  children, so a wrapper can give a default fill.
- The app names library types by re-exporting them from `src/sinter.types.ts`
  (`export type { Root } from '@acme/markdown'`).

### 5. Constant trees are unrolled

Folding a parsed document into HTML needs the unrolling of constants to go further than today. Most
of this is useful on its own, for nested constant data in any page.

1. **A constant pre-pass.** Before the layout is computed, the values of the bindings that are
   constant are written into the unrolled markup, and their `data-sn-*` attributes removed. Which
   bindings are constant is known only after the walk, which sees every write (handlers, models,
   `then`, scripts, persisted state), so this uses the two passes `decided` and `unrolled` already
   use: the first pass records each binding it drops as constant, by site, with its value; the
   second writes them before the layout. The second pass runs only on a page where a fold reaches
   the layout or images (a constant binding on an `<img>`, a constant class or style), or with
   `decided` and `unrolled` when it runs anyway. Item 4's worklist later replaces the passes. The order after it is
   unchanged: the layout, reserved space and images, then the walk, which reads the layout for bound
   images. A folded `<img>` then becomes a `<picture>` with `srcset`, `width` and `height`, and is
   checked like an image written in the page (`SN513` included); a folded class counts for `sizes`.
   Image analysis is already async with a recompile; that stays.
2. **Nested constant loops.** A row that contains a template is unrolled when that template is
   itself over constants, at any depth.
3. **Decisions per instance.** A `data-sn-if` that reads the row, and a choice over a constant value,
   are decided per unrolled copy. Keys become instance paths: the template's file and offset, the
   component chain, and the item index at each level. Literal props already decide per use; this
   extends it to rows.
4. **A worklist, not passes.** Expansion continues within one compile until nothing more is decided.
   Today each further level would cost one more full compile (`compilePasses`), also in the LSP.
5. **Shared definitions over constants.** A recursion point instantiated over constant props is
   expanded at build time like a nested loop, and a definition leaves the page when nothing else
   instantiates it. Fill templates ([4](#how-it-compiles)) expand the same way.

The conditions on rows stay as they are, at every level: bindings of kind `text`, `attr`, `class`,
`style` or `show` that read only the row and fixed state, no state of their own, and a page with no
errors but `SN322`, with one exception:

6. **Nodes with a handler.** A node whose only run-time need is a handler that reads constants and
   its own `$el` (a copy button on a code block) does not stop unrolling. It stays in the unrolled
   HTML as an element with its handler, which the page module adopts as it adopts any root element
   with a handler; the rest of the tree is plain HTML. A node with state, a model, a nested template
   or a handler that reads anything else still keeps its tree for the runtime.

The expansion limit is per page, reported at the use that crosses it, beside the 1,000 items per
list: what it bounds (the layout and images) runs over the whole document. Its value comes from
build times measured in step 9; over it, the tree is left to the runtime with a warning.

### 6. Helpers over constants run at build time

A helper call in a binding or a state initializer, whose arguments are all build-time constants, is
run by the compiler, and its result joins the constants. Messages already run at build time this
way. There is no marker; what may fold is decided from the code.

- **Where.** In the positions the evaluator considers: bindings and state initializers. Never in
  handlers, actions or `then`.
- **What may fold.** A helper folds when the code it can reach uses only the globals ECMAScript
  defines (`Object`, `Array`, `Math` but not `Math.random`, `JSON`, `Map`, `RegExp` and the rest),
  and not `Date`, `Intl`, the members `toLocale*` and `localeCompare`, or `innerHTML`, `outerHTML`
  and `insertAdjacentHTML`. It is an allowlist: `globalThis`, `self`, `process`, `import.meta.env`,
  `fetch`, timers and every browser name stop a helper from folding without being listed.
- **Per function.** Reachability is followed per exported function, through the functions it calls
  and the modules it imports; a module's top-level code counts for every function in it. One date
  formatter in `sinter.helpers.ts` does not stop the other helpers from folding.
- **Conditions.** The walk follows imports into packages, resolved with production conditions, the
  same in dev and in the build, so `SN322` does not differ between them. A local variable named like
  a global (`location`) does not count.
- A helper that cannot fold stays in the browser, with no warning: that is what it is for.
- **The result** must be plain data (JSON values). A call that throws, or returns anything else, is
  left to the browser, with a dev warning at the call, once.
- **Loading.** `compile()` stays synchronous: the helpers module is loaded before compiling and
  passed in. The build loads it with Vite's module runner and the app's Vite config (aliases and
  plugins apply; `sinter render`'s private server, with `configFile: false`, does not do that).
  `sinter check` and `sinter lsp` load it the same way, so what folds, and so `SN322`, agrees with
  the build; the LSP reloads it when its files change. A module that fails to load in Node folds
  nothing, with one warning. Testing's `render()` and `firstPaint()` already take `helpers`.
- **Why a call did not fold.** On a `static` page, `SN322` names the call that keeps it from folding
  and the reason (a name outside the allowlist and where it is reached, a throw, a result that is not
  plain data).
- **Purity is still trusted.** Dev builds run each folded call twice and warn when the results
  differ.
- **Where a folded result goes.** Written into the HTML where it is a binding's value. Where
  something that runs in the browser still reads it (a tree that is not unrolled), it is written
  once as embedded data and read from there, not inlined into the early file and the page module
  both.
- **Trust.** The helpers module and the packages it re-exports already run in the app; now they also
  run in Node, in builds, the dev server, `sinter check` and the LSP, as Vite plugins and the app's
  config do. A compiler hook was rejected for a different reason
  ([Alternatives](#alternatives-considered)): its output is markup the checker and the editor cannot
  follow. A helper's output is data with a type.

### 7. Files: the `file:` source

`file` is a second built-in name in the `src` grammar, beside `site`, read at build time with or
without `sinter({ apis })`.

```html
<sn-resource name="post" src="file:./post.md"></sn-resource>
```

- `file` becomes a reserved API name (`SN329`), as `site` is.
- The path is a literal. A relative path resolves against the file that wrote it (a page, a layout
  or a component); `file:/content/post.md` resolves against the project root. It must stay inside
  the project root. An interpolation (`{…}`) is an error: pages per file are
  [not in this proposal](#not-in-this-proposal). A missing file is a build error.
- `file:` on `<sn-sync>`, a stream or an action is an error.
- The value is the file's text, or for `.json` its parsed value, as response bodies are read today.
  `name`, `type` and, for JSON, `items` and `key` apply.
- It is a constant: nothing can write it. The evaluator gains file resources beside state, so
  bindings over it fold, and so do helpers called over it ([6](#6-helpers-over-constants-run-at-build-time)).
- Whatever does not fold reaches the browser as embedded data, written into the head as any
  placeholder is, so the first frame has it with no request. It is not in the `embed` manifest:
  nothing for a server to fill.
- There is nothing to load or change. `$meta.post` is constant: `loading` false, `error`, `loadedAt`
  and the rest null. `refresh`, `cache`, `paginate`, `each`, `call`, `when`, `then`, `early`, sync
  events, store functions and write-through on it are errors.
- The file is one of the page's dependencies (`CompileResult.files`), so the dev server reloads the
  page when it changes.

Relative URLs inside a file's text are the parser's to resolve. A markdown file's images are next to
it in the repo, but the component that renders them is in the library, and the image pipeline
resolves a relative `src` against the file that wrote the element. So the parser takes a base, a
path from the project root, and writes root paths: `md.parse(post, { base: '/content/posts/' })`
turns `./diagram.png` into `/content/posts/diagram.png`. A folded `<img>` goes through the image
pipeline, which resolves it against the project root and writes the built URL, also under Vite's
`base`. For markdown from an API nothing is rewritten. A link to another markdown file
(`./other.md`) stays as written.

### 8. Lets over helpers

Markdown from an API has to be parsed in the browser. `data-sn-let` is where a page names a value
computed from data, so the parse goes there, with two rules.

```html
<template data-sn-for="c in comments" data-sn-key="c.id">
  <article data-sn-let="{ doc: md.parse(c.body, { headings: 'strong' }) }">
    <md-doc data-sn-prop="{ doc }"></md-doc>
  </article>
</template>
```

#### A let over a helper is cached

Measured in step 1: with today's inlined lets, `md.parse` runs once per read of `doc` (the prop
and the list both read it), so 4 times when the article loads and 100 times for 50 comments, and the
parse is about half the time from the response to the rendered article (188 of 363 ms).

A let entry whose expression calls a helper at its top level (not inside an arrow function) is
computed once per scope instance and kept until one of its dependencies changes, as tracked for any
binding. When they change, it is computed again, unless every argument of the call is a primitive,
or an object literal of primitives, equal to the last call's. So `md.parse(c.body, { headings:
'strong' })` parses once per body, and `visible(tasks, q)` after `tasks.push(…)` is computed again,
since `tasks` is the same object with new contents. A let without a helper call stays inlined, as
today.

- Lets that read `$el` or `$index` are cached per instance like any other.
- A handler, or an `<sn-sync>` mapping, that reads the let gets the cached value.
- The early script caches the same way, in its own copy; the page module computes the let again at
  takeover, as it computes all state again today ([Limits](#limits)).
- attributes.md's "computed where they are read" changes to say so.

#### A let may wait for a lazy helper module

A helper module that reaches a lazy package is loaded whole, when first needed, as a component
script that imports one is ([lazy.md](../lazy.md#component-scripts)). The lazy transform does not
turn its functions into promises: once loaded, they are synchronous.

- A let that calls a member of such a module is `undefined` until the module has arrived, and
  `sinter check` types it `T | undefined`. The module's arrival is one more dependency: it renders
  what reads the let. A page shows something else meanwhile with `data-sn-if` on the let, or `??`;
  a let has no `$meta`. An app that needs loading and error states uses `<sn-resource call>`.
- If the module fails to load, the let stays `undefined` and the failure takes the unhandled-error
  path (`onError`), once.
- A component prop is a let, so `data-sn-prop="{ doc: md.parse(x) }"` is the same.
- Anywhere else (a binding, a handler, a state initializer), calling a member of such a module is
  `SN324`, with the hint to name it in a `data-sn-let`. The rule is per module: a library keeps the
  helpers that only read a tree (`md.headings`, `md.text`) in a module that does not import the
  parser, and they stay ordinary helpers. For that, the page module imports each member from the
  module that declares it, as the early file already does; today it imports namespace members from
  the namespace's module.
- Only the app's `lazy` option makes a package lazy. A library cannot: it would change types and
  make the app's call sites `SN324`.
- The module loads when the first scope with such a let is created. A page whose main content is
  markdown from an API adds `data-sn-preload` to start it with the page, as lazy.md advises: measure
  first.
- A let that waits is not early. The rest of the item (a comment's author and date) still renders
  early with embedded data.
- An app that leaves the parser out of `lazy` gets a synchronous helper: the let is early over
  embedded data, and the parser is in both the early file and the page module. Step 1 measured what
  that costs, and it is a loss:
  - the early file is 39.2 kB gzip (plus 2.8 kB shared) against the 10,000-byte `earlyBudget`,
    against 4.0 kB for the same article sent as a tree;
  - it parses twice before the first paint (FCP 520 ms against 32 ms);
  - the page module adopts the 2,831 early elements, then evaluates the let again, gets new objects,
    and replaces every row of the unkeyed lists, which are matched by item identity: LCP 1,164 ms
    with embedded data against 424 ms fetched.
  So a parser does not belong in the early file, and handing cached lets from the early script to
  the page module is not needed. Markdown from an API is in the first frame only when the API sends
  the tree (LCP 264 ms in step 1).
- **The takeover keeps what the early script rendered.** The last point is general: any early let
  whose helper returns new objects makes the takeover replace the unkeyed rows built over them,
  though a pure helper returns the same contents. At takeover, the rows of an unkeyed list are
  adopted by position, against the early script's rows, rather than matched by identity; after the
  takeover, lists behave as today. The takeover then changes nothing, which the `firstPaint` then
  `render` tests already require.
- A draft in state is a let like any other: `data-sn-let="{ preview: md.parse(draft) }"` is a live
  preview, cached until the draft changes.
- Two views of one item parse it twice, once in each scope.

An app can render a single article from an API today with `<sn-resource call>`: an action function
that imports the parser lazily, with `$meta.<name>.loading` while it loads. It cannot do a list
(`call` does not combine with `each`), it is not early, and it calls action functions, not helpers
([Alternatives](#alternatives-considered)).

### 9. Libraries ship source

A library ships source: component `.html` files, their scripts, helper modules and types. The app's
sinter compiles them as it compiles the app's own components, which is the only way a library gets
the app's build-time constants, early script, embedded data, type checks and scoped styles.
Precompiled output would lose all of them. Svelte libraries ship `.svelte` files for the same
reason. This step comes late in the [Plan](#plan), once the sections above have fixed the source
format.

- **Named in the config**, as `lazy` names packages: `sinter({ components: ['@acme/markdown'] })`.
- **An app-shaped folder.** The package's `package.json` has `"sinter": "./sinter"`, a folder laid
  out like an app's `src/`: `components/`, `sinter.helpers.ts`, `sinter.types.ts`. Components in
  `components/internal/` are internal; the others are public. A subfolder is new: the app's
  `src/components/` stays flat.
- **A prefix per package.** A package's component names share their first segment (`md-doc`,
  `md-link`: `md`), and the package owns it. Two packages with one prefix fail the build, and so does
  an app component whose first segment is a configured package's. There is no shadowing.
- **Public and internal.** The app using an internal component is an error that names the public
  ones. `ComponentName` holds the app's components and the public ones; each package gets its own
  union, internal components included, for the `use` in its markup.
- **Helpers are a namespace**, the one way the app uses them: `export * as md from '@acme/markdown'`
  in `src/sinter.helpers.ts`. A re-export from a configured package is followed like a relative one.
- A library's props, slot data and helper results resolve type names against the library's types
  module, not the app's `sinter.types.ts`.
- Component scripts work as in the app: the generated base class and the `*/name.html` declarations
  cover library components, and `sinter render` finds their scripts.
- **Files.** Paths in configured packages are read even when their real path is outside the project
  root (a workspace link): today `readFile` refuses those. In dev, configured packages are left out
  of Vite's dependency pre-bundling and watched. The lazy transform covers their modules.
- **Styles.** A library's scoped styles go into `@layer sinter-lib`, wrapping their `@scope` blocks.
  sinter declares that layer first in the page's stylesheet, so unlayered app CSS and the app's own
  layers win; an app can place it among its layers by declaring the order itself.
- Diagnostics in library files name the file in the package, then where the app uses it:
  `@acme/markdown/sinter/components/internal/md-table.html:4 … used at src/pages/post.html:12`.
- **The library author's checks.** A library has no pages, and `sinter check` checks a component
  through the pages that use it. A library keeps fixture pages beside its folder that use its public
  components with the cases it supports; `sinter check` in the library's repository compiles those,
  and rules 5 and 7 of [tree slots](#the-rules) are checked there and in the app's build.
- **Versions.** A library declares the sinter versions it supports as a `peerDependency`; the app's
  sinter checks the range. It cannot know which version introduced a feature newer than itself.

## The markdown library

### 10. Parse options: what content may contain

Markdown written by users and markdown written by the team need different rules: a comment must not
add an `<h1>` to the page, may not embed images, and must not carry raw HTML. Those rules are options
of the parser, not slots that render nothing:

```html
data-sn-let="{ doc: md.parse(c.body, { headings: 'strong', images: 'link', html: 'text' }) }"
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
  `javascript:` and other unsafe URLs, at run time, early and when folded, without the parser's help.
- An image from user content is a plain `<img>`: the library's image component does not use a
  resizing service unless the app's fill does.

### 11. The library

- **Two helper modules, one namespace.** `md.parse(source, options)` returns an mdast tree
  (CommonMark, and GFM tables, task lists, strikethrough and autolinks), typed as a discriminated
  union; `options.base` turns relative URLs into root paths. `md.headings(doc)` (a table of
  contents) and `md.text(doc)` (a description, a reading time) read a tree and live in a module that
  does not import the parser.
- **The parser is one prebundled module**, built by the library with production, non-browser
  conditions. A library cannot control how the app's Vite resolves a transitive dependency's
  `browser` or `development` condition, and micromark's decoder of named character references has a
  browser build that decodes through `innerHTML`, which throws under sinter's
  `require-trusted-types-for 'script'`. Prebundled, the parser behaves the same under Trusted Types
  in every app, and the static check of [6](#6-helpers-over-constants-run-at-build-time) sees one
  module graph. Step 1 confirmed it: Vite resolves `decode-named-character-reference` through its
  `browser` condition to the build that decodes with `innerHTML`, and every parse that meets an
  entity throws under Trusted Types: a single let renders nothing, and in a list of 50 comments 19
  rows rendered an empty body while the page went on, with only a console error per row. The safe
  decoder renders `Fish &amp; chips` and costs its entity table: the parser is 35.2 kB gzip with it
  against 23.1 kB with the DOM build. micromark's `development` condition bundles `debug` into
  `vite dev` (it reads `window`, `navigator` and `localStorage`, guarded); the production build has
  none of it, and the prebundled parser removes the difference. The library has a browser test with
  entities under Trusted Types, in the harness of [Testing](#testing).
- **One function in three places.** Over a `file:` resource, the compiler runs it. In a let over API
  data, it loads on demand when the app lists the parser in `lazy`, or with the page when it does not.
- **Public components**: `md-doc` (block content) and `md-inline` (one line: a title, a table
  cell). `md-doc` uses `md-inline` for phrasing content, which rule 4 of [tree slots](#the-rules)
  covers. One internal component per node type. Both have a plain root (`<div class="md">`) and take
  `doc` as optional, rendering their content only when it is there: a let that waits leaves the
  element in place, so the tag may carry an `id`.
- **Roots.** A heading's root is an `if` chain over its depth, a list's over `ordered`, and a node a
  caller can change has its slot as its root. Block and inline nodes are dispatched by choice
  anchors; text runs are `<template data-sn-text>` in the children loop. `## Hello *world*` renders
  as `<h2>Hello <em>world</em></h2>`, plus the anchor comments of what renders at run time.
- **Declared slots** on both roots, for the nodes an app is likely to change: `heading`, `link`,
  `image`, `code`, `inlineCode`, `blockquote`, `table`. Adding one later is additive.
- **What sinter does for it:** internal links prefetch; local images from the repo are optimized;
  headings get ids from their text, so `md.headings` and the anchors agree; a code block's fill can
  highlight at build time with a helper over the constant code.
- Where it lives (this repository, a package beside `create`, or its own repository) is decided at
  the last step.

## Breaking changes

All of them go into the CHANGELOG under the pre-1.0 policy.

- **The DOM shape of every list and branch.** `<template>` elements leave the body: an `if`, a `for`,
  a recursion point and a choice are marked by comments, and their templates are in the head. So:
  - `:first-child`, `:only-child` and `:last-child` now match the first or only row, and
    `:nth-child` parity flips (the template was child 1): zebra striping changes;
  - `* + *` no longer matches the first row, and `ul:empty` matches an empty list;
  - `.children[n]`, `firstElementChild` and `childNodes` indexes shift in tests and scripts;
  - CSS, tests or scripts that select the templates in the body (`template[data-sn]`) find nothing;
  - in this repository, `.page-item:first-child .page-link` (`examples/realworld/src/styles.css`)
    starts matching over the pager's rows (`conduit-pager.html`).
- **An author's comment that starts with `sn`** is an error.
- **`$el` in an `if` or `for` expression** is an error: the anchor is a comment.
- **The helpers module runs in Node**, in builds, the dev server, `sinter check` and the LSP. Its
  side effects at load run there; a module that cannot load there folds nothing and warns.
- **Helpers over constants fold.** A binding over one is written into the HTML, and state
  initialized by one becomes a constant: bindings over it leave the early script, and a page can
  become static. A helper that breaks the purity contract while using only allowed globals gets its
  result baked in; the dev check warns where two runs differ.
- **Every let over a helper is cached**, which changes when the helper runs and what is kept in
  memory, for every app that has one. A helper that breaks the purity contract no longer gives a new
  value at every read.
- **A `<slot>` that no component or fill encloses** is an error; today it is left in the HTML.
- **`file` is a reserved API name.** An app with an API named `file` renames it.
- **`Slot` is a reserved type name** in component declarations.
- **The tag's attributes on a recursion point** now reach the root, where they were dropped.
- **An app component whose first segment equals a configured package's prefix** fails the build,
  once that package is configured.

Relaxed, not breaking: `SN312` counts only placements that can render together, a slot that passes
data may be placed more than once, and a component's root need not be one plain element. New
warnings, not errors: a literal `id` in repeated markup.

## Limits

- A constant tree with a node that needs more at run time than a handler over constants (state, a
  model, a handler that reads data) is not unrolled in the first version.
- Markdown from an API as a string is not in the first frame: a parser in the early file is four
  times the early budget and made LCP worse in step 1. Reserved space covers only paginated lists,
  so a body that renders late shifts the layout. An API that sends the tree avoids both.
- A placement gives a fill only its default slot; a fill cannot receive named parts.
- A stream that appends to a let's source parses the whole body again for each chunk: in step 1,
  47 ms for the first 2,000 characters and 336 ms for the last, so quadratic over the stream.
- Links between markdown files stay as written, and a relative link to a repo file is not emitted as
  an asset. A run-time image under a root path needs to be in `publicDir`.
- A root that is not a plain element is replaced when its condition changes, and focus on it is
  lost. Components with a script, or with state on their root, keep a plain root.
- `<sn-component>` takes no attributes but `use`, `data-sn-prop` and `data-sn-early`.
- An HTML minifier or CDN optimizer that strips comments breaks takeover: anchors and text
  separators are comments. The dev warnings for missing anchors show it; such stripping has to be
  turned off for sinter's pages.
- Browser translation and extensions that rewrite text: a replaced bound text node is found again
  from its marker, but one that is removed with its marker is not.

## Diagnostics

"new" marks a code numbered when implemented. Existing codes keep their meaning and gain cases.

| Situation | Code |
| --- | --- |
| An author's comment that starts with `sn` | new |
| `$el` in an `if`, `for` or choice expression | new |
| An anchor or `<template data-sn-text>` inside `<textarea>` or `<title>` | new |
| A missing, duplicate or unpaired anchor comment at mount | dev warning, as for a missing `data-sn` element |
| A fill for a slot the component or root does not declare; direct content for a name an inner use does not declare | `SN314`, with the declared names |
| A `Slot<T>` member passed through `data-sn-prop` | `SN313` |
| `Slot<T>` in a type alias, with `?`, in a head or layout declaration, or an app type named `Slot` | new |
| A placement's `data-sn-prop` does not fit `T` | new |
| A tree placement with no enclosing root that declares it; one whose name is close to a declared slot | new |
| A declared slot is placed nowhere inside the root | new, in the library's check and the app's build |
| A placement whose default's element declares names its children read | new |
| A `<slot>` in a fill whose placement's default renders no element | new |
| Two placements of one name that can render together, or two unnamed `<slot>`s in one fill | `SN312` |
| A `<slot>` that no component or fill encloses | new |
| A literal `id` in markup that renders more than once | new warning |
| The helper form of `<sn-component use>` in a component that declares slots or has a tree placement | new |
| A root that can render more than one element, or text | new |
| A component with a script or root state whose root is not a plain element | new |
| One attribute on a tag and on the fill that becomes its root | new, at the tag, naming the fill |
| `id`, `data-sn-model`, an action or `data-sn-transition` on the tag of a component whose root may render nothing | new |
| `data-sn-text` with `data-sn-if` or `data-sn-for` on one `<template>` | new |
| A helper call that throws at build time or returns something that is not plain data | dev warning, at the call |
| A call that keeps a `static` page from folding, with the reason | `SN322` |
| The helpers module could not be loaded at build time | warning, once |
| A page over the expansion limit | warning, at the use that crosses it |
| An API named `file` | `SN329` |
| A `file:` source with an interpolation, outside the project root, or missing; `file:` outside `<sn-resource src>` | new |
| An attribute or store function on a `file:` resource that needs loading or writing | new |
| A member of a helper module that reaches a lazy package, called outside a `data-sn-let` or prop | `SN324`, with the hint |
| A lazy helper module that fails to load | the unhandled-error path |
| A configured package without a `"sinter"` folder, or without `components/` | new |
| Two packages, or a package and the app, own the same prefix | new |
| The app uses an internal library component | new |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A token stream (markdown-it's open and close tokens) | Markdown is a tree, and so are sinter templates; the renderer would rebuild the nesting |
| A component map passed down the tree (`{ link: 'ugc-link' }`; react-markdown and MDX do this) | A map can be an expression, so the compiler knows less, and every node component has to pass it on. Slots keep the override in markup the compiler reads |
| Shadowing (an app file named like a library component replaces it) | Silent, global, and makes every internal name public API. One wrapper with fills does the same, visibly |
| Inner components declare their own fillable slots | The contract would spread over every file of the library |
| Keeping template anchors, with roots that leave none (third revision) | A rendered tree keeps a template beside every node anyway, so markdown from an API would style differently from the same markdown from the repo, and a root that renders nothing leaves a keyed row without a first node |
| One anchor per candidate of `<sn-component use>` (today) | Two comments and one evaluation per candidate per node; a choice anchor is one pair and one evaluation |
| A new handoff entry keyed by anchor id (fourth revision) | An anchor inside a row exists once per row; the property on the start comment is per node, as today |
| Copying the library's definitions per set of fills (third revision) | Every definition the root reaches is duplicated; a choice anchor between default and fill copies nothing |
| Hidden inputs threaded through the tree (fourth revision) | Any state a fill reads would re-render every level of the tree, and a fill could not write a caller row's state; the scope chain already reaches the caller |
| One `data-sn-c` list for a component tag as root (fourth revision) | The element would be both the `@scope` root and its limit, so the outer component's rules would reach the inner one's markup |
| Caching a let by argument identity (fourth revision) | Stale after a change in place, which sinter supports |
| A denylist of globals, per module (fourth revision) | It cannot be complete (`globalThis`, `process`, `import.meta.env`), and one date formatter would stop every helper in the file from folding |
| A `data-sn-slots` attribute (first revision) | A third declaration beside props and events; `Slot<T>` in the props type keeps two |
| `data-sn-let` on `<slot>` (the components proposal's sketch, second revision) | Lets take no shorthand and may not repeat a prop's name, and the fill reads `$slot.x`, not the bare name. `data-sn-prop` already means "values for what renders inside" |
| A marker on tree placements (`data-sn-tree`, first revision) | A placement of a name the component does not declare is already explicit |
| `<sn-children>` (first revision) | A new element for what a `<slot>` inside a fill means under the nearest-markup rule |
| An empty fill gets the default's children (second revision) | Invisible in the markup, changes existing empty fills, and cannot place children beside other content |
| A `pure()` marker on helpers (first revision) | What may fold can be read from the code; a marker would be one more thing to keep in step |
| `$file()` (first revision), or `./` in `src` as a file (second revision) | `$file()` is a function among magic names that are values; `./` would make `post.md` and `./post.md` mean different things, and conflicts with `apis` |
| `$meta.<name>.url` as a base (second revision) | Not known early, a path for files but a URL for APIs, and only files need a base; the parser takes one |
| Derived fields on resources (first revision) | A new attribute for what `data-sn-let` names; a let also covers drafts in state |
| `<sn-resource call>` for markdown from an API | What lazy.md recommends, and enough for one article, but it does not combine with `each`, is not early, and calls action functions, not the helpers a page folds |
| A library that declares its parser lazy | `lazy` changes types and makes call sites `SN324`; a library switching it would break app builds |
| `$meta` for a let that waits | A let with a status would be a second kind of resource; `<sn-resource call>` is that already |
| Bindings that wait for a lazy package | Every binding would need a pending state. Only lets wait, and they read as `undefined` |
| A dynamic tag (`data-sn-tag`) | A new attribute that covers only the choice of tag, not a slot or a component as the root, nor text |
| Components without a root (fragments) | A tag whose component has several top-level nodes could take no `class` or handlers, and a component edited from one root to two would break its callers |
| A compiler hook a library registers for its tag | Its output is markup that `sinter check` and the editor cannot follow |
| HTML from the parser, inserted through the Sanitizer API | Loses per-node looks, conflicts with markup from the network staying inert, and is not in every browser sinter supports |

## Not in this proposal

- Pages from a folder of markdown files (a blog: one page per post, an index of them, links between
  them). It builds on `file:` and helpers at build time, and needs its own design for page paths and
  interpolated `file:` sources.
- Named parts a placement gives its fill.
- Testing in a component whether a slot is filled; additive later, as a per-use constant like a
  left-out prop.
- Parsing in a worker.
- Using sinter components outside sinter: unchanged, still deferred.

## Testing

- Compiler tests in `test/` for each step: anchors, choices, slots, fills and their `<slot>`s,
  roots, text nodes, reach-through and fill templates, folding and unrolling, `file:`, lets,
  packages. Each diagnostic has a test. Layout and reserved-space goldens are updated for the new
  anchors.
- **A browser test harness that enforces Trusted Types.** `docs/security.md` says the browser suite
  runs with Trusted Types enforced and a strict CSP, but no test sets `require-trusted-types-for`,
  and the only CSP in a browser test is `script-src 'self'` (`e2e/navigation/index.html`). Step 2
  adds one: pages served with `script-src 'self'; style-src 'self'; require-trusted-types-for
  'script'`, failing on any violation report, as step 1's pages already run. The docs' claim was
  corrected in #48.
- Browser tests for the runtime parts, in that harness: anchors in
  lists, branches, choices, trees and keyed reorders (including rows whose content renders nothing);
  anchors in tables, `<select>`, SVG and dialogs; fills in rows; fill templates instantiated by the
  runtime and the early script; roots replaced when their condition changes; cached and waiting lets;
  a lazy helper module and its failure; the dev warning for stripped comments.
- First paint and takeover, with the takeover changing nothing (the existing `firstPaint` then
  `render` pattern): anchors found by the early script and the page module, an early render that
  failed and is cleared, roots decided at build time, early and at mount, and text nodes side by
  side, empty, and in row templates. The testing module's whole-document path (`writePage`) with
  templates in the head.
- Tests with tables run on jsdom: happy-dom mis-parses `<tr>` and `<td>` inside a template, today and
  after this change.
- The testing module's `render()` and `firstPaint()` take fills, `file:` resources (through
  `files`) and the helpers that fold.
- A library's fixture pages are checked by `sinter check`, and the markdown library's are tested in
  the browser, with entities under Trusted Types.

## Docs

Each step updates `spec.md` (Reserved space, HTML rewrite and the early script for anchors),
`attributes.md`, `components.md` (and `lazy.md`, `resources.md`, `apis.md`, `configuration.md` where
it touches them), `llms.txt`, the compiler's vocabulary, the editor data (`html-custom-data.json`),
the examples whose CSS or tests depend on the old DOM, and the LSP: hover on `$slot` and on a
`<slot>` says what fills it, and completion offers a root's declared slots on a fill. The markdown
library gets its own page and a recipe.

## Plan

1. **Done: a spike in userland, measuring only** (`examples/markdown/` on branch
   `ccr-ec5fd4e0-bp4vko`, with its write-up, raw results and a list of what it contradicted here). Its numbers are in the sections they
   bear on. It needed the two fixes listed under bugs above, which go into a pull request of their
   own. As planned: in an example app, `md.parse` as an ordinary helper over
   mdast, loaded with the page; about fifteen recursive `md-*` components dispatched with
   `<sn-component use>`; an article and a comment list from the API, under Trusted Types. Confirm
   the parser's export maps and which builds touch the DOM. Measure, in `bench/`:
   - render time and binding count for a long article;
   - the DOM it produces: wrappers, templates and comments per node, and the anchors per node with
     fifteen candidates;
   - the page and early files with embedded data against `earlyBudget`, the parse at takeover, and
     the article's LCP with the parser lazy and with the page;
   - re-parse cost per render, since lets are inlined today, and per streamed chunk;
   - the cost of a walk over elements and comments at mount on a page of 20,000 nodes.
   It cannot try fills, which need the compiler.
2. **Anchors as comments** (section 1): the three kinds of anchor, the choice among them; templates
   in the head (or at the end of the body when nothing early uses them); ids and the IR change for
   `else`; shared definitions as head templates, with `data-sn-def` and `defs.ts` removed; finding
   anchors at mount and early; the handoff on the start comment; keyed lists; the layout model and
   reserved space; foreign content; the early renderer's templates in a table; the Trusted Types
   test harness; the dev warnings; spec.md, the goldens and the examples. Useful on its own: prose
   CSS over any list, and the SVG crash fixed. The js-framework-benchmark, the live grids and the
   bytes before the body in `bench/first-paint` must not regress.
3. **Slots that pass data** (section 2): `Slot<T>`, `data-sn-prop` on `<slot>`, `$slot`, a slot per
   branch, a fill's `<slot>` by the nearest-markup rule, literal ids in repeated markup, with a data
   table and a list with custom rows as tests.
4. **The component root and text nodes** (section 3): roots that render at most one element, the
   tag's attributes on them and on shared definitions (which fixes the dropped attributes), the
   root marker for scoped styles, `<template data-sn-text>` as a binding target with its separators.
   Useful on its own for buttons, headings and variants. Needs 2. After it, step 1's article is
   measured again against the RealWorld island (LCP 188 ms, 120 ms to render).
5. **Tree slots** (section 4) among app components: tree placements, roots and boundaries, fill
   templates chosen by choice anchors, fills compiled in the caller's scope and read through the
   scope chain, with unique runtime names. Measures the re-render of a 3,000-node tree when state a
   fill reads changes. The package rules are tested in step 11. Needs 3 and 4.
6. **The constant pre-pass** (section 5, item 1): constants written before layout and images.
   Useful for any page whose constant images or classes come from bindings.
7. **Nested constant loops, decisions per instance and the worklist** (section 5, items 2 to 4).
   Measures build time against nesting depth, in the build and the LSP.
8. **Helpers over constants and `file:`** (sections 6 and 7): the module runner with the app's
   config, in the build, `sinter check` and the LSP; the allowlist check per function, run against
   the markdown parser's real module graph under dev and build.
9. **Constant trees** (section 5, items 5 and 6), fill templates included: a docs page from a `.md`
   file ships no JavaScript, with its images optimized, and one whose code blocks have a copy button
   ships only that handler. A test in `test/` and the `static-site` example.
   Sets the expansion limit. Needs 5, 6, 7 and 8.
10. **Lets over helpers** (section 8): cached by dependencies with equal primitive arguments, and
    waiting for a lazy helper module, with members imported from their declaring modules in the
    page module; unkeyed rows adopted by position at takeover.
11. **Libraries ship source** (section 9), once the format above is settled. The spike's components
    move into a local package with fixture pages; the package rules of step 5 and a library's lazy
    helper module from step 10 are tested here.
12. **The markdown library** (sections 10 and 11), with its prebundled parser, its docs page,
    `llms.txt`, and a recipe with an article and its comments on one page.

Steps 2, 3, 6 and 10 do not depend on each other.

## Open questions

None is left for the maintainer. Measured, then decided:

- The cost of fills read through the scope chain (step 5).
- The expansion limit's value (step 9).

## Decisions

Decided with the user while drafting:

| Question | Decision | Section |
| --- | --- | --- |
| Children inside a fill | A `<slot>` inside the fill, by the rule that a `<slot>` is filled by the nearest markup given content for it | [2](#a-slot-inside-a-fill) |
| The component root | Renders at most one element: a plain element, an `if` chain, a component tag, `<sn-component use>` or a slot; plain for scripts and root state; text through `<template data-sn-text>` | [3](#3-the-component-root) |
| Anchors | Comments in place and templates in the head, for every `if`, `for`, recursion point and choice | [1](#1-anchors-as-comments) |
| Handlers in unrolled trees | A node whose only run-time need is a handler over constants and its own `$el` stays in the unrolled HTML; the rest is plain HTML | [5](#5-constant-trees-are-unrolled) |

Settled in the fourth review, from the code and the reasoning recorded there:

| Question | Decision | Section |
| --- | --- | --- |
| Slot data | `Slot<T>` in the props type, `data-sn-prop` on `<slot>`, `$slot` | [2](#2-slots-that-pass-data) |
| One slot in several branches | Allowed within one `if`/`else` chain | [2](#one-slot-in-each-branch-of-a-chain) |
| Fills as elements or templates | Elements, as today; `<template slot>` only for a chain or a text | [2](#the-fill-slot) |
| Testing whether a slot is filled | Not in this proposal | [Not in this proposal](#not-in-this-proposal) |
| Reach-through | As proposed; the boundary is the app's components until packages exist | [4](#the-rules) |
| How fills reach the caller | Compiled in the caller's scope and read through the run-time scope chain; choice anchors select them; writes to a caller row's state work | [4](#what-a-fill-may-contain) |
| Scoped styles for a component tag as root | A root marker and root-only rules, not a shared `@scope` | [3](#scoped-styles) |
| App-wide looks | A wrapper component with fills; no shadowing | [4](#app-wide-looks-and-wrappers) |
| Constant folding | A pre-pass before images; nested loops, per-instance decisions, a worklist; then trees | [5](#5-constant-trees-are-unrolled) |
| The expansion limit's scope | Per page | [5](#5-constant-trees-are-unrolled) |
| Helpers at build time | No marker; an allowlist of ECMAScript globals, reachability per exported function, production conditions in dev and build | [6](#6-helpers-over-constants-run-at-build-time) |
| Files from the repo | `file` as a built-in name beside `site`, reserved; what does not fold becomes embedded data | [7](#7-files-the-file-source) |
| Base paths | A project-root path, for `file:` sources only; the image pipeline writes the built URL | [7](#7-files-the-file-source) |
| The let cache | Invalidated by dependencies, skipped when the arguments are equal primitives | [8](#a-let-over-a-helper-is-cached) |
| A lazy parser | Only the app's `lazy`; a let that waits has no `$meta`; a failed load takes the unhandled-error path | [8](#a-let-may-wait-for-a-lazy-helper-module) |
| How a library ships | As source, named in the config, an app-shaped folder with `components/internal/` | [9](#9-libraries-ship-source) |
| What content may contain | Parse options; raw HTML shown as text by default; `'allow'` is a fixed set | [10](#10-parse-options-what-content-may-contain) |
| The parser | One prebundled module, built with production, non-browser conditions, tested under Trusted Types | [11](#11-the-library) |

Settled by the step 1 measurements:

| Question | Decision | Section |
| --- | --- | --- |
| A parser in the early file | No: it is four times the early budget and makes LCP worse; markdown from an API is in the first frame only as a tree | [8](#a-let-may-wait-for-a-lazy-helper-module) |
| Handing cached lets from the early script | Not needed | [8](#a-let-may-wait-for-a-lazy-helper-module) |
| The takeover over an early let | Unkeyed rows are adopted by position at takeover, so the takeover changes nothing | [8](#a-let-may-wait-for-a-lazy-helper-module) |
| The cost of finding comment anchors | Negligible: 0.5 ms on 20,000 nodes | [1](#finding-anchors) |
| The early renderer's size | Templates written once into a table, not inlined per use | [1](#what-else-changes) |
| First step | A spike that measures, before any compiler change | [Plan](#plan) |
