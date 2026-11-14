# sinter v0.1 spec
Source: https://claude.ai/artifact/KUVBabhMHDm52FpMuPFvA9 (snapshot 2026-11-04, rev 78)

## Overview
sinter binds JSON APIs to plain HTML: it caches server data in keyed resources, keeps them current from server events, renders them through `<template>` bindings, and runs mutations with optimistic updates. It is compile-first: a build step turns annotated HTML into a page module, so the browser runs no parser and no `eval`.
Package: `@tiaforge-ui/sinter`. Attribute prefix: `data-sn-`. Declaration elements: `<sn-resource>`, `<sn-sync>`, `<sn-event>`. Components: files in `src/components/`, used by their tag, and `<sn-component use>` (see Components).
License: MIT. Contributions are accepted under the Developer Certificate of Origin (`Signed-off-by` in each commit); no CLA.

### Goals
- Replace the server-state plumbing of a multi-page app: loading flags, stale responses, refetch on reconnect, list upserts from SSE.
- Valid HTML, readable without knowing the library, and easy for an LLM to write correctly.
- Small runtime: under 11 KB min+gzip for the core (10.1 KB on 2026-11-05), verified per release by `npm run size`.
- CSP-safe under `script-src 'self'` with no `unsafe-eval`.
- Optimistic updates that stay correct when requests overlap or SSE events arrive mid-flight.

### Non-goals
- Routing and a virtual DOM. Components are expanded at build time (see Components), not a runtime component system; transitions are view transitions between pages (`data-sn-transition`).
- HTML responses or `innerHTML` rendering.
- A runtime interpreter: HTML that never passes through the compiler cannot use directives.
- Dialogs and popovers: native `<dialog>`, `popover` and `commandfor` cover them.
- Anything that measures layout: that stays in islands.

### Design principles
- One way to do each thing. No aliases, no overlapping features.
- Familiar shapes, same meaning. Borrow from Vue, Alpine and htmx only where the semantics match.
- Everything visible on the element. No implicit inheritance beyond lexical scope.
- Configuration is data. Resources, keys, event mappings and pagination are attributes, never callbacks, so they can be validated and generated later.
- Errors at build time. Anything the compiler can check, it checks.
- Seams for later work. A versioned intermediate format, a DOM-free store and normalized change messages keep a type generator, embedded server data, cross-page caching and a shared SSE worker possible without API changes.

## Architecture
The compiler turns annotated HTML into a page module once; at runtime the store sits in the middle, and every change from the server, an action or an island goes through it before the renderer writes the DOM.
Server data enters through the request layer (loads) and the sync adapter (events); the renderer only reads the store, so there is one path to the DOM.

### Packages

| Import | Contents |
| --- | --- |
| `@tiaforge-ui/sinter` | `mount`, store, renderer, actions, request layer, instance API |
| `@tiaforge-ui/sinter/sse` | `<sn-sync>` with the SSE transport (and any configured one) |
| `@tiaforge-ui/sinter/ws` | WebSocket transport (opt-in from the config module) |
| `@tiaforge-ui/sinter/optimistic` | optimistic layers |
| `@tiaforge-ui/sinter/paginate` | keyset, offset, append |
| `@tiaforge-ui/sinter/each` | fan-out resources (`each="a in accounts"`) |
| `@tiaforge-ui/sinter/persist` | `data-sn-persist` |
| `@tiaforge-ui/sinter/form` | form bodies: a form's fields without `data-sn-body`, `data-sn-encoding="form"` |
| `@tiaforge-ui/sinter/select` | the selection index (`{active: row.id === selected}` in a row) |
| `@tiaforge-ui/sinter/location` | `$url` written (a handler, a model on `$url`, `page-model`): the query string follows, with history entries (see The URL); array parameters read as lists |
| `@tiaforge-ui/sinter/query-links` | same-page links: a plain click on a link to the page that changes only query parameters it reads stays on the page (see The URL) |
| `@tiaforge-ui/sinter/typing` | a text, number or range model on `$url`: its writes wait for the typing pause (a text field's run: one entry; a number field's burst of steps: one entry) |
| `@tiaforge-ui/sinter/call` | action functions (`data-sn-call`, `<sn-resource call>`): their context and errors |
| `@tiaforge-ui/sinter/debounce` | `data-sn-debounce`, `data-sn-debounce-<event>` |
| `@tiaforge-ui/sinter/confirm` | `data-sn-confirm` |
| `@tiaforge-ui/sinter/models` | `data-sn-model` on checkboxes, radio buttons, `<select>`, number and range inputs |
| `@tiaforge-ui/sinter/compiler` | `compile()` |
| `@tiaforge-ui/sinter/vite` | Vite plugin |
| `@tiaforge-ui/sinter/testing` | `render`, `mockRequests`, `mockStream` |

The compiler imports only the feature modules a page uses; the core never imports them.

## Compiler contract and intermediate format
The compiler is one pure, deterministic function; every build tool integration is a thin adapter around it.
```ts
compile(html: string, options: CompileOptions): {
  html: string;            // rewritten page
  module: string;          // generated page module (ESM)
  diagnostics: Diagnostic[];
  files: string[];         // component files read, for watch mode
  map?: SourceMap;         // with `sourcemap`: the page module's source map (earlyMap: the early module's)
}

interface CompileOptions {
  file: string;            // for diagnostics, stable ids and relative includes
  root: string;            // project root; includes may not leave it
  readFile: (path: string) => string;  // supplied by the adapter, used for component files
  components?: string;     // where component files are (default `<root>/src/components`)
  helpers: HelperManifest; // helper functions and namespace members, read from the helpers module by the adapter
  dev: boolean;            // dev runtime + source positions in the IR
  sourcemap?: boolean;     // also return source maps for the page and early modules
}
```
Same input and options always give byte-identical output. Ids are assigned in document order.

### HTML rewrite
- Component tags are replaced by the component's markup first, before any other step (see Components).
- All `data-sn-*` attributes are removed from the output.
- An element outside a `<template>` that carries directives gets `data-sn="<n>"`, a short id the runtime looks up once at mount.
- Inside a `<template>`, bindings are addressed by node path (child indexes from the template root), since template content is inert and only cloned.
- `<sn-resource>`, `<sn-sync>` and `<sn-event>` are removed; their definitions move into the IR.
- Embedded data (`<script type="application/json" data-sn-data="contacts">`) stays in the HTML, since it may be produced at request time.
- One `<script type="module">` is injected that imports the page module.

