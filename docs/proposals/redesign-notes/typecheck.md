# Redesign notes: the type check of a build, once per component

Part of [compile-units.md](../compile-units.md), stage 4: "a component's markup is checked once". With TypeScript
installed, `vite build` type-checks every page (`typecheck`, on by default). This note measures where that time
goes, says what each change did, and what is left. Measured 2026-11-23 on the 4-core machine the other agents load
(load average 2 to 14 during these runs; medians of back-to-back runs, ±15 % at best), TypeScript 7.0.2 (`tsc` is
the native compiler), Node 22.23.

## How the check works (before)

- The compiler records a check unit per page (`compile(…, { check: true })`, `CheckUnit`): every expression with its
  position and the scope frames it sees. A component's markup is recorded once per use, and each copy is checked
  against the component's declared props (`contract.md` §5).
- `check()` (src/check/index.ts) writes one shadow file per page (`shadowOf`): a block of declarations (the page's
  resources, `$meta`, the store's functions typed by the resources, the helpers, sinter's names), then one function
  `$e<i>` per expression, which opens its frames (`$e<j>()` for a frame's initial value) and returns the expression.
- One `tsc -p` child process over every shadow; a second one for the components' `<script>` blocks only when the
  app has a `tsconfig.json` and there are blocks. Not incremental: the libs (`lib.dom.d.ts` and the rest, about
  60,000 lines) are parsed on every run.
- `tsc` prints its errors sorted by file, then position (checked: `a.js` before `b.js` whatever the order of
  `files`), and prints no semantic error at all when any file of the program has a syntax error (a broken
  expression, which the compiler has reported already).

## Where the time went (before)

Blog benchmark, 100 posts, a page file per post (`writeSinterApp(root, { n: 100, files: true, typecheck: true })`),
instrumented (`profile-agent`'s `instr.mjs`, ms per page, one build at load 12):

| | check off | check on |
|---|---:|---:|
| whole build (wall, load 12) | 10.2 s | 24.0 s |
| `compile()` per page | 50.6 | 117.1 |
| pass 1 `walkPage` | 21.1 | 66.5 |
| of it `definition` (calls per page) | 10.5 (13, and `replay` 7.3) | 56.6 (257) |
| pass 1 `finishPage` | 0 (1 call in the build) | 12.0 (every page) |
| `check()` | | 9,735 ms: `shadowOf` 1,097, `tsc` about 8,600 |

- The shadows: 101 files, 783,933 lines, 22 MB. A post's shadow is 7,839 lines and 429 functions, 425 of them the
  expressions of sinter-markdown's definitions; over the build they are 150 distinct functions. Two posts' shadows
  differ in two lines (the header and the file's value).
- `tsc` alone over them: 842k lines, parse 3.2 s, bind 0.4 s, check 4.5 s, 924 MB (load 12).
- Template variant (one `<html data-sn-for>` template): its check is two units, `check()` 0.2 s; what it cost is
  in the compile (measured below).

## Where it stands (all five changes)

Medians of 3, interleaved, 4c3e26c against this branch, load 9 to 16 (wall times are 2 to 3 times a quiet machine's;
CPU is user + sys of the build and its `tsc` children, and moves much less with the load):

| case | before: wall (CPU) | after: wall (CPU) | the same app without the check |
|---|---:|---:|---:|
| blog, one template, 100 posts | 5.3 s (5.9 s) | 4.6 s (6.1 s) | (its check was already once per template) |
| blog, a page file per post, 100 posts | 30.0 s (22.8 s) | 13.9 s (10.4 s) | 6.3 to 6.5 s (8.0 to 8.2 s) |
| sinter-mail, 12 API pages (route ii), TypeScript in the app; warm build (CPU of cold and warm) | 38.8 s (46.7 s) | 9.2 s (14.0 s) | 3.7 to 4.1 s (8.4 to 9.0 s) |
| examples/realworld, 7 pages | 4.1 s (3.3 s) | 4.1 s (3.4 s) | (858 functions, 64 distinct shared: its check was small) |

`sinter check` on the blog's files variant: 12.8 s with change 1, 8.7 s with change 5 (one run each, load 13).
The outputs: the benchmark's two blogs and sinter-mail's routes (i), (ii) and (iii) build byte for byte the same
with the check on and off, and the blogs the same as 4c3e26c's.

## What changed

### 1. Each expression's function checked once (`checkShared`, src/check/index.ts)

A page's shadow function refers to nothing of its file but the declarations and the functions of the frames it
opens. So the build's check writes the functions that repeat (across pages, or at several uses on one page) once,
into a module beside the pages (`$shared-<n>.js`, one per folder, so that its relative imports are the pages'), and
each page's shadow keeps its declarations and the rest. TypeScript's errors in a shared function are laid out where
each page's whole shadow would have had them, in the order `tsc` prints (by file, then position), and turned into
diagnostics by the same code as before (`parseTsc` over records): the same diagnostics, at every place they
repeat, with each page's include chain.

- What is shared is decided on the text TypeScript sees, not on what the compiler meant: two functions are one when
  their text is the same, the functions they call included (`$s<id>` names). No claim about components is needed.
- A function stays on its page when its text names something the page's declarations type for that page: a
  resource of the page (components see the page's resources), `$meta`, `refresh`, `upsert`, `page`, `$A`, `$O<n>`,
  `$F<n>`; or when it calls such a function, or is broken (its syntax error must stay where it was), or nothing
  else has it. The shared module's declarations are a page's without the resources; every other name is declared
  the same way on every page of a build. The type names an app without a types module declares `any` are part of
  the key of the module.
- It gives up (checks every page whole, as before) when nothing repeats, a path is not ASCII, the files of `tsc`'s
  output come in another order than the one it lays them out in, an error is outside a function of a shared module
  or names one (`$s12`), or one is past a page's end. `SN_CHECK_DEBUG=1` says which; `SN_CHECK_SHARE=0` turns it
  off.
- For builds and `sinter check` (both check every page); `sinter lsp` and `checkPage` check as before.

Files variant: 101 shadows of 78 lines and one shared module of 150 functions (7,700 lines); `tsc` 0.86 s wall
instead of 9.8 s. 42,500 of 42,900 functions come from the shared module.

| median of 3, interleaved | before | after |
|---|---:|---:|
| blog, a page file per post, check on | 12.6 s | 8.4 s |
| blog, one template, check on | 5.1 s | 4.4 s |
| sinter-mail, 12 API pages (route ii), TypeScript in the app, warm (one run each, load 8) | 21.3 s | 8.0 s |

sinter-mail without TypeScript: 3.1 s warm. Its 12 pages have 56,916 functions, 294 distinct: all but the 12
page-level ones come from the shared module. The bench is `scratchpad/typecheck-agent/mail-bench.mjs <route>
<pages> ts` (test/app.ts's `app()`, `sinter({ libraries })`, TypeScript linked into the app, cold then warm).

### 2. The first pass stops at its decisions under check too (`compilePasses`)

With a second pass to follow, the first pass stopped after its decisions (`quietFinish`) except when the page was
type-checked: the check unit was taken from `finishPage`'s result. `finishPage` adds nothing to the unit (the walk
records every expression; `runTargets` runs in the walk), so the unit is taken from the first pass where it stops.
Checked by an assertion, over the whole suite, the corpus, the blog bench, sinter-mail's three routes and the four
examples: `finishPage` never changed a check unit (`JSON` before and after). 12.8 ms a page on the files variant
(`finishPage`, with `shareTemplates`, `earlyParts`, `anchors`).

| median of 3, interleaved (load 4 to 9) | before | after |
|---|---:|---:|
| blog, a page file per post, check on: wall | 8.80 s | 8.17 s |
| the same, CPU (user + sys, `tsc` included) | 14.5 s | 13.6 s |

### 3. Shared definitions linked under check (`definition()`, `LINK_FIELDS`)

Why `definition()` did not link under check: the check unit's lists (`check.frames`, `check.exprs`,
`check.resources`) were inside `check`, a field the linker holds `fixed`, so a recorded definition's expressions
went into the recording page and nowhere else; and every `if (this.check)` in the walk read the whole unit, which
names the page, so no plan would have held on another page.

- The lists are compiler fields of their own (`checkFrames`, `checkExprs`, `checkResources`, the same arrays as
  `check`'s), classified as tables: a unit's pushes are recorded and replayed like any table's. The walk tests
  `checking` (a boolean) instead of `check`.
- A plan's key gains the lists' lengths: the frames and expressions a definition records refer to each other by
  number, and a plan links only into a page numbered alike, as for templates and functions.
- The include chain of a definition's expressions names the page (`post-3.html:1`): the linker already gives each
  page its own (`Line`), as it does for the origins.
- The one place that removed an expression (`exprs.pop()`, a choice's `use`, whose key is checked instead) does not
  record it in the first place (`expr(…, kept = false)`); lists are only pushed to in a unit.
- `SN_LINK_AUDIT` now runs under check too (it compiled the page once, unlinked, so it compared nothing there), and
  compares the check unit with the rest.

This does teach the linker something, which [stage4-units.md](stage4-units.md) rejects as stage 4's design (a plan
copies everything a definition wrote; on sinter-mail its replay is a third of a later page). It was measured first:
what it buys under check is the whole of the linker's gain (below), now, and what is the linker's in it is three
`LINK_FIELDS` entries and the key's lengths. The rest is what stage 4's step 5 needs whatever replaces the linker:
the check unit's lists as fields a unit's merge can append to and offset (`CheckExpr.frames`, `init`), and a walk
that tests whether it checks without reading the page's unit.

On the files variant 1,304 `definition` calls a page and 38 compiled, as without check (26,000 and 1,900 before).

| median of 3, interleaved (load 11 to 15) | before | after |
|---|---:|---:|
| blog, a page file per post, check on: CPU (wall) | 12.8 s (18.3 s) | 10.7 s (14.2 s) |
| sinter-mail, 12 API pages with TypeScript: warm build (CPU of cold and warm) | 9.7 s (19.4 s) | 7.8 s (16.0 s) |

What is left of the check in the compile: the two pages that compile and record the library (on sinter-mail the
recording is 0.7 s more with check data), and the check data each later page replays (12 ms a page on sinter-mail).

### 4. Shadows made faster (`shadow`, `checkShared`)

`libTyped` (a library's type names in a props type, renamed to its types module) made a `Set` of the library's
names and ran its regex for every function that opens a library component's frame, on every page; it keeps its
work per library and text. `relative()` for module specifiers is kept per target. The sharing key's test for page
names runs one regex over a function before the exact scan. sinter-mail, `check()` per build (12 pages, loaded
machine): 3.1 s to 1.8 s (`shadow` 1.08 to 0.62 s, the key 0.81 to 0.17 s, `tsc` 0.7 s).

| median of 3, interleaved (load 12 to 14) | before | after |
|---|---:|---:|
| blog, a page file per post, check on: CPU | 10.9 s | 9.6 s |
| sinter-mail, 12 API pages with TypeScript: CPU of the cold and warm builds | 16.9 s | 15.2 s |

### 5. `sinter check` links its pages' definitions (`cli.ts`)

The CLI compiled every page with no cache of shared definitions, so a library was compiled on every page (on the
blog, 1,900 `compileDefinition` calls, 3.5 s of the 6.6 s of compile). It now passes one `definitions` map to its
pages' compiles, as the build does; since change 3 that links under check too. The corpus's `sinter check` outputs
are the same (also under `SN_LINK_AUDIT=1`). Blog, a page file per post: `sinter check` 12.8 s to 8.7 s (one run each,
load 13).

## Is a component's markup checked the same at every use? (contract.md §5, checked)

Mostly, and the shared check does not depend on it: it compares the text TypeScript sees. What the check data shows:

- A component's frames are its own (`componentScope` starts from no state, loop or let of the caller's); its props
  frame is the declared type. Choice candidates narrow on the caller's side (the `guard` is on the use's
  `data-sn-with`); fills are the caller's markup, in the caller's frames and the slot's frame (`Slot<T>`), one copy
  per fill. A `<script>` block is checked per file, in the second run. So over the blog's 101 pages, 42,500
  functions are 150 texts.
- **Not quite "nothing semantic":** a component sees the page's resources (SN201's message says so), and through
  them `$meta`, `refresh`, `upsert` and `page`, which are typed by each page. The corpus has one (`x-res` reads
  `people`, a `Person[]` on one page and a `string[]` on another): its error differs by page. Those functions stay
  on their pages. A per-component check would have to do the same.
- What differs per use otherwise is the include chain in the message (`(included from a.html:6)`), which is why the
  errors are laid out per use rather than reported once. The build's error text and `sinter check` print every one;
  the editor drops exact duplicates (`publishAll`: file, line, column, code, message), so it shows one per distinct
  chain. Unchanged.

## What is left, and what stage 4 proper adds

- **The check data is still per page.** A linked definition's check data is replayed into each page (a copy, with
  the page's chain), and `check()` writes each page's whole shadow in memory (`shadow`) to find where its errors go,
  then hashes each function's text to find the shared ones. On sinter-mail that is about 12 ms a page of replay and
  50 ms a page of shadow text and keys. Stage 4's unit would carry its check data once, with a hole for the page's
  chain (the one thing that differs), and `check()` would take a page's layout from the units it links (their
  functions' lines, known once) instead of writing it out.
- **Recording.** The page that records a definition records its check data too (on sinter-mail, 0.7 s more per
  build than without, mostly the linker's copy and encode of 4,700 expressions). Gone with the linker.
- **`tsc`.** One process, not incremental; about 0.7 s on these apps, most of it parsing TypeScript's libs. A second
  process for the components' `<script>` blocks when the app has a `tsconfig.json` (0.26 s for corpus app d);
  running the two at once would need `check()` to be asynchronous (it is public API). Not done.
- **Tried and dropped:** turning `check` off in the second pass, whose unit is thrown away. `check` is not only data:
  SN506 (an `<sn-event>` without `type`) is reported only under it, and a choice's key is compiled once more (and
  can report), so the second pass's diagnostics would change. What it costs there is small once definitions link
  (the files variant's second pass compiles a page's own few expressions).

## Checks

- Each commit's own state, in a copy of the worktree: the whole suite (2,840 tests at the start, 2,844 with
  `check-shared.test.ts`), green but for tests over their deadline at loads of 13 to 25, which pass alone: two
  `checkPage` tests with a tsconfig in `test/check/check.test.ts` (3 to 4 s each at the start too), once
  `test/lsp/lsp.test.ts`'s 10 s wait for diagnostics, once `test/vite/compile-hints.test.ts`.
- `SN_LINK_AUDIT=1`, the whole suite, on change 3: green once the audit compared a template's check unit fairly.
- After merging `ccr-9ebf49d5-gpdej8` (with the stage 2 coverage and the stage 4 spike): 2,851 passed, one over 5 s
  at load 25; the corpus the reference; `scripts/render-audit.mjs` over the four examples (which type-check) the
  same both ways.

## The diagnostics corpus

`scratchpad/typecheck-agent/corpus/` (`gen.mjs` writes the apps, `run.mjs <out>` builds each and runs `sinter
check`, and diffs the clean app's dist with the check on and off). Four apps on the `@fixture/ui` library:

- **a**: errors in a component's markup used once, twice, in a loop over constants and over a resource, as a choice
  candidate (with an SN538 candidate), with a fill and a slot that passes data, in a recursive component (a shared
  definition, on three pages and two folders), in a library component's fill and props, in a component that reads
  the page's resource (two pages with different types for it), in page markup, in `data-sn-with`, in handlers (on
  the tag, `$event.detail`), and in a `<script>` block. 49 errors and a warning.
- **b**: a plus a page with a broken expression: TypeScript then reports no type error anywhere (1 error).
- **c**: clean: the build passes; its dist is compared with the check on and off.
- **d**: a with an app `tsconfig.json`.

The reference is the output of `4c3e26c`'s dist. After each change the whole output (the build's error text, the
CLI's stdout, stderr and exit code, the clean dist) is byte for byte the reference.

Found, not changed (today's output, recorded):

- A prop given as a number literal and read with a member (`n.toFixed()` with `n: 1`) becomes `1.toFixed()` in the
  page module, a syntax error Rolldown reports (`Invalid characters after number`) instead of the check's
  diagnostics; the corpus passes such props from state.
- A broken expression on any page (app b) silences every type error of every page: `tsc` reports no semantic error
  in a program with a syntax error. The build stops at the compile error first; `sinter check` prints the compile
  error and no SN208.
- A recursive component used on a page both inline and through its shared definition reports an error in its markup
  twice on that page, once per copy (`(included from deep.html:6)` and `(included from deep.html:1)`, the
  definition's chain being the page's first line).
- The build counts warnings among its type errors: app a fails with `sinter check: 50 type error(s)` for 49 errors
  and an SN538 warning (`sinter check` says 49 errors, 1 warning).
