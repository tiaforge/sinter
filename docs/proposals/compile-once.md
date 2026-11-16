# Spike: less compiling, not more threads

Status: spike (2026-11-16), uncommitted prototype on this branch. Builds on [parallel-page-compile.md](parallel-page-compile.md),
which removed the all-pairs loops inside one compile. This one asks which compiles a build runs at all, and which of
them repeat work that does not change. No threads.

Recommendation: take up **(1) compile a `data-sn-pages` template's first pass once** and **(2) parse component files once
per process**. Both are prototyped here, output byte-identical, all tests pass. Together a post's compile goes from 30 ms
to 8.5 ms, and the 1,000-post build from 38 s to 17 s. Then consider (3) dropping the per-entry describe compile, and,
as the larger redesign, (4) a single pass for pages whose decisions read only build-time data.

## Measured

`bench/collections`, static posts, 4 cores, Node 22. "Compile" is every entry's `compile()` replayed in-process after a
build (median of the later repetitions); "build" is `bench/collections/run.mjs`, one process each.

| | compile per entry | 100 posts, build | 1,000 posts, build |
| --- | ---: | ---: | ---: |
| main | 30.2 ms | 4.8 s | 38.4 s |
| (2) parse once | 25.1 ms | | |
| (1) first pass once | 10.9 ms | 2.6 s | 17.1 s |
| (1) + (2) | **8.5 ms** | | |

The live variant (each post with a comments resource, so a module per page): compile 32 → 10.5 ms per entry with (1),
build 6.5 → 4.3 s (the rest is Rolldown bundling 101 modules). Peak memory goes down too (100 static posts: 460 → 360 MB).

Checked: for every entry of the static and the live app at 100 posts, the page's HTML, module, early script, runtime
reasons and diagnostics are byte-identical with and without each change (`SN_NO_SHARE=1`, `SN_NO_PARSE_CACHE=1` switch
them off in the prototype). `vitest run`: 2,115 passed, 1 skipped.

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

## (1) A template's first pass, once per build

The first pass of two entries of one template is the same program: the 136 compiled functions are identical, and the IR
and the template HTML differ only in values (title, path, canonical URL). The entry is a constant resource (`fx`) whose
value the walk never reads. Only `prerender()` reads it, through `fileConstants`. The worklist reads compiled functions
and bindings, never the DOM, so the decisions (`decided`, `unrolls`, `foldReads`, `overLimit`) are a function of the
program and the values alone, and they are keyed by source position (`instKey`), not by anything per-entry.

Prototype (`src/compiler/compile.ts`, `sharedAnalysis`, `Compiler.redecide`, `run(html, analysisOnly)`):

- The first entry of a template runs pass 1 up to just before `prerender()` and the `Compiler` is kept, per build (keyed
  by `globCache`, file, locale and HTML).
- Each entry swaps its value into the entry's `fileData`, clears the decision maps, truncates the diagnostics to the
  analysis's, runs `prerender()` again, and goes to pass 2 with the result.
- It falls back to today's path when the pass would need pass 1's own output (nothing decided), its `constants` (the
  layout's dry run), a type check, or when pass 1 is not clean.

What a real version needs:

- `prerender()` split into *decide* (pure: values in, decisions out) and *write first paint* (DOM). The prototype
  re-runs the whole thing on the kept DOM, which works only because a pass 2 discards that DOM.
- The per-entry options the analysis bakes in, made parameters like the entry value: `urls` (the canonical link) and
  `foldLog`'s page (swapped in the prototype). A test that every per-entry option is one of these.
- `collectConstants` re-run per entry, so pages with constant classes or styles (Tailwind) share too.
- The template compile in `templatePages` can be that analysis, which removes it.
- Dev: the dev server compiles one entry per request, so this does not help there.

## (2) Component files parsed once per process

`parsedFiles` is a field of `Compiler`, so each compile (each pass, each entry, each page) parses every component it
uses again. `fileGraph` and `dataSlotsOf` parse the same text once more without caching. A component's parsed tree is
a function of its text, and every use already takes a `freshCopy`. The prototype keys one module-level map by text and
uses it read-only in all three places: 17% of a post's compile, and it applies to every page with components, in dev too.
A real version needs a bound (the editor and the dev server see every edit's text): an LRU, or clearing per build.

## (3) The per-entry `describeOnly` compile

`describe()` compiles each entry in full (without prerender) to learn its `path`, which is the entry's own
`page.path`, and its prefetch parts, which differ between entries only in the entry's values. One description of the
template, with each entry's path and values substituted, would replace N compiles. That's 1.8 ms per entry, about 7%
of the 100-post build after (1).

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
