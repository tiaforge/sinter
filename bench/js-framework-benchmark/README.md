# sinter in js-framework-benchmark

The keyed entry for [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark).
`index.html` is the whole app; `src/sinter.helpers.js` builds the row data.
`test/bench.test.ts` in the repo root checks every operation through the testing module.

## Running locally

```sh
npm run build                      # in the repo root: builds dist/
cd bench/js-framework-benchmark
npm install && npm run build-prod  # builds dist/ here

# in a checkout of js-framework-benchmark:
ln -s <this folder> frameworks/keyed/sinter
(cd server && npm ci && npm start) &
cd webdriver-ts && npm ci && npx tsc
node dist/isKeyed.js --headless --framework keyed/sinter
node dist/benchmarkRunner.js --headless --framework keyed/sinter keyed/vanillajs --benchmark 0 4 --count 10

node <this folder>/compare.mjs results   # markdown table
```

Add `--chromeBinary <path>` if Chrome is not on the default path.

## sinter against itself

`self.mjs` times this page's operations in headless Chrome without a js-framework-benchmark checkout:
two or more builds, page loads alternating, script time (click until the render's microtasks are
done) and total (also laid out), and the JS heap after GC (ready, 1,000 rows, five create-and-clear
cycles). `ivi/` is the same page in ivi 5.1, as a reference; `avenx/` is the same page as one
[Avenx](https://github.com/Avenx-JS/avenx-js) 1.0.0-rc.1 component (a keyed `<@for>` over Proxy state,
rows changed in place).

```sh
npm run build                                   # in the repo root, for each sinter variant
npx vite build --outDir dist-a                  # one build per variant
npx vite build -c vite.ivi.config.js            # dist-ivi
(cd avenx && npm install && npm run build)      # avenx/dist; pass the folder `avenx` itself
CHROME=/path/to/chrome node self.mjs dist-a dist-b dist-ivi avenx [--loads 6] [--reps 10]
```

### Results: sinter and Avenx

2026-11-12, `node self.mjs dist-sinter avenx` (6 page loads × 10 reps), headless Chromium (Chrome for
Testing 153), 4-core cloud VM, one run. Median ms; script / total as above.

> **A separate run.** It used a different machine from the js-framework-benchmark rankings cited in
> [docs/benchmark.md](../../docs/benchmark.md), and Avenx has no entry in the official benchmark. Compare
> Avenx only with the sinter column here. Placing Avenx among the other frameworks needs the full suite
> re-run with an Avenx entry, on one machine.

| operation | sinter script | sinter total | Avenx script | Avenx total |
| --- | ---: | ---: | ---: | ---: |
| create 1k | 3.40 | 29.50 | 17.20 | 41.20 |
| replace 1k | 5.20 | 26.70 | 20.00 | 42.30 |
| update 10th | 0.70 | 7.40 | 3.30 | 10.40 |
| select row | 0.50 | 0.50 | 3.40 | 3.40 |
| swap rows | 0.40 | 3.50 | 7.80 | 29.60 |
| remove row | 0.50 | 2.90 | 13.00 | 32.90 |
| append 1k | 2.60 | 29.70 | 16.90 | 41.60 |
| clear 1k | 3.20 | 3.20 | 6.00 | 6.00 |
| create 10k | 25.60 | 300.10 | 205.80 | 505.90 |
| ready MB | 1.84 | | 2.17 | |
| 1k rows MB | 2.21 | | 5.46 | |
| run-clear x5 MB | 2.05 | | 2.92 | |

- Avenx's script time is 5–25× sinter's; the widest gaps are swap, remove and select.
- On swap and remove Avenx also spends about 20 ms more in layout, which suggests its keyed list
  moves many rows rather than one or two (not checked).
- Size, not measured by `self.mjs`: Avenx's default production build is 354 KB (81 KB gzipped);
  sinter's page is 37 KB (15.5 KB gzipped).
