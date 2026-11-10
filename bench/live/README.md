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
  changes). Its paint is the frame whose ResizeObserver callback (after every rAF callback and
  layout, just before paint) comes next, timed by a message posted there; so a library that renders
  in a rAF callback counts in the frame it renders in. It counts frames and long tasks.
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

A run of all variants takes about 5 minutes per CPU setting. For iterating, `QUICK=1` runs both
CPU settings at three rates each with 1 s steps (about 15 s a variant) and keeps no results file;
`node profile.mjs sinter 1000 4` lists self time by function (build with `MINIFY=0` for names).

## Results

2026-11-10, Chrome for Testing 153 headless (frames at 60 Hz), 4-core cloud VM; server, browser and
runner on the same machine. One run per cell: good enough to compare approaches, not to rank close
results. Raw numbers: [`results/`](results).

Highest rate kept up with (ticks/s; the runs went up to 5,000):

| CPU | sinter | Solid | Svelte | Vue | Datastar signals | Datastar elements | htmx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1x | **5000** | 2000 | 1000 | 1000 | 2000 | 1000 | 200 |
| 4x throttled | **5000** | 200 | 200 | 200 | 200 | 100 | 25 |

- sinter renders the changes of server events once per frame (since this run; see below). At 5,000
  ticks/s it painted 60 fps with frame p95 6.7 ms at 36 % main thread (1x), and 43 fps with frame
  p95 44 ms at 4x, never falling behind. The other JSON clients render every event: each SSE message
  is a task, and each flush runs in its microtasks, so at 4x they saturate between 200 and 500/s.
- Datastar reads the stream with `fetch` and applies the messages of one network chunk together: it
  shows fewer ticks than were sent with latency still low, and its server sends formatted values,
  so its client formats nothing. It saturates at 4x above 200/s.
- What 1,000–2,000 SSE messages a second cost with no rendering, at 4x: 23–26 % of the main thread
  with EventSource, 29–32 % reading the same stream with `fetch` (two floor pages, not kept). The
  transport is not what limits the rate.
- Heap after GC stayed between 0.6 and 2.2 MB for every variant.

Before (commit fdca219, sinter 0.13.1, rendering every event, and the harness timing paints from
the next rAF): sinter kept up to 2,000/s at 1x and 200/s at 4x, level with Solid and Svelte.

### CPU 1x

| variant | keeps up to (ticks/s) | heap after GC, start → end (MB) |
| --- | ---: | ---: |
| sinter | 5000 | 0.8 → 1.2 |
| solid | 2000 | 0.8 → 2.0 |
| svelte | 1000 | 0.9 → 2.2 |
| vue | 1000 | 0.9 → 1.7 |
| datastar | 2000 | 1.1 → 1.5 |
| datastar-elements | 1000 | 0.7 → 0.9 |
| htmx | 200 | 0.6 → 1.1 |

