# sinter v0.1 spec
Source: https://claude.ai/artifact/KUVBabhMHDm52FpMuPFvA9 (snapshot 2026-11-04, rev 78)

## Overview
sinter binds JSON APIs to plain HTML: it caches server data in keyed resources, keeps them current from server events, renders them through `<template>` bindings, and runs mutations with optimistic updates. It is compile-first: a build step turns annotated HTML into a page module, so the browser runs no parser and no `eval`.
Package: `@tiaforge/sinter`. Attribute prefix: `data-sn-`. Declaration elements: `<sn-resource>`, `<sn-sync>`, `<sn-event>`, `<sn-include>`.
License: MIT. Contributions are accepted under the Developer Certificate of Origin (`Signed-off-by` in each commit); no CLA.

### Goals
- Replace the server-state plumbing of a multi-page app: loading flags, stale responses, refetch on reconnect, list upserts from SSE.
- Valid HTML, readable without knowing the library, and easy for an LLM to write correctly.
- Small runtime: under 11 KB min+gzip for the core (10.1 KB on 2026-11-05), verified per release by `npm run size`.
- CSP-safe under `script-src 'self'` with no `unsafe-eval`.
- Optimistic updates that stay correct when requests overlap or SSE events arrive mid-flight.

### Non-goals
- Routing, a component system, a virtual DOM, transitions.
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
| `@tiaforge/sinter` | `mount`, store, renderer, actions, request layer, instance API |
| `@tiaforge/sinter/sse` | `<sn-sync>` with the SSE transport (and any configured one) |
| `@tiaforge/sinter/ws` | WebSocket transport (opt-in from the config module) |
| `@tiaforge/sinter/optimistic` | optimistic layers |
| `@tiaforge/sinter/paginate` | keyset, offset, append |
| `@tiaforge/sinter/persist` | `data-sn-persist` |
| `@tiaforge/sinter/compiler` | `compile()` |
| `@tiaforge/sinter/vite` | Vite plugin |
| `@tiaforge/sinter/testing` | `render`, `mockRequests`, `mockStream` |

The compiler imports only the feature modules a page uses; the core never imports them.

## Compiler contract and intermediate format
The compiler is one pure, deterministic function; every build tool integration is a thin adapter around it.
```ts
compile(html: string, options: CompileOptions): {
  html: string;            // rewritten page
  module: string;          // generated page module (ESM)
  diagnostics: Diagnostic[];
  files: string[];         // partials read, for watch mode
}

interface CompileOptions {
  file: string;            // for diagnostics, stable ids and relative includes
  root: string;            // project root; includes may not leave it
  readFile: (path: string) => string;  // supplied by the adapter, used for <sn-include>
  helpers: HelperManifest; // helper functions and namespace members, read from the helpers module by the adapter
  dev: boolean;            // dev runtime + source positions in the IR
}
```
Same input and options always give byte-identical output. Ids are assigned in document order.

### HTML rewrite
- `<sn-include>` elements are replaced by their partial's content first, before any other step (see Partials).
- All `data-sn-*` attributes are removed from the output.
- An element outside a `<template>` that carries directives gets `data-sn="<n>"`, a short id the runtime looks up once at mount.
- Inside a `<template>`, bindings are addressed by node path (child indexes from the template root), since template content is inert and only cloned.
- `<sn-resource>`, `<sn-sync>` and `<sn-event>` are removed; their definitions move into the IR.
- Embedded data (`<script type="application/json" data-sn-data="contacts">`) stays in the HTML, since it may be produced at request time.
- One `<script type="module">` is injected that imports the page module.

### Partials
`<sn-include src="./partials/contact-dialog.html"></sn-include>` inlines another HTML file at build time. It adds nothing to the runtime.
- `src` is relative to the including file, must be a literal path, and must resolve inside the project root (`root` in `CompileOptions`); anything else is `SN305`.
- Partials may include partials; a cycle is error `SN306`, a missing file `SN305`.
- Scope is lexical: the partial sees the state, loop variables and resources at its insertion point, and is checked per page. Wrapping it in `data-sn-state` passes values in without a component system: `<div data-sn-state="{ c: selected }"><sn-include src="./partials/contact-card.html"></sn-include></div>`.
- Diagnostics point to the line in the partial, followed by the include chain.
- Partials are plain HTML with no parameters, props or slots; components remain a non-goal.

### Page module
```js
import { mount } from '@tiaforge/sinter';
import sse from '@tiaforge/sinter/sse';          // only features this page uses
import optimistic from '@tiaforge/sinter/optimistic';
import { date } from '/src/sinter.helpers.js';               // only the helpers this page uses
import { inbox_title } from '/src/paraglide/messages.js';     // namespace members, imported by name

const ir = { v: 1, resources: [...], syncs: [...], roots: [...], templates: [...], actions: [...] };
const fns = [
  (s) => s.c.fn_name,
  (s) => date(s.c.birthday, 'short'),
  // one function per expression, identifiers already resolved
];

mount(document, { ir, fns, features: [sse, optimistic] });
```

