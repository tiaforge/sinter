# First paint with data

**Can a page show real data in its first frame without rendering on the server?** Yes. A small layer
fetches the API data and writes the JSON into the static HTML as it is sent. The page's head script
renders over it while the browser parses. Compared with a server-rendering framework (Qwik City), the
first frame has the same content, and a server core handles roughly ten times more pages.

Measured on the RealWorld home and article pages. Scripts and the Qwik app: [`bench/first-paint/`](../bench/first-paint/).

## Headline

Slow 4G, cold cache, headless Chromium. "Data" is when the first article title is in the page; an LCP
equal to first paint means the first paint already had the data (`measure.mjs`).

| Page | sinter static | sinter + embedding layer | Server rendering (Qwik City) |
| --- | --- | --- | --- |
| Home: first paint / data / LCP | 528 / 864 / 916 ms | 588 / 517 / **588** ms | 560 / 466 / **560** ms |
| Article: first paint / data / LCP | 496 / 710 / 752 ms | 568 / 514 / **568** ms | 528 / 465 / **528** ms |

Unthrottled, the embedding variant is level with Qwik or ahead: home LCP 76 vs 84 ms, article 68 vs 72 ms.
Static sinter paints first, but its data arrives one API round trip later.

Server cost per request, no API delay, one Node process each (`server-bench.mjs`):

| Per request | CPU | Latency p50 | Throughput |
| --- | --- | --- | --- |
| Static files, home / article | 0.8 / 0.9 ms | 2.0 / 1.9 ms | 1,083 / 1,432 req/s |
| **sinter middleware**, home / article | **2.8 / 1.7 ms** | 3.6 / 2.3 ms | **640 / 722 req/s** |
| Qwik City SSR, home / article | 22 / 6.6 ms | 14 / 5.3 ms | 88 / 244 req/s |

The middleware adds 1-2 ms to serving the file (fetch, fill, gzip). Qwik's home page costs about 8x that,
so a core serves about 7x fewer pages.

Components do not change this: they are expanded at build time, so their bindings render in the same
first frame (a component over embedded data renders with the rows, during the parse), and a component
used inside itself renders a tree at any depth from its shared definition. The RealWorld pages measured
here were built with partials, before components; the pages' markup did not change.

## How it works

The middleware fetches the page's API data and writes the JSON into the page's `data-sn-data`
placeholders. The head script renders the bindings over it, rows included, as the parser goes, and the
page module adopts those rows ([first paint](first-paint.md)). The middleware has no DOM
and no renderer: it does a fetch and a string replacement.

[`packages/sinter-axum`](../packages/sinter-axum) is the same thing in Rust, as a `tower` layer. It
reads the build's `sinter-embed.json` instead of a hand-written table and streams the head first, so
stylesheets and scripts load while the API answers.

## Method

- **Apps.** sinter: `examples/realworld` with `data-sn-data` placeholders for `articles` and `tags`
  (home) and `article` and `comments` (article). Qwik: Qwik City 1.20, written for this comparison after
  `joma1021/realworld-qwik` (same markup and CSS, `useResource$` rendered on the server, cookie auth), in
  `bench/first-paint/qwik`. Running the reference app itself was not possible in the measuring environment.
- **The same work.** Both render the article body as plain text: the reference Qwik app does not render
  Markdown, while sinter's RealWorld does (in the browser, with marked and DOMPurify). With Markdown,
  sinter's article page LCP is about 400 ms later on slow 4G; that is the library's download and run, not
  the first-paint mechanism.
- **The same fonts:** none. sinter's build serves Google Fonts itself (`@font-face`), Qwik links them;
  both are stubbed, since a font file found after the first layout holds that text's paint.
- **Servers.** A mock RealWorld API with realistic payloads (`api.mjs`); a static server with immutable
  hashed assets and gzip (`serve.mjs`, with `embed` the middleware); Qwik's Node middleware with gzip.
  Everything local, on one 4-core machine.
- **Browser.** Headless Chromium. "Slow 4G": 150 ms latency, 1.6 Mbit/s, CPU 4x slower unless stated.
  Cold cache, median of 5 or 6 loads (9 for the sinter-axum table).

## More results

### Browser cost (`client-bench.mjs`)

Main-thread time until the content is painted (LCP), CPU 4x slower, network unthrottled.

| Until LCP | Busy | Script | Style, layout, paint |
| --- | --- | --- | --- |
| sinter static, home / article | 345 / 324 ms | 100 / 104 ms | 77 / 68 ms |
| **sinter + middleware**, home / article | **220 / 200 ms** | 42 / 41 ms | 68 / 50 ms |
| Qwik, home / article | 134 / 142 ms | 1 / 3 ms | 59 / 53 ms |

