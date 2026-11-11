# Pages without JavaScript

A page ships JavaScript only if something on it runs in the browser. A page built from a layout,
components and text, with no data and nothing interactive, is complete in its HTML and gets no
script at all: no page module, no early script, no runtime. A site that is static on some pages and
an app on others gets both: the runtime is one shared file that only the pages that need it load.

There is nothing to turn on. The build decides it per page and says so:

```
sinter: index.html: no JavaScript
sinter: contact.html: JavaScript 0.4 kB gzip + 14.1 kB gzip shared: `data-sn-on-submit` (contact.html:12), resource `countries` (contact.html:3)
```

The second line names the first few things that run in the browser on that page, and where each was
written: in the page, a component or the layout.

## What is static

Whatever can never change is written into the HTML at build time and carries nothing in the
browser ([build-time constants](first-paint.md#build-time-constants)):

- literals, and a component's props given as literals: `<site-header data-sn-prop="{ title: 'About' }">`
- `data-sn-state` fields that nothing on the page writes: `{ nav: 'about' }` read by a nav link's class
- `data-sn-if` over those, decided at build time
- `data-sn-for` over a constant list, unrolled into its rows, when the rows read only the item, its
  index and constants:

  ```html
  <!-- src/components/nav-list.html -->
  <template data-sn-component="{ items: { href: string; label: string }[] }">
    <ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-text="i.label"></a></li></template></ul>
  </template>

  <!-- the page -->
  <nav-list data-sn-prop="{ items: [{ href: '/', label: 'Home' }, { href: '/about.html', label: 'About' }] }"></nav-list>
  ```

  is `<ul><li><a href="/">Home</a></li><li><a href="/about.html">About</a></li></ul>` in the built page.
  A row with a handler, a model, its own state or a nested loop, and a list over 1,000 items, stay a
  template that the runtime renders.

## What needs JavaScript

Anything that runs in the browser keeps the runtime on its page:

| On the page | Why |
| --- | --- |
| a binding over state a handler, a model or a `then` writes | it changes |
| a binding over `$url`, `$now`, `$locale`, a helper or a built-in formatter | the browser computes it |
| `<sn-resource>`, `<sn-sync>`, an action (`data-sn-post`, `data-sn-call`, …) | it talks to your API |
| a handler (`data-sn-on-click`, key shortcuts), `data-sn-model`, `data-sn-persist`, `data-sn-listbox` | it reacts to the visitor |
| a component with a script (`src/components/<name>.ts`) | its script runs |
| messages that switch language in the browser (`m.*`) | the language is picked in the browser |
| `data-sn-transition`, images from the API through a resizing service | they need code |

A script the page or its layout writes itself (`<script type="module" src="./main.ts">`) is the
app's: it stays, and Vite bundles it as usual, without the runtime.

## Making sure a page stays static

On a docs site, one `data-sn-on-click` in the footer would put the runtime back on every page,
quietly. List the pages that must ship no JavaScript in the plugin's options:

```js
// vite.config.js
sinter({ static: ['index.html', 'about.html', 'docs/**'] })
sinter({ static: true })   // every page
```

Paths are relative to the root: `*` matches within one folder, `**` across folders. A listed page
that needs the runtime fails the build with [SN322](diagnostics.md#sn322-ships-javascript), once for
each thing that runs, where it was written:

```
src/components/site-footer.html:3:29 error SN322 ships-javascript: about.html must ship no JavaScript (`sinter({ static })`), but `data-sn-on-click` runs in the browser
```

`sinter check` and the editor report it too. A pattern that matches no page is a build error, so
that renaming a page cannot drop it from the check unnoticed.

## What a page without JavaScript does not do

- **The config module does not run.** `src/sinter.config.ts` configures sinter (request middleware,
  `onError`, `locale`, …), and sinter does not run on the page, so neither does it. Code meant for
  every page, such as an analytics snippet, goes in a script the layout includes.
- **The early module does not run either.** `src/sinter.early.ts` is shared by every page of the app
  and runs before sinter renders; on a page where sinter renders nothing, it is left out.
- **Next-page data is not prefetched.** When a visitor rests the pointer on a link to a page with
  data, sinter's runtime requests that page's data, so it shows at once. A static page has no runtime,
  so a data page opened from it loads its data after one round trip, as on a first visit. Speculation
  Rules still work, since they are not JavaScript: the browser fetches the next page's HTML, and with
  `sinter({ speculation: 'prerender' })` Chromium loads the whole next page, data included, before the
  click ([navigation](navigation.md)).

## Your own scripts

A static page ships no script of sinter's, and the app's global modules (the config module and the
early module) stay out. A script the page or its layout writes is the page's own: it always ships,
and it does not count against `sinter({ static })`.

| Code that should run | Write it as |
| --- | --- |
| after the page is parsed: analytics, a widget, a small interaction | `<script type="module" src="./about.ts">`, bundled by Vite: in the layout's head for every page, or in one page through the layout's head slot (`<script slot="head" type="module" src="./about.ts">`) |
| before the first paint: a theme class from `localStorage`, so the page does not flash | a classic script inline in the layout's head: `<script>document.documentElement.dataset.theme = localStorage.theme ?? 'light'</script>` |

A module script runs after the page is parsed, too late for code that must change the first paint,
and Vite bundles only module scripts; so pre-paint code is inline (or a classic script from
`public/`, served as written). With a Content Security Policy, an inline script needs its hash (or
`'unsafe-inline'`) in `script-src`.

The dev server serves the same pages as the build: no page module on a static page, its components'
styles as a stylesheet.