### Intermediate format (IR v1)
The IR is the only contract between compiler and runtime. It is plain JSON plus a function table, carries `v: 1`, and the runtime refuses a version it does not know.

| Part | Holds |
| --- | --- |
| `resources` | name, URL template, key fields, items/total paths, order, pagination config |
| `syncs` | stream URL, event → change-message mappings |
| `roots` | per `data-sn` id: its bindings and the scope it opens |
| `templates` | per template: node paths, bindings, key expression |
| `actions` | method, URL template, body source, trigger, debounce, concurrency, optimistic, then, catch |
| `bindings` | kind (`text`, `attr`, `class`, `style`, `show`, `model`, `prop`, `for`, `if`, `else`, `on`), target, function index, static dependency paths |

Dependencies are extracted at compile time: every binding lists the state and resource paths it reads (`q`, `contacts`, `c`). The runtime matches them against dirty paths (see Reactivity), so it needs no proxies and no read tracking.

### Adapters
- Vite (v0.1): `@tiaforge/sinter/vite` hooks `transformIndexHtml` for every HTML entry and serves the page module as a virtual module. Dev and build use the same path. Partials returned in `files` are watched. Diagnostics go to the terminal and Vite's error overlay. An HTML or partial change triggers a full reload in v0.1.
- Later: esbuild or a CLI wrap the same `compile()`; nothing in the core changes.

## Expressions and scope
Every attribute value that is not a URL or a name is a JavaScript expression, parsed by a real JS parser at build time and checked against a closed set of identifiers.

### Two kinds of expression

| Kind | Used in | Allowed | Refused |
| --- | --- | --- | --- |
| Value | `text`, `attr`, `class`, `show`, `prop`, `for` (after `in`), `if`, `key`, `body`, `state`, resource `when` and `cursor`, `<sn-event>` `item`, `set` and `when`, URL interpolations | any JS expression, `new` on allowed globals, arrow functions as arguments, template strings, `?.`, `??` | assignment, `++`/`--`, `delete`, `await`, `import()` |
| Handler | `on-*`, `then`, `catch`, `optimistic` | statements separated by `;`, assignment to state variables, calls to store and action functions | declarations (`let`, `const`, `function`), loops, `await` |

Value expressions must be side-effect free, so the runtime may evaluate them any number of times.

### Identifier resolution
A free identifier resolves to the first match, innermost first:
- Loop variables of enclosing `data-sn-for` (and their index, e.g. `(c, i) in contacts`).
- State variables declared by the nearest enclosing `data-sn-state`.
- Resource names declared on the page.
- Magic names: `$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`.
- Registered helpers, helper namespaces and the store/action functions (`refresh`, `upsert`, `patch`, `remove`, `page`, `close`, `reset`, `emit`).
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
| `date(v, style)`, `time(v, style)`, `datetime(v, style)` | `Intl.DateTimeFormat` with the current locale |
| `relative(v)` | `Intl.RelativeTimeFormat`, e.g. "3 days ago" |
| `number(v, opts)`, `bytes(v)` | `Intl.NumberFormat`, file sizes |

User helpers live in one module (`sinter.helpers.js`) whose export names the compiler reads. A helper must be pure.
Helper namespaces. The helpers module may re-export a whole ES module as a namespace, e.g. `export * as m from './paraglide/messages.js'`. Templates call its members like functions: `m.inbox_title()`, `m.items_count({count: n})`.
- The compiler resolves `m.<name>` statically. An unknown member is error `SN206` with a suggestion.
- The page module imports only the members it uses, so unused ones (e.g. messages) are tree-shaken.
- Members must be named literally; `m[key]` is refused. A dynamic choice goes in a helper.
This is how i18n works: sinter ships no message format and no `t()` of its own, and works with any ESM-based i18n library.
Locale. `configure({ locale: { get, set } })` connects the app's locale source. `$locale` reads it; assigning `$locale = 'de'` in a handler calls `set` and re-runs every locale-dependent binding: those that call a namespace member or a `date`/`number` helper.

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
Rows. A row re-evaluates only if its item object was replaced or its own path is dirty. Only the whole-root fallback checks every row.
Default keys. Without `data-sn-key`, a `for` over resource items keys by the resource's `key` fields, and a `for` over a state array of objects keys by object identity (an internal id per object via `WeakMap`), so `splice` never re-binds rows. Arrays of primitives need an explicit key.
Writes from outside handlers. Islands change state only through `app.state(el).update(s => { … })`, which invalidates the roots it touched. Dev builds snapshot each state root after every flush and warn when a root changed without invalidation ("state `draft` changed outside sinter: use `update()`").
Resources are read-only in expressions. Assigning to, or calling a mutator on, a value rooted in a resource is error `SN205`, including loop variables over resources; the message shows the `patch()` equivalent. To edit resource data, copy it with `structuredClone(c)`, which returns unfrozen plain data.
Why this is sound. Value expressions cannot mutate and handlers cannot declare variables, so state cannot escape into a reference the compiler does not see.