| variant | rate/s | shown/s | fps | dom p50 / p95 | frame p50 / p95 | busy % | script % | style+layout % | long tasks (ms) | heap MB | drain ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 50 | 1 | 1 | 18.3 / 22.1 | 22.1 / 28.0 | 2 | 1 | 0 | 0 (0) | 1.1 | 105 |
| sinter | 100 | 1 | 1 | 6.7 / 6.7 | 11.7 / 11.7 | 2 | 1 | 0 | 0 (0) | 1.6 | 53 |
| sinter | 200 | 57 | 57 | 4.3 / 6.2 | 6.7 / 8.9 | 21 | 5 | 6 | 0 (0) | 2.2 | 53 |
| sinter | 500 | 60 | 60 | 2.7 / 3.7 | 5.2 / 6.8 | 26 | 6 | 7 | 0 (0) | 1.3 | 53 |
| sinter | 1000 | 60 | 60 | 2.2 / 3.2 | 5.6 / 7.0 | 33 | 7 | 9 | 0 (0) | 3.3 | 53 |
| sinter | 2000 | 60 | 60 | 2.1 / 2.9 | 5.3 / 7.0 | 33 | 8 | 9 | 0 (0) | 4.3 | 53 |
| sinter | 5000 | 60 | 60 | 1.8 / 2.5 | 5.0 / 6.7 | 36 | 9 | 8 | 0 (0) | 5.4 | 55 |
| solid | 50 | 50 | 60 | 1.6 / 2.6 | 10.3 / 19.5 | 15 | 3 | 5 | 0 (0) | 1.7 | 1 |
| solid | 100 | 100 | 60 | 1.4 / 2.9 | 12.3 / 19.4 | 16 | 4 | 5 | 0 (0) | 1.7 | 1 |
| solid | 200 | 200 | 60 | 1.3 / 2.4 | 11.8 / 18.7 | 23 | 7 | 6 | 0 (0) | 1.7 | 2 |
| solid | 500 | 501 | 60 | 1.3 / 3.1 | 12.3 / 19.9 | 38 | 16 | 7 | 0 (0) | 2.7 | 3 |
| solid | 1000 | 1002 | 60 | 1.4 / 3.8 | 13.8 / 21.5 | 56 | 29 | 8 | 0 (0) | 2.8 | 1 |
| solid | 2000 | 2002 | 55 | 2.4 / 6.9 | 21.2 / 61.9 | 88 | 58 | 8 | 1 (55) | 5.8 | 2 |
| solid | 5000 | 3695 | 1 | 1697.8 / 2488.0 | 2472.0 / 3377.0 | 100 | 86 | 0 | 4 (5681) | 7.4 | no |
| svelte | 50 | 50 | 60 | 1.7 / 2.7 | 12.4 / 19.6 | 14 | 3 | 4 | 0 (0) | 3.9 | 1 |
| svelte | 100 | 100 | 60 | 1.4 / 2.1 | 10.0 / 17.5 | 19 | 5 | 5 | 0 (0) | 3.5 | 1 |
| svelte | 200 | 200 | 60 | 1.5 / 3.4 | 12.7 / 19.9 | 28 | 9 | 7 | 0 (0) | 10.0 | 1 |
| svelte | 500 | 501 | 60 | 1.5 / 3.8 | 13.4 / 21.0 | 44 | 20 | 8 | 0 (0) | 11.2 | 1 |
| svelte | 1000 | 1002 | 60 | 1.8 / 5.0 | 16.1 / 24.6 | 72 | 39 | 10 | 0 (0) | 15.6 | 4 |
| svelte | 2000 | 2318 | 32 | 6.8 / 60.3 | 86.9 / 674.6 | 96 | 75 | 4 | 7 (2365) | 22.8 | 37 |
| svelte | 5000 | 3700 | 1 | 1704.9 / 2683.3 | 2211.7 / 2936.2 | 100 | 84 | 0 | 2 (2937) | 42.2 | no |
| vue | 50 | 50 | 60 | 1.9 / 2.9 | 12.8 / 20.1 | 16 | 1 | 5 | 0 (0) | 2.8 | 1 |
| vue | 100 | 100 | 60 | 1.8 / 3.9 | 11.7 / 20.2 | 24 | 1 | 6 | 0 (0) | 4.1 | 2 |
| vue | 200 | 200 | 60 | 1.7 / 3.7 | 12.7 / 20.3 | 33 | 2 | 8 | 0 (0) | 4.4 | 2 |
| vue | 500 | 501 | 60 | 1.7 / 4.1 | 13.8 / 21.8 | 52 | 3 | 9 | 0 (0) | 3.4 | 2 |
| vue | 1000 | 1001 | 60 | 1.9 / 5.7 | 17.4 / 29.7 | 78 | 5 | 10 | 0 (0) | 13.4 | 1 |
| vue | 2000 | 2463 | 1 | 366.2 / 466.9 | 1475.6 / 2306.7 | 100 | 5 | 0 | 2 (4187) | 12.9 | 652 |
| datastar | 50 | 50 | 60 | 2.2 / 3.3 | 11.5 / 18.4 | 16 | 3 | 5 | 0 (0) | 2.3 | 1 |
| datastar | 100 | 100 | 60 | 2.1 / 3.2 | 11.7 / 19.1 | 22 | 5 | 6 | 0 (0) | 1.8 | 2 |
| datastar | 200 | 200 | 60 | 1.8 / 3.9 | 12.9 / 20.4 | 30 | 9 | 8 | 0 (0) | 1.6 | 1 |
| datastar | 500 | 456 | 60 | 1.8 / 3.2 | 12.7 / 19.9 | 45 | 17 | 8 | 0 (0) | 5.1 | 1 |
| datastar | 1000 | 500 | 60 | 2.0 / 4.0 | 14.0 / 21.2 | 69 | 32 | 11 | 0 (0) | 5.7 | 3 |
| datastar | 2000 | 344 | 60 | 2.5 / 7.9 | 15.2 / 25.0 | 85 | 47 | 11 | 0 (0) | 17.5 | 62 |
| datastar | 5000 | 9 | 9 | 688.1 / 888.1 | 682.4 / 986.3 | 100 | 79 | 2 | 26 (2882) | 30.6 | no |
| datastar-elements | 50 | 50 | 60 | 2.8 / 3.9 | 11.2 / 18.9 | 21 | 6 | 5 | 0 (0) | 1.4 | 1 |
| datastar-elements | 100 | 100 | 60 | 2.5 / 3.6 | 11.1 / 18.6 | 28 | 11 | 6 | 0 (0) | 1.8 | 1 |
| datastar-elements | 200 | 200 | 60 | 2.4 / 4.4 | 13.4 / 20.6 | 41 | 18 | 7 | 0 (0) | 1.6 | 2 |
| datastar-elements | 500 | 452 | 60 | 2.0 / 3.7 | 13.1 / 20.5 | 66 | 37 | 7 | 0 (0) | 3.0 | 1 |
| datastar-elements | 1000 | 391 | 60 | 2.3 / 6.9 | 14.6 / 24.1 | 93 | 59 | 8 | 0 (0) | 3.4 | 4 |
| datastar-elements | 2000 | 6 | 6 | 474.6 / 583.1 | 478.5 / 586.5 | 100 | 87 | 1 | 17 (3214) | 11.9 | no |
| htmx | 50 | 50 | 60 | 3.3 / 4.7 | 10.8 / 18.2 | 29 | 14 | 6 | 0 (0) | 2.3 | 1 |
| htmx | 100 | 100 | 60 | 3.4 / 5.1 | 14.2 / 19.3 | 47 | 26 | 8 | 0 (0) | 3.6 | 1 |
| htmx | 200 | 201 | 60 | 3.0 / 5.7 | 13.7 / 22.3 | 66 | 44 | 8 | 0 (0) | 2.7 | 2 |
| htmx | 500 | 418 | 2 | 647.3 / 762.7 | 826.0 / 1072.3 | 100 | 96 | 1 | 8 (3355) | 24.0 | no |

