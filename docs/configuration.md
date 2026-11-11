# Configuration

Three places configure a sinter app, and each has one job:

| Where | What it configures |
| --- | --- |
| `sinter({...})` in `vite.config.js` | the build: checks, first paint, prefetching, fonts, images |
| `src/sinter.config.js` | the running page: requests, auth, errors, locale |
| `src/sinter.helpers.js` | functions your markup can call |

Everything has a default. A working app needs only the plugin:

```js
// vite.config.js
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: sinter({ openapi: 'openapi.yml', typecheck: true }),
});
```

## Vite plugin options

`sinter(options)` returns the list of Vite plugins, so pass it to `plugins` as is.

### Project files

Each option names a file relative to the project root. Leave it out and sinter looks for the default, `.js` first, then `.ts`.

| Option | Default | Purpose |
| --- | --- | --- |
| `helpers` | `src/sinter.helpers.js` | functions and namespaces for expressions, [below](#helpers) |
| `actions` | `src/sinter.actions.js` | functions for `data-sn-call` and `<sn-resource call>` ([docs/actions.md](actions.md)) |
| `config` | `src/sinter.config.js` | the module that calls `configure()`, [below](#the-config-module) |
| `early` | `src/sinter.early.js` | code that runs before the first paint ([docs/first-paint.md](first-paint.md)) |
| `types` | `src/sinter.types.ts` (then `.d.ts`, `.js`) | the types `type="..."` may name ([docs/type-checking.md](type-checking.md)) |
| `messages` | `project.inlang`, if it exists | the inlang project for [messages](#messages); `false` turns them off |
| `openapi` | none | one OpenAPI file or a list of them ([docs/type-checking.md](type-checking.md#openapi)) |

### Checks

| Option | Default | Purpose |
| --- | --- | --- |
| `typecheck` | `false` | run `sinter check` at the end of `vite build` and fail the build on type errors. Needs TypeScript |
| `complexity` | see [below](#what-belongs-in-markup) | limits for the `SN507` warning, and its level |
| `checkCycles` | `false` | report `then`/`catch` handlers that start each other through `run()` (`SN509`) |
| `site` | none | the site's origin (`'https://example.com'`, no path): every page whose URL is known gets a canonical link, and expressions get `$site` and `$canonical` ([docs/static-pages.md](static-pages.md#canonical-urls)) |
| `localePrefix` | `false` | each page once per language of the [messages](#messages), under its prefix (`/de/about/`), its text in the HTML; unprefixed URLs choose a language ([docs/static-pages.md](static-pages.md#languages)) |
| `redirects` | `true` | write `_redirects` (Netlify, Cloudflare Pages) with the pages' URLs ([docs/static-pages.md](static-pages.md#redirects-and-rewrites)) |
| `static` | none | pages that must ship no JavaScript, by path from the root (`['about.html', 'docs/**']`), or `true` for all: one that needs the runtime is `SN322` ([docs/static-pages.md](static-pages.md)) |

### First paint and loading

| Option | Default | Purpose |
| --- | --- | --- |
| `firstPaint` | `true` | write build-time values into the HTML and render what needs no data as the page loads. `false` waits for the page module ([docs/first-paint.md](first-paint.md)) |
| `earlyBudget` | `10000` | an early script above this many gzipped bytes is a build warning |
| `embed` | `false` | for a server that writes each page's data into the HTML: pages get placeholders instead of early requests, and the build writes `sinter-embed.json` listing them. `vite dev` is unaffected |
| `origins` | `[]` | other origins your resources, actions and streams may call. Added to every page's allowlist and preloaded like same-origin requests, without credentials. Put API origins here, not in `configure({ origins })` |
| `prefetch` | `true` | request the next page's data when a link is about to be followed ([docs/navigation.md](navigation.md)) |
| `speculation` | `'prefetch'` | Speculation Rules for links between pages (Chromium): `'prefetch'`, `'prerender'`, `false`, or `{ mode, delivery }` |

`speculation` is delivered as an inline script in every page, so it needs no server setup. A CSP declared in a `<meta>` gets the script's hash from the build. A CSP sent as a response header needs `'inline-speculation-rules'` in `script-src`, or `delivery: 'header'`: the build then writes `speculation-rules.json` at the site root, and your server sends it as `application/speculationrules+json` in a `Speculation-Rules` header on every page (`vite dev` and `vite preview` do both). Details in [docs/navigation.md](navigation.md).

```js
sinter({
  origins: ['https://api.example.com'],
  speculation: { mode: 'prerender', delivery: 'header' },
})
```

### Fonts

Google Fonts stylesheets are downloaded at build time and bundled as one of your CSS files, so a page makes one render-blocking request to another origin less. The look and `font-display` stay as written. Downloads are cached in `node_modules/.cache/sinter/fonts`; a build that cannot download one keeps the link and warns.

| Option | Default | Purpose |
| --- | --- | --- |
| `fonts.inline` | `true` | `false` keeps the `<link>` to Google Fonts |
| `fonts.preload` | none | faces to preload: a family name (its 400 normal face) or `{ family, weight, style }` |

```js
sinter({ fonts: { preload: ['Inter', { family: 'Inter', weight: 700 }] } })
```

The build fails when a page preloads a face of a family its stylesheets never use, or when no page has the face at all. In dev, sinter warns when a page did not render with the face in its first frames: a preload competes with what the first paint needs.

### Images

| Option | Default | Purpose |
| --- | --- | --- |
| `images` | on (needs `sharp`) | local `<img src>` JPEG, PNG, WebP and AVIF become responsive `<picture>` elements. `false` leaves images as written |
| `images.widths` | built in | widths for fluid images |
| `images.remote` | none | images from the API: `{ url, cover, origins }` for a resizing service |

[docs/images.md](images.md) covers both steps.

## The config module

`src/sinter.config.js` is imported before the page mounts. It calls `configure()` once. It runs on the
pages that run sinter: a page with nothing to run ships no JavaScript, this module included
([docs/static-pages.md](static-pages.md)), so code meant for every page goes in a script the layout includes.

```js
// src/sinter.config.js
import { configure, credentials, header, onUnauthorized, loginRedirect } from '@tiaforge-ui/sinter';

configure({
  request: [
    credentials('same-origin'),
    header('X-Sinter', '1'),
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
| `locale` | `{ get(), set(locale) }` | connects your own locale source to `$locale` and the date and number helpers. Not needed with [built-in messages](#messages) |
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

configure({ request: [timing, credentials('same-origin')] });
```

Built in:

| Function | Does |
| --- | --- |
| `credentials(mode)` | sets the fetch credentials mode |
| `header(name, value, { origin })` | adds a header to same-origin requests, or only to `origin` |
| `onUnauthorized(handler)` | calls `handler(request, response)` on a 401 |
| `loginRedirect({ to, returnUrl })` | stores the current URL (same-origin and under an allowed prefix only), clears persisted state, goes to `to`. It never resolves, so `then` and `catch` do not run |
| `takeReturnUrl(allow)` | on the login page: the stored URL if it is same-origin and under an allowed prefix, else `null`; removes it |
| `clearPersisted()` | removes values stored by `data-sn-persist`, and cached page data. Call it on logout |

Requests time out after 30 seconds, and nothing is sent twice unless a [retry policy](retry.md) says so.

Failures reject with `$error`, an object of `status`, `body`, `message` and `detail`:

- `status` is the HTTP status, `0` for a network error, `null` for a failed action call.
- `detail` is the error in words when there is one: a short text body, a JSON body's `message` or `error`, or a thrown error's message. Otherwise it is `null` and `message` falls back to the status.
- `body` is the parsed error body.

So `error = $error.detail ?? m.save_failed()` shows the server's reason or your own text.

Response bodies: 204 or empty gives `null`, a JSON content type is parsed (invalid JSON is an error with `message` `invalid JSON`), anything else is text.

A request to an origin that is neither the page's nor listed in `origins` is refused.

## Helpers

`src/sinter.helpers.js` exports the functions your expressions call. Keep them pure: same arguments, same result, nothing read or changed elsewhere.

```js
// src/sinter.helpers.js
export const initials = (name) => name.split(' ').map((w) => w[0]).join('');
export * as fmt from './format.js';
```

```html
<span data-sn-text="initials(c.name)"></span>
<span data-sn-text="fmt.price(c.total)"></span>
```

- Exported names become functions. Type-only exports are skipped.
- `export * as ns from './module.js'` makes a namespace. The compiler reads its members, so `fmt.pirce(...)` is `SN206` with a suggestion. Members must be named literally: `fmt[key]` is refused. Only the members a page uses reach its bundle.
- Re-exports follow relative paths only.

### Built-in formatters

Always available, no import. They read the current locale, so a locale switch updates them. Each `Intl` formatter is built once per locale and options, then reused.

| Helper | Example | Result in `en` |
| --- | --- | --- |
| `date(v, style)` | `date(c.born, 'long')` | `March 4, 1990` |
| `time(v, style)` | `time(c.at)` | `9:30 AM` |
| `datetime(v, style)` | `datetime(c.at)` | `Mar 4, 1990, 9:30 AM` |
| `relative(v)` | `relative(c.at)` | `3 days ago` |
| `number(v, opts)` | `number(c.total, { style: 'currency', currency: 'EUR' })` | `€12.50` |
| `bytes(v)` | `bytes(f.size)` | `1.5 MB` |

`style` is `'full'`, `'long'`, `'medium'` or `'short'`; `date` and `datetime` default to `'medium'`, `time` to `'short'`. `opts` are `Intl.NumberFormat` options. Missing or invalid values give an empty string, not `Invalid Date`.

## State, briefly

`data-sn-state` declares local variables for an element and what is inside it. The value is an object literal, so the compiler knows every name:

```html
<section data-sn-state="{ q: '', editing: null }">…</section>
```

`data-sn-let` names values computed from state, resources and loop variables, for use inside the element. Names are read-only and may not reuse a state or loop variable name (`SN209`):

```html
<div data-sn-let="{ hits: contacts.filter(c => c.name.includes(q)), n: hits.length }">
  <p data-sn-show="n" data-sn-text="n + ' found'"></p>
</div>
```

State lives with the page. `data-sn-persist="key"` on an element with a model or state stores it in `localStorage` under `sn:key`. See [docs/attributes.md](attributes.md).

## Messages

Messages come from an inlang project, so the inlang tools (VS Code extension, Fink, machine translation) keep working on the same files.

```
project.inlang/settings.json
messages/en.json      { "inbox_title": "Inbox", "inbox_count": "{count} unread" }
messages/de.json      { "inbox_title": "Posteingang", "inbox_count": "{count} ungelesen" }
```

```html
<h1 data-sn-text="m.inbox_title()"></h1>
<p data-sn-text="m.inbox_count({ count: inbox.unread })"></p>
<button data-sn-on-click="$locale = 'de'">Deutsch</button>
```

See [docs/recipes/messages.html](recipes/messages.html).

- The project is read from `project.inlang/settings.json` (`baseLocale`, `locales`, and the message-format `pathPattern`, default `./messages/{locale}.json`). Each file maps keys to plain strings with `{param}` placeholders. Plurals and variants are not supported, and a non-string message is a build error. Keys must be identifiers.
- An unknown key is `SN206` with a suggestion. Wrong or missing parameters are `SN208` in `sinter check`; a parameter is `string | number`.
- In app code, `import { m } from '@tiaforge-ui/sinter/messages'`, typed by the generated `src/sinter.messages.d.ts` (rewritten on every build and `sinter check`, so you can git-ignore it). Only `m.key` is allowed: `m[key]`, and passing or aliasing `m`, are build errors. For a dynamic choice use a map of `() => m.key()` functions.
- Your helpers module must not also export a namespace `m`.
- A missing translation falls back to the base language and is reported once per locale at build.
- Each page gets one small file per language holding only the keys it uses. Before the first paint the page picks the language: the stored choice (`localStorage` key `locale`), else the first match in `navigator.languages` (`de-AT` matches `de`), else the base. The base language's text is in the HTML, so visitors in that language see it in the first frame. For another language those elements stay hidden, keeping their space, until the page has rendered them.
- `$locale = 'de'` (or `setLocale('de')` from the messages module) stores the choice, loads the page's file for that language once, sets `<html lang>` and re-renders every message and every `date()` and `number()`. `onLocale(fn)` tells app code.
- With built-in messages sinter is the locale source: do not also call `configure({ locale })`.
- With `sinter({ localePrefix: true })` the language is in the URL instead (`/de/about/`): each page is built once per language with its text in the HTML, switching is a link (`localeUrl('de')`), and `$locale` cannot be assigned. See [docs/static-pages.md](static-pages.md#languages).

An app without an inlang project pays nothing for this: no picker, no language files.

To use another i18n library, export its message functions as a namespace from the helpers module (`export * as m from './paraglide/messages.js'`) and connect its locale with `configure({ locale: { get, set } })`.

## What belongs in markup

Every attribute value that is not a URL or a name is a JavaScript expression, parsed at build time and checked against a closed set of names.

| Kind | Used in | Allowed | Refused |
| --- | --- | --- | --- |
| Value | `text`, `attr`, `class`, `show`, `prop`, `for` (after `in`), `if`, `key`, `body`, `state`, URL interpolations | any expression: template strings, `?.`, `??`, arrow functions as arguments, `new` on allowed globals | assignment, `++`/`--`, `delete`, `await`, `import()` |
| Handler | `on-*`, `then`, `catch`, `optimistic` | statements separated by `;`, assignment to state, calls to store functions | declarations, loops, `await` |

A name resolves to the first match, innermost first: loop variables, state, resources, magic names (`$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`), then helpers, namespaces and store functions (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`, `close`, `reset`, `emit`, `run`), then allowed globals. Anything else is `SN201` with a suggestion.

Globals are JavaScript, not the browser. `Math`, `JSON`, `Object`, `Array`, `Set`, `Map`, `Date`, `Intl`, `RegExp`, `URL`, `URLSearchParams` and `structuredClone` work. `window`, `document`, `fetch`, `localStorage`, timers, `eval`, `Function`, `Proxy` and `Reflect` do not (`SN202`): browser work belongs in a [component's script](islands.md). In a binding, `Date.now()` and `Math.random()` never update, so use `$now` (`SN502`).

Markup holds filters, conditions, single assignments and short calls. Logic that computes a value goes into a helper; logic with side effects goes into an action ([docs/actions.md](actions.md)). The handler applies the result:

```html
<!-- not four lines of if/else on $event.shiftKey -->
<li data-sn-on-click="sel = rowClick($event, sel, f.id, ids)">

<!-- a guard over one step is fine -->
<button data-sn-on-click="open && close('detail')">
```

One condition per step. `a && (b = null, close())` is two steps behind one guard: write them as separate statements, or compute the new state in a helper.

### Complexity limits (`SN507`)

Expressions that outgrow markup get warning `SN507`, naming the limit they exceed. The measure is structure, not length.

| Limit | Default | Counts |
| --- | --- | --- |
| `statements` | 4 | `;`-separated statements in one handler |
| `sequences` | 0 | comma sequences `(a, b)` |
| `guarded` | 1 | steps one `&&`, `\|\|`, `??` or `?:` statement runs: `a && close()` is 1, `a && (b = 1, close())` is 2 |
| `ternaries` | 2 | nesting of `?:` |
| `arrow` | 8 | operations in one arrow function body; a block body is always too many |
| `operations` | 15 | operations in one expression, the backstop |

Operations are calls, `new`, operators, assignments, computed member access and functions. Names, member paths (`a.b.c`), literals and object and array structure are free, so a draft object of plain fields costs nothing. Filters like `people.filter(p => p.name.includes(q))` stay under the limits.

```js
sinter({ complexity: { statements: 6, ternaries: 1, level: 'error' } })
```

Set any limit alone. `level` is `'warn'` (default), `'error'` (fails the build) or `'off'`. An unknown limit or level is refused when the config loads. The setting also applies to `sinter check` and the editor. In an editor, the quick fix for `SN507` extracts the expression into a helper ([docs/editors.md](editors.md)).