## Attribute and element reference
The whole vocabulary is the tables below; any other `data-sn-*` name is a build error with a suggestion. All names are lowercase kebab-case, because HTML lowercases attribute names.

### Rendering

| Attribute | Value | Notes |
| --- | --- | --- |
| `data-sn-state` | object literal | declares state for the subtree |
| `data-sn-text` | value expression | sets `textContent`; never HTML |
| `data-sn-attr` | object literal `{href: …, title: …}` | literal keys; `null`/`false` removes, `true` sets empty; URL values are checked (see Security) |
| `data-sn-class` | object literal `{unread: !m.is_read}` | toggles each class |
| `data-sn-style` | object literal `{'--color': cal.color, width: pct + '%'}` | sets each property with `style.setProperty` |
| `data-sn-show` | value expression | toggles the `hidden` attribute |
| `data-sn-prop` | object literal | sets JS properties; custom elements only |
| `data-sn-model` | state path | two-way binding for form controls (see below) |
| `data-sn-for` | `item in list` or `(item, i) in list` | on `<template>` only |
| `data-sn-key` | value expression | optional; defaults to the resource key or object identity, required for arrays of primitives |
| `data-sn-if` | value expression | on `<template>` only |
| `data-sn-else` | none | on a `<template>` directly after an `if` template |
| `data-sn-path` | URL patterns, space-separated | on `<html>` only; the path shapes the page is served for, e.g. `/editor /editor/:slug`; `:name` segments of the first matching pattern appear read-only in `$url` (added 2026-11-04) |
| `data-sn-persist` | storage key | persists the element's model or state in localStorage under `sn:`; refused on password and payment fields; storage failures are ignored |


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

### Actions and events

| Attribute | Value | Notes |
| --- | --- | --- |
| `data-sn-get`, `-post`, `-put`, `-patch`, `-delete` | URL template | one per element |
| `data-sn-body` | value expression | JSON body; overrides form serialization |
| `data-sn-trigger` | DOM event name | overrides the default trigger |
| `data-sn-debounce` | milliseconds | delays the trigger, resets on each event |
| `data-sn-concurrency` | `block`, `queue` or `latest` | mutations only; default `block` for forms, `queue` otherwise |
| `data-sn-optimistic` | handler expression | store changes applied before the request |
| `data-sn-then` | handler expression | runs after a 2xx response, `$result` = parsed body |
| `data-sn-catch` | handler expression | runs after an error, `$error` = error object |
| `data-sn-on-<event>` | handler expression | plain event handler, no request; e.g. `data-sn-on-click` |


### Declaration elements

| Element | Attributes | Notes |
| --- | --- | --- |
| `<sn-resource>` | `name`, `src`, `key`, `items`, `total`, `order`, `when`, pagination attributes | see Resources and Pagination |
| `<sn-sync>` | `src` | one server event stream |
| `<sn-event>` (child of `<sn-sync>`) | `name`, `resource`, `op`, `item`, `set`, `when`, `fallback` | maps one server event to a change message |
| `<sn-include>` | `src` | inlines a partial at build time; see Partials |

Custom elements with a hyphen are valid HTML, so these pass a validator before compilation.

### URL templates
URLs are literal strings with `{expression}` interpolations. Each interpolated value is passed through `encodeURIComponent`.
```html
<button data-sn-delete="/api/contact?account_id={c.account_id}&uid={c.uid}">Delete</button>
```
A query parameter whose whole value is one interpolation that evaluates to `null` or `undefined` is left out, with its separator: `/api/articles?tag={$url.tag}&limit=10` requests `/api/articles?limit=10` when there is no tag. An empty string is still sent (`tag=`). (Added 2026-11-04.)

A resource whose `src` interpolates state or `$url` refetches when those values change.

### Magic names

| Name | Available in | Value |
| --- | --- | --- |
| `$event` | `on-*`, `then`, `catch` | the DOM event |
| `$el` | everywhere | the current element |
| `$url` | everywhere | reactive view of `location.search` params plus the path parameters of `data-sn-path`; assigning to `$url.x` calls `history.replaceState` (path parameters are read-only, `SN203`) |
| `$now` | everywhere | current time as a `Date`, refreshed every 60 s; the timer runs only on pages that use it |
| `$locale` | everywhere | current locale from `configure({ locale })`; assignable in handlers |
| `$result` | `then` | parsed response body |
| `$error` | `catch` | `{status, body, message}` |
| `$meta` | everywhere | per resource status fields (see Resources and store) |


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
| `src` | yes | URL template; refetch when its interpolated values change |
| `key` | for collections | comma-separated item fields forming the identity; absent = single object |
| `items` | no | path to the array in the response; default: the response itself |
| `total` | no | path to a total count, exposed as `$meta.<name>.total` |
| `order` | no | field kept sorted on upserts, `-field` for descending; locale-aware for strings |
| `when` | no | value expression; while falsy, the resource is empty (null or []) and a running request is aborted |


