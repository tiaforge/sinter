# First paint with data: sinter compared with Qwik City

Measured 2026-11-10 on RealWorld's home and article pages. Scripts and the Qwik app: [`bench/first-paint/`](../bench/first-paint/).

## The question

Server rendering (Qwik City here) puts the data into the first frame, at the cost of rendering every page on the server. sinter builds static HTML. Can it reach the same first frame with a server that does almost nothing?

The variant that does it: a middleware fetches the page's API data and writes the JSON into the page's `data-sn-data` placeholders. The head script renders the bindings over it, rows included, as the parser goes, and the page module adopts those rows (docs/spec.md, "Embedded data renders early"). The middleware has no DOM and no renderer: it does a fetch and a string replacement.

## Setup

- **Apps.** sinter: `examples/realworld`, plus `data-sn-data` placeholders for `articles` and `tags` (home) and `article` and `comments` (article). Qwik: Qwik City 1.20, written for this comparison after `joma1021/realworld-qwik` (same markup and CSS, `useResource$` rendered on the server, cookie auth), in `bench/first-paint/qwik`. Running the reference app itself was not possible in the measuring environment.
- **The same work.** Both render the article body as plain text: the reference Qwik app does not render Markdown, while sinter's RealWorld does (in the browser, with marked and DOMPurify). With Markdown, sinter's article page LCP is about 400 ms later on slow 4G; that is the library's download and run, not the first-paint mechanism.
- **The same fonts:** none. sinter's build serves Google Fonts itself (`@font-face`), Qwik links them; both are stubbed, since a font file found after the first layout holds that text's paint.
- **Servers.** A mock RealWorld API with realistic payloads (`api.mjs`); a static server with immutable hashed assets and gzip (`serve.mjs`, with `embed` the middleware); Qwik's Node middleware with gzip. Everything local, on one 4-core machine.
- **Browser.** Headless Chromium. "Slow 4G": 150 ms latency, 1.6 Mbit/s, CPU 4× slower unless stated. Cold cache, median of 5 or 6 loads.

## Results

### First frame and LCP (`measure.mjs`)

Slow 4G, cold. "Data" is when the first article title is in the page; below first paint means the first paint has it.

| Page | sinter static | sinter + middleware | Qwik |
| --- | --- | --- | --- |
| Home: first paint / data / LCP | 528 / 864 / 916 ms | 588 / 517 / **588** ms | 560 / 466 / **560** ms |
| Article: first paint / data / LCP | 496 / 710 / 752 ms | 568 / 514 / **568** ms | 528 / 465 / **528** ms |

Unthrottled, the middleware variant is level with Qwik or ahead: home LCP 76 vs 84 ms, article 68 vs 72 ms. Static sinter paints first but its data comes one API round trip later.

### Server cost (`server-bench.mjs`)

No API delay; CPU time of the server process per request, 200 sequential requests, then 400 with 10 concurrent. One Node process each.

| Per request | CPU | Latency p50 | Throughput |
| --- | --- | --- | --- |
| Static files, home / article | 0.8 / 0.9 ms | 2.0 / 1.9 ms | 1,083 / 1,432 req/s |
| **sinter middleware**, home / article | **2.8 / 1.7 ms** | 3.6 / 2.3 ms | **640 / 722 req/s** |
| Qwik City SSR, home / article | 22 / 6.6 ms | 14 / 5.3 ms | 88 / 244 req/s |

The middleware costs 1–2 ms on top of serving the file (fetch, fill, gzip). Qwik's home page costs about 8× that, so a core serves about 7× fewer pages.

### Browser cost (`client-bench.mjs`)

Main-thread time until the content is painted (LCP), CPU 4× slower, network unthrottled.

| Until LCP | Busy | Script | Style, layout, paint |
| --- | --- | --- | --- |
| sinter static, home / article | 345 / 324 ms | 100 / 104 ms | 77 / 68 ms |
| **sinter + middleware**, home / article | **220 / 200 ms** | 42 / 41 ms | 68 / 50 ms |
| Qwik, home / article | 134 / 142 ms | 1 / 3 ms | 59 / 53 ms |

