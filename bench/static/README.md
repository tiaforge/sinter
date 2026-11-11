# Pages without JavaScript, measured

Builds `examples/static-site` with a checkout of sinter and opens each page in Chromium with a 4× CPU
slowdown: the scripts it downloads (gzip level 9), the time the main thread spent running script,
and, with JavaScript off, how many nav links show and whether the page's text is all there.

```sh
npm run build                                          # this checkout's dist/
node bench/static/measure.mjs --label branch
git worktree add ../sinter-main origin/main && (cd ../sinter-main && npm ci && npm run build)
node bench/static/measure.mjs --repo ../sinter-main --label main
```

Results, the build and a screenshot of each page with JavaScript off go to `bench/static/out/<label>/`.

## Results

2026-11-11, one machine, Chromium with a 4× CPU slowdown and slow 4G (150 ms latency, 1.6 Mbit/s),
files served with gzip, first visit (no cache). `main` at 5e6c1c8, before pages without JavaScript;
the branch of [#27](https://github.com/tiaforge/sinter/pull/27).

| page | build | scripts | script (gzip) | script time | first paint | load | nav links, JS off | same text, JS off |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| index.html | main | 2 | 15.9 kB | 12 ms | 396 ms | 514 ms | 0 | no |
| | branch | 0 | 0 | 0 ms | 388 ms | 382 ms | 4 | yes |
| about.html | main | 2 | 15.6 kB | 10 ms | 376 ms | 495 ms | 0 | no |
| | branch | 0 | 0 | 0 ms | 372 ms | 346 ms | 4 | yes |
| docs/getting-started.html | main | 2 | 15.6 kB | 5 ms | 388 ms | 474 ms | 0 | no |
| | branch | 0 | 0 | 0 ms | 380 ms | 351 ms | 4 | yes |
| status.html (loads data) | main | 2 | 16.3 kB | 9 ms | 376 ms | 518 ms | 0 | no |
| | branch | 1 | 15.8 kB | 5 ms | 376 ms | 470 ms | 4 | no |

- `dist/` of the branch has one `.js` file, the status page's; `main`'s has five.
- With JavaScript off, `main` shows no nav and no feature grid: lists from a constant prop were rendered
  by the page module. The branch's pages show the same text with JavaScript off as on
  (`js-off-main-vs-branch.png`). The status page's text differs as it should: its data needs the script.
- The first paint is level: the HTML and the stylesheet decide it. The load event comes 120–150 ms
  earlier on the static pages, since there is no script to fetch. On a later page of the same visit,
  `main` takes the runtime from the HTTP cache, so the saving there is parsing and running it.
- Layout shift is 0 to 0.004 on both: the stylesheet arrives about when `main`'s script does, so the
  empty nav is rarely painted. Script time is small in both; it is not where the difference is.