### Behaviour
- Shared requests. Resources with the same resolved `src` share one in-flight request (e.g. one endpoint that returns two lists).
- Latest wins. When `src` changes, the in-flight request is aborted; a late response for an old URL is discarded.
- Status. `$meta.<name>` exposes `loading`, `error` and `loadedAt`. During a refetch the old data stays visible; `loading` is true.
- Identity. Keys are compared as joined strings. A duplicate key in a response is a dev-mode warning; the last one wins.
- Immutability. Items are frozen in dev builds. Changes always replace the item object.
Single-object resources (no `key`): `upsert` replaces the object, `patch` merges fields into it, `remove` sets it to `null`. Their change messages need no key.

### Status fields
Status lives under `$meta.<name>`, never on the data itself. The field set is fixed:

| Field | Type | Meaning |
| --- | --- | --- |
| `loading` | boolean | a request for this resource is in flight |
| `error` | `{status, body, message}` or `null` | the last load failed; cleared on success |
| `loadedAt` | number (ms) or `null` | time of the last successful load |
| `pending` | number | optimistic layers not yet settled |
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
- Embedded JSON: if the page contains `<script type="application/json" data-sn-data="contacts">`, that payload is the initial data and no first request is made. Who writes it (a server, a build step) is out of scope.
A cache source (stale-while-revalidate across page loads) can be added later through the same interface.

## Sync: change messages and transports
The store only understands one message shape; transports translate server events into it. Server-Sent Events are the default; a WebSocket transport ships as `@tiaforge/sinter/ws`, and others (SignalR) are a few lines in the app (see Transport interface).
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
Inside `<sn-event>` attributes, the event's parsed JSON payload is the scope: `item="contact"` reads `payload.contact`.

| Attribute | Meaning |
| --- | --- |
| `name` | event name (the SSE event name, or what the transport reports) |
| `resource` | target resource |
| `op` | `upsert`, `patch`, `remove` or `refetch` |
| `item` | value expression for `upsert`; default: the whole payload |
| `set` | object literal for `patch`, e.g. `{flags, is_read: flags.includes('\\Seen')}` |
| `when` | value expression; skip the event unless truthy, e.g. `mailbox === $url.mailbox` |
| `fallback` | `refetch` when `item` evaluates to null (for servers that send some updates without a body) |

For `patch` and `remove`, the key is read from the payload using the resource's `key` fields. Events with no `<sn-event>` are still dispatched to islands (see JS API).

### Connection rules
- One connection per stream URL per page, however many elements use it.
- The session probe gates every reconnect. `EventSource` cannot see HTTP status, so after an error the adapter does not reconnect directly. It calls the configured `sessionProbe` through the request layer:
  - 2xx: reconnect the stream.
  - 401: the normal login redirect.
  - network error (status 0): wait out the backoff, then probe again.
- Backoff: 1 s, doubling to 30 s, with jitter; reset after a successful reconnect.
- Offline is not logged out. Only a 401 leads to login; an outage never does.
- Missed events. After a reconnect, every resource fed by that stream is refetched once, since events sent while disconnected are lost.
- Back/forward cache. The connection closes on `pagehide` and reopens on `pageshow`, so an open stream does not keep the page out of the cache. Reopening goes through the session probe like any reconnect, so a page restored after logout is redirected to login.
- Coalescing. Several `refetch` messages for one resource within one task cause one request.
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
import { configure } from '@tiaforge/sinter';
import { webSocketTransport } from '@tiaforge/sinter/ws';

