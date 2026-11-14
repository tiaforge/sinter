# Between pages: next-page data, Speculation Rules, page transitions

A sinter app is multi-page: every navigation to another page is a page load. Three things make that
load feel instant, and none needs code in the pages:

| | What you get | Browsers |
| --- | --- | --- |
| [Next-page data](#next-page-data) | The next page's data is requested while the pointer rests on its link, and the page shows it at first paint. sinter does this. | all |
| [Speculation Rules](#speculation-rules) | The browser fetches the next page's HTML, or prerenders the whole page. sinter generates the rules and [handles your CSP](#speculation-rules-and-a-content-security-policy). | Chromium |
| [Page transitions](#page-transitions) | Pages cross-fade (a CSS rule that temper enables). `data-sn-transition` morphs a list row into its detail page. Both use the browser's view transitions. | Chromium, Safari 18.2+ |

Where a browser lacks a feature, navigation is a normal page load.

Within a page, [the URL and the history](#the-url-and-the-history) behave as in a single-page app:
Back steps through the filters and pages the user chose. A link that changes only the query is to a
sinter page what a `#hash` link is to any page: [it stays on the page](#same-page-links).

## Next-page data

Nothing to write. When a link to another page of the app is about to be followed, sinter requests
the data that page loads first. The next page shows it at its first paint, then revalidates;
`$meta.<name>.loadedAt` stays `null` until the server answers, as with `cache`.

- **When:** the pointer rests on the link for 65 ms, or the link has focus that long. A mouse press
  starts at once. A touch waits 65 ms, and a scroll that starts on the link requests nothing. Skipped
  with `navigator.connection.saveData` or on 2g.
- **What:** the resources of the target page whose `src` and `when` read only `$url`, constants and
  your helpers. Resources that read state, other resources, `$now`, or that are paginated, `each`,
  `call` or embedded, are not prefetched. Data the current page already loaded from the same
  request is handed over without a new request.
- **Which links:** same-origin links to one of the app's pages, matched by the pages' `data-sn-path`
  patterns (or their file paths). Give pages a `data-sn-path` so that `/article/slug` finds
  `article.html`.
- **Requests** go through your middleware (auth headers apply) with low priority. A failed one is
  dropped and never triggers `onUnauthorized` or a login redirect. Any mutation discards what was
  prefetched.
- **Off:** `sinter({ prefetch: false })`; for one page, see [Opting a page out](#opting-a-page-out).
- **Testing:** `render(html, { pages: { 'article.html': articleHtml } })`.

## Speculation Rules

The browser does the fetching; sinter writes the rules into every page. They cover links to the
app's pages, with eagerness `moderate` (the pointer rests on a link, or a press starts). Links
that download, open elsewhere (`target`) or are `rel="nofollow"` are left out.

```js
sinter({ speculation: 'prefetch' })    // default: the next page's HTML
sinter({ speculation: 'prerender' })   // the whole page, data included, before the click
sinter({ speculation: false })         // none
sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })   // by a response header; see the CSP section
```

`'prerender'` runs the next page before anyone sees it: its requests go out and its islands start.
Streams (`<sn-sync>`) wait until the page is shown, and then every resource is refetched, since it
may have loaded minutes earlier. Use it for apps whose pages do nothing on load but read.

## Speculation Rules and a Content Security Policy

> **With a CSP sent as a response header, add `'inline-speculation-rules'` to its `script-src`.**
> sinter writes the rules into every page as an inline `<script type="speculationrules">`, which
> needs no server setup, but a policy like `script-src 'self'` blocks it: the browser logs a
> violation and prefetches nothing. Next-page data still works. Dev builds warn in the console when
> this happens.

| Your setup | What to do |
| --- | --- |
| No CSP | nothing |
| CSP in the page (`<meta http-equiv="Content-Security-Policy">`) | nothing: the build adds the rules' hash to it |
| CSP header with a nonce, through Vite's `html.cspNonce` | nothing: Vite puts the nonce on the rules script, in build and dev |
| CSP sent as a response header | add `'inline-speculation-rules'` to its `script-src` (or the hash the build prints), or deliver the rules by header (below) |

`'inline-speculation-rules'` allows speculation rules only, no other inline script. The hash
(`sha256-…`, printed by the build when a page has no CSP `<meta>`) allows exactly these rules and
changes when the app's pages change. A policy that already allows inline scripts
(`'unsafe-inline'`) needs nothing; the build leaves such a `<meta>` as it is, since adding a hash
would turn `'unsafe-inline'` off for other inline scripts.

Everything else on this page, and the script that holds the first paint, works under
`script-src 'self'` as is.

### Delivering the rules by a response header

No CSP blocks rules delivered this way:

```js
sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })   // or mode: 'prerender'
```

The build then writes `speculation-rules.json` at the site root and no inline script. Your server
has to:

- send `Speculation-Rules: "/speculation-rules.json"` with every page (under Vite's `base`:
  `"/app/speculation-rules.json"`; the build log prints the exact value);
- serve that file as `Content-Type: application/speculationrules+json`. The browser rejects
  `application/json`, which most static hosts use for `.json`.

`vite dev` and `vite preview` do both. For a host, for example:

```nginx
# nginx
location = /speculation-rules.json { default_type application/speculationrules+json; }
add_header Speculation-Rules '"/speculation-rules.json"';
```

```text
# Netlify / Cloudflare Pages: _headers in the build output
/*
  Speculation-Rules: "/speculation-rules.json"
/speculation-rules.json
  Content-Type: application/speculationrules+json
```

Browsers load Speculation Rules only as inline JSON (also when a script adds them) or from that
header. `<script type="speculationrules" src>` is not supported, and there is no `<link>` or
`<meta http-equiv>` form. A `<link rel="prefetch">` hint is no substitute: Chromium reuses its
response for the navigation only when the page is served cacheable (`max-age` above 0), which most
hosts do not do for HTML.

## The URL and the history

`$url` is bindable: `data-sn-model="$url.q"` on a search field, `$url.sort` on a select,
`page-model="$url.page"` on a list ([Page in the URL](pagination.md#page-in-the-url)). Back and
Forward then restore what the user saw, reload and shared links show the same. The kind of entry is
decided where the write happens:

| Write | History |
| --- | --- |
| a handler run by the user's event (a click, a select's `change`), and what it causes (`emit`, an action it started and that action's `then`/`catch`) | new entry |
| a select, radio or checkbox model; a component's model | new entry |
| a number or range model | at its pause (250 ms): a burst of steps (spinner clicks, arrow keys) is one new entry, a later change another |
| `page()` | new entry |
| a text-field model: typing | at each pause (250 ms); the first commit of a typing run adds an entry, later ones replace it |
| a handler on `input` (a keystroke) | replaces, at once; on a checkbox, radio or select itself it is a choice: a new entry |
| a resource's or stream's `then`, `sn-error` handlers, anything no user event caused | replaces |
| a list's reset to page 1 after its URL changed | replaces (with a typing commit waiting, it goes into that one) |
| a [same-page link](#same-page-links) | new entry: the link's URL, as written |
| Back, Forward | writes nothing |

A typing run ends at a new entry, at `change` on the field (Enter, or leaving it, which a click on a
link does before navigating) and at Back or Forward. So typing "foo", Enter, then "bar" gives two
entries; typing slowly, pausing between words, gives one. There is no attribute to change these
rules, and no other pause.

| You do | URL | Back |
| --- | --- | --- |
| type "sinter" | `?q=sinter` | before the search |
| pick a tag | `?q=sinter&tag=go` | before the tag |
| page › twice | `…&page=3` | page 2 |
| change the tag on page 3 | `…&tag=js`, `page` removed | page 3 with the old tag |
| open a result, Back | | the same results (usually from the bfcache) |

- One flush writes the URL once, the strongest kind winning; a write that does not change the query
  does nothing. The other parameters keep their order; path parameters (`data-sn-path`) stay in the
  path and are read-only: changing one is a link to another page.
- Values are written as a reload reads them: numbers as strings (`0` is `'0'`), `true` as `'1'`;
  `false`, `null`, `undefined`, `''` and `[]` delete the parameter. A handler that reads its own write
  sees the string; `+$url.page` gives a number. `'0'` is truthy, as in JavaScript.
- A parameter bound to a `<select multiple>` or to checkboxes with a `value` is a list, decided at
  build time: `?tag=go&tag=js` reads as `['go', 'js']`, no parameter as `[]`. A single value written to
  it is wrapped. Test it with `$url.tag.length` (a bare list is always truthy: SN211); a parameter
  bound as a list in one place and one value in another is SN210.
- Browsers refuse history calls made too often (Safari throws): sinter keeps `$url` and warns in dev.

## Same-page links

A plain click on a link to the page itself that changes only query parameters the page reads stays
on the page: a new history entry, and the page shows what loading the link's URL would show. Only
the state you made (`data-sn-state`) and the scroll position stay. Nothing to write:

```html
<a data-sn-attr="{ href: '?tag=' + encodeURIComponent($url.tag) + '&page=' + n }" data-sn-text="n"></a>
<a href="?feed=following">Your feed</a>
```

- **Which clicks:** the primary button without Ctrl, Cmd, Shift or Alt, on a link with the same
  origin and path (path parameters included: `/tag/go?page=2` → `/tag/go?page=3` stays,
  `/tag/go` → `/` loads), when every parameter that differs is one the page reads (`$url.<name>`).
  A link with `download`, a `target` other than `_self` or `rel="external"`, a click a handler
  prevented, and a parameter the page does not read (`?lang=de`, one a server or an island acts on)
  load the URL as before. Middle-click and Ctrl/Cmd-click open a new tab, as always.
- **What follows:** `$url` takes the link's query, and everything that reads it follows as after
  Back or Forward: a [`page-model`](pagination.md#page-in-the-url) list loads the link's page, so
  `?tag=js&page=3` shows page 3 and `?tag=js` page 1. A text field's pending typing gets its own
  entry first. A link to the current URL changes nothing. A `#hash` in the link is followed by the
  browser, in the new entry.
- **What it does not do:** no other path or page (that is a page load, always); no cross-document
  view transition (the list keeps its rows until the response, as with `page()`); no
  `<form method="get">` (bind the field instead: `data-sn-model="$url.q"`).
- **Which pages:** the build loads it (`@tiaforge-ui/sinter/query-links`, about 0.7 KB gzip) on a
  page that reads a query parameter by name and has a link it can see goes to the page: a static
  `href` (`?page=3`, the page's own URL or its file, `about.html?q=1`), or a `data-sn-attr` `href`
  that starts with one (followed through `+`, template literals, `?:`, `||` and `??`). A link it
  cannot see (an `href` from data, a helper, a link an island renders) loads its URL, as before. A
  page that reads `$url` whole or by a computed name (`$url[k]`), or has a `<base href>`, does not
  load it: every link loads. The same link in a layout stays on one page and loads from another: it
  depends on what each page reads. A parameter that is a path parameter (`/tag/:tag`) is not a
  query parameter the page reads, on any of its paths, as for `$url` writes.
- **Building the query:** `href="?page=3"` keeps only `page`, as any URL resolves: on `?tag=go` it
  drops the tag. Build the whole query. A pager link (a static query-only `href` that sets a
  `page-model` parameter) that drops other parameters the page reads is SN519; a filter or tab
  link that drops the page is how the list starts at page 1, and needs nothing.
- Next-page data leaves same-page links alone. Speculation Rules on such a page leave out its own
  path with any other query, so a link there that changes a parameter the page does not read
  (and loads) is not prefetched either.
- A history call the browser refuses (Safari, called too often): the link loads.

For a pager, links are the recommended form: crawlable, a new tab, copy link, and on the page with
this. `page('next')` stays for relative moves and buttons. A pager link should carry
`aria-current="page"` for the active page.

## Opting a page out

`<html data-sn-prefetch="off">`: no other page prefetches this page's data or HTML, or prerenders
it. Use it for a page that does something when it loads, such as a logout page that clears the
session. The attribute is read at build time and does not stay in the page. Links cannot be opted
out one by one: the browser's rules can only skip a link by something in the page.

## Page transitions

**The fade** is one CSS rule, `@view-transition { navigation: auto; }`, which the browser applies.
temper has it on by default (turn it off with `@view-transition { navigation: none; }` in your
CSS); without temper, add it to your stylesheet. Reduced motion turns it off.

**The morph:** give the same `data-sn-transition` name to an element in a list row and to the
element it becomes on the detail page:

```html
<!-- list -->
<template data-sn-for="a in articles">
  <a data-sn-attr="{href: '/article/' + a.slug}"><h2 data-sn-transition="'article-' + a.slug" data-sn-text="a.title"></h2></a>
</template>

<!-- article.html, data-sn-path="/article/:slug" -->
<h1 data-sn-transition="'article-' + $url.slug" data-sn-text="article.title"></h1>
```

- Following the row's link morphs one into the other; going back morphs it back.
- Only that pair is named, and only during the transition: a list of a thousand rows asks the
  browser to capture one element, not a thousand.
- Style all morphs with `::view-transition-group(.sn-transition) { animation-duration: 300ms; }`
  (the names themselves are hashes).
- **The element must be there at the page's first paint**, which is when the browser captures it.
  When a morph is pending, sinter holds that paint until the page has mounted, but not until
  responses arrive. Render the element from `$url`, `cache`, prefetched or embedded data. A list
  you morph back into needs `cache` on its resource, or its rows arrive too late and it only fades.
- One morph per navigation. Navigations sinter starts itself (a redirect) do not morph.
