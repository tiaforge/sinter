# Proposal: component libraries, with markdown as the first

Status: draft, third revision, after two reviews. Nothing here is implemented. Where the first
revision added new attributes and functions, this one builds on what sinter has; what is new is
listed in [What is new](#what-is-new). One question is open and decided next: how a component's root
may be written ([Open questions](#open-questions)).

Decided with the user while drafting:
- Markdown from the repo (built with the site) and markdown from an API (a string in a response)
  are the target, equally. Streaming and APIs that send a parsed tree should work too, but do not
  drive the design.
- Parsing and rendering are separate parts. The parser returns a tree, not a stream of tokens.
- How a node looks is changed with slots, not with a map of components.
- Only the root component of a library declares the slots a caller can fill. The library's
  contract stays in one file.
- A bigger feature is fine where it fits best, but existing concepts are generalized before a name
  is added.
- A fill is filled too: a `<slot>` inside a fill takes what the placement gives it, by the rule in
  [A `<slot>` inside a fill](#a-slot-inside-a-fill).

## Goals

- Markdown from the repo is plain HTML in the page, with optimized images and no JavaScript.
- Markdown from an API renders with the page's bindings, parsed once per value, with the parser
  loaded only where it is used.
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
  definition. With embedded data, the early script renders such a tree in the first frame at any
  depth. ``<sn-component use="`md-${n.type}`">`` picks a component per node; with a discriminated
  union, `sinter check` narrows the node per candidate and fails when a node type has no component.
  A markdown renderer should be possible in userland today, given a helper that parses; step 1 of
  the [Plan](#plan) checks that.
- **One root element.** A component's template has exactly one plain element at its top, not a
  `<template>`, a `<slot>` or a component (`compile.ts`, the component's root). A text binding sits
  on an element: `data-sn-text` sets an element's content. So today every link, heading and run of
  text in a rendered tree needs an element of its own.
- **Build-time constants** ([spec.md](../spec.md), Build-time constants): a binding over constants is
  written into the HTML, a `data-sn-if` over them is decided, and a `data-sn-for` over a constant
  list of up to 1,000 items is unrolled. The evaluator runs the built-in messages, and under
  `localePrefix` some formatters, but no app helpers. The limits that matter here:
  - only state fields are constants; no resource is;
  - a row is unrolled only when none of its nodes is a nested template, so a constant list inside a
    constant list is not;
  - a `data-sn-if` is decided per template, and only when it reads no row, and inside a component
    only when every use agrees;
  - unrolling is two compile passes, not a fixpoint;
  - shared definitions are never unrolled.
- **The compile order.** In one pass, loops are unrolled, then the layout is computed and images are
  rewritten, then bindings are walked, their functions compiled and constants written (`run()` in
  `compile.ts`). The evaluator runs compiled binding functions, so it can only run after the walk.
  An `<img>` with a `data-sn-*` attribute is skipped by the image pipeline, so a `src` written later
  never becomes a `<picture>`. `compile()` is synchronous.
- **Local files.** The image pipeline reads every `src` without a scheme as a file (`photo.jpg`,
  `./photo.jpg`, or `/img/x.jpg` from the project root), and leaves a missing file alone. A
  resource's `src` is a request; with `sinter({ apis })` it is `[api:]/path`, and `site:` is a
  built-in source in that grammar.
- **Embedded data**: JSON in a placeholder in the page's head (`<script type="application/json"
  data-sn-data>`), which the early script and the page module read as a resource's first value.
- **Helpers are pure by contract**: "same arguments, same result, nothing read or changed elsewhere"
  ([configuration.md](../configuration.md#helpers)). Their manifest is read statically, without
  running the module.
- **`data-sn-let`** names values computed from state, resources and loop variables. A name "is
  compiled into every expression that reads it, so it is always current, costs no runtime and is
  tracked like the expression itself" (spec.md, Derived names). A helper in a let is called again at
  every read. Entries are `name: expression`, with no shorthand, and may not reuse a name in scope
  (`SN209`). A component's props are lets internally.
- **Lazy packages** ([lazy.md](../lazy.md)): every call into the package returns a promise. A helper
  module that reaches one is `SN324`, and lazy.md names a markdown body as the case to load with the
  page instead. A component script that imports one loads with it, whole, when the component first
  renders. The lazy transform covers the app's modules, not `node_modules`. `<sn-resource call>` runs
  an async action function; it cannot be combined with `each` and is not early.
- **Slots** fill at build time by moving the caller's content into the one `<slot>` of that name
  (two of one name are `SN312`), and show their own children when left empty. A `<slot>` belongs
  to the component whose file it is written in, so one inside content passed to another component
  forwards (`<slot name="aside" slot="side">`). Slot content sees only the caller's scope. A
  recursive component's inner uses take no slot content (`SN314`), and `<sn-component>` drops it.
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
| Slot content that receives data | `<slot>`, `data-sn-prop`, magic names such as `$event` | `$slot`; `Slot<T>` in the props type |
| A fill that places the node's children | `<slot>` and the innermost-first lookup of names | a rule: a `<slot>` is filled by the nearest markup given content for it |
| Fills that reach deep into a tree | slots | a rule: a placement of a slot the component does not declare is filled by the root |
| Helpers run at build time | the purity contract, the constant evaluator, messages at build time | a rule, with a static check of what a helper may touch |
| Constant trees folded into HTML | unrolling | nested loops, decisions per instance, a fixpoint, and constants before images |
| A file from the repo | `<sn-resource src>`, the `site:` source, embedded data | the `file:` source |
| Parse once per value, with a package loaded on demand | `data-sn-let`, lazy component scripts | two rules: a let over a helper is cached; it may wait for a lazy helper module |
| Components from a package | `src/components/`, helper namespaces, the `lazy` option | `sinter({ components })`, the `"sinter"` field, `components/internal/`, `@layer sinter-lib` |

The behaviour of existing pages that changes is listed in [Breaking changes](#breaking-changes).

## Where markdown comes from

| Source | Example | Parsed | Shipped |
| --- | --- | --- | --- |
| The repo | docs, a README, page copy | by the compiler | HTML only: no parser, no bindings |
| An API, as a string | an article body, a comment | in the browser, once per value, in a `data-sn-let` | the parser (on demand) and the renderer's bindings |
| An API, as a tree | a backend that stores mdast | not at all | the renderer's bindings; first frame with embedded data |
| A stream | model output | in the browser, again on each chunk | as from an API |

Keeping parsing and rendering apart lets one library serve all four. The renderer only ever sees a
tree.

## Design

### 1. Slots that pass data

A component passes values to the content of a slot. This is useful without trees (a data table with
custom cells, a list with custom rows) and ships first.

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

#### The placement: `data-sn-prop` on a `<slot>`

`data-sn-prop` passes values to what renders inside, on a component's tag and now on a `<slot>`. It
takes shorthand and is checked against `T` as a tag's props are against the props type.

- A slot that passes data may be placed more than once (in a loop, in several `data-sn-if`
  branches): its fill is rendered at each placement, as a template. `SN312` stays for slots that
  pass nothing, whose content is moved, not copied.

#### The fill: `$slot`

- A fill is written like slot content today: the elements with `slot="<name>"`, in order. Its scope
  is the caller's scope plus `$slot`, the values the placement passes, as a handler reads `$event`.
- Inside a fill for another component, the inner `$slot` hides the outer one; keep the outer value
  with `data-sn-let="{ outer: $slot.row }"` on the outer fill.
- Provenance flows through: `$slot.row` is the row the component got from its prop, so
  `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource, as `$event.detail`
  already carries sources.
- A literal `id` in a fill that is rendered more than once is an error, as for components.
- A fill for a slot the component does not have is `SN314`, the existing unknown-slot error.

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
| the tag's children are the slot content | the children of the placement's default element are the fill's content |
| `<slot>` in the component | `<slot>` in the fill |
| props read by name | values read as `$slot.x`, since the fill also sees the caller's scope |
| an empty slot shows its children | an unfilled placement shows its default |

What a placement gives its fill, in the first version: when its default is one element, that
element's children, as the fill's default slot. Nothing named. So:

- An unnamed `<slot>` inside a fill of a slot that passes data is the node's children. They are the
  component's markup: they keep its scope and its style scope, as slot content keeps its author's.
- A named `<slot>` inside a fill finds nothing in the fill and is the enclosing component's slot, as
  today. Its content is rendered once per placement, so a literal `id` in it is an error.
- A fill of a slot that passes nothing is given nothing, so every `<slot>` inside it is the enclosing
  component's, as today. No existing page changes meaning.

```html
<!-- placement: the default is one element, whose children are what a fill's <slot> gets -->
<slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }">…the children…</a></slot>

<!-- fill: the children, then an icon -->
<a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot> ↗</a>
```

The cases at the edge:

- A component that has a default slot of its own, and an unnamed `<slot>` inside a fill of a data
  slot in its markup: the fill's meaning wins, and the build reports it as an error ("this `<slot>`
  is the children of `link`; `app-markdown`'s default slot cannot be placed inside a fill"). No
  `<slot>` silently changes meaning.
- A placement whose default is not one element (text, several elements, nothing) gives no children;
  a `<slot>` in its fill is an error that names the placement.
- A fill without a `<slot>` drops the children, as an image shown as its alt text does:
  `<span slot="image" data-sn-text="$slot.node.alt"></span>`.
- Two unnamed `<slot>`s in one fill are `SN312`, as two of one name in a component are.

### 2. Tree slots

A root's declared slot is filled at placements deep inside the root's expansion: the root's fill is
copied into the shared definitions that place it, as a specialization ([below](#how-it-compiles)).

```html
<!-- @acme/markdown: components/md-doc.html, the root -->
<template data-sn-component="{ doc: Root; link: Slot<{ node: Link }>; heading: Slot<{ node: Heading }>; code: Slot<{ node: Code }> }">
  <div class="md">…the nodes of doc.children…</div>
</template>

<!-- @acme/markdown: components/internal/md-link.html, deep inside -->
<template data-sn-component="{ node: Link }">
  <span><slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url, title: node.title }">…the children…</a></slot></span>
</template>
```

The `<span>` is there because a component's root cannot be a `<slot>` today; see
[Open questions](#open-questions).

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
   filled from outside.
2. **It is filled by the nearest enclosing root that declares the name**, within the root's package
   (or, for a root in `src/components/`, the app's components). The `Slot<T>` types must agree. A
   tree placement with no enclosing root that declares it is an error at the use that leaves it
   without one.
3. **A root written in caller markup** (a page, a fill, slot content, a component of another
   package) starts a new contract: the outer fills do not reach into it.
4. **A root used in its own package's markup** inside another root (`md-doc` rendering a table cell
   through `md-inline`) is not a boundary. The fills of slots it also declares pass into it.
5. **Every declared slot is placed** somewhere inside the root, or the library fails `sinter check`.
6. **Fills do not reach into slot content** the caller passes to the root.
7. **Inside a root whose use has fills, ``<sn-component use>`` takes the convention or the map
   form.** The candidates are the components of the root's package that fit them. The helper form
   would make every component a candidate and the expansion unknown, so it is an error there.
8. A root's slot that the use leaves unfilled uses the placements' defaults: the plain definitions,
   no specialization.

Inner uses get no slot content from reach-through, so `SN314` stays as it is for recursive uses. An
inner use that passes direct content for a name it does not declare is `SN314` too.

#### What a fill may contain

A fill is compiled into the package's shared definitions, which are compiled with an empty scope and
take only props. What it reads from the caller has to be carried in. In the first version:

- Reads of the caller's scope (state, `data-sn-let` names, loop variables, props) and `$slot`: the
  names it reads become hidden inputs of the specialization, passed through every level, through
  `<sn-component use>` points, and into the children a fill's `<slot>` places. A `data-sn-let` name
  is captured as its value, as a prop is.
- Store functions on caller rows (`patch(c, …)`): each hidden input carries the sources it has at
  the use, as definition props do (`@def:<name>:<prop>`), per specialization.
- Handlers that write page-level state. A fill that writes state declared inside a caller's row is an
  error in the first version: a write needs a reference to that row's scope, not a value.
- `$el`, `$event` and `emit()`, as in the caller's markup. `emit()` names are checked against the
  component whose markup the fill is.

#### How it compiles

A root use with fills compiles the package's shared definitions again for that set of fills: a
specialization, with its own `<template>`s in the head and its own functions. The key is the source
location of each fill (so the same text in two loops is two keys, with its own resolved names and
types), the use's `data-sn-early` mode, and whether the tree is unrolled
([4](#4-constant-trees-are-unrolled)). Each specialization costs a copy of every definition the root
reaches; the plan measures it.

`data-sn-early="off"` on a root use applies to its specialization as a whole, fills included: unlike
plain slot content, fills are compiled into the definitions.

#### App-wide looks and wrappers

There is no shadowing. An app that wants its own links everywhere writes one wrapper:

```html
<!-- src/components/app-markdown.html -->
<template data-sn-component="{ doc: Root; code: Slot<{ node: Code }> }">
  <md-doc data-sn-prop="{ doc }">
    <a slot="link" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a>
    <slot name="code" slot="code" data-sn-prop="{ node: $slot.node }"></slot>
  </md-doc>
</template>
```

- Pages use `app-markdown`. The override is written down in one place and reaches the library only
  through what the root declares.
- `<slot>` inside the link's fill is the link's children. `<slot name="code" slot="code">` is itself
  the fill of `code`, not inside one, so it is `app-markdown`'s own `code` slot: a page's fill for
  `code` forwards to `md-doc`, with the data passed on by its `data-sn-prop`. Left unfilled by the
  page, it shows its children, so a wrapper can give a default fill.
- The app names library types by re-exporting them from `src/sinter.types.ts`
  (`export type { Root } from '@acme/markdown'`).

### 3. Helpers over constants run at build time

A helper call in a binding or a state initializer, whose arguments are all build-time constants, is
run by the compiler, and its result joins the constants. Messages already run at build time this
way. There is no marker; what may fold is decided from the code.

- **Where.** In the positions the evaluator already considers: bindings and state initializers.
  Never in handlers, actions or `then`.
- **What.** The helper's module and what it imports, followed as the lazy check follows imports,
  must not touch `Date`, `Intl`, `toLocale*`, `Math.random`, `crypto`, `performance`, `navigator`,
  `location`, `document`, `window` or storage. A helper that does stays in the browser, with no
  warning: that is what it is for. The built-in formatters keep their rules.
- **The result** must be plain data (JSON values). A call that throws, or returns anything else, is
  left to the browser, with a dev warning at the call, once.
- **Loading.** `compile()` stays synchronous: the helpers module is loaded before compiling and
  passed in. The build loads it with Vite's module runner and the app's Vite config (aliases and
  plugins apply; `sinter render`'s private server, with `configFile: false`, does not do that).
  `sinter check` and `sinter lsp` load it the same way, so what folds, and so `SN322`, agrees with
  the build; the LSP reloads it when its files change. A module that fails to load (one that reads
  `location` at its top level) folds nothing, with one warning. Testing's `render()` and
  `firstPaint()` already take `helpers`.
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

### 4. Constant trees are unrolled

Folding a parsed document into HTML needs the unrolling of constants to go further than today. Most
of this is useful on its own, for nested constant data in any page.

1. **Constants before layout and images.** `run()` is reordered: the walk compiles the bindings, the
   evaluator writes the constants, and only then are the layout computed and images rewritten. A
   folded `<img>` loses its `data-sn-*` attributes, so it becomes a `<picture>` with `srcset`,
   `width` and `height`, and is checked like an image written in the page (`SN513` included); a
   folded class counts for `sizes`. Image analysis is already async with a recompile; that stays.
2. **Nested constant loops.** A row that contains a template is unrolled when that template is
   itself over constants, at any depth.
3. **Decisions per instance.** A `data-sn-if` that reads the row, and a `<sn-component use>` over a
   constant node type, are decided per unrolled copy. Keys become instance paths: the template's
   file and offset, the component chain, and the item index at each level.
4. **A fixpoint, not two passes.** Expansion repeats until nothing more is decided: today's two
   passes decide one level.
5. **Shared definitions over constants.** A recursion point instantiated over constant props is
   expanded at build time like a nested loop, and a definition leaves the page when nothing else
   instantiates it.

The conditions on rows stay as they are, at every level: bindings of kind `text`, `attr`, `class`,
`style` or `show` that read only the row and fixed state, no state of their own, and a page with no
errors but `SN322`. A tree with one subtree that needs run time (a fill with a handler, a code block
with a copy button) is not unrolled in the first version.

There is a limit on the nodes of one expansion, beyond the 1,000 items per list. It also bounds
layout and image work, which runs over the whole document. Its value comes from build times
measured when item 5 is built; over it, the tree is left to the runtime with a warning at the use.

### 5. Files: the `file:` source

`file:` is a built-in source in the `src` grammar, beside `site:`. It names a file in the project,
read at build time.

```html
<sn-resource name="post" src="file:./post.md"></sn-resource>
```

- The path is a literal. A relative path resolves against the file that wrote it (a page, a layout
  or a component); `file:/content/post.md` resolves against the project root. It must stay inside
  the project root. An interpolation (`{…}`) is an error: pages per file are
  [not in this proposal](#not-in-this-proposal). A missing file is a build error.
- The value is the file's text, or for `.json` its parsed value, as response bodies are read today.
  `name`, `type` and, for JSON, `items` and `key` apply.
- It is a constant: nothing can write it. The evaluator gains file resources beside state, so
  bindings over it fold, and so do helpers called over it ([3](#3-helpers-over-constants-run-at-build-time)).
- Whatever does not fold reaches the browser as embedded data, written into the head as any
  placeholder is, so the first frame has it with no request. It is not in the `embed` manifest:
  nothing for a server to fill.
- There is nothing to load or change. `$meta.post` is constant: `loading` false, `error`, `loadedAt`
  and the rest null. `refresh`, `cache`, `paginate`, `each`, `call`, `when`, `then`, `early`, sync
  events, store functions and write-through on it are errors.
- `file:` works with `sinter({ apis })`, since it is a source, not a path. Nothing that works today
  changes.
- The dev server reloads the page when the file changes.

Relative URLs inside a file's text are the parser's to resolve. A markdown file's images are next to
it in the repo, but the component that renders them is in the library, and the image pipeline
resolves a relative `src` against the file that wrote the element. So the parser takes a base and
writes root paths: `md.parse(post, { base: '/content/posts/' })` turns `./diagram.png` into
`/content/posts/diagram.png`, which the image pipeline resolves against the project root. A link to
another markdown file (`./other.md`) stays as written; a page for it is not in this proposal.

### 6. Lets over helpers

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

A let entry whose expression calls a helper at its top level (not inside an arrow function) is
computed once per scope instance and kept while the helper's arguments compare equal: by identity,
and for plain-data literals such as an options object, by value. A change to `comments` does not
parse every row again: each row's call compares its own `c.body`. A let without a helper call stays
inlined, as today.

- Lets that read `$el` or `$index` are cached per instance like any other.
- A handler, or an `<sn-sync>` mapping, that reads the let gets the cached value.
- The early script caches the same way, and hands its values to the page module with the rest of
  its state, so a let is not computed again at takeover.
- attributes.md's "computed where they are read" changes to say so.

#### A let may wait for a lazy helper module

A helper module that reaches a lazy package is loaded whole, when first needed, as a component
script that imports one is ([lazy.md](../lazy.md#component-scripts)). The lazy transform does not
turn its functions into promises: once loaded, they are synchronous.

- A let that calls a member of such a module is `undefined` until the module has arrived, and
  `sinter check` types it `T | undefined`. The module's arrival is one more dependency: it renders
  what reads the let. `<md-doc>` takes `doc?: Root` and renders nothing without it.
- A component prop is a let, so `data-sn-prop="{ doc: md.parse(x) }"` is the same.
- Anywhere else (a binding, a handler, a state initializer), calling a member of such a module is
  `SN324`, with the hint to name it in a `data-sn-let`. The rule is per module, not per package:
  sinter imports each member from the module that declares it, so a library keeps the helpers that
  only read a tree (`md.headings`, `md.text`) in a module that does not import the parser, and they
  stay ordinary helpers.
- The module loads when the first scope with such a let is created. A page whose main content is
  markdown from an API adds `data-sn-preload` to start it with the page, as lazy.md advises: measure
  first.
- A let that waits is not early. The rest of the item (a comment's author and date) still renders
  early with embedded data.
- An app that leaves the parser out of `lazy` gets a synchronous helper: the let is early over
  embedded data, and the parser is in both the early file and the page module. A parser of
  micromark's size is likely to be over the early budget (`earlyBudget`, 10,000 bytes); the plan
  measures it.
- A draft in state is a let like any other: `data-sn-let="{ preview: md.parse(draft) }"` is a live
  preview, cached until the draft changes.
- Two views of one item parse it twice, once in each scope.

An app can render a single article from an API today with `<sn-resource call>`: an action function
that imports the parser lazily, with `$meta.<name>.loading` while it loads. It cannot do a list
(`call` does not combine with `each`), it is not early, and it calls action functions, not helpers
([Alternatives](#alternatives-considered)).

### 7. Libraries ship source

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
  and rule 5 of [tree slots](#the-rules) is checked there and in the app's build.
- **Versions.** A library declares the sinter versions it supports as a `peerDependency`; the app's
  sinter checks the range. It cannot know which version introduced a feature newer than itself.

## The markdown library

### 8. Parse options: what content may contain

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
  `javascript:` and other unsafe URLs without the parser's help.
- An image from user content is a plain `<img>`: the library's image component does not use a
  resizing service unless the app's fill does.

### 9. The library

- **Two helper modules, one namespace.** `md.parse(source, options)` returns an mdast tree
  (CommonMark, and GFM tables, task lists, strikethrough and autolinks), typed as a discriminated
  union; `options.base` turns relative URLs into root paths. `md.headings(doc)` (a table of
  contents) and `md.text(doc)` (a description, a reading time) read a tree and live in a module that
  does not import the parser.
- **One function in three places.** Over a `file:` resource, the compiler runs it. In a let over API
  data, it loads on demand when the app lists the parser in `lazy`, or with the page when it does not.
- **Public components**: `md-doc` (block content) and `md-inline` (one line: a title, a table
  cell). `md-doc` uses `md-inline` for phrasing content, which rule 4 of [tree slots](#the-rules)
  covers. One internal component per node type. Both take `doc` as optional and render nothing
  without it, for a let that waits.
- **Declared slots** on both roots, for the nodes an app is likely to change: `heading`, `link`,
  `image`, `code`, `inlineCode`, `blockquote`, `table`. Adding one later is additive.
- **What sinter does for it:** internal links prefetch; local images from the repo are optimized;
  headings get ids from their text, so `md.headings` and the anchors agree; a code block's fill can
  highlight at build time with a helper over the constant code.
- Where it lives (this repository, a package beside `create`, or its own repository) is decided at
  the last step.

## Breaking changes

- **The helpers module runs in Node**, in builds, the dev server, `sinter check` and the LSP. Its
  side effects at load run there; a module that cannot load there folds nothing and warns.
- **Helpers over constants fold.** A binding over one is written into the HTML, and state
  initialized by one becomes a constant: bindings over it leave the early script, and a page can
  become static. A helper that breaks the purity contract without touching the listed globals gets
  its result baked in; the dev check warns where two runs differ.
- **Every let over a helper is cached**, which changes when the helper runs and what is kept in
  memory, for every app that has one. A helper that breaks the purity contract no longer gives a new
  value at every read.
- **`Slot` is a reserved type name** in component declarations.
- **An app component whose first segment equals a configured package's prefix** fails the build,
  once that package is configured.

Relaxed, not breaking: `SN312` no longer applies to slots that pass data.

## Limits

- A constant tree with any subtree that needs run time is not unrolled in the first version.
- Markdown from an API as a string is in the first frame only when the parser is not lazy, and then
  the parser is in the early file and the page module. Reserved space covers only paginated lists, so
  a body that renders late shifts the layout. An API that sends the tree avoids both.
- A placement gives a fill only its default slot; a fill cannot receive named parts.
- Each specialization of a package's definitions is a copy of every definition its root reaches.
- A stream that appends to a let's source parses the whole body again for each chunk.
- A fill cannot write state declared inside a caller's row.
- Links between markdown files stay as written.

## Diagnostics

New codes are numbered when implemented. Existing codes keep their meaning and gain cases.

| Situation | Diagnostic |
| --- | --- |
| A fill for a slot the component or root does not declare; direct content for a name an inner use does not declare | `SN314`, with the declared names |
| A `Slot<T>` member passed through `data-sn-prop` | `SN313` |
| `Slot<T>` in a type alias, with `?`, in a head or layout declaration, or an app type named `Slot` | at the declaration |
| A placement's `data-sn-prop` does not fit `T` | at the placement |
| A tree placement with no enclosing root that declares it | at the use |
| A declared slot is placed nowhere inside the root | in the library's `sinter check` and the app's build |
| An unnamed `<slot>` in a fill, in a component that has a default slot of its own | at the `<slot>` |
| A `<slot>` in a fill whose placement gives no children; two unnamed `<slot>`s in one fill | at the fill; `SN312` |
| A literal `id` in a fill, or in content placed in one, rendered more than once | at the element |
| A fill writes state declared inside a caller's row | at the write |
| The helper form of `<sn-component use>` inside a root whose use has fills | at the use |
| A helper over constants that could not be folded | dev warning, at the call; `SN322` on a `static` page |
| The helpers module could not be loaded at build time | one warning |
| A tree over the expansion limit | warning, at the use, with the count |
| A `file:` source with an interpolation, outside the project root, or missing | at the resource |
| An attribute or store function on a `file:` resource that needs loading or writing | at the attribute |
| A member of a helper module that reaches a lazy package, called outside a `data-sn-let` or prop | `SN324`, with the hint |
| A configured package without a `"sinter"` folder, or without `components/` | the package |
| Two packages, or a package and the app, own the same prefix | both owners |
| The app uses an internal library component | the public ones |

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| A token stream (markdown-it's open and close tokens) | Markdown is a tree, and so are sinter templates; the renderer would rebuild the nesting |
| A component map passed down the tree (`{ link: 'ugc-link' }`; react-markdown and MDX do this) | A map can be an expression, so the compiler knows less, and every node component has to pass it on. Slots keep the override in markup the compiler reads |
| Shadowing (an app file named like a library component replaces it) | Silent, global, and makes every internal name public API. One wrapper with fills does the same, visibly |
| Inner components declare their own fillable slots | The contract would spread over every file of the library |
| A `data-sn-slots` attribute (first revision) | A third declaration beside props and events; `Slot<T>` in the props type keeps two |
| `data-sn-let` on `<slot>` (the components proposal's sketch, second revision) | Lets take no shorthand and may not repeat a prop's name, and the fill reads `$slot.x`, not the bare name. `data-sn-prop` already means "values for what renders inside" |
| A marker on tree placements (`data-sn-tree`, first revision) | A placement of a name the component does not declare is already explicit |
| `<sn-children>` (first revision) | A new element for what a `<slot>` inside a fill means under the nearest-markup rule |
| An empty fill gets the default's children (second revision) | Invisible in the markup, changes existing empty fills, and cannot place children beside other content |
| A `pure()` marker on helpers (first revision) | What may fold can be read from the code; a marker would be one more thing to keep in step |
| Every helper over constants folds, by the purity contract alone (second revision) | The contract is about re-rendering in one browser, not about the build machine and the visitor's browser agreeing on locale, time zone or globals |
| `$file()` (first revision), or `./` in `src` as a file (second revision) | `$file()` is a function among magic names that are values; `./` would make `post.md` and `./post.md` mean different things, and conflicts with `apis`. `file:` is a source in the existing grammar |
| `$meta.<name>.url` as a base (second revision) | Not known early, a path for files but a URL for APIs, and only files need a base; the parser takes one |
| Derived fields on resources (first revision) | A new attribute for what `data-sn-let` names; a let also covers drafts in state. It parsed once per item for all views, where a let parses once per scope |
| `<sn-resource call>` for markdown from an API | What lazy.md recommends, and enough for one article, but it does not combine with `each`, is not early, and calls action functions, not the helpers a page folds |
| Bindings that wait for a lazy package | Every binding would need a pending state. Only lets wait, and they read as `undefined`, as a resource that has not loaded reads as empty |
| A compiler hook a library registers for its tag | Its output is markup that `sinter check` and the editor cannot follow |
| HTML from the parser, inserted through the Sanitizer API | Loses per-node looks, conflicts with markup from the network staying inert, and is not in every browser sinter supports |

## Not in this proposal

- Pages from a folder of markdown files (a blog: one page per post, an index of them, links between
  them). It builds on `file:` and helpers at build time, and needs its own design for page paths and
  interpolated `file:` sources.
- Partial unrolling: a constant tree with a subtree that needs run time.
- Named parts a placement gives its fill.
- Parsing in a worker.
- Using sinter components outside sinter: unchanged, still deferred.

## Testing

- Compiler tests in `test/` for each step: slots, fills and their `<slot>`s, reach-through and
  specializations, folding and unrolling, `file:`, lets, packages. Each diagnostic has a test.
- Browser tests for the runtime parts: fills in rows, specializations instantiated by the runtime and
  the early script, cached and waiting lets, a lazy helper module, under the strict CSP and Trusted
  Types as today.
- The testing module's `render()` and `firstPaint()` take fills, `file:` resources (through
  `files`) and the helpers that fold.
- A library's fixture pages are checked by `sinter check`, and the markdown library's are tested in
  the browser.

## Docs

Each step updates `spec.md`, `attributes.md`, `components.md` (and `lazy.md`, `resources.md`,
`configuration.md` where it touches them), `llms.txt`, the compiler's vocabulary, the editor data
(`html-custom-data.json`) and the LSP: hover on `$slot` and on a `<slot>` says what fills it, and
completion offers a root's declared slots on a fill. The markdown library gets its own page and a
recipe.

## Plan

1. **A spike in userland, measuring only.** In an example app: `md.parse` as an ordinary helper over
   micromark and mdast, loaded with the page; about fifteen recursive `md-*` components; an article
   and a comment list from the API. Measure, in `bench/`: render time and binding count for a long
   article; the DOM it produces (the wrappers the root rule forces, inline whitespace); the page and
   early files with embedded data against `earlyBudget`; the parse at takeover; re-parse cost per
   render, since lets are inlined today, and per streamed chunk. It cannot try fills, which need the
   compiler.
2. **Slots that pass data** (section 1): `Slot<T>`, `data-sn-prop` on `<slot>`, `$slot`, a fill's
   `<slot>` by the nearest-markup rule, with a data table and a list with custom rows as tests.
3. **The root rule**, as decided next ([Open questions](#open-questions)).
4. **Tree slots** (section 2) among app components: tree placements, roots and boundaries,
   specializations with hidden inputs and their sources, early mode. Measures the cost per
   specialization. The package rules are tested in step 9.
5. **The compile order** (section 4, item 1): constants written before layout and images. Useful for
   any page whose constant images or classes come from bindings.
6. **Nested constant loops, decisions per instance and a fixpoint** (section 4, items 2 to 4).
   Useful for any page with nested constant data.
7. **Helpers over constants and `file:`** (sections 3 and 5): the module runner with the app's
   config in the build, `sinter check` and the LSP; the static check of what a helper touches.
8. **Constant trees** (section 4, item 5), and unrolling of specializations: a docs page from a `.md`
   file ships no JavaScript, with its images optimized. A test in `test/` and the `static-site`
   example. Sets the expansion limit.
9. **Lets over helpers** (section 6): cached, and waiting for a lazy helper module.
10. **Libraries ship source** (section 7), once the format above is settled. The spike's components
    move into a local package with fixture pages; the package rules of step 4 are tested here.
11. **The markdown library**, its docs page, `llms.txt`, and a recipe with an article and its
    comments on one page.

Steps 2, 5 and 9 do not depend on each other. Step 4 needs 2 and 3; step 8 needs 4, 6 and 7; step 9
builds its library case on 10.

## Open questions

- **The component root, decided next.** Today a component's root is one plain element, and a text
  binding needs an element, so a rendered tree has a wrapper around each link, heading and text run,
  and prose CSS (`h2 + p`, `li > a`) does not match. The options are the wrappers, narrower root
  rules (a `data-sn-if` chain or a `<slot>` as the root, and a text-only `<template data-sn-text>`),
  or components without a root.
- Fills as elements, as slot content is today, or as `<template slot>`, which makes the repetition
  visible and allows text or several elements without a wrapper.
- Whether a component can test that a slot is filled.
- Whether a library may declare that its parser is lazy, or only the app's `lazy` option does.
- Whether a let that waits should expose that through `$meta` for a placeholder, or a `data-sn-if` on
  the let is enough.
- How `md.parse`'s base and the image pipeline agree on root paths when Vite's `base` or `publicDir`
  is set.
- The expansion limit: per tree or per page, and its value.
- Partial unrolling, if step 8 shows trees that are constant except for a button.
- Writes from a fill to state inside a caller's row: needed, or a fill emits instead.

## Decisions

Proposed here, for review:

| Question | Proposal | Section |
| --- | --- | --- |
| Slot data | Declared as `Slot<T>` in the props type, passed with `data-sn-prop` on `<slot>`, read as `$slot`; ships before trees | [1](#1-slots-that-pass-data) |
| Children inside a fill | A `<slot>` inside the fill, by the nearest-markup rule; the one conflict is an error | [1](#a-slot-inside-a-fill) |
| Reach-through | A placement of a name its component does not declare, filled by the nearest root that declares it, within the root's package | [2](#the-rules) |
| Fills in the first version | Reads, store functions on caller rows, page-level writes; no writes to a caller row's state | [2](#what-a-fill-may-contain) |
| App-wide looks | A wrapper component with fills; no shadowing | [2](#app-wide-looks-and-wrappers) |
| Helpers at build time | Calls over constants in bindings and state initializers, refused statically for helpers that touch locale, time or browser globals; loaded with the app's Vite config | [3](#3-helpers-over-constants-run-at-build-time) |
| Constant folding | Constants before images; nested loops, per-instance decisions, a fixpoint; then trees | [4](#4-constant-trees-are-unrolled) |
| Files from the repo | The `file:` source; what does not fold becomes embedded data | [5](#5-files-the-file-source) |
| Markdown from an API | A let over the parser: cached per scope by its arguments; waiting for a helper module loaded whole | [6](#6-lets-over-helpers) |
| How a library ships | As source, named in the config, an app-shaped folder | [7](#7-libraries-ship-source) |
| What content may contain | Parse options; raw HTML shown as text by default; `'allow'` is a fixed set | [8](#8-parse-options-what-content-may-contain) |
| First step | A spike that measures, before any compiler change | [Plan](#plan) |
