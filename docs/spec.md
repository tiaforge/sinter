# sinter v0.1 spec
Source: https://claude.ai/artifact/KUVBabhMHDm52FpMuPFvA9 (snapshot 2026-11-04, rev 78)

## Overview
sinter binds JSON APIs to plain HTML: it caches server data in keyed resources, keeps them current from server events, renders them through `<template>` bindings, and runs mutations with optimistic updates. It is compile-first: a build step turns annotated HTML into a page module, so the browser runs no parser and no `eval`.
Package: `@tiaforge-ui/sinter`. Attribute prefix: `data-sn-`. Declaration elements: `<sn-resource>`, `<sn-sync>`, `<sn-event>`. Components: files in `src/components/`, used by their tag, and `<sn-component use>` (see Components).
License: MIT. Contributions are accepted under the Developer Certificate of Origin (`Signed-off-by` in each commit); no CLA.

### Goals
- Replace the server-state plumbing of a multi-page app: loading flags, stale responses, reload on reconnect, list upserts from SSE.
- Valid HTML, readable without knowing the library, and easy for an LLM to write correctly.
- Small runtime: under 11 KB min+gzip for the core (10.1 KB on 2026-11-05), verified per release by `npm run size`.
- CSP-safe under `script-src 'self'` with no `unsafe-eval`.
- Optimistic updates that stay correct when requests overlap or SSE events arrive mid-flight.

### Non-goals
- Routing and a virtual DOM. Components are expanded at build time (see Components), not a runtime component system; transitions are view transitions between pages (`data-sn-transition`).
- HTML responses or `innerHTML` rendering.
- A runtime interpreter: HTML that never passes through the compiler cannot use directives.
- Dialogs and popovers: native `<dialog>`, `popover` and `commandfor` cover them.
- Anything that measures layout: that stays in custom elements.

### Design principles
- One way to do each thing. No aliases, no overlapping features.
- Familiar shapes, same meaning. Borrow from Vue, Alpine and htmx only where the semantics match.
- Everything visible on the element. No implicit inheritance beyond lexical scope.
- Configuration is data. Resources, keys, event mappings and pagination are attributes, never callbacks, so they can be validated and generated later.
- Errors at build time. Anything the compiler can check, it checks.
- Seams for later work. A versioned intermediate format, a DOM-free store and normalized change messages keep a type generator, embedded server data, cross-page caching and a shared SSE worker possible without API changes.

## Architecture
The compiler turns annotated HTML into a page module once; at runtime the store sits in the middle, and every change from the server, an action or a custom element goes through it before the renderer writes the DOM.
Server data enters through the request layer (loads) and the sync adapter (events); the renderer only reads the store, so there is one path to the DOM.

### Packages

