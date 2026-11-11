# Proposal: components

Status: implemented (2026-11-10), steps 1 to 7 of the [Plan](#plan); the guide is
[components.md](../components.md). Where the implementation departs from this text: scoped styles use
the root's parent as the `@scope` root (see Defining a component); a value of `<sn-component use>`
outside the candidates renders nothing without a dev warning; write-through still patches nested
entities at the fixed depth the URL names; the comparison docs compare the RealWorld builds before and
after components on one machine (`realworld-comparison.md`, Components) instead of re-running every
implementation.

This reverses a non-goal (`spec.md`: "Routing, a component system, a virtual DOM, transitions";
"components remain a non-goal"). Once sinter has components, they will be compared with Svelte, Vue
SFCs, Lit, Solid and Astro. Matching their feature lists does not win that comparison. These
components should do what the others cannot, because the sinter compiler sees the whole page: its
data, its first paint, and where every value comes from.

## The hallmark: components in the first frame, without hydration

**A component renders in the first frame, with data, on a static host, and its JavaScript never
hydrates it.** Every other decision here serves this.

How the others get content into the first frame:

| | Content in the first frame | Then |
| --- | --- | --- |
| Svelte, Vue, React | needs SSR or prerendering | hydrates: the framework re-runs the components to attach to the HTML |
| Lit, plain web components | nothing until the JS runs (Lit SSR with declarative shadow DOM is the exception) | renders |
| Astro components | yes, rendered on the server | static; interactivity means a framework island that hydrates |
| sinter components | yes: build-time constants, the early script, embedded data | the page module adopts the DOM as it does for pages today; nothing re-renders |

sinter already does this for pages ([first-paint.md](../first-paint.md)): build-time constants,
an early script that renders bindings while the parser inserts elements, and embedded JSON for API
data. Components keep it by being **expanded at build time**. After expansion, a component's
markup is page markup, so everything that renders early on a page renders early in a component.
There is no component runtime to hydrate.

## Design

### Two kinds, one file format

```
src/components/article-preview.html     markup only: expanded at build time, no runtime
src/components/live-clock.html          markup...
src/components/live-clock.ts            ...plus a script, run per instance by sinter (today's island)
```

- A component **without a script** costs nothing at runtime. Its markup is expanded at each use,
  like `<sn-include>`, and only its bindings remain.
- A component **with a script** is also expanded at build time, so it paints early. sinter runs
  its script once per instance, on the instance's root element (see [The tag](#the-tag-replaced-by-the-root)).
  It is not a custom element. The script does browser work (timers, canvas,
  observers, third-party libraries, `fetch` outside resources) and writes the component's state;
  sinter renders the markup. No `document.createElement`. See
  [Components with a script](#components-with-a-script).
- Islands become "a component with a script". Plain custom elements with no component file
  (your own or third-party web components) keep working as they do today, through `data-sn-prop`
  and events.

### Defining a component

```html
<!-- src/components/article-preview.html -->
<template data-sn-component="{ article: Article; compact?: boolean }">
  <article class="preview" data-sn-class="{ compact }">
    <a data-sn-attr="{ href: '/article/' + article.slug }"><h2 data-sn-text="article.title"></h2></a>
    <slot name="meta"></slot>
    <p data-sn-text="article.description"></p>
    <slot></slot>
  </article>
</template>

<style>
  .preview { padding: var(--space-md); }
  .compact p { display: none; }
</style>
```

- The tag name is the file name, which must contain a `-`. A component may be used on every page.
- `data-sn-component` holds the props type, written in TypeScript and using the names
  `src/sinter.types.ts` exports, like `<sn-resource type>`. An optional prop gets its default
  from `data-sn-state` on the root, or is `undefined`.
- `data-sn-emits` (optional) declares the events the component emits and their detail types:
  `data-sn-emits="{ select: Article }"`. An `emit()` in the component with a name not declared there
  is a build error.
- Together, these two attributes are the component's whole contract. Nothing else declares it: not
  the caller, and not the script (see [One contract](#one-contract)).
- `<style>` is scoped to the component and goes into the app's CSS files: no inline style, no
  CSP change. The compiler wraps it in native `@scope`. (Implemented with the root's parent as the
  scope root, `@scope (:has(> [data-sn-c="article-preview"])) to (:scope > :not([data-sn-c="article-preview"]), :scope > * [data-sn-c])`:
  selectors in `@scope` match only descendants of the scope root, so `([data-sn-c="article-preview"]) to ([data-sn-c])`
  would not let `.preview` match the root itself; see spec.md, Components.)
  - The root of each instance carries `data-sn-c` with the component's name, in production too
    (only for components that have styles; others keep it in dev builds only).
  - The `to` boundary stops the styles at nested components, and at slot content, which the
    compiler marks with the same boundary.
  - Selectors stay as written, with their normal specificity; devtools show them unchanged.
  - `@scope` is in Chrome, Safari, and Firefox since late 2025, so every browser sinter supports
    ("current Chromium, Firefox and Safari", README) has it. An older browser ignores the block,
    and the component shows unstyled.

### Using a component

```html
<template data-sn-for="a in articles">
  <article-preview data-sn-prop="{ article: a, compact: narrow }" data-sn-on-select="sel = $event.detail">
    <span slot="meta" data-sn-text="date(a.createdAt)"></span>
    <favorite-button data-sn-prop="{ article: a }"></favorite-button>
  </article-preview>
</template>
```

- **Props go in through `data-sn-prop`**, the attribute that already sets properties on custom
  elements: the same shape, and the same meaning of "values for this thing". A component's script
  reads them as `this.props`.
- **Props are live and read-only.** A prop is an expression evaluated in the caller's scope where
  the component reads it, as `data-sn-let` works today. Nothing is copied, so a change from a
  server event shows at once. A component that assigns to a prop fails the build. It changes its
  own `data-sn-state` instead, or emits an event.
- **Events come out with `emit()`**, which exists today. The caller handles them with
  `data-sn-on-<event>` on the component's tag, and `$event.detail` has the type `data-sn-emits`
  gives it.
- **Slots are resolved at build time**: the default `<slot>`, named slots (`slot="meta"`) and
  fallback content. Slot content keeps the caller's scope. In the example, `a` and `date()` still
  refer to the caller's loop. It is light DOM, so global CSS, forms, labels and ARIA references
  work across the boundary.
- Other attributes (`class`, `id`, `aria-*`, layout attributes such as temper's `data-grow`) and
  handlers move onto the component's root element (next section).

### Custom inputs: `data-sn-model`

A component can be bound like a form control. `data-sn-model` on a component is two-way, as it is
on `<input>`: the component shows the state value, and its changes write it back.

```html
<form data-sn-put="/api/contacts/{draft.id}" data-sn-body="draft">
  <rating-input data-sn-model="draft.stars"></rating-input>
  <button>Save</button>
</form>
```

- **It is shorthand, not a new mechanism:** `data-sn-model="draft.stars"` is
  `data-sn-prop="{ value: draft.stars }"` plus `data-sn-on-change="draft.stars = $event.detail"`.
- **The component opts in** by declaring a `value` prop and a `change` event
  (`data-sn-emits="{ change: number }"`). `data-sn-model` on a component without them is a build
  error, and the compiler checks that the state path's type matches `value`.
- **It binds state, never a resource,** as on `<input>`: resources are read-only in expressions
  (`SN205`). The usual flow is the form dialog's: copy the row into a draft
  (`draft = structuredClone(c)`), bind the draft's fields, and save with the form's action;
  write-through then patches the resource. To save on each change instead, use an action on the
  component's event with an optimistic `patch`:

  ```html
  <rating-input data-sn-prop="{ value: c.stars }"
                data-sn-patch="/api/contacts/{c.id}" data-sn-trigger="change"
                data-sn-body="{ stars: $event.detail }"
                data-sn-optimistic="patch(c, { stars: $event.detail })"></rating-input>
  ```
- **`data-sn-persist`** works with it, as on `<input>`.
- **Form integration** (a `name` submitted with the form, `reset()`, validation) is not part of it
  at first: the form's action sends the draft through `data-sn-body`. It can come later, once the
  form cases are clear.

### The tag: replaced by the root

The component's tag does not stay in the page. **Each use is replaced by the component's root
element**, for components with and without a script alike:

- **A component has exactly one root element.** It is what the caller's attributes, classes and
  `data-sn-on-*` handlers land on. More than one root is a build error.
- **Attributes merge onto the root:** `class` is joined, a `data-sn-class` or `data-sn-attr` on the
  tag combines with the root's, and a plain attribute the root also sets is a build error rather
  than a silent override.
- **Styling from outside works through the root.** A parent's layout reaches the component's root
  as its direct child: `grid-column`, `flex`, `data-layout` children. No `display: contents`
  wrapper gets in the way. Styling a component's inside from outside is not supported; scoped
  styles are the way.
- **Events:** `emit()` inside the component bubbles up through the root, where the caller's handler
  now sits.
- **Tables and lists:** a component whose root is a `<tr>`, `<li>` or `<option>` *is* that element.
  - Inside `<template data-sn-for>`, where rows come from, the tag can be written as it is. The
    compiler parses with the browser's rules (parse5), and template content keeps it in place.
  - Directly in a `<tbody>` or `<table>`, the parser moves an unknown tag out of the table before
    the compiler sees it. The compiler detects that from source positions and fails the build with
    the fix (put it in the row's template).
- **Devtools:** the root carries the component's name (`data-sn-c="article-preview"`): in dev
  builds always, in production builds for components with styles, which scope by it.
- **Scripts need no tag.** The compiler knows every place a component is used, including inside
  templates, and the runtime already creates and removes those elements. It starts the component's
  script for each instance when the root is created or adopted, and stops it when it is removed,
  as it does for bindings. No `customElements.define`, no upgrade timing, no "do not read children
  in `connectedCallback`".

### Components with a script

A component gets a script when it needs the browser or a third-party library. Here a task ring is
drawn with Chart.js:

```html
<!-- src/components/task-ring.html: the only contract -->
<template data-sn-component="{ done: number; open: number }" data-sn-emits="{ pick: 'done' | 'open' }">
  <figure>
    <canvas data-sn-ref="canvas" role="img" data-sn-attr="{ 'aria-label': done + ' of ' + (done + open) + ' done' }"></canvas>
    <figcaption data-sn-text="done + ' / ' + (done + open)"></figcaption>
  </figure>
</template>
```

```ts
// src/components/task-ring.ts
import Chart from 'chart.js/auto';                 // any npm package: bundled with the pages that use the component
import { TaskRingComponent } from './task-ring.html'; // generated from the component file, typed

export class TaskRing extends TaskRingComponent {
  #chart?: Chart;

  connected() {                                     // the markup is rendered; refs are set
    this.#chart = new Chart(this.refs.canvas, {     // HTMLCanvasElement
      type: 'doughnut',
      data: { labels: ['Done', 'Open'], datasets: [{ data: [this.props.done, this.props.open] }] },
      options: { onClick: (_e, [hit]) => hit && this.emit('pick', hit.index ? 'open' : 'done') },
    });
  }

  propsChanged() {                                  // a live prop changed: a server event, a filter
    this.#chart!.data.datasets[0].data = [this.props.done, this.props.open];
    this.#chart!.update();
  }

  disconnected() { this.#chart?.destroy(); }
}
```

```html
<!-- any page -->
<task-ring data-sn-prop="{ done: doneCount(tasks), open: openCount(tasks) }"
           data-sn-on-pick="show = $event.detail"></task-ring>
```

- **First frame:** the caption and the `aria-label` are ordinary bindings, so they are in the first
  frame. The library draws the ring once the page module runs.
- **External code is an import.** The bundler puts it in the pages that use the component, and
  nowhere else.
- **`data-sn-ref="name"`** gives the script an element of its own markup as `this.refs.name`, with
  the type of its tag. A ref inside a `data-sn-for` or `data-sn-if` template is `undefined` while
  it is not rendered; the generated type says so.
- **`this.root`** is the instance's root element (the `<figure>`); `this.emit()` dispatches from
  it. `this` is not an element: the script is an object sinter creates per instance.
- **Lifecycle, driven by sinter:**
  - `connected()` runs once the instance's markup is rendered or adopted, so refs are set.
  - `propsChanged()` runs once per flush in which a prop the script reads changed.
  - `disconnected()` runs when sinter removes the instance: its row, its `data-sn-if` branch, or
    the page.
- **State:** `this.state` is the component's `data-sn-state`. Assigning a field schedules a render,
  as a handler does.
- **The script writes only state.** It never writes to nodes sinter renders. A ref is for handing
  an element to code that owns it (a canvas, a map container, an editor), not for setting its text.
- Nothing is registered: the compiler links the script to the component by its file name.

### One contract

The props, events and refs are declared once, in the component's HTML, because that is the one file
every component has: a markup-only component has no script to declare them in. The script gets them
from a **generated base class**, the same way `src/sinter.messages.d.ts` is generated from the
message files today:

- `import { TaskRingComponent } from './task-ring.html'` resolves, through the Vite plugin, to a
  base class that extends sinter's component base.
- Generated types describe it:
  - `this.props` from `data-sn-component`
  - `this.emit(name, detail)` from `data-sn-emits`
  - `this.refs` from `data-sn-ref`, typed by tag
  - `this.state` from `data-sn-state`
- Editors get completion and errors from those types, with no sinter TypeScript plugin.
- **One file for the app:** the types of every component with a script go in
  `src/sinter.components.d.ts`, beside `src/sinter.messages.d.ts`, not in a file per component.
- **Handled like the messages file:** written on every build and `sinter check`, so an app may
  commit it or git-ignore it; the starter template commits both.
- **Current while editing:** `sinter lsp` rewrites it when a component's HTML changes, so the
  editor's types are current without the dev server running.

The compiler checks every edge against that one declaration:

| Where | What is checked |
| --- | --- |
| The call site | `data-sn-prop` keys and types; `data-sn-on-<event>` names and the type of `$event.detail`; slot names |
| The component's markup | bindings read only declared props, the component's state and globals; `emit()` names and details match `data-sn-emits` |
| The script | TypeScript, through the generated base: a misspelled prop, event or ref, or a wrong detail type, is a type error |

Changing a prop in the HTML updates the types at once in the editor (through `sinter lsp`), and on
the next build or `sinter check`, so a script that still uses the old name fails at once.

### Scope

The component body sees only its props, its own `data-sn-state`, resources, helpers and magic
names. It cannot see the caller's state or loop variables. This is the one new scoping rule, and
the compiler enforces it: reading a caller name in a component is an error that names the prop to
add.

Slot content is the reverse: it sees the caller's scope and none of the component's.

**No scoped slots at first.** A component cannot pass values to its slot content (Vue's
`v-slot="{ item }"`, Svelte's `let:item`). The caller writes the loop itself, which a sinter page
does easily. If they are needed later, the form would be a `<slot data-sn-let="{ item }">` whose
names the slot content reads through `$slot` (`data-sn-let="{ c: $slot.item }"`), declared in the
caller's markup and typed across the boundary. That can be added without breaking anything.

## Where sinter components win

### 1. The first frame (the hallmark)

See above. A `<live-clock>` with `data-sn-state="{ now: '--:--' }"` has `--:--` in the built HTML
even without scripts. A component that reads a persisted value or a message shows it before the
first paint. One inside a `data-sn-for` over embedded data renders with the rows, during the parse.

### 2. Components that understand server data

The compiler already knows what an action is about (provenance, `spec.md` "Write-through"):
`{a.slug}` with `a in articles` names a row of `articles`. Because components are expanded at each
use, a prop keeps that provenance. Here is the RealWorld favorite button as a component, used on
the feed, the profile and the article page:

```html
<!-- src/components/favorite-button.html -->
<template data-sn-component="{ article: Article }">
  <button class="btn btn-sm"
          data-sn-class="{ 'btn-primary': article.favorited, 'btn-outline-primary': !article.favorited }"
          data-sn-post="/api/articles/{article.slug}/favorite"
          data-sn-optimistic="patch(article, { favorited: true, favoritesCount: article.favoritesCount + 1 })">
    <i class="ion-heart"></i> <span data-sn-text="article.favoritesCount"></span>
  </button>
</template>
```

- **`patch(article, …)` takes no resource name** (see [Store functions](#store-functions-resolved-from-the-item)).
  It changes the article where it came from at each use: a row of `articles` on the feed, the
  single `article` on the article page.
- **Write-through needs nothing extra**: the response `Article` patches each list that holds it,
  at every use.
- **Comparison:** in Svelte, Vue or Angular the same component takes a store or query library,
  an invalidation strategy, and code for the optimistic update and its rollback. The comparison
  docs already count this for pages (Angular: a 73-line component plus service methods plus the
  parent's toggle handling).

#### Store functions: resolved from the item

This applies to pages too, not only components. **`patch(item, …)` and `remove(item)` act on the
item in the resource it came from, found by its key. They take no resource name. Other resources
that hold the same entity follow from write-through and server events.**

| Call | Meaning |
| --- | --- |
| `patch(a, { … })` | change the item in the resource it came from; everything that reads that resource shows the change |
| `remove(m)` | take it out of the resource it came from (archived, moved, deleted), wherever that resource is shown; a single resource becomes `null` |
| `upsert('contacts', x)`, `upsert(c.replies, x)` | add it to this list: a resource by name, or a nested list that has a source (a new item has none of its own) |
| `refresh('name')`, `page('name', …)` | unchanged: they act on a resource, not an item |

- **Where the item came from** is resolved the way write-through resolves what an action is about:
  - a loop row: `m in messages` is a row of `messages`; for `a in (x ? feed : articles)`, the list
    the row is shown from;
  - an element of a resource: `contacts[0]`;
  - a single resource: `patch(article, …)`;
  - state assigned from one of those in the page's handlers: `sel = p` with `p in messages` makes
    `sel` a row of `messages`;
  - in a component, a prop, which keeps its provenance from the caller. An event detail that is a
    prop keeps it too, so the caller's `data-sn-on-select="remove($event.detail)"` works.
  - a nested item: `r in comment.replies`, at any depth in a recursive component (see
    [Nested items](#nested-items-along-their-path)).
  - a row that came through a helper: `m in visible(messages, q)`, or
    `r in childrenOf(comments, c.id)` over a flat list with parent ids. **A helper that takes one
    resource and returns its element type keeps that resource's provenance:**
    - The compiler reads it from the helper's types: one argument whose source is a resource (or a
      nested list with a source), and a return type of that argument's element type, or an array
      of it.
    - It composes: `m in visible(sorted(messages), q)` is still a row of `messages`.
    - More than one argument with a source and the returned element type is a build error naming
      the helper, since the source would be ambiguous.
    - A helper that returns another type (mapped objects, counts) gives values with no source, as
      before.
    - A helper may return copies: `patch` and `remove` find the item in the resource by its key,
      not by object identity.
- **An item with no source is a build error** that names the right tool:

  | Item | Instead |
  | --- | --- |
  | a key literal, `patch('items', {id: 1}, …)` | write it as a row: `patch(items[0], …)`. Only `test/behaviour/selection.test.ts:91` uses this form today; it needs a row change, not a key literal, and is rewritten with the migration |
  | `$result` | with a spec, write-through already applies the response; else patch the row with `$result`'s fields |
  | a server event's payload | `<sn-event resource op>`, which keeps its `resource` |
  | `$event.detail` from a script component | the script itself, through the JS API, which holds the resource handle |
  | a state field assigned from an untraceable value | the error names the assignment |

- **Every instance in the resource, no other resource.** The change is to the resource's item,
  found by its key (by identity in a resource without `key`), not to the copy that was clicked. So
  every place that shows that resource shows it:
  - every `data-sn-for` over it, including a filtered or sorted one (`m in visible(messages, q)`);
  - every `data-sn-let` derived from it, such as `selected` found by `selectedId` in a reading pane;
  - every loaded page of a paginated or `append` resource;
  - the same row passed to several components.

  The same entity in **another** resource (the same `Article` in `feed` and in `articles`) is not
  patched. It is a different resource, with its own request, and it follows from the response and
  from events (next point).
- **State that holds a row is a snapshot, and stays one.** sinter keeps resources current, and
  `data-sn-let` names derived from them. It does not rewrite values held in state: an old value
  there may be intentional. The form dialog keeps `draft = structuredClone(p)` so the user's edits
  survive a server event that changes the row.
  - `patch(sel, …)` still finds the right item through its key; only bindings that read `sel`
    itself show the old values.
  - To show the current row, keep its key in state and derive the row with `data-sn-let`
    (`islands.md` does this with `selectedId`).
- **Other resources holding the same entity follow from the response and from events.** Write-through
  rule 1 patches every keyed list of the response's schema, and server events do the same for
  changes made elsewhere. RealWorld has a spec and no SSE: its feed patches `'articles'` and
  `'feed'` one after the other today (`examples/realworld/index.html:56`), but the second patch
  only updates the hidden tab during the request, and rule 1 updates it when the response arrives.
  `patch(a, …)` is enough.
- **Why not "everywhere" for `patch`:**
  - Without a spec, "the same key in another resource" is ambiguous (`id: 3` in `messages` and in
    `contacts`), so it could only mean "the source" on untyped pages: two behaviours under one name.
  - For `remove`, "everywhere" would be wrong for archive and move.
  - Both functions follow the same rule, and consistency across lists has one owner, not two.
- **What is lost:** while a request runs, another copy of the entity on the same page keeps the old
  value. For example, a mail row beside a reading pane that loads the same message as a single
  resource: flag it in the pane, and the row's flag changes when the response arrives. If that
  turns out to matter, the fix is in the engine, not in these functions: **write-through rule 1
  applied to optimistic changes**, on pages with a spec. That would be a later addition.
- **Migration:** `patch('name', item, …)` and `remove('name', item)` are removed. Drop the first
  argument; the build error for the old forms says so. A call that removed or patched an item in a
  list other than its source becomes `refresh('name')`, or is left to write-through and events.

### 3. Composition that costs nothing at runtime

- A markup-only component leaves nothing at runtime: no instance, no boundary, no props object.
- Ten levels of layout components cost exactly what the flat markup would. Svelte and Solid also
  compile, but they keep a component boundary at runtime.
- The 11 KB core budget does not grow for markup-only components.

### 4. Types from the API spec to every prop

`sinter check` already types pages against OpenAPI. Props are checked at each use:

- Passing a `Profile` where `article: Article` is expected is an error at the call site.
- `$event.detail` of a component event is typed by `data-sn-emits`.
- Slot names are checked.
- A component's script is typed from the same declaration ([One contract](#one-contract)): there
  is no second copy to drift.

This closes the gaps that exist today for islands: `data-sn-prop` is unchecked, `$el` on a custom
element is plain `HTMLElement`, and `$event.detail` is `any`.

### 5. CSP-safe, small vocabulary, easy for an LLM to write correctly

- No eval, no runtime templates.
- The additions are three attributes (`data-sn-component`, `data-sn-emits`, `data-sn-ref`), native
  `<slot>` and `slot=""`, `<style>` in a component file, and for scripts a generated base class
  with three hooks.
- Every mistake is a build error with a suggestion.
- This is the property to protect most carefully as the design grows.

## Table stakes

Missing any of these loses the comparison regardless of the hallmark:

- typed props with errors at the call site
- default and named slots, and fallback content
- typed events
- scoped styles
- an imperative escape hatch (the script)
- editor support: completion of components, props and slots, go-to-definition, hover; HMR in dev
- testing: `render()` of a single component with props, from `@tiaforge-ui/sinter/testing`
- clear diagnostics through component boundaries: the line in the component, then the use site,
  as partials do today

## What we do not compete on

- Client-side routing and a virtual DOM. These stay non-goals.
- **The size of a component ecosystem.** Any existing web component already works inside sinter
  through `data-sn-prop` and events. sinter components are not custom elements; using them outside
  sinter would need a generated wrapper, which is left for after the first release
  ([Decisions](#decisions)).
- **Peak re-render speed.** Stay close to the leaders in `bench/js-framework-benchmark`. The case
  rests on first paint and data correctness.

#### Nested items: along their path

In a tree, an item is not a row of a resource but nested in one: `comments[3].replies[1].replies[0]`.
The same rule applies, along the path.

- **`patch(r, …)` and `remove(r)`** act on `r` where it came from inside its top-level row. The
  runtime knows the path, because it created each level from its parent. Items are immutable, so
  it replaces the objects along the path, and every view of that row updates.
- **Nested loops need keys** (`data-sn-key`, or the schema's key), so that the path still finds the
  item after the list changed: a reply added above it moves its index, not its key.
- **`upsert` takes the list the item joins:** `upsert(c.replies, $result)` adds a reply to a reply,
  optimistically. `c.replies` has a source, so the compiler knows where it is; a resource name
  stays the form for top-level lists.
- **Write-through** already patches "a nested entity at its path" when the URL named it, at a fixed
  depth today. It follows the same paths at any depth.

## Recursion and choosing a component at runtime

Expanding at build time cannot handle a component that uses itself, or one chosen by data. Both are
handled by one mechanism: **a shared definition, instantiated at runtime, as `data-sn-for` already
instantiates its template per item.**

### Shared definitions

- The compiler compiles the component's body **once**, as a definition.
- In the built HTML, the definition is a `<template>` in the `<head>`, so the parser has it before
  the body.
- The early script clones it per item while the parser runs, as `each()` clones a row template
  today (`src/early.ts`). A tree or a block list in embedded data is in the first frame **at any
  depth**, and the page module adopts it as it adopts rows.
- Uses outside templates are still expanded in place, as page markup, with build-time constants
  and everything else. Only the uses described below go through a definition.

### Recursion

A component uses itself by its own tag; there is no special element (Svelte 5 dropped
`<svelte:self>` for the same form):

```html
<!-- src/components/comment-thread.html -->
<template data-sn-component="{ comment: Comment }">
  <li>
    <p data-sn-text="comment.body"></p>
    <ul>
      <template data-sn-for="r in comment.replies" data-sn-key="r.id">
        <comment-thread data-sn-prop="{ comment: r }"></comment-thread>
      </template>
    </ul>
  </li>
</template>
```

- **Every cycle must pass through a `data-sn-for` or `data-sn-if` template**, because only data
  ends it. The inner use becomes a reference to the shared definition. A cycle that does not pass
  through a template would recurse forever: a build error showing the cycle. The same rule covers
  mutual recursion (A uses B, B uses A).
- Nested items are changed along their path: [Nested items](#nested-items-along-their-path).

### Choosing a component at runtime

A list of mixed blocks (a CMS page, dashboard widgets, a form builder) picks a component per item:

```html
<template data-sn-for="b in blocks" data-sn-key="b.id">
  <sn-component use="`${b.type}-block`" data-sn-prop="{ block: b }"></sn-component>
</template>
```

- **The compiler needs every candidate at build time.** The generated `src/sinter.components.d.ts`
  has a `ComponentName` type, the union of every component in the app (a component's name is its
  file name). `use` must have a type that fits it, and **its members are the candidates**.
- Three ways to write the mapping, one check:

  | Form | Example | For |
  | --- | --- | --- |
  | Convention, from the data | ``use="`${b.type}-block`"`` | names that follow the data; TypeScript types a template string contextually typed by a literal union as the template-literal type (since 4.3), so the enum `'hero' \| 'text' \| 'image'` gives the candidates |
  | Map in the markup | `use="{ hero: 'hero-block', text: 'rich-text' }[b.type]"` | names that do not follow a convention; untyped pages |
  | Helper | `use="blockComponent(b)"` | logic, such as a fallback; the helper's return type, a literal union, gives the candidates |

  `b.type + '-block'` is typed `string` by TypeScript, so it fails the check; the error points to
  the template-string form.
- **A missing component is a build error** at the use: "`'image-block'` is not a component; create
  `src/components/image-block.html`". A new block type in the API spec breaks the build until its
  component exists.
- **Props are checked per candidate, narrowed.** Blocks are usually a discriminated union
  (`Block = HeroBlock | TextBlock | …`). For the convention and the map, the compiler knows which
  candidate belongs to which `b.type`, so it narrows `b` per candidate: `hero-block` can declare
  `{ block: HeroBlock }`. A helper hides that link, so its candidates take the whole `Block`.
- **A value outside the candidates at runtime** renders nothing, with a warning in dev builds, or
  the `data-sn-else` template that follows the element.
- Only the candidates are compiled into the page's definitions, and only their scripts are bundled.
- `<sn-component>` is the one new element; its `use` attribute is an expression.

## Limits that come from expanding at build time

- **HTML size**: each use outside a `data-sn-for` repeats the markup in the built HTML (inside a
  `for`, it is one template). gzip absorbs most of it; measure it on RealWorld.

## What changes elsewhere

- **`<sn-include>` is removed (breaking).** A partial is a component without a script, so keeping
  both would be two ways to do one thing.
  - **Scope is the one real difference.** A partial sees the scope where it is inserted, while a
    component sees only its props. A partial that reads outer names, such as a dialog that uses the
    page's `draft`, takes them as props.
  - **The migration is checked.** The compiler already checks each partial against each page that
    includes it, so it knows which outer names a partial reads. `<sn-include>` becomes a build error
    that lists them: "`contact-dialog` reads `draft`, `save`: add them to `data-sn-component` and
    pass them with `data-sn-prop`". Moving the file to `src/components/` and renaming the tag
    completes it.
  - **IDs inside components.** `showModal('edit')`, `close('edit')` and `run('id')` check their id
    against the page and, today, its partials (`SN309`, `SN311`). They look inside the components a
    page uses instead. A component used more than once whose markup has a literal `id` would make
    duplicate ids: a build error, unless the id is computed from a prop.
  - **Diagnostics move:** `SN305` (partial not found) is retired. `SN306` (partial cycle) becomes
    the component cycle that does not pass through a template
    ([Recursion](#recursion)).
  - **What uses partials today:** the starter template (`partials/header.html`), test fixtures,
    the LSP, the Vite plugin's file watching and the docs. All move to components with the
    implementation.
- **Docs:**
  - `spec.md`: drop the non-goal.
  - README: "No components to write" becomes "components that need no hydration and no store".
  - `islands.md` becomes "Components with a script". Its rule "sinter never touches an island's
    children" is already untrue today: markup inside a custom element is bound like the rest of
    the page.

## Proof

Before release, rebuild RealWorld with components and update both comparison docs:

- `realworld-comparison.md`: source size, download size, Lighthouse, the favorite button.
- `first-paint-comparison.md`: the first frame with data.

The claim to support: **the same app, with components, paints with data in the first frame and
has no store code**. `npm run size` must show the core unchanged.

## Plan

1. **Typing gaps, needed with or without components:** check `data-sn-prop` keys and types; give
   `$el` the app's `HTMLElementTagNameMap`; type `$event.detail` of custom events. Correct the
   `islands.md` rule about children.
2. **Markup-only components:**
   - discovery in `src/components/`
   - `data-sn-component` props
   - isolated scope
   - slots
   - diagnostics, `sinter check`, LSP
   - first paint through components, with tests
   - removing `<sn-include>`: the migration error, ids across components, the template's header
   - `data-sn-model` on components: the `value` prop and `change` event, checked
3. **Store functions:** `patch(item, …)` and `remove(item)` resolved from where the item came from,
   replacing the forms with a resource name; provenance through state assignments, component
   props and helpers that return a resource's element type. This step is useful for pages on its own and can ship before components.
4. **Scoped styles** through native `@scope`, with the slot boundary.
5. **Script components:**
   - the generated base class through the Vite plugin, typed by `src/sinter.components.d.ts`
   - `data-sn-emits`, `data-sn-ref`
   - `this.props`, `this.state`, `this.root`, `this.emit`, the three hooks
   - running a script per instance on its root, in rows and branches too

   Islands become this.
6. **Recursion and runtime choice:** shared definitions in the head, instantiated by the runtime
   and the early script; the cycle rule; nested items along their path and `upsert(list, …)`;
   `<sn-component use>`, `ComponentName`, narrowing per candidate.
7. **The RealWorld rewrite**, the comparison docs, the spec, README and `llms.txt`.

## Decisions

Settled in review, in the order they were discussed:

| Question | Decision | Section |
| --- | --- | --- |
| First paint | A hard requirement: components render in the first frame and never hydrate | [The hallmark](#the-hallmark-components-in-the-first-frame-without-hydration) |
| The script's contract | Declared once in the HTML; the script extends a generated base class | [One contract](#one-contract) |
| `patch` and `remove` | Take the item, act on the resource it came from, no resource name | [Store functions](#store-functions-resolved-from-the-item) |
| State holding a row | Stays a snapshot; derive the current row with `data-sn-let` | [Store functions](#store-functions-resolved-from-the-item) |
| Generated files | One `src/sinter.components.d.ts`, handled like the messages file, kept current by `sinter lsp` | [One contract](#one-contract) |
| The tag | Replaced by the single root element; scripts run per instance, not as custom elements | [The tag](#the-tag-replaced-by-the-root) |
| Scoped slots | None at first; an additive form is sketched | [Scope](#scope) |
| Scoped CSS | Native `@scope`, with nested components and slot content as the boundary | [Defining a component](#defining-a-component) |
| `<sn-include>` | Removed (breaking); partials become components | [What changes elsewhere](#what-changes-elsewhere) |
| Two-way props | `data-sn-model` on components, as shorthand for a `value` prop and a `change` event | [Custom inputs](#custom-inputs-data-sn-model) |
| Exporting | Not now; revisit after the first release | [What we do not compete on](#what-we-do-not-compete-on) |
| Recursion | A component uses itself by its tag; every cycle passes through a `for` or `if` template; shared definitions keep it in the first frame | [Recursion](#recursion) |
| Nested items | `patch` and `remove` along their path; `upsert` takes the list, nested or by name | [Nested items](#nested-items-along-their-path) |
| Choosing at runtime | `<sn-component use>`; candidates from a type that fits `ComponentName`, props narrowed per candidate | [Choosing a component at runtime](#choosing-a-component-at-runtime) |
| Rows through a helper | A helper that takes one resource and returns its element type keeps that resource's provenance | [Store functions](#store-functions-resolved-from-the-item) |
| Leaving the first frame | Added after review: `data-sn-early="off"` on a component's tag leaves that use out of the early script, for uses that accept the layout shifting when they render | [components.md](../components.md) |
