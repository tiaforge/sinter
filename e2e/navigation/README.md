# Navigation e2e: next-page data, Speculation Rules, morphs

sinter across page loads in headless Chrome: what only a real browser shows, beside the fakes in
`test/behaviour/prefetch.test.ts`, `speculation.test.ts` and `transition.test.ts`.

Two pages: a list ([`index.html`](index.html), served at `/`) and an item page
([`item.html`](item.html), `/item/:id`). [`server.mjs`](server.mjs) serves the build and a JSON API
on the same origin (no request interception: that turns prerendering off), logs every request with
its `Sec-Purpose` header, and can slow the API down. It sends the pages as a strict deployment
would: `Content-Security-Policy: script-src 'self'`, and the Speculation Rules by the
`Speculation-Rules` header (the build uses `speculation: { delivery: 'header' }`, see
[docs/navigation.md](../../docs/navigation.md)).

The steps:

1. The list loads.
2. **Next-page data and Speculation Rules:** resting the pointer on an item's link requests that
   item's data (`GET /api/items/2`, sinter) and its HTML (`/item/2` with `Sec-Purpose: prefetch`,
   the browser).
3. **First paint with data:** with the API slowed to 1.5 s, following the link shows the
   prefetched title at the item page's first paint (`pagereveal`), from the prefetched HTML
   (`deliveryType: navigational-prefetch`), then the server's newer one.
4. **Morph:** the item's title morphed from its row (a `::view-transition-group(sn-…)` beside
   `root`), and no element keeps its `view-transition-name` afterwards.
5. **Morph back:** `history.back()` reloads the list (no back/forward cache under DevTools); with
   the API slowed again, its rows (from `cache`) are there at its first paint, held by the hold
   script, so the title morphs into its row.
6. **CSP:** no `securitypolicyviolation` on either page. With the default inline rules this step
   fails (and step 2 misses the HTML prefetch), checked 2026-11-09.

Not covered: prerendering (`sinter({ speculation: 'prerender' })`). Chrome does not prerender while
DevTools drives it (`PrerenderingDisabledByDevTools`); `test/behaviour/speculation.test.ts` covers
what sinter does when a prerendered page is shown.

```sh
npm install                       # in the repo root first: npm run build
CHROME=/path/to/chrome node run.mjs
CHROME=/path/to/chrome CHROME_ARGS=--no-sandbox node run.mjs    # as root, e.g. in a container
```

Building with `sinter({ prefetch: false })` makes steps 2 to 5 fail (checked 2026-11-09).
