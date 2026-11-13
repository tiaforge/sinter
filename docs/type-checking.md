# Type checking

Give a resource a type and `sinter check` verifies every expression that touches it: fields, request bodies and event payloads. `article.titel` becomes a build error with a suggestion.

```html
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" type="Contact[]"></sn-resource>

<template data-sn-for="c in contacts">
  <span data-sn-text="c.emial"></span>
</template>
```

```ts
// src/sinter.types.ts
export interface Contact { id: number; name: string; email: string | null }
```

```text
index.html:5:28 error SN208 type-error: Property 'emial' does not exist on type 'Contact'. Did you mean 'email'? (TS2339)
```

Run it:

```sh
npx sinter check                 # pages and options from the Vite config
npx sinter check page.html       # or name the pages
npx sinter check --root app      # another project root
```

It needs TypeScript in the project, uses your version of it, and never runs in the dev server. To fail the production build on type errors:

```js
sinter({ typecheck: true })
```

The check runs at the end of `vite build`. Without types, the compiler still checks every name, state variable and helper: [docs/diagnostics.md](diagnostics.md).

## Types on resources

`type` names the type of what `items` selects. The names come from your types module, `src/sinter.types.ts` (or `.d.ts`, `.js`; set `sinter({ types })` to move it).

| Attribute | Meaning |
| --- | --- |
| `type="Contact[]"` | any TypeScript type over the names the module exports |
| `type="any"` | leave this resource unchecked on purpose |
| none | `SN504` warning, unless an OpenAPI spec or `call` types it |

State is typed by its literal. When the literal cannot show the type, cast it with JSDoc:

```html
<section data-sn-state="{ editing: /** @type {Contact|null} */ (null) }">
```

Everything else is typed for you: helpers and namespace members by their own modules, `$event` and `$el` by the DOM types of the event and element, and `$meta`, `$error` and the store functions by sinter. `$result` in `then` has the resource's type, or the action's awaited result for `call`.

Custom elements are typed by the app's own declarations. A module under `src/` that declares an element in
`HTMLElementTagNameMap`, or its events in `SinterElementEvents`, is part of every check:

```ts
// src/islands/mail-reader.ts
export class MailReader extends HTMLElement { message: Message | null = null; readonly = false; }
declare global {
  interface HTMLElementTagNameMap { 'mail-reader': MailReader }
  interface SinterElementEvents { 'mail-reader': { 'reader-flag': boolean } }
}
```

Then `data-sn-prop` on `<mail-reader>` takes only its properties, with their types; `$el` is a `MailReader`; and in
`data-sn-on-reader-flag`, `$event.detail` is a `boolean`. An element the app does not declare takes any property,
and its events' `detail` is `any`.

Null checks and implicit `any` are off. A binding that reads `null` renders nothing, and expressions in separate attributes cannot narrow each other, so strictness would only produce noise.

## Server events

`type` on `<sn-event>` types the payload, using the same module:

```html
<sn-sync src="/api/events">
  <sn-event name="contact_updated" resource="contacts" op="upsert" item="contact" type="ContactEvent"></sn-event>
</sn-sync>
```

```ts
export interface ContactEvent { contact: Contact }
```

`item` must be assignable to the resource's item, and `set` to a part of it, so a payload that does not fit the resource is an error:

```text
Type 'string' is not assignable to type 'Contact'.
```

An event whose expressions read the payload and has no `type` is warning `SN506`; `type="any"` opts out. See [docs/sync.md](sync.md) and the [typed recipe](recipes/typed.html).

## OpenAPI

Point sinter at your spec and resources are typed without writing any types:

```js
sinter({ openapi: 'openapi.yml' })                    // or a list, one per API
```

Local JSON or YAML files, so builds stay deterministic. The spec must be an OpenAPI 3 document (`openapi: 3.x` and `paths`), else `SN307`.

A resource with no `type` is matched to a `GET` operation:

- The `servers` URL prefix is stripped from `src` and the query string is dropped.
- Literal segments match literally; a segment that is one interpolation (`/api/contacts/{id}`) matches a `{param}`. A literal path beats a templated one.
- The type is the first 2xx JSON response's schema at `items`. Named schemas become named types.

