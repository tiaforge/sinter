# Spike: less compiling, not more threads

Status: (1), (2) and (3) landed (2026-11-16) with tests (`test/compiler/template-pass.test.ts`, the next-page test in
`test/vite/pages.test.ts`); (4) and the rarer re-runs are open. Builds on
[parallel-page-compile.md](parallel-page-compile.md), which removed the all-pairs loops inside one compile. This one asks
which compiles a build runs at all, and which of them repeat work that does not change. No threads.

As landed, the 100-post blog builds in 2.4 s instead of 4.7 s, and the 1,000-post one in 14.1 s instead of 37.9 s. Next:
(4), a single pass for pages whose decisions read only build-time data.

## Measured

`bench/collections`, 4 cores, Node 22. Each build in its own process, `main`'s `dist` and this branch's swapped in turn:

| | main | as landed |
| --- | ---: | ---: |
| 100 static posts | 4.7 s | 2.4 s |
| 100 posts with a live resource (a module per page) | 6.6 s | 4.2 s |
| 1,000 static posts | 37.9 s | 14.1 s |

The output is byte for byte `main`'s: every file of each build above, and of every example app (`examples/*`) built
with each `dist`. Per entry, replayed in-process: 30.2 ms on `main`, 25.1 ms with (2) alone, 8.5 ms with (1) and (2)
in the prototype; a build now runs one `describeOnly` compile per template instead of one per entry. The live build's
rest is Rolldown bundling 101 modules. Peak memory goes down too (100 static posts: 460 → 360 MB).

## Which compiles a build runs

For a `data-sn-pages` template with N entries (`main`, 100 static posts):

| Compile | Count | Each | What for |
| --- | ---: | ---: | --- |
| the template, as a template | 2 | 26 ms | its entries (`templatePages`) |
| `describeOnly`, per entry | N | 1.8 ms | the entry's path and what is requested ahead (`describe`) |
| pass 1, per entry | N | ~22 ms | the program, then evaluated to decide what is constant |
| pass 2, per entry | N | ~9 ms | the page written with those decisions |
| again with `canonicalLink: false` | static pages with a pattern path | both passes | the canonical link |
| again after `images.analyze` | pages with new images | both passes | the images' sizes |

Of pass 1's 22 ms, the walk takes 16, and 13 of that compiles the markdown library's recursive components into run-time
"shared definitions" (`definition`, `runtimePlacement`) that the finished, static page never ships. Only the
evaluation (`prerender`, about 2 ms) depends on the entry.

## (1) A template's first pass, once per build (landed)

The first pass of two entries of one template is the same program: the 136 compiled functions are identical, and the IR
and the template HTML differ only in values (title, path, canonical URL). The entry is a constant resource (`fx`) whose
value the walk never reads. Only `prerender()` reads it, through `fileConstants`. The worklist reads compiled functions
and bindings, never the DOM, so the decisions (`decided`, `unrolls`, `foldReads`, `overLimit`) are a function of the
program and the values alone, and they are keyed by source position (`instKey`), not by anything per-entry.

As landed (`fromTemplate` in `src/compiler/compile.ts`, compile's `templates` option, which the Vite plugin passes in
builds and clears with the build's reads):

- `run()` is `walkPage()` (parse, expand, walk: the program) and `finishPage()`. A template's first entry is walked and
  the `Compiler` kept, by file, language and HTML.
- Each entry swaps its value into the entry's `fileData`, clears what the evaluation writes, and runs
  `prerender(true)`: it evaluates as before, records what it would paint, and writes nothing into the markup, so every
  entry starts from the same walk. Then `collectConstants` (the constants of rows come from the evaluation) and pass 2.
- Not shared, known from the walk: a page that compiles its own URL into its program (`$canonical` at a fixed path,
  `localeUrl()` from its translations; `PageInfo.readsUrl`). As a backstop, the first other entry is walked too, once,
  and its program must be the kept one (the functions, in order), or the template is not shared.
- Compiled the usual way, per entry: nothing to decide (the first pass is the page), a constant the layout or the images
  read that the first pass writes into its own markup and drops (a top-level class), the dry run, errors (in either
  pass), a type check, the canonical-link re-run. A template whose first two entries gain nothing is not evaluated for
  the next ones.
- The fold log: each entry logs the helper calls it would on its own.

Each guard has a test that fails without it. Dev is unchanged: the dev server compiles one entry per request. The
template compile in `templatePages` (once per build, ~50 ms) still runs on its own.

## (2) Component files parsed once per process (landed)

`parsedFiles` is a field of `Compiler`, so each compile (each pass, each entry, each page) parses every component it
uses again. `fileGraph` and `dataSlotsOf` parse the same text once more without caching. A component's parsed tree is
a function of its text, and every use already takes a `freshCopy`. One module-level map, by text, now
serves all three places, read-only: 17% of a post's compile, and it applies to every page with components, in dev too.
Landed with a bound: the map is cleared when it holds 2,000 texts (the editor and the dev server see one per edit).

## (3) The per-entry `describeOnly` compile (landed)

`describe()` compiled each entry in full (without prerender) to learn its `path`, which is the entry's own `page.path`,
and what it requests ahead. That reads only `$url`, never the entry (a request over the entry is not prefetchable), so
entries' descriptions differ only in their path. The Vite plugin now describes one entry per template and language and
gives every other entry that description at its own path (`entryDescription`): 100 compiles become one. A compiler test
checks the invariant (a `$url` request, one over the entry, a language prefix), and a build test that the next-page
module lists each entry at its own path with its request.

## (4) Do we need two passes at all?

Pass 1 exists because "what writes state, which decides what is constant, is known only after a walk"
(`compilePasses`). That is true for `data-sn-state`, but not for `file:`, `content:` and the entry: nothing can write
them, so they are known to be constant before the walk. A page whose decisions read only those (every post here) could
unroll a loop or pick a component while it expands, evaluating the expression there, and skip both the shared
definitions and the second walk. That would cover pages that are not `data-sn-pages` too (a post per file:
`measure.mjs --files`, which (1) does not help). Estimate: pass 1's share, about two thirds of a prerendered page's
compile. It is the largest change. It needs an evaluator over expressions during `expandComponents`, the same
decisions as the worklist (the expansion limit, per-instance agreement), and pass 1 kept for pages whose decisions
read state. Of the changes in this list, it's the only one that touches what the compiler decides, so do it after
(1)–(3), with the byte-identical check over `examples/*` and both benchmark apps.

The two rarer re-runs are full recompiles, which a patch of the first result could replace: `canonicalOnly` (a static
page with a pattern path, whose canonical link is the only difference) and the compile after `images.analyze`. Neither
is hit by this benchmark.

## Not pursued

- Threads: see the two earlier spikes.
- GC is 10–12% of the compile throughout. Fewer passes allocate less; it is the next thing to profile after (1)–(3).
