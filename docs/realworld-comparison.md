# RealWorld: sinter compared with other implementations

**How does a sinter app compare with the same app written with other tools?** RealWorld is a public
spec for a blogging app (Conduit) that many frameworks implement against the same API. sinter's version
has the fewest source lines and the least JavaScript of the apps that show articles, and its Lighthouse
mobile score is within a few points of the best.

| implementation | source lines | JS, home + article (gz KB) | Lighthouse mobile perf |
| --- | ---: | ---: | ---: |
| **sinter** | **777** | **35.7** | 94 |
| SvelteKit | 1153 | - | 95 |
| Solid | 1281 | - | 97 (empty feed) |
| Vue 3 | 1848 | 63.7 | 85 |
| React + Redux | 2087 | - | - |
| Angular | 2210 | 123.0 | 77 |

A dash means the number could not be measured (see the notes under each table below). sinter's source
lines are for its version with components (2026-11-10); its download size and Lighthouse score in
these tables are from before components; [Components](#components) compares the two builds on one
machine. Scripts:
[`bench/realworld/loc.mjs`](../bench/realworld/loc.mjs) (source lines),
[`bench/realworld/weight.mjs`](../bench/realworld/weight.mjs) (what the browser downloads),
[`bench/realworld/lighthouse.mjs`](../bench/realworld/lighthouse.mjs) (Lighthouse).

| implementation | repo (commit) | architecture |
| --- | --- | --- |
| sinter | `examples/realworld` | multi-page, compiled HTML |
| Angular | realworld-apps/angular-realworld-example-app (d426ec8, 2026-11-02) - the official demo | SPA |
| Vue 3 | mutoe/vue3-realworld-example-app (741c215, 2026-08-29) | SPA |
| SvelteKit | sveltejs/realworld (df79670, 2026-08-10) | SSR + hydration |
| Solid | solidjs/solid-realworld (f6e77ec, 2022-04-24) | SPA |
| React + Redux | gothinkster/react-redux-realworld-example-app (ee72eba, 2021-09-07) | SPA |

## Source size

Non-blank lines of app source; tests, mocks, type declarations, generated code (Vue 3's 790-line
generated API client) and the shared theme CSS excluded. sinter's count includes its 43-line Vite
config (page entries and path rewrites), and leaves out its generated `src/sinter.components.d.ts`.
Before components, with partials, the same script counts 765 lines (html 593, js 172): the components'
`<template data-sn-component>` wrappers and their props cost more lines than the favorite button they
deduplicate saves.

| implementation | files | lines | by type |
| --- | ---: | ---: | --- |
| **sinter** | 20 | **777** | html 605, js 172 |
| SvelteKit | 41 | 1153 | svelte 816, js 312, html 25 |
| Solid | 27 | 1281 | js 1248, html 33 |
| Vue 3 | 41 | 1848 | vue 1344, ts 488, html 16 |
| React + Redux | 39 | 2087 | js 2056, html 31 |
| Angular | 53 | 2210 | ts 1658, html 546, css 6 |

## Download size

Headless Chrome loads the home page, then opens the first article. Every JS and CSS response is
gzipped at level 9 by the script, so different CDN compression does not skew the numbers. The others
are measured on their live demos (which may be built from other commits than the ones above); sinter
on `vite preview` of its production build.

| implementation | JS, home (gz KB) | JS, home + article (gz KB) | JS, home + article (raw KB) | CSS (gz KB) | note |
| --- | ---: | ---: | ---: | ---: | --- |
| **sinter** | **13.8** | **35.7** | 108.4 | 14.4 | Markdown renderer (21.5 KB) loads with the first article |
| Angular | 98.4 | 123.0 | 392.0 | 11.9 | |
| Vue 3 | 46.7 | 63.7 | 171.9 | 14.4 | |
| SvelteKit | 42.8 | - | 105.9 | 14.8 | the article did not open in the script |
| Solid | 11.7 | - | 31.8 | 9.3 | demo shows no articles (backend gone); lazy route code not loaded |
| React + Redux | - | - | - | - | demo no longer online |

Every sinter page loads 14.0-15.7 KB of JS when opened (its page module plus the shared chunk: core,
config, islands; `npm run size`). As a multi-page app, each navigation is a page load; the shared chunk
comes from the browser cache.

## Lighthouse

Lighthouse 13.6 in Chrome for Testing 153: the home page, each run in a new Chrome with an empty cache,
five runs per implementation and form factor; the run with the median performance score is shown, with
the range of the five. Mobile is Lighthouse's default (simulated slow 4G, 4x CPU slowdown). The others
run on their live demos; sinter's production build is served by
[`bench/realworld/serve.mjs`](../bench/realworld/serve.mjs) (brotli, immutable assets, HTTP/1.1).

| implementation | demo |
| --- | --- |
| Angular | https://demo.realworld.show/ (the official demo) |
| SvelteKit | https://realworld.svelte.dev/ |
| Vue 3 | https://vue3-realworld-example-app-mutoe.vercel.app/ |
| Solid | https://solid-realworld.netlify.app/ (its API, `api.realworld.io`, answers 530: an empty feed) |

React + Redux has no demo online.

Mobile:

| implementation | perf (range) | a11y | best pr. | SEO | FCP | LCP | TBT | CLS | JS (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **94** (93-95) | 94 | 100 | **100** | **1.57 s** | 2.95 s | 0 ms | 0 | **24.0** |
| SvelteKit | 95 (94-95) | 95 | 100 | 92 | 1.76 s | 2.78 s | 0 ms | 0 | 48.7 |
| Vue 3 | 85 (71-86) | 93 | 100 | 91 | 1.98 s | 3.20 s | 79 ms | 0.150 | 50.7 |
| Angular | 77 (71-83) | 67 | 100 | 75 | 2.57 s | 3.86 s | 193 ms | 0.102 | 118.1 |
| Solid (empty feed) | 97 (96-98) | 77 | 96 | 82 | 1.92 s | 2.22 s | 0 ms | 0 | 11.5 |

Desktop:

| implementation | perf (range) | a11y | best pr. | SEO | FCP | LCP | TBT | CLS | JS (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **99** (98-99) | 94 | 100 | **100** | **544 ms** | 950 ms | 0 ms | 0 | **24.0** |
| SvelteKit | 98 (98-99) | 95 | 100 | 92 | 635 ms | 951 ms | 0 ms | 0 | 48.6 |
| Vue 3 | 74 (74-76) | 93 | 100 | 91 | 846 ms | 1.23 s | 0 ms | 0.513 | 50.6 |
| Angular | 77 (70-79) | 67 | 100 | 75 | 1.34 s | 1.88 s | 23 ms | 0.168 | 118.1 |
| Solid (empty feed) | 98 (97-99) | 77 | 96 | 82 | 870 ms | 870 ms | 0 ms | 0 | 11.4 |

JS is what was transferred (the hosts' own compression). sinter paints first and ships the least JS of
the implementations that show articles; SvelteKit, which renders the feed on the server, has its
largest paint 0.2 s sooner on mobile. Every implementation loses accessibility points for the Conduit
theme's text colors (`#bbb`, `#999` and the green on white, `color-contrast`); sinter's 94 is only that.

A sinter build that requests resources on the API's origin (listed in `sinter({ origins })`) before the
stylesheets have loaded, and bundles the Google Fonts stylesheet as the app's own CSS (Angular's CLI
does the same by default), measured with the same setup: mobile 98 (97-98), LCP 2.30 s, FCP 1.54 s;
desktop 98 (98-99), LCP 1.08 s; CLS 0.001 and 0. The tables above are the build without those two options.

Demos change under their URLs. Lighthouse replays every page on the same simulated network, but each
server's response time counts as measured.

## htmx and Datastar

The hypermedia builds render HTML on their own server for every page and interaction, so they cannot
use the shared JSON API; each ships its own backend. Counted: UI layer (templates, page-rendering
handlers, routes) and data layer (models, queries, services) separately. Client JS is the library
versions their layouts load, gzipped at level 9.

| implementation | commit | UI layer lines | data layer lines | client JS (gz) |
| --- | --- | ---: | ---: | ---: |
| **sinter** | | **735** | - (uses the API) | 14.0-15.7 KB per page |
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

sinter, against a local backend: 135 of 140 in the suite's spa mode, 91 passed and 48 skipped in ssr
mode, with 1 failure. The failures come from assumptions in the suite (the settings page surviving its
redirect; a strict locator that matches the reference markup's second "Sign in" link); see
`examples/realworld/README.md`. The other implementations were not run against the suite here.

## The same feature: the favorite button

Angular: a 73-line component (`favorite-button.component.ts`: template, auth check, service calls,
submit state, output event) plus `favorite`/`unfavorite` in `articles.service.ts` and the parent's
handling of the toggle event. Not optimistic.

sinter: one component, `examples/realworld/src/components/favorite-button.html` (19 lines, both states),
used on the feed, the profile and the article page. It is optimistic and rolled back on failure;
signed-out users are sent to login by the page's `sn-error` handler. The state that favors:

```html
<button class="btn btn-sm btn-outline-primary" data-sn-post="https://api.realworld.show/api/articles/{article.slug}/favorite"
        data-sn-optimistic="patch(article, { favorited: true, favoritesCount: article.favoritesCount + 1 })">
```

`patch(article, …)` names no resource. At each use it changes the article where it came from (a row of
`articles` or `feed` on the home page, a row of the profile's list, the single `article` on the article
page), and write-through applies the response. There is no store code: no `patch('articles', …)` and
`patch('feed', …)` side by side as before.

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
more JS than the 13.8 KB in the tables above, which were measured on an earlier version of the app.) 

Where the bytes go, per file, gzip, `main` against components (after moving nested items and shared
definitions out of the core into modules only the pages that use them load):

| file | change | what it is |
| --- | ---: | --- |
| core (`npm run size`) | +93 B (13,925 → 14,018) | `patch()`/`remove()` finding the item in the resource it came from 54, `upsert` into a nested list 9, the script hook 12, the shared-definition hook 10, cycle guards 6 |
| write-through module | 0 (1,055) | nested targets are in a list of their own, which the `nested` module applies (only pages with nested lists load it) |
| shared chunk of the app (core, config, write-through) | +100 B | the core |
| page modules | -24 to +2 B | the same functions as `main`: a prop that is a plain path is inlined without parentheses (so one expression is one function, wherever a prop inlines it), and a `data-sn-if` on a constant prop is decided at build time; left are the source names in `patch()` calls (`["article"]`) |
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
props, which the `conduit-seo` head component (`<template data-sn-head>`) binds into the `<title>` and
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
does not write into the HTML, so their bindings stay.

The early script then learned `$url` on every page (before, only on pages with embedded data). On
`/tag/css`, the home page's `css` tab is in the first frame, active (checked in Chromium with the page
module blocked); before, it appeared when the page module ran and shifted the tabs. The profile
page's own nav link reads `$url` too, but it is shown only for a signed-in user, whose data is not
there early, so nothing visible changes there. Cost, gzip: the shared head script 3,233 → 3,325 B (the attribute and text
writers, which an early binding now uses; the URL reader was already in it), the home page's head
script 856 → 950 B and the profile page's 792 → 889 B; the others within 1 B.
