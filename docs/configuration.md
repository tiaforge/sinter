# Configuration

Three places configure a sinter app, and each has one job:

| Where | What it configures |
| --- | --- |
| `sinter({...})` in `vite.config.js` | the build: checks, page URLs, first paint, prefetching, fonts, images |
| `src/sinter.config.js` | the running page: requests, auth, errors, locale |
| `src/sinter.helpers.js` | functions your markup can call |

Everything has a default. A working app needs only the plugin:

```js
// vite.config.js
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: sinter({ apis: { main: { openapi: 'openapi.yml' } } }),
});
```

## Vite plugin options

`sinter(options)` returns the list of Vite plugins, so pass it to `plugins` as is.

The pages are the `.html` files under the project root, outside `public/`, the build's output, `node_modules`,
`src/components/` and `src/layouts/`: `vite build` builds each one, as `vite dev` serves them, and the app is a
multi-page app (`appType: 'mpa'`). A config that names `build.rollupOptions.input` builds those pages instead.

A built page with nothing for Vite's HTML handling to do (no module script, stylesheet, `<style>`, image or other
asset URL, `%ENV%` value; a page that ships no JavaScript usually) is not parsed by it again: sinter writes it as Vite
would. That holds only while no other plugin of the app has a `transformIndexHtml` hook, which would then not see
those pages: with one, every page goes through Vite's HTML handling as usual. Nothing to configure.

### Project files

The app's modules have fixed names in `src/`, each optional, `.js` or `.ts`. A component library's are beside its
fixture pages, in `fixtures/` ([docs/libraries.md](libraries.md)).

