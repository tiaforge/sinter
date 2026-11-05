# sinter

sinter binds JSON APIs to plain HTML. It caches server data in keyed
resources, keeps them current from server events, renders them through
`<template>` bindings, and runs mutations with optimistic updates. It is
compile-first: a build step turns annotated HTML into a page module, so the
browser runs no parser and no `eval`.

```html
<sn-resource name="contacts" src="/api/contacts" items="contacts" key="id" order="name"></sn-resource>

<sn-sync src="/api/events">
  <sn-event name="contact_updated" resource="contacts" op="upsert" item="contact"></sn-event>
  <sn-event name="contact_removed" resource="contacts" op="remove"></sn-event>
</sn-sync>

<section data-sn-state="{ q: '' }">
  <input type="search" data-sn-model="q">
  <ul>
    <template data-sn-for="c in contacts.filter(c => c.name.includes(q))">
      <li>
        <span data-sn-text="c.name"></span>
        <button data-sn-delete="/api/contacts/{c.id}" data-sn-optimistic="remove('contacts', c)">Delete</button>
      </li>
    </template>
  </ul>
</section>
```

## Setup (Vite)

```js
// vite.config.js
import sinter from '@tiaforge/sinter/vite';
export default { plugins: [sinter()] };
```

- `src/sinter.helpers.js` (optional): helper functions and namespaces (`export * as m from './paraglide/messages.js'`).
- `src/sinter.config.js` (optional): `configure({ request, sessionProbe, onError, locale, origins, urlSchemes, transport })`;
  `transport` picks WebSocket (`@tiaforge/sinter/ws`), SignalR (recipe in `llms.txt`) or another
  transport per `<sn-sync>` URL.
- `src/sinter.types.ts` (optional): types that `<sn-resource type="Contact[]">` names. `npx sinter check`
  type-checks every expression with your TypeScript; `sinter({ typecheck: true })` runs it in `vite build`.

## Packages

| Import | Contents |
| --- | --- |
| `@tiaforge/sinter` | `mount`, store, renderer, actions, request layer, instance API, `configure` |
| `@tiaforge/sinter/sse` | `<sn-sync>`, SSE transport |
| `@tiaforge/sinter/ws` | WebSocket transport for `<sn-sync>` |
| `@tiaforge/sinter/optimistic` | optimistic layers |
| `@tiaforge/sinter/paginate` | keyset, offset, append |
| `@tiaforge/sinter/persist` | `data-sn-persist` |
| `@tiaforge/sinter/compiler` | `compile()` |
| `@tiaforge/sinter/vite` | Vite plugin |
| `@tiaforge/sinter/check` | `check()`, used by `sinter check` |
| `@tiaforge/sinter/testing` | `render`, `mockRequests`, `mockStream` |

## Docs

- [`docs/spec.md`](docs/spec.md): the v0.1 specification.
- [`llms.txt`](llms.txt): attribute reference, scope rules and six recipes with tests.
- [`docs/progress.md`](docs/progress.md): implementation status and decisions.

## Development

```sh
npm test          # vitest (happy-dom)
npm run typecheck
npm run build     # dist/
npm run size      # size budget per module
npm run docs      # regenerate llms.txt and html-custom-data.json
```

License: MIT. Contributions are accepted under the Developer Certificate of
Origin (`Signed-off-by` in each commit, `git commit -s`); no CLA.