Qwik's HTML arrives rendered, so almost no script runs before its first paint; sinter's head script
renders the rows during the parse. Over the whole load the two are close (home 293 vs 415 ms, article
344 vs 277 ms), since Qwik loads its code afterwards.

### Under load (`loadcmp.mjs`, `loadgen.mjs`)

Home page, slow 4G, while the server under test takes a steady stream of other requests (open loop).
First paint = LCP throughout. The last column is the latency those other requests saw.

| CPU | Load | sinter + middleware: first byte / paint | Qwik: first byte / paint | Qwik under load p50 / p90 |
| --- | --- | --- | --- | --- |
| 1x | idle | 7 / 480 ms | 19 / 460 ms | - |
| 1x | 80/s | 5 / 472 ms | 44 / 476 ms | 20 / 63 ms |
| 1x | 100/s | 5 / 472 ms | 112 / 488 ms | 58 / 143 ms |
| 1x | 120/s | 7 / 476 ms | 1,646 / 4,152 ms, 2 of 5 timed out | 1,914 / 3,358 ms |
| 2x | idle | 6 / 500 ms | 18 / 488 ms | - |
| 2x | 80/s | 5 / 500 ms | 40 / 500 ms | 17 / 45 ms |
| 4x | idle | 6 / 592 ms | 15 / 548 ms | - |
| 4x | 80/s | 6 / 552 ms | 31 / 540 ms | 18 / 55 ms |
| 4x | 120/s | 6 / 548 ms | 1,561 / 4,096 ms, 2 of 5 timed out | 2,540 / 6,376 ms |

The middleware's own latency stayed at 2-3 ms at every rate. Warm navigations (the article first, then
the home page, full page loads): idle, sinter 472 vs Qwik 480 ms at 1x, 528 vs 520 ms at 4x; at 80/s,
468 vs 504 ms at 1x and 528 vs 576 ms at 4x.

### Where each server breaks (`limit.mjs`)

Home page, open-loop load stepped up, 6 s per step; latency the load saw, and the server process's CPU
(one Node process, % of one core; above 100% is gzip in worker threads). The mock API and the load
generator stayed below 25% throughout. Each server was only stepped through its own range.

| Load | sinter middleware: p50 / p90 / p99 | CPU | Qwik City: p50 / p90 / p99 | CPU |
| --- | --- | --- | --- | --- |
| 40/s | | | 12 / 17 / 27 ms | 66% |
| 80/s | | | 13 / 29 / 51 ms | 100% |
| 100/s | | | 10 / 26 / 53 ms | 88% |
| 120/s | | | 206 / 398 / 487 ms | 111% |
| 150/s | | | 744 / 2,873 / 4,140 ms | 133% |
| 200/s | 2.7 / 3.7 / 8.4 ms | 30% | | |
| 400/s | 3.6 / 5.5 / 10.9 ms | 54% | | |
| 600/s | 4.7 / 7.8 / 12.8 ms | 75% | | |
| 800/s | 6.5 / 25 / 53 ms | 97% | | |
| 1,000/s | 25 / 76 / 105 ms | 96% | | |
| 1,200/s | 237 / 2,331 / 4,493 ms | 116% | | |

The same curve, an order of magnitude apart: Qwik breaks between 100 and 120 pages per second per core,
the middleware between 1,000 and 1,200.

### What the numbers say

1. **The same first frame without server rendering.** With a middleware that only writes the JSON in,
   sinter's first paint has the data: LCP equals first paint on both pages.
2. **Within 30-40 ms of server rendering on slow devices, level or ahead on fast ones.** On a 4x slower
   CPU, sinter's head script spends about 40 ms rendering rows before the first paint; at 1x that is
   about 10 ms. Part of the remaining gap at 1x is bytes: on a cold load the two head scripts (about
   4.8 kB gzip) share the slow link with the stylesheets.
3. **The cost sits in different places.** Per page, about 3 ms on the server plus about 55 ms in the
   browser (at 1x, home) for sinter, against about 22 ms on the server plus about 34 ms in the browser
   for Qwik. Server rendering pays per request, on the server, for every visitor.
4. **Capacity.** A Qwik server core saturates at about 100-120 home pages per second: past that, pages
   time out. The middleware's core saturates at about 1,000-1,200, so the same traffic needs about a
   tenth of the servers. Where server compute is billed per CPU millisecond (an edge function), that is
   about 2 ms against 22 ms per page.
5. **Server time shows little in first paint until the server queues.** On slow 4G the first paint waits
   mostly for the network; Qwik's 20-40 ms later first byte moved its first paint by 10-15 ms.

