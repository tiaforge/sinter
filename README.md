<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/sinter-logo-dark.svg">
    <img src="docs/logo/sinter-logo.svg" alt="sinter" width="240" height="54">
  </picture>
</h1>

**Write HTML. Ship a website, a web app, or both.**

sinter compiles plain HTML pages into fast sites. A page with nothing to run ships no JavaScript.
A page that talks to your JSON API gets live data, instant updates and a first frame that already
has its data, from a few attributes. It's the same tool and the same syntax in both cases, and the
build checks every expression, so a typo fails the build and never reaches a visitor.

```sh
npm create sinter my-app
```

<a href="https://stackblitz.com/github/tiaforge/sinter/tree/main/examples/dashboard"><img src="https://developer.stackblitz.com/img/open_in_stackblitz.svg" alt="Open in StackBlitz" align="absmiddle"></a>&nbsp; or try a live dashboard in the browser, with nothing to install.

---

<table>
<tr>
<td align="center"><b>606 lines</b><br><sub>for the RealWorld app.<br>Angular's official one is 2,210</sub></td>
<td align="center"><b>100 / 100</b><br><sub>Lighthouse, mobile and desktop.<br>No layout shift</sub></td>
<td align="center"><b>0 KB</b><br><sub>of JavaScript on a static page.<br>About 16 KB on an app page</sub></td>
<td align="center"><b>~10× cheaper</b><br><sub>than server rendering for<br>a first frame with data</sub></td>
</tr>
</table>

<sub>Each implementation passes RealWorld's official end-to-end suite and was measured on the same machine under the same conditions: [comparison](docs/realworld-comparison.md), [first-paint benchmark](docs/first-paint-comparison.md). The Lighthouse score depends on the data and the styles: when the largest element on the screen is filled from the API, the largest paint waits for that response. The [server layer](docs/first-paint.md#embedded-data) avoids this by putting the data in the first frame. The [running copy](https://realworld.tiaforge.dev) is served that way, and [PageSpeed Insights](https://pagespeed.web.dev/analysis?url=https%3A%2F%2Frealworld.tiaforge.dev%2F) gives it a performance score of 100 (2026-11-26).</sub>

## From page to app, one step at a time

**1. Start with a page.** A layout and components are HTML files. The build expands them, so the
result is just HTML, with no JavaScript and nothing to hydrate.

```html
<!-- about.html -->
<site-layout data-sn-with="{ title: 'About' }">
  <h1>About us</h1>
  <team-grid data-sn-with="{ people: [{ name: 'Ada' }, { name: 'Grace' }] }"></team-grid>
</site-layout>
```

```text
sinter: about.html: no JavaScript
```

**2. Add data.** Point a resource at your API and bind it. You don't write fetch code or a store.

```html
<sn-resource name="contacts" src="/api/contacts" key="id" order="name"></sn-resource>

<ul>
  <template data-sn-for="c in contacts">
    <li data-sn-text="c.name"></li>
  </template>
</ul>
```

The request starts before the page has finished parsing, and last visit's data can be on screen in
the first frame. With the optional [server layer](docs/server.md), today's data is there too, and the
server does no rendering.

**3. Make it interactive.** Filter as you type. Delete at once, and put the row back if the server refuses.

```html
<section data-sn-state="{ q: '' }">
  <input type="search" data-sn-model="q">
  <template data-sn-for="c in contacts.filter(c => c.name.includes(q))">
    <li>
      <span data-sn-text="c.name"></span>
      <button data-sn-delete="/api/contacts/{c.id}" data-sn-optimistic="remove(c)">Delete</button>
    </li>
  </template>
</section>
```

**4. Make it live.** Changes other people make show up as they happen, in the right list.

```html
<sn-sync src="/api/events">
  <sn-event name="contact_updated" resource="contacts" op="upsert" value="$event.contact"></sn-event>
  <sn-event name="contact_removed" resource="contacts" op="remove"></sn-event>
</sn-sync>
```

**5. Get it wrong, and the build tells you.** The compiler knows every name an expression can use.
Give it your OpenAPI spec or TypeScript types, and it checks fields too.

```text
contacts.html:5:52 error SN201 unknown-identifier: `qq` is not defined here. Did you mean `q`?
contacts.html:7:29 error SN208 type-error: Property 'nmae' does not exist on type 'Contact'. Did you mean 'name'? (TS2339)
```

Your editor shows the same errors as you type, along with completion and hover.

