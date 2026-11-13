# The server layer for JavaScript: `@tiaforge-ui/sinter/server`

Serve a sinter build with its API data already in the page: the first frame shows the data, the browser
makes no API request on load, and nothing is rendered on the server. It is the same layer as
[`sinter-axum`](../packages/sinter-axum#readme) (Rust), option for option, written on web-standard
`Request` and `Response`, so one handler runs on Node, Bun, Deno, Cloudflare Workers, Vercel and
Netlify functions, and inside Hono, H3, Elysia or any framework that takes a fetch handler.

The layer is optional: without it, sinter pages fetch their data in the browser
([first paint](first-paint.md#embedded-data)).

## Quick start

**1. Build the frontend for a server**: `sinter({ embed: true })` in its Vite config. The build leaves an
empty data slot in each page for every resource whose request the page's URL decides, and lists them in
`dist/sinter-embed.json`, with their types in `dist/sinter-embed.d.ts`.

**2. Wrap your app.** With Hono:

```ts
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun'; // or @hono/node-server/serve-static, hono/deno, …
import { embed } from '@tiaforge-ui/sinter/server';
import type { Build } from '../web/dist/sinter-embed.js';

const app = new Hono();
app.get('/api/articles', (c) => c.json(listArticles(c.req.query('tag'))));
app.use('*', serveStatic({ root: '../web/dist' }));

const sinter = await embed<Build>({ dir: '../web/dist', data: { user: 'skip' } });
export default { fetch: sinter.wrap(app.fetch) };
```

`wrap(handler)` answers the build's pages itself, and passes everything else (the API, the static files)
to the handler. It also calls the handler **in-process** for each page's API requests, with the page
request's cookies: no socket, no HTTP parsing, and your own routes, middleware and authentication apply.

On Node, serve the wrapped handler with any adapter for fetch handlers, such as `@hono/node-server` or
`srvx`:

```ts
import { serve } from '@hono/node-server';
serve({ fetch: sinter.wrap(app.fetch), port: 3000 });
```

On Bun, `Bun.serve({ fetch: sinter.wrap(app.fetch) })`; on Deno, `Deno.serve(sinter.wrap(app.fetch))`.

The page is sent head first, before the data is in, so its status is `200` from the start. If the data
then can't be fetched, the rest of the page isn't sent: the response ends with an error text, or a
redirect to your error page (see [what the layer does](#what-the-layer-does)).

## The type check, and the startup check

`embed<Build>` takes the build's placeholders as types from `sinter-embed.d.ts`. In your server's code, it
is a type error to leave a placeholder the build can't describe without an entry, or to name one that
doesn't exist:

```text
error TS2322: … Property '"profile.html:articles"' is missing in type '{ user: "skip"; }' …
error TS2561: Object literal may only specify known properties, but 'usr' does not exist in type …
```

A name applies to every page; `'profile.html:articles'` names one page's slot.

`embed()` makes the same checks when the server starts, against the build it reads, and rejects with
every problem in one error:

```text
sinter: 1 placeholder(s) have no source:
  profile.html: `articles`: the build could not describe its request (its `src` calls a
  helper, or reads something other than `$url`); add `articles: (req) => …` or `articles: 'skip'` to `data`
```

## Where the data comes from

The build records each page's API requests, including the first page of a paginated list and simple
`when` conditions on the URL. The layer makes them with the browser runtime's own URL code, so they are
exactly the requests the page would have made.

| Your API | Configure |
| --- | --- |
| Routes of the app you wrap | nothing (in-process) |
| Routes of another handler | `api: other.fetch` |
| A separate server, called by the frontend at same-origin paths (`/api/...`) | `upstream: 'http://127.0.0.1:4000'` |
| Another origin, called by the frontend at absolute URLs (`https://api.example.com/...`) | `origins: ['https://api.example.com']` |

An absolute URL on an origin that isn't allowed is refused at startup.

### Resolvers: your own code for one resource

A resolver is your function for one resource: it produces the data instead of the layer making the
request. You need one when the build can't describe the request (the frontend's `src` calls a helper or
chooses with a ternary, or its `when` is more than a comparison of URL values); the type check and the
startup check tell you which. It also skips the round trip for one the build does describe.

```ts
const sinter = await embed<Build>({
  dir: '../web/dist',
  data: {
    'profile.html:articles': ({ params, signal }) =>
      db.articles.byAuthor(params.username, { page: Number(params.page ?? 1), signal }),
    user: 'skip',
  },
});
```

It receives a `SlotRequest`:

- `params`: the page URL's parameters: query parameters and named path segments (`/article/:slug`
  gives `slug`); an array parameter (one a `<select multiple>` or checkboxes with a `value` bind,
  `?tag=a&tag=b`) is a list of strings, `[]` when absent;
- `request`: the page request (its headers, cookies included);
- `url`: the URL the layer would request, if the build describes one;
- `page`, `resource`: which slot it is;
- `signal`: aborted at the page's time limit, or when the visitor leaves.

It returns the data: any value (serialized as JSON), a JSON text (`string`), its bytes (`Uint8Array`,
`ArrayBuffer`), or a `Response` (a 2xx JSON one, such as `fetch(…)` or your API's own handler returns).
`null` or `undefined` leaves the resource to the browser.

## Signed-in users

The layer fetches the data before any of the page's JavaScript runs, so the API sees only what the
browser sent with its request for the page.

1. **The data is the same for everyone.** Nothing to do.
2. **Per user, with a session cookie.** Nothing to do: the layer passes the page request's `cookie`,
   `authorization` and `accept-language` headers on to in-process and `upstream` requests (`forward` to
   change them). Requests to `origins` get none, as sinter's own requests to another origin don't either.
3. **Per user, with a token from JavaScript** (`localStorage`). The request for the page doesn't carry
   it, so leave those resources to the browser: `early="off"` on the resource in the frontend (no slot),
   or `'skip'` here.

Pages are sent with `Cache-Control: private, no-cache`, so a shared cache never gives one user's page to
another.

## Options

| Option | Default |
| --- | --- |
| `dir`: the build's output directory, read with `node:fs` | — |
| `manifest`, `read`: the manifest (parsed or text) and a page reader, for runtimes without a file system | from `dir` |
| `data`: per resource, a resolver or `'skip'` | — |
| `api`: the in-process API | the handler given to `wrap` (or `next`) |
| `upstream`, `origins` | none |
| `timeout`: how long a page waits for all its data, in ms | 500 |
| `forward`: the page request's headers passed on to `api` and `upstream` | `cookie`, `authorization`, `accept-language` |
| `maxBytes`: the largest response put into a page | 2 MiB |
| `stream: false`: send each page in one piece; a failure is then a real `502` (`504` on the time limit) | head first |
| `errorText`: sent instead of the rest of a page whose data failed | `Error, please retry later.` |
| `errorRedirect`: where the browser goes then (a `meta` refresh and `location.replace`) | none |
| `cacheControl`: the pages' `Cache-Control` | `private, no-cache` |
| `fetch`: the fetch for `upstream` and `origins` | the global one |
| `onError`: a placeholder's data could not be fetched | `console.warn` |

### On Cloudflare Workers and other runtimes without a file system

Give the layer the manifest and the pages instead of a directory, as modules your bundler includes:

```ts
import manifest from '../web/dist/sinter-embed.json';
import index from '../web/dist/index.html'; // a text module (Wrangler: rules with type "Text")
import article from '../web/dist/article.html';

const pages: Record<string, string> = { 'index.html': index, 'article.html': article };
const sinter = await embed<Build>({ manifest, read: (file) => pages[file]! });

export default { fetch: sinter.wrap((req, env, ctx) => app.fetch(req, env, ctx)) };
```

Extra arguments (a Worker's `env` and `ctx`) are passed on to the handler, for the page's in-process
requests too.

### On Node

Node's `fetch` is undici behind the WHATWG `Request`/`Response` layer, and that layer costs more than the
request itself: when your pages' data comes from an API over HTTP (`upstream`, `origins`, or a resolver
that fetches), give the layer undici's own `request()`, the same client and connection pool:

```ts
import { request } from 'undici';

const sinter = await embed<Build>({
  dir: '../web/dist',
  origins: ['https://api.example.com'],
  fetch: async (url, init) => {
    const r = await request(url, { headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal });
    return new Response(r.statusCode == 204 ? null : await r.body.arrayBuffer(), { status: r.statusCode, headers: r.headers as HeadersInit });
  },
});
```

On RealWorld's pages it served 55-71% more pages per second uncompressed, 33-45% more with gzip
([measurements](first-paint-comparison.md#with-the-api-on-another-server)). Calls to the app you wrap are
in-process and use neither. Bun's and Deno's `fetch` are native and need nothing of the kind.

### As one step of a chain

`sinter.fetch(request, next)` answers a page, a redirect or the manifest's 404, and passes anything else to
`next`; `next` is also the in-process API unless `api` is set.

## What the layer does

- **At startup (`await embed(…)`):** it reads the manifest, checks that every slot has a source, and
  splits each page at its slots (the last thing in the page's `<head>`).
- **On a GET for a page:** it sends the HTML up to the first slot at once, fetches every slot's data in
  parallel for this URL, and writes each, with `<` escaped so it can't break out of its `<script>`,
  then the rest of the page.
- **When a slot's data can't be fetched** (an error, a non-2xx or non-JSON response, one over
  `maxBytes`, the time limit, a resolver that throws), the page ends there with the error text in a
  `<body data-sn-failed>`, so its scripts don't start. A resolver that ignores its `signal` doesn't hold
  the page past the time limit.
- **The site's URLs:** it follows the rules of the build's `_redirects`, from the manifest: a permanent
  redirect from a page's old file URL, a path a page declares in `data-sn-path` answered with that page
  (or passed on as its file, for a page without slots), and on a site with languages a `302` from an
  unprefixed URL to the visitor's language.
- **No data is not a failure:** a resolver's `null`, a skip, or a `when` that doesn't hold leaves the slot
  empty, and the browser requests that data itself.
- **What it never does:** fetch a URL whose host comes from the page's URL, or serve `sinter-embed.json`
  or `sinter-embed.d.ts` (it answers 404; a static host without the layer would serve them, so don't
  deploy them there if their resource names are private).

## Performance

See [first-paint-comparison.md](first-paint-comparison.md#with-the-api-in-the-same-app) for pages per second
against sinter-axum and Sinter.AspNetCore on the same machine, with the API in the same app
(`bench/in-process`), and [with an API over HTTP](first-paint-comparison.md#with-the-api-on-another-server). To run the RealWorld server used there (frontend built with
`SINTER_EMBED=1`):

```sh
npm run build
node bench/realworld/sinter-server.mjs examples/realworld/dist 4370 http://localhost:4400
bun bench/realworld/sinter-server.mjs examples/realworld/dist 4370 http://localhost:4400
```