### CPU 4x

| variant | keeps up to (ticks/s) | heap after GC, start → end (MB) |
| --- | ---: | ---: |
| sinter | 5000 | 0.8 → 1.2 |
| solid | 200 | 0.8 → 1.6 |
| svelte | 200 | 0.9 → 1.8 |
| vue | 200 | 0.9 → 1.5 |
| datastar | 200 | 1.1 → 1.5 |
| datastar-elements | 100 | 0.7 → 0.9 |
| htmx | 25 | 0.6 → 1.0 |

| variant | rate/s | shown/s | fps | dom p50 / p95 | frame p50 / p95 | busy % | script % | style+layout % | long tasks (ms) | heap MB | drain ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 25 | 25 | 60 | 11.9 / 19.8 | 20.4 / 30.6 | 42 | 8 | 11 | 0 (0) | 1.8 | 8 |
| sinter | 50 | 50 | 60 | 10.9 / 18.2 | 19.3 / 29.6 | 56 | 12 | 18 | 0 (0) | 1.5 | 7 |
| sinter | 100 | 60 | 60 | 8.8 / 13.1 | 17.8 / 25.6 | 72 | 15 | 24 | 0 (0) | 2.2 | 67 |
| sinter | 200 | 57 | 57 | 6.4 / 11.1 | 17.9 / 28.0 | 89 | 19 | 29 | 0 (0) | 2.0 | 66 |
| sinter | 500 | 50 | 50 | 5.6 / 10.3 | 18.8 / 33.4 | 94 | 20 | 31 | 0 (0) | 1.4 | 68 |
| sinter | 1000 | 48 | 48 | 5.0 / 9.1 | 19.5 / 39.2 | 99 | 23 | 33 | 0 (0) | 3.6 | 70 |
| sinter | 2000 | 50 | 50 | 4.5 / 8.3 | 19.6 / 34.5 | 99 | 25 | 31 | 0 (0) | 3.2 | 63 |
| sinter | 5000 | 43 | 43 | 4.6 / 7.4 | 22.9 / 44.1 | 100 | 30 | 27 | 0 (0) | 3.3 | 24 |
| solid | 25 | 25 | 60 | 4.1 / 7.4 | 18.3 / 25.7 | 42 | 7 | 12 | 0 (0) | 1.2 | 2 |
| solid | 50 | 50 | 60 | 4.9 / 11.0 | 19.0 / 30.3 | 59 | 12 | 19 | 0 (0) | 1.6 | 1 |
| solid | 100 | 100 | 59 | 5.3 / 13.3 | 20.3 / 35.5 | 80 | 19 | 24 | 0 (0) | 1.5 | 18 |
| solid | 200 | 202 | 54 | 6.8 / 16.9 | 25.6 / 61.1 | 91 | 30 | 24 | 0 (0) | 2.9 | 14 |
| solid | 500 | 598 | 2 | 39.5 / 142.5 | 380.7 / 1240.7 | 100 | 84 | 1 | 8 (4718) | 2.0 | 83 |
| solid | 1000 | 1235 | 0 | 5027.5 / 6439.7 | 9063.5 / 10729.5 | 100 | 87 | 0 | 2 (14582) | 4.4 | 14186 |
| svelte | 25 | 25 | 60 | 3.9 / 7.4 | 18.9 / 28.4 | 39 | 7 | 11 | 0 (0) | 2.6 | 6 |
| svelte | 50 | 50 | 59 | 4.4 / 9.5 | 18.4 / 29.5 | 56 | 12 | 18 | 0 (0) | 3.4 | 2 |
| svelte | 100 | 100 | 60 | 4.0 / 10.8 | 18.5 / 29.3 | 67 | 18 | 19 | 0 (0) | 4.5 | 16 |
| svelte | 200 | 202 | 53 | 7.1 / 17.6 | 26.3 / 73.4 | 92 | 34 | 23 | 0 (0) | 11.5 | 16 |
| svelte | 500 | 583 | 26 | 11.3 / 57.6 | 60.0 / 599.4 | 100 | 63 | 13 | 3 (230) | 43.0 | 177 |
| svelte | 1000 | 1239 | 0 | 5753.1 / 7225.4 | 9993.9 / 11666.9 | 100 | 86 | 0 | 2 (15527) | 34.1 | no |
| vue | 25 | 25 | 60 | 4.8 / 11.5 | 19.0 / 28.8 | 44 | 2 | 12 | 0 (0) | 2.6 | 2 |
| vue | 50 | 50 | 59 | 5.4 / 16.4 | 19.4 / 40.3 | 67 | 3 | 20 | 0 (0) | 2.4 | 1 |
| vue | 100 | 100 | 60 | 4.7 / 11.5 | 19.3 / 32.1 | 69 | 3 | 18 | 0 (0) | 2.9 | 6 |
| vue | 200 | 201 | 55 | 7.1 / 16.3 | 25.9 / 56.7 | 95 | 5 | 22 | 0 (0) | 2.4 | 12 |
| vue | 500 | 1240 | 0 | 1443.4 / 1571.7 | 5887.5 / 9235.5 | 100 | 5 | 0 | 0 (0) | 10.5 | 2388 |
| datastar | 25 | 25 | 60 | 4.7 / 8.4 | 17.6 / 24.8 | 41 | 8 | 11 | 0 (0) | 1.3 | 9 |
| datastar | 50 | 50 | 60 | 5.0 / 11.4 | 18.5 / 30.5 | 60 | 12 | 18 | 0 (0) | 2.1 | 2 |
| datastar | 100 | 97 | 60 | 4.7 / 11.7 | 19.5 / 29.4 | 73 | 18 | 21 | 0 (0) | 2.8 | 1 |
| datastar | 200 | 106 | 55 | 5.0 / 13.6 | 20.6 / 41.1 | 90 | 28 | 24 | 0 (0) | 4.7 | 10 |
| datastar | 500 | 24 | 25 | 23.5 / 63.7 | 60.7 / 122.6 | 100 | 51 | 16 | 4 (338) | 6.2 | 15 |
| datastar | 1000 | 4 | 4 | 439.2 / 508.8 | 467.2 / 525.1 | 100 | 76 | 3 | 11 (2968) | 14.3 | 557 |
| datastar | 2000 | 2 | 2 | 2069.5 / 2633.3 | 2087.1 / 2655.5 | 100 | 81 | 1 | 6 (3312) | 19.1 | no |
| datastar-elements | 25 | 25 | 60 | 6.6 / 10.7 | 17.7 / 25.4 | 43 | 13 | 9 | 0 (0) | 1.6 | 1 |
| datastar-elements | 50 | 50 | 60 | 7.3 / 13.4 | 18.2 / 30.6 | 72 | 25 | 17 | 0 (0) | 1.3 | 7 |
| datastar-elements | 100 | 60 | 47 | 11.2 / 29.9 | 27.9 / 71.9 | 94 | 42 | 19 | 1 (50) | 3.3 | 27 |
| datastar-elements | 200 | 5 | 5 | 204.6 / 300.1 | 230.6 / 328.1 | 100 | 80 | 4 | 16 (3056) | 3.0 | 298 |
| datastar-elements | 500 | 1 | 1 | 1597.2 / 1995.1 | 1613.4 / 2011.1 | 100 | 89 | 1 | 4 (3799) | 8.8 | no |
| htmx | 25 | 25 | 60 | 10.1 / 19.5 | 22.3 / 36.6 | 69 | 31 | 13 | 0 (0) | 2.0 | 37 |
| htmx | 50 | 51 | 41 | 16.0 / 39.3 | 36.0 / 150.7 | 98 | 58 | 18 | 4 (319) | 2.9 | 7 |
| htmx | 100 | 105 | 5 | 37.4 / 60.2 | 135.8 / 281.7 | 100 | 89 | 5 | 16 (2958) | 7.2 | 80 |
| htmx | 200 | 179 | 1 | 1260.0 / 1863.0 | 1949.3 / 2776.2 | 100 | 96 | 1 | 4 (5389) | 19.2 | no |
