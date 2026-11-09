# Between pages: next-page data, Speculation Rules, page transitions

A sinter app is multi-page: every navigation is a page load. Three things make that load feel
instant, and none needs code in the pages:

| | What it does | Browsers |
| --- | --- | --- |
| [Next-page data](#next-page-data) | requests the next page's data while the pointer rests on its link; the page shows it at its first paint | all |
| [Speculation Rules](#speculation-rules) | the browser fetches the next page's HTML (or prerenders the whole page) | Chromium |
| [Page transitions](#page-transitions) | pages cross-fade; `data-sn-transition` morphs a list row into its detail page | Chromium, Safari 18.2+ |

## Content Security Policy

> **With a CSP, Speculation Rules need a decision.** By default sinter writes them into every page
> as an inline `<script type="speculationrules">`, and a policy like `script-src 'self'` blocks
> it: the browser logs a violation and prefetches nothing. Everything else on this page works
> under `script-src 'self'` as it is.

Two ways out, checked in Chromium (2026-11-09):

**1. Deliver the rules with a response header (no CSP change).** Recommended for a strict CSP:

```js
// vite.config.js
sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })
```

The build writes `speculation-rules.json` at the site root and no inline script. Your server
then has to do two things:

- send `Speculation-Rules: "/speculation-rules.json"` with every page (under Vite's `base`:
  `"/app/speculation-rules.json"`; the build log prints the exact value);
- serve that file as `Content-Type: application/speculationrules+json`. A file served as
  `application/json` (what most static hosts do for `.json`) is rejected.

`vite dev` and `vite preview` do both for you. For a host, for example:

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

**2. Allow the inline rules.** Add `'inline-speculation-rules'` to `script-src`, or the hash the
build prints (`sha256-…`; it changes when the app's pages change). This keyword allows
speculation rules only, no other inline script.

A server-rendered page, or one injected by JavaScript, is no way around it: rules added from
script are still inline and still blocked.

What `e2e/navigation` checks: pages sent with `script-src 'self'` and the header, no violation on
either page, and the HTML prefetched.

## Next-page data

When a link to another page of the app is about to be followed, sinter requests the data that
page loads first and stores it for it (sessionStorage, 30 s). The next page shows it at its first
paint, then revalidates; `$meta.<name>.loadedAt` stays `null` until the server answers, as with
`cache`.

- **When:** the pointer rests on the link for 65 ms, or it has focus that long; a mouse press
  starts at once; a touch waits 65 ms and a scroll that starts on the link requests nothing. Not
  with `navigator.connection.saveData` or on 2g.
- **What:** the resources of the target page whose `src` and `when` read only `$url`, constants
  and your helpers (not state, other resources, `$now`, paginated, `each`, `call` or embedded
  ones). Data the current page already loaded from the same request is handed over, no request.
- **Which links:** same-origin links to one of the app's pages, matched by the pages'
  `data-sn-path` patterns (or their file paths). Give pages `data-sn-path` so `/article/slug`
  finds `article.html`.
- **Requests** go through your middleware (auth headers apply) with low priority. A failed one is
  dropped and never starts `onUnauthorized` or a login redirect. Any mutation drops what was
  prefetched.
- **Off:** `sinter({ prefetch: false })`; for one page, see [Opting a page out](#opting-a-page-out).
- **Testing:** `render(html, { pages: { 'article.html': articleHtml } })`.

## Speculation Rules

Every page gets rules for the links to the app's pages (eagerness `moderate`: the pointer rests
on a link, or a press starts). Links that download, open elsewhere (`target`) or are
`rel="nofollow"` are left out.

```js
sinter({ speculation: 'prefetch' })    // default: the next page's HTML
sinter({ speculation: 'prerender' })   // the whole page, data included, before the click
sinter({ speculation: false })         // none
sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })   // see Content Security Policy
```

`'prerender'` runs the next page before anyone sees it: its requests go out, its islands start.
Streams (`<sn-sync>`) wait until the page is shown, and then every resource is refetched (it may
have loaded minutes earlier). Keep it for apps whose pages do nothing on load but read.

## Opting a page out

`<html data-sn-prefetch="off">`: no other page prefetches this page's data or HTML, or
prerenders it. For a page that does something when it loads, such as a logout page that clears
the session. It is decided at build time; the attribute does not stay in the page. Links cannot
be opted out one by one: the browser's rules can only skip a link by something in the page.

## Page transitions

**The fade** is one CSS rule, `@view-transition { navigation: auto; }`. temper has it on by
default (off with `@view-transition { navigation: none; }` in your CSS); without temper, add it to
your stylesheet. Reduced motion turns it off.

**The morph:** give the same name to an element in a list row and to the element it becomes on
the detail page:

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
  responses arrive: render the element from `$url`, `cache`, prefetched or embedded data. A list
  you morph back into needs `cache` on its resource, or its rows arrive too late and it only fades.
- One morph per navigation; navigations sinter starts itself (a redirect) do not morph.
