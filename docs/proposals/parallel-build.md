# Proposal: page compiles in worker threads

Status: spike, not for merge. The prototype is on the branch `spike/parallel-build`: `sinter({ workers: n })` (or
`SINTER_WORKERS=n`) compiles a build's pages in `n` worker threads, and the output is the same, byte for byte. This
document says what it measured, what makes it work and what complicates it, and what a real version would cost. Line
references are to `main` at 73e4c7d unless they name the branch.

A build compiles every page on the main thread: `transformIndexHtml` calls `build()` (`src/vite.ts:1338`), which
calls `compile()` (`src/vite.ts:854`), synchronously. Pages are independent once their inputs are known, so a large
site is bound by one core. [The collections benchmark](../../bench/collections/README.md) (a blog of markdown posts
from one `data-sn-pages` template) builds 1,000 posts in 39 s on a 4-core machine, nearly all of it on one core.

**Result: three workers build the 1,000-post blog in 19.6 s instead of 38.9 s (2.0×), and the 4,000-post one in
RESULT_4K. It stops scaling at about two workers, and the reason is not serialization or sinter's design but V8's
garbage collector: an allocation-heavy loop alone scales the same way on this machine.**

## Where the time goes

The current build, 1,000 posts, static, one CPU profile (`node --cpu-prof bench/collections/run.mjs`, 41.5 s under
the profiler):

