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
| Your API, without it | after one round trip, started before the page script runs | [Requests start early](#requests-start-early); its list's space and its loading branch are in the first frame: [reserved space](#reserved-space) |

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
time: its branch (or its `data-sn-else`) is page markup, written and painted like the rest. A
`data-sn-for` over a constant list (a literal, a prop given as one, state nothing writes) whose rows read
only the item, its index and constants is unrolled at build time: its rows are page markup too.

A page where all of it is constant has nothing left to run, and ships no JavaScript at all: see
[pages without JavaScript](static-pages.md).

## The early script

Anything that needs a little code, but no data, is rendered by an early script that runs before
the first paint:

- messages, in the language picked from the visitor's saved choice or browser settings
- persisted values (`data-sn-persist`)
- state fields initialized by helpers or `$locale`
- the URL: `$url`'s query and its `data-sn-path` parameters (the current nav item, a tab from `?feed=`)
- `data-sn-if` branches over that state
- a resource's status before its data: no rows yet, and loading when it will load (`$meta.<name>.loading`,
  `.error`, `.loadedAt`), so a "Loading…" branch is in the first frame ([below](#loading-branches))
- your own code in `src/sinter.early.ts`

Each page gets two small classic scripts first in the head, before the stylesheets: one shared by
every page (so it is cached across pages) and one with the page's own bindings. Nothing hides the
page while they run. They render each element as the browser parses it, before it can be painted,
so there is no flash in Chromium, Firefox or Safari. Attributes and classes are written as soon as
the element exists; its content once the parser has closed it.

The runtime then takes over: on mount it computes the same values, writes nothing new, and nothing
flashes or resets. Early code runs once and keeps no listeners.

What waits for the page script: `$url`, `$now`, `$meta` (but a resource's status before its data, [below](#loading-branches)), `$el`, loop variables, store functions and
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

[`sinter-axum`](../packages/sinter-axum#readme) is a ready-made layer for Rust (axum), and
[`Sinter.AspNetCore`](../packages/sinter-aspnetcore#readme) the same for ASP.NET Core (minimal
APIs and MVC, NativeAOT-compatible), and [`@tiaforge-ui/sinter/server`](server.md) for JavaScript, on
web-standard `Request` and `Response` (Node, Bun, Deno, Workers, Hono and other fetch handlers). Build with:

```js
// vite.config.js
sinter({ embed: true })
```

Every resource whose request the page's URL decides (its `src`, `when` and `page-model` read only
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
  `sinter-axum`, `Sinter.AspNetCore` and `@tiaforge-ui/sinter/server` do). The page script then does not mount. Pages never write that attribute
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
The build fails if a page preloads a face none of its stylesheets use (in a `font-family` or
`font` declaration, directly or through a custom property: `font-family: var(--font-sans)`). Stylesheets on other
origins (an icon font's CSS) are left alone.

### Self-hosted fonts

The bundled Google Fonts CSS still loads the font files from `fonts.gstatic.com`: each visitor's
browser contacts Google, and a CSP needs `font-src https://fonts.gstatic.com`. To serve the files
yourself, use a local font package instead of the link, for example
[Fontsource](https://fontsource.org): `npm install @fontsource-variable/figtree`, then
`import '@fontsource-variable/figtree';` in your page module (or `@import` it in your stylesheet).
Vite bundles the font files as hashed assets, so `font-src 'self'` is enough.

`preload` works for these too: a face no Google Fonts stylesheet has is looked up in the
`@font-face` rules of the page's own bundled CSS, and the page preloads its Latin file (the one
whose `unicode-range` covers Latin letters). Use the family name the package declares:
`sinter({ fonts: { preload: ['Figtree Variable'] } })`. A variable face covers every weight in
its range with one file, so one preload covers them all. In dev, local faces are not preloaded.

## Heavy packages

A package only some interactions need (crypto, charts, a PDF renderer) does not have to be on the
first paint's path: `sinter({ lazy: ['openpgp'] })` loads it on first call. Per page, in the markup,
`data-sn-import="openpgp"` loads it once the page has taken over, and `data-sn-preload="openpgp"`
fetches it with the page, for pages whose first content needs it. See [lazy packages](lazy.md).

## Reserved space

Without embedded data, a list's rows arrive one round trip after the first paint, and everything
below the list moves down to make room for them. For a list whose size the stylesheets give, the
build holds that room from the first frame:

```html
<sn-resource name="people" src="/api/people" items="people" key="id" paginate="offset" page-size="12"></sn-resource>
<ul><template data-sn-for="p in people"><li class="row" data-sn-text="p.name"></li></template></ul>
```

```css
.row { height: 56px; border-bottom: 1px solid #ddd }
```

The built page has an empty, `aria-hidden` element after the template, 12 × 57 px tall (from a rule in the
page's stylesheet: no inline style, nothing for a CSP to allow). The page module removes it in the same
update that inserts the rows, or as soon as no load is running (it ended empty or failed, or it never
started). Nothing moves when the rows arrive.

How many rows: a paginated resource's `page-size`. A list without pages has no count the build can
know, and gets no space.

How large: what the stylesheets say about the row, at each screen width the media queries split.

- A height the stylesheets fix (`height`, `block-size`, a grid's `grid-auto-rows`) is exact: the rows
  take exactly the space held.
- Otherwise the space is a lower bound, never taller than the rows: a bound text counts as one
  line, a `data-sn-if` or `data-sn-show` inside the row, a nested list, a float, the content of a
  closed `<details>`, a negative margin it cannot read, or anything the cascade cannot decide counts as
  nothing. An image with `width` and `height` counts as tall as the width it has at each screen width
  allows (`max-width: 100%`); form controls in their own font and line height. Text that wraps makes the
  rows taller than the space, and what follows moves by the difference, not by the whole list.
- Lines follow `line-height`. `normal` depends on the font, and the text may be in any face of its
  stack: a web font shows only once it has loaded (`font-display: swap`), and a family a platform
  lacks falls through to the next. So `normal` counts the least of them: each family the page
  ships (from its file, a local `@font-face`, Fontsource or Google Fonts, or the overrides of a
  fallback face: `ascent-override`, `descent-override`, `size-adjust`, `src: local(…)`), each
  system font the build has metrics for (Arial, Helvetica, Segoe UI, Roboto, San Francisco, Times
  New Roman, DejaVu, Noto and others), and the first generic family on every platform
  (`system-ui` is Segoe UI, San Francisco, Roboto or a Linux desktop's font; without one, the
  browser's default, serif). A family neither the page nor that table has metrics for (a web font
  from a stylesheet the build does not read, a font on the visitor's machine) counts as 1 × the font
  size. An explicit `line-height` avoids all of this: it is the same in every face.
- Widths: rows stacked in a block or a flex column take the container's width, as the placeholder
  does. Rows with a width of their own (`width` in px, rem, em) also work side by side in a flex row
  (the placeholder as wide as the rows and their gaps), and wrapping in one (as many lines as the
  container's width gives, at each screen width).
- Rows in a grid: the placeholder spans the grid rows the items fill, over every column (`auto-fill`
  and `auto-fit` columns are counted at each width).

When fewer rows arrive than were held (the last page, an empty list), what follows moves up by
what is missing. Measured with the API answering after 500 ms (Chromium, a list of 12 rows of 56 px
with content below it):

| Rows that arrive | Layout shift without | With reserved space |
| --- | ---: | ---: |
| 12 of 12 | 0.081 desktop, 0.183 phone | 0, 0 |
| 7 of 12 | 0.073, 0.214 | 0.034, 0.076 |
| none | 0, 0 | 0.081, 0.183 |

Builds only (`vite dev` serves the rules with the page module, after the first paint). Not for a resource
with embedded data (its rows are in the first frame), with `when` (it may not load), `each` or `call`, or a
list that is not the resource itself (`people.filter(…)`: the build cannot count it), nor for rows side
by side without a width of their own (or with a `flex-basis`), absolutely positioned, with
`content-visibility`, or a template with more than one element.
`sinter({ firstPaint: false })` turns it off with the rest of the first-paint work.

The runtime carries no code for it: the build writes the placeholder's removal as one of the page's own
bindings (about 65 bytes gzip per list), and its rule in the page's stylesheet: one shared rule per page,
then each list's height (and width, margins or grid span) per screen width, with the weight of an id, so
the author's rules for the row's tag do not reach it.

### A box whose width follows the list

A list inside a box whose width the stylesheets leave to its content (a flex item in a row with no
`flex-basis` or `width`, or a float) has a different problem: empty, the box is narrow and what is
beside it sits next to it; the rows widen it, and its neighbours move or wrap to the next line. When
the rows have a width of their own, the placeholder takes it, and the box is as wide from the first
frame. Otherwise the data decides the width, and the build reports it, `SN520`: give the box a width
of its own (`flex: 1 1 0`, or a basis of 100% where it takes the line, as grid systems do below their
breakpoint), or give the rows one.

### Loading branches

The early script knows a resource's status when the page module mounts: no data, and loading if its
`when` holds (or it has none). So a branch over it renders before the first paint, and the page module
adopts it:

```html
<template data-sn-if="$meta.people.loading && !people.length"><p>Loading…</p></template>
```

That holds for a resource that is not embedded, `each` or `call`, whose `when` reads only what the early
script knows (`$url`, `$now`, helpers; not state). With `cache`, or in an app with next-page data, only
in a tab that holds no cached or prefetched rows: otherwise they are there at mount. `loading`, `error`
and `loadedAt` are known (and the whole status of a resource without pages or a stream); other status
fields (a page number) are the page module's. The values are compiled into the page's early file: its
runtime is the same.

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
- [lazy.md](lazy.md): packages loaded on first call, or when an element renders.