## sinter-axum

The same machine and mock API, with the Rust layer. The server is
`cargo run --release --features upstream --example realworld`: tags, article and comments as the build
describes them, the list from a resolver (its `src` calls a helper and has a `when`). The placeholders
sit in the `<head>` (the runtime ignores them anywhere else).

### First frame (`measure.mjs`, slow 4G, cold, median of 5)

| Page, API delay | sinter static: first paint / LCP | sinter-axum: first paint / LCP |
| --- | --- | --- |
| Home, 0 ms | 540 / 948 ms | 588 / **588** ms |
| Home, 300 ms | 532 / 1,128 ms | 572 / **572** ms |
| Article, 0 ms | 532 / 948 ms | 556 / 900 ms |
| Article, 300 ms | 536 / 996 ms | 536 / 936 ms |

- **The head is streamed.** The page goes out up to the first placeholder at once and the rest when the
  data is in, so stylesheets and scripts load while the API answers. Sending the page whole after the
  data (the Node middleware, or `Embed::stream(false)`) puts the API's time in front of everything: with
  the API at 300 ms, home LCP was 712 ms buffered and 536 ms streamed, and on a fast network the first
  paint moved from about 65 ms (static) to the API's time.
- **The article page's LCP is its Markdown body.** RealWorld renders it in the browser (marked and
  DOMPurify), after the page module, so data in the page moves it little. The comparison above rendered
  the body as plain text, for both apps.

### With `sinter({ embed: true })` and native pagination

RealWorld's lists use native pagination (`start-page="$url.page"`), and the build places the
placeholders itself. The example server needs one resolver, for the profile list's ternary. Slow 4G,
cold, median of 9:

| Page | sinter static: first paint / LCP | sinter-axum: first paint / LCP |
| --- | --- | --- |
| Home | 528 / 960 ms | 576 / **576** ms |
| Article, marked and DOMPurify lazy | 524 / 976 ms | 560 / 1,088 ms |
| Article, marked and DOMPurify with the page | 524 / 948 ms | 548 / **888** ms |

Loaded lazily, marked and DOMPurify are requested only once the page module runs; with the data in the
page that comes later, so the server made the article slower. Imported statically by `src/markdown.js`,
they download with the page and the article is faster with the server than without. They are
RealWorld's own libraries, not sinter: the size check (`scripts/size.mjs`) reports them apart from the
page budgets (marked 13.2 kB, DOMPurify 9.2 kB gzip); the article page is 22.3 kB of its 27 kB budget.

### Throughput (`oha`, 15 s, 32 connections, gzip)

Each server pinned to one core (all its threads), the mock API to another, the load generator to a
third. Every server ran at about 98% of its core; the API at 25-55% of its own.

| Pages per second, one core | Home | Article |
| --- | --- | --- |
| Qwik City SSR | 57 (p50 531 ms) | 199 (p50 153 ms) |
| Node middleware (`serve.mjs embed`) | 583 (p50 51 ms) | 1,096 (p50 28 ms) |
| **sinter-axum**, one Tokio thread | **2,156** (p50 14 ms) | **2,922** (p50 10 ms) |

About 35x Qwik's home pages and 3.5x the Node middleware's per core; on the article page, 15x and 2.7x.
A second run of 10 s gave 67, 595 and 1,884 home pages per second. Each page here is two API requests,
which the API answered in about 1 ms: a slower API changes the latency, not the CPU per page.

## Sinter.AspNetCore

[`packages/sinter-aspnetcore`](../packages/sinter-aspnetcore) is the same layer for ASP.NET Core. Its
`examples/RealWorld` is a port of sinter-axum's example server (the same resolver, gzip, cache headers),
published with NativeAOT. Measured 2026-11-13 against sinter-axum's example on another machine than the
tables above (a 4-core container), with the same method: `oha`, 15 s, 32 connections, the RealWorld build
with `SINTER_EMBED=1` and the mock API; each server pinned to one core, the API to a second, the load
generator to the other two, `accept-encoding: gzip` or `identity`. Both servers ran at 99% of their core
with gzip, the API at 34-38% of its own. Every page was the same byte for byte (24,840 bytes for home,
uncompressed), and gzip at each one's default level gave sizes within 4% (2,980 and 3,109 bytes).

| Pages per second, one core | Home, gzip | Article, gzip | Home | Article |
| --- | --- | --- | --- | --- |
| sinter-axum | 2,763 (p50 11.2 ms) | 3,526 (p50 8.7 ms) | 9,697 | 9,919 |
| Sinter.AspNetCore, NativeAOT | 2,689 (p50 11.5 ms) | 3,196 (p50 9.7 ms) | 8,656 | 10,572 |