Actions are matched the same way with their own method: `data-sn-body` must fit the JSON request schema, and `$result` in `then` has the response type. No match leaves the resource or action untyped (`any`), and `SN504` names the closest path.

The match runs in every build, not only in the check:

```text
SN308 unknown-schema-field: the response of `GET /articles` has no `articls`. Did you mean `articles`?
SN505 unknown-query-param: `GET /articles` declares no query parameter `tagg`. Did you mean `tag`?
```

`SN308` means `items` or `total` is not in the schema. `SN505` is a warning for a literal query parameter the operation does not declare.

### Operations instead of URLs

With a spec, a resource can name its operation instead of writing its URL:

```html
<!-- instead of src="https://api.realworld.show/api/profiles/{$url.username}" -->
<sn-resource name="profile" operation="GetProfileByUsername" params="{ username: $url.username }" items="profile"></sn-resource>
<sn-resource name="articles" operation="GetArticles" params="{ tag: $url.tag, limit: 10 }" items="articles"></sn-resource>
```

- `operation` is an `operationId`, or the method and path as the spec writes them (`GET /profiles/{username}`) for a spec without ids.
- The URL is the first `servers` entry followed by the path. `params` fills the path parameters and adds the query parameters it gives, in the spec's order; a `null` query value leaves the parameter out, as in `src`.
- The build compiles this to the same URL template as the `src` it stands for, so loading, request sharing, prefetching and the server layer work the same.
- An unknown operation is `SN326`, with a "did you mean". A parameter the operation does not declare, and a path parameter or required query parameter left out, are `SN327`. Both are errors, unlike `SN505` on a `src`.

In the editor, `operation="…"` completes the spec's GET operations, and a hover on it shows the absolute URL, as the spec has it and with the `params` expressions filled in.

## Examples of errors

| You wrote | Report |
| --- | --- |
| `c.emial` on a `Contact` | `SN208` Property 'emial' does not exist on type 'Contact'. Did you mean 'email'? |
| `data-sn-body="{ name: 5 }"` against a string field | `SN208` Type 'number' is not assignable to type 'string' |
| a `src` that matches no operation | `SN504` resource `contacts` has no type, naming the closest path |
| `operation="GetArticels"` | `SN326` the OpenAPI spec has no operation `GetArticels`. Did you mean `GetArticles`? |
| `m.inbox_count({ cnt: 1 })` | `SN208` wrong or missing message parameter |
| `$meta.contacts.loadng` | `SN303` unknown status field, did you mean `loading` |

## What the check does

`sinter check` compiles each page, writes one JavaScript file per page under `.sinter/check/` with every expression verbatim inside blocks that declare its scope, and runs `tsc` on them with `checkJs`. Errors map back to the HTML line and column. Add `.sinter/` to `.gitignore`. It prints a summary:

```text
sinter check: 4 page(s), 0 error(s), 1 warning(s); 7 of 8 resources typed (3 via OpenAPI)
```

`--check-cycles` also reports `then`/`catch` handlers that start each other through `run()` (`SN509`).

## Editor support

`sinter lsp` shows the same diagnostics as you type. With TypeScript 7 it adds type errors, hover types, completion inside expressions and go to definition, including from a resource type to its schema in the spec. A "did you mean" message offers a quick fix. Setup for VS Code, Neovim, Helix and Emacs is in [docs/editors.md](editors.md).

## In tests

`checkPage` runs the same check on one page in a temporary project:

```js
import { checkPage } from '@tiaforge-ui/sinter/check';
import page from './typed.html?raw';
import types from './typed.types.ts?raw';

test('every expression type-checks', () => {
  expect(checkPage(page, { files: { 'src/sinter.types.ts': types } })).toEqual([]);
});
```

`files` are written next to the page, and the other options are the ones of `sinter({...})` (`openapi`, `types`, `helpers`, ...). It returns the compiler's and TypeScript's diagnostics, and resolves TypeScript from the current directory. More in [docs/testing.md](testing.md).