configure({ transport: (url) => url.startsWith('/ws/') ? webSocketTransport() : undefined });   // undefined: EventSource
```
- **WebSocket** (`webSocketTransport({ protocols, decode })`): opens the URL as `ws:`/`wss:`. Each text message is JSON `{"event": "<name>", "data": <payload>}`; `decode(message)` returning `[name, payload]` or `null` reads other formats. Server to client only: actions stay on HTTP, so `then`/`catch`, optimistic layers and 401 handling are unchanged.
- **SignalR**: the `llms.txt` recipe; the adapter lives in the app, so sinter does not depend on `@microsoft/signalr`. Hub method names are the event names; the first argument is the payload. Do not enable SignalR's automatic reconnect.
- Auth on a WebSocket or hub is the transport's: browsers send cookies, but request middleware does not apply.

A SharedWorker or BroadcastChannel transport that shares one stream across tabs can implement the same interface later.

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

### After the response
`then` and `catch` are handler expressions. The built-in functions:

| Function | Effect |
| --- | --- |
| `refresh('contacts')` | refetch a resource |
| `upsert('contacts', $result)` | insert or replace an item |
| `patch('contacts', item, {…})` | change fields of an item |
| `remove('contacts', item)` | remove an item |
| `page('messages', 'next')` | change page (see Pagination) |
| `close()` | close the nearest `<dialog>` |
| `reset()` | reset the nearest `<form>` |
| `emit('name', detail)` | dispatch a `CustomEvent` from the element |

State assignments work too: `data-sn-then="editing = null; close()"`.

### Unhandled errors
When an action fails and has no `data-sn-catch`:
- An `sn-error` `CustomEvent` bubbles from the element, `detail = {error, element}`. A listener on a container (`data-sn-on-sn-error`) handles it by calling `$event.preventDefault()`.
- If no listener prevented it, `configure({ onError(error, element) })` runs, e.g. to show a toast.
- Dev builds log every unhandled error to the console.
Resource load failures set `$meta.<name>.error` and then take the same path, with `detail.resource` set and the mount root as element. A 401 never reaches this path; the login redirect handles it.

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
import { configure, credentials, header, onUnauthorized, loginRedirect } from '@tiaforge/sinter';

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
- Non-2xx responses reject with `$error = {status, body, message}`. Network errors give `status: 0`.
- Defaults: 30 s timeout; one automatic retry for idempotent requests on network errors only.
Response bodies. 204 or an empty body → `null`. A JSON content type → parsed; invalid JSON is an error with the response's status and the message `invalid JSON`. Any other content type → text. Error bodies are parsed the same way into `$error.body`.

## Optimistic updates
An action with `data-sn-optimistic` changes the store before the request is sent and undoes exactly that change if the request fails. It ships in v0.1 as the `optimistic` module.
```html
<button data-sn-patch="/api/email/message/flags"
        data-sn-body="{account_id: m.account_id, mailbox: m.mailbox, uid: m.uid, flags: ['\\Flagged'], set: !m.is_flagged}"
        data-sn-optimistic="patch('messages', m, {is_flagged: !m.is_flagged})"
        data-sn-catch="emit('toast', $error.message)"
        data-sn-attr="{'aria-pressed': m.is_flagged}">★</button>
