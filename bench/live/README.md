# Live dashboard benchmark: sinter, Solid, Svelte, Vue, Datastar, htmx

A dashboard fed by one SSE stream at rising rates: three line charts (SVG paths over a 120-point
window each), 16 bars and a 50-row table. Every tick moves the three charts and the bars and changes
5 rows. How fast can each library keep the page current, and what does it cost the main thread?

| variant | wire | rendering |
| --- | --- | --- |
| `sinter` | JSON `tick` event | `<sn-sync>` + `<sn-event then="s = advance(s, …)">`; bindings over one state value ([`apps/sinter`](apps/sinter)) |
| `solid` | JSON | signals per window and the bars, a store for the hosts, each tick in `batch()` (Solid 1.9.18) |
| `svelte` | JSON | `$state.raw` windows and bars, deep `$state` hosts changed in place (Svelte 5.57.3) |
| `vue` | JSON | `shallowRef` windows and bars, `reactive` hosts changed in place (Vue 3.5.45) |
| `datastar` | `datastar-patch-signals` | the server sends the changed values, formatted; `data-text`, `data-attr:d`, `data-style:height` show them (Datastar 1.0.4) |
| `datastar-elements` | `datastar-patch-elements` | the server renders the changed elements, morphed by id |
| `htmx` | HTML `tick` event | `sse-swap` on `#seq`, everything else `hx-swap-oob` (htmx 2.0.11, htmx-ext-sse 2.2.4) |

The JSON clients share the data model and the formatting and path functions
([`shared/model.js`](shared/model.js)), so they differ only in how they turn state into DOM. The
hypermedia variants' server keeps the view state and renders or formats per tick
([`server.mjs`](server.mjs)); that work is outside the browser, but its delay counts (below).

## Method

- **Harness** ([`shared/harness.js`](shared/harness.js)), the same classic script first in every
  page: a MutationObserver sees each new `#seq` (every variant renders the tick's seq with its
  changes); the end of the following frame (rAF, then a message) is its paint. It counts frames and
  long tasks.
- **Latency** is measured from when the server had the tick due (the server schedules ticks on its
  clock and reports the schedule; one machine, one clock), so a server or a browser that falls
  behind both show up. `dom`: to the DOM; `frame`: to the end of the next frame (event-to-paint).
- **Steps** ([`run.mjs`](run.mjs)): each variant in a fresh headless Chrome tab; per rate 1 s
  warm-up, 3 s measured, then the stream pauses until the page shows the last tick sent. A variant
  that does not catch up within 10 s (or whose frame p95 passes 2 s) gets no faster rates.
  "Keeps up" = caught up and frame p95 under 100 ms.
- **Main thread** from the DevTools protocol (`Performance.getMetrics`): busy = task time / wall
  time; script; style + layout. Heap: JS heap used, after a forced GC before and after the run.
- **Correctness:** before measuring, the stream was paused after ~200 ticks and every variant's
  DOM (paths, captions, bar heights and labels, every row and its class) compared with the model's
  state at that seq: all equal.

```sh
npm run build                              # in the repo root (sinter's dist/)
cd bench/live && npm install
mkdir -p vendor && curl -sfLo vendor/datastar-1.0.4.js https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.4/bundles/datastar.js
#   sha256 727844adfc825ee651fb93c544a2a739986f9a21820a94524b35f0cac470cf91 (also on raw.githubusercontent.com/starfederation/datastar/v1.0.4/bundles/datastar.js)
node build.mjs                             # dist/<variant>/
CHROME=/path/to/chrome node run.mjs        # tables on stdout, raw numbers in results/
# CPU=4 (throttling) RATES=25,50,100 STEP=3000 WARM=1000 ONLY=sinter,datastar CHROME_ARGS=--no-sandbox
node server.mjs 4500                       # to look: http://127.0.0.1:4500/sinter/ and /control?rate=100
```

A run of all variants takes about 5 minutes per CPU setting; one variant about 1.5.

## Results

2026-11-10, Chrome for Testing 153 headless, 4-core cloud VM; server, browser and runner on the
same machine. sinter 0.13.1. One run per cell: good enough to compare approaches, not to rank
close results. Raw numbers: [`results/`](results).

