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
    means: 'The attribute or element is valid, but not here: lists and conditionals render from a `<template>`, `data-sn-path` belongs on `<html>`, `<sn-event>` inside `<sn-sync>`, options such as `data-sn-debounce` need a method attribute on the same element, and `data-sn-attr` cannot bind the `value` or `checked` that a `data-sn-model` on the same control writes.',
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
    example: '`window` is a browser API; expressions may use JavaScript, not the browser. Use a component\'s script',
    means: 'Expressions may use JavaScript built-ins but not browser APIs such as `window`, `document`, `fetch` or timers, so pages stay safe under a strict CSP and testable.',
    fix: 'Move the browser code into a helper (for a pure function) or a component\'s script (`src/components/<name>.ts`, which owns imperative work).',
  },
  SN203: {
    example: 'value expressions cannot assign; move this to `data-sn-on-*`',
    means: 'A binding that produces a value (`text`, `attr`, `show`, `for`, …) tried to change state, which would run on every render. Path parameters of `$url` are read-only everywhere. Also: an expression called a function of the actions module. Actions run on elements (`data-sn-call`) or feed resources (`<sn-resource call>`), because their busy state, concurrency, optimistic layer and `then`/`catch` belong to an element.',
    fix: 'Do the assignment in an event handler (`data-sn-on-click`) or in an action\'s `then`. To start an action from a handler (a key filter, `data-sn-then`, `<sn-resource then>`), put it on an element with an `id` and call `run(\'id\')`: `<span hidden id="mark-read" data-sn-call="mail.markRead(open)"></span>` and `then="$result && run(\'mark-read\')"`.',
  },
  SN204: {
    example: '`data-sn-optimistic` may only call `patch`, `upsert`, `remove`',
    means: 'An optimistic change is undone when the request fails, so it may only use the store functions that sinter can roll back.',
    fix: 'Express the change with `patch`, `upsert` or `remove`; set other state in `then`.',
  },
  SN205: {
    example: '`m.is_read = true` mutates a resource. Use `patch(\'messages\', m, {is_read: true})`',
    means: 'Resource data is read-only in expressions: it mirrors the server, and a direct write (an assignment, a mutating method such as `push()`, or `Object.assign()` on an item) would be lost on the next refresh or event.',
    fix: 'Use the `patch()` call from the message, or copy the item with `structuredClone(c)` to edit it in state.',
  },
  SN206: {
    example: '`m.inbox_titel` is not exported by namespace `m`. Did you mean `inbox_title`?',
    means: 'A helper namespace (for example paraglide messages) has no export of that name.',
    fix: 'Use the suggested name, or add the export to the namespace module.',
  },
  SN207: {
    example: '`onclick` cannot be bound with `data-sn-attr`; use `data-sn-on-click`',
    means: 'The binding could run script or inject markup from data: event-handler attributes, `style`, `srcdoc`, `innerHTML`, bindings on `<script>` and similar elements, URL templates that do not start with a literal path (or with a literal origin that lacks its `/` before a value), persisted password fields, or `constructor`, `__proto__` and `prototype` named in an expression.',
    fix: 'Use the safe equivalent the message names: `data-sn-on-*` for events, `data-sn-style` for styles, a literal `/path` (or `https://host/`) at the start of a URL template.',
  },
  SN208: {
    example: 'Property \'nmae\' does not exist on type \'Contact\'. (TS2339)',
    means: 'TypeScript found a type error in an expression. Reported by `sinter check`, `sinter({ typecheck: true })` and the editor integration.',
    fix: 'Fix the expression, or the type: `type` on `<sn-resource>`, the OpenAPI spec, or a JSDoc cast in `data-sn-state`.',
  },
  SN209: {
    example: '`s` is already defined here by `data-sn-let`; use another name',
    means: 'A `data-sn-let` name is inlined wherever it is read, so it cannot share a name with a state variable or loop variable in its scope, or be redeclared inside it. A resource cannot take the name of a store function (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close`, `reset`, `emit`, `run`).',
    fix: 'Rename the let, the state or loop variable, or the resource.',
  },
  SN301: {
    example: 'resource `mesages` is not declared on this page',
    means: 'A store call, `$meta` or embedded data (`data-sn-data`) names a resource that no `<sn-resource>` on the page or its partials declares. A name chosen by an expression (`page(searching ? \'results\' : \'messages\', \'next\')`, or a `data-sn-let` name that is one) is checked for each name it can take. Also reported: a store call whose name argument cannot be listed from the source (a state variable, a helper\'s result, `$event.detail`).',
    fix: 'Fix the name or add the `<sn-resource>` element. For a name that cannot be listed, write the choice as literals: `?:`, `||` or `??` between string literals, or a `data-sn-let` name whose value is one; a name kept in state becomes `tab === \'inbox\' ? \'inbox\' : \'sent\'`.',
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
    means: 'Keyset (cursor) pagination only knows the next and previous page, so `page(\'name\', 7)` has nothing to jump to, unless the server can also skip items by offset. A computed target (`page(\'name\', dir)`) is not this error: `sinter check` types it as a direction, and at run time a page number is refused without a request. `append` pagination takes only the literal `\'next\'`.',
    fix: 'If the API accepts an offset next to its cursor, add `offset-param="offset"`: the jump is sent as an offset and `prev`/`next` continue by cursor. Otherwise use `paginate="offset"`, or only step with `first`, `prev`, `next` and `last`.',
  },
  SN306: {
    example: '`<comment-card>` → `<reply-list>` → `<comment-card>` uses itself with no `data-sn-for` or `data-sn-if` template between, so it would never end',
    means: 'A component uses itself, directly or through other components, and nothing in between depends on data: expanding it would never end.',
    fix: 'Put the inner use in a `<template data-sn-for>` over the children (or a `<template data-sn-if>`), so data ends the recursion.',
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
  SN311: {
    example: 'no element `id="mark-raed"` on this page. Did you mean `mark-read`?',
    means: '`run(id)` starts the action of the element with that literal `id`: an element on the page or one of its partials with `data-sn-get`, `-post`, `-put`, `-patch`, `-delete` or `data-sn-call`. Also reported: an id that is not a string literal, an element without an action, an element inside a `data-sn-for` row (every row would have the id), and an id that more than one element has.',
    fix: 'Fix the id, or give the action element an `id`. For a row\'s action, put one action element outside the list and pass the row through state: `open = m; run(\'mark-read\')`.',
  },
  SN312: {
    example: 'a component has one root element; `<article-preview>` has 2 elements at the top of its template',
    means: 'A file in `src/components/` is not a valid component: it needs one `<template data-sn-component="{ …props }">` (and optionally a `<style>`) with exactly one root element in it, and the root cannot be a `<template>`, a `<slot>` or another component. Also reported: two slots with the same name.',
    fix: 'Wrap the markup in one element inside `<template data-sn-component>`: the caller\'s classes, attributes and handlers land on it.',
  },
  SN313: {
    example: '`artcle` is not a prop of `<article-preview>`; its props are `article`, `compact`. Did you mean `article`?',
    means: '`data-sn-prop` on a component passes a name its `data-sn-component` does not declare, or leaves out a prop that is not optional. Also reported: `data-sn-model` on a component without a `value` prop and a `change` event.',
    fix: 'Fix the name, pass the missing prop, or declare it in the component (`{ article: Article; compact?: boolean }`).',
  },
  SN314: {
    example: '`<article-preview>` has no slot `meta`. Its slots are `footer`.',
    means: 'Content on a component\'s tag goes into its `<slot>` elements: a `slot="name"` names a `<slot name>`, the rest goes into the default `<slot>`. Content no slot takes would be dropped.',
    fix: 'Fix the slot name, or add the `<slot>` to the component.',
  },
  SN315: {
    example: '`<task-ring>` does not declare the event `pik`; `data-sn-emits` declares `pick`. Did you mean `pick`?',
    means: 'A component\'s events are the ones its `data-sn-emits` declares: `emit()` inside it, and `data-sn-on-<event>` on its tag, must name one of them (or, on the tag, a DOM event such as `click`).',
    fix: 'Fix the name, or declare the event with its detail type: `data-sn-emits="{ pick: \'done\' | \'open\' }"`.',
  },
  SN316: {
    example: '`<sn-include>` is removed: a partial is a component. Move `./partials/contact-dialog.html` to `src/components/contact-dialog.html`, … It reads `draft`, `save` from the page: add them to `data-sn-component` and pass them with `data-sn-prop="{ draft: draft, save: save }"`',
    means: 'Partials became components. A component sees only its props, so the names a partial read from the page where it was included become props; the message lists them.',
    fix: 'Move the file to `src/components/<name>.html` (the name needs a `-`), wrap its markup in `<template data-sn-component="{ draft: Contact; … }">` around one root element, and replace the `<sn-include>` by `<name data-sn-prop="{ draft: draft }"></name>`.',
  },
  SN317: {
    example: '`selected` has no source: `patch()` acts on an item where it came from, and nothing says which resource `selected` is an item of',
    means: '`patch(item, …)` and `remove(item)` change the item in the resource it came from, found by its key: a row of a `data-sn-for` over a resource (also a filtered one, or one a helper returns), an element of one (`contacts[0]`, `.find(…)`), a single resource, a component prop that is one of those, or state a handler assigned from one (`sel = m`). The item here is none of these. Also reported: the removed forms with a resource name, `patch(\'name\', item, …)` and `remove(\'name\', item)`, and a row of a helper that takes more than one resource.',
    fix: 'Drop the resource name from the old forms. Otherwise pass the row itself; for `$result`, rely on write-through (with a spec) or patch the row with its fields; a server event\'s payload goes through `<sn-event resource op>`; an island changes the resource through the instance API.',
  },
  SN401: {
    example: '`data-sn-for` takes `item in list` or `(item, i) in list`',
    means: 'An attribute value has the wrong form: a JavaScript syntax error (the column points inside the attribute), or a value outside what the attribute accepts, such as `paginate` or `data-sn-concurrency`.',
    fix: 'Fix the value as the message says. Handlers are statements separated by `;`; value bindings are a single expression.',
  },
  SN501: {
    example: 'resource `addressbooks` is declared but never read',
    means: 'The page fetches a resource that nothing on it uses, which costs a request on every load. A resource with a `then` handler counts as used.',
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
  SN507: {
    example: '`data-sn-on-click` is too complex for markup: 5 statements in one handler (limit `statements`: 4). Move the logic into a helper (pure, `x = fn(…)`) or an action',
    means: 'An expression has more structure than markup should hold. The measure is structure, not length: statements in a handler (`statements`, 4), comma sequences (`sequences`, 0), steps one `&&`/`||`/`?:` used as a statement runs (`guarded`, 1: `a && close()` is fine, `a && (b = 1, close())` is not), `?:` nesting (`ternaries`, 2), operations in an arrow function (`arrow`, 8; a block body `{ … }` always counts), and operations in one expression or statement (`operations`, 15) as a backstop. Operations are calls, operators, assignments and computed access; names, member paths (`a.b.c`) and literals are free. Object attributes (`data-sn-state`, `-let`, `-attr`, `-class`, `-style`, `-prop`) are measured per property value. A warning by default.',
    fix: 'Move the logic into a helper (pure) and apply its result in the handler, `sel = rowClick($event, sel, key)`, or into an action for side effects (`data-sn-call`). Split independent steps into separate `;` statements. Limits and the level are options of the Vite plugin: `sinter({ complexity: { statements: 4, level: \'error\' } })`; `level: \'off\'` turns the check off.',
  },
  SN509: {
    example: '`run()` cycle: `#save` `data-sn-catch` (index.html:12) runs `#save`, which starts the first step again',
    means: '`then`/`catch` handlers start each other again through `run()` (and `refresh()`, whose load runs the resource\'s `then`), so the requests may never stop. The message lists every step with its handler and line. The check is off by default: a guarded retry is a deliberate cycle. `sinter check --check-cycles` turns it on for one run, and `sinter({ checkCycles: true })` for the build, `sinter check` and `sinter lsp`.',
    fix: 'Make sure a step stops: a condition that becomes false (`$error.status === 503 && tries < 3 && run(\'save\')`), or drop one step.',
  },
  SN510: {
    example: '`patch(\'articles\', …, $result.article)` is what write-through does: the response of `POST /articles/{slug}/favorite` is `Article`, which `articles` holds; remove this write, or add `data-sn-apply="off"` to keep it',
    means: 'A `then` handler writes to the store what write-through writes by itself after the response: an object of a resource\'s schema is patched into the item with its key (and into what the URL named), a POST to a list\'s URL inserts the created item, a DELETE of a row\'s URL removes the row. The handler\'s write lands on top and changes nothing.',
    fix: 'Remove the write from the handler (keep its other statements). To keep the explicit write, turn write-through off for that element with `data-sn-apply="off"`.',
  },
  SN511: {
    example: '`hero.jpg` is 600 px wide; the 400 px box needs 800 px to be sharp on 2x screens',
    means: 'An `<img>` with `width`/`height` smaller than its source is a box of that size, and gets files for 1x and 2x screens (phones, tablets and most laptops are 2x or more). The source has fewer pixels than the 2x file needs, so it is used as the largest file and looks soft on those screens. With a crop (`object-fit: cover`), the width counts after cropping.',
    fix: 'Use a larger source, at least the width the message names. A smaller box works too.',
  },
  SN512: {
    example: '`width="200" height="200"` has another ratio than `photo.jpg` (1600 × 1067), so the image is stretched',
    means: 'The `width` and `height` of an `<img>` have another ratio than its file, and it has no inline `object-fit`, so the browser stretches the image to fill the box.',
    fix: 'To crop to the box, add `style="object-fit: cover"` (and `object-position` for the part to keep): the build makes the cropped file and removes the style. To show the whole image, fix `width`/`height` to the file\'s ratio, or set only one of them.',
  },
  SN513: {
    example: '`src` is bound to local images (`./logo-dark.png`, `./logo.png`), which are not optimized',
    means: 'An `<img>` binds `src` to a local image path, or chooses between a few of them. The build optimizes static `<img src>` (formats, widths, dimensions) but cannot follow a path computed at runtime, so the bound image is served as the original file.',
    fix: 'Write each image as a static `<img>` and choose with `data-sn-if` or `data-sn-show`: `<img src="./logo-dark.png" alt="" data-sn-show="dark"><img src="./logo.png" alt="" data-sn-show="!dark">`. Images from the API are a different case: see `images.remote`.',
  },
  SN514: {
    example: 'this image is in a `repeat(auto-fit, …)` grid whose items are the rows of a `data-sn-for`: its columns stretch when there are fewer items than fit in a row, and how many rows there are is known only at runtime, so its size is not; it gets an upper bound instead',
    means: 'With `auto-fit`, a grid\'s empty columns collapse: a list shorter than a row stretches its items. The rows of a `data-sn-for` exist only at runtime, so the build cannot tell how wide each item is, and the image gets `sizes` from an upper bound (its container), which may fetch larger files than needed. With `auto-fill` the columns stay the same whatever the number of items, and the build writes exact `sizes`.',
    fix: 'Use `repeat(auto-fill, minmax(…, 1fr))` unless short lists should stretch. Otherwise write `sizes` on the image, which silences this.',
  },
};
