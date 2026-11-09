# Changelog

Attribute names, function names and diagnostic codes are public API. Before
1.0, renames are allowed but listed here.

## Unreleased

### Added

- Next-page data: when a link to another page of the app is about to be followed (the pointer rests
  on it for 65 ms, it has focus, a mouse press starts on it, or a touch stays on it for 65 ms without
  becoming a scroll), the resources of that page whose
  request only the URL decides are requested, and the next page shows them at once, then
  revalidates (`$meta.loadedAt` stays null until the server answers, as with `cache`). Data the
  current page already loaded from the same request is handed over without one. Requests go
  through the middleware chain with low priority; a failed one never starts a login redirect; a
  mutation drops what was prefetched. Nothing to declare: the compiler describes each page, the Vite
  plugin shares one module of every page's description, `sinter({ prefetch: false })` turns it off.
  New module `@tiaforge-ui/sinter/prefetch`. Testing: `render(html, { pages: { 'article.html': … } })`.
  RealWorld in Chromium with a 1.5 s API: the article shows 215 ms after the click instead of after
  the API answers.

- Speculation Rules: every page gets `<script type="speculationrules">` for links to the app's
  pages (their `data-sn-path` patterns or file paths, eagerness `moderate`). `sinter({ speculation })`:
  `'prefetch'` (default, the next page's HTML), `'prerender'`, or `false`. Under a CSP they need
  `'inline-speculation-rules'` or the hash the build prints in `script-src`. A prerendered page
  connects its streams once it is shown and refetches its resources then (`app.shown()` for features).

- `speculation: { mode, delivery: 'header' }`: Speculation Rules without an inline script, for a strict CSP.
  The build writes `speculation-rules.json` at the site root; the server sends
  `Speculation-Rules: "/speculation-rules.json"` with every page and the file as
  `application/speculationrules+json` (`vite dev` and `vite preview` do both). Guide: `docs/navigation.md`.
  `e2e/navigation` runs under `script-src 'self'` with it.
- `<html data-sn-prefetch="off">`: no other page prefetches this page's data or HTML, or prerenders it
  (for pages that do something when they load). Build time only: the attribute is stripped; anywhere but
  `<html>` it is `SN102`.
- `data-sn-transition` (value expression, a name): the same thing on two pages. Following a link from a
  list row to a page with an element of the same name morphs one into the other (cross-document view
  transitions; back from a page with one named element too). Only that pair gets a
  `view-transition-name`, during the transition. New module `@tiaforge-ui/sinter/transition`, added to
  pages that use the attribute. Testing: `r.window('pageswap' | 'pagereveal', { viewTransition, activation })`.
  Morphing elements also get `view-transition-class: sn-transition`, so
  `::view-transition-group(.sn-transition)` styles them all. When a morph is pending, the first paint of
  the next page waits for its page module (a small classic script in the head of pages that use the
  attribute), so data-rendered elements exist when the browser captures the page.
  RealWorld: an article's title morphs from the list, and back. For the morph back to a list, its rows
  must render from what the page has at mount: give the list `cache`.
- `e2e/navigation`: next-page data, Speculation Rules and morphs in headless Chrome.

### Changed

- The RealWorld article page's size budget is 22 KB (was 20 KB): next-page data adds 1.3 KB gzip to
  every page.

## 0.9.0 (2026-11-08)

### Added

- Write-through: a mutation's 2xx response is applied to the resources it is about, after the
  optimistic commit and before `then`. Four rules, nothing declared: (1) an object of a named
  OpenAPI schema in the response patches the same-key item in every list of that schema, and the
  row, single resource or nested entity the action's URL or body read (`{article.author.username}`
  names `article.author`); (2) a POST to exactly a keyed list's current URL inserts the created
  item: the response's, else the body merged with the response's key (`{id: 42}`), else the list is
  refetched; (3) a PUT/PATCH body patches the entity the URL named; (4) a DELETE of a row's URL
  removes the row. Rules 1 to 3 need `sinter({ openapi })`; untyped pages get rule 4 and the
  body-only update. Patches merge and skip unchanged fields. New feature module
  `@tiaforge-ui/sinter/apply` (loaded by pages with something to apply), `data-sn-apply="off"` per
  element, warning `SN510 redundant-write` for a `then` that writes what a rule writes, dev log per
  application. Resources are matched to schemas by `$ref`, by an identical inline copy, or by an
  inline projection with fewer fields (RealWorld's list response). RealWorld: 12 of 19 `then`
  handlers removed. Testing: `render(html, { openapi })`.
- Loading optimizations that need no attributes:
  - Preconnect: every origin a literal resource or stream `src` names (`https://api.example.com/…`)
    gets `<link rel="preconnect" crossorigin>` in the head, so the connection is made while the page
    bundle downloads (with first paint on). RealWorld's pages name their API origin on every resource
    and had neither a preload nor an early request for it.
  - Request priority: a resource that only elements inside `<dialog>`s read (bindings, state,
    actions and handlers there, templates of the dialog included) is requested with
    `priority: 'low'`, and its preload link with `fetchpriority="low"`: the visible content's
    requests get the bandwidth first. Any read outside, by another resource or by a stream keeps
    the default.
  - Typing: a resource whose `src` or `when` changes only through keystrokes in a text field
    (`data-sn-model` on an `<input>` or `<textarea>`, `input` events) waits 250 ms for the next
    keystroke before it requests, instead of one aborted request per keystroke. Any other change
    (a select, a handler, `$url`) is requested at once. `settle()` in tests runs the pause.
  - Coming back: a `pageshow` after a back/forward-cache restore and `online` refetch every
    resource. Resources a stream feeds are left to the stream's reconnect, which already refetches
    them. Testing: `window('online')`.
  - Core +230 B gzip (RealWorld article 18.0 → 18.2 kB).

### Changed

- Compiled row creation. For a simple row template whose bindings do not read `$el`, the compiler
  emits a creation function (`make` on the template in the IR) that walks to the bound elements,
  evaluates the value expressions inline and writes them through the runtime's per-kind writers,
  which are the same code the generic path uses (URL and style checks included). Creating 1,000 rows
  in Chrome: sinter's click-to-flush time 2.07 → 1.9 ms against vanillajs's 1.6 (10,000 rows: 20.5 →
  18 ms against 15.5). A class binding's first write on a clone knows whether the source element has a
  `class` attribute (`cl` on the node). Core +0.1 KB gzip; a page module grows by one function per
  simple row template.
- The creation function walks only to elements with value bindings: an element with only handlers
  (a row's remove link) is not visited, as its handlers bind on its first event. Creating 1,000 rows
  in Chrome, sinter's click-to-flush time: 2.41 → 2.21 ms (10,000 rows: 24.0 → 20.5 ms), median of
  three interleaved page loads each, with vanillajs at 2.21 and 19.6 in the same session (see
  `docs/benchmark.md`). The core is unchanged.
- Simple rows keep no binding objects. A row template whose elements carry only value bindings and
  handlers (no state, model, nested template or dialog) now stores its last values in one array per
  row and finds its elements again from the row's first node when it renders; handlers in such rows
  bind to their element on its first event. One-element rows keep no node list. Behaviour is
  unchanged (a debounced handler keeps its timer across events, `run('id')` finds a row's action);
  memory per row drops: 1,000 rows take 2.19 MB instead of 2.51 (vanillajs 1.87; see `docs/benchmark.md`). Core +0.45 KB gzip.
- Selection bindings: a value binding in a row whose value is `row side === outer side` (or `!==`),
  such as `data-sn-class="{active: row.id === selectedId}"`, is re-evaluated only on the rows the
  comparison held for and on those matching the new value when the outer side changes, through an
  index of the rows the runtime builds on first use and drops whenever the rows render for another
  reason. Selecting a row in a 1,000-row table evaluates two bindings instead of 1,000
  (js-framework-benchmark select row, script time 5.2 → 2.2 ms; sinter's own flush takes 0.7 ms for
  the first selection, when the index is built, and 0.2 ms after); the result is the same. The compiler marks the pattern in the IR (`s` on the binding: both sides as functions and
  the outer side's dependencies); loose equality and comparisons inside larger expressions are
  rendered as before. Core +0.26 KB gzip.

### Fixed

- Firefox (no `blocking` attribute) no longer paints a page before its early file has rendered:
  the page's first classic script (the language picker, or `sinter-paint-<hash>.js` on pages with
  an early file and no messages) hides `<html>` and turns CSS transitions off until the early file
  has rendered and the stylesheets have applied (2 s at most for the hiding). A persisted
  collapsed rail no longer shows open for a frame, and nothing transitions from the unrendered
  state. Chromium is unchanged.
- `vite build` with Vite 8 no longer warns "`inlineDynamicImports` option is deprecated" once per
  page: the early file's build passes Rolldown's `codeSplitting: false` (Vite 6 and 7, on Rollup,
  keep `inlineDynamicImports: true`). Both put an early module's dynamic imports into the early
  file itself; the output is the same. An early build that still comes out as several chunks now
  fails the build instead of emitting an early file whose imports cannot load.

## 0.8.0 (2026-11-08)

### Added

- Resource names chosen by an expression: `refresh()`, `upsert()`, `patch()`, `remove()` and
  `page()` take a name the compiler can list from the source: a string literal, `?:`, `||` or `??`
  between such expressions, or a `data-sn-let` name whose value is one
  (`data-sn-let="{ shown: searching ? 'results' : 'messages' }"`, then `page(shown, 'next')`). Every
  name it can take gets the checks a literal gets (`SN301`, `SN303`, `SN304`, `SN501`, `SN509`).
  A computed `$meta[…]` key whose names can be listed is checked the same way and depends only on
  those resources' status; other computed keys stay unchecked. `sinter check`: a page number in
  `page()` needs every name to accept one; `upsert`/`patch`/`remove` take an item of any of the
  names' types.

### Changed

- Breaking (behaviour): `page()` with `prev` does nothing while `$meta.<name>.hasPrev` is false,
  and with `next` while `hasNext` is false, in every mode. Before, keyset and append sent the
  request anyway (`next` after a short page loaded an empty page), and offset `next` without a
  known total went on. `first` and `last` always load. Before the first load has come back, `prev`
  and `next` do nothing. Migration: a handler no longer needs `$meta.x.hasNext && page('x', 'next')`
  (the guard still works); a live keyset list that relied on `next` past a short page to find new
  items uses `refresh('x')` or a server event's `refetch` instead.
- Breaking (behaviour): bubbling custom events are notifications. `emit()`, islands'
  `CustomEvent`s, `sn-error` and the `listbox` module's `dismiss` no longer stop at the nearest
  element with a handler: every element from the target up with a `data-sn-on-<name>` for the
  event runs, inner first, until a handler calls `$event.preventDefault()` (the other handlers on
  that element and its action still run). `emit()` and `dismiss` are cancelable. Debounced
  handlers and actions triggered by a custom event pass it on (an `<a>` action no longer prevents
  a custom event). `sn-error`: an inner handler that does not prevent it lets outer handlers and
  then `onError` see the error. Native events, plain `Event`s and custom events with
  `bubbles: false` keep nearest-wins. There is no `stop()`, and `stopPropagation()` does not end
  the walk. Migration: where an element and one of its ancestors both handle the same custom
  event and only the inner one should run, add `$event.preventDefault()` to the inner handler
  (`data-sn-on-saved="saving = false; $event.preventDefault()"`); an island whose events must be
  stoppable dispatches them with `cancelable: true`.
- `SN301` for a name argument that cannot be listed (a state variable, a helper's result) now
  says which forms are allowed: "takes a resource name: a string literal, `?:`, `||` or `??`
  between them, or a `data-sn-let` name that is one".
- A resource named only in a store call (`refresh('x')`, `page('x', 'next')`) counts as used: no
  `SN501`.

### Fixed

- `SN301` for an unknown resource in `$meta.<name>.<field>` was reported twice.
- The early file no longer repeats work: a binding the build wrote into the HTML as a constant is
  left out of the early chunk (a persisted model stays in, its stored value is read early), and a
  resource whose literal `src` names an origin (`https://…`, `//…`) is no early request, as it is
  no preload: the early file sends same-origin requests only. A page with nothing else to run
  early has no early file. RealWorld: article 21.1 → 17.9 kB gzip, profile 21.1 → 17.9 kB, under the
  20 kB budget again.
- The early file carries the request machinery (URL templates, `$url`, `$now`, the handoff) only when
  the page has early requests, and no longer the runtime's default environment: about 1 kB gzip less
  per page with an early file (RealWorld index 20.9 → 20.0 kB, login 19.4 → 18.4 kB).
  `start(page, messages, requests?, doc?)` in `@tiaforge-ui/sinter/early`; `config.env` holds only
  what `configure({ env })` overrides (`envOf(config)` is the environment in use).
- The `listbox` module kept its document listeners after `destroy()`: in tests, each earlier
  `render()` with a `data-sn-listbox` fired `dismiss` (and handled arrows, Enter and Tab) once more.

## 0.7.0 (2026-11-08)

### Added

- First paint: pages render correctly before their module has run, and the page bundle is not
  render-blocking.
  - Build-time constants are written into the HTML: bindings outside templates that read only
    literal `data-sn-state` fields (each on its own) and constants, e.g. `aria-current` from
    `here === '/mail/'`.
  - The early chunk: per page, one file with nothing to import, loaded `type="module"
    blocking="render"` before the page module, so the first paint waits for one request. It runs the app's optional `src/sinter.early.ts` first (e.g. to pick the
    language), then, once, the bindings outside `data-sn-for` templates that need no data: state
    fields that need no data, persisted values read from storage, `$locale` and helpers, and the
    branch of a `data-sn-if` over them. It holds only the helpers those bindings call, and copies of
    modules it shares with the page bundle: state the early module sets (an i18n locale) is set
    again by the page bundle. Resources, `$url`, `$now`, `$meta`, `$el` and the
    built-in formatters wait for the page module.
  - The runtime takes the rendered DOM over: its first write changes nothing, and it adopts an
    early `data-sn-if` branch instead of rendering it again.
  - The build prints each page's early file and its size (gzip) and warns above `earlyBudget` (default
    10000 bytes), naming the largest modules.
- `sinter({ firstPaint: false })` turns it off; `sinter({ early: 'path' })` names another early
  module. Compiler options `prerender` and `early`; `CompileResult.early` is the page's early
  module. New entry `@tiaforge-ui/sinter/early`.
- Data requests before the page module (with first paint): a resource with a literal same-origin
  `src` and no `when` gets `<link rel="preload" as="fetch" crossorigin>` in the head; one whose URL
  reads only state that needs no data, persisted values, `$now`, `$url` and helpers is requested by
  the early file (not paginated, `each`, `call` or embedded ones). The request layer takes each
  early response once, at the end of the middleware chain, when the request is the one the early
  file sent (GET, same URL, same-origin credentials, only `Accept: application/json`): response
  middleware runs on it, a request middleware that changes the request gets a request of its own;
  what no resource took is aborted after mount. Size: the early file grows by about 1.1 kB gzip
  (URL templates, `$url`, the handoff).
- Testing: `firstPaint(html, { helpers, storage, early })` shows the page as it is before the
  page module runs; `render(html, { firstPaint: { early, afterEarly } })` mounts over it.
- Recipe "First paint: page chrome that renders before the script".
- Built-in messages, from an inlang project (`project.inlang/settings.json`, `messages/{locale}.json`
  of plain strings with `{param}`s; `sinter({ messages })` points elsewhere or turns it off):
  `m.key({ param })` in markup, `m` from the new `@tiaforge-ui/sinter/messages` in app code, typed
  by a generated `src/sinter.messages.d.ts`. Unknown keys are `SN206`, wrong parameters `SN208`;
  `m[key]` in a module fails the build. Per page and language the build emits a file with only
  the keys the page calls (markup and its modules), and every such page gets the picker and waits
  for the dictionary, also when only a helper, action or island it bundles calls `m`; missing translations fall back to the base
  language and are reported. A small classic picker script chooses the language before the first
  paint (stored choice, `navigator.languages`, base) and loads that file render-blocking; the early
  file and page module wait for it and hold no message text. `$locale = 'de'` stores the choice,
  loads that file and re-renders without a reload. No plurals or variants yet. Apps without an
  inlang project pay nothing (same build output byte for byte). Testing: `render(html, { messages })`.
  Recipe "Messages".

### Changed

- Breaking, for apps with an inlang project: `m` in markup is sinter's built-in messages. A helpers
  module that exports a namespace `m` (`export * as m from './paraglide/messages.js'`) is a build
  error then; remove it, drop the i18n library's Vite plugin and `configure({ locale })` (sinter is
  the locale source), and import `m` from `@tiaforge-ui/sinter/messages` in app code.
  `sinter({ messages: false })` keeps the old behaviour.
- `date`, `time`, `datetime`, `relative`, `number` and `bytes` reuse one `Intl` formatter per
  locale and options instead of building one per call (the largest script cost of a list of dates).
- The page bundle's script is `async` in builds (a deferred module waits for every pending
  stylesheet; on a warm load this starts the page's requests a round trip earlier). The page module
  waits before it mounts: `await parsed()`, or on a page with an early
  file `await rendered()`, both from the core (the parse, then the early file's render;
  an early file that failed to load does not hold it past DOMContentLoaded). Also for apps without
  first paint or messages: their page entry gets `async` and the page module awaits `parsed()`.
  App code in the page bundle may now run while the body is parsed: it must not read the body at
  module top level, and an island's `connectedCallback` may run before its children are parsed.
  The early module calls `start()` from `@tiaforge-ui/sinter/early` (was `early(document, …)`).
- `sinter()` from `@tiaforge-ui/sinter/vite` returns two plugins (`sinter` and `sinter:early`);
  `plugins: [sinter()]` works as before.

## 0.6.0 (2026-11-08)

### Added

- `refresh()` takes several names: `refresh('messages', 'results', 'unread')` refetches each
  named resource, instead of one `refresh()` statement per resource. Every name is a string
  literal naming a resource of the page (`SN301` otherwise, with a did-you-mean); the call is one
  statement for `SN507`, however many names it lists, and each name is an edge for `SN509`.
  `sinter check` types it as `refresh(...names)`. Core +8 B gzip.
- `page()` with a computed target on a keyset resource: `page('results', $event.shiftKey ? 'prev'
  : 'next')`, so one handler serves both directions (Caley needed `list-next` and `list-prev`).
  It was `SN304`, because the compiler cannot tell a computed direction from a page number.
  Now it compiles, and `sinter check` types it: on keyset without `offset-param` it must be a
  subset of `'first' | 'prev' | 'next' | 'last'`, else `SN208`, whose message says to add
  `offset-param` for page numbers. A literal page number stays `SN304`; `append` takes only the
  literal `'next'` (its `SN304` message now says so). At run time a target the resource cannot
  go to (a page number on keyset without `offset-param`, a string that is not a direction)
  sends no request: `$meta.<name>.error` with the reason, the unhandled-error path and a dev
  warning. It used to be a dev warning only, or, for an unknown string on keyset, a request.
  The paginate module grows by about 120 B gzip.

### Changed

- Event dispatch: the nearest element wins only if it handled the event. For keys, an element
  whose plain `data-sn-on-keydown`/`-keyup` ran without calling `$event.preventDefault()` now
  passes the key on to its ancestors. Caley's calendar binds N and P on `<body>`
  (`data-sn-on-keydown-shift-n`), and its week grid's plain arrow-key handler, which prevents
  only the arrows it uses, used to hide them for every key. A matching key filter, an action and
  a debounced handler still handle the key; clicks, other DOM events and custom events
  (`emit()`, islands, `sn-error`) are unchanged: any handler or action that ran handles them, so a
  button inside a clickable row still keeps the row's handler from running. Behaviour change:
  plain key handlers at two levels now both see the keys the inner one does not prevent; a plain
  handler that should keep keys from its ancestors prevents them. No sinter-level stop; non-bubbling
  events keep their nearest-ancestor reach, now written down. Core +22 B gzip.

### Fixed

- Spec, Pagination: `cursor` is evaluated on the boundary item *of the current page* (its last
  item for `next`, its first for `prev`; `first` and `last` send no cursor). "last item for
  `next`, first for `prev`" read as if the direction `first` mapped to `prev`. The modes table,
  the offset-param jump and the `direction-values` row say the same.

- `<sn-event>` `when`, `then`, `item` and `set` see the `data-sn-let` names declared around the
  `<sn-sync>`, resolved like state there: before payload fields of the same name. They were taken
  for payload fields, so a typed payload reported them as missing (`not on type EmailUpdatedEvent`),
  and `sinter check` declared a let and a payload field of one name in the same block (TS2451
  redeclare errors). The shadow now declares the payload outside the state and let blocks. With
  a typed payload, a let named like a payload field is a check error, as for state; a let that
  reads `$el` is `SN201` there.

## 0.5.0 (2026-11-08)

### Added

- `run('id')`, a store function that starts the action of the element with that literal id
  from any handler: `data-sn-on-*` (key filters included), `data-sn-then`/`data-sn-catch`,
  `<sn-event then>` and `<sn-resource then>`. The element's whole lifecycle applies, as if its
  trigger fired: debounce, confirm, its concurrency policy, the optimistic layer, `aria-busy`,
  `then`/`catch` and the unhandled-error path. A form is submitted with `requestSubmit()`
  (validation runs, `data-sn-on-submit` too); for any other element no DOM event is dispatched
  and `$event` is `null`. The target's own scope applies, `run()` takes no arguments and returns
  nothing. A disabled or inert target does nothing; a hidden one, or one in a closed dialog,
  runs; one that is not on the page (an `if` branch not rendered) does nothing, with a dev
  warning. Caley's case, marking a mail read once its body has loaded:
  `then="$result && !open.is_read && run('mark-read')"` with the action on a hidden
  `<span id="mark-read" data-sn-call="…" data-sn-optimistic="…">`. Islands still have no
  `app.run()`: they emit an event and the page runs the action. Core +86 B gzip.
- `SN311 unknown-run-target`: `run()` takes a string literal naming one element on the page that
  carries an action, outside `data-sn-for` rows, with a did-you-mean suggestion (and the LSP
  quick fix, which now also fixes `SN309` dialog ids).
- `sinter check` types `$event` in the URL, body, call arguments and confirm of a non-form
  `run()` target as `RunEvent<…>` (the event or `void`), so `$event.shiftKey` there is `SN208`
  and `$event && $event.shiftKey` is not.
- `SN509 run-cycle`, an opt-in warning for `then`/`catch` handlers that start each other again
  through `run()` (and `refresh()`), listing each step's element, handler and line. Off by
  default; `sinter check --check-cycles` for one run, `sinter({ checkCycles: true })` for the
  build, `sinter check` and `sinter lsp`.
- New recipe: run an action from a handler (mark a mail read after its body loaded; a shortcut
  on a button that is disabled when nothing is open).

- Key filters on keyboard handlers: `data-sn-on-keydown-<modifiers->key` and
  `data-sn-on-keyup-…` run only for that key, so each shortcut is its own attribute
  (`data-sn-on-keydown-j`, `-shift-n`, `-ctrl-space`, `-mod-enter`, `-escape`, `-question`).
  Modifiers are `ctrl`, `alt`, `shift`, `meta` and `mod` (Cmd on Apple platforms, Ctrl
  elsewhere), the key comes last: `a`–`z`, `0`–`9`, named keys (`enter`, `space`, `arrowdown`,
  `home`, `f1`…) and characters by name (`slash`, `question`, `minus`…). They match
  `KeyboardEvent.key`, so letters follow the layout; a letter filter falls back to the physical
  key when the layout gives no Latin letter. Modifiers are exact (`j` does not run for Ctrl+J);
  Shift is the filter's for letters and named keys (`n` vs `shift-n`) and not checked for
  characters that already say it (`question`, digits). Filters on an ancestor skip keys typed
  into fields and Enter/Space on buttons and links; a filter on the field itself runs. A match
  calls `preventDefault()`; repeats run; IME composition never matches. On one element, the
  matching filters and a plain `data-sn-on-keydown` run in attribute order, and an element
  whose filters do not match passes the key on to its ancestors. `data-sn-debounce-keydown-j`
  delays one filter. Unknown key or modifier names, uppercase (HTML would lowercase
  `-N` to `-n`) and malformed filters are `SN101` with a suggestion; `sinter check` types
  `$event` as `KeyboardEvent`. The matching is a feature module, `@tiaforge-ui/sinter/keys`
  (578 B gzip), loaded only by pages with a key filter; the core grows by about 17 B gzip.
  New recipe: keyboard shortcuts.

- `SN507 complex-expression`, a warning for expressions too complex for markup, naming the
  limit exceeded. It measures structure, not characters: statements in a handler
  (`statements`, 4), comma sequences (`sequences`, 0), steps one `&&`/`||`/`?:` used as a
  statement runs (`guarded`, 1: `a && close()` passes, `a && (b = null, close())` does not),
  `?:` nesting (`ternaries`, 2), operations in an arrow function (`arrow`, 8; block bodies
  always warn) and operations in one expression (`operations`, 15). Names, member paths,
  literals and object/array literal structure are free; object attributes are measured per
  property value. Configured with `sinter({ complexity: { …limits, level: 'warn' | 'error' |
  'off' } })`, which `sinter check`, `checkPage()` and `sinter lsp` read too; unknown limits or
  levels are refused. The recipes, RealWorld and the e2e pages pass: the SSE recipe's
  `<sn-event then>` closes the dialog and the dialog's `data-sn-on-close` clears the
  selection; RealWorld's tag input is `data-sn-on-keydown-enter="d.tagList = withTag(d.tagList, tag); tag = ''"`
  with a `withTag` helper (its editor page now loads the keys module, +550 B gzip). The docs' once-only `then` example is
  `draft = $result ?? draft; $result && showModal('compose')`.

- `sinter lsp`: an "Extract to helper" refactoring (`refactor.extract`). On an expression, or a
  selection inside one, it moves the expression into a new exported function of the helpers module
  (created when missing, `.ts` in a TypeScript project) and calls it in its place. Free names (loop
  variables, state, resources, `$event`, `$el`, `$result`, `$meta.<resource>`, …) become parameters,
  typed from TypeScript 7 when the project has it (`unknown` otherwise, JSDoc in a `.js` module);
  helpers, store functions and globals do not. In a handler the assignment stays and its value is
  extracted (`query = nextQuery(c)`); several assignments become one helper each, or one helper
  returning an object merged with `Object.assign` when they write properties of one state object. On
  `data-sn-call` and `<sn-resource call>`, "Extract to action" moves the call into a new action. Each
  extraction is compiled before it is offered. Code actions resolve their edit lazily when the
  client supports it. Runtime size is unchanged. `SN507` offers the same extraction as its quick fix.

### Docs

- The expression table no longer says handlers may call action functions: they call store
  functions, and start actions with `run('id')`. `SN203` for an action called in a handler now
  says so, with the hidden-element pattern as its hint.
- "What belongs in markup" in the spec and `llms.txt`: markup holds filters, conditions,
  single assignments and short calls; logic goes into helpers (pure) or actions (side
  effects), and handlers apply results as `state = fn(…)`, one step per condition. New recipe:
  row selection with Ctrl/Shift, `sel = rowClick($event, sel, f.id, ids)` with the helper and
  its unit tests.

### Changed

- `run` is a store function: a resource can no longer be named `run` (`SN209`), and a state or
  loop variable named `run` hides it in its scope. The internal `App.run()` (runs a handler
  expression) is now `App.exec()`.
- `data-sn-on-keydown-…` and `data-sn-on-keyup-…` are key filters now; a custom event whose
  name starts with `keydown-` or `keyup-` can no longer be handled with `data-sn-on-*`.

### Fixed

- `data-sn-prop` on a custom element that is already defined but not upgraded yet: a row of
  `data-sn-for` or a `data-sn-if` branch is cloned from the template and gets its props before
  it is connected, and only connecting upgrades it. The values were own properties that hid
  the class's setters (Caley's `<mail-frame>` in a list row showed an empty frame on a direct
  page load). The props of an element that is not an instance of its definition now go the
  same way as those of an element defined later: they are set again through the class when
  `customElements.whenDefined()` resolves, by which time the row is in the document. An upgraded element still pays one `customElements.get()` and an `instanceof`
  per write. 9 B gzip on the core.