```

### Model: base plus layers
Each resource holds a base (what the server last confirmed) and an ordered list of optimistic layers. What templates see is the base with every layer applied on top, in order.
- On trigger, the `optimistic` expression runs against a recorder. Its `patch`, `upsert` and `remove` calls become one layer, tagged with the action's request.
- The visible state is recomputed; affected rows re-render immediately.
- Success: the layer is dropped. If `then` writes the response (`upsert('contacts', $result)`), that write goes to the base in the same flush, so nothing flickers.
- Failure: the layer is dropped, which is the rollback; `catch` runs.
- Server events always write to the base. Layers are re-applied on top, so an SSE update arriving mid-flight is neither lost nor overwritten by a later rollback.
This is why rollback is "drop the layer", not "restore a snapshot": with two overlapping actions on the same item, a snapshot restore from the first failure would wipe out the second action's change.

### Rules
- `optimistic` may only call `patch`, `upsert` and `remove`. Anything else is a build error, because local state and side effects cannot be rolled back.
- A layer's `patch` on an item that the base no longer has is ignored; a `remove` of an absent item is a no-op.
- An optimistic `remove` on a paginated resource also decrements `$meta.<name>.total` inside the same layer.
- A layer lives until its request settles, including the 30 s timeout.
- Bulk actions put all their changes into one layer, so they roll back together.
- Pending layers are visible in dev tools through `$meta.<name>.pending` (count of layers).

### Typical cases

| Action | Optimistic change |
| --- | --- |
| Flag or mark read | `patch('messages', m, {is_flagged: …})` |
| Delete or move mail | `remove('messages', m)` |
| Bulk mark read | one layer with one `patch` per selected message |
| Delete contact | `remove('contacts', c)` |
| Toggle calendar visibility | `patch('calendars', cal, {hidden: !cal.hidden})` |


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
| `keyset` | `cursor` fields read from the boundary item + `direction` | `first`, `prev`, `next`, `last` | large or live lists where pages must not shift |
| `offset` | `page-param` (1-based) + `size-param` | the above + a page number | lists that need "go to page N" |
| `append` | like `keyset`, `next` only | `next` | "load more", infinite scroll |

Keyset mode never jumps: `page('messages', 7)` on a keyset resource is error `SN304`, with a hint to use offset mode. sinter does not simulate jumps by stepping through pages.

### Server requirements for keyset
- `direction` takes `first`, `prev`, `next` and `last`. `first` and `last` ignore the cursor.
- `prev` and `last` read the list in reverse on the server, but the response is always in display order.
- The cursor fields must form a unique, stable sort key (e.g. a timestamp plus a row id).

### Attributes

| Attribute | Meaning |
| --- | --- |
| `paginate` | `keyset`, `offset` or `append` |
| `page-size` | items per page; sent as `size-param` |
| `size-param` | name of the size query parameter, default `limit` |
| `cursor` | object literal evaluated on the boundary item: last item for `next`, first for `prev` |
| `direction-param` | name of the direction parameter; values `first`, `prev`, `next`, `last` |
| `page-param` | offset mode: name of the page parameter, default `page` |


### `$meta` fields
`page` (offset only), `pages` (when `total` is known), `total`, `from`, `to`, `hasPrev`, `hasNext`, `loading`.
For keyset, `hasNext` is true when the page came back full; `hasPrev` is false after `first` or when a `prev` page comes back short. `from` and `to` are `null` when they cannot be known (after `last` without a `total`). `from` and `to` are tracked by the runtime from page moves.

### Rules
- A change to `src` (e.g. another filter value) resets to the first page.
- `refetch` repeats the current page's exact request, so a refresh never jumps.
- `page()` during a pending page load aborts the pending one.
- After `last`, `hasNext` is false; after `first`, `hasPrev` is false.
- `append` mode keeps all loaded items; `refetch` reloads them as one request with `size = loaded count`.
- Server events on paginated resources follow the rule in Sync: unknown keys trigger a refetch of the current page.

## Rendering and scheduler
sinter updates the DOM fine-grained, without a virtual DOM: every binding knows its node, and only bindings whose inputs changed are re-evaluated and written.

### Mount
- One `querySelectorAll('[data-sn]')` builds the id → element table.
- Root bindings attach to their elements; `data-sn-state` scopes are created.
- Resources start loading (or read embedded data); syncs connect.
- One listener per used event type is added at the mount root.

### Template instances
- An instance is `template.content.cloneNode(true)` plus the nodes found by the IR's node paths, resolved once per clone.
- Each instance keeps its scope (loop item, index) and the last value written by each binding.
- A binding writes only when the new value differs from its last value.

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
- Reused nodes keep focus, selection, scroll position and half-typed input.

### Scheduler
- All changes in one task are collected; one microtask flush evaluates dirty bindings and writes.
- The core never reads layout (`offsetHeight`, `getBoundingClientRect`), so a flush cannot force reflow.
- Bindings inside a closed `<dialog>` are kept dirty and evaluated on its `toggle` to open.

### Events
- A delegated listener finds the nearest element with a handler or action for that event type.
- A row element maps to its instance through a `WeakMap`, which supplies the loop scope.
- `input` and `change` from `data-sn-model` elements update state before other handlers on the same event run.

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
| URL templates of resources, actions and streams | requests to an attacker-chosen origin, leaked headers | see Requests and origins |
| store merges, form serialization, `patch` fields, `$url` | prototype pollution | keys `__proto__`, `constructor` and `prototype` are dropped; objects built from input have a null prototype |
| `data-sn-persist` | secrets left in localStorage | refused (`SN207`) on `type="password"` and on fields with `autocomplete` `cc-*`, `one-time-code` or `current-password`/`new-password` |


### URL attributes
`href`, `src`, `action`, `formaction`, `poster`, `cite`, `data`, `ping` and `xlink:href` are checked, and every candidate in `srcset`.
- The value is parsed with `new URL(value, document.baseURI)`, the browser's own parser, so whitespace, control characters, tabs inside the scheme and mixed case cannot disguise it.
- Allowed: `http:`, `https:`, `mailto:`, `tel:`, and relative URLs. `data:` and `blob:` only in `src` of `<img>`, `<video>`, `<audio>` and `<source>`.
- A rejected value removes the attribute; dev builds warn with the element and the value.
- `configure({ urlSchemes: ['webcal:'] })` adds schemes. `javascript:`, `vbscript:` and `data:` outside media can never be added.

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
`data-sn-state`, `$url` and persisted values can be changed by the user in the browser, and `$url` by anyone who sends a link. The server validates every request on its own. Persisted keys are namespaced `sn:`, cleared by `loginRedirect`, and can be cleared with `clearPersisted()` on logout.

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
- `<sn-include>` resolves only inside the project root, symlinks included, so a build cannot inline files from outside the project.

## JS API for islands
Islands are custom elements that own imperative work (encryption, rich editors, canvas-like views); they get data through properties and talk back through DOM events, and may use the store directly.

### Data in, events out
```html
<template data-sn-if="selected">
  <mail-reader data-sn-prop="{message: selected, unlocked: vaultUnlocked}"
                data-sn-on-reader-flag="patch('messages', selected, {is_flagged: $event.detail})"></mail-reader>
</template>
```
- `data-sn-prop` assigns JS properties, so islands receive objects, not strings.
- An island dispatches `CustomEvent`s with lowercase kebab-case names (`reader-flag`); `data-sn-on-<name>` handles them.

### Instance API
```ts
import { instance } from '@tiaforge/sinter';

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
| `optimistic(change, run)` | apply `change` as a layer, settle it with the promise from `run` |
| `on(event, fn)` | subscribe to a server event by name; returns unsubscribe |
| `state(el)` | the state handle, with get() and update(fn), of the nearest `data-sn-state` scope |


