# Components

A component is an HTML file in `src/components/`. Its file name is its tag, and it can be used on
every page:

```html
<!-- src/components/article-preview.html -->
<template data-sn-component="{ article: Article; compact?: boolean }" data-sn-emits="{ select: Article }">
  <article class="preview" data-sn-class="{ compact }">
    <a data-sn-attr="{ href: '/article/' + article.slug }" data-sn-on-click="emit('select', article)">
      <h2 data-sn-text="article.title"></h2>
    </a>
    <slot name="meta"></slot>
    <p data-sn-text="article.description"></p>
    <slot></slot>
  </article>
</template>
```

```html
<!-- any page -->
<template data-sn-for="a in articles">
  <article-preview class="item" data-sn-prop="{ article: a, compact: narrow }" data-sn-on-select="sel = $event.detail">
    <span slot="meta" data-sn-text="date(a.createdAt)"></span>
    <favorite-button data-sn-prop="{ article: a }"></favorite-button>
  </article-preview>
</template>
```

The compiler expands each use at build time. After expansion, the component's markup is page markup:
it renders in the first frame like the rest of the page (build-time constants, the early script,
embedded data), and the page module adopts it. Nothing hydrates it, and a component costs nothing at
runtime.

## The file

- The name contains a `-` (`article-preview.html` is `<article-preview>`).
- One `<template data-sn-component="…">` holds the markup. Its root **renders at most one element**
  ([The root](#the-root)).
- `data-sn-component` is the props type, written in TypeScript with the names `src/sinter.types.ts`
  exports (or the schemas of your OpenAPI spec), as `<sn-resource type>` is. `data-sn-component=""`
  takes no props.
- `data-sn-emits` (optional) declares the events the component emits, with their detail types.
- Together, these two attributes are the component's whole contract.

## The tag is replaced by the root

Each use is replaced by the component's root element, so a parent's layout reaches it as a direct
child (grid, flex, `data-layout`), with no wrapper.

- `class` on the tag is joined with the root's. Another attribute (`id`, `aria-*`, `data-grow`) moves
  onto the root; the same attribute on both is an error, not a silent override.
- Handlers (`data-sn-on-*`), an action (`data-sn-post`, …), `data-sn-class`, `-attr`, `-style`,
  `-show` and `-transition` on the tag move onto the root, in the caller's scope.
- A component whose root is a `<tr>` or `<li>` is that element. Write its tag inside the row's
  `<template data-sn-for>`: directly in a `<table>`, the HTML parser moves an unknown tag out of the
  table, which is a build error with the fix.

## The root

What the caller writes on the tag lands on exactly one element, so a component's root **renders at
most one element**:

| Root | Renders at most one element because |
| --- | --- |
| a plain element | it is one |
| a `data-sn-if` / `data-sn-else` chain | each branch is a root; without an `else`, nothing renders when no branch holds |
| another component's tag | its root renders at most one element |
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

- A root that is not a plain element is an `if` or a choice like any other: marked by comments,
  decided at build time when a constant prop decides it (`<ui-button data-sn-prop="{ label: 'Save' }">`
  is a `<button>` in the HTML), otherwise replaced when its condition changes. Focus on the old element
  is lost, a handler on the tag sees the new `$el`, and a pending or debounced handler on the old
  element is dropped with it. Whitespace between the branch templates is dropped.
- The tag's attributes land on every branch (one attribute on the tag and a branch's element is an
  error, per branch). Through a component tag as root they pass on, `class` joined, down to the element
  that renders. With a `<slot>` as root they land on the fill, or the default; one attribute on both
  the tag and the fill is an error at the tag that names the fill.
- **What keeps a plain root**: a component with a script (it runs on its root; replacing it would
  restart it), and one with `data-sn-state` on its root (which holds optional props' defaults: give
  those with `??` in the expressions instead). Anything else is `SN312`.
- A root that may render nothing (a chain without an `else`, `<sn-component use>`, a component tag
  whose own root may) takes no `id`, `data-sn-model`, action or `data-sn-transition` on its tag
  (`SN334`): each points at an element that may not exist.
- More than one element, or text, at the root is `SN312`.

## Props

`data-sn-prop` on the tag passes the props. Each prop is the caller's expression, evaluated where the
component reads it: nothing is copied, so a change shows at once.

- Props are read-only. A component changes its own `data-sn-state`, or emits an event.
- A prop the use gives as a constant (`label: true`), or leaves out, decides a `data-sn-if` on it at
  build time: the branch is in the markup, or not at all, with no binding.
- A prop the component does not declare, or a required one left out, is a build error (`SN313`).
- An optional prop that is not passed is `undefined`, or, when the root's `data-sn-state` has a field
  with its name, that field: its default.

## Scope

The component's markup sees its props, its own state, the page's resources, helpers and magic names.
It does not see the caller's state or loop variables: reading one is an error that names the prop to
add.

Slot content is the reverse: it is the caller's markup and sees the caller's scope, none of the
component's.

## Slots

The tag's children fill the component's slots at build time. Content with `slot="meta"` goes into
`<slot name="meta">`, the rest into the default `<slot>`. A slot the caller leaves empty shows its own
children (fallback content). Content that no slot takes is a build error (`SN314`). Slot content is
light DOM: global CSS, forms, labels and ARIA references work across the boundary.

A slot takes every child that names it, in the order they are written. A `<slot>` that is itself slot
content of a component's tag forwards what fills it into that component's slot, with its own
fallback when it is left empty:

```html
<!-- src/components/page-section.html -->
<template data-sn-component="">
  <section><side-card><slot name="aside" slot="side">Nothing here</slot></side-card><slot></slot></section>
</template>
```

The caller's `slot="aside"` content ends up in `side-card`'s `side` slot, in the caller's scope:
slot content keeps the scope of the markup that wrote it through any number of components.

A slot is placed once, with one exception: one `<slot>` of a name in each branch of one
`data-sn-if`/`data-sn-else` chain, since only one branch renders. Its content is copied into each
branch at build time. Two placements that can render together are a build error (`SN312`).

```html
<template data-sn-component="{ level: number }">
  <div>
    <template data-sn-if="level === 1"><h1><slot></slot></h1></template>
    <template data-sn-else><h2><slot></slot></h2></template>
  </div>
</template>
```

## Slots that pass data

A component can pass values to the content of a slot: a data table with custom cells, a list with
custom rows. The slot is a member of type `Slot<T>` in the props type, and `T` is what it passes:

```html
<!-- src/components/data-table.html -->
<template data-sn-component="{ rows: Row[]; columns: (keyof Row)[]; cell: Slot<{ row: Row; column: keyof Row }> }">
  <table><tbody>
    <template data-sn-for="r in rows" data-sn-key="r.id">
      <tr><template data-sn-for="c in columns"><td><slot name="cell" data-sn-prop="{ row: r, column: c }"><span data-sn-text="r[c]"></span></slot></td></template></tr>
    </template>
  </tbody></table>
</template>
```

```html
<data-table data-sn-prop="{ rows: invoices, columns: ['number', 'customer', 'total'] }">
  <span slot="cell" data-sn-text="$slot.column === 'total' ? number($slot.row.total) : $slot.row[$slot.column]"></span>
</data-table>
```

- **The declaration.** `cell: Slot<…>` is a type, not a value: the content stays markup. It is written
  in the props type literal, where the compiler sees it (in a type alias, or inside another type, it
  is an error), without `?`: every slot may be left unfilled. A slot is not a prop: passing it with
  `data-sn-prop` is `SN313`, it is not in a script's `this.props`, and nothing requires it.
  `Slot<T>` is not allowed in `data-sn-head` or `data-sn-layout`. `Slot` is a type sinter
  generates (in `src/sinter.components.d.ts`, beside `ComponentName`); a types module that exports
  one is an error that asks for another name. A slot that passes nothing needs no declaration.
- **The placement.** `data-sn-prop` on the `<slot>` passes the values, as on a component's tag; it is
  checked against `T`. A slot that passes data is named, and may be placed more than once (each
  placement renders its own copy of the content).
- **The fill.** The caller's elements with `slot="cell"`, as for any slot. A `<template slot="cell">`
  starts an `if`/`else` chain (`<template slot="cell" data-sn-if="…">…</template><template
  data-sn-else>…</template>`). The fill sees the caller's scope plus `$slot`, the values of its
  placement, as a handler sees `$event`. `$slot.row` is the row the component got from its prop, so
  `patch($slot.row, …)` and `remove($slot.row)` act on the caller's resource. Inside a fill for
  another component, the inner `$slot` hides the outer one; keep the outer value with
  `data-sn-let="{ outer: $slot.row }"` on the outer fill.
- Whether a slot is filled cannot be tested in the component: an unfilled placement shows its default.
- `sinter check` types `$slot` by `T`, and the placement's `data-sn-prop` against it. In the editor,
  a hover on `$slot` shows its type and its placement.

For a library, turning a plain slot into a `Slot<T>` changes what an unnamed `<slot>` in a caller's
fill means (below): a breaking change of the library.

### A `<slot>` inside a fill

A `<slot>` is filled by the nearest enclosing markup that is given content for it: a component, given
slot content by its caller, or a fill, given children by its placement. The placement's default is one
plain element (or an `if`/`else` chain of them); an unnamed `<slot>` in a fill of a slot that passes
data is that element's children. They are the component's markup, with its scope and styles.

```html
<!-- placement: the default renders one element, whose children a fill's <slot> gets -->
<slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }"><span data-sn-text="node.text"></span></a></slot>

<!-- fill: the children, then an icon -->
<a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot> ↗</a>

<!-- a heading fill that picks its level: a chain, with the children in each branch -->
<template slot="heading" data-sn-if="$slot.node.depth === 1"><h1 class="title"><slot></slot></h1></template>
<template data-sn-else><h2 class="title"><slot></slot></h2></template>
```

- A named `<slot>` inside a fill is the enclosing component's slot, as before. A fill of a slot that
  passes nothing is given nothing: every `<slot>` in it is the enclosing component's.
- A component's own default slot cannot be placed inside a fill of a slot that passes data: that
  `<slot>` is the children there. Give it a name.
- Forwarding passes the children on: a `<slot name="link" slot="link" data-sn-prop="…">` in a
  wrapper gives its own fill what its placement gave it, so a page's fill of the wrapper's `link` can
  place `<slot>` too.
- A fill without a `<slot>` drops the children.
- Errors (`SN331`): a `<slot>` in a fill whose placement's default renders no element (text, nothing);
  names the default's element declares (`data-sn-let`, `data-sn-state`) that its children read, since
  they move into the fill without it (put them on the `<slot>`'s `data-sn-prop`, or inside); a
  default that is not a root (several elements, a loop); a `<slot>` in a fill whose default is a
  component, whose element's children are that component's markup. Two unnamed `<slot>`s in one fill that can render together
  are `SN312`.
- A `<slot>` that no component or fill encloses (on a page, or in a page's slot content) is an error.

### Tree slots

A component made of other components (a document of paragraphs, lists and links, or a tree of
folders and files) can let its caller fill a slot that a component deep inside it places. The root
declares the slot; a component inside it places it without declaring it:

```html
<!-- src/components/x-doc.html: the root -->
<template data-sn-component="{ doc: Block[]; link: Slot<{ node: Link }> }">
  <article><template data-sn-for="b in doc"><x-block data-sn-prop="{ block: b }"></x-block></template></article>
</template>

<!-- src/components/x-link.html: two levels down, it places the root's slot -->
<template data-sn-component="{ node: Link }">
  <slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }"><x-inline data-sn-prop="{ nodes: node.children }"></x-inline></a></slot>
</template>
```

```html
<x-doc data-sn-prop="{ doc: page.doc }">
  <a slot="link" rel="nofollow" data-sn-attr="{ href: $slot.node.url }"><slot></slot> ↗</a>
</x-doc>
```

- **The placement.** A `<slot name>` with `data-sn-prop` whose name its own component does not
  declare is a tree placement. A name close to one its component declares is `SN535` (warning), with
  the name it suggests.
- **Which root fills it.** The nearest enclosing component that declares the name: its caller's fill,
  or the default when it is not given one. The placement's values are typed by that root's `Slot<T>`.
  A placement no root encloses is `SN331`, at the use that leaves it without one (the outermost tag,
  or a page using the component directly).
- **A root inside a fill** (in the caller's markup) starts again: its own fill or its default, never
  the outer one.
- **A root in its own package's markup** (a component that uses another component declaring the same
  slot) passes the outer fill through: the inner root's own fill wins where it gives one. The app's
  components are one package and each [component library](libraries.md) is one: a placement is
  filled by a root of its own package only, and a root written in another package's markup starts
  again.
- **Every declared slot is placed** somewhere in the root's components, or it is `SN331`.
- **Fills do not reach into slot content**: a placement in content a caller gives (a plain slot's
  fill, the children of another fill) is not filled by the root that content is passed to.
- **`<sn-component use>`** in its helper form is `SN312` in a component that declares slots or
  contains a tree placement (the fill could not follow a component chosen by a function).
- How it compiles: each fill is a template of its own, compiled once in the caller's scope, which it
  reads through the runtime scope chain (rows, `data-sn-let`, `data-sn-state`, state writes and store
  functions, `$el`, `$event`, `emit()` of the caller's component). A placement is a choice between its
  default and the fill passed down; only `$slot` and the fill's choice travel down the components.
  A component used inside itself compiles once for all its depths. A placement directly in the root's
  markup is filled at build time, as a plain slot is. `data-sn-early="off"` on the root's tag covers
  its fills.
- Children and forwarding work as for any fill: an unnamed `<slot>` in the fill is the placement's
  default element's children, and a wrapper forwards a root's slot to its own caller:

```html
<!-- src/components/x-wrap.html: a wrapper that gives the page the link slot -->
<template data-sn-component="{ doc: Block[]; link: Slot<{ node: Link }> }">
  <x-doc data-sn-prop="{ doc }"><slot name="link" slot="link" data-sn-prop="{ node: $slot.node }"></slot></x-doc>
</template>
```

## Events

`emit('select', article)` inside the component dispatches a bubbling event from where it runs, up
through the root, where the caller's `data-sn-on-select` sits. Its name must be one `data-sn-emits`
declares (`SN315`), and so must the event of a `data-sn-on-<event>` on the tag, unless it is a DOM
event such as `click`. `sinter check` types `$event.detail` from the declaration.

## Leaving a component out of the early script

Every component renders in the first frame by default: the early script renders its bindings as the
page is parsed. A use that can accept the layout changing when it renders (a widget below the fold, a
sidebar box) can opt out on its tag, so the early script stays small:

```html
<tag-cloud data-sn-early="off" data-sn-prop="{ tags }"></tag-cloud>
```

That use's bindings are left out of the early script, at any depth (components inside it too, not the
slot content the tag passes in), and render when the page module runs. Other uses of the component
still render early. Build-time constants are still written into the HTML; they cost no script.
`<sn-component>` takes it too.

## Styles

A `<style>` in the component file is scoped to the component:

```html
<!-- src/components/article-preview.html, after the template -->
<style>
  .preview { padding: var(--space-md); }
  .compact p { display: none; }
</style>
```

- It goes into the page's stylesheet (the bundler puts it there, with the page's other CSS): no inline
  style, no CSP change, and it is there for the first paint.
- The compiler wraps it in native `@scope`. The rules apply to the component's root and what is inside
  it, and stop at a nested component's root and at slot content, so a component's `p { … }` styles
  neither the paragraphs of the components it uses nor those the caller passes into its slots.
- Slot content is styled by the component whose markup it is: the content a component passes into
  another one's slots gets its own styles.
- Selectors are as written, with their normal specificity. A rule's first part may be the component's
  root (`.preview`, the `.compact` of `.compact p`): the compiler adds a copy of each selector for that
  (`.compact p, :where(:scope):is(.compact) p`), which devtools show beside it. `:scope` is the root.
- Each instance is its own scope: `.card + .card` does not reach the next instance.
- `@keyframes`, `@font-face`, `@import` and `@property` stay global.
- To scope, the root carries `data-sn-c="article-preview"` and top-level slot content carries
  `data-sn-s`, on pages with scoped styles (the root's name is there in dev builds too). Each branch of
  a chain root carries `data-sn-c`; a fill that is a `<slot>` root keeps the caller's styles.
- A component whose root is another component's tag (`primary-button` above) has no element of its
  own: the element is the inner component's (`data-sn-c="ui-button"`) and also carries
  `data-sn-r="primary-button"`. The outer component's rules whose subject is its root (`.primary`,
  `:scope`) are emitted against that marker, outside its `@scope`, with the same specificity; its rules
  that reach inside do not apply there, since the inside is the inner component's.
- `@scope` is in every browser sinter supports. An older browser ignores the rules, and the component
  shows unstyled.
- Styling a component's inside from outside is not supported: style its root through the tag's
  `class`, or give the component a prop.

## Custom inputs: `data-sn-model`

A component that declares a `value` prop and a `change` event can be bound like a form control:

```html
<!-- src/components/rating-input.html -->
<template data-sn-component="{ value: number }" data-sn-emits="{ change: number }">
  <div>
    <template data-sn-for="i in [1, 2, 3, 4, 5]" data-sn-key="i">
      <button type="button" data-sn-class="{ on: i <= value }" data-sn-on-click="emit('change', i)" data-sn-text="i"></button>
    </template>
  </div>
</template>
```

```html
<form data-sn-put="/api/contacts/{draft.id}" data-sn-body="draft">
  <rating-input data-sn-model="draft.stars"></rating-input>
</form>
```

`data-sn-model="draft.stars"` is `data-sn-prop="{ value: draft.stars }"` plus a `change` handler that
writes `$event.detail` back. Only the component's own event writes: a native `change` from a control
inside it is not. It binds state, never a resource, as on `<input>`.

## A script

A component that needs the browser (a canvas, a map, a third-party library) gets a script beside its
HTML: `src/components/task-ring.ts`. sinter runs it once per instance, on the instance's root, with
`connected()`, `propsChanged()` and `disconnected()`; the script reads `this.props`, writes
`this.state`, reaches elements through `data-sn-ref` and emits declared events. See
[components with a script](islands.md).

## Text without an element

`data-sn-text` on a `<template>` renders a text node: a run of text beside elements, with no `<span>`
around it.

```html
<template data-sn-for="p in highlight(title, q)">
  <template data-sn-if="p.match"><mark data-sn-text="p.text"></mark></template>
  <template data-sn-else><template data-sn-text="p.text"></template></template>
</template>
```

- It takes no other attribute: a condition or a loop goes on a template around it (`SN333`), and
  `$el` has no element there (`SN213`).
- It always occupies one node (a `Text`, or an empty comment while its value is empty), found again
  from the node before it at each write, so text that browser translation replaced is written in
  place. Outside rows it is marked like a branch (`<!--sn 7-->…<!--/sn-->`); in a row, the element
  before it marks it, or an empty comment does.
- A build-time constant (a literal, state nothing writes, a constant prop, the item of a row unrolled at build time) folds into the HTML as plain text, its marks and binding gone; a text that stays a binding keeps its marks, so the two never merge. A page whose text is all constant ships no JavaScript for it.
- A fill may be a text: `<template slot="label" data-sn-text="$slot.v"></template>`.

## A component inside itself

A component may use itself by its own tag, for a tree of data: comments and their replies, a file
tree, a nested menu.

```html
<!-- src/components/comment-thread.html -->
<template data-sn-component="{ comment: Comment }">
  <li>
    <p data-sn-text="comment.body"></p>
    <button data-sn-on-click="upsert(comment.replies, { id: $now, body: 'Thanks!', replies: [] })">Reply</button>
    <ul>
      <template data-sn-for="r in comment.replies" data-sn-key="r.id">
        <comment-thread data-sn-prop="{ comment: r }"></comment-thread>
      </template>
    </ul>
  </li>
</template>
```

- Every cycle must pass through a `data-sn-for` or `data-sn-if` template, because only data ends it. A
  cycle that does not is a build error (`SN306`) showing it; the rule covers mutual recursion too (A uses
  B, B uses A).
- The compiler compiles the component once, as a shared definition: a `<template>` in the `<head>`, so
  the parser has it before the body (at the end of the body when nothing renders it before the first
  paint). Each inner use is an instance of it, created per item as `data-sn-for` creates rows. The
  early script clones it too: a tree in embedded data is in the first frame at any depth.
- Over constants (a literal, a `file:` resource, state nothing writes), the tree is expanded at build
  time instead, one copy of the markup per node, and the shared definition leaves the page when no
  instance is left to render from it ([static pages](static-pages.md#what-is-static)). A tree's node
  that writes state, or a fill that holds components or slots, keeps its part of the tree in the
  browser. At most 10,000 rows and components are expanded per page (`SN536` past it).
- A component used inside itself declares its props as a type literal, and its inner uses take no slot
  content. An inner use's plain attributes, `data-sn-class`, `-attr`, `-style`, `-show` and handlers
  reach the root its instance renders: they are compiled where the tag is written and passed with
  its props. Other sinter attributes on it are `SN102`.
- **Nested items are changed along their path.** `patch(r, …)` and `remove(r)` for `r in
  comment.replies` act on `r` inside its top-level row, at any depth: the objects along the path are
  replaced, and every view of that row updates. Nested items are matched by the resource's key, so
  give nested loops `data-sn-key`. `upsert(c.replies, x)` adds `x` to a nested list (or replaces the item
  with its key); a resource name stays the form for top-level lists.
- **Write-through follows the same paths.** An action inside the tree is about the nested item it reads
  (`data-sn-put="/api/comments/{comment.id}"`): its response patches that item at its depth, and a
  DELETE of the item's URL removes it from its list.

## Choosing a component at runtime

A list of mixed blocks (a CMS page, dashboard widgets, a form builder) picks a component per item:

```html
<template data-sn-for="b in blocks" data-sn-key="b.id">
  <sn-component use="`${b.type}-block`" data-sn-prop="{ block: b }"></sn-component>
</template>
```

- `use` is an expression naming the component. The compiler needs every candidate at build time, and
  `use` must have a type that fits `ComponentName`, the union of the app's components (generated in
  `src/sinter.components.d.ts`).
- Three ways to write it, one check:

  | Form | Example | For |
  | --- | --- | --- |
  | Convention | ``use="`${b.type}-block`"`` | names that follow the data: with `b.type` typed `'hero' \| 'text'`, TypeScript types it `'hero-block' \| 'text-block'` |
  | Map | `use="{ hero: 'hero-block', text: 'rich-text' }[b.type]"` | names that do not follow a convention; untyped pages |
  | Helper | `use="blockComponent(b)"` | logic, such as a fallback; its return type, a union of names, is checked |

  `b.type + '-block'` is a `string` to TypeScript, so it is an error that points to the template
  string.
- A missing component is an error: a new block type in the API spec fails `sinter check` until its
  component exists, and a map that names a missing file fails the build.
- Props are checked per candidate. For the convention and the map, each candidate's props are checked
  with the item narrowed to its type (`hero-block` can declare `{ block: HeroBlock }` for
  `Block = HeroBlock | TextBlock`). A helper hides that link, so its candidates take the whole union.
- A value outside the candidates renders nothing, with a warning in dev builds (once per value), or the
  `data-sn-else` template that follows the element.
- Each candidate compiles to a shared definition in the head (as for [recursion](#a-component-inside-itself)).
  Over constant props, the candidate each use renders is expanded at build time in its place, and a
  candidate nothing renders is not in the page.
  A convention or a map compiles only its candidates; a helper compiles every component of the app,
  since only TypeScript knows its return type.
- The page holds one place for the chosen component, however many candidates there are: `use` is
  evaluated once, and the rendered component sits between two comments, as every list and branch does
  ([lists and branches in the page](#lists-and-branches-in-the-page)).

## Lists and branches in the page

A `data-sn-for`, a `data-sn-if` (with its `data-sn-else`), a component used inside itself and a
`<sn-component use>` render between two comments, and their templates are in the head:

```html
<ul><!--sn 4--><li>a</li><li>b</li><!--/sn--></ul>
```

Comments are not elements, so CSS sees the rows as a plain list: `li:first-child` is the first row,
`:nth-child` counts rows only, `h2 + p` and `* + *` match inside a branch as written, and an empty
list matches `ul:empty`. A script that counts `childNodes` sees the comments. A comment of yours whose
text is exactly one of those forms (`sn`, `sn 4`, `/sn`, or empty) is an error (`SN105`); `<!--snippet-->`
and any other comment are yours. `$el` in an `if`, `for` or `use` expression has no element
to name (`SN213`). Keep HTML comments in sinter's pages: a minifier or CDN that strips them breaks
lists and branches (dev builds warn).

## Types

`sinter check` checks every edge against the one declaration:

| Where | What is checked |
| --- | --- |
| The tag | `data-sn-prop` keys and types; `data-sn-on-<event>` names and the type of `$event.detail`; slot names; `$slot` in a fill, by the slot's `Slot<T>` |
| A placement | `data-sn-prop` on a `<slot>`, against its `Slot<T>` |
| The component's markup | bindings read only declared props, its state and globals; `emit()` names match `data-sn-emits` |
| The script | TypeScript, through the generated base class: a misspelled prop, event or ref, or a wrong detail type, is a type error |

Errors in the component are reported in the component's file, followed by where it is used. In the
editor, `sinter lsp` checks a component through the pages that use it, and goes from a tag to its file.

## Ids

A literal `id` in a component used more than once on a page would be on the page more than once:
that is a build error. Compute it from a prop (`data-sn-attr="{ id: 'edit-' + item.id }"`). A literal
`id` in markup that renders more than once (a `data-sn-for` row, a fill of a slot placed more than
once), in a page or a component, is a warning (`SN532`).

## Head components

A component for the `<head>` holds head elements, any number of them, with no wrapper:

```html
<!-- src/components/seo-tags.html -->
<template data-sn-head="{ title?: string; description?: string }">
  <title data-sn-text="title ? title + ' · My Blog' : 'My Blog'">My Blog</title>
  <meta name="description" content="Notes on the web." data-sn-attr="{ content: description ?? 'Notes on the web.' }">
  <slot name="extra"></slot>
</template>
```

```html
<head>
  <meta charset="utf-8">
  <seo-tags data-sn-prop="{ title: post?.title, description: post?.summary }"></seo-tags>
</head>
```

- It is declared with `data-sn-head` in place of `data-sn-component`; the two declarations are the
  file's kind, and a template with both is `SN312`.
- It holds head elements: `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`,
  `<base>`, `<template data-sn-if>` or `data-sn-for` over head elements, slots and other head
  components. Anything else is `SN320`. Head elements in a `data-sn-component` are `SN312`, with the
  hint to declare it with `data-sn-head`.
- It is used in a head: a page's, a [layout's](layouts.md), or a head slot's content. In a body it is
  `SN320`, as is a component with one root element in a head.
- Its tag takes `data-sn-prop` and slot content, nothing else: there is no root for other attributes
  to land on. It has no script and no scoped `<style>`.
- Props, slots, constants deciding a `data-sn-if` at build time and `sinter check` work as for every
  component. `<sn-component use>` chooses only components for the body.
- In a head, `<title data-sn-text>` binds, and so does the `content` of a `<meta>` with a literal
  `name`, `property` or `itemprop`. See [what a crawler sees](layouts.md#what-a-crawler-sees).

sinter parses a head so that a component's tag stays where it is written; the browser's parser
would end the head at it and move it, and everything after it, into the body.

## From a library

A [component library](libraries.md) is a package of components in this format, named in
`sinter({ components: ['@acme/ui'] })`. Its public components are tags like the app's own; their
names start with the library's prefix (`ui-`), which no app component may use.

## From `<sn-include>`

`<sn-include>` is removed: a partial is a component without a script. The build error (`SN316`) lists
the names the partial read from the page. Move the file to `src/components/<name>.html`, wrap its
markup in `<template data-sn-component="{ … }">` around one root element, declare those names as
props, and pass them with `data-sn-prop`.