- `render()` from `@tiaforge-ui/sinter/testing` took the `<html>` attributes from the first
  `<html` in the page's text, even inside a comment: Caley's calendar page explains its state
  in a comment that mentions `<html>` before the real tag, and the state was lost under jsdom
  (the comment's tail also became text in the body). `render()` now parses the page and takes
  the attributes and the content from its `<html>` element. The runtime is unchanged.
- `SN501` warned that a resource used only through its own `then` was never read, as in the
  spec's pattern `<sn-resource name="pending" call="mail.pendingCompose()" then="… $result && showModal('mail-compose')">`
  (Caley's share-to-mail). A resource with `then` now counts as used, whether or not the
  handler reads `$result`: a `then` that only notes the arrival (`then="loaded = true"`) is a
  reason to load it too.
- `data-sn-model` on a `<select>` inside a closed `<dialog>` was evaluated on every flush:
  bindings there wait for the dialog to open, but the pass that sets each select's value again
  after its options render did not. Caley's import dialog, `data-sn-model="imp.target"` while
  `imp` is null, warned "binding `model` on <select> threw" on each page load. That pass now
  defers selects in a closed dialog too, and runs once more when a dialog opens, so a select
  whose options render in the dialog gets its value. 13 B gzip on the core.

## 0.4.0 (2026-11-08)

### Added

- `then` on `<sn-resource>`: a handler expression run after each successful load, with `$result`
  being what the load stored (what `items` selects, the page just loaded, or one `each`
  source's items). It runs for the first load, `refresh()`, refetch events, `src`/`call`
  changes, every `page()` and embedded data; not for data `cache` shows before the
  revalidation, failed or superseded loads, optimistic layers or `upsert`/`patch`/`remove`.
  It runs after the store and `$meta` have the response, in the scope around the resource
  (state assignable), with store functions; as in `<sn-event then>`, `close()` must name its
  dialog and `reset()`/`emit()` are `SN203`. `sinter check` gives `$result` the resource's type
  (`type`, OpenAPI or the action's result). Handlers that should run once guard themselves:
  `then="$result && (compose = $result, showModal('mail-compose'))"`. The core grows by
  45 B gzip, the each module by 9 B.

### Changed

- Optimistic changes stay when the request succeeds. A 2xx response (or a call that resolves,
  or `app.optimistic()`'s `run`) commits the layer into the base before `then` runs, so a
  `then` write, and any later server event or refetch, still wins. Before, success dropped the
  layer, and a change `then` did not write again flipped back until the next refetch. Commits
  keep the order of the changes: a layer that succeeds while an older one is pending waits on
  top of it and joins the base when every older layer has settled (it leaves
  `$meta.<name>.pending` at once; a server write to the same item wins over it). A load in
  flight replays a commit on its response; a committed `remove` keeps `total` down. A
  superseded `GET` action now rolls its layer back instead of leaving it. The core grows by
  146 B gzip.

- An array as the whole value of a query parameter in a URL template is a repeated key, each
  item URL-encoded: `/api/search?q={q}&cal={cals}` with `['a', 'b']` sends `cal=a&cal=b`, as
  `data-sn-encoding="form"` does for bodies; `null`/`undefined` items are left out and an empty
  array leaves the parameter out. Before, the array was comma-joined (`cal=a%2Cb`). An array
  in the path is now refused (the request is not made, like a `..` segment), and `sinter
  check` reports it (`PathValue`). An array that is only part of a query value is comma-joined
  as before. 77 B gzip on the core.

### Fixed

- `data-sn-prop` on a custom element that is defined after sinter has set its properties (an
  island loaded with `import()`): the values were own properties that hid the class's setters,
  so the island never received them (Caley worked around it with an `upgradeProps()` helper).
  sinter now keeps the latest value of each property set before the definition and, when
  `customElements.whenDefined()` resolves, deletes the own property and sets it again through
  the class. Defined elements pay one `customElements.get()` per write. 88 B gzip on the core.
- `data-sn-attr` sets the live property for form state: `checked`, `selected`,
  `indeterminate` and `value` are set as properties as well as attributes, so a re-render or
  an optimistic rollback moves a control the user already changed (a clicked checkbox whose
  change rolls back unchecks). `null`/`false` set the property to `false` (`value`: `''`).
  Binding the `checked` (checkbox, radio) or `value` (other controls) that a `data-sn-model` on
  the same element writes is now `SN102`. 50 B gzip on the core.
- `render()` from `@tiaforge-ui/sinter/testing` keeps the `<html>` element's attributes. It
  kept only what was inside `<html>`, so `data-sn-state`, `data-sn-persist` or bindings on
  `<html>` were lost in tests although they work in the browser. Each render also clears the
  previous page's `<html>` attributes.
- `sinter check` read the types module's exported names from comments and strings too: a
  comment such as `// export type { Draft } from './compose'` in `src/sinter.types.ts` made
  `Draft` an export that the generated check file then imported. The scanner now skips
  comments and string and template literals; `@typedef`s are still read from comments.

## 0.3.3 (2026-11-08)

### Added

- `then` on `<sn-event>`: a handler expression run after the event's change is applied to the
  store, in the event's scope (payload fields as bare names, the state around the `<sn-sync>`,
  assignable). Store functions work in it; with no element, `close()` must name its dialog and
  `reset()`/`emit()` are `SN203`. With `then`, `resource` and `op` may be left out, so an event
  can only run a handler. `sinter check` types it with the payload's `type`, and an untyped
  event with `then` is `SN506`. For pages that close a detail dialog when the item it shows is
  removed: `then="sel?.uid === uid && (sel = null, close('contact-detail'))"`. The sse module
  grows by 51 B gzip, the core by 8 B.

## 0.3.2 (2026-11-08)

### Fixed

- `<sn-sync>` elements whose `src` resolves to the same URL share one connection, as the spec
  says: one transport, one session probe and backoff per reconnect, and every element's
  `<sn-event>` mappings apply (each in its own `<sn-sync>`'s scope). Before, each element opened
  its own, so a `<sn-sync>` in an `<sn-include>`d partial and one in the page held two
  EventSources. The sse module grows by 35 B gzip.

## 0.3.1 (2026-11-08)

### Changed

- Size budgets: the minimal page may be 15 KB gzip (was 11.5 KB; 0.3.0 shipped at 12.1 KB) and the
  RealWorld article page 20 KB (was 16.5 KB, with 24 B to spare). CI now runs `npm run size -- --check`,
  so an overrun fails the build.

### Fixed

- `app.state(el).update()` now reaches bindings inside `data-sn-for` rows: an island that changes a
  row's field or a nested list in place re-renders those rows. Before, only bindings outside the
  rows updated.
- Assigning `$locale` re-sorts resources with `order` by the new locale's collation. The store's
  cached view was never dropped for a locale change.
- A resource whose `when` turned false no longer overwrites its page-load cache entry with an
  empty list on pagehide.
- The 64 KiB `keepalive` limit is measured in UTF-8 bytes. A mutation body of 22,000 to 60,000
  non-ASCII characters was sent with `keepalive` and refused by the browser.
- A resource cannot take a store function's name (`remove`, `patch`, …): new `SN209` case. Such a
  page compiled, but `sinter check` failed with an internal error on it.
- `validateIR` accepts pages with `data-sn-call` and `<sn-resource call>`.
- A URL with a second `?` in its query keeps it when pagination parameters are added.
- A form with a scalar control and a nested one under the same name (`a`, `a.b`) serializes
  (the later control wins) instead of throwing.
- An app destroyed before its `<sn-sync>` streams connected opens none; a cleanup added after
  `destroy()` runs at once.
- A debounced `data-sn-on-*` handler does not run when its element left the page meanwhile.
- Keyset pagination: an empty `next` page reports `from` and `to` as 0 instead of 1 and 0. Offset
  pagination: `page(name, 'prev')` on page 1 and `page(name, 'next')` on the last known page send
  no request.
- `bytes('')` returns an empty string, like `number('')`.
- `data-sn-encoding="form"` serializes a form through `FormData`, as the browser would, instead of
  its own control walk (same fields, about 100 B less core).
- The compiler closes three lint gaps: a literal origin followed by a value needs its `/`
  (`https://api.example.com{x}` let the value extend the host; the runtime's origin check still
  refused the request), `Object.assign()` and `Object.defineProperty()` on a resource item are
  `SN205` (on state, a write, or `SN203` in a value expression), and `constructor`, `__proto__`
  and `prototype` named literally as `Object.*` arguments are `SN207`.

## 0.3.0 (2026-11-07)

### New

- `sinter check` types `data-sn-attr` values: a global `SinterAttributes` interface (empty by
  default) lists attribute value types, and a library extends it. With tinystyle,
  `import type {} from '@tiaforge-ui/tinystyle/sinter'` in the types module makes
  `{'data-tone': bad ? 'danger' : 'sucess'}` a type error. Keys it does not list are unchecked,
  as before. The types module is now always part of the check, so its `declare global`
  augmentations apply.
- `showModal('id')` opens `<dialog id="id">` as a modal from a handler, for
  example after a request (`data-sn-then="…; showModal('detail')"`) or from a
  custom event. `close('id')` closes a dialog by id; `close()` still closes
  the nearest one. The id must be a string literal naming a `<dialog>` on the
  page or its partials: new diagnostic `SN309 unknown-dialog`.
- `data-sn-let="{ hits: suggestions(q), n: hits.length }"`: derived names for an element
  and its subtree, compiled into the expressions that read them (no runtime cost). Read-only;
  new diagnostic `SN209 name-conflict` when one shares a name with state or a loop variable.
- `data-sn-confirm="question"` asks before an action runs (nothing when the value is falsy);
  `configure({ confirm })` replaces `window.confirm`.
- `data-sn-encoding="form"` sends a form or `data-sn-body` as
  `application/x-www-form-urlencoded` (arrays as repeated keys); `ctx.request` accepts a
  `URLSearchParams` body.
- `data-sn-listbox="list-id"` on a text input: the combobox keys for a suggestion list (arrows
  mark an option, Enter/Tab pick it, Escape fires `dismiss`), in the new `listbox` module.
- `$error.detail`: the server's message or a thrown error's, `null` when there is none.
- `data-sn-debounce-<event>="ms"` delays only that event's handler, e.g. a debounced
  `data-sn-on-input` next to an immediate `data-sn-on-blur`; it overrides `data-sn-debounce`
  for that handler, `0` makes it immediate.

## 0.2.0 (2026-11-06)

### Faster

Compared with 0.1.0 in Chrome 156, production builds:

- Writes to an ordered resource patch its sorted list instead of re-sorting
  it. Into 5,000 items, one upsert, patch or remove takes 0.005 ms instead of
  10 ms, a burst of 50 upserts 0.19 ms instead of 7.2 ms. A server event
  landing in a rendered sorted list flushes in 0.14 ms instead of 1.35 ms at
  1,000 rows, 0.7 ms instead of 11.2 ms at 5,000. Ties in `order` keep arrival
  order, as before; `replace` costs the same.
- A flush is about 2.5× cheaper per root binding: only bindings inside a
  `<dialog>` check for a closed one, and each binding keeps its parsed
  dependencies. One state change on a page with 4,000 root bindings: 0.18 ms
  instead of 0.44 ms.
- Identical expressions share one function in the compiled page module (the
  RealWorld article page has 60 instead of 112).

Row rendering (js-framework-benchmark) and mount time are unchanged. Pages are
0.6–0.8 KB gzip larger than with 0.1, mostly for the features below.

### New

- Local actions: `data-sn-call="ns.fn(args)"` calls a function from the actions
  module (`src/sinter.actions.js` or `.ts`) with the lifecycle of an action
  (busy, concurrency, optimistic layers, `then`/`catch`), and
  `<sn-resource call="…">` loads a resource from one, latest wins. Functions get
  a trailing context `{signal, request, el}`. New code `SN310 unknown-action`.
- `each="a in accounts"` on `<sn-resource>`: one request per list item, merged
  into one collection. A changed list loads only new sources and drops removed
  ones; a `refetch` event reloads only the source its payload names.
- `offset-param` on a keyset `<sn-resource>`: when the server also accepts an
  offset, `page(name, n)` jumps with it and `prev`/`next` continue by cursor;
  `$meta.<name>.page` is available. Without it, `SN304` now suggests it.
- `direction-values` on a keyset or append `<sn-resource>` maps sinter's
  directions to the values a server expects, e.g.
  `{first: 'forward', prev: 'backward', next: 'forward'}`. Directions not
  listed are sent by name, as before.
- `data-sn-debounce` on an element without a method delays its
  `data-sn-on-*` handlers: `<input data-sn-model="q" data-sn-on-input="query = q"
  data-sn-debounce="250">` updates `q` at once and `query` once typing pauses.
- `<sn-event>` expressions can read the state declared around their
  `<sn-sync>` (`when="mailbox === sel.mailbox"`), and `<sn-sync src>` is
  evaluated in that state's scope.
- A TypeScript helpers module (`src/sinter.helpers.ts`): export names are read
  with TypeScript syntax, type-only exports are not helpers, and
  `sinter check` accepts `.ts` import paths. Before, any type annotation in it
  failed every page's build with an acorn parse error.
- Helper and namespace modules may re-export with `export * from './x.js'`
  (relative paths only). Paraglide 2's message index is built this way, so
  `export * as m from './paraglide/messages.js'` used to find no messages
  (`SN206` on every `m.…()` call).

### Changed

- `<sn-event>`: a name declared by the surrounding state now shadows a payload
  field of the same name (before, it silently meant the payload field); a
  `sinter check` error when the payload is typed.
- `$error.status` (and `SinterError.status`) is `null` for a failed action
  call; its type is now `number | null`.
- Pagination cursor fields that are `null` or `undefined` are left out of the
  request instead of being sent empty, like URL template query parameters.
- `$meta.<name>.total` updates when the total or an optimistic removal changes
  it; before, it updated only when something on the page read the list.
- Resource lists are frozen in dev builds only, like their items (`SN205`
  refuses writes at build time). In production, code outside expressions that
  mutates `app.resource(name).all()` corrupts the store; copy it first.

## 0.1.0 (2026-11-05)

First implementation of the v0.1 spec: compiler, runtime, `sse`,
`optimistic`, `paginate`, `persist`, Vite plugin and testing module.

- `configure({ transport })` picks the `<sn-sync>` transport per stream URL;
  `@tiaforge-ui/sinter/ws` adds a WebSocket transport, and `llms.txt` has a
  SignalR recipe.
- `Transport.connect`'s `onEvent` now receives the parsed payload
  (`unknown`) instead of the raw string.
- `sinter check` type-checks expressions with the project's TypeScript:
  `type` on `<sn-resource>` and `<sn-event>`, OpenAPI specs
  (`sinter({ openapi })`), `sinter({ typecheck: true })` for `vite build`,
  `checkPage()` in `@tiaforge-ui/sinter/check`. New codes: `SN208`, `SN307`,
  `SN308`, `SN504`, `SN505`, `SN506`.
- `sinter lsp`: a language server with diagnostics as you type, type errors,
  hover, completion, go to definition and a did-you-mean quick fix; a VS Code
  extension in `editors/vscode`; setup for other editors in `docs/editors.md`.
- `Diagnostic` has an optional `span` (what an editor underlines).
- Diagnostics link to `docs/diagnostics.md`, generated from the compiler.
- The core's size budget is 11 KB min+gzip (was 5 KB, never met).
- `cache` on `<sn-resource>`: the page-load cache (sessionStorage, revalidated
  on every load, cleared on 401 and by `clearPersisted()`); the
  `@tiaforge-ui/sinter/cache` feature module.
- Dev builds warn when a stream is served over HTTP/1.1.
- Testing: `render({ session, storage })` and `memoryStorage()`.
