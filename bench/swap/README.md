# Swap benchmark: sinter, htmx, Datastar, plain JS

How long it takes from a click to new server data showing on the page, for a list of 100, 1,000
and 5,000 table rows. The hypermedia libraries fetch an HTML fragment; sinter and `vanilla-json`
fetch JSON and render it in the browser.

| variant | wire | DOM update |
| --- | --- | --- |
| `vanilla-html` | HTML fragment | `innerHTML` |
| `vanilla-json` | JSON | a `<template>` row cloned per item, `replaceChildren` |
| `sinter` | JSON | `<sn-resource>` + keyed `data-sn-for` ([`sinter/index.html`](sinter/index.html)) |
| `htmx-2.0.11` | HTML fragment | `hx-swap="innerHTML"` (npm `latest`) |
| `htmx-4.0.1` | HTML fragment | `hx-swap="innerHTML"` (newest release; npm `next`) |
| `htmx-4.0.1-morph` | HTML fragment | `hx-swap="innerMorph"` |
| `datastar-1.0.4` | HTML `<tbody id="target">` | morphed by id (Datastar's default) |
| `datastar-1.0.4-replace` | HTML | `datastar-mode: replace` (no morphing) |

Two scenarios:

- **replace**: the new rows have new ids (switching page or filter).
- **update**: the same ids, every 10th label changed (reloading after an edit). Keyed and
  morphing variants can keep the unchanged rows here.

## Method

Each variant is a page with buttons `#a` and `#b` that load row set a or b into `#target`
([`pages/`](pages/)). The harness ([`pages/bench.js`](pages/bench.js)), the same on every page,
clicks them alternately and measures, from just before `click()`:

- **dom**: until the `MutationObserver` callback that first sees the expected rows (count, first
  label, last changed label) in `#target`;
- **layout**: the same, plus a forced style and layout of that DOM (`offsetHeight`).

The next frame is not used as an end point: when it comes depends on the frame clock rather than
on the work done. Headless Chrome spaces frames about 17 ms apart, and htmx touches the DOM at
click time (`htmx-request` class), which starts that clock early; measured that way, htmx paid a
fixed ~15 ms at 100 rows that has nothing to do with rendering.

Per cell: a fresh tab, one untimed load, 10 warm-up swaps (discarded), 50 timed swaps, 30 ms idle
between swaps (so deferred work such as htmx's settle step stays outside the timed window); 3
rounds with the variants in random order; medians over all 150 samples. The server
([`server.mjs`](server.mjs)) answers from memory over loopback, uncompressed, with
`Cache-Control: no-store`, so network and server time are near zero and equal for all: what is
left is each library's client-side work (request, parse, DOM update).

```sh
npm run build                          # in the repo root (sinter's dist/)
cd bench/swap && npm install && ./fetch-libs.sh
CHROME=/path/to/chrome node run.mjs    # rebuilds the sinter page, prints tables, raw samples → results/
# N=100,1000,5000 S=replace,update ROUNDS=3 ITER=50 WARMUP=10 CPU=4 (throttling) ONLY=sinter,htmx
```

`fetch-libs.sh` pins the libraries by version and sha256. Datastar 1.x is published on GitHub
only (npm stops at 1.0.0-beta.11).

## Results

2026-11-05, Chrome 156 headless, AMD Ryzen Z2 Extreme (Steam Deck), no CPU throttling.
Median ms from `click()` to the expected rows in the DOM / to that DOM styled and laid out.

#### replace

| variant | 100 rows | 1000 rows | 5000 rows |
| --- | ---: | ---: | ---: |
| vanilla-html | 2.80 / 4.50 | 5.10 / 13.9 | 12.7 / 55.5 |
| vanilla-json | 2.70 / 4.30 | 5.00 / 14.6 | 13.1 / 56.5 |
| sinter | 3.50 / 5.10 | 8.35 / 19.6 | 23.7 / 65.0 |
| htmx-2.0.11 | 5.10 / 6.60 | 14.5 / 22.5 | 68.9 / 113 |
| htmx-4.0.1 | 4.70 / 6.10 | 11.9 / 20.5 | 45.7 / 94.8 |
| htmx-4.0.1-morph | 5.90 / 7.15 | 17.3 / 24.2 | 76.1 / 116 |
| datastar-1.0.4 | 4.20 / 5.50 | 13.0 / 22.9 | 41.1 / 80.5 |
| datastar-1.0.4-replace | 3.90 / 5.50 | 9.90 / 19.4 | 28.6 / 69.9 |

#### update

| variant | 100 rows | 1000 rows | 5000 rows |
| --- | ---: | ---: | ---: |
| vanilla-html | 3.00 / 4.40 | 5.50 / 14.6 | 12.8 / 54.3 |
| vanilla-json | 2.80 / 4.40 | 5.60 / 14.6 | 12.9 / 56.3 |
| sinter | 2.70 / 3.60 | 3.70 / 9.80 | 5.50 / 30.1 |
| htmx-2.0.11 | 5.10 / 6.60 | 14.9 / 21.8 | 69.2 / 113 |
| htmx-4.0.1 | 4.90 / 6.60 | 11.8 / 18.9 | 46.5 / 94.1 |
| htmx-4.0.1-morph | 4.90 / 5.60 | 15.0 / 20.4 | 46.7 / 72.6 |
| datastar-1.0.4 | 3.50 / 4.30 | 6.80 / 12.9 | 15.9 / 42.5 |
| datastar-1.0.4-replace | 4.00 / 5.60 | 10.1 / 18.9 | 29.0 / 70.2 |

#### Bytes

Response for 1000 rows: HTML fragment 60.3 KB (5.1 gz), JSON 28.1 KB (4.7 gz).

| variant | library JS (gz KB) |
| --- | ---: |
| vanilla-html | – |
| vanilla-json | – |
| sinter | 10.0 (runtime plus this page's compiled bindings) |
| htmx-2.0.11 | 16.5 |
| htmx-4.0.1 | 13.1 |
| htmx-4.0.1-morph | 13.1 |
| datastar-1.0.4 | 13.1 |
| datastar-1.0.4-replace | 13.1 |

Spread: at 5,000 rows the three rounds' medians agree within about 5%; at 1,000 rows some cells
(Datastar replace, htmx morph) move by up to ±25% between rounds, so differences of a few ms there
are noise.

What the numbers say:

- **Replacing everything**, sinter costs about 1.5–2× plain JS (8.4 vs 5.0 ms at 1,000 rows,
  24 vs 13 ms at 5,000) to build the same rows through its keyed list. htmx's `innerHTML` swap
  costs 2–5× plain `innerHTML` for the same DOM (htmx 4: 12 / 46 ms; htmx 2: 15 / 69 ms; where the
  time goes inside htmx was not profiled); htmx 4 is about a third faster than htmx 2 at 5,000
  rows. Datastar without morphing is close to sinter (10 / 29 ms); its default morph is slower
  when nothing matches (13 / 41 ms).
- **Updating every 10th row**, the keyed and morphing variants keep the other rows: sinter
  updates only the changed labels (3.7 / 5.5 ms, more than 2× faster than rebuilding with plain
  JS at 5,000 rows) and its layout time halves; Datastar's morph comes second (6.8 / 16 ms). htmx 4's
  `innerMorph` keeps the rows too (the lower layout time shows it) but is not faster than its
  `innerHTML` swap to reach that state.
- **Wire size**: the HTML fragment is about twice the JSON uncompressed, about the same gzipped.

## Caveats

- One machine, one browser. Loopback hides the payload difference (HTML fragment vs JSON, see
  Bytes); on a real network the larger fragment costs transfer time, and both compress well.
- The rows are minimal (two cells, no attributes the libraries act on). htmx processes swapped
  content for `hx-*` attributes and Datastar for `data-*` ones; with richer rows that cost grows,
  and so does sinter's per-row binding work.
- Only one interaction is measured. It says nothing about first load, memory, or how the
  libraries compare on features (optimistic updates, SSE, history, forms).
