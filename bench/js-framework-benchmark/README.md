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
cycles). `ivi/` is the same page in ivi 5.1, as a reference.

```sh
npm run build                                   # in the repo root, for each sinter variant
npx vite build --outDir dist-a                  # one build per variant
npx vite build -c vite.ivi.config.js            # dist-ivi
CHROME=/path/to/chrome node self.mjs dist-a dist-b dist-ivi [--loads 6] [--reps 10]
```