### Rules
- Islands never write to sinter-managed nodes; sinter never touches an island's children.
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
| `SN202 forbidden-global` | error | `window` is a browser API; expressions may use JavaScript, not the browser. Use an island |
| `SN203 side-effect` | error | value expressions cannot assign; move this to `data-sn-on-*` |
| `SN204 optimistic-scope` | error | `data-sn-optimistic` may only call `patch`, `upsert`, `remove` |
| `SN205 resource-mutation` | error | `m.is_read = true` mutates a resource. Use `patch('messages', m, {is_read: true})` |
| `SN206 unknown-namespace-member` | error | `m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`? |
| `SN207 unsafe-sink` | error | `onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click` |
| `SN208 type-error` | error | Property 'nmae' does not exist on type 'Contact'. (TS2339) — `sinter check` only |
| `SN301 unknown-resource` | error | resource `mesages` is not declared on this page |
| `SN302 duplicate-resource` | error | resource `contacts` is declared twice |
| `SN303 unknown-meta-field` | error | `$meta.contacts.loadng` is not a status field. Did you mean `loading`? |
| `SN304 keyset-jump` | error | keyset pagination cannot jump to a page number. Use `paginate="offset"` |
| `SN305 include-not-found` | error | partial `./partials/contact-dialg.html` not found or outside the project root |
| `SN306 include-cycle` | error | `a.html` → `b.html` → `a.html` includes itself |
| `SN307 openapi-invalid` | error | OpenAPI spec `api.yml` is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`) |
| `SN308 unknown-schema-field` | error | the response of `GET /articles` has no `articls`. Did you mean `articles`? |
| `SN401 parse-error` | error | JS syntax error, with the column inside the attribute |
| `SN501 unused-resource` | warning | resource `addressbooks` is declared but never read |
| `SN502 non-reactive-value` | warning | `Date.now()` in a binding never updates. Use `$now` |
| `SN503 data-bound-id` | warning | `id` bound from data can shadow globals other scripts read (DOM clobbering) |
| `SN504 untyped-resource` | warning | resource `contacts` has no type: expressions using it are not checked — `sinter check` only |
| `SN505 unknown-query-param` | warning | `GET /articles` declares no query parameter `tagg`. Did you mean `tag`? |
| `SN506 untyped-event` | warning | event `contact_updated` has no type: expressions reading its payload are not checked — `sinter check` only |


### Type checking
`sinter check` type-checks every expression of the pages with the project's own TypeScript; it is opt-in and never runs in the dev server.
- A resource names the type of what `items` selects with `type`, a TypeScript type over the names the types module (`src/sinter.types.ts`, `.d.ts` or `.js`) exports: `<sn-resource name="contacts" … type="Contact[]">`. `type="any"` leaves a resource unchecked on purpose; a resource without `type` is warning `SN504`.
- State is typed by its literal. A value the literal cannot show takes a JSDoc cast: `{ editing: /** @type {Contact|null} */ (null) }`.
- Helpers and namespace members are typed by their own modules; `$event` and `$el` by the DOM types of the event and element; `$meta`, `$error` and the store functions by sinter.
- The check generates one JavaScript file per page under `.sinter/check/`, with every expression verbatim inside blocks that declare its scope, and runs `tsc` on them with `checkJs`. Errors map back to the HTML position (`SN208`).
- Null checks and implicit `any` are off: a binding that reads `null` renders nothing at runtime, and expressions in separate attributes cannot narrow each other.
- `sinter check` reads the pages and options from the Vite config, or takes pages as arguments. `sinter({ typecheck: true })` runs it at the end of `vite build` and fails the build on errors.
- OpenAPI: `sinter({ openapi: 'openapi.yml' })` (or a list, one per API; local JSON or YAML files, so builds stay deterministic). A resource without `type` is matched to a GET operation: the `servers` URL prefix is stripped from `src`, the query string dropped, literal segments match literally, a segment that is one interpolation matches a `{param}`, and a literal path beats a templated one. Its type is the first 2xx JSON response's schema at `items`, converted to TypeScript by sinter (named schemas become named types). The match runs in every build, not only in the check: an `items` or `total` the schema lacks is `SN308`, a literal query parameter the operation does not declare is warning `SN505`. No match leaves the resource untyped (`SN504`, naming the closest path).
- Actions are matched like resources, with their own method: `data-sn-body` must fit the JSON request schema, and `$result` in `then` has the response's type (`any` without a match).
- Server events: `type` on `<sn-event>` types the payload, using the types module's names. `item` must be assignable to the resource's item and `set` to a part of it, so a payload that does not fit the resource is an error. `cursor` reads the resource's own item. An event with payload expressions and no `type` is warning `SN506`; `type="any"` opts out.
- `checkPage(html, { files, types, openapi })` from `@tiaforge/sinter/check` runs the same check on one page in a temporary project, for tests.

### Dev runtime
The dev build adds checks that need real data: duplicate keys in a response, an item missing a key field, an `items` path that is not an array, a server event payload missing key fields. Warnings name the resource, the page and the offending value.

### LLM support
- `llms.txt` in the package: the full attribute reference, the scope rules and seven copy-paste recipes (list with filter, form dialog, SSE sync, optimistic toggle, pagination, SignalR transport, typed resources).
- A generated VS Code custom-data file (`html-custom-data.json`) so editors and agents get attribute completion.
- Every diagnostic links to its section in `docs/diagnostics.md`, which is generated from the compiler's table of codes (example, meaning, fix).

### Editor integration
- `sinter lsp` is a language server over stdio. It compiles open buffers on every change and publishes the compiler's diagnostics; a partial is compiled in the context of the pages that include it, and a page's diagnostics in its partials are reported on the partial.
- Pages are the HTML entries of the Vite config, plus any open HTML file no page includes. A change to the Vite config, the helpers or types module, or an OpenAPI spec reloads the project.
- Diagnostics underline the whole attribute or tag when they are about it (`span` on `Diagnostic`), else the name at their position.
- Type errors (`SN208`) as you type: with TypeScript 7, `sinter lsp` keeps each page's shadow file open in TypeScript's own language server (`tsc --lsp --stdio`, one per project, shadows under `.sinter/lsp/`) and pulls its errors 300 ms after the last change, mapped to the HTML with TypeScript's range. Before TypeScript 7 (no `--lsp`), it runs the `sinter check` pipeline on save.
- Hover on a name in an expression shows its TypeScript type (TypeScript 7 only).
- Planned (roadmap item 4): completion, go to definition and a did-you-mean quick fix; a VS Code extension that starts the project's own `sinter lsp`.

### Stability
- Attribute names, function names and diagnostic codes are part of the public API.
- Before 1.0, renames are allowed but listed in the changelog. After 1.0, a deprecated name keeps working with a warning for at least one minor version.
- IR versions are independent of package versions; the runtime reads every IR version of its major.

## Testing
Apps rely on sinter as a building block, so v0.1 ships a testing module that is public, stable API under the same rules as the runtime, and sinter itself is tested through it.

### `@tiaforge/sinter/testing`
```js
import { test, expect } from 'vitest';
import { render, mockRequests, mockStream } from '@tiaforge/sinter/testing';
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
| `render(html, options)` | compiles in memory with the real compiler, mounts into the test DOM, returns `{ root, app, flush, settle, advance, navigations }` |
| `flush()` | runs the scheduler until no binding is dirty; deterministic, no timeouts |
| `settle()` | `flush()` until every request, queue and debounce has finished |
| `advance(ms)` | moves sinter's clock: debounce, backoff, `$now` |
| `navigations` | URLs sinter tried to navigate to (login redirect), instead of navigating the test DOM |
| `mockRequests(routes)` | request middleware: `'METHOD /path'` → JSON, `{status, body}` or `(req) => response`; records `calls`; an unmatched request fails the test and lists the registered routes |
| `mockStream()` | stream transport: `emit(name, payload)`, `drop()`, `connected` |

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
- Every recipe in the docs and in `llms.txt` comes with its test, so copying a recipe means copying a test.
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
                data-sn-optimistic="remove('contacts', c)">Delete</button>
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
- Dialog markup used on several pages goes in a partial: `<sn-include src="./partials/contact-dialog.html"></sn-include>`.