The two are within about 10% of each other on every page; compression is most of the cost of a page.

## @tiaforge-ui/sinter/server

The same layer for JavaScript, on web-standard `Request` and `Response` ([server.md](server.md)), serving
the same pages: `bench/realworld/sinter-server.mjs`, a port of sinter-axum's example server (the same
resolver, cache headers; gzip on Node, flushed per chunk so the head still goes out first). Measured on
the same machine with the same method, in a later run that measured sinter-axum again; every server
returned the same pages, byte for byte.

| Pages per second, one core | Home, gzip | Article, gzip | Home | Article |
| --- | --- | --- | --- | --- |
| sinter-axum | 2,721 | 3,599 | 9,406 | 10,100 |
| sinter/server on Bun 1.4 (`Bun.serve`) | — | — | 5,814 | 7,710 |
| sinter/server on Node 22, API through `undici.request()` | 1,369 | 1,658 | 3,347 | 3,524 |
| sinter/server on Node 22, API through `fetch` | 1,085 | 1,281 | 1,978 | 1,907 |

- **The layer itself costs about 50 µs of CPU a page on Node, 30-45 µs on Bun**, measured in-process with
  the API answered from memory (half what it was before two changes: the scan for `<` in the API's JSON
  is a native one, as sinter-axum's, and the page and rule lookups are built once at startup).
- **Bun serves 60-75% of the Rust layer's pages**, with the same code that runs on Node. (Bun's server
  does not compress, so it has no gzip numbers.)
- **On Node, most of a page's cost is Node's own `fetch`**: a CPU profile under load puts the layer at
  about 3% of the time and Node's `fetch` (undici behind the WHATWG `Request` and `Response`) at the
  largest share. Giving the layer undici's `request()` instead (`fetch` option, [server.md](server.md#on-node))
  serves 69-85% more pages uncompressed and 26-29% more with gzip. The rest is Node's HTTP server, gzip
  and garbage collection; several processes use several cores.
- These pages fetch their data from an API server over HTTP. With the API in the same app (the in-process
  call `wrap(app.fetch)` makes), a page's requests use no HTTP client at all: below.

## With the API in the same app

The case the layers are built for: the API is routes of the same app, which the layer calls in-process
(sinter-axum's `.api(router)`, Sinter.AspNetCore's endpoints, `wrap(app.fetch)` over a Hono app). The
servers are in `bench/in-process` (`run.sh` runs them all): each API route answers with the same recorded
JSON, so the API does the same, trivial work in every language, and what is measured is the layer and
its server. Same pages and method as above (one core for the server, two for `oha`, 32 connections,
15 s), measured 2026-11-13 on the same machine; every server returned the same pages, byte for byte.

| Pages per second, one core | Home, gzip | Article, gzip | Home | Article |
| --- | --- | --- | --- | --- |
| sinter-axum | 3,092 | 3,942 | 28,679 | 31,306 |
| Sinter.AspNetCore, NativeAOT | 4,216 | 5,739 | 20,844 | 27,278 |
| sinter/server on Bun 1.4, Hono | — | — | 13,727 | 19,825 |
| sinter/server on Node 22, Hono | 1,499 | 1,776 | 6,467 | 7,035 |

- **Without compression, the layers serve 6,500-31,000 pages per second per core**, about three times
  as many as with an API over HTTP: the two API requests of a page were most of its cost.
- **With gzip, the compressor is most of the work.** Sinter.AspNetCore leads there because .NET's
  `Optimal` level compresses a little less (3,109 bytes for home, against 2,972 for tower-http's
  default), which costs less CPU.
- **Bun runs the JavaScript layer at about half the Rust layer's rate** (48-63%), Node at about a
  quarter (23%). On Node, a CPU profile under load puts the layer itself at about 3%: the rest is the
  `Request` and `Response` objects of a fetch handler (for the page and for each in-process call),
  socket writes and garbage collection.

## Limits

- Islands that render from data (the Markdown body) are not rendered early: they wait for the page module.
- Data only the browser knows (login in `localStorage`, as RealWorld keeps it) cannot be fetched by the
  middleware: it embeds the anonymous view (`favorited`, `following` false), embedded data is not
  reloaded, and the user's own feed still loads in the browser. Qwik needs cookies for the same reason.
- No real network or production deployment (CDN, an API with real latency): the API here answered in
  about 1 ms (a run with 50 and 200 ms API delays moved both servers alike).
- Chromium only for the comparison (the first-paint mechanism itself was checked in Firefox); one core
  per server.
