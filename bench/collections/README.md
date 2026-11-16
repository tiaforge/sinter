# A page per entry, prototyped

Part 0 of [the collections proposal](../../docs/proposals/collections.md#prototype), and the benchmark for
the build's compile cost. The app is a blog: `n` markdown posts of about 600 words rendered with
sinter-markdown, one page per post, an index, and with `live` a comments resource on each post. The
prototype built the posts from one template page with an option that is gone since; the app now writes
each post as a page of its own, which compiles the same way.

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
compiler was.

## After the compile work

One compile per page, expressions parsed once per text, and the project and its files read once per build
(CHANGELOG, Unreleased). The app now writes each post as a page of its own (the prototype's option is gone),
which compiles the same way; 100 posts, the same machine:

| | Static | Live |
| --- | ---: | ---: |
| before | 21.2 s | 20.9 s |
| one compile per page | 11.9 s | 12.0 s |
| and expressions parsed once, files read once per build | 7.0 s | 7.5 s |
| and the project read once per build | 6.5 s | 6.9 s |

The output is the same, byte for byte, at each step, and so is every example app's (`examples/*`, built with
`main` and with the change).

## A page per entry (`data-sn-pages`)

The app builds every post from one template (`measure.mjs`; `--files` for one page per post). Static posts, Node's
default heap:

| Posts | Time | Per post |
| ---: | ---: | ---: |
| 100 | 6.5 s | 65 ms |
| 1,000 | 65.3 s | 65 ms |
| 2,000 | 124 s | 62 ms |
| 4,000 | 197 s | 49 ms |
| 10,000 | 626 s | 63 ms |

Found on the way and fixed, each a cost every post's page paid over the whole list or over all pages: the list's
JSON written and parsed into each page and dropped, the list built and sorted again, the list deep-copied for
folding, the page list rebuilt, the map of every page's URL rebuilt while links were rewritten, and each page's
description (its paths, what it requests ahead) serializing the list it never reads. 2,000 and 4,000 posts were
measured after all but the last, and after all of them respectively; 10,000 after all of them.

From 4,000 to 10,000 posts the cost per post still rises (49 to 63 ms), much less than before (10,000 took over 19
minutes, against about 10 now). With the heap capped at 300 MB the 2,000-post build still completes (131 s): what it
keeps is small; the rest of its resident memory (2.1 GB at 10,000) is Node, Vite and Rolldown with that many inputs.
