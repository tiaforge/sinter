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

> `window` is a browser API; expressions may use JavaScript, not the browser. Use a component's script

Expressions may use JavaScript built-ins but not browser APIs such as `window`, `document`, `fetch` or timers, so pages stay safe under a strict CSP and testable.

**Fix:** Move the browser code into a helper (for a pure function) or a component's script (`src/components/<name>.ts`, which owns imperative work).

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

The binding could run script or inject markup from data: event-handler attributes, `style`, `srcdoc`, `innerHTML`, bindings on `<script>`, `<link>`, `<base>` and similar elements, any binding on a `<meta>` but `data-sn-attr="{ content: … }"` on one with a literal `name`, `property` or `itemprop` (never `http-equiv` or `charset`), URL templates that do not start with a literal path (or with a literal origin that lacks its `/` before a value), persisted password fields, or `constructor`, `__proto__` and `prototype` named in an expression.

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

## SN210 url-list-mismatch

Error, for example:

> `$url.tag` is a list elsewhere on the page (a `<select multiple>` or a checkbox with a `value`), and one value here; bind it as a list everywhere

A `$url` parameter is a list (an array parameter, written as repeated keys: `?tag=a&tag=b`) when a `<select multiple>` or a checkbox with a `value` attribute binds it; the build decides this, so every place must agree. A parameter no such control binds is one value, and a list written to it would be lost on reload.

**Fix:** Bind the parameter the same way everywhere (two parameters if you need both), or write one value to it; a single value written to an array parameter is wrapped in a list for you.

## SN211 url-list-condition

Error, for example:

> `$url.tag` is a list and always truthy; use `$url.tag.length`

An array parameter always reads as a list, `[]` when the URL has none, and an empty list is truthy in JavaScript: a condition on the bare parameter always holds.

**Fix:** Test its length: `data-sn-if="$url.tag.length"`, or `$url.tag.includes('go')` for one value.

## SN212 url-object-value

Error, for example:

> `$url.filter` holds a string (or a list of strings); an object cannot be written to it. Write the field you mean, such as `$url.filter = x.id`

The URL holds strings: an object, a function or an instance (`{…}`, `() => …`, `new Date()`) written to a `$url` parameter has no form a reload could read back. At run time such a value removes the parameter, with a dev warning.

**Fix:** Write the string or number you mean (`$url.from = d.toISOString().slice(0, 10)`), or keep the object in state.

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

`$meta.<resource>` has a fixed set of fields: `loading`, `error`, `loadedAt`, `pending`, `total`, `live`, and with `paginate` also `pages`, `from`, `to`, `hasPrev`, `hasNext`; `page` with `paginate="offset"`, or keyset with `offset-param`.

**Fix:** Use the suggested field. A pagination field needs `paginate` on the resource.

## SN304 keyset-jump

Error, for example:

> keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`

Keyset (cursor) pagination only knows the next and previous page, so `page('name', 7)` has nothing to jump to, unless the server can also skip items by offset. A computed target (`page('name', dir)`) is not this error: `sinter check` types it as a direction, and at run time a page number is refused without a request. `append` pagination takes only the literal `'next'`.

**Fix:** If the API accepts an offset next to its cursor, add `offset-param="offset"`: the jump is sent as an offset and `prev`/`next` continue by cursor. Otherwise use `paginate="offset"`, or only step with `first`, `prev`, `next` and `last`.

## SN306 component-cycle

Error, for example:

> `<comment-card>` → `<reply-list>` → `<comment-card>` uses itself with no `data-sn-for` or `data-sn-if` template between, so it would never end

A component uses itself, directly or through other components, and nothing in between depends on data: expanding it would never end.

**Fix:** Put the inner use in a `<template data-sn-for>` over the children (or a `<template data-sn-if>`), so data ends the recursion.

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

## SN312 invalid-component

Error, for example:

> a component has one root element; `<article-preview>` has 2 elements at the top of its template

A file in `src/components/` is not a valid component: it needs one `<template data-sn-component="{ …props }">` (and optionally a `<style>`) with exactly one root element in it, and the root cannot be a `<template>`, a `<slot>` or another component. A head component is declared with `<template data-sn-head>` instead, and holds any number of head elements. Also reported: two slots with the same name, a template with both declarations, a head component with a script, and `<sn-component use>` naming a head component.

**Fix:** Wrap the markup in one element inside `<template data-sn-component>`: the caller's classes, attributes and handlers land on it. For head elements (`<title>`, `<meta>`, …), declare the component with `<template data-sn-head>`.

## SN313 unknown-prop

Error, for example:

> `artcle` is not a prop of `<article-preview>`; its props are `article`, `compact`. Did you mean `article`?

`data-sn-prop` on a component passes a name its `data-sn-component` does not declare, or leaves out a prop that is not optional. Also reported: `data-sn-model` on a component without a `value` prop and a `change` event.

**Fix:** Fix the name, pass the missing prop, or declare it in the component (`{ article: Article; compact?: boolean }`).

## SN314 unknown-slot

Error, for example:

> `<article-preview>` has no slot `meta`. Its slots are `footer`.

Content on a component's tag goes into its `<slot>` elements: a `slot="name"` names a `<slot name>`, the rest goes into the default `<slot>`. Content no slot takes would be dropped.

**Fix:** Fix the slot name, or add the `<slot>` to the component.

## SN315 unknown-component-event

Error, for example:

> `<task-ring>` does not declare the event `pik`; `data-sn-emits` declares `pick`. Did you mean `pick`?

A component's events are the ones its `data-sn-emits` declares: `emit()` inside it, and `data-sn-on-<event>` on its tag, must name one of them (or, on the tag, a DOM event such as `click`).

**Fix:** Fix the name, or declare the event with its detail type: `data-sn-emits="{ pick: 'done' | 'open' }"`.

## SN316 include-removed

Error, for example:

> `<sn-include>` is removed: a partial is a component. Move `./partials/contact-dialog.html` to `src/components/contact-dialog.html`, … It reads `draft`, `save` from the page: add them to `data-sn-component` and pass them with `data-sn-prop="{ draft: draft, save: save }"`

Partials became components. A component sees only its props, so the names a partial read from the page where it was included become props; the message lists them.

**Fix:** Move the file to `src/components/<name>.html` (the name needs a `-`), wrap its markup in `<template data-sn-component="{ draft: Contact; … }">` around one root element, and replace the `<sn-include>` by `<name data-sn-prop="{ draft: draft }"></name>`.

## SN317 no-item-source

Error, for example:

> `selected` has no source: `patch()` acts on an item where it came from, and nothing says which resource `selected` is an item of

`patch(item, …)` and `remove(item)` change the item in the resource it came from, found by its key: a row of a `data-sn-for` over a resource (also a filtered one, or one a helper returns), an element of one (`contacts[0]`, `.find(…)`), a single resource, a component prop that is one of those, or state a handler assigned from one (`sel = m`). The item here is none of these. Also reported: the removed forms with a resource name, `patch('name', item, …)` and `remove('name', item)`, and a row of a helper that takes more than one resource.

**Fix:** Drop the resource name from the old forms. Otherwise pass the row itself; for `$result`, rely on write-through (with a spec) or patch the row with its fields; a server event's payload goes through `<sn-event resource op>`; an island changes the resource through the instance API.

## SN318 invalid-layout

Error, for example:

> `src/layouts/site-layout.html` is not a layout: a layout is a whole document whose `<html>` declares its props, `<html data-sn-layout="{ …props }">`

A file in `src/layouts/` is a layout: a whole document (`<html>`, `<head>`, `<body>`) whose `<html>` carries `data-sn-layout` with its props type. Also reported: `data-sn-layout` anywhere else, a default slot in the layout's head (the default slot is the page's body), `data-sn-emits` on a layout, a layout with a script beside it, a layout and a component with the same name, and a layout built as a page.

**Fix:** Write the layout as a document: `<!doctype html><html lang="en" data-sn-layout="{ title?: string }"><head>…<slot name="head"></slot></head><body>…<slot></slot></body></html>`. Name head slots; leave `src/layouts/` out of the build's inputs (a glob over every `.html` picks it up).

## SN319 layout-use

Error, for example:

> a page that uses the layout `<site-layout>` is only its tag: `<p>` belongs inside it

A page that uses a layout is the layout's tag at its top level and nothing else (a doctype and comments are allowed): its content goes into the layout's slots, the attributes of `<html>` on the tag. A layout's tag anywhere else (inside a component, another layout, or other markup) is reported too, and so is `data-sn-early` on it.

**Fix:** Move the content inside the tag, with `slot="…"` for a named slot; write `lang`, `data-sn-path` and the like on the tag.

## SN320 head-content

Error, for example:

> `<div>` cannot be in the `<head>`: the browser would move it, and everything after it, into the body

After components are expanded, a head holds only head elements: `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>` and `<template>`. `<sn-resource>` and `<sn-sync>` go in the body: they are page-wide wherever they are written, and their requests start in the head anyway. The browser ends the head at anything else and moves it, with every element after it, into the body. sinter parses heads so that a component's tag stays where it is written: the element it expands to must be head content.

**Fix:** Move the element into the body. In a head, use head components (`<template data-sn-head>`).

## SN321 duplicate-head

Error, for example:

> a second `<title>` in the head: the page would have two

After a layout, its slots and its head components are merged, the head has two of an element a page has once: `<title>`, `<base>`, `<meta charset>`, `<link rel="canonical">`, and the `<meta>` with `name` `viewport`, `description` or `robots`, or `property` `og:title`, `og:description`, `og:url`, `og:type`, `twitter:card`, `twitter:title` or `twitter:description`. Elements inside `data-sn-if`, `data-sn-else` and `data-sn-for` templates count: two in the branches of one `data-sn-if` / `data-sn-else` are one, one at the top level and one in a branch are two, and one in a `data-sn-for` template is one per row.

**Fix:** Keep one: pass the value to the one that is there (a prop of the layout or head component), or replace a slot's fallback with the page's own element.

## SN322 ships-javascript

Error, for example:

> about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-on-click` runs in the browser

