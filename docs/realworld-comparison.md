# RealWorld: sinter compared with other implementations

**How does a sinter app compare with the same app written with other tools?** RealWorld is a public
spec for a blogging app (Conduit) that many frameworks implement against the same API, with an official
end-to-end suite. Only implementations that pass that suite are compared here: a smaller or faster app that
does less is not the same app ([which were tested, and why some are not here](#official-e2e-suite)). Of those,
sinter has the fewest source lines, the best Lighthouse scores (100 on mobile and on desktop, its largest paint
in its first frame and no layout shift) and, with the first article, the least JavaScript but Backtick's
(a server-rendered app whose page code arrives inside its HTML, at a cost: its largest paint waits for the server).

Sinter's app runs at https://realworld.tiaforge.dev ([the server image](../examples/realworld/README.md#the-server-as-an-image)), and
[PageSpeed Insights](https://pagespeed.web.dev/analysis?url=https%3A%2F%2Frealworld.tiaforge.dev%2F) gives it a performance score of 100 (2026-11-26). The Lighthouse scores below are the same-conditions
measurements, not scores of that site: a score follows the machine that measures it (the same page scored 95 in a DevTools run on a
loaded desktop, whose CPU benchmark was 1,650 against 3,500 in the runs here), and the public API's data and the network change it too.

| implementation | e2e, spa / ssr mode | source lines (gz KB) | JS, home + article (gz KB) | Lighthouse mobile / desktop |
| --- | --- | ---: | ---: | ---: |
| **sinter** | **140/140** / **92 of 92** | **631** (9.3) | 67.5 | **100** / **100** |
| Angular | 140/140 / 91 of 92 | 2210 (15.5) | 123.1 | 85 / 76 |
| Vue 3 (official) | 140/140 / 91 of 92 | 1913 (11.9) | 72.3 | 77 / 76 |
| Solid + Backtick (server-rendered) | 105/140 / **92 of 92** | 1741 (13.0) | 14.9 + 8.3 in its HTML | 89 / 99 (2026-11-22) |

Measured on 2026-11-27 (sinter at 46426e1), every implementation built from source and served on one machine against
the same local API (Lighthouse: the median of 5 runs under [the same conditions](#the-same-conditions); e2e: the
official suite against a local backend, [below](#official-e2e-suite)); Backtick's Lighthouse scores, every ssr run and
the e2e runs of Angular, Vue 3 and Backtick are from 2026-11-22. Backtick's JS column counts Solid's two files; its
page code is an inline module in each page's HTML, given beside them ([below](#download-size)). In ssr mode the suite
skips 48 spa-only tests; an SSR app like Backtick cannot pass those by design, and sinter (a browser client) passes
both. Scripts: [`bench/realworld/loc.mjs`](../bench/realworld/loc.mjs) (source lines),
[`bench/realworld/fair/weight.mjs`](../bench/realworld/fair/README.md) (what the browser downloads:
[`weight.mjs`](../bench/realworld/weight.mjs) with every app served by the fair harness),
[`bench/realworld/fair/run.mjs`](../bench/realworld/fair/README.md) (Lighthouse under the same conditions),
[`bench/realworld/lighthouse.mjs`](../bench/realworld/lighthouse.mjs) (Lighthouse on the public demos).

| implementation | repo (commit) | framework (latest major on 2026-11-22) | architecture |
| --- | --- | --- | --- |
| sinter | `examples/realworld` (46426e1) | sinter | multi-page, compiled HTML, a browser client of the API |
| Angular | realworld-apps/angular-realworld-example-app (d426ec8) - the official demo | Angular 21.2 (22) | SPA |
| Vue 3 (official) | realworld-apps/vue-realworld-example-app (db749e3) | Vue 3.5 (3) | SPA |
| Solid + Backtick | backtickjs/backtick-solid-realworld-example-app (24976ac) | Solid 1.9 (2) | server-rendered (Hono) |

No RealWorld on Solid 2 or on Svelte 5 without SvelteKit was found; Backtick is the only Solid one that passes the
suite, and the only one still maintained. No client-side Solid RealWorld can stand in for it: of the four found
(2026-11-27), none passes the suite ([below](#official-e2e-suite)).

## Source size

Non-blank lines of app source (`loc.mjs`, the app's `src/`); tests, mocks, type declarations, generated code and
the shared theme CSS excluded. sinter on 2026-11-27 (46426e1), the others on 2026-11-22 at the commits above. sinter's pages are at its app's root, so its count also takes them, its Vite config
and its `apis.js` (the API config); the others' root config files are not counted. The gzip of the counted source
does not depend on how long a line is.

| implementation | files | lines | gzip (KB) |
| --- | ---: | ---: | ---: |
| **sinter** | 22 | **631** | **9.3** |
| Solid + Backtick | 21 | 1741 | 13.0 |
| Vue 3 (official) | 32 | 1913 | 11.9 |
| Angular | 53 | 2210 | 15.5 |

sinter's 631 are html 485, js 135 and css 11 (`src/fonts.css`, the faces of the fonts it serves itself). At 2fb0ea3
(2026-11-22) the same count was 606 (html 486, js 120): since then the fonts moved into the app and its config module
sends a public read again without the token (`publicReads`).

## Download size

Headless Chrome loads the home page, then opens the first article. Every JS and CSS response is
gzipped at level 9 by the script, so different compression does not skew the numbers. Every implementation is
served locally from its production build by the [same harness](#the-same-conditions) (`fair/weight.mjs`: the same local
API and recorded third-party files as the Lighthouse runs). sinter measured on 2026-11-27 (46426e1), the others on
2026-11-22 (Angular and Vue 3 again on 2026-11-27: the same numbers, but for one of Angular's four loads, whose home + article was 110.9 KB). The script counts script responses, not
JavaScript inside the HTML.

| implementation | JS, home (gz KB) | JS, home + article (gz KB) | JS, home + article (raw KB) | CSS (gz KB) | note |
| --- | ---: | ---: | ---: | ---: | --- |
| **sinter** | 35.2 | 67.5 | 176.9 | 15.2 | the Markdown parser (`@tiaforge-ui/sinter-markdown`) loads with the first article |
| Angular | 98.4 | 123.1 | 392.0 | 11.9 | |
| Vue 3 (official) | 48.7 | 72.3 | 201.6 | 13.6 | |
| Solid + Backtick | 14.9 | 14.9 | 38.6 | 14.8 | server-rendered. The columns are Solid 1.9.17's two files, from a CDN (import map), here served locally as minified copies of the same files, so the KB are approximate. They leave out the page's code, an inline module in each page's HTML: 4.4 KB gzip on the home page and 3.9 KB on the article, so about 19.3 KB on the home page and 23.2 KB with the article |

Backtick's inline code was measured on 2026-11-27 the way `weight.mjs` measures a file (gzip level 9 of what
arrives): its server (24976ac, `NODE_ENV=production`) against `bench/realworld/mock-api.mjs`, every inline
`<script>` but the import map of `/` and `/article/article-25`. On the home page that is 34.6 KB as served (its page
code is a URL-encoded `data:` import; 21.8 KB raw and 4.1 KB gzip decoded). Each of its pages is a page load that brings
its own module.

Every sinter page loaded 29.3-35.5 KB of JS when opened (`npm run size`, 2026-11-22), the article 56.8 KB with the
Markdown library: most of it is sinter (the core, the early script, the swap stub and the features the page uses),
the rest the app's page module, config and helpers, and on the article the parser and the md-* components. RealWorld runs with [swaps](navigation.md#swaps) on, so opening the article
fetches its HTML and only the scripts the home page did not load (the article's page module, the rest of
the swap code and the Markdown parser); the shared chunks come from the browser cache. Built with `swap`, `prefetch`
and `firstPaint` off (a copy of its `vite.config.js`, 2026-11-27), the home page loads 26.2 KB and home + article
54.7 KB, but the build passes 135 of 140 (the four settings tests that read the page after saving, which need swaps,
and "should handle 401 when submitting settings form"), and its first paint no longer has the page's bindings before
the module: Lighthouse mobile 98 (84-100), CLS 0.088, LCP 1.71 s.

## Lighthouse

Lighthouse 13.6 in Chrome for Testing 158.0.8127.36, the home page, each run in a new Chrome with an empty
cache. Mobile is Lighthouse's default (simulated slow 4G, 4x CPU slowdown). The median of five runs, with
their range.

### The same conditions

Every implementation built from source, served on one machine by the same server, against the same local API
(25 articles, 10 per page, every answer after 150 ms) and the same recorded copies of Ionicons and Google Fonts, so
none gets a host, a CDN or an API latency the others don't. The runs are interleaved across implementations. Measured
on 2026-11-27 (Chrome for Testing 158.0.8127.36, Lighthouse 13.6.0, load 0.51 before and 0.76 after), sinter at 46426e1,
[bench/realworld/fair](../bench/realworld/fair/README.md) has the method. Only implementations that pass the
[e2e suite](#official-e2e-suite) in their mode are audited. Backtick's row is the 2026-11-22 run's (Chrome
153.0.8010.12; sinter 100 and 100 in that run too): it loads Solid from a CDN through an import map, which this
harness does not serve.

Mobile:

| implementation | perf (range) | FCP | LCP | TBT | CLS | JS (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **100** (100-100) | 901 ms | **901 ms** | 8 ms | **0** | 34.4 |
| Angular | 85 (84-89) | 1.51 s | 2.98 s | 213 ms | 0.138 | 89.9 |
| Vue 3 (official) | 77 (66-80) | 1.76 s | 3.95 s | 2 ms | 0.198 | 45.9 |
| Solid + Backtick (2026-11-22) | 89 (89-99) | 1.42 s | 3.66 s | 27 ms | 0.002 | 39.2 |

Desktop:

| implementation | perf (range) | FCP | LCP | CLS |
| --- | ---: | ---: | ---: | ---: |
| **sinter** | **100** (100-100) | 257 ms | **257 ms** | 0 |
| Angular | 76 (76-76) | 404 ms | 673 ms | 0.767 |
| Vue 3 (official) | 76 (76-76) | 404 ms | 847 ms | 0.793 |
| Solid + Backtick (2026-11-22) | 99 (99-99) | 452 ms | 869 ms | 0 |

sinter's paints are earlier than on 2026-11-22 (mobile 1.38 s then): since then the app serves its fonts and Ionicons
itself (no stylesheet from another origin before the first paint, [fair/README](../bench/realworld/fair/README.md)), and
Chrome is newer; this run does not separate the two.

JS is what was transferred (brotli). sinter's largest paint is in its first frame here because the largest element is
the home page's banner heading. That depends on the data and the styles: with longer titles, such as the public API's
("Introduction to Machine Learning for Developers"), the first title wraps to two lines on a phone and becomes the
largest element. It arrives with the API response, and mobile drops to about 96-98 with this harness's 150 ms API and
to 92-96 at 800 ms. The [server layer](first-paint.md#embedded-data) puts that data in the first frame. Of the others, Backtick renders the feed on its
server, so it has no shift, but its largest paint waits for its server's fetch of the API. The client-rendered apps
shift when the feed arrives (Angular, Vue 3). Backtick requests a Vercel-only script (`/_vercel/insights/script.js`),
a 404 off Vercel, once per audit; its Solid files were served locally (above).

Not the same, still: each app's own markup, scripts and fonts; server rendering on this machine; one
machine's CPU and Lighthouse's simulated network, not a CDN at the edge with HTTP/2. Earlier runs of this harness
(2026-11-14, with implementations that do not pass the e2e suite, and 2026-11-22) are in its
[README](../bench/realworld/fair/README.md).

### On the public demos

The implementations as they were compared on 2026-11-14, before the e2e suite decided which are compared; kept for the record.


On 2026-11-14, with [`bench/realworld/lighthouse.mjs`](../bench/realworld/lighthouse.mjs): the others on their
live demos, sinter's build (before the two changes above) served by
[`bench/realworld/serve.mjs`](../bench/realworld/serve.mjs) (brotli, immutable assets, HTTP/1.1), all through
this machine's network proxy.

| implementation | demo |
| --- | --- |
| Angular | https://demo.realworld.show/ (the official demo) |
| SvelteKit | https://realworld.svelte.dev/ |
| Vue 3 | https://vue3-realworld-example-app-mutoe.vercel.app/ |
| Solid | https://solid-realworld.netlify.app/ (its API, `api.realworld.io`, does not answer: an empty feed) |

React + Redux has no demo online.

Mobile:

| implementation | perf (range) | a11y | best pr. | SEO | FCP | LCP | TBT | CLS | JS (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **98** (97-99) | 94 | 100 | **100** | **1.58 s** | 2.29 s | 0 ms | 0.001 | 27.7 |
| SvelteKit | 95 (94-96) | 95 | 100 | 92 | 1.77 s | 2.73 s | 0 ms | 0 | 48.7 |
| Vue 3 | 86 (74-87) | 93 | 100 | 91 | 1.97 s | 3.09 s | 53 ms | 0.150 | 50.7 |
| Angular | 82 (78-86) | 67 | 100 | 75 | 2.38 s | 3.33 s | 184 ms | 0.102 | 118.1 |
| Solid (empty feed) | 98 (96-98) | 77 | 96 | 82 | 1.83 s | 2.12 s | 0 ms | 0 | 11.4 |

Desktop:

| implementation | perf (range) | a11y | best pr. | SEO | FCP | LCP | TBT | CLS | JS (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **99** (98-99) | 94 | 100 | **100** | **525 ms** | 884 ms | 0 ms | 0 | 27.7 |
| SvelteKit | 99 (98-99) | 95 | 100 | 92 | 710 ms | 839 ms | 0 ms | 0 | 48.7 |
| Vue 3 | 76 (74-78) | 93 | 100 | 91 | 729 ms | 1.02 s | 0 ms | 0.513 | 50.7 |
| Angular | 80 (71-81) | 67 | 100 | 75 | 1.29 s | 1.73 s | 0 ms | 0.168 | 118.1 |
| Solid (empty feed) | 99 (98-99) | 77 | 96 | 82 | 743 ms | 751 ms | 0 ms | 0 | 11.4 |

The live API had 4 articles that day, so the feed's shift on a phone barely showed. Every implementation
loses accessibility points for the Conduit theme's text colors (`#bbb`, `#999` and the green on white,
`color-contrast`); sinter's 94 is only that. Demos change under their URLs, and each server's response time
counts as measured.

## htmx and Datastar

The hypermedia builds render HTML on their own server for every page and interaction, so they cannot
use the shared JSON API; each ships its own backend. Counted: UI layer (templates, page-rendering
handlers, routes) and data layer (models, queries, services) separately. Client JS is the library
versions their layouts load, gzipped at level 9.

| implementation | commit | UI layer lines | data layer lines | client JS (gz) |
| --- | --- | ---: | ---: | ---: |
| **sinter** | | **735** | - (uses the API) | 27.8-33.3 KB per page, the article 59.8 KB |
| Go + templ + htmx (BerkeleyTrue/conduit-go-htmx) | 4c0990a | 2031 | 2529 | 39.9 KB (htmx 1.9.5 14.7 + hyperscript 25.1) |
| Clojure + hiccup + htmx (BerkeleyTrue/conduit-clj-htmx) | c46a814 | 1351 | 1525 | 39.9 KB |
| Go + templ + Datastar (delaneyj/realworld-datastar) | 410de63 | 1949 | 488 | 14.7 KB (Datastar 0.18.9) |

htmx 2.0.4 alone is 16.4 KB gz. harabat/django-htmx (a4a29fc) does not use htmx in its published state
and is left out. Behavioural differences: sinter's mutations are optimistic, the htmx builds show
results after the server answers (favorite = POST, then a hyperscript-triggered reload of the article
fragment); htmx reads directives from the live DOM, sinter compiles them, so injected markup stays
inert; htmx needs no client build step.

Runtime cost of one fetch-and-swap (100-5,000 rows, htmx 2.0.11 and 4.0.1, Datastar 1.0.4, plain JS):
[`bench/swap`](../bench/swap/README.md).

## Alpine and petite-vue

No RealWorld builds were compared. Like sinter, both render JSON with client-side templates, but they
have no server-state layer: fetching, caching, keyed upserts from server events and optimistic rollback
are code you write in each component's state. Both turn directive expressions into functions in the
browser (`new Function`), so their standard builds need `unsafe-eval` in the CSP. Alpine ships a
separate CSP build (`@alpinejs/csp`) that avoids this but accepts only a restricted expression syntax.
petite-vue has no CSP build. sinter compiles expressions at build time, so it runs under
`script-src 'self'` in every build, with no separate CSP mode. For swap timings against both, see
[`bench/swap`](../bench/swap/README.md).

## Official e2e suite

The RealWorld project's own suite (140 tests, Playwright, `examples/realworld/e2e`), against a local backend
(realworld-django-ninja, SQLite), on 2026-11-22; sinter's spa run and the client-side Solid apps' again on 2026-11-27
(realworld-django-ninja 33b88f1 with the two changes [the example's README](../examples/realworld/README.md#against-a-local-backend)
lists; the failing Solid apps with 2 workers and an 8 s test timeout, as a test they fail waits for it). `spa` mode is for an app that calls the API from the browser and
holds the token there; `ssr` mode for one whose server calls the API, and it skips the 48 tests that intercept the
browser's API calls or read a token it holds. Every implementation was run in both. Failures are classed as broken
or missing behaviour, markup the suite's selector contract (`e2e/SELECTORS.md`) does not find, or an assumption of
the suite.

| implementation | spa (passed of 140) | ssr (passed of 92, 48 skipped) | in the comparison |
| --- | ---: | ---: | --- |
| **sinter** | **140** | **92** | yes (spa 2026-11-27 at 46426e1, ssr 2026-11-22) |
| Angular | 140 | 91 | yes; its 1 ssr failure is a locator of the suite that matches two "Sign in" links |
| Vue 3 (official) | 140 | 91 | yes; its 1 ssr failure needs two authors on the first feed page, which the seeded data did not have |
| Solid + Backtick | 105 | 92 | yes, in its mode: 35 spa failures are the suite intercepting browser API calls an SSR app does not make, and about 4 editor selectors |
| SvelteKit (sveltejs/realworld df79670) | 47 | 31 | no: after one documented edit (`type="submit"` on the register button), 61 ssr failures remain: no `?page=N` in the URL, no `?feed=following`, no user info or Follow button on the profile page, login errors not in `.error-messages`, the settings button |
| Vue 3 (mutoe/vue3-realworld-example-app 741c215) | 19 | - | no: its inputs have no `name`, which the selector contract needs, so every test that signs in fails |
| Solid (solidjs/solid-realworld f6e77ec, Solid 1.3) | 8 | - | no: its routes are hash routes (`#/register`, `#/@user`), so the suite's `/register`, `/login` and `/profile/:username` show the home page, and every test that signs up or in fails at its first field. With the `name` attributes the selector contract asks for added, still 8 (2026-11-27): the inputs are on pages the suite never reaches |
| Solid (stevej2608/solid-realworld 40dab23, Solid 1.7) | 8 | - | no: a TypeScript port of the one above, with the same hash router |
| SolidStart (phillipbaird/realworld-solidstart 08332bf, solid-start 0.1) | 33 | - | no: built as an SPA (`ssr: false`), path routes, but unfinished: settings and editor have no handlers, the token lives in memory only |

A fourth client-side Solid one, yy-cc-20/solid-realworld-example-app (e85298e), was not run: its API calls are commented
out and its data is hard-coded.

React + Redux (gothinkster/react-redux-realworld-example-app, last commit 2021) was not attempted. No Svelte 5
implementation without SvelteKit exists; the ones found are Svelte 3 on SvelteKit 1 and 3-5 years old.

## The same feature: the favorite button

Angular: a 73-line component (`favorite-button.component.ts`: template, auth check, service calls,
submit state, output event) plus `favorite`/`unfavorite` in `articles.service.ts` and the parent's
handling of the toggle event. Not optimistic.

sinter: one component, `examples/realworld/src/components/favorite-button.html` (19 lines, both states),
used on the feed, the profile and the article page. It is optimistic and rolled back on failure;
signed-out users are sent to login by the page's `sn-error` handler. The state that favors:

```html
<button class="btn btn-sm btn-outline-primary" data-sn-post="https://api.realworld.show/api/articles/{article.slug}/favorite"
        data-sn-optimistic="merge(article, { favorited: true, favoritesCount: article.favoritesCount + 1 })">
```

`merge(article, …)` names no resource. At each use it changes the article where it came from (a row of
`articles` or `feed` on the home page, a row of the profile's list, the single `article` on the article
page), and write-through applies the response. There is no store code: no `merge('articles', …)` and
`merge('feed', …)` side by side as before.

## Components

The app has seven components: the header, footer, article meta, byline, preview, error list and the
favorite button. They are expanded at build time, so every page still renders in the first frame with
its data (the head script renders their bindings like the rest of the page: no hydration). Measured on 2026-11-11 on one machine, `main` (partials) against the build with components, both served
by `bench/realworld/serve.mjs` against the live API:

| build | JS, home (gz KB) | JS, home + article (gz KB) | Lighthouse mobile perf (range of 3) | FCP | LCP | desktop perf |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| main | 26.2 | 50.3 | 98 (98-98) | 1.73 s | 2.14 s | 98 |
| components | 26.4 | 50.5 | 98 (98-99) | 1.54 s | 2.29 s | 98 |

Components cost 0.2 KB of JS (gz) on these pages (download sizes measured again after the size work
below; Lighthouse on the build before it, 0.1 KB larger), and the scores do not move. Mobile FCP is 0.19 s
earlier and LCP 0.15 s later; with three runs each, neither is read as a change here. (Both builds load
less JS than the 32.5 KB in the tables above, which were measured again on 2026-11-17, after swaps and next-page data.) 

Where the bytes go, per file, gzip, `main` against components (after moving nested items and shared
definitions out of the core into modules only the pages that use them load):

| file | change | what it is |
| --- | ---: | --- |
| core (`npm run size`) | +93 B (13,925 → 14,018) | `merge()`/`remove()` finding the item in the resource it came from 54, `upsert` into a nested list 9, the script hook 12, the shared-definition hook 10, cycle guards 6 |
| write-through module | 0 (1,055) | nested targets are in a list of their own, which the `nested` module applies (only pages with nested lists load it) |
| shared chunk of the app (core, config, write-through) | +100 B | the core |
| page modules | -24 to +2 B | the same functions as `main`: a prop that is a plain path is inlined without parentheses (so one expression is one function, wherever a prop inlines it), and a `data-sn-if` on a constant prop is decided at build time; left are the source names in `merge()` calls (`["article"]`) |
| head scripts | 0 | |
| other modules | 0 to +5 B | no source change: `npm run size` leaves their runtime imports external, so their output holds the checkout's absolute path, one character longer here than in the `main` checkout measured |
| new modules | `components` 674 B, `nested` 1,234 B (with the write-through helpers it shares: with the write-through module, 94 B less than two copies), `defs` 175 B | only on pages with a component script, nested changes, shared definitions |
| HTML | −125 to −236 B | a component file's comments stay in the file |

`data-sn-early="off"` on the home page's header and error list (a test, not in the app) takes its
head script from 837 to 717 B (gzip); the page module and the shared head script do not change.

## Layouts

The seven pages now share one [layout](layouts.md), `src/layouts/conduit-layout.html`: the head
(charset, viewport, icon, the Ionicons, Google Fonts and app stylesheets), the header and the footer.
Each page is the layout's tag with its state, `data-sn-on-sn-error` and its title and description as
props, which the `conduit-seo` head component (`<template data-sn-props>`) binds into the `<title>` and
the description `<meta>`. Every title is a constant, as before (`title: 'Article'`), so it is written
into the HTML; the article page's Markdown script goes into the layout's head slot. The page files lost their
heads and the header and footer tags: 7 to 11 lines each.

Measured on 2026-11-11, one machine, `vite build` of the example before and after:

| page | HTML (B, gz) before → after | page head script (B, gz) | page module (`npm run size`, B gz) |
| --- | --- | --- | --- |
| article | 2,159 → 2,162 | 755 → 756 | 22,698 → 22,796 |
| editor | 1,780 → 1,783 | 460 → 461 | 20,992 → 21,063 |
| index | 2,194 → 2,195 | 855 → 856 | 22,897 → 23,001 |
| login | 1,623 → 1,621 | 418 → 419 | 19,884 → 19,943 |
| profile | 2,035 → 2,033 | 792 → 792 | 22,895 → 22,994 |
| register | 1,649 → 1,649 | 421 → 423 | 19,884 → 19,955 |
| settings | 1,810 → 1,806 | 372 → 373 | 20,097 → 20,180 |

The HTML and the head scripts are level: the merged document is the document the pages wrote by
hand, and the layout's comment stays in its file. The page modules grew by 60 to 104 B (gzip): the
title and description were bindings, and a constant one, written into the HTML at build time, kept
its binding, as every prerendered binding did. The build now leaves a binding that reads nothing out
of the page module (see [first-paint.md](first-paint.md#build-time-constants)), which brings the
pages with constant titles back to level:

| page module (gzip) | before layouts | with layouts | without constant bindings |
| --- | ---: | ---: | ---: |
| editor | 20,992 | 21,063 | 20,997 |
| index | 22,897 | 23,001 | 22,904 |
| login | 19,884 | 19,943 | 19,886 |
| register | 19,884 | 19,955 | 19,888 |
| settings | 20,097 | 20,180 | 20,099 |
| article | 22,698 | 22,796 | 22,712 |
| profile | 22,895 | 22,994 | 22,911 |

(A first version of the conversion took the article and profile titles from data, which cost those
two pages about 60 to 100 B and showed `Conduit` to link previews; the example went back to constant
titles, since it is not where that feature is shown.) Every page is within 16 B (gzip) of the build
before layouts, and scrapers that run no script see the same titles as before. The shared head script
does not change (3,233 B). Leaving out, too, the bindings that read only state nothing writes (the
pages' `nav`, read by the header's Home link) takes 8 to 16 B more off six of the page modules
(login 19,886 → 19,871); the header's other links are inside `data-sn-if` templates, which the build
does not write into the HTML, so their bindings stay. Their dependency on `nav`, which never fires, is left out: 3 to
7 B more (login 19,871 → 19,864). Writing those header bindings into their templates' markup instead, and
leaving `nav` out of the state once nothing reads it, takes the page modules 55 to 58 B further
(login 19,864 → 19,808) and the page head scripts 48 to 80 B (login 419 → 339, editor 461 → 387);
profile, whose `nav` comes from the URL, does not change. Checked in Chromium for a guest and a
signed-in visitor: the active link is the same on every page.

The early script then learned `$url` on every page (before, only on pages with embedded data). On
`/tag/css`, the home page's `css` tab is in the first frame, active (checked in Chromium with the page
module blocked); before, it appeared when the page module ran and shifted the tabs. The profile
page's own nav link reads `$url` too, but it is shown only for a signed-in user, whose data is not
there early, so nothing visible changes there. Cost, gzip: the shared head script 3,233 → 3,325 B (the attribute and text
writers, which an early binding now uses; the URL reader was already in it), the home page's head
script 856 → 950 B and the profile page's 792 → 889 B; the others within 1 B.