| Phase | Time | Share | In workers? |
| --- | ---: | ---: | --- |
| Vite starts, `configResolved` (the content, the template's entries), `buildStart` (the project, the helpers module) | 2.0 s | 5% | no |
| `describe` of every page, on the first page's compile (`prefetchPages()`, `src/vite.ts:853`; 1,001 describe-only compiles) | 1.2 s | 3% | yes |
| page compiles (`compile()` 30.7 s, and most of the 6.7 s of garbage collection) | 36 s | 87% | yes |
| the rest of `transformIndexHtml` (stylesheets, `lineHeightsOf`, the plugin's maps) | 0.2 s | 0.5% | no |
| Rolldown, Vite's HTML plugin, `generateBundle` (the plugin's bundle hooks: 0.7 s), writing `dist/` | 2.1 s | 5% | no |

Within the compile, no single cost stands out any more: `compile.js` itself is 47% of the samples, acorn's expression
analysis (`expr.js`) 9%, parse5 7%, the parse cache 3%. Garbage collection is 16% of the whole build, nearly all of
it during the compiles.

So about 90% of the build can move to workers; the other 10% (4 s) is serial. By Amdahl's law three workers could at
best bring 41.5 s to 4.5 + 37 / 3 = 17 s (2.5×), and no number of workers below 4.5 s (9×).

## Measurements

`node bench/collections/workers.mjs --sizes 1000,4000,10000` (on the branch): the same app built with 0 workers (the
current build, compiles on the main thread) and with 1, 2 and 3, each build in a fresh process, each `dist/` compared
with the first one's (`diff -r`). 4 cores (Xeon, 2.3 GHz, one thread per core), 16 GB, Node 22.23, Vite 8.3.5,
Rolldown 1.2.16, static posts, one run each:

RESULTS_TABLE

Peak RSS is the process's, workers included (they are threads of it). Each worker's job count and busy time
(`SINTER_WORKERS_STATS=1`) shows the pool is balanced (at 1,000 posts, three workers ran 676, 642 and 684 jobs, each
busy 14.8 s) and that the main thread is not what they wait for: its profile with three workers is 90% idle while the
pages compile.

**What one worker buys: nothing but a separate heap.** One worker is 8% faster than the main thread doing the
same compiles, because the compiles' garbage no longer shares a heap with Vite's and Rolldown's, and the main thread
does the bundling while the worker compiles.

**Where it stops scaling, and why.** At 1,000 posts, one worker spends 29.7 s on 2,002 jobs (each page described,
then compiled); three workers spend 14.8 s each, 44.4 s together: the same work costs 50% more CPU when three threads
do it at once. The candidates, in order of what they cost:

- **The garbage collector and the memory system: most of it.** The machine scales perfectly for arithmetic (a loop
  of integer operations takes 31.2 s in one thread and 31.2 s in each of four at once) but not for allocation: a loop
  that allocates small objects and drops them takes 504 ms alone, 576 ms in each of two threads and 793 ms in each of
  three (+57%, the compile's +50%). Each worker is an isolate with its own heap, but V8's parallel scavenger and
  concurrent marker draw on Node's one platform thread pool (four threads by default), and young-generation
  collections in four isolates compete for it and for memory bandwidth. A larger young generation helps both builds:
  with `--max-semi-space-size=64` the current build takes 33.9 s and three workers 17.7 s (1.9×). `--single-threaded-gc`
  helps the workers a little (18.7 s) and the main thread not at all (40.1 s).
- **The fixed cost, about 5 s of the 19.6 s.** Vite's start and `configResolved` (2 s), the pool's start (0.6–0.8 s:
  each worker reads the project and loads the helpers module through a Vite module runner of its own, about 0.5 s,
  in parallel), and Rolldown, the bundle hooks and the write at the end (2 s). None of it shrinks with more workers.
- **Each worker's own caches: a little.** Every cache shared across pages today is per worker: the parse cache, the
  `file:` list (each worker reads and parses the 1,000 posts' frontmatter once), the component files. The describe
  pass, the first thing each worker does, takes 1.76 s with one worker and 0.90 s with three, not 0.59 s.
- **Serialization: negligible.** The main thread's `postMessage` is 0.2 s of the whole build and `structuredClone` does
  not show; a job is the page's HTML and its options' data (a few kB here), a result is the compiled page (its HTML
  and module, about 4 kB here).
- **Rolldown: not here.** The main thread is idle while the pages compile; Rolldown's work is a few seconds in all.

So past two workers this machine has little to give: the third worker takes 1,000 posts from 21.0 s to 19.6 s. A
machine with more cores and memory bandwidth per core would scale further; the young-generation size is the one
setting that helped here.

**Memory.** Each worker holds its own project, caches and module copies, and its own heap's slack: peak RSS goes from
0.69 GB to 1.37 GB at 1,000 posts with three workers, about 230 MB per worker. RSS_NOTE

## What a compile needs, and what it does

### Inputs

`compile()` is pure given its options (`src/compiler/index.ts:27`), and most of the options `build()` builds are data:
the file, the root, the helper and action manifests, the page entry, the APIs and specs, the language, the URLs, the
flags. What cannot cross to a worker is a dozen functions and caches, and each has a way across:

| Input | Today | In a worker (the prototype) |
| --- | --- | --- |
| `readFile`, `listFiles` | the project's, through `buildReads` (`src/vite.ts:824`) | the worker's own `project()` and read cache |
| `globCache` (`file:` lists) | one per build (`src/vite.ts:823`) | one per worker: each lists and parses the glob once |
| the project (`src/project.ts:173`) | read once per build, in `buildStart` (`src/vite.ts:1085`) | read again by each worker, after the main thread's (whose writes of `sinter.components.d.ts` and `sinter.messages.d.ts` come first, so the workers find them current) |
| `helperValues`, `helperFold` | the helpers module, loaded once before the pages (`src/helpers-node.ts:51`) | loaded again in each worker, through a Vite module runner of its own (about 0.5 s each); the fold verdicts are recomputed there too |
| `foldLog` | records each folded call for the end-of-build cross-check (`src/vite.ts:832`) | the worker records the calls and returns them; the main thread replays them into `foldCalls`, in order |
| `collections` | the content module's, loaded once in `configResolved` (`src/vite.ts:974`) | sent to each worker once, as data (the loaders' results are checked to be plain data): the content module runs once, as before |
| `styles`, `minify.styles`, line heights, `0` widths | computed per page before the compile, asynchronously (Vite's `preprocessCSS`, font files) | computed on the main thread as before, and sent with the job |
| `images` (`ImageHost.info`, `url`) | the plugin's sharp instance; a page with images not analysed yet compiles twice (`src/vite.ts:1340`) | the worker's own sharp over the same disk cache; it analyses and compiles again itself, and returns the variants, which the main thread encodes in `generateBundle` as before |
| `lazyScript`, `lazyModule` | `reachLazy` and `lazyHelpers`, and a log line per component script | rebuilt in the worker; the scripts it asked about are returned and the main thread logs them |
| `componentCss`, `normalLineHeight`, `zeroWidth` | closures over constants and maps | rebuilt from the constant and the maps' entries |

Everything the content module, the stylesheets and the fonts need stays on the main thread, which is also where it
is asynchronous. The compile stays synchronous in the worker.

### Shared state

None of the per-build state the compiles share is needed for correctness; it is all caches of what the files and
modules say, and a worker's copy holds the same values as the main thread's would:

- `globCache`, `buildReads`, `buildProject`: per worker, built on first use, gone with the pool at the build's end
  (a rebuild under `--watch` starts a new pool, as these caches are cleared at each `buildStart` today).
- The parse cache (`src/compiler/parse.ts:12`) and `fileValue`'s cache (`src/compiler/files.ts:112`): module state,
  so per isolate. Each warms up on its own; the trees are frozen either way.
- `FoldCache`: per worker.

The one semantic change is the helpers module: it is imported once per worker as well as by the main thread. A helper
that keeps state between calls sees a different sequence of calls in each worker. That is what the end-of-build
cross-check (SN534, `src/vite.ts:1302`) exists for: it runs every distinct folded call again, in a fresh copy, in
reverse order, and it still runs on the main thread, over the calls the workers reported. A helpers module with side
effects at import (a request, a log line) runs them once per worker; it already runs them twice per build (the build's
copy and the cross-check's).

### Side effects

After each compile, `build()` writes the page's facts into the plugin's maps (`src/vite.ts:885`–`898` and the rest of
the hook, `src/vite.ts:1344`–`1378`): `runtimeOf`, `preloadOf`, `lazyScriptsOf`, `componentCss`, the page and early
modules and their maps, `earlyPages`, `embedPages`, `holdPages`, `markupMessages`, `remoteWidths`, `unlisted`,
`paintCss`, `imageCss`, `variants`, `units` (for `typecheck`), `sameLinkPages`, the rules' hashes. Every one of them is
derived from the `CompileResult`, which is plain data and crosses as it is. The prototype splits `build()` into
`prepare` (the options), the compile, and `finishPage` (the writes, unchanged), so a worker's result goes through the
same code as a local compile's. Only two effects happen during the compile, through callbacks (`foldLog`,
`lazyScript`), and those are replayed.

What changes is the order in which pages finish. Two things depended on it:

- the CSP hashes in the closing log line came from a `Set` filled in the order pages finished; the branch sorts them
  (found by comparing the realworld example's build log with and without workers);
- `foldCalls` is a map in that order, and the cross-check walks it in reverse; the order changes, the check does not.

Today's build already interleaves pages at their `await`s (the stylesheets, the fonts), so the maps were never
written in input order; the examples and the test suite found nothing else.

### Hooks

No compile-ahead is needed. Vite's HTML plugin runs the `pre` `transformIndexHtml` hooks inside each HTML module's
`transform` (`node_modules/vite/dist/node/chunks/node.js:31880` in Vite 8.3.5), and Rolldown runs the modules'
transforms concurrently: with the hook awaiting its page's compile, IN_FLIGHT pages were in flight at once, more than
enough to keep three workers busy. The hook keeps its shape; only the compile inside it is awaited instead of called.

Compiling every page ahead, in `buildStart`, would also be wrong in general: the HTML the hook gets is not the file.
Vite's own `pre` hooks (the import map, the CSP nonce) and any of the app's plugins ordered before sinter change it
first. A compile-ahead would have to compare its input with the hook's and compile again on a mismatch.

The one thing that does move is the describe pass. Every page's description (its `data-sn-path` patterns, what it
requests ahead) is needed by the first page's compile (`prefetchPages()`, the page's `$canonical`, the Speculation
Rules), and today the first page compiles all of them, on the main thread, before its own. The prototype describes
every page in the pool at the end of `buildStart`, after the workers have started (0.9 s for 1,001 pages with three
workers, 1.2 s on the main thread before).

Dev is untouched: the dev server compiles a page when it is requested, one at a time, and its compile latency is not
what a pool shortens.

## The prototype

On the branch, about 250 lines:

- `src/compile-pool.ts`: the pool (N workers, a queue, each job to the next idle worker), and the job's shape: the
  page's HTML, compile()'s options without their functions and caches, and the names of the functions to rebuild.
- `src/compile-worker.ts`: a worker. At start it reads the project, loads the helpers module and sharp; for each job it
  rebuilds the options' functions, compiles (twice when images were not analysed yet), and returns the result, the
  folded calls and the lazy lookups.
- `src/vite.ts`: `build()` split into `prepare`, the compile and `finishPage`; `buildIn` sends a page to the pool and
  replays what came back; `buildStart` starts the pool and describes every page in it; `buildEnd` closes it.
  `workers` (or `SINTER_WORKERS`) turns it on; with `SINTER_WORKERS_STATS=1` the build prints each worker's jobs and
  busy time.

Corners cut: no fallback when a worker dies (the build fails); options that cannot be cloned turn the pool off with a
warning rather than an error; the per-page stylesheets are sent with every job instead of once; the worker resolves
its own file next to the module, or the built one from the sources (the test suite runs `src/` and needs `npm run
build` first).

How it was checked:

- the benchmark's `dist/` with and without workers, at every size above: identical;
- each example (`examples/*`, realworld also with `SINTER_EMBED=1`, dashboard with `typecheck`), built with and
  without three workers: identical `dist/`, and the same build log except the hashes' order (now sorted);
- the whole test suite with `SINTER_WORKERS=3`: 2,108 tests pass, 122 of its builds through the pool (images, the
  content module, `data-sn-pages`, `localePrefix`, `lazy`, strict mode and the fold cross-check among them); and
  without it, as on `main`.

## Recommended design

Workers are worth having for sites of hundreds of pages and up, on by default above a threshold, and not before the
compile's inputs are made explicit. In order:

1. **A compile environment as data.** Today the options mix data, closures and caches, and the worker has to know
   which is which (the prototype's list of names to rebuild). Split them: a `CompileEnv` that is plain data (the
   project's manifests and component list, the fold verdicts, the collections, the `file:` lists, the stylesheets
   by hash), built once per build on the main thread and sent once to each worker; and a host per thread that gives
   `readFile`, `listFiles` and the helpers module's values. The main thread and the workers then run the same code,
   with no rebuild step to drift from it. The `file:` lists move to the environment too: built once on the main thread
   instead of once per worker.
2. **The pool's lifetime is the build's** (`buildStart` to `buildEnd`), as in the prototype; under `--watch` a new
   pool per build, as the caches are per build today.
3. **Its size: `min(cores − 1, pages / 100)`, and none below about 50 pages,** where the start (0.6–0.8 s) costs
   more than it saves. `workers: 0` turns it off, `workers: n` fixes it. The main thread is idle while workers
   compile, so `cores` rather than `cores − 1` may be better on machines that are not this one; it is an open question.
4. **A larger young generation in each worker** (`resourceLimits.maxYoungGenerationSizeMb`), the one setting that
   helped here, measured on more machines before it is a default.
5. **Errors as today:** a compile's diagnostics are data and come back with its result; an exception comes back with
   its message and stack and fails the build; the first failure terminates the pool.

**Cost.** Item 1 is the work: a few hundred lines across `vite.ts`, `project.ts` and the compiler's options, and
tests that build each fixture both ways (the prototype's trick, the suite under `SINTER_WORKERS=3`, as a CI job).
The pool itself is about 100 lines. The ongoing cost is a rule for every new compile option: data, or something the
host gives. The gain on this machine is 2× at 1,000 pages and up; a hand-written site of 20 pages gains nothing and
stays at 0 workers.

## Open questions

- **Is 2× on 4 cores the ceiling, or this machine's?** The allocation test says the limit is the collector and the
  memory system; a machine with more cores, or a compile that allocates less, would say more. The compile's
  allocation (16% of a single-threaded build is collection) is worth a profile of its own: less garbage helps the
  single-threaded build and the workers both.
- **The default.** On above a page count, or opt-in until it has run on more apps (Windows, CI runners with 2 cores)?
- **`cores − 1` or `cores`**, and what to do on a 2-core CI runner, where one worker is only 8% faster.
- **Memory**: about 230 MB per worker at 1,000 posts. A CI runner with little memory may want fewer workers than
  cores; a cap by `os.freemem()`?
- **Helpers with state or side effects at import** run once per worker: document it next to the cross-check, or
  load the helpers module only on the main thread and run folded calls there (a round trip per call: slower, and
  the compile would no longer be synchronous)?
- **`typecheck`** still checks every page's unit on the main thread at the end (`src/vite.ts:1313`); with many pages
  it could be split across the pool too.
- **Images**: each worker has its own sharp, whose libvips uses threads of its own; with many new images and many
  workers that oversubscribes the cores. Analyse on the main thread and send the results instead?
