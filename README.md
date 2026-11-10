# sinter

**Multi-page apps, rethought.** Build a fast, live, type-checked web app out of plain HTML pages and
the JSON API you already have. No components, no router, no store, no JavaScript to write.

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
filters as you type, and removes a contact the moment you click Delete, putting it back if the
server refuses. It is the whole page: there is no script file next to it.

## Why multi-page apps are worth another look

Websites made of separate pages are simple, fast to open, easy to link to and hard to break. People
moved to single-page apps because classic multi-page apps had real problems. sinter fixes those
problems and keeps the simplicity.

| The classic multi-page problem | What sinter does |
| --- | --- |
| Pages flash empty, then fill in | The page shows its layout, saved values and your data in the **first frame**, [also on the very first visit](docs/spec.md#first-paint). |
| Showing data means rendering every page on a server, which costs CPU on every visit | A small layer writes the API's JSON into the HTML as it is sent. **Nothing is rendered on the server.** About 2 ms per page, [roughly ten times cheaper than server rendering](docs/first-paint-comparison.md). |
| Every click is a full reload with a white flash | The next page's data is [fetched while the pointer rests on the link](docs/navigation.md) (all browsers); sinter also writes Speculation Rules so Chromium prefetches or prerenders the HTML, and one attribute wires a [list-to-detail morph](docs/navigation.md#page-transitions) (the browser's view transitions, Chromium and Safari 18.2+). |
| Data on the page goes stale | [Live updates](docs/spec.md#sync-change-messages-and-transports) arrive over SSE or WebSocket and are applied to the right lists. |
| Forms wait for the server before anything happens | Changes show at once and [roll back on failure](docs/spec.md#optimistic-updates). |
| A typo only shows up when someone clicks it | The build [checks every name and type](docs/diagnostics.md) and fails. |
| Adding JavaScript to a page means a pile of tooling | You write attributes. The compiler writes the JavaScript. |

## What you get

- **No UI glitching, even on first load.** Layout, language, saved values and (with the optional
  server layer) real data are in the first frame. No empty states that jump, no layout shift: the
  RealWorld example measures a layout shift (CLS) of 0 in Lighthouse.
- **A server that stays cool.** Pre-filling data costs a fetch and a string replacement, not a render.
  One core serves roughly 600-1,100 pages per second as a Node script and about 2,000 with the Rust layer;
  server-rendering the same page with Qwik City saturates around 60-120.
  ([measurements](docs/first-paint-comparison.md))
- **Type checking from the database edge to the button.** Point sinter at your TypeScript types or
  your OpenAPI spec and `article.titel` is a build error with a "did you mean `title`?". Your editor
  shows it as you type.
- **Web performance by default.** Preloading, preconnecting, low-priority loading for data nobody
  needs yet, self-hosted fonts, optimized images and Speculation Rules are done by the build. You do
  not configure them. RealWorld scores **94 on mobile and 99 on desktop** in Lighthouse, with the
  least JavaScript of the apps that show articles ([comparison](docs/realworld-comparison.md#lighthouse)).
- **Great ergonomics.** One way to do each thing, all of it visible on the element. 735 lines for
  the RealWorld app, against 2,210 for the official Angular one. Small enough that an LLM writes it
  correctly on the first try (`llms.txt` ships with the package).
- **Small and safe.** 14-16 KB of JavaScript per page. No `eval`, no `unsafe-eval` in your Content
  Security Policy, and markup injected at runtime stays inert.

## Browser support

Everything works in current Chromium, Firefox and Safari (WebKit); the test suite runs in all three.
Two navigation extras depend on the browser and degrade to a normal page load:

| | Chromium | Safari | Firefox |
| --- | :---: | :---: | :---: |
| First frame, live data, optimistic updates | yes | yes | yes |
| Next-page data on hover or press | yes | yes | yes |
| Speculation Rules (HTML prefetch, prerender) | yes | no | no |
| List-to-detail morph (browser view transitions) | yes | 18.2+ | no |

## Try it

```sh
npm create @tiaforge-ui my-app
```

You get a small task board with live updates across tabs, optimistic changes that roll back, a
dialog without JavaScript, page transitions and the build-time checks, with a demo API inside
Vite ([`packages/create`](packages/create)). To add sinter to an existing project, see
[Setup](#setup).

## Mistakes fail the build

The compiler knows every name an expression can use: the state around it, loop variables,
resources, helpers. Misspell `q` in the filter above and the build stops:

```text
contacts.html:11:70 error SN201 unknown-identifier: `qq` is not defined here. Did you mean `q`?
```

The same pass rejects code that would break at runtime: writing to server data
(`c.name = 'x'` is `SN205`, use `patch('contacts', c, {...})`) and browser APIs inside expressions
(`localStorage` is `SN202`, use an island). With a `type` on the resource or your OpenAPI spec,
`sinter check` also type-checks fields, request bodies and event payloads, so `article.titel`
reports `Property 'titel' does not exist on type 'Article'. Did you mean 'title'?`.

htmx, Datastar and Alpine read their attribute strings in the browser. Nothing checks them against
your data before they ship, so the same typo shows up only when that code runs: as a console error,
or as an element that stays empty.

## Features

Each item links to the details.

### Data

- **Resources.** `<sn-resource>` loads a JSON endpoint, caches it by key and shares the request
  between everything that asks. Loading flags, stale responses and refetching are handled.
  [Resources and store](docs/spec.md#resources-and-store)
- **Live updates.** `<sn-sync>` turns server events into list changes (upsert, remove, patch) with
  attributes, over SSE, WebSocket or SignalR. Coming back online or from the back button refetches.
  [Sync](docs/spec.md#sync-change-messages-and-transports), [recipe](docs/recipes/sse-sync.html)
- **Pagination.** Keyset, offset and "load more" lists, including a start page from the URL.
  [Pagination](docs/spec.md#pagination), [recipe](docs/recipes/pagination.html)
- **Fan-out.** One request per item of another list (`each="a in accounts"`).
  [Fan-out resources](docs/spec.md#fan-out-resources-each)
- **Background refresh and caching.** `cache` shows last visit's data at once, then revalidates;
  `refresh` keeps data current. [Cached list](docs/recipes/cached-list.html),
  [Background refresh](docs/spec.md#background-refresh-refresh)

### Changing data

- **Optimistic updates that stay correct**, also when requests overlap or a server event arrives
  mid-request. [Optimistic updates](docs/spec.md#optimistic-updates),
  [recipe](docs/recipes/optimistic-toggle.html)
- **Forms and server validation.** Field errors from the server land on the right input.
  [Server validation errors](docs/spec.md#server-validation-errors-on-the-form),
  [recipe](docs/recipes/field-errors.html)
- **Writes that survive a dropped connection.** Retries with idempotency keys, per element.
  [Retries](docs/retry.md), [recipe](docs/recipes/offline-draft.html)
- **Dialogs, keyboard shortcuts, suggestion lists and row selection** without JavaScript.
  [Form dialog](docs/recipes/form-dialog.html),
  [Shortcuts](docs/recipes/keyboard-shortcuts.html),
  [Listbox](docs/spec.md#suggestion-lists-data-sn-listbox),
  [Row select](docs/recipes/row-select.html)

### Speed

- **First paint with data.** Build-time constants, an early script that renders as the page is
  parsed, and data embedded by a server layer. [First paint](docs/spec.md#first-paint),
  [measured against Qwik City](docs/first-paint-comparison.md)
- **A server layer that does not render.** [`sinter-axum`](packages/sinter-axum) (Rust, a `tower`
  layer) streams the head first, then writes each API response into its slot. The build checks
  at compile time that every slot can be filled.
- **Instant navigation.** Next-page data (sinter, all browsers). Generated Speculation Rules and
  CSP handling for HTML prefetch or prerender (the browser fetches; Chromium). `data-sn-transition`
  wires a list-row-to-detail morph on top of the browser's view transitions (Chromium, Safari 18.2+).
  [Navigation](docs/navigation.md)
- **Preloading done for you.** Preconnect to API origins, `preload` for requests known at build
  time, low priority for data behind dialogs, fonts bundled at build time.
  [First paint](docs/spec.md#first-paint)
- **Images.** AVIF/WebP/JPEG variants, `srcset` and `sizes` written from your own markup and CSS.
  [Images](docs/images.md)
- **Fast rendering.** Keyed lists measured level with or ahead of ivi, Solid and Svelte on
  js-framework-benchmark operations, and live grids that take thousands of events per second.
  [Benchmarks](docs/benchmark.md)

### Developer experience

- **Build-time errors with fixes.** Every diagnostic has a code, a "did you mean" and a page.
  [Diagnostics](docs/diagnostics.md)
- **Type checking** against TypeScript types or OpenAPI. [Type checking](docs/spec.md#type-checking),
  [recipe](docs/recipes/typed.html)
- **Editor support.** Hover, completion, go to definition and errors as you type, in VS Code,
  Neovim, Helix and Emacs. [Editors](docs/editors.md)
- **Testing.** Render a page, mock requests and streams, assert on the DOM, in plain Vitest.
  [Testing](docs/spec.md#testing)
- **Translations.** Typed `m.key({ param })` messages with inlang, one small file per page and
  language. [Recipe](docs/recipes/messages.html)
- **Islands for the rest.** Canvases, editors and charts are plain custom elements that get data
  in and send events out. [JS API for islands](docs/spec.md#js-api-for-islands)
- **LLM-ready.** [`llms.txt`](llms.txt) has the whole attribute reference and recipes.

### Safety

- **Strict CSP.** Pages run under `script-src 'self'`. [Security](docs/spec.md#security),
  [CSP and Speculation Rules](docs/navigation.md#speculation-rules-and-a-content-security-policy)
- **Compiled, not interpreted.** No parser and no `eval` in the browser; markup from the network
  stays inert.

## Compared with

**Angular, React, Vue.** If your app mostly shows and edits API data, a SPA framework makes you build
components, services, a store and a router to get there. sinter keeps the page as HTML and moves the
data handling into attributes. The tradeoff is that sinter apps are multi-page: each navigation is a
page load (the shared code comes from the browser cache).

**Next, Nuxt, SvelteKit, Qwik.** These render pages on the server for the first frame, which makes
every visit cost server CPU. sinter reaches the same first frame by writing JSON into a static page.
[Measured against Qwik City](docs/first-paint-comparison.md).

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
- You need stability guarantees. sinter is at v0.13.

## Setup

To start from a working app instead, `npm create @tiaforge-ui` creates a small task board with
sinter, [temper](https://github.com/tiaforge/temper) for the styles and a demo API inside Vite: live
updates across tabs, optimistic changes that roll back, an island, and the build-time checks
([`packages/create`](packages/create)).

To add sinter to a project:

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
- `src/sinter.helpers.js`: functions and namespaces your expressions can call.
- Messages: with an inlang project (`project.inlang`, `messages/{locale}.json`), `m.key({ param })` in markup and `m` from `@tiaforge-ui/sinter/messages` in code; one small file per page and language, loaded before the first paint; `$locale = 'de'` switches without a reload.
- `src/sinter.types.ts`: types named by `<sn-resource type="Contact[]">`. Or use `sinter({ openapi: 'openapi.yml' })` to type resources from your API spec.
- `npx sinter check` type-checks every expression. `sinter({ typecheck: true })` runs it in `vite build`.
- Loading: concurrent loads share requests, typing waits for a pause, data only dialogs show is fetched with low priority, origins in `src` are preconnected, a bfcache restore refetches, and a link to another page requests that page's data while the pointer rests on it, so the next page shows it at once (`sinter({ prefetch: false })` turns that off). `data-sn-transition="'article-' + a.slug"` on a list row and the same name on the detail page morphs one into the other across the navigation (view transitions). In Chromium the pages also carry Speculation Rules, so the next page's HTML is fetched ahead too, or the whole page prerendered with `sinter({ speculation: 'prerender' })` ([`docs/navigation.md`](docs/navigation.md)). Nothing to configure, except `'inline-speculation-rules'` in a CSP sent as a response header ([what each CSP setup needs](docs/navigation.md#speculation-rules-and-a-content-security-policy)).
- First paint: page chrome outside data templates shows before the page bundle. Build-time constants (and the base language's messages) go into the HTML; a small classic script first in the head runs `src/sinter.early.ts` (e.g. pick the language) and renders the bindings that need no data, persisted values included, as the parser inserts each element: nothing holds the paint, in any browser. With data embedded in the page (a server fills `data-sn-data`), it renders those bindings and rows too. The build lists the placeholders and their requests in `sinter-embed.json`; [`packages/sinter-axum`](packages/sinter-axum) fills them from a Rust (axum) server, streaming the head first. The build reports its size.
- `<sn-resource … cache>` shows the last page load's data at once, then revalidates. Call `clearPersisted()` on logout.
- Serve `<sn-sync>` streams over HTTP/2. Over HTTP/1.1, each tab's stream takes one of six connections per origin.
- Editors: `npx sinter lsp --stdio`. There is a VS Code extension in [`editors/vscode`](editors/vscode). For Neovim, Helix and Emacs, see [`docs/editors.md`](docs/editors.md).

## Docs

- [`llms.txt`](llms.txt): attribute reference, scope rules and recipes (each with tests).
- [`docs/spec.md`](docs/spec.md): the v0.1 specification.
- [`docs/diagnostics.md`](docs/diagnostics.md): every `SN` error code and how to fix it.
- [`docs/navigation.md`](docs/navigation.md): between pages: next-page data, Speculation Rules (and a Content Security Policy), page transitions.
- [`docs/retry.md`](docs/retry.md): retry policies: writes that survive a dropped connection, idempotency keys, what the server needs.
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
| `@tiaforge-ui/sinter/prefetch` | next-page data (added by the Vite plugin) |
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
