// What each diagnostic means and how to fix it. `docs/diagnostics.md` is generated
// from this table (`npm run docs`), and editors show it next to the message.
import type { Code } from './diagnostics.js';

export interface DiagnosticDoc {
  /** a message as the compiler prints it */
  example: string;
  /** what went wrong, in a sentence or two */
  means: string;
  /** what to change */
  fix: string;
}

export const DIAGNOSTIC_DOCS: Record<Code, DiagnosticDoc> = {
  SN101: {
    example: '`data-sn-txt` is not a sinter attribute. Did you mean `data-sn-text`?',
    means: 'An attribute starts with `data-sn-` but is not one sinter knows, usually a typo.',
    fix: 'Use the suggested name. The attributes are listed in `llms.txt` and, in VS Code, completed from `html-custom-data.json`.',
  },
  SN102: {
    example: '`data-sn-for` must be on a `<template>`',
    means: 'The attribute or element is valid, but not here: lists and conditionals render from a `<template>`, `data-sn-path` belongs on `<html>`, `<sn-event>` inside `<sn-sync>`, and options such as `data-sn-debounce` need a method attribute on the same element.',
    fix: 'Move it to where the message says, wrapping the content in a `<template>` if needed.',
  },
  SN103: {
    example: 'a `data-sn-for` over primitive values needs `data-sn-key`',
    means: 'sinter keys list rows by the resource key or by object identity. Strings and numbers have neither, so rows could not be matched on update.',
    fix: 'Add `data-sn-key` with an expression that is unique per row, such as the value itself: `data-sn-key="tag"`.',
  },
  SN104: {
    example: '`data-sn-model` does not support `type="file"`; submit the form instead',
    means: 'Two-way binding has no meaningful value for this input type.',
    fix: 'Submit the form with a method attribute (`data-sn-post`, …) on it; a form with a file input is sent as `FormData`.',
  },
  SN201: {
    example: '`contcts` is not defined here. Did you mean `contacts`?',
    means: 'An expression uses a name that is not a loop variable, state field, resource, magic name, helper or JavaScript global in this scope.',
    fix: 'Fix the typo, declare the name in `data-sn-state`, or export it from the helpers module. Loop variables are only visible inside their `<template>`.',
  },
  SN202: {
    example: '`window` is a browser API; expressions may use JavaScript, not the browser. Use an island',
    means: 'Expressions may use JavaScript built-ins but not browser APIs such as `window`, `document`, `fetch` or timers, so pages stay safe under a strict CSP and testable.',
    fix: 'Move the browser code into a helper (for a pure function) or an island (a custom element that owns imperative work).',
  },
  SN203: {
    example: 'value expressions cannot assign; move this to `data-sn-on-*`',
    means: 'A binding that produces a value (`text`, `attr`, `show`, `for`, …) tried to change state, which would run on every render. Path parameters of `$url` are read-only everywhere.',
    fix: 'Do the assignment in an event handler (`data-sn-on-click`) or in an action\'s `then`.',
  },
  SN204: {
    example: '`data-sn-optimistic` may only call `patch`, `upsert`, `remove`',
    means: 'An optimistic change is undone when the request fails, so it may only use the store functions that sinter can roll back.',
    fix: 'Express the change with `patch`, `upsert` or `remove`; set other state in `then`.',
  },
  SN205: {
    example: '`m.is_read = true` mutates a resource. Use `patch(\'messages\', m, {is_read: true})`',
    means: 'Resource data is read-only in expressions: it mirrors the server, and a direct write would be lost on the next refresh or event.',
    fix: 'Use the `patch()` call from the message, or copy the item with `structuredClone(c)` to edit it in state.',
  },
  SN206: {
    example: '`m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`?',
    means: 'A helper namespace (for example paraglide messages) has no export of that name.',
    fix: 'Use the suggested name, or add the export to the namespace module.',
  },
  SN207: {
    example: '`onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`',
    means: 'The binding could run script or inject markup from data: event-handler attributes, `style`, `srcdoc`, `innerHTML`, bindings on `<script>` and similar elements, URL templates that do not start with a literal path, or persisted password fields.',
    fix: 'Use the safe equivalent the message names: `data-sn-on-*` for events, `data-sn-style` for styles, a literal `/path` at the start of a URL template.',
  },
  SN208: {
    example: 'Property \'nmae\' does not exist on type \'Contact\'. (TS2339)',
    means: 'TypeScript found a type error in an expression. Reported by `sinter check`, `sinter({ typecheck: true })` and the editor integration.',
    fix: 'Fix the expression, or the type: `type` on `<sn-resource>`, the OpenAPI spec, or a JSDoc cast in `data-sn-state`.',
  },
  SN209: {
    example: '`s` is already defined here by `data-sn-let`; use another name',
    means: 'A `data-sn-let` name is inlined wherever it is read, so it cannot share a name with a state variable or loop variable in its scope, or be redeclared inside it. A resource cannot take the name of a store function (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close`, `reset`, `emit`).',
    fix: 'Rename the let, the state or loop variable, or the resource.',
  },
  SN301: {
    example: 'resource `mesages` is not declared on this page',
    means: 'A store call, `$meta` or embedded data (`data-sn-data`) names a resource that no `<sn-resource>` on the page or its partials declares.',
    fix: 'Fix the name or add the `<sn-resource>` element.',
  },
  SN302: {
    example: 'resource `contacts` is declared twice',
    means: 'Two `<sn-resource>` elements on one page share a name, often once in the page and once in a partial.',
    fix: 'Rename one, or remove the duplicate.',
  },
  SN303: {
    example: '`$meta.contacts.loadng` is not a status field. Did you mean `loading`?',
    means: '`$meta.<resource>` has a fixed set of fields: `loading`, `error`, `loadedAt`, `pending`, `total`, and with `paginate` also `pages`, `from`, `to`, `hasPrev`, `hasNext`; `page` with `paginate="offset"`, or keyset with `offset-param`.',
    fix: 'Use the suggested field. A pagination field needs `paginate` on the resource.',
  },
  SN304: {
    example: 'keyset pagination cannot jump to a page number. Add `offset-param` if the server also accepts an offset, or use `paginate="offset"`',
    means: 'Keyset (cursor) pagination only knows the next and previous page, so `page(\'name\', 7)` has nothing to jump to, unless the server can also skip items by offset.',
    fix: 'If the API accepts an offset next to its cursor, add `offset-param="offset"`: the jump is sent as an offset and `prev`/`next` continue by cursor. Otherwise use `paginate="offset"`, or only step with `first`, `prev`, `next` and `last`.',
  },
  SN305: {
    example: 'partial `./partials/contact-dialg.html` not found or outside the project root',
    means: 'The `src` of `<sn-include>` must be a literal path, relative to the including file, that resolves inside the project root.',
    fix: 'Fix the path. Partials outside the root are refused on purpose.',
  },
  SN306: {
    example: '`a.html` → `b.html` → `a.html` includes itself',
    means: 'Partials include each other in a cycle.',
    fix: 'Move the shared part into a third partial that neither includes back.',
  },
  SN307: {
    example: 'OpenAPI spec `api.yml` is not an OpenAPI 3 document (needs `openapi: 3.x` and `paths`)',
    means: 'A spec given to `sinter({ openapi })` is missing, unreadable, or not OpenAPI 3.',
    fix: 'Fix the path in the Vite config, or convert a Swagger 2 spec to OpenAPI 3.',
  },
  SN308: {
    example: 'the response of `GET /articles` has no `articls`. Did you mean `articles`?',
    means: 'The resource matched an operation in the OpenAPI spec, but its `items` or `total` path is not in the response schema.',
    fix: 'Fix the path in `items` or `total`, or the spec if the API changed.',
  },
  SN309: {
    example: 'no `<dialog id="compose-dialg">` on this page. Did you mean `compose-dialog`?',
    means: '`showModal(id)` and `close(id)` name a `<dialog>` by its literal `id`, which must be on the page or one of its partials.',
    fix: 'Fix the id, or add `id` to the `<dialog>`. `close()` without an argument closes the dialog around the element.',
  },
  SN310: {
    example: '`pgp.decrpyt` is not exported by the actions module. Did you mean `pgp.decrypt`?',
    means: '`data-sn-call` and `<sn-resource call>` name a function the actions module (`src/sinter.actions.js` or `.ts`) exports, directly or through `export * as ns`.',
    fix: 'Use the suggested name, or export the function from the actions module.',
  },
  SN401: {
    example: '`data-sn-for` takes `item in list` or `(item, i) in list`',
    means: 'An attribute value has the wrong form: a JavaScript syntax error (the column points inside the attribute), or a value outside what the attribute accepts, such as `paginate` or `data-sn-concurrency`.',
    fix: 'Fix the value as the message says. Handlers are statements separated by `;`; value bindings are a single expression.',
  },
  SN501: {
    example: 'resource `addressbooks` is declared but never read',
    means: 'The page fetches a resource that nothing on it uses, which costs a request on every load.',
    fix: 'Remove the `<sn-resource>`, or use it.',
  },
  SN502: {
    example: '`Date.now()` in a binding never updates. Use `$now`',
    means: 'The binding reads the time or a random number once and is never re-rendered by it.',
    fix: 'Use `$now`, which sinter updates, or compute the value in a handler.',
  },
  SN503: {
    example: '`id` bound from data can shadow globals other scripts read (DOM clobbering)',
    means: 'An `id` or `name` set from server data can create a global that overrides one another script relies on.',
    fix: 'Prefix the value (`\'contact-\' + c.id`) or use a `data-*` attribute instead.',
  },
  SN504: {
    example: 'resource `contacts` has no type: expressions using it are not checked',
    means: 'The type checker has no type for the resource, so expressions that use it are not checked. Reported by `sinter check` only.',
    fix: 'Add `type="Contact[]"` with a type from `src/sinter.types.ts`, configure an OpenAPI spec that matches `src`, load it with `call` (typed by what the action returns), or write `type="any"` to opt out.',
  },
  SN505: {
    example: '`GET /articles` declares no query parameter `tagg`. Did you mean `tag`?',
    means: 'A literal query parameter in `src` is not declared by the matched OpenAPI operation, usually a typo the server would ignore.',
    fix: 'Use the suggested name, or add the parameter to the spec.',
  },
  SN506: {
    example: 'event `contact_updated` has no type: expressions reading its payload are not checked',
    means: 'An `<sn-event>` reads its payload but has no `type`, so those expressions are not checked. Reported by `sinter check` only.',
    fix: 'Add `type` with a payload type from `src/sinter.types.ts`, or `type="any"` to opt out.',
  },
};