| File | Purpose |
| --- | --- |
| `src/sinter.helpers.js` | functions and namespaces for expressions, [below](expressions.md#helpers) |
| `src/sinter.actions.js` | functions for `data-sn-call` and `<sn-resource call>` ([docs/actions.md](actions.md)) |
| `src/sinter.config.js` | the module that calls `configure()`, [below](#the-config-module) |
| `src/sinter.early.js` | code that runs before the first paint ([docs/first-paint.md](first-paint.md)) |
| `src/sinter.types.ts` (or `.d.ts`, `.js`) | the types `type="..."` may name ([docs/type-checking.md](type-checking.md)) |
| `src/sinter.content.ts` | collections for `src="content:…"` ([docs/resources.md](resources.md)); `sinter({ content: false })` turns it off |

| Option | Default | Purpose |
| --- | --- | --- |
| `apis` | none | the APIs the app calls: base URL, OpenAPI spec, credentials, headers, and what each endpoint returns. Pages then write paths relative to them (`src="/contacts"`), checked against the spec ([docs/apis.md](apis.md)) |
| `libraries` | `[]` | component libraries, by package name (`['@acme/ui']`): packages whose `package.json` names a folder of sinter components (`"sinter": "./sinter"`). Their public components are tags in the app; their helpers come in through a namespace re-export in your helpers module ([docs/libraries.md](libraries.md)) |
| `openapi` | none | deprecated: one OpenAPI file or a list of them; give each API its spec in `apis` instead ([docs/type-checking.md](type-checking.md#openapi)) |

### Checks

| Option | Default | Purpose |
| --- | --- | --- |
| `typecheck` | on with TypeScript | run `sinter check` at the end of `vite build` and fail the build on type errors; `false` turns it off |
| `compileHints` | `false` | each page module starts with V8's `//# allFunctionsCalledOnLoad`, so Chromium compiles it as the page loads instead of each function at its first call: worth it where a first render runs much of the code at once (a large parse in the browser); a large page module compiles longer up front. Other browsers ignore the comment |
| `complexity` | warnings | `SN507`, expressions that outgrew markup ([below](expressions.md#what-belongs-in-markup)): `{ level: 'error' }` fails the build, `false` turns it off |
| `expansionLimit` | `10000` | the most rows and component instances a page expands at build time; past it the list or tree renders in the browser, with `SN536` ([docs/static-pages.md](static-pages.md#what-is-static)) |
| `strict` | `false` | warnings fail `sinter check`, `vite build`, pages in the dev server and `render()`; runtime warnings show in the dev server's terminal and overlay. `{ allow: { SN504: 'reason' } }` keeps codes warnings. `SINTER_STRICT=1`/`0` overrides it ([docs/strict.md](strict.md)) |

### Pages and URLs

What the build writes for the site as a whole: page URLs, languages, and pages without JavaScript.

| Option | Default | Purpose |
| --- | --- | --- |
| `site` | none | the site's origin (`'https://example.com'`, no path): every page whose URL is known gets a canonical link, and expressions get `$site` and `$canonical` ([docs/static-pages.md](static-pages.md#canonical-urls)) |
| `sitemap` | on with `site` | `sitemap.xml` with every page that may be indexed; `{ paths: { '/article/:slug': () => slugs() } }` gives the values of pages whose path has parameters; `false` leaves it out ([docs/static-pages.md](static-pages.md#sitemap)) |
| `localePrefix` | `false` | each page once per language of the [messages](messages.md) (or of the content module's `languages()`), under its prefix (`/de/about/`), its text in the HTML; unprefixed URLs choose a language ([docs/static-pages.md](static-pages.md#languages)) |
| `redirects` | `true` | write `_redirects` (Netlify, Cloudflare Pages) with the pages' URLs ([docs/static-pages.md](static-pages.md#redirects-and-rewrites)) |
| `static` | none | pages that must ship no JavaScript, by path from the root (`['about.html', 'docs/**']`), or `true` for all: one that needs the runtime is `SN322` ([docs/static-pages.md](static-pages.md)) |

### First paint and loading

| Option | Default | Purpose |
| --- | --- | --- |
| `firstPaint` | `true` | write build-time values into the HTML and render what needs no data as the page loads. `false` waits for the page module ([docs/first-paint.md](first-paint.md)) |
| `firstPaint.budget` | `10000` | an early script above this many gzipped bytes is a build warning: `firstPaint: { budget: 20000 }` |
| `minifyHtml` | `true` | builds: remove your comments, and the white space your stylesheets show to render nothing, from every page's HTML. Dev never minifies ([docs/minify.md](minify.md)) |
| `embed` | `false` | for a server that writes each page's data into the HTML: pages get placeholders instead of early requests, and the build writes `sinter-embed.json` listing them. `vite dev` is unaffected |
| `lazy` | `[]` | packages loaded on first call instead of with the page (`['openpgp']`): your imports of one become stubs that share one `import()`, so it is a chunk of its own. Only awaited calls of its exports work (`SN324`); `data-sn-import` and `data-sn-preload` load it sooner ([docs/lazy.md](lazy.md)) |
| `origins` | `[]` | other origins your resources, actions and streams may call. Added to every page's allowlist and preloaded like same-origin requests, without credentials. The origins of `apis` are added for you; list here only origins that are no API (an image host). Put them here, not in `configure({ origins })` |
| `prefetch.data` | `true` | request the next page's data when a link is about to be followed ([docs/navigation.md](navigation.md)). `prefetch: false` turns off this and `prefetch.html`, as `<html data-sn-prefetch="off">` does for one page |
| `prefetch.html` | `true` | Speculation Rules for links between pages (Chromium): `true` (the next page's HTML), `false`, or `{ prerender, delivery }` (`prerender: true`: the whole page; `prerender: 'auto'`: the pages the build can show do nothing on load but read, the rest prefetched, [docs/navigation.md](navigation.md#prerendering-chosen-per-page)) |
| `swap` | `false` | links and `navigate()` to another page of the app swap it in instead of loading it, keeping `data-sn-permanent` elements (an audio player plays on). Read what changes first ([docs/navigation.md](navigation.md#swaps)) |

`prefetch.html` is delivered as an inline script in every page, so it needs no server setup. A CSP declared in a `<meta>` gets the script's hash from the build. A CSP sent as a response header needs `'inline-speculation-rules'` in `script-src`, or `delivery: 'header'`: the build then writes `speculation-rules.json` at the site root, and your server sends it as `application/speculationrules+json` in a `Speculation-Rules` header on every page (`vite dev` and `vite preview` do both). Details in [docs/navigation.md](navigation.md).

```js
sinter({
  origins: ['https://api.example.com'],
  prefetch: { html: { prerender: true, delivery: 'header' } },
})
```

### Fonts

Google Fonts stylesheets are downloaded at build time and bundled as one of your CSS files, so a page makes one render-blocking request to another origin less. The look and `font-display` stay as written. Downloads are cached in `node_modules/.cache/sinter/fonts`; a build that cannot download one keeps the link and warns.

| Option | Default | Purpose |
| --- | --- | --- |
| `fonts.bundle` | `true` | `false` keeps the `<link>` to Google Fonts (`fonts: false` turns off `preload` too) |
| `fonts.preload` | none | faces to preload: a family name (its 400 normal face) or `{ family, weight, style }`, from a Google Fonts stylesheet or the app's own `@font-face` (builds) |

```js
sinter({ fonts: { preload: ['Inter', { family: 'Inter', weight: 700 }] } })
```

The build fails when a page preloads a face of a family its stylesheets never use, or when no page has the face at all. In dev, sinter warns when a page did not render with the face in its first frames: a preload competes with what the first paint needs.

Whatever this option says, on pages with an early script a build loads these faces of the page's bundled CSS (Google Fonts, self-hosted or your own `@font-face`), other than those in `preload`, after the window's `load` event (or 2 s after the first contentful paint): faces with `font-display: swap`, and faces of text fonts without a `font-display`, which become `swap` (icon fonts, told apart by their files, stay as they are). They move into a stylesheet of their own, which the page links in `<noscript>` and its early script adds, so they do not compete with the first paint's files; the text painted before them is in a fitted fallback family (a system font with the web font's metrics, named after the web font in the stylesheets' font lists). Builds only; there is no option. See [first paint](first-paint.md#fonts-after-the-load).

To self-host fonts (no requests to Google, `font-src 'self'`), use a local package such as Fontsource instead of the Google Fonts link; `preload` finds its faces in the bundled CSS. See [first paint](first-paint.md#self-hosted-fonts).

### Images

| Option | Default | Purpose |
| --- | --- | --- |
| `images` | on (needs `sharp`) | local `<img src>` JPEG, PNG, WebP and AVIF become responsive `<picture>` elements. `false` leaves images as written |
| `images.widths` | built in | widths for fluid images; the largest is also the widest file of a fluid image or a sized CSS background (built in: the source's width) |
| `images.remote` | none | images from the API: `{ url, cover, origins }` for a resizing service |

[docs/images.md](images.md) covers both steps.

## The config module

`src/sinter.config.js` is imported before the page mounts. It calls `configure()` once. It runs on the
pages that run sinter: a page with nothing to run ships no JavaScript, this module included
([docs/static-pages.md](static-pages.md)), so code meant for every page goes in a script the layout includes.

```js
// src/sinter.config.js
import { configure, header, onUnauthorized, loginRedirect } from '@tiaforge-ui/sinter';

configure({
  request: [
    // a value the browser knows, read for each request (none while unset); a fixed one (credentials,
    // a CSRF header) goes on the API, and so does a token it issues: sinter({ apis: { main: { token } } })
    header('X-Tenant', () => localStorage.getItem('tenant')),
    onUnauthorized(loginRedirect({ to: '/login/', returnUrl: { allow: ['/app/'] } })),
  ],
  sessionProbe: '/api/user',
  onError: (error) => showToast(error.message),
});
```

`configure()` takes only the keys you pass and leaves the rest as they were.

| Key | Type | Purpose |
| --- | --- | --- |
| `request` | `Middleware[]` | the [request layer](#the-request-layer) |
| `sessionProbe` | URL | a cheap authenticated endpoint. After a network error, and before a stream reconnects, sinter requests it: a 2xx means go on, a 401 goes to your login handler, anything else waits and tries again ([docs/retry.md](retry.md), [docs/sync.md](sync.md)) |
| `onError` | `(error, element) => void` | called for an action or load error nothing else handled. `element` is the element that started it, or `null` |
| `locale` | `{ get(), set(locale) }` | connects your own locale source to `$locale` and the date and number helpers (a message library that switches language in place). Not needed with [`inlang()`](messages.md), whose pages each have one language. Without it, an app without languages uses the page's literal `<html lang>` ([docs/expressions.md](expressions.md#built-in-formatters)) |
| `origins` | `string[]` | allowed origins besides the page's own. Replaces the list; prefer `sinter({ origins })` |
| `urlSchemes` | `string[]` | extra URL schemes allowed in bound `href` and `src`, e.g. `['sms']`. `http`, `https`, `mailto` and `tel` are always allowed; `javascript:`, `vbscript:` and `data:` never are |
| `transport` | `(url) => Transport \| undefined` | the connection for a `<sn-sync src>`. Return `undefined` for the default `EventSource` ([docs/sync.md](sync.md)) |
| `retry` | `retry({...})` | named retry policies ([docs/retry.md](retry.md)) |
| `confirm` | `(question) => boolean \| Promise<boolean>` | asks the question of `data-sn-confirm`. Default `window.confirm`. Return `true` to run the action |
| `fieldErrors` | `(error, { url, method }) => map \| null \| undefined` | reads your server's validation errors for a form ([docs/actions.md](actions.md)) |

`fieldErrors` returns `{ <control name>: message | message[] }`. `null` marks no field, `undefined` leaves it to the default, which reads a 4xx response with a JSON body `{ "errors": { ... } }`:

```js
configure({
  fieldErrors: (error) => error.body?.violations
    ? Object.fromEntries(error.body.violations.map((v) => [v.field, v.message]))
    : undefined,
});
```

### The request layer

Every request goes through one chain: resources, actions and the session probe. A middleware is `(request, next) => Promise<Response>`, so a retry, a timeout or a logger is a plain function:

```js
const timing = async (request, next) => {
  const t = performance.now();
  const response = await next(request);
  console.debug(request.method, request.url, Math.round(performance.now() - t), 'ms');
  return response;
};

configure({ request: [timing] });
```

Built in:

| Function | Does |
| --- | --- |
| `header(name, value, { origin })` | adds a header to same-origin requests, or only to `origin`: for a value the browser knows. `value` is a function called for each request, `() => string \| null \| undefined` (null or undefined: no header), so a token set after sign-in is sent, also with swapped pages; a string is sent as it is. Fixed credentials and headers, and a token the API issues (`token`, [docs/apis.md](apis.md#a-token)), go on the API, which keeps early requests |
| `onUnauthorized(handler)` | calls `handler(request, response)` on a 401 |
| `loginRedirect({ to, returnUrl })` | stores the current URL (same-origin and under an allowed prefix only), clears persisted state, goes to `to`. It never resolves, so `then` and `catch` do not run |
| `takeReturnUrl(allow)` | on the login page: the stored URL if it is same-origin and under an allowed prefix, else `null`; removes it |
| `clearStored()` | removes what sinter stored in the browser: `data-sn-persist` values, the page-load cache and next-page data. Call it on sign-in and sign-out (an API's `token` does it itself, and `signOut()` with it) |

Requests time out after 30 seconds, and nothing is sent twice unless a [retry policy](retry.md) says so.

Failures reject with `$error`, an object of `status`, `body`, `message` and `detail`:

- `status` is the HTTP status, `0` for a network error, `null` for a failed action call.
- `detail` is the error in words when there is one: a short text body, a JSON body's `message` or `error`, or a thrown error's message. Otherwise it is `null` and `message` falls back to the status.
- `body` is the parsed error body.

So `error = $error.detail ?? m.save_failed()` shows the server's reason or your own text.

Response bodies: 204 or empty gives `null`, a JSON content type is parsed (invalid JSON is an error with `message` `invalid JSON`), anything else is text.

A request to an origin that is neither the page's nor listed in `origins` is refused.

## Moved

Helpers, built-in formatters, state and what belongs in markup are in [expressions.md](expressions.md); messages (`inlang()`, a content namespace) in [messages.md](messages.md).
