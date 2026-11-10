# Between pages: next-page data, Speculation Rules, page transitions

A sinter app is multi-page: every navigation is a page load. Three things make that load feel
instant, and none needs code in the pages:

| | What you get | Browsers |
| --- | --- | --- |
| [Next-page data](#next-page-data) | The next page's data is requested while the pointer rests on its link, and the page shows it at first paint. sinter does this. | all |
| [Speculation Rules](#speculation-rules) | The browser fetches the next page's HTML, or prerenders the whole page. sinter generates the rules and [handles your CSP](#speculation-rules-and-a-content-security-policy). | Chromium |
| [Page transitions](#page-transitions) | Pages cross-fade (a CSS rule that temper enables). `data-sn-transition` morphs a list row into its detail page. Both use the browser's view transitions. | Chromium, Safari 18.2+ |

Where a browser lacks a feature, navigation is a normal page load.

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