The page is in `sinter({ static })`, the pages that must ship no JavaScript, but something on it runs in the browser: a binding over state a handler writes, data, `$url`, `$now` or a helper, a handler, an action, a resource or stream, a model, or a component with a script. The error is where that was written, in the page, a component or the layout, once for each.

**Fix:** Remove what runs in the browser, or make it a constant (a literal, a prop given as one, state nothing writes). If the page is meant to run it, take the page out of `static` in vite.config.

## SN323 needs-site

Error, for example:

> `$canonical` is the page's absolute URL, and the build does not know the site's origin: set `sinter({ site: 'https://…' })` in vite.config

`$site` (the site's root URL) and `$canonical` (the page's URL) are absolute: they need the origin the site is served at, which only the configuration knows. Also: a `<link rel="canonical">` the page writes itself must name an absolute URL, since `$canonical` is that URL.

**Fix:** Set `sinter({ site: 'https://example.com' })` in vite.config (an origin, no path: a site under a path sets Vite's `base`). For a canonical link of your own, write it absolute, e.g. `$site + '/en/about/'` is what the build would write.

## SN324 lazy-package-use

Error, for example:

> `openpgp.encrypt(…)` is not awaited: `sinter({ lazy })` loads openpgp on first call, so every call returns a Promise

The package is in `sinter({ lazy })`, so the app's imports of it are stubs that load it on first call: each call returns a Promise, and nothing else of the package is there before it has loaded. So a value imported from it may only be called, and each call must be waited for (`await`, `return`, `.then`, `void`, or `Promise.all`). Refused: a call nothing waits for, `new`, `instanceof`, reading a constant or setting (`openpgp.enums`, `openpgp.config`), passing a function or the namespace as a value, `import 'pkg'` for its side effects, and re-exporting it. Also: the helpers module reaches a lazy package through its imports (helpers run while a binding renders and cannot wait); and in markup, `data-sn-import` or `data-sn-preload` names a package that is not in `lazy`.

**Fix:** Await the call. For classes and constants, load the package where they are needed with `await import('pkg')`, or move that code into a component script, which loads with the package. Compute what a helper needed in an action or a `<sn-resource call>`. In markup, name a package of `lazy`, or add it there.

## SN325 lazy-package-bundled

Error, for example:

> the page bundle of mail.html contains openpgp, which `sinter({ lazy })` loads lazily: mail.html → src/lib/autocrypt.ts → some-lib → openpgp

A page's bundle (its own chunk and the chunks it imports, or its early file) contains a lazy package after all, so the page downloads it with itself: another package imports it (the app's imports of it are stubs, a package's are not), or the early module reaches it. Also: an app module that some module of the page loads with `import()` is imported statically by the page too, so the split does nothing for that page.

**Fix:** Add the other package to `lazy` as well, or load it with `import()`. For the app's own split, import the module only with `import()` where the page reaches it, or not lazily at all.

## SN326 unknown-operation

Error, for example:

> `GET /contacs` is no operation of the API `main`. Did you mean `/contacts`?

With `sinter({ apis })`, a path in `src`, an action or `<sn-sync src>` is relative to an API, and the API accepts only the operations its spec or its `operations` declare, with the method the place implies (`GET` for a resource unless it has `method`, the attribute's for an action). Also reported: `api:` naming no API, and a path without `api:` when several APIs are configured and `defaultApi` names none.

**Fix:** Use the suggested path (the editor completes them), add the endpoint to the spec, or declare it in the API's `operations`. A path written with the base in it (`/api/contacts` with `base: '/api'`) drops the base.

## SN327 undeclared-query

Error, for example:

> `GET /articles` of the API `main` declares no query parameter `tagg`. Did you mean `tag`?

A query parameter in a path to a configured API must be one its operation declares (in the spec, or in `query` of the API's `defaults` or `operations`), and every required one must be given. The parameters `paginate` adds count as given, and are checked too.

**Fix:** Use the suggested name, give the required parameter, or declare it: in the spec, or with `query: ['name']` in the API's `defaults` for the operation.

## SN328 absolute-url

Error, for example:

> `https://api.example.com/v1/contacts` names its API's origin: write `/contacts`

With `sinter({ apis })`, a page writes paths relative to an API, and the origin is the API's `base`. An absolute URL would bypass the API's checks and settings.

**Fix:** Write the path relative to the API that has this base (the quick fix does), with `api:` when it is not the default API; for an origin that is no API, add one to `apis`.

## SN329 api-config

Error, for example:

> sinter({ apis }): `main.base` is `undefined` (an environment variable that is not set?); it does not fall back to the spec's server

The `apis` option is invalid: an API setting that does not exist, a `base` that is not `''`, a same-origin path or an `https://` URL (or is `undefined`), `defaults` naming an operation the spec does not have, `operations` naming one it has, `defaultApi` naming no API, or a top-level `openapi` next to `apis`.

**Fix:** Follow the message: set the environment variable, move the endpoint between `defaults` and `operations`, or move `openapi` into an API.

## SN330 configured-shape

Error, for example:

> `items` of `GET /articles` is `articles` (`main.defaults`), not `posts`: every page reads one shape from an endpoint

What an endpoint returns (`items`, `total`, `key`, `type`) is said once: when the API's `defaults` or `operations` give a value, a resource of that operation does not write a different one, because two pages would read different shapes from one endpoint. The same value is the warning `SN518`.

**Fix:** Remove the attribute, or change the configured value if the page is right.

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

**Fix:** Start the value with a literal string (`'contact-' + c.id` or `` `contact-${c.id}` ``) or use a `data-*` attribute instead.

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

## SN510 redundant-write

Warning, for example:

> `patch('articles', …, $result.article)` is what write-through does: the response of `POST /articles/{slug}/favorite` is `Article`, which `articles` holds; remove this write, or add `data-sn-apply="off"` to keep it

A `then` handler writes to the store what write-through writes by itself after the response: an object of a resource's schema is patched into the item with its key (and into what the URL named), a POST to a list's URL inserts the created item, a DELETE of a row's URL removes the row. The handler's write lands on top and changes nothing.

**Fix:** Remove the write from the handler (keep its other statements). To keep the explicit write, turn write-through off for that element with `data-sn-apply="off"`.

## SN511 image-too-small

Warning, for example:

> `hero.jpg` is 600 px wide; the 400 px box needs 800 px to be sharp on 2x screens

An `<img>` with `width`/`height` smaller than its source is a box of that size, and gets files for 1x and 2x screens (phones, tablets and most laptops are 2x or more). The source has fewer pixels than the 2x file needs, so it is used as the largest file and looks soft on those screens. With a crop (`object-fit: cover`), the width counts after cropping.

**Fix:** Use a larger source, at least the width the message names. A smaller box works too.

## SN512 image-stretched

Warning, for example:

> `width="200" height="200"` has another ratio than `photo.jpg` (1600 × 1067), so the image is stretched

The `width` and `height` of an `<img>` have another ratio than its file, and it has no inline `object-fit`, so the browser stretches the image to fill the box.

**Fix:** To crop to the box, add `style="object-fit: cover"` (and `object-position` for the part to keep): the build makes the cropped file and removes the style. To show the whole image, fix `width`/`height` to the file's ratio, or set only one of them.

## SN513 bound-local-image

Warning, for example:

> `src` is bound to local images (`./logo-dark.png`, `./logo.png`), which are not optimized

An `<img>` binds `src` to a local image path, or chooses between a few of them. The build optimizes static `<img src>` (formats, widths, dimensions) but cannot follow a path computed at runtime, so the bound image is served as the original file.

**Fix:** Write each image as a static `<img>` and choose with `data-sn-if` or `data-sn-show`: `<img src="./logo-dark.png" alt="" data-sn-show="dark"><img src="./logo.png" alt="" data-sn-show="!dark">`. Images from the API are a different case: see `images.remote`.

## SN514 auto-fit-rows

Warning, for example:

> this image is in a `repeat(auto-fit, …)` grid whose items are the rows of a `data-sn-for`: its columns stretch when there are fewer items than fit in a row, and how many rows there are is known only at runtime, so its size is not; it gets an upper bound instead

With `auto-fit`, a grid's empty columns collapse: a list shorter than a row stretches its items. The rows of a `data-sn-for` exist only at runtime, so the build cannot tell how wide each item is, and the image gets `sizes` from an upper bound (its container), which may fetch larger files than needed. With `auto-fill` the columns stay the same whatever the number of items, and the build writes exact `sizes`.

**Fix:** Use `repeat(auto-fill, minmax(…, 1fr))` unless short lists should stretch. Otherwise write `sizes` on the image, which silences this.

## SN515 redundant-path

Warning, for example:

> `data-sn-path="/contact/"` is the URL this page has anyway, as a directory's index

A page without `data-sn-path` is written as a directory's index (`contact.html` as `contact/index.html`, served at `/contact/`), so a `data-sn-path` that names only that URL says nothing. The page is built as if it had none.

**Fix:** Remove `data-sn-path`. It lists the paths a page answers at instead: patterns such as `/article/:slug`, or a fixed path such as `/login`, each served by a rewrite to the page's file.

## SN516 unfed-live

Warning, for example:

> `$meta.contacts.live` is always `null`: no `<sn-event resource="contacts">` on this page feeds `contacts`

`$meta.<resource>.live` is the state of the server-event stream that feeds the resource. A resource is fed when an `<sn-event>` in a `<sn-sync>` names it in `resource`; without one, `live` is `null` and a badge built on it never shows a state.

**Fix:** Add an `<sn-event resource="…">` for the resource to the `<sn-sync>`, or read `live` of a resource that a stream feeds.

## SN517 unkeyed-list

Warning, for example:

> `GET /api/contacts` returns a list at `contacts`: resource `contacts` has no `key`, so it is one object holding the list

Without `key` a resource is a single object. A list of objects loads and renders that way, but nothing can change one item: an `upsert` replaces the whole list, `patch` merges fields into the list and `remove` sets it to `null`. Reported when the OpenAPI response at `items` is a list of objects.

**Fix:** Add `key` with the field that identifies an item, such as `key="id"`. A list that is only read can stay as it is.

## SN518 redundant-shape

Warning, for example:

> `items` of `GET /articles` is configured as `articles` (`main.defaults`): remove it here

The API's `defaults` or `operations` already give this value for the endpoint, so the attribute says nothing. A different value is the error `SN330`.

**Fix:** Remove the attribute.
