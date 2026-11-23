# Components with a script

Attributes cover showing and changing API data. For imperative work such as editors, canvases, charts
or a third-party library, give a [component](components.md) a script: a file beside its HTML with the
same name (`task-ring.ts` beside `task-ring.html`, in `src/components/` or in the component's
[own folder](components.md#where-its-files-go), `src/components/task-ring/`). sinter renders the markup (so it is in the first frame, with data); the script does the
browser work and writes the component's state.

```html
<!-- src/components/task-ring.html: the only contract -->
<template data-sn-props="{ done: number; open: number }" data-sn-emits="{ pick: 'done' | 'open' }">
  <figure>
    <canvas data-sn-ref="canvas" role="img" data-sn-attr="{ 'aria-label': done + ' of ' + (done + open) + ' done' }"></canvas>
    <figcaption data-sn-text="done + ' / ' + (done + open)"></figcaption>
  </figure>
</template>
```

```ts
// src/components/task-ring.ts
import Chart from 'chart.js/auto';                    // any npm package: bundled with the pages that use the component
import { TaskRingComponent } from './task-ring.html'; // generated from the component file, typed

export class TaskRing extends TaskRingComponent {
  #chart?: Chart;

  connected() {                                       // the markup is rendered; refs are set
    this.#chart = new Chart(this.refs.canvas, {       // HTMLCanvasElement
      type: 'doughnut',
      data: { labels: ['Done', 'Open'], datasets: [{ data: [this.props.done, this.props.open] }] },
      options: { onClick: (_e, [hit]) => hit && this.emit('pick', hit.index ? 'open' : 'done') },
    });
  }

  propsChanged() {                                    // a live prop changed: a server event, a filter
    this.#chart!.data.datasets[0]!.data = [this.props.done, this.props.open];
    this.#chart!.update();
  }

  disconnected() { this.#chart?.destroy(); }
}
```

```html
<!-- any page -->
<task-ring data-sn-with="{ done: doneCount(tasks), open: openCount(tasks) }"
           data-sn-on-pick="show = $event.detail"></task-ring>
```

- **First frame:** the caption and the `aria-label` are bindings, so they are in the first frame. The
  library draws once the page module runs.
- **Nothing is registered.** The script is found by its file name. It exports the class named after the
  component (`TaskRing` for `task-ring`), or a default export. It is not a custom element: no
  `customElements.define`, no upgrade timing.
- **External code is an import**, bundled with the pages that use the component and nowhere else.
- **One contract.** The props, events and refs are declared once, in the HTML. The script extends the
  base class generated from it, so `this.props`, `this.emit()`, `this.refs` and `this.state` are typed
  by the HTML (through `src/sinter.components.d.ts`, below), and a misspelled prop, event or ref is a
  type error in the script.
- **`data-sn-ref="name"`** gives the script an element of its own markup as `this.refs.name`, typed by
  its tag. A ref inside a `data-sn-for` or `data-sn-if` template is `undefined` while it is not
  rendered, and its type says so. Elements of nested components and of slot content are not refs.
- **`this.root`** is the instance's root element; `this.emit(name, detail)` dispatches a declared event
  from it (bubbling, cancelable). `this` is not an element: it is an object sinter creates per instance.
- **`this.early`** is `true` when the component's [early renderer](components.md#early-renderers) filled the root
  before the page module loaded: keep what is there.
- **`this.state`** is the root's `data-sn-state` (a component with a script always has one). Assigning
  a field renders, as a handler does: `this.state.loaded = true`.
- **Lifecycle, driven by sinter:**
  - `connected()` runs once the instance's markup is rendered or adopted, so refs are set.
  - `propsChanged()` runs once per render in which a prop changed.
  - `disconnected()` runs when sinter removes the instance: its row, its `data-sn-if` branch, or the
    page.
  Inside a `data-sn-for` or `data-sn-if`, each instance has its own object, started when its root is
  created and ended when it is removed.
- **A script that imports a [lazy package](lazy.md#component-scripts)** (`sinter({ lazy: ['chart.js'] })`),
  directly or through your modules, loads with it when the component first renders: `connected()` runs
  once both have arrived, with the props of that moment; an instance removed before then never starts.
  The markup does not wait.
- **The script writes only state.** It never writes to nodes sinter renders. A ref is for handing an
  element to code that owns it (a canvas, a map container, an editor), not for setting its text.
- **A script that builds elements itself** (a renderer for a large tree, faster than a template per node) writes
  them into an element sinter renders empty, and holds what it writes to the rules of markup with
  `attrAllowed(el, name, value)` and `styleAllowed(value)` from `@tiaforge-ui/sinter`: a URL attribute only with an
  allowed scheme (the app's `configure({ urlSchemes })` included), no style value that can load a URL. It creates
  elements with `createElement` and text with `new Text()`, never parses markup, so the page's CSP and Trusted
  Types need nothing. A component can keep its template for what the build renders and use such a script for the
  rest ([choosing how it renders](components.md#choosing-how-it-renders-per-use-build-and-slots)). Where its
  props are in the page before the page module loads (embedded data), give it an
  [early renderer](components.md#early-renderers), or what it builds appears after the first paint (`SN543`).

## Single-file components

A small component can keep its script in its file, in a top-level `<script>` beside the `<template>` and the
`<style>`:

```html
<!-- src/components/task-ring.html -->
<template data-sn-props="{ done: number; open: number }" data-sn-emits="{ pick: 'done' | 'open' }">
  <figure><canvas data-sn-ref="canvas"></canvas></figure>
</template>

<script lang="ts">
  import Chart from 'chart.js/auto';
  import { TaskRingComponent } from './task-ring.html';

  export class TaskRing extends TaskRingComponent {
    connected() { /* … */ }
  }
</script>

<style>
  figure { margin: 0; }
</style>
```

- **The same script as a file.** It imports its base from `./task-ring.html` and exports the class, as
  `task-ring.ts` would. When it grows, cut the block's code into `task-ring.ts` beside the file, unchanged
  (and later into the component's [own folder](components.md#where-its-files-go)).
- **Which `<script>`:** a top-level one with no `type`, or `type="module"`. `lang="ts"` is TypeScript; without
  `lang` it is JavaScript. A `<script>` that is markup (JSON-LD) goes inside the `<template>`, as before.
- **One place.** Two top-level scripts, a block and a `task-ring.ts` beside the file, or a `lang` other than
  `ts` are `SN312`. A head component has no script, in either form.
- **Its module** is `task-ring.html.script.ts`, a path beside the file that sinter serves: relative imports in
  the block resolve from the component's folder, the dev server reloads it with the file, and errors and
  breakpoints point at the file's own lines, through a source map.
- **Checked.** `sinter check` (and the build, and your editor through `sinter lsp`) type-checks the block with
  the HTML's types, and reports errors at their line and column in the HTML (`SN208`). Your own `tsc` does
  not see the block, as it sees no HTML: a script that needs your project's stricter compiler options is a
  file beside the component.
- **Testable parts go in modules.** A test cannot import from the block: logic worth a unit test goes in a
  module of its own beside it, which the block imports.

## `src/sinter.components.d.ts`

The types of every component with a script go in one generated file, in `src/`. It is written on every build and `sinter check`, and `sinter lsp` rewrites
it when a component's HTML changes, so the editor's types are current without the dev server. An app
may commit it or git-ignore it; the starter template commits it. Types it names come from
`src/sinter.types.ts`.

## Plain custom elements

Your own or third-party web components keep working without a component file: data goes in through
properties (`data-sn-with`), events come out as DOM events. The rest of this page is about them.

An example:

```html
<sn-resource name="messages" src="/api/messages" key="id"></sn-resource>

<section data-sn-state="{ selectedId: null, draft: '' }"
         data-sn-let="{ selected: messages.find(m => m.id === selectedId) }">
  <ul>
    <template data-sn-for="m in messages">
      <li>
        <button data-sn-on-click="selectedId = m.id; draft = ''" data-sn-text="m.subject"></button>
        <span data-sn-show="m.is_flagged">flagged</span>
      </li>
    </template>
  </ul>

  <template data-sn-if="selected">
    <mail-reader data-sn-with="{message: selected, readonly: !selected.can_edit}"
                 data-sn-on-reader-flag="merge(selected, {is_flagged: $event.detail})"
                 data-sn-on-reader-note="draft = $event.detail"></mail-reader>
    <p>Note: <span data-sn-text="draft.length"></span> characters</p>
  </template>
</section>
```

```js
class MailReader extends HTMLElement {
  #message = null;
  #readonly = false;
  #title = document.createElement('h2');
  #flag = document.createElement('button');
  #note = document.createElement('textarea');

  constructor() {
    super();
    this.#flag.onclick = () => this.#emit('reader-flag', !this.#message.is_flagged);
    this.#note.oninput = () => this.#emit('reader-note', this.#note.value);
  }

  connectedCallback() {
    this.replaceChildren(this.#title, this.#flag, this.#note);
  }

  // sinter assigns these from data-sn-with, each time the value changes
  set message(m) {
    this.#message = m;
    this.#title.textContent = m.subject;
    this.#flag.textContent = m.is_flagged ? 'Unflag' : 'Flag';
  }
  set readonly(v) {
    this.#flag.disabled = this.#note.readOnly = v;
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }
}
customElements.define('mail-reader', MailReader);
```
The round trip:

1. Clicking a row sets `selectedId`; `selected` is derived from the resource, so it is always the current item. `data-sn-with` assigns `message` and `readonly` on the custom element, and its setters update the
   elements it built.
2. Clicking Flag dispatches `reader-flag` with the new value. The template's handler calls
   `merge(selected, {...})`, which updates the resource, so the `flagged` label in the
   list changes, and `selected` is the patched item, which `data-sn-with` passes to the custom element again, and it
   re-renders with "Unflag".
3. Typing dispatches `reader-note` with the text. The handler writes it to the `draft` state, and the
   `<span data-sn-text="draft.length">` next to the custom element updates on every keystroke.

The custom element owns the elements it builds; sinter owns the bindings around it. Data flows in
through properties and out through events, never through the DOM in between.

### Data in

`data-sn-with` takes an object literal and assigns each entry as a JavaScript property, so the
custom element receives objects and arrays, not strings. It works on custom elements only.

The custom element's module may define the element after the page has mounted (a lazy `import()`). Values
set before that are not lost: when the element is defined, sinter sets the latest value of each
property again through your class's setter.

With a declaration in `HTMLElementTagNameMap` under `src/`, `sinter check` checks each key and value against the
element's properties ([type-checking.md](type-checking.md)).

### Events out

A custom element dispatches `CustomEvent`s with lowercase kebab-case names (`reader-flag`) that bubble.
`data-sn-on-<name>` handles them like any other event, with the payload in `$event.detail`.

Declare the details in `SinterElementEvents` and `$event.detail` is typed:
`interface SinterElementEvents { 'mail-reader': { 'reader-flag': boolean; 'reader-note': string } }`.

Handlers run at every level the event bubbles through until one calls `$event.preventDefault()`.
If an event may be final at some level, dispatch it with `cancelable: true`.

### Instance API

A custom element can also use the store directly:

```js
import { instance } from '@tiaforge-ui/sinter';

const app = instance(document);              // the instance mounted on the document

const messages = app.resource('messages');
messages.subscribe(change => { /* ... */ });
messages.merge(msg, { is_read: true });

app.request('/api/email/raw?id=7');          // fetch through the request layer
app.optimistic(() => messages.remove(msg), () => app.request(url, { method: 'DELETE' }));

app.on('new_email', payload => notify(payload));  // any server event, mapped or not
```

| Method | Purpose |
| --- | --- |
| `instance(root)` | The instance mounted on `root`. Throws if there is none. |
| `resource(name)` | The store handle of a declared [resource](resources.md). |
| `request(url, init)` | `fetch` through the request layer, with the same 401 handling as actions. `init.body` is encoded as JSON: pass the object, not `JSON.stringify(…)`. |
| `optimistic(change, run)` | Applies `change` as a layer and settles it with the promise from `run`: kept when it resolves, rolled back when it rejects. |
| `on(event, fn)` | Subscribes to a server event by name (see [sync.md](sync.md)). Returns the unsubscribe function. |

`app.on` receives every event on the stream, including ones no `<sn-event>` maps, and fires after
all mappings have run.

### Rules

- Custom elements never write to nodes sinter manages. Markup written inside a custom element in the page is bound like the
  rest of the page, so a custom element that replaces its children (as `<mail-reader>` does) should be written empty.
- Store writes from a custom element go to the base data, like server events. For a change the server
  hasn't confirmed, use `app.optimistic()`, so it rolls back on failure and stays consistent with
  incoming events.
- There can be several instances, one per mount root. There is no global one, so always pass the
  root to `instance()`.
