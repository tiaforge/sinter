# Proposal: a smaller, plainer vocabulary

Status: implemented 2026-11-20. Step 9 was held, and decided against (below). Each step landed as its own
commit, with a diagnostic that names the replacement, so a page written for 0.20 fails the build with the
fix in the message rather than changing behaviour silently. Attribute names, function names and
diagnostic codes are public API; before 1.0 renames are allowed and listed in the changelog.

Decided with the user along the way: `reset()` goes too (4a); `data-sn-listbox` becomes the general
mechanism, named `data-sn-options` (not `data-sn-roving`: a roving tabindex moves the focus itself); the
props declaration is `data-sn-props`, so the passing attribute is renamed `data-sn-with` (12).

The rule this applies: one way to do each thing, one word per concept, and nothing in the vocabulary
that another part of it already does.

## Removals and renames

### 1. `data-sn-get` goes

A GET that puts its result on the page is a resource. `<sn-resource src>` already reloads when the
values its URL reads change, aborts the running request (latest wins), waits for the typing pause, has
`$meta` status, `cache`, `refresh`, a typed `$result`, can be preloaded and embedded. A GET action had
none of that, and it was the reason for special cases elsewhere: GET's own "latest wins" concurrency,
"GET actions mark no fields", "GET actions have no write-through", no body for GET.

| Before | After |
| --- | --- |
| `<input name="q" data-sn-get="/api/search?q={q}" data-sn-trigger="input" data-sn-then="hits = $result">` | `<input data-sn-model="q">` and `<sn-resource name="hits" src="/api/search?q={q}" when="q">` |
| a button that fetches once into state | a resource with `when` set by the button, or `data-sn-call` |

`data-sn-get` is `SN101` with that hint.

### 2. `patch()` is `merge()`

The store function shared its name with the HTTP method, so `data-sn-patch="…"` and
`data-sn-optimistic="patch(…)"` on one element read as the same thing twice. `merge(item, {…})` says
what it does: fields you leave out stay. `<sn-event op="patch">` is `op="merge"`. `data-sn-patch`, the
HTTP method, stays.

