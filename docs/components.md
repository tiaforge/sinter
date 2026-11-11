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
- One `<template data-sn-component="…">` holds the markup, with **exactly one root element**.
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

## Props

`data-sn-prop` on the tag passes the props. Each prop is the caller's expression, evaluated where the
component reads it: nothing is copied, so a change shows at once.

- Props are read-only. A component changes its own `data-sn-state`, or emits an event.
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

## Events

`emit('select', article)` inside the component dispatches a bubbling event from where it runs, up
through the root, where the caller's `data-sn-on-select` sits. Its name must be one `data-sn-emits`
declares (`SN315`), and so must the event of a `data-sn-on-<event>` on the tag, unless it is a DOM
event such as `click`. `sinter check` types `$event.detail` from the declaration.

## Leaving a component out of the early script

Every component renders in the first frame by default: the early script renders its bindings as the
page is parsed. A component that can accept the layout changing when it renders (a widget below the
fold, a sidebar box) can opt out, so the early script stays small:

```html
<template data-sn-component="{ tags: string[] }" data-sn-early="off">
```

Its bindings are left out of the early script, at any depth (components inside it too, not the slot
content its caller passes in), and render when the page module runs. Build-time constants are still
written into the HTML; they cost no script.

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
- Selectors stay as written, with their normal specificity; devtools show them unchanged.
- `@keyframes`, `@font-face`, `@import` and `@property` stay global.
- To scope, the root carries `data-sn-c="article-preview"` and top-level slot content carries
  `data-sn-s`, on pages with scoped styles (the root's name is there in dev builds too).
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
  the parser has it before the body. Each inner use is an instance of it, created per item as
  `data-sn-for` creates rows. The early script clones it too: a tree in embedded data is in the first
  frame at any depth.
- A component used inside itself declares its props as a type literal, and its inner uses take no slot
  content.
- **Nested items are changed along their path.** `patch(r, …)` and `remove(r)` for `r in
  comment.replies` act on `r` inside its top-level row, at any depth: the objects along the path are
  replaced, and every view of that row updates. Nested items are matched by the resource's key, so
  give nested loops `data-sn-key`. `upsert(c.replies, x)` adds `x` to a nested list (or replaces the item
  with its key); a resource name stays the form for top-level lists.

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
- A value outside the candidates renders nothing, or the `data-sn-else` template that follows the
  element.
- Each candidate compiles to a shared definition in the head (as for [recursion](#a-component-inside-itself)).
  A convention or a map compiles only its candidates; a helper compiles every component of the app,
  since only TypeScript knows its return type.

## Types

`sinter check` checks every edge against the one declaration:

| Where | What is checked |
| --- | --- |
| The tag | `data-sn-prop` keys and types; `data-sn-on-<event>` names and the type of `$event.detail`; slot names |
| The component's markup | bindings read only declared props, its state and globals; `emit()` names match `data-sn-emits` |
| The script | TypeScript, through the generated base class: a misspelled prop, event or ref, or a wrong detail type, is a type error |

Errors in the component are reported in the component's file, followed by where it is used. In the
editor, `sinter lsp` checks a component through the pages that use it, and goes from a tag to its file.

## Ids

A literal `id` in a component used more than once on a page would be on the page more than once:
that is a build error. Compute it from a prop (`data-sn-attr="{ id: 'edit-' + item.id }"`).

## From `<sn-include>`

`<sn-include>` is removed: a partial is a component without a script. The build error (`SN316`) lists
the names the partial read from the page. Move the file to `src/components/<name>.html`, wrap its
markup in `<template data-sn-component="{ … }">` around one root element, declare those names as
props, and pass them with `data-sn-prop`.
