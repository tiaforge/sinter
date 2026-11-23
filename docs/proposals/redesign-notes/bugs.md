# Redesign notes: six bugs found on the way, fixed

Running log (2026-11-23). The research for the compiler redesign recorded six bugs without changing them
([decisions.md](decisions.md) §7.1–7.3, [typecheck.md](typecheck.md), "Findings"). These fixes change behaviour and
output for the affected pages, on purpose; everything else stays byte-identical. Per bug: the reproduction, the
cause, the fix, and what output changes for whom.

How each is checked: a failing test first; then `npx vitest run test/compiler test/vite test/check
test/check-cli.test.ts` and the full suite; `node scripts/render-audit.mjs` (every app "same");
`SN_RENDER_AUDIT=1` and `SN_LINK_AUDIT=1` over `test/compiler`; the five benchmark apps and four examples built with
the base `dist/` (`53942ea`) and with the fix, diffed file by file (floor.md's `ident.mjs`); for the type-check
bugs the diagnostics corpus of typecheck.md (apps a–d); sinter-mail's `mail-audit.mjs --suite`.

## 1. A choice's props were not checked for being build-time constants

**Reproduction** (`test/compiler/choice-props-constant.test.ts`). `<div data-sn-state="{ s: 'a.jpg' }"><sn-component
use="{ a: 'x-img' }['a']" data-sn-with="{ src: s }"></sn-component><button data-sn-on-click="s = 'b.jpg'">`, with
`x-img` an `<img data-sn-attr="{ src }">`: with `images` on, the image was written as a static `<picture>` of
`a.jpg`, with no binding left, while `<x-img data-sn-with="{ src: s }">` keeps its binding. Without `images`, rows
rendered at build time (stage 1, `rowRenderer`) made it worse: a text prop (`<b data-sn-text="label">`) came out as
a static `<b>a.jpg</b>`, at the top of the page and in every row of an unrolled loop around the choice. A click
changed nothing on the page.

**Cause.** `worklist`'s `expandCase` evaluated the case's props (`($) => (props)`) without the test every other
decided expression passes: `caseOf` checks the `use` expression's deps with `fixed` and `known`, a ROW binding its
own, a loop or `if` its own, but the props were run as they came. Inside the definition the props read as `$p<n>`
with no deps, so the case's bindings pass `fixed` there, and their values (from the state's initial value) went into
`rowPaint` and the rendered record. The case's own deps (`ChoiceGroup.cases[].deps`: the props' lets, `use`, the
tag's attributes, in the caller's terms) were there all along.

**Fix.** `expandCase` runs the props only when `fixed(c.deps) && known(c.deps)`; otherwise the case is not expanded
(`FAIL`): outside rows it stays a run-time choice (`choose` leaves the candidate, `pending` null), inside a row the
row is not static and the loop is left to the browser. `rowRenderer` renders only what `expandCase` recorded, so it
takes the same answer. Neighbours: a recursion point's props are its node's `for` binding, which `nodesOf` already
checks (`fixed(b.d) && known(…)`); a tree placement's data was run unchecked like the props, and now passes the same
test (`P.deps`). In the test suite and the apps no placement's data has deps that fail it (a placement is in a
definition, whose reads of its props have no deps, and a node with state of its own already fails the row), so this
one is a guard with no output change today.

**What changes.** Pages with a `<sn-component use>` whose props read state that a handler (or a model) writes: the
case is no longer expanded at build time; the page ships the choice and renders it in the browser, as the tag would.
No benchmark app, example or sinter-mail page has one: all byte-identical.
