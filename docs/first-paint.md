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
know, and gets no space. The list may be the resource itself (`p in people`) or a choice between
resources (`a in list` with `data-sn-let="{ list: $url.feed ? feed : articles }"`, or a resource with a
`when`): then the placeholder is a branch the early script shows while one of them loads with no rows,
when it can tell (their `when` reads only the URL), so a resource that will not load holds nothing.
That branch's `<template>` stays after the rows once they are in, so a `:last-child` rule (or
`:nth-last-child()`, `:only-child`) never matches one of them; the space counts it the same way. Either
form needs the load to start when the page module mounts: a `src` or `when` that reads state or another
resource holds nothing.

How large: what the stylesheets say about each row in its place (`.row + .row`, `:first-child`,
Tailwind's `space-y-*` and `:nth-child()` rules are decided per row), at each screen width the media
queries split, and for any default font size a visitor has set (sizes in `rem` and `em` shrink with a
smaller one, and so does the space).

- A height the stylesheets fix (`height`, `block-size`, a grid's `grid-auto-rows`) is exact: the rows
  take exactly the space held.
- Otherwise the space is a lower bound for the layouts the build follows, never taller than the rows
  (a differential test lays random lists out in Chromium against it): a bound text counts as one
  line, an empty one too (as with fewer rows than a page, the space is then taller than what arrives),
  a `data-sn-if` or `data-sn-show` inside the row, a nested list, a float, the content of a
  closed `<details>`, a negative margin it cannot read, an element a binding may hide, or anything the
  cascade cannot decide counts as nothing. Lists it does not follow hold nothing: rows a component's
  own `<style>` reaches, a grid with explicit `grid-template-rows`, `zoom`, rows side by side without
  a width. A rule that may or may not apply (`:hover`, `@media (hover: none)`, `@supports`) counts at
  its least. An image with `width` and `height` counts as tall as the width it has at each screen width
  allows (`max-width: 100%`); form controls in their own font and line height; a link around a card's
  blocks as the blocks stacked; a branch and its `data-sn-else` as the lesser; `<br>` as a line. Text that
  wraps makes the rows taller than the space, and what follows moves by the difference, not by the whole
  list.
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
- A height that follows the container's width (square cards in columns, a font size in `vw`) is held
  as a share of that width, exact at every width.
- Table rows in a `<tbody>`: each as tall as its tallest cell, with the table's vertical `border-spacing`
  between them (2 px by default; none with `border-collapse: collapse`, where the cells' borders count as
  nothing). The placeholder is a `<tr>`. With `table-layout: auto` the columns may still widen when the
  rows' text arrives: `table-layout: fixed` keeps them.

When fewer rows arrive than were held (the last page, an empty list), what follows moves up by
what is missing. Measured with the API answering after 500 ms (Chromium, 1280 px and 412 px wide,
`page-size="12"` with content below; a list of 56 px rows, a three-column grid of 160 px cards, a table
of one-line rows with collapsed borders; the median of 3 loads):

| Rows that arrive | List, without / with | Grid, without / with | Table, without / with |
| --- | ---: | ---: | ---: |
| 12 of 12, desktop | 0.081 / 0 | 0.102 / 0 | 0.083 / 0.001 |
| 12 of 12, phone | 0.183 / 0 | 0.227 / 0 | 0.242 / 0.003 |
| 7 of 12, desktop | 0.073 / 0.034 | 0.096 / 0.024 | 0.048 / 0.030 |
| 7 of 12, phone | 0.214 / 0.076 | 0.279 / 0.052 | 0.141 / 0.088 |
| none, desktop | 0 / 0.081 | 0 / 0.102 | 0 / 0.081 |
| none, phone | 0 / 0.183 | 0 / 0.227 | 0 / 0.235 |

(The table's 0.001 is its collapsed borders, which count as nothing.)

Builds only (`vite dev` serves the rules with the page module, after the first paint, so it writes no
placeholders; it plans them the same way, so `SN529` says what a build says). Not for a resource
with embedded data (its rows are in the first frame), with a `src` or `when` over state or another
resource (the build cannot tell whether it loads at mount), `each` or `call`, rows a component's own
`<style>` reaches, or a list that is more than a choice between
resources (`people.filter(…)`: the build cannot count it), nor for rows side by side without a width of
their own (or with a `flex-basis`), absolutely positioned, with `content-visibility`, table rows outside
a `<tbody>`, or a template with more than one element. The build prints each paginated list it holds no space for, and why
(`sinter: index.html:43: no space held for this list's rows before its data: …`).
`sinter({ firstPaint: false })` turns it off with the rest of the first-paint work.

A "Loading…" branch over the same status right before the list (`$meta.people.loading && !people.length`,
one element) takes the placeholder's place: while it shows it has the rows' height and outer margins, and
the placeholder does not show. Any other loading indicator over the same status, anywhere on the page (a
branch after the list, a spinner in the header, a `data-sn-show`), leaves the list without one, as the two
together would be taller than the rows. The build reads each condition over the status (it does not run
it): an empty state, an error, or anything that cannot show while the resource loads with no rows never
meets the placeholder; a condition it cannot read counts as one that may show.

The runtime carries no code for it: the build writes the placeholder's removal as one of the page's own
bindings (about 60 bytes gzip per list; a branch for a list with a `when`), and its rules (about 180 bytes
gzip for a page with one list) in the page's stylesheet, which is one more stylesheet file for a page that
had none of its own (Vite merges it into the page's stylesheet when it has one): one shared rule per page,
then each list's height (and width, margins or grid span) per screen width, with the weight of an id, so
the author's rules for the row's tag do not reach it.

The build does the work: following the stylesheets for each list, at each screen width and default font
size. RealWorld (7 pages, a Bootstrap-sized theme) builds in 2.09 s against 1.93 s without it.

### A box whose width follows the list

A list inside a box whose width the stylesheets leave to its content (a flex item in a row with no
`flex-basis` or `width`, or a float) has a different problem: empty, the box is narrow and what is
beside it sits next to it; the rows widen it, and its neighbours move or wrap to the next line. When
the rows have a width of their own, the placeholder takes it, and the box is as wide from the first
frame. Otherwise the data decides the width, and no space the build could hold keeps the neighbours in
place. So, in a build, what follows the box stays invisible (`visibility: hidden`: laid out, not shown)
while the list's first rows load, and shows with them: what moves is not shown, so nothing visible
shifts. The build prints each box it does this for:

```
sinter: index.html:43: what follows <div.col-md-9> stays hidden while this list's first rows load: its width follows its content (below 768 px), so they would move it; data-sn-wait="off" on it keeps it shown
```

- Only at the screen widths where the box follows its content (RealWorld's theme: below 768 px; from there
  the columns have a width, and nothing is hidden), and only the boxes after it in its container.
- Only the first load: the list's resource that always loads, until it has rows or no load is running
  (the marker that hides them is removed for good); a choice between resources, while one the early script
  knows (`src` and `when` over the URL) makes its first load (`!$meta.<name>.loadedAt`). One it cannot tell
  (RealWorld's "Your Feed", whose `when` waits for the user) hides nothing. Cached rows show at once, so
  nothing is hidden then either.
- For at most 3 s, whatever happens (an animation in the rule): a page script that never runs leaves
  nothing hidden for good.
- It needs `:has()`; a browser without it shows them, and they move, as before.
- While they are hidden they are out of the accessibility tree and tab order, and their content
  (RealWorld's popular tags) shows only with the list: when what follows matters on its own, or holds the
  page's largest content, give the box a width of its own instead (`flex: 1 1 0`, or a basis of 100% where
  it takes the line, as grid systems do below their breakpoint), or give the rows one.

`data-sn-wait="off"` on the box keeps what follows it shown, and the build reports `SN529` instead,
naming the screen widths where the rows move it. The rules are 154 bytes in the page's stylesheet
(142 gzip on their own), and the marker a branch or a binding of the page; dev plans the same and hides
nothing. Measured on RealWorld's home page under the same conditions as the other implementations (the
API answering after 150 ms with 10 articles, 5 runs): Lighthouse mobile CLS 0.151 → 0.000, performance
93 → 100 (99–100), first and largest paint unchanged (1.53 s) ([bench/realworld/fair](../bench/realworld/fair/README.md)).

An image without a height in rows that arrive late (no `width` and `height` attributes, no `aspect-ratio`
or height in CSS) grows its row again when its file loads: `SN530`.

### Loading branches

The early script knows a resource's status when the page module mounts: no data, and loading if its
`when` holds (or it has none). So a branch over it renders before the first paint, and the page module
adopts it:

```html
<template data-sn-if="$meta.people.loading && !people.length"><p>Loading…</p></template>
```

That holds for a resource that is not embedded, `each` or `call`, whose `src` and `when` read only what the
early script knows (`$url`, `$now`, `$locale`, your helpers; not state, another resource or the
built-in formatters such as `date()`). With `cache`, or in an app with next-page data, only
in a tab that holds no cached or prefetched rows of that resource: otherwise they are there at mount.
A branch the status closes at mount whatever the load does (`data-sn-if="user"`, an error, "loaded and
empty") is left out of the early script: the HTML shows it closed already.
`loading`, `error` and `loadedAt` are known, also through a `data-sn-let` of the whole status; other status
fields (a page number) are the page module's, and a binding that reads one renders when it mounts. The values are compiled into the page's early file: its
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
