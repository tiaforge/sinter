# Early scripts that differ only in literals: one build per shape

**Where it stands (2026-11-23):** built, on by default, byte-identical on every app checked, the self-check clean.
`src/early-shapes.ts` and `generateBundle` in `src/vite.ts`. Next: the measurements below (before/after on a quiet
machine), the 13 ms of one nested build broken down, then the merge of `ccr-9ebf49d5-gpdej8`.

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

(to come)
