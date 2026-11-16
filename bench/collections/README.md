# A page per entry, prototyped

Part 0 of [the collections proposal](../../docs/proposals/collections.md#prototype). `sinter({ prototypePages })`
(on this branch only) builds a template page once per entry, as virtual inputs at its `data-sn-path` filled
from the entry: the source's `{=field}` is replaced by the entry's field and the pattern by the filled path,
a stand-in for `data-sn-pages` and the implicit entry resource. The app is a blog: `n` markdown posts of
about 600 words rendered with sinter-markdown, an index, and with `live` a comments resource on each post.

```sh
npm run build                                   # this checkout's dist/
mkdir -p packages/sinter-markdown/node_modules/@tiaforge-ui && ln -sfn "$PWD" packages/sinter-markdown/node_modules/@tiaforge-ui/sinter
node bench/collections/measure.mjs --sizes 10,100,1000
```

Each build runs in a fresh process (`run.mjs`), which prints its time, peak memory and output. The apps are
written to `bench/collections/out/` (ignored by git).

## Results

2026-11-16, 4 cores, Node 22, Vite 8 (Rolldown), one run each:

| Entries | Page | Time | Per entry | Peak memory | HTML | JS files |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100 | static | 18.1 s | 181 ms | 473 MB | 0.5 MB | 0 |
| 1,000 | static | 176.4 s | 176 ms | 721 MB | 26.1 MB | 0 |
| 100 | live | 21.5 s | 215 ms | 537 MB | 0.6 MB | 101 |
| 1,000 | live | 195.3 s | 195 ms | 1,212 MB | 26.5 MB | 1,001 |

The HTML column is before the Speculation Rules fix (every page listed every page: 23 kB of each post's 26 kB
at 1,000 entries); after it, a post is 3.2 kB at any size.

Profile of the static build at 100 entries (`node --cpu-prof bench/collections/run.mjs <app>`):

| | Share |
| --- | ---: |
| compile in `buildStart` (the early-script pass) | 44% |
| compile in `transformIndexHtml` (the page) | 40% |
| of which: acorn parsing expressions | 25% |
| of which: component files read (`realpath`, `lstat`) | 13% |
| `describe` (paths and prefetch), per-page lists | 2–3% |

Experiments at 100 entries: `firstPaint: false` (which skips the first compile) takes 12.1 s instead of 22.3 s;
with that, caching file reads across compiles (`SN_PROTO_READ_CACHE=1`) takes 10.6 s.

The 10,000-entry run was stopped after the 1,000 results showed linear scaling: about 30 minutes as the
compiler is, and worth running after the compile work the proposal lists, as its check.
