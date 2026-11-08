# sinter diagnostics

Generated from `src/compiler/diagnostic-docs.ts` by `npm run docs`. Every diagnostic links to its section here. Codes from SN500 up are warnings; the rest are errors and fail the build.

## SN101 unknown-attribute

Error, for example:

> `data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`?

An attribute starts with `data-sn-` but is not one sinter knows, usually a typo.

**Fix:** Use the suggested name. The attributes are listed in `llms.txt` and, in VS Code, completed from `html-custom-data.json`.

## SN102 wrong-element

Error, for example:

> `data-sn-for` must be on a `<template>`

The attribute or element is valid, but not here: lists and conditionals render from a `<template>`, `data-sn-path` belongs on `<html>`, `<sn-event>` inside `<sn-sync>`, options such as `data-sn-debounce` need a method attribute on the same element, and `data-sn-attr` cannot bind the `value` or `checked` that a `data-sn-model` on the same control writes.

**Fix:** Move it to where the message says, wrapping the content in a `<template>` if needed.

## SN103 missing-key

Error, for example:

> a `data-sn-for` over primitive values needs `data-sn-key`

sinter keys list rows by the resource key or by object identity. Strings and numbers have neither, so rows could not be matched on update.

**Fix:** Add `data-sn-key` with an expression that is unique per row, such as the value itself: `data-sn-key="tag"`.

## SN104 unsupported-model

Error, for example:

> `data-sn-model` does not support `type="file"`; submit the form instead

Two-way binding has no meaningful value for this input type.

**Fix:** Submit the form with a method attribute (`data-sn-post`, …) on it; a form with a file input is sent as `FormData`.

## SN201 unknown-identifier

Error, for example:

> `contcts` is not defined here. Did you mean `contacts`?

An expression uses a name that is not a loop variable, state field, resource, magic name, helper or JavaScript global in this scope.

**Fix:** Fix the typo, declare the name in `data-sn-state`, or export it from the helpers module. Loop variables are only visible inside their `<template>`.

## SN202 forbidden-global

Error, for example:

> `window` is a browser API; expressions may use JavaScript, not the browser. Use an island

Expressions may use JavaScript built-ins but not browser APIs such as `window`, `document`, `fetch` or timers, so pages stay safe under a strict CSP and testable.

**Fix:** Move the browser code into a helper (for a pure function) or an island (a custom element that owns imperative work).

## SN203 side-effect

Error, for example:

> value expressions cannot assign; move this to `data-sn-on-*`

A binding that produces a value (`text`, `attr`, `show`, `for`, …) tried to change state, which would run on every render. Path parameters of `$url` are read-only everywhere. Also: an expression called a function of the actions module. Actions run on elements (`data-sn-call`) or feed resources (`<sn-resource call>`), because their busy state, concurrency, optimistic layer and `then`/`catch` belong to an element.

**Fix:** Do the assignment in an event handler (`data-sn-on-click`) or in an action's `then`. To start an action from a handler (a key filter, `data-sn-then`, `<sn-resource then>`), put it on an element with an `id` and call `run('id')`: `<span hidden id="mark-read" data-sn-call="mail.markRead(open)"></span>` and `then="$result && run('mark-read')"`.

## SN204 optimistic-scope

Error, for example:

> `data-sn-optimistic` may only call `patch`, `upsert`, `remove`

An optimistic change is undone when the request fails, so it may only use the store functions that sinter can roll back.

**Fix:** Express the change with `patch`, `upsert` or `remove`; set other state in `then`.

## SN205 resource-mutation

Error, for example:

> `m.is_read = true` mutates a resource. Use `patch('messages', m, {is_read: true})`

Resource data is read-only in expressions: it mirrors the server, and a direct write (an assignment, a mutating method such as `push()`, or `Object.assign()` on an item) would be lost on the next refresh or event.

**Fix:** Use the `patch()` call from the message, or copy the item with `structuredClone(c)` to edit it in state.

## SN206 unknown-namespace-member

Error, for example:

> `m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`?

A helper namespace (for example paraglide messages) has no export of that name.

**Fix:** Use the suggested name, or add the export to the namespace module.

## SN207 unsafe-sink

Error, for example:

> `onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`

The binding could run script or inject markup from data: event-handler attributes, `style`, `srcdoc`, `innerHTML`, bindings on `<script>` and similar elements, URL templates that do not start with a literal path (or with a literal origin that lacks its `/` before a value), persisted password fields, or `constructor`, `__proto__` and `prototype` named in an expression.

**Fix:** Use the safe equivalent the message names: `data-sn-on-*` for events, `data-sn-style` for styles, a literal `/path` (or `https://host/`) at the start of a URL template.

## SN208 type-error

