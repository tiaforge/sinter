# First paint

The first frame a visitor sees is already correct: the layout, the language, the current nav item,
values the visitor saved last time, and (with the optional server layer) the real data. No empty
states that jump, no layout shift. It works on a plain static host, on the first visit, in every
browser.

What can be in the first frame depends on where the value comes from:

| The value comes from | In the first frame | How |
| --- | --- | --- |
| A literal `data-sn-state` field | yes, even without scripts | [Build-time constants](#build-time-constants) |
| Messages, persisted values, helpers, `$locale`, the URL (`$url`) | yes | [The early script](#the-early-script) |
| Your API, with the server layer | yes | [Embedded data](#embedded-data) |
| Your API, without it | after one round trip, started before the page script runs | [Requests start early](#requests-start-early) |

## Build-time constants

A binding outside any `<template>` whose value is known at build time is written into the HTML
as the runtime would write it:

```html
<body data-sn-state="{ here: '/mail/' }">
  <a href="/mail/" data-sn-attr="{'aria-current': here === '/mail/' ? 'page' : null}">Mail</a>
  <a href="/calendar/" data-sn-attr="{'aria-current': here === '/calendar/' ? 'page' : null}">Calendar</a>
</body>
```

The built HTML already has `aria-current="page"` on Mail. This is what a browser with scripts
disabled shows.

A binding qualifies when it reads only `data-sn-state` fields with a constant initializer, and
constants. Fields count one by one: in `{ here: '/mail/', at: $now }`, `here` is still constant.
Helpers, `$locale` and persisted values are not constants (the early script handles those). A
refused URL or style is left out.

A binding that reads nothing that can change, such as a component's prop given as a literal
(`<seo-tags data-sn-prop="{ title: 'About' }">`) or a state field that nothing on the page writes
(`nav: 'home'` read by a nav link's class), is only in the HTML: the page script carries nothing for
it. One that reads state a handler, a model, a `then` or a component's script writes stays bound.
The same holds inside templates: such a binding is written into the template's markup, so every
row or branch is cloned with it. And a `data-sn-if` over state nothing writes is decided at build
time: its branch (or its `data-sn-else`) is page markup, written and painted like the rest.

## The early script

Anything that needs a little code, but no data, is rendered by an early script that runs before
the first paint:

- messages, in the language picked from the visitor's saved choice or browser settings
- persisted values (`data-sn-persist`)
- state fields initialized by helpers or `$locale`
- the URL: `$url`'s query and its `data-sn-path` parameters (the current nav item, a tab from `?feed=`)
- `data-sn-if` branches over that state
- your own code in `src/sinter.early.ts`

Each page gets two small classic scripts first in the head, before the stylesheets: one shared by
every page (so it is cached across pages) and one with the page's own bindings. Nothing hides the
page while they run. They render each element as the browser parses it, before it can be painted,
so there is no flash in Chromium, Firefox or Safari. Attributes and classes are written as soon as
the element exists; its content once the parser has closed it.

The runtime then takes over: on mount it computes the same values, writes nothing new, and nothing
flashes or resets. Early code runs once and keeps no listeners.

What waits for the page script: `$url`, `$now`, `$meta`, `$el`, loop variables, store functions and
the built-in formatters (`date()` and friends, which use the locale the runtime configures).

### Your own early code

`src/sinter.early.ts` is optional app code that runs before anything is rendered, for example to
configure the environment.

```ts
// src/sinter.early.ts
import { configure } from '@tiaforge-ui/sinter';
configure({ env: { apiVersion: '2' } });
```

Early code is bundled apart from the page script, so any module both use exists twice, as separate
instances. State you set early is not seen by the page script; set it again there, for example by
calling the same function from `src/sinter.config.ts`. sinter's own state (rendered values,
messages) is handed over for you. Don't configure the locale: sinter owns it.

Because the early files block the parser, keep them small. The build prints each page's early size
(gzip, the page's script and the shared one together) and warns above `sinter({ earlyBudget })`
(default 10000 bytes), naming the largest modules. A heavy import in the early module, or in a
helper an early binding calls, shows up there.

### The page script is `async`

In builds the page script is `async`, so it does not wait for stylesheets and starts its requests
sooner. It may therefore run before the body is parsed. sinter waits for the parse (and the early
script) before it mounts, but your code at the top level of a page-bundle module must not read the
body, and an island must not read its children or later siblings in `connectedCallback`; read them
when sinter sets a prop or on an event.

## Embedded data

A resource can start with its data inside the page. If the head contains

```html
<script type="application/json" data-sn-data="contacts">[{"id":1,"name":"Ada"}]</script>
```

then `contacts` has that data and makes no first request. The early script reads it too, so
bindings over it, `data-sn-for` loops included, are in the first frame. The page script adopts
the rows that are there instead of cloning them again.

Who writes the JSON is up to you. A server that only fetches your API and writes the response
into the page is enough: it renders nothing. The slots must sit in `<head>`, once per resource;
anything else is ignored. Empty slot contents mean "no data", and the page requests it itself, so
a server that fails or times out leaves a working page. Invalid JSON is a dev warning.

### The server layer

[`sinter-axum`](../packages/sinter-axum#readme) is a ready-made layer for Rust (axum). Build with:

```js
// vite.config.js
sinter({ embed: true })
```

Every resource whose request the page's URL decides (its `src`, `when` and `start-page` read only
`$url`, constants and helpers) gets an empty slot, last in the head, so a streaming server sends
the stylesheets and scripts before it has the data. The build lists the slots in
`dist/sinter-embed.json`: per page, its paths and per slot the resource and the request the browser
would have made. Those resources are no longer preloaded or requested by the browser; the data comes
with the page. `vite dev` is unaffected.

Left out of embedding: `call` and `each` resources, resources with `early="off"`, and anything
whose request reads state, another resource or a non-constant helper (they stay with the browser).
The manifest is the contract if you write the server in another language. The layer costs about
2 ms per page and no rendering; see [first-paint-comparison.md](first-paint-comparison.md) for
measurements against a server-rendering framework.

Two things to know:

- The server fetches without the visitor's credentials. If the user's token lives in
  `localStorage`, the server cannot see it and writes the anonymous view; embedded data is not
  reloaded. Give such resources a resolver that returns nothing, so the browser requests them.
- A server that cannot fetch a page's data may end the page with `<body data-sn-failed>` (what
  `sinter-axum` does). The page script then does not mount. Pages never write that attribute
  themselves.

For the browser-side cache that works without a server, see `cache` on a resource in
docs/resources.md.

## Requests start early

Without embedded data, a resource's request still leaves before the page script is running:

- **Preload.** A resource with a literal same-origin `src`, no `when` and not `each`, `call` or
  embedded gets `<link rel="preload" as="fetch" crossorigin>` in the head. The request starts while
  the head is parsed. A paginated resource is preloaded at its first page.
- **Early request.** A resource whose URL reads only things the early script knows (state without
  data, persisted values, `$now`, `$url`, helpers) is requested as soon as the early script runs,
  if its `when` holds.
- **Preconnect.** Every origin a literal `src` of a resource or stream names gets
  `<link rel="preconnect" crossorigin>`.

The page's resource takes the response when it loads, so there is one request. It goes through your
request middleware as always: the early response is used at the end of the chain if the request is
exactly the one sent early (a plain GET with no extra headers), so response middleware such as
`onUnauthorized` still runs. A request your middleware changes is sent again.

### Other origins

A cross-origin `src` is preloaded and requested early only if its origin is listed in the build:

```js
sinter({ origins: ['https://api.example.com'] })
```

List API origins here, not in `configure({ origins })`: every page adds this list to the runtime's
allowlist, and nothing the runtime would refuse is sent early. An origin listed only in
`configure()` is allowed but requested by the page script. The build tells you which origins it
left to the page script. Cross-origin early requests are sent without credentials.

### Keeping a resource out

`<sn-resource early="off">` keeps a resource out of the preload and the early request. Use it when
a request middleware answers the request itself or changes it, for example adds an
`Authorization` header: the early request would go unused, or fail where the middleware would
have answered. A browser preload is sent without your headers, so the same goes for any resource
that needs a header on its GET.

### Low priority for dialog-only data

A resource that only elements inside a `<dialog>` read is preloaded with `fetchpriority="low"` and
fetched with low priority, so it does not compete with what the visitor sees.

## Google Fonts

A page's `<link rel="stylesheet" href="https://fonts.googleapis.com/css...">` is downloaded at
build time and bundled as one of your CSS files, and the page gets a preconnect to the font files'
origin. The fonts and their look are unchanged; the page loses a render-blocking request to another
origin. It is a file, not an inline `<style>`, so your CSP needs no change.

Downloads are cached in `node_modules/.cache/sinter/fonts`. If a build cannot download, it keeps
the link and warns. `sinter({ fonts: { inline: false } })` turns this off.

To preload a face, opt in: `sinter({ fonts: { preload: ['Inter', { family: 'Inter', weight: 700 }] } })`
(a bare family means its regular face, 400 normal). A preload can make the first paint later,
because it competes with render-blocking files and text in that face waits for it, so measure.
The build fails if a page preloads a face none of its stylesheets use. Stylesheets on other
origins (an icon font's CSS) are left alone.

## Page chrome outside data templates

Chrome renders before the page script only outside data templates. A `data-sn-if="user"` around
the navigation hides it until the user has loaded:

```html
<!-- Good: the nav is in the first frame, only the name waits -->
<nav data-sn-state="{ collapsed: false }">
  <input type="checkbox" data-sn-model="collapsed" data-sn-persist="nav-collapsed">
  <a href="/mail/"><span data-sn-text="m.mail()"></span></a>
  <template data-sn-if="user"><span data-sn-text="user.name"></span></template>
</nav>
```

Put only what needs data inside the template. The complete version is in
[docs/recipes/first-paint.html](recipes/first-paint.html).

## Turning it off

| To | Do |
| --- | --- |
| Turn off all first-paint work for the app | `sinter({ firstPaint: false })`: everything waits for the page script |
| Keep one resource out of preload and early request | `<sn-resource early="off">` |
| Skip Google Fonts bundling | `sinter({ fonts: { inline: false } })` |
| Leave out next-page data and Speculation Rules | `sinter({ prefetch: false })` or `<html data-sn-prefetch="off">`, see [navigation.md](navigation.md) |

## Testing

`firstPaint` from the testing module returns the page as the browser shows it before the page
script runs: build-time constants, then the early script.

```ts
import { firstPaint } from '@tiaforge-ui/sinter/testing';

localStorage.setItem('sn:nav-collapsed', 'true');
const { root, html } = await firstPaint(pageHtml, { helpers, storage: localStorage });
expect(root.querySelector('a[aria-current]')?.getAttribute('href')).toBe('/mail/');
```

Options: `helpers`, `files`, `storage` (a `Storage` holding persisted values, keys prefixed `sn:`), `messages`, `locale`, and
`early`, a function standing in for your `src/sinter.early.ts`.

To test the takeover, pass `firstPaint` to `render`: `render(html, { firstPaint: { early, afterEarly } })`
mounts over that first paint, and `afterEarly` runs in between, so a test can assert what mounting
changes (it should be nothing).

## The head

Bindings in the head follow the same rules: in a page's head, a [layout's](layouts.md) or a head
component's, `<title data-sn-text>` and the `content` of a `<meta name|property|itemprop>` are
written into the HTML when they are build-time constants and rendered by the early script when it
knows their inputs, as the head is parsed. A value from a request renders when it arrives. Scrapers
that run no script (most link previews) see what is in the HTML: the constants, and the literal
content of the rest, so give each bound element a good fallback: `<title data-sn-text="…">My
Blog</title>`.

## Related

- [navigation.md](navigation.md): next-page data, Speculation Rules and page transitions, for the
  frame after a click.
- [images.md](images.md): `width`/`height`, `srcset` and placeholder colors, so images do not shift
  the layout.
- [first-paint-comparison.md](first-paint-comparison.md): measurements.
