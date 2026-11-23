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

Found, not changed: a prop given as a number literal and read with a member (`n.toFixed()` with `n: 1`) becomes
`1.toFixed()` in the page module, a syntax error Rolldown reports (`Invalid characters after number`) instead of
the check's diagnostics; the corpus passes such props from state.