Qwik's HTML arrives rendered, so almost no script runs before its first paint; sinter's head script renders the rows during the parse. Over the whole load the two are close (home 293 vs 415 ms, article 344 vs 277 ms), since Qwik loads its code afterwards.

### Under load (`loadcmp.mjs`, `loadgen.mjs`)

Home page, slow 4G, while the server under test takes a steady stream of other requests (open loop). First paint = LCP throughout. The last column is the latency those other requests saw.

| CPU | Load | sinter + middleware: first byte / paint | Qwik: first byte / paint | Qwik under load p50 / p90 |
| --- | --- | --- | --- | --- |
| 1× | idle | 7 / 480 ms | 19 / 460 ms | – |
| 1× | 80/s | 5 / 472 ms | 44 / 476 ms | 20 / 63 ms |
| 1× | 100/s | 5 / 472 ms | 112 / 488 ms | 58 / 143 ms |
| 1× | 120/s | 7 / 476 ms | 1,646 / 4,152 ms, 2 of 5 timed out | 1,914 / 3,358 ms |
| 2× | idle | 6 / 500 ms | 18 / 488 ms | – |
| 2× | 80/s | 5 / 500 ms | 40 / 500 ms | 17 / 45 ms |
| 4× | idle | 6 / 592 ms | 15 / 548 ms | – |
| 4× | 80/s | 6 / 552 ms | 31 / 540 ms | 18 / 55 ms |
| 4× | 120/s | 6 / 548 ms | 1,561 / 4,096 ms, 2 of 5 timed out | 2,540 / 6,376 ms |

The middleware's own latency stayed at 2–3 ms at every rate. Warm navigations (the article first, then the home page, full page loads): idle, sinter 472 vs Qwik 480 ms at 1×, 528 vs 520 ms at 4×; at 80/s, 468 vs 504 ms at 1× and 528 vs 576 ms at 4×.

### Where each server breaks (`limit.mjs`)

Home page, open-loop load stepped up, 6 s per step; latency the load saw, and the server process's CPU (one Node process, % of one core; above 100% is gzip in worker threads). The mock API and the load generator stayed below 25% throughout.

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

The same curve, an order of magnitude apart: Qwik breaks between 100 and 120 pages per second per core, the middleware between 1,000 and 1,200.

## Findings

1. **The same first frame without server rendering.** With a middleware that only writes the JSON in, sinter's first paint has the data, as Qwik's does: LCP equals first paint on both pages.
2. **Within 30–40 ms of Qwik on slow devices, level or ahead on fast ones.** On a 4× slower CPU, sinter's head script spends about 40 ms rendering rows before the first paint; at 1× that is about 10 ms. Part of the remaining gap at 1× is bytes: on a cold load the two head scripts (about 4.8 kB gzip) share the slow link with the stylesheets.
3. **The cost sits in different places.** Per page, about 3 ms on the server plus about 55 ms in the browser (at 1×, home) for sinter, against about 22 ms on the server plus about 34 ms in the browser for Qwik. Qwik pays per request, on the server, for every visitor.
4. **No scaling problem.** A Qwik server core saturates at about 100–120 home pages per second: past that, pages time out. The middleware's core saturates at about 1,000–1,200, so the same traffic needs about a tenth of the servers. Where server compute is expensive (an edge function billed per CPU millisecond), that is the difference: about 2 ms against 22 ms per page.
5. **Server time shows little in first paint until the server queues.** On slow 4G the first paint waits mostly for the network; Qwik's 20–40 ms later first byte moved its first paint by 10–15 ms.

## Not measured

- Islands that render from data (the Markdown body) are not rendered early: they wait for the page module.
- Data only the browser knows (login in localStorage, as RealWorld keeps it) cannot be fetched by the middleware: the user's own feed still loads in the browser. Qwik needs cookies for the same reason.
- Real networks and a production deployment (CDN, an API with real latency): the API here answered in about 1 ms (a run with 50 and 200 ms API delays moved both servers alike).
- Firefox and Safari: the comparison ran in Chromium (the first-paint mechanism itself was checked in Firefox).