`patch(` in an expression is `SN201` with "renamed to `merge`"; `op="patch"` is `SN403`-style
(`op`'s own diagnostic) with the same hint.

### 3. `refetch` is `refresh`

One concept had two words: `refresh()`, `refresh="30s"`, and `<sn-event op="refetch">`,
`fallback="refetch"`. All are `refresh` now. The JavaScript side follows both renames: `Resource.merge()`, `Resource.refresh()`,
and the change messages' `op: 'merge'` and `op: 'refresh'`. A helper named like a store function
(`merge`) is `SN201`: the store function always won, so the helper was unreachable.

### 4. `$error`: kept, made consistent

Looked at closer, `message` and `detail` are not two names for one text: `message` is the server's
words when it gave any, else the HTTP status (always something to show), and `detail` is the server's
words or `null`, so a page can put its own, translated text where the server said nothing
(`$error.detail ?? m.save_failed()`). What was wrong is that `$meta.<name>.error` was documented, and
typed in `Meta`, without `detail`, though it is the same object. Both now say `{status, body,
message, detail}`.

### 5. `data-sn-listbox` becomes `data-sn-options`

The one attribute that implemented a single widget becomes the general mechanism under it: keys move
a mark through a list of options, and Enter clicks the marked one. A combobox is one use; a menu, a
selectable list and a command palette are others.

```html
<!-- a combobox: focus stays in the input -->
<input data-sn-model="q" data-sn-options="hits" data-sn-on-dismiss="open = false">
<ul id="hits" role="listbox" data-sn-show="open && hits.length">…<li role="option">…</li></ul>

<!-- a menu, a list: the element itself takes focus, its options are inside it -->
<ul role="menu" data-sn-options>
  <template data-sn-for="c in commands"><li role="menuitem" data-sn-on-click="run(c.id)">…</li></template>
</ul>
```

- The value is the id of the list. Empty: the options inside the element, else the nearest list
  around it (inputs rendered in a loop).
- Options are `[role=option]`, `[role=menuitem]`, `[role=menuitemcheckbox]` and
  `[role=menuitemradio]` that are shown and not `aria-disabled`. (Tree items left out: their expand
  and collapse keys are a widget of their own.)
- Focus stays on the element with the attribute; the mark is `aria-activedescendant` on the element
  (an option without an `id` gets one), `data-sn-marked` on the option for styling, and
  `aria-selected` on an `option`: the pattern assistive technology reads for both comboboxes and
  composite widgets.
- ArrowDown and ArrowUp move the mark (ArrowRight and ArrowLeft with `aria-orientation="horizontal"`),
  Home and End go to the first and last. Enter clicks the marked option; on an element that is not a
  text field, Space does too. Tab clicks the marked one, or the only one, on a text input. Escape
  fires a bubbling, cancelable `dismiss`.
- On a text input the compiler adds `role="combobox"`, `aria-controls` and
  `aria-autocomplete="list"`, as before; typing unmarks. On another element it adds `tabindex="0"`
  when the element has none.
- A mouse press on an option keeps the focus where it is.
- `data-sn-listbox` is `SN101`, "renamed to `data-sn-options`".
- The name: first `data-sn-roving`, but a roving tabindex is the other ARIA technique, where the focus
  itself moves from item to item. Here the focus stays and the element points at its marked option, so the
  attribute is named for what it points at: `data-sn-options="hits"`, the element's options are `#hits`.

### 6. Pagination is one attribute

Nine attributes (`paginate`, `page-size`, `size-param`, `cursor`, `direction-param`,
`direction-values`, `page-param`, `offset-param`, `page-model`) mixed two kinds of thing: how this list
pages, and how the server spells its parameters. The second is the same for every list of an API.

```html
<sn-resource name="messages" src="/api/messages" items="messages" total="total" key="id"
  paginate="{ keyset: { before: id }, size: 20 }"></sn-resource>
<sn-resource name="feed" src="/api/feed" key="id" paginate="{ append: { before: id }, size: 20 }"></sn-resource>
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" items="articles" total="count"
  paginate="{ numbered: true, size: 10, model: $url.page }"></sn-resource>
```

| Key | Meaning | Was |
| --- | --- | --- |
| `keyset`, `append`: an object literal | the mode, and the cursor read on the boundary item | `paginate`, `cursor` |
| `numbered: true`, `numbered: 'offset'` | numbered mode: sends the page number, or with `'offset'` the items to skip | `paginate="offset"`, `offset-param` on it |
| `size` | items per page | `page-size` |
| `model` | numbered: the URL parameter that holds the page, `$url.page` | `page-model` |
| `jump: true` | keyset: page numbers, by sending an offset | `offset-param` on a keyset list |
| `params` | the server's names: `{ size: 'limit', page: 'page', offset: 'offset', direction: 'dir' }` | `size-param`, `page-param`, `offset-param`, `direction-param` |
| `directions` | the server's direction values, `{ first: 'forward', prev: 'backward' }` | `direction-values` |

- `params` and `directions` are given once per API: `sinter({ apis: { main: { …, paginate: { params,
  directions } } } })`, and on a resource only where it differs. Without `apis`, they go in the
  attribute. `params` only names parameters: whether the items to skip are sent is
  `numbered: 'offset'` or `jump: true`, on the list (step 17).
- `offset-param` no longer has two jobs: on a keyset list, jumping to a page is `jump: true`.
- The old attributes are `SN401`; `paginate="keyset"` with them names the object they become.
- RealWorld moved `params: { size: 'limit', offset: 'offset' }` from its three lists into its API's config;
  its build is byte for byte the same (asset names apart).

### 4a. `reset()` goes

It reset the nearest form's fields and then copied them into their models: two sources for one value.
A form's fields follow their `data-sn-model` state, so a form clears by clearing its state
(`data-sn-then="body = ''"`, as RealWorld's comment form already did), and `<button type="reset">`
restores the fields with their models following, which it did not before. `reset()` is `SN201` with
that hint.

## Merges

### 7. One declaration for a component's props: `data-sn-props`

`data-sn-component`, `data-sn-head` and `data-sn-layout` each declared "this file's props", and the
kind came from the attribute's name. The compiler already knows the kind: a file in `src/layouts/` is
a layout (on its `<html>`), and a component whose markup is head elements is a head component (today's
`SN312` already tells the two apart to suggest the other attribute). One attribute:

```html
<template data-sn-props="{ contact: Contact; compact?: boolean }" data-sn-emits="{ pick: Contact }">
<template data-sn-props="{ title?: string }"><title data-sn-text="title"></title>…</template>
<html data-sn-props="{ title: string }">  <!-- src/layouts/app.html -->
```

The three old names are `SN101` with "renamed to `data-sn-props`".

The props-passing attribute, `data-sn-prop`, was one letter from it; it is renamed in its own step (12) so
that declaring and passing are different words. A head component may be made of other head components: a
component's tag counts by that component's own kind (a cycle is a body component).

### 8. `data-sn-debounce` has one meaning

It meant "delay the request" next to a method attribute, and "delay every `data-sn-on-*` handler"
without one, beside `data-sn-debounce-<event>` for one handler. Now `data-sn-debounce` delays an
action's trigger only, and a handler is delayed by `data-sn-debounce-<event>` (`-input`, `-keydown-j`).
`data-sn-debounce` without a method is `SN102` naming the `-<event>` attributes to write instead.

### 9. `<sn-event>` writes with the store functions (not done)

**Not done.** The `op` form is more than a way to write: the compiler and runtime read `resource` from it
to know which resources a stream feeds, for `$meta.<name>.live`, the refresh of every fed resource after a
reconnect, the hand-over of streamed pages, and the typing of `item` and `set` against the resource. `op`
also carries rules a store call does not: an `upsert` of a key not on a paginated list's page refreshes
the page instead, a `refresh` passes the payload so an `each` resource reloads only its source, a payload
without the key fields is skipped with a warning and `then` does not run. To keep all of that, the
compiler would have to read the calls back out of `then` into the same form, and a `?:` fallback would
have no static form at all. The gain (four attributes fewer) does not pay for an implicit form that
every one of those places has to reverse-engineer. Smaller options, if any: `item` and `set` as one
attribute; `fallback` as a flag.

The design as first written:

`<sn-event>` had its own small language for changes (`resource`, `op`, `item`, `set`, `fallback`)
beside `then`, which already calls store functions. In `then`, the store functions now take the
resource by name and the item from the payload:

```html
<sn-event name="person_updated" then="upsert('people', person)"></sn-event>
<sn-event name="person_removed" then="remove('people', { id })"></sn-event>
<sn-event name="message_changed" when="mailbox === sel.mailbox"
          then="merge('messages', { uid, flags, is_read: flags.includes('\\Seen') })"></sn-event>
<sn-event name="stats_changed" then="refresh('stats')"></sn-event>
```

- `merge(name, fields)` and `remove(name, fields)` find the item by the resource's `key` fields in
  `fields`; `upsert(name, item)` as everywhere. These two-argument forms are only for `<sn-event then>`,
  where the item is a payload; elsewhere `SN317` stands (an item comes from the resource).
- They write to the base like the old `op`s (a server event is what the server confirmed), so
  optimistic layers stay on top.
- `fallback` is `person ? upsert('people', person) : refresh('people')`.
- `resource`, `op`, `item`, `set`, `fallback` are `SN101` with the `then` they become.

### 10. `data-sn-apply` is `data-sn-write-through`

The docs call the concept write-through everywhere; the attribute should say so.
`data-sn-write-through="off"`.

### 11. `data-sn-pages` is `data-sn-for` on `<html>`

It is a loop, and its name clashed with pagination's `page()` and `$meta.pages`:
`<html data-sn-for="p in posts" data-sn-path="/blog/:slug">`.

### 12. `data-sn-prop` is `data-sn-with`

With the declaration named `data-sn-props` (the familiar pair with `data-sn-emits`), passing values
was one letter away. The passing side gives way: `<contact-card data-sn-with="{ contact: c }">`,
`<slot name="cell" data-sn-with="{ row }">`, `<x-chart data-sn-with="{ data }">`. One meaning
throughout: the values given to what the tag stands for.

### 13. `openDialog()` and `closeDialog()`

`showModal()` and `close()` were two DOM methods side by side, the only store functions that were not
one plain word. `open()` would read best but loses to a state named `open` (the open message, in our
own recipes thirty times), and `show()` is the DOM's non-modal open. So the pair names its object:
`openDialog('edit')`, `closeDialog()`.

### 14. `data-sn-debounce` on a model, and `data-sn-retry` on a call

Added after the review: a field with `data-sn-model` takes `data-sn-model-debounce` (first `data-sn-debounce`, step 17), which delays
the model's write in place of the typing pause (a resource over it loads right after, a model on `$url`
writes one history entry); and `data-sn-retry` on `data-sn-call` applies to each request the function
sends, so the attribute works on every action.

### 15. `<sn-event value>`

`item` (for `upsert`) and `set` (for `merge`) were two names for what the change writes; it is one,
`value`. The `op` form itself stays (step 9).

### 16. Diagnostics

Kept separate where a code is its own opt-out (strict mode's `allow` is per code: the image warnings), and
merged where two codes were one rule with one severity: `SN302` into `SN209`. `SN327` (error, with
`sinter({ apis })`, where the config can declare the parameter) and `SN505` (warning, a bare spec, where
nothing can) are one rule with two severities, so they stay apart and name each other. `SN316`, a
migration error from 0.14, is gone; the rename messages of this proposal go at 1.0.

### 17. After the review (2026-11-20)

A second reader's review found bugs in the steps above (fixed, each with a test) and these, done:
- `data-sn-model-debounce` delays a model's write, and `data-sn-debounce` stays the action's: one attribute
  meant two things again, and adding an action to a debounced field moved its delay without a word.
- `paginate`'s numbered mode is `numbered: true`: `offset` was the mode and the server's skip parameter.
- `<sn-event fallback>` is gone: a payload that sometimes lacks the item is two `<sn-event>`s of the same
  name, each with its `when` (recipe: partial events). `numbered: 'offset'` (was `params.offset`, which
  switched the request as well as naming it).
- `sinter({ libraries })` (was `components`): it lists component libraries.
- `prefetch: { data, html }` (was `prefetch` and `speculation`; `html: true | 'prerender' | false | { prerender,
  delivery }`, after the third review), with `prefetch: false` turning off both as
  `<html data-sn-prefetch="off">` does for a page; `firstPaint: { budget }` (was `earlyBudget`).
- The feature module `./write-through` (was `./apply`).
- Renamed attributes report under `SN101`, functions under `SN201`, values under `SN401`.
- Diagnostic names that read alike where the rules are alike: `missing-row-key`/`missing-resource-key`,
  `undeclared-query`/`undeclared-query-in-spec`; `SN523` is `first-paint-budget`. Pure renames say
  "`X` is renamed to `Y`", and the editor's quick fix writes each.
- Click to load: a recipe for what `data-sn-get` did on a click (state and `when`).

Left for 1.0, as already deprecated: the top-level `sinter({ openapi })` (an API's `openapi`), and
`configure({ origins })` (`sinter({ origins })`). Kept: `data-sn-with` on `<sn-component>`, where a bare
`with` would give the word a second spelling.

## Looked at and kept

- `data-sn-wait`: already automatic. The build hides what follows a content-sized box by itself; the
  attribute is only the `off` switch, with `SN529` reporting the shift.
- `data-sn-with` (was `data-sn-prop`): its meanings are one idea, the values given to the thing (a
  custom element, a component, a slot's fill). A tree placement is a slot with values that its own component does not
  declare, and `SN535` catches near-misses.
- `data-sn-import` and `data-sn-preload`: they are apart on purpose. Preloading competes with the page
  bundle on a slow network, and docs/lazy.md measures both; folding one into the other would preload
  where nobody measured.

## Removed at 1.0

Every migration error of this proposal goes at 1.0, at once. They live in:

- `RETIRED` (attributes and elements, `SN101`) and `PAGINATE_OLD` with `legacyPaginate` (the old pagination
  attributes) in `src/compiler/compile.ts`; `SET_BY_SINTER` stays, it is not a migration.
- `RETIRED_FNS` (`SN201`) in `src/compiler/expr.ts`.
- The old `<sn-event>` attributes and `op` values (`item`, `set`, `fallback`, `op="patch|refetch"`), `UNPREFIXED`
  (`data-sn-on-navigate`, `data-sn-on-dismiss`) and `offset: true` in `paginate`, in `src/compiler/compile.ts`.
- `retiredOptions` in `src/project.ts` (`components`, the module paths, `content: '<path>'`), the renamed
  options in `src/vite.ts` (`speculation`, `earlyBudget`, the old `prefetch.html` values), `credentials()` in
  the config module (`configSource`), the old `complexity` keys (`complexityOf`), `--check-cycles` in
  `src/cli.ts`, and `render({ minify, remoteImages })` in `src/testing/index.ts`.
- Already deprecated, also going: the top-level `sinter({ openapi })` and `render({ openapi })` (an API's
  `openapi`), and `configure({ origins })` (`sinter({ origins })`).

The `<sn-include>` and `start-page` errors went early (2026-11-20): two and more generations old.

## Plan

One commit each, in this order: 1, 4a, 2, 3, 4, 10, 5, 8, 11, 7, 12, 6. Step 9 was held, then dropped: `op` and `value` stay. Each updates the vocabulary, the
compiler and runtime, tests, recipes, examples, docs (`npm run docs`) and the changelog.