Error, for example:

> Property 'nmae' does not exist on type 'Contact'. (TS2339)

TypeScript found a type error in an expression. Reported by `sinter check`, `sinter({ typecheck: true })` and the editor integration.

**Fix:** Fix the expression, or the type: `type` on `<sn-resource>`, the OpenAPI spec, or a JSDoc cast in `data-sn-state`.

## SN209 name-conflict

Error, for example:

> `s` is already defined here by `data-sn-let`; use another name

A `data-sn-let` name is inlined wherever it is read, so it cannot share a name with a state variable or loop variable in its scope, or be redeclared inside it. A resource cannot take the name of a store function (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close`, `reset`, `emit`, `run`).

**Fix:** Rename the let, the state or loop variable, or the resource.

## SN301 unknown-resource

Error, for example:

> resource `mesages` is not declared on this page

A store call, `$meta` or embedded data (`data-sn-data`) names a resource that no `<sn-resource>` on the page or its partials declares. A name chosen by an expression (`page(searching ? 'results' : 'messages', 'next')`, or a `data-sn-let` name that is one) is checked for each name it can take. Also reported: a store call whose name argument cannot be listed from the source (a state variable, a helper's result, `$event.detail`).

**Fix:** Fix the name or add the `<sn-resource>` element. For a name that cannot be listed, write the choice as literals: `?:`, `||` or `??` between string literals, or a `data-sn-let` name whose value is one; a name kept in state becomes `tab === 'inbox' ? 'inbox' : 'sent'`.

## SN302 duplicate-resource

Error, for example:

> resource `contacts` is declared twice

Two `<sn-resource>` elements on one page share a name, often once in the page and once in a partial.

**Fix:** Rename one, or remove the duplicate.

## SN303 unknown-meta-field

Error, for example:

> `$meta.contacts.loadng` is not a status field. Did you mean `loading`?

`$meta.<resource>` has a fixed set of fields: `loading`, `error`, `loadedAt`, `pending`, `total`, and with `paginate` also `pages`, `from`, `to`, `hasPrev`, `hasNext`; `page` with `paginate="offset"`, or keyset with `offset-param`.

**Fix:** Use the suggested field. A pagination field needs `paginate` on the resource.

## SN304 keyset-jump

Error, for example:

> keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`

Keyset (cursor) pagination only knows the next and previous page, so `page('name', 7)` has nothing to jump to, unless the server can also skip items by offset. A computed target (`page('name', dir)`) is not this error: `sinter check` types it as a direction, and at run time a page number is refused without a request. `append` pagination takes only the literal `'next'`.

**Fix:** If the API accepts an offset next to its cursor, add `offset-param="offset"`: the jump is sent as an offset and `prev`/`next` continue by cursor. Otherwise use `paginate="offset"`, or only step with `first`, `prev`, `next` and `last`.

## SN305 include-not-found

Error, for example:

> partial `./partials/contact-dialg.html` not found or outside the project root

The `src` of `<sn-include>` must be a literal path, relative to the including file, that resolves inside the project root.

**Fix:** Fix the path. Partials outside the root are refused on purpose.

## SN306 include-cycle

Error, for example:

> `a.html` → `b.html` → `a.html` includes itself

Partials include each other in a cycle.

**Fix:** Move the shared part into a third partial that neither includes back.

## SN307 openapi-invalid

Error, for example:

> OpenAPI spec `api.yml` is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`)

A spec given to `sinter({ openapi })` is missing, unreadable, or not OpenAPI 3.

**Fix:** Fix the path in the Vite config, or convert a Swagger 2 spec to OpenAPI 3.

## SN308 unknown-schema-field

Error, for example:

> the response of `GET /articles` has no `articls`. Did you mean `articles`?

The resource matched an operation in the OpenAPI spec, but its `items` or `total` path is not in the response schema.

**Fix:** Fix the path in `items` or `total`, or the spec if the API changed.

## SN309 unknown-dialog

Error, for example:

> no `<dialog id="compose-dialg">` on this page. Did you mean `compose-dialog`?

`showModal(id)` and `close(id)` name a `<dialog>` by its literal `id`, which must be on the page or one of its partials.

**Fix:** Fix the id, or add `id` to the `<dialog>`. `close()` without an argument closes the dialog around the element.

## SN310 unknown-action

Error, for example:

> `pgp.decrpyt` is not exported by the actions module. Did you mean `pgp.decrypt`?

`data-sn-call` and `<sn-resource call>` name a function the actions module (`src/sinter.actions.js` or `.ts`) exports, directly or through `export * as ns`.

**Fix:** Use the suggested name, or export the function from the actions module.

## SN311 unknown-run-target

Error, for example:

> no element `id="mark-raed"` on this page. Did you mean `mark-read`?

`run(id)` starts the action of the element with that literal `id`: an element on the page or one of its partials with `data-sn-get`, `-post`, `-put`, `-patch`, `-delete` or `data-sn-call`. Also reported: an id that is not a string literal, an element without an action, an element inside a `data-sn-for` row (every row would have the id), and an id that more than one element has.

**Fix:** Fix the id, or give the action element an `id`. For a row's action, put one action element outside the list and pass the row through state: `open = m; run('mark-read')`.

## SN401 parse-error

Error, for example:

> `data-sn-for` takes `item in list` or `(item, i) in list`

An attribute value has the wrong form: a JavaScript syntax error (the column points inside the attribute), or a value outside what the attribute accepts, such as `paginate` or `data-sn-concurrency`.

**Fix:** Fix the value as the message says. Handlers are statements separated by `;`; value bindings are a single expression.

## SN501 unused-resource

Warning, for example:

> resource `addressbooks` is declared but never read

The page fetches a resource that nothing on it uses, which costs a request on every load. A resource with a `then` handler counts as used.

**Fix:** Remove the `<sn-resource>`, or use it.

## SN502 non-reactive-value

Warning, for example:

> `Date.now()` in a binding never updates. Use `$now`

The binding reads the time or a random number once and is never re-rendered by it.

**Fix:** Use `$now`, which sinter updates, or compute the value in a handler.

## SN503 data-bound-id

Warning, for example:

> `id` bound from data can shadow globals other scripts read (DOM clobbering)

An `id` or `name` set from server data can create a global that overrides one another script relies on.

**Fix:** Prefix the value (`'contact-' + c.id`) or use a `data-*` attribute instead.

## SN504 untyped-resource

Warning, for example:

> resource `contacts` has no type: expressions using it are not checked

The type checker has no type for the resource, so expressions that use it are not checked. Reported by `sinter check` only.

**Fix:** Add `type="Contact[]"` with a type from `src/sinter.types.ts`, configure an OpenAPI spec that matches `src`, load it with `call` (typed by what the action returns), or write `type="any"` to opt out.

## SN505 unknown-query-param

Warning, for example:

> `GET /articles` declares no query parameter `tagg`. Did you mean `tag`?

A literal query parameter in `src` is not declared by the matched OpenAPI operation, usually a typo the server would ignore.

**Fix:** Use the suggested name, or add the parameter to the spec.

## SN506 untyped-event

Warning, for example:

> event `contact_updated` has no type: expressions reading its payload are not checked

An `<sn-event>` reads its payload but has no `type`, so those expressions are not checked. Reported by `sinter check` only.

**Fix:** Add `type` with a payload type from `src/sinter.types.ts`, or `type="any"` to opt out.

## SN507 complex-expression

Warning, for example:

> `data-sn-on-click` is too complex for markup: 5 statements in one handler (limit `statements`: 4). Move the logic into a helper (pure, `x = fn(…)`) or an action

An expression has more structure than markup should hold. The measure is structure, not length: statements in a handler (`statements`, 4), comma sequences (`sequences`, 0), steps one `&&`/`||`/`?:` used as a statement runs (`guarded`, 1: `a && close()` is fine, `a && (b = 1, close())` is not), `?:` nesting (`ternaries`, 2), operations in an arrow function (`arrow`, 8; a block body `{ … }` always counts), and operations in one expression or statement (`operations`, 15) as a backstop. Operations are calls, operators, assignments and computed access; names, member paths (`a.b.c`) and literals are free. Object attributes (`data-sn-state`, `-let`, `-attr`, `-class`, `-style`, `-prop`) are measured per property value. A warning by default.

**Fix:** Move the logic into a helper (pure) and apply its result in the handler, `sel = rowClick($event, sel, key)`, or into an action for side effects (`data-sn-call`). Split independent steps into separate `;` statements. Limits and the level are options of the Vite plugin: `sinter({ complexity: { statements: 4, level: 'error' } })`; `level: 'off'` turns the check off.

## SN509 run-cycle

Warning, for example:

> `run()` cycle: `#save` `data-sn-catch` (index.html:12) runs `#save`, which starts the first step again

`then`/`catch` handlers start each other again through `run()` (and `refresh()`, whose load runs the resource's `then`), so the requests may never stop. The message lists every step with its handler and line. The check is off by default: a guarded retry is a deliberate cycle. `sinter check --check-cycles` turns it on for one run, and `sinter({ checkCycles: true })` for the build, `sinter check` and `sinter lsp`.

**Fix:** Make sure a step stops: a condition that becomes false (`$error.status === 503 && tries < 3 && run('save')`), or drop one step.