## Everything a site needs, built in

Most of what you'd otherwise assemble from separate libraries ships with sinter. There's nothing to
configure until you want something different.

| | |
| --- | --- |
| **Pages and content** | [Layouts](docs/layouts.md) and [components](docs/components.md) with typed props, slots, events and scoped styles · [pages with no JavaScript](docs/static-pages.md) · [several languages](docs/static-pages.md#languages) from one source · [markdown](packages/sinter-markdown/docs/markdown.md) · sitemaps, canonical URLs and redirects |
| **Data** | [Resources](docs/resources.md) with caching, background refresh and fan-out · [live updates](docs/sync.md) over SSE, WebSocket or SignalR · [pagination](docs/pagination.md) with the page in the URL |
| **Changing data** | [Optimistic updates](docs/actions.md#optimistic-updates) that stay correct when requests overlap · [server validation errors](docs/actions.md) on the right field · [retries](docs/retry.md) that survive a dropped connection · dialogs, popovers and keyboard shortcuts in markup |
| **Speed** | [First frame with data](docs/first-paint.md) · [next-page data on hover](docs/navigation.md), prerendering and [page transitions](docs/navigation.md#page-transitions) · [optimized images](docs/images.md) and self-hosted fonts · [heavy packages loaded on demand](docs/lazy.md) · [list rendering](docs/benchmark.md) on par with ivi and faster than Solid and Svelte on CPU |
| **Servers** (optional) | Layers that write your API's JSON into the page as it's sent, for [Node, Bun, Deno and Workers](docs/server.md), [Rust (axum)](packages/sinter-axum) and [.NET](packages/sinter-aspnetcore) |
| **Tooling** | [Diagnostics](docs/diagnostics.md) that suggest a fix · [type checking](docs/type-checking.md) against OpenAPI or TypeScript · [editor support](docs/editors.md) for VS Code, Neovim, Helix and Emacs · [testing](docs/testing.md) in plain Vitest · [`llms.txt`](llms.txt) for coding assistants |
| **Safety** | Runs under a [strict CSP](docs/security.md) (`script-src 'self'`) · nothing is evaluated in the browser · markup from the network stays inert |

When attributes aren't enough (a canvas, a chart library, an editor), give a component
[a script](docs/islands.md). sinter renders the markup and your code handles the rest.

## Examples

- **[Dashboard](examples/dashboard)**: four services with live metrics, checked against the backend's OpenAPI file.
- **[RealWorld](examples/realworld)**: the full Conduit app, passing the official end-to-end suite. [Running copy](https://realworld.tiaforge.dev) (PageSpeed Insights: 100).
- **[Static site](examples/static-site)** and **[multilingual site](examples/multilingual-site)**: pages that ship no JavaScript, plus one page that loads data.
- **[Recipes](docs/recipes)**: 22 small pages, each one tested: filters, dialogs, offline drafts, SignalR and more.

## How it compares

- **SPA frameworks (React, Vue, Angular)**: you get the same app with no router, store or services
  to write. sinter apps are multi-page. Navigation is fast, and [swaps](docs/navigation.md#swaps) can
  keep elements such as a player running across pages, but there is no client-side router.
- **SSR frameworks (Next, Nuxt, SvelteKit)**: you get the same first frame without rendering on the
  server, so a server core handles about ten times the traffic.
- **htmx, Datastar**: sinter uses the JSON API you already have instead of an HTML-rendering
  server, its updates are optimistic, and its attributes are checked at build time, not at runtime.
- **Alpine, petite-vue**: sinter includes fetching, caching, live updates and rollback, and needs no
  `unsafe-eval`.

Details and numbers: [RealWorld comparison](docs/realworld-comparison.md).

**When not to use sinter:** you need an app shell that stays in memory for the whole session; the app
is mostly one canvas or editor; you can't have a build step; your backend has no JSON API; or you need
1.0 stability (renames are listed in the [changelog](CHANGELOG.md)).

## Add it to an existing project

```sh
npm install @tiaforge-ui/sinter
```

```js
// vite.config.js
import sinter from '@tiaforge-ui/sinter/vite';
export default { plugins: [sinter()] };
```

Then read the [attribute reference](docs/attributes.md), or start with [resources](docs/resources.md)
and [components](docs/components.md). It works in current Chromium, Firefox and Safari. A few navigation
extras depend on the browser and fall back to a normal page load ([navigation](docs/navigation.md)).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT license.
