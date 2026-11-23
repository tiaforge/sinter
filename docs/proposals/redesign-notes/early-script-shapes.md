# Early scripts that differ only in literals: one build per shape

**Where it stands (2026-11-23, evening): done, provable scheme is the default.** Pages whose early sources are one
program but for some literals share one nested build with a **free identifier** in each varying literal's place;
each page's literals are put back into the built output as syntax (`src/early-opaque.ts`). Why that is a correct
build of every page is in "Proof" below; it does not depend on what the minifier knows of the values. On every app,
the suite and sinter-mail, every shared page is also byte for byte its own build. The earlier scheme (placeholder
literals of the value's kind and length, checked on two pages per group, `src/early-shapes.ts`) is kept behind
`SN_EARLY_SHAPES=kinds` until the coordinator decides; what can then be deleted is listed under "The kinds scheme".
Switches: `SN_EARLY_SHAPES=0` off, `SN_EARLY_SHAPES_AUDIT=1` the self-check, `SN_EARLY_SHAPES_LOG=1` counts at exit.
Next: nothing required.

## The problem

A page with live parts gets an early script, built by a nested Vite build of a generated source (pipeline-fixes.md §1,
§6: one build per distinct source, all through one builder, ≈13 ms each). Since the embedding change
(embed-fields.md) folds a post's slug into the code, every post of the benchmark blog has its own source:

```js
const f = [
  ($) => ((("post-12"))),
  ($) => ({  }),
];
return { …, req: (q, n, b) => { q(() => "/api/comments" + $hq([["post", f[0](n[0])]])); } };
```

so `sinter-live-100` ran 101 nested builds (the shared head script and one per post), `sinter-live-400` 401.

## The kinds scheme (the first design; `SN_EARLY_SHAPES=kinds`)

1. **Cut** each distinct source at its string and number literals (acorn's tokenizer; module specifiers are not
   literals here). The **shape** is the source with every literal masked (a string keeps its quote character) plus
   the runtime names the build depends on (`take`, `own`).
2. In a shape, the literals that differ between its pages are **lifted**; the others stay as they are.
3. A lifted literal must be liftable on every page (else that page builds alone, the reason counted):
   - written as its value (no escape, no `0x`, `1_000`);
   - **passed along**, behind parentheses of its own: an argument, an element, a property's value or key, a returned
     value, a branch or condition, an operand of `+` (strings only). Not the object of a member (`"a".indexOf("-")`),
     an operand of a comparison or of arithmetic, a `case`, a spread, an initializer (`const a = "x"`);
   - of a **kind**: a string of at least 2 characters, all of `[A-Za-z0-9_\-.,:;/?&=+%#@!~*()|^[\]{} ]` (none needs an
     escape in any of the three quotes, none means anything in a template), not one a minifier knows by value
     (`typeof`'s answers, `use strict`, `__proto__`, `constructor`, …), classed as an identifier, a canonical integer
     (`x["12"]` becomes `x[12]`), digit-led, or other, and its exact length; a number: a safe integer ≥ 10 with at
     most 2 trailing zeros (1000 prints as `1e3`), by digit count and trailing zeros.
4. Pages of a shape are grouped by **kind key**: each lifted value's kind, which lifted values are equal to each
   other, which equal one of the shape's own literals. A group of fewer than 4 pages builds page by page.
5. A group is built **once**, each class of equal values replaced by a **placeholder** of its kind and length
   (`-aaaaa` for `post-1`, `Qaaaa` for an identifier, `9999` for a 4-digit integer…), none occurring in the shape's
   text or any page's values.
6. Each page's script is the shape's output with its values written over the placeholders (plain string replace:
   the characters need no escape in whatever quote the minifier chose), and the same over the modules' rendered code
   (`chunk.modules[id].code`; their lengths are equal since the lengths are). Content keys the build collected must
   not contain a placeholder (else the group falls back).
7. **The check**: the first 2 pages of every group are also built from their own source; script, modules and keys
   must equal what was written, else the rest of the group is built page by page (counted: "differs from its own
   build once written").

Why it is sound, and where it is not proven. What a minifier can do to a passed literal depends on what it knows of
it; the placeholder shares the kind, the exact length, truthiness and `typeof` with every page's value of the group,
and the program around it is the same token for token. What is not shared is the characters. A fold that reads the
characters (`indexOf`, `toUpperCase`, `includes`, a comparison) is stopped where it is written next to the literal
(rule 3) but not where the minifier carries the value there itself: Rolldown's minifier folds
`["ab-01"][0].indexOf("-")`, `(() => "ab-01")().indexOf("-")`, `("ab-01" || "q").indexOf("-")`, a template and a
concatenation (measured). Such a fold either drops the placeholder or computes from it, and the check sees it unless
the fold's answer happens to be the same for the placeholder and the two checked pages but not for a later page
(`includes("x")`: false for `-aaaaa`, `post-1`, `post-2`, true for `post-x`). Early code comes from the compiler,
which writes a folded value as `((("…")))` in a function of the table, read through `f[i](…)`, which the minifier does
not inline; a user's expression over a folded value (`post.slug.includes('x')`) could reach such a fold. That is what
the self-check is for.

**Switches:** `SN_EARLY_SHAPES=0` turns the sharing off (a build per distinct source, as before).
`SN_EARLY_SHAPES_AUDIT=1` builds every page whose script was written from a shared build from its own source too and
throws on the first difference (`SN_EARLY_SHAPES_AUDIT_LOG=<file>`: a line per page it checked).
`SN_EARLY_SHAPES_LOG=1` (and the audit) print at exit: distinct sources, nested builds, shared shapes, checked pages,
fallbacks by reason.

## Verified

- Byte identity, `SN_EARLY_SHAPES=0` against the default (with the audit on): `scripts/render-audit.mjs --switch
  SN_EARLY_SHAPES` (the four bench apps at 100, the four examples): same; `scripts/baseline.mjs --keep` both ways
  (its seven apps), `diff -r`: same; bench `live-400`, `live-files-400`, `static-100`, `static-files-100`,
  `static-typecheck-100`: same; sinter-mail (`scripts/mail-audit.mjs <checkout> --switch SN_EARLY_SHAPES`): 42 files
  identical.
- The audit over the apps: live-100 and live-files-100 (100 pages each), live-400 and live-files-400 (400 each),
  every page built from its own source too: no difference.
- `npx vitest run` with `SN_EARLY_SHAPES_AUDIT=1`: 2,908 passed. (No test app outside `early-builds.test.ts` has 4
  pages of one shape, so there the audit checks nothing; the bench apps are where it bites.)
- Tests (`test/vite/early-builds.test.ts`): six pages a literal apart and one whose program differs (5 nested builds
  for 8 sources; each page's head script as built alone; with the sharing off the same files); on Rolldown directly,
  each kind (identifier, integer string, digit-led, other, numbers with and without a trailing zero, a value twice,
  a concatenation folded at build time, the early script's own form) and each fallback (a member, a comparison,
  arithmetic, a `case`, an initializer, an escape, a one-digit number, an exponent, a fold through an array caught by
  the check, another length, an equality on one page only, another program).

## Builds by shape

| app | distinct early sources | nested builds before | after | shapes shared |
|---|---:|---:|---:|---|
| sinter-live-100, live-files-100 | 100 | 101 | 7 (1 head + 2 × (1 shape + 2 checked)) | `post-N` of 6 and of 7 characters |
| sinter-live-400, live-files-400 | 400 | 401 | 10 (3 lengths) | 6, 7, 8 characters |
| baseline apps, examples, sinter-mail | 1–8 per app | | the same | none (no group of 4) |

## Measurements

Machine: the session's own cloud container, 4 cores, Node 22.23.5, nothing else running (load ≈ 0 before each
series). Before and after alternated run by run in fresh processes. `generateBundle` is sinter's main
`generateBundle`, wall time from its first to its last line (an `hrtime` pair patched into a scratch copy of `dist/`;
the CPU profile cannot give an async hook's inclusive time: what runs after an `await` is a root of its own).

### Sharing the shapes (`SN_EARLY_SHAPES=0` against the default; medians, 5 runs at 100, 3 at 400)

| app | whole build before | after | `generateBundle` before | after | per live page |
|---|---:|---:|---:|---:|---:|
| sinter-live-100 | 4,268 ms | 3,235 ms | 1,135 ms | 128 ms | −10.1 ms |
| sinter-live-files-100 | 5,305 ms | 4,319 ms | 1,060 ms | 126 ms | −9.3 ms |
| sinter-live-400 | 13,446 ms | 9,684 ms | 4,611 ms | 482 ms | −10.3 ms |
| sinter-live-files-400 | 17,941 ms | 13,804 ms | 4,604 ms | 398 ms | −10.5 ms |

The whole build loses a little less than `generateBundle` at 100 (≈1.0 s of 1.0 s, within noise) and about as much
at 400; static apps have no early script and are unchanged.

### What one nested build is made of

CPU profile of `sinter-live-100` with the sharing off (101 nested builds through the one builder), samples inside
`generateBundle`'s window (1,153 ms, so 11.4 ms a build):

| | ms | per build |
|---|---:|---:|
| Rolldown's `#build` self time: the native bundle, link and minify, called synchronously | 408 | 4.0 |
| idle: the main thread waiting on Rolldown's native threads (`generate` is async) | 407 | 4.0 |
| `(program)`: native outside a JS frame | 126 | 1.2 |
| Rolldown's and Vite's JS per build: options bound to the binding (`bindingifyPlugin`, `wrapHandlers`, `bindingifyHook`), `injectEnvironmentToHooks`, `resolveRolldownOptions`, the output turned into JS objects (`transformToMutableRollupOutputChunk`) | ≈110 | 1.1 |
| GC | 27 | 0.3 |
| sinter's own (the entry plugin's hooks, `earlyScript`) | 14 | 0.1 |

So the fixed cost is Rolldown's: 9 of the 11 ms are its native work and the wait for it, not Vite's plugin pipeline
nor sinter's. A tiny script does not need most of what Rolldown does (a module graph, chunking, a runtime), but its
bytes are what Rolldown and its minifier make of it (pipeline-fixes.md: calling Rolldown with the entry plugin alone
changed the bytes). What remains to cut is the number of builds, which this change does.

### What is left in `generateBundle`, and the entry index

With the sharing on, a profile of `sinter-live-400` gave 437 ms in the window, of which ≈140 ms were `pageCss` and
its `path.resolve` calls: each page found its entry chunk by scanning every chunk of the bundle with
`c.facadeModuleId === resolve(root, rel)`, the path resolved once per chunk (400 pages × 800 chunks). The same scan
was in `pageModules` and in the content-namespace loop. Now one index per bundle (`entryChunk`: facade → first
entry chunk with it, a hit checked to be still in the bundle, a miss scanned as before). The rest: 10 nested builds
(≈120 ms), acorn's tokenizer over 400 sources (≈25 ms), GC, Rolldown's output objects.

| (medians of 3, alternating) | `generateBundle` before | after | whole build before | after |
|---|---:|---:|---:|---:|
| sinter-live-400 | 439 ms | 186 ms | 9,847 | 9,481 |
| sinter-live-files-400 | 463 ms | 228 ms | 14,491 | 13,809 |
| sinter-live-100 | 154 ms | 125 ms | 3,537 | 3,457 |

Byte identity of the index: the bench apps (100: static, static-files, static-typecheck, live, live-files; live-400,
live-files-400), the four examples and the seven baseline apps built with both `dist/`s: same.

## Alternatives

- **(b) The early script reads its values from the page** (the slug from an attribute or the URL), so every page's
  script is the same text and the existing per-source sharing applies. Not built: it changes every live page's
  bytes, adds a read at run time and a few bytes to the page (the value is in the page already, but not where the
  early script runs before any data), and the compiler decides what the early code reads. (a) gets the build to 7
  nested builds with no change to the output, which leaves (b) nothing to win at build time.
- **(c) Cheaper nested builds.** The profile above: 9 of 11 ms are Rolldown's native work and the wait for it. Running
  several at once gave nothing (pipeline-fixes.md §6: bound by the main thread); Rolldown alone changed the bytes. No
  cheaper way to the same bytes was found.
- **Placeholders of any length** (one per string, whatever its value's length): not tried, ruled out by what the
  check compares. Each module's `renderedLength` and rendered code are part of a build's result (the size report
  and SN325 read them), and they differ by the length difference; the length is also what a minifier's choices can
  depend on (inlining a short constant). The exact length makes the placeholder's text the only difference. (The
  first run of the check failed on every page for another reason, fixed since: the modules' rendered code carries
  the placeholder too, and is now written over like the script.)
- **Fewer checked pages** (one instead of two): one build less per group (5 instead of 7 at 100). Kept at two: the
  check is what catches a value-dependent fold, and a second page with another value makes a coincidence (the fold's
  answer the same for the placeholder and the first page) less likely for the cost of ≈13 ms a group.

## What is left

- The soundness gap above (a fold the minifier reaches through a value it carried, whose answer is the same for the
  placeholder and the two checked pages): closed only by the audit, which the bench apps pass page for page.
  If it ever matters, a second shape build with another placeholder alphabet would catch most such folds for
  ≈13 ms a group.
- Sources with a short or escaped varying literal (a one-letter id, a title with a quote) build page by page, as
  before; the log line (`SN_EARLY_SHAPES_LOG=1`) names them.
- At 400 posts, `generateBundle` is now ≈190 ms: 10 nested builds (≈120 ms), the tokenizer (≈25 ms), GC.

## The opaque scheme (the default)

1. Each distinct source is tokenized; its **skeleton** is the source with every string and number literal masked,
   plus the runtime names its build depends on. Pages of one skeleton are one program but for those values.
2. For a skeleton, its first page is parsed once (acorn) and each literal marked **liftable** when it is an
   expression the program only evaluates: not a module specifier or import attribute, a property or class member's
   name, a directive, `delete`'s operand or `require`'s argument; and nothing is liftable in a program whose skeleton
   has `import(`, `import.meta`, `require(`, `new URL`, `new Worker`/`SharedWorker` (constructs whose literal a Vite
   build step reads by value: dynamic imports, globs, asset URLs, workers). The token sequence is the same for every
   page of the skeleton, so the marks are too.
3. The literals that differ between the pages and are liftable are **lifted**; a literal that differs where it is
   not liftable splits the skeleton by its value. A group of at least 2 pages is built once: the first page's source
   with each lifted literal replaced by `__sn_lit<i>_<nonce>__`, a name no page's source has and no `define` key has.
4. A second nested build prints every page's lifted literals: `__sn_lit99999_<nonce>__(l1, l2, …)`, the same pipeline
   as the shape, so each literal comes out as the minifier prints it (`` `post-1` ``, `1e3`, `.5`, `` `<\/script>` ``).
   The output is parsed and each argument must be a literal (or a template without substitutions) whose value is
   the page's value, else the group builds page by page.
5. The shape's output is parsed once (`references`): every occurrence of a placeholder name in its text must be an
   `Identifier` reference the walk reaches: not in a string, not a key, a member's name, a declaration, an
   assignment or update target, a `for-in/of` head, a shorthand property, and no `with` in the output. Then each
   page's script is the output with each reference written as its printed literal (`writeRefs`): a number before a
   member's dot as `1 .x` (`1e3.x`, `.5.x` as they are, anything else in parentheses), a reference that is a
   statement in parentheses (it could otherwise become a directive), and `a[P]` with an identifier-name string as
   `a.name`, which is the same property (ES5 allows reserved words there) and what the minifier writes for
   `a["name"]`. The entry module's rendered code (size report metadata) gets the source literals the same way, its
   `renderedLength` adjusted by the difference. Content keys the shape's build collected must not contain a
   placeholder (they cannot: `moduleKeys` reads member names, never string values).

Without the audit a group costs two nested builds, whatever its size and whatever its values' kinds.

## Proof

Claim: for every page `p` of a group, the script written for `p` is a correct build of `p`'s early source, assuming
only that the bundler and minifier are correct, which is the trust a build of `p` alone places in them.

Notation: `S` is the shape's source, with the free identifiers `P1…Pk`; `S[P:=v]` is `S` with each `Pi` replaced by
the literal `vi`; `p`'s own source is exactly `S[P:=v]` for `p`'s values (step 3 replaced the literals' tokens, and
nothing else, by the names). `T` is what the pipeline (Vite's plugins, Rolldown, the minifier) makes of a source.
Let `E_v` be an environment in which, before the script runs, each `Pi` is a global immutable binding holding `vi`
(a `const` of an earlier classic script: reading it has no effect and cannot throw, nothing can assign it).

1. **The pipeline transforms `S` without regard to the identifiers' values.** A free identifier is a global
   reference; no step of the early build gives it a meaning: the early config has sinter's entry plugin and Vite's
   built-in build plugins; of those, only `define` replaces identifiers by name, and its keys are avoided (step 3);
   no `inject` is configured; the steps that read literal values (import specifiers, `import()`, `import.meta.glob`,
   `new URL(…, import.meta.url)`, workers, `require`) never see a placeholder in their argument (step 2). Sinter's
   entry plugin reads content-namespace calls by member name and rewrites only the helpers module. So `T(S)` is a
   correct translation of `S` in **every** environment, `E_v` included: a minifier may not assume anything about an
   unknown global's value, and the assumptions it may make about globals (a read has no effect and does not throw,
   the value does not change between two reads) hold in `E_v`.
2. **In `E_v`, `S` behaves as `p`'s source.** `S` only reads each `Pi`: each placeholder stands where a literal stood
   in an evaluated expression (step 2), and a literal there is never assigned, declared or deleted (excluded) and
   is not a directive or a key (excluded). Reading an immutable binding that holds `vi` evaluates to `vi` with no
   effect, which is what evaluating the literal does. `typeof Pi` is `typeof vi`. So `S` in `E_v` ≡ `S[P:=v]` = `p`'s
   source. By 1, `T(S)` in `E_v` ≡ `p`'s source.
3. **Writing the literals into `T(S)` is reading those bindings.** Step 5 checked that every occurrence of each name
   in `T(S)` is a reference, none is written, none is shadowed (no declaration of the name in `T(S)`, no `with`, no
   string that could reach a direct `eval`, since every textual occurrence is a reference), so each reference
   resolves to the global `Pi`, which in `E_v` evaluates to `vi` with no effect. Replacing each by a literal that
   evaluates to `vi` (step 4 checked the printed literal's value) gives a program that behaves in every
   environment as `T(S)` in `E_v`. The syntax around it: a literal is a primary expression and stands wherever an
   identifier reference stands, but before a member's dot for an integer (written `1 .x`) and as a statement (a
   string there in parentheses, so no directive is made); `a["n"]` ≡ `a.n` for an identifier name. Token
   boundaries are those the identifier had.
4. So the written script ≡ `T(S)` in `E_v` ≡ `p`'s source. ∎

What the proof does **not** give, and what was measured:

- **The bytes of `p`'s own build.** Where the minifier computes from a value, `T(S[P:=v])` is smaller than
  `T(S)[P:=v]`: a concatenation folded (`` `/api/`+`ab-1` `` → `` `/api/ab-1` ``), a method on a literal
  (`"ab-01".indexOf("-")` → `2`), a comparison, arithmetic, and an unused binding of a literal dropped
  (`const a = "x"`, where a read of an unknown global is kept as a statement: the one cost the bundler's
  conservatism adds). The audit (below) builds `p` alone and classifies any difference: allowed only when the
  minifier makes the two the same once it sees the value (both rebuilt through the same pipeline: equal), counted
  with its bytes; anything else throws. Measured: **no page of any app, of the suite or of sinter-mail differs**:
  the compiler writes a folded value as the body of a function of the table (`($) => ((("post-1")))`), read through
  `f[0](…)`, which the minifier does not inline; nothing computes from it at build time. The cases above occur only
  in `early-builds.test.ts`, which writes them on purpose (24 pages, each heavier by 3 to 19 bytes, and each run
  with the same result as its own build in a VM).
- **That the minifier is correct.** The same trust as building each page alone.
- Checked in the code, not assumed: that the generated source only reads the literal's place is not taken from how
  the compiler writes early code; it is decided per shape from the parse (step 2), and the output side is checked
  per shape (step 5); a shape where either does not hold builds page by page.

Holes found while checking the argument, and how each is closed:

| construct | why it breaks the argument | closed by |
|---|---|---|
| `import("m")`, `import.meta.glob("…")`, `new URL("./a", import.meta.url)`, `new Worker(…)`, `require("m")` | a Vite build step reads the literal's value: the placeholder would change what is bundled | no lifting in a program with these (skeleton test) and none of specifiers (step 2) |
| `delete "x"` | `delete P` is a syntax error in module code | not lifted |
| `"use strict"` as a directive; a string statement in the output | an identifier is no directive; a literal written as a statement could become one | not lifted; written in parentheses |
| `{ "k": 1 }`, `class { "m"() {} }` | `{ P: 1 }` names the key `P` | not lifted |
| a `define` key equal to a placeholder | Vite would replace the identifier | names avoid `define`'s keys |
| `with`, direct `eval` in the output | a name could resolve elsewhere | `with` refused; every textual occurrence must be a reference |
| a number before `.` | `1.x` does not parse | `1 .x` |
| `a["name"]` | not a hole (the same property), but the minifier writes `a.name`: written the same for the bytes | `writeRefs` |

## Measurements: the opaque scheme

Same machine and method as above (4 cores, Node 22.23.5, quiet; alternating; `generateBundle` wall time).

| app | nested builds: off / kinds / opaque | `generateBundle` off / kinds / opaque | whole build off / kinds / opaque |
|---|---|---|---|
| sinter-live-100 (3 runs, medians) | 101 / 7 / 3 | 1,046 / 115 / 70 ms | 4,283 / 3,221 / 3,233 ms |
| sinter-live-files-100 (3 runs) | 101 / 7 / 3 | 1,128 / 133 / 89 ms | 5,361 / 4,302 / 4,386 ms |
| sinter-live-400 (2 runs, both) | 401 / 10 / 3 | 4,788, 4,387 / 190, 223 / 118, 151 ms | 14,756, 14,230 / 10,172, 9,617 / 9,880, 10,191 ms |
| sinter-live-files-400 (2 runs) | 401 / 10 / 3 | 4,718, 5,186 / 232, 228 / 124, 150 ms | 19,509, 20,072 / 15,155, 15,203 / 14,732, 15,917 ms |
| examples, baseline apps, sinter-mail | unchanged: no two early sources of one program (realworld: 6 distinct sources, 6 builds; dashboard 1) | | |

The whole build cannot tell kinds from opaque (±300 ms of noise against a 50–100 ms difference); `generateBundle`
can. A first version parsed every page's source and output (acorn) and was slower than the kinds scheme
(137 / 245–274 ms); parsing once per shape (the marks and the references depend only on the shape) made it the
fastest.

Verified (with `SN_EARLY_SHAPES_AUDIT=1`, `SN_EARLY_SHAPES=0` against the default, after merging
`ccr-9ebf49d5-gpdej8` at the merge of check-data-once):

- `npx vitest run`: 2,927 passed; the audit checked 70 shared pages, 10 of them from other tests' apps (blog posts,
  `en/`/`de/` pages, carts), all the same bytes; 24 "used the value", all in `early-builds.test.ts`'s deliberate cases.
- `render-audit.mjs --switch SN_EARLY_SHAPES` (bench at 100, examples), `baseline.mjs --keep` both ways, bench
  `live-400`, `live-files-400`, `static-*`: same; the audit checked 1,000 pages, all the same bytes.
- sinter-mail (`mail-audit.mjs --switch SN_EARLY_SHAPES`): 42 files identical. `render-audit.mjs` and
  `pass-audit.mjs` with their own switches: same.
- Tests: `test/vite/early-builds.test.ts`: every kind (identifiers, integer strings, digit-led, any number, a
  string with quotes, backslashes, a template's characters, `</script>`, a line separator, one-letter strings, a
  value twice, `(1).toFixed`), one shape and the bytes of each page's own; four value folds (shared script keeps
  the expression, counted, behaves the same in a VM); what is not lifted (keys, specifiers, directives, `delete`,
  `import.meta`), another program, and the substitution's refusals; that a free identifier makes Rolldown log
  nothing and emit no import.

### The kinds scheme: what can be deleted

When the opaque scheme is accepted: `src/early-shapes.ts` but the `Built` type (move it to `early-opaque.ts`), the
`SN_EARLY_SHAPES=kinds` branch in `generateBundle`, and the two kinds tests in `early-builds.test.ts` ("each kind of
literal shares a build …", "a page falls back …") with their helper `shapes` (`mini` and `of` stay: the opaque tests
use them). The kinds scheme's notes above stay as the record of why it was replaced.