## Open questions
- State reactivity depth. Decided: compile-time path invalidation, default identity keys, `update()` for islands, dev-mode detector, resources read-only (`SN205`), copies via `structuredClone`. See Expressions and scope.
- $meta naming. Decided: `$meta.<name>.<field>` with a fixed field set. See Resources and store.
- Mutation concurrency. Decided: `block` for forms, `queue` otherwise, `latest` on request via `data-sn-concurrency`; running mutations are never aborted. See Actions.
- Safe globals. Decided: "JavaScript yes, browser no", `new` allowed, `$now` for time, warning `SN502`. See Expressions and scope.
- Session probe trigger. Decided: the probe gates every reconnect; 401 goes to login, network errors back off. See Sync.
- i18n source. Decided: no built-in `t()`; helper namespaces resolved and tree-shaken at build time, `$locale` for switching. See Expressions and scope.
- Keyset jumps. Decided: keyset never jumps (`SN304`); jumps need offset mode; server requirements for keyset written down. See Pagination.
- Testing utilities. Decided: `@tiaforge/sinter/testing` ships in v0.1 as stable API; sinter tests itself through it. See Testing.
- Path parameters. Decided (2026-11-04): `<html data-sn-path="/article/:slug">` declares the URL shapes a page is served for; the runtime matches `location.pathname` once and exposes `:name` segments read-only in `$url`. No client-side routing: the server still picks the page, links stay full page loads; dev and production rewrites are the deployment's job for now.
- Optional query parameters. Decided (2026-11-04): a query parameter whose interpolated value is `null`/`undefined` is omitted from the URL, so one resource covers lists whose filters come and go.
- Templates shared across pages. Decided: static `<sn-include>` resolved at build time, lexical scope, no parameters. See Compiler contract.

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