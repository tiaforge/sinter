# sinter

**Your JSON API, bound to plain HTML.** sinter loads and caches server data, keeps it current from
server events, renders it through `<template>` bindings and runs mutations with optimistic updates,
without components, a router or a store library. A compiler resolves every name in every expression
at build time, and type-checks it when you give it your TypeScript types or OpenAPI spec. A typo
fails the build instead of the page, and the browser runs no parser and no `eval`.

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

That page loads the contacts, keeps them sorted, applies updates other users make as they arrive,
filters as you type, and removes a contact at once when you click Delete, putting it back if the
server refuses.

## Mistakes fail the build

The compiler knows every name an expression can use: the state around it, loop variables,
resources, helpers. Misspell `q` in the filter above and the build stops:

```text
contacts.html:11:70 error SN201 unknown-identifier: `qq` is not defined here. Did you mean `q`?
```

The same pass rejects code that would break at runtime: writing to server data
(`c.name = 'x'` is `SN205`, use `patch('contacts', c, {…})`) and browser APIs inside expressions
(`localStorage` is `SN202`, use an island). With a `type` on the resource or your OpenAPI spec,
`sinter check` also type-checks fields, request bodies and event payloads, so `article.titel`
reports `Property 'titel' does not exist on type 'Article'. Did you mean 'title'?`. Your editor
shows these errors as you type.

htmx, Datastar and Alpine read their attribute strings in the browser. Nothing checks them against
your data before they ship, so the same typo shows up only when that code runs: as a console error,
or as an element that stays empty.

## Why sinter

- **The server-state plumbing is gone.** You don't write loading flags, stale-response guards,
  refetch on reconnect, list upserts from SSE or WebSocket events, or rollback of failed updates.
  They are attributes.
- **Optimistic updates that stay correct**, also when requests overlap or a server event arrives
  while a request is in flight.
- **Checked before it ships.** Every name in every expression is resolved at build time and
  type-checked against your TypeScript types or your OpenAPI spec. Your editor shows the errors as
  you type, with hover, completion and go to definition.
- **Less code.** The [RealWorld](examples/realworld) app takes 735 lines in sinter. The official
  Angular version takes 2,210. Each page downloads 14–16 KB of JS.
- **Safe by construction.** Directives are compiled, not read from the live DOM. Pages run under
  `script-src 'self'` with no `unsafe-eval`, and markup injected at runtime stays inert.
- **Plain, valid HTML.** There is one way to do each thing, and everything is visible on the element.
  This makes the pages easy to read and easy for an LLM to write correctly (`llms.txt` ships with the
  package).

## Compared with

**Angular, React, Vue.** If your app mostly shows and edits API data, a SPA framework makes you build
components, services, a store and a router to get there. sinter keeps the page as HTML and moves the
data handling into attributes. The tradeoff is that sinter apps are multi-page: each navigation is a
page load (the shared code comes from the browser cache).

**htmx, Datastar.** These expect a server that renders HTML for every page and interaction. If you
have a JSON API, you would have to build and maintain that server. sinter uses the API you already
have, and its mutations are optimistic where htmx waits for the server's answer. Their attributes
are read in the browser, so a wrong name surfaces at runtime; sinter's are checked at build time.
If your backend renders HTML anyway and you want no build step, htmx is a good choice.

**Alpine, petite-vue.** These also render JSON with client-side templates, but they leave fetching,
caching, live updates and rollback to you. Their expressions are compiled in the browser with
`new Function`, so they need `unsafe-eval` in the CSP (Alpine has a restricted CSP build), and
nothing checks the names or fields they use until the code runs.

Measurements and sources: [`docs/realworld-comparison.md`](docs/realworld-comparison.md).

## When not to use sinter

- You want a SPA: client-side routing, transitions, a component system.
- The UI is mostly client-side interaction (editors, canvas, drag and drop). sinter leaves that to
  islands, which are plain custom elements.
- You can't have a build step.
- Your backend renders HTML, not JSON.
- You need stability guarantees. sinter is at v0.6.

## Setup

```sh
npm install @tiaforge-ui/sinter
```

```js
// vite.config.js
import sinter from '@tiaforge-ui/sinter/vite';
export default { plugins: [sinter()] };
```

Then write `data-sn-*` attributes in your HTML pages. Optional:

- `src/sinter.config.js`: `configure({ request, sessionProbe, onError, locale, origins, urlSchemes, transport })`. Auth headers, error handling, WebSocket (`@tiaforge-ui/sinter/ws`) or SignalR transports.
- `src/sinter.helpers.js`: functions and namespaces your expressions can call (`export * as m from './paraglide/messages.js'`).
- `src/sinter.types.ts`: types named by `<sn-resource type="Contact[]">`. Or use `sinter({ openapi: 'openapi.yml' })` to type resources from your API spec.
- `npx sinter check` type-checks every expression. `sinter({ typecheck: true })` runs it in `vite build`.
- First paint: page chrome outside data templates shows before the page bundle. Build-time constants go into the HTML; a small render-blocking early chunk per page runs `src/sinter.early.ts` (e.g. pick the language) and the bindings that need no data, persisted values included. The build reports its size.
- `<sn-resource … cache>` shows the last page load's data at once, then revalidates. Call `clearPersisted()` on logout.
- Serve `<sn-sync>` streams over HTTP/2. Over HTTP/1.1, each tab's stream takes one of six connections per origin.
- Editors: `npx sinter lsp --stdio`. There is a VS Code extension in [`editors/vscode`](editors/vscode). For Neovim, Helix and Emacs, see [`docs/editors.md`](docs/editors.md).

## Docs

- [`llms.txt`](llms.txt): attribute reference, scope rules and recipes (each with tests).
- [`docs/spec.md`](docs/spec.md): the v0.1 specification.
- [`docs/diagnostics.md`](docs/diagnostics.md): every `SN` error code and how to fix it.
- [`examples/realworld`](examples/realworld): a complete multi-page app.
- [`docs/progress.md`](docs/progress.md): implementation status and decisions.

## Packages

| Import | Contents |
| --- | --- |
| `@tiaforge-ui/sinter` | `mount`, store, renderer, actions, request layer, instance API, `configure` |
| `@tiaforge-ui/sinter/sse` | `<sn-sync>`, SSE transport |
| `@tiaforge-ui/sinter/ws` | WebSocket transport for `<sn-sync>` |
| `@tiaforge-ui/sinter/optimistic` | optimistic layers |
| `@tiaforge-ui/sinter/paginate` | keyset, offset, append |
| `@tiaforge-ui/sinter/each` | fan-out resources (`each="a in accounts"`) |
| `@tiaforge-ui/sinter/persist` | `data-sn-persist` |
| `@tiaforge-ui/sinter/compiler` | `compile()` |
| `@tiaforge-ui/sinter/vite` | Vite plugin |
| `@tiaforge-ui/sinter/check` | `check()` (used by `sinter check`), `checkPage()` for tests |
| `@tiaforge-ui/sinter/testing` | `render`, `mockRequests`, `mockStream` |

## Development

```sh
npm test          # vitest (happy-dom); CI runs typecheck, build and tests on every push (Node 22/24/26)
npm run typecheck
npm run build     # dist/
npm run size      # size per page and module, with budgets
npm run bench     # store and flush benchmarks (docs/benchmark.md)
npm run docs      # regenerate llms.txt, html-custom-data.json (also the VS Code extension's) and docs/diagnostics.md
npm run release -- 0.3.0   # bump versions, date the changelog, commit "Release 0.3.0", tag v0.3.0 (not pushed)
```

License: MIT. Contributions are accepted under the Developer Certificate of Origin
(`Signed-off-by` in each commit, `git commit -s`); no CLA.
