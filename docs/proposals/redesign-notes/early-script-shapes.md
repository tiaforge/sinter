# Early scripts that differ only in literals: one build per shape

**Where it stands (2026-11-23):** built, on by default, byte-identical on every app checked, the self-check clean;
measured (below). Also: a page's entry chunk found through an index (was ~140 ms of `generateBundle` at 400 pages).
Next: merge `ccr-9ebf49d5-gpdej8`, rebuild, re-run the identity checks and the audit.

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

## The design

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
