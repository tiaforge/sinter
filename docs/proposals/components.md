# Proposal: components

Status: draft, for discussion. Nothing here is implemented.

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
src/components/live-clock.ts            ...plus a script: also a custom element (today's island)
```

- A component **without a script** costs nothing at runtime. Its markup is expanded at each use,
  like `<sn-include>`, and only its bindings remain.
- A component **with a script** is also expanded at build time, so it paints early. Its script is
  registered as the custom element of the host tag. The script does browser work (timers, canvas,
  observers, third-party libraries, `fetch` outside resources) and writes the component's state;
  sinter renders the markup. No `document.createElement`. See
  [Components with a script](#components-with-a-script).
- Islands become "a component with a script". Plain custom elements with no component file keep
  working as they do today.

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
  CSP change.

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
  elements. It has the same shape and the same meaning, so a script component receives them as
  properties.
- **Props are live and read-only.** A prop is an expression evaluated in the caller's scope where
  the component reads it, as `data-sn-let` works today. Nothing is copied, so a change from a
  server event shows at once. A component that assigns to a prop fails the build. It changes its
  own `data-sn-state` instead, or emits an event.
- **Events come out with `emit()`**, which exists today. The caller handles them with
  `data-sn-on-<event>` on the host, and `$event.detail` has the type `data-sn-emits` gives it.
- **Slots are resolved at build time**: the default `<slot>`, named slots (`slot="meta"`) and
  fallback content. Slot content keeps the caller's scope. In the example, `a` and `date()` still
  refer to the caller's loop. It is light DOM, so global CSS, forms, labels and ARIA references
  work across the boundary.
- Other attributes (`class`, `id`, `aria-*`) stay on the host element.

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
import { TaskRingElement } from './task-ring.html'; // generated from the component file, typed

export class TaskRing extends TaskRingElement {
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
- **Lifecycle:**
  - `connected()` runs after the page module has adopted the component's markup, so refs are set.
  - `propsChanged()` runs once per flush in which a prop the script reads changed.
  - `disconnected()` runs when the component leaves the page.
- **State:** `this.state` is the component's `data-sn-state`. Assigning a field schedules a render,
  as a handler does.
- **The script writes only state.** It never writes to nodes sinter renders. A ref is for handing
  an element to code that owns it (a canvas, a map container, an editor), not for setting its text.
- The tag is registered by the generated base class from the file name. There is no
  `customElements.define`.

### One contract

The props, events and refs are declared once, in the component's HTML, because that is the one file
every component has: a markup-only component has no script to declare them in. The script gets them
from a **generated base class**, the same way `src/sinter.messages.d.ts` is generated from the
message files today:

- `import { TaskRingElement } from './task-ring.html'` resolves, through the Vite plugin, to a base
  class that extends sinter's element base and registers the tag.
- A generated `task-ring.html.d.ts` types it:
  - `this.props` from `data-sn-component`
  - `this.emit(name, detail)` from `data-sn-emits`
  - `this.refs` from `data-sn-ref`, typed by tag
  - `this.state` from `data-sn-state`
- Editors get completion and errors from those types, with no sinter TypeScript plugin.

The compiler checks every edge against that one declaration:

| Where | What is checked |
| --- | --- |
| The call site | `data-sn-prop` keys and types; `data-sn-on-<event>` names and the type of `$event.detail`; slot names |
| The component's markup | bindings read only declared props, the component's state and globals; `emit()` names and details match `data-sn-emits` |
| The script | TypeScript, through the generated base: a misspelled prop, event or ref, or a wrong detail type, is a type error |

Changing a prop in the HTML updates the types the next time the dev server or `sinter check` runs,
so a script that still uses the old name fails at once.

### Scope

The component body sees only its props, its own `data-sn-state`, resources, helpers and magic
names. It cannot see the caller's state or loop variables. This is the one new scoping rule, and
the compiler enforces it: reading a caller name in a component is an error that names the prop to
add.

Slot content is the reverse: it sees the caller's scope and none of the component's. Scoped slots,
which pass values from the component to the slot, are an [open question](#open-questions).

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

- **`patch(article, …)` without a resource name** is new. At each use the compiler resolves which
  resource `article` came from: a row of `articles` on the feed, the single `article` on the
  article page.
- **Write-through needs nothing extra**: the response `Article` patches each list that holds it,
  at every use.
- **Comparison:** in Svelte, Vue or Angular the same component takes a store or query library,
  an invalidation strategy, and code for the optimistic update and its rollback. The comparison
  docs already count this for pages (Angular: a 73-line component plus service methods plus the
  parent's toggle handling).

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
- This is the property to protect most carefully when choosing between the open questions below.

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
- **The size of a component ecosystem.** A script component is a standard custom element. Exporting
  components for use outside sinter is a later step; any existing web component already works
  inside sinter through `data-sn-prop` and events.
- **Peak re-render speed.** Stay close to the leaders in `bench/js-framework-benchmark`. The case
  rests on first paint and data correctness.

## Limits that come from expanding at build time

- **Recursive components** (a tree of comments, a file tree) cannot be expanded at build time:
  `SN306` today. They need a runtime path: a component instantiated from a template per level,
  which renders early only for embedded data. This is a real gap against every other system and
  needs a design before release.
- **Choosing a component at runtime** (`<component :is>`): the same problem. A `data-sn-if` per
  candidate covers small cases.
- **HTML size**: each use outside a `data-sn-for` repeats the markup in the built HTML (inside a
  `for`, it is one template). gzip absorbs most of it; measure it on RealWorld.

## What changes elsewhere

- **`<sn-include>`:** a partial is a component with no props and lexical scope. Under "one way to
  do each thing", either partials stay as the lexical-scope tool and components are the isolated
  one, or `<sn-include>` is deprecated. Open question below.
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
3. **`patch(row, …)` with the resource resolved per use.**
4. **Scoped styles** (`@scope`, or a build-time attribute; see below).
5. **Script components:**
   - the generated base class and its `.d.ts`, through the Vite plugin
   - `data-sn-emits`, `data-sn-ref`
   - `this.props`, `this.state`, `this.emit`, the three hooks
   - tag registration from the file name

   Islands become this.
6. **Recursive and dynamic components:** the runtime path.
7. **The RealWorld rewrite**, the comparison docs, the spec, README and `llms.txt`.

## Open questions

1. **Generated files.** Settled: a class extending a generated base, typed from the HTML (see
   [One contract](#one-contract)); no setup-function API. Still open:
   - a `.d.ts` next to each component, or one generated file for the app (as for messages);
   - whether the generated files are committed;
   - how the types stay fresh in an editor without the dev server running (`sinter lsp` could
     write them).
2. **The host element.** Keep `<article-preview>` in the DOM (a styling hook, the target for
   events, visible in devtools; `display: contents` when unwanted), or replace it with the
   template's content? Keeping it breaks components inside `<table>`, `<ul>` and `<select>`, where
   the parser moves unknown elements: Vue's `is` problem. Possibly keep it, except for components
   whose template has a single `<tr>`, `<li>` or `<option>` root.
3. **Scoped slots.** Pass component values to slot content (`<slot data-sn-let="{ item }">`), or
   leave them out at first?
4. **Scoped CSS.** Native `@scope`, which is in every evergreen browser but young in Firefox, or a
   build-time attribute selector? Both keep the CSS in files.
5. **`<sn-include>`.** Keep partials for lexical scope, or deprecate them in favour of components?
6. **Two-way props.** `data-sn-model` on a component, for a custom input? Events cover it, but
   forms are where people will expect it.
7. **Exporting.** Should a script component also build as a standalone custom element for use
   outside sinter, and when?
