# RealWorld: sinter compared with other implementations

Measured 2026-11-04. Scripts: [`bench/realworld/loc.mjs`](../bench/realworld/loc.mjs) (source lines),
[`bench/realworld/weight.mjs`](../bench/realworld/weight.mjs) (what the browser downloads).

| implementation | repo (commit) | architecture |
| --- | --- | --- |
| sinter | `examples/realworld` | multi-page, compiled HTML |
| Angular | realworld-apps/angular-realworld-example-app (d426ec8, 2026-11-02) — the official demo | SPA |
| Vue 3 | mutoe/vue3-realworld-example-app (741c215, 2026-08-29) | SPA |
| SvelteKit | sveltejs/realworld (df79670, 2026-08-10) | SSR + hydration |
| Solid | solidjs/solid-realworld (f6e77ec, 2022-04-24) | SPA |
| React + Redux | gothinkster/react-redux-realworld-example-app (ee72eba, 2021-09-07) | SPA |

## Source size

Non-blank lines of app source; tests, mocks, type declarations, generated code (Vue 3's
790-line generated API client) and the shared theme CSS excluded. sinter's count includes its
43-line Vite config (page entries and path rewrites).

| implementation | files | lines | by type |
| --- | ---: | ---: | --- |
| **sinter** | 17 | **724** | html 585, js 139 |
| SvelteKit | 41 | 1153 | svelte 816, js 312, html 25 |
| Solid | 27 | 1281 | js 1248, html 33 |
| Vue 3 | 41 | 1848 | vue 1344, ts 488, html 16 |
| React + Redux | 39 | 2087 | js 2056, html 31 |
| Angular | 53 | 2210 | ts 1658, html 546, css 6 |

## Download size

Headless Chrome loads the home page, then opens the first article. Every JS and CSS response
is gzipped at level 9 by the script, so different CDN compression does not skew the numbers.
The others are measured on their live demos (which may be built from other commits than the
ones above); sinter on `vite preview` of its production build.

| implementation | JS, home (gz KB) | JS, home + article (gz KB) | JS, home + article (raw KB) | CSS (gz KB) | note |
| --- | ---: | ---: | ---: | ---: | --- |
| **sinter** | **13.8** | **35.7** | 108.4 | 14.4 | Markdown renderer (21.5 KB) loads with the first article |
| Angular | 98.4 | 123.0 | 392.0 | 11.9 | |
| Vue 3 | 46.7 | 63.7 | 171.9 | 14.4 | |
| SvelteKit | 42.8 | — | 105.9 | 14.8 | the article did not open in the script |
| Solid | 11.7 | — | 31.8 | 9.3 | demo shows no articles (backend gone); lazy route code not loaded |
| React + Redux | — | — | — | — | demo no longer online |

Every sinter page loads 12.5–14.2 KB of JS when opened (its page module plus the shared chunk:
core, config, islands). As a multi-page app, each navigation is a page load; the shared chunk
comes from the browser cache.

## Official e2e suite

sinter: 130–133 of 140, depending on the run (see `examples/realworld/README.md` for the rest:
SPA assumptions in the settings tests, optimistic updates racing tests that navigate at once,
and the public API failing under load). The other implementations were not run against the
suite here.

## The same feature: the favorite button

Angular: a 73-line component (`favorite-button.component.ts`: template, auth check, service
calls, submit state, output event) plus `favorite`/`unfavorite` in `articles.service.ts` and
the parent's handling of the toggle event. Not optimistic.

sinter (per state of the button; optimistic, rolled back on failure, signed-out users sent to login):

```html
<button class="btn btn-outline-primary btn-sm pull-xs-right"
        data-sn-post="https://api.realworld.show/api/articles/{a.slug}/favorite"
        data-sn-optimistic="patch('articles', a, {favorited: true, favoritesCount: a.favoritesCount + 1})"
        data-sn-then="patch('articles', a, $result.article)"
        data-sn-catch="$error.status == 401 ? emit('navigate', '/login') : error = $error">
  <i class="ion-heart"></i> <span data-sn-text="a.favoritesCount"></span>
</button>
```

## Caveats

- Line counts measure volume, not difficulty; sinter's HTML lines carry the logic the others
  write in components and services.
- The implementations differ in scope: SvelteKit renders on the server (its line count includes
  server routes); Angular includes typed models and route guards.
- Building the other implementations locally (for same-commit bundle sizes) was not done: it
  runs their dependencies' install and build code, which this environment blocks by default.
