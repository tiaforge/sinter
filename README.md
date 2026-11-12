# sinter

<a href="https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard"><img src="https://developer.stackblitz.com/img/open_in_stackblitz.svg" alt="Open in StackBlitz" align="absmiddle"></a>&nbsp; a live dashboard, nothing to install

**HTML pages that behave like an app.** Add attributes to your HTML to bind the JSON API you already
have and get live data, instant updates and a first paint with no flicker. Typos fail the build, not
the page. Reusable components are plain HTML files that render in the first frame and never hydrate.
No router or store library to write, and no app JavaScript for typical pages: a small runtime ships with
each page that needs one (currently under 20 KB), and a page with nothing to run [ships none](docs/static-pages.md).

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
        <button data-sn-delete="/api/contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
      </li>
    </template>
  </ul>
</section>
```

That page loads the contacts, keeps them sorted, applies updates other users make as they arrive,
filters as you type, and removes a contact the moment you click Delete, putting it back if the
server refuses.

## The simplicity of separate pages, without the old problems

Separate pages are simple, fast to open, easy to link to and hard to break. People moved to
single-page apps because classic multi-page apps had real problems. sinter fixes those and keeps
the pages.

| The classic multi-page problem | What sinter does |
| --- | --- |
| Pages flash empty, then fill in | The page shows its layout and saved values in the **first frame**, [also on the very first visit](docs/first-paint.md). Your data follows after one API round trip, or is in the first frame too with the optional server layer below. |
| Data in the first frame means rendering every page on a server, which costs CPU on every visit | Optional, off by default: a small layer writes the API's JSON into the HTML as it is sent. **Nothing is rendered on the server.** About 2 ms per page, [roughly ten times cheaper than server rendering](docs/first-paint-comparison.md). |
| Every click is a full reload with a white flash | The next page's data is [fetched while the pointer rests on the link](docs/navigation.md) (all browsers); sinter also writes Speculation Rules so Chromium prefetches or prerenders the HTML, and one attribute wires a [list-to-detail morph](docs/navigation.md#page-transitions) (the browser's view transitions, Chromium and Safari 18.2+). |
| Data on the page goes stale | Quick start: add `refresh="30s"` to a resource and it reloads in the background, keeping the old data on screen ([details](docs/resources.md)). For real-time, [live updates](docs/sync.md) arrive over SSE or WebSocket and are applied to the right lists. |
| Forms wait for the server before anything happens | Changes show at once and [roll back on failure](docs/actions.md#optimistic-updates). |
| A typo only shows up when someone clicks it | The build [checks every name and type](docs/diagnostics.md) and fails. |
| Adding behavior means writing and wiring JavaScript | You write attributes. The compiler and a small runtime do the rest. |
| Shared markup means copy-paste or server-side includes | [Components](docs/components.md): HTML files with props, slots, events and scoped styles, expanded at build time. |

## What you get

- **No UI glitching, even on first load.** Layout, language and saved values are in the first frame with a plain static
  host. With the optional server layer (`sinter({ embed: true })`, switched at build time) real data is too. No empty states that jump, no layout shift: the
  RealWorld example measures a layout shift (CLS) of 0 in Lighthouse.
- **A server that stays cool, if you want one.** Pre-filling data (optional) costs a fetch and a string replacement, not a render.
  One core serves roughly 600-1,100 pages per second as a Node script and about 2,000 with the Rust layer;
  a server-rendering framework in the same benchmark saturates around 60-120.
  ([measurements](docs/first-paint-comparison.md))
- **Type checking.** Point sinter at your TypeScript types or
  your OpenAPI spec and `article.titel` is a build error with a "did you mean `title`?".
- **Web performance by default.** Preloading, preconnecting, low-priority loading for data nobody
  needs yet, self-hosted fonts, optimized images and Speculation Rules are done by the build. You do
  not configure them. RealWorld scores **94 on mobile and 99 on desktop** in Lighthouse, with the
  least JavaScript of the apps that show articles ([comparison](docs/realworld-comparison.md#lighthouse)).
- **Components without hydration.** A component is an HTML file, expanded where it is used, so it is in
  the first frame with its data and costs nothing at runtime. Its props keep track of where their data
  came from, so a favorite button inside it updates the right list with no store code.
- **Great ergonomics.** One way to do each thing, all of it visible on the element. 777 lines for
  the RealWorld app, against 2,210 for the official Angular one. LLM-friendly: `llms.txt` ships with the package, and the small, uniform syntax is easy for a model to get right.
- **Small and safe.** Currently under 20 KB of JavaScript per page, and none on a page with nothing to run. No `eval`, no `unsafe-eval` in your Content
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
npm create sinter my-app
```

