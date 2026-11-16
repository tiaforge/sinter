# Spike: compiling one page in parallel

Status: spike (2026-11-16). Recommendation: **don't split one page's compile across threads.** Fix the
two all-pairs loops this spike found instead (prototyped on this branch, output byte-identical, all tests
pass). That makes a large page compile 2 to 5.6 times faster.

This is not the [parallel build spike](parallel-build.md) (a separate session), which compiles
*different pages* at the same time. This one asks whether *one* page's compile can be split up: a
single large page, or the one page `vite dev` compiles again after a save. The two questions are
independent. The findings below on worker cost and on what cannot cross a thread apply to both.

## Measured

`bench/page-compile/run.mjs [sections] [runs]` compiles one synthetic page in-process with
`compile()`. Each section has its own `data-sn-state`, a model, a click handler, show/class/attr
bindings, a component with a slot, a filtered loop over a resource, and an `if`. All sections share one
resource. Median of 7 runs; 4 cores, Node 22.

| Sections | Page HTML | main | this branch | |
| ---: | ---: | ---: | ---: | ---: |
| 5 | 4 kB | 29 ms | 22 ms | 1.3× |
| 50 | 44 kB | 161 ms | 125 ms | 1.3× |
| 200 | 177 kB | 815 ms | 356 ms | 2.3× |
| 400 | 356 kB | 2,288 ms | 616 ms | 3.7× |
| 800 | 713 kB | 7,765 ms | 1,396 ms | 5.6× |

On main the time grows with the square of the page's size: 4 times the sections took 11 times as long.
On this branch it grows about linearly. On normal pages the change does nothing measurable: the 100-post
blog of `bench/collections` (live) builds in 6.5 s on main and 6.5 s on this branch, which is within
run-to-run noise.

## Where one page's time went (main, 400 sections)

| | Share |
| --- | ---: |
| `fixedDeps`: one `new RegExp` per state field, run over every function of the page | 45% |
| `compactIR` → `numberPaths`: every written path checked against every dependency (`staticReach`) | 18% |
| the main walk (`element`/`walkChildren`), bindings, expression analysis | 13% |
| parse5 | 3% |

On this branch, at 800 sections, the profile is flat. The main walk takes 35% (expression analysis 17%,
acorn 5%), garbage collection 21%, parse5 8%, `prerender` 11%, and `numberPaths` 2%.

## The two fixes (prototype)

- **`fixedDeps`** (`src/compiler/compile.ts`): one scan of the page's functions builds an index from
  each `$sN` and `$sN.field` to the distinct function sources that read it (`stateReaders`). The
  per-field "is it read by a function other than its own initializer" check becomes a lookup. The
  index applies the regular expressions' rules exactly: the whole object counts only when it is not
  followed by `.`, `$` or a word character, and a field only when it is not followed by `$` or a word
  character. `stateInits.find` per node becomes a Map lookup.
- **`numberPaths`** (`src/paths.ts`): dependencies are grouped by their first segment. A write whose
  first segment is a plain name (`$s12`, `$r`) can reach only the dependencies in its own group and
  those whose first segment is `*`, `#` or `{…}`. `staticReach` already rules out everything else at
  segment 0. A write starting with a special segment is still checked against every dependency. The
  candidates are visited in the same id order, so the table is the same.

Checked: html, module, early script and diagnostics are byte-identical to main for 1, 7, 60 and 300
sections, and `vitest run` passes (2,107 tests).

## Why not split the page across threads

1. **Nothing large enough is left to split.** After the fixes no single stage is big and independent.
   The largest one is the main walk, which builds everything else.
2. **The compile is one stateful pass.** `Compiler` numbers nodes, state scopes (`sid`) and the
   deduplicated function table (`fns`, `fnUses`) in document order. It records diagnostics in order,
   and its later passes read the whole page: `writtenState`/`fixedDeps`, `dropEmptyStates`, the
   constant-folding passes, and the second `compilePasses` run that depends on the first. Splitting the
   page by subtree (say, top-level sections) means renumbering and merging all of that afterwards, and
   the cross-page analyses would still run serially over the merged result. That is a rewrite of a
   9,000-line class, with a determinism risk, for the 35% the walk takes.
3. **The pure parts are small.** Parsing expressions with acorn is about 5%. Moving the parsing to a
   worker means cloning the ASTs back, which costs about as much as parsing them.
4. **A worker costs more than a normal page.** A worker that has imported the compiler is ready after
   120–160 ms. Importing the compiler on the main thread alone takes about 150 ms. A typical page
   compiles in 20–60 ms. A worker pool kept across a build or a dev server pays that cost only once.
   But that pool serves *several pages at once*, which is the other spike's design.
5. **Some inputs cannot cross a thread.** `CompileOptions` carries functions: `readFile`, `listFiles`,
   the helper manifest used to fold build-time helper calls (user code loaded through Vite), the fold
   cache, and the image host. Any worker design needs these re-created in the worker or proxied back
   to the main thread. That is a constraint for the parallel build spike too.

## What runs around one page in the Vite plugin

`transformIndexHtml` awaits, in order: `stylesOf` → `lineHeightsOf` → `zeroWidthsOf` →
`helpersReady` → (minifier styles) → `compile` → when there are new images, `images.analyze` and a
second `compile`. Vite already runs the pages' handlers concurrently, so these awaits overlap with
other pages' work. `lineHeightsOf` and `zeroWidthsOf` both depend only on `styles` and could run under
one `Promise.all`. In the 100-post build both took 0 ms, so this isn't worth doing on its own. On a
100-post build, the synchronous `compile` calls add up to 5.3 s of the 8.6 s total (measured with
timers in the built plugin, not committed). That cost is spread across pages, which is the parallel
build spike's subject.

## How this relates to the parallel build spike

- They combine: a faster compile per page shrinks the work the parallel build hands to its workers,
  and a pool of workers is the only way the 120–160 ms startup is worth paying.
- They don't compete for cores, because this spike adds no threads.
- One case stays serial in a parallel build: a site with one huge page and a few small ones. With the
  pages split across workers, that page alone sets the build time. Only the fixes above shorten it.

## Next steps, if taken up

1. Land the two fixes with a test of their own: a large-page timing guard, or a unit test of
   `stateReaders`' boundary rules (`$s1` vs `$s12`, `$s1.a` vs `$s1.ab`, `$s1.` followed by a non-name).
2. Keep `bench/page-compile/run.mjs` to catch the next all-pairs loop. The 800-section row of the
   table is the one to watch.
3. Garbage collection is 21% at 800 sections. If huge pages matter, the next thing to profile is
   allocation in the main walk, not threads.