Highest rate kept up with (ticks/s):

| CPU | sinter | Solid | Svelte | Vue | Datastar signals | Datastar elements | htmx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1x | 2000 | 2000 | 2000 | 1000 | 2000 | 1000 | 500 |
| 4x throttled | 200 | 200 | 200 | 200 | 200 | 100 | 25 |

- The JSON clients render every event: each SSE message is a task, and each flush runs in that
  task's microtasks. At 5,000/s they all saturate (about 3,700 shown/s, 1 fps).
- Datastar reads the stream with `fetch` and applies the messages of one network chunk together:
  it shows fewer ticks than were sent (546 of 1,000/s) with latency still low, and its busy time
  grows more slowly. Its server also sends formatted values, so its client formats nothing.
- At 4x and 200/s the four JSON clients are at 88–95 % busy. One step up (500/s), Solid still paints
  27 fps; sinter 8, Svelte 6, Vue none. sinter's page replaces one state value per tick, so every
  binding is checked.
- Heap after GC stayed between 0.6 and 2.2 MB for every variant.

### CPU 1x

| variant | rate/s | shown/s | fps | dom p50 / p95 | frame p50 / p95 | busy % | script % | style+layout % | long tasks (ms) | heap MB | drain ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 50 | 50 | 60 | 1.6 / 2.3 | 12.1 / 19.3 | 13 | 3 | 4 | 0 (0) | 1.0 | 1 |
| sinter | 100 | 100 | 60 | 1.7 / 2.4 | 10.2 / 17.6 | 18 | 5 | 5 | 0 (0) | 2.4 | 1 |
| sinter | 200 | 200 | 60 | 1.6 / 3.1 | 11.7 / 19.5 | 25 | 8 | 6 | 0 (0) | 2.6 | 1 |
| sinter | 500 | 500 | 60 | 1.5 / 3.3 | 11.7 / 19.4 | 39 | 18 | 7 | 0 (0) | 4.4 | 1 |
| sinter | 1000 | 1003 | 59 | 1.7 / 4.8 | 12.7 / 21.5 | 65 | 36 | 9 | 0 (0) | 4.2 | 5 |
| sinter | 2000 | 2008 | 58 | 2.2 / 6.9 | 13.4 / 37.5 | 87 | 58 | 8 | 1 (72) | 5.9 | 2 |
| sinter | 5000 | 3700 | 1 | 1694.0 / 2543.3 | 2528.0 / 3394.5 | 100 | 86 | 0 | 4 (5703) | 16.8 | no |
| solid | 50 | 50 | 60 | 1.4 / 1.9 | 10.3 / 17.3 | 12 | 2 | 4 | 0 (0) | 1.6 | 1 |
| solid | 100 | 100 | 60 | 1.5 / 2.7 | 11.8 / 19.1 | 16 | 4 | 5 | 0 (0) | 1.1 | 1 |
| solid | 200 | 200 | 60 | 1.3 / 3.1 | 11.0 / 19.3 | 23 | 7 | 6 | 0 (0) | 1.5 | 1 |
| solid | 500 | 501 | 60 | 1.3 / 3.0 | 11.4 / 19.1 | 36 | 16 | 7 | 0 (0) | 2.9 | 1 |
| solid | 1000 | 1003 | 60 | 1.4 / 3.8 | 12.0 / 19.8 | 55 | 29 | 8 | 0 (0) | 4.1 | 1 |
| solid | 2000 | 2001 | 60 | 1.7 / 4.7 | 12.4 / 23.5 | 80 | 51 | 8 | 0 (0) | 8.3 | 20 |
| solid | 5000 | 3703 | 1 | 1315.6 / 2234.4 | 2163.5 / 3067.5 | 100 | 86 | 0 | 4 (5372) | 3.7 | no |
| svelte | 50 | 50 | 60 | 1.6 / 2.4 | 12.3 / 19.3 | 14 | 3 | 4 | 0 (0) | 3.8 | 1 |
| svelte | 100 | 100 | 60 | 1.4 / 3.2 | 12.2 / 19.6 | 19 | 5 | 5 | 0 (0) | 1.8 | 1 |
| svelte | 200 | 200 | 60 | 1.3 / 2.1 | 10.9 / 18.5 | 23 | 8 | 6 | 0 (0) | 7.1 | 1 |
| svelte | 500 | 501 | 60 | 1.4 / 3.2 | 11.6 / 19.2 | 39 | 18 | 7 | 0 (0) | 6.0 | 1 |
| svelte | 1000 | 1001 | 60 | 1.5 / 4.3 | 12.1 / 20.3 | 61 | 34 | 9 | 0 (0) | 11.2 | 1 |
| svelte | 2000 | 2017 | 57 | 2.1 / 6.4 | 13.8 / 42.9 | 86 | 57 | 8 | 0 (0) | 27.9 | 17 |
| svelte | 5000 | 3705 | 1 | 2025.1 / 2969.0 | 2874.5 / 3904.4 | 100 | 86 | 0 | 4 (6211) | 44.5 | no |
| vue | 50 | 50 | 60 | 1.9 / 2.5 | 11.0 / 18.2 | 15 | 1 | 4 | 0 (0) | 1.8 | 1 |
| vue | 100 | 100 | 60 | 1.6 / 2.3 | 10.8 / 18.2 | 20 | 1 | 5 | 0 (0) | 3.7 | 6 |
| vue | 200 | 200 | 60 | 1.5 / 2.8 | 11.3 / 19.1 | 25 | 1 | 6 | 0 (0) | 2.6 | 1 |
| vue | 500 | 501 | 60 | 1.5 / 4.1 | 12.1 / 20.1 | 50 | 3 | 9 | 0 (0) | 1.4 | 4 |
| vue | 1000 | 1001 | 60 | 2.1 / 6.1 | 13.2 / 29.3 | 82 | 5 | 10 | 0 (0) | 7.8 | 1 |
| vue | 2000 | 2239 | 35 | 5.3 / 106.9 | 22.3 / 572.4 | 96 | 5 | 4 | 6 (2901) | 2.7 | 28 |
| vue | 5000 | 2463 | 1 | 1851.6 / 2614.0 | 2947.7 / 3612.7 | 100 | 5 | 0 | 2 (3317) | 28.4 | no |
| datastar | 50 | 50 | 60 | 2.0 / 2.7 | 10.5 / 17.7 | 13 | 3 | 4 | 0 (0) | 2.3 | 1 |
| datastar | 100 | 100 | 60 | 1.8 / 3.6 | 12.3 / 19.8 | 18 | 4 | 5 | 0 (0) | 2.8 | 1 |
| datastar | 200 | 200 | 60 | 1.8 / 3.1 | 11.6 / 19.5 | 26 | 8 | 7 | 0 (0) | 3.8 | 1 |
| datastar | 500 | 466 | 60 | 1.7 / 2.9 | 11.8 / 19.0 | 40 | 16 | 7 | 0 (0) | 4.7 | 1 |
| datastar | 1000 | 546 | 60 | 1.8 / 3.4 | 12.0 / 19.3 | 63 | 29 | 10 | 0 (0) | 7.9 | 6 |
| datastar | 2000 | 392 | 60 | 2.4 / 5.8 | 12.1 / 21.2 | 85 | 47 | 11 | 0 (0) | 6.7 | 11 |
| datastar | 5000 | 10 | 10 | 198.3 / 221.1 | 209.4 / 315.6 | 100 | 77 | 2 | 30 (2818) | 12.7 | no |
| datastar-elements | 50 | 50 | 60 | 2.5 / 3.3 | 12.5 / 19.8 | 18 | 6 | 4 | 0 (0) | 1.3 | 1 |
| datastar-elements | 100 | 100 | 60 | 2.2 / 3.0 | 10.7 / 18.1 | 26 | 10 | 5 | 0 (0) | 1.4 | 1 |
| datastar-elements | 200 | 200 | 60 | 2.1 / 3.7 | 11.3 / 19.5 | 35 | 16 | 6 | 0 (0) | 3.3 | 1 |
| datastar-elements | 500 | 431 | 60 | 2.3 / 4.3 | 12.0 / 19.8 | 71 | 41 | 8 | 0 (0) | 4.1 | 1 |
| datastar-elements | 1000 | 160 | 45 | 3.5 / 28.8 | 13.5 / 39.9 | 98 | 70 | 7 | 4 (248) | 6.0 | 75 |
| datastar-elements | 2000 | 4 | 4 | 885.7 / 1235.4 | 890.4 / 1244.8 | 100 | 86 | 1 | 12 (2961) | 29.2 | no |
| htmx | 50 | 50 | 60 | 3.2 / 4.3 | 11.1 / 18.6 | 28 | 13 | 6 | 0 (0) | 1.9 | 1 |
| htmx | 100 | 100 | 60 | 2.8 / 5.2 | 12.3 / 19.6 | 40 | 23 | 7 | 0 (0) | 1.6 | 1 |
| htmx | 200 | 200 | 60 | 2.7 / 4.8 | 11.7 / 19.9 | 60 | 39 | 7 | 0 (0) | 2.0 | 1 |
| htmx | 500 | 507 | 35 | 7.3 / 18.5 | 24.9 / 98.4 | 100 | 86 | 6 | 10 (694) | 17.0 | 23 |
| htmx | 1000 | 656 | 4 | 1072.3 / 1637.0 | 1149.5 / 1687.6 | 100 | 96 | 1 | 12 (3446) | 31.2 | no |

