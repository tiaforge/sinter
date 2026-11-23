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

## 2. A number-literal prop read with a member was pasted as `1.toFixed()`

**Reproduction** (`test/compiler/pasted-props.test.ts`). `<x-n data-sn-with="{ n: 1 }">` with `x-n` reading
`n.toFixed(1)`, on a page whose bindings stay in the browser: the page module had `($) => (1.toFixed(1))`, which
does not parse (Rolldown: `Invalid characters after number`), so the build failed with a bundler error instead of
anything about the page. The same through a component that passes the prop on (`{ n: m }` with `m: 3`), and through
a slot's data (`$slot.n.toFixed()` with `<slot data-sn-with="{ n: 2 }">`). `sinter check` was not affected: its
shadows declare a prop as a `const` of its own, they do not paste it.

**Cause.** A prop is a let, whose code is put where the markup reads it (`emitName`, expr.ts). It goes in bare when
it is "a plain path" (`/^[\w$]+(\.[\w$]+)*$/`, so that the same expression is the same function at every use), and
in parentheses otherwise: a string is `('A')`, an object `({ … })`, `-1` is `(-1)`. `\w` takes digits, so a number
literal counts as a path and goes in bare. For precedence that is right (a literal is a primary expression, like a
path: `1 + 1`, `` `${1}` ``, `-1` from `-n`, `new`, `typeof` are all as written). What goes wrong is tokenization: an
integer followed by `.` reads the `.` as its decimal point. That is the only place where the text after a pasted
primary joins it: a path followed by `.` is a member (`$.n.x`), a decimal (`1.5.toFixed()`), an exponent
(`1e3.x`), a hex, binary, octal or BigInt literal take a `.` as a member too; `1 .x`, `1?.x` and `1[x]` parse.

**Fix.** The rule as it now reads: a let's code goes in bare when it is a path or a literal, else in parentheses
(precedence), and an integer goes in parentheses where a `.` follows it right away (tokenization): `pasted()`, at
the two places a let's code replaces a name in the source (a name, `ident`; a slot's member, `$slot.n`). The test is
on the source after the name, `src[end] === '.'`, so `n.toFixed()` is `(1).toFixed()` and every other read of `1`
is as before. A uniform rule (every literal in parentheses) was not needed, and would have changed every page with
a number prop.

**What changes.** Only page modules that did not parse before (a build failure): such a page now builds. All other
code is byte-identical (benchmark apps, examples, sinter-mail).

## 3. A broken expression on any page silenced every type error on every page

**Reproduction** (`test/check/check-shared.test.ts`, "a broken expression on one page"; the corpus's app b). One page
with `<p data-sn-text="1 +">` (SN401): `sinter check` printed the SN401 and nothing else, for 12 pages that have 49
type errors between them; `checkPage` and the build's check the same (the build stops at the compile error before
its check runs, as for any compile error, and is unchanged).

**Cause.** Not the shadow file, and not a bail-out: `tsc` itself. The compiler records a broken expression in the
check unit (`broken: true`) so that an editor can complete inside it; `shadow()` writes it last, and
`brokenFrom` drops whatever TypeScript says from there on. But `tsc` (its `emitFilesAndReportErrors`) asks for
semantic diagnostics only when the whole program has no syntactic one: one syntax error in one shadow, and no file
of the program gets a type error. A broken expression that is not a syntax error (an unknown name, SN201) was
harmless; SN401 was not.

**Fix.** `check()` (the build's, `sinter check`'s and `checkPage`'s `tsc` program, shared or each page whole)
writes the shadows without their broken expressions (`ShadowOptions.broken: false`). Nothing refers to one (a let,
state or loop over a broken expression has no init: `lastExpr` is null), and nothing was reported from them
(`brokenFrom`), so the rest of that page is checked as it would be without it. `sinter lsp` keeps them: the
language service reports a file's semantic errors whatever its syntax, and completion needs them.

**What changes.** `sinter check` (and `checkPage`) on an app with a broken expression: the compiler's error, plus
every type error of every page, that page's other expressions included. Corpus app b: `sinter check` now prints
app a's 49 errors and SN538 warning, plus the 3 errors of `<x-bad>` on the broken page, after its SN401: `53
error(s), 1 warning(s)` instead of `1 error(s), 0 warning(s)`. Its build, and apps a, c, d, are unchanged; the
build output of every app is unchanged (the check writes no output).

## 4. A component used inside itself reported its type errors twice on a page

**Reproduction** (`test/check/check-shared.test.ts`, "a component used inside itself…" and "a fill of a tree slot…").
`<x-tree data-sn-with="{ node: root }">` with `node.lable` in `x-tree`: two SN208 on the page, `(included from
b.html:7)` and `(included from b.html:1)`; two uses on one page, three. A page's fill of a tree slot placed by a
component used inside itself (`<ui-tree>`'s `<ui-node>` in the corpus): the fill's error twice, with the same text.

**What "once" means.** A component used without recursion reports an error once per use, with that use's include
chain (two uses on one line: twice, both `a.html:6`); a loop around the use does not multiply it. A component used
inside itself is inlined at its outermost use and compiled once more as the shared definition its deeper uses render
(contract.md, worked example 3), and a tree slot's fill once more as the case of the placement in that definition
(`finishTreeFills`). Those second copies are not uses: they are what the uses already reported render further down.

**Cause.** The check unit records every copy the compiler walks; the definition's copy has the page's first line as
its chain (its host has no place in the page), and the fill's case the fill's own place. Nothing told the check
which copy was which.

**Fix.** The compiler marks the expressions it records while walking a shared definition (`compileDefinitionIn`)
or a fill's case of a placement in one (`finishTreeFills`): `CheckExpr.def` (a counter, `defWalk`, classified
`restored` in `LINK_FIELDS` like `inDef`; a linked definition replays its expressions with the mark). `parseTsc`
drops an error of a marked expression when an unmarked copy on the same page reports the same error (severity,
code, file, line, column, message without its chain). A definition's error that no inlined copy has (a component
reached only through its definition, such as a run-time choice's case) is still reported, with its chain as before.

**What changes.** `sinter check` and the build's check print each such error once per use. Corpus apps a and d:
46 errors (and the SN538 warning) instead of 49, i.e. `x-tree`'s second report on `deep.html`, `tree.html`,
`tree2.html` and the fill's on `tree.html`; app b likewise (49 instead of 53); the build's line says `46 type
error(s)` instead of 50 (see §5 for the warning in it). No build output changes. `sinter lsp` is unchanged (its
diagnostics of one position are shown once).
