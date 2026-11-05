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

The attribute or element is valid, but not here: lists and conditionals render from a `<template>`, `data-sn-path` belongs on `<html>`, `<sn-event>` inside `<sn-sync>`, and options such as `data-sn-debounce` need a method attribute on the same element.

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

A binding that produces a value (`text`, `attr`, `show`, `for`, …) tried to change state, which would run on every render. Path parameters of `$url` are read-only everywhere.

**Fix:** Do the assignment in an event handler (`data-sn-on-click`) or in an action's `then`.

## SN204 optimistic-scope

Error, for example:

> `data-sn-optimistic` may only call `patch`, `upsert`, `remove`

An optimistic change is undone when the request fails, so it may only use the store functions that sinter can roll back.

**Fix:** Express the change with `patch`, `upsert` or `remove`; set other state in `then`.

## SN205 resource-mutation

Error, for example:

> `m.is_read = true` mutates a resource. Use `patch('messages', m, {is_read: true})`

Resource data is read-only in expressions: it mirrors the server, and a direct write would be lost on the next refresh or event.

**Fix:** Use the `patch()` call from the message, or copy the item with `structuredClone(c)` to edit it in state.

## SN206 unknown-namespace-member

Error, for example:

> `m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`?

A helper namespace (for example paraglide messages) has no export of that name.

**Fix:** Use the suggested name, or add the export to the namespace module.

## SN207 unsafe-sink

Error, for example:

> `onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`

The binding could run script or inject markup from data: event-handler attributes, `style`, `srcdoc`, `innerHTML`, bindings on `<script>` and similar elements, URL templates that do not start with a literal path, or persisted password fields.

**Fix:** Use the safe equivalent the message names: `data-sn-on-*` for events, `data-sn-style` for styles, a literal `/path` at the start of a URL template.

## SN208 type-error

Error, for example:

> Property 'nmae' does not exist on type 'Contact'. (TS2339)

TypeScript found a type error in an expression. Reported by `sinter check`, `sinter({ typecheck: true })` and the editor integration.

**Fix:** Fix the expression, or the type: `type` on `<sn-resource>`, the OpenAPI spec, or a JSDoc cast in `data-sn-state`.

## SN301 unknown-resource

Error, for example:

> resource `mesages` is not declared on this page

A store call, `$meta` or embedded data (`data-sn-data`) names a resource that no `<sn-resource>` on the page or its partials declares.

**Fix:** Fix the name or add the `<sn-resource>` element.

## SN302 duplicate-resource

Error, for example:

> resource `contacts` is declared twice

Two `<sn-resource>` elements on one page share a name, often once in the page and once in a partial.

**Fix:** Rename one, or remove the duplicate.

## SN303 unknown-meta-field

Error, for example:

> `$meta.contacts.loadng` is not a status field. Did you mean `loading`?

`$meta.<resource>` has a fixed set of fields: `loading`, `error`, `loadedAt`, `pending`, `total`, and with `paginate` also `page`, `pages`, `from`, `to`, `hasPrev`, `hasNext`.

**Fix:** Use the suggested field. A pagination field needs `paginate` on the resource.

## SN304 keyset-jump

Error, for example:

> keyset pagination cannot jump to a page number. Use `paginate="offset"`

Keyset (cursor) pagination only knows the next and previous page, so `page('name', 7)` has nothing to jump to.

**Fix:** Use `paginate="offset"` if the API supports offsets, or only step with `next`, `prev` and `first`.

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

## SN401 parse-error

Error, for example:

> `data-sn-for` takes `item in list` or `(item, i) in list`

An attribute value has the wrong form: a JavaScript syntax error (the column points inside the attribute), or a value outside what the attribute accepts, such as `paginate` or `data-sn-concurrency`.

**Fix:** Fix the value as the message says. Handlers are statements separated by `;`; value bindings are a single expression.

## SN501 unused-resource

Warning, for example:

> resource `addressbooks` is declared but never read

The page fetches a resource that nothing on it uses, which costs a request on every load.

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

**Fix:** Add `type="Contact[]"` with a type from `src/sinter.types.ts`, configure an OpenAPI spec that matches `src`, or write `type="any"` to opt out.

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