You get a small task board with live updates across tabs, optimistic changes that roll back, a
dialog without JavaScript, page transitions and the build-time checks, with a demo API inside
Vite ([`packages/create`](packages/create)).

Or open a live dashboard in the browser, nothing to install:
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard)
Four services with made-up metrics: the backend serves an OpenAPI file the pages are checked against,
and pushes new numbers every second, which redraw the graphs ([`examples/dashboard`](examples/dashboard)).

## Mistakes fail the build

The compiler knows every name an expression can use: the state around it, loop variables,
resources, helpers. Misspell `q` in the filter above and the build stops:

```text
contacts.html:11:70 error SN201 unknown-identifier: `qq` is not defined here. Did you mean `q`?
```

The same pass rejects code that would break at runtime: writing to server data
(`c.name = 'x'` is `SN205`, use `patch(c, {...})`) and browser APIs inside expressions
(`localStorage` is `SN202`, use a component's script). With a `type` on the resource or your OpenAPI spec,
`sinter check` also type-checks fields, request bodies and event payloads, so `article.titel`
reports `Property 'titel' does not exist on type 'Article'. Did you mean 'title'?`.

htmx, Datastar and Alpine read their attribute strings in the browser. Nothing checks them against
your data before they ship, so the same typo shows up only when that code runs: as a console error,
or as an element that stays empty.

## Components

A component is an HTML file in `src/components/`. Its file name is its tag:

```html
<!-- src/components/contact-card.html -->
<template data-sn-component="{ contact: Contact; compact?: boolean }" data-sn-emits="{ pick: Contact }">
  <article class="card" data-sn-class="{ compact }">
    <h2 data-sn-text="contact.name"></h2>
    <slot name="meta"></slot>
    <button data-sn-on-click="emit('pick', contact)">Open</button>
    <button data-sn-delete="/api/contacts/{contact.id}" data-sn-optimistic="remove(contact)">Delete</button>
  </article>
</template>
<style>
  .card { padding: 1rem; }
  .compact h2 { font-size: 1rem; }
</style>
```

```html
<!-- any page -->
<template data-sn-for="c in contacts">
  <contact-card data-sn-prop="{ contact: c }" data-sn-on-pick="open = $event.detail">
    <small slot="meta" data-sn-text="c.email"></small>
  </contact-card>
</template>
```

- **Expanded at build time.** The component's root replaces its tag, so the component is page markup:
  it renders in the first frame like the rest of the page, and nothing hydrates it.
- **A checked contract.** Props, events and slots are declared once, in the file; a wrong prop, event
  or slot name fails the build, and `sinter check` types every prop and `$event.detail`.
- **Data that knows where it came from.** `remove(contact)` names no resource: it removes the contact
  from the list the caller got it from.
- **Scoped styles** through native `@scope`, in the page's stylesheet: no inline styles, no CSP change.
- **A script when needed.** `contact-card.ts` beside the file extends a base class typed from the HTML,
  for a canvas or a library; sinter renders the markup.
- **Trees and mixed lists.** A component can use itself (comments and their replies, at any depth), and
  ``<sn-component use="`${b.type}-block`">`` picks one per item.
- **Layouts.** A document in `src/layouts/` with slots in its head and body: a page is only its tag,
  and passes its title and SEO tags in through props, head slots and head components
  (`<template data-sn-head>`). The merge happens at build time, so the early scripts, preloads and
  bundled scripts and fonts work on the merged head.

[Components](docs/components.md), [layouts](docs/layouts.md), [components with a script](docs/islands.md)

## Features

### Data

- **Resources.** `<sn-resource>` loads a JSON endpoint, caches it by key and shares the request
  between everything that asks. Loading flags, stale responses and refetching are handled.
  [Resources and store](docs/resources.md)
- **Live updates.** `<sn-sync>` turns server events into list changes (upsert, remove, patch) with
  attributes, over SSE, WebSocket or SignalR. Coming back online or from the back button refetches.
  [Sync](docs/sync.md), [recipe](docs/recipes/sse-sync.html)
- **Pagination.** Keyset, offset and "load more" lists, including a start page from the URL.
  [Pagination](docs/pagination.md), [recipe](docs/recipes/pagination.html)
- **Fan-out.** One request per item of another list (`each="a in accounts"`).
  [Fan-out resources](docs/resources.md)
- **Background refresh and caching.** `cache` shows last visit's data at once, then revalidates;
  `refresh` keeps data current. [Cached list](docs/recipes/cached-list.html),
  [Background refresh](docs/resources.md)

### Changing data

- **Optimistic updates that stay correct**, also when requests overlap or a server event arrives
  mid-request. [Optimistic updates](docs/actions.md#optimistic-updates),
  [recipe](docs/recipes/optimistic-toggle.html)
- **Forms and server validation.** Field errors from the server land on the right input.
  [Server validation errors](docs/actions.md),
  [recipe](docs/recipes/field-errors.html)
- **Writes that survive a dropped connection.** Retries with idempotency keys, per element.
  [Retries](docs/retry.md), [recipe](docs/recipes/offline-draft.html)
- **Dialogs, keyboard shortcuts, suggestion lists and row selection** in markup.
  [Form dialog](docs/recipes/form-dialog.html),
  [Shortcuts](docs/recipes/keyboard-shortcuts.html),
  [Listbox](docs/actions.md),
  [Row select](docs/recipes/row-select.html)

### Speed

- **First paint with data.** Build-time constants, an early script that renders as the page is
  parsed, and, optionally, data embedded by a server layer. [First paint](docs/first-paint.md),
  [benchmark against a server-rendering framework](docs/first-paint-comparison.md)
- **An optional server layer that does not render.** [`sinter-axum`](packages/sinter-axum) (Rust, a `tower`
  layer) and [`Sinter.AspNetCore`](packages/sinter-aspnetcore) (.NET, middleware for minimal APIs
  and MVC, NativeAOT-compatible) stream the head first, then write each API response into its slot. Both
  check at compile time that every slot can be filled. Other languages are easy to add: the
  server only writes JSON into the `<script type="application/json" data-sn-data>` slots in the
  head, listed in the build's `sinter-embed.json` ([contract](docs/first-paint.md)).
- **Instant navigation.** Next-page data (sinter, all browsers). Generated Speculation Rules and
  CSP handling for HTML prefetch or prerender (the browser fetches; Chromium). `data-sn-transition`
  wires a list-row-to-detail morph on top of the browser's view transitions (Chromium, Safari 18.2+).
  [Navigation](docs/navigation.md)
- **Preloading done for you.** Preconnect to API origins, `preload` for requests known at build
  time, low priority for data behind dialogs, fonts bundled at build time.
  [First paint](docs/first-paint.md)
- **Heavy packages on demand.** `sinter({ lazy: ['openpgp'] })`: your imports stay as they are, the
  package loads on first call; `data-sn-import` and `data-sn-preload` load it sooner where a page needs
  it. The build fails when a page would ship it anyway, and a tab left open across a deploy gets
  `$error.stale` instead of a broken import. [Lazy packages](docs/lazy.md)
- **Images.** AVIF/WebP/JPEG variants, `srcset` and `sizes` written from your own markup and CSS.
  [Images](docs/images.md)
- **Fast rendering.** Keyed lists measured level with or ahead of ivi, Solid and Svelte on
  js-framework-benchmark operations, and live grids that take thousands of events per second.
  [Benchmarks](docs/benchmark.md)

### Developer experience

- **Build-time errors with fixes.** Every diagnostic has a code, a "did you mean" and a page.
  [Diagnostics](docs/diagnostics.md)
- **Type checking** against TypeScript types or OpenAPI. [Type checking](docs/type-checking.md),
  [recipe](docs/recipes/typed.html)
- **Editor support.** Hover, completion, go to definition and errors as you type, in VS Code,
  Neovim, Helix and Emacs. [Editors](docs/editors.md)
- **Testing.** Render a page, mock requests and streams, assert on the DOM, in plain Vitest.
  [Testing](docs/testing.md)
- **Translations.** Typed `m.key({ param })` messages with inlang, one small file per page and
  language. [Recipe](docs/recipes/messages.html)
- **Components.** HTML files with props, slots, events and scoped styles, expanded at build time and
  typed. [Components](docs/components.md)
- **Scripts for the rest.** Canvases, editors and charts are a component's script, or plain custom
  elements that get data in and send events out. [Components with a script](docs/islands.md)
- **LLM-ready.** [`llms.txt`](llms.txt) has the whole attribute reference and recipes.

### Safety

- **Strict CSP.** Pages run under `script-src 'self'`. [Security](docs/security.md),
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
[Benchmark](docs/first-paint-comparison.md).

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

- You want a SPA: client-side routing and a client-side component runtime.
- The UI is mostly client-side interaction (editors, canvas, drag and drop). sinter leaves that to
  the scripts of components, which do the browser work around markup sinter renders.
- You can't have a build step.
- Your backend renders HTML, not JSON.
- You need stability guarantees. sinter is at v0.17.

## Setup

```sh
npm install @tiaforge-ui/sinter
```

```js
// vite.config.js
import sinter from '@tiaforge-ui/sinter/vite';
export default { plugins: [sinter()] };
```

The broad concepts:

- **[Resources](docs/resources.md)** (`<sn-resource>`) load and cache server data by name. Templates read them.
- **[Bindings](docs/attributes.md#show-data)** (`data-sn-text`, `data-sn-for`, `data-sn-if`, ...) render data. Expressions are checked at build time.
- **[Actions](docs/actions.md)** (`data-sn-post`, `data-sn-delete`, ...) send changes; [`data-sn-optimistic`](docs/actions.md#optimistic-updates) shows them at once.
- **[Sync](docs/sync.md)** (`<sn-sync>`) applies server events to resources.
- **[Components](docs/components.md)** are HTML files in `src/components/`, expanded at build time: props,
  slots, events and scoped styles, in the first frame with no hydration.
- **[Components with a script](docs/islands.md)** do what attributes can't (a canvas, a library); plain
  custom elements work too.

Every attribute is in the [reference](docs/attributes.md). Optional files in `src/`:

- [`sinter.config.js`](docs/configuration.md): auth headers, error handling, transports, retries.
- [`sinter.helpers.js`](docs/configuration.md): functions your expressions can call.
- `sinter.types.ts`, or `sinter({ openapi: 'openapi.yml' })`: types for [`sinter check`](docs/type-checking.md).

`npx sinter check` type-checks every expression, and `npx sinter lsp --stdio` gives editors errors as you type ([editors](docs/editors.md)). Loading, first paint and navigation need no configuration; their options are in the [first paint](docs/first-paint.md) and [navigation](docs/navigation.md) docs.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT license.