### CPU 4x

| variant | rate/s | shown/s | fps | dom p50 / p95 | frame p50 / p95 | busy % | script % | style+layout % | long tasks (ms) | heap MB | drain ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 25 | 25 | 60 | 4.0 / 6.6 | 17.8 / 26.4 | 32 | 7 | 11 | 0 (0) | 1.8 | 5 |
| sinter | 50 | 50 | 60 | 4.0 / 11.5 | 18.0 / 27.4 | 56 | 12 | 19 | 0 (0) | 1.5 | 1 |
| sinter | 100 | 101 | 60 | 5.1 / 13.1 | 17.8 / 27.9 | 71 | 19 | 21 | 0 (0) | 2.2 | 6 |
| sinter | 200 | 201 | 55 | 6.1 / 16.9 | 18.9 / 55.9 | 90 | 32 | 23 | 0 (0) | 2.9 | 11 |
| sinter | 500 | 541 | 8 | 28.0 / 172.9 | 191.7 / 849.7 | 100 | 78 | 5 | 12 (2401) | 3.4 | 40 |
| sinter | 1000 | 1234 | 0 | 5221.7 / 6240.2 | 9110.7 / 10776.7 | 100 | 84 | 0 | 2 (14623) | 2.7 | 14504 |
| solid | 25 | 25 | 60 | 3.6 / 6.6 | 17.6 / 26.5 | 29 | 6 | 10 | 0 (0) | 1.1 | 2 |
| solid | 50 | 50 | 60 | 3.0 / 7.1 | 15.4 / 24.3 | 45 | 9 | 15 | 0 (0) | 1.8 | 3 |
| solid | 100 | 100 | 60 | 3.3 / 9.7 | 16.4 / 25.0 | 60 | 14 | 18 | 0 (0) | 1.9 | 7 |
| solid | 200 | 201 | 53 | 6.7 / 20.9 | 19.7 / 72.8 | 88 | 31 | 23 | 1 (61) | 1.6 | 10 |
| solid | 500 | 507 | 27 | 10.3 / 21.9 | 41.1 / 105.0 | 100 | 57 | 15 | 2 (178) | 3.1 | 26 |
| solid | 1000 | 1235 | 0 | 4542.4 / 5766.2 | 8625.5 / 10292.5 | 100 | 83 | 0 | 2 (14145) | 4.6 | 12121 |
| svelte | 25 | 25 | 60 | 3.9 / 6.6 | 18.8 / 28.0 | 31 | 7 | 10 | 0 (0) | 2.6 | 6 |
| svelte | 50 | 50 | 60 | 3.6 / 7.8 | 16.4 / 25.1 | 48 | 11 | 16 | 0 (0) | 3.5 | 1 |
| svelte | 100 | 100 | 60 | 4.0 / 11.2 | 16.6 / 27.1 | 65 | 18 | 19 | 0 (0) | 4.2 | 16 |
| svelte | 200 | 200 | 54 | 7.0 / 17.7 | 20.0 / 50.9 | 91 | 31 | 24 | 0 (0) | 1.8 | 13 |
| svelte | 500 | 618 | 6 | 103.2 / 508.8 | 479.2 / 1963.2 | 100 | 79 | 3 | 6 (9337) | 28.0 | 40 |
| svelte | 1000 | 1232 | 0 | 5516.3 / 7172.7 | 9925.9 / 11588.9 | 100 | 86 | 0 | 2 (15440) | 29.4 | no |
| vue | 25 | 25 | 60 | 4.2 / 6.1 | 18.3 / 27.1 | 32 | 2 | 10 | 0 (0) | 2.7 | 1 |
| vue | 50 | 50 | 60 | 4.1 / 10.3 | 18.0 / 26.6 | 54 | 2 | 17 | 0 (0) | 2.4 | 2 |
| vue | 100 | 100 | 60 | 4.9 / 11.6 | 17.2 / 26.3 | 73 | 4 | 20 | 0 (0) | 4.5 | 3 |
| vue | 200 | 202 | 57 | 6.9 / 16.3 | 19.0 / 39.3 | 95 | 6 | 23 | 0 (0) | 3.3 | 46 |
| vue | 500 | 1236 | 0 | 1981.1 / 2983.2 | 7631.7 / 10967.7 | 100 | 6 | 0 | 0 (0) | 6.0 | 4088 |
| datastar | 25 | 25 | 60 | 4.6 / 6.4 | 18.7 / 26.8 | 32 | 7 | 10 | 0 (0) | 1.4 | 3 |
| datastar | 50 | 50 | 60 | 4.9 / 11.3 | 19.1 / 28.2 | 58 | 13 | 18 | 0 (0) | 2.1 | 1 |
| datastar | 100 | 88 | 59 | 6.5 / 14.0 | 18.4 / 29.9 | 79 | 20 | 23 | 0 (0) | 2.2 | 1 |
| datastar | 200 | 113 | 58 | 5.1 / 11.3 | 16.5 / 30.5 | 90 | 27 | 23 | 0 (0) | 2.3 | 12 |
| datastar | 500 | 27 | 27 | 19.3 / 59.0 | 37.2 / 107.3 | 100 | 50 | 16 | 6 (402) | 6.4 | 80 |
| datastar | 1000 | 2 | 2 | 1140.8 / 1453.7 | 1172.4 / 1470.4 | 100 | 82 | 1 | 6 (3013) | 10.5 | no |
| datastar-elements | 25 | 25 | 61 | 7.3 / 11.5 | 19.1 / 29.2 | 42 | 15 | 10 | 0 (0) | 1.4 | 2 |
| datastar-elements | 50 | 50 | 61 | 7.9 / 14.5 | 19.8 / 27.4 | 72 | 25 | 18 | 0 (0) | 1.2 | 1 |
| datastar-elements | 100 | 63 | 49 | 11.1 / 26.9 | 21.1 / 54.5 | 96 | 43 | 20 | 0 (0) | 1.4 | 8 |
| datastar-elements | 200 | 12 | 12 | 55.7 / 154.0 | 96.5 / 296.9 | 100 | 69 | 10 | 17 (1573) | 5.3 | 106 |
| datastar-elements | 500 | 1 | 1 | 1524.4 / 2404.6 | 1540.0 / 2422.7 | 100 | 87 | 1 | 2 (1608) | 3.8 | no |
| htmx | 25 | 25 | 58 | 13.8 / 22.5 | 26.8 / 40.3 | 75 | 38 | 16 | 0 (0) | 1.5 | 2 |
| htmx | 50 | 50 | 29 | 20.6 / 40.8 | 43.3 / 150.7 | 99 | 64 | 15 | 5 (427) | 1.4 | 14 |
| htmx | 100 | 104 | 3 | 46.3 / 111.2 | 199.8 / 761.1 | 100 | 92 | 3 | 9 (2273) | 7.6 | 100 |
| htmx | 200 | 179 | 1 | 1397.9 / 2066.6 | 2146.4 / 3075.2 | 100 | 96 | 1 | 4 (5614) | 9.6 | no |