### Components
A file `src/components/<name>.html` (the name contains a `-`) is the component `<name>`, usable on every page. Every use is expanded at build time, so a component's markup is page markup: it renders in the first frame with everything else, and a component without a script adds nothing to the runtime. The guide is [components.md](components.md).
- The file holds one `<template data-sn-component="{ …props }">` with exactly one root element, and optionally a `<style>`. `data-sn-emits` on the template declares its events and their detail types. Anything else is `SN312`.
- Each use is replaced by the root. The tag's `class` is joined with the root's; another plain attribute moves onto it (the same attribute on both is `SN209`); the tag's `data-sn-on-*`, actions, `data-sn-class`, `-attr`, `-style`, `-show` and `-transition` are compiled onto the root in the caller's scope. Other `data-sn-*` attributes on a tag are `SN102`.
- Props: `data-sn-prop` on the tag. Each prop is the caller's expression, inlined where the component reads it (as a `data-sn-let` name), so it is live and read-only. A key the props type does not declare, or a required prop left out, is `SN313`. A prop not given is `undefined`, unless the root's `data-sn-state` has a field of that name, its default.
- Scope: the component's markup sees its props, its own state, the page's resources, helpers and magic names; a caller's name is `SN201` with the prop to add. Its loops get their own runtime names, so a prop read in a row never resolves to a row of the component.
- Slots: the tag's children fill the component's `<slot>` elements at build time: `slot="meta"` the `<slot name="meta">`, the rest the default `<slot>`; a slot left empty keeps its fallback content. Slot content keeps the caller's scope. Content no slot takes is `SN314`.
- Events: `emit()` in a component must name an event `data-sn-emits` declares (`SN315`), and so must a `data-sn-on-<event>` on the tag that is not a DOM event. `$event.detail` is typed by the declaration.
- `data-sn-model` on a tag binds the component's `value` prop and writes the detail of its `change` event back (a `CustomEvent` only, not a native `change` bubbling from inside); the component must declare both (`SN313`).
- Recursion: a component that uses itself (directly or through others) with a `data-sn-for` or `data-sn-if` template between is compiled once as a shared definition: `<template id="sn-def-<name>">` appended to the `<head>`, whose content is the component's markup compiled as a row template whose item (`$p<tid>`) is the props object (the definition's props read `$.$p<tid>.<prop>`). Each inner use becomes an empty `<template data-sn-def="sn-def-<name>">` carrying a `data-sn-for` over `[{ …props }]` with the constant key `() => 0`; the runtime and the early script clone the definition into such a template the first time they instantiate it, so trees render at any depth, early too. The definition's props must be a type literal (`SN312`) and inner uses take no slot content (`SN314`). The item sources of the definition's props are the sources given at every use (`@def:<name>:<prop>`). A component that uses itself with no `data-sn-for` or `data-sn-if` template between is `SN306`.
- `<sn-component use="…" data-sn-prop="…">`: a component chosen by data (the one new element). Candidates: for a template string with one expression (``use="`${b.type}-block`"``), the app's components with that prefix and suffix (`componentNames` in `CompileOptions`, from `src/components/`, or the components the page already read); for a map in the markup (`use="{ hero: 'hero-block' }[b.type]"`), its values, each of which must be a component (`SN312`); for a call (`use="blockComponent(b)"`), every component. `use` built with `+` is `SN312` (TypeScript types it `string`). Each candidate becomes a point of its shared definition whose `data-sn-for` renders `[props]` when `use` evaluates to the candidate's name, else `[]`; a `data-sn-else` template right after becomes a `data-sn-if` for a value outside the candidates. Without one, dev builds warn (`console.warn`, once per value and place) when `use` names no candidate; production builds carry no code for it. `sinter check`: the template string and the call must fit the union of the app's components (the generated `ComponentName`); for a map, the key must fit its keys; the props are checked per candidate, guarded by `key === '<value>'` for the template string and the map, so TypeScript narrows the item.
- Nested items: a row of a nested list of an item with a source (`r in comment.replies`) has the source `<resource>><field>` (`comments>replies`; several fields join: `comments>replies,children`), meaning an item found under the resource's rows through those lists at any depth. `patch()` and `remove()` with such a source (the `nested` feature) find the item by identity, else by the resource's key, replace the objects along its path and patch the top-level row (or the single resource). `upsert(c.replies, x)` compiles to `upsert(<c's sources>, c, "replies", x)`: `c` is patched with its list, `x` added (or replacing the item with its key). Write-through follows the same paths: a read of a nested row (or of a prop that is one, `$p3.comment` in a shared definition, its sources resolved after the walk) gives a target `{ r, v, n: [fields] }` (with its schema: the list's item schema under the row's); its response patches the item at its depth (rule 1 and 3), and a DELETE of the list's URL plus one segment removes it (rule 4). Such targets are in `ap.nt` (`nu`: the one the body describes), apart from `tg`, and the `nested` module applies them after the write-through module, so a page without nested lists loads none of it. A tag written directly in a table, which the HTML parser moves out, is `SN102`: write it in the row's template.
- A literal `id` in the markup of a component used more than once on a page is `SN209`.
- Styles: the file's `<style>` is scoped and imported by the page module (`componentCss(name)` names the module; the Vite plugin serves it), so the bundler puts it in the page's stylesheet. It is wrapped in `@scope ([data-sn-c="<name>"], [data-sn-s="<name>"]) to ([data-sn-c], [data-sn-s])`: the component's root is the scope root, and nested component roots and slot content are the limits. Slot content passed on by a component is a scope root of its own for that component's styles (`data-sn-s="<name>"`; the page's is `data-sn-s=""`). In `@scope`, a selector without `:scope` or `&` matches only below the scope root, so each such selector of a style rule (also inside `@media` and `@supports`; not rules nested in rules) gets a copy whose first compound may be the root: `.compact p` becomes `.compact p, :where(:scope):is(.compact) p` (a pseudo-element follows the `:is()`, a selector whose first combinator is `+` or `~` gets none), with the same specificity. Each instance is its own scope: a sibling instance is outside it. `@keyframes`, `@font-face`, `@import`, `@property`, `@counter-style`, `@page` and `@layer` statements stay outside. On a page that uses a component with styles, every component root carries `data-sn-c` and top-level slot content elements `data-sn-s`; in dev builds roots always carry `data-sn-c`.
- Scripts: a component with a script beside its HTML (`<name>.ts`, `.js`, `.mts` or `.mjs`) gets a `cmp` binding on its root, whose function returns `[the class, its props, the root state's field names]` with those fields' paths as the binding's `w`; the page module imports the class the script exports, named after the component in PascalCase (`TaskRing` for `task-ring`), else its default export (neither is `SN312`), and the `components` feature (`@tiaforge-ui/sinter/components`) creates its object once per instance with `props` (live), `state` (one accessor per field of the root's state: an assignment marks that field's path; a root without `data-sn-state` gets `{}`), `refs` and `root`. Each `data-sn-ref` element of the markup gets a `cmp` binding too, returning `[the root's state, the ref's name]`, which gives the element to that instance's `refs` (a ref whose element left the page is removed after the render); and runs `connected()` after the render that created it, `propsChanged()` after a render that changed a prop, and `disconnected()` after the render that removed its root (or on destroy). `import { XComponent } from './x.html'` in the script resolves, through the Vite plugin, to a base class extending `Component`; `src/sinter.components.d.ts` types it from the HTML (props, emits, refs by tag, state from its initial values), written with the project like `src/sinter.messages.d.ts`, and by `sinter lsp` when a component's HTML changes. `data-sn-ref` outside a component's markup, or on its root, is `SN102`.
- `data-sn-early="off"` on a component's tag (or `<sn-component>`): the early chunk leaves out the bindings of that use's markup and of the components inside it (not of the slot content the tag passes in), so they render when the page module mounts; `prerender` still writes build-time constants into the HTML. Any other value is `SN401`; on a component's template or a plain element it is `SN102`.
- Diagnostics point to the line in the component, followed by where it is used.
- `<sn-include>` is removed: it is `SN316`, whose message lists the names the partial reads from the page, the props it needs as a component.
- Slot forwarding: a `<slot>` that carries `slot="<name>"` and is a child of a component's tag forwards what fills it (or its fallback) into that component's slot `<name>`: the elements get `slot="<name>"`, text keeps the name aside. Slot content keeps the use it was first given to (its caller's scope and its `data-sn-s` marker) through any number of components.
- Head components: a file whose template is `<template data-sn-head="{ …props }">` (a template with both declarations is `SN312`). Its top-level nodes, head elements only (`<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>`, `<slot>`, head components; anything else, or text, is `SN320`), replace the tag after its slots are filled and its constant props have decided `data-sn-if` templates (a prop given as a literal, or an optional one left out, as for components, but before the walk, so top-level templates fold too). They share one component scope, computed at the first of them the walk reaches; its caller is the scope where they are, the head component whose markup has the tag, or for slot content the caller of the use it was passed to. The tag takes only `data-sn-prop` and `slot` (`SN102`). A head component has no script (`SN312`) and no scoped `<style>` (`SN320`); it is used only in a head (`SN320`; `expandComponents` tracks whether it is in one), is not a candidate of `<sn-component use>` (nor in `ComponentName`), and does not use itself (`SN306`).

### Layouts
A file `src/layouts/<name>.html` (`CompileOptions.layouts`) is a whole document whose `<html>` carries `data-sn-layout="{ …props }"`. The guide is [layouts.md](layouts.md).
- A page whose body's only element is a layout's tag (a component of the same name wins, and is `SN318`) is replaced, right after it is parsed and before includes, components and everything else, by the layout's document: the layout is parsed (`parseDocument`), tagged with its file, its comments outside `<html>` dropped, its relative `src`/`href`/`srcset`/`poster` URLs of `link`, `script`, `img`, `source`, `video`, `audio`, `track` and `input` rebased to root-relative ones, and its slots filled with the tag's children as a component's are (`fillSlots`, over the whole document). Anything else in the page's head or body is `SN319`, as are attributes on an explicit `<html>` of the page.
- The tag's plain attributes set the layout's `<html>` attributes (replacing them; `class` is joined); `data-sn-path` and `data-sn-prefetch` are copied; `data-sn-state` is compiled on `<html>`'s node in the page's scope (`stateOf`), which is then the caller's scope: the props (`data-sn-prop`, `SN313`) and every slot content see it, the layout's markup, compiled in a component scope of its props, does not. The tag's `data-sn-class`, `-attr`, `-style` are compiled on `<html>` in that scope; its handlers (`data-sn-on-*`, `data-sn-debounce-*`) on the layout's `<body>`, in that scope, before the body's own bindings (the page's `<body>` handlers, as before layouts). A handler's event must be a DOM event, `sn-error` or `dismiss` (`SN315`). `data-sn-early` is `SN319`; other `data-sn-*` are `SN102`. The same `data-sn-state` on the tag and the layout's `<html>` is `SN209`.
- A default slot in the head is `SN318` (the page's content without `slot` is its body), and a `<title>`, `<meta>`, `<link>` or `<base>` given to a body slot is `SN320`. A layout tag anywhere else (inside a component, a layout, other markup) is `SN319`; a layout file with a script beside it, `data-sn-emits` on its `<html>`, a file without `data-sn-layout` on an explicit `<html>`, and a layout compiled as a page are `SN318`. The layout's file is in `CompileResult.files`, so the dev server reloads its pages.
- `sinter check` frames the layout's props like a component's (`data-sn-layout`'s location); the generated `src/sinter.components.d.ts` has `LayoutName` and `LayoutProps`.
- After expansion the head holds head elements only (`SN320`; `<sn-resource>` and `<sn-sync>` too, which go in the body: they are page-wide wherever they are written), and once each of `<title>`, `<base>`, `<meta charset>`, `<link rel="canonical">`, `<meta name>` `viewport`/`description`/`robots` and `<meta property>` `og:title`/`og:description`/`og:url`/`og:type`/`twitter:card`/`twitter:title`/`twitter:description` (`SN321`; a `<meta media>` is not counted). Elements inside `data-sn-if`, `data-sn-else` and `data-sn-for` templates count: an element in both branches of one if/else is one, a branch's and a top-level one are two, and any in a `data-sn-for` template is `SN321` (one per row).
- Parsing: `parseDocument` parses a document with a written `<head>…</head>` in two parts at the same offsets: the document with the head's content blanked, and that content as template content (in a `<template>` context), so every element (a custom tag, a `<slot>`) stays in the head where it is written. A document without both tags is parsed as `parse5.parse` does.

### Page module
```js
import { mount } from '@tiaforge-ui/sinter';
import sse from '@tiaforge-ui/sinter/sse';          // only features this page uses
import optimistic from '@tiaforge-ui/sinter/optimistic';
import { date } from '/src/sinter.helpers.js';               // only the helpers this page uses
import { inbox_title } from '/src/paraglide/messages.js';     // namespace members, imported by name

const ir = { v: 2, resources: [...], syncs: [...], roots: [...], templates: [...], actions: [...], ps: {...} };
const fns = [
  (s) => s.c.fn_name,
  (s) => date(s.c.birthday, 'short'),
  // one function per expression, identifiers already resolved
];

await parsed();   // the page module is `async`; on a page with an early file: `await rendered()` (see First paint)
mount(document, { ir, fns, features: [sse, optimistic] });
```

**Source maps.** With `sourcemap`, `compile` also returns a v3 source map for the page module (`map`) and the early module (`earlyMap`): each function in `fns` maps to where its expression starts in the markup (the attribute's value, `shift` characters in for a part such as a URL template's `{…}`), in the page or the component it came from, with the files' text in `sourcesContent`. An error thrown in an expression then points at the HTML in the browser's devtools. A function maps as a whole: identifiers are rewritten (`q` becomes `$.$s0.q`), so every column inside it maps to the expression's start. A function shared by several attributes (identical code is one table entry) maps to the first. Functions the compiler writes itself map to the markup they come from: a row template's lookups (`find`, `make`) to its `data-sn-for`, a form's state with `$error` to its `data-sn-state` (or its start tag), the early module's state functions to `data-sn-state`, and the setter of a `data-sn-model` to that attribute; an expression inlined into one (each binding in `make`, a state's fields) maps to its own place. The module text is the same with or without a map. Because a shared function can map to one place only, dev builds also name each use when it throws: the dev IR gives each binding, action, resource and event an `at` (`{ [fn]: "file:line:col" }`, the place of each function it uses, recorded as it is compiled), and the core hands the dev module what threw (the binding, its element and the error; for a handler, the binding it runs for), which reports `binding \`text\` on <p> at page.html:2:20 threw: …` with the error after it. Production builds carry no `at`, and the core's error paths pass objects instead of formatting messages. The Vite plugin asks for maps in `vite dev` and in builds with `build.sourcemap`, and returns them from `load()`; in a build with maps, page modules get a plain id (`/@sinter/<page>.js`, not `\0/@sinter/…`), since Rolldown drops the map of a `\0` module.

### Intermediate format (IR v2)
The IR is the only contract between compiler and runtime. It is plain JSON plus a function table, carries `v: 2`, and the runtime refuses a version it does not know.

| Part | Holds |
| --- | --- |
| `resources` | name, URL template, key fields, items/total paths, order, pagination config (with `page-model`, its parameter `model` and the function that reads it, `start`; in the page module only the fields that are set: an absent one is null, `deps` [] and `scope` -1; the compiler keeps the full objects; the page module also flags a resource that an event of one of the page's streams names, `fed`: its `$meta.live` starts as `connecting`, and `pageshow` and `online` leave its refetch to the stream, added 2026-11-14) |
| `syncs` | stream URL, event → change-message mappings (absent event fields are null; absent on a page without streams) |
| `roots` | per `data-sn` id: its bindings and the scope it opens (in the page module `p` is absent for a node outside any state scope) |
| `templates` | per template: node paths, bindings, key expression (absent `index`, `key`, `keyFields` are null); in the page module (`compactIR`) also its kind, which the runtime reads instead of walking the template's bindings: `sm` a simple row template (a lookup function, only value bindings and handlers: its rows keep no binding objects), `ri` a binding in its rows, nested templates included, reads a loop index (added 2026-11-14) |
| `actions` | method, URL template, concurrency, and only where the page sets them: body source, debounce, optimistic, then, catch, the paths they write, form (the trigger event is the action's `on` binding) |
| `bindings` | kind (`text`, `attr`, `class`, `style`, `show`, `model`, `prop`, `for`, `if`, `else`, `on`), target, function index, static dependency paths; for a key filter, the `key` to match and modifier bits |
| `urlArrays` | the `$url` parameters that are lists (bound to a `<select multiple>` or a checkbox with a `value`), absent when none (added 2026-11-13) |
| `urlReads` | same-page links: the `$url` parameters the page reads by name, present only on pages that load query-links (added 2026-11-14) |
| `ps` | the path table (page module only, below) |
| `ev` | the event types the mount listens for at its root (page module only, from `compactIR`): each handler's, `input` and `change` with a model, `toggle` where a dialog that opens has something to render (an element in a dialog, a model of a control other than a text field); absent for none. The mount adds one listener per entry and walks no bindings for it (added 2026-11-14) |

Dependencies are extracted at compile time: every binding lists the state and resource paths it reads (`q`, `contacts`, `c`). The runtime matches them against dirty paths (see Reactivity), so it needs no proxies and no read tracking.

**Numbered paths (IR v2, added 2026-11-09).** The compiler's IR holds paths as strings (`$s0.draft.emails.{$i1}.value`). In the page module (`compactIR`, `src/paths.ts`) every path read or written (`d`, `w`, `deps`, a selection's `s.d`) is a node id of one trie per page: numbered in pre-order with children sorted by name, so the same page gets the same ids. The table `ps` holds no segment names:
- `p`: each node's parent (-1 for a top-level segment); `k`: the special segments by node (`*`, `#`, `~`, `**`, `{name}`);
- `r`: by written node, the dependency nodes it can reach: a node id, or `[node, flags, ...checks]` when checks remain at runtime: a `{name}` value of the write equal to a segment the dependency names, the reader's row index equal to the writer's (or to a literal index), a marked row (`~`); flags 1: a `**` ended the match;
- `x`: the nodes of the paths the runtime marks by itself (`$locale`, `$url`, `$now`, `$r.<name>`, `$meta.<name>`, `$s<sid>.**`, `$s<sid>.$error`), by name.

The compiler decides, for every pair of written path and dependency, what the runtime's string matching decided before (`staticReach`); the runtime keeps only the checks against scope values. A dirty path is a written node plus the values its `{name}` segments took from the writer's scope. Each flush indexes the round's dirty paths by dependency node, so a binding's check is a lookup. `test/paths.test.ts` compares both halves with the former string matching on random paths, scopes and marked rows.

### Adapters
- Vite (v0.1): `@tiaforge-ui/sinter/vite` hooks `transformIndexHtml` for every HTML entry and serves the page module as a virtual module. Dev and build use the same path. Component files returned in `files` are watched. Diagnostics go to the terminal and Vite's error overlay. An HTML or component change triggers a full reload in v0.1.
- Later: esbuild or a CLI wrap the same `compile()`; nothing in the core changes.

### First paint
The page renders correctly before its module has run; the module then fills in data. The page bundle is not render-blocking, and it is `async` (below).

**Build-time constants.** With the `prerender` compile option (the Vite plugin always passes it; until 2026-11-14 `sinter({ firstPaint: false })` turned it off, which made constant bindings on `static` pages SN322 and left pages with nothing to run a page module), a binding outside any `<template>` whose value is a build-time constant is written into the HTML as the runtime would write it: it reads only `data-sn-state` fields with a constant initializer (each field on its own: `{ here: '/mail/', at: $now }` leaves `here` constant) and constants. No helpers, no `$locale`, nothing persisted. Kinds: `text` (content without elements), `attr`, `class` (literal keys), `style`, `show`, and `model` on checkboxes, radios and text/number fields. A refused URL or style is left out. This is what a browser without scripts shows. A binding written so that reads nothing but state fields nothing writes (no data, URL or `$locale`: a literal, a component prop given as one, a field no handler, model, `then`, `catch`, component script or the runtime writes) can never change, so the page module leaves it out (added 2026-11-11). The written fields are every `w` of the page's bindings (rows' too), actions, resources and events, by field (`$s<sid>.<field>`, or the whole state for a computed key or `**`), plus a form's `$error` and persisted values. A dependency on such a field never fires either: it is left out of every binding's `d` and every resource's `deps` (rows and branches too), after the early chunk is made, which reads the full lists. Inside templates (rows and branches), a binding over such state and constants only, that reads no row, is written into the template's markup the same way and left out (the template's nodes renumbered: `p`, `y`), and a state field that nothing writes and no remaining function reads is left out of its state's initializer (unless something reads the whole object). A `data-sn-if` whose condition reads only such state is decided at build time: `compileParts` compiles the page again (only when the first pass decided one) with each decided template replaced by its branch, the `data-sn-else` after it, or nothing, keyed by the template's file and offset; a component's template is decided only when every use agrees; its function when nothing else uses it (a `0` placeholder keeps the other functions' indexes), and its node and `data-sn` id when nothing else is bound there, the roots after it renumbered (`p`, `y`, resource and stream scopes). A `data-sn-for` over such a list (the evaluator above: literals, constant props, state nothing writes) is unrolled the same way when its rows need nothing at run time (every row binding is `text`, `attr`, `class`, `style` or `show`, reads no `$el`, writes nothing and reads only the row and fixed state; no row node has a state, and none is a nested template), the list is plain data and at most 1,000 items, and the first pass has no errors but `SN322` (added 2026-11-11): the second pass replaces the template by one copy of its content per item, keyed by the template's file, offset and the uses of the components it is in (a component used on two lines of a page is two templates; uses that disagree on the length leave it), and each copy's top elements get the item and index as derived names, `(list)[k]` and `k`, so their bindings are constants written into the HTML. A page-level state left with no fields has no node either (the nodes inside take the scope around it).

**Pages with nothing to run (added 2026-11-11).** After all of the above, `CompiledParts.runtime` lists why the page needs the runtime, in document order, the page's own first: each root node with a binding or a state (named by its first sinter attribute where it was written, `the script of <x>` for a component script), each resource and each stream. With `prerender` and an empty list the page is `static`: it gets no page module script and no early script (the early module is `null`, also when the app has an early module), and the stylesheets the module would import (`images.stylesheet`, `componentCss(name)` for each component with styles) are `<link rel="stylesheet">` at the end of the head instead, which Vite's HTML pipeline bundles. With the `static` compile option (the plugin passes it for pages `sinter({ static })` matches), each reason is `SN322` where it was written; `sinter check` and the LSP compile such pages with `prerender`. The plugin logs one line per page in builds: `no JavaScript`, or the page chunk's and its imports' gzip sizes and the first three reasons with their file and line; and fails the build for a `static` pattern no page matches.

**The early script.** With the `early` compile option, each page gets an early module. In builds the Vite plugin bundles it into classic scripts (IIFEs) and puts their tags first in the head, before the stylesheets (a classic script waits for the stylesheets before it) and the page module: `assets/sinter-head-<hash>.js`, shared by every page (the language picker, the early runtime with the writers any page uses, the app's early module; cached across pages), then the page's own `assets/<page>-head-<hash>.js` (the hold script if the page uses `data-sn-transition`, the page's compiled early bindings and requests). The page's script takes the runtime from a global the shared one sets (`Symbol.for('sinter.early.rt')`); both are parser-blocking, fetched in parallel, run in order. In dev it is the same: the dev server bundles the page's early module into one classic script (the runtime bundled in, no shared script) when it is first requested, serves it outside the module pipeline (which would add imports to it) with its source map inline, and keeps it until a watched file changes; its tag is first in the head. The base language's text is in the HTML in dev too. It holds:
- the app's early module, `src/sinter.early.ts` (optional; `early` in the plugin options names another). It is app code that runs before anything is rendered; sinter does not know what it does. (The language is sinter's own with built-in messages: see Messages.)
- the early bindings, compiled into the page's renderer (`src/compiler/early-render.ts`, decided 2026-11-09: the early runtime used to interpret them from an IR, ~1.9 KB gzip of every early file): every state scope with its persisted values first, then each binding's first write and each early `data-sn-if` branch, as straight-line calls of the small writers and helpers `@tiaforge-ui/sinter/early` exports, so a page's early file bundles only the writers its bindings use (no attribute binding: no URL check). A binding that throws is left to the page module, a missing element is skipped. Outside `data-sn-for` templates, bindings (`text`, `attr`, `class`, `style`, `show`, `model`, `if`) that read only state fields whose initial value needs no data (literals, helpers, `$locale`, other such fields), persisted values, and helpers. Persisted values are read from localStorage (`sn:<key>`, any value) and applied before anything is written, as the persist feature does at mount. `$url` too (the URL's query and `data-sn-path` parameters, read as the page module reads them; added 2026-11-11, before only on pages with embedded data). Not early: resources (their requests are, see below), `$now`, `$meta`, `$el`, loop variables, store functions, the built-in formatters (they format with the configured locale, which the page module sets). `$locale` reads `configure({ locale })` if the early module configured it; otherwise those reads wait.
- a `data-sn-if` of that kind renders its branch (and `data-sn-else`), and the early bindings in it; nested `data-sn-if`s the same way. The branch's nodes, its end marker and the branch number are left on the template element; the runtime adopts them on its first toggle (binds the existing nodes instead of cloning), or removes them if another branch is to show.
- only the helpers and namespace members the early bindings call, imported from the modules that declare them (past the helpers module and barrels such as a message index, whose namespace objects would pull in everything), and only the state fields those bindings read.
- the request machinery (`requests` from `@tiaforge-ui/sinter/early`: the URL templates, `$url`, `$now`, the handoff) only when the page has early requests (below); the environment (`configure({ env })`, set by the app's early module if at all) only as far as the early file reads it, not the runtime's default environment. A page with nothing to run early (every early binding written at build time, no early request) has no early file.

**Own copies.** The early scripts are bundled apart from the page bundle: any module both use is in both, as separate instances, so state the app sets early is not seen by the page bundle: the app sets it again there, e.g. by calling the same language function from `src/sinter.config.ts` (same inputs, same result). sinter's own state is handed over through the DOM (rendered values, the early branch on its template) and through globals (the handoff, the messages' state). (Until 2026-11-10 the early file and the page bundle shared a chunk with the URL checks and expansion; the early runtime is now in the shared head script, once per site.) The early budget counts the page's script and the shared one.

The runtime owns every binding: on mount it computes the same values, and its writes change nothing, so there is no flash and no reset. Early code runs once and keeps no listeners.

**The page bundle is `async`.** In builds its entry script carries `async`: a deferred module script waits for every pending stylesheet before it runs, an async one does not, so on a warm load the page module starts its requests one round trip earlier. It may now run before the body is parsed, or before the early file, so the page module waits before it mounts: `await parsed()` (`readyState` past `loading`), or on a page with an early script `await rendered()` (both from `@tiaforge-ui/sinter`: the core is in every page bundle, so no chunk more), which waits for the parse and for the early script's last pass (and for the dictionary, with messages). They are bundled apart, so the two meet through a global (`Symbol.for('sinter.early.page')`): the early script marks that it started and when it has rendered. An early script that failed to load does not hold the page: if it has not started by DOMContentLoaded, the page module mounts. The takeover is the same as with a deferred page module. What changes for app code: the modules of the page bundle (islands, `src/sinter.config.ts`) may run while the body is still being parsed, so top-level code must not read the body, and an island defined then is upgraded as the parser creates it (its `connectedCallback` can run before later siblings or its children are parsed: read them when sinter sets a prop or on an event, not on connect). In dev the page module stays a plain module script; the same waits apply.

**Data requests before the page module.** A page's resources are requested before its page module has run, in two ways (with first paint on):
- Every origin a literal `src` of a resource or a stream names (`https://api.example.com/…`) gets `<link rel="preconnect" href="https://api.example.com" crossorigin>` in the head, before the preloads: DNS, TCP and TLS are done while the page bundle downloads instead of when its first request leaves. `crossorigin` (anonymous), because the request layer sends cross-origin requests with `credentials: 'same-origin'` and `EventSource` connects without credentials. Such a `src` gets a preload and an early request (below) only when its origin is listed in `sinter({ origins: [...] })`. Every page module adds that list to the runtime's allowlist (`$origins()`, after the app's config module, which may still call `configure({ origins })`: an origin listed only there is allowed but not requested early), so an app lists its API origins once and nothing the runtime would refuse is sent early. The build names, once, the origins it left to the page module. (Before 2026-11-09 both were same-origin only.)
- `<sn-resource early="off">` keeps a resource out of both: one a request middleware answers itself or changes (adds an `Authorization` header), so that the request sent early would go unused, or fail where the middleware would have answered (RealWorld's `user`: the middleware answers `{user: null}` without a token).
- A resource whose request is fixed at build time (a literal same-origin `src`, no `when`, not `each`, `call` or embedded data; a paginated one at its first page) gets `<link rel="preload" as="fetch" crossorigin href="…">` in the head, after the leading `<meta>`s: the request starts while the head is parsed, before any script. The runtime's `fetch()` takes the preloaded response (Chrome matches it by URL and credentials mode, `crossorigin` being same-origin credentials; the differing `Accept` header does not keep it from matching, measured 2026-11-08), so there is one request.
- A resource whose URL reads only what the early file knows (state fields whose initial value needs no data, persisted values, `$now`, `$url`, helpers, not other resources, `$meta` or the built-in formatters) is requested by the early file when it starts, if its `when` holds: as the request layer sends a GET with no middleware (`Accept: application/json`, `credentials: 'same-origin'`, so none to another origin). The early file and the page bundle are bundled apart, so the responses are handed over through a global (`Symbol.for('sinter.prefetched')`). A paginated resource is requested at its first page: the compiler adds the query parameters the pager sends for it (`firstParams` in `paginate.ts`: `size-param`=`page-size` and `direction-param`=the `first` value of `direction-values`, or `page-param`=1 and the size in offset mode; no cursor, no `offset-param`) as the runtime adds them (`withParams`, shared by both), so the runtime's first load (and its revalidation of a `cache`d page) takes the response; any other page, or a request whose `src` changed meanwhile, is the runtime's own. Not `each`, `call` or embedded resources.

How middleware applies (`configure({ request })` is the page bundle's): the runtime sends its request through the whole chain as always; at the end of the chain, instead of fetching, it takes the early response for that URL if the request is exactly the one the early file sent (GET, same URL, same-origin credentials, `Accept: application/json` as its only header). So response middleware (`onUnauthorized`, the 401 cache clearing, the timeout, a retry policy) runs on the early response as on any other; a request middleware that changes the request (adds a header, changes credentials) gets a request of its own, and the early one is aborted after mount, as is any early request no resource took (its URL changed in between, or a middleware waited before calling `next`). Each early response is taken once: a refetch goes to the server. An early request that failed (a network error) fails the load that took it, as its own request would have; with `retry.get`, the policy's next try is a real request (changed 2026-11-09: the request layer's automatic resend used to send it again at once). A preloaded response is taken by the browser, not by sinter: an app whose middleware adds headers the server needs on a GET (an `Authorization` header) should turn first paint off or not declare such resources with a literal `src`, since the preload is sent without them.

**The early script renders as the parser goes (decided 2026-11-10).** It runs in the head, before any of the body exists: it starts the early requests at once (no stylesheet to wait for), then watches the parse with a `MutationObserver` and renders each early root once the parser has moved past it (it, or an ancestor, has a following node; an `if` template also once its `data-sn-else` sibling is parsed; `<html>` and `<body>` at once). The observer's callback is a microtask at the end of the parser's task, so it runs before the browser can paint that element: in every browser, with no `blocking` attribute and no hold. Each pass looks only at the nodes added since the last one. At DOMContentLoaded a last pass renders what is left, and the page module may mount. This replaced a deferred render-blocking module (with a split `async` file for the early requests and a Firefox fallback that hid `<html>`): without the hold, Chromium painted the unrendered page on 61–90% of RealWorld loads (layout shift 0.12 on the home page); with this, 0 wrong frames in Chromium and Firefox (RealWorld, and Caley's persisted collapsed rail), first paint level or earlier (slow 4G cold: 576 → 440 ms on a page with messages; Caley 160 → 144 ms cold in Chromium, 197 → 172 ms in Firefox, where the fallback had hidden the page in its first frame on most loads). On slow networks the browser may paint the top of a page whose rest has not arrived yet: what is shown is rendered, what is not parsed yet is not shown. A stalled head script holds the parse, as any parser-blocking script does: keep it small (the budget below).

**Attributes at insertion, content at close (2026-11-10).** A root's attribute-like bindings (`attr`, `class`, `style`, `show`) are written in the first pass that sees the element: its attributes are complete when the parser inserts it. Its content bindings (text, a control's value, an `if` or `for` template) wait until the parser has closed it. Each pass looks at every root seen so far and writes each binding once; one runs when roots were added or a content binding still waits. Before, every binding of a root waited for the close, so a persisted class on an element that wraps the page was missing until the end of the document arrived (found with the home page streamed in two chunks: 30–35 frames without the wrapper's class in each of 10 loads).

**Embedded data renders early (prototype, 2026-11-10).** A resource with embedded data (`data-sn-data`, filled by a server: see Embedded JSON) is known before the first paint, so the early part also takes the bindings that read it, `data-sn-for` loops included. The early IR names each such resource's data element and `items` path (`emb`); `$r.<name>` in the early scope parses it once. A binding that reads a resource without data throws there, which leaves it to the page module, as for anything else not available early (`$url.feed == 'following' ? feed : articles` renders the global feed early). Rows are cloned by `each` (a clone of the template per item, rendered over a scope with the loop variable) and left on their template with their end marker (`Symbol.for('sinter.early.rows')`). The page module's first reconcile of that list adopts them when it has as many items: it binds each row's nodes (`instantiate` with `pre`, as for an early `if` branch) instead of cloning, and writes the values again, which changes nothing; the text writer skips a value that is already there, since a write counts as new content for the browser's paint timing. With another count it removes them and renders the list. So a server that only fetches the API and writes the JSON into the page (no DOM, no rendering) gives the page its data in the first frame. Measured against Qwik City in [docs/first-paint-comparison.md](first-paint-comparison.md).

**Hidden messages come back.** The sheet that hides base-language text for another language is removed after 3 s if the page module has not mounted by then (it failed or stalls): the text shows in the base language instead of never.


**Closed at mount (added 2026-11-14).** `earlyParts` leaves out a `data-sn-if` without a `data-sn-else` that reads resources without embedded data (not `each` or `call`) and that `shows` (compiler/status-eval.ts) finds false with no data (`[]` for a keyed resource, `null` for one object) both loading and not: the early file would render nothing the HTML does not show already.

**Reserved space (added 2026-11-14, builds).** A `data-sn-for` outside templates and dialogs over a paginated resource, or a choice between paginated resources (the expression, and the `data-sn-let`s around it that it reads, only choose: identifiers, `?:`, `||`, `??`, comparisons, `$url.<name>`, literals; no call, member or index), holds its rows' space from the first frame: the least `page-size` rows. No attribute; `sinter({ firstPaint: false })` turns it off with the rest. Not for a resource with `each` or `call`, with embedded data (`data-sn-data`, or a slot `embed: true` adds: decided from the resources' data slots after the walk), or whose `src` or `when` reads state, another resource or `$el` (its load may not start at mount); nor rows a component's own `<style>` reaches (a styled component's root or slot content around the list or inside its rows: the layout reads only the page's stylesheets). Two forms. `static` (the list is one resource without `when`): an element after the template, `class="sn-reserve snr<page hash><n>" aria-hidden="true"` (the hash: FNV-1a of the page's path, so two pages' classes differ) (`li` in a list, `span` where only phrasing content may go, else `div`), whose root node's one binding (kind `imp`, `$el`) removes it once the resource has rows or no load is running (`$r.<name>?.length || !$meta.<name>.loading`: loads start at mount, before it runs); its node gets its id and place in `roots` after the walk (`placeholders`). `if` (a `when`, a choice): a `<template data-sn-if="!(<list>)?.length && ($meta.<a>.loading || …)">` with that element, inserted after the list and compiled by the walk, only when every resource is `predictable()` and the list reads only them and the URL, so the early file decides it (resource status early, below) and the page module toggles it as any branch. That template stays after the rows, so `reserve` is told (`trailing`) and counts it as an element after them for structural rules. The Vite plugin's early files come from each page's own compile (with the stylesheets), so their ids are the page's. Loading indicators (`settleSpace`, after the walk, before `placeholders`): every compiled `if` and `show` binding of the page that reads `$meta.<name>` of one of the list's resources is evaluated by `shows` (compiler/status-eval.ts: an acorn walk of the compiled function over literals, `$.$meta.<name>` fields, `$.$r.<name>` and `.length`, `!`, `&&`/`||`/`??`, `?:` and comparisons; anything else unknown, never run) while loading with no rows, with a row, and loaded. One that is false while loading with no rows never meets the placeholder; one that is true then and false in both others, a `data-sn-if` right before the list (only templates between) with one element, takes the placeholder's place (the element gets `snr…b`: `min-height` the rows' height, `margin-top`/`margin-bottom` theirs, `box-sizing: border-box`; and `.snr…b ~ .sn-reserve.snr…` is `display: none`); any other that may show then (unknown included) leaves the list without space: the static placeholder is taken out, the inserted branch's condition compiled to `false`. `planSpace` (before the walk, which removes the bindings the cascade looks at; in dev too, so `SN529` follows the same plan, the placeholders being the build's) calls `Layout.reserve(tpl, count, { sized })` (compiler/layout.ts): the placeholder's rule per viewport range (the stylesheets' width breakpoints, split where an `auto-fill`/`auto-fit` grid or a wrapping row gains a column; within 1 px the lesser shape; mobile first, `@media (min-width)`), or null with a reason (`unreserved`), which the build prints per list (`CompiledParts.unheld`). Shapes: block (rows' margins collapse between them, the outer ones on the placeholder), flex column (`gap`, margins), grid (`grid-column: 1/-1; grid-row: span <lines>`, each line as tall as `grid-auto-rows` or its tallest row), a flex row of rows with a width of their own (`width` in px, rem, em, with box-sizing, min/max and margins; no `flex-basis`: the placeholder the rows and gaps wide, `flex: 0 1 auto`), and a wrapping one (rows per line from the container's content width at each viewport width; `flex: 0 0 100%`), and table rows in a row group (a `<tr>` placeholder, `display: block` in an anonymous cell; the rows' heights and the table's vertical `border-spacing` between them, 2 px from the UA, 0 when `border-collapse: collapse`, where cells count their padding only; the UA's 1 px cell padding; the table elements' own default displays for heights). With `sized` (the list is in a box whose width follows its content, `Layout.contentSized`), only stacked rows with a width of their own, and the placeholder takes that width. Each row is laid out in its place (`withRow`, when a rule has a sibling combinator or a structural pseudo-class; a view per distinct answer of the row's positional queries, which are logged and replayed for the next row): its previous and following siblings are the rows before and after it, the template (right before row 1), and the elements around the template, what another template there may render counting as maybe; `:nth-child()` and the like count those. Each value that may or may not win (`candidates`: a state, a media feature, `@supports`) counts at its least: the least height, `min-height` floor and `max-height` cap, `font-size`, `line-height`; an undecided `box-sizing` as `border-box`; a row's `display` when all candidates lay it out alike. The row's height is exact when the stylesheets fix it, else a lower bound: block flow with margin collapsing (through the first and last child unless padding, border or a formatting context stops it; an inline box with blocks in it is split around them), flex containers (sum in a column, the tallest in a row) and grids (the tallest item), each item with its own line height (text runs the container's); table rows (the tallest cell); a run of inline content is one line box at least as tall as the strut and every inline box in it (a bound text, `data-sn-text`, one line; `<br>` ends one; inline-blocks, controls and images by their boxes); a `data-sn-if` with its `data-sn-else` the lesser; images with `width`/`height` attributes as tall as their width at that viewport (a `max-width`) allows; controls in the UA's font (`system-ui`, `normal`, 13.333px for a 16 px default, following the default size) with `box-sizing: border-box` for buttons, selects and button-like inputs, a lone `monospace` font at 13/16 of its size (font-size keywords under it too); nested lists without vertical margins; `<sub>` and `<sup>` `smaller`; a `<br>` the cascade hides or cannot decide ends no line; a closed `<details>` its `<summary>`; margins as they are, a box whose margin cannot be read 0; hidden, `data-sn-show`, out-of-flow, floated, `display: contents` and undecided boxes are 0. An item of a column flex container counts its `flex-basis` and, when the container's height may be limited, its automatic minimum (it may shrink). A negative margin collapsing through a box's edge (from its first or last child) pulls the box in; rows that may be empty let margins through, the lesser of both. Rows with `content-visibility` other than `visible`, a wrapping row with a `flex-basis`, a grid with explicit rows (`grid-template-rows`, `grid-template`, `grid`), `zoom` on the rows, their container or an ancestor, and rows a binding may hide (`data-sn-attr` with `hidden`) are not followed. Font sizes inherit (keywords, em, %, rem, vw, the `font` shorthand; the UA's heading sizes and margins at their least, an `<h1>` 1.5em), line heights as computed (a number per element, a length inherited as px); `normal` below. Every length is computed for a default font size of 16, 12 and 8 px (`withBase`): equal, px; on one line, `min(<16 px value>, calc(a px + b rem))`, the line at or below all three (rem scaled by the page's root font); not on one line (a kink, as a `min-height` in px over text in em), steps that each hold from their sample up (heights grow with the font): `max(min(<8 px value>, <line>), <ramp to the 12 px value at 12>, <ramp to the 16 px value at 16>)`; a shape's column count is the most of the three (a gap in rem fits more columns with a smaller font). All floored to 1/64 px and 0.01. A height that is a straight line in the container's width over a range (at or below it at the middle, the same for every default font size) is `height: 0; padding-bottom: calc(k% + c px)` instead, exact at every width. The rules are `CompiledParts.paint`: one `.sn-reserve:not(#_)` rule (block, hidden, no padding, border, margin or min/max height, `flex: none`) and per list and viewport range `.sn-reserve.snr…:not(#_)` with what varies (height, margins, width, `flex`, grid span); `:not(#_)` weighs as an id; each declaration `!important`. With `paintCss` a string, the page module imports it (the plugin serves `/@sinter/paint-css/<page>.css`, one file per page, which Vite merges into the page's stylesheet; builds only, since dev serves imported CSS after the first paint). Testing's `render(html, { css })` writes placeholders too. `SN529` (`Layout.contentSized`, naming the viewport widths): a list over a resource without embedded data inside a box whose width follows its content (an auto-width flex item without a basis in a row, among other items; a float), up through blocks, stretched column flex items and percentages, unless its placeholder takes the rows' width. `SN530`: an image, video, iframe, embed or object in the rows of such a list with no height before its file loads (`Layout.sized`: no `width` and `height` attributes, no fixed height, box or `aspect-ratio` from the stylesheets). The plugin reads the stylesheets of the page's layout too (its `<link>`s and `<style>`s first), for images as well, and Google Fonts' stylesheets in builds when `fonts.inline` is on.

**`line-height: normal` (added 2026-11-14).** The text may be in any face of its `font-family` stack when the rows arrive: a web font shows only once loaded (`font-display: swap`, and during `block`'s period the fallback lays out), a family a platform lacks falls through. So the cascade counts the least ratio among: each family with a ratio from the build (`normalLineHeight(family)`), each family of the built-in table (src/compiler/system-fonts.ts: (ascent + descent) / unitsPerEm of Arial, Helvetica, Helvetica Neue, San Francisco as `-apple-system` and `BlinkMacSystemFont`, Segoe UI, Roboto, Times New Roman, Georgia, Courier New, Tahoma, Verdana, Noto, Roboto Mono, Cantarell, Ubuntu, Oxygen from @capsizecss/metrics 4.4.0, MIT; DejaVu and Liberation read from their files), up to the first generic family, which counts the least of its default on each platform (`GENERIC_FONTS`: `sans-serif` Arial, Helvetica, Roboto, DejaVu Sans, Liberation Sans, Noto Sans; `system-ui` and `ui-sans-serif` Segoe UI, San Francisco, Roboto, Cantarell, Ubuntu, DejaVu Sans, Noto Sans; `serif`, `monospace` and the `ui-` ones likewise; a default without metrics in the table, Times, Menlo and Consolas, counts as 1). A stack with no generic family ends in the browser's default, `serif`. A family neither the build nor the table has metrics for counts as 1, as does a stack the cascade cannot decide. The px value is the ratio × the font size less 1 (engines round the ascent and the descent to whole pixels). The build's ratios (Vite plugin): `familyLineHeights` takes each `@font-face` family of the page's stylesheets from its regular Latin face (no `unicode-range`, or one covering U+0041): its `ascent-override` + `descent-override` when it has both, else the first file that reads (`normalLineHeight(bytes)`, src/font-metrics.ts: `head`, `hhea`, `OS/2` of a ttf, otf, woff or woff2, not collections; the smallest of `hhea` ascender − descender and, with USE_TYPO_METRICS, the typo values, else the Windows ascent + descent, line gaps left out, as Chromium on Linux leaves out the typo line gap), else the table's ratio of its first `local()` font; `size-adjust` scales it (the smaller of scaled and not, as it may or may not scale the overrides). Files: a local URL (relative to the stylesheet, root, `public/`, `/@fs/`), a `data:` URI, or a fonts.gstatic.com URL, downloaded once into `node_modules/.cache/sinter/fonts/files`. Checked against Chromium on the installed system fonts (test/font-metrics.test.ts).

**Resource status early (added 2026-11-14).** `predictable()`: resources not embedded, `each` or `call`, whose `when` (if any) reads only `$url`, `$now`, `$locale` and helpers other than the built-in formatters, no state. When the page module mounts such a resource has no data (a collection `[]`, else null) and is loading exactly when its `when` holds. A binding reading such a resource is early when it also reads one of their statuses (`$meta.<name>.loading`, `.error`, `.loadedAt`, or the whole status); other status fields, and state fields, stay the page module's. The compiler writes that state into the binding's early function, on its syntax tree (strings are left alone): `$.$r.<name>` becomes `[]` (or `null`), `.loading` its `when` from the early table (`!!f[i]($)`) or `true`, `.error` and `.loadedAt` `null`, a whole status a table function's object (`f[i](loading)`: `{ loading, error: null, loadedAt: null, pending: 0, total: null, live: null }`, or for a paginated or stream-fed resource with getters that throw for `total`, `live` and the pager's fields, so a binding that reads one is the page module's), so the early runtime has nothing new. A binding over a resource with `cache`, or one next-page data can serve (the app has `prefetch`; not paginated, no `body`), first calls a function of the page's early table per such resource that throws when this tab's sessionStorage has an `sn:c:` or `sn:p:` entry of it (the literal start of its `src`, its `items` and `total` paths, as both key their entries): its rows would be there at mount. Any other resource throws in the early scope as before, leaving the binding to the page module. The page module adopts the branch as any early branch.

**Google Fonts (builds, 2026-11-09, `sinter({ fonts })`, on by default).** A page's `<link rel="stylesheet" href="https://fonts.googleapis.com/css…">` is downloaded at build time (as a current Chrome, so the font files are woff2 with `unicode-range` subsets), and the link points at a module the plugin serves it as, so Vite bundles it as one of the app's CSS files; the page gets `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` (the origins in its `url()`s; fonts load in CORS mode). The fonts, their `font-display` and the look are unchanged: the page loses a render-blocking request to another origin and the font files' connection is open when they are requested, as the Angular CLI does by default (its RealWorld demo has the preconnect). A file, not an inline `<style>`: no `style-src` change. Downloads are cached in `node_modules/.cache/sinter/fonts` by URL, so a later build needs no network; one that cannot download keeps the link and warns. Measured in RealWorld (Lighthouse mobile, median of 5): LCP 3.0 → 2.8 s alone, 2.3 s with the split early file (the article title needs both its data and its font). `{ inline: false }` turns it off. `{ preload: [...] }` (opt-in, decided 2026-11-10): faces to preload, each a family (its regular face, 400 normal) or `{ family, weight, style }`; a page whose Google Fonts stylesheets have the face gets `<link rel="preload" as="font" type="font/woff2" crossorigin>` for its Latin file (the `/* latin */` subset) after `<meta charset>`, in builds and dev. Opt-in, because a preload can make the first paint later: it competes with the render-blocking files, and while it loads, text in that face waits for it (measured by an earlier session in RealWorld: article LCP 1092 → 932 ms with the body font preloaded, Chrome throttled to slow 4G; with the font delayed 1.5 s and no throttling, first paint 80 → 172 ms). Two checks: the build fails when a page preloads a face of a family none of its stylesheets uses (a `font-family` or `font` declaration outside `@font-face` that lists it, or reads with `var()` a custom property whose value lists it, also through other custom properties, in its linked stylesheets, bundled or public, its `<style>`s and `style` attributes), or when no page's stylesheets have the face; in dev, warning 25 when the page did not render with the face in its first frames (3 after mount: a face loads only once something is laid out with it, and its `FontFace` in `document.fonts` stays `unloaded` until then, preloaded or not). Other stylesheets on other origins (an icon font's CSS) are left alone: whether one may be served from the app's origin is the app's decision. **Local fonts (2026-11-12).** Self-hosting is the app's: a local package (Fontsource) instead of the link, whose files Vite bundles as hashed assets (no requests to Google, `font-src 'self'`); sinter does not download Google's font files itself. In builds, a `preload` face no Google Fonts stylesheet has is looked up in the `@font-face` rules of the page's own CSS (linked, bundled or public, and its `<style>`s), after Vite has bundled it: the face with the family, a `font-weight` that is or spans the weight (a variable font's `300 900`), the style, and a `unicode-range` covering the Latin letters (minified `U+00??` too), its woff2 source; a relative URL resolves against the stylesheet. A face of a Google Fonts stylesheet matches the same way (`wght@400..700` is one face spanning the weights). Dev does not preload local faces: their CSS is a module there, not known when the page is served.

**Size.** The build prints each page's early script and the shared one, gzip, and warns above `sinter({ earlyBudget })` (default 10000 bytes, both together), naming the largest modules: a heavy import in the early module or in a helper an early binding calls is noticed.

**What this asks of markup.** Page chrome renders before the page module only outside data templates: a `data-sn-if="user"` around the navigation hides it until the user has loaded. Keep chrome out of such templates; put only what needs data inside.

### Lazy packages (added 2026-11-11)

Guide: [lazy.md](lazy.md); design: [proposals/lazy-code.md](proposals/lazy-code.md). `sinter({ lazy })` lists package names (`lazyOf` in `project.ts` refuses paths and subpaths; a subpath is covered by its package). Build side `src/lazy-build.ts`, runtime `src/lazy.ts`.

- **Generated modules** under `/@sinter/lazy/`: `<spec>.js` is the loader, `export const load = lazy(() => import('<spec>'), <chunk URL>, import.meta.url)`, one per package specifier, shared by everything that loads it; `<spec>.js?n=a,b` are one importer's stubs, `const $0 = (...a) => load().then((m) => m["a"](...a))`, exported under the package's names (`default` and reserved words included). The stubs carry only the names the importer calls, so no package's exports are read.
- **The transform** (the main plugin's `transform`, before TypeScript is stripped, app modules only: not `node_modules`, not `\0` ids): `scanLazy` parses the module (acorn with the TypeScript plugin) and, for each value import of a lazy package, rewrites only the specifier (lines stay, so no source map). Uses are found by a walk over value nodes (type annotations and TypeScript's type nodes skipped): a namespace member or a named/default import may only be a callee, and the call must be waited for: the operand of `await`, `return`, `yield` or `void`, an arrow function's body, the receiver of `.then`/`.catch`/`.finally`, or an element of `Promise.all`/`allSettled`/`race`/`any`'s array that is itself waited for; through `as`, `!`, `satisfies`, `?:` branches and the right of `&&`/`||`/`??`. Anything else is `SN324` at its offset (all of a module's, in one error). Shadowing is not tracked: a local with an import's name counts as the import. A component script (`src/components/<name>.ts` beside its HTML) is left as written. The helpers module that reaches a lazy package through static value imports (`reachLazy`: relative and root-absolute specifiers, type-only imports and re-exports are no edge) is `SN324` with the chain. `config()` adds the packages to `optimizeDeps.include` (no page imports them statically, so the dependency scan would not find them).
- **`sinter check`**: `lazyDiagnostics` scans the helpers, actions, config and early modules, the component scripts and every app module they import, with the same rules. The language server checks the markup's names only.
- **Chunk URLs**: the loader is written with `"__SN_CHUNK__<resolved id>__"`; the post plugin's `generateBundle` replaces each mark with the path of the chunk whose facade is that id, relative to the chunk the mark is in (`null` when there is none; dev passes `null`). Rolldown may split a package into a facade chunk and a body chunk that a lazy component script shares; the probe asks for the facade, which a deploy removes with the body (both hashes follow the package).
- **`data-sn-import`**: a binding of kind `imp` whose function calls each named loader (`$l$<n>`, imported by the page module) and drops its rejection; `process()` evaluates it once, when the element is rendered, and `write()` has no case for it (no runtime code). Not early, not a build-time constant. **`data-sn-preload`**: `CompileResult.preload`; the post plugin's `transformIndexHtml` writes `<link rel="modulepreload" crossorigin>` for the package's chunk and the chunks it imports, and for the page's lazy component scripts that load with it, before `</head>`; a package no module imports is a warning. Builds only. Both: the names must be in `lazy` (`SN324`, `lazyNames`); testing compiles with `lazy: true` (any name) and binds the loaders to no-ops.
- **Lazy component scripts**: the compiler asks `lazyScript(module)` (the plugin: `reachLazy` from the script); a script that reaches a package is imported as `later(() => import(module).then((m) => m[export]), [package loaders], <chunk mark>, import.meta.url)` instead of statically (`lazyScripts` in `compiler/index.ts`). The components feature sees `a.l`: the root waits in `waiting` with its latest props; when `later()` resolves and the root is still connected, the instance is created and `connected()` runs at once; a failure goes to `app.unhandled` (added to the App interface for features). The build logs each such script once, with its chains.
- **SN325** (`guardLazy`, the main plugin's `generateBundle`): from each page module, a walk over `importedIds` (static only). A module under `node_modules/<pkg>/` of a lazy package in that set is an error with the shortest chain; so is an app module in the set with a `dynamicImporters` entry in the set (any app, with or without `lazy`). Early files: a lazy package among an early file's or the shared head script's modules. The page's log line ends with `; lazy: <pkg> n kB gzip, <script> n kB gzip`: each lazy package or lazy script chunk a chunk of the page imports dynamically, with the chunks it imports that the page does not load (packages counted first).
- **Stale**: `lazy()` caches the import's promise and drops it on failure, then `loadError(e, url)`: `fetch(url, { cache: 'no-store' })`; a 404, a 410 or a 2xx that is not JavaScript is `new SinterError(null, null, 'this page is out of date: reload it', null, true)`; a network failure `status: 0`; any other status that status; JavaScript: the module threw (`status: null`). `SinterError` has `stale` (default false, the fifth constructor argument). The call feature probes an `import()` of the app's that fails inside an action when the browser's `TypeError` names the module (`dynamically imported module: <url>`; Chromium, Firefox; not Safari), which costs the call feature 288 B gzip (365 → 653 B).
- Deviations from the proposal: no preload links in dev (the pre-bundled module's URL is not known to the HTML transform); `void` counts as waiting (an explicit discard); `vite:preloadError` is not used (the error's own URL is); the static-and-dynamic rule of `SN325` applies to every app; testing's `render()` needs nothing for lazy scripts (tests pass the class).

## Expressions and scope
Every attribute value that is not a URL or a name is a JavaScript expression, parsed by a real JS parser at build time and checked against a closed set of identifiers.

### Two kinds of expression

| Kind | Used in | Allowed | Refused |
| --- | --- | --- | --- |
| Value | `text`, `attr`, `class`, `show`, `prop`, `for` (after `in`), `if`, `key`, `body`, `state`, resource `when` and `cursor`, `<sn-event>` `item`, `set` and `when`, URL interpolations | any JS expression, `new` on allowed globals, arrow functions as arguments, template strings, `?.`, `??` | assignment, `++`/`--`, `delete`, `await`, `import()` |
| Handler | `on-*`, `then`, `catch`, `optimistic`, `<sn-event>` and `<sn-resource>` `then` | statements separated by `;`, assignment to state variables, calls to store functions (actions run through `run('id')`) | declarations (`let`, `const`, `function`), loops, `await` |

Value expressions must be side-effect free, so the runtime may evaluate them any number of times.

### What belongs in markup
Markup holds filters, conditions, single assignments and short calls. Logic goes into a helper when it computes a value (pure: same arguments, same result, nothing else read or changed), or into an action when it has side effects (`data-sn-call`, see Local actions). A handler then applies the result to state, `state = fn(…)`, and does the rest in a few short statements:
```html
<li data-sn-on-click="sel = rowClick($event, sel, f.id, ids)">        <!-- not: four lines of if/else on $event.shiftKey -->
<input data-sn-on-keydown-enter="d.tagList = withTag(d.tagList, tag); tag = ''">
<button data-sn-on-click="open && close('detail')">                  <!-- a guard over one step -->
```
- A helper is a plain function in the helpers module, so it is unit-tested without a page; the page's test checks that the handler applies it (recipe: row selection).
- One condition per step: `a && (b = null, close())` is two steps behind one guard; write the steps as statements (`a && close()` plus `data-sn-on-close="b = null"` on the dialog), or compute the new state in a helper.
- Warning `SN507` flags what has outgrown markup: long handlers, comma sequences, guards over several steps, deep `?:` chains, long or block-bodied arrow functions (see Complexity).

### Identifier resolution
A free identifier resolves to the first match, innermost first:
- Loop variables of enclosing `data-sn-for` (and their index, e.g. `(c, i) in contacts`).
- State variables declared by the nearest enclosing `data-sn-state`.
- Resource names declared on the page.
- Magic names: `$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`.
- Registered helpers, helper namespaces and the store functions (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close`, `reset`, `emit`, `run`).
- Allowed globals (below).
Anything else is a build error with a suggestion: `contcts` → "did you mean `contacts`?".
Globals: JavaScript yes, browser no. Expressions may use the ECMAScript standard library, including `new`: `Math`, `JSON`, `Object`, `Array`, `Set`, `Map`, `Date`, `Intl.*`, `RegExp` and the rest. Three pure web-platform utilities are allowed as well: `URL`, `URLSearchParams`, `structuredClone`. Forbidden are browser and I/O APIs (`window`, `document`, `fetch`, `localStorage`, `navigator`, timers, …) and the language's meta-tools (`eval`, `Function`, `Proxy`, `Reflect`, `globalThis`, `WeakRef`, `FinalizationRegistry`, `Atomics`). Browser work belongs in islands. `$el` and `$event` are handed in explicitly, so their properties and methods may be used: `$event.preventDefault()`, `$el.focus()`, `$el.form.requestSubmit()`.
The sandbox is a guardrail, not a security boundary: expressions come from the page source at build time, never from users. A strict CSP blocks `eval` and `Function` at runtime as a second layer.
Time and randomness. `Date.now()`, `new Date()` without arguments and `Math.random()` in a value expression are warning `SN502`, because the binding never updates on its own. Use `$now` instead.

### Sandbox rules
- Static member access to `constructor`, `__proto__` and `prototype` is a build error.
- Computed member access (`obj[k]`) compiles to a guarded getter that throws on those three keys.
- Assignment targets in handlers are limited to state variables and their properties, `$url.<param>` and `$locale`. Resources are changed only through store functions.

### State
`data-sn-state` declares local, reactive variables for its subtree:
```html
<section data-sn-state="{ q: '', editing: null }">
  <input type="search" data-sn-model="q">
  …
</section>
```
The value must be an object literal so the compiler knows every name. State is page-local and not persisted unless an element opts in with `data-sn-persist`.

### Helpers
Helpers are plain functions called like any JS function: `date(c.birthday, 'short')`. No pipe syntax, because `|` is JS's bitwise OR and would change meaning in compiled code.

| Helper | Purpose |
| --- | --- |
| `date(v, style)`, `time(v, style)`, `datetime(v, style)` | `Intl.DateTimeFormat` with the current locale; `date` of a calendar date (`YYYY-MM-DD`) with `timeZone: 'UTC'` (added 2026-11-11) |
| `relative(v)` | `Intl.RelativeTimeFormat`, e.g. "3 days ago" |
| `number(v, opts)`, `bytes(v)` | `Intl.NumberFormat`, file sizes |

Each built-in builds its `Intl` formatter once per locale and options and reuses it (building one costs far more than formatting with it); a locale switch reads another entry, so nothing goes stale.

User helpers live in one module (`sinter.helpers.js` or `.ts`) whose export names the compiler reads; type-only exports are not helpers. A helper must be pure.
Helper namespaces. The helpers module may re-export a whole ES module as a namespace, e.g. `export * as m from './paraglide/messages.js'`. Templates call its members like functions: `m.inbox_title()`, `m.items_count({count: n})`.
- The compiler resolves `m.<name>` statically, following `export * from './…'` re-exports (relative paths only). An unknown member is error `SN206` with a suggestion.
- The page module imports only the members it uses, so unused ones (e.g. messages) are tree-shaken.
- Members must be named literally; `m[key]` is refused. A dynamic choice goes in a helper.
Any ESM module works as a namespace this way, an i18n library's message functions included. sinter also has built-in messages (next section), which take the name `m`.
Locale. `configure({ locale: { get, set } })` connects the app's locale source. `$locale` reads it; assigning `$locale = 'de'` in a handler calls `set` and re-runs every locale-dependent binding: those that call a namespace member or a `date`/`number` helper. With built-in messages sinter is the locale source itself.

### Messages
Built-in messages, from an inlang project's message files, so the inlang tooling (VS Code extension, Fink, machine translation) keeps working on the same files.
- Source: `project.inlang/settings.json` (or `sinter({ messages: 'path/to/project.inlang' })`; `false` turns it off): `baseLocale`, `locales`, and `plugin.inlang.messageFormat.pathPattern`, relative to the directory that holds the project (default `./messages/{locale}.json`). Each file is `{ "key": "text with {param}" }`. Plain strings only: no plurals or variants yet (a non-string message is a build error). Keys must be identifiers.
- Markup: `m.key()` and `m.key({ param })`, as a helper namespace that sinter provides: an unknown key is `SN206` with a suggestion, wrong or missing parameters are `SN208` in `sinter check` (types come from the base language's `{param}`s; a parameter is `string | number`). The helpers module must not export a namespace `m` as well.
- App code: `import { m } from '@tiaforge-ui/sinter/messages'`, typed by the generated `src/sinter.messages.d.ts` (written on every build and `sinter check`; generated, so it can be git-ignored). Only `m.key` is allowed: `m[key]`, `m` passed on or aliased are build errors with the position, because each page's language file holds only the keys it uses. A dynamic choice is a switch or a map of `() => m.key()` functions.
- A missing translation is the base language's text, reported once per locale at build.
- Per page and language the build emits `assets/<page>-<locale>-<hash>.js` (and the page gets the picker) when the page calls any key, with only the keys the page calls: its markup (components included) and every module of its page bundle (static and dynamic imports) and of its early file. The page bundle and the early file hold no message text: `m` reads a dictionary shared through a global (`Symbol.for('sinter.i18n')`), so the bundled-apart early file, the page bundle and the language file see one dictionary, and the page bundle fetches nothing again.
- Picking the language, before the first paint: the start of the shared head script (see First paint), its data in `data-sn-i18n` on its tag, runs while the head is parsed. It takes the stored choice (localStorage `locale`), else the first of `navigator.languages` that matches a locale exactly or by language (`de-AT` → `de`), else the base; sets `<html lang>`; and adds the page's language file as a module script. Nothing waits for it (decided 2026-11-10). The build writes the base language's text into the HTML (a text binding that calls `m`, outside templates; marked `data-sn-m`), so a visitor in the base language has the right text in the first frame. For another language the picker hides the marked elements (a constructed stylesheet, `[data-sn-m]{visibility:hidden}`: their space is kept) until the page module has rendered them (`use(app)` after mount removes it); the early script renders a message whose dictionary arrived during the parse, and skips the others. No visitor sees one language replaced by another. Measured (Chromium, German visitor, 20 loads): cold, the text hidden in the first frame and German shown at about the time the old hold showed it (slow 4G 566 → 578 ms) while the rest of the page painted earlier (576 → 440 ms); warm, German in the first frame on 15–20 of 20.
- Switching: `$locale = 'de'` (or `setLocale('de')` from the messages module) stores the choice, loads this page's file for that language once, sets `<html lang>` and re-renders what reads `$locale` (every message, `date()`, `number()`), without a reload. `onLocale(fn)` tells app code.
- Testing: `render(html, { messages: { en: {…}, de: {…} }, locale })` and `firstPaint(html, { messages, storage })`.

**Cost when unused.** An app without an inlang project pays nothing: no picker, no language file, no request more, and the messages module is imported only by pages and modules that call `m`. The core runtime has no i18n code path: in an app with an inlang project every page module wires sinter's locale source (`use()`) and waits for the dictionary, and a page gets the picker and its language file whenever it calls `m` at all: in its markup or in any module of its bundle or early file (a page whose markup has no `m` may still call it from a helper, an action or an island). A build of the same app before and after this feature is byte for byte the same (the `vite-app` fixture, checked 2026-11-08); a test guards that a build without messages contains no picker, language file or messages code.

### Derived names
`data-sn-let` names values computed from state, resources and loop variables, for the element and its subtree:
```html
<div data-sn-let="{ hits: suggestions(contacts, q), n: hits.length }">
  <ul data-sn-show="n"><template data-sn-for="h in hits">…</template></ul>
</div>
```
- Each entry is a value expression; later entries may use earlier ones.
- A name is compiled into every expression that reads it, so it is always current, costs no runtime and is tracked like the expression itself; handlers see the value at the time they run.
- Names are read-only (`SN203` on assignment) and may not share a name with a state or loop variable in their scope (`SN209`).

### Reactivity
State is plain, mutable JavaScript; resource items are immutable. The compiler works out what each handler may have changed, so the runtime needs no proxies and no read tracking.
Invalidation by path. After a handler runs, generated code marks the state paths it may have changed as dirty:

| Handler code | Marks dirty |
| --- | --- |
| `draft.fn_name = 'x'` | `draft.fn_name` |
| `draft.emails.push(e)` | `draft.emails` (list structure) |
| `draft.emails[i].value = x`, `i` a loop variable | `draft.emails.<i>.value`, that row only |
| `draft.emails[k].value = x`, `k` anything else | `draft.emails.*.value`, every row |
| `draft.emails.forEach(e => e.value = '')` | `draft.emails.*.value` (origin of `e` is known) |
| `helper(draft)` or anything opaque | `draft` (whole root) |

Each binding lists the paths it reads. A binding re-runs when one of its paths and a dirty path are prefixes of each other. `data-sn-model` on a path invalidates that path the same way.
Method classes. Known read-only methods (`includes`, `map`, `filter`, `slice`, `find`, `some`, …) invalidate nothing. Known mutators (`push`, `pop`, `splice`, `sort`, `reverse`, `shift`, `unshift`, `fill`; `add`, `delete`, `clear` on `Set` and `Map`) and unknown methods invalidate the receiver's path. Helpers and store functions only read their arguments.
Rows. A row re-evaluates only if its item object was replaced or its own path is dirty. Only the whole-root fallback checks every row. A write through the row's own element (`draft.emails[i].value = x`, `i` the list's index, a `{$i<tid>}` segment) reaches the row at that index only: the walk visits that row and skips the others without checking them (IR v2, added 2026-11-09), unless the list was reconciled since its rows were last all walked; then every row is checked as before. Typing in one row of a 20,000-row state list costs what it costs in a 10-row list (0.006 ms in the runtime benchmark, against 2.9 ms before). A write into another list indexed by the row's index (`other[i] = x`) still checks every row.
Default keys. Without `data-sn-key`, a `for` over resource items keys by the resource's `key` fields. A list the compiler cannot trace to a resource (a helper's result, `t in visible(tasks, q)`) keys each item that is a keyed resource's current item by that resource's key, at runtime, so a patch (which replaces the object) keeps the row. A `for` over a state array of objects keys by object identity (an internal id per object via `WeakMap`), so `splice` never re-binds rows. Arrays of primitives need an explicit key.
Writes from outside handlers. State changes through handlers, models, actions and a component script's `this.state` (which marks the field it writes), all of which the compiler sees: a field none of them writes is a build-time constant (see Build-time constants). There is no other way in: the instance has no state handle (removed 2026-11-11: `app.state(el).update()` wrote fields the build had made constants, and nothing followed). Dev builds snapshot each state root after every flush and warn when a root changed without invalidation ("state `draft` changed outside sinter: write it from a handler, or a component script's `this.state`"). Testing's `render()` has `state(el).update(fn)`, which marks the whole scope and refuses a field in `fixedState`, the fields the build made constants.
Resources are read-only in expressions. Assigning to, or calling a mutator on, a value rooted in a resource is error `SN205`, including loop variables over resources; the message shows the `patch()` equivalent. To edit resource data, copy it with `structuredClone(c)`, which returns unfrozen plain data.
Why this is sound. Value expressions cannot mutate and handlers cannot declare variables, so state cannot escape into a reference the compiler does not see.

## Attribute and element reference
The whole vocabulary is the tables below; any other `data-sn-*` name is a build error with a suggestion. All names are lowercase kebab-case, because HTML lowercases attribute names.

### Rendering

| Attribute | Value | Notes |
| --- | --- | --- |
| `data-sn-state` | object literal | declares state for the subtree |
| `data-sn-let` | object literal `{name: expression}` | derived names for the element and its subtree; see Derived names |
| `data-sn-text` | value expression | sets `textContent`; never HTML |
| `data-sn-attr` | object literal `{href: …, title: …}` | literal keys; `null`/`false` removes, `true` sets empty; URL values are checked (see Security). `checked`, `selected`, `indeterminate` and `value` also set the live property (see below) |
| `data-sn-class` | object literal `{unread: !m.is_read}` | toggles each class |
| `data-sn-style` | object literal `{'--color': cal.color, width: pct + '%'}` | sets each property with `style.setProperty` |
| `data-sn-show` | value expression | toggles the `hidden` attribute |
| `data-sn-transition` | value expression (a name) | the same thing on two pages; see Page transitions (added 2026-11-09) |
| `data-sn-prop` | object literal | sets JS properties; custom elements only |
| `data-sn-model` | state path, or `$url.<param>` | two-way binding for form controls (see below) |
| `data-sn-for` | `item in list` or `(item, i) in list` | on `<template>` only |
| `data-sn-key` | value expression | optional; defaults to the resource key or object identity, required for arrays of primitives |
| `data-sn-if` | value expression | on `<template>` only |
| `data-sn-else` | none | on a `<template>` directly after an `if` template |
| `data-sn-path` | URL patterns, space-separated | on `<html>` only; the path shapes the page is served for, e.g. `/editor /editor/:slug`; `:name` segments of the first matching pattern appear read-only in `$url` (added 2026-11-04) |
| `data-sn-persist` | storage key | persists the element's model or state in localStorage under `sn:`; refused on password and payment fields; storage failures are ignored |


### Form state through `data-sn-attr`
`checked`, `selected` and `value` attributes are only a control's default: once the user has changed it, the attribute no longer moves the control. So for these names, and for `indeterminate` (a property without an attribute), `data-sn-attr` sets the element's property as well as the attribute, whenever the bound value changes: a re-render, or an optimistic rollback, puts a control the user changed back to what the data says. A checkbox clicked and then rolled back unchecks. `null` and `false` remove the attribute and set the property to `false` (`value`: to `''`); `true` sets `checked`, `selected` or `indeterminate` (for `value`: `''`). A value that did not change is not written again, so text the user types stays until the bound value changes. (Changed 2026-11-08: before, only the attribute was set.)

On a control with `data-sn-model`, the model owns its state: `data-sn-attr` binding `checked` on a checkbox or radio, or `value` on any other control, is `SN102`; write the model's state instead. `value` on a checkbox or radio with a model is allowed (it is what the model collects), and so is `indeterminate`.

### `data-sn-model` by control

| Control | State value |
| --- | --- |
| text-like `<input>`, `<textarea>`, `<select>` | string |
| `type="number"`, `type="range"` | number; empty → `null` |
| `type="checkbox"` | boolean; if the model value is an array, the checkbox's `value` is added to or removed from it |
| `type="radio"` | the checked radio's `value`; radios with one `name` share one model |
| `<select multiple>` | array of selected values |
| `type="date"`, `"time"`, `"datetime-local"` | string as the control gives it (ISO format) |
| `type="file"` | not supported (`SN104`); files go through a form submit |

Text-like controls update on `input`, all others on `change`.

A model on `$url` (added 2026-11-13): `data-sn-model="$url.q"` binds a query parameter (`SN203` names the forms it takes; a path parameter or `$url.a.b` is `SN203`, as in a handler, since the setter goes through the same analysis; `data-sn-persist` on one is `SN102`: the URL keeps the value). The value is the URL's string: a number or range model compares numerically, so `1.0` stays as typed. A checkbox with a `value` attribute, or a `<select multiple>`, makes the parameter a list (see The URL). Its writes follow the history rules of The URL: a text field's at each typing pause; a number or range field's once its burst of steps (spinner clicks, arrow keys; each is a `change`) pauses, as one new entry; any other control's at once, as a new entry. The control is filled in the first frame like any model.

### Actions and events

| Attribute | Value | Notes |
| --- | --- | --- |
| `data-sn-get`, `-post`, `-put`, `-patch`, `-delete` | URL template | one per element |
| `data-sn-call` | one call of an action, `ns.fn(args)` | a local action instead of a request (see Local actions); one action per element |
| `data-sn-body` | value expression | JSON body; overrides form serialization |
| `data-sn-trigger` | DOM event name | overrides the default trigger |
| `data-sn-debounce` | milliseconds | delays the trigger, resets on each event; on an element without a method, delays its `data-sn-on-*` handlers the same way (the handler runs with the last event; `data-sn-model` still updates at once) |
| `data-sn-debounce-<event>` | milliseconds | delays only the `data-sn-on-<event>` handler, e.g. `data-sn-debounce-input="200"` next to an immediate `data-sn-on-blur`; overrides `data-sn-debounce` for that handler, `0` makes it immediate |
| `data-sn-concurrency` | `block`, `queue` or `latest` | mutations only; default `block` for forms, `queue` otherwise |
| `data-sn-optimistic` | handler expression | store changes applied before the request |
| `data-sn-then` | handler expression | runs after a 2xx response, `$result` = parsed body |
| `data-sn-catch` | handler expression | runs after an error, `$error` = error object |
| `data-sn-confirm` | value expression | a question asked before the action runs; no request when the answer is no, no question when the value is falsy |
| `data-sn-encoding` | `json` or `form` | `form`: the body is sent as `application/x-www-form-urlencoded` (see Request body) |
| `data-sn-apply` | `off` | turns write-through off for this mutation (see Write-through) |
| `data-sn-listbox` | the `id` of a suggestion list | on a text input: the combobox keys (see Suggestion lists) |
| `data-sn-on-<event>` | handler expression | plain event handler, no request; e.g. `data-sn-on-click` |
| `data-sn-on-keydown-<key>`, `data-sn-on-keyup-<key>` | handler expression | runs only for that key, with modifiers before it: `-j`, `-shift-n`, `-mod-enter`, `-escape`; see Key filters |

### Key filters
A keyboard handler can name its key in the attribute: `data-sn-on-keydown-<modifiers->key` (and `data-sn-on-keyup-…`), so a page binds each shortcut on its own instead of one `data-sn-on-keydown` that switches on `$event.key`. (Added 2026-11-08.)
```html
<body data-sn-on-keydown-j="cursor = nextRow(list, cursor)"
      data-sn-on-keydown-shift-n="weekStart = addDays(weekStart, 28)"
      data-sn-on-keydown-ctrl-space="marked = toggled(marked, cursor)"
      data-sn-on-keydown-escape="detailOpen = false">
```
- **Spelling.** After the event come modifiers, then exactly one key, separated by `-`, all lowercase. Modifiers: `ctrl`, `alt`, `shift`, `meta`, and `mod`, which is Cmd (Meta) on Apple platforms and Ctrl elsewhere (`mod` with `ctrl` or `meta` is an error). Modifiers may come in any order, each once. Keys: the letters `a`–`z`, the digits `0`–`9`, the named keys `escape`, `enter`, `tab`, `space`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `arrowup`, `arrowdown`, `arrowleft`, `arrowright`, `contextmenu`, `f1`–`f12`, and characters an attribute name cannot hold (or `-`, the separator) by name: `slash` /, `backslash` \\, `question` ?, `period` ., `comma` ,, `semicolon` ;, `colon` :, `quote` ', `backquote` \`, `minus` -, `plus` +, `equal` =, `asterisk` \*, `bracketleft` [, `bracketright` ]. Anything else is `SN101` with a suggestion (`esc` → `escape`, `cmd` → `meta`, `?` → `question`).
- **Case.** HTML lowercases attribute names, so `data-sn-on-keydown-N` would silently be `…-n`; the compiler reads the source spelling and reports uppercase in a key filter as `SN101` ("write N as `shift-n`"). Uppercase N is `shift-n`.
- **What is matched: `KeyboardEvent.key`,** the character or key the user's layout produced, not `code` (the physical key). A shortcut is the letter printed on the key: `z` is Z on a German keyboard too, and `question` is ? whether it is Shift+/ (US) or Shift+ß (German). Letters compare without case, with Shift decided by the filter (`n` is n, `shift-n` is N; Caps Lock does not matter). When `key` is not a Latin letter at all (a Cyrillic or Greek layout, or a dead key from Option on a Mac), a letter filter matches the physical key instead (`code` `KeyN`), so `ctrl-n` still works there.
- **Modifiers are exact.** The Ctrl, Alt, Meta and Shift held must be the ones the filter names: `j` does not run for Ctrl+J, and `escape` not for Shift+Escape. The exception is Shift for digits and named characters (`1`, `question`, `slash`…): the character already says whether Shift was needed, so it is not checked unless the filter names `shift`; with AltGr held, Ctrl and Alt are not checked for them either (AltGr reports both on Windows).
- **Keys in fields belong to the field.** A filter on an ancestor does not run while focus is in a text `<input>`, a `<textarea>`, a `<select>` or contenteditable content, and does not take Enter or Space from a focused button, link, `<summary>`, checkbox, radio or other button-like input (other keys still run there). A filter on the focused element itself does: `<textarea data-sn-on-keydown-mod-enter="send()">`. There is no exemption for Escape: in a search field it clears the field, in a field of a dialog it closes the dialog. A handler that must see keys from fields uses a plain `data-sn-on-keydown` and tests `$event.key` itself, or sits on the field.
- **Default and repeats.** A filter that matches calls `$event.preventDefault()` before its handler runs (Space does not scroll, `slash` does not type into a field it focuses); a plain `data-sn-on-keydown` never does, so it is the escape hatch for a key whose default should happen. Held keys repeat, and every repeat runs the handler (holding `j` moves on); a handler that should not repeat checks `$event.repeat` (`$event.repeat || (marked = toggled(marked, cursor))`). During IME composition no filter matches.
- **Which handlers run.** The nearest element (from the target up) that handles the key wins (see Events, Which handlers run): one whose filter matches, or whose plain `data-sn-on-keydown` ran and called `$event.preventDefault()`. So a `<dialog data-sn-on-keydown-escape>` does not swallow the `j` meant for `<body>`, and neither does a grid's plain arrow-key handler that prevents only the arrows it uses. On that element, the matching filters and the plain handler all run, in attribute order; the plain one runs for every key. Several filters can match one event (`ctrl-shift-k` and `shift-ctrl-k`). A plain key handler that does not prevent a key passes it on (changed 2026-11-08; it used to keep every key from its ancestors).
- **Where.** Keys go to the focused element, or to `<body>` when nothing is focused, so page-wide shortcuts belong on `<body>` (or `<html>`); a filter on an element runs while focus is inside it.
- **Debounce.** `data-sn-debounce-keydown-j` delays only that filter's handler; `data-sn-debounce-keydown` only the plain one, `data-sn-debounce` all of the element's handlers. `preventDefault()` is called at once.
- **Types.** `sinter check` types `$event` in a key filter as the `KeyboardEvent` of its `keydown` or `keyup`.
- The runtime part is a feature module (`@tiaforge-ui/sinter/keys`), imported only by pages with a key filter. A custom event named `keydown-…` or `keyup-…` cannot be handled with `data-sn-on-*`.

### Declaration elements

| Element | Attributes | Notes |
| --- | --- | --- |
| `<sn-resource>` | `name`, `src`, `call`, `each`, `key`, `items`, `total`, `order`, `when`, `cache`, `then`, `type`, pagination attributes | see Resources and Pagination |
| `<sn-sync>` | `src` | one server event stream |
| `<sn-event>` (child of `<sn-sync>`) | `name`, `resource`, `op`, `item`, `set`, `when`, `fallback`, `then`, `type` | maps one server event to a change message, and runs `then` after it |

Custom elements with a hyphen are valid HTML, so these pass a validator before compilation.

### URL templates
URLs are literal strings with `{expression}` interpolations. Each interpolated value is passed through `encodeURIComponent`.
```html
<button data-sn-delete="/api/contact?account_id={c.account_id}&uid={c.uid}">Delete</button>
```
A query parameter whose whole value is one interpolation that evaluates to `null` or `undefined` is left out, with its separator: `/api/articles?tag={$url.tag}&limit=10` requests `/api/articles?limit=10` when there is no tag. An empty string is still sent (`tag=`). (Added 2026-11-04.)

A query parameter whose whole value is one interpolation that evaluates to an array is sent once per item, as a repeated key, each item URL-encoded: `/api/search?q={q}&cal={cals}` with `cals = ['a', 'b']` requests `/api/search?q=…&cal=a&cal=b`, as `data-sn-encoding="form"` sends an array in a body. `null` and `undefined` items are left out, and an empty array leaves the parameter out like `null`. In the path an array is refused: the request is not made and the error takes the resource's or action's error path (`refused an array as a URL path value`), and `sinter check` reports it (`SN208`, the value must fit `PathValue`: anything but an array). An array that is only part of a query value (`?tags=t:{list}`) is converted with `String()` (comma-joined) and encoded, as before. `SN505` checks parameter names, so a repeated key counts as the one name the template writes. (Added 2026-11-08.)

A resource whose `src` interpolates state or `$url` refetches when those values change.

#### Paths relative to an API (added 2026-11-14)
With `sinter({ apis })` (`ApiOptions`, resolved by `resolveApis` in `compiler/apis.ts` into `ApisDef`: each API's `base`, its spec indexes into `openapi`, `credentials`, `headers` and `shapes`), the value of `src` on `<sn-resource>` and `<sn-sync>` and of an action's method attribute is `[api:]/path[?query]`. `api:` names an API (`site` is built in, base `''`); without it the path goes to `defaultApi` (the only API when one is configured; `SN326` when several are and none is named). The compiler parses the template from after the prefix, checks that it starts with a literal `/` (`SN207`), and puts the API's base in front of its first literal: the compiled template is the one the absolute URL gave before, so the runtime, the early file, preloads, prefetching and embedding see the same URLs. An absolute URL is `SN328` (its message names the API-relative path). The `operations` of an API are a generated OpenAPI document (`operationsDoc`, `OpenApiSpec.config` = the API's name), so they match like the spec's.

The operation is `matchOperation` over the API's specs only, with the path relative to them (no server prefix) and the method of the place: `GET` for a resource (`POST` with `method="POST"`) and a stream, the attribute's for an action. No match is `SN326` with the closest path of that method. Query parameter names written literally, and those `paginate` sends (`sizeParam`, `offsetParam` or `pageParam` by mode, `directionParam`, the cursor's keys), must be declared by the operation or the shape's `query` (`SN327`); `name[field]` counts as `name` when that parameter is `style: deepObject`; a required one that is not given is `SN327`. Without `apis` nothing of this applies.

A resource's `items`, `total`, `key` and `type` come from the operation's shape (`defaults`/`operations`, keyed `METHOD /path` as the spec writes the path), else the element; the declaration pass reads `key` that way, so a configured key makes a collection. An element restating a configured value is `SN518` (equal) or `SN330` (different). An operation of the generated document has no response schema: its type is the shape's `type`, else `SN504` in check mode.

`method="POST"` on a resource (`ResourceDef.body`, the function of its `body` attribute) loads with a POST of the body's value; the loader's identity is `URL + "\0" + JSON(body)`, which `changed()` compares and the shared-request map keys by. Such a resource is in `noEarly` (no preload, early request or embedding), is left out of `prefetchParts`, and refuses `cache`, `paginate` and `each` (`SN401`).

The page module calls `$apis([{ n, b, c?, h? }])` when an API has `credentials` or `headers`. The request layer finds a URL's API by the longest base it starts with (`apiFor`), sets its headers the request does not have and its credentials before the middleware chain; `apiOf(url)` names it. `EarlyIR.res[].a` gives the early file the same settings; its `take` compares the page module's request with what it sent (method, credentials, every header). A preload link is written for a resource whose API has no headers and no `credentials: 'omit'` (`crossorigin="use-credentials"` for `include`). `EmbedSlot.headers` carries the static headers to the server layers.

### Magic names

| Name | Available in | Value |
| --- | --- | --- |
| `$event` | `on-*`, `then`, `catch`, `data-sn-body`, `data-sn-call` arguments | the DOM event (for an action, the one that triggered it; `null` when `run('id')` started it, except for a form) |
| `$el` | everywhere | the current element |
| `$url` | everywhere | reactive view of `location.search` params plus the path parameters of `data-sn-path`; assigning to `$url.x` writes the URL, with a history entry when a user's event caused it (see The URL; path parameters are read-only, `SN203`) |
| `$now` | everywhere | current time as a `Date`, refreshed every 60 s; the timer runs only on pages that use it |
| `$locale` | everywhere | current locale from `configure({ locale })`; assignable in handlers |
| `$result` | `then` | parsed response body (action); what the load stored (`<sn-resource then>`) |
| `$error` | `catch`; inside a `<form>` | `{status, body, message, detail}`; `detail` is the server's message or a thrown error's, else `null`. In a form: its last failed send, else `null` (see Server validation errors on the form) |
| `$meta` | everywhere | per resource status fields (see Resources and store) |


### The URL (`$url`)
Decided with the project owner (2026-11-13, docs/proposals/url-bindings.md): `$url` parameters are bindable like state, and history behaves as a user expects from a single-page app: Back steps through pages and filters, a typed search is one entry. No attribute overrides the rules, and typing waits for the pause resources already use (250 ms).
- Values. A compiled write to `$url.<name>` (`=`, `++`, `delete`, a method that changes it) goes through `$.$u(name, …)` (location.ts), which normalizes it: strings stay; numbers are written as their string (`0` → `'0'`); `true` → `'1'`; `false`, `null`, `undefined`, `''` and `[]` delete the parameter; arrays become string arrays; an object, a function or an instance deletes the parameter, with a dev warning (`SN212` where the compiler sees one written). So `$url` in memory equals what a reload reads, and a handler reading back its own write sees the string. Reads are plain JavaScript truthiness, which the servers' conditions match (`'0'` is non-empty, so truthy). Arithmetic needs `+$url.page`.
- Kinds. Each write asks for a history entry where it happens: `push` in a handler run by a trusted DOM event (a click, a select's `change`) and what it causes (`emit`, an action it started, that action's `then`/`catch`, a debounced handler), for a select, radio, checkbox or component model, and for `page()`; `typing` for a text-field model (`input`); `replace` for a handler hearing `input` (unless it is on a checkbox, radio or select itself: the compiler makes that a `push`, a choice; a handler higher up that hears it replaces), a resource's or stream's `then`, `sn-error` handlers and anything no user event caused, and for a list's reset to page 1. The compiler fixes the kind of a model's writes and of a choice's handler (`$u(name, v, kind)`), and sends writes to an array parameter to `$l`; for the rest the core keeps the outermost event of the dispatch (`app.ev`) and location.ts pushes when it is the user's (`Env.trusted`, default `isTrusted`; the testing module counts its simulated events) and not `input`, so handlers for `then`/`catch`, `sn-error` and custom events get it only when a user event caused them. A form submitted by `run()` is not the user's.
- Per flush pass the strongest kind wins (`push` > `typing` > `replace`), and one `afterFlush` hook writes once; a later pass of the same flush writes nothing new or replaces. A write whose query equals the current one does nothing. The query starts from the current one and sets or deletes the changed names, so the order of the others is kept; path parameters never go to the query. History calls are wrapped (Safari throws when called too often): a dev warning, `$url` kept.
- Typing commits after one 250 ms pause (a timer counted as busy, so the testing module's `settle` waits); the first commit of a run pushes, later ones replace. A run ends at a push, at `change` on the field (Enter, or leaving it) and at popstate. A replace while a commit waits goes into that commit.
- Back and Forward (`popstate`) read `$url` again, drop a waiting commit, end the run and write nothing: re-serializing could differ from the address bar (unsafe names are dropped on read). What they cause (a list loading the URL's page) writes nothing either.
- Array parameters. A parameter bound to a `<select multiple>` or to a checkbox with a `value` attribute is a list, decided at build time (`IR.urlArrays`), unlike a state checkbox, which decides from its current value at run time. It always reads as an array (`[]` when absent), written as repeated keys (`?tag=a&tag=b`); other parameters read the last value of a repeated name. A single value written to one is wrapped. Errors: the same parameter bound as a list and as one value, or a list literal written to a parameter that is not a list (`SN210`); a bare list in a condition, `data-sn-if`, `data-sn-show`, `when`, `?:`, `!`, `&&`/`||` (`SN211`: use `$url.tag.length`). The runtime, the early file, next-page data (with the target page's list) and the server layers read lists the same way; a `when` that reads one is the browser's to evaluate.
- Pagination in the URL is `page-model` (see Pagination).
- Same-page links (added 2026-11-14, docs/proposals/same-page-links.md; query-links.ts). The invariant: a same-page link shows what loading its URL would show; only `data-sn-state` and the scroll position differ. A click is the page's when it is a primary-button `click` without Ctrl, Meta, Shift or Alt whose default nothing prevented, on an `<a href>` or `<area href>` without `download`, a `target` other than `_self` or `rel="external"`, whose URL has the page's origin and path, and (after a pending typing commit is committed, its own entry) every query parameter that differs (by name and values, not as a string) is in `IR.urlReads`. Then: `pushState` the link's URL as written without its hash (a refused call: `Env.navigate` to it), `$url` read again, `ext.location.arrive()` (the flush is as after Back: a `page-model` list loads the URL's page and is not reset), the hash a native fragment navigation in the new entry (`Env.fragment`, default `location.replace`). The same query: a `#hash` (the link's or the address bar's) is the browser's, otherwise nothing happens. Any other click is the browser's. `IR.urlReads` comes from the IR's dependencies (`eachPath`): the first segment after `$url.`; a page that reads `$url` whole or by a computed name gets none. The compiler loads the module (with location.ts) on a page with read query parameters (path parameters of any pattern excluded), no `<base href>`, and a link it sees goes to the page: a static `href` that resolves (from the page's file, for a relative one) to one of the page's URLs (`pagePaths`, plus its file, `/about.html`), or a `data-sn-attr` `href` whose literal start does (followed through `+`, template literals, both branches of `?:` and both sides of `||`/`??`; a path seen only in part fits a pattern segment by segment). The compile result carries `sameLinks`. Next-page data skips a link that would stay on the page (`ext.sameLink`), and such a page's inline Speculation Rules leave out `{ href_matches: '?*', relative_to: 'document' }` (the page's own path with any query; checked against Chromium's preload candidates; the build names each distinct inline hash), as does a rules file for a response header once any page has same-page links. `SN519`: a pager link (a static query-only `href` that sets a `page-model` parameter, not also bound) that drops other query parameters the page reads.


## Resources and store
A resource is a named, page-wide cache of one piece of server data: either a keyed collection or a single object. Templates read it by name; only store functions change it.
```html
<sn-resource name="contacts" src="/api/contacts" items="contacts"
             key="account_id,uid,addressbook_href" order="fn_name"></sn-resource>
<sn-resource name="addressbooks" src="/api/contacts" items="addressbooks" key="account_id,href"></sn-resource>
```

### Attributes

| Attribute | Required | Meaning |
| --- | --- | --- |
| `name` | yes | identifier used in expressions; must be a valid JS identifier |
| `src` | yes, or `call` | URL template; refetch when its interpolated values change |
| `call` | instead of `src` | one call of an action, `ns.fn(args)`; the resource loads from the function and reloads when the arguments' inputs change (see Local actions) |
| `key` | for collections | comma-separated item fields forming the identity; absent = single object |
| `items` | no | path to the array in the response; default: the response itself |
| `total` | no | path to a total count, exposed as `$meta.<name>.total` |
| `order` | no | field kept sorted on upserts, `-field` for descending; locale-aware for strings |
| `when` | no | value expression; while falsy, the resource is empty (null or []) and a running request is aborted |
| `cache` | no | page-load cache: show the data from the last page load at once, then revalidate (see Data sources). No value: any age; `30s`, `10m`, `2h`, `1d`: ignore older data |
| `refresh` | no | `30s`, `5m`, `1h` (at least `1s`): reload in the background once this long has passed since the last load, whatever caused it (see Background refresh) |
| `each` | no | `item in list`: one request per list item, `src` evaluated with the item in scope; the responses form one collection (see Fan-out resources) |
| `then` | no | handler expression run after each successful load, with `$result` (see After a load) |
| `type` | no | the type of what `items` selects, for `sinter check` (see Type checking) |


### Behaviour
- Shared requests. Resources with the same resolved `src` share one in-flight request (e.g. one endpoint that returns two lists).
- Latest wins. When `src` changes, the in-flight request is aborted; a late response for an old URL is discarded.
- Typing. When the change to `src` or `when` comes only from keystrokes (`input` events of a text field with `data-sn-model`: `<input>` of a text-like type, `<textarea>`), the request waits until 250 ms have passed without another keystroke; the shown data stays, `loading` is not set. Any other change (a select, a checkbox, a handler, `$url` written by a handler) is requested at once, and ends a running pause. A text field bound to `$url` (`data-sn-model="$url.q"`) is typing too: the request and the URL's commit wait for the same pause. Typing back to the current URL within the pause sends nothing.
- Priority. A resource that only elements inside `<dialog>`s read (bindings, state initializers, actions and their handlers there, templates of the dialog included) is not needed for the first paint: its requests carry `priority: 'low'` (its preload link `fetchpriority="low"`), so the visible content's requests get the bandwidth first. A read anywhere else, in another resource's `src`, `when` or `then`, or in a stream's `src` or events, keeps the default priority. Embedded data is never marked.
- Coming back. A `pageshow` with `persisted` (back/forward cache) and `online` refetch every resource that has a URL, since the data may have changed meanwhile. Resources a stream feeds are left to the stream's reconnect, which refetches them (see Connection rules).
- Status. `$meta.<name>` exposes `loading`, `error` and `loadedAt`. During a refetch the old data stays visible; `loading` is true (not for a background refresh, see Background refresh).
- Unchanged responses (added 2026-11-09). A reload of a `src` resource whose response carries the version (`ETag`, else `Last-Modified`) of the response the data was last replaced with, while nothing has changed the data since (no server event, action result, confirmed optimistic layer, or write during the load), is the data the store already holds: it is neither parsed nor stored, and nothing re-renders. Otherwise it is a successful load like any other, so a page behaves the same with and without the check: `loadedAt` moves, `error` clears, and `then` runs with the `$result` of the load that stored the data (decided 2026-11-09: the module saves work, it does not change what handlers see). A `304` that reaches the page (a middleware sent `If-None-Match` itself) counts the same. It applies to every reload on pages whose resources are reloaded as a matter of course, those with `refresh` or an `<sn-sync>`: `refresh()`, a `refetch` event, a reconnect, `online`, a bfcache restore, a refresh. The compiler adds the module (`@tiaforge-ui/sinter/versions`) to those pages only; on others every reload is stored, as before (decided 2026-11-09: most pages reload a URL rarely, and the check would cost every page about 300 B gzip in core). Per request URL, so each page of a paginated resource has its own; not for `call`, `each` and embedded data. sinter sends no conditional headers: the browser's HTTP cache does, when the server sends `ETag` (or `Last-Modified`) with `Cache-Control: no-cache`, and answers with the cached body on a `304`. Cross-origin APIs also send `Access-Control-Expose-Headers: ETag`, or sinter cannot see it and every response counts. (Sending `If-None-Match` from sinter was decided against: it would duplicate the browser's cache, and it is not a CORS-safelisted header, so every cross-origin reload would need a preflight.)
- Identity. Keys are compared as joined strings. A duplicate key in a response is a dev-mode warning; the last one wins.
- Immutability. Items and the lists that hold them are frozen in dev builds (production relies on `SN205`; frozen arrays are slow to copy and filter). Changes always replace the item object.
Single-object resources (no `key`): `upsert` replaces the object, `patch` merges fields into it, `remove` sets it to `null`. Their change messages need no key.

### After a load (`then`)
`then` on `<sn-resource>` is a handler expression, like `data-sn-then` on an action, run after each successful load of the resource (added 2026-11-08, for Caley's share-to-mail and mark-read):
```html
<main data-sn-state="{ compose: null }">
  <sn-resource name="pending" call="mail.pendingCompose()"
    then="compose = $result ? composeDraft('new', null, identities, '', null, $result.files, $result.subject) : compose; $result && showModal('mail-compose')"></sn-resource>
```
- `$result` is what the load stored: what `items` selects (the response itself without `items`, the function's result for `call`), the same value the store received, before `order`. For a paginated resource it is the page just loaded (in `append` mode: the new items only); for an `each` resource, the items of the one source that answered.
- When: after every response the store takes: the first load, `refresh()`, a `refetch` from a server event (or a reconnect), a change of `src`, `call` arguments or `when` that loads again, every `page()`, and embedded JSON (the page's first load). For `each`, once per source response, not once per round. Not for the cached data `cache` shows at once (only once the revalidation succeeds), not for a failed, aborted or superseded load, not when `when` empties the resource, and not for changes that are not loads: optimistic layers, `upsert`/`patch`/`remove` from handlers or server events, action results.
- Also for a reload answered with the version of the data already shown (see Unchanged responses under Behaviour): `$result` is what the load that stored the data stored.
- So it runs again on every refetch: a handler meant to run once guards itself with state or with the data, one guard per step (`!opened && showModal('x'); opened = true`, `$result && …` for a resource that is empty when nothing is pending). A handler that refreshes its own resource loops.
- Order: after the store has the response (writes made during the load replayed on top) and `$meta.<name>` is current (`loading` false, `loadedAt` set, `error` null), so the handler reads the resource and other resources as they now are. Its state writes re-render like any handler's, in the same flush.
- Scope: the scope the resource's `src` and `when` see, so the state around the `<sn-resource>` element, which it may assign, and every resource. Store functions work, `run('id')` included (the mark-read case in Running an action from a handler); there is no element, so `close()` names its dialog and `reset()` and `emit()` are errors (`SN203`), as in `<sn-event then>`. `$event` and `$error` are not defined here; `$result` is not defined in the resource's other expressions. The `each` item name is not in scope.
- An exception in the handler is logged; the load still counts as successful.
- A resource with `then` counts as used: one that only its own `then` reads, with or without `$result`, is not `SN501`.

### Background refresh (`refresh`)
For data that no stream keeps current, or as a check on one that may miss events (a buffering proxy, a server that drops events without closing the connection), `refresh` reloads a resource once its last load is that old (added 2026-11-09):
```html
<sn-resource name="jobs" src="/api/jobs" key="id" refresh="30s"></sn-resource>
```
- The clock starts at the end of every load, whatever caused it: the first load (embedded data included), `refresh()`, a `refetch` event or a stream's reconnect, a change of `src`, `call` arguments or `when`, `page()`. A resource that a stream keeps reloading is rarely refreshed; one that only receives `upsert`/`patch` events is, since those are not loads. The wait is ±10 % (`random()`), so pages opened together do not reload together.
- Named `refresh`, not `poll`, decided 2026-11-09: it sets how old the data may get, not how often to send a request, and `refresh="30s"` is what `refresh('jobs')` does, by itself, after 30 s (as `<meta http-equiv="refresh">`). `revalidate` would blur with `cache`, which revalidates already.
- A background load: `$meta.<name>.loading` stays false (a `loading` binding does not flicker every 30 s); otherwise it is the resource's ordinary reload, with `then`, the page-load cache and writes made during it replayed on top. A `refresh()` or event in the same task makes it an ordinary load again. With `paginate` it reloads the current page; with `each`, every source.
- Hidden: while the page is hidden (a background tab, a prerendered page) nothing is reloaded; a refresh that fell due meanwhile runs when the page is shown again (`visibilitychange`); one that did not runs at its time.
- Nothing to load: while `when` is falsy there is no refresh; the load that follows starts the clock again. A load in flight when the refresh falls due counts as the refresh.
- Failure: `error` is set as for any load, and the next try waits twice as long each time, up to 30 s (never sooner than `refresh`), back to `refresh` after a success. A failing refresh is reported (`sn-error`, `onError`) once, and again only after a load has succeeded: an outage gives one toast, not one per try. Offline, refreshes fail and back off; `online` reloads every resource no stream feeds, as before, which starts the clock again.
- Values: a number and `s`, `m` or `h`, at least `1s`; anything else is `SN401`. The module (`@tiaforge-ui/sinter/refresh`, 0.4 KB gzip) is added only to pages that use `refresh`.
- Servers: answer unchanged data with the same `ETag` (see Unchanged responses under Behaviour), and a refresh costs a `304` and no rendering.
- Cost (2026-11-09): `refresh` is 394 B gzip and `versions` 438 B, each only on the pages that need it (`refresh` shares the retry helper, `backoff.ts`, with the stream module). Core grew from 13,960 to 14,154 B gzip for the hooks both use (background loads, the end-of-load callback, shared responses read lazily); the RealWorld article page (no stream, no `refresh`) from 25,721 to 25,915 B.
- The testing module's `render()` drives it: `advance(ms)` moves the clock, `visibility('hidden' | 'visible')` hides and shows the page.

### Fan-out resources (`each`)
Some APIs list a collection per parent: mailboxes per account, events per calendar. `each` loads one request per item of another list and keeps the results as one collection (added 2026-11-05):
```html
<sn-resource name="accounts" src="/api/email/accounts" key="account_id"></sn-resource>
<sn-resource name="mailboxes" each="a in accounts" src="/api/email/mailboxes?account_id={a.account_id}"
             key="account_id,name" order="name"></sn-resource>
```
- A source is identified by its resolved URL. When the list changes, only new sources load, and a removed source's items are dropped; the others keep their data.
- An item belongs to a source when it came in that source's last response, or when `src` resolves to that source's URL with the item in place of the list item (here: its `account_id`). A source's next response replaces exactly its items, including ones a server event added.
- `key` is required and must tell the sources' items apart (here `account_id` is part of it). `paginate`, `total` and `cache` do not combine with `each`.
- It ships as the `each` module, imported only by pages that use it.
- `$meta.<name>.loading` is true while any source loads; `loadedAt` is set once every current source has answered, or, for an empty list, once the list's resource has loaded. `error` is the last failed source's.
- `refresh(name)` reloads every source. A `refetch` from a server event reloads only the source its payload resolves to, the same way (`mailboxes_changed` with `{account_id}`), and every source otherwise.
- `when` applies to all sources at once: falsy drops every item and aborts every request.
- Prefer one endpoint for the whole collection when you control the server: `each` makes one request per list item.

### Status fields
Status lives under `$meta.<name>`, never on the data itself. The field set is fixed:

| Field | Type | Meaning |
| --- | --- | --- |
| `loading` | boolean | a request for this resource is in flight |
| `error` | `{status, body, message}` or `null` | the last load failed; cleared on success |
| `loadedAt` | number (ms) or `null` | time of the last successful load |
| `pending` | number | optimistic layers whose request has not settled |
| `total` | number or `null` | from the `total` path; adjusted by optimistic removes |
| `page` | number | offset pagination only |
| `pages` | number or `null` | paginated, when `total` is known |
| `from`, `to` | number | paginated: 1-based positions of the current page |
| `hasPrev`, `hasNext` | boolean | paginated |

Any other field is a build error (`SN303 unknown-meta-field`), and so is a pagination field on a resource without `paginate`.

### Store API
The store has no knowledge of the DOM, fetch or SSE. Everything else talks to it through this interface:
```ts
interface Resource<T> {
  get(key: string | T): T | undefined;
  all(): readonly T[];            // in `order`
  replace(items: T[]): void;      // full load
  upsert(item: T): void;          // insert or replace by key
  patch(key: string | T, fields: Partial<T>): void;
  remove(key: string | T): void;
  refetch(): Promise<void>;
  subscribe(fn: (change: Change<T>) => void): () => void;
}
```

### Data sources
A resource's data can arrive through pluggable sources. v0.1 ships two:
- Fetch loader: loads `src` through the request layer.
- Embedded JSON: if the page contains `<script type="application/json" data-sn-data="contacts">`, that payload is the initial data and no first request is made. Who writes it (a server, a build step) is up to the app; the build describes the placeholders for a server that does (below).

Embedded data for a server (added 2026-11-10):
- An empty placeholder (only whitespace) is no data: the resource loads as if it had none, with no dev warning. It is what a server leaves when it has nothing to write (no data for this request, an error, its time limit), so the page then requests the data itself. Invalid JSON is still dev warning 5.
- A build with placeholders writes `sinter-embed.json` next to the pages (`{ version: 2, pages: [{ file, paths, arrays?, data: [...] }] }`; version 2 since 2026-11-13, which older layers refuse: `arrays` lists the page's array parameters, which a server reads as lists and expands as repeated keys): for each page, its file in the output, the paths it answers at (as for next-page data: `data-sn-path`, else where its file is served), and per placeholder its `data-sn` id, its resource and the request the browser would make: `src` as literal strings and `{ url: name }` for a `$url.name` read, or null when anything else is in it (a helper, state, another resource), or for `call` and `each`. `when: true` says the resource has a condition only the browser evaluates. A paginated resource has `query`: its first page's parameters as the pager sends them (`firstParams`), which the server sets on the template's URL as the runtime does (`withParams`); the runtime takes embedded data as that first page, so `page()` moves on from it. The `$url` values go in as the runtime puts them (src/runtime/url.ts: encoded, an absent query value leaves its parameter out). A server fills what the template describes and leaves the rest, or the app gives it a function per resource.
- `sinter({ embed: true })` (added 2026-11-10): builds served by such a server. Every resource without a placeholder whose `src`, `when` and `page-model` read only `$url`, constants and helpers gets one, last in the head (after the tags Vite adds, so a server that streams the page up to the first placeholder sends the stylesheets and scripts first): not `call`, `each`, or `early="off"` (a request a middleware changes, such as one carrying the user's token). Those resources are neither preloaded nor requested by the early file: their data comes with the page. `vite dev` is unaffected.
- `when` in the manifest: `true` when only the browser can evaluate it, else a condition over `$url`: `{ url }` (present and not empty), `{ url, eq }`, `{ url, ne }` (against a string literal; an absent value equals nothing), `{ not }`, `{ and }`, `{ or }` (from `!`, `&&`, `||`). A paginated resource with `page-model="$url.<name>"` has `start: { url, key, size, skip?, query }`: from page 2 on, the parameters are `query` with `key` set to the page, or with `skip` to (page - 1) × `size`. A `start-page` that reads anything else makes `src` null.
- `packages/sinter-axum`: such a server for Rust, a `tower` layer (axum). `Embed::from_dir(dist).api(router).build()` refuses, one line per problem, a placeholder with no resolver, no `skip` and no request it can make, and names no placeholder has; `embed!(path, { "articles" => resolver, "user" => skip })` makes the same check when the server compiles and compiles the manifest in. It cuts each page at its placeholders at startup, streams the head up to the first placeholder at once (stylesheets and scripts load while the data is fetched), and fills each from the app's own API router called in-process, an upstream server, an allowed origin (without the page's cookies) or the app's function; `<` is written `\u003c`. Measured 2026-11-10 (RealWorld, slow 4G, cold): home LCP 948 → 588 ms with an API that answers at once, 1,128 → 572 ms when it takes 300 ms; one core serves 1,900–2,200 home pages/s, Qwik City 57–67 (docs/first-paint-comparison.md).
- `packages/sinter-aspnetcore` (added 2026-11-12): the same server for ASP.NET Core, option for option (`Sinter.AspNetCore`). `AddSinter(o => …)` and `app.UseSinter()`; same-origin requests go to the app's own endpoints in-process (minimal APIs, MVC controllers), through a pipeline of their own with routing, CORS, authentication and authorization, each with its own `HttpContext` and service scope. `[SinterEmbed]` (a source generator, the build named by `<SinterBuild>` in the project file) compiles the manifest into the assembly as code, makes the same checks as `embed!` as compile errors (`SINTER001`–`SINTER007`), and binds `[SinterResolve]` methods' parameters (services, the request, the token) and serializes their values through `JsonTypeInfo`, without reflection. NativeAOT-compatible; CI publishes a NativeAOT app from the packed package with trim and AOT warnings as errors.
- `@tiaforge-ui/sinter/server` (added 2026-11-13, `src/server.ts`): the same server in JavaScript, on web-standard `Request` and `Response`, option for option with sinter-axum (`origins` for `allow_origin`, `data` for `resolve` and `skip`). `await embed(options)` reads the build (from `dir` with `node:fs`, or from `manifest` and `read`), refuses at startup what `build()` refuses, and gives `fetch(request, next)` and `wrap(handler)`: the wrapped handler (Hono's `app.fetch`, any fetch handler) is the in-process API, called with the page request's forwarded headers and its extra arguments (a Worker's `env`). URLs come from the runtime's own `expand`, `withParams` and `readUrl`. With `embed: true` the build also writes `sinter-embed.d.ts` (per page, each placeholder's resource and whether its request is described); `embed<Build>()` makes a missing entry or an unknown name a type error. The layer answers 404 for both files.
- `<body data-sn-failed>` (added 2026-11-10): the body of a page a server ended because its data could not be fetched (sinter-axum, which writes its error text into that body). The page module does not mount there (`parsed()` does not resolve), so it neither renders nor requests. A marker for servers, not an attribute: pages do not write it (it is `SN101` in markup like any unknown `data-sn-*`), and it is left out of llms.txt and the editors' custom data on purpose.
- Data fetched for the page without the user's credentials is the anonymous view: a signed-in user whose token the server cannot see (RealWorld keeps it in `localStorage`) gets that view, and embedded data is not reloaded. Such pages leave those resources to the browser (a resolver that returns nothing for them) until the runtime can revalidate embedded data.
- Page-load cache (`cache` on `<sn-resource>`, added 2026-11-05): stale-while-revalidate across page loads in one tab.

The page-load cache:
- On page start, a resource with `cache` whose `src` resolves stores its cached entry at once (before the first paint). `$meta.<name>.loadedAt` stays `null` until the server answers, so it keeps meaning "loaded during this page load" and guards such as `$meta.user.loadedAt && !user` never act on cached data (found with RealWorld's login redirect, 2026-11-05). Then the resource loads as usual: `loading` is true and the cached data stays visible, as during any refetch. A failed revalidation keeps it and sets `error`.
- Embedded JSON wins: no cache lookup is made, and the embedded data is cached.
- Entries live in `sessionStorage` (one tab's lifetime) under `sn:c:`, keyed by the request URL and the `items` and `total` paths, so two pages that load the same data share an entry whatever they call the resource. An entry holds `{t, items, total}`, not the response body.
- Writes: after every successful load, and on `pagehide` for resources whose confirmed data changed since (server events, action results). Optimistic layers are never written. Only the first load reads the cache; a `src` that changes on the page does not.
- Pagination: each page's request URL has its own entry; `paginate="append"` caches only its first page.
- Limits: an entry over 256 KB serialized is not written (dev warning); a full storage drops the older half of the entries and retries once.
- Logout: every entry is removed on any 401 (as the response arrives, before `onUnauthorized` middleware runs) and by `clearPersisted()`, which apps call on logout.
- A malformed value is `SN401`. The cache module (`@tiaforge-ui/sinter/cache`) is added only to pages that use `cache`.

Next-page data (added 2026-11-09, `@tiaforge-ui/sinter/prefetch`, nothing to declare):
- What can be requested ahead: the compiler describes each page by its `data-sn-path` patterns (else the paths it is served at: `/login/` and `/login` for `login.html`, `/docs/` and `/docs/index.html`, under Vite's `base`; see Page URLs) and the resources whose `src` and `when` read only `$url`, constants and the app's helpers: no state, resources, `$meta`, `$now`, built-in formatters or messages; not paginated, `each`, `call` or embedded data. The Vite plugin puts every HTML entry's description in one module (`/@sinter/prefetch.js`, a shared chunk), which every page imports when any page has something to describe. `sinter({ prefetch: false })` leaves it out.
- When: a same-origin link (`a[href]`, not `download`, `target` empty or `_self`, not this page's path and query) to one of those pages is about to be followed: the pointer rests on it for 65 ms (`HOVER`) or it has focus that long; a mouse or pen press starts at once. A touch waits the same 65 ms, and a `pointercancel` (the browser took the gesture for a scroll) ends the wait, so scrolling a list of links by touch requests nothing. Nothing with `navigator.connection.saveData` or a 2g connection.
- What: each described resource's URL is computed with the link's `$url` (query, then the first matching pattern's segments). A request this page has loaded itself (same URL, `items` and `total`, loaded during this page load) is handed over from its confirmed data without a request; any other is a GET through the request layer, low priority, marked with an `x-sinter-prefetch` header for the middleware chain. The mark is removed before `fetch`, so it adds no CORS preflight; a marked request answered with an error rejects there, and `onUnauthorized` passes a marked 401 by, so a prefetch never starts a login redirect. A URL requested within the last 10 s (or in flight) is not requested again.
- Stored: `{t, items, total}` (items cleaned as a load cleans them) in `sessionStorage` under `sn:p:`, keyed by the request URL and the `items`/`total` paths, as the page-load cache. Not written: over 256 KB, a collection whose `items` is not an array, a response to a request that overlapped a mutation. After every mutation (any method but GET and HEAD, once it settles) all entries are removed, as on any 401 and by `clearPersisted()`; a page removes entries older than 30 s (`MAX_AGE`) when it mounts.
- Taken: on its first load, a resource (not `call`, `each` or paginated) whose request has an entry not older than 30 s takes it, once (the entry is removed), before the page-load cache, and shows it at once; then it loads as usual. `$meta.<name>.loadedAt` stays `null` until the server answers, as with `cache`. So the next page paints with data without a round trip, and still shows what the server says a moment later.
- Speculation Rules (added 2026-11-09, Chromium): the Vite plugin writes rules for same-origin links to the app's paths (every page's patterns or file paths as URL patterns, any query and fragment; not `[download]`, another `target`, `rel~=nofollow`), eagerness `moderate`. `sinter({ speculation })`: `'prefetch'` (default) fetches the next page's HTML; `'prerender'` loads and runs it in the background; `false` writes none. Delivery (decided 2026-11-09: inline by default, it needs no server setup): `<script type="speculationrules">` in every page's head. A CSP the page declares (`<meta http-equiv="Content-Security-Policy">`) gets the rules' hash (`withRulesHash()` in `prefetch-build.ts`): in `script-src-elem` and `script-src`, else in a `script-src` copied from `default-src`; a directive that already allows them (`'unsafe-inline'` without a hash or nonce, `'inline-speculation-rules'`) is left alone. A CSP sent as a response header is out of the build's reach: it needs `'inline-speculation-rules'` (or the printed hash) in `script-src`; dev builds warn (code 22) through a buffered `ReportingObserver`, since the violation happens while the page is parsed, before sinter runs. `speculation: { mode, delivery: 'header' }` writes `speculation-rules.json` at the site root (fixed name) for a `Speculation-Rules: "/speculation-rules.json"` response header instead, which no CSP blocks; the server must send the header with every page and the file as `application/speculationrules+json` (`application/json` is rejected). `vite dev` and `vite preview` do both. Browsers have no third way: `<script type="speculationrules" src>` is not supported, `<link>`/`<meta http-equiv>` forms do not exist, and a `<link rel="prefetch">` hint is reused for the navigation only when the HTML is cacheable (Chromium, tested: not with `no-cache`, `max-age=0` or no header). Measured 2026-11-09 in Chromium under `script-src 'self'`: inline blocked (a violation), header with that type works, header with `application/json` rejected; `e2e/navigation` runs this setup. Guide: [navigation.md](navigation.md). Next-page data still runs: it works in every browser and fetches the data, which a prefetched document does not.
- A prerendered page (`document.prerendering`): loads its resources as usual; streams (`<sn-sync>`) connect only once it is shown (`app.shown()`), so a page nobody may ever see holds no connection; when it is shown (`prerenderingchange`) every resource is refetched (it may have loaded minutes earlier and missed server events), then the waiting work runs. Measured 2026-11-09 in Chromium: prefetch is used by the navigation (`deliveryType: navigational-prefetch`); prerender is requested (`Sec-Purpose: prefetch;prerender`) but Chromium does not prerender while DevTools drives it (`PrerenderingDisabledByDevTools`), so activation is covered by the behaviour test only.
- Opting a page out: `<html data-sn-prefetch="off">` (anywhere else `SN102`, another value `SN401`). The page is left out of the next-page module and of every page's Speculation Rules, so no page prefetches its data or its HTML, or prerenders it: for a page that does something when it loads (a logout page that clears the session). It is a build-time decision: the attribute is stripped like every directive. There is no per-link opt-out: the browser can only leave a link out of its rules by a marker in the page (decided 2026-11-09: no marker).
- Cost: the feature is 1.4 KB gzip on every page (2026-11-09), plus the pages' descriptions (RealWorld: 7 pages, one shared chunk). The RealWorld article page went from 19,971 to 21,306 B gzip; its budget was raised to 22 KB.

## Sync: change messages and transports
The store only understands one message shape; transports translate server events into it. Server-Sent Events are the default; a WebSocket transport ships as `@tiaforge-ui/sinter/ws`, and others (SignalR) are a few lines in the app (see Transport interface).
```ts
type Change<T> =
  | { resource: string; op: 'upsert';  item: T }
  | { resource: string; op: 'patch';   key: string; fields: Partial<T> }
  | { resource: string; op: 'remove';  key: string }
  | { resource: string; op: 'refetch' };
```

### Declaring a stream
```html
<sn-sync src="/api/events/stream">
  <sn-event name="contact_updated"  resource="contacts" op="upsert" item="contact" fallback="refetch"></sn-event>
  <sn-event name="contact_removed"  resource="contacts" op="remove"></sn-event>
  <sn-event name="contacts_refetch" resource="contacts" op="refetch"></sn-event>
</sn-sync>
```
Inside `<sn-event>` attributes, the event's parsed JSON payload is the scope: `item="contact"` reads `payload.contact`. State declared around the `<sn-sync>` is in scope too, and a state name wins over a payload field of the same name: `when="mailbox === sel.mailbox"` compares the payload's `mailbox` with the state `sel` (added 2026-11-05, for Caley's mail list). `data-sn-let` names declared around the `<sn-sync>` resolve the same way, before payload fields, and read the state they are computed from when the event arrives (`data-sn-let="{ open: … }"` on the page's `<main>`: `then="open && open.uid === uid && …"`; added 2026-11-08); a let that reads `$el` is `SN201` here, since there is no element. With a typed payload (`type="…"`), a state or let name that is also a payload field is a `sinter check` error; without a type, pick names that payloads do not use. Loop variables and resources are not in scope here (a let may read resources). `src` of `<sn-sync>` is evaluated in the same scope.

| Attribute | Meaning |
| --- | --- |
| `name` | event name (the SSE event name, or what the transport reports) |
| `resource` | target resource |
| `op` | `upsert`, `patch`, `remove` or `refetch` |
| `item` | value expression for `upsert`; default: the whole payload |
| `set` | object literal for `patch`, e.g. `{flags, is_read: flags.includes('\\Seen')}` |
| `when` | value expression; skip the event unless truthy, e.g. `mailbox === $url.mailbox` |
| `fallback` | `refetch` when `item` evaluates to null (for servers that send some updates without a body) |
| `then` | handler expression, run after the change is applied (see Handlers on server events) |
| `type` | the payload's type, for `sinter check` (see Type checking) |

For `patch` and `remove`, the key is read from the payload using the resource's `key` fields. On an `each` resource, `refetch` reloads only the source the payload resolves to (see Fan-out resources). Events with no `<sn-event>` are still dispatched to islands (see JS API).

### Handlers on server events
`then` on `<sn-event>` is a handler expression, like `data-sn-then` on an action, run after the event's change is applied to the store (for `refetch`: once the reload is requested; it does not wait for it). It sees the same scope as the event's other attributes: payload fields as bare names, and the state and `data-sn-let` names around the `<sn-sync>`; it may assign the state. It runs for every event that passes `when`; not when the payload cannot be applied (a `patch` or `remove` without the key fields, an `upsert` without an item and no `fallback`). With `then`, `resource` and `op` may be left out: the event only runs its handler. (Added 2026-11-08, for Caley's detail dialogs.)
```html
<body data-sn-state="{ sel: null, notice: '' }">
  <sn-sync src="/api/events/stream">
    <sn-event name="contact_removed" resource="contacts" op="remove" type="ContactRemoved"
              then="sel?.uid === uid && close('contact-detail')"></sn-event>
    <sn-event name="notice" type="Notice" then="notice = text"></sn-event>
  </sn-sync>
```
- The dialog clears the selection itself (`<dialog id="contact-detail" data-sn-on-close="sel = null">`), so the handler runs one step under its condition (two would be `SN507`).
- Store functions are in scope (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close('id')`, `run('id')`), and their names win over payload fields. There is no element, so `close()` names its dialog and `reset()` and `emit()` are errors (`SN203`); `$event` and `$result` are not defined here, and assigning to a payload field is an error.
- State writes re-render what reads them, as from any handler. Bindings inside a dialog the handler closes keep their last values until it opens again.
- Islands still receive the event through `app.on(name)`, after every mapping has run.

### Connection rules
- One connection per stream URL per page, however many elements use it: `<sn-sync>` elements whose `src` resolves to the same URL (at connect time, after the page mounts) share one transport, and all their `<sn-event>` mappings apply, each evaluated in its own `<sn-sync>`'s scope. An event mapped by several of them applies once per mapping; islands receive it once.
- The session probe gates every reconnect. `EventSource` cannot see HTTP status, so after an error the adapter does not reconnect directly. It calls the configured `sessionProbe` through the request layer:
  - 2xx: reconnect the stream.
  - 401: the normal login redirect.
  - network error (status 0): wait out the backoff, then probe again.
- Backoff: 1 s, doubling to 30 s, with jitter; reset after a successful reconnect.
- Offline is not logged out. Only a 401 leads to login; an outage never does.
- Missed events. After a reconnect, every resource fed by that stream is refetched once, since events sent while disconnected are lost.
- Back/forward cache. The connection closes on `pagehide` and reopens on `pageshow`, so an open stream does not keep the page out of the cache. Reopening goes through the session probe like any reconnect, so a page restored after logout is redirected to login.
- Coalescing. Several `refetch` messages for one resource within one task cause one request.
- HTTP version. Each open EventSource holds one HTTP connection. Over HTTP/1.1 browsers allow 6 per origin, so with more than 5 tabs of an app open, the next page stops loading. Serve streams over HTTP/2 or HTTP/3 (one connection carries about 100 streams; any TLS reverse proxy such as nginx or Caddy provides it), or use the WebSocket transport, which is not counted against that limit. Dev builds warn once when a stream's origin was reached over HTTP/1.1, judged from Resource Timing: the page's navigation for a same-origin stream, else the last request to that origin. Streams are not shared across tabs (decided 2026-11-05: it would change what servers see per connection, such as echo suppression and presence).
Later, with a backend change: a `session_expired` event sent before the server closes the stream could trigger the redirect without a probe.

### Paginated resources
On a paginated resource, `upsert` of a key that is not on the current page becomes a `refetch` of the current page. `patch` and `remove` apply only to items present. This keeps page boundaries correct without client-side guessing.

### Transport interface
A transport is an object with `connect(url, onEvent, onState, names)`, an optional `listen(name)` and `close()`:
- `onEvent(name, payload)` delivers one event with its **parsed** payload (the SSE transport parses JSON and passes anything else as the raw string).
- `onState('open')` once connected; `onState('error')` when the connection is lost, cleanly or not. A transport never reconnects by itself: the connection rules above (session probe, backoff, refetch) apply to every transport. Nothing is reported after `close()`.
- `names` are the event names the page maps; `listen(name)` adds one an island subscribes to later. A transport delivers at least those.

The transport is chosen per stream URL in the config module; the URL in the HTML stays an http(s) URL under the usual URL template rules, so a value can never choose the host:
```js
import { configure } from '@tiaforge-ui/sinter';
import { webSocketTransport } from '@tiaforge-ui/sinter/ws';

configure({ transport: (url) => url.startsWith('/ws/') ? webSocketTransport() : undefined });   // undefined: EventSource
```
- **WebSocket** (`webSocketTransport({ protocols, decode })`): opens the URL as `ws:`/`wss:`. Each text message is JSON `{"event": "<name>", "data": <payload>}`; `decode(message)` returning `[name, payload]` or `null` reads other formats. Server to client only: actions stay on HTTP, so `then`/`catch`, optimistic layers and 401 handling are unchanged.
- **SignalR**: the `llms.txt` recipe; the adapter lives in the app, so sinter does not depend on `@microsoft/signalr`. Hub method names are the event names; the first argument is the payload. Do not enable SignalR's automatic reconnect.
- Auth on a WebSocket or hub is the transport's: browsers send cookies, but request middleware does not apply.

A SharedWorker or BroadcastChannel transport that shares one stream across tabs could implement the same interface; it is not planned (see HTTP version under Connection rules).

## Actions, events and request layer
An action is an element with one method attribute; it sends a request when its trigger fires and runs `then` or `catch` afterwards. Plain `data-sn-on-<event>` handlers cover everything that needs no request.

### Default triggers

| Element | Trigger |
| --- | --- |
| `<form>` | `submit` (default prevented) |
| `<button>`, `<a>` | `click` |
| `<input>`, `<select>`, `<textarea>` | `change` |
| anything else | `click` |

`data-sn-trigger="input"` overrides it; `data-sn-debounce="300"` delays it. A `<button>` inside a form that has its own method attribute is its own action, not a form submit. An `<a>` with a method attribute does not navigate: its default is prevented, like a form's submit.

### Request body
- `data-sn-body` set: its value is sent as JSON.
- Otherwise, a form is serialized to nested JSON from its named controls:
  - `name="org"` → `{org}`, `name="emails[0].value"` → `{emails: [{value}]}`.
  - `type="number"` and `range` → number; a single checkbox → boolean; several checkboxes with one name → array of checked values.
  - Disabled controls are skipped, as in native forms.
- A form containing `<input type="file">` is sent as `multipart/form-data` instead.
- `GET` and `DELETE` without `data-sn-body` send no body.
- With `data-sn-encoding="form"` the body goes as `application/x-www-form-urlencoded`: a form's fields as a browser submits them (repeated names stay repeated), or the keys of `data-sn-body`, an array as a repeated key; `null` and `undefined` values are left out, objects are sent as JSON text. Action functions get the same with a `URLSearchParams` body in `ctx.request`.
- Serializing a form and form encoding are the `form` feature module (0.8 KB gzip), imported only by pages with a form action without `data-sn-body` (not `GET` or `DELETE`) or with `data-sn-encoding="form"`.

### Confirmation
`data-sn-confirm="m.delete_confirm({name: c.fn_name})"` asks before the action runs: no optimistic change, no request when the answer is no. The value is evaluated when the action triggers; when it is falsy nothing is asked, so a question can depend on state: `data-sn-confirm="inTrash ? m.delete_forever() : null"`. `configure({ confirm })` replaces `window.confirm`, for example with a dialog of the app's own (it may return a promise).

### After the response
`then` and `catch` are handler expressions. The built-in functions:

| Function | Effect |
| --- | --- |
| `refresh('contacts')`, `refresh('messages', 'unread')` | refetch each named resource (names as in Resource names below; one call, one statement for `SN507`) |
| `upsert('contacts', $result)` | insert or replace an item |
| `patch(item, {…})` | change fields of an item, in the resource it came from |
| `remove(item)` | remove an item from the resource it came from; a single resource becomes `null` |
| `page('messages', 'next')` | change page: a direction, or a page number where the resource can jump; may be computed (see Pagination) |
| `showModal('edit')` | open `<dialog id="edit">` as a modal; nothing if it is open |
| `close()`, `close('edit')` | close the nearest `<dialog>`, or the one with that id |
| `reset()` | reset the nearest `<form>` |
| `emit('name', detail)` | dispatch a bubbling, cancelable `CustomEvent` from the element; every container with a handler for it runs, inner first, until one calls `$event.preventDefault()` |
| `run('id')` | start the action of the element with that id, as its trigger would (a form: submit it); see Running an action from a handler |

State assignments work too: `data-sn-then="editing = null; close()"`.
The dialog id of `showModal()` and `close()` is a string literal that must name a `<dialog id>` on the page or the components it uses (`SN309`), so a typo fails the build. A button that only opens a dialog needs no handler: `commandfor="edit" command="show-modal"` is the platform's. `showModal()` is for opening after a request or call (`data-sn-then`), from a custom event, or after setting state in the same handler. Bindings inside the dialog render when it opens.

### Write-through
A mutation's 2xx response is applied to the resources it is about, by the `apply` feature module (loaded by pages that have something to apply), after the optimistic layer commits and before `then` runs, so `then` has the last word. Nothing is declared: the compiler knows what the action is about and what the response holds.

**What the action is about** (provenance): the resources, rows and nested entities its URL and body read. `{a.slug}` with `a in articles` names a row of `articles` (also of each list in `a in (following ? feed : articles)`); `{article.slug}` names the single-object resource `article`; `{article.author.username}` also names `article.author`, a `Profile` by the schema walk. **What the response holds**: with an OpenAPI spec, the objects of named component schemas in it, at the top level or one property down (`{article: Article}`, `{articles: Article[]}`); each resource is matched to a schema the same way (a `$ref`, an inline copy, or an inline projection with fewer fields, as list responses often are). The request body's wrapper property (`{comment: {…}}`) comes from the request schema.

| Rule | When | Effect |
| --- | --- | --- |
| 1 Confirm | the response holds an object of schema `S` | every keyed list resource of schema `S` patches the item with that key, if it holds one; what the URL named (a row, a single resource, a nested entity at its path) is patched when its schema is `S` |
| 2 Create | a `POST` whose resolved URL equals a keyed list's current URL, query included | the response's object of the list's schema is upserted; without one, the body (unwrapped) merged with the response object that carries the key fields (`{id: 42}`, also wrapped) is; without either, the list is refetched. A filtered or paginated list is never inserted into: its URL carries parameters the POST does not |
| 3 Update | a `PUT` or `PATCH` | the body (unwrapped) patches the entity the URL named whose schema has every field the body may carry; without a spec, the row or single the URL named, when every body key is a field it already has |
| 4 Delete | a `DELETE` whose resolved URL is a keyed list's current URL plus one path segment, built from a row of that list | the row is removed (no spec needed) |

- Patches merge. A field the response omits stays; a row created by rule 2 lacks fields only the server sets until the next load or event. Fields that already hold the value are not written: a base write to an item drops an older pending layer's changes to that item (as a server event does), so a confirmation that changes nothing must write nothing.
- Never by type alone: a response `Article` does not replace the single `article` unless the URL read it; a response `Profile` does not touch `article.author` unless the URL read it. A `DELETE` on a sub-resource (`/articles/{slug}/favorite`) removes nothing; a `DELETE` of a single-object resource's URL leaves it (the page usually navigates).
- Rules 1 to 3 need the spec (`sinter({ openapi })`); untyped pages get rule 4 and the body-only form of rule 3.
- `data-sn-apply="off"` turns it off for one element. `GET` actions and `data-sn-call` have no write-through.
- `SN510 redundant-write` (warning): a `then` that `patch`es or `upsert`s a resource with `$result.<path>` a rule applies, or `remove`s the row a rule 4 removes. Dev builds log each application: `write-through after POST /api/articles/x/favorite: articles: patch, feed: patch`.
- RealWorld (2026-11-08): 12 of 19 `then` handlers went, among them every favorite and follow button and the comment form's `upsert`.

### Resource names
`patch(item, …)` and `remove(item)` take no resource name (added 2026-11-10; the forms with one are `SN317`). The compiler resolves where the item came from, as write-through resolves what an action is about: a loop row (for `a in (x ? feed : articles)`, either list; through `filter`, `slice`, `toSorted`, `toReversed`, or a helper that takes exactly one resource or list with a source; a helper that takes two is `SN317`), an element of a list (`list[i]`, `.find()`, `.findLast()`, `.at()`), a single resource, a `data-sn-let` name or a component prop that is one of those, a component event's `$event.detail` when the component emits one of those, `structuredClone()` of one, and a state path a handler on the page assigns one of those (`sel = m`; every assignment counts). It passes those resource names to the runtime ahead of the item; the runtime changes the item in the first that holds its key (a single resource is the item itself). An item with none of these sources is `SN317`, naming what to use instead: write-through for `$result`, `<sn-event resource op>` for a payload, the instance API for an island's event. State that holds a row stays a snapshot: sinter does not rewrite values in state; `patch(sel, …)` finds the item by its key.

`refresh()`, `upsert()` and `page()` take the resource name as an expression whose possible values the compiler can list from the source: a string literal; `c ? x : y` where `x` and `y` are such expressions (the test is any value expression); `x || y` and `x ?? y` where both are; parentheses; and a `data-sn-let` name whose value is such an expression (lets are inlined, so the compiler has their expression). "Page the list shown", where the list is one of two resources:
```html
<div data-sn-let="{ shown: searching ? 'results' : 'messages', list: searching ? results : messages }"
     data-sn-on-list-next="page(shown, 'next')"
     data-sn-on-mail-saved="refresh(shown, 'unread')">
```
- **Compile time.** Every name the expression can take gets the checks a literal gets: `SN301` (did-you-mean on that literal, and the LSP quick fix; for a let's name it is reported where the let is read), `SN303` and `SN304` for each name `page()` can take (a literal page number on a `?:` that may name a keyset resource without `offset-param` is `SN304`), each name counts as used for `SN501`, and `refresh()` adds an `SN509` edge per name. An expression whose names cannot be listed (a state variable, a helper's result, `$event.detail`, `a && 'x'`) is `SN301`: "takes a resource name: a string literal, `?:`, `||` or `??` between them, or a `data-sn-let` name that is one". A name kept in state (`tab: 'inbox'`) becomes a `?:` or a let.
- **`sinter check`.** The shadow types the name as `K extends keyof R & string`, so `searching ? 'results' : 'messages'` infers `'results' | 'messages'`; a let read as a name is typed as its names (TypeScript would widen a single `'messages'` to `string`). `page()`'s target must suit every name: a page number only where none of them is a keyset resource without `offset-param` (`[Extract<K, D>] extends [never] ? Direction | number : Direction | NoPageNumber`). `upsert`, `patch` and `remove` accept an item of any of the names' types (`Item<R[K]>` over the union).
- **Runtime.** The store functions look the name up when they run. The compiler guarantees every value is a declared resource; with a hand-written IR, an unknown name makes the store function throw, the rest of the handler is skipped, and the error is logged.
- **`$meta`.** A computed key whose names can be listed (`$meta[shown].hasNext`) gets `SN301` and `SN303` per name and depends only on `$meta.<name>.<field>` for each; any other computed key is accepted unchecked and depends on all of `$meta`.

### Unhandled errors
When an action fails and has no `data-sn-catch`:
- An `sn-error` `CustomEvent` bubbles from the element (from its nearest ancestor still in the page when the element left it meanwhile, e.g. with a row an optimistic `remove` took away), `detail = {error, element}`, to every container with `data-sn-on-sn-error` (inner first). A handler that calls `$event.preventDefault()` handles it: the walk ends there, and `onError` does not run.
- If no listener prevented it, `configure({ onError(error, element) })` runs, e.g. to show a toast.
- Dev builds log every unhandled error to the console.
Resource load failures set `$meta.<name>.error` and then take the same path, with `detail.resource` set and the mount root as element. A 401 never reaches this path; the login redirect handles it.

### Server validation errors on the form
A mutation (`data-sn-post`, `-put`, `-patch`, `-delete`) without `data-sn-catch` on a form, or on a control inside one (a `type="button"` Publish button; `form="id"` counts), shows the server's errors without any code (added 2026-11-09). The messages are the server's: sinter puts them on the fields, and the form's markup shows the rest through `$error`.
```html
<form data-sn-post="/api/signup">
  <p data-sn-show="$error && !$error.body?.errors" data-sn-text="$error?.detail"></p>  <!-- a 5xx -->
  <label>Email <input type="email" name="email"></label>  <!-- `errors.email` goes next to it -->
  <button>Sign up</button>
</form>
```
- **Fields** (the `fields` feature module, 1.1 KB gzip, loaded by pages with such an action or a form that reads `$error`): by default a 4xx whose JSON body's `errors` is an object of `<name>: message` or `<name>: [message, …]` (Rails, Laravel, RealWorld, ASP.NET's `ValidationProblemDetails`). Each name that is a control of the form (as `form.elements` finds it: its `name`, else its `id`) marks it: every control of the name (radio buttons) gets `aria-invalid="true"`, which temper (and Pico) already style, and its messages (joined with `; `) go into the element the control's `aria-errormessage` names, shown if it was `hidden`, or else into a `<small data-sn-error="<name>" data-tone="danger">` inserted after the control, which `aria-errormessage` and `aria-describedby` then name (an existing `aria-describedby` keeps its ids). The first such control in document order gets focus, once the form's controls are enabled again. Editing a control (`input` or `change`) clears its error; sending the form again clears them all and restores what sinter changed.
- **`$error` in the form**: inside a `<form>`, `$error` is the form's last failed send, `{status, body, message, detail}` as in `data-sn-catch`, or `null`; it is `null` again when the form is sent again. Any binding reads it, so a summary is plain markup: `<template data-sn-if="$error"><ul><template data-sn-for="m in errorLines($error)">…` with a helper for the lines. The compiler gives a form whose markup reads `$error` a state field of that name (merged into its `data-sn-state`), so it is reactive, typed by `sinter check` (`Err | null`), and assignable in handlers (`$error = null`). Outside a form and outside `data-sn-catch`, `$error` is `SN201`; inside `data-sn-catch` it is the action's own.
- **Handled**: when every message marked a field, or the form's markup reads `$error`, the failure is shown: no `sn-error`, no `onError`. Otherwise (a name no control has, a 5xx, a network error, in a form that does not read `$error`) it takes the unhandled path as usual, so a toast reports it.
- **Opting out**: `data-sn-catch` on the action. The app then handles the error itself: no field is marked and nothing counts as shown (`$error` is still set). `GET` actions and `data-sn-call` mark no fields.
- **Other formats**: `configure({ fieldErrors(error, request) })` (`request`: `{url, method}` of what was sent, to tell APIs apart, as request middleware does) returns `{ <name>: message | [message, …] }`; `null` marks no field; `undefined` leaves the error to the default reading. It is called for every failure of such an action and reads the server's messages out of `error.body`:
  ```js
  configure({
    fieldErrors: (error, { url }) => {
      const p = error.body?.['invalid-params'];          // RFC 9457
      if (Array.isArray(p)) return Object.fromEntries(p.map((x) => [x.name, x.reason]));
      // undefined: the default (`errors`) for the rest
    },
  });
  ```
  The default reading lives in the fields module, not in the core: an earlier version exported it from the main package for hooks to call, and it then sat in the chunk every page shares (found by comparing RealWorld's home page with `main`, 2026-11-09).
  JSON:API (`errors[].source.pointer` → the name, `detail` → the message), Django REST Framework (top-level names) and ASP.NET's PascalCase names (`Email` → `email`) are a few lines each the same way. `() => null` marks no field: the form's markup shows everything through `$error`.
- **Translation**: when the server sends codes instead of text (`{email: ['taken']}`), the hook maps them to the app's messages (Messages): `m.key` is allowed in `src/sinter.config.js` as in any module of the page bundle, and a map of functions keeps them literal: `const text = { taken: () => m.error_taken() }`, then `msgs.map((c) => text[c]?.() ?? c)`. A message the server words in the user's language (`Accept-Language`) needs nothing.
- RealWorld (2026-11-09): no form has a `data-sn-catch` any more (login, register, settings, the editor, comments). Its markup shows every error in one `<ul class="error-messages">` and marks no field: the config says `fieldErrors: () => null`, and each form holds the list it already had as a partial, reading `$error` instead of a state variable a catch filled (`<template data-sn-if="$error"><ul class="error-messages"><template data-sn-for="m in errors($error)">…`, the `<field> <message>` lines of its `errors()` helper). Its own error tests (`error-handling`, `user-fetch-errors`, mocked API) pass as before (44 of 45; the 45th, deleting another user's comment, fails on `main` too). The pages with a form load the fields module; the article page's budget went from 26 to 27 KB for it. Against `main`, a page with a form loads 1.1–1.2 KB more (the module), the home and profile pages 58 B more (the core's two calls into the module, the happy-dom fix, the config line).
- Considered and dropped: a `data-sn-errors` element that sinter filled with what no field took (it is what `$error` replaced: data in, markup out, nothing to learn); splitting the fields module so that pages showing only a list load less (about 0.45 KB): which half runs is decided by the hook, which is code, so it would need a markup declaration, for too little gain.

### Pending state and concurrency
- While a request is pending, the element gets `aria-busy="true"`. Pico CSS already styles `aria-busy`. Forms in `block` mode are also disabled.
- `GET` actions: a new trigger aborts the previous request (latest wins).
- Mutating actions follow a concurrency policy, applied per element instance, so rows in a list never block each other.

| Policy | Behaviour | Default for |
| --- | --- | --- |
| `block` | re-triggers are ignored while a request is pending | `<form>` |
| `queue` | every trigger is sent, in order; its optimistic layer applies at trigger time, so the body sees the already-updated value | every other element |
| `latest` | the running request finishes; only the newest waiting trigger is sent after it, older waiting ones are dropped | none (autosave) |

`data-sn-concurrency` overrides the default. `latest` is only safe when the body describes the target state (`set: true`, a full draft), not an operation such as "create".
A running mutation is never aborted: aborting `fetch` does not stop the server, so the write could still happen, out of order.

### Request layer
All requests (resources, actions, the stream session probe) go through one middleware chain, configured once per app:
```js
// src/sinter.config.js
import { configure, credentials, header, onUnauthorized, loginRedirect } from '@tiaforge-ui/sinter';

configure({
  request: [
    credentials('same-origin'),
    header('X-Sinter', '1'),                       // CSRF: backend rejects mutations without it
    onUnauthorized(loginRedirect({ to: '/', returnUrl: { allow: ['/app/'] } })),
  ],
  sessionProbe: '/api/user',
  onError: (error) => showToast(error.message),   // unhandled action and load errors
  locale: { get: getLocale, set: setLocale },      // from the app's i18n library
  transport: (url) => undefined,                   // per <sn-sync> URL; undefined: EventSource
});
```
- A middleware is `(request, next) => Promise<Response>`, so retries, timeouts or logging are plain functions.
- `loginRedirect` stores the return URL (same-origin, allowlisted prefixes only), navigates to login, and never resolves, so `then` and `catch` do not run.
- Non-2xx responses reject with `$error = {status, body, message, detail}`. Network errors give `status: 0`; a failed action call gives `status: null`. `detail` is the error in words when there are any: a short text body, a JSON body's `message` or `error`, or a thrown error's message; otherwise `null` and `message` falls back to the HTTP status, so `error = $error.detail ?? m.save_failed()` shows the server's reason or the app's own text.
- Defaults: 30 s timeout. Nothing is sent again unless a retry policy says so (see Retry policies; changed 2026-11-09: until then GET, HEAD, OPTIONS, PUT and DELETE were sent once more after a network error).
Response bodies. 204 or an empty body → `null`. A JSON content type → parsed; invalid JSON is an error with the response's status and the message `invalid JSON`. Any other content type → text. Error bodies are parsed the same way into `$error.body`.

### Retry policies (`data-sn-retry`)
A write made while the connection is down is sent again when its element names a retry policy; without one it is sent once and fails as any request does (added 2026-11-09, for drafts, notes and events in a groupware app; the guide is [`docs/retry.md`](retry.md)):
```js
// src/sinter.config.js
import { configure } from '@tiaforge-ui/sinter';
import { retry } from '@tiaforge-ui/sinter/retry';

configure({
  sessionProbe: '/api/user',
  retry: retry({
    policies: {
      drafts:  { backoff: ['1s', '30s'] },                 // until it succeeds or the page is closed
      network: { backoff: ['1s', '10s'], retries: 3 },
    },
    get: 'network',                                         // default policy for every GET; absent: GETs are sent once
  }),
});
```
```html
<form data-sn-put="/api/notes/{note.id}" data-sn-retry="drafts" data-sn-concurrency="latest"
      data-sn-optimistic="patch(note, {title, body})">
```

| Policy field | Default | Meaning |
| --- | --- | --- |
| `backoff` | `['1s', '30s']` | the first and the longest wait between tries; each failure doubles the wait, ±25 % (the stream's rule). `['5m', '5m']` is a fixed interval |
| `retries` | no limit | how many times the request is sent again after the first try |
| `maxAge` | no limit | no new try once this long has passed since the first |
| `key` | `'Idempotency-Key'` | the header carrying a write's idempotency key; `false` sends none |

Durations are written as in `refresh` and `cache` (`30s`, `5m`, `1h`, `1d`); `retry()` throws on a value it cannot read, and when `get` names no policy. Without `retries` and `maxAge`, a policy retries for as long as the page is open.

- **Where.** `data-sn-retry` takes a policy name, on actions with `data-sn-post`, `-put`, `-patch` or `-delete`. No value is `SN401`; on a GET action, on `data-sn-call` (a call may send several requests) or on an element without an action it is `SN102`. Writes have no default policy: whether a write may be sent twice depends on what its endpoint does, which only its element can say. GETs (resource loads, `each` sources, pages, GET actions) use `retry.get`, except background refreshes (`refresh`, which retries by itself), the session probe, next-page data and the early file's requests. A name `retry()` does not define fails the action with `$error.message` "unknown retry policy `x`"; with no `retry` configured at all, the write is sent once, as without the attribute (the check lives in the retry module, not in core). Dev builds warn at mount about both. The compiler does not read the config module, so the name is checked when the page runs.
- **What is sent again:**

| Response | Effect |
| --- | --- |
| network error or timeout (`status: 0`) | wait out the backoff, then the session probe decides, as for streams: 2xx sends again; 401 ends the write (the login redirect; the write is lost); anything else waits longer. Without `sessionProbe`, it sends again after the backoff |
| 5xx | a failed try: wait out the backoff, send again (no probe: the server answered) |
| 429, or 503 with `Retry-After` | wait for the longer of the backoff and `Retry-After` (seconds or an HTTP date); if that is after the policy's last allowed try (its `maxAge` deadline, or what its remaining tries take at the longest wait), fail at once with this response. A 429 without `Retry-After` is a failed try |
| 404 on a `DELETE` that is being sent again | success: an earlier try deleted it. `$result` is `null`, write-through rule 4 removes the row. A 404 on the first try is an error |
| other 4xx | fail at once (a 422 marks the form's fields at once) |

- **Giving up.** The action fails as one without a policy does, with the last response or network error as `$error`: the optimistic layer is rolled back, then `data-sn-catch`, or the form's field errors and `$error`, or `sn-error` and `onError`. A try that will be sent again is not a failure: nothing is reported and the form's `$error` and field marks stay as they were.
- **Idempotency keys.** Each trigger gets one key (`crypto.randomUUID()`, else 16 random bytes in hex), sent on its first try and on every try after, set before the middleware chain (which runs on every try, so a CSRF header or a refreshed token is current). A server that honours it remembers each key with its response for as long as the longest policy retries, answers a repeated key with that response, `409` while the first request with the key still runs and `422` when the key comes with another body. A server that ignores the header: `PUT` of the full target state, `DELETE` and a `PATCH` that sets fields are safe to send again; a `PATCH` that increments or appends is not; **a `POST` that creates is not: a lost response and a resend make a duplicate.** Create with a client-generated id instead (`PUT /api/notes/{uuid}`), which is idempotent on any server. The browser cannot tell "never reached the server" from "applied, but the response was lost".
- **While a write waits.** It counts as running for its element: `aria-busy` stays, and the element's concurrency policy applies. `latest` drops the waiting write when a newer trigger comes (no further try; a running try is never aborted), so after reconnecting only the newest draft goes: the policy for autosave. `queue` keeps later triggers behind it, in order. `block` (forms by default) keeps the form disabled until it settles, so a draft form says `data-sn-concurrency="latest"`. Writes of different elements are not ordered with each other; a page that must not run two writes to one item disables the second while the first is pending (`$meta.<name>.pending` for actions with an optimistic layer). `then` runs when the write finally succeeds, possibly minutes later, against the page's state then. `online` ends the current wait.
- **Leaving the page.** While a write waits for a retry, the page has a `beforeunload` listener, so the browser asks before a link, a reload or closing the tab (in its own words; a custom message is ignored); it is removed once nothing waits, so it does not keep the page out of the back/forward cache otherwise. Nothing is sent on `pagehide`. iOS Safari never asks, and a tab closed from the app switcher fires nothing usable: there, closing the page loses waiting writes without warning. The page-wide signal is markup: `body:has(form[aria-busy]) .unsaved { display: block }`.
- **Reads.** A GET waiting for a retry is aborted like a running one (a `src` change, `when` turning falsy, a newer GET trigger). `$meta.<name>.loading` stays true while an ordinary load waits; `error` is set only when the policy gives up. Concurrent loads of one URL share one request and so one retry. Unchanged reloads (`versions`) look at the response that finally arrives.
- **Dev builds** log each failed try and its outcome (`console.info`): `sinter: retry (drafts): PUT /api/notes/7 try 1 failed (Failed to fetch); next in 1 s`, `… succeeded on try 2`, `… try 4 failed (502): gave up`.
- Not covered: writes that survive a navigation or a closed tab (a stored outbox), retrying `data-sn-call`, policies written as functions. The testing module drives the waits with `advance(ms)`; `settle()` does not wait for them.
- Cost: the `retry` module, in the config module's bundle only in apps that call `retry()`; core grew 39 B gzip (14,203 to 14,242) for the hook.
- Recipe: "Offline drafts".

### Local actions (`data-sn-call`)
Work that is not one request (crypto, MIME, WebAuthn, other browser APIs) runs in app functions that pages call like requests (added 2026-11-05; decided in the local actions proposal).
```html
<button data-sn-call="mail.archive(msg)" data-sn-optimistic="remove(msg)" data-sn-catch="error = $error.message">Archive</button>
<sn-resource name="body" call="pgp.decrypt(open)" when="open" type="Decrypted"></sn-resource>
```
- The actions module is `src/sinter.actions.js` or `.ts` (`sinter({ actions })` overrides it), read like the helpers module: export names, `export * as ns` namespaces, re-exports followed. Its functions may be async and have side effects.
- `data-sn-call` is exactly one call of an exported function or namespace member; anything else is `SN401`, an unknown name `SN310`. A method attribute and `data-sn-call` on one element is `SN102`, and so is `data-sn-body` on a call.
- An action is an action: the same triggers, `data-sn-trigger`, `data-sn-debounce`, `aria-busy`, the mutation concurrency rules (`block` for forms, `queue`, `latest`; a running call is never aborted), optimistic layers, `then` with `$result`, `catch` with `$error`, and the unhandled-error path.
- Arguments are value expressions evaluated when the action triggers; like `data-sn-body`, they see `$event`, e.g. `$event.submitter` to tell a form's submit buttons apart. The function receives them, then a context: `{signal, request, el}`. `request` goes through the request layer (401 handling, origins, timeout); `signal` aborts when the page is hidden; `el` is the element (null for a resource).
- A thrown `SinterError` reaches `$error` as it is; anything else becomes `{status: null, body: <the thrown value>, message}`.
- Action functions never write to sinter-managed nodes or to state: they return data, and `then` puts it where it belongs. Expressions cannot call them (`SN203`); helpers stay pure.
- A handler that wants to run an action (a keyboard shortcut, `<sn-resource then>`, chaining from `data-sn-then`) calls `run('id')` on the element that carries it; see Running an action from a handler. There is no `app.call()`.
- `<sn-resource call>` is a resource fed by a function: the arguments' dependencies play the role of `src`'s, so a change aborts the running call through `ctx.signal`, drops its late result and calls again (latest wins). `$meta`, `refresh()` and `refetch` events work as for `src`. `paginate`, `each` and `cache` do not combine with `call` in v0.2.
- `sinter check` types the arguments against the function's parameters without a trailing `CallContext`, and `$result` as the awaited return type. The page module imports only the actions it calls. A resource fed by `call` holds the awaited result at `items`: without `type` that is its type (no `SN504`); with `type`, the result must fit it, reported on `type`.

### Running an action from a handler (`run('id')`)
A handler cannot call an action function (`SN203`), because an action's lifecycle belongs to its element: `aria-busy`, concurrency (never aborted), the optimistic layer and its rollback, `then`/`catch` and the unhandled-error path. `run('id')` starts the action of the element with that id instead, and that lifecycle runs unchanged (added 2026-11-08, for Caley's mark-read after load and for keyboard shortcuts without a visible control; there is still no `app.call()`):
```html
<span hidden id="mark-read" data-sn-call="mail.markRead(open)"
      data-sn-optimistic="patch(open, {is_read: true})"></span>
<sn-resource name="body" call="mail.body(open)" when="open"
             then="$result && !open.is_read && run('mark-read')"></sn-resource>

<body data-sn-on-keydown-e="run('archive')">
  <button id="archive" data-sn-post="/api/archive?id={open.id}" data-sn-attr="{disabled: !open}"
          data-sn-optimistic="remove(open)">Archive</button>
```
- **Target.** The element with that `id` in the mount root (components included). It carries an action: `data-sn-get`, `-post`, `-put`, `-patch`, `-delete` or `data-sn-call`, on any element, forms included. Elements with only `data-sn-on-*` handlers are not targets: their work is state writes the caller can make itself, or a helper both call.
- **Not a form:** `run()` enters where the trigger event would, so everything after the event happens as for a click: `data-sn-debounce`, `data-sn-confirm` (no means nothing happens), the concurrency policy, `data-sn-optimistic`, `aria-busy`, the request or call, `then`/`catch` and the unhandled-error path. No DOM event is dispatched: the target's own `data-sn-on-*` handlers do not run, nothing bubbles, and no default action happens (a link does not navigate, a checkbox does not toggle).
- **A form** is submitted with `requestSubmit()`, as Enter in a field does: constraint validation runs (an invalid form shows the browser's messages and is not sent), a real `submit` event fires, and sinter handles it as any submit, the form's `data-sn-on-submit` handler included.
- **Scope.** The target's expressions see the target's own scope (its `data-sn-state`, `data-sn-let` names, `$el` = the target), not the caller's. `run()` takes no arguments: what the action needs is state the caller sets first, `open = m; run('mark-read')`. It starts synchronously at the call, so the URL, body and call arguments see state assigned earlier in the same handler (debounce and an asynchronous `confirm` delay the start, as for a click).
- **`$event`** in the target's trigger-time expressions (URL, `data-sn-body`, `data-sn-call` arguments, `data-sn-confirm`) is `null` for a non-form target, and the `SubmitEvent` of `requestSubmit()` for a form (`submitter` null). `sinter check` types it as `RunEvent<…>` in every element `run()` names (not a form): `$event.shiftKey` there is `SN208` ("Property 'shiftKey' does not exist on type 'RunEvent<PointerEvent>'"), `$event && $event.shiftKey` is not. (Checking runs without `strictNullChecks`, where `Event | null` would be just `Event`, so the missing event is typed `void`, and `$event?.shiftKey` is reported too.) A button can then serve a click and a shortcut alike.
- **Ids are checked at build time** (`SN311 unknown-run-target`): the argument must be a string literal naming an element that carries an action; it must not sit in a `data-sn-for` row (every row would have the id: put one action outside the list and pass the row through state), and no other element may have the same id. A target inside a `data-sn-if`/`data-sn-else` branch is allowed.
- **When the target cannot run:**

| Target | Behaviour |
| --- | --- |
| disabled (`:disabled`: its own `disabled`, or a disabled `<fieldset>` around it) | nothing happens, no warning, as a click on a disabled button: disabling a button also turns off its shortcut |
| `inert`, itself or an ancestor (the attribute) | nothing happens, no warning, as HTML means by inert |
| `hidden`, `data-sn-show` false, off-screen | runs: a hidden carrier is the intended pattern |
| inside a closed `<dialog>` | runs: actions are bound at mount; only value bindings wait for the dialog to open |
| not on the page (a `data-sn-if` branch that is not rendered, removed by an island) | nothing happens; dev builds warn |
| a `block` action with a request pending | the run is ignored, as a second click would be |

- **Concurrency.** The target's own policy applies, per element: `GET` aborts the previous request (latest wins), `block` ignores the run, `queue` sends every run in order, `latest` keeps the newest waiting one; a running mutation is never aborted. `data-sn-concurrency="block"` on the carrier keeps one in flight and drops the rest.
- **No return value** (`undefined`). Results go where an action's results always go: the target's `data-sn-then` and `data-sn-catch`.
- **Where.** Every handler: `data-sn-on-*` (key filters included), `data-sn-then`/`data-sn-catch` (chaining: on success, run the next action), `<sn-event then>` and `<sn-resource then>`; it needs no element of the caller's. Not in value expressions (`SN203`) and not in `data-sn-optimistic` (`SN204`: a request cannot be rolled back).
- **Key filters** combine as any handler: `data-sn-on-keydown-mod-enter="run('send')"`. The filter has already called `preventDefault()`. Held keys repeat and every repeat runs the action through its concurrency policy; a shortcut that should not repeat guards itself, `$event.repeat || run('archive')`.
- **Cycles.** Actions are asynchronous, so a cycle is an endless series of requests, not a stack overflow: `data-sn-catch="run('save')"` on `#save`, A's `then` running B and B's running A, or a `<sn-resource then>` that runs an action whose `then` refreshes that resource. There is no runtime guard: the runtime cannot tell a loop from a retry. Warning `SN509 run-cycle` lists every such cycle with each step's element, handler and line: `` `#a` `data-sn-then` (index.html:4) runs `#b`, then `#b` `data-sn-catch` (index.html:5) runs `#a` ``. Edges are `run()` and `refresh()` calls in an action's `then`/`catch` or a resource's `then`; `data-sn-on-*` handlers are not edges (a user's event starts them), and a cycle needs at least one `run()`. A guarded retry is a deliberate cycle, so the check is off by default, a debugging aid: `sinter check --check-cycles` turns it on for one run, `sinter({ checkCycles: true })` for the build, `sinter check` and `sinter lsp`.
- **Islands** have no `app.run()`: they talk back through events, and the page decides, `data-sn-on-reader-read="run('mark-read')"`. That keeps the page the only place that knows its ids.
- Recipe: "Run an action from a handler" (mark read after load, and a shortcut on a button).

### Suggestion lists (`data-sn-listbox`)
A text input with suggestions below it, the WAI-ARIA combobox pattern:
```html
<input data-sn-model="q" data-sn-listbox="hits" data-sn-on-dismiss="open = false">
<ul id="hits" role="listbox" data-sn-show="open && hits.length">
  <template data-sn-for="h in hits"><li role="option" data-sn-on-click="pick(h)" data-sn-text="h"></li></template>
</ul>
```
- The compiler marks the input (`role="combobox"`, `aria-controls`, `aria-autocomplete="list"`); the `listbox` module handles its keys while the list shows options.
- Without an id (`data-sn-listbox`), the list is the nearest `[role="listbox"]` around the input (in its parent, else further up), for inputs rendered in a loop.
- ArrowDown and ArrowUp mark an option (`aria-selected="true"`, scrolled into view); Enter clicks the marked option, Tab the marked one or the only one; Escape fires `dismiss` on the input (bubbling and cancelable: one handler on a form can serve all its inputs, and an input's own handler can keep it there with `$event.preventDefault()`). Other keys, and Enter without a marked option, do what they always do.
- Typing unmarks. A mouse press on an option does not take the focus from the input. Picking is the option's own click handler.

## Optimistic updates
An action with `data-sn-optimistic` changes the store before the request is sent, keeps the change when the request succeeds, and undoes exactly that change if it fails. It ships in v0.1 as the `optimistic` module.
```html
<button data-sn-patch="/api/email/message/flags"
        data-sn-body="{account_id: m.account_id, mailbox: m.mailbox, uid: m.uid, flags: ['\\Flagged'], set: !m.is_flagged}"
        data-sn-optimistic="patch(m, {is_flagged: !m.is_flagged})"
        data-sn-catch="emit('toast', $error.message)"
        data-sn-attr="{'aria-pressed': m.is_flagged}">★</button>
```

### Model: base plus layers
Each resource holds a base (what the server last confirmed) and an ordered list of optimistic layers. What templates see is the base with every layer applied on top, in order.
- On trigger, the `optimistic` expression runs against a recorder. Its `patch`, `upsert` and `remove` calls become one layer, tagged with the action's request.
- The visible state is recomputed; affected rows re-render immediately.
- Success (2xx, or a call that resolves): the layer is committed: its changes are applied to the base, then `then` runs, so a `then` write (`upsert('contacts', $result)`) goes on top of them and wins. What the page shows does not change at commit, so nothing flickers and nothing flips back. A server event or a refetch that comes later wins too, as any later base write does. (Changed 2026-11-08: before, a success dropped the layer, so a change `then` did not write again flipped back until the next refetch.)
- Failure: the layer is dropped, which is the rollback; `catch` runs. An aborted or superseded request (a newer `GET` trigger) is a failure; so is a `latest` trigger replaced before it was sent.
- Commits keep the layers' order: a layer whose request succeeds while an older layer is still pending waits on top of it, and joins the base once every older layer has settled (committed or rolled back). So the change made last stays on top, whatever order the responses come in. While it waits it no longer counts in `pending`, and a server write to the same item wins over it (it drops that layer's changes to the item).
- Server events always write to the base. Layers are re-applied on top, so an SSE update arriving mid-flight is neither lost nor overwritten by a later rollback; on success the layer is applied on top of it.
- A commit is a confirmed write: a load in flight when it happens replays it on its (older) response, as for any write made during a load. A load that starts after the commit wins.
This is why rollback is "drop the layer", not "restore a snapshot": with two overlapping actions on the same item, a snapshot restore from the first failure would wipe out the second action's change.

### Rules
- `optimistic` may only call `patch`, `upsert` and `remove`. Anything else is a build error, because local state and side effects cannot be rolled back.
- A layer's `patch` on an item that the base no longer has is ignored; a `remove` of an absent item is a no-op.
- An optimistic `remove` on a paginated resource also decrements `$meta.<name>.total` inside the same layer; its commit keeps the total down.
- A layer lives until its request settles, including the 30 s timeout and, with `data-sn-retry`, every try its policy makes; then it is committed or dropped.
- Bulk actions put all their changes into one layer, so they roll back together.
- Pending layers are visible in dev tools through `$meta.<name>.pending` (count of layers whose request has not settled).

### Typical cases

| Action | Optimistic change |
| --- | --- |
| Flag or mark read | `patch(m, {is_flagged: …})` |
| Delete or move mail | `remove(m)` |
| Bulk mark read | one layer with one `patch` per selected message |
| Delete contact | `remove(c)` |
| Toggle calendar visibility | `patch(cal, {hidden: !cal.hidden})` |


## Pagination
Pagination is declared on the resource and driven by `page()` calls; v0.1 supports keyset, offset and append modes in the `paginate` module.
```html
<sn-resource name="messages"
  src="/api/email/messages?account_id={$url.account_id}&mailbox={$url.mailbox}"
  items="messages" total="total" key="account_id,mailbox,uid"
  paginate="keyset" page-size="50" size-param="limit"
  cursor="{cursor_sent_at: sent_at, cursor_rowid: rowid}"
  direction-param="direction"></sn-resource>

<nav>
  <button data-sn-on-click="page('messages', 'first')" data-sn-attr="{disabled: !$meta.messages.hasPrev}">«</button>
  <button data-sn-on-click="page('messages', 'prev')"  data-sn-attr="{disabled: !$meta.messages.hasPrev}">‹</button>
  <span data-sn-text="`${$meta.messages.from}–${$meta.messages.to} of ${$meta.messages.total}`"></span>
  <button data-sn-on-click="page('messages', 'next')"  data-sn-attr="{disabled: !$meta.messages.hasNext}">›</button>
  <button data-sn-on-click="page('messages', 'last')"  data-sn-attr="{disabled: !$meta.messages.hasNext}">»</button>
</nav>
```

### Modes

| Mode | Request parameters | `page()` targets | Fits |
| --- | --- | --- | --- |
| `keyset` | `cursor` fields read from the current page's boundary item + `direction` | `first`, `prev`, `next`, `last`; with `offset-param` also a page number | large or live lists where pages must not shift |
| `offset` | `page-param` (1-based) + `size-param`; with `offset-param`, the items to skip instead of the page | the above + a page number | lists that need "go to page N" |
| `append` | like `keyset`, `next` only | `next` | "load more", infinite scroll |

Keyset mode jumps only when the server can skip by offset as well. With `offset-param="offset"`, `page('messages', 7)` requests the `first` direction with `offset=300` (page size 50) and no cursor; `prev` and `next` then continue by cursor from that page's first and last items. Without it, a page number on a keyset resource is error `SN304`, with a hint to add `offset-param` or use offset mode. sinter never simulates jumps by stepping through pages. (Added 2026-11-05, for APIs such as Caley's mail list.)
- Offset mode with `offset-param` (added 2026-11-10): page n sends `offset-param`=(n - 1) × `page-size` and `size-param`, no `page-param`, for APIs that take an offset (RealWorld's `?offset=20&limit=10`).
- `page-model="$url.page"` (added 2026-11-13, offset mode only; replaces `start-page`, which is `SN401` naming the rename): the list's page lives in the URL, read at load and written back on every move. The URL is the single source. The pager keeps `requested`, the page of its last request; its request, refetches (`refresh`, `pageshow`, `online`) and retries are built from the parameter (`pageParams(toPage(…))`). `page()` does not load: it computes the target and writes it (page 1 deletes the parameter), a push. `next`/`prev` count from `requested`, or from the shown page after a failed load; a target past `pages` is clamped when the total is known; with an unknown total, `next` is ignored while a page is loading; `prev`/`next` past the ends do nothing. `page()` to the page already requested reloads it when the last load failed (a handler writing the same value changes nothing). On a resource whose `when` is false, `page()` does nothing. The pager follows the parameter (it is among the resource's dependencies): it loads `toPage(param)` when that differs from `requested`, so a typed page field gets the typing pause and the pager's own write is no echo. The first URL a resource gets after mount (at mount, or when a late `when` turns true) reads the parameter and never writes: `?page=3` restores, with no clamp or correction (`?page=abc` is page 1). A change caused by popstate never resets: it loads the parameter's page. Any other later change of the resource's URL (a `src` change, a later `when` turning true) resets to page 1 and deletes the parameter, a replace: changing a filter on page 3 starts at page 1, and Back restores page 3. `when` turning false never writes. `$url.page` is the page asked for (it changes at once), `$meta.<name>.page` the page shown (it changes when the response arrives, and stays after a failure). Lists bound to the same parameter page together and reset together. The early request, the preload rule and `sinter-embed.json` (`start`) read it where `start-page` was (`pageParams` in `runtime/pages.ts`, shared by all of them). Errors: on another mode `SN401` with the reason (keyset page numbers are often unknown; keyset and append move by cursor); a value other than `$url.<query param>` (a path parameter, state, an expression, a list) `SN203`; the resource's own `src` or `when` reading the same parameter `SN401`, since each page write would reset the list. Lost with `start-page`: a start page from a path segment, from an arbitrary expression, and for keyset lists with `offset-param` (those start at page 1). Cursor-based lists (plain keyset, append) are not synced to the URL.
- The target may be computed: `page('results', $event.shiftKey ? 'prev' : 'next')`, or a helper's result, so one handler serves both directions. The compiler cannot tell a computed direction from a page number, so it accepts it, and `sinter check` types it: on a keyset resource without `offset-param` it must be a subset of `'first' | 'prev' | 'next' | 'last'` (a `number`, or a plain `string`, is `SN208`, whose message says to add `offset-param` for page numbers); elsewhere a direction or a number. A literal page number stays `SN304`; `append` takes only the literal `'next'`. (Added 2026-11-08, for Caley's keyset list.)
- At run time a target the resource cannot go to (a page number on keyset without `offset-param`, a string that is not a direction, `NaN`) sends no request: it takes the error path of a failed load, `$meta.<name>.error` with the reason and the unhandled-error path (see Unhandled errors), plus a dev warning. The next load clears the error.
- A jump target is clamped to `$meta.<name>.pages` when the total is known.
- `$meta.<name>.page` is the page holding the last item shown, `ceil(to / page-size)`, so it is exact after a jump, `first` and `last`, and approximate after cursor steps across items inserted meanwhile, as offsets always are on a live list.

### Server requirements for keyset
- `direction` takes `first`, `prev`, `next` and `last` (or the values `direction-values` maps them to). `first` and `last` send no cursor.
- `prev` and `last` read the list in reverse on the server, but the response is always in display order.
- The cursor fields must form a unique, stable sort key (e.g. a timestamp plus a row id).

### Attributes

| Attribute | Meaning |
| --- | --- |
| `paginate` | `keyset`, `offset` or `append` |
| `page-size` | items per page; sent as `size-param` |
| `size-param` | name of the size query parameter, default `limit` |
| `cursor` | object literal evaluated on the boundary item of the current page: its last item for `next`, its first item for `prev`; `first` and `last` send no cursor. Fields that are `null` or `undefined` are left out, as in URL templates |
| `direction-param` | name of the direction parameter; values `first`, `prev`, `next`, `last` |
| `direction-values` | keyset/append: object literal of strings, the value sent for a direction where the server names it differently, e.g. `{first: 'forward', prev: 'backward', next: 'forward'}` (`first` and `next` may share a value: the server tells them apart by the cursor, which `first` does not send); directions not listed are sent by name |
| `page-param` | offset mode: name of the page parameter, default `page` |
| `offset-param` | keyset mode: name of an offset parameter the server also accepts; enables `page(name, n)` and `$meta.<name>.page` |
| `page-model` | offset mode: `$url.<param>`, the URL query parameter that holds the page (see above) |


### `$meta` fields
`page` (offset mode, and keyset with `offset-param`), `pages` (when `total` is known), `total`, `from`, `to`, `hasPrev`, `hasNext`, `loading`.
For keyset, `hasNext` is true when the page came back full; `hasPrev` is false after `first` or when a `prev` page comes back short. `from` and `to` are `null` when they cannot be known (after `last` without a `total`). `from` and `to` are tracked by the runtime from page moves.

### Rules
- A change to `src` (e.g. another filter value) resets to the first page (with `page-model`, the parameter is deleted, a replace).
- `refetch` repeats the current page's exact request, so a refresh never jumps.
- `page()` during a pending page load aborts the pending one.
- After `last`, `hasNext` is false; after `first`, `hasPrev` is false.
- `append` mode keeps all loaded items; `refetch` reloads them as one request with `size = loaded count`.
- Server events on paginated resources follow the rule in Sync: unknown keys trigger a refetch of the current page.

### Past the ends
`page()` with `prev` does nothing while `$meta.<name>.hasPrev` is false, and with `next` while `hasNext` is false, in every mode: no request, no change. `first` and `last` always load (they send no cursor, so they also serve as "reload from the top"), and page numbers keep their clamping. A handler that pages in a computed direction needs no guard:
```html
<div data-sn-let="{ shown: searching ? 'results' : 'messages' }"
     data-sn-on-list-step="page(shown, $event.detail > 0 ? 'next' : 'prev')">
```
- Buttons keep their `disabled: !$meta.x.hasNext`, a binding with a fixed direction.
- `append` with infinite scroll stops sending requests at the end: after a short page `hasNext` is false.
- A live list that wants the items added after a short keyset page uses `refresh()` or a server event's `refetch`: a refetch repeats the current page and recomputes `hasNext`.
- Before the first load has come back both flags are false, so `prev` and `next` do nothing then.

### Page transitions (`data-sn-transition`)

The page fade is CSS (`@view-transition { navigation: auto; }`; temper has it on by default). `data-sn-transition="'article-' + a.slug"` on an element in a list row and `data-sn-transition="'article-' + $url.slug"` on the detail page say they are the same thing: following the row's link morphs one into the other.
- The value is a value expression; the runtime keeps it on the element as `data-sn-vt` (an attribute binding). Pages that use the attribute get the `transition` feature (`@tiaforge-ui/sinter/transition`).
- Old page (`pageswap` with a view transition): when a click on a link started the navigation (the activation URL is the link's), the named element is the one the link is in or holds, else the one of its row: the nearest ancestor of the link that holds named elements, if it holds exactly one and no link to another URL. A back or forward navigation (`traverse`) on a page with exactly one named element uses that one. Its name goes to sessionStorage (`sn:vt`, with the time: a name older than 10 s, `PENDING_MAX`, is ignored and removed, so a navigation that reached a page without the feature leaves nothing a later page acts on).
- New page (`pagereveal` with a view transition): the first element whose name is the stored one.
- Both get `view-transition-name: sn-<hash of the name>` (a valid ident for any name, the same on both pages) and `view-transition-class: sn-transition` until the transition finishes, so only the pair is captured, never a whole list, and two equal names on one page cannot end the transition. The class is for the app's CSS: `::view-transition-group(.sn-transition) { animation-duration: 300ms; }` styles every morph (the names are hashes).
- The new page's element must exist at its first paint, which is when the browser captures it, and the page module is `async`, so it may mount after that. So pages that use the attribute get a small classic script first in the head (the build only: the start of the page's own head script, `assets/<page>-head-<hash>.js`, see First paint). It does nothing unless a name is pending; then it turns the page module's tag, as the parser inserts it, from `async` into a deferred render-blocking module, which mounts in the parse's last task, before the first paint (`HOLD_SCRIPT` in `paint-build.ts`). The first paint then waits for the page bundle, only on a navigation that morphs. It waits for the mount, not for responses: the element must render from what the page has at mount (literal text, `$url`, `cache`, prefetched or embedded data). Measured 2026-11-09 in Chromium (RealWorld): list → article and back to a reloaded list both morph (3 of 3 runs each; before the hold script, back only faded). `e2e/navigation` checks both directions with the API slowed to 1.5 s.

## Rendering and scheduler
sinter updates the DOM fine-grained, without a virtual DOM: every binding knows its node, and only bindings whose inputs changed are re-evaluated and written.

### Mount
- One `querySelectorAll('[data-sn]')` builds the id → element table.
- Root bindings attach to their elements; `data-sn-state` scopes are created.
- Resources start loading (or read embedded data); syncs connect.
- One listener per used event type is added at the mount root.

### Template instances
- An instance is `template.content.cloneNode(true)` plus the nodes found by the IR's node paths, resolved once per clone (a one-element row clones just that element and keeps no node list).
- Each instance keeps its scope (loop item, index) and the last value written by each binding.
- A binding writes only when the new value differs from its last value.
- Simple rows (changed 2026-11-08). A row template whose elements carry only value bindings and handlers (no state, model, nested template or dialog) is the common case, and its rows keep no binding objects: the last values live in one array per row, parallel to the template's value bindings, and the elements are found again from the row's first node (the template's lookup function) when the row renders, so a row holds no references to its inner elements. Handlers in such rows bind on their first event: the dispatch walk finds the row above the target (a `WeakMap` from row nodes to instances), locates the element among the row's bound elements, and keeps the handler bindings on the element from then on (a debounced handler keeps its timer across events). The observable behaviour is that of bound bindings; what changes is memory per row (the 1,000-row benchmark table: see `docs/benchmark.md`) and that the row's inner element wrappers can be collected between renders.
- Compiled creation (added 2026-11-08). For a simple row template whose bindings do not read `$el`, the compiler also emits a creation function (`make` in the IR): it walks from the clone's first node to each element with a value binding (the same path code as the lookup function; an element with only handlers is not visited, as its handlers bind on its first event), evaluates every value expression inline in the row scope and writes each through the runtime's writer for its kind (`w.t` text, `w.a` attribute, `w.c` class, `w.s` style, `w.h` show, `w.p` property; the writers are the same code the generic path uses, so URL and style checks are not duplicated), and returns the last values. A class binding's first write knows from the source whether the element has a `class` attribute (`cl` on the node), so a false value on a fresh clone writes nothing. If the function throws (an expression error), the row is created by the generic path, which reports the failing binding. Creating a row then costs the clone, the walk, the expressions and the writes, with no element array, table lookup or per-binding dispatch.

### Writes

| Binding | Write |
| --- | --- |
| `text` | `textContent` of one text node |
| `attr` | `setAttribute`; `null`/`false` → `removeAttribute`; URL values checked first |
| `class` | `classList.toggle` per key |
| `style` | `style.setProperty` per key; `null` → `removeProperty` |
| `show` | `hidden` attribute |
| `prop` | property assignment |
| `model` | `value`/`checked`/`selected` per control; skipped while the element has focus and already holds the value |
| `if`/`else` | insert or remove the instance fragment |


### Keyed lists
- The list keeps a `key → instance` map.
- On a change, unchanged keys keep their nodes; new keys get instances; missing keys are removed.
- Reordering uses a longest-increasing-subsequence pass, so the minimum number of nodes move.
- A row re-evaluates its bindings only if its item object was replaced, its own state path is dirty, or a dependency outside the row (e.g. `q`) changed.
- Selection bindings (added 2026-11-08). A value binding in a row whose value is `row side === outer side` (or `!==`), where one side reads the row (its item or index) and the other reads something outside it (`{active: row.id === selectedId}`, `{on: n === g.pick}` under an outer loop, `data-sn-show="r.id !== hidden"`), is marked by the compiler (`s` in the IR: both sides as functions, the outer side's dependencies). When only the outer side changes, the runtime re-evaluates the binding on the rows the comparison held for and on the rows whose row side equals the new outer value, found through an index built from the rows on first use; every other row keeps its value, which cannot have changed. Any other change to the rows (a reconcile, a row-side dependency) renders them as before and drops the index. The pattern is strict equality only: `==` is not an index lookup, a ternary around the comparison is not the pattern. The result equals evaluating every row.
- Reused nodes keep focus, selection, scroll position and half-typed input.

### Scheduler
- All changes in one task are collected; one microtask flush evaluates dirty bindings and writes.
- Changes from server events (`<sn-sync>`: the store changes and state writes of `<sn-event>` mappings and their `then`) are applied when the event arrives, and rendered before the next frame is painted (`requestAnimationFrame`) instead of in a microtask, so a burst of events renders once per frame. Any other change (a handler, a response, a timer) still flushes in a microtask and renders the waiting server changes with it. A hidden page has no frames: there, server events flush in a microtask as before. Islands' `app.on()` listeners run when the event arrives, before that render. (Added 2026-11-10, from bench/live: at 4× CPU slowdown a dashboard kept up with 200 events/s when each one rendered, and with 5,000/s at 51 fps rendering once per frame.)
- The core never reads layout (`offsetHeight`, `getBoundingClientRect`), so a flush cannot force reflow.
- Bindings inside a closed `<dialog>` are kept dirty and evaluated on its `toggle` to open.

### Events
- A delegated listener walks from the target up to the first element that handles the event: one with a handler or action for that type that ran; for keys, a matching filter, an action, a debounced handler, or a plain handler that prevented the key (see Which handlers run).
- A row element maps to its instance through a `WeakMap`, which supplies the loop scope.
- `input` and `change` from `data-sn-model` elements update state before other handlers on the same event run.

#### Which handlers run
Delegation walks from the target up, and the first element that **handles** the event ends the walk. On that element every applying handler runs, in attribute order, with its action's trigger. An element handles the event when:
- **Any event but keys and bubbling custom events** (`click`, `submit`, `input`, an island's plain `Event`, a `CustomEvent` that does not bubble): any of its handlers or an action for that type ran. A button or an action inside a clickable row keeps the row's `data-sn-on-click` from running.
- **Bubbling custom events** (`emit()`, islands' `CustomEvent`s, `sn-error`, `dismiss`): no element ends the walk by handling them; it ends where a handler called `$event.preventDefault()`. See Custom events are notifications.
- **Keys** (`keydown`, `keyup`): a key filter matched (it calls `preventDefault()` first), an action ran, a debounced handler was scheduled, or a plain `data-sn-on-keydown`/`-keyup` ran **and `$event.defaultPrevented` is set afterwards**. A plain key handler that does not prevent a key passes it on, so `<body data-sn-on-keydown-shift-n>` still gets N while focus is in a grid whose plain handler takes only the arrow keys it calls `preventDefault()` for. To keep a key from ancestors, prevent it.
- A debounced plain key handler has not run when the walk decides, so it always counts as handled; a key that should go on past such an element needs a key filter for the keys the element uses instead.
- The editable-field rule applies wherever the walk goes: an ancestor's filter never takes a key typed into a field, so a key a field's plain handler passes on only reaches ancestors' plain handlers.
- Non-bubbling events (`focus`, `blur`, `toggle`, `close`, `cancel`, `invalid`, `scroll`, `load`) are seen by sinter's capture listener at the root and take the same walk: the nearest element from the target up with a handler for the type, an ancestor included (an inner `<details>` without a handler reaches an outer `<details data-sn-on-toggle>`).
- `run('id')` dispatches no event and takes no walk; a form it submits sends `submit` as usual.
- There is no sinter-level stop. `$event.stopPropagation()` keeps its native meaning: sinter's listener runs in the capture phase at the root, so calling it there also keeps the event from the target and any island's listeners, and does not end sinter's walk early (the walk has already ended at the element that handled the event).
- Cost: one property read per ancestor for the event types the page binds; the walk goes past an element only for a key it did not prevent.

Why this rule (decided 2026-11-08, from Caley's calendar, whose week-grid arrow handler hid the page's N and P): nearest-wins is what clickable rows with buttons, actions and forms rely on, so it stays; only plain key handlers changed, and their signal is the DOM's own for a consumed key, which handlers already give for keys they take from their default. Full DOM-like bubbling would have needed a stop at every inner handler, and opt-in attributes would have needed markup in each place.

#### Custom events are notifications
A bubbling custom event (`emit()`, an island's `CustomEvent`, `sn-error`, the `listbox` module's `dismiss`) does not end the walk at the first element that handles it: it goes to every element from the target up to the mount root that has a handler for it, until a handler calls `$event.preventDefault()`. Clicks need nearest-wins (a button in a row is not a click on the row); a custom event says that something happened, and every level that cares hears it. A row that clears its own `saving` flag and a page that shows a toast handle the same `saved`:
```html
<main data-sn-state="{ toast: '' }" data-sn-on-saved="toast = m.saved()">
  <template data-sn-for="r in rows">
    <li data-sn-state="{ saving: false }" data-sn-on-saved="saving = false">       <!-- runs first, passes it on -->
      <button data-sn-post="/api/r/{r.id}" data-sn-on-click="saving = true" data-sn-then="emit('saved', $result)">
```
- **Which events.** Events that are `CustomEvent`s and bubble. Native events, and an island's plain `Event`, keep the rule above (the nearest element that handled it; keys go on when not prevented). A custom event that does not bubble (`bubbles: false`) keeps its nearest-ancestor reach: the island said it should not travel.
- **Order.** Inner to outer, as the event bubbles; on each element its handlers in attribute order, with its action's trigger. Everything runs synchronously inside the dispatch, so an outer handler sees the state the inner one wrote, every handler sees the same `$event.detail`, and statements after `emit()` in the emitting handler run after all of them. Each level has its own scope: `$el` is that element, its own state and lets. One flush renders all their writes.
- **Saying "final".** `$event.preventDefault()`: the walk stops after the element whose handler prevented it (the other handlers on that element, and its action, still run, as for keys). `emit()` dispatches a cancelable event, and so does the `listbox` module for `dismiss`. `sn-error` is cancelable, and preventing it means "handled, no `onError`": an inner `data-sn-on-sn-error` that only logs lets the page's handler and then `onError` see the error. A handler on a non-cancelable custom event (an island's event without `cancelable`) cannot stop it (the DOM ignores `preventDefault()` there): every level runs. Islands whose events may be final at some level dispatch them with `cancelable: true`.
- **Debounced handlers** (`data-sn-debounce-<event>`) have not run when the walk decides, so they pass the event on; a level that must be final does not debounce, or prevents in a plain handler next to the debounced one.
- **Actions** triggered by a custom event (`data-sn-trigger="saved"`) pass it on too: an action does not prevent a custom event (an `<a>` action prevents only native events).
- **Islands and other listeners.** sinter's walk runs in its capture listener at the root, before the event reaches its target and bubbles to `document`, so app code listening outside sinter (RealWorld's `document.addEventListener('navigate', …)`) still gets every event, and can read `defaultPrevented` to see whether a page handler took it. An island that dispatches a cancelable event and checks `dispatchEvent()`'s result to skip its own default (a `reader-close` the page may veto) sees a page handler that ends the walk as a veto too; an island that needs the two apart dispatches two events.
- **`$event.stopPropagation()`** keeps its native meaning, as above: it does not end sinter's walk (which already runs at the root), and it keeps the event from its target and from listeners outside sinter. There is no sinter-level stop: `preventDefault()` already says "final" for keys and `sn-error`.
- `run('id')` dispatches no event and is unaffected.

Why (decided 2026-11-08, the follow-up the dispatch decision above left open): with nearest-wins, one custom event could not be handled at two levels, so pages merged such handlers on the page, which then reached into the row's state (Caley's reader `mail-patched` and `mail-removed`). Notifications are the default rather than opt-in, because an emitter-side flag would make the receiver read the emitter to know how far an event goes, and a receiver-side attribute would be needed at every outer level. A behaviour change, listed in the CHANGELOG: an element tree with handlers for the same custom event at two levels now runs both unless the inner one calls `$event.preventDefault()`.

## Security
sinter never creates HTML from data, and every remaining DOM sink is closed at build time or checked at runtime. The core uses no Trusted Types sinks, so pages can run under `require-trusted-types-for 'script'`.

### Sinks and how each is closed

| Sink | Risk | Rule |
| --- | --- | --- |
| `data-sn-text` | none | `textContent` only |
| `data-sn-attr` names | event handlers such as `onclick` | keys must be literal; computed keys, spread (`...obj`) and `on*` names are `SN207` |
| `data-sn-attr` URL values | `javascript:` links and forms | runtime scheme allowlist (below) |
| `data-sn-attr` `style`, `srcdoc` | CSS injection, HTML | `SN207`; styles go through `data-sn-style` |
| `data-sn-attr` `id`, `name` from data | DOM clobbering of other scripts | warning `SN503` |
| `data-sn-style` | CSS that loads URLs | literal property names, no spread; values set with `style.setProperty`; values containing `url(`, `image(`, `image-set(` or a backslash are rejected at runtime |
| `data-sn-prop` | `innerHTML` and friends | only on custom elements; literal keys, no spread; `innerHTML`, `outerHTML`, `srcdoc` are `SN207` |
| `data-sn-class` | applying arbitrary existing classes | computed keys allowed (low risk); classes only, never other attributes |
| any binding on `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`, `<link>` or SVG `<animate>`, `<set>`, `<animateMotion>`, `<animateTransform>` | script execution, page takeover | `SN207` |
| `data-sn-attr` on a `<meta>` with a literal `name`, `property` or `itemprop` | none for `content` | only the key `content`; nothing on `http-equiv` or `charset` (`SN207`) |
| URL templates of resources, actions and streams | requests to an attacker-chosen origin, leaked headers | see Requests and origins |
| store merges, form serialization, `patch` fields, `$url` | prototype pollution | keys `__proto__`, `constructor` and `prototype` are dropped; objects built from input have a null prototype |
| `data-sn-persist` | secrets left in localStorage | refused (`SN207`) on `type="password"` and on fields with `autocomplete` `cc-*`, `one-time-code` or `current-password`/`new-password` |


### URL attributes
`href`, `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping` and `xlink:href` are checked, and every candidate in `srcset`.
- The scheme is read as the URL standard reads it (`schemeOf` in `runtime/security.ts`): leading control characters and spaces stripped, tabs and newlines removed anywhere, then a letter followed by letters, digits, `+`, `-` or `.` up to `:`; anything else is relative and judged by the scheme of the element's base URL (`baseURI`, what the browser resolves it against: `<base href>` can make it `ftp:` or `webcal:`, and then a relative link has that scheme). So whitespace, control characters, tabs inside the scheme and mixed case cannot disguise it. It agrees with the browser's parser on every URL that parser accepts (a differential test over generated strings; 2026-11-09, 200,000 strings in Chromium, none differing), at a fraction of the cost of `new URL()` (1,000 links: 1.5 ms instead of 5.1 ms in Chromium, 1.2 ms with no check). Only the scheme is checked: a URL the browser cannot parse further is written as an invalid link, as in static HTML.
- Allowed: `http:`, `https:`, `mailto:`, `tel:`, and relative URLs. `data:` and `blob:` only in `src` of `<img>`, `<video>`, `<audio>` and `<source>`.
- A rejected value removes the attribute; dev builds warn with the element and the value.
- `configure({ urlSchemes: ['webcal:'] })` adds schemes. `javascript:`, `vbscript:` and `data:` outside media can never be added.
- The check is about the scheme only: a protocol-relative `//other.example` or an `https:` URL to another origin is allowed, as in static HTML.
- The early file skips the check where the compiler proves the scheme from the expression: a value whose literal start is `/` followed by any character but `/` or `\` (`'/article/' + slug`; not `'/' + v`, which is `//host` when `v` starts with `/` or `\`, nor `` `/${v}` ``), `./`, `../` (or `.\`, `..\`), `?`, `#`, `http://`, `https://`, `mailto:` or `tel:`, tabs and line breaks removed first as the URL parser removes them; a ternary or `||`/`??` of such values, `&&` with one on its right, `null` and `false`. Every other URL value is checked.

### No runtime template processing
Vue, Alpine, Datastar and htmx all process directives found in the live DOM, so server-rendered user content that contains a directive runs as code (client-side template injection). sinter cannot have this class of bug: directives exist only at build time, and the runtime never reads a `data-sn-*` attribute. Injected markup with directives is inert HTML.
The runtime only reads `data-sn` ids, so it checks them at mount:
- Each id must appear exactly once, on an element with the tag the IR recorded. A missing, duplicate or mismatched id is not bound, and dev builds report it.
- Embedded data (`data-sn-data`) is accepted only from `<head>`, at most once per resource name; anything else is ignored with a dev error.
- The runtime never reads named properties of `window` or `document` (`document.currentScript`, `document.scripts`, `window.<id>`), the pattern behind most published DOM clobbering gadgets in bundlers and libraries.
Configuration comes only from `configure()` in JavaScript, never from the DOM, so injected markup cannot change request scope, headers or schemes.

### Requests and origins
- A URL template must start with a literal same-origin path (`/` followed by a non-slash) or an origin listed in `configure({ origins: [...] })`. A leading interpolation or `//` is `SN207`. This prevents the absolute-URL class of bug, where a full URL in a parameter overrides the intended base.
- At runtime, a resolved URL whose origin is neither the page's nor an allowed one is refused and reported through `onError`.
- Interpolated values are encoded with `encodeURIComponent`; values that are exactly `.` or `..` are encoded as `%2E` / `%2E%2E`, so they cannot climb path segments.
- Header middleware such as the CSRF header applies to same-origin requests only, unless it is scoped to a listed origin explicitly. A CSRF token never leaks to third-party hosts.
- Stream URLs of `<sn-sync>` follow the same rules.

### Client state is untrusted
`data-sn-state`, `$url` and persisted values can be changed by the user in the browser, and `$url` by anyone who sends a link; URL values reach models (as values, never markup) and `page-model` (parsed as a whole number). The server validates every request on its own. Persisted keys are namespaced `sn:`, cleared by `loginRedirect`, and can be cleared with `clearPersisted()` on logout.

### Outside sinter's control
- Islands, user helpers and `onError` handlers are trusted code and must not pass server data, `$error.message` included, to HTML sinks themselves.
- Embedded JSON must be serialized with `<` escaped as `<`, so it cannot close its `<script>`.
- The server rejects state-changing requests without the CSRF header, never changes state on `GET`, and never answers credentialed CORS requests for arbitrary origins (which would defeat the header check).
- JSON responses carry `Content-Type: application/json` and `X-Content-Type-Options: nosniff`.
- Pages with sensitive data restored from the back/forward cache after logout are caught by the session probe, which runs on `pageshow` before any stream reconnects; a server that must never show them again sends `Cache-Control: no-store`.
- Expressions are authored code; their sandbox is a guardrail, not a security boundary (see Expressions and scope).

### Verification
- Compiler fixtures for every `SN207` case.
- An XSS payload corpus (filter-evasion cases such as encoded and whitespace-split schemes, mixed case, leading control characters, `srcset` lists) run through every runtime sink in Chromium, Firefox and WebKit.
- Injection tests: server-rendered markup containing `data-sn-*` attributes, forged `data-sn` ids and forged `data-sn-data` scripts must stay inert.
- A DOM clobbering corpus (named `form`, `img` and `a` elements shadowing `document` and `window` properties) must not change runtime behaviour.
- URL tests: absolute and protocol-relative values, `.`/`..` segments and disallowed origins in every URL template position.
- The whole browser suite also runs with Trusted Types enforced and a strict CSP, and fails on any violation report.

### Supply chain and build
- The runtime has zero dependencies; the compiler's are few, pinned, and reviewed on update.
- The package has no install scripts.
- Releases are published only from CI through npm trusted publishing with provenance; maintainer accounts use 2FA and hold no long-lived publish tokens. This is the path that self-replicating npm worms abused through stolen tokens and `postinstall` hooks.
- The compiler uses a spec-compliant HTML parser (the algorithm browsers use, no regular expressions) and serializes its output from that tree, so the compiler and the browser always agree on which element an attribute belongs to.
- Component files are read from `src/components/` inside the project root only, symlinks included, so a build cannot inline files from outside the project.

## JS API for islands
Islands are custom elements that own imperative work (encryption, rich editors, canvas-like views); they get data through properties and talk back through DOM events, and may use the store directly.

### Data in, events out
```html
<template data-sn-if="selected">
  <mail-reader data-sn-prop="{message: selected, unlocked: vaultUnlocked}"
                data-sn-on-reader-flag="patch(selected, {is_flagged: $event.detail})"></mail-reader>
</template>
```
- `data-sn-prop` assigns JS properties, so islands receive objects, not strings.
- An island's module may define its element after the page has mounted (a lazy `import()`). Until then, a property sinter sets is a plain own property of the element, readable but hiding the class's accessor once it is defined. So for an element that is not defined yet, sinter remembers the latest value of each property and, when `customElements.whenDefined()` resolves (a microtask after the upgrade, so after the constructor and `connectedCallback`), deletes the own property and sets the value again, through the class's setter. A class field the upgrade redefined gets the latest value too. Elements already defined pay one `customElements.get()` per write. (Fixed 2026-11-08; Caley had an `upgradeProps()` workaround.)
- An island dispatches `CustomEvent`s with lowercase kebab-case names (`reader-flag`), bubbling; `data-sn-on-<name>` handles them at every level until one calls `$event.preventDefault()`, so an event that may be final somewhere is dispatched with `cancelable: true` (see Events, Custom events are notifications).

### Instance API
```ts
import { instance } from '@tiaforge-ui/sinter';

const app = instance(document);            // the instance mount() created

const messages = app.resource('messages'); // Resource<T>, see Resources and store
messages.subscribe(change => { /* … */ });
messages.patch(msg, { is_read: true });

app.request('/api/email/raw?…');           // fetch through the request layer
app.optimistic(() => messages.remove(msg), () => app.request(url, { method: 'DELETE' }));

app.on('new_email', payload => notify(payload));  // any server event, mapped or not
```

| Method | Purpose |
| --- | --- |
| `instance(root)` | the instance mounted on `root`; throws if none |
| `resource(name)` | the store handle of a declared resource |
| `request(url, init)` | fetch through the middleware chain; same 401 handling |
| `optimistic(change, run)` | apply `change` as a layer, settle it with the promise from `run`: committed when it resolves, rolled back when it rejects |
| `on(event, fn)` | subscribe to a server event by name; returns unsubscribe |


### Rules
- Components with a script never write to sinter-managed nodes; neither do islands (plain custom elements). Markup written inside a custom element in the page is bound like the rest of the page.
- Direct store writes from islands go to the base, like server events; unconfirmed changes use `app.optimistic()`. Both follow the base/layer model, so SSE and optimistic updates stay consistent.
- Multiple instances may exist (one per mount root); there is no global singleton.

## Developer experience
Errors should be found by the compiler, worded so that a person or a coding agent can fix them from the message alone.

### Diagnostics
Each diagnostic has `severity`, `code`, `message`, `file`, `line`, `col`, an optional `hint` and an optional `span` (what an editor underlines).

| Code | Severity | Example message |
| --- | --- | --- |
| `SN101 unknown-attribute` | error | `data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`? |
| `SN102 wrong-element` | error | `data-sn-for` must be on a `<template>` |
| `SN103 missing-key` | error | a `data-sn-for` over primitive values needs `data-sn-key` |
| `SN104 unsupported-model` | error | `data-sn-model` does not support `type="file"`; submit the form instead |
| `SN201 unknown-identifier` | error | `contcts` is not defined here. Did you mean `contacts`? |
| `SN202 forbidden-global` | error | `window` is a browser API; expressions may use JavaScript, not the browser. Use a component's script |
| `SN203 side-effect` | error | value expressions cannot assign; move this to `data-sn-on-*` |
| `SN204 optimistic-scope` | error | `data-sn-optimistic` may only call `patch`, `upsert`, `remove` |
| `SN205 resource-mutation` | error | `m.is_read = true` mutates a resource. Use `patch(m, {is_read: true})` |
| `SN206 unknown-namespace-member` | error | `m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`? |
| `SN207 unsafe-sink` | error | `onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click` |
| `SN208 type-error` | error | Property 'nmae' does not exist on type 'Contact'. (TS2339) — `sinter check` only |
| `SN210 url-list-mismatch` | error | `$url.tag` is a list elsewhere on the page (a `<select multiple>` or a checkbox with a `value`), and one value here; bind it as a list everywhere |
| `SN211 url-list-condition` | error | `$url.tag` is a list and always truthy; use `$url.tag.length` |
| `SN301 unknown-resource` | error | resource `mesages` is not declared on this page |
| `SN302 duplicate-resource` | error | resource `contacts` is declared twice |
| `SN303 unknown-meta-field` | error | `$meta.contacts.loadng` is not a status field. Did you mean `loading`? |
| `SN304 keyset-jump` | error | keyset pagination cannot jump to a page number. Use `paginate="offset"` |
| `SN306 component-cycle` | error | `<x-a>` → `<x-b>` → `<x-a>` uses itself with no `data-sn-for` or `data-sn-if` template between |
| `SN307 openapi-invalid` | error | OpenAPI spec `api.yml` is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`) |
| `SN308 unknown-schema-field` | error | the response of `GET /articles` has no `articls`. Did you mean `articles`? |
| `SN311 unknown-run-target` | error | no element `id="mark-raed"` on this page. Did you mean `mark-read`? |
| `SN312 invalid-component` | error | a component has one root element; `<article-preview>` has 2 elements at the top of its template |
| `SN313 unknown-prop` | error | `artcle` is not a prop of `<article-preview>`; its props are `article`, `compact` |
| `SN314 unknown-slot` | error | `<article-preview>` has no slot `meta` |
| `SN315 unknown-component-event` | error | `<task-ring>` does not declare the event `pik` |
| `SN316 include-removed` | error | `<sn-include>` is removed: a partial is a component |
| `SN401 parse-error` | error | JS syntax error, with the column inside the attribute |
| `SN501 unused-resource` | warning | resource `addressbooks` is declared but never read |
| `SN502 non-reactive-value` | warning | `Date.now()` in a binding never updates. Use `$now` |
| `SN503 data-bound-id` | warning | `id` bound from data can shadow globals other scripts read (DOM clobbering) |
| `SN504 untyped-resource` | warning | resource `contacts` has no type: expressions using it are not checked — `sinter check` only |
| `SN505 unknown-query-param` | warning | `GET /articles` declares no query parameter `tagg`. Did you mean `tag`? |
| `SN506 untyped-event` | warning | event `contact_updated` has no type: expressions reading its payload are not checked — `sinter check` only |
| `SN507 complex-expression` | warning | `data-sn-on-click` is too complex for markup: 5 statements in one handler (limit `statements`: 4). Move the logic into a helper (pure, `x = fn(…)`) or an action |
| `SN509 run-cycle` | warning | `run()` cycle: `#save` `data-sn-catch` (index.html:12) runs `#save`, which starts the first step again — opt-in (`checkCycles`) |


### Complexity (`SN507`)
Expressions that are too complex for markup are warning `SN507`, with the limit they exceed in the message. The measure is structure, never length in characters (added 2026-11-08):

| Limit | Default | Counts |
| --- | --- | --- |
| `statements` | 4 | `;`-separated statements in one handler |
| `sequences` | 0 | comma sequences `(a, b)` |
| `guarded` | 1 | steps one `&&`, `\|\|`, `??` or `?:` used as a statement runs: `a && close()` is 1, `a && (b = 1, close())` and `a && (b ? c() : d())` are 2 |
| `ternaries` | 2 | nesting of `?:`: `n === 0 ? 'none' : n === 1 ? 'one' : 'many'` is 2 |
| `arrow` | 8 | operations in one arrow function's body (`p => p.name.toLowerCase().includes(q)` has 3); a block body `{ … }` is always too many |
| `operations` | 15 | operations in one expression (each statement of a handler), the backstop |

Operations are calls, `new`, operators, assignments, updates, computed member access and functions; names, member paths (`a.b.c`), literals, and object and array literal structure are free, so a draft literal of plain fields costs nothing. Object attributes (`data-sn-state`, `-let`, `-attr`, `-class`, `-style`, `-prop`) are measured per property value, and the warning names the property. The defaults leave filters (`people.filter(p => p.name.includes(q))`), single assignments of a helper's result, a guard over one call (`open && close()`), short object literals and one nested ternary alone; they were checked against the recipes, the RealWorld example and the e2e pages, which pass.
- Options of the Vite plugin, read by `sinter check` and `sinter lsp` too: `sinter({ complexity: { statements: 6, ternaries: 1, level: 'warn' } })`. `level` is `warn` (default), `error` (fails the build like any error) or `off`. Each limit can be set alone; an unknown name or level is refused when the config loads.
- What to do instead: see What belongs in markup.

### Type checking
`sinter check` type-checks every expression of the pages with the project's own TypeScript; it is opt-in and never runs in the dev server.
- A resource names the type of what `items` selects with `type`, a TypeScript type over the names the types module (`src/sinter.types.ts`, `.d.ts` or `.js`) exports: `<sn-resource name="contacts" … type="Contact[]">`. `type="any"` leaves a resource unchecked on purpose; a resource without `type` is warning `SN504`, unless `call` types it.
- State is typed by its literal. A value the literal cannot show takes a JSDoc cast: `{ editing: /** @type {Contact|null} */ (null) }`.
- Helpers and namespace members are typed by their own modules; `$event` and `$el` by the DOM types of the event and element; `$meta`, `$error` and the store functions by sinter.
- The check generates one JavaScript file per page under `.sinter/check/`, with every expression verbatim inside blocks that declare its scope, and runs `tsc` on them with `checkJs`. Errors map back to the HTML position (`SN208`).
- Null checks and implicit `any` are off: a binding that reads `null` renders nothing at runtime, and expressions in separate attributes cannot narrow each other.
- `sinter check` reads the pages and options from the Vite config, or takes pages as arguments. `sinter({ typecheck: true })` runs it at the end of `vite build` and fails the build on errors.
- OpenAPI: `sinter({ openapi: 'openapi.yml' })` (or a list, one per API; local JSON or YAML files, so builds stay deterministic). A resource without `type` is matched to a GET operation: the `servers` URL prefix is stripped from `src`, the query string dropped, literal segments match literally, a segment that is one interpolation matches a `{param}`, and a literal path beats a templated one. Its type is the first 2xx JSON response's schema at `items`, converted to TypeScript by sinter (named schemas become named types). The match runs in every build, not only in the check: an `items` or `total` the schema lacks is `SN308`, a literal query parameter the operation does not declare is warning `SN505`. No match leaves the resource untyped (`SN504`, naming the closest path).
- Actions are matched like resources, with their own method: `data-sn-body` must fit the JSON request schema, and `$result` in `then` has the response's type (`any` without a match).
- `$result` in `<sn-resource then>` has the resource's type: its `type`, the matched OpenAPI response at `items`, or for `call` the action's awaited result at `items` (`any` for an untyped resource).
- Server events: `type` on `<sn-event>` types the payload, using the types module's names. `item` must be assignable to the resource's item and `set` to a part of it, so a payload that does not fit the resource is an error. `then` is checked with the payload and the state around the `<sn-sync>` in scope. `cursor` reads the resource's own item. An event with payload expressions and no `type` is warning `SN506`; `type="any"` opts out.
- `checkPage(html, { files, types, openapi })` from `@tiaforge-ui/sinter/check` runs the same check on one page in a temporary project, for tests.

### Dev runtime
The dev build adds checks that need real data: duplicate keys in a response, an item missing a key field, an `items` path that is not an array, a server event payload missing key fields. Warnings name the resource, the page and the offending value.

### LLM support
- `llms.txt` in the package: the full attribute reference, the scope rules and eight copy-paste recipes (list with filter, form dialog, field errors, SSE sync, optimistic toggle, pagination in the URL, typed resources, local actions); the other recipes are listed with links. Agents read all of it, so it stays short (about 55 KB): recipe tests stay beside the recipes in `docs/recipes/`, and build internals stay in the guides.
- A generated VS Code custom-data file (`html-custom-data.json`) so editors and agents get attribute completion; the VS Code extension ships it.
- Every diagnostic links to its section in `docs/diagnostics.md`, which is generated from the compiler's table of codes (example, meaning, fix).

### Editor integration
- `sinter lsp` is a language server over stdio. It compiles open buffers on every change and publishes the compiler's diagnostics; a component is compiled through the pages that use it (one no page uses, through a use of its own), and a page's diagnostics in its components are reported on the component.
- Pages are the HTML entries of the Vite config, plus any open HTML file no page includes. A change to the Vite config, the helpers or types module, or an OpenAPI spec reloads the project.
- Diagnostics underline the whole attribute or tag when they are about it (`span` on `Diagnostic`), else the name at their position.
- Type errors (`SN208`) as you type: with TypeScript 7, `sinter lsp` keeps each page's shadow file open in TypeScript's own language server (`tsc --lsp --stdio`, one per project, shadows under `.sinter/lsp/`) and pulls its errors 300 ms after the last change, mapped to the HTML with TypeScript's range. Before TypeScript 7 (no `--lsp`), it runs the `sinter check` pipeline on save.
- Hover on a name in an expression shows its TypeScript type (TypeScript 7 only).
- Completion inside expressions comes from TypeScript, minus the shadow's own names and auto-imports. An expression the compiler rejects (it may not even parse, like `article.`) stays in the check unit marked broken: it is written after all other expressions, completes like any other, and TypeScript's errors in it are dropped, since the compiler has reported it.
- Go to definition: a resource goes to its `name` attribute, a state field to its key in `data-sn-state`, a loop variable or index to `data-sn-for`, a type generated from OpenAPI to its schema (or property) in the spec file, a component's tag to its file; helpers and types-module names go where TypeScript says.
- Quick fix: a diagnostic whose message ends in a suggestion ("Did you mean `count`?", TypeScript's "Did you mean 'title'?") offers to replace the misspelled name with it.
- Extract to helper (`refactor.extract`; added 2026-11-08): an expression, or the smallest whole expression around a selection in it, moves into a new exported function of the helpers module (created if missing: `.ts` when the types or actions module is TypeScript or there is a `tsconfig.json`), and the attribute calls it. The parameters are its free names that the page resolves (loop variables, state, lets, resources, payload fields, magic names, names of arrow functions around the selection; `$meta.<resource>` as a whole), not helpers, namespaces, store functions or globals; with TypeScript 7 they are typed from TypeScript's view of the page, else `unknown`. The name is unique among everything an expression or the module could mean by it. In a handler only pure parts are extracted: an assignment keeps its target (`q = nextQ(c)`); several assignments get one helper each, or, for properties of one state object none of whose values reads an earlier write, one helper returning an object merged with `Object.assign(obj, …)`, since handlers have neither destructuring nor locals. On `data-sn-call` and `<sn-resource call>`, Extract to action moves the call into a new action that forwards the context. Each extraction is compiled before it is offered and dropped if it adds an error. Handler semantics are unchanged; dependency tracking becomes coarser (whole parameters instead of the paths read). `SN507` (complex expression) offers the same extraction as a quick fix.
- VS Code: the extension in `editors/vscode` starts the `sinter lsp` of the nearest `node_modules/@tiaforge-ui/sinter` above each HTML file (one server per installation, so nested projects keep their own) and contributes `html-custom-data.json`. Other editors run `npx sinter lsp --stdio`; `docs/editors.md` has the setup.

### Stability
- Attribute names, function names and diagnostic codes are part of the public API.
- Before 1.0, renames are allowed but listed in the changelog. After 1.0, a deprecated name keeps working with a warning for at least one minor version.
- IR versions are independent of package versions; the runtime reads every IR version of its major.

## Testing
Apps rely on sinter as a building block, so v0.1 ships a testing module that is public, stable API under the same rules as the runtime, and sinter itself is tested through it.

### `@tiaforge-ui/sinter/testing`
```js
import { test, expect } from 'vitest';
import { render, mockRequests, mockStream } from '@tiaforge-ui/sinter/testing';
import page from './contacts.html?raw';

test('delete is optimistic and rolls back on failure', async () => {
  const requests = mockRequests({
    'GET /api/contacts': { addressbooks: [], contacts: [{ account_id: 'a', uid: '1', addressbook_href: '/ab', fn_name: 'Ada', org: '', emails: [], phones: [], addresses: [] }] },
    'DELETE /api/contact': { status: 500 },
  });
  const stream = mockStream();
  const { root, flush, settle } = await render(page, { requests, streams: { '/api/events/stream': stream } });

  root.querySelector('li button:last-of-type').click();
  await flush();                                   // optimistic layer applied
  expect(root.querySelectorAll('li')).toHaveLength(0);

  await settle();                                  // request failed, layer dropped
  expect(root.querySelectorAll('li')).toHaveLength(1);
  expect(requests.calls.at(-1).body).toEqual({ account_id: 'a', uid: '1', addressbook_href: '/ab' });
});
```

| API | Purpose |
| --- | --- |
| `render(html, options)` | compiles in memory with the real compiler, mounts into the test DOM, returns `{ root, app, flush, settle, advance, navigations }`. A full document keeps its `<html>` attributes (`lang`, `data-sn-state`, `data-sn-persist`, bindings), as in the browser; each render replaces the previous page's |
| `flush()` | runs the scheduler until no binding is dirty; deterministic, no timeouts |
| `settle()` | `flush()` until every request, queue and debounce has finished |
| `advance(ms)` | moves sinter's clock: debounce, backoff, `$now` |
| `navigations` | URLs sinter tried to navigate to (login redirect), instead of navigating the test DOM |
| `mockRequests(routes)` | request middleware: `'METHOD /path'` → JSON, `{status, body}` or `(req) => response`; records `calls`; an unmatched request fails the test and lists the registered routes |
| `mockStream()` | stream transport: `emit(name, payload)`, `drop()`, `connected` |

`render` also returns `url()`, `history()` (the page's history entries; a `$url` write a user's event caused pushes one) and `back()`/`forward()` (move through them and dispatch `popstate`; a push drops the entries after the current one; a navigation adds none, so they never cross one). The events a test dispatches count as the user's (`Env.trusted`); the custom events sinter dispatches do not.

`render` options: `requests` (a `mockRequests` middleware), `streams` (stream URL → `mockStream()`; a URL with no mock uses `configure({ transport })`, so a custom transport is tested over a fake connection), `url` (for `$url`), `locale`, `now` and `helpers`. Diagnostics from compiling fail the test with the same messages as the build.
The module has no test-runner imports. It works with Vitest, or anything else, on jsdom or happy-dom.

### Seams this requires in the runtime
- An injectable clock and scheduler, so `advance()` and `flush()` are exact.
- Navigation through one internal function, so redirects can be recorded.
- Request middleware and the transport interface, which already exist.

### How sinter tests itself

| Layer | Method | Guards |
| --- | --- | --- |
| Compiler | golden files: input HTML → expected HTML, module and diagnostics; every diagnostic code has a failing fixture | rewrite, scope checks, error wording |
| IR contract | every golden output validated against the IR schema | compiler and runtime drifting apart |
| Runtime units | store, layers, scheduler, reconciler in isolation | core logic |
| Property-based | random list changes against a reference model (DOM order, node reuse); random interleavings of optimistic actions, failures and server events against a reference store | the concurrency-heavy parts |
| Behaviour | every documented feature, written with the testing module | the public API, and the testing module itself |
| Real browsers | Playwright on Chromium, Firefox and WebKit | `<dialog>`, `commandfor`, back/forward cache, `EventSource`, focus preservation |
| Budgets | size per module and a list-update benchmark in CI | the 11 KB core budget, performance regressions |

Rules: every bug fix adds a failing test first, and every code example in the docs and in `llms.txt` is executed as a test.

### Encouraging app tests
- Every recipe in the docs and in `llms.txt` has its test in `docs/recipes/`, executed by the suite.
- `llms.txt` has a testing section, so coding agents write a test next to the markup by default.
- Failures are readable: an unmatched request prints the request and the routes; a failed render prints the build diagnostics.

## Worked example: contacts page
A contacts page that exercises resources, SSE sync, filtering, a form dialog with repeatable fields, optimistic delete and the 401 path.
Endpoints used: `GET /api/contacts` → `{addressbooks, contacts}`, `POST /api/contact` (create or update, returns the contact), `DELETE /api/contact` (JSON body), and the `contact_updated`, `contact_removed`, `contacts_refetch` events on `/api/events/stream`.
```html
<sn-resource name="contacts" src="/api/contacts" items="contacts"
             key="account_id,uid,addressbook_href" order="fn_name"></sn-resource>
<sn-resource name="addressbooks" src="/api/contacts" items="addressbooks"
             key="account_id,href"></sn-resource>

<sn-sync src="/api/events/stream">
  <sn-event name="contact_updated"  resource="contacts" op="upsert" item="contact" fallback="refetch"></sn-event>
  <sn-event name="contact_removed"  resource="contacts" op="remove"></sn-event>
  <sn-event name="contacts_refetch" resource="contacts" op="refetch"></sn-event>
</sn-sync>

<section data-sn-state="{ q: '', draft: null }">
  <header>
    <input type="search" placeholder="Search" data-sn-model="q" data-sn-persist="contacts.q">
    <button data-sn-on-click="draft = {account_id: addressbooks[0].account_id, addressbook_href: addressbooks[0].href, fn_name: '', org: '', emails: [{value: '', type_label: 'home'}], phones: [], addresses: []}" commandfor="edit" command="show-modal">New contact</button>
    <!-- dialog#edit, see below -->
  </header>

  <p data-sn-show="$meta.contacts.loading && !contacts.length" aria-busy="true">Loading…</p>

  <ul class="contact-grid">
    <template data-sn-for="c in contacts.filter(c => !q || (c.fn_name + ' ' + c.org).toLowerCase().includes(q.toLowerCase()))"
              data-sn-key="c.uid">
      <li>
        <strong data-sn-text="c.fn_name"></strong>
        <small data-sn-text="c.org" data-sn-show="c.org"></small>
        <a data-sn-show="c.emails.length" data-sn-attr="{href: 'mailto:' + c.emails[0]?.value}" data-sn-text="c.emails[0]?.value"></a>
        <button data-sn-on-click="draft = structuredClone(c)" commandfor="edit" command="show-modal">Edit</button>
        <button data-sn-delete="/api/contact"
                data-sn-body="{account_id: c.account_id, uid: c.uid, addressbook_href: c.addressbook_href}"
                data-sn-optimistic="remove(c)">Delete</button>
      </li>
    </template>
  </ul>
</section>
```
The edit dialog binds the form to `draft` and sends it as the body, which keeps repeatable rows simple:
```html
<dialog id="edit">
  <form data-sn-post="/api/contact" data-sn-body="draft"
        data-sn-then="upsert('contacts', $result); draft = null; close()"
        data-sn-catch="emit('toast', $error.message)">
    <input data-sn-model="draft.fn_name" required>
    <input data-sn-model="draft.org">

    <template data-sn-for="(e, i) in draft.emails">
      <div role="group">
        <input type="email" data-sn-model="draft.emails[i].value">
        <button type="button" data-sn-on-click="draft.emails.splice(i, 1)">×</button>
      </div>
    </template>
    <button type="button" data-sn-on-click="draft.emails.push({value: '', type_label: 'home'})">Add email</button>

    <button type="submit">Save</button>
  </form>
</dialog>
```

### Notes on this example
- `draft.emails.splice(i, 1)` works as written: path invalidation marks `draft.emails`, and rows keep their nodes because state lists key by object identity.
- `structuredClone(c)` turns the frozen resource item into editable state.
- Markup used on several pages goes in a component: `src/components/contact-card.html`, used as `<contact-card data-sn-prop="{ contact: c }">`.

## Open questions
- State reactivity depth. Decided: compile-time path invalidation, default identity keys, `update()` for islands, dev-mode detector, resources read-only (`SN205`), copies via `structuredClone`. See Expressions and scope.
- $meta naming. Decided: `$meta.<name>.<field>` with a fixed field set. See Resources and store.
- Mutation concurrency. Decided: `block` for forms, `queue` otherwise, `latest` on request via `data-sn-concurrency`; running mutations are never aborted. See Actions.
- Safe globals. Decided: "JavaScript yes, browser no", `new` allowed, `$now` for time, warning `SN502`. See Expressions and scope.
- Session probe trigger. Decided: the probe gates every reconnect; 401 goes to login, network errors back off. See Sync.
- i18n source. Decided (2026-11-08, replacing "no built-in `t()`"): built-in messages (`m.key()`) from the inlang message files, one file per page and language loaded before the first paint. Reasons: sinter cannot rely on a server to pick the language or inline the text, so the browser must; a per-page, per-language file loaded in the early step is a one-time cost per page and deploy (cached by its hash) and gives the fastest correct first render; paraglide's runtime was most of the early chunk; the consumer (Caley) used only plain strings with `{param}`s; keeping the inlang file format keeps its tooling. Plurals and variants are deferred. Apps without messages pay nothing. See Messages.
- Keyset jumps. Decided: keyset never jumps (`SN304`); jumps need offset mode; server requirements for keyset written down. See Pagination.
- Testing utilities. Decided: `@tiaforge-ui/sinter/testing` ships in v0.1 as stable API; sinter tests itself through it. See Testing.
- Path parameters. Decided (2026-11-04): `<html data-sn-path="/article/:slug">` declares the URL shapes a page is served for; the runtime matches `location.pathname` once and exposes `:name` segments read-only in `$url`. No client-side routing: the server still picks the page, links stay full page loads; dev and production rewrites are the deployment's job for now.
- Optional query parameters. Decided (2026-11-04): a query parameter whose interpolated value is `null`/`undefined` is omitted from the URL, so one resource covers lists whose filters come and go.
- Templates shared across pages. Decided (2026-11-10): components, expanded at build time, with props, slots and events; `<sn-include>` is removed. See Components and `docs/proposals/components.md`.
- Handlers at several levels. Decided (2026-11-08): nearest wins unless the element did not handle the event; a plain key handler handles a key only when it prevents it. See Events, Which handlers run.
- Running an action from a handler. Decided (2026-11-08): `run('id')` starts the action of the element with that literal id (`SN311`), keeping its lifecycle; `$event` is null (forms are submitted), disabled and inert targets do nothing, no return value, no `app.run()` for islands, cycle check `SN509` opt-in. See Running an action from a handler.

## Sources
Advisories and guidance the Security section was checked against:
- CVE-2026-27121: Svelte XSS via spread attributes in SSR
- CVE-2025-27152: axios SSRF and credential leakage via absolute URLs
- CVE-2023-45857: axios XSRF token sent to every host
- CVE-2026-71502: stored XSS via Vue template delimiters
- PortSwigger: client-side template injection
- htmx 4 security best practices
- Datastar security reference
- DOM clobbering gadget collection
- Shai-Hulud self-replicating npm worm

### Page URLs (added 2026-11-11)

Every page without `data-sn-path` (not `index.html`, `404.html` or `200.html`) is written as a directory's index: `about.html` as `about/index.html`, served at `/about/` (`movesToDirectory`, `pageFile`, `pageUrl` in `src/prefetch-build.ts`). A page with `data-sn-path` answers at exactly the paths it lists (absolute, with `base`; with or without parameters; a pattern also with a trailing slash) and stays in its file; its URL for links is its first fixed path, if any. A `data-sn-path` that is only the page's directory URL is `SN515` (a warning; the compile option `base` gives the plugin's `base`) and the page moves as without it. `pageRoutes` (`src/page-urls.ts`) gives the site's rules: a 301 from each moved page's file URL to its URL, and a 200 from each declared path to its file, except the path a host serves the file at anyway (`/login` for `login.html`, a folder for `index.html`), whose target is that path (`/article`); fixed rules first. The plugin writes them to `_redirects` (`redirects: false` turns it off; none with a relative base), after `public/_redirects`, warns above Cloudflare Pages' 2,000 fixed and 100 dynamic rules, and puts them in `sinter-embed.json` as `routes` with each rewrite's output `file`; sinter-axum answers a 301 route with its query, serves a page with data by its paths, and rewrites a 200 route's path to its file for the inner service. The plugin's last plugin (`sinter:pages`) does it in `generateBundle`, on each page's finished HTML (`relocateHtml` in `src/page-urls.ts`): a link (`<a>`, `<area>` `href`) to a page with a fixed path, by its file, its path without `.html` or its URL, becomes the page's URL (root-relative stays root-relative, relative stays relative, query and fragment kept), and on a page that moves, every other relative URL (`src`, `srcset`, `href`, `action`, `formaction`, `poster`, `<object data>`, CSS `url()` in `style` and `<style>`, the language picker's files) is rebased one folder down. Script text and comments are left alone. The page is emitted at its new file, and a redirect at the old one (`redirectHtml`: a script that keeps the query and fragment, a refresh, a canonical link, `noindex`). Two pages for one file fail the build. A page whose page module names another page's old file in a string (`'/task.html?…'`, a link built at run time) is a build warning. Paths everywhere follow: `pagePaths` gives `/about/` and `/about` (next-page data, Speculation Rules, the embed manifest, whose `file` is the new file); Speculation Rules add a trailing-slash variant of each pattern. `vite dev` serves `/about/` from `about.html` and redirects `/about` and `/about.html` (with the query) to it, rewriting the page's HTML as the build does, serves a declared path from its page, and redirects `/login/` to `/login` for a page that stays in `login.html`; without a build input it knows every `.html` file under the root (not in `node_modules`, the output, `public/`, `src/components`, `src/layouts` or a hidden folder). `vite preview` follows the built `_redirects` (redirects with the query, relative 200 rewrites), redirects `/about` to `/about/` when the output has `about/index.html`, and `/login/` to `/login` when it has `login.html`.

### Canonical URLs (added 2026-11-11)

`sinter({ site })` is an origin (a path, query or fragment is refused: the path is Vite's `base`). The plugin passes each page `urls`: `site` (`$site`: the origin and an absolute `base`, no trailing slash), `canonical` (the origin and `pageUrl`, or null for a page whose paths all have parameters) and `origin`. In expressions `$site` and `$canonical` compile to string literals (`kind: 'const'` in expr.ts), so they are build-time constants: prerendered, and left out of the page module; on a pattern page `$canonical` compiles to `(origin + location.pathname.replace(/\/+$/, ''))`, which the build-time evaluator cannot run (`location` is shadowed there) and the early script renders. Without `urls`, either name is `SN323`; `sinter check` types both as `string`. After components, the head's own `<link rel="canonical">` is `$canonical` (a relative `href` is `SN323`); without one, the compiler appends `<link rel="canonical" href="…">` to the head, or for a pattern page `<link rel="canonical" data-sn-attr="{ href: $canonical }">` (`Compiler.canonicalLink`, exempt from `SN207`), which the early script renders. That link is not a reason to run (`runtimeReasons` skips it): when it is the page's only binding, `compileParts` compiles the page again without it (`canonicalLink: false`), so a pattern page with nothing else to run has no canonical link and no script. No server fills it.

### Languages in the URL (added 2026-11-11)

`sinter({ localePrefix: true })` needs the built-in messages; `readLocales` (`src/locales-build.ts`) reads `baseLocale` and `locales` from the inlang settings and refuses a missing `baseLocale`, one not among `locales`, or a locale that is not a language tag. Each source page is built once per locale as `<root>/<locale>/<page>`: the build's input is replaced by those paths, `resolveId` and `load` serve them from the source page, and `build()` compiles the source (`file` is the source, so diagnostics, components and layouts are as written) with the compile option `locale: { name, urls, base }` and that language's messages as `baseMessages`, then rebases the output from the source's folder to the language's (`rebaseHtml`). In the compiler: `$locale` and `localeUrl` compile to constants (`localeUrl` from `urls`, or for a page whose paths all have parameters `base + l + location.pathname.slice(…)`); messages of the built-in namespace add no `$locale` dependency, are written in attributes too, and get no `data-sn-m`; built-in helpers add no `$locale` dependency, and the build-time evaluator has `number`, `bytes` and `date` of a calendar date in that locale (the runtime's `number`, `bytes` and `date`, with that locale for the call; any other date throws, so it is formatted in the browser); in the page module and the early script each message the code calls is a function of that language's text (`fixedMessages` in `src/compiler/index.ts`: `m$title = () => "Über uns"`, a `{param}` read from the argument, kept as written when missing), and `fixed(locale)` from the messages module sets the locale (the config's locale source, unless the app set one) and reads the dictionary of the app's modules' messages from `script[data-sn-messages]`; nothing waits for a dictionary; assigning `$locale` is `SN203`; `data-sn-path` patterns get the prefix after `base`; `<html lang>` is the locale; the page module sets the `locale` cookie (`Path=/`, a year, `SameSite=Lax`) before mounting. No page in a language gets the picker or a language file: the plugin writes the messages the page's bundled modules and early file call (`moduleKeys`), in that language, into its head as `<script type="application/json" data-sn-messages>` (in dev, the language's whole dictionary). The pages plugin adds `hreflang` links (with `site`) and links into the page's language (`relocateHtml` with the locales: a page's same-language pages also by their unprefixed paths; `<a hreflang>` is left alone), writes a chooser (`chooserHtml`) at each source page's unprefixed file (its `pageFile`; `404.html` and `200.html` are the base language's page, rebased), and the same chooser at a moved source page's file (`about.html`), so an old URL is one hop from a language. A chooser has a refresh to the base language's URL, `noindex`, `hreflang`, links to each language, and on a site where a page ships JavaScript a script: the `locale` cookie, else `navigator.languages`, else the base; to that language's URL of the page (a page with a fixed path: the URLs are in the script, so it works at any URL), or for a pattern page the same path under that prefix; query and fragment kept. `siteRoutes` adds the choosers' rules to the languages': each a rewrite with `choose`, the old file URL's too (`/about.html  /about/  200`); sinter-axum sends a fixed rule's request to its target under the language (`/about.html` → `/de/about/`), a pattern's to the request's path; the embed manifest has `locales: { base, list, at }` and a `choose` route for each fixed unprefixed URL too, and sinter-axum answers a `choose` route with a 302 (`Vary: Cookie, Accept-Language`) to `at + locale + '/' + rest`. `vite dev` serves a page in a language through `transformIndexHtml` at its URL (redirecting its other forms) and a chooser at an unprefixed URL.

