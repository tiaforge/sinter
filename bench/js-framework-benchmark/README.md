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