| Import | Contents |
| --- | --- |
| `@tiaforge-ui/sinter` | the app's API: `configure()` and the request middleware, `instance()`, `navigate()`, the built-in formatters, the `Resource` type |
| `@tiaforge-ui/sinter/vite` | Vite plugin |
| `@tiaforge-ui/sinter/testing` | `render`, `firstPaint`, `mockRequests`, `mockStream`, `memoryStorage` |
| `@tiaforge-ui/sinter/check` | `check()`, what `sinter check` runs |
| `@tiaforge-ui/sinter/compiler` | `compile()` |
| `@tiaforge-ui/sinter/server` | the server layer's `embed()` |
| `@tiaforge-ui/sinter/ws`, `/retry` | the WebSocket transport and `retry()`, for the config module |
| `@tiaforge-ui/sinter/messages`, `/memo`, `/content` | the messages' runtime (`m`; `/messages/content` has `inlang()`, `/messages/format` its formatter), `memo()`, `collection()` |
| `@tiaforge-ui/sinter/runtime`, `/runtime/<feature>` | what compiled pages import, not the app (since 2026-11-20; the features were top-level subpaths): the core (`mount`, `$k`, …) and one module per feature (`components` also has the `Component` class the generated base of a component's script extends; was also `@tiaforge-ui/sinter/components` until 2026-11-20), `sse`, `optimistic`, `paginate`, `for`, `persist`, `form`, `select`, `location`, `query-links`, `typing`, `call`, `debounce`, `confirm`, `models`, `keys`, `cache`, `back`, `refresh`, `prefetch`, `write-through`, `fields`, `versions`, `navigate`, `swap`, `lazy`, `transition`, `early`, `nested`, `lets`, `options`, `remote`, `dev` |

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
- Anchors (changed 2026-11-15, docs/proposals/component-libraries.md section 1): every place that renders a variable number of nodes, a `data-sn-if` (with its `data-sn-else`), a `data-sn-for`, a recursion point and a `<sn-component use>` (a choice), is marked by a start and an end comment in place, `<!--sn <n>-->` and `<!--/sn-->` (in a row, `<!--sn-->`: it is found by its path), and what it renders goes between them. Two kinds of templates render without nodes of their own (changed 2026-11-16, docs/proposals/flat-anchors.md): a wrapper (`a`: its content is one `if` or choice anchor and nothing else, no state, dialog or `$el`), whose fresh row or branch is its anchor's branch, the anchor bound without comments (an empty comment while that renders nothing, so the row has a first node; the branch ends where the row does), and a text run (`tx`: its content is one `<template data-sn-text>`), whose fresh row or branch is one `Text` its binding writes. What the early script rendered keeps its comments and is adopted as it is; the head template of a wrapper or a text run is in the page only when the early file renders it. Its templates move into `<template id="sn-t-<template id>">`: in the `<head>` when the early file renders them, at the end of the `<body>` otherwise, so they do not hold the body's first byte. The runtime and the early script find a template from the IR (`sn-t-` and the id), never from the comment. Comments are no elements: `:first-child`, `:nth-child`, `+`, `~`, `>` and `:empty` see a list's rows and a branch's elements as plain HTML would. An if's `data-sn-else` is its binding's `z` (no node of its own); a choice is one node (binding kind `ch`) whose function evaluates `use` once and returns `[case, props]` (null for a value outside the candidates), with each case's template in `c`; an anchor's node has the tag `#`. A template inside `<svg>` or `<math>` (foreign content: parse5 gives it no content) gets its content wrapped in that element in its head template (`w` on the template), and a row is made of the wrapper's children. An author's comment whose text is exactly one of those forms (`sn`, `sn <digits>`, `/sn`, or empty: a text separator) is `SN105`, and the runtime and the early script match only those forms (`<!--snippet-->` is the author's); a `<template data-sn-…>` (or `<sn-component>`) inside `<textarea>` or `<title>`, which the parser reads as text, is `SN106`; `$el` in an `if`, `for` or `use` expression is `SN213` (the anchor is a comment).
- Inside a template, bindings are addressed by node path (child indexes from the template root, counted from the final markup: an anchor is its start comment, and adjacent text is one node as the browser parses it), since template content is inert and only cloned.
- `<sn-resource>`, `<sn-sync>` and `<sn-event>` are removed; their definitions move into the IR.
- Embedded data (`<script type="application/json" data-sn-resource="contacts">`) stays in the HTML, since it may be produced at request time.
- One `<script type="module">` is injected that imports the page module.

### Components
A file `src/components/<name>.html` (the name contains a `-`) is the component `<name>`, usable on every page. Every use is expanded at build time, so a component's markup is page markup: it renders in the first frame with everything else, and a component without a script adds nothing to the runtime. The guide is [components.md](components.md).
- The file holds one `<template data-sn-props="{ …props }">` and optionally a `<style>`. `data-sn-emits` on the template declares its events and their detail types. Anything else is `SN312`.
- The root renders at most one element (`rootShape`, after the slots are filled, so a `<slot>` at the top is its fill or its default): one plain element (the root, `useOf`, as before), a `data-sn-if` template with an optional `data-sn-else` template whose contents are roots, a component tag, or `<sn-component use>`. More elements, text, or a `data-sn-for` or `data-sn-text` template are `SN312`, except a caller's text fill of the root `<slot>` (`<template slot data-sn-text>`, shape `text`, changed 2026-11-15: before it was `SN312` when the placement was expanded at build time and allowed in a runtime placement): the root is one text node with no landing, and the tag's attributes other than `data-sn-with` and `data-sn-early`, and an outer tag's passing on to it, are `SN334`. A component's tag that is a fill of a slot that passes data compiles its props and attributes in the fill's scope (`fillOf` of its host; `markupOf` and the root's fill lookup), so they read `$slot`. A root that is not one plain element (`Use.shape`) is folded first by the use's constant props (`foldIn` on the template's content; decided to nothing, the tag is removed); its top nodes take the tag's place, with the whitespace between them dropped, and mark where the component's markup starts (`scopeStart`: the walk computes the component scope there, once per use, `markupOf`, in the caller's scope of the tag, or for a tag that was slot content its writer's). Its landing elements (`landingOf`: each branch's element, a fill's) take the tag's plain attributes (`class` joined, another one on both `SN209`, at the tag naming the fill for a fill) and its sinter attributes (`landing`: compiled on them in the caller's scope). A component tag as root gets the plain attributes, and the outer uses pass on to it (`passOn`), outer first: its own landing elements take their attributes too, and its scope starts after theirs. A component with a script, or `data-sn-state` on a landing element of its own, needs a plain root (`SN312`). A root that may render nothing (`mayBeEmpty`: a chain without an else, a choice, through component tags) makes `id`, `data-sn-model`, actions and `data-sn-transition` on the tag `SN334`. A chain decided in the second pass (`foldDecided`) and an unrolled row (`cloneTree`) keep `scopeStart`, `landing` and `passOn`.
- Scoped styles of roots: each branch of a chain root carries `data-sn-c`; a fill keeps the caller's `data-sn-s`. An element that is also the root of outer components through their tags carries `data-sn-r="<names>"`, and each such component's style gets `rootCss`: its selectors whose subject is the root (one compound, or `:scope`), as `:where([data-sn-r~="<name>"]):is(<compound>)` outside `@scope` (inside `@media`, `@supports`, `@container` and `@layer` as written).
- Text without an element: `<template data-sn-text>` (`textNode`) is replaced, outside templates, by an anchor pair around an empty comment (`<!--sn N--><!----><!--/sn-->`, a root node with tag `#`), and in a template by an empty comment after the element before it (its node's path and tag are that element's) or, when there is none, after another empty comment (the node). Its binding is `text` with `n: "+"`: the runtime's writer `x` (and the early file's `slot`) writes the node after the marker, replacing the empty comment with a `Text` once there is text, keeping the `Text` (empty) after. The early file's `slot` records the texts it writes, and `for`, `iff` and `ch` put them in the node lists they leave for the page module in place of the placeholders they replaced (or after the node that is the placeholder), so adoption reads the nodes in the page; what the page module does not adopt is cleared between the anchor's comments (`cut`), nested anchors' rows and texts with it (changed 2026-11-15: it removed the listed nodes, leaving texts and nested contents). A literal folds into the HTML as text at the walk; outside templates, `prerender()` also folds one over build-time constants (`textRoots`, by the rules of element text bindings), replacing the anchor pair with the text, and `dropConstants` drops the node (`textFolded`). A text that stays a binding keeps its anchor pair or its empty-comment slot, so no folded text merges with it. In the dry run of constant rows a text node is seen through its marker (`textMarks`) and is never painted into a template. Another attribute on the template, content in it (`SN333`) and `$el` (`SN213`) are errors. `SN105` ignores the compiler's own comments (no source location). A literal folds into the HTML as text at the walk; outside templates, `prerender()` also folds one over build-time constants (`textRoots`, by the rules of element text bindings), replacing the anchor pair with the text, and `dropConstants` drops the node (`textFolded`). A text that stays a binding keeps its anchor pair or its empty-comment slot, so no folded text merges with it. In the dry run of constant rows a text node is seen through its marker (`textMarks`) and is never painted into a template. Another attribute on the template, content in it (`SN333`) and `$el` (`SN213`) are errors. `SN105` ignores the compiler's own comments (no source location).
- Each use is replaced by the root. The tag's `class` is joined with the root's; another plain attribute moves onto it (the same attribute on both is `SN209`); the tag's `data-sn-on-*`, actions, `data-sn-class`, `-attr`, `-style`, `-show` and `-transition` are compiled onto the root in the caller's scope. Other `data-sn-*` attributes on a tag are `SN102`.
- Props: `data-sn-with` on the tag. Each prop is the caller's expression, inlined where the component reads it (as a `data-sn-let` name, evaluated at every read like one), so it is live and read-only. A key the props type does not declare, or a required prop left out, is `SN313`. A prop not given is `undefined`, unless the root's `data-sn-state` has a field of that name, its default.
- Scope: the component's markup sees its props, its own state, the page's resources, helpers and magic names; a caller's name is `SN201` with the prop to add. Its loops get their own runtime names, so a prop read in a row never resolves to a row of the component.
- Slots: the tag's children fill the component's `<slot>` elements at build time: `slot="meta"` the `<slot name="meta">`, the rest the default `<slot>`; a slot left empty keeps its fallback content. Slot content keeps the caller's scope. Content no slot takes is `SN314`. The `<template data-sn-else>` right after a `<template slot="<name>" data-sn-if>` is part of that slot's content. `SN312` counts placements that can render together (`placements`: each `<slot>` with the `data-sn-if`/`data-sn-else` branches it is in; two are exclusive when one chain has them in different branches): one plain slot in each branch of one chain is allowed, and its content is copied into each (`cloneTree`), a `<slot>` in another slot's fallback is filled first.
- Slots that pass data: a member `name: Slot<T>` of the props type literal (`typeMembers` reads `slot: T`) is a slot that passes `T`, not a prop: it leaves `Use.props` and `propsText` (`withoutSlots`), so `data-sn-with` passing it is `SN313`, the required-prop check and the props frame skip it, and `componentTypes` leaves it out of `this.props`. `Slot<T>` with `?`, inside another member's type, in a props type the compiler cannot list, in a head component's or a layout's `data-sn-props`, and a types module that exports `Slot` (`project()`, when the app has components) are `SN331`; `src/sinter.components.d.ts` and `sinter.d.ts` declare the global `interface Slot<T>`. A placement is `<slot name data-sn-with>` (`data-sn-with` on a slot not declared `Slot<T>`, or a `Slot<T>` slot without it: `SN331`); it may be placed more than once, each placement taking its own copy of the fill (marked repeated). Its default is nothing, text, or a root (`rootShape`); anything else is `SN331`. The children a fill's `<slot>` places are those of the element each leaf branch renders; a default that renders a component gives none (`SN331` for a `<slot>` in its fill). A fill is the elements with `slot="<name>"`; a `<template slot>` only with `data-sn-if` or `data-sn-text` (else `SN331`). The fill's top-level nodes get a `FillChain` (the placements from the outermost forwarding slot to the one where it renders). At the walk, the first node of a fill compiles each placement's `data-sn-with` (`placementData`: the innermost in the component's scope at the placement, each outer one with the inner `$slot`), once per chain (`fillScopes`), into a `SlotScope` (`Scope.slot`): each key a let entry with its code, dependencies and sources (`$slot.<key>`), and the whole object; keys `T` (a type literal) does not have, and required keys missing, are `SN313`. The fill's scope is its writer's (`slotOf(node).caller`) with `slot` set: `$slot.<key>` is inlined as a let is, so `merge($slot.row, …)` keeps the row's sources, and an inner fill's `$slot` replaces the outer one. `$slot` outside a fill, `$slot.<key>` the placement does not pass (`SN201`) and an assignment to it (`SN203`) are errors. An unfilled placement's default compiles its `data-sn-with` too (`defaultOf`; an empty default, when the walk reaches the node it was in, `emptyDefaults`). With `check`, the placement's `data-sn-with` returns `T`, and the fill's expressions have a `slot` frame (`const $slot`, typed `T`, with a JSDoc line naming the placement for hovers).
- A `<slot>` inside a fill: an unnamed `<slot>` in a fill of a slot that passes data (and not inside a nearer fill of an inner tag) is not the enclosing component's (`placements` skips it); `place` replaces it with the children of the element the default renders (moved for the first, copied for others), or for a chain default with the chain's templates holding each branch element's children. Those nodes (`childrenOf`) are walked in the component's scope at the placement, and are scope roots of the component's styles (`data-sn-s="<name>"`, as slot content a component passes on). Two such `<slot>`s in one fill that can render together are `SN312`; one whose placement's default renders no element, and a default element whose `data-sn-let` or `data-sn-state` names its children read (as identifiers, not object keys or property names), are `SN331`. A forwarding placement (a `<slot slot="<name>">` child of a component's tag whose `<name>` passes data) leaves them to the inner placement, which gives its children. A fill of a slot that passes nothing is given nothing.
- Tree slots: a named `<slot>` with `data-sn-with` whose name its own component does not declare is a tree placement (`treePlacement`; a name `didYouMean` finds among the declared ones is `SN535`, warning). `expandComponents` records each tag's enclosing use (`enclosing`; for a tag in slot content, the enclosing use of the tag that content was given to), so the root is the nearest enclosing use whose `slots` has the name. Its fill is looked up from that root outward while the use is not slot content and the next one out declares the name too (a root in its own markup passes the outer fill through, its own fill wins; one in a caller's fill starts again). Expanded inline, the placement is filled at build time like a plain slot (`place`); inside a shared definition (`inDef`) it is a runtime placement (`runtimeSlots`): `runtimePlacement` compiles its `data-sn-with` and a default case template `$sl<tid>`, and turns it into a choice anchor (`ch`). Each declared data slot's fill is kept, expanded in the caller's enclosing use, as a fill definition (`fillDefs`, `Use.treeFills`, numbered by source location and early mode); `finishTreeFills`, after the main walk, gives each runtime placement a case template per fill that can reach it (`fileGraph`/`reach`: the fill's root uses, through component files, the placement's component), walked in the fill use's caller scope (`caseScopes`) with `$slot` the placement's values and an unnamed `<slot>` the default element's children, and `f` returns the case named by the fill map at `$.<point>.$f[<name>]`. The fill map travels as `$f` in a recursion point's props item when the definition reaches a tree placement (`reachesTree`); a component's scope gets `fills` (`expr` from the point, `own` its tags' fills), inherited by the components it uses but not by slot content. A placement no root encloses is `SN331` at the outermost tag; a declared slot no component inside places is `SN331` (`slotsPlaced`); `<sn-component use>` with a helper in a use that declares slots or reaches a tree placement is `SN312`. Runtime: `templateDeps` visits each template once per call and memoises only a whole result, so components used inside one another get every dependency of their fills.
- After expansion (`strayAndRepeated`, before decided branches and unrolled loops), a `<slot>` left in the page (on a page, in a page's slot content; not inside a `<template>` without `data-sn-*` attributes, such as declarative shadow DOM) is `SN331`, and a literal `id` in a `data-sn-for` template's content or in a fill copied to more than one placement is `SN532` (after `componentIds`, which reports `SN209` for its own elements).
- Events: `emit()` in a component must name an event `data-sn-emits` declares (`SN315`), and so must a `data-sn-on-<event>` on the tag that is not a DOM event. `$event.detail` is typed by the declaration.
- `data-sn-model` on a tag binds the component's `value` prop and writes the detail of its `change` event back (a `CustomEvent` only, not a native `change` bubbling from inside); the component must declare both (`SN313`).
- Recursion: a component that uses itself (directly or through others) with a `data-sn-for` or `data-sn-if` template between is compiled once as a shared definition: a head template like any other (`<template id="sn-t-<tid>">`, with `data-sn-name="<name>"` in dev builds), whose content is the component's markup compiled as a row template whose item (`$p<tid>`) is the props object (the definition's props read `$.$p<tid>.<prop>`). Each inner use is an anchor whose `data-sn-for` over `[{ …props }]`, with the constant key `() => 0`, instantiates that template directly, so trees render at any depth, early too. (Until 2026-11-15 each use was an empty `<template data-sn-def>` the `defs` feature filled with a copy of the definition; both are gone.) The definition's props must be a type literal (`SN312`) and inner uses take no slot content (`SN314`). An inner use's plain attributes, `data-sn-class`, `-attr`, `-style`, `-show` and handlers (and, for `<sn-component use>` as a component's root, the outer tags' attributes) are compiled at the use in its scope into the item's `$a` (`pointAttrs`: values by key, `c:<class>`, `a:<attr>`, `s:<prop>`, `h:`, and handlers as `o:<event>` functions over the use's scope, given `$el`, `$event` and `$f` at the event); the definition's root elements (`defRoots`, given a node even without bindings) get one binding per key its uses pass, reading `$.$p<tid>.$a` (`defRootBindings`, after the walk), and the anchor's dependencies include the values'. Other sinter attributes there are `SN102`. The item sources of the definition's props are the sources given at every use (`@def:<name>:<prop>`). A component that uses itself with no `data-sn-for` or `data-sn-if` template between is `SN306`.
- `<sn-component use="…" data-sn-with="…">`: a component chosen by data (the one new element). Candidates: for a template string with one expression (``use="`${b.type}-block`"``), the app's components with that prefix and suffix (`componentNames` in `CompileOptions`, from `src/components/`, or the components the page already read); for a map in the markup (`use="{ hero: 'hero-block' }[b.type]"`), its values, each of which must be a component (`SN312`); for a call (`use="blockComponent(b)"`), every component. `use` built with `+` is `SN312` (TypeScript types it `string`). The use is one choice anchor (since 2026-11-15; before, one anchor and one evaluation of `use` per candidate): its function evaluates `use` once and returns `[i, props]` for the candidate it names, each candidate's props as that candidate's shared definition takes them, and the anchor instantiates candidate `i`'s definition with the props as its row's item; the same case again updates that row's props, another replaces the row. A `data-sn-else` template right after becomes a `data-sn-if` anchor for a value outside the candidates. Without one, dev builds warn (`console.warn`, once per value and place) when `use` names no candidate; production builds carry no code for it. `sinter check`: the template string and the call must fit the union of the app's components (the generated `ComponentName`); for a map, the key must fit its keys, unless a `data-sn-else` template follows (any key renders it then); the props are checked per candidate, guarded by `key === '<value>'` for the template string and the map, so TypeScript narrows the item, and the `data-sn-else` template under the negation of every candidate's guard.
- Nested items: a row of a nested list of an item with a source (`r in comment.replies`) has the source `<resource>><field>` (`comments>replies`; several fields join: `comments>replies,children`), meaning an item found under the resource's rows through those lists at any depth. `merge()` and `remove()` with such a source (the `nested` feature) find the item by identity, else by the resource's key, replace the objects along its path and patch the top-level row (or the single resource). `upsert(c.replies, x)` compiles to `upsert(<c's sources>, c, "replies", x)`: `c` is patched with its list, `x` added (or replacing the item with its key). Write-through follows the same paths: a read of a nested row (or of a prop that is one, `$p3.comment` in a shared definition, its sources resolved after the walk) gives a target `{ r, v, n: [fields] }` (with its schema: the list's item schema under the row's); its response patches the item at its depth (rule 1 and 3), and a DELETE of the list's URL plus one segment removes it (rule 4). Such targets are in `ap.nt` (`nu`: the one the body describes), apart from `tg`, and the `nested` module applies them after the write-through module, so a page without nested lists loads none of it. A tag written directly in a table, which the HTML parser moves out, is `SN102`: write it in the row's template.
- A literal `id` in the markup of a component used more than once on a page is `SN209`.
- Styles: the file's `<style>` is scoped and imported by the page module (`componentCss(name)` names the module; the Vite plugin serves it), so the bundler puts it in the page's stylesheet. It is wrapped in `@scope ([data-sn-c="<name>"], [data-sn-s="<name>"]) to ([data-sn-c], [data-sn-s])`: the component's root is the scope root, and nested component roots and slot content are the limits. Slot content passed on by a component is a scope root of its own for that component's styles (`data-sn-s="<name>"`; the page's is `data-sn-s=""`). In `@scope`, a selector without `:scope` or `&` matches only below the scope root, so each such selector of a style rule (also inside `@media` and `@supports`; not rules nested in rules) gets a copy whose first compound may be the root: `.compact p` becomes `.compact p, :where(:scope):is(.compact) p` (a pseudo-element follows the `:is()`, a selector whose first combinator is `+` or `~` gets none), with the same specificity. `:scope` as written is the component's root only, not slot content it passes on: in a style rule's selectors (not rules nested in rules) it becomes `:scope:where([data-sn-c="<name>"])` and `&` becomes `:where(:scope:where([data-sn-c="<name>"]))`, before the copies are added (theirs stay `:where(:scope)`, which slot content passed on may be). Each instance is its own scope: a sibling instance is outside it. `@keyframes`, `@font-face`, `@import`, `@property`, `@counter-style`, `@page` and `@layer` statements stay outside. On a page that uses a component with styles, every component root carries `data-sn-c` and top-level slot content elements `data-sn-s`; in dev builds roots always carry `data-sn-c`.
- Scripts: a component with a script beside its HTML (`<name>.ts`, `.js`, `.mts` or `.mjs`) gets a `cmp` binding on its root, whose function returns `[the class, its props, the root state's field names]` with those fields' paths as the binding's `w`; the page module imports the class the script exports, named after the component in PascalCase (`TaskRing` for `task-ring`), else its default export (neither is `SN312`), and the `components` feature (`@tiaforge-ui/sinter/runtime/components`) creates its object once per instance with `props` (live), `state` (one accessor per field of the root's state: an assignment marks that field's path; a root without `data-sn-state` gets `{}`), `refs` and `root`. Each `data-sn-ref` element of the markup gets a `cmp` binding too, returning `[the root's state, the ref's name]`, which gives the element to that instance's `refs` (a ref whose element left the page is removed after the render); and runs `connected()` after the render that created it, `propsChanged()` after a render that changed a prop, and `disconnected()` after the render that removed its root (or on destroy). `import { XComponent } from './x.html'` in the script resolves, through the Vite plugin, to a base class extending `Component`; `src/sinter.components.d.ts` types it from the HTML (props, emits, refs by tag, state from its initial values), written with the project, and by `sinter lsp` when a component's HTML changes. `data-sn-ref` outside a component's markup, or on its root, is `SN102`.
- `data-sn-early="off"` on a component's tag (or `<sn-component>`): the early chunk leaves out the bindings of that use's markup and of the components inside it (not of the slot content the tag passes in), so they render when the page module mounts; `prerender` still writes build-time constants into the HTML. Any other value is `SN401`; on a component's template or a plain element it is `SN102`.
- Diagnostics point to the line in the component, followed by where it is used.
- `<sn-include>` is gone (0.14; its migration errors went 2026-11-19 and 2026-11-20): it is an unknown element (`SN101`).
- Slot forwarding: a `<slot>` that carries `slot="<name>"` and is a child of a component's tag forwards what fills it (or its fallback) into that component's slot `<name>`: the elements get `slot="<name>"`, text keeps the name aside. Slot content keeps the use it was first given to (its caller's scope and its `data-sn-s` marker) through any number of components.
- Head components: a file whose template is `<template data-sn-props="{ …props }">` (a template with both declarations is `SN312`). Its top-level nodes, head elements only (`<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>`, `<slot>`, head components; anything else, or text, is `SN320`), replace the tag after its slots are filled and its constant props have decided `data-sn-if` templates (a prop given as a literal, or an optional one left out, as for components, but before the walk, so top-level templates fold too). They share one component scope, computed at the first of them the walk reaches; its caller is the scope where they are, the head component whose markup has the tag, or for slot content the caller of the use it was passed to. The tag takes only `data-sn-with` and `slot` (`SN102`). A head component has no script (`SN312`) and no scoped `<style>` (`SN320`); it is used only in a head (`SN320`; `expandComponents` tracks whether it is in one), is not a candidate of `<sn-component use>` (nor in `ComponentName`), and does not use itself (`SN306`).

### Layouts
A file `src/layouts/<name>.html` (`CompileOptions.layouts`) is a whole document whose `<html>` carries `data-sn-props="{ …props }"`. The guide is [layouts.md](layouts.md).
- A page whose body's only element is a layout's tag (a component of the same name wins, and is `SN318`) is replaced, right after it is parsed and before includes, components and everything else, by the layout's document: the layout is parsed (`parseDocument`), tagged with its file, its comments outside `<html>` dropped, its relative `src`/`href`/`srcset`/`poster` URLs of `link`, `script`, `img`, `source`, `video`, `audio`, `track` and `input` rebased to root-relative ones, and its slots filled with the tag's children as a component's are (`fillSlots`, over the whole document). Anything else in the page's head or body is `SN318`, as are attributes on an explicit `<html>` of the page.
- The tag's plain attributes set the layout's `<html>` attributes (replacing them; `class` is joined); `data-sn-path` and `data-sn-prefetch` are copied; `data-sn-state` is compiled on `<html>`'s node in the page's scope (`stateOf`), which is then the caller's scope: the props (`data-sn-with`, `SN313`) and every slot content see it, the layout's markup, compiled in a component scope of its props, does not. The tag's `data-sn-class`, `-attr`, `-style` are compiled on `<html>` in that scope; its handlers (`data-sn-on-*`, `data-sn-debounce-*`) on the layout's `<body>`, in that scope, before the body's own bindings (the page's `<body>` handlers, as before layouts). A handler's event must be a DOM event, `sn-error` or `sn-dismiss` (`SN315`). `data-sn-early` is `SN318`; other `data-sn-*` are `SN102`. The same `data-sn-state` on the tag and the layout's `<html>` is `SN209`.
- A default slot in the head is `SN318` (the page's content without `slot` is its body), and a `<title>`, `<meta>`, `<link>` or `<base>` given to a body slot is `SN320`. A layout tag anywhere else (inside a component, a layout, other markup) is `SN318`; a layout file with a script beside it, `data-sn-emits` on its `<html>`, a file without `data-sn-props` on an explicit `<html>`, and a layout compiled as a page are `SN318`. The layout's file is in `CompileResult.files`, so the dev server reloads its pages.
- `sinter check` frames the layout's props like a component's (`data-sn-props`'s location); the generated `src/sinter.components.d.ts` has `LayoutName` and `LayoutProps`.
- After expansion the head holds head elements only (`SN320`; `<sn-resource>` and `<sn-sync>` too, which go in the body: they are page-wide wherever they are written), and once each of `<title>`, `<base>`, `<meta charset>`, `<link rel="canonical">`, `<meta name>` `viewport`/`description`/`robots` and `<meta property>` `og:title`/`og:description`/`og:url`/`og:type`/`twitter:card`/`twitter:title`/`twitter:description` (`SN321`; a `<meta media>` is not counted). Elements inside `data-sn-if`, `data-sn-else` and `data-sn-for` templates count: an element in both branches of one if/else is one, a branch's and a top-level one are two, and any in a `data-sn-for` template is `SN321` (one per row).
- Parsing: `parseDocument` parses a document with a written `<head>…</head>` in two parts at the same offsets: the document with the head's content blanked, and that content as template content (in a `<template>` context), so every element (a custom tag, a `<slot>`) stays in the head where it is written. A document without both tags is parsed as `parse5.parse` does.

### Page module
```js
import { mount } from '@tiaforge-ui/sinter/runtime';
import sse from '@tiaforge-ui/sinter/runtime/sse';  // only features this page uses
import optimistic from '@tiaforge-ui/sinter/runtime/optimistic';
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
| `resources` | name, URL template, key fields, select/total paths, order, pagination config (with `paginate`'s `model`, its parameter `model` and the function that reads it, `start`; in the page module only the fields that are set: an absent one is null, `deps` [] and `scope` -1; the compiler keeps the full objects; the page module also flags a resource that an event of one of the page's streams names, `fed`: its `$meta.live` starts as `connecting`, and `pageshow` and `online` leave its reload to the stream, added 2026-11-14) |
| `syncs` | stream URL, event → change-message mappings (absent event fields are null; absent on a page without streams) |
| `roots` | per `data-sn` id: its bindings and the scope it opens (in the page module `p` is absent for a node outside any state scope) |
| `templates` | per template: node paths, bindings, key expression (absent `index`, `key`, `keyFields` are null); in the page module (`compactIR`) also its kind, which the runtime reads instead of walking the template's bindings: `sm` a simple row template (a lookup function, only value bindings and handlers: its rows keep no binding objects), `ri` a binding in its rows, nested templates included, reads a loop index (added 2026-11-14); `o` its content is one element, so a row clones that element and no fragment (any IR, added 2026-11-16) |
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

**Build-time constants.** With the `prerender` compile option (the Vite plugin always passes it; until 2026-11-14 `sinter({ firstPaint: false })` turned it off, which made constant bindings on `static` pages SN322 and left pages with nothing to run a page module), a binding outside any `<template>` whose value is a build-time constant is written into the HTML as the runtime would write it: it reads only `data-sn-state` fields with a constant initializer (each field on its own: `{ here: '/mail/', at: $now }` leaves `here` constant) and constants. No helpers, no `$locale`, nothing persisted. Kinds: `text` (content without elements), `attr`, `class` (literal keys), `style`, `show`, and `model` on checkboxes, radios and text/number fields. A refused URL or style is left out. This is what a browser without scripts shows. A binding written so that reads nothing but state fields nothing writes (no data, URL or `$locale`: a literal, a component prop given as one, a field no handler, model, `then`, `catch`, component script or the runtime writes) can never change, so the page module leaves it out (added 2026-11-11). The written fields are every `w` of the page's bindings (rows' too), actions, resources and events, by field (`$s<sid>.<field>`, or the whole state for a computed key or `**`), plus a form's `$error` and persisted values. A dependency on such a field never fires either: it is left out of every binding's `d` and every resource's `deps` (rows and branches too), after the early chunk is made, which reads the full lists. Inside templates (rows and branches), a binding over such state and constants only, that reads no row, is written into the template's markup the same way and left out (the template's nodes renumbered: `p`, `y`), and a state field that nothing writes and no remaining function reads is left out of its state's initializer (unless something reads the whole object). A `data-sn-if` whose condition reads only such state is decided at build time: `compileParts` compiles the page again (only when the first pass decided one) with each decided template replaced by its branch, the `data-sn-else` after it, or nothing, keyed by its instance (below): per use of a component (changed 2026-11-15: before, a component's template was decided only when every use agreed); one template in two instances nothing tells apart is decided only when they agree; its function when nothing else uses it (a `0` placeholder keeps the other functions' indexes), and its node and `data-sn` id when nothing else is bound there, the roots after it renumbered (`p`, `y`, resource and stream scopes). A `data-sn-for` over such a list (the evaluator above: literals, constant props, state nothing writes) is unrolled the same way when its rows need nothing at run time (every row binding is `text`, `attr`, `class`, `style` or `show`, reads no `$el`, writes nothing and reads only the row and fixed state, or is a handler that writes nothing and reads only constants, `$el` and `$event` (`handlerOnly`, added 2026-11-15: a copy button; the handler is all the row ships); no row node has a state; a template in a row is decided or unrolled per row, below), the list is plain data (no length limit of its own since 2026-11-16: its rows count against the page's expansion limit), and the first pass has no errors but `SN322` (added 2026-11-11; an error in a branch decided away, which the second pass does not compile, is reported all the same, since 2026-11-23): the second pass replaces the template by one copy of its content per item, and each copy's top elements get the item and index as derived names, the item's value as a literal (the first pass computed it) and `k`, so their bindings are constants written into the HTML; the list is compiled once per loop, for its diagnostics and types. **At any depth, in one second pass** (added 2026-11-15): after the walk, the first pass's worklist (`worklist()` in `prerender()`) evaluates each such loop per row with the row's item and index in scope, and what is in a row is decided per copy: a nested `data-sn-for` over constants is unrolled the same way (its rows the same conditions, at any depth), a `data-sn-if` (one that reads the row too) is decided and its kept branch is the row's markup under the same conditions, and a candidate of `<sn-component use>` that the copy does not render goes. **Constant trees** (added 2026-11-15; before, a row that rendered a candidate kept its loop a template): a recursion point and the chosen candidate of a `<sn-component use>` over constant props are expanded per instance (`expandCase`): the worklist checks the definition's markup over those props as a one-row instance under the same conditions, at the instance path `<key>#0/`, and the second pass inlines it (`inlineInstance`: the definition's markup expanded at the tag as a component used inline, `Origin.use` of its root `<` so the keys match the first pass's synthetic host; a candidate's tag takes the plain attributes of the tags it passes on). A runtime tree placement over constants is decided the same way: its case function runs at build time and the case it returns (the default, or the fill named by the fill map) is expanded in place; any fill is expanded (changed 2026-11-15; it had to be flat), with the instance's markup keyed as its definition's (`Origin.use` `<` on the component's own markup, never on a fill that took a slot root's place); the children a fill's `<slot>` places enclose their own component's tags and compile in its scope at the placement, before the components whose markup starts there; each case template is an instance of its own for what the walk keeps per instance (`caseInst`); fill scopes are kept per instance (`fillScopes`, `fillAt`: the longest recorded instance that prefixes the element's, through the chain a copy was made from). Two fills stay the browser's (`fillStays`): one holding a component with slots of its own, and one a wrapper passes on (written further out than the root's tag); SN322 names it. A definition that no remaining instance renders leaves the page, with its head template. Outside rows, the loops, choices and decided templates in a branch decided at build time are found the same way, and each `<sn-component use>` drops the candidates it does not render (per use) and expands the one it renders. A row is all or nothing: what it decides is kept only when its loop is unrolled. Keys are instance paths: the template's file and offset and the uses of the components it is in (`Origin.use`, the tags' places, so two uses on one line differ), after `<loop key>#<k>/` for each row it is in (and `<point key>#0/` for each instance expanded at build time). The second pass applies them top down (`expandConstants`): a decided template is replaced, a candidate removed, a loop unrolled into copies whose own templates are decided and unrolled in turn; a row whose loop is a row's top element gets that row's item too (`RowInfo.up`). Loops in a template that stays (rendered at run time) are not unrolled. So a page is compiled at most twice, whatever the depth (before, each level would have cost one more compile; a nested loop was not unrolled). Limits: the expansion limit (until 2026-11-16 also 1,000 items per list, which refused lists the page's limit allowed, with no diagnostic): at most 10,000 rows and component instances expanded at build time per page (`EXPANSION_LIMIT`, the `expansionLimit` compile option; until 2026-11-15, 10,000 rows, which component instances did not count). The loop or instance that would cross it stays a template rendered in the browser, and it is warning `SN536` (`expansion-limit`) at its element, once per page (heuristic: `strict` leaves it a warning). The value is measured: a copy costs about 0.2 ms in the second pass (build and LSP alike; 1,884 copies 436 ms build / 367 ms LSP, 6,280 copies 1.5 s / 1.3 s, 9,420 copies 1.9 s / 1.8 s), so a page at the limit compiles in about two seconds; a long article (about 3,000 nodes, a 47 kB source) needs between 5,000 and 5,500 copies. A page-level state left with no fields has no node either (the nodes inside take the scope around it). The compile order in `run()`: components and includes are expanded, decided templates folded and loops unrolled; then the constant pre-pass; then the layout is computed, reserved space planned and images rewritten; then the walk compiles the bindings (reading the layout for bound images); then `prerender()` writes the remaining constants and `dropConstants` leaves them out. **The constant pre-pass** (added 2026-11-15): what the layout and the images read is written before them, so a constant image is optimized and a constant class counts for `sizes` and reserved space. Which bindings are constant is known only after the walk (what writes state comes from handlers, models, `then`s and scripts), so the first pass records each value attribute whose bindings `dropConstants` left out, by where it was written (its element's file, offset and component uses, and the instance path for a row of an unrolled loop, whose bindings the worklist evaluates per row), with what it writes. The second pass writes those into the markup before the layout and removes the attributes, under the same rules as above. Only attributes the layout or the images read: any of an `<img>`'s `data-sn-text`, `-show`, `-attr`, `-class` and `-style` (with `images`), so it becomes a static image, and `data-sn-class` (a class some selector names) and `-style` when the page has stylesheets and the fold changes what the layout feeds (changed 2026-11-15), which a dry run decides: the first pass copies the markup before the layout when the page has a `data-sn-class` or `-style` and an image or a loop (`snapshot`), and records the layout's answers for every image (box, bound, rendered width at every viewport width with and without the file's own width, the `auto-fit` case, the scaled widths) and the reserved space `planSpace` planned, in document order; after the walk, when those folds are the only reason for a second pass, it writes them into the copy (`prefold`), computes the layout and `planSpace` again on it, with no walk or code (`dryRun`), and compiles again only when an answer differs. A flex or grid sibling's class that changes an image's width counts, and so does a class the layout could not follow while it was bound (it cannot tell a bound class's box: a flex row with one gave its images `100vw`). A class no selector names, a page with no image or loop, and folds whose answers do not change are written after the walk and cost no second compile (RealWorld's constant `active` nav class). When the page is compiled again anyway (an image's attributes, a decided template, an unrolled loop), they go with it, with no dry run; every binding of the attribute must be constant, and an attribute with a diagnostic other than `SN513` stays bound (so the second pass reports it again). A component's tag passes its attributes to its root: written there, and removed from the tag when every root it reaches has them. Instances that nothing tells apart and that disagree leave it. `compileParts` compiles a second time for these too (with a clean first pass, as for unrolling); the decided templates and unrolled loops ride in the same second pass. The rest is written after the walk, as before. A folded image is then rewritten and checked like one written in the page (`<picture>`, `srcset`, `sizes`, `width`, `height`; `SN511`, `SN512`, `SN514`; no `SN513`, which is for a `src` that changes), with its folded `src` or `srcset` resolved against the page, as the browser would have; a `srcset` it folds is the author's, as on a written image, and leaves it alone. Images not analysed yet are pending, analysed and compiled again, as for written ones. The fields such bindings read are in `fixedState`. The LSP and `sinter check` pass no images or stylesheets, so they never compile a page a second time for this. The constants of rows at every depth come from the worklist, by instance path. One compile would need what writes state before the walk; the second pass stays, once per page.

**Pages with nothing to run (added 2026-11-11).** After all of the above, `CompiledParts.runtime` lists why the page needs the runtime, in document order, the page's own first: each root node with a binding or a state (named by its first sinter attribute where it was written, `the script of <x>` for a component script), each resource and each stream. With `prerender` and an empty list the page is `static`: it gets no page module script and no early script (the early module is `null`, also when the app has an early module), and the stylesheets the module would import (`images.stylesheet`, `componentCss(name)` for each component with styles) are `<link rel="stylesheet">` at the end of the head instead, which Vite's HTML pipeline bundles. With the `static` compile option (the plugin passes it for pages `sinter({ static })` matches), each reason is `SN322` where it was written; `sinter check` and the LSP compile such pages with `prerender`. The plugin logs one line per page in builds: `no JavaScript`, or the page chunk's and its imports' gzip sizes and the first three reasons with their file and line; and fails the build for a `static` pattern no page matches.

**The early script.** With the `early` compile option, each page gets an early module. In builds the Vite plugin bundles it into classic scripts (IIFEs) and puts their tags first in the head, before the stylesheets (a classic script waits for the stylesheets before it) and the page module: `assets/sinter-head-<hash>.js`, shared by every page (the early runtime with the writers any page uses, the app's early module; cached across pages), then the page's own `assets/<page>-head-<hash>.js` (the hold script if the page uses `data-sn-transition`, the page's compiled early bindings and requests). The page's script takes the runtime from a global the shared one sets (`Symbol.for('sinter.early.rt')`), except for the few exports that keep no state of the runtime's own and that not every page uses (`PAGE_OWN` in src/vite.ts: a numbered list's page parameters and page, the array parameters, the token's read, the sign-in guard, `$hq` and `$href`), which the pages that use them bundle in, so the shared script every page loads holds none of them; both are parser-blocking, fetched in parallel, run in order. In dev it is the same: the dev server bundles the page's early module into one classic script (the runtime bundled in, no shared script) when it is first requested, serves it outside the module pipeline (which would add imports to it) with its source map inline, and keeps it until a watched file changes; its tag is first in the head. The base language's text is in the HTML in dev too. It holds:
- the app's early module, `src/sinter.early.ts` (optional; `early` in the plugin options names another). It is app code that runs before anything is rendered; sinter does not know what it does. (The page's language is fixed at build: see Messages.)
- the early bindings, compiled into the page's renderer (`src/compiler/early-render.ts`, decided 2026-11-09: the early runtime used to interpret them from an IR, ~1.9 KB gzip of every early file): every state scope with its persisted values first, then each binding's first write and each early `data-sn-if` branch, as straight-line calls of the small writers and helpers `@tiaforge-ui/sinter/runtime/early` exports, so a page's early file bundles only the writers its bindings use (no attribute binding: no URL check). A binding that throws is left to the page module, a missing element is skipped. Outside `data-sn-for` templates, bindings (`text`, `attr`, `class`, `style`, `show`, `model`, `if`) that read only state fields whose initial value needs no data (literals, helpers, `$locale`, other such fields), persisted values, and helpers. Persisted values are read from localStorage (`sn:<key>`, any value) and applied before anything is written, as the persist feature does at mount. `$url` too (the URL's query and `data-sn-path` parameters, read as the page module reads them; added 2026-11-11, before only on pages with embedded data). Not early: resources (their requests are, see below), `$now`, `$meta`, `$el`, loop variables, store functions, the built-in formatters (they format with the page's locale: the early file sets it with `$lang` for a page in one language, as the page module does; else the configured one). `$locale` reads `configure({ locale })` if the early module configured it, else the page's `<html lang>` in an app that sets no locale (the page object's `locale`, since the head script's runtime is shared); otherwise those reads wait.
- a `data-sn-if` of that kind renders its branch (or its `data-sn-else`, the `z` template), and the early bindings in it; nested `data-sn-if`s the same way. The branch is cloned from its head template before the anchor's end comment; its nodes, the end comment and the branch number are left on the start comment (`Symbol.for('sinter.early')`); the runtime adopts them on its first toggle (binds the existing nodes instead of cloning), or removes them if another branch is to show. An anchor is rendered once its end comment is parsed (the observer sees comments as the parser inserts them: one more `nodeType` check per added node), and the first scan covers anchors already parsed in the head.
- the code for each template the early file renders is written once into a table (`B[<template id>]`) and referenced wherever the template is used (shared definitions that reach each other included), so a template inlined at every place it is used no longer multiplies the early bindings.
- only the helpers and namespace members the early bindings call, imported from the modules that declare them (past the helpers module and barrels such as a message index, whose namespace objects would pull in everything), and only the state fields those bindings read.
- the request machinery (`requests` from `@tiaforge-ui/sinter/runtime/early`: `$url`, `$now`, the handoff) only when the page has early requests (below), and the early requests themselves compiled into the page's early file (`req` on its page object, `earlyRequests` in src/compiler/index.ts; decided 2026-11-20: the early runtime used to interpret them from `EarlyIR.res` and `as`, with `expand()`, `URLSearchParams` and an origin check per request, 1,158 B gzip of RealWorld's shared head script): per request, its `when`, its URL written out as the page module will fill the template (`urlCode` in src/compiler/compile.ts: the literals, each path value through `$hv`, which refuses a dot segment or a list, each value inside a query parameter through `$hv(v, 1)`, and a query with whole values, `?tag={t}`, through `$hq`, which leaves out a null parameter and repeats a list's; a template of another shape, one with a `#`, through `$href`, which is `expand()`), a paginated list's first-page parameters as literal text after it (a numbered list's page, from the URL, an expression; `withParams` when the template has a query of its own, which the parameters are merged into as the pager merges them), and its API's settings (credentials, static headers, the token's storage and header), as literals. The runtime starts the fetch, keeps it for the page module (`pending()`: the token's read, the hand-off's comparison, the abort after mount), and nothing else; the early file's URL and the page module's come from two computations of one template, which test/url-code.test.ts compares over random templates and values. No origin check at runtime: the build requests a resource early only when its literal start fixes the origin (`earlyOrigin`: `/` and a character that is not `/` or `\`, or a listed origin's `https://host` followed by `/`, `?` or `#`, read with tabs and newlines dropped, as URL parsers read them); an `src` such as `/{path}` is left to the page module; the environment (`configure({ env })`, set by the app's early module if at all) only as far as the early file reads it, not the runtime's default environment. A page with nothing to run early (every early binding written at build time, no early request) has no early file.

**Own copies.** The early scripts are bundled apart from the page bundle: any module both use is in both, as separate instances, so state the app sets early is not seen by the page bundle: the app sets it again there, e.g. by calling the same language function from `src/sinter.config.ts` (same inputs, same result). sinter's own state is handed over through the DOM (rendered values, the early branch on its template) and through globals (the handoff, the messages' state). (Until 2026-11-10 the early file and the page bundle shared a chunk with the URL checks and expansion; the early runtime is now in the shared head script, once per site.) The first-paint budget counts the page's script and the shared one. **Shared helper modules (added 2026-11-17, builds, `src/shared-build.ts`):** a module that declares helpers (the helpers module itself excepted) is shared when an early file imports it, every early file that imports it imports all of its exports (`ModuleInfo.exports`), and the build target has top-level `await` (`topLevelAwait`). Its `load` waits until every page is compiled (`everyPage`, the core's wait), then returns a stub: `globalThis[Symbol.for('sinter.shared')]?.[key] ?? await import('<file>?sn-own')`, re-exported. The early files of the pages whose bundle reaches the stub start with `import * as $sn$shN from '<module>'` and put the namespace under the same key. The key is a mark (`__SN_SHARED__<hash of the path>__`) until `generateBundle`, then `k` and a hash of the own copy's chunk name, of the mark's length (source maps keep their columns), so an instance of another build is never taken. HTML: `<link data-sn-shared href>` (the own copy) on a page whose early file registers the module, which the swap imports beside the page module (`SHARED`, a flag of the core, off unless an early file imports a helper module); `modulepreload` for the copy and its chunks on a page that reaches the stub without it. The page's early-size line names modules of 4 kB or more (before gzip) in both, with `unshared`'s reasons.

The runtime owns every binding: on mount it computes the same values, and its writes change nothing, so there is no flash and no reset. Early code runs once and keeps no listeners.

**The page bundle is `async`.** In builds its entry script carries `async`: a deferred module script waits for every pending stylesheet before it runs, an async one does not, so on a warm load the page module starts its requests one round trip earlier. It may now run before the body is parsed, or before the early file, so the page module waits before it mounts: `await parsed()` (`readyState` past `loading`), or on a page with an early script `await rendered()` (both from `@tiaforge-ui/sinter`: the core is in every page bundle, so no chunk more), which waits for the parse and for the early script's last pass (and for the dictionary, with messages). They are bundled apart, so the two meet through a global (`Symbol.for('sinter.early.page')`): the early script marks that it started and when it has rendered. An early script that failed to load does not hold the page: if it has not started by DOMContentLoaded, the page module mounts. The takeover is the same as with a deferred page module. What changes for app code: the modules of the page bundle (custom elements, `src/sinter.config.ts`) may run while the body is still being parsed, so top-level code must not read the body, and a custom element defined then is upgraded as the parser creates it (its `connectedCallback` can run before later siblings or its children are parsed: read them when sinter sets a prop or on an event, not on connect). In dev the page module stays a plain module script; the same waits apply.

**Data requests before the page module.** A page's resources are requested before its page module has run, in two ways (with first paint on):
- Every origin a literal `src` of a resource or a stream names (`https://api.example.com/…`) gets `<link rel="preconnect" href="https://api.example.com" crossorigin>` in the head, before the preloads: DNS, TCP and TLS are done while the page bundle downloads instead of when its first request leaves. `crossorigin` (anonymous), because the request layer sends cross-origin requests with `credentials: 'same-origin'` and `EventSource` connects without credentials. Such a `src` gets a preload and an early request (below) only when its origin is listed in `sinter({ origins: [...] })`. Every page module adds that list to the runtime's allowlist (`$origins()`, after the app's config module, which may still call `configure({ origins })`: an origin listed only there is allowed but not requested early), so an app lists its API origins once and nothing the runtime would refuse is sent early. The build names, once, the origins it left to the page module. (Before 2026-11-09 both were same-origin only.)
- `<sn-resource early="off">` keeps a resource out of both: one a request middleware answers itself or changes (adds an `Authorization` header), so that the request sent early would go unused, or fail where the middleware would have answered (RealWorld's `user`: the middleware answers `{user: null}` without a token).
- A resource whose request is fixed at build time (a literal same-origin `src`, no `when`, not `for`, `call` or embedded data; a paginated one at its first page) gets `<link rel="preload" as="fetch" crossorigin href="…">` in the head, after the leading `<meta>`s: the request starts while the head is parsed, before any script. The runtime's `fetch()` takes the preloaded response (Chrome matches it by URL and credentials mode, `crossorigin` being same-origin credentials; the differing `Accept` header does not keep it from matching, measured 2026-11-08), so there is one request.
- A resource whose URL reads only what the early file knows (state fields whose initial value needs no data, persisted values, `$now`, `$url`, helpers, not other resources, `$meta` or the built-in formatters) is requested by the early file when it starts, if its `when` holds: as the request layer sends a GET with no middleware (`Accept: application/json`, `credentials: 'same-origin'`, so none to another origin). The early file and the page bundle are bundled apart, so the responses are handed over through a global (`Symbol.for('sinter.prefetched')`). A paginated resource is requested at its first page: the compiler adds the query parameters the pager sends for it (`firstParams` in `paginate.ts`: `params.size`=`size` and `params.direction`=the `first` value of `directions`, or `params.page`=1 and the size in offset mode; no cursor, no `params.offset`) as the runtime adds them (the same string as `withParams` makes, shared by both), so the runtime's first load (and its revalidation of a `cache`d page) takes the response; any other page, or a request whose `src` changed meanwhile, is the runtime's own. Not `for`, `call` or embedded resources.

How middleware applies (`configure({ request })` is the page bundle's): the runtime sends its request through the whole chain as always; at the end of the chain, instead of fetching, it takes the early response for that URL if the request is exactly the one the early file sent (GET, same URL, same-origin credentials, `Accept: application/json` as its only header). So response middleware (`onUnauthorized`, the 401 cache clearing, the timeout, a retry policy) runs on the early response as on any other; a request middleware that changes the request (adds a header, changes credentials) gets a request of its own, and the early one is aborted after mount, as is any early request no resource took (its URL changed in between, or a middleware waited before calling `next`). Each early response is taken once: a reload goes to the server. An early request that failed (a network error) fails the load that took it, as its own request would have; with `retry.get`, the policy's next try is a real request (changed 2026-11-09: the request layer's automatic resend used to send it again at once). A preloaded response is taken by the browser, not by sinter: an app whose middleware adds headers the server needs on a GET (an `Authorization` header) should turn first paint off or not declare such resources with a literal `src`, since the preload is sent without them.

**The early script renders as the parser goes (decided 2026-11-10).** It runs in the head, before any of the body exists: it starts the early requests at once (no stylesheet to wait for), then watches the parse with a `MutationObserver` and renders each early root once the parser has moved past it (it, or an ancestor, has a following node; an `if` template also once its `data-sn-else` sibling is parsed; `<html>` and `<body>` at once). The observer's callback is a microtask at the end of the parser's task, so it runs before the browser can paint that element: in every browser, with no `blocking` attribute and no hold. Each pass looks only at the nodes added since the last one. At DOMContentLoaded a last pass renders what is left, and the page module may mount. This replaced a deferred render-blocking module (with a split `async` file for the early requests and a Firefox fallback that hid `<html>`): without the hold, Chromium painted the unrendered page on 61–90% of RealWorld loads (layout shift 0.12 on the home page); with this, 0 wrong frames in Chromium and Firefox (RealWorld, and Caley's persisted collapsed rail), first paint level or earlier (slow 4G cold: 576 → 440 ms on a page with messages; Caley 160 → 144 ms cold in Chromium, 197 → 172 ms in Firefox, where the fallback had hidden the page in its first frame on most loads). On slow networks the browser may paint the top of a page whose rest has not arrived yet: what is shown is rendered, what is not parsed yet is not shown. A stalled head script holds the parse, as any parser-blocking script does: keep it small (the budget below).

**Attributes at insertion, content at close (2026-11-10).** A root's attribute-like bindings (`attr`, `class`, `style`, `show`) are written in the first pass that sees the element: its attributes are complete when the parser inserts it. Its content bindings (text, a control's value, an `if` or `for` template) wait until the parser has closed it. Each pass looks at every root seen so far and writes each binding once; one runs when roots were added or a content binding still waits. Before, every binding of a root waited for the close, so a persisted class on an element that wraps the page was missing until the end of the document arrived (found with the home page streamed in two chunks: 30–35 frames without the wrapper's class in each of 10 loads).

**Embedded data renders early (prototype, 2026-11-10).** A resource with embedded data (`data-sn-resource`, filled by a server: see Embedded JSON) is known before the first paint, so the early part also takes the bindings that read it, `data-sn-for` loops included. The early IR names each such resource's data element and `select` path (`emb`); `$r.<name>` in the early scope parses it once. A binding that reads a resource without data throws there, which leaves it to the page module, as for anything else not available early (`$url.feed == 'following' ? feed : articles` renders the global feed early). A binding that throws on every path is not written into the early file at all (`alwaysThrows` in `earlyParts`, changed 2026-11-27): its compiled function reads `$.$r.<name>` or `$.$meta.<name>` of a resource that is neither embedded nor predictable (below), or a field of a predictable object resource (null at mount), outside the branches of `?:`, the right side of `&&`/`||`/`??`, an optional call's arguments and callbacks. So its templates, state fields and helpers are not in the early file either (before, on a page with any embedded or predictable resource, such bindings were written in and skipped at run time: 44% of Caley's mail early file). The early script never renders from a response, in any mode: `$r` in its scope is the embedded data alone (another name throws), a predictable resource's reads are written in as its state at mount (below), an early request's response is handed to the page module (`runtime/handoff.ts`), a tab with cached or next-page rows of a resource makes its bindings throw (below), and a swap runs no head script. Rows are cloned by `for` (a clone of the head template per item, before the anchor's end comment, rendered over a scope with the loop variable) and left on the anchor's start comment with the end comment (`Symbol.for('sinter.early.rows')`); a choice over embedded data (`ch`) renders its case's definition the same way, with the props as the definition's item. A start comment without these marks but with nodes before its end comment is an early render that failed: the page module removes those nodes on its first render of the anchor, where they would have been doubled. The page module's first reconcile of that list adopts them when it has as many items: it binds each row's nodes (`instantiate` with `pre`, as for an early `if` branch) instead of cloning, and writes the values again, which changes nothing; the text writer skips a value that is already there, since a write counts as new content for the browser's paint timing. With another count it removes them and renders the list. An unkeyed list it adopted matches its rows by position, not by item identity, in the page module's first flush (added 2026-11-15): a let over a helper that returns new objects (a parser) is computed again when the embedded data is stored, and its new items take the adopted rows, whose values are written again, so the takeover changes nothing. After that flush the list behaves as any other. The page module computes every let and all state again at takeover. So a server that only fetches the API and writes the JSON into the page (no DOM, no rendering) gives the page its data in the first frame. Measured against Qwik City in [docs/first-paint-comparison.md](first-paint-comparison.md).

**Hidden messages come back.** The sheet that hides base-language text for another language is removed after 3 s if the page module has not mounted by then (it failed or stalls): the text shows in the base language instead of never.


**Closed at mount (added 2026-11-14).** `earlyParts` leaves out a `data-sn-if` without a `data-sn-else` that reads resources without embedded data (not `for` or `call`) and that `shows` (compiler/status-eval.ts) finds false with no data (`[]` for a keyed resource or a list without a key, `null` for one object) both loading and not: the early file would render nothing the HTML does not show already.

**Closed by the initial state (added 2026-11-28).** `earlyParts` leaves out a `data-sn-if` without a `data-sn-else`, not in an else-if chain, when all of this holds; anything else keeps it. (1) Its compiled condition is made of state fields and what is read off them (`$.$s<n>.<field>…`, `$k` for a computed key), literals and operators alone (`stateOnly` in src/compiler/compile.ts: an allow-list of syntax; no other call, no function, no global, no `$url`, `$now`, resource, item, `$el` or `$build`), and reads at least one field. (2) `prerender` evaluated it over the states' initial values (the evaluator of the build-time constants, where a persisted state's or model's field and a field it could not compute throw) and every evaluation of the binding was falsy. (3) The early script computes those values itself (`sameEarly`): each field read, and each field its initializer reads, is of a state without `data-sn-persist`, is no persisted model's path, and its initializer is of the same syntax or is a value the build computed and embedded (`$.$d(id)`: the early script reads that value, never another). The early script evaluates such a binding false and `iff` then does nothing, so the first frame and the takeover are the same without it; its templates are no longer the early file's (`placeTemplates` puts them at the end of the `<body>`), and the functions and state fields only it read leave the early file. A model's setter is in the early table only for a persisted model (`pm` is its one caller). The same for an early request (`EarlyIR.res`): a resource whose `when` is of that syntax, false over the initial values (`whenClosed`) and over fields the early script computes alike (`sameEarly`) is not in the list, as `q` sends a request only where its `when` holds. Nothing else reads the list: the page module's loader decides its own requests and takes an early response only if one was started (`take`), and the embedded-data manifest, next-page data and preload links are made from the resources, not from it. A page whose early file held nothing else has none.

**Closed as written (added 2026-11-28).** `earlyParts` also leaves out a `data-sn-if` without a `data-sn-else` whose condition, once `status` has written the resources' state at mount into it, reads nothing (`stateOnly` with no field: literals and operators) and evaluates false: `user && !$meta.user.error` on an API with a token is `null && !null`, signed out and while it loads. The early script would render nothing whether the binding's checks (cached rows, an empty placeholder) pass or throw. What the look added to the function table is taken out again.

**Folded values by reader (added 2026-11-28).** A folded state field's value (`embedFolded`, `<script type="application/json" data-sn="<id>">`) that no function of the early file reads (`$.$d(<id>)`) is written at the end of the `<body>` (`placeFolded`), after the templates the early file does not render; the page module finds it by its id in its walk of the document, as it finds one in the head. One the early file names stays in the head, where its reader looks (`head > script[data-sn]`).

**The head script's parts (added 2026-11-28).** The shared head script holds the early runtime's exports the pages' early files import (the compiler names each: `$k` only where an early function has a computed key, `a[$k(b)]`), and, inside those, the parts a flag guards (src/runtime/early-flags.ts, as src/runtime/flags.ts for the core): `EMBEDDED`, the reader of embedded data (`$r` early, with the token's read it makes). A page's compile says which parts its early file uses (`CompileResult.earlyRuntime`); the early files' build serves the flags module with the union on and the rest off, per site, and every part is on in dev, in tests and for a page compiled without that information. `CONFIG` is the build's own fact: on when the app has an early module (`src/sinter.early.ts`, bundled into the head script, the one code that can `configure()` before the early files run); off, the early runtime's reads of the configuration (the environment's storage, the URL schemes of `attr`) are the defaults, compiled in.

**Reserved space (added 2026-11-14, builds).** A `data-sn-for` outside templates and dialogs over a paginated resource, or a choice between paginated resources (the expression, and the `data-sn-let`s around it that it reads, only choose: identifiers, `?:`, `||`, `??`, comparisons, `$url.<name>`, literals; no call, member or index), holds its rows' space from the first frame: the least `size` rows. No attribute; `sinter({ firstPaint: false })` turns it off with the rest. Not for a resource with `for` or `call`, with embedded data (`data-sn-resource`, or a slot `embed: true` adds: decided from the resources' data slots after the walk), or whose `src` or `when` reads state, another resource or `$el` (its load may not start at mount); nor rows a component's own `<style>` reaches (a styled component's root or slot content around the list or inside its rows: the layout reads only the page's stylesheets). Two forms. `static` (the list is one resource without `when`): an element after the list's anchor (its end comment), `class="sn-reserve snr<page hash><n>" aria-hidden="true"` (the hash: FNV-1a of the page's path, so two pages' classes differ) (`li` in a list, `span` where only phrasing content may go, else `div`), whose root node's one binding (kind `imp`, `$el`) removes it once the resource has rows or no load is running (`$r.<name>?.length || !$meta.<name>.loading`: loads start at mount, before it runs); its node gets its id and place in `roots` after the walk (`placeholders`). `if` (a `when`, a choice): a `<template data-sn-if="!(<list>)?.length && ($meta.<a>.loading || …)">` with that element, inserted after the list and compiled by the walk, only when every resource is `predictable()` and the list reads only them and the URL, so the early file decides it (resource status early, below) and the page module toggles it as any branch. In the page that branch is an anchor after the rows, two comments: it is no element after them for structural rules, and the element it renders shows only while there are no rows (changed 2026-11-15: until then its template counted as an element after the rows, `trailing`, so a `:last-child` rule never matched a row of this form). The Vite plugin's early files come from each page's own compile (with the stylesheets), so their ids are the page's. Loading indicators (`settleSpace`, after the walk, before `placeholders`): every compiled `if` and `show` binding of the page that reads `$meta.<name>` of one of the list's resources is evaluated by `shows` (compiler/status-eval.ts: an acorn walk of the compiled function over literals, `$.$meta.<name>` fields, `$.$r.<name>` and `.length`, `!`, `&&`/`||`/`??`, `?:` and comparisons; anything else unknown, never run) while loading with no rows, with a row, and loaded. One that is false while loading with no rows never meets the placeholder; one that is true then and false in both others, a `data-sn-if` right before the list (only templates between) with one element, takes the placeholder's place (the element gets `snr…b`: `min-height` the rows' height, `margin-top`/`margin-bottom` theirs, `box-sizing: border-box`; and `.snr…b ~ .sn-reserve.snr…` is `display: none`); any other that may show then (unknown included) leaves the list without space: the static placeholder is taken out, the inserted branch's condition compiled to `false`. `planSpace` (before the walk, which removes the bindings the cascade looks at; in dev too, so `SN529` follows the same plan, the placeholders being the build's) calls `Layout.reserve(tpl, count, { sized })` (compiler/layout.ts): the placeholder's rule per viewport range (the stylesheets' width breakpoints, split where an `auto-fill`/`auto-fit` grid or a wrapping row gains a column; within 1 px the lesser shape; mobile first, `@media (min-width)`), or null with a reason (`unreserved`), which the build prints per list (`CompiledParts.unheld`). Shapes: block (rows' margins collapse between them, the outer ones on the placeholder), flex column (`gap`, margins), grid (`grid-column: 1/-1; grid-row: span <lines>`, each line as tall as `grid-auto-rows` or its tallest row), a flex row of rows with a width of their own (`width` in px, rem, em, with box-sizing, min/max and margins; no `flex-basis`: the placeholder the rows and gaps wide, `flex: 0 1 auto`), and a wrapping one (rows per line from the container's content width at each viewport width; `flex: 0 0 100%`), and table rows in a row group (a `<tr>` placeholder, `display: block` in an anonymous cell; the rows' heights and the table's vertical `border-spacing` between them, 2 px from the UA, 0 when `border-collapse: collapse`, where cells count their padding only; the UA's 1 px cell padding; the table elements' own default displays for heights). With `sized` (the list is in a box whose width follows its content, `Layout.contentSized`), only stacked rows with a width of their own, and the placeholder takes that width. Each row is laid out in its place (`withRow`, when a rule has a sibling combinator or a structural pseudo-class; a view per distinct answer of the row's positional queries, which are logged and replayed for the next row): its previous and following siblings are the rows before and after it and the elements around the list's anchor, what another anchor there may render counting as maybe; `:nth-child()` and the like count those. An anchor is comments, no element (changed 2026-11-15; until then the template counted as the element right before row 1): row 1's `+` sibling is the last element before the list, or what an anchor just before it may render back to the nearest element that is surely there, and a list at the start of its parent has row 1 as `:first-child`. Outside a row view, sibling and structural rules skip anchors (`elementsOf`), and an element beside one has siblings the build does not know (`siblingsUnknown`: maybe). Each value that may or may not win (`candidates`: a state, a media feature, `@supports`) counts at its least: the least height, `min-height` floor and `max-height` cap, `font-size`, `line-height`; an undecided `box-sizing` as `border-box`; a row's `display` when all candidates lay it out alike. The row's height is exact when the stylesheets fix it, else a lower bound: block flow with margin collapsing (through the first and last child unless padding, border or a formatting context stops it; an inline box with blocks in it is split around them), flex containers (sum in a column, the tallest in a row) and grids (the tallest item), each item with its own line height (text runs the container's); table rows (the tallest cell); a run of inline content is one line box at least as tall as the strut and every inline box in it (a bound text, `data-sn-text`, one line; `<br>` ends one; inline-blocks, controls and images by their boxes); a `data-sn-if` with its `data-sn-else` the lesser; images with `width`/`height` attributes as tall as their width at that viewport (a `max-width`) allows; controls in the UA's font (`system-ui`, `normal`, 13.333px for a 16 px default, following the default size) with `box-sizing: border-box` for buttons, selects and button-like inputs, a lone `monospace` font at 13/16 of its size (font-size keywords under it too); nested lists without vertical margins; `<sub>` and `<sup>` `smaller`; a `<br>` the cascade hides or cannot decide ends no line; a closed `<details>` its `<summary>`; margins as they are, a box whose margin cannot be read 0; hidden, `data-sn-show`, out-of-flow, floated, `display: contents` and undecided boxes are 0. An item of a column flex container counts its `flex-basis` and, when the container's height may be limited, its automatic minimum (it may shrink). A negative margin collapsing through a box's edge (from its first or last child) pulls the box in; rows that may be empty let margins through, the lesser of both. Rows with `content-visibility` other than `visible`, a wrapping row with a `flex-basis`, a grid with explicit rows (`grid-template-rows`, `grid-template`, `grid`), `zoom` on the rows, their container or an ancestor, and rows a binding may hide (`data-sn-attr` with `hidden`) are not followed. Font sizes inherit (keywords, em, %, rem, vw, the `font` shorthand; the UA's heading sizes and margins at their least, an `<h1>` 1.5em), line heights as computed (a number per element, a length inherited as px); `normal` below. Every length is computed for a default font size of 16, 12 and 8 px (`withBase`): equal, px; on one line, `min(<16 px value>, calc(a px + b rem))`, the line at or below all three (rem scaled by the page's root font); not on one line (a kink, as a `min-height` in px over text in em), steps that each hold from their sample up (heights grow with the font): `max(min(<8 px value>, <line>), <ramp to the 12 px value at 12>, <ramp to the 16 px value at 16>)`; a shape's column count is the most of the three (a gap in rem fits more columns with a smaller font). All floored to 1/64 px and 0.01. A height that is a straight line in the container's width over a range (at or below it at the middle, the same for every default font size) is `height: 0; padding-bottom: calc(k% + c px)` instead, exact at every width. The rules are `CompiledParts.paint`: one `.sn-reserve:not(#_)` rule (block, hidden, no padding, border, margin or min/max height, `flex: none`) and per list and viewport range `.sn-reserve.snr…:not(#_)` with what varies (height, margins, width, `flex`, grid span); `:not(#_)` weighs as an id; each declaration `!important`. With `paintCss` a string, the page module imports it (the plugin serves `/@sinter/paint-css/<page>.css`, one file per page, which Vite merges into the page's stylesheet; builds only, since dev serves imported CSS after the first paint). Testing's `render(html, { css })` writes placeholders too. `SN529` (`Layout.contentSized`, naming the viewport widths): a list over a resource without embedded data inside a box whose width follows its content (an auto-width flex item without a basis in a row, among other items; a float), up through blocks, stretched column flex items and percentages, unless its placeholder takes the rows' width. `SN530`: an image, video, iframe, embed or object in the rows of such a list with no height before its file loads (`Layout.sized`: no `width` and `height` attributes, no fixed height, box or `aspect-ratio` from the stylesheets). The plugin reads the stylesheets of the page's layout too (its `<link>`s and `<style>`s first), for images as well, and Google Fonts' stylesheets in builds when `fonts.bundle` is on.

**`line-height: normal` (added 2026-11-14).** The text may be in any face of its `font-family` stack when the rows arrive: a web font shows only once loaded (`font-display: swap`, and during `block`'s period the fallback lays out), a family a platform lacks falls through. So the cascade counts the least ratio among: each family with a ratio from the build (`normalLineHeight(family)`), each family of the built-in table (src/compiler/system-fonts.ts: (ascent + descent) / unitsPerEm of Arial, Helvetica, Helvetica Neue, San Francisco as `-apple-system` and `BlinkMacSystemFont`, Segoe UI, Roboto, Times New Roman, Georgia, Courier New, Tahoma, Verdana, Noto, Roboto Mono, Cantarell, Ubuntu, Oxygen from @capsizecss/metrics 4.4.0, MIT; DejaVu and Liberation read from their files), up to the first generic family, which counts the least of its default on each platform (`GENERIC_FONTS`: `sans-serif` Arial, Helvetica, Roboto, DejaVu Sans, Liberation Sans, Noto Sans; `system-ui` and `ui-sans-serif` Segoe UI, San Francisco, Roboto, Cantarell, Ubuntu, DejaVu Sans, Noto Sans; `serif`, `monospace` and the `ui-` ones likewise; a default without metrics in the table, Times, Menlo and Consolas, counts as 1). A stack with no generic family ends in the browser's default, `serif`. A family neither the build nor the table has metrics for counts as 1, as does a stack the cascade cannot decide. The px value is the ratio × the font size less 1 (engines round the ascent and the descent to whole pixels). The build's ratios (Vite plugin): `familyLineHeights` takes each `@font-face` family of the page's stylesheets from its regular Latin face (no `unicode-range`, or one covering U+0041): its `ascent-override` + `descent-override` when it has both, else the first file that reads (`normalLineHeight(bytes)`, src/font-metrics.ts: `head`, `hhea`, `OS/2` of a ttf, otf, woff or woff2, not collections; the smallest of `hhea` ascender − descender and, with USE_TYPO_METRICS, the typo values, else the Windows ascent + descent, line gaps left out, as Chromium on Linux leaves out the typo line gap), else the table's ratio of its first `local()` font; `size-adjust` scales it (the smaller of scaled and not, as it may or may not scale the overrides). Files: a local URL (relative to the stylesheet, root, `public/`, `/@fs/`), a `data:` URI, or a fonts.gstatic.com URL, downloaded once into `node_modules/.cache/sinter/fonts/files`. Checked against Chromium on the installed system fonts (test/font-metrics.test.ts).

**Resource status early (added 2026-11-14).** `predictable()`: resources not embedded, `for` or `call`, whose `when` (if any) reads only `$url`, `$now`, `$locale` and helpers other than the built-in formatters, no state. When the page module mounts such a resource has no data (a collection or a list without a key `[]`, else null) and is loading exactly when its `when` holds. A binding reading such a resource is early when it also reads one of their statuses (`$meta.<name>.loading`, `.error`, `.loadedAt`, or the whole status); other status fields, and state fields, stay the page module's. The compiler writes that state into the binding's early function, on its syntax tree (strings are left alone): `$.$r.<name>` becomes `[]` (or `null` for one object), `.loading` its `when` from the early table (`!!f[i]($)`) or `true`, `.error` and `.loadedAt` `null`, a whole status a table function's object (`f[i](loading)`: `{ loading, error: null, loadedAt: null, pending: 0, total: null, live: null }`, or for a paginated or stream-fed resource with getters that throw for `total`, `live` and the pager's fields, so a binding that reads one is the page module's), so the early runtime has nothing new. A binding over a resource with `cache`, or one next-page data can serve (the app has `prefetch`; no `body`), first calls a function of the page's early table per such resource that throws when this tab's sessionStorage has an `sn:c:` or `sn:p:` entry of it (the literal start of its `src`, its `select` and `total` paths, as both key their entries): its rows would be there at mount. An embedded resource (`data-sn-resource`, a placeholder `embed: true` adds, a `file:` or `content:` constant; changed 2026-11-21) without `when`, `paginate`, `for`, `call` or an `<sn-event>` feeding it has a fixed status at mount too: `createLoader`'s `start()` stores the payload as its first load, so it is not loading, has no error, and `loadedAt` is the mount's time (`new Date(env.now())`; null for a constant, `fx`); a `refresh` reload is quiet and `versions` changes nothing, so nothing loads at mount. (With `when` falsy at mount the payload is not stored; a pager with `model` may load the page the URL names; an event a stream held before the takeover may refresh it.) Such a binding's early function reads the resource's data first (`$.$r.<name>, ` before the rest, as the checks above: a placeholder the server left empty throws, and the page module requests it) and has `.loading` written as `false`, `.error` as `null`, and `.loadedAt` as `null` for a constant, else `true` where only its truth counts (the operand of `!`, a `?:` test, the left of `&&`, as a list's empty state reads it: `($meta.c.loadedAt && !$meta.c.loading && !$meta.c.error) && !c.length`); a `.loadedAt` read as a value (`date($meta.c.loadedAt)`, the left of `||`) and the whole status are left as written and throw, so that binding is the page module's. So a list's empty state over embedded data, also through a prop or `$slot`, is in the first paint. Any other resource throws in the early scope as before, leaving the binding to the page module; one that throws on every path is not in the early file (see Embedded data renders early). The page module adopts the branch as any early branch.

**Google Fonts (builds, 2026-11-09, `sinter({ fonts })`, on by default).** A page's `<link rel="stylesheet" href="https://fonts.googleapis.com/css…">` is downloaded at build time (as a current Chrome, so the font files are woff2 with `unicode-range` subsets), and the link points at a module the plugin serves it as, so Vite bundles it as one of the app's CSS files; the page gets `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` (the origins in its `url()`s; fonts load in CORS mode). The fonts, their `font-display` and the look are unchanged: the page loses a render-blocking request to another origin and the font files' connection is open when they are requested, as the Angular CLI does by default (its RealWorld demo has the preconnect). A file, not an inline `<style>`: no `style-src` change. Downloads are cached in `node_modules/.cache/sinter/fonts` by URL, so a later build needs no network; one that cannot download keeps the link and warns. Measured in RealWorld (Lighthouse mobile, median of 5): LCP 3.0 → 2.8 s alone, 2.3 s with the split early file (the article title needs both its data and its font). `fonts: false` turns it off (was `{ inline: false }`, 2026-11-20: it bundles a file and inlines nothing; `{ bundle: false }` keeps the links and the preloads). `{ preload: [...] }` (opt-in, decided 2026-11-10): faces to preload, each a family (its regular face, 400 normal) or `{ family, weight, style }`; a page whose Google Fonts stylesheets have the face gets `<link rel="preload" as="font" type="font/woff2" crossorigin>` for its Latin file (the `/* latin */` subset) after `<meta charset>`, in builds and dev. Opt-in, because a preload can make the first paint later: it competes with the render-blocking files, and while it loads, text in that face waits for it (measured by an earlier session in RealWorld: article LCP 1092 → 932 ms with the body font preloaded, Chrome throttled to slow 4G; with the font delayed 1.5 s and no throttling, first paint 80 → 172 ms). Two checks: the build fails when a page preloads a face of a family none of its stylesheets uses (a `font-family` or `font` declaration outside `@font-face` that lists it, or reads with `var()` a custom property whose value lists it, also through other custom properties, in its linked stylesheets, bundled or public, its `<style>`s and `style` attributes), or when no page's stylesheets have the face; in dev, warning 25 when the page did not render with the face in its first frames (3 after mount: a face loads only once something is laid out with it, and its `FontFace` in `document.fonts` stays `unloaded` until then, preloaded or not). Other stylesheets on other origins (an icon font's CSS) are left alone: whether one may be served from the app's origin is the app's decision. **Local fonts (2026-11-12).** Self-hosting is the app's: a local package (Fontsource) instead of the link, whose files Vite bundles as hashed assets (no requests to Google, `font-src 'self'`); sinter does not download Google's font files itself. In builds, a `preload` face no Google Fonts stylesheet has is looked up in the `@font-face` rules of the page's own CSS (linked, bundled or public, and its `<style>`s), after Vite has bundled it: the face with the family, a `font-weight` that is or spans the weight (a variable font's `300 900`), the style, and a `unicode-range` covering the Latin letters (minified `U+00??` too), its woff2 source; a relative URL resolves against the stylesheet. A face of a Google Fonts stylesheet matches the same way (`wght@400..700` is one face spanning the weights). Dev does not preload local faces: their CSS is a module there, not known when the page is served.

**Size.** The build prints each page's early script and the shared one, gzip, and warns above `sinter({ firstPaint: { budget } })` (default 10000 bytes, both together), naming the largest modules: a heavy import in the early module or in a helper an early binding calls is noticed.

**What this asks of markup.** Page chrome renders before the page module only outside data templates: a `data-sn-if="user"` around the navigation hides it until the user has loaded. Keep chrome out of such templates; put only what needs data inside.

### Lazy packages (added 2026-11-11)

Guide: [lazy.md](lazy.md); design: [proposals/lazy-code.md](proposals/lazy-code.md). `sinter({ lazy })` lists package names (`lazyOf` in `project.ts` refuses paths and subpaths; a subpath is covered by its package). Build side `src/lazy-build.ts`, runtime `src/lazy.ts`.

- **Generated modules** under `/@sinter/lazy/`: `<spec>.js` is the loader, `export const load = lazy(() => import('<spec>'), <chunk URL>, import.meta.url)`, one per package specifier, shared by everything that loads it; `<spec>.js?n=a,b` are one importer's stubs, `const $0 = (...a) => load().then((m) => m["a"](...a))`, exported under the package's names (`default` and reserved words included). The stubs carry only the names the importer calls, so no package's exports are read.
- **The transform** (the main plugin's `transform`, before TypeScript is stripped, app modules only: not `node_modules`, not `\0` ids): `scanLazy` parses the module (acorn with the TypeScript plugin) and, for each value import of a lazy package, rewrites only the specifier (lines stay, so no source map). Uses are found by a walk over value nodes (type annotations and TypeScript's type nodes skipped): a namespace member or a named/default import may only be a callee, and the call must be waited for: the operand of `await`, `return`, `yield` or `void`, an arrow function's body, the receiver of `.then`/`.catch`/`.finally`, or an element of `Promise.all`/`allSettled`/`race`/`any`'s array that is itself waited for; through `as`, `!`, `satisfies`, `?:` branches and the right of `&&`/`||`/`??`. Anything else is `SN324` at its offset (all of a module's, in one error). Shadowing is not tracked: a local with an import's name counts as the import. A component script (`src/components/<name>.ts` beside its HTML) is left as written. The helpers module that reaches a lazy package through static value imports (`reachLazy`: relative and root-absolute specifiers, type-only imports and re-exports are no edge) is `SN324` with the chain. `config()` adds the packages to `optimizeDeps.include` (no page imports them statically, so the dependency scan would not find them).
- **`sinter check`**: `lazyDiagnostics` scans the helpers, actions, config and early modules, the component scripts and every app module they import, with the same rules. The language server checks the markup's names only.
- **Chunk URLs**: the loader is written with `"__SN_CHUNK__<resolved id>__"`; the post plugin's `generateBundle` replaces each mark with the path of the chunk whose facade is that id, relative to the chunk the mark is in (`null` when there is none; dev passes `null`). Rolldown may split a package into a facade chunk and a body chunk that a lazy component script shares; the probe asks for the facade, which a deploy removes with the body (both hashes follow the package).
- **`data-sn-import`**: a binding of kind `imp` whose function calls each named loader (`$l$<n>`, imported by the page module) and drops its rejection; `process()` evaluates it once, when the element is rendered, and `write()` has no case for it (no runtime code). Not early, not a build-time constant. **`data-sn-preload`**: `CompileResult.preload`; the post plugin's `transformIndexHtml` writes `<link rel="modulepreload" crossorigin>` for the package's chunk and the chunks it imports, and for the page's lazy component scripts that load with it, before `</head>`; a package no module imports is a warning. Builds only. Both: the names must be in `lazy` (`SN324`, `lazyNames`); testing compiles with `lazy: true` (any name) and binds the loaders to no-ops.
- **Lazy component scripts**: the compiler asks `lazyScript(module)` (the plugin: `reachLazy` from the script); a script that reaches a package is imported as `later(() => import(module).then((m) => m[export]), [package loaders], <chunk mark>, import.meta.url)` instead of statically (`lazyScripts` in `compiler/index.ts`). The components feature sees `a.l`: the root waits in `waiting` with its latest props; when `later()` resolves and the root is still connected, the instance is created and `connected()` runs at once; a failure goes to `app.unhandled` (added to the App interface for features). The build logs each such script once, with its chains.
- **Lazy helper modules** (added 2026-11-15): the compiler asks `lazyModule(module)` for each module that declares a helper (the plugin: `lazyHelpers(root, lazy).reach`, `reachLazy` from the module without the edges of its own re-exports, so the helpers module that re-exports every namespace does not count). Such a module's helpers are called only in lets (`SN324` elsewhere, per call, in the build and `sinter check`), which wait for it (Derived names); the page module loads it as `later(() => import(module), [package loaders], <chunk mark>, import.meta.url)` (`$lh$<n>`) instead of importing it. The transform leaves the imports of the module and of the app modules on its chain to the package unstubbed (`whole`): they load with it, and their calls are synchronous; `lazyDiagnostics` skips them too. Until 2026-11-15 the helpers module reaching a lazy package was `SN324`.
- **SN325** (`guardLazy`, the main plugin's `generateBundle`): from each page module, a walk over `importedIds` (static only). A module under `node_modules/<pkg>/` of a lazy package in that set is an error with the shortest chain; so is an app module in the set with a `dynamicImporters` entry in the set (any app, with or without `lazy`). Early files: a lazy package among an early file's or the shared head script's modules. The page's log line ends with `; lazy: <pkg> n kB gzip, <script> n kB gzip`: each lazy package or lazy script chunk a chunk of the page imports dynamically, with the chunks it imports that the page does not load (packages counted first).
- **Stale**: `lazy()` caches the import's promise and drops it on failure, then `loadError(e, url)`: `fetch(url, { cache: 'no-store' })`; a 404, a 410 or a 2xx that is not JavaScript is `new SinterError(null, null, 'this page is out of date: reload it', null, true)`; a network failure `status: 0`; any other status that status; JavaScript: the module threw (`status: null`). `SinterError` has `stale` (default false, the fifth constructor argument). The call feature probes an `import()` of the app's that fails inside an action when the browser's `TypeError` names the module (`dynamically imported module: <url>`; Chromium, Firefox; not Safari), which costs the call feature 288 B gzip (365 → 653 B).
- Deviations from the proposal: no preload links in dev (the pre-bundled module's URL is not known to the HTML transform); `void` counts as waiting (an explicit discard); `vite:preloadError` is not used (the error's own URL is); the static-and-dynamic rule of `SN325` applies to every app; testing's `render()` needs nothing for lazy scripts (tests pass the class).

## Expressions and scope
Every attribute value that is not a URL or a name is a JavaScript expression, parsed by a real JS parser at build time and checked against a closed set of identifiers.

### Two kinds of expression

| Kind | Used in | Allowed | Refused |
| --- | --- | --- | --- |
| Value | `text`, `attr`, `class`, `show`, `with`, `for` (after `in`), `if`, `key`, `body`, `state`, resource `when` and `paginate`, `<sn-event>` `value` and `when`, URL interpolations | any JS expression, `new` on allowed globals, arrow functions as arguments, template strings, `?.`, `??` | assignment, `++`/`--`, `delete`, `await`, `import()` |
| Handler | `on-*`, `then`, `catch`, `optimistic`, `<sn-event>` and `<sn-resource>` `then` | statements separated by `;`, assignment to state variables, calls to store functions (actions run through `run('id')`) | declarations (`let`, `const`, `function`), loops, `await` |

Value expressions must be side-effect free, so the runtime may evaluate them any number of times.

### What belongs in markup
Markup holds filters, conditions, single assignments and short calls. Logic goes into a helper when it computes a value (pure: same arguments, same result, nothing else read or changed), or into an action when it has side effects (`data-sn-call`, see Local actions). A handler then applies the result to state, `state = fn(…)`, and does the rest in a few short statements:
```html
<li data-sn-on-click="sel = rowClick($event, sel, f.id, ids)">        <!-- not: four lines of if/else on $event.shiftKey -->
<input data-sn-on-keydown-enter="d.tagList = withTag(d.tagList, tag); tag = ''">
<button data-sn-on-click="open && closeDialog('detail')">                  <!-- a guard over one step -->
```
- A helper is a plain function in the helpers module, so it is unit-tested without a page; the page's test checks that the handler applies it (recipe: row selection).
- One condition per step: `a && (b = null, closeDialog())` is two steps behind one guard; write the steps as statements (`a && closeDialog()` plus `data-sn-on-close="b = null"` on the dialog), or compute the new state in a helper.
- Warning `SN507` flags what has outgrown markup: long handlers, comma sequences, guards over several steps, deep `?:` chains, long or block-bodied arrow functions (see Complexity).

### Identifier resolution
A free identifier resolves to the first match, innermost first:
- Loop variables of enclosing `data-sn-for` (and their index, e.g. `(c, i) in contacts`).
- State variables declared by the nearest enclosing `data-sn-state`.
- Resource names declared on the page.
- Magic names: `$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`.
- Registered helpers, helper namespaces and the store functions (`refresh`, `upsert`, `merge`, `remove`, `page`, `openDialog`, `closeDialog`, `closePopover`, `emit`, `run`, `navigate`).
- Allowed globals (below).
Anything else is a build error with a suggestion: `contcts` → "did you mean `contacts`?".
Globals: JavaScript yes, browser no. Expressions may use the ECMAScript standard library, including `new`: `Math`, `JSON`, `Object`, `Array`, `Set`, `Map`, `Date`, `Intl.*`, `RegExp` and the rest. Three pure web-platform utilities are allowed as well: `URL`, `URLSearchParams`, `structuredClone`. Forbidden are browser and I/O APIs (`window`, `document`, `fetch`, `localStorage`, `navigator`, timers, …) and the language's meta-tools (`eval`, `Function`, `Proxy`, `Reflect`, `globalThis`, `WeakRef`, `FinalizationRegistry`, `Atomics`). Browser work belongs in custom elements. `$el` and `$event` are handed in explicitly, so their properties and methods may be used: `$event.preventDefault()`, `$el.focus()`, `$el.form.requestSubmit()`.
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
| `date(v, style, timeStyle)` | `Intl.DateTimeFormat` with the current locale (`dateStyle`, `timeStyle`; `style` `null` leaves the date out; one function since 2026-11-20, was `date`, `time`, `datetime`); `date` of a calendar date (`YYYY-MM-DD`) with `timeZone: 'UTC'` (added 2026-11-11) |
| `relative(v)` | `Intl.RelativeTimeFormat`, e.g. "3 days ago" |
| `number(v, opts)`, `bytes(v)` | `Intl.NumberFormat`, file sizes |

Each built-in builds its `Intl` formatter once per locale and options and reuses it (building one costs far more than formatting with it); a locale switch reads another entry, so nothing goes stale.

User helpers live in one module (`sinter.helpers.js` or `.ts`) whose export names the compiler reads; type-only exports are not helpers. A helper must be pure.

**The helpers module in Node** (added 2026-11-15, `src/helpers-node.ts`, `src/fold-check.ts`): so that a helper call over build-time constants can run at build time (below), the build, the dev server, `sinter check` and the language server load the helpers module in Node before compiling, and pass it to `compile()` (`helperValues`), which stays synchronous. It loads through Vite with the app's config, so aliases and plugins apply: in dev by the dev server's SSR environment (`ssrLoadModule`), elsewhere by a Vite server of its own over the app's config file (middleware mode, no HMR, watcher or dependency scan), in which sinter's plugin is inert (`loadingHelpers()`); a Vite started with an inline config (`configFile: false`) passes its resolved aliases instead. `sinter render`'s private server (`configFile: false`) is not used for this. A module that throws while it loads there folds nothing: warning SN533, once per build or session. A module that imports a stylesheet or an asset loads as it does in the app (Vite's CSS plugin is set up for the module runner, which has no client to start it). For the static check, a stylesheet or asset imported for its effect (`import './card.css'`) is an empty module and `?raw` is the file's text, the same in Node and in the build; any other value one gives (an asset's URL, `?url`, `?inline`, a CSS module's class names) is the build's own, hashed or processed, and a helper that reaches one does not fold ("its value is the build's own …", naming the file). A side-effect import of a JavaScript module runs its top level only. The dev server loads it again after a file the static check read changes; the language server reloads the project, as for the helpers module itself.
- **What may fold** is decided from the code, per exported function (`foldVerdicts`, `helperFold` in `compile()`): the function, the functions it calls, the module-level code of every module on the way, through imports and re-exports, may read only ECMAScript's deterministic globals (`FOLD_GLOBALS`: `Object`, `Array`, `Math`, `JSON`, `Map`, `Set`, `RegExp`, the errors, typed arrays, `parseInt` and the URI functions, …) and five web-platform utilities that behave the same in Node and browsers, `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams` and `structuredClone` (added 2026-11-15; the last three are the ones expressions allow, Globals above), not `Date`, `Intl`, `Math.random`, a member `toLocale*` or `localeCompare`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `import.meta.env`, `import()` or `with`; any other name (`globalThis`, `self`, `window`, `document`, `process`, `fetch`, timers, `console`, `require`) stops it. Also refused (2026-11-15, from review): `import.meta` in any form (`new URL(s, import.meta.url)` bakes in the build machine's path), member access to `.constructor` and `__proto__` (`[].constructor.constructor('…')()` is `Function`), `Math` and `Reflect` other than as the object of a non-computed member access (`RESTRICTED`: an alias, a destructuring, a value passed on reaches `random` under another name), `.stack` of an error (one constructed in the expression, a catch parameter, a variable initialized with one), and a function that assigns to or updates a module-level binding itself (`count++`, `count = …`). State kept inside an object (a table of ids in a `Map`, a counter in a member, reached however: an alias, an import, `Object.assign`, a computed method name) is not read here: what reads the same may be a pure cache or a parser resetting a regex's `lastIndex`, and the reading would lose that race. The build's cross-check (Folding, below) finds it by running the calls again. **The check is a guard against mistakes, not a sandbox**: it is a reading of the code for the common ways a call differs between the build and the browser, and code written to evade it can; helpers run in the build with the build machine's access, as plugins and dependencies do. Names resolve in lexical scope, so a local named like a global does not count. Imports follow the app's aliases into app files, and packages resolve by their `exports` with production conditions (`production`, `node`, `import`, `module`, `default`; never `browser`), then `module`, then `main`, the same in dev and in the build. Code a plugin generates (a virtual module) cannot be read, so it does not fold. The verdict names what stops a helper, where, and the chain of functions (`foldReason`), for SN322 to name later. Per-module analyses are cached by file, mtime and size (`FoldCache`), which the language server keeps across reloads.
- **Folding** (added 2026-11-15, `helperCalls` in `compile.ts`): in `prerender`'s evaluator (bindings, state initializers, and the rows, choices and conditions step 7's worklist evaluates; never handlers, actions or `then`), each app helper the verdict lets fold, with the module loaded, is the real function behind a wrapper; the others, the built-in formatters and messages keep their stubs, which throw `NOT`. The wrapper refuses arguments that are not plain data, runs the call, refuses a result that is not plain data (JSON values, `undefined` included), and runs it again and refuses a different result (`JSON.stringify`), in every build (a production build too: a counter in an object, `uid('f')` twice on one page, is found there and nowhere else). A page's calls are kept by helper and arguments (`FOLD_MEMO`, by the helpers module's values and the page's file, the arguments keyed one to one by `dataKey`: its passes and the worklist evaluate a let many times; on a library package's fixture page its parse ran 15 times per page, now once, and a 25 kB article's build went from about 6.0 to 4.3 s). A memoised result is one frozen value per page and arguments: the identity of a helper's result is not part of its contract (`tags(s) === tags(s)` holds over constants and not in the browser), only its value. **The build's cross-check** (`fold-cross.ts`, added 2026-11-15 from review): in a production build, the compiler also reports each distinct call that folded, once per page, with its arguments and its result (`foldLog`): an argument that is another call's result, by that call's id (`{ r }`: a parse tree passed to `headings()` is not kept twice, and its call runs again first), and the result tagged (`resultKey`: `undefined` is a result like any other), of which the plugin keeps only a SHA-1 (a page's parse tree adds up over a site). At the end of the build (`buildEnd`, the client environment's; an SSR environment beside it compiles no page), the plugin loads the helpers module again in a module runner of its own with `ssr.noExternal`, so the module and the packages it imports are fresh instances, not the ones Node's module cache shares, and runs every page's calls again, the pages in reverse order. A result that differs fails the build (SN534 as an error, naming the helper, its arguments, the page and the fresh result): one instance shared by the build's pages hands each page what the page order made of state kept between calls (a table of ids gave three pages 2, 3 and 1, where each gives 1 in the browser). A module that cannot be loaded again is a warning that the check did not run. Cost, measured on a library package's fixture page and a 25 kB article (4 builds each): loading the fresh instance 74 to 109 ms per build, and the calls once more, 6 to 22 ms (fixture) and 91 to 139 ms (article). Memory, on a site of 100 pages of 20 kB of source text each (this machine; peak RSS): 1,130 MB before the cross-check, 1,553 MB keeping each result's JSON and arguments, 1,157 MB with hashes and references. Every build loads the helpers module afresh at its start (`buildStart`): under `vite build --watch` an edit to the helpers counts, and nothing a helper kept, nor the memo (by the instance), carries over from the last build. Helpers load in a module runner (`createRunnableDevEnvironment` over the app's resolved config), not a dev server: the app's `configureServer` hooks never run (a mock API's timer kept `vite build` from exiting); a refusal is warning SN534 at the call's site (`codeAt`), once per call and helper, dev builds only, and the call stays in the browser. A helper's own exception is that; a `NOT` thrown from inside (it read a value that is not constant) is passed on. The result is frozen and copied (`structuredClone`) before the evaluator uses it. A helper of a module that reaches a lazy package never folds (dev runs it over stubs). A waiting let's wrapper (`$.$w`) runs its expression directly in the evaluator. A memoized helper (`memo()`) folds as the function it calls does: the fold check reads `export const parse = memo(parseDocument)` as a function of its own (`memoOf` in `fold-check.ts`), and the build's cross-check still finds state the function keeps between calls; `render()`'s helpers check the function a memoized one calls (`MEMO_OF`). A binding whose evaluation reached a helper that may not fold records why (`foldWhy`, by code), and SN322 names the call and `foldReason` beside the binding (`whyNotFolded`, also through the rows of its templates and its state). `$locale` counts as known and fixed when helpers are loaded: namespace members depend on it (i18n libraries are namespaces), and whatever really reads the locale throws in the evaluator. A helper none of whose calls is left for the browser is not imported. What folds is written into the HTML as any constant. A state field a helper call computed that something in the browser still reads (a binding that does not fold) is written once into the head as `<script type="application/json" data-sn>` and read from there (`embedFolded`: its expression in the state's initializer becomes `$.$d(id)`, which the runtime and the early scope parse, a fresh copy per read); after `dropConstants`, only the values a live function reads are written (`foldScriptsOut`). The helper is then in neither the page module nor the early file. A helper of a module that reaches a lazy package never folds, and SN322 says so, also for a waiting let (`$z` in the evaluator records it).
- **Testing**: `render()` and `firstPaint()` pass their helpers as `helperValues`, and each one's verdict from its own source (`functionVerdict`: `toString()`, parsed as a function or a method; a name from outside the function, a closure variable included, does not fold).
Helper namespaces. The helpers module may re-export a whole ES module as a namespace, e.g. `export * as m from './paraglide/messages.js'`. Templates call its members like functions: `m.inbox_title()`, `m.items_count({count: n})`.
- The compiler resolves `m.<name>` statically, following `export * from './…'` re-exports (relative paths only). An unknown member is error `SN206` with a suggestion.
- The page module imports only the members it uses, so unused ones (e.g. messages) are tree-shaken; it imports each from the module that declares it (`HelperManifest.from`), as the early file does, so the helpers module and barrels are not loaded with the page (added 2026-11-15).
- Members must be named literally; `m[key]` is refused. A dynamic choice goes in a helper.
Any ESM module works as a namespace this way, an i18n library's message functions included. The messages (next section) are a content namespace, `m` by default.
Locale. The locale `$locale` and the built-in formatters read, the first that applies (changed 2026-11-26, sinter-alloy S15): the app's source, `configure({ locale: { get, set } })`; the page's language with `languages()`/`localePrefix` (`$lang`); in an app that sets no locale, the page's literal `<html lang>` or its layout's (`$lang`, at build too); else none (the engine's default, `$locale` undefined). The build decides "the app sets a locale" from the config and early modules and the app modules they import (`configuresLocale` in `project.ts`: a `locale` key, an assignment to `.locale`, a `configure()` whose options are no plain object literal, a module it cannot parse), and then formats nothing in `<html lang>` (`appLocale`). A `lang` a `data-sn-attr` may set (on `<html>` or a layout's tag) or one `Intl` refuses is not used. A page sets it only when it reads it (a built-in formatter, `$locale`, a component's script). Dev builds record text formatted in `<html lang>` (`IR.lf`), and warning 35 names the fix when the app's source says another locale at mount. `$locale` reads the source; assigning `$locale = 'de'` in a handler calls `set` and re-runs every locale-dependent binding: those that call a namespace member or a `date`/`number` helper. With `inlang()`'s messages the page's language is the locale source.

### Messages
The messages are a content namespace (docs/proposals/messages.md, built 2026-11-21): `inlang()` in `@tiaforge-ui/sinter/messages/content` reads an inlang project's message files (format 4: nested keys, complex messages with plurals and selectors, formatted placeholders, several `pathPattern`s), so the inlang tooling keeps working on the same files. Until 2026-11-21 sinter read them itself (`sinter({ messages })`, plain strings only, `src/sinter.messages.d.ts`); that path is removed (SN348), and `sinter migrate` writes the content module's part.
- Source: the content module, `export const messages = inlang()` (namespace `m`) and `export const locales = languages(({ root }) => inlangLocales('project.inlang', root))`. Loaded per language (`perLocale`), or per tenant and language with `per` and `tenantFiles`.
- Markup: `m.inbox.title()` and `m.key({ param })`, as any content namespace: an unknown key is `SN206` with a suggestion, wrong or missing parameters are `SN208` in `sinter check` (types from the base language's entries, `messagesType`). The helpers module must not export a namespace `m` as well.
- App code: `import { m } from '@tiaforge-ui/sinter/messages'` (the namespace's `module`), typed by the generated `sinter.namespaces.d.ts` next to the content module, which fills the module's `Entries` interface (`writeNamespaceTypes`, on every load that worked). Only `m.key` is allowed: `m[key]`, `m` passed on or aliased are build errors with the position, because each page carries only the keys it uses (`moduleKeys`).
- A missing translation is its chain's (`de-AT`, `de`, the base), reported (SN522) when it reaches the base.
- A page has one language, chosen at build (decided 2026-11-21, docs/proposals/axes.md §7): with `localePrefix` its point's, else the content module's base. The compiler gets it as `locale` (`prefix: false` without `localePrefix`) and the namespace's entries in that language as `contentNs.m`: a call over constants is folded with the formatter (`format`), one over data is compiled into the page's script with that entry alone (a plain text by the formatter's `inline()`, else the entry and an import of `@tiaforge-ui/sinter/messages/format`), and the entries the page's bundled modules and early file call are written into its head as `<script type="application/json" data-sn-ns="m">`, packed by the formatter's `pack()` (a plain message is its text, `{"bye":"Bye"}`) with the page's `lang`, which the namespace's module reads on its first call (no page module calls it); a swap merges the next page's (`inline`). Nothing is loaded for a language, and nothing waits for a dictionary.
- `$locale` is the page's language and cannot be assigned (`SN203`). Until 0.20, a build without `localePrefix` picked the language in the browser; removed with the axes work.
- Testing: `render(html, { messages: { en: {…}, de: {…} }, locale })` and `firstPaint(html, { messages, locale })`: the namespace `m` from those files, the page compiled in `locale`, else the base.

**Cost when unused.** An app without `inlang()` pays nothing: the messages module is imported only by pages and modules that call `m`, and the core runtime has no i18n code path.

### Derived names
`data-sn-let` names values computed from state, resources and loop variables, for the element and its subtree:
```html
<div data-sn-let="{ hits: suggestions(contacts, q), n: hits.length }">
  <ul data-sn-show="n"><template data-sn-for="h in hits">…</template></ul>
</div>
```
- Each entry is a value expression; later entries may use earlier ones.
- A name is compiled into every expression that reads it, so it is always current, costs no runtime and is tracked like the expression itself; handlers see the value at the time they run. A helper call in it is a call at every read: a binding, a handler, a listener, each row (a parse that three bindings read runs three times). An expensive helper is the app's to keep: `memo()` from `@tiaforge-ui/sinter/memo` ([expressions.md](expressions.md#memoized-helpers)), `export const parse = memo(parseDocument)` in the helpers module, which keeps results by arguments, copies object arguments, freezes and shares its results, and folds at build time as the function it calls does. A cache inside the framework was built (2026-11-15) and taken out again (2026-11-16): the proposal's step 10, as built, says why.
- **A let may wait for a lazy helper module** ([lazy.md](lazy.md#helpers-that-wait)): a call of a helper whose declaring module reaches a package of `lazy` becomes `$.$z(<module>, "<export>")`, which starts the module's load (a function of the table, `IR.lm`) and throws a marker; the let's expression is wrapped in `$.$w(() => …)` (`lets.ts`, loaded only by pages with such a let), which catches it: the let is `undefined`. Its arrival marks `$lz.<module>`, one more dependency of the let. `sinter check` declares the let `T | undefined` (`$waits()` in the shadow file), and checks with the app tsconfig's `strictNullChecks` (`markupOptions` in `check/index.ts`; off without a tsconfig), so an unguarded read is reported only then; the docs recommend guarding every read (`data-sn-if`, `?.`, `??`). A failed load takes the unhandled-error path, once, and the let stays `undefined`. Elsewhere such a call is `SN324`. Not early.
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
| `draft.notes.sort(cmp)`, `Object.assign(draft, …)`, an unknown method | `draft.notes` (list structure), `draft` (the object as a whole) |
| `helper(draft)` | nothing: a helper changes none of its arguments (below) |

Each binding lists the paths it reads. A binding re-runs when one of its paths and a dirty path are prefixes of each other. `data-sn-model` on a path invalidates that path the same way.
Method classes. Known read-only methods (`includes`, `map`, `filter`, `slice`, `find`, `some`, …) invalidate nothing. Known mutators (`push`, `pop`, `splice`, `sort`, `reverse`, `shift`, `unshift`, `fill`; `add`, `delete`, `clear` on `Set` and `Map`) and unknown methods invalidate the receiver's path. Store functions only read their arguments. A helper changes none of its arguments, in a handler as in a binding (changed 2026-11-27: until then a helper called in a handler could change a state argument, `sortInPlace(tasks)`, which counted as a write of the argument's root; that missed a change below a list's element, `bump(ys[0])`, which the rows do not read, and covering it would have cost every helper call its precision). A helper call writes nothing; to change state in place, the handler uses the method itself, which the compiler sees (`tasks.sort(cmp)`, `ys[0].n++`), or assigns a helper's result (`tasks = sorted(tasks)`). Enforced in two layers. The build reads the helpers' modules (`helper-writes.ts`, beside `fold-check.ts`, which resolves them) and finds, per parameter, the writes into it it can be sure of: an assignment, compound assignment, `++`/`--` or `delete` on a member whose chain starts at the parameter (not reassigned anywhere in the function, not shadowed where written), directly, through a `const` initialized with such a chain (`const items = p.items`), a `for (const x of p.items)` variable or the element parameter of an inline `forEach`/`map`/`filter`/… callback over such a chain; a mutating method on such a chain (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`, `set`, `add`, `delete`, `clear`); `Object.assign(<it>, …)`; and a call that passes the parameter (or such a chain) to a function of the modules that writes the parameter it lands in (a fixpoint over the calls, through imports and re-exports). A call in the page that gives page data (state, a resource, a let or prop that does not read `$el`, a row's item, a callback's element of such) to such a parameter is error `SN214`, in a binding as in a handler, naming the write's place; an element, an event, a literal or a copy (`[...xs]`) is not page data, so a helper that scrolls or focuses what it is given is not reported. Testing's `render()` reads each helper function's own source the same way. What the build cannot see (a write through a function the helper is given or calls as a value, a destructured parameter, a getter) the dev build reports when it happens: in a dev page module a helper call in a handler is `$.$hc(f, "name", [argument texts])(…)`, which snapshots its object arguments (plain objects and arrays, bounded at 20,000 values as the write check is), calls the helper and names each path it changed (warning 37: ``helper `bump` changed `ys[0].n`, which a helper may not do: … ``); the write check's warnings 36 and 15 do not report the same change again at the next flush. A production page module calls the helper directly. A helper's change in a binding, or on a code path no dev session ran, stays unreported.
Aliases (added 2026-11-21). State that holds one of the page's objects is an alias of it: `sel = row` in a row's handler, `sel = tasks[i]`, `box.it = y`, `box = { it: y }`, `list.push(y)`, `Object.assign(o, { y })`, `merge(t, { y })`, a field initialized with a prop or a resource's item. The compiler records every alias any handler or state initializer of the page makes, with row indexes as wildcards (`sel` may be any row of `tasks`), and a compiled write through either name also marks the other's path, both ways and through chains of aliases: after `sel = row`, `sel.done = true` marks `tasks.*.done` (the rows over `tasks` and every let that reads it), and `tasks[i].done = true` marks `sel.done`. A write that changes an object as a whole (an unknown method, `Object.assign`) marks everything under each alias inside it; a list's order (`push`, `splice`, `sort`) changes no object in it. A helper's result is fresh or holds objects found in its arguments, at any depth: `sel = pick(tasks, i)` makes `sel` an alias of anything under `tasks`. A `data-sn-let` (and a prop) holds what its value expression may hold, a `data-sn-for` item over a list that is no state path (`x in visible(tasks)`, a resource) an element of what the list may hold, and a callback's parameter over such a list (`visible(tasks).map((t) => t.part)`) the same (changed 2026-11-27): `sel = row` with `row` such an item marks what `visible`'s argument may hold. What a handler's `$event` holds is decided by what the page's code can send (changed 2026-11-27, src/event-senders.ts): the build reads every module the page loads (the helpers, actions, config and early modules, the scripts of its components, its own `<script>`s, through every import, into packages in their browser and Node builds and the files a `browser` field swaps in) and finds each place that makes an event. A DOM event's `$event` (`click`) holds none of the page's objects, and another event's `$event.detail` is what the page's `emit()`s of it pass (`compose = $event.detail` aliases what `emit('compose', draft)` gave), when every event of that name the modules make carries no detail or a primitive one (a literal, arithmetic, a comparison), with a literal name. What the build cannot read or follow makes that name untraceable (`new CustomEvent('pick', { detail: item })` in an app's module) or every name (a module it cannot find, an event named by a value, a class that extends an event's, `createEvent()`, a `detail` assigned or set by `Object.assign()`, an event class taken as a value, a script of another origin, an import map). sinter's own modules are not read: their events are `emit()`'s, which the compiler reads in the markup, and its own (`sn-*`). A DOM event's name that the page sends too (an `emit('click', …)`, a component that declares it) has the detail its `emit()`s pass. The Vite plugin and `sinter check` read the modules (`CompileOptions.eventSenders`, from the project); `compile()` without it, and `render()` without `events`, read none, so there every `$event` is untraceable. A script added to the page after sinter compiles it (another Vite plugin's `transformIndexHtml`) is not seen. An alias the compiler cannot follow is untraceable: `reduce()`, an unknown method's result, a function, the fields of a component with a script whose script the build cannot show keeps none of the page's objects in them (changed 2026-11-27, src/script-values.ts): it reads the script, and its state is no alias when every use of `this.state` is a write of an allowed value to one field (`this.state.dragging = true`, `this.state.cp = structuredClone(this.props.item)`) or a read of one field where only a primitive comes out (a comparison, arithmetic, a test), and `this` itself never leaves (passed, stored, read by a computed key). Allowed values: primitives (literals, arithmetic, comparisons, `!`, templates, `String()`, `Number()`, `Math.*()`), fresh values (object and array literals of allowed values, `structuredClone()`, `JSON.parse()`, a new `Map`, `Set`, `Date`, `URL`) and a `const` of the module declared once with an allowed value; the same rule decides an event's detail made in a module (a component script's `this.emit('media', media)`). A script the build cannot read (`render()` gives its class, whose code it reads) keeps its fields untraceable. `sinter({ explainWrites: true })` reports each untraceable alias that makes handlers mark everything (SN548). A write through an untraceable alias marks every state scope of the page (and every resource, for a store function's write), and any change inside an object marks everything that reads an untraceable alias. A write through state never reaches a resource through an alias (changed 2026-11-27): resource data is read-only (SN205, frozen in dev builds), so `sel = row` over a resource, then `sel.done = true`, changes no resource object; only store functions (`merge`, `upsert`, `remove`) do, and they mark the resource and, through aliases, the state that holds its items. Fields that only ever hold primitives are no aliases: a field whose initializer and every assignment is surely a primitive (a literal, arithmetic, a comparison, a template, `.length`, `String()`, a string method, `$event.target.value`) and nothing writes below, as `next` in `data = rows(next, 1000); next += 1000`. Fresh values hold none of the page's objects either: `structuredClone()`, `JSON.parse()`, a literal of primitives, `$result`, `$error`, the detail of sinter's own events (`sn-error`), and a DOM event's `$event` as above (`sel = rowClick($event, sel)` aliases only `sel`). What the compiler adds is decided at build time, into each handler's written paths; the runtime does nothing new. Before, a write through an alias marked only the alias's path: a row binding over the aliased item kept its old value (`sel = ys[1]; sel.n = 50` left the row showing 2).
Rows. A row re-evaluates only if its item object was replaced or its own path is dirty. Only the whole-root fallback checks every row. A write through the row's own element (`draft.emails[i].value = x`, `i` the list's index, a `{$i<tid>}` segment) reaches the row at that index only: the walk visits that row and skips the others without checking them (IR v2, added 2026-11-09), unless the list was reconciled since its rows were last all walked; then every row is checked as before. Typing in one row of a 20,000-row state list costs what it costs in a 10-row list (0.006 ms in the runtime benchmark, against 2.9 ms before). A write into another list indexed by the row's index (`other[i] = x`) still checks every row.
Default keys. Without `data-sn-key`, a `for` over resource items keys by the resource's `key` fields. A list the compiler cannot trace to a resource (a helper's result, `t in visible(tasks, q)`) keys each item that is a keyed resource's current item by that resource's key, at runtime, so a patch (which replaces the object) keeps the row. A `for` over a state array of objects keys by object identity (an internal id per object via `WeakMap`), so `splice` never re-binds rows. A list chosen between resources (`$url.feed == 'following' ? feed : articles`, the same choices as Reserved space: `?:`, `||`, `??` and `data-sn-let`s, and `filter`/`slice`/`toSorted`/`toReversed` of one or a helper given one, the sources `merge`/`remove` resolve, `listOf`) keys by their key fields when every candidate has the same ones (added 2026-11-20; before, such a list keyed each current item as a helper's result does, by resource and key, so switching from one resource to the other rendered a row shown in both again); an item without those fields (a helper's own object) keys by identity. A string, number or other primitive keys by its type and value and its occurrence among equal values, `['a', 'b', 'a']` keying `a`, `b`, `a`·1 (added 2026-11-20; until then arrays of primitives needed `data-sn-key`, `SN103` `missing-row-key`, reported only for a literal array, `Object.keys` and `split`, while one from a resource, `a.tagList`, was keyed by value at run time with a dev warning, and duplicates were a second dev warning). Keyed by occurrence, duplicates need nothing of the author: reconciling `['a', 'a', 'b']` to `['b', 'a', 'a']` moves `b`, and removing one `a` removes the last row of that value; equal values render alike, a row's index is set again when it moves, and state inside a row stays with its occurrence. The type of the items is not needed at build time: the runtime tells primitives from objects per item, so untyped data, a mixed list and a helper's result key the same way. An explicit `data-sn-key` is used as written (duplicates there stay a dev warning). `SN103` is retired.
Writes from outside handlers. State changes through handlers, models, actions and a component script's `this.state` (which marks the field it writes), all of which the compiler sees: a field none of them writes is a build-time constant (see Build-time constants). There is no other way in: the instance has no state handle (removed 2026-11-11: `app.state(el).update()` wrote fields the build had made constants, and nothing followed). Dev builds snapshot each state root after every flush and warn when a root changed without invalidation ("state `draft` changed outside sinter: write it from a handler, or a component script's `this.state`"). They also check each write at path level (warning 36, added 2026-11-27): when a flush starts, every concrete path of the state that changed since the last one (a value replaced, a key added or removed, inside plain objects and arrays; frozen values, such as resources' items, and other objects by identity; getters not called) must be reached by a path marked since, `*`, `#`, `~` and an unfilled `{name}` standing for any segment and `**` for any rest, as the reach does; a change below a list's element is not reached by a write above the element (changed 2026-11-27: a row renders again when its item is another, not when the list was written as a whole, so `xs` written and `xs.0.n` changed in place is reported). One that is not names the path, what was marked and the handlers that ran (`a write changed \`ys.0.n\`, which nothing it marked reaches (it marked \`k\`) …`): a write sinter cannot see (a custom element that changes an object it was handed) or an alias the write analysis missed. For it a dev page module's path table carries its segments' names (`ps.n`); a production one does not. The reactivity fuzz uses it as an oracle. Testing's `render()` has `state(el).update(fn)`, which marks the whole scope and refuses a field in `fixedState`, the fields the build made constants.
Resources are read-only in expressions. Assigning to, or calling a mutator on, a value rooted in a resource is error `SN205`, including loop variables over resources; the message shows the `merge()` equivalent. So is a write in place into state that may hold resource data (added 2026-11-27): `sel = row`, then `sel.n = 9`, `sel.tags.push(x)`, `Object.assign(sel, …)` or `data-sn-model="sel.title"`, which would change the resource's own object (production builds do not freeze it: the page's reads of the resource would keep the old value, and the next `merge()` of the item would take the change in). The build follows the data from the resource through state, loop variables over it, `data-sn-state` initializers (a component's from a prop) and the details of `emit()`s; assigning the field again is no write in place. A helper's result is not followed (a draft a helper builds from an item's fields is fresh), and neither is a value the build cannot trace: those are left to the dev builds' freeze. To edit resource data, copy it with `structuredClone(c)`, which returns unfrozen plain data (a spread, `{ ...c }`, where one level is enough).
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
| `data-sn-with` | object literal | sets JS properties; custom elements only |
| `data-sn-model` | state path, or `$url.<param>` | two-way binding for form controls (see below) |
| `data-sn-for` | `item in list` or `(item, i) in list` | on `<template>` only |
| `data-sn-key` | value expression | optional; defaults to the resource key (also through a choice between resources with the same key), object identity, or the value and its occurrence for primitives; see Default keys |
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
| `data-sn-post`, `-put`, `-patch`, `-delete` | URL template | one per element; a GET is a resource |
| `data-sn-call` | one call of an action, `ns.fn(args)` | a local action instead of a request (see Local actions); one action per element |
| `data-sn-body` | value expression | JSON body; overrides form serialization |
| `data-sn-trigger` | DOM event name | overrides the default trigger |
| `data-sn-debounce` | duration (`300`, `300ms`, `2s`) | delays the action's trigger, resets on each event; without an action `SN102`, naming `data-sn-model-debounce` for a model and the `data-sn-debounce-<event>` attributes for the element's handlers |
| `data-sn-model-debounce` | duration (`300`, `300ms`, `2s`) | delays the element's `data-sn-model` write (added 2026-11-19 as `data-sn-debounce` on a field without an action; its own name since 2026-11-20, so adding an action does not move the delay): the field shows the keystrokes at once; the write is no keystroke, so a resource over it loads at once and a model on `$url` pushes one entry, with no second pause; a text field's `change` writes at once, synchronously; not on a component's tag (`SN102`) |
| `data-sn-debounce-<event>` | duration (`300`, `300ms`, `2s`) | delays the `data-sn-on-<event>` handler (it runs with the last event; `data-sn-model` still updates at once), e.g. `data-sn-debounce-input="200"` next to an immediate `data-sn-on-blur` |
| `data-sn-concurrency` | `block`, `queue` or `latest` | what a trigger does while the action runs; default `block` for forms, `queue` otherwise |
| `data-sn-optimistic` | handler expression | store changes applied before the request; sees `$event` as the body does (added 2026-11-26: was `SN201`), so an action on a component's tag reads the triggering event's `$event.detail` |
| `data-sn-then` | handler expression | runs after a 2xx response, `$result` = parsed body |
| `data-sn-catch` | handler expression | runs after an error, `$error` = error object |
| `data-sn-confirm` | value expression | a question asked before the action runs; no request when the answer is no, no question when the value is falsy |
| `data-sn-encoding` | `form` | the body is sent as `application/x-www-form-urlencoded` (see Request body) |
| `data-sn-write-through` | `off` | turns write-through off for this mutation (see Write-through) |
| `data-sn-options` | the `id` of a list, or empty | keys move a mark through the options (see Lists you move through with the keys) |
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
- **Debounce.** `data-sn-debounce-keydown-j` delays only that filter's handler; `data-sn-debounce-keydown` only the plain one. `preventDefault()` is called at once.
- **Types.** `sinter check` types `$event` in a key filter as the `KeyboardEvent` of its `keydown` or `keyup`.
- The runtime part is a feature module (`@tiaforge-ui/sinter/runtime/keys`), imported only by pages with a key filter. A custom event named `keydown-…` or `keyup-…` cannot be handled with `data-sn-on-*`.

### Declaration elements

| Element | Attributes | Notes |
| --- | --- | --- |
| `<sn-resource>` | `name`, `src`, `call`, `for`, `key`, `select`, `total`, `order`, `when`, `cache`, `then`, `type`, pagination attributes | see Resources and Pagination |
| `<sn-sync>` | `src` | one server event stream |
| `<sn-event>` (child of `<sn-sync>`) | `name`, `resource`, `op`, `value`, `when`, `then`, `type` | maps one server event to a change message, and runs `then` after it |

Custom elements with a hyphen are valid HTML, so these pass a validator before compilation.

### URL templates
URLs are literal strings with `{expression}` interpolations. Each interpolated value is passed through `encodeURIComponent`.
```html
<button data-sn-delete="/api/contact?account_id={c.account_id}&uid={c.uid}">Delete</button>
```
A query parameter whose whole value is one interpolation that evaluates to `null` or `undefined` is left out, with its separator: `/api/articles?tag={$url.tag}&limit=10` requests `/api/articles?limit=10` when there is no tag. An empty string is still sent (`tag=`). (Added 2026-11-04.)

A query parameter whose whole value is one interpolation that evaluates to an array is sent once per item, as a repeated key, each item URL-encoded: `/api/search?q={q}&cal={cals}` with `cals = ['a', 'b']` requests `/api/search?q=…&cal=a&cal=b`, as `data-sn-encoding="form"` sends an array in a body. `null` and `undefined` items are left out, and an empty array leaves the parameter out like `null`. In the path an array is refused: the request is not made and the error takes the resource's or action's error path (`refused an array as a URL path value`), and `sinter check` reports it (`SN208`, the value must fit `PathValue`: anything but an array). An array that is only part of a query value (`?tags=t:{list}`) is converted with `String()` (comma-joined) and encoded, as before. `SN505` checks parameter names, so a repeated key counts as the one name the template writes. (Added 2026-11-08.)

A resource whose `src` interpolates state or `$url` reloads when those values change.

**Compiled, not interpreted (decided 2026-11-20).** The compiler writes each template as code (`urlCode` in src/compiler/compile.ts): the literals, each path value through `$hv` (which refuses a dot segment or an array), each value inside a query parameter through `$hv(v, 1)`, and a query with whole values through `$hq([…])` (each part a parameter already written, or `[key, value]`: null, undefined or `[]` leaves it out, an array repeats it). A template of another shape (an `&` in the path, an empty parameter, `?` or `&` in the fragment, two values side by side in the query, a value after `=` that is not the parameter's whole value) is `$href(tpl, [values])`, which is `expand()`. The function is in the page's table, the definition's `u` (resources, streams, actions; the core calls `fns[def.u](scope)`), and the page module carries no template: `compactIR` drops `src` and `url` where `u` is set. The compiler's IR keeps the templates for what reads them at build time (the early file, next-page data, embedded data, `sinter-embed.json` and the server layers, which still fill them with `expand`, `withParams` and `readUrl`). Next-page data (`prefetch()`) gets each request as one function too (`requestUrl`: its `when`, its URL, a numbered list's first page), imported helpers from `@tiaforge-ui/sinter/runtime/prefetch`. So `expand()` left the core of every app (−297 B gzip on the minimal page). test/url-code.test.ts compares the code with `expand` over random templates and values (null, empty, arrays, dot segments, unicode, `&`, `#`, `?`, `=` in values), and a numbered list's first page with `withParams`.

#### Links (added 2026-11-20)
`data-sn-href` on `<a>` or `<area>` (or the tag of a component whose root is one) is a link's URL template: the grammar, encoding and `sinter check` typing above, without `sinter({ apis })` (a link is not a request), and it may also start with `?` or `#` (this page's URL). It compiles to one `attr` binding of `href` whose function is the template as code (above; `$href(tpl, [values])` for a template of another shape: `tpl` is the template with its numbers indexing the interpolations' values, and `$href`, `runtime/url.ts`, exported by the core and the early module, fills it with `expand`). So everything that reads bound links reads it: the URL check, build-time constants (a constant template is written as a plain `href`, and `$href` is not imported), the early script, same-page links (`hrefs`: its literal start), SN519 (the literal parameter names of a query-only template), SN521 (the page module's code names the file). A `data-sn-attr` `href` on the same element is `SN102`.

#### Paths relative to an API (added 2026-11-14)
With `sinter({ apis })` (`ApiOptions`, resolved by `resolveApis` in `compiler/apis.ts` into `ApisDef`: each API's `base`, its spec indexes into `openapi`, `credentials`, `headers` and `shapes`), the value of `src` on `<sn-resource>` and `<sn-sync>` and of an action's method attribute is `[api:]/path[?query]`. `api:` names an API (`site` is built in, base `''`); without it the path goes to the API with `default: true` (was `sinter({ defaultApi })` until 2026-11-20; the only API when one is configured; `SN326` when several are and none is the default). The compiler parses the template from after the prefix, checks that it starts with a literal `/` (`SN207`), and puts the API's base in front of its first literal: the compiled template is the one the absolute URL gave before, so the runtime, the early file, preloads, prefetching and embedding see the same URLs. An absolute URL is `SN328` (its message names the API-relative path). The `operations` of an API are a generated OpenAPI document (`operationsDoc`, `OpenApiSpec.config` = the API's name), so they match like the spec's.

The operation is `matchOperation` over the API's specs only, with the path relative to them (no server prefix) and the method of the place: `GET` for a resource (`POST` with `method="POST"`) and a stream, the attribute's for an action. No match is `SN326` with the closest path of that method. Query parameter names written literally, and those `paginate` sends (`sizeParam`, `offsetParam` or `pageParam` by mode, `directionParam`, the cursor's keys), must be declared by the operation or the shape's `query` (`SN327`); `name[field]` counts as `name` when that parameter is `style: deepObject`; a required one that is not given is `SN327`. Without `apis` nothing of this applies.

A resource's `select`, `total`, `key` and `type` come from the operation's shape (`defaults`/`operations`, keyed `METHOD /path` as the spec writes the path), else the element; the declaration pass reads `key` that way, so a configured key makes a collection. An element restating a configured value is `SN518` (equal) or `SN330` (different). An operation of the generated document has no response schema: its type is the shape's `type`, else `SN504` in check mode.

`method="POST"` on a resource (`ResourceDef.body`, the function of its `body` attribute) loads with a POST of the body's value; the loader's identity is `URL + "\0" + JSON(body)`, which `changed()` compares and the shared-request map keys by. Such a resource is in `noEarly` (no preload, early request or embedding), is left out of `prefetchParts`, and refuses `cache`, `paginate` and `for` (`SN401`).

The page module calls `$apis([{ n, b, c?, h? }])` when an API has `credentials` or `headers`. The request layer finds a URL's API by the longest base it starts with (`apiFor`), sets its headers the request does not have and its credentials before the middleware chain; `apiOf(url)` names it. `EarlyIR.res[].a` gives the early file the same settings; its `take` compares the page module's request with what it sent (method, credentials, every header). A preload link is written for a resource whose API has no headers and no `credentials: 'omit'` (`crossorigin="use-credentials"` for `include`). `EmbedSlot.headers` carries the static headers to the server layers.

### Magic names

| Name | Available in | Value |
| --- | --- | --- |
| `$event` | `on-*`, `then`, `catch`, `data-sn-body`, `data-sn-call` arguments, `data-sn-optimistic`, `data-sn-confirm`, `data-sn-when` | the DOM event (for an action, the one that triggered it; `null` when `run('id')` started it, except for a form) |
| `$el` | everywhere | the current element |
| `$url` | everywhere | reactive view of `location.search` params plus the path parameters of `data-sn-path`; assigning to `$url.x` writes the URL, with a history entry when a user's event caused it (see The URL; path parameters are read-only, `SN203`) |
| `$now` | everywhere | current time as a `Date`, refreshed every 60 s; the timer runs only on pages that use it |
| `$locale` | everywhere | the current locale: `configure({ locale })`'s, the page's language, or its literal `<html lang>` in an app that sets no locale (see Locale); assignable in handlers |
| `$result` | `then` | parsed response body (action); what the load stored (`<sn-resource then>`) |
| `$error` | `catch`; inside a `<form>` | `{status, body, message, detail}`; `detail` is the server's message or a thrown error's, else `null`. In a form: its last failed send, else `null` (see Server validation errors on the form) |
| `$meta` | everywhere | per resource status fields (see Resources and store) |
| `$site`, `$canonical` | everywhere, with `sinter({ site })` | the site's root URL and the page's absolute URL, filled in by the build (`SN323` without `site`) |
| `$slot` | a fill of a slot declared `Slot<T>` | the values the placement passes |
| `localeUrl(locale)` | everywhere, with `sinter({ localePrefix: true })` | this page's URL in another language |
| `axisUrl(list, key)` | everywhere, on a page built over the axis of `list` (`data-sn-for` on `<html>`) | this page's URL at another value of that axis (absolute on another origin); `list` names the axis and is not read |


### The URL (`$url`)
Decided with the project owner (2026-11-13, docs/proposals/url-bindings.md): `$url` parameters are bindable like state, and history behaves as a user expects from a single-page app: Back steps through pages and filters, a typed search is one entry. No attribute overrides the rules, and typing waits for the pause resources already use (250 ms).
- Values. A compiled write to `$url.<name>` (`=`, `++`, `delete`, a method that changes it) goes through `$.$u(name, …)` (location.ts), which normalizes it: strings stay; numbers are written as their string (`0` → `'0'`); `true` → `'1'`; `false`, `null`, `undefined`, `''` and `[]` delete the parameter; arrays become string arrays; an object, a function or an instance deletes the parameter, with a dev warning (`SN212` where the compiler sees one written). So `$url` in memory equals what a reload reads, and a handler reading back its own write sees the string. Reads are plain JavaScript truthiness, which the servers' conditions match (`'0'` is non-empty, so truthy). Arithmetic needs `+$url.page`.
- Kinds. Each write asks for a history entry where it happens: `push` in a handler run by a trusted DOM event (a click, a select's `change`) and what it causes (`emit`, an action it started, that action's `then`/`catch`, a debounced handler), for a select, radio, checkbox or component model, and for `page()`; `typing` for a text-field model (`input`); `replace` for a handler hearing `input` (unless it is on a checkbox, radio or select itself: the compiler makes that a `push`, a choice; a handler higher up that hears it replaces), a resource's or stream's `then`, `sn-error` handlers and anything no user event caused, and for a list's reset to page 1. The compiler fixes the kind of a model's writes and of a choice's handler (`$u(name, v, kind)`), and sends writes to an array parameter to `$l`; for the rest the core keeps the outermost event of the dispatch (`app.ev`) and location.ts pushes when it is the user's (`Env.trusted`, default `isTrusted`; the testing module counts its simulated events) and not `input`, so handlers for `then`/`catch`, `sn-error` and custom events get it only when a user event caused them. A form submitted by `run()` is not the user's.
- Per flush pass the strongest kind wins (`push` > `typing` > `replace`), and one `afterFlush` hook writes once; a later pass of the same flush writes nothing new or replaces. A write whose query equals the current one does nothing. The query starts from the current one and sets or deletes the changed names, so the order of the others is kept; path parameters never go to the query. History calls are wrapped (Safari throws when called too often): a dev warning, `$url` kept.
- Typing commits after one 250 ms pause (a timer counted as busy, so the testing module's `settle` waits); the first commit of a run pushes, later ones replace. A run ends at a push, at `change` on the field (Enter, or leaving it) and at popstate. A replace while a commit waits goes into that commit.
- Back and Forward (`popstate`) read `$url` again, drop a waiting commit, end the run and write nothing: re-serializing could differ from the address bar (unsafe names are dropped on read). What they cause (a list loading the URL's page) writes nothing either.
- Array parameters. A parameter bound to a `<select multiple>` or to a checkbox with a `value` attribute is a list, decided at build time (`IR.urlArrays`), unlike a state checkbox, which decides from its current value at run time. It always reads as an array (`[]` when absent), written as repeated keys (`?tag=a&tag=b`); other parameters read the last value of a repeated name. A single value written to one is wrapped. Errors: the same parameter bound as a list and as one value, or a list literal written to a parameter that is not a list (`SN210`); a bare list in a condition, `data-sn-if`, `data-sn-show`, `when`, `?:`, `!`, `&&`/`||` (`SN211`: use `$url.tag.length`). The runtime, the early file, next-page data (with the target page's list) and the server layers read lists the same way; a `when` that reads one is the browser's to evaluate.
- Pagination in the URL is `paginate`'s `model` (see Pagination).
- Same-page links (added 2026-11-14, docs/proposals/same-page-links.md; query-links.ts). The invariant: a same-page link shows what loading its URL would show; only `data-sn-state` and the scroll position differ. A click is the page's when it is a primary-button `click` without Ctrl, Meta, Shift or Alt whose default nothing prevented, on an `<a href>` or `<area href>` without `download`, a `target` other than `_self` or `rel="external"`, whose URL has the page's origin and path, and (after a pending typing commit is committed, its own entry) every query parameter that differs (by name and values, not as a string) is in `IR.urlReads`. Then: `pushState` the link's URL as written without its hash (a refused call: `Env.navigate` to it), `$url` read again, `ext.location.arrive()` (the flush is as after Back: a `paginate`'s `model` list loads the URL's page and is not reset), the hash a native fragment navigation in the new entry (`Env.fragment`, default `location.replace`). The same query: a `#hash` (the link's or the address bar's) is the browser's, otherwise nothing happens. Any other click is the browser's. `IR.urlReads` comes from the IR's dependencies (`eachPath`): the first segment after `$url.`; a page that reads `$url` whole or by a computed name gets none. The compiler loads the module (with location.ts) on a page with read query parameters (path parameters of any pattern excluded), no `<base href>`, and a link it sees goes to the page: a static `href` that resolves (from the page's file, for a relative one) to one of the page's URLs (`pagePaths`, plus its file, `/about.html`), or a `data-sn-attr` `href` whose literal start does (followed through `+`, template literals, both branches of `?:` and both sides of `||`/`??`; a path seen only in part fits a pattern segment by segment). The compile result carries `sameLinks`. Next-page data skips a link that would stay on the page (`ext.sameLink`), and such a page's inline Speculation Rules leave out `{ href_matches: '?*', relative_to: 'document' }` (the page's own path with any query; checked against Chromium's preload candidates; the build names each distinct inline hash), as does a rules file for a response header once any page has same-page links. `SN519`: a pager link (a static query-only `href` that sets a `paginate`'s `model` parameter, not also bound) that drops other query parameters the page reads.


## Resources and store
A resource is a named, page-wide cache of one piece of server data: either a keyed collection or a single object. Templates read it by name; only store functions change it.
```html
<sn-resource name="contacts" src="/api/contacts" select="contacts"
             key="account_id,uid,addressbook_href" order="fn_name"></sn-resource>
<sn-resource name="addressbooks" src="/api/contacts" select="addressbooks" key="account_id,href"></sn-resource>
```

### Attributes

| Attribute | Required | Meaning |
| --- | --- | --- |
| `name` | yes | identifier used in expressions; must be a valid JS identifier |
| `src` | yes, or `call` | URL template; reload when its interpolated values change |
| `call` | instead of `src` | one call of an action, `ns.fn(args)`; the resource loads from the function and reloads when the arguments' inputs change (see Local actions) |
| `key` | for collections | comma-separated item fields forming the identity; absent = single object |
| `select` | no | path in the response to the data, a list or one object; default: the response itself |
| `total` | no | path to a total count, exposed as `$meta.<name>.total` |
| `order` | no | field kept sorted on upserts, `-field` for descending; locale-aware for strings |
| `when` | no | value expression; while falsy, the resource is empty (null or [], see Single-object resources) and a running request is aborted |
| `cache` | no | page-load cache: show the data from the last page load at once, then revalidate (see Data sources). No value: any age; `30s`, `10m`, `2h`, `1d`: ignore older data |
| `refresh` | no | `30s`, `5m`, `1h` (at least `1s`): reload in the background once this long has passed since the last load, whatever caused it (see Background refresh) |
| `for` | no | `item in list`: one request per list item, `src` evaluated with the item in scope; the responses form one collection (see Fan-out resources) |
| `then` | no | handler expression run after each successful load, with `$result` (see After a load) |
| `type` | no | the type of what `select` picks, for `sinter check` (see Type checking) |


### Behaviour
- Shared requests. Resources with the same resolved `src` share one in-flight request (e.g. one endpoint that returns two lists).
- Latest wins. When `src` changes, the in-flight request is aborted; a late response for an old URL is discarded.
- Typing. When the change to `src` or `when` comes only from keystrokes (`input` events of a text field with `data-sn-model`: `<input>` of a text-like type, `<textarea>`), the request waits until 250 ms have passed without another keystroke; the shown data stays, `loading` is not set. Any other change (a select, a checkbox, a handler, `$url` written by a handler) is requested at once, and ends a running pause. A text field bound to `$url` (`data-sn-model="$url.q"`) is typing too: the request and the URL's commit wait for the same pause. Typing back to the current URL within the pause sends nothing.
- Priority. A resource that only elements inside `<dialog>`s read (bindings, state initializers, actions and their handlers there, templates of the dialog included) is not needed for the first paint: its requests carry `priority: 'low'` (its preload link `fetchpriority="low"`), so the visible content's requests get the bandwidth first. A read anywhere else, in another resource's `src`, `when` or `then`, or in a stream's `src` or events, keeps the default priority. Embedded data is never marked.
- Coming back. A `pageshow` with `persisted` (back/forward cache) and `online` reload every resource that has a URL, since the data may have changed meanwhile. Resources a stream feeds are left to the stream's reconnect, which reloads them (see Connection rules).
- Status. `$meta.<name>` exposes `loading`, `error` and `loadedAt`. During a reload the old data stays visible; `loading` is true (not for a background refresh, see Background refresh).
- Unchanged responses (added 2026-11-09). A reload of a `src` resource whose response carries the version (`ETag`, else `Last-Modified`) of the response the data was last replaced with, while nothing has changed the data since (no server event, action result, confirmed optimistic layer, or write during the load), is the data the store already holds: it is neither parsed nor stored, and nothing re-renders. Otherwise it is a successful load like any other, so a page behaves the same with and without the check: `loadedAt` moves, `error` clears, and `then` runs with the `$result` of the load that stored the data (decided 2026-11-09: the module saves work, it does not change what handlers see). A `304` that reaches the page (a middleware sent `If-None-Match` itself) counts the same. It applies to every reload on pages whose resources are reloaded as a matter of course, those with `refresh` or an `<sn-sync>`: `refresh()`, a `refresh` event, a reconnect, `online`, a bfcache restore, a refresh. The compiler adds the module (`@tiaforge-ui/sinter/runtime/versions`) to those pages only; on others every reload is stored, as before (decided 2026-11-09: most pages reload a URL rarely, and the check would cost every page about 300 B gzip in core). Per request URL, so each page of a paginated resource has its own; not for `call`, `for` and embedded data. sinter sends no conditional headers: the browser's HTTP cache does, when the server sends `ETag` (or `Last-Modified`) with `Cache-Control: no-cache`, and answers with the cached body on a `304`. Cross-origin APIs also send `Access-Control-Expose-Headers: ETag`, or sinter cannot see it and every response counts. (Sending `If-None-Match` from sinter was decided against: it would duplicate the browser's cache, and it is not a CORS-safelisted header, so every cross-origin reload would need a preflight.)
- Identity. Keys are compared as joined strings. A duplicate key in a response is a dev-mode warning; the last one wins.
- Immutability. Items and the lists that hold them are frozen in dev builds (production relies on `SN205`; frozen arrays are slow to copy and filter). Changes always replace the item object.
Single-object resources (no `key`): `upsert` replaces the object, `merge` merges fields into it, `remove` sets it to `null`. Their change messages need no key. A list without a key (a list of strings has none) whose value the build knows is an array reads `[]` instead of `null` while it has no data: before its first load, while `when` is falsy, after `remove` (added 2026-11-20, from RealWorld's `tags`, which needed `tags?.length` and `tags ?? []`). The compiler marks it `ls` in the IR when `type` is an array as written (`T[]`, `readonly T[]`, `Array<T>`, `ReadonlyArray<T>`; `isArrayType` in compiler/components.ts: not a union, an alias or a conditional), or, without `type`, the OpenAPI response at `select` is an array, or a `file:` JSON value (at `select`) or a `content:` list is one; anything else stays `null`. The store's `value()` gives one frozen `[]` for it (`list` in `ResourceOptions`; `base()` and the page-load cache keep `null`); the early file writes `[]` for its `$r.<name>` (Resource status early) and for embedded data that is `null` (`emb[name].ls`); Closed at mount evaluates it as `[]`. The checker's type is the array type, as before: null checks are off, so a keyless resource was never `T | null` there.

### After a load (`then`)
`then` on `<sn-resource>` is a handler expression, like `data-sn-then` on an action, run after each successful load of the resource (added 2026-11-08, for Caley's share-to-mail and mark-read):
```html
<main data-sn-state="{ compose: null }">
  <sn-resource name="pending" call="mail.pendingCompose()"
    then="compose = $result ? composeDraft('new', null, identities, '', null, $result.files, $result.subject) : compose; $result && openDialog('mail-compose')"></sn-resource>
```
- `$result` is what the load stored: what `select` picks (the response itself without `select`, the function's result for `call`), the same value the store received, before `order`. For a paginated resource it is the page just loaded (in `append` mode: the new items only); for a `for` resource, the items of the one source that answered.
- When: after every response the store takes: the first load, `refresh()`, a `refresh` from a server event (or a reconnect), a change of `src`, `call` arguments or `when` that loads again, every `page()`, and embedded JSON (the page's first load). For `for`, once per source response, not once per round. Not for the cached data `cache` shows at once (only once the revalidation succeeds), not for a failed, aborted or superseded load, not when `when` empties the resource, and not for changes that are not loads: optimistic layers, `upsert`/`merge`/`remove` from handlers or server events, action results.
- Also for a reload answered with the version of the data already shown (see Unchanged responses under Behaviour): `$result` is what the load that stored the data stored.
- So it runs again on every reload: a handler meant to run once guards itself with state or with the data, one guard per step (`!opened && openDialog('x'); opened = true`, `$result && …` for a resource that is empty when nothing is pending). A handler that refreshes its own resource loops.
- Order: after the store has the response (writes made during the load replayed on top) and `$meta.<name>` is current (`loading` false, `loadedAt` set, `error` null), so the handler reads the resource and other resources as they now are. Its state writes re-render like any handler's, in the same flush.
- Scope: the scope the resource's `src` and `when` see, so the state around the `<sn-resource>` element, which it may assign, and every resource. Store functions work, `run('id')` included (the mark-read case in Running an action from a handler); there is no element, so `closeDialog()` and `closePopover()` name theirs and `emit()` is an error (`SN203`), as in `<sn-event then>`. `$event` and `$error` are not defined here; `$result` is not defined in the resource's other expressions. The `for` item name is not in scope.
- An exception in the handler is logged; the load still counts as successful.
- A resource with `then` counts as used: one that only its own `then` reads, with or without `$result`, is not `SN501`.

### Background refresh (`refresh`)
For data that no stream keeps current, or as a check on one that may miss events (a buffering proxy, a server that drops events without closing the connection), `refresh` reloads a resource once its last load is that old (added 2026-11-09):
```html
<sn-resource name="jobs" src="/api/jobs" key="id" refresh="30s"></sn-resource>
```
- The clock starts at the end of every load, whatever caused it: the first load (embedded data included), `refresh()`, a `refresh` event or a stream's reconnect, a change of `src`, `call` arguments or `when`, `page()`. A resource that a stream keeps reloading is rarely refreshed; one that only receives `upsert`/`merge` events is, since those are not loads. The wait is ±10 % (`random()`), so pages opened together do not reload together.
- Named `refresh`, not `poll`, decided 2026-11-09: it sets how old the data may get, not how often to send a request, and `refresh="30s"` is what `refresh(jobs)` does, by itself, after 30 s (as `<meta http-equiv="refresh">`). `revalidate` would blur with `cache`, which revalidates already.
- A background load: `$meta.<name>.loading` stays false (a `loading` binding does not flicker every 30 s); otherwise it is the resource's ordinary reload, with `then`, the page-load cache and writes made during it replayed on top. A `refresh()` or event in the same task makes it an ordinary load again. With `paginate` it reloads the current page; with `for`, every source.
- Hidden: while the page is hidden (a background tab, a prerendered page) nothing is reloaded; a refresh that fell due meanwhile runs when the page is shown again (`visibilitychange`); one that did not runs at its time.
- Nothing to load: while `when` is falsy there is no refresh; the load that follows starts the clock again. A load in flight when the refresh falls due counts as the refresh.
- Failure: `error` is set as for any load, and the next try waits twice as long each time, up to 30 s (never sooner than `refresh`), back to `refresh` after a success. A failing refresh is reported (`sn-error`, `onError`) once, and again only after a load has succeeded: an outage gives one toast, not one per try. Offline, refreshes fail and back off; `online` reloads every resource no stream feeds, as before, which starts the clock again.
- Values: a duration, a number and `ms`, `s`, `m`, `h` or `d` (one grammar with `cache` and the debounces, 2026-11-20), at least `1s`; anything else is `SN401`. The module (`@tiaforge-ui/sinter/runtime/refresh`, 0.4 KB gzip) is added only to pages that use `refresh`.
- Servers: answer unchanged data with the same `ETag` (see Unchanged responses under Behaviour), and a refresh costs a `304` and no rendering.
- Cost (2026-11-09): `refresh` is 394 B gzip and `versions` 438 B, each only on the pages that need it (`refresh` shares the retry helper, `backoff.ts`, with the stream module). Core grew from 13,960 to 14,154 B gzip for the hooks both use (background loads, the end-of-load callback, shared responses read lazily); the RealWorld article page (no stream, no `refresh`) from 25,721 to 25,915 B.
- The testing module's `render()` drives it: `advance(ms)` moves the clock, `visibility('hidden' | 'visible')` hides and shows the page.

### Fan-out resources (`for`)
Some APIs list a collection per parent: mailboxes per account, events per calendar. `for` loads one request per item of another list and keeps the results as one collection (added 2026-11-05):
```html
<sn-resource name="accounts" src="/api/email/accounts" key="account_id"></sn-resource>
<sn-resource name="mailboxes" for="a in accounts" src="/api/email/mailboxes?account_id={a.account_id}"
             key="account_id,name" order="name"></sn-resource>
```
- A source is identified by its resolved URL. When the list changes, only new sources load, and a removed source's items are dropped; the others keep their data.
- An item belongs to a source when it came in that source's last response, or when `src` resolves to that source's URL with the item in place of the list item (here: its `account_id`). A source's next response replaces exactly its items, including ones a server event added.
- `key` is required and must tell the sources' items apart (here `account_id` is part of it). `paginate`, `total` and `cache` do not combine with `for`.
- It ships as the `for` module, imported only by pages that use it.
- `$meta.<name>.loading` is true while any source loads; `loadedAt` is set once every current source has answered, or, for an empty list, once the list's resource has loaded. `error` is the last failed source's.
- `refresh(name)` reloads every source. A `refresh` from a server event reloads only the source its payload resolves to, the same way (`mailboxes_changed` with `{account_id}`), and every source otherwise.
- `when` applies to all sources at once: falsy drops every item and aborts every request.
- Prefer one endpoint for the whole collection when you control the server: `for` makes one request per list item.

### Status fields
Status lives under `$meta.<name>`, never on the data itself. The field set is fixed:

| Field | Type | Meaning |
| --- | --- | --- |
| `loading` | boolean | a request for this resource is in flight |
| `error` | `{status, body, message, detail}` or `null` | the last load failed; cleared on success |
| `loadedAt` | `Date` or `null` | time of the last successful load (a number of ms until 2026-11-20; a `Date` now, as `$now` is) |
| `total` | number or `null` | from the `total` path; adjusted by optimistic removes |
| `page` | number | numbered lists, and keyset with `jump` |
| `pages` | number or `null` | paginated, when `total` is known |
| `from`, `to` | number | paginated: 1-based positions of the current page |
| `hasPrev`, `hasNext` | boolean | paginated |
| `live` | `'connecting'`, `'open'`, `'retrying'` or `null` | the stream feeding the resource (see Connection status); `null` when no `<sn-event>` names it |

Any other field is a build error (`SN303 unknown-meta-field`), and so is a pagination field on a resource without `paginate`.

### Store API
The store has no knowledge of the DOM, fetch or SSE. Everything else talks to it through this interface:
```ts
interface Resource<T> {
  get(key: string | T): T | undefined;
  all(): readonly T[];            // in `order`
  replace(items: T[]): void;      // full load
  upsert(item: T): void;          // insert or replace by key
  merge(key: string | T, fields: Partial<T>): void;
  remove(key: string | T): void;
  refresh(): Promise<void>;
  subscribe(fn: (change: Change<T>) => void): () => void;
}
```

### Data sources
A resource's data can arrive through pluggable sources. v0.1 ships two:
- Fetch loader: loads `src` through the request layer.
- Embedded JSON: if the page contains `<script type="application/json" data-sn-resource="contacts">`, that payload is the initial data and no first request is made. Who writes it (a server, a build step) is up to the app; the build describes the placeholders for a server that does (below).

Collections (added 2026-11-16, `content.ts`, `content-node.ts`): the content module's exports are `collection({ key, load })` objects (marked with `Symbol.for('sinter.collection')`, so any instance of the module counts). The plugin loads the module in `configResolved` through `importModule` (the helpers' short-lived runner, sinter's plugin inert in it), runs every collection concurrently with a context (`files` reads a glob as `file:` does, `get` memoizes by collection and refuses cycles, `env` from `loadEnv`, `command`), checks each result (a list of plain data, objects with a unique key) and deep-freezes it; errors are scrubbed (`scrub`: URL credentials and queries, `env` values) and fail a build, or in dev reach compiles as `collectionsError`. The compile gets the lists as `collections` (synchronous); `content:name` is `contentResource`: a constant list (`fx`), its key the collection's, sorted by `order` and frozen once per build in `globCache`, `drafts` and `select` SN332, an unknown name SN342 with a suggestion. `data-sn-for` on `<html>` takes it as it takes a `file:` glob. Without `collections` (check, editor) the list is empty.

Files (added 2026-11-15, `compiler/files.ts`): `src="file:<path>"` names a file of the project, read when the page compiles. `file` is a built-in name beside `site`, recognized before the API lookup (with or without `sinter({ apis })`), and reserved as an API name (SN329). The path is a literal, relative to the file that wrote the element (`origins`: a page, a layout or a component) or `/…` from the root, normalized and confined to the root; its text, for `.json` its parsed value, and for `.md`/`.markdown` its frontmatter (YAML, core schema, no anchors, aliases or tags; `body`, `dir`, `path` reserved) with `body`, is the value (`select` and `key` apply as to a response). A path with `*`, `?` or `{a,b}` is a glob (`filePath` returns its fixed folder and a pattern; `globRegExp`): `CompileOptions.listFiles` lists the folder (the project's skips `node_modules` and dot-folders, and links out of the root), and the value is a list, sorted by path, of `fileEntry`s: each file's value as an object (text as `{ body }`, `.json` must be an object) with `slug`, `dir` and `path`; `key` defaults to `['slug']` and duplicates are SN332; the folders and patterns are `CompileResult.globs`, which the dev server watches for added and removed files. `drafts` drops entries whose field is `true` when `!dev`; `order` sorts with `sortList` (the runtime's comparison, strings by `Intl.Collator` in `opts.locale` or the page's `<html lang>`), so the resource itself has no `order`. The check types a markdown file as `type & { body: string }`, and a glob as `(type & { slug; dir; path } & { body })[]`: `CheckResource.file` carries what sinter adds (`adds`) beside `type` as written (a typedef, so `verbatim` maps it), and each file's value (bodies as `""`), which the shadow writes as a literal typed with the entry, at that file (an excess or missing field is an error there). `{$locale}` in a path is `opts.locale.name` (the build's language, the base one in `sinter check` and the editor through `checkLocale`); without a locale it is SN332. `fileValue` keeps each file's parsed value while its text is unchanged; the editor keeps reads by modification time and listings until a file event, and recompiles the pages that read a changed file or whose glob matches it (`ProjectState.globs`). The compiler writes it into the head as `<script type="application/json" data-sn>` (`<` as `\u003c`) and gives the resource `data` and `fx: 1`; the runtime stores it at start as any embedded data, does not set `loadedAt`, and never loads it (`changed` and `refresh` do nothing, so coming back online or from the back/forward cache requests nothing). It is not in `embedSlots()`. The file joins `CompileResult.files`. SN332 (`build-time-source`): an interpolation, outside the root, missing, invalid JSON or frontmatter, a glob's non-object JSON, duplicate keys, `select` over text, markdown or a glob, `drafts` on one file, `order` on a non-list; any attribute but `name`, `src`, `type`, `select`, `key`, `order` and `drafts`; SN539 (`empty-glob`, a warning): a glob that matches nothing; `file:` in an action or `<sn-sync>`; after the walk, a store call that names it (`refresh`, `upsert`, `page`, `merge`, `remove` in compiled code), a `merge`/`remove` whose item resolves to it (`resolveSources`), a write-through target or a stream event about it. It is a constant of the build-time evaluator (`fileConstants`: `$r.<name>`, its `select` picked and frozen, and `$meta.<name>` with `loading` false and the rest null; `fileConstant` makes its paths known and fixed, so `prerender`, the worklist and `dropConstants` treat them as state nothing writes): bindings over it fold, and a resource that no function left for the browser reads leaves the page with its head script (`dropFiles`, after `dropConstants` in both passes; not when any function chooses a resource by a computed name). What still reads it gets it from that embedded data, early too, and only what it reads (changed 2026-11-23, docs/proposals/redesign-notes/embed-fields.md): in a build's second pass, a read down to a primitive (`null`, a boolean, a finite number, a string of at most `FOLD_STRING` = 120 characters) of a resource nothing can change (`foldValues`: no write or store call reaching `$r`, no stream; not in dev or a description) is that value's literal in the code (expr.ts `foldOf`, pasted as a let's value is), unless a component script left in the page may be given one of the page's objects (`foldsEscape`: compiled again without); a page with no other reason for a second pass gets one when the first pass's functions read such a primitive (`foldGain`). What is still embedded is pruned (`fileJson`, embed-reads.ts): `resourceReads` takes each path read under `$r` from the syntax trees of the page module's and the early file's functions (a fixed-key member chain; a method's receiver, any other use, a computed key read the subtree whole; `$r` whole, by a computed name or written makes everything whole) and `prune` keeps, of a plain object, the keys some path names, at each depth, a list or a path's end whole. Not in dev, with `select`, or for a resource a stream feeds. A constant resource has a URL function too (`($) => ""`): the runtime resolves it to store the embedded value.

Embedded data for a server (added 2026-11-10):
- An empty placeholder (only whitespace) is no data: the resource loads as if it had none, with no dev warning. It is what a server leaves when it has nothing to write (no data for this request, an error, its time limit), so the page then requests the data itself. Invalid JSON is still dev warning 5.
- A build with placeholders writes `sinter-embed.json` next to the pages (`{ version: 2, pages: [{ file, paths, arrays?, data: [...] }] }`; version 2 since 2026-11-13, which older layers refuse: `arrays` lists the page's array parameters, which a server reads as lists and expands as repeated keys): for each page, its file in the output, the paths it answers at (as for next-page data: `data-sn-path`, else where its file is served), and per placeholder its `data-sn` id, its resource and the request the browser would make: `src` as literal strings and `{ url: name }` for a `$url.name` read, or null when anything else is in it (a helper, state, another resource), or for `call` and `for`. `when: true` says the resource has a condition only the browser evaluates. A paginated resource has `query`: its first page's parameters as the pager sends them (`firstParams`), which the server sets on the template's URL as the runtime does (`withParams`); the runtime takes embedded data as that first page, so `page()` moves on from it. The `$url` values go in as the runtime puts them (src/runtime/url.ts: encoded, an absent query value leaves its parameter out). A server fills what the template describes and leaves the rest, or the app gives it a function per resource.
- `sinter({ embed: true })` (added 2026-11-10): builds served by such a server. Every resource without a placeholder whose `src`, `when` and `paginate`'s `model` read only `$url`, constants and helpers gets one, last in the head (after the tags Vite adds, so a server that streams the page up to the first placeholder sends the stylesheets and scripts first): not `call`, `for`, or `early="off"` (a request a middleware changes, such as one carrying the user's token). Those resources are neither preloaded nor requested by the early file: their data comes with the page. `vite dev` is unaffected.
- `when` in the manifest: `true` when only the browser can evaluate it, else a condition over `$url`: `{ url }` (present and not empty), `{ url, eq }`, `{ url, ne }` (against a string literal; an absent value equals nothing), `{ not }`, `{ and }`, `{ or }` (from `!`, `&&`, `||`). A paginated resource with `model: $url.<name>` has `start: { url, key, size, skip?, query }`: from page 2 on, the parameters are `query` with `key` set to the page, or with `skip` to (page - 1) × `size`. A `start-page` that reads anything else makes `src` null.
- `packages/sinter-axum`: such a server for Rust, a `tower` layer (axum). `Embed::from_dir(dist).api(router).build()` refuses, one line per problem, a placeholder with no resolver, no `skip` and no request it can make, and names no placeholder has; `embed!(path, { "articles" => resolver, "user" => skip })` makes the same check when the server compiles and compiles the manifest in. It cuts each page at its placeholders at startup, streams the head up to the first placeholder at once (stylesheets and scripts load while the data is fetched), and fills each from the app's own API router called in-process, an upstream server, an allowed origin (without the page's cookies) or the app's function; `<` is written `\u003c`. Measured 2026-11-10 (RealWorld, slow 4G, cold): home LCP 948 → 588 ms with an API that answers at once, 1,128 → 572 ms when it takes 300 ms; one core serves 1,900–2,200 home pages/s, Qwik City 57–67 (docs/first-paint-comparison.md).
- `packages/sinter-aspnetcore` (added 2026-11-12): the same server for ASP.NET Core, option for option (`Sinter.AspNetCore`). `AddSinter(o => …)` and `app.UseSinter()`; same-origin requests go to the app's own endpoints in-process (minimal APIs, MVC controllers), through a pipeline of their own with routing, CORS, authentication and authorization, each with its own `HttpContext` and service scope. `[SinterEmbed]` (a source generator, the build named by `<SinterBuild>` in the project file) compiles the manifest into the assembly as code, makes the same checks as `embed!` as compile errors (`SINTER001`–`SINTER007`), and binds `[SinterResolve]` methods' parameters (services, the request, the token) and serializes their values through `JsonTypeInfo`, without reflection. NativeAOT-compatible; CI publishes a NativeAOT app from the packed package with trim and AOT warnings as errors.
- `@tiaforge-ui/sinter/server` (added 2026-11-13, `src/server.ts`): the same server in JavaScript, on web-standard `Request` and `Response`, option for option with sinter-axum (`origins` for `allow_origin`, `data` for `resolve` and `skip`). `await embed(options)` reads the build (from `dir` with `node:fs`, or from `manifest` and `read`), refuses at startup what `build()` refuses, and gives `fetch(request, next)` and `wrap(handler)`: the wrapped handler (Hono's `app.fetch`, any fetch handler) is the in-process API, called with the page request's forwarded headers and its extra arguments (a Worker's `env`). URLs come from the runtime's own `expand`, `withParams` and `readUrl`. With `embed: true` the build also writes `sinter-embed.d.ts` (per page, each placeholder's resource and whether its request is described); `embed<Build>()` makes a missing entry or an unknown name a type error. The layer answers 404 for both files.
- `<body data-sn-failed>` (added 2026-11-10): the body of a page a server ended because its data could not be fetched (sinter-axum, which writes its error text into that body). The page module does not mount there (`parsed()` does not resolve), so it neither renders nor requests. A marker for servers, not an attribute: pages do not write it (it is `SN101` in markup like any unknown `data-sn-*`), and it is left out of llms.txt and the editors' custom data on purpose.
- Data fetched for the page without the user's credentials is the anonymous view: a signed-in user whose token the server cannot see (RealWorld keeps it in `localStorage`) gets that view, and embedded data is not reloaded. Such pages leave those resources to the browser (a resolver that returns nothing for them) until the runtime can revalidate embedded data.
- Page-load cache (`cache` on `<sn-resource>`, added 2026-11-05): stale-while-revalidate across page loads in one tab.

The page-load cache:
- On page start, a resource with `cache` whose `src` resolves stores its cached entry at once (before the first paint). `$meta.<name>.loadedAt` stays `null` until the server answers, so it keeps meaning "loaded during this page load" and guards such as `$meta.user.loadedAt && !user` never act on cached data (found with RealWorld's login redirect, 2026-11-05). Then the resource loads as usual: `loading` is true and the cached data stays visible, as during any reload. A failed revalidation keeps it and sets `error`.
- Embedded JSON wins: no cache lookup is made, and the embedded data is cached.
- Entries live in `sessionStorage` (one tab's lifetime) under `sn:c:`, keyed by the request URL and the `select` and `total` paths, so two pages that load the same data share an entry whatever they call the resource. An entry holds `{t, items, total}`, not the response body.
- Writes: after every successful load, and on `pagehide` for resources whose confirmed data changed since (server events, action results). Optimistic layers are never written. Only the first load reads the cache; a `src` that changes on the page does not.
- Pagination: each page's request URL has its own entry; an `append` list caches only its first page.
- Limits: an entry over 256 KB serialized is not written (dev warning); a full storage drops the older half of the entries and retries once.
- Logout: every entry is removed on any 401 (as the response arrives, before `onUnauthorized` middleware runs) and by `clearStored()` (was `clearPersisted()`, 2026-11-20: it clears more than the persisted values), which apps call on logout.
- A malformed value is `SN401`. The cache module (`@tiaforge-ui/sinter/runtime/cache`) is added only to pages that use `cache`; for Back and Forward, a page without it that has a resource which can come back (not `for`, `call`, `method="POST"`, `file:`, embedded or `append`) gets the smaller `@tiaforge-ui/sinter/runtime/back` (since 2026-11-20), and a page with none gets neither.
- Back and Forward (added 2026-11-20): a page reached by a history traversal that the back/forward cache did not serve restores every resource it can hold from its entry, with or without `cache`, at any age, before the first paint (the hold script waits for the mount, so a morph back needs no `cache`), and revalidates as `cache` does. Traversal, decided as the module installs: the env's `traversal()` (the testing module's `traverse`), else the swap's flag for the page it mounts (`Symbol.for('sinter.traverse')`, set before each boot, since the document's navigation type is its first load's), else the load's `PerformanceNavigationTiming.type == 'back_forward'`; or the mark a swap's traversal leaves (`sessionStorage['sn:back']`, the URL) when it reloads its entry instead (Back from a page with nothing to run, a page that could not mount), read and removed once. Writes: a resource without `cache` is tracked at each load (its request URL, through `ext.cache.loaded`, which the core now calls for every resource) and written only as the page is left (`pagehide`, the app's destroy before a swap), its confirmed data (`base()`), not after loads; an `append` list is not written then (as `cache`'s pagehide write skips it), so it loads again. Not `for`, `call`, `method="POST"` or `file:` resources (`never()` in back.ts). The early file's check for rows at mount (Resource status early) counts a resource's `sn:c:` entries without `cache` only on such a load (the navigation type, or the mark for this URL); a swap runs no early file. Measured 2026-11-20 in Chromium with the back/forward cache off (`test/vite/back-restore.test.ts`): after Back the list shows what was left while the API takes a second, then the API's rows, on a load, on a swap's traversal, and on Back from a page with nothing to run (a reload, marked). An API response the browser may reuse is reused on a traversal (subresources prefer the HTTP cache there): send `Cache-Control: no-cache` (with `ETag`) or `no-store`, as Background refresh asks already.

Next-page data (added 2026-11-09, `@tiaforge-ui/sinter/runtime/prefetch`, nothing to declare):
- What can be requested ahead: the compiler describes each page by its `data-sn-path` patterns (else the paths it is served at: `/login/` and `/login` for `login.html`, `/docs/` and `/docs/index.html`, under Vite's `base`; see Page URLs) and the resources whose `src` and `when` read only `$url`, constants and the app's helpers: no state, resources, `$meta`, `$now`, built-in formatters or messages; not `for`, `call`, `method="POST"` or embedded data. A paginated resource (added 2026-11-20; it was left out) is described with its pagination (`p`: the `Paginate` config without `cursor` and `start`) and requested at the page its first load requests: with `model` (paginate) `pageParams(toPage($url[model]))` of the link's `$url`, else `firstParams` (keyset and `append`: the first page, no cursor), set on the URL as the pager sets them (`withParams`), so the next page's first load takes the entry and its `total` gives `$meta.pages`. Its handover from this page's own data is not attempted (the loader keeps the URL without the page). The Vite plugin puts every HTML entry's description in one module (`/@sinter/prefetch.js`, a shared chunk), which every page imports when any page has something to describe. `sinter({ prefetch: false })` leaves it out.
- When: a same-origin link (`a[href]`, not `download`, `target` empty or `_self`, not this page's path and query) to one of those pages is about to be followed: the pointer rests on it for 65 ms (`HOVER`) or it has focus that long; a mouse or pen press starts at once. A touch waits the same 65 ms, and a `pointercancel` (the browser took the gesture for a scroll) ends the wait, so scrolling a list of links by touch requests nothing. Nothing with `navigator.connection.saveData` or a 2g connection.
- What: each described resource's URL is computed with the link's `$url` (query, then the first matching pattern's segments). A request this page has loaded itself (same URL, `select` and `total`, loaded during this page load) is handed over from its confirmed data without a request; any other is a GET through the request layer, low priority, marked with an `x-sinter-prefetch` header for the middleware chain. The mark is removed before `fetch`, so it adds no CORS preflight; a marked request answered with an error rejects there, and `onUnauthorized` passes a marked 401 by, so a prefetch never starts a login redirect. A URL requested within the last 10 s (or in flight) is not requested again.
- Stored: `{t, items, total}` (items cleaned as a load cleans them) in `sessionStorage` under `sn:p:`, keyed by the request URL and the `select`/`total` paths, as the page-load cache. Not written: over 256 KB, a collection whose `select` is not an array, a response to a request that overlapped a mutation. After every mutation (any method but GET and HEAD, once it settles) all entries are removed, as on any 401 and by `clearPersisted()`; a page removes entries older than 30 s (`MAX_AGE`) when it mounts.
- Taken: on its first load, a resource (not `call`, `for` or `method="POST"`; a paginated one at the page of its first request) whose request has an entry not older than 30 s takes it, once (the entry is removed), before the page-load cache, and shows it at once; then it loads as usual. `$meta.<name>.loadedAt` stays `null` until the server answers, as with `cache`. So the next page paints with data without a round trip, and still shows what the server says a moment later.
- Speculation Rules (added 2026-11-09, Chromium): the Vite plugin writes rules for same-origin links to the app's paths (every page's patterns or file paths as URL patterns, any query and fragment; not `[download]`, another `target`, `rel~=nofollow`), eagerness `moderate`. `sinter({ prefetch: { html } })`: `true` (default) fetches the next page's HTML; `{ prerender: true }` loads and runs it in the background (was also `'prerender'`, 2026-11-20: one spelling, the object's key); `false` writes none. Delivery (decided 2026-11-09: inline by default, it needs no server setup): `<script type="speculationrules">` in every page's head. A CSP the page declares (`<meta http-equiv="Content-Security-Policy">`) gets the rules' hash (`withRulesHash()` in `prefetch-build.ts`): in `script-src-elem` and `script-src`, else in a `script-src` copied from `default-src`; a directive that already allows them (`'unsafe-inline'` without a hash or nonce, `'inline-speculation-rules'`) is left alone. A CSP sent as a response header is out of the build's reach: it needs `'inline-speculation-rules'` (or the printed hash) in `script-src`; dev builds warn (code 22) through a buffered `ReportingObserver`, since the violation happens while the page is parsed, before sinter runs. `prefetch: { html: { delivery: 'header' } }` (`prerender: true` beside it to prerender) (was `speculation`) writes `speculation-rules.json` at the site root (fixed name) for a `Speculation-Rules: "/speculation-rules.json"` response header instead, which no CSP blocks; the server must send the header with every page and the file as `application/speculationrules+json` (`application/json` is rejected). `vite dev` and `vite preview` do both. Browsers have no third way: `<script type="speculationrules" src>` is not supported, `<link>`/`<meta http-equiv>` forms do not exist, and a `<link rel="prefetch">` hint is reused for the navigation only when the HTML is cacheable (Chromium, tested: not with `no-cache`, `max-age=0` or no header). Measured 2026-11-09 in Chromium under `script-src 'self'`: inline blocked (a violation), header with that type works, header with `application/json` rejected; `e2e/navigation` runs this setup. Guide: [navigation.md](navigation.md). Next-page data still runs: it works in every browser and fetches the data, which a prefetched document does not.
- Prerender chosen per page (added 2026-11-20): `prefetch: { html: { prerender: 'auto' } }` (one spelling: a value of `prerender`, beside `delivery`; there is no `html: 'auto'`). The compiler finds what a page does as it loads besides reading (`loadEffects()`, `CompileResult.loadEffect`: the first found): a resource with `call`, `method="POST"` or `then`; an `on` binding whose event is not one only a visitor causes (`USER_EVENTS`: clicks, keys, pointer, mouse, touch, wheel, input, change, submit, reset, invalid, drag, clipboard, `close`, `cancel`, `navigate`, `dismiss`; not `focus`, which `autofocus` fires, `load`, `error`, `toggle`, `scroll`, `sn-error` or custom events); a `cmp` binding (a component script), an `imp` binding (`data-sn-import`) or a lazy helper module (`ir.lm`); a hyphenated element that is not `sn-*` or a component (a custom element), in the page or a head template; a `<script>` the page wrote that is not data (`application/json`, `application/ld+json`, `importmap`, `speculationrules`; sinter's own are kept in `OWN_SCRIPTS`). `<sn-sync>` does not count: streams connect once the page is shown (below). The plugin checks the app's modules every page may run (config, early, helpers and actions, all of them for every page, and what they import; `moduleEffect()` in `src/prerender-build.ts`): a module is quiet when each top-level statement is an import, a declaration (function, class without static blocks, decorators or effectful static fields, `const`/`let` of a literal, function, object or array of those, a template, an operator over those, an `import.meta` chain), type syntax, or a call of a sinter configuration function imported from the package (`configure`, `header`, `onUnauthorized`, `loginRedirect`, `apiOf`, `memo` and the formatters) with such arguments; an import of a relative module that is quiet, of `@tiaforge-ui/sinter*`, or of a package whose package.json says `"sideEffects": false` (the claim bundlers tree-shake by). Anything else (a call, `new`, a property read of anything but `import.meta`, a package that does not say) is an effect, so the check errs toward prefetching. Rules: `speculationRules({ prerender, prefetch })` writes a `prerender` rule over the quiet pages' paths that leaves out (`not href_matches`) the patterns of the prefetched pages, and a `prefetch` rule over those; a `<html data-sn-for>` page's pattern goes with its described entry. The build log names the prerendered pages and, for each other, the reason. Not the default (decided 2026-11-20): a prerender loads the page's data for a visitor who may not follow the link, then again on activation, and the HTML request reaches page-view counters (with `Sec-Purpose: prefetch;prerender`), costs the build cannot see.
- A prerendered page (`document.prerendering`): loads its resources as usual; streams (`<sn-sync>`) connect only once it is shown (`app.shown()`), so a page nobody may ever see holds no connection; when it is shown (`prerenderingchange`) every resource is reloaded (it may have loaded minutes earlier and missed server events), then the waiting work runs. Measured 2026-11-09 in Chromium: prefetch is used by the navigation (`deliveryType: navigational-prefetch`); prerender is requested (`Sec-Purpose: prefetch;prerender`) but Chromium does not prerender while DevTools drives it (`PrerenderingDisabledByDevTools`), so activation is covered by the behaviour test only.
- Opting a page out: `<html data-sn-prefetch="off">` (anywhere else `SN102`, another value `SN401`). The page is left out of the next-page module and of every page's Speculation Rules, so no page prefetches its data or its HTML, or prerenders it: for a page that does something when it loads (a logout page that clears the session). It is a build-time decision: the attribute is stripped like every directive. There is no per-link opt-out: the browser can only leave a link out of its rules by a marker in the page (decided 2026-11-09: no marker).
- Cost: the feature is 1.4 KB gzip on every page (2026-11-09), plus the pages' descriptions (RealWorld: 7 pages, one shared chunk). The RealWorld article page went from 19,971 to 21,306 B gzip; its budget was raised to 22 KB.

## Sync: change messages and transports
The store only understands one message shape; transports translate server events into it. Server-Sent Events are the default; a WebSocket transport ships as `@tiaforge-ui/sinter/ws`, and others (SignalR) are a few lines in the app (see Transport interface).
```ts
type Change<T> =
  | { resource: string; op: 'upsert';  item: T }
  | { resource: string; op: 'merge';   key: string; fields: Partial<T> }
  | { resource: string; op: 'remove';  key: string }
  | { resource: string; op: 'refresh' };
```

### Declaring a stream
```html
<sn-sync src="/api/events/stream">
  <sn-event name="contact_updated"  resource="contacts" op="upsert" value="$event.contact" when="$event.contact"></sn-event>
  <sn-event name="contact_updated"  resource="contacts" op="refresh" when="!$event.contact"></sn-event>
  <sn-event name="contact_removed"  resource="contacts" op="remove"></sn-event>
  <sn-event name="contacts_changed" resource="contacts" op="refresh"></sn-event>
</sn-sync>
```
Inside `<sn-event>` attributes, the event's parsed JSON payload is `$event` (since 2026-11-20; before, its fields were bare names, and a bare name that is no state, let or other name is now `SN201` naming `$event.<field>`): `value="$event.contact"` reads the payload's `contact`. State declared around the `<sn-sync>` is in scope too: `when="$event.mailbox === sel.mailbox"` compares the payload's `mailbox` with the state `sel` (added 2026-11-05, for Caley's mail list). `data-sn-let` names declared around the `<sn-sync>` resolve the same way, and read the state they are computed from when the event arrives (`data-sn-let="{ open: … }"` on the page's `<main>`: `then="open && open.uid === $event.uid && …"`; added 2026-11-08); a let that reads `$el` is `SN201` here, since there is no element. Loop variables and resources are not in scope here (a let may read resources). `src` of `<sn-sync>` is evaluated in the same scope.

| Attribute | Meaning |
| --- | --- |
| `name` | event name (the SSE event name, or what the transport reports) |
| `resource` | target resource |
| `op` | `upsert`, `merge`, `remove` or `refresh` |
| `value` | what the change writes (changed 2026-11-19: was `item` and `set`, now `SN101`): for `upsert` the item, a value expression, default the whole payload; for `merge` the fields, an object literal, e.g. `{flags: $event.flags, is_read: $event.flags.includes('\\Seen')}` |
| `when` | value expression; skip the event unless truthy, e.g. `$event.mailbox === $url.mailbox` |
| `then` | handler expression, run after the change is applied (see Handlers on server events) |
| `type` | the payload's type, for `sinter check` (see Type checking) |

For `merge` and `remove`, the key is read from the payload using the resource's `key` fields. On a `for` resource, `refresh` reloads only the source the payload resolves to (see Fan-out resources). Events with no `<sn-event>` are still dispatched to custom elements (see JS API).

### Handlers on server events
`then` on `<sn-event>` is a handler expression, like `data-sn-then` on an action, run after the event's change is applied to the store (for `refresh`: once the reload is requested; it does not wait for it). It sees the same scope as the event's other attributes: the payload as `$event`, and the state and `data-sn-let` names around the `<sn-sync>`; it may assign the state. It runs for every event that passes `when`; not when the payload cannot be applied (a `merge` or `remove` without the key fields, an `upsert` without an item; a second event of the same name with `when` can refresh instead). With `then`, `resource` and `op` may be left out: the event only runs its handler. (Added 2026-11-08, for Caley's detail dialogs.)
```html
<body data-sn-state="{ sel: null, notice: '' }">
  <sn-sync src="/api/events/stream">
    <sn-event name="contact_removed" resource="contacts" op="remove" type="ContactRemoved"
              then="sel?.uid === $event.uid && closeDialog('contact-detail')"></sn-event>
    <sn-event name="notice" type="Notice" then="notice = $event.text"></sn-event>
  </sn-sync>
```
- The dialog clears the selection itself (`<dialog id="contact-detail" data-sn-on-close="sel = null">`), so the handler runs one step under its condition (two would be `SN507`).
- Store functions are in scope (`refresh`, `upsert`, `merge`, `remove`, `page`, `openDialog`, `closeDialog('id')`, `run('id')`), and their names win over payload fields. There is no element, so `closeDialog()` names its dialog and `emit()` is an error (`SN203`); `$event` and `$result` are not defined here, and assigning to a payload field is an error.
- State writes re-render what reads them, as from any handler. Bindings inside a dialog the handler closes keep their last values until it opens again.
- Custom elements still receive the event through `app.on(name)`, after every mapping has run.

### Connection rules
- One connection per stream URL per page, however many elements use it: `<sn-sync>` elements whose `src` resolves to the same URL (at connect time, after the page mounts) share one transport, and all their `<sn-event>` mappings apply, each evaluated in its own `<sn-sync>`'s scope. An event mapped by several of them applies once per mapping; custom elements receive it once.
- The session probe gates every reconnect. `EventSource` cannot see HTTP status, so after an error the adapter does not reconnect directly. It calls the configured `sessionProbe` through the request layer:
  - 2xx: reconnect the stream.
  - 401: the normal login redirect.
  - network error (status 0): wait out the backoff, then probe again.
- Backoff: 1 s, doubling to 30 s, with jitter; reset after a successful reconnect.
- Offline is not logged out. Only a 401 leads to login; an outage never does.
- Missed events. After a reconnect, every resource fed by that stream is reloaded once, since events sent while disconnected are lost.
- Back/forward cache. The connection closes on `pagehide` and reopens on `pageshow`, so an open stream does not keep the page out of the cache. Reopening goes through the session probe like any reconnect, so a page restored after logout is redirected to login.
- Coalescing. Several `refresh` messages for one resource within one task cause one request.
- HTTP version. Each open EventSource holds one HTTP connection. Over HTTP/1.1 browsers allow 6 per origin, so with more than 5 tabs of an app open, the next page stops loading. Serve streams over HTTP/2 or HTTP/3 (one connection carries about 100 streams; any TLS reverse proxy such as nginx or Caddy provides it), or use the WebSocket transport, which is not counted against that limit. Dev builds warn once when a stream's origin was reached over HTTP/1.1, judged from Resource Timing: the page's navigation for a same-origin stream, else the last request to that origin. Streams are not shared across tabs (decided 2026-11-05: it would change what servers see per connection, such as echo suppression and presence).
Later, with a backend change: a `session_expired` event sent before the server closes the stream could trigger the redirect without a probe.

### Paginated resources
On a paginated resource, `upsert` of a key that is not on the current page becomes a `refresh` of the current page. `merge` and `remove` apply only to items present. This keeps page boundaries correct without client-side guessing.

### Transport interface
A transport is an object with `connect(url, onEvent, onState, names)`, an optional `listen(name)` and `close()`:
- `onEvent(name, payload)` delivers one event with its **parsed** payload (the SSE transport parses JSON and passes anything else as the raw string).
- `onState('open')` once connected; `onState('error')` when the connection is lost, cleanly or not. A transport never reconnects by itself: the connection rules above (session probe, backoff, reload) apply to every transport. Nothing is reported after `close()`.
- `names` are the event names the page maps; `listen(name)` adds one a custom element subscribes to later. A transport delivers at least those.

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
- `DELETE` without `data-sn-body` sends no body.
- With `data-sn-encoding="form"` the body goes as `application/x-www-form-urlencoded`: a form's fields as a browser submits them (repeated names stay repeated), or the keys of `data-sn-body`, an array as a repeated key; `null` and `undefined` values are left out, objects are sent as JSON text. Action functions get the same with a `URLSearchParams` body in `ctx.request`.
- Serializing a form and form encoding are the `form` feature module (0.8 KB gzip), imported only by pages with a form action without `data-sn-body` (not `DELETE`) or with `data-sn-encoding="form"`.

### Confirmation
`data-sn-confirm="m.delete_confirm({name: c.fn_name})"` asks before the action runs: no optimistic change, no request when the answer is no. The value is evaluated when the action triggers; when it is falsy nothing is asked, so a question can depend on state: `data-sn-confirm="inTrash ? m.delete_forever() : null"`. `configure({ confirm })` replaces `window.confirm`, for example with a dialog of the app's own (it may return a promise).

### After the response
`then` and `catch` are handler expressions. The built-in functions:

| Function | Effect |
| --- | --- |
| `refresh(contacts)`, `refresh(messages, unread)` | reload each named resource (names as in Resource names below; one call, one statement for `SN507`) |
| `upsert(contacts, $result)` | insert or replace an item |
| `merge(item, {…})` | change fields of an item, in the resource it came from |
| `remove(item)` | remove an item from the resource it came from; a single resource becomes `null` |
| `page(messages, 'next')` | change page: a direction, or a page number where the resource can jump; may be computed (see Pagination) |
| `openDialog('edit')` | open `<dialog id="edit">` as a modal; nothing if it is open |
| `closeDialog()`, `closeDialog('edit')` | close the nearest `<dialog>`, or the one with that id |
| `closePopover()`, `closePopover('menu')` | hide the nearest open `popover`, or the one with that id; nothing if it is hidden |
| `emit('name', detail)` | dispatch a bubbling, cancelable `CustomEvent` from the element; every container with a handler for it runs, inner first, until one calls `$event.preventDefault()` |
| `navigate(url, { replace })` | go to `url` (relative to the page's): a same-page link when only parameters the page reads change, else a navigation (a swap where on) |
| `run('id')` | start the action of the element with that id, as its trigger would (a form: submit it); see Running an action from a handler |

State assignments work too: `data-sn-then="editing = null; closeDialog()"`.
The dialog id of `openDialog()` and `closeDialog()` is a string literal that must name a `<dialog id>` on the page or the components it uses (`SN309`), so a typo fails the build. A button that only opens a dialog needs no handler: `commandfor="edit" command="show-modal"` is the platform's. `closePopover('id')` names an element with `popover` and that `id` the same way (`SN309`); `closePopover()` hides the popover around the element, which `command="hide-popover"` cannot do for a link: a same-page link in a menu popover (`<a href="#services" data-sn-on-click="closePopover()">`) closes it as it scrolls. `openDialog()` is for opening after a request or call (`data-sn-then`), from a custom event, or after setting state in the same handler. Bindings inside the dialog render when it opens.

### Write-through
A mutation's 2xx response is applied to the resources it is about, by the `write-through` feature module (`@tiaforge-ui/sinter/runtime/write-through`, `apply` until 2026-11-20) (loaded by pages that have something to apply), after the optimistic layer commits and before `then` runs, so `then` has the last word. Nothing is declared: the compiler knows what the action is about and what the response holds.

**What the action is about** (provenance): the resources, rows and nested entities its URL and body read. `{a.slug}` with `a in articles` names a row of `articles` (also of each list in `a in (following ? feed : articles)`); `{article.slug}` names the single-object resource `article`; `{article.author.username}` also names `article.author`, a `Profile` by the schema walk. **What the response holds**: with an OpenAPI spec, the objects of named component schemas in it, at the top level or one property down (`{article: Article}`, `{articles: Article[]}`); each resource is matched to a schema the same way (a `$ref`, an inline copy, or an inline projection with fewer fields, as list responses often are). The request body's wrapper property (`{comment: {…}}`) comes from the request schema.

| Rule | When | Effect |
| --- | --- | --- |
| 1 Confirm | the response holds an object of schema `S` | every keyed list resource of schema `S` patches the item with that key, if it holds one; what the URL named (a row, a single resource, a nested entity at its path) is patched when its schema is `S` |
| 2 Create | a `POST` whose resolved URL equals a keyed list's current URL, query included | the response's object of the list's schema is upserted; without one, the body (unwrapped) merged with the response object that carries the key fields (`{id: 42}`, also wrapped) is; without either, the list is reloaded. A filtered or paginated list is never inserted into: its URL carries parameters the POST does not |
| 3 Update | a `PUT` or `PATCH` | the body (unwrapped) patches the entity the URL named whose schema has every field the body may carry; without a spec, the row or single the URL named, when every body key is a field it already has |
| 4 Delete | a `DELETE` whose resolved URL is a keyed list's current URL plus one path segment, built from a row of that list | the row is removed (no spec needed) |

- Patches merge. A field the response omits stays; a row created by rule 2 lacks fields only the server sets until the next load or event. Fields that already hold the value are not written: a base write to an item drops an older pending layer's changes to that item (as a server event does), so a confirmation that changes nothing must write nothing.
- Never by type alone: a response `Article` does not replace the single `article` unless the URL read it; a response `Profile` does not touch `article.author` unless the URL read it. A `DELETE` on a sub-resource (`/articles/{slug}/favorite`) removes nothing; a `DELETE` of a single-object resource's URL leaves it (the page usually navigates).
- Rules 1 to 3 need the spec (`sinter({ apis })`); untyped pages get rule 4 and the body-only form of rule 3.
- `data-sn-write-through="off"` turns it off for one element. `data-sn-call` has no write-through.
- `SN510 redundant-write` (warning): a `then` that `merge`s or `upsert`s a resource with `$result.<path>` a rule applies, or `remove`s the row a rule 4 removes. Dev builds log each application with `console.debug` (a trace, which strict mode does not fail on): `write-through after POST /api/articles/x/favorite: articles: merge, feed: merge`.
- RealWorld (2026-11-08): 12 of 19 `then` handlers went, among them every favorite and follow button and the comment form's `upsert`.

### Resource names
`merge(item, …)` and `remove(item)` take no resource name (added 2026-11-10; the forms with one are `SN317`). The compiler resolves where the item came from, as write-through resolves what an action is about: a loop row (for `a in (x ? feed : articles)`, either list; through `filter`, `slice`, `toSorted`, `toReversed`, or a helper that takes exactly one resource or list with a source; a helper that takes two is `SN317`), an element of a list (`list[i]`, `.find()`, `.findLast()`, `.at()`), a single resource, a `data-sn-let` name or a component prop that is one of those, a component event's `$event.detail` when the component emits one of those, `structuredClone()` of one, and a state path a handler on the page assigns one of those (`sel = m`; every assignment counts). It passes those resource names to the runtime ahead of the item; the runtime changes the item in the first that holds its key (a single resource is the item itself). An item with none of these sources is `SN317`, naming what to use instead: write-through for `$result`, `<sn-event resource op>` for a payload, the instance API for a custom element's event. State that holds a row stays a snapshot: sinter does not rewrite values in state; `merge(sel, …)` finds the item by its key.

`refresh()`, `upsert()` and `page()` take the resource itself (changed 2026-11-20; they took its name as a string, now `SN301` naming the form): a resource (`refresh(people)`); `c ? x : y` where `x` and `y` are references (the test is any value expression); `x || y` and `x ?? y`; or a `data-sn-let` name whose value is one. The compiler lists the resources it can be and compiles each leaf to the resource's name, so the runtime still looks names up; a let used both as a list and as a reference is both.
```html
<div data-sn-let="{ shown: searching ? results : messages }"
     data-sn-on-list-next="page(shown, 'next')"
     data-sn-on-mail-saved="refresh(shown, unread)">
  <template data-sn-for="m in shown">…</template>
</div>
```
- **Compile time.** Every resource the reference can be gets the checks: `SN301` (an undeclared one, did-you-mean; for a let it is reported where the let is read), `SN303` and `SN304` for each one `page()` can take. A reference whose resources cannot be listed (state, a call) is `SN301` with the forms allowed. Each one counts as used (`SN501`).
- **`sinter check`.** The checked source names each leaf as its string (`page('results' …)`), so the store's types (`K extends keyof R & string`) check the targets per resource.
- **Runtime.** The store functions look the name up when they run; with a hand-written IR, an unknown name makes the store function throw, the rest of the handler is skipped, and the error is reported as any handler's.
- **`$meta`.** A computed key that is a reference (`$meta[shown].hasNext`) gets `SN301` and `SN303` per resource and depends only on `$meta.<name>.<field>` for each; any other computed key is accepted unchecked and depends on all of `$meta`.

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
- **Opting out**: `data-sn-catch` on the action. The app then handles the error itself: no field is marked and nothing counts as shown (`$error` is still set). `data-sn-call` marks no fields.
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
- Actions follow a concurrency policy, applied per element instance, so rows in a list never block each other.
- Same id, same control: when a `data-sn-if`/`data-sn-else` swap removes an element whose action is running or
  waiting, the element with its `id` in the new branch carries on that state (its queue, `block`, `latest`, and
  `aria-busy`), as it takes the focus. A toggle's two buttons (a POST and a DELETE, swapped at once by an optimistic
  change) are then one control: a quick second click queues behind the first instead of racing it, so the server
  ends as the page shows. The twin's own triggers follow its own policy. Nothing else carries over (an element's
  field errors, its debounce, a `confirm` it is asking). A part of the site's core (`TWIN` in src/runtime/flags.ts,
  2026-11-20): a build keeps it only when a page has branches and an action's element with an `id` or a
  `data-sn-attr` (which may bind one; `IR.tw`), so an app with actions and no such element carries none of it (125 B gzip).

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
import { configure, onUnauthorized, loginRedirect } from '@tiaforge-ui/sinter';

// fixed request settings (credentials, a CSRF header) go on the API: sinter({ apis: { site: { headers: { 'X-Sinter': '1' } } } })
configure({
  request: [
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
      data-sn-optimistic="merge(note, {title, body})">
```

| Policy field | Default | Meaning |
| --- | --- | --- |
| `backoff` | `['1s', '30s']` | the first and the longest wait between tries; each failure doubles the wait, ±25 % (the stream's rule). `['5m', '5m']` is a fixed interval |
| `retries` | no limit | how many times the request is sent again after the first try |
| `maxAge` | no limit | no new try once this long has passed since the first |
| `key` | `'Idempotency-Key'` | the header carrying a write's idempotency key; `false` sends none |

Durations are written as in `refresh` and `cache` (`30s`, `5m`, `1h`, `1d`); `retry()` throws on a value it cannot read, and when `get` names no policy. Without `retries` and `maxAge`, a policy retries for as long as the page is open.

- **Where.** `data-sn-retry` takes a policy name, on any action. No value is `SN401`; on an element without an action it is `SN102`. On `data-sn-call` (added 2026-11-19) the policy goes to each request the function sends through `ctx.request`, each with its own idempotency key; the function runs once (it may do more than send, and its requests differ), and a request's own `retry` in its init wins (`retry: false` sends it once). While the function waits inside a request it does not count as busy, the request does. Writes have no default policy: whether a write may be sent twice depends on what its endpoint does, which only its element can say. GETs (resource loads, `for` sources, pages) use `retry.get`, except background refreshes (`refresh`, which retries by itself), the session probe, next-page data and the early file's requests. A name `retry()` does not define fails the action with `$error.message` "unknown retry policy `x`"; with no `retry` configured at all, the write is sent once, as without the attribute (the check lives in the retry module, not in core). Dev builds warn at mount about both. The compiler does not read the config module, so the name is checked when the page runs.
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
- **While a write waits.** It counts as running for its element: `aria-busy` stays, and the element's concurrency policy applies. `latest` drops the waiting write when a newer trigger comes (no further try; a running try is never aborted), so after reconnecting only the newest draft goes: the policy for autosave. `queue` keeps later triggers behind it, in order. `block` (forms by default) keeps the form disabled until it settles, so a draft form says `data-sn-concurrency="latest"`. Writes of different elements are not ordered with each other; a page that must not run two writes to one item disables the second while the first is pending (the first element carries `aria-busy` while it waits). `then` runs when the write finally succeeds, possibly minutes later, against the page's state then. `online` ends the current wait.
- **Leaving the page.** While a write waits for a retry, the page has a `beforeunload` listener, so the browser asks before a link, a reload or closing the tab (in its own words; a custom message is ignored); it is removed once nothing waits, so it does not keep the page out of the back/forward cache otherwise. Nothing is sent on `pagehide`. iOS Safari never asks, and a tab closed from the app switcher fires nothing usable: there, closing the page loses waiting writes without warning. The page-wide signal is markup: `body:has(form[aria-busy]) .unsaved { display: block }`.
- **Reads.** A GET waiting for a retry is aborted like a running one (a `src` change, `when` turning falsy). `$meta.<name>.loading` stays true while an ordinary load waits; `error` is set only when the policy gives up. Concurrent loads of one URL share one request and so one retry. Unchanged reloads (`versions`) look at the response that finally arrives.
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
- The actions module is `src/sinter.actions.js` or `.ts`, read like the helpers module: export names, `export * as ns` namespaces, re-exports followed. Its functions may be async and have side effects.
- `data-sn-call` is exactly one call of an exported function or namespace member; anything else is `SN401`, an unknown name `SN310`. A method attribute and `data-sn-call` on one element is `SN102`, and so is `data-sn-body` on a call.
- An action is an action: the same triggers, `data-sn-trigger`, `data-sn-debounce`, `aria-busy`, the mutation concurrency rules (`block` for forms, `queue`, `latest`; a running call is never aborted), optimistic layers, `then` with `$result`, `catch` with `$error`, and the unhandled-error path.
- Arguments are value expressions evaluated when the action triggers; like `data-sn-body`, they see `$event`, e.g. `$event.submitter` to tell a form's submit buttons apart. The function receives them, then a context: `{signal, request, el}`. `request` goes through the request layer (401 handling, origins, timeout); `signal` aborts when the page is hidden; `el` is the element (null for a resource).
- A thrown `SinterError` reaches `$error` as it is; anything else becomes `{status: null, body: <the thrown value>, message}`.
- Action functions never write to sinter-managed nodes or to state: they return data, and `then` puts it where it belongs. Expressions cannot call them (`SN203`); helpers stay pure.
- A handler that wants to run an action (a keyboard shortcut, `<sn-resource then>`, chaining from `data-sn-then`) calls `run('id')` on the element that carries it; see Running an action from a handler. There is no `app.call()`.
- `<sn-resource call>` is a resource fed by a function: the arguments' dependencies play the role of `src`'s, so a change aborts the running call through `ctx.signal`, drops its late result and calls again (latest wins). `$meta`, `refresh()` and `refresh` events work as for `src`. `paginate`, `for` and `cache` do not combine with `call` in v0.2.
- `sinter check` types the arguments against the function's parameters without a trailing `CallContext`, and `$result` as the awaited return type. The page module imports only the actions it calls. A resource fed by `call` holds the awaited result at `select`: without `type` that is its type (no `SN504`); with `type`, the result must fit it, reported on `type`.

### Running an action from a handler (`run('id')`)
A handler cannot call an action function (`SN203`), because an action's lifecycle belongs to its element: `aria-busy`, concurrency (never aborted), the optimistic layer and its rollback, `then`/`catch` and the unhandled-error path. `run('id')` starts the action of the element with that id instead, and that lifecycle runs unchanged (added 2026-11-08, for Caley's mark-read after load and for keyboard shortcuts without a visible control; there is still no `app.call()`):
```html
<span hidden id="mark-read" data-sn-call="mail.markRead(open)"
      data-sn-optimistic="merge(open, {is_read: true})"></span>
<sn-resource name="body" call="mail.body(open)" when="open"
             then="$result && !open.is_read && run('mark-read')"></sn-resource>

<body data-sn-on-keydown-e="run('archive')">
  <button id="archive" data-sn-post="/api/archive?id={open.id}" data-sn-attr="{disabled: !open}"
          data-sn-optimistic="remove(open)">Archive</button>
```
- **Target.** The element with that `id` in the mount root (components included). It carries an action: `data-sn-post`, `-put`, `-patch`, `-delete` or `data-sn-call`, on any element, forms included. Elements with only `data-sn-on-*` handlers are not targets: their work is state writes the caller can make itself, or a helper both call.
- **Not a form:** `run()` enters where the trigger event would, so everything after the event happens as for a click: `data-sn-debounce`, `data-sn-confirm` (no means nothing happens), the concurrency policy, `data-sn-optimistic`, `aria-busy`, the request or call, `then`/`catch` and the unhandled-error path. No DOM event is dispatched: the target's own `data-sn-on-*` handlers do not run, nothing bubbles, and no default action happens (a link does not navigate, a checkbox does not toggle).
- **A form** is submitted with `requestSubmit()`, as Enter in a field does: constraint validation runs (an invalid form shows the browser's messages and is not sent), a real `submit` event fires, and sinter handles it as any submit, the form's `data-sn-on-submit` handler included.
- **Scope.** The target's expressions see the target's own scope (its `data-sn-state`, `data-sn-let` names, `$el` = the target), not the caller's. `run()` takes no arguments: what the action needs is state the caller sets first, `open = m; run('mark-read')`. It starts synchronously at the call, so the URL, body and call arguments see state assigned earlier in the same handler (debounce and an asynchronous `confirm` delay the start, as for a click).
- **`$event`** in the target's trigger-time expressions (URL, `data-sn-body`, `data-sn-call` arguments, `data-sn-confirm`, `data-sn-optimistic`, `data-sn-when`) is `null` for a non-form target, and the `SubmitEvent` of `requestSubmit()` for a form (`submitter` null). `sinter check` types it as `RunEvent<…>` in every element `run()` names (not a form): `$event.shiftKey` there is `SN208` ("Property 'shiftKey' does not exist on type 'RunEvent<PointerEvent>'"), `$event && $event.shiftKey` is not. (Checking runs without `strictNullChecks` unless the app's tsconfig turns it on, and there `Event | null` would be just `Event`, so the missing event is typed `void`, and `$event?.shiftKey` is reported too.) A button can then serve a click and a shortcut alike.
- **Ids are checked at build time** (`SN309 unknown-element-id`): the argument must be a string literal naming an element that carries an action; it must not sit in a `data-sn-for` row (every row would have the id: put one action outside the list and pass the row through state), and no other element may have the same id. A target inside a `data-sn-if`/`data-sn-else` branch is allowed.
- **When the target cannot run:**

| Target | Behaviour |
| --- | --- |
| disabled (`:disabled`: its own `disabled`, or a disabled `<fieldset>` around it) | nothing happens, no warning, as a click on a disabled button: disabling a button also turns off its shortcut |
| `inert`, itself or an ancestor (the attribute) | nothing happens, no warning, as HTML means by inert |
| `hidden`, `data-sn-show` false, off-screen | runs: a hidden carrier is the intended pattern |
| inside a closed `<dialog>` | runs: actions are bound at mount (refs are set then too); only value bindings wait for the dialog to open |
| not on the page (a `data-sn-if` branch that is not rendered, removed by a custom element) | nothing happens; dev builds warn |
| a `block` action with a request pending | the run is ignored, as a second click would be |

- **Concurrency.** The target's own policy applies, per element: `block` ignores the run, `queue` sends every run in order, `latest` keeps the newest waiting one; a running mutation is never aborted. `data-sn-concurrency="block"` on the carrier keeps one in flight and drops the rest.
- **No return value** (`undefined`). Results go where an action's results always go: the target's `data-sn-then` and `data-sn-catch`.
- **Where.** Every handler: `data-sn-on-*` (key filters included), `data-sn-then`/`data-sn-catch` (chaining: on success, run the next action), `<sn-event then>` and `<sn-resource then>`; it needs no element of the caller's. Not in value expressions (`SN203`) and not in `data-sn-optimistic` (`SN204`: a request cannot be rolled back).
- **Key filters** combine as any handler: `data-sn-on-keydown-mod-enter="run('send')"`. The filter has already called `preventDefault()`. Held keys repeat and every repeat runs the action through its concurrency policy; a shortcut that should not repeat guards itself, `$event.repeat || run('archive')`.
- **Cycles.** Actions are asynchronous, so a cycle is an endless series of requests, not a stack overflow: `data-sn-catch="run('save')"` on `#save`, A's `then` running B and B's running A, or a `<sn-resource then>` that runs an action whose `then` refreshes that resource. There is no runtime guard: the runtime cannot tell a loop from a retry. Warning `SN509 run-cycle` lists every such cycle with each step's element, handler and line: `` `#a` `data-sn-then` (index.html:4) runs `#b`, then `#b` `data-sn-catch` (index.html:5) runs `#a` ``. Edges are `run()` and `refresh()` calls in an action's `then`/`catch` or a resource's `then`; `data-sn-on-*` handlers are not edges (a user's event starts them), and a cycle needs at least one `run()`. Reported on every check (added 2026-11-20; it was opt-in, `checkCycles`). A guarded retry is a deliberate cycle: `strict: { allow: { SN509: 'why' } }` keeps it a warning.
- **Custom elements** have no `app.run()`: they talk back through events, and the page decides, `data-sn-on-reader-read="run('mark-read')"`. That keeps the page the only place that knows its ids.
- Recipe: "Run an action from a handler" (mark read after load, and a shortcut on a button).

### Lists you move through with the keys (`data-sn-options`)
Keys move a mark through a list of options and Enter clicks the marked one; the focus stays on the element with the attribute (the owner). A text field with suggestions (the WAI-ARIA combobox) is one use, a menu, a selectable list or a command palette others:
```html
<input data-sn-model="q" data-sn-options="hits" data-sn-on-sn-dismiss="open = false">
<ul id="hits" role="listbox" data-sn-show="open && hits.length">
  <template data-sn-for="h in hits"><li role="option" data-sn-on-click="q = h; open = false" data-sn-text="h"></li></template>
</ul>
<ul role="menu" data-sn-options>…<li role="menuitem" data-sn-on-click="…">…</li></ul>
```
- The attribute stays in the HTML for the `options` module (`KEPT_ATTRS`). On a text field the compiler adds `role="combobox"` and `aria-autocomplete="list"`; elsewhere `tabindex="0"` unless the element has a `tabindex`; with an id, `aria-controls`. On a `<select>`, a non-text `<input>` or a `<template>` it is `SN102`; a value that is not an id is `SN401`. `data-sn-listbox` is `SN101` naming the rename.
- The list: the element the id names; without one, the owner when it holds options, else the nearest `[role="listbox"]`, `[role="menu"]` or `[role="menubar"]` around it (in its parent, else further up), for inputs rendered in a loop. The options: its shown `[role="option"]`, `[role="menuitem"]`, `[role="menuitemcheckbox"]` and `[role="menuitemradio"]` without `aria-disabled="true"`.
- The mark: `aria-activedescendant` on the owner (an option without an `id` gets `sn-o-<n>`), `data-sn-marked` on the option, and `aria-selected` true or false on every `option` (menu items take no `aria-selected`); scrolled into view.
- ArrowDown and ArrowUp move it (ArrowRight and ArrowLeft with `aria-orientation="horizontal"` on the list or the owner, not in a text field). Enter clicks the marked option. Escape unmarks and fires `sn-dismiss` on the owner (bubbling and cancelable: one handler on a form can serve all its inputs, and an input's own handler can keep it there with `$event.preventDefault()`). The keydown is cancelled only when Escape closes something: on a text field with visible options, with a marked option, or when `sn-dismiss` was cancelled; otherwise it goes on, so a `<dialog>` around a menu closes. Other keys, and Enter without a marked option, do what they always do.
- In a text field: Tab clicks the marked option or the only one; up from the first unmarks; typing unmarks; a pick unmarks; a mouse press on an option of a list outside the owner does not take the focus from it. Elsewhere: Home and End mark the first and last, Space clicks like Enter, up from the first stays on it, and the mark stays after a pick.
- Picking is the option's own click handler. Considered and left out: marking the first option when the owner gets the focus (the arrow does it), tree items (their expand and collapse keys are a widget of their own), typeahead.

## Optimistic updates
An action with `data-sn-optimistic` changes the store before the request is sent, keeps the change when the request succeeds, and undoes exactly that change if it fails. It ships in v0.1 as the `optimistic` module.
```html
<button data-sn-patch="/api/email/message/flags"
        data-sn-body="{account_id: m.account_id, mailbox: m.mailbox, uid: m.uid, flags: ['\\Flagged'], set: !m.is_flagged}"
        data-sn-optimistic="merge(m, {is_flagged: !m.is_flagged})"
        data-sn-catch="emit('toast', $error.message)"
        data-sn-attr="{'aria-pressed': m.is_flagged}">★</button>
```

### Model: base plus layers
Each resource holds a base (what the server last confirmed) and an ordered list of optimistic layers. What templates see is the base with every layer applied on top, in order.
- On trigger, the `optimistic` expression runs against a recorder. Its `merge`, `upsert` and `remove` calls become one layer, tagged with the action's request.
- The visible state is recomputed; affected rows re-render immediately.
- Success (2xx, or a call that resolves): the layer is committed: its changes are applied to the base, then `then` runs, so a `then` write (`upsert(contacts, $result)`) goes on top of them and wins. What the page shows does not change at commit, so nothing flickers and nothing flips back. A server event or a reload that comes later wins too, as any later base write does. (Changed 2026-11-08: before, a success dropped the layer, so a change `then` did not write again flipped back until the next reload.)
- Failure: the layer is dropped, which is the rollback; `catch` runs. An aborted request is a failure; so is a `latest` trigger replaced before it was sent.
- Commits keep the layers' order: a layer whose request succeeds while an older layer is still pending waits on top of it, and joins the base once every older layer has settled (committed or rolled back). So the change made last stays on top, whatever order the responses come in. While it waits it no longer counts in `pending`, and a server write to the same item wins over it (it drops that layer's changes to the item).
- Server events always write to the base. Layers are re-applied on top, so an SSE update arriving mid-flight is neither lost nor overwritten by a later rollback; on success the layer is applied on top of it.
- A commit is a confirmed write: a load in flight when it happens replays it on its (older) response, as for any write made during a load. A load that starts after the commit wins.
This is why rollback is "drop the layer", not "restore a snapshot": with two overlapping actions on the same item, a snapshot restore from the first failure would wipe out the second action's change.

### Rules
- `optimistic` may only call `merge`, `upsert` and `remove`. Anything else is a build error, because local state and side effects cannot be rolled back.
- A layer's `merge` on an item that the base no longer has is ignored; a `remove` of an absent item is a no-op.
- An optimistic `remove` on a paginated resource also decrements `$meta.<name>.total` inside the same layer; its commit keeps the total down.
- A layer lives until its request settles, including the 30 s timeout and, with `data-sn-retry`, every try its policy makes; then it is committed or dropped.
- Bulk actions put all their changes into one layer, so they roll back together.
- Pending layers are not exposed to expressions (`$meta.<name>.pending` was, until 2026-11-20): the element whose request is in flight carries `aria-busy`.

### Typical cases

| Action | Optimistic change |
| --- | --- |
| Flag or mark read | `merge(m, {is_flagged: …})` |
| Delete or move mail | `remove(m)` |
| Bulk mark read | one layer with one `merge` per selected message |
| Delete contact | `remove(c)` |
| Toggle calendar visibility | `merge(cal, {hidden: !cal.hidden})` |


## Pagination
Pagination is declared on the resource and driven by `page()` calls; v0.1 supports keyset, offset and append modes in the `paginate` module.
```html
<sn-resource name="messages"
  src="/api/email/messages?account_id={$url.account_id}&mailbox={$url.mailbox}"
  select="messages" total="total" key="account_id,mailbox,uid"
  paginate="{ keyset: {cursor_sent_at: $item.sent_at, cursor_rowid: $item.rowid}, size: 50, params: { size: 'limit', direction: 'direction' } }"></sn-resource>

<nav>
  <button data-sn-on-click="page(messages, 'first')" data-sn-attr="{disabled: !$meta.messages.hasPrev}">«</button>
  <button data-sn-on-click="page(messages, 'prev')"  data-sn-attr="{disabled: !$meta.messages.hasPrev}">‹</button>
  <span data-sn-text="`${$meta.messages.from}–${$meta.messages.to} of ${$meta.messages.total}`"></span>
  <button data-sn-on-click="page(messages, 'next')"  data-sn-attr="{disabled: !$meta.messages.hasNext}">›</button>
  <button data-sn-on-click="page(messages, 'last')"  data-sn-attr="{disabled: !$meta.messages.hasNext}">»</button>
</nav>
```

### Modes

| Mode | Request parameters | `page()` targets | Fits |
| --- | --- | --- | --- |
| `keyset` | the cursor's fields read from the current page's boundary item + `direction` | `first`, `prev`, `next`, `last`; with `jump` also a page number | large or live lists where pages must not shift |
| `numbered` | `params.page` (1-based) + `params.size`; with `numbered: 'offset'`, the items to skip (`params.offset`) instead of the page | the above + a page number | lists that need "go to page N" |
| `append` | like `keyset`, `next` only | `next` | "load more", infinite scroll |

Keyset mode jumps only when the server can skip by offset as well. With `jump: true`, `page(messages, 7)` requests the `first` direction with `offset=300` (page size 50) and no cursor; `prev` and `next` then continue by cursor from that page's first and last items. Without it, a page number on a keyset resource is error `SN304`, with a hint to add `jump: true` or use offset mode. sinter never simulates jumps by stepping through pages. (Added 2026-11-05, for APIs such as Caley's mail list.)
- `numbered: 'offset'` (added 2026-11-10 as `offset-param`, then `params.offset`): page n sends `params.offset`=(n - 1) × `size` and `params.size`, no `params.page`, for APIs that take an offset (RealWorld's `?offset=20&limit=10`).
- `model: $url.page` (added 2026-11-13 as `page-model`, numbered lists only; replaces `start-page`, whose migration error went 2026-11-20): the list's page lives in the URL, read at load and written back on every move. The URL is the single source. The pager keeps `requested`, the page of its last request; its request, reloads (`refresh`, `pageshow`, `online`) and retries are built from the parameter (`pageParams(toPage(…))`). `page()` does not load: it computes the target and writes it (page 1 deletes the parameter), a push. `next`/`prev` count from `requested`, or from the shown page after a failed load; a target past `pages` is clamped when the total is known; with an unknown total, `next` is ignored while a page is loading; `prev`/`next` past the ends do nothing. `page()` to the page already requested reloads it when the last load failed (a handler writing the same value changes nothing). On a resource whose `when` is false, `page()` does nothing. The pager follows the parameter (it is among the resource's dependencies): it loads `toPage(param)` when that differs from `requested`, so a typed page field gets the typing pause and the pager's own write is no echo. The first URL a resource gets after mount (at mount, or when a late `when` turns true) reads the parameter and never writes: `?page=3` restores, with no clamp or correction (`?page=abc` is page 1). A change caused by popstate never resets: it loads the parameter's page. Any other later change of the resource's URL (a `src` change, a later `when` turning true) resets to page 1 and deletes the parameter, a replace: changing a filter on page 3 starts at page 1, and Back restores page 3. `when` turning false never writes. `$url.page` is the page asked for (it changes at once), `$meta.<name>.page` the page shown (it changes when the response arrives, and stays after a failure). Lists bound to the same parameter page together and reset together. The early request, the preload rule and `sinter-embed.json` (`start`) read it where `start-page` was (`pageParams` in `runtime/pages.ts`, shared by all of them). Errors: on another mode `SN401` with the reason (keyset page numbers are often unknown; keyset and append move by cursor); a value other than `$url.<query param>` (a path parameter, state, an expression, a list) `SN203`; the resource's own `src` or `when` reading the same parameter `SN401`, since each page write would reset the list. Lost with `start-page`: a start page from a path segment, from an arbitrary expression, and for keyset lists with `jump` (those start at page 1). Cursor-based lists (plain keyset, append) are not synced to the URL.
- The target may be computed: `page(results, $event.shiftKey ? 'prev' : 'next')`, or a helper's result, so one handler serves both directions. The compiler cannot tell a computed direction from a page number, so it accepts it, and `sinter check` types it: on a keyset resource without `jump` it must be a subset of `'first' | 'prev' | 'next' | 'last'` (a `number`, or a plain `string`, is `SN208`, whose message says to add `jump: true` for page numbers); elsewhere a direction or a number. A literal page number stays `SN304`; `append` takes only the literal `'next'`. (Added 2026-11-08, for Caley's keyset list.)
- At run time a target the resource cannot go to (a page number on keyset without `jump`, a string that is not a direction, `NaN`) sends no request: it takes the error path of a failed load, `$meta.<name>.error` with the reason and the unhandled-error path (see Unhandled errors), plus a dev warning. The next load clears the error.
- A jump target is clamped to `$meta.<name>.pages` when the total is known.
- `$meta.<name>.page` is the page holding the last item shown, `ceil(to / size)`, so it is exact after a jump, `first` and `last`, and approximate after cursor steps across items inserted meanwhile, as offsets always are on a live list.

### Server requirements for keyset
- `direction` takes `first`, `prev`, `next` and `last` (or the values `directions` maps them to). `first` and `last` send no cursor.
- `prev` and `last` read the list in reverse on the server, but the response is always in display order.
- The cursor fields must form a unique, stable sort key (e.g. a timestamp plus a row id).

### The `paginate` object (changed 2026-11-19: was nine attributes)

`paginate` is one object literal, read by `pageSpec()` (compile.ts) into the IR's `Paginate`, which did not change:

| Key | Meaning |
| --- | --- |
| `keyset`, `append` | the mode, and its cursor: an object literal over `$item`, the boundary item of the current page (its fields were bare names until 2026-11-20), its last item for `next`, its first for `prev`; `first` and `last` send no cursor. Fields that are `null` or `undefined` are left out, as in URL templates. Compiled with `expr(el, 'paginate', …, text, offset)`, so diagnostics point into the attribute |
| `numbered: true`, `numbered: 'offset'` | numbered mode: pages by number (was `offset: true` until 2026-11-20, `SN401` naming the rename); `'offset'` sends the items to skip (`params.offset`, default `offset`) instead of the page number. Naming `params.offset` switches nothing (changed 2026-11-20) |
| `size` | items per page, a positive whole number literal; required |
| `model` | numbered mode: `$url.<param>`, the URL query parameter that holds the page (see above) |
| `jump: true` | keyset mode: `page(name, n)` and `$meta.<name>.page`, sent as the items to skip (`params.offset`, default `offset`) |
| `params` | the server's names, string literals: `size` (default `limit`), `page` (default `page`), `offset` (default `offset`: sent by `numbered: 'offset'`, `(n - 1) × size`, and by a keyset `jump`), `direction` (default `direction`) |
| `directions` | keyset/append: the value sent for a direction where the server names it differently, e.g. `{first: 'forward', prev: 'backward', next: 'forward'}` (`first` and `next` may share a value: the server tells them apart by the cursor, which `first` does not send); directions not listed are sent by name |

- `more: 'has_more'`: a path in the response (as `total`, read from the whole response) whose value, as a boolean, says whether there are more items in the direction asked for: `hasNext` after `first`, `next`, a page number and an append reload, `hasPrev` after `prev` and `last`. It replaces the guess from a full page (`n >= size`), and on a numbered page wins over `pages`; `fill` passes `null` for data from `cache` or the prefetch, which keep no `more`, so those are guessed until the revalidation. Checked against the OpenAPI response (SN308, on `paginate`).
- `params`, `directions` and `more` are given once per API in `sinter({ apis: { main: { paginate: { params, directions, more } } } })` (`PaginateWire`, checked by `resolveApis`, `SN329`); a resource's own keys win, key by key for `params`. The API is the resource's `src` (`apiOf`); `file:` and `content:` resources have none.
- Errors are `SN401` at the key: one mode exactly, a `size`, known keys (did-you-mean), `model` only on numbered lists, `jump` only on keyset, `directions` not on numbered lists, string literals for names, `more` a string literal path. The old attributes (`page-size`, `size-param`, `cursor`, `direction-param`, `direction-values`, `page-param`, `offset-param`, `page-model`) are `SN101` (`PAGINATE_OLD`), as every renamed attribute is; `paginate="keyset"` with them is `SN401` with the object they become (`legacyPaginate`).

### `$meta` fields
`page` (numbered mode, and keyset with `jump`), `pages` (when `total` is known), `total`, `from`, `to`, `hasPrev`, `hasNext`, `loading`.
For keyset, `hasNext` is true when the page came back full; `hasPrev` is false after `first` or when a `prev` page comes back short. `from` and `to` are `null` when they cannot be known (after `last` without a `total`). `from` and `to` are tracked by the runtime from page moves.

### Rules
- A change to `src` (e.g. another filter value) resets to the first page (with `model`, the parameter is deleted, a replace).
- A refresh repeats the current page's exact request, so a refresh never jumps.
- `page()` during a pending page load aborts the pending one.
- After `last`, `hasNext` is false; after `first`, `hasPrev` is false.
- `append` mode keeps all loaded items; a refresh reloads them as one request with `size = loaded count`.
- Server events on paginated resources follow the rule in Sync: unknown keys trigger a reload of the current page.

### Past the ends
`page()` with `prev` does nothing while `$meta.<name>.hasPrev` is false, and with `next` while `hasNext` is false, in every mode: no request, no change. `first` and `last` always load (they send no cursor, so they also serve as "reload from the top"), and page numbers keep their clamping. A handler that pages in a computed direction needs no guard:
```html
<div data-sn-let="{ shown: searching ? results : messages }"
     data-sn-on-list-step="page(shown, $event.detail > 0 ? 'next' : 'prev')">
```
- Buttons keep their `disabled: !$meta.x.hasNext`, a binding with a fixed direction.
- `append` with infinite scroll stops sending requests at the end: after a short page `hasNext` is false.
- A live list that wants the items added after a short keyset page uses `refresh()` or a server event's `refresh`: a reload repeats the current page and recomputes `hasNext`.
- Before the first load has come back both flags are false, so `prev` and `next` do nothing then.

### Page transitions (`data-sn-transition`)

The page fade is CSS (`@view-transition { navigation: auto; }`; temper has it on by default). `data-sn-transition="'article-' + a.slug"` on an element in a list row and `data-sn-transition="'article-' + $url.slug"` on the detail page say they are the same thing: following the row's link morphs one into the other.
- The value is a value expression; the runtime keeps it on the element as `data-sn-vt` (an attribute binding). Pages that use the attribute get the `transition` feature (`@tiaforge-ui/sinter/runtime/transition`).
- Old page (`pageswap` with a view transition): when a click on a link started the navigation (the activation URL is the link's), the named element is the one the link is in or holds, else the one of its row: the nearest ancestor of the link that holds named elements, if it holds exactly one and no link to another URL. A back or forward navigation (`traverse`) on a page with exactly one named element uses that one. Its name goes to sessionStorage (`sn:vt`, with the time: a name older than 10 s, `PENDING_MAX`, is ignored and removed, so a navigation that reached a page without the feature leaves nothing a later page acts on).
- New page (`pagereveal` with a view transition): the first element whose name is the stored one.
- Reduced motion (`prefers-reduced-motion: reduce`, `Env.reducedMotion`; added 2026-11-22): nothing is named on either page and a pending name is removed unused, so the page only fades, if the app's CSS fades it (temper's `@view-transition` rule is inside `@media (prefers-reduced-motion: no-preference)`). A swap's own transition follows the same CSS (`wanted()` evaluates its `@media` conditions), so it does not run either under temper.
- Both get `view-transition-name: sn-<hash of the name>` (a valid ident for any name, the same on both pages) and `view-transition-class: sn-transition` until the transition finishes, so only the pair is captured, never a whole list, and two equal names on one page cannot end the transition. The class is for the app's CSS: `::view-transition-group(.sn-transition) { animation-duration: 300ms; }` styles every morph (the names are hashes).
- The new page's element must exist at its first paint, which is when the browser captures it, and the page module is `async`, so it may mount after that. So pages that use the attribute get a small classic script first in the head (the build only: the start of the page's own head script, `assets/<page>-head-<hash>.js`, see First paint). It does nothing unless a name is pending; then it turns the page module's tag, as the parser inserts it, from `async` into a deferred render-blocking module, which mounts in the parse's last task, before the first paint (`HOLD_SCRIPT` in `paint-build.ts`). The first paint then waits for the page bundle, only on a navigation that morphs. It waits for the mount, not for responses: the element must render from what the page has at mount (literal text, `$url`, `cache`, prefetched or embedded data). A swap can wait longer, since the old page stays on screen until its update ends: when a name is pending, no element has it at mount and the page has resources loading, the swap fires `sn-pagereveal` only once the element renders, the page's responses are in, or 500 ms (`REVEAL_MAX`) pass (`morphHeld` in `swap-run.ts`, so the pages carry none of it) (added 2026-11-22: signed in to RealWorld, an article's prefetch needs a CORS preflight for `Authorization` and lands after the mount, and its title is inside `data-sn-if="article"`). Measured 2026-11-09 in Chromium (RealWorld): list → article and back to a reloaded list both morph (3 of 3 runs each; before the hold script, back only faded). `e2e/navigation` checks both directions with the API slowed to 1.5 s.

## Rendering and scheduler
sinter updates the DOM fine-grained, without a virtual DOM: every binding knows its node, and only bindings whose inputs changed are re-evaluated and written.

### Mount
- One walk over the mount root's elements and comments (a `TreeWalker`, changed 2026-11-15: before, one `querySelectorAll('[data-sn]')`) builds the id → node table: `data-sn` elements and anchors' start comments (`<!--sn <n>-->`). A missing or duplicate id, or a node of another kind than the IR's tag, is a dev warning (1, 2, 3; a missing anchor is what a comment-stripping minifier leaves); an anchor's end is found from its start, skipping anchors nested between them, and one without an end gets one, with dev warning 31.
- Root bindings attach to their elements; `data-sn-state` scopes are created.
- Resources start loading (or read embedded data); syncs connect.
- One listener per used event type is added at the mount root.

### Template instances
- An instance is a clone of its head template's content (`<template id="sn-t-<id>">`, found once per template; for foreign content, of its wrapper's children) plus the nodes found by the IR's node paths, resolved once per clone (a one-element row clones just that element and keeps no node list). A nested anchor in a row is its start comment (tag `#`); walking an adopted early row, a path steps over a nested anchor from its start to its end comment.
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
| `if` (with its `else`), choice | insert or remove the instance fragment, before the anchor's end comment |


### Keyed lists
- The list keeps a `key → instance` map.
- On a change, unchanged keys keep their nodes; new keys get instances; missing keys are removed.
- Reordering uses a longest-increasing-subsequence pass, so the minimum number of nodes move.
- A row re-evaluates its bindings only if its item object was replaced, its own state path is dirty, or a dependency outside the row (e.g. `q`) changed.
- Selection bindings (added 2026-11-08). A value binding in a row whose value is `row side === outer side` (or `!==`), where one side reads the row (its item or index) and the other reads something outside it (`{active: row.id === selectedId}`, `{on: n === g.pick}` under an outer loop, `data-sn-show="r.id !== hidden"`), is marked by the compiler (`s` in the IR: both sides as functions, the outer side's dependencies). When only the outer side changes, the runtime re-evaluates the binding on the rows the comparison held for and on the rows whose row side equals the new outer value, found through an index built from the rows on first use; every other row keeps its value, which cannot have changed. Any other change to the rows (a reconcile, a row-side dependency) renders them as before and drops the index. The pattern is strict equality only: `==` is not an index lookup, a ternary around the comparison is not the pattern. The result equals evaluating every row.
- Reused nodes keep focus, selection, scroll position and half-typed input.
- A row that goes while the focus is in it (added 2026-11-22: a delete, an optimistic `remove()`, a server's event): the focus goes to the row now in its place (the next one; after the last row, the new last), to the element at the same index among that row's focusable elements (`FOCUSABLE`, not disabled, in a disabled fieldset, `hidden` or `inert`: the next row's Delete button for a Delete button), else to its first; with no row left, or none with a focusable element, to the list's parent element, which gets `tabindex="-1"` unless it takes the focus itself. Focus outside the rows that go stays where it is. Only a list's own rows: an `if` branch keeps its same-id rule.

### Scheduler
- All changes in one task are collected; one microtask flush evaluates dirty bindings and writes.
- Changes from server events (`<sn-sync>`: the store changes and state writes of `<sn-event>` mappings and their `then`) are applied when the event arrives, and rendered before the next frame is painted (`requestAnimationFrame`) instead of in a microtask, so a burst of events renders once per frame. Any other change (a handler, a response, a timer) still flushes in a microtask and renders the waiting server changes with it. A hidden page has no frames: there, server events flush in a microtask as before. Custom elements' `app.on()` listeners run when the event arrives, before that render. (Added 2026-11-10, from bench/live: at 4× CPU slowdown a dashboard kept up with 200 events/s when each one rendered, and with 5,000/s at 51 fps rendering once per frame.)
- The core never reads layout (`offsetHeight`, `getBoundingClientRect`), so a flush cannot force reflow.
- Bindings inside a closed `<dialog>` are kept dirty and evaluated on its `toggle` to open. A component script's refs (`data-sn-ref`, binding flag `r`) do not wait: they are set at mount (changed 2026-11-26, requested by sinter-alloy as S14).

### Events
- A delegated listener walks from the target up to the first element that handles the event: one with a handler or action for that type that ran; for keys, a matching filter, an action, a debounced handler, or a plain handler that prevented the key (see Which handlers run).
- A row element maps to its instance through a `WeakMap`, which supplies the loop scope.
- `input` and `change` from `data-sn-model` elements update state before other handlers on the same event run.

#### Which handlers run
Delegation walks from the target up, and the first element that **handles** the event ends the walk. On that element every applying handler runs, in attribute order, with its action's trigger. An element handles the event when:
- **Any event but keys and bubbling custom events** (`click`, `submit`, `input`, a custom element's plain `Event`, a `CustomEvent` that does not bubble): any of its handlers or an action for that type ran. A button or an action inside a clickable row keeps the row's `data-sn-on-click` from running.
- **Bubbling custom events** (`emit()`, custom elements' `CustomEvent`s, `sn-error`, `sn-dismiss`): no element ends the walk by handling them; it ends where a handler called `$event.preventDefault()`. See Custom events are notifications.
- **Keys** (`keydown`, `keyup`): a key filter matched (it calls `preventDefault()` first), an action ran, a debounced handler was scheduled, or a plain `data-sn-on-keydown`/`-keyup` ran **and `$event.defaultPrevented` is set afterwards**. A plain key handler that does not prevent a key passes it on, so `<body data-sn-on-keydown-shift-n>` still gets N while focus is in a grid whose plain handler takes only the arrow keys it calls `preventDefault()` for. To keep a key from ancestors, prevent it.
- A debounced plain key handler has not run when the walk decides, so it always counts as handled; a key that should go on past such an element needs a key filter for the keys the element uses instead.
- The editable-field rule applies wherever the walk goes: an ancestor's filter never takes a key typed into a field, so a key a field's plain handler passes on only reaches ancestors' plain handlers.
- Non-bubbling events (`focus`, `blur`, `toggle`, `close`, `cancel`, `invalid`, `scroll`, `load`) are seen by sinter's capture listener at the root and take the same walk: the nearest element from the target up with a handler for the type, an ancestor included (an inner `<details>` without a handler reaches an outer `<details data-sn-on-toggle>`).
- `run('id')` dispatches no event and takes no walk; a form it submits sends `submit` as usual.
- There is no sinter-level stop. `$event.stopPropagation()` keeps its native meaning: sinter's listener runs in the capture phase at the root, so calling it there also keeps the event from the target and any custom element's listeners, and does not end sinter's walk early (the walk has already ended at the element that handled the event).
- Cost: one property read per ancestor for the event types the page binds; the walk goes past an element only for a key it did not prevent.

Why this rule (decided 2026-11-08, from Caley's calendar, whose week-grid arrow handler hid the page's N and P): nearest-wins is what clickable rows with buttons, actions and forms rely on, so it stays; only plain key handlers changed, and their signal is the DOM's own for a consumed key, which handlers already give for keys they take from their default. Full DOM-like bubbling would have needed a stop at every inner handler, and opt-in attributes would have needed markup in each place.

#### Custom events are notifications
A bubbling custom event (`emit()`, a custom element's `CustomEvent`, `sn-error`, the `options` module's `sn-dismiss`) does not end the walk at the first element that handles it: it goes to every element from the target up to the mount root that has a handler for it, until a handler calls `$event.preventDefault()`. Clicks need nearest-wins (a button in a row is not a click on the row); a custom event says that something happened, and every level that cares hears it. A row that clears its own `saving` flag and a page that shows a toast handle the same `saved`:
```html
<main data-sn-state="{ toast: '' }" data-sn-on-saved="toast = m.saved()">
  <template data-sn-for="r in rows">
    <li data-sn-state="{ saving: false }" data-sn-on-saved="saving = false">       <!-- runs first, passes it on -->
      <button data-sn-post="/api/r/{r.id}" data-sn-on-click="saving = true" data-sn-then="emit('saved', $result)">
```
- **Which events.** Events that are `CustomEvent`s and bubble. Native events, and a custom element's plain `Event`, keep the rule above (the nearest element that handled it; keys go on when not prevented). A custom event that does not bubble (`bubbles: false`) keeps its nearest-ancestor reach: the custom element said it should not travel.
- **Order.** Inner to outer, as the event bubbles; on each element its handlers in attribute order, with its action's trigger. Everything runs synchronously inside the dispatch, so an outer handler sees the state the inner one wrote, every handler sees the same `$event.detail`, and statements after `emit()` in the emitting handler run after all of them. Each level has its own scope: `$el` is that element, its own state and lets. One flush renders all their writes.
- **Saying "final".** `$event.preventDefault()`: the walk stops after the element whose handler prevented it (the other handlers on that element, and its action, still run, as for keys). `emit()` dispatches a cancelable event, and so does the `options` module for `sn-dismiss`. `sn-error` is cancelable, and preventing it means "handled, no `onError`": an inner `data-sn-on-sn-error` that only logs lets the page's handler and then `onError` see the error. A handler on a non-cancelable custom event (a custom element's event without `cancelable`) cannot stop it (the DOM ignores `preventDefault()` there): every level runs. Custom elements whose events may be final at some level dispatch them with `cancelable: true`.
- **Debounced handlers** (`data-sn-debounce-<event>`) have not run when the walk decides, so they pass the event on; a level that must be final does not debounce, or prevents in a plain handler next to the debounced one.
- **Actions** triggered by a custom event (`data-sn-trigger="saved"`) pass it on too: an action does not prevent a custom event (an `<a>` action prevents only native events).
- **Custom elements and other listeners.** sinter's walk runs in its capture listener at the root, before the event reaches its target and bubbles to `document`, so app code listening outside sinter (`document.addEventListener('saved', …)`) still gets every event, and can read `defaultPrevented` to see whether a page handler took it. A custom element that dispatches a cancelable event and checks `dispatchEvent()`'s result to skip its own default (a `reader-close` the page may veto) sees a page handler that ends the walk as a veto too; a custom element that needs the two apart dispatches two events.
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
| `data-sn-with` | `innerHTML` and friends | only on custom elements; literal keys, no spread; `innerHTML`, `outerHTML`, `srcdoc` are `SN207` |
| `data-sn-class` | applying arbitrary existing classes | computed keys allowed (low risk); classes only, never other attributes |
| any binding on `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta>`, `<link>` or SVG `<animate>`, `<set>`, `<animateMotion>`, `<animateTransform>` | script execution, page takeover | `SN207` |
| `data-sn-attr` on a `<meta>` with a literal `name`, `property` or `itemprop` | none for `content` | only the key `content`; nothing on `http-equiv` or `charset` (`SN207`) |
| URL templates of resources, actions and streams | requests to an attacker-chosen origin, leaked headers | see Requests and origins |
| store merges, form serialization, `merge` fields, `$url` | prototype pollution | keys `__proto__`, `constructor` and `prototype` are dropped; objects built from input have a null prototype |
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
- Embedded data (`data-sn-resource`) is accepted only from `<head>`, at most once per resource name; anything else is ignored with a dev error.
- The runtime never reads named properties of `window` or `document` (`document.currentScript`, `document.scripts`, `window.<id>`), the pattern behind most published DOM clobbering gadgets in bundlers and libraries.
Configuration comes only from `configure()` in JavaScript, never from the DOM, so injected markup cannot change request scope, headers or schemes.

### Requests and origins
- A URL template must start with a literal same-origin path (`/` followed by a non-slash) or an origin listed in `sinter({ origins: [...] })` (or an API's origin; `configure({ origins })` is deprecated). A leading interpolation or `//` is `SN207`. This prevents the absolute-URL class of bug, where a full URL in a parameter overrides the intended base.
- At runtime, a resolved URL whose origin is neither the page's nor an allowed one is refused and reported through `onError`.
- Interpolated values are encoded with `encodeURIComponent`; values that are exactly `.` or `..` are encoded as `%2E` / `%2E%2E`, so they cannot climb path segments.
- Header middleware such as the CSRF header applies to same-origin requests only, unless it is scoped to a listed origin explicitly. A CSRF token never leaks to third-party hosts.
- Stream URLs of `<sn-sync>` follow the same rules.

### Client state is untrusted
`data-sn-state`, `$url` and persisted values can be changed by the user in the browser, and `$url` by anyone who sends a link; URL values reach models (as values, never markup) and `paginate`'s `model` (parsed as a whole number). The server validates every request on its own. Persisted keys are namespaced `sn:`, cleared by `loginRedirect`, and can be cleared with `clearPersisted()` on logout.

### Outside sinter's control
- Custom elements, user helpers and `onError` handlers are trusted code and must not pass server data, `$error.message` included, to HTML sinks themselves.
- Embedded JSON must be serialized with `<` escaped as `<`, so it cannot close its `<script>`.
- The server rejects state-changing requests without the CSRF header, never changes state on `GET`, and never answers credentialed CORS requests for arbitrary origins (which would defeat the header check).
- JSON responses carry `Content-Type: application/json` and `X-Content-Type-Options: nosniff`.
- Pages with sensitive data restored from the back/forward cache after logout are caught by the session probe, which runs on `pageshow` before any stream reconnects; a server that must never show them again sends `Cache-Control: no-store`.
- Expressions are authored code; their sandbox is a guardrail, not a security boundary (see Expressions and scope).

### Verification
- Compiler fixtures for every `SN207` case.
- An XSS payload corpus (filter-evasion cases such as encoded and whitespace-split schemes, mixed case, leading control characters, `srcset` lists) run through every runtime sink in Chromium, Firefox and WebKit.
- Injection tests: server-rendered markup containing `data-sn-*` attributes, forged `data-sn` ids and forged `data-sn-resource` scripts must stay inert.
- A DOM clobbering corpus (named `form`, `img` and `a` elements shadowing `document` and `window` properties) must not change runtime behaviour.
- URL tests: absolute and protocol-relative values, `.`/`..` segments and disallowed origins in every URL template position.
- The e2e navigation pages run under `script-src 'self'` and fail on any violation report. No test enforces Trusted Types yet.

### Supply chain and build
- The runtime has zero dependencies; the compiler's are few, pinned, and reviewed on update.
- The package has no install scripts.
- Releases are published only from CI through npm trusted publishing with provenance; maintainer accounts use 2FA and hold no long-lived publish tokens. This is the path that self-replicating npm worms abused through stolen tokens and `postinstall` hooks.
- The compiler uses a spec-compliant HTML parser (the algorithm browsers use, no regular expressions) and serializes its output from that tree, so the compiler and the browser always agree on which element an attribute belongs to.
- Component files are read from `src/components/` inside the project root only, symlinks included, so a build cannot inline files from outside the project.

## JS API for custom elements
Custom elements are custom elements that own imperative work (encryption, rich editors, canvas-like views); they get data through properties and talk back through DOM events, and may use the store directly.

### Data in, events out
```html
<template data-sn-if="selected">
  <mail-reader data-sn-with="{message: selected, unlocked: vaultUnlocked}"
                data-sn-on-reader-flag="merge(selected, {is_flagged: $event.detail})"></mail-reader>
</template>
```
- `data-sn-with` assigns JS properties, so custom elements receive objects, not strings.
- A custom element's module may define its element after the page has mounted (a lazy `import()`). Until then, a property sinter sets is a plain own property of the element, readable but hiding the class's accessor once it is defined. So for an element that is not defined yet, sinter remembers the latest value of each property and, when `customElements.whenDefined()` resolves (a microtask after the upgrade, so after the constructor and `connectedCallback`), deletes the own property and sets the value again, through the class's setter. A class field the upgrade redefined gets the latest value too. Elements already defined pay one `customElements.get()` per write. (Fixed 2026-11-08; Caley had an `upgradeProps()` workaround.)
- A custom element dispatches `CustomEvent`s with lowercase kebab-case names (`reader-flag`), bubbling; `data-sn-on-<name>` handles them at every level until one calls `$event.preventDefault()`, so an event that may be final somewhere is dispatched with `cancelable: true` (see Events, Custom events are notifications).

### Instance API
```ts
import { instance } from '@tiaforge-ui/sinter';

const app = instance(document);            // the instance mount() created

const messages = app.resource('messages'); // Resource<T>, see Resources and store
messages.subscribe(change => { /* … */ });
messages.merge(msg, { is_read: true });

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
- Components with a script never write to sinter-managed nodes; neither do custom elements (plain custom elements). Markup written inside a custom element in the page is bound like the rest of the page.
- Direct store writes from custom elements go to the base, like server events; unconfirmed changes use `app.optimistic()`. Both follow the base/layer model, so SSE and optimistic updates stay consistent.
- Multiple instances may exist (one per mount root); there is no global singleton.

## Developer experience
Errors should be found by the compiler, worded so that a person or a coding agent can fix them from the message alone.

### Diagnostics
Each diagnostic has `severity`, `code`, `message`, `file`, `line`, `col`, an optional `hint` and an optional `span` (what an editor underlines).

Every code, with its message, meaning and fix, is in [diagnostics.md](diagnostics.md), generated from `src/compiler/diagnostic-docs.ts`; codes are public API (strict mode's `allow` names them).


### Complexity (`SN507`)
Expressions that are too complex for markup are warning `SN507`, with the limit they exceed in the message. The measure is structure, never length in characters (added 2026-11-08):

| Limit | Default | Counts |
| --- | --- | --- |
| `statements` | 4 | `;`-separated statements in one handler |
| `sequences` | 0 | comma sequences `(a, b)` |
| `guarded` | 1 | steps one `&&`, `\|\|`, `??` or `?:` used as a statement runs: `a && closeDialog()` is 1, `a && (b = 1, closeDialog())` and `a && (b ? c() : d())` are 2 |
| `ternaries` | 2 | nesting of `?:`: `n === 0 ? 'none' : n === 1 ? 'one' : 'many'` is 2 |
| `arrow` | 8 | operations in one arrow function's body (`p => p.name.toLowerCase().includes(q)` has 3); a block body `{ … }` is always too many |
| `operations` | 15 | operations in one expression (each statement of a handler), the backstop |

Operations are calls, `new`, operators, assignments, updates, computed member access and functions; names, member paths (`a.b.c`), literals, and object and array literal structure are free, so a draft literal of plain fields costs nothing. Object attributes (`data-sn-state`, `-let`, `-attr`, `-class`, `-style`, `-with`) are measured per property value, and the warning names the property. The defaults leave filters (`people.filter(p => p.name.includes(q))`), single assignments of a helper's result, a guard over one call (`open && closeDialog()`), short object literals and one nested ternary alone; they were checked against the recipes, the RealWorld example and the e2e pages, which pass.
- The option of the Vite plugin, read by `sinter check` and `sinter lsp` too: `sinter({ complexity: { level: 'error' } })` fails the build on it, `complexity: false` turns it off. The limits are fixed (until 2026-11-20 each could be set; those keys now fail naming the change).
- What to do instead: see What belongs in markup.

### Type checking
`sinter check` type-checks every expression of the pages with the project's own TypeScript; it is opt-in and never runs in the dev server.
- A resource names the type of what `select` picks with `type`, a TypeScript type over the names the types module (`src/sinter.types.ts`, `.d.ts` or `.js`) exports: `<sn-resource name="contacts" … type="Contact[]">`. `type="any"` leaves a resource unchecked on purpose; a resource without `type` is warning `SN504`, unless `call` types it.
- State is typed by its literal. A value the literal cannot show takes a JSDoc cast: `{ editing: /** @type {Contact|null} */ (null) }`.
- Helpers and namespace members are typed by their own modules; `$event` and `$el` by the DOM types of the event and element; `$meta`, `$error` and the store functions by sinter.
- The check generates one JavaScript file per page under `.sinter/check/`, with every expression verbatim inside blocks that declare its scope, and runs `tsc` on them with `checkJs`. Each function that pages repeat (a component's markup) is written once, in a shared file per folder, and its errors are reported at every place it repeats (`vite build` and `sinter check`; `sinter lsp` and `checkPage` check each page whole). Errors map back to the HTML position (`SN208`).
- Null checks and implicit `any` are off: a binding that reads `null` renders nothing at runtime, and expressions in separate attributes cannot narrow each other.
- Branches narrow (added 2026-11-15): a `guard` frame (`Scope.guards`, `Compiler.guarded`) puts what is inside a `data-sn-if` template under `if (!(<condition>)) return $any;`, and its `data-sn-else` under the negation; a choice's `data-sn-else` under `!((<key>) === '<a>' || …)` over the candidates (convention and map; `branchGuard`). Guard lines are quiet regions (`quietLine`): an error in a condition is reported once, at its own attribute. A component's markup starts without the caller's guards.
- `sinter check` reads the pages and options from the Vite config, or takes pages as arguments. `vite build` runs it at the end when the project resolves TypeScript and fails the build on errors (`typecheck: false` turns it off; added 2026-11-20, it was opt-in).
- OpenAPI: `sinter({ apis: { main: { openapi: 'openapi.yml' } } })` (one spec per API; local JSON or YAML files, so builds stay deterministic). A resource without `type` is matched to a GET operation: the `servers` URL prefix is stripped from `src`, the query string dropped, literal segments match literally, a segment that is one interpolation matches a `{param}`, and a literal path beats a templated one. Its type is the first 2xx JSON response's schema at `select`, converted to TypeScript by sinter (named schemas become named types). The match runs in every build, not only in the check: an `select` or `total` the schema lacks is `SN308`, a literal query parameter the operation does not declare is warning `SN505`. No match leaves the resource untyped (`SN504`, naming the closest path).
- Actions are matched like resources, with their own method: `data-sn-body` must fit the JSON request schema, and `$result` in `then` has the response's type (`any` without a match).
- `$result` in `<sn-resource then>` has the resource's type: its `type`, the matched OpenAPI response at `select`, or for `call` the action's awaited result at `select` (`any` for an untyped resource).
- Server events: `type` on `<sn-event>` types the payload, using the types module's names. an `upsert`'s `value` must be assignable to the resource's item and a `merge`'s to a part of it, so a payload that does not fit the resource is an error. `then` is checked with the payload and the state around the `<sn-sync>` in scope. `cursor` reads the resource's own item. An event with payload expressions and no `type` is warning `SN506`; `type="any"` opts out.
- `checkPage(html, { files, types, openapi })` from `@tiaforge-ui/sinter/check` runs the same check on one page in a temporary project, for tests.

### Dev runtime
The dev build adds checks that need real data: duplicate keys in a response, an item missing a key field, an `select` path that is not an array, a server event payload missing key fields. Warnings name the resource, the page and the offending value.

### LLM support
- `llms.txt` in the package, short enough for a shell's `cat` to show whole (under 25 KB; Claude Code keeps about 30 KB of a command's output): the opening rules, the attribute and element reference, the scope rules, what belongs in markup, the magic names and store functions, and an index of the other sections as `sinter docs` topics. `llms-full.txt` beside it has everything, eight copy-paste recipes included (list with filter, form dialog, field errors, SSE sync, optimistic toggle, pagination in the URL, typed resources, local actions), and `sinter docs` prints from it. Both are generated from one source (test/docs.test.ts).
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

Rules: every bug fix adds a failing test first, and every code example in the docs and in `llms-full.txt` is executed as a test.

### Encouraging app tests
- Every recipe in the docs and in `llms-full.txt` has its test in `docs/recipes/`, executed by the suite.
- `llms-full.txt` has a testing section (`sinter docs testing`), so coding agents write a test next to the markup by default.
- Failures are readable: an unmatched request prints the request and the routes; a failed render prints the build diagnostics.

## Worked example: contacts page
A contacts page that exercises resources, SSE sync, filtering, a form dialog with repeatable fields, optimistic delete and the 401 path.
Endpoints used: `GET /api/contacts` → `{addressbooks, contacts}`, `POST /api/contact` (create or update, returns the contact), `DELETE /api/contact` (JSON body), and the `contact_updated`, `contact_removed`, `contacts_changed` events on `/api/events/stream`.
```html
<sn-resource name="contacts" src="/api/contacts" select="contacts"
             key="account_id,uid,addressbook_href" order="fn_name"></sn-resource>
<sn-resource name="addressbooks" src="/api/contacts" select="addressbooks"
             key="account_id,href"></sn-resource>

<sn-sync src="/api/events/stream">
  <sn-event name="contact_updated"  resource="contacts" op="upsert" value="$event.contact" when="$event.contact"></sn-event>
  <sn-event name="contact_updated"  resource="contacts" op="refresh" when="!$event.contact"></sn-event>
  <sn-event name="contact_removed"  resource="contacts" op="remove"></sn-event>
  <sn-event name="contacts_changed" resource="contacts" op="refresh"></sn-event>
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
        data-sn-then="upsert(contacts, $result); draft = null; closeDialog()"
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
- Markup used on several pages goes in a component: `src/components/contact-card.html`, used as `<contact-card data-sn-with="{ contact: c }">`.

## Open questions
- State reactivity depth. Decided: compile-time path invalidation, default identity keys, `update()` for custom elements, dev-mode detector, resources read-only (`SN205`), copies via `structuredClone`. See Expressions and scope.
- $meta naming. Decided: `$meta.<name>.<field>` with a fixed field set. See Resources and store.
- Mutation concurrency. Decided: `block` for forms, `queue` otherwise, `latest` on request via `data-sn-concurrency`; running mutations are never aborted. See Actions.
- Safe globals. Decided: "JavaScript yes, browser no", `new` allowed, `$now` for time, warning `SN502`. See Expressions and scope.
- Session probe trigger. Decided: the probe gates every reconnect; 401 goes to login, network errors back off. See Sync.
- i18n source. Decided (2026-11-08, replacing "no built-in `t()`"): built-in messages (`m.key()`) from the inlang message files, one file per page and language loaded before the first paint. Reasons: sinter cannot rely on a server to pick the language or inline the text, so the browser must; a per-page, per-language file loaded in the early step is a one-time cost per page and deploy (cached by its hash) and gives the fastest correct first render; paraglide's runtime was most of the early chunk; the consumer (Caley) used only plain strings with `{param}`s; keeping the inlang file format keeps its tooling. Plurals and variants are deferred. Apps without messages pay nothing. See Messages. Superseded 2026-11-21 (docs/proposals/axes.md §7): a page has one language, chosen at build; the runtime picker and the language files are gone.
- Keyset jumps. Decided: keyset never jumps (`SN304`); jumps need a numbered list or `jump`; server requirements for keyset written down. See Pagination.
- Testing utilities. Decided: `@tiaforge-ui/sinter/testing` ships in v0.1 as stable API; sinter tests itself through it. See Testing.
- Path parameters. Decided (2026-11-04): `<html data-sn-path="/article/:slug">` declares the URL shapes a page is served for; the runtime matches `location.pathname` once and exposes `:name` segments read-only in `$url`. No client-side routing: the server still picks the page, links stay full page loads; dev and production rewrites are the deployment's job for now.
- Optional query parameters. Decided (2026-11-04): a query parameter whose interpolated value is `null`/`undefined` is omitted from the URL, so one resource covers lists whose filters come and go.
- Templates shared across pages. Decided (2026-11-10): components, expanded at build time, with props, slots and events; `<sn-include>` is removed. See Components and `docs/proposals/components.md`.
- Handlers at several levels. Decided (2026-11-08): nearest wins unless the element did not handle the event; a plain key handler handles a key only when it prevents it. See Events, Which handlers run.
- Running an action from a handler. Decided (2026-11-08): `run('id')` starts the action of the element with that literal id (`SN309`), keeping its lifecycle; `$event` is null (forms are submitted), disabled and inert targets do nothing, no return value, no `app.run()` for custom elements, cycle check `SN509` opt-in. See Running an action from a handler.

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

`sinter({ localePrefix: true })` takes its languages from the content module's `languages({ base, list })` (`src/content.ts`, found by `loadContent`, which loads `perLocale` collections for them; an inlang project's with `inlangLocales`), checked by `checkLanguages`: a `base` among `list`, each a language tag. Each source page is built once per locale as `<root>/<locale>/<page>`: the build's input is replaced by those paths, `resolveId` and `load` serve them from the source page, and `build()` compiles the source (`file` is the source, so diagnostics, components and layouts are as written) with the compile option `locale: { name, urls, base }` and the content namespaces' entries in that language as `contentNs`, then rebases the output from the source's folder to the language's (`rebaseHtml`). In the compiler: `$locale` and `localeUrl` compile to constants (`localeUrl` from `urls`, or for a page whose paths all have parameters `base + l + location.pathname.slice(…)`); calls of a content namespace add no `$locale` dependency and are written in attributes too; built-in helpers add no `$locale` dependency, and the build-time evaluator has `number`, `bytes` and `date` of a calendar date in that locale (the runtime's `number`, `bytes` and `date`, with that locale for the call; any other date throws, so it is formatted in the browser); in the page module and the early script each entry the code calls is compiled in with that language's entry (`contentLines` in `src/compiler/index.ts`: the formatter's `inline()`, `m$title = () => "Über uns"`, or the entry and the formatter), and the page module and the early file (when it calls a built-in formatter) call the core's `$lang(locale)`, the config's locale source unless the app set one; the namespace's module reads the entries the app's modules call from `script[data-sn-ns][lang]` on its first call, and an app module that calls an entry the formatter cannot inline imports the formatter and registers it (`install(null, format, ns)`, added by the plugin's transform, `withFormatter`); nothing waits for a dictionary; assigning `$locale` is `SN203`; `data-sn-path` patterns get the prefix after `base`; `<html lang>` is the locale; the page module sets the `locale` cookie (`Path=/`, a year, `SameSite=Lax`) before mounting. No page in a language gets the picker or a language file: the plugin writes the entries the page's bundled modules and early file call (`moduleKeys`), in that language and packed by the formatter's `pack()`, into its head as `<script type="application/json" data-sn-ns="m">` (in dev, the namespace's every entry). The pages plugin adds `hreflang` links (with `site`) and links into the page's language (`relocateHtml` with the locales: a page's same-language pages also by their unprefixed paths; `<a hreflang>` is left alone), writes a chooser (`chooserHtml`) at each source page's unprefixed file (its `pageFile`; `404.html` and `200.html` are the base language's page, rebased), and the same chooser at a moved source page's file (`about.html`), so an old URL is one hop from a language. A chooser has a refresh to the base language's URL, `noindex`, `hreflang`, links to each language, and on a site where a page ships JavaScript a script: the `locale` cookie, else `navigator.languages`, else the base; to that language's URL of the page (a page with a fixed path: the URLs are in the script, so it works at any URL), or for a pattern page the same path under that prefix; query and fragment kept. `siteRoutes` adds the choosers' rules to the languages': each a rewrite with `choose`, the old file URL's too (`/about.html  /about/  200`); sinter-axum sends a fixed rule's request to its target under the language (`/about.html` → `/de/about/`), a pattern's to the request's path; the embed manifest has `locales: { base, list, at }` and a `choose` route for each fixed unprefixed URL too, and sinter-axum answers a `choose` route with a 302 (`Vary: Cookie, Accept-Language`) to `at + locale + '/' + rest`. `vite dev` serves a page in a language through `transformIndexHtml` at its URL (redirecting its other forms) and a chooser at an unprefixed URL.

## Implementation log

What was built, in order, and where it departed from the spec (was `docs/progress.md` until 2026-11-20; the
changelog lists the released changes).



### Layout

| Path | Contents |
| --- | --- |
| `src/ir.ts` | IR v1 types shared by compiler and runtime |
| `src/compiler/` | `compile()`: HTML rewrite, includes, expression checking and codegen, helper manifest |
| `src/runtime/` | store, scheduler, renderer, actions, request layer, config, helpers, security checks |
| `src/sse.ts`, `src/optimistic.ts`, `src/paginate.ts`, `src/persist.ts`, `src/cache.ts` | feature modules |
| `src/ws.ts` | WebSocket transport (imported by the app's config module, not a feature) |
| `src/vite.ts` | Vite adapter |
| `src/project.ts` | the app's helpers, config and types modules, found the same way by the plugin and the CLI; pages from the Vite config |
| `src/check/`, `src/cli.ts` | `sinter check`: shadow files, `tsc`, error mapping |
| `src/lsp/` | `sinter lsp`: JSON-RPC, the workspace of projects and open buffers, the TypeScript bridge, quick fixes |
| `editors/vscode/` | the VS Code extension: starts the project's `sinter lsp` |
| `src/compiler/diagnostic-docs.ts` | example, meaning and fix per code; `docs/diagnostics.md` is generated from it |
| `src/testing/` | `render`, `mockRequests`, `mockStream` |
| `src/compiler/vocabulary.ts` | the attribute/element table; compiler, `llms.txt` and custom data derive from it |
| `test/` | Vitest suites (happy-dom); `test/compiler/golden/__out__` are file snapshots |
| `docs/recipes/` | the nine `llms.txt` recipes, each with its executed test |
| `scripts/size.mjs` | min+gzip per module (`npm run size`) |
| `scripts/release.mjs` | bump versions, date the changelog, commit and tag (`npm run release -- 0.3.0`) |

### Milestones

- [x] M0 scaffold: package, tsconfig, test runner
- [x] M1 compiler: HTML parse/rewrite, `<sn-include>`, attribute vocabulary, diagnostics
- [x] M2 expressions: parse, scope resolution, sandbox rules, dirty-path analysis, codegen
- [x] M3 runtime core: store, scheduler, bindings, keyed lists (LIS moves), if/else, model, events, closed dialogs
- [x] M4 request layer + actions: middleware, bodies, concurrency, then/catch, unhandled errors, 401
- [x] M5 SSE sync module: change messages, session probe, backoff, missed-event refetch, bfcache
- [x] M6 optimistic layers (actions and `app.optimistic()`)
- [x] M7 pagination: keyset, offset, append
- [x] M8 persist, `$url`, `$now`, `$locale`, helpers and namespaces
- [x] M9 testing module
- [x] M10 Vite plugin (transformIndexHtml, virtual page module, root-confined partials, full reload on change)
- [x] M11 diagnostics fixture per code, golden outputs + IR schema check, property-based tests,
      security corpus (URLs, CSS, injection, clobbering, pollution, origins), recipes with tests,
      generated `llms.txt` and `html-custom-data.json`
- [ ] M12 size budget: measured, not met (see below)
- [ ] M13 real-browser suite (Playwright on Chromium, Firefox, WebKit; Trusted Types + strict CSP run)
      (started: `e2e/transports` runs `<sn-sync>` over SSE, WebSocket and SignalR against real
      servers in headless Chrome)

### How it fits together

- The compiler resolves every identifier statically and emits one function per
  expression taking a scope object `$`: loop variables are `$.c`, state is
  `$.$s<n>.q`, resources `$.$r.contacts`, magic names `$.$url` etc., store
  functions `$.$f.patch`. Scopes are prototype chains (page → state → row).
- Dependency and write paths are strings like `$s0.draft.emails.{i}.value`;
  `{name}` is filled from the row scope at runtime, `*` matches any segment.
  A binding re-runs when one of its paths and a dirty path are prefixes of each
  other. Row-local reads (loop items) re-run only when the item is replaced.
- Resources hold base + optimistic layers; server events and `then` writes go
  to the base; an optimistic action records ops into a layer, dropped on settle.

### Log

- 2026-11-04: spec imported, plan written.
- 2026-11-04: compiler, runtime, feature modules and testing module in; the
  spec's test example passes. 38 behaviour tests (rendering, models, lists,
  actions, errors, 401, SSE, optimistic overlaps, pagination).
- Runtime rewritten as closures (private state minifies to short names);
  dev warnings, freezing and the outside-write detector moved to the `dev`
  feature module, which the compiler adds to dev builds only. Lists and if
  blocks use one end-marker comment instead of recursive node bookkeeping.
  The size script now minifies fully (Vite's lib mode keeps whitespace in ES
  output, which had inflated earlier numbers).
- js-framework-benchmark entry added (`bench/js-framework-benchmark`, results in
  [benchmark.md](benchmark.md)); flush and reconcile optimized from ~1.2× to ~0.94× Svelte.
  Found while optimizing: index reads across lists (`names[i]` in a row of another list)
  missed structure changes; fixed with a test.
- RealWorld example (`examples/realworld`), run against the official e2e suite: 130–133/140.
  Bugs it found in sinter, each fixed with a test: parenthesized expressions failed to parse;
  inlined partials shifted node paths (adjacent text merges in the browser); a load answered
  after a local write wiped that write (writes during a load are now replayed); mutations were
  cancelled by navigations (now sent with `keepalive`).
- URL templates omit query parameters whose value is `null`/`undefined` (spec addition, 2026-11-04).
- `data-sn-path` on `<html>` (spec addition, decided 2026-11-04 for the RealWorld app):
  path parameters in `$url`, read-only, several patterns per page. Server rewrites are not
  generated yet; the compiler puts the patterns in the IR (`ir.path`) so the Vite plugin can later.
- Fixed: delegated listeners were only added for event types used by root
  elements, so handlers used only inside template rows never fired.
- Vite plugin with a real build test; diagnostics fixtures for all 21 codes;
  golden outputs; property-based list and layer tests; security tests;
  recipes; generated docs. 129 tests pass, typecheck clean.
- 2026-11-05: pluggable stream transports. `configure({ transport })` picks one per `<sn-sync>`
  URL (EventSource otherwise); `@tiaforge-ui/sinter/ws` is a WebSocket transport (`{event, data}`
  messages or a `decode` function; http(s) stream URLs are opened as ws(s), so the compiler's URL
  rules are unchanged); SignalR is an `llms.txt` recipe with its adapter in the app. Transports now
  deliver parsed payloads (SignalR and WebSocket adapters parse themselves). `render()` falls back
  to the configured transport for stream URLs without a mock.
- 2026-11-05: type checking, phase 2 of the adoption roadmap (`type=` only; OpenAPI is phase 3).
  `compile(…, { check: true })` returns a check unit (expressions with positions and scope frames);
  `src/check/` writes one checked JS file per page to `.sinter/check/` and runs the project's `tsc`
  (TypeScript 7's native `tsc` works; no in-process compiler API is needed). New `type` attribute on
  `<sn-resource>`, `SN208 type-error`, `SN504 untyped-resource`, `sinter check` CLI,
  `sinter({ typecheck, types })`. The untyped RealWorld example (377 expressions) checks with no errors;
  that is a test.
- 2026-11-05: type checking, phase 3: OpenAPI. `sinter({ openapi })` loads JSON/YAML specs (`yaml` is now a
  dependency, required only when a spec is configured); `src/compiler/openapi.ts` matches resources to
  GET operations in every build (`SN307`, `SN308`, `SN505`); `src/check/openapi-types.ts` converts schemas
  to TypeScript. RealWorld now uses the Conduit spec (`examples/realworld/openapi.yml`): 15 of 15
  resources typed with no annotations, 0 errors (a test); a planted `article.titel` reports
  "Property 'titel' does not exist on type 'Article'. Did you mean 'title'?".
- 2026-11-05: type checking, last phase: actions match OpenAPI operations by method (`data-sn-body`
  against the request schema, typed `$result`: 20 of RealWorld's 23 `then` handlers), `type` on
  `<sn-event>` (payload typed, `item`/`set` checked against the resource, `SN506 untyped-event`), `cursor`
  typed as the resource's item, `checkPage()` for tests, and the "Typed resources, state and events"
  recipe. A value that is wrong as a whole is reported by TypeScript on the shadow's `return`; that line
  now maps to the expression's start.
- 2026-11-05: pre-launch fixes. The core's size budget is now 11 KB min+gzip (10.1 KB today); 5 KB
  was never met. `docs/diagnostics.md` is generated from `src/compiler/diagnostic-docs.ts` (example,
  meaning and fix per code) and ships in the package; diagnostics link to its section on GitHub
  (`github.com/tiaforge/sinter`).
- 2026-11-05: editor integration, phase 1: `sinter lsp` (`src/lsp/`: JSON-RPC framing, a
  `Workspace` of projects, pages, partials and open buffers, the LSP glue). Compiler diagnostics as you
  type; partials are compiled through the pages that include them; Vite entries are compiled on load
  (about 0.4 s for RealWorld, mostly Vite's config resolution); file watching reloads the project when
  helpers, types, specs or the Vite config change. `Diagnostic.span` gives attribute- and element-level
  diagnostics their full range. Reading the Vite config moved from `cli.ts` to `viteProject()` in
  `project.ts`. Tests drive the server over in-memory streams (`test/lsp/`).
- 2026-11-05: editor integration, phase 2: `src/lsp/typescript.ts` starts the project's
  `tsc --lsp --stdio` (TypeScript 7) per project, keeps one shadow per page open in it (written to
  `.sinter/lsp/` once so its tsconfig includes them, then changed in memory), pulls errors 300 ms after
  the last compile and maps them with TypeScript's range; hover maps the cursor into the shadow
  (`shadowPosition()` in `shadow.ts`) and the range back. Before TypeScript 7, the `sinter check`
  pipeline runs on save (tested with a fake TypeScript 5 package). `check()` is split into
  `writeSupport`, `shadowOf` and `typeDiagnostic` so both share them. RealWorld over stdio: a planted
  `article.titel` is reported 340 ms after the edit; a hover takes 6 ms.
- 2026-11-05: editor integration, phase 3: completion (`completionItem/resolve` forwarded to
  TypeScript), go to definition and the did-you-mean quick fix (`src/lsp/quickfix.ts`, which reads the
  suggestion from the message, so TypeScript's suggestions work too). In check mode the compiler keeps
  expressions with errors as `broken` (written last in the shadow; their TypeScript errors dropped,
  also in `sinter check`); state and loop frames and resources carry the location of their names, and
  the shadow maps its declarations there. `src/lsp/spec-location.ts` finds a schema or property in the
  spec with `yaml`'s source ranges. RealWorld over stdio: completion after `article.` 22 ms,
  definition of `title` → `openapi.yml:561` 23 ms.
- 2026-11-05: editor integration, phase 4: the VS Code extension (`editors/vscode`, plain CommonJS,
  `vscode-languageclient` 10.1.2, packaged with `@vscode/vsce` 4.0.0 to a 694 KB `.vsix`). It starts
  the `sinter lsp` of the nearest installation above each HTML file, one client per installation;
  middleware keeps a client away from files of a nested project. Its `html-custom-data.json` is kept
  current by the docs test. `docs/editors.md`: setup for VS Code, Neovim, Helix and Emacs. Tested with
  fakes for `vscode` and the client (`test/vscode/`); not yet run inside VS Code itself.
- 2026-11-05: data across page loads (roadmap item 3), phase 1. Sharing one stream across tabs was
  dropped (it changes what servers see per connection; the 6-connection limit is HTTP/1.1's). Instead,
  dev builds warn (code 18) when an EventSource stream's origin was reached over HTTP/1.1
  (`protocolOf()` in `dev.ts`, from Resource Timing; the SSE module calls `app.streamOpened` for
  default-transport streams only), and the spec, README and `llms.txt` say to serve streams over HTTP/2.
- 2026-11-05: item 3, phase 2: the page-load cache. `cache` on `<sn-resource>` (value: max age,
  `SN401` if malformed) compiles to `ResourceDef.cache` and adds the `cache` feature
  (`src/cache.ts`, 757 B gzip). The loader reads the entry on start (after embedded data) and reports
  every load to the feature (`fill`/`store` split in `createLoader`); the feature writes after loads
  and on `pagehide` for resources whose base changed (store `base()`, subscriptions fire for confirmed
  writes only). The request layer clears `sn:c:` entries on any 401, at `fetch` and after the
  middleware chain; `clearStored()` clears them too. `render({ session, storage })` and
  `memoryStorage()` in the testing module. Core: 10.30 → 10.53 KB gzip.
- 2026-11-05: RealWorld uses `cache` on all 9 resources and calls `clearStored()` on sign-in and
  sign-out. The e2e suite (local backend, `spa`) found that cached data set `loadedAt`, so the
  editor's and settings' login-redirect guard (`$meta.user.loadedAt && !user`) fired on a cached
  `user: null`: 5 tests failed reproducibly. `loadedAt` now stays null until the server answers
  (e582d83). After that: 134/140, the same 5 known failures plus 1 `page.goto` load timeout that
  passes alone (the baseline without cache had 5 such timeouts in one run).

- 2026-11-06: 0.2 roadmap, phase 1: benchmarks. `npm run bench` (`bench/runtime/`, its own Vitest
  config, not part of `npm test`) times the store (5,000 items ordered by name: ~10 ms per write,
  because every write re-sorts from arrival order) and one flush (0.2–0.3 µs per root binding;
  1.6 / 11.3 ms for one upsert into 1,000 / 5,000 sorted rows). `npm run size` measures a minimal page
  and every RealWorld page from a production build; budgets moved from the core to pages. Vitest 5
  dropped `bench()`, so the cases are plain tests that print tables.

- 2026-11-06: 0.2 phase 2, store fixes. The sorted list is patched per write instead of re-sorted
  (one upsert on 5,000 items: 9.9 → 0.007 ms); ties keep arrival order exactly, which the property
  test now checks against a full sort. `meta.total` is computed when the total or a layer changes,
  not when the list is read: a page that shows only `$meta.x.total` updates, and a load no longer
  needs a second flush pass. `setTotal` marks only `meta`. Lists are frozen in dev builds only
  (frozen arrays are 3–50× slower to copy and filter in V8). Core +481 B gzip.

- 2026-11-06: 0.2 phases 3–4 (builder calls, per-page core) stopped after measuring: positional
  builder calls save 250–345 B gzip per RealWorld page (~2 %), a per-page core about 0.3 KB on two
  pages (every page uses lists, conditionals and handlers). Both stay possible features.

- 2026-11-06: flush cost per root binding. A profile of one flush on a page with 4,000 root bindings
  showed two per-binding costs besides matching: every binding that matched ran
  `el.closest('dialog:not([open])')`, and every binding tested did a `WeakMap` lookup for its parsed
  dependencies, plus a `Set` lookup in the deferred set. The compiler now marks nodes that are a
  `<dialog>` or inside one of their block (`dl` in the IR; it replaces the runtime's
  `querySelector('dialog')` per row template), bindings keep their parsed dependencies, and the
  deferred set is consulted only when non-empty. Chrome 156, one change on 4,000 root bindings:
  0.49 → 0.18–0.24 ms; happy-dom (`npm run bench`), 2,000 root bindings: 0.41 → 0.10 ms. Row
  creation, select and update of 1,000 rows and mount unchanged within noise. Core −30 B gzip.
- 2026-11-06: identical expressions share one entry in the page's function table (`fn()` in the
  compiler keys by code). RealWorld article: 112 → 60 functions, 16,507 → 16,293 B gzip; index,
  profile and editor 28–55 B smaller. A first call costs about 5 µs per function in Chrome, so mount
  gains at most about 0.26 ms on the article page, not measurable in a page load's script time.
- 2026-11-08: `run('id')` (proposal reviewed the same day): a store function that starts the action
  of the element with that id through the trigger path (`trigger(rb, null)`), or `requestSubmit()`
  for a form; disabled (`:disabled`) and inert (`[inert]` on it or an ancestor) targets do nothing,
  a missing one warns (dev code 20). Compiler: element ids collected in `declare` (`PageInfo.ids`:
  action, in a row, count) for `SN311`; handlers' `run()`/`refresh()` calls (`flows`) give the
  `$event` typing of targets (`CheckExpr.run`, `RunEvent<E> = E | void`, because `E | null` is `E`
  without `strictNullChecks`) and the opt-in `SN509` cycle search. happy-dom does not match
  `:disabled` inside a disabled `<fieldset>` and passes the form as `requestSubmit()`'s submitter;
  the tests allow for both. Core +86 B gzip.

- 2026-11-08: loading optimizations without attributes (asked: "where there is a clear pattern we can just do"):
  preconnect links for origins literal `src`s name (compiler, `preconnects()`); low request priority for
  resources only dialogs read (`ResourceDef.lo`, from the function table's `$.$r.<name>`/`$.$meta.<name>`
  reads of nodes outside dialogs, templates inside dialogs tracked in `dlTemplates`; `SendInit.priority`,
  `fetchpriority` on the preload); a 250 ms pause for URL changes that keystrokes cause (the model
  handler marks its dirty paths as typing, `hits()` tells a loader whether only such marks reached it);
  refetch on persisted `pageshow` and `online` for resources no stream feeds. Core +230 B gzip.
- 2026-11-08: write-through (designed in the roadmap doc's "Write-through (0.9)" tab, decisions there). Compiler:
  `ExprResult.reads` (member chains rooted at a resource or a row; `LoopEntry.resources` for `cond ? feed : articles`),
  `ResourceDef.sch` from `namedSchema()` (`$ref`, identical inline copy, or inline projection: RealWorld's list
  response inlines an Article without `body`), `ActionDef.ap` from `applyDef()` (provenance with named sub-paths,
  response entities, request wrapper, the body's target), `SN510` from the `then` AST. Runtime: `src/apply.ts`
  (rules 1–4, unchanged fields skipped because a base write drops a waiting layer's changes to the item: the
  overlapping-actions test caught that), one hook in `send()`. The RealWorld check test doubles as the acceptance:
  12 handlers removed.
- 2026-11-09: next-page data (pitch item: "Astro for dynamic content", prefetch). Compiler: `prefetchParts()`
  (`CompiledParts.prefetch`, `CompileResult.prefetch`): `data-sn-path` patterns and the resources whose `src`/`when`
  read only `$url`, constants and helpers. `src/prefetch-build.ts`: `pagePaths()` (a file's served paths) and
  `prefetchModule()`; the Vite plugin describes every HTML entry once (`/@sinter/prefetch.js`, invalidated on HTML
  changes in dev) and passes `prefetch` to `compile()`, whose page module adds the feature. Runtime: `src/prefetch.ts`
  (delegated pointer/focus/touch listeners, 65 ms rest, handover of this page's own data, sessionStorage `sn:p:`),
  `ext.prefetch.take()` in the loader's start before the cache, `writes`/`writing` on the request layer (a mutation
  clears entries; an overlapping prefetch is dropped), the `x-sinter-prefetch` mark (removed before fetch; errors
  reject there; `onUnauthorized` skips it). Chosen over "use the prefetched response instead of a request": the next
  page revalidates, so the preload links and early requests are still taken (no unused preloads) and nothing older
  than one round trip stays on screen. The document itself is not prefetched (a `<link rel=prefetch>` cost 90 B gzip
  for a request a CDN usually answers fast; Speculation Rules would need `inline-speculation-rules` in the CSP or a
  response header). Real browser (RealWorld build, Chromium, API mocked at 1.5 s): hover → article and comments
  requested, the user handed over; the article showed 215 ms after the click, the fresh data at 1,591 ms. Size: feature
  1,366 B gzip; core +153 B; RealWorld article 19,971 → 21,306 B gzip, budget raised from 20 to 22 KB.
- 2026-11-09: Speculation Rules (`speculationRules()` in `prefetch-build.ts`, written by the plugin into every page; CSP hash
  logged in `closeBundle`) and prerender awareness (`app.shown()`; the SSE module connects through it; activation refetches
  every loader). `CompileResult.path` carries `data-sn-path` so pages without prefetchable data still get rules. Chromium,
  RealWorld build: `/article/post-1` fetched on hover with `Sec-Purpose: prefetch`, the navigation used it; with
  `'prerender'` the browser asked for `prefetch;prerender` but reported `PrerenderingDisabledByDevTools` (Playwright, also
  without request interception), so activation is covered by `test/behaviour/speculation.test.ts` only. Default stays
  `'prefetch'`: prerender runs pages nobody may see (requests, custom elements' side effects).
- 2026-11-09: `data-sn-transition` (`src/transition.ts`; compiled to an attribute binding writing `data-sn-vt`). Names are
  given at `pageswap`/`pagereveal` only, to the followed row's element and its match. A row is the nearest ancestor of the
  link holding named elements without links elsewhere (the first version climbed to `<body>`: a link to `/about` named the
  first row's image; the behaviour test caught it). Chromium, RealWorld: list → article morphs
  (`::view-transition-group(sn-1k2g1wp)` beside `root`, only the clicked title named); back to the list fades only: Playwright's
  Chromium reloads it (no bfcache) and the rows render after the first paint, which is when the browser captures.
  temper: `@view-transition { navigation: auto; }` in `core.css` (on by default, off with `navigation: none` in the app's CSS).
- 2026-11-09: holding the first paint while a morph is pending (`HOLD_SCRIPT`: a MutationObserver makes the async page
  module deferred and render-blocking before the parser prepares it). Tried first on a bare page with the module delayed
  400 ms: first paint 35 ms without the element, 420 ms with it. RealWorld back to a reloaded list: morphs, 3 of 3.
  `view-transition-class: sn-transition` on the named pair. Per-link prefetch opt-out dropped: the browser's rules can
  only skip a link by a marker in the page; `<html data-sn-prefetch="off">` is build-time and stripped.
- 2026-11-09: `e2e/navigation` (headless Chrome over `bench/swap/cdp.mjs`, which takes `CHROME_ARGS` now): hover → data and
  HTML prefetched; first paint with the prefetched title; morph forward and back. Its first run found that the back morph
  had passed by timing: the hold script waits for the mount, not for responses, so the list needs `cache` (it has it now,
  and the step slows the API to 1.5 s). Building with `prefetch: false` fails steps 2 to 5.
- 2026-11-09: touch presses wait like a hover (pointercancel ends it); the pending morph name carries its time (10 s).
  CI runs `e2e/navigation` (green on GitHub's Chrome, 13 s). CSP: tried in Chromium under `script-src 'self'`: inline rules
  blocked, rules from a `Speculation-Rules` header served as `application/speculationrules+json` work, as `application/json`
  rejected. So `speculation: { delivery: 'header' }` (a fixed-name `speculation-rules.json`; dev and preview send the header
  and type) and `docs/navigation.md` with the CSP part near the top; the README no longer mentions CSP. `e2e/navigation` now
  runs under that policy, and a step fails on any violation.
- 2026-11-09: Speculation Rules delivery, decided after testing each option in Chromium (not committed in between: header by
  default, then a `<link rel="prefetch">` default). No in-page file form exists (`<script src>`: "External speculation rules
  are not yet supported"; `<meta http-equiv>`, `<link rel=speculationrules>`: ignored). A `<link rel="prefetch">` is reused for
  the navigation only for cacheable HTML (`max-age=60` yes; none, `no-cache`, `max-age=0`, `no-store` no). So: inline by
  default (no server setup), the build adds the hash to a CSP `<meta>` (works, tested), a header CSP needs
  `'inline-speculation-rules'`; dev warns (code 22, buffered `ReportingObserver`: tested, it gets the report from before mount).
  `delivery: 'header'` stays the opt-in that no CSP blocks. `e2e/navigation` runs under a `script-src 'self'` `<meta>`.
- 2026-11-09: data and fonts before the first paint, from Lighthouse on RealWorld (bench/realworld/lighthouse.mjs). The early
  requests waited for the stylesheets (the early file is deferred) and skipped other origins; the article title (the LCP)
  needs its data and its font. A/B, mobile, median of 5 (LCP): base 3.0 s, Google Fonts inlined 2.8 s, early requests from an
  `async` file 2.8 s, both 2.3 s; desktop unchanged (1.0–1.1 s). Decided: (1) a page with early requests splits its early file:
  loaded `async` before the stylesheets (starts the requests), rendered by a ~60-byte render-blocking stub that imports it (one
  module per URL), instead of the prototype's second, near-duplicate requests file (3.2 kB gzip a page); one script cannot do
  both (an async render-blocking module that awaits the parse does not hold the paint, see Messages). (2) Other origins
  requested early only when listed in `sinter({ origins })`, on by default for those; the page module adds that list to the
  runtime's allowlist (`$origins()`), so apps list API origins once (RealWorld's config no longer does). (3) `<sn-resource early="off">` for a resource a middleware answers or changes (RealWorld's `user` logged a 401 from
  its preload). (4) Google Fonts inlined by default (the Angular CLI does; its RealWorld demo has the preconnect), cached in
  `node_modules/.cache/sinter/fonts`. Not done: other third-party CSS (the app's call), `font-display` (a visual choice),
  non-blocking CSS (the build cannot know what affects layout). The RealWorld article page's budget: 26 KB (its early file
  now carries the request code). Tested in Chromium under a `script-src 'self'` header CSP: no violations.
- 2026-11-20: next-page data for paginated resources (`prefetchParts()` no longer skips `paginate`; the loader's start takes a
  prefetched entry for one). The description carries the first page's parameters (`q`, `firstParams`) and, with `model`
  (paginate), the start read (`sp`: `{ f, k, s, o? }`, the early file's `startOf` without `qn`, since page n is `q` with `k`
  set); the runtime reads the page as `toPage` does, inline (importing `runtime/pages.js` moved that module into the shared
  chunk every RealWorld page loads: +390 B gzip a page; inline +208). Prefetch module 1,526 → 1,610 B gzip; RealWorld login
  27,615 → 27,823 B gzip. Keyset and append: the first page only (a later page needs the boundary item's cursor). The
  handover from the current page's own data stays off for paginated lists (the loader keeps the URL without the page).
- 2026-11-20: `prefetch: { html: { prerender: 'auto' } }`: the build prerenders the pages it can show do nothing on load
  but read (see Next-page data). Shaped as a value of `prerender` so it fits `html: { prerender, delivery }`; `'auto'` is
  not accepted as `html` itself. `<sn-sync>` is allowed: streams wait until shown. The app-module check is all modules for
  every page (not per page's imports): stricter, and one `describe` compile has no module text. Default unchanged.
- 2026-11-20: Back and Forward restore resources without `cache` (see the page-load cache). First built as the cache
  module on every page with a resource (822 → 1,010 B gzip): the minimal page +641 B gzip. Then, at the maintainer's ask
  to limit the runtime cost, split: a page with `cache` keeps the cache module (it handles Back too, through back.ts's
  `traversal()`, `keyOf` and `never`: 1,021 B gzip), a page without gets `@tiaforge-ui/sinter/runtime/back` (750 B gzip:
  no per-load writes, dirty tracking, age or eviction by age; a full storage drops the `sn:c:` entries and writes once
  more), and a page with no resource that can come back gets neither: only `for`, `call`, POST, `file:`, embedded (which
  wins over any entry: an `embed` build's pages) or `append` resources. A resource without `cache` writes at `pagehide`
  only, not after each load: no storage work while the page is shown. Against the work branch (24a49c5f): minimal
  11,090 → 11,505 B gzip (budget 12,288; +415, was +641 with the cache module), minimal with swaps 12,909 → 13,342
  (13,824); core −8 B; RealWorld login 27,712 → 28,137 (prefetch +84 of it, items 1 and 3). RealWorld keeps `cache`:
  it is for its ordinary loads too (a reload into the cached feed, the signed-in header on every page).
- 2026-11-26: `<html lang>` is the page's locale in an app that sets no locale (sinter-alloy S15; see Locale). Reverted
  once from #121 after review (the early file's `$lang` did not reach the shared head runtime's `$locale`, a bound
  `lang` on a layout's tag, a test's locale left across renders), then the app's own source detected at build
  (config and early modules and their imports), warning 35 as the net for what detection misses, and `$lang` only on
  pages that read the locale. RealWorld (`lang="en"`, no locale): article +31 B gzip, index and profile +32.

### Decisions and deviations

- `CompileOptions` gains optional `moduleSrc` (URL of the injected
  `<script type="module" src>`; an inline module script would break
  `script-src 'self'`) and `config` (app config module imported before mount).
- `MountOptions` gains `env`, `request` and `transport` seams for the testing module.
- `Transport.connect` takes a 4th argument, the event names to listen for
  (EventSource needs them), plus an optional `listen(name)` for late subscribers.
- Subscribers of `resource.subscribe()` get `{ op: 'refresh' }` after each full load.
- A plain `data-sn-on-<event>` handler and an action on the same element both
  run, the handler first.
- `helper(draft)` in a handler invalidates the whole `draft` root (opaque call);
  built-in helpers, namespace members and store functions do not invalidate.
  (Changed 2026-11-27: no helper call invalidates its arguments; see Method classes.)
- `render()` options also accept `files` (partials for `<sn-include>`). Mock
  responses are held until `settle()`, so `flush()` can observe optimistic state.
- Payload scopes (`<sn-event>`, `cursor`) resolve unknown identifiers to payload
  fields before the browser-API check, so fields like `name` work.
- Diagnostics in partials append the include chain to the message.
- `loginRedirect` stores the return URL in sessionStorage (`sn:return`);
  `takeReturnUrl(allow)` reads it back after login.
- `.` / `..` in a URL *path* interpolation is refused at runtime (reported via
  `onError`) instead of being encoded as `%2E`/`%2E%2E`: WHATWG URL parsing,
  and so `fetch`, turns `%2E%2E` back into a `..` segment. Query values are
  still encoded as specified.
- `SN503` fires for any `id`/`name` value that is not a literal and does not start with a
  non-empty literal string (`'contact-' + c.id`, `` `contact-${c.id}` ``): row-local reads have
  no dependency paths, so "bound from data" means "not a literal".
- Type checking of expressions turns off `noImplicitAny`, and `strictNullChecks` unless the app's
  `tsconfig.json` turns it on (`strictNullChecks`, or `strict`; read with `tsc --showConfig`, its
  `extends` merged): bindings that read `null` render nothing at runtime, and an app that does not check
  nulls in its own code is not made to in its markup. With it on, `data-sn-if="x"` around `x.y` narrows `x`,
  a state field that starts as `null`, `undefined` or `[]` is `any` (`State<T>` in the shadow, so
  `{ error: null }` then `error = $error` passes, as without it), and RealWorld's 7 pages had 2 errors,
  both `$meta.<name>.pages > 1` (`pages` is null while the total is unknown; now `?? 0`). A component file's `<script>` block is checked under all of the
  app's options instead: a second program whose generated tsconfig `extends` the app's
  (`.sinter/check/scripts/tsconfig.json`, and a second project in `sinter lsp`), so the block and a module
  beside the file are checked alike.
- OpenAPI types come from sinter's own schema converter, not `openapi-typescript`: that package builds
  its output with the TypeScript 5 compiler API and declares `typescript@^5` as a peer, which conflicts
  with TypeScript 7 projects (this one included). The converter also turns named schemas into named
  declarations, so messages say `type 'Article'` instead of spelling out the object.
- `type` on `<sn-resource>` is any TypeScript type over the types module's exports (`Contact[]`,
  `Page<Article>`); the shadow file brings the exports into scope with a JSDoc `@import`, so state casts
  use plain names too.
- The compiler's browser-API list does not include very generic names (`name`,
  `open`, `print`, `event`); they are `SN201` instead of `SN202`.

### Open / not yet done

- **Size budgets per page since 2026-11-06** (0.2 roadmap, decision 2): the minimal page (one resource, one
  text binding) ≤ 15 KB gzip (11.5 KB until 2026-11-07: 0.3's features took it to 12.1 KB, and the
  budget was raised rather than features moved out of the core), replacing "core ≤ 11 KB", and the
  RealWorld article page ≤ 20 KB (16.5 KB until 2026-11-07, when it stood at 16.9 KB), with every other RealWorld page reported (baseline in
  [benchmark.md](benchmark.md)). CI runs `npm run size -- --check`. The table below is the
  core budget's last measurement. Until then: **11 KB for the core, met** (it was 5 KB until 2026-11-05, which the core never reached). `npm run size` (rolldown bundle, oxc minify, gzip -9), 2026-11-05:

  | Module | min | gzip |
  | --- | ---: | ---: |
  | core (`mount`, `$k`) | 23.5 KB | 10.1 KB (11.5 KB before the closure rewrite) |
  | sse | 3.1 KB | 1.4 KB |
  | paginate | 2.9 KB | 1.2 KB |
  | persist | 0.7 KB | 0.4 KB |
  | optimistic | 0.2 KB | 0.2 KB |
  | dev (dev builds only) | 1.4 KB | 0.8 KB |
  | contacts page (core + sse + optimistic + persist) | 27.2 KB | 11.4 KB |

  The list performance work of 2026-11-05 (bench/swap, js-framework-benchmark) added 354 B gzip to
  the core (9,944 → 10,298 B), and compiled pages carry one element-lookup function per
  `data-sn-for` template (RealWorld's 7 pages: 18 functions, 275 B gzip in all).

  Marginal gzip cost inside the core: request layer + config ≈ 0.9 KB, store
  ≈ 0.9, app object/API ≈ 1.2, mount/bind ≈ 0.8, loaders ≈ 0.9, actions ≈ 0.7,
  lists ≈ 0.7, render ≈ 0.4, security ≈ 0.4, forms ≈ 0.3, models ≈ 0.3.
  Further trimming yields tens of bytes; 5 KB would need either moving
  parts (actions, forms, models, loaders) into compiler-selected modules or a
  different budget definition.
- Playwright suite in real browsers (`<dialog>`/`commandfor`, bfcache,
  `EventSource`, focus preservation), with Trusted Types and strict CSP.
- List-update benchmark in CI.
- From bench/live (2026-11-10), not needed now: `<sn-event op="merge" items="…">` (one event patching several
  items, so a tick of many rows patches a keyed resource instead of a `then` helper replacing a whole state value,
  and only the changed rows' bindings are checked); a frame-rate cap for server-event renders (e.g. 30 fps, to save
  battery). The dashboard at 4× CPU is now bound by style, layout and paint (about 30 % of the main thread).
- Release pipeline (CI-only trusted publishing with provenance).

