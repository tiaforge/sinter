# Changing data: actions

An **action** is an element that sends a request when something happens to it: a click, a submit, a
change. Add one method attribute and you have a working save, delete or toggle. What the server
answers is applied to your lists, and a failure is undone or shown, without handler code.

```html
<template data-sn-for="c in contacts">
  <li>
    <span data-sn-text="c.name"></span>
    <button data-sn-delete="/api/contacts/{c.id}"
            data-sn-confirm="'Delete ' + c.name + '?'"
            data-sn-optimistic="remove('contacts', c)">Delete</button>
  </li>
</template>
```

Click, confirm, and the row is gone at once. If the server refuses, it comes back and the error is
reported. Nothing else to write.

## Sending a request

One method attribute per element: `data-sn-get`, `-post`, `-put`, `-patch` or `-delete`, with a URL
template (`{c.id}` reads the row in scope). Add other attributes as needed:

| Attribute | Does |
| --- | --- |
| `data-sn-trigger="input"` | fires on this DOM event instead of the default |
| `data-sn-debounce="300"` | waits that many ms after the last trigger |
| `data-sn-body="expr"` | sends the value as JSON, instead of serializing a form |
| `data-sn-encoding="form"` | sends `application/x-www-form-urlencoded` instead of JSON |
| `data-sn-confirm="expr"` | asks first; a falsy value asks nothing |
| `data-sn-optimistic="…"` | changes lists before the request ([below](#optimistic-updates)) |
| `data-sn-then="…"`, `data-sn-catch="…"` | run after success or failure ([below](#then-and-catch)) |
| `data-sn-concurrency` | what to do with triggers while one is pending |
| `data-sn-apply="off"` | turns off [write-through](#write-through) for this element |
| `data-sn-retry` | resend after a dropped connection: see [retry.md](retry.md) |

### Triggers

| Element | Default trigger |
| --- | --- |
| `<form>` | `submit` (the default is prevented) |
| `<button>`, `<a>` | `click` |
| `<input>`, `<select>`, `<textarea>` | `change` |
| anything else | `click` |

An `<a>` with a method attribute does not navigate. A `<button>` inside a form that has its own
method attribute is its own action, not a submit.

```html
<input type="search" name="q" data-sn-get="/api/search?q={q}" data-sn-trigger="input" data-sn-debounce="300">
```

### The body

- With `data-sn-body`, its value is sent as JSON.
- Otherwise a form is serialized to nested JSON from its named controls. `name="org"` becomes
  `{org}`, `name="emails[0].value"` becomes `{emails: [{value}]}`. Number and range inputs send
  numbers, a single checkbox a boolean, several checkboxes with one name an array of the checked
  values. Disabled controls are skipped.
- A form with an `<input type="file">` is sent as `multipart/form-data`.
- `GET` and `DELETE` without `data-sn-body` send no body.

`data-sn-encoding="form"` is for backends that expect a browser-style form post. A form's fields go
as a browser would send them (repeated names stay repeated). With `data-sn-body`, the object's keys
become fields: an array is a repeated key, `null` and `undefined` are left out, a nested object is
sent as JSON text.

### Confirmation

`data-sn-confirm` is evaluated when the action triggers. On "no" nothing happens: no optimistic
change, no request. A falsy value asks nothing, so the question can depend on state:

```html
<button data-sn-delete="/api/notes/{n.id}" data-sn-confirm="inTrash ? m.delete_forever() : null">Delete</button>
```

It uses `window.confirm`. `configure({ confirm })` replaces it with your own dialog and may return
a promise ([configuration.md](configuration.md)).

## Forms and validation errors

A form is an action like any other. Put the method on the `<form>` and name the controls:

```html
<form data-sn-post="/api/signup">
  <p data-sn-show="$error && !$error.body?.errors" data-sn-text="$error?.detail"></p>
  <label>Email <input type="email" name="email"></label>
  <button>Sign up</button>
</form>
```

When the server answers 4xx with a JSON body whose `errors` is an object of `name: message` or
`name: [message, …]` (the shape Rails, Laravel, ASP.NET's validation problem details and RealWorld
use), sinter puts each message on the control with that name:

- the control gets `aria-invalid="true"`;
- the messages (joined with `; `) go into the element its `aria-errormessage` names, or into a
  `<small data-sn-error="email" data-tone="danger">` inserted after the control;
- the first invalid control gets focus;
- editing a control clears its error, and sending the form again clears them all.

This applies to forms and to buttons inside them (`form="id"` counts) with `post`, `put`, `patch` or
`delete`, as long as the action has no `data-sn-catch`. `GET` actions and local actions mark no
fields. To place a message yourself, point `aria-errormessage` at an element:

```html
<input name="username" aria-errormessage="username-error">
<small id="username-error" hidden></small>
```

### `$error` in a form

Inside a `<form>`, `$error` is the form's last failed send, `{status, body, message, detail}`, or
`null`. It is `null` again when the form is sent again. It is ordinary reactive state, so a summary
is plain markup. `detail` is the error in words when there is one (a short text body, a JSON
body's `message` or `error`); `message` falls back to the HTTP status.

When every message found a field, or the form's markup reads `$error`, the failure counts as shown.
Otherwise (a name no control has, a 5xx, a network error) it goes the [unhandled way](#unhandled-errors).

### Other error formats

`configure({ fieldErrors })` reads the server's messages out of `error.body` for APIs that use
another shape. Return `{ name: message | [message, …] }`, `null` to mark no field, or `undefined`
to fall back to the default:

```js
configure({
  fieldErrors: (error, { url, method }) => {
    const p = error.body?.['invalid-params'];                 // RFC 9457
    if (Array.isArray(p)) return Object.fromEntries(p.map((x) => [x.name, x.reason]));
  },
});
```

`() => null` marks no field and leaves everything to `$error` in your markup. If the server sends
codes instead of text, map them to your messages in this hook. Recipe: [field-errors](recipes/field-errors.html).

## Pending state and concurrency

While a request is pending, the element has `aria-busy="true"`, and a form in `block` mode is also
disabled. `GET` actions abort the previous request when triggered again (latest wins). Mutations
follow a policy, applied per element, so rows in a list never block each other:

| `data-sn-concurrency` | While one is pending | Default for |
| --- | --- | --- |
| `block` | new triggers are ignored | `<form>` |
| `queue` | every trigger is sent, in order | everything else |
| `latest` | the newest waiting trigger is sent after the running one, older ones are dropped | nothing |

`latest` suits autosave, and only when the body describes the target state (a full draft,
`set: true`), not an operation such as "create". A running mutation is never aborted, because
aborting `fetch` does not stop the server.

## Optimistic updates

`data-sn-optimistic` changes your lists before the request is sent, keeps the change if the request
succeeds, and undoes exactly that change if it fails.

```html
<button data-sn-patch="/api/messages/{m.id}"
        data-sn-body="{is_flagged: !m.is_flagged}"
        data-sn-optimistic="patch('messages', m, {is_flagged: !m.is_flagged})"
        data-sn-catch="emit('toast', $error.message)"
        data-sn-attr="{'aria-pressed': m.is_flagged ? 'true' : 'false'}">★</button>
```

The expression may only call `patch`, `upsert` and `remove` (anything else is a build error, since
local state and side effects cannot be rolled back).

### Model

Each resource keeps a **base** (what the server last confirmed) and an ordered list of
**layers** (optimistic changes whose request is pending). What the page shows is the base with every
layer applied on top, in order.

- Triggering the action records its `patch`, `upsert` and `remove` calls as one layer and re-renders
  the affected rows.
- On success (2xx) the layer is committed into the base, then `then` runs, so a write in `then`
  goes on top and wins. What is on screen does not change at commit, so nothing flickers.
- On failure the layer is dropped, which is the rollback, and `catch` runs. An aborted request, or a
  `latest` trigger replaced before it was sent, counts as a failure.
- Layers commit in order. If a later request answers first, its layer waits on top of the older
  one and joins the base once everything older has settled, so the last change made stays on top.
- Server events write to the base and layers are re-applied above them, so a live update that arrives
  mid-request is neither lost nor undone by a rollback.

Rollback is "drop the layer", not "restore a snapshot", so two overlapping actions on one item do
not wipe each other out when the first fails.

### Rules

- A `patch` on an item the base no longer has is ignored; a `remove` of an absent item does nothing.
- On a paginated resource, `remove` also lowers `$meta.<name>.total` in the same layer.
- A layer lives until its request settles: the 30 s timeout, and with `data-sn-retry` every try of
  its policy.
- A bulk action puts all its changes into one layer, so they roll back together.
- `$meta.<name>.pending` counts layers whose request has not settled.

### Typical cases

| Action | Optimistic change |
| --- | --- |
| Flag or mark read | `patch('messages', m, {is_flagged: …})` |
| Delete or move | `remove('messages', m)` |
| Bulk mark read | one layer, one `patch` per selected message |
| Toggle visibility | `patch('calendars', cal, {hidden: !cal.hidden})` |

Recipe: [optimistic-toggle](recipes/optimistic-toggle.html).

## Write-through

A 2xx response is applied to the lists it is about, without a `then`. It happens after the
optimistic layer commits and before `then` runs. You declare nothing: the compiler knows from the
URL and body which resources and rows the action reads.

| Rule | When | Effect |
| --- | --- | --- |
| Confirm | the response holds an object of a schema `S` | every keyed list of `S` patches its item with that key; what the URL named is patched when it is an `S` |
| Create | a `POST` to a keyed list's own URL, query included | the response's object (else the body merged with the response's key fields; else a refetch) is upserted. A filtered or paginated list is never inserted into |
| Update | a `PUT` or `PATCH` | the body patches the entity the URL named |
| Delete | a `DELETE` of that list's URL plus one path segment, built from a row | the row is removed |

- The first three need your OpenAPI spec (`sinter({ openapi })`). Without one you still get Delete,
  and Update when every body key is a field the row already has.
- Patches merge: fields the response omits stay.
- Nothing is matched by type alone. A response `Article` does not replace the single resource
  `article` unless the URL read it, and `DELETE /articles/{slug}/favorite` removes nothing.
- `data-sn-apply="off"` turns it off for one element. `GET` actions and `data-sn-call` have no
  write-through.
- A `then` that does what a rule already does is the warning `SN510`. Dev builds log each
  application to the console.

## then and catch

`data-sn-then` runs after a 2xx response with `$result` (the parsed body); `data-sn-catch` runs after
a failure with `$error`. Both are handlers: state assignments and these built-ins, separated by
`;`.

| Function | Effect |
| --- | --- |
| `refresh('contacts')`, `refresh('a', 'b')` | refetch the named resources |
| `upsert('contacts', $result)` | insert or replace an item |
| `patch('contacts', item, {…})` | change fields of an item |
| `remove('contacts', item)` | remove an item |
| `page('messages', 'next')` | change the page of a paginated resource |
| `showModal('edit')` | open `<dialog id="edit">`, nothing if it is open |
| `close()`, `close('edit')` | close the nearest `<dialog>`, or the one with that id |
| `reset()` | reset the nearest form |
| `emit('name', detail)` | dispatch a bubbling, cancelable `CustomEvent` from the element |
| `run('id')` | start the action of the element with that id ([below](#run-an-action-from-a-handler)) |

```html
<form data-sn-post="/api/people" data-sn-body="draft"
      data-sn-then="upsert('people', $result); draft = null; close()"
      data-sn-catch="emit('toast', $error.message)">
```

Non-2xx responses give `$error = {status, body, message, detail}`. Network errors have `status: 0`,
a failed local action `status: null`. `error = $error.detail ?? m.save_failed()` shows the server's
reason or your own text.

Resource names in these functions must be string literals, `a ? 'x' : 'y'`, `||` or `??` between
literals, or a `data-sn-let` name holding one, so the compiler can check every name.

### Unhandled errors

An action that fails with no `data-sn-catch` (and no field or `$error` display that showed it)
reaches an `sn-error` event, which bubbles from the element with `detail = {error, element}`.
Handle it with `data-sn-on-sn-error` on any ancestor; `$event.preventDefault()` ends the walk. If
nothing prevented it, `configure({ onError(error, element) })` runs, for example to show a toast.
Dev builds log every unhandled error. A 401 never gets here: the login redirect handles it.

## Local actions

Work that is not one request (hashing, crypto, WebAuthn, other browser APIs) goes in functions you
export from `src/sinter.actions.js` (or `.ts`). A page calls them with `data-sn-call`:

```html
<button data-sn-call="upload(file, digest)" data-sn-attr="{disabled: !digest}"
        data-sn-then="url = $result.url" data-sn-catch="error = $error.message">Upload</button>
<sn-resource name="digest" call="sha256(file)" when="file"></sn-resource>
```

```js
// src/sinter.actions.js
export async function sha256(file, ctx) {
  const bytes = await file.arrayBuffer();
  ctx.signal.throwIfAborted();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- One call of an exported function or `export * as ns` member per element. Combining it with a
  method attribute or `data-sn-body` is an error.
- It is an action in every other respect: triggers, debounce, `aria-busy`, concurrency,
  `data-sn-optimistic`, `then` with `$result`, `catch` with `$error`, and the unhandled-error path.
- Arguments are expressions evaluated at trigger time (they see `$event`). The function receives
  them, then a context `{signal, request, el}`. `request` is `fetch` through your middleware
  (headers, 401 handling, allowed origins, timeout); `signal` aborts when the page is hidden; `el`
  is the element, `null` for a resource.
- A thrown `SinterError` reaches `$error` as is; any other throw becomes
  `{status: null, body: <thrown value>, message}`.
- Action functions return data and never touch state or the DOM: `then` puts the result where it
  belongs. Expressions cannot call them.
- `<sn-resource call="…">` is a resource fed by a function. It calls again when the arguments
  change, aborting the running call through `ctx.signal` and dropping its late result.
  `paginate`, `each` and `cache` do not combine with `call`.
- With JSDoc or TypeScript types, `sinter check` checks arguments against the parameters (without
  the trailing context) and `$result` against the return type.

Recipe: [local-actions](recipes/local-actions.html).

## Run an action from a handler

A handler cannot call an action function, because an action's lifecycle (busy state, concurrency,
rollback, `then`/`catch`) belongs to its element. `run('id')` starts the action of the element with
that id, and that lifecycle runs unchanged. Use it for a shortcut on a control that has no button,
for chaining, or for "mark read after the body loads":

```html
<body data-sn-on-keydown-e="run('archive')">
  <span hidden id="mark-read" data-sn-call="mail.markRead(open)"
        data-sn-optimistic="patch('messages', open, {is_read: true})"></span>
  <sn-resource name="body" call="mail.body(open)" when="open"
               then="$result && !open.is_read && run('mark-read')"></sn-resource>

  <button id="archive" data-sn-post="/api/archive?id={open.id}" data-sn-attr="{disabled: !open}"
          data-sn-optimistic="remove('messages', open)">Archive</button>
```

- The target is an element in the page (partials included) that carries `data-sn-get`, `-post`,
  `-put`, `-patch`, `-delete` or `data-sn-call`. The id must be a string literal naming exactly one
  such element, outside any `data-sn-for` row, or the build fails (`SN311`). Pass a row through
  state: `open = m; run('mark-read')`.
- It enters where the trigger event would: debounce, confirm, concurrency, optimistic layer, busy
  state, `then`/`catch` all apply. No DOM event is dispatched, so the target's own `data-sn-on-*`
  handlers do not run and nothing bubbles.
- A form is submitted with `requestSubmit()`: validation runs and an invalid form is not sent.
- The target's expressions see the target's own scope, not the caller's. `run()` takes no arguments
  and starts synchronously, so state assigned earlier in the same handler is visible to the URL and
  body.
- `$event` in the target's trigger-time expressions is `null` (for a form, the `SubmitEvent`).
  Write `$event && $event.shiftKey`, not `$event.shiftKey`, if a button serves both a click and a
  shortcut.
- A disabled or `inert` target does nothing, so disabling the button also disables its shortcut. A
  hidden target runs; that is the pattern above. A `block` action with a request pending ignores
  the run.
- It returns nothing. Results go to the target's `then` and `catch`.
- `run()` works in every handler (`data-sn-on-*`, `then`, `catch`, `<sn-resource then>`,
  `<sn-event then>`), not in value expressions or `data-sn-optimistic`.
- A loop of actions that run each other (`data-sn-catch="run('save')"` on `#save`) is an endless
  series of requests; nothing stops it at runtime. `sinter check --check-cycles` lists such cycles
  as `SN509`.

Recipe: [run-action](recipes/run-action.html).

## Keyboard shortcuts

Name the key in the attribute: `data-sn-on-keydown-<modifiers->key` (also `data-sn-on-keyup-…`).

```html
<body data-sn-on-keydown-j="cursor = nextRow(list, cursor)"
      data-sn-on-keydown-shift-n="weekStart = addDays(weekStart, 28)"
      data-sn-on-keydown-mod-enter="run('send')"
      data-sn-on-keydown-escape="detailOpen = false">
```

Spelling: all lowercase, the modifiers (`ctrl`, `alt`, `shift`, `meta`, and `mod`, which is Cmd on
Apple platforms and Ctrl elsewhere) in any order, then exactly one key, joined with `-`.

| Key | Spelled |
| --- | --- |
| letters and digits | `a`-`z`, `0`-`9` |
| named keys | `escape`, `enter`, `tab`, `space`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `arrowup`, `arrowdown`, `arrowleft`, `arrowright`, `contextmenu`, `f1`-`f12` |
| characters | `slash` /, `backslash` \\, `question` ?, `period` ., `comma` ,, `semicolon` ;, `colon` :, `quote` ', `backquote` \`, `minus` -, `plus` +, `equal` =, `asterisk` \*, `bracketleft` [, `bracketright` ] |

Anything else is `SN101` with a suggestion (`esc` becomes `escape`, `cmd` becomes `meta`, `?`
becomes `question`). Uppercase is an error too: N is `shift-n`.

- **The key printed on the key.** Filters match `KeyboardEvent.key`, so `z` is Z on a German
  keyboard, and `question` is ? however you type it. On a layout with no Latin letters, a letter
  filter falls back to the physical key, so `ctrl-n` still works.
- **Modifiers are exact.** `j` does not run for Ctrl+J, `escape` not for Shift+Escape. Digits and
  named characters ignore Shift unless the filter names it.
- **Keys in fields belong to the field.** A filter on an ancestor does not run while focus is in a
  text input, textarea, select or contenteditable, and does not take Enter or Space from a focused
  button, link, summary, checkbox or radio. A filter on the focused element does:
  `<textarea data-sn-on-keydown-mod-enter="send()">`. Escape is not exempt: in a dialog's field it
  closes the dialog.
- **A matching filter calls `preventDefault()`.** A plain `data-sn-on-keydown` never does.
- **Repeats run.** Holding `j` moves on. Guard with `$event.repeat || run('archive')`. Nothing
  matches during IME composition.
- **Nearest wins.** The nearest element from the target up that handles the key ends the walk: one
  whose filter matched, or whose plain handler ran and prevented the key. A
  `<dialog data-sn-on-keydown-escape>` does not swallow the `j` meant for `<body>`.
- **Where.** Keys go to the focused element, or `<body>` when nothing is focused. Page-wide
  shortcuts belong on `<body>`.
- `data-sn-debounce-keydown-j` delays only that filter's handler.

Recipe: [keyboard-shortcuts](recipes/keyboard-shortcuts.html).

## Suggestion lists

`data-sn-listbox` turns a text input into a combobox over a list of options:

```html
<input data-sn-model="q" data-sn-listbox="hits" data-sn-on-dismiss="open = false">
<ul id="hits" role="listbox" data-sn-show="open && hits.length">
  <template data-sn-for="h in hits">
    <li role="option" data-sn-on-click="pick(h)" data-sn-text="h"></li>
  </template>
</ul>
```

- The compiler adds `role="combobox"`, `aria-controls` and `aria-autocomplete="list"` to the input.
- The value is the list's `id`. Left empty, the list is the nearest `[role="listbox"]` around the
  input, for inputs rendered in a loop.
- ArrowDown and ArrowUp mark an option (`aria-selected="true"`, scrolled into view). Enter clicks
  the marked option, Tab the marked one or the only one. Escape fires a bubbling, cancelable
  `dismiss` event on the input; one handler on a form can serve all its inputs, and an input's own
  handler keeps it there with `$event.preventDefault()`. Other keys, and Enter with no marked
  option, do what they always do.
- Typing unmarks. A mouse press on an option does not take focus from the input. Picking is your
  option's own click handler.

## Dialogs

Use the native `<dialog>`. A button that only opens it needs no handler: `commandfor` and
`command="show-modal"` are the platform's. Set the state the dialog reads in the same button:

```html
<button data-sn-on-click="draft = {name: '', emails: [{value: ''}]}"
        commandfor="edit" command="show-modal">New</button>

<dialog id="edit">
  <form data-sn-post="/api/people" data-sn-body="draft"
        data-sn-then="upsert('people', $result); draft = null; close()">
    <input data-sn-model="draft.name" required>
    <button>Save</button>
  </form>
</dialog>
```

- `showModal('edit')` and `close('edit')` are for opening or closing from a handler, such as a
  `then` after a request or a custom event. `close()` alone closes the nearest dialog. The id must
  be a string literal naming a `<dialog id>` on the page or its partials, or the build fails
  (`SN309`).
- Bindings inside a dialog render when it opens. A resource that only dialogs read loads with low
  priority.
- Reset state when the dialog closes, however it closes (Escape included):
  `<dialog id="person" data-sn-on-close="sel = null">`.
- Closing a form's dialog in `then` means a failed save leaves it open with the errors on its
  fields.

Recipe: [form-dialog](recipes/form-dialog.html).

## Row selection

Selection is state, not a feature. Keep the selected keys in state, toggle them in a click handler,
and keep the multi-select rules (Ctrl adds, Shift selects a range) in a pure helper so the handler
only applies its result:

```html
<section data-sn-state="{ sel: noSelection() }" data-sn-let="{ ids: files.map(f => f.id) }">
  <p data-sn-text="sel.keys.length + ' selected'"></p>
  <ul role="listbox" aria-multiselectable="true">
    <template data-sn-for="f in files">
      <li role="option" data-sn-attr="{'aria-selected': sel.keys.includes(f.id) ? 'true' : 'false'}"
          data-sn-on-click="sel = rowClick($event, sel, f.id, ids)" data-sn-text="f.name"></li>
    </template>
  </ul>
</section>
```

`noSelection()` returns `{ keys: [], anchor: null }` and `rowClick(event, sel, key, keys)` returns
the next selection, from `event.ctrlKey`, `event.metaKey` and `event.shiftKey`. Both live in your
helpers module and are testable without a page. A bulk action then reads `sel.keys`, and its
optimistic change is one layer, so it rolls back as a whole. Recipe: [row-select](recipes/row-select.html).

## Edge behavior

- A button or action inside a clickable row keeps the row's `data-sn-on-click` from running: the
  nearest element that handles a click wins. Custom events from `emit()` are different; they
  reach every ancestor with a handler, inner first, until one prevents the default.
- `then` runs after write-through, so what `then` writes has the last word.
- A later refetch or server event also beats an optimistic change that has already committed, like
  any later write to the base.
- `data-sn-confirm` with a falsy value skips the question, not the action.
- `$error` outside a form and outside `data-sn-catch` is a build error (`SN201`); inside
  `data-sn-catch` it is that action's own error, and `data-sn-catch` also switches off the form's
  automatic field errors.
- A `GET` action cancelled by a newer trigger is a failure for its optimistic layer.

See also: [resources.md](resources.md), [sync.md](sync.md), [retry.md](retry.md),
[configuration.md](configuration.md), [attributes.md](attributes.md), [diagnostics.md](diagnostics.md).
