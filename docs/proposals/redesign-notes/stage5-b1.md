# Stage 5, step B1: a page's second pass taken from its first pass's walk

Running log (2026-11-23), branch `redesign/stage5-b1`, started at `5f203af` (the integration branch as found).

## Where the work stands (read this first)

- **Done**: the measurements (1, 2): which second passes apply only rendered blocks and page-level decided
  branches, over the suite and the apps; the reference build times.
- **Next**: the differences between the first pass's walk with the decisions applied and the second pass's result
  (3), found with the canonical audit while the route is built (4).

## How it is measured

- The machine: a cloud container, 4 cores (Intel Xeon @ 2.10GHz), 15 GB, Node 22.23.5, nothing else running
  (load under 1 before each run).
- `SN_APPLIED_LOG=<file>` (src/compiler/compile.ts, `appliedLog`): one line per second pass, the kinds of decision
  it applied and where (recorded by `expandConstants` as it applies them), the first pass's context (a layout, the
  image pipeline, a kept element), the test or page. Kinds: `if:<where>` a decided `data-sn-if`, `loop rendered` a
  block spliced, `loop unrolled:<where>` an unrolled loop compiled the old way, `choice dropped/inlined/rendered`,
  `point inlined`, `constants (prefold)` (`opts.constants`: values the layout or the images read), `over limit`;
  `<where>` is `page` (outside templates, rows and instances), `row`, `instance` or `template` (a template that stays).

## 1. Reference: whole builds on the integration branch as found (`5f203af`)

`node bench/astro/run-sinter.mjs`, 100 posts, 3 rounds, ms (median in bold):

| variant | round 1 | round 2 | round 3 | median |
| --- | ---: | ---: | ---: | ---: |
| static | 3646 | 3037 | 2747 | **3037** |
| live | 3386 | 3544 | 3415 | **3415** |
| static-files | 3579 | 3594 | 3986 | **3594** |
| live-files | 5539 | 5521 | 5699 | **5539** |
| static, type check | 3147 | 2902 | 3017 | **3017** |

page-compile (`node bench/page-compile/run.mjs 200 7`, 3 runs): median 419 / 375 / 361 ms, min 272 / 258 / 268.

## 2. What the second passes apply

### The suite (`SN_APPLIED_LOG` over `npx vitest run`: 300 files, 2,883 tests pass)

2,040 second passes. By what they apply:

| applies | second passes | of them with a layout / images / a kept element |
| --- | ---: | --- |
| loop rendered | 1,728 | layout+images 61, images 75, layout 6 |
| if:page | 92 | kept element 8 |
| if:page + loop rendered | 14 | |
| **routable by the plan (the three above)** | **1,834 (90%)** | |
| loop unrolled (the old row route, `SN_RENDER` reasons) with or without others | 160 | |
| constants (prefold), with others or alone | 52 | |
| choices (dropped, inlined, rendered) | 46 | |
| if:row / if:instance / if:template | 63 | |
| over limit | 1 | |

(A line counts in every row whose kind it has; the routable rows are exact.) Where the 1,728 `loop rendered` come
from: the behaviour fuzzers (wrapper 735, component 297, reactivity 118, anchor 95, minify 92), units 64,
render-rows 61, constant-differential 46, vite origins 34, link 30.

### The apps (`scripts/pass-audit.mjs`, both of its builds, so each page twice)

| app | second passes a build | applies | context |
| --- | ---: | --- | --- |
| the five blog variants | 100 each | if:page + loop rendered (`$build` chooses `<md-tree>`; its loop rendered) | images |
| static-site, multilingual-site | 6, 8 | loop rendered (12 pages); constants + loop rendered (2) | layout, images |
| realworld | 1 | constants (prefold) + if:template | layout, images |
| dashboard | 0 | | |
| page-compile | 1 | if:page (its 200 `if`s over state nothing writes) | |

So the plan's kinds cover the pages the route was for: every blog entry, page-compile, the examples' pages but
two, and 90% of the suite's second passes. The image pipeline (and, on the examples, the layout) runs on most of
them: the route has to give the image pipeline and the minifier the markup the second pass gives them, or fall back.
