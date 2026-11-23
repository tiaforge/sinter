# Redesign notes: what the first pass decides, and whether one top-down pass can

Read-only study of `src/compiler/compile.ts` (and `expr.ts` for writes) as of 2026-11-23, for the "compile each
component once into a unit, then build the page in one top-down pass with online partial evaluation" redesign.
Line numbers are `compile.ts` unless another file is named. **Verified** marks behaviour checked by compiling small
pages against the built `dist/` (scripts in the session scratchpad, not committed); **inference** marks what I read
but did not run. Sibling notes: [pipeline.md](pipeline.md) (phases, numbering), [contract.md](contract.md) (output
contract, oracle).

## 0. The shape of the two passes

`compilePasses` (1048–1072):

```ts
const first = new Compiler(options);  const out = first.run(html);
if (!options.prerender || options.decided || options.unrolled) return withLate(out);
const clean = !out.diagnostics.some((d) => d.severity === 'error' && d.code !== 'SN322');
const unrolled  = first.unrolls.size && clean ? first.unrolls : null;
const constants = first.constants.size && clean ? first.constants : null;
if (!first.decided.size && !unrolled && !constants) return withLate(out);
const frozen = first.foldedState(); if (constants) for (const s of first.constantSites) frozen.add(s);
const second = new Compiler({ ...options, decided: first.decided, unrolled, constants, overLimit: first.overLimit, frozen }).run(html);
```

What crosses from pass 1 to pass 2 is exactly five maps: `decided: Map<key, boolean>` (ifs *and* choice
candidates), `unrolled: Map<key, unknown[]>` (loops *and* recursion points, with the list), `constants:
Map<constKey, ConstantWrite[]>` (values written into markup before the layout and the images), `overLimit: Map<key,
limit>` (to repeat SN536), and `frozen: Set<"file:offset#field">` (only feeds `CompiledParts.fixedState`, a testing
aid, `src/testing/index.ts:852`; it does not change HTML). `fromTemplate` (1008–1046) hands over the same five after
`decideFor` (1989–2000) re-ran only `prerender(true)` on a kept walk with the entry's value swapped in.

Pass 1 = `walkPage` (1587) + `finishPage` (1747), whose `prerender()` (7740) does two different jobs:
1. **first paint**: write each evaluable binding's value into the HTML (`writeFirstPaint`, 11102), then
   `dropConstants` (9080) removes bindings that can never change;
2. **decisions** (only when `collecting()`, 8128: prerender on, no decisions given): `decided`, `unrolls`,
   `rowPaint`, then `collectConstants` (8387).

Pass 2 is the same `Compiler` with the maps. It differs in four places only: `expandConstants` after component
expansion (1600), `prefold` before the layout (1616), `prerender` skips `decide`/`unroll`/worklist (7764, 7772,
7780, 7927), and the definition link key's pass number (4783). Note that pass 2 **expands components exactly as pass 1
does first** (`expandComponents` 1594, choices and recursion points still markers) and only then patches the expanded
tree top-down. It is not "deciding while expanding" either.

## 1. The decisions, rule by rule

### 1.1 Shared machinery in `prerender()`

- `written = this.writtenState()` (7744; definition 9343), the page-wide set of `$s<sid>` / `$s<sid>.<field>`
  something can write (section 3).
- `fixed(ds)` (7745): every dep is a `file:`/`content:` resource or its `$meta` (`fileConstant`, 8095), or
  `$locale` when helpers may fold, or `$s<sid>.<field>` (not `*`/`**`) with neither `$s<sid>` nor the field in
  `written`. **A dep on a prop of a shared definition does not exist**: definition props are lets with code
  `$.$p<tid>.<name>` and `deps: []` (3990–3993), so they count as fixed, and their values come from the row item.
- `known(deps)` (7838): like `fixed`, but for state it asks whether the state's *initial value was computed*
  (`states.has(sid)`) and the field is not persisted. Written state can still be `known`: its initial value is used.
- State initial values (7869–7881): each `stateInits` field is evaluated on its own if `known(deps)`, kept if
  `plainData`, the object `deepFreeze`d behind a proxy that throws `NOT` for a missing or persisted field.
- The evaluator: **not** an IR interpreter and **not** the runtime. The page's own compiled function strings (the
  `fns` table entries it needs: candidates, state inits, every row binding, choice picks, case props, placement
  functions, 7819–7826) are compiled once with `new Function(...params, "return [ ... ]")` (7830) and called with a
  proxy `$` (7849–7867) that serves `$s<n>` (frozen initial state), `$r`/`$meta` (`fileConstants`, 8101: the
  `file:` values deep-frozen), `$build` (true; undefined "as the browser"), `$w`, `$z`; anything else throws
  `NOT`. Globals `Date`, `Intl`, `Math`, `location` and the built-in formatters are stubs that throw (7787), except
  `number`/`bytes`/`date` in a page with one locale (7794–7801, the runtime's own `runtime/helpers.js`). App
  helpers fold through `helperCalls` (7942): only with a `helperFold` verdict, plain-data args, run twice and
  compared, memoized per file (`FOLD_MEMO`), logged for the build's re-check (`foldLog`). Shared with the runtime:
  `$k`, `$href`/`$hq`/`$hv`, `schemesOf`/`urlAllowed`/`STYLE_BAD` (security.ts), the formatters, `config`. The
  control structure (if/for/choice/placement) is walked by the worklist's own small interpreter over `NodeDef` /
  `TemplateDef` (`nodesOf`, 8205), not by `src/runtime/app.ts`.
- Build-time-known data, therefore: `file:`/`content:` resources (incl. the `data-sn-for` page entry, which is a
  `fileData` entry, 1991), literals, constant props, state initial values that read only those, `$locale`'s base
  text with `helperFold`, content-namespace entries in the page's language (7804–7817), folded app-helper results.
  Never: other resources, `$url`, `$now`, `$el`, the clock, persisted state, lazy helper modules.

### 1.2 `decided` for a `data-sn-if` outside any unrolled row (`decide`, 7762; evaluated 7895–7903)

Candidate if: not pass 2 (`this.opts.decided`); kind `if`; has a function; `fixed(b.d)` **or** the code contains
`$.$build`; `instKey(el)` non-null (an element with a source location); and, for top-level elements, not inside a
kept (`data-sn-permanent`, swaps on) element (7778). Candidates come from `this.paints` (bound elements outside
templates, 5432) and `this.tplEls` (bound elements inside any template content: branches, loop rows that stay,
shared definitions, 5435). Evaluated with `known(deps)`; if FAIL and the code has `$build`, evaluated again
"as the browser" (`asBrowser`: `$build` undefined, any read of a written field throws, 7855, 7890).

Stored at `instKey(el)` **with no instance prefix**. Agreement: a FAIL marks `undecided`; two candidates with one key
that disagree mark `undecided` (7898–7901). Also records `foldReads[key] = stateSites(b.d)`.

### 1.3 The worklist (`worklist`, 8144–8348): unrolls, decisions inside rows, choices

**Unroll candidate** (`unroll`, 7771): `collecting()`, kind `for`, has a function, no `$el` (`b.e`), `fixed(b.d)`,
`instKey` non-null, its template exists; top-level only (from `paints`), not in a kept element. Evaluated, then
`work.unroll(key, …)` (8268): the list must be an array of plain data (`listOf`), the template must have an item,
and **every row must be static markup** (`rowsOf` → `nodesOf`). Nested decisions are collected into a `Found` and
committed only if the whole loop is accepted.

**`nodesOf(nodes, rowScope, prefix)`** (8205), the definition of "static", per node of the template, fails on:
- `n.state !== undefined || n.sid !== undefined`: any `data-sn-state` on a node in the row (8207);
- no element known for the node (`elOf`, 8171);
- a choice point (`<sn-component use>`, `point.group`): `caseOf` (8176) needs `pick.deps` fixed and known, every
  candidate's `choiceKey` non-null, and the pick evaluable. Candidates not picked → `decided[prefix+ck] = false`;
  the picked one → `expandCase` (8189): its props `($) => (props)` evaluated to plain data (**their deps are not
  checked for `fixed`**, see 3.6), `decided[prefix+ck] = true`, and the case's definition template is walked as
  one row whose item is the props (`rowsOf(t, [props], prefix+ck)`);
- a tree placement in a definition (`placementOf`, 8222): its function yields `[caseIndex, data]`; the case
  template must exist, data plain, and the chosen fill must not "stay" (`fillStays`, 3776: a forwarded fill, or a
  fill holding a component with data slots); then its nodes are walked with `$slot` data as item;
- per binding: `handlerOnly(b)` (8154) is skipped (kept as a live handler, "item 6"): kind `on`, no writes,
  code not matching `/\$\.\$(r|meta|url|now|locale|slot|error)\b|\$\.\$p\d/` and every `$.$s<n>.<f>` it reads
  unwritten;
  ROW kinds (`text attr class style show`, 7770): fail on `b.e`, `b.w?.length`, `!fixed(b.d)`; if `paintable`
  and known, evaluate and record `rowPaint` (a FAIL value is recorded as `null`, the row still counts as static and
  the binding stays live in pass 2);
  `else` skipped; `if`/`for`: fail on `b.e`, no function, `!fixed`, `!known`, null key, FAIL value. `if` records
  `decided[prefix+key]` and walks the kept branch; `for` records `unrolls[prefix+key]` and recurses into rows.
  **Every other binding kind fails the row**: `model`, `on` that is not handlerOnly, `cmp` (component script),
  `ref`, actions, etc.
- `rowsOf` (8196) fails when `out.rows += items.length` exceeds `left` (the page budget, `expansionLimit`, default
  `EXPANSION_LIMIT = 10_000`, 11048) and sets `out.over`.

**Choices outside rows** (`choose`, 8276; reached from `finish` over `this.roots`, and `pageOf` (8298) over
branches already decided true/false): per candidate `ck = choiceKey(el, name)`; if the pick is unknown, or this is
the picked case, or `ck` was already chosen by another instance (`chosen`), the candidate stays (`decided.delete`),
and the picked one is put in `pending` via `expandCase`; otherwise `decided[ck] = false`. So "dropped" needs every
instance with that key to agree that it is not rendered; "expanded" needs its case to be static.

**Commit** (`finish`, 8317–8346): for each `pending` entry *in insertion order*: null (failed, or a second
instance with the same key, 8273/8289) is skipped; over budget (`found.over` or `found.rows > left`) →
`overLimit[key] = limit` and SN536 at the element (an error on `data-sn-for` pages, 8124); else `left -=
found.rows`, then `decided[key] = true` (choice) or `unrolls[key] = items`, plus all nested `found.unrolls`,
`found.decided` (overwriting without the agreement check of 1.2), and `rowPaint`.

Insertion order = top-level loop candidates in `paints` order (prerender's loop, 7884), then choices at the roots
and loops/choices inside top-level decided branches in `roots` order (`finish` → `pageOf`). Not document order:
budget allocation is order-dependent.

### 1.4 `constants` (`collectConstants`, 8387; `constantSources`, 8363)

Only attributes whose element is read by the images pipeline or the layout: every value attribute of an `<img>`
(with `images`), `data-sn-style` anywhere and `data-sn-class` whose class name some stylesheet selector names (with a
layout). Per `attrSources` entry (recorded in pass 1 only, 5476–5481; `noted` = it got a diagnostic other than
SN513): inside unrolled rows, from `rowPaint` per prefix (`prefix + constKey`); outside, only if every binding was
`dropped` by `dropConstants` and painted. Two uses with one key and different writes → null → removed. Then the
layout-only ones (`layoutKeys`) are kept only if a second pass happens anyway (other constants, any decision, clean
unrolls) or the **dry run** (`dryRun`, 8528: prefold a snapshot copy, recompute layout answers and space plan) finds
a difference; otherwise dropped. Why it matters for bytes: `prefold` removes the attribute before the walk, so the
element may get no `data-sn` id, which shifts the numbering of every later node. `decideFor` instead sets
`needsMarkup` and the entry is compiled the usual way (1998).

### 1.5 Keys (`siteKey` 8792, `instKey` 8597, `choiceKey` 8603, `constKey` 8545)

- `siteKey(el)` = `${origin.file}:${startOffset}`; null for an element the compiler made (no
  `sourceCodeLocation`), which can never be decided.
- `Origin.use` is set when a component's markup is tagged (`expandUse`, 3003): `use: `${siteKey(host)}<${hostOrigin.use}``,
  the chain of tag sites from inner to outer. A shared definition's host is synthetic (no location), so markup
  compiled in a definition has `use` starting `<`; `inlineInstance` sets `o.use = '<'` (8736) so pass 2's inlined
  copy keys as the definition did.
- `instKey = siteKey|use`; `choiceKey = instKey|use:<name>` (all candidates of one `<sn-component>` are clones of one
  tag, 2862–2873, sharing the location); `constKey = instKey|<attrName>`.
- Inside rows/instances the worklist prefixes `<instKey of loop or case>#<k>/` per level (8200, 8233, `${key}#0/`
  for a case); pass 2 reproduces the prefix from `rowOf` (`inst: ${pre}${tkey}#${k}/`, 8691) and `instAt`
  (`${pre}${ck ?? pk}#0/`, 8668), read with `instOf` (4110).

Why long: a key must name one *instance* identically in two different programs: pass 1, where a definition exists
once and a loop's row once, and pass 2, where instances are cloned (`cloneTree`) and rows copied. The only stable
coordinates are source offsets (unchanged by cloning), the use chain (to tell two uses of one component apart), and
the row index path. Depth `d` of nested rows/instances gives a key of `d` full `instKey`s. A one-pass compiler
needs none of this: it decides where it stands. It only needs the *agreement* semantics the keys encode (1.6).

### 1.6 Things decided "by key across instances"

- 1.2: one key evaluated twice with different results → undecided (both stay live).
- `pending.has(key)` → null (8273, 8289): two loop/case instances with one key → neither unrolled.
- `chosen` (8281): a candidate rendered by one instance is not dropped for another with the same key.
- `collectConstants.put` (8390): differing writes → no constant.

Where one key really has several instances in pass 1: cloned markup that keeps origin and offset, i.e. choice
candidates (hence `|use:`), fills placed more than once (`repeatedFills`, 3486), fills cloned into a tree
placement's case templates (`finishTreeFills`, 4447), and inferred: the same component markup reached through two
fills in one instance. Outside those, `use` chains make keys unique.

## 2. Where each fact comes from

"Per component" = derivable from the component file once. "Per use" = needs the use site's prop expressions
(which caller paths, which constants and their values). "Per page" = needs the whole expanded page. "Dynamic" =
depends on evaluation, its order, or other instances.

| Fact used by a rule | Where in code | Source |
| --- | --- | --- |
| binding kind (ROW / if / for / on / model / cmp / ref / action) | `nodesOf` 8236–8263 | per component (attribute as written) |
| `$el` in the binding (`b.e`) | 7772, 8239, 8248 | per component |
| binding has writes (`b.w.length > 0`) | 8239, `handlerOnly` 8155 | per component (syntactic; aliasing only grows it) |
| `data-sn-state` on a node in the row (`n.state`, `n.sid`) | 8207 | per component |
| component has a script (`cmp` binding) | 5371–5386 | per component |
| handler code reads `$r/$meta/$url/$now/$locale/$slot/$error/$p<n>` | 8157 | per component, *as compiled as a definition* (a prop read is `$.$p<n>` there, a literal when inlined) |
| element has a source location (key non-null) | `instKey` | per component (compiler-made elements: never) |
| text binding over element children; `paintable` | 11058 | per component |
| fill stays (forwarded fill, fill with a data-slot component) | `fillStays` 3776 | per component + fill (per use) |
| deps of a binding resolve to caller paths (props inlined as code) | `propLets` 4164, `emitName` let (expr.ts 717) | per use |
| `fixed(deps)`: deps are file/`$locale`/state nobody writes | 7745 | per use × **per page** (`written`) |
| `known(deps)`: state's initial value computed, not persisted | 7838 | per page (state init evaluation, persisted set) |
| `handlerOnly`: state it reads is unwritten | 8158 | per page |
| values: list items, props, picks, conditions | `run` | dynamic (evaluation over constants) |
| pick deps fixed; case props plain data | `caseOf` 8178, `expandCase` 8192 | per use × per page / dynamic |
| `$build` "as the browser" | 7855, 7890 | per page (`written`) |
| kept element (`data-sn-permanent` with swaps) | `inKept` 1382 | per page option + ancestor attribute (position) |
| budget left (`expansionLimit`) | 8161, 8334 | per page, dynamic (commit order, 1.3) |
| instances sharing a key agree | 1.6 | dynamic, per page |
| pass 1 is clean (no error but SN322 anywhere) | 1058 | **per page, after the whole walk** |
| layout reads the attribute (img with images; a class a selector names; any style) | `constantSources` 8379–8381 | per page (stylesheets) + per component (tag) |
| a second pass happens anyway / dry run differs | 8414–8417 | per page, after everything |
| `helperFold` verdict, helpers module loads, lazy packages | `helperCalls` 7993 | per build |
| locale, content namespaces | 7794, 7804 | per page option |
| entry value (`data-sn-for` pages) | `decideFor` 1991 | per entry (only evaluation reads it) |
| page reads its own URL (template shareable) | `entryProgram` 1974 | per page, from the walk |

## 3. Writes

### 3.1 What `writtenState` counts (9343–9362)

`$s<sid>` (whole state) for any write path ending in `*`/`**`, else `$s<sid>.<field>`, from: every binding's `w` in
roots and templates (handlers `on` 5569, models `model` 6443 and the component model's `change` handler 5601,
component scripts `cmp` 5385, the `on` bindings a definition's root takes from its uses' tags 4710); actions' `w`
(their `then`/`catch`, 7153); resources' `w` (their `then`, 7727); sync events' `w`; a persisted state
(`data-sn-persist`, whole sid); a state with an `$error` field (the one a form's action adds, 5310–5316); and
`persisted` paths (a model with persist, 6448). It is computed over the **program as walked**, i.e. after
`applyAliases` (1642) widened every `w` list.

### 3.2 Where a `w` path comes from (expr.ts)

`writePath` (expr.ts 1283): assignment, `++`, `delete` to a state path, a loop item or a callback local with an
alias path (`item.done = …` in a row over `$s1.list` → `$s1.list.{$i3}.done` or `~`), `$url.<p>`, `$locale`.
Mutating method calls on such paths (`.push` → `….#`, unknown methods → the path, 1349–1368), `Object.assign`
and friends (1373–1391), and an app-helper call in a handler marks each state argument as changed (1412–1418).
**Props, lets and `$slot` cannot be written**: a prop is a `data-sn-let` (`propLets` 4198), so `prop = …` and
`prop.x = …` are SN203 (expr.ts 1300); `$slot` too (1296). A loop over a prop list has `alias: null`, so its item
cannot be written either (falls to SN203 at 1324).

So a component writes, *directly*, only: its own `data-sn-state` fields, `$url`, `$locale`. Everything that writes
a caller's state is compiled **in the caller's scope at the caller's site**:
- handlers on the component's tag, including handlers of declared events (`data-sn-on-select="sel = $event.detail"`):
  compiled on the component's root in the caller's scope (`bindings(use.host, …, use.caller)`, 5367). The write
  exists whether or not the component ever emits; emitting is invisible to the analysis.
- `data-sn-model` on a component tag: a `change` handler in the caller's scope (5581–5601).
- slot content and fills: the caller's markup, compiled in the caller's scope (5116–5141).
- tag attributes of shared-definition uses: `pointAttrs` (4663) compiles handlers in the caller's scope into the
  item's `$a`, and copies their `w` onto the definition root's `on` binding (4710–4711).

### 3.3 Indirect writes: aliases (`applyAliases`, 9271–9341)

A state field initialised with (or assigned) an object is an alias of where the object came from (`stateOf`
4152–4156; handler assignments, `push`, `Object.assign`, expr.ts 1356–1387, 1746–1749). A write is extended,
breadth first, through every alias in both directions (`extend`, 9297); an untraceable source (`s: null`) means
"any object of the page": a write under it adds `ALL` (every `$s<sid>.**` and `$r.<name>.**`), and any deep write
(`O.length >= 2`) adds `[...t, '**']`. Over 400 paths, `ALL` (9301).

Crucially, **a prop is an untraceable source**: `classify` of an identifier that resolves to a let returns `ANY`
(expr.ts 852). So `data-sn-state="{ draft: item }"` with `item` a prop object, plus any handler that writes
`draft.title`, marks every state field and resource on the page written. A component with a script adds
`{ t: [$s<sid>, '*'], s: null }` and `$s<sid>.*` as object-holding (9273–9276): its `cmp` binding writes every key
of its root state, so a scripted component with a stateful root also reaches `ALL` (inference from the code; worth a
fixture).

### 3.4 Could a per-component write summary replace the page walk?

Mostly yes, for the *set* `written`, because writes are local by construction:

- Summary per component file: (a) for each own `data-sn-state` site, the fields its markup writes (from handlers,
  models, actions, scripts, `$error`, persist); (b) its alias pieces, in local terms: own state paths, resource
  names, `$url`, and `ANY` (any prop/let/helper/`$event.detail` source); (c) writes to `$url`/`$locale`; (d) its
  slot contents and fills contribute nothing of its own (they are caller markup).
- Composition: instantiate per *instance identity* (inline use: a fresh state per use; shared definition: one state
  for all its instances, 4134 runs once per compiled definition), add the caller-side writes (tag handlers, models,
  fills), then run the page-level alias closure on the instantiated list.

What would be unsound or non-identical:
1. **The alias closure is page-global and capped** (400 → ALL). It must run on the page's whole alias list exactly as
   today. Cheap on a list; impossible per component.
2. **Which components are on the page in pass 1 is wider than what renders**: every candidate of every
   `<sn-component use>` (a helper-form `use` makes every app component a candidate, 2835–2841), every definition and
   what it reaches, every fill placed into a definition (`finishTreeFills`' fixpoint over `reach`, 4433–4492), every
   branch, decided or not. Pass 1's `written` (call it W1) is over that whole expansion. The summary composition must
   enumerate exactly that set (`fileGraph`/`reach`, 4545–4595, already compute the candidate graph from files alone).
3. **W1 is not the final write set.** Pass 2 recomputes `writtenState()` on its own program, where dead branches and
   dropped candidates are gone (W2 ⊆ W1). Decisions use W1; pass 2's first paint, `dropConstants` and `fixedDeps` use
   W2. **Verified**: state `{ n: 1, open: false }`, `<template data-sn-if="open"><button data-sn-on-click="n++">`,
   then `<span data-sn-text="n">`: the page is static, `<span>1</span>` (W2 lacks `n`). Replace the span with
   `<template data-sn-if="n > 0">`: the if is **not** decided (W1 has `n`), the page ships a runtime anchor. A
   single pass that decides with the refined set would be "better" and byte-different. To match today: decide
   with W1, paint/drop with W2.
4. Write identity is by sid, and sids are numbered in walk order (4134). The summary needs a stable instance
   identity (site + use chain, as `instKey` but for state) mapped to final sids after the walk.
5. Things the summary cannot see from markup: `persisted` from storage, the runtime's own `$error` (both are
   structural, so fine), and component scripts writing *arbitrary* state (already modelled as `ALL` via the alias
   rule; keep that).

## 4. What `prerender()` produces

Both first-paint writes and decisions. In pass 1, first paint is written into pass 1's own markup and then thrown away
when pass 2 runs (2.3 ms of 25, compile-once.md (4)); `prerender(true)` (`decideFor`) writes nothing and only
records `paintValue`. Outputs: `painted`, `paintValue`, `tplPainted`, `textFolded` (text nodes written as plain
text, 7915–7926), `foldedFields` (state fields a helper computed; embedded as JSON by `embedFolded`, 8045), and with
`collecting()`: `decided`, `undecided`, `unrolls`, `foldReads`, `rowPaint`, `overLimit`, `foldWhy` (SN322
reasons). Pass 2 runs the same `prerender()` without decisions: its own first paint over its own program.

## 5. What pass 2 does with a decision

- **if** (8646–8654): `decided.get(pre + instKey)`; true → the template's content replaces it (`place`), false → the
  `data-sn-else` content or nothing; the condition text goes to `foldedText` so SN501 does not fire for resources it
  read (1667).
- **choice candidate** (8655–8681): `decided === false` → removed; `true` → `inlineInstance` (8713): the clone becomes
  a real tag of the component, plain attributes of outer tags passed on, `points`/`choices` entries deleted, then
  `expandUse` + `expandComponents` as an ordinary inline use (its props now from the real `data-sn-with`, not
  `$p<tid>`), keyed `o.use = '<'`, its nodes marked `instAt = pre+ck#0/`. Nested choices and loops are revisited by
  the same loop (`i--`), with the new prefix.
- **recursion point** (8663–8665): `unrolled.has(pre + instKey)` → `inlineInstance` likewise (a recursion point's
  binding is a `for` over `[props]`, `recursionPoint` 4291–4294, so pass 1 records it as an unroll).
- **loop** (8683–8701; only outside templates): `cloneTree` (8762) of the template content per item, each top element
  with `rowOf = { item, index, value, inst }`. `cloneTree` copies the node and every side table entry that compiles it
  (origins, slots, uses, points, choices, scope starts, landing, passOn, pointCtx, defRoots, fill chains).
- During the walk, a row's item and index become lets with literal code: `code: (${jsLiteral(value)})`, `deps: []`
  (`rowLets`, 5083–5100; `jsLiteral` 11016). The list expression is compiled once per loop for diagnostics. So
  constant values enter the program as **code literals**, then pass 2's own prerender evaluates and writes them into
  the markup like any constant and drops the bindings. `deepFreeze` (11034) is only for the evaluator's values.
- Earlier, in both passes and in one pass already: `foldConstants`/`foldIn` (5610–5651, called from
  `componentScope` 3994 and from `expandUse` 3100 for non-plain roots) decide a `data-sn-if="<prop>"` whose prop is a
  literal (`CONST_PROP`, 883), at expansion time. This is the only online partial evaluation today, and it is
  syntactic.
- `prefold` (8556) writes `constants` before the layout and images and removes the attribute (from the component tag
  too when every root it reaches has it).
- What stays live inside an otherwise constant instance: `handlerOnly` handlers (the page module adopts them); ROW
  bindings whose value cannot be written ahead (`firstPaintValue` FAIL: objects, refused URLs/styles, select values);
  and, inside an inlined choice case, bindings over props whose caller state is written (3.6). State never: a row
  with state is never unrolled.

## 6. Shared definitions versus inlined instances

- A component is compiled as a runtime shared definition when (a) it is reached inside itself across a
  `data-sn-for`/`data-sn-if` template (`#` in the chain, 2737–2747: `points`), or (b) it is a candidate of
  `<sn-component use>` (2870: every candidate is a point). Both go through `recursionPoint` (4231) → `definition`
  (4772, possibly linked) → `compileDefinition` (4830): one head template per component per page, compiled once with an
  empty scope, props `$.$p<tid>.<name>`, `inDef > 0`. A `<slot>` that is a tree placement inside it becomes
  `runtimePlacement` (3551, 4386) and each fill that reaches it a case template (`finishTreeFills`).
- Everything else is inlined at its use (`expandUse`, 2995) with a fresh copy of the parsed file.
- Decisions: pass 1 always compiles the definitions (that is 13 of the walk's 16 ms on the blog), and the worklist
  evaluates a definition per instance by walking its template with the props as row item. Pass 2 inlines exactly the
  instances decided `true`/unrolled (`inlineInstance`); a definition is compiled in pass 2 only if some instance
  remains a point, and templates nothing reaches are dropped by `compactTables` (1901). A constant tree therefore
  ships no definition, and the rest of the page keeps one definition shared by its live instances.

## 7. Verdict

**Can one top-down pass with per-component summaries make the same decisions, byte for byte?** Not as a pure
single pass. It can with (i) a pre-scan that computes the page-wide write set W1 and a few other page facts, (ii) a
post-pass that does what `finishPage` already does, and (iii) a fallback recompile for pages with errors. The
online part is sound for evaluation and scoping; the hard rules are the ones whose inputs are page-global or
"after the fact".

### 7.1 Rules that make it hard, and what each needs

1. **`written` (W1) for `fixed`, `handlerOnly`, `$build`-as-browser.** Needs the pre-scan of 3.4 over pass 1's wide
   expansion (all candidates, definitions, fills, branches), plus the page alias closure with its 400 cap.
   Summary per component: own-state writes, alias pieces in local terms with `ANY`, script flag.
2. **Decide with W1, paint with W2** (3.4 item 3, verified). The single pass must not use what it has just decided to
   shrink the write set for decisions; the post-walk prerender recomputes `writtenState()` on the result, as today.
3. **Row staticness is defined on the definition's compiled form.** `handlerOnly` rejects `$.$p<n>` (a prop read),
   and definition props have `deps: []`. An inlining PE compiles props as literals or caller paths and would judge
   differently. Needs a per-component summary computed in definition context: per node, "fails the row" reasons
   (state, non-ROW binding, `$el`, writes, handler reads of `$r/$url/…/$p`) and the state fields its handlers read.
4. **Clean pass 1 gates unrolls and constants** (1058, 1064), and pass 1's errors include errors in code that pass 2
   never compiles. **Verified**: an SN201 inside `<template data-sn-if="false">` is not reported at all, and it stops
   an unrelated constant loop from unrolling (the page ships JS). An online pass cannot know that a later or dead
   part of the page has an error. Workable only as: decide optimistically, compile dead branches for diagnostics
   anyway (or keep a cheap error-only check of them), and on any error recompile the old way. (Today's behaviour of
   dropping the dead-branch error looks like a bug in its own right.)
5. **Agreement across instances with one key** (1.6). Several instances of one source element (repeated fills,
   case-template copies) must all evaluate the same before any is decided. An online pass meets the first instance
   before the others. Needs a structural pre-scan for "elements with more than one instance in pass 1's program",
   and for those: evaluate all instances at the first (they are siblings inside one instance's expansion, known from
   the component's slots), or defer and back-patch. This is genuinely non-local but bounded to one component
   instance.
6. **The expansion budget** is allocated in `pending` commit order (1.3: top-level loops first, then choices and
   decided branches in root order), and a tree's `rows` are counted before it is committed. Document order differs.
   Byte-identical only by reproducing the order, which needs every top-level candidate's row count first: a
   two-phase "measure, then commit" over the top level. Only matters for pages over 10,000 rows (SN536).
7. **Layout constants** (1.4): whether a layout-only class/style constant is prefolded depends on whether *any* other
   second-pass reason exists on the page and else on a dry run of the layout; prefolding changes `data-sn` numbering.
   Needs all decisions to be made before the layout runs (they are in a design where expansion completes before
   `new Layout`), then the same rule. Not circular, but it fixes the phase order: expand+decide all, then layout,
   then walk.
8. **`fromTemplate`'s guards** (`entryProgram`, `sameProgram`, `needsMarkup`) are about the two-pass split and go
   away, but their facts (the page reads its own URL) must still be known if entries share work.

### 7.2 Genuinely circular, or only after the fact

- **Not circular**: W1 (syntactic over the wide expansion), state initial values (`declare` already pre-scans
  resources; state inits read only what is declared), choices, loop values. Writes do not depend on decisions
  because decisions are made against the over-approximation W1 by design.
- **After the fact (needs a later phase, not a fixpoint)**: errors anywhere (4), key agreement (5), budget order
  (6), the dry run (7), W2 for paints (2). Each is answered after the whole page is expanded, and none feeds back
  into W1, so a fixed number of phases suffices; but "one pass" is not achievable for any of them without changing
  output.
- Today's result is itself a truncated fixpoint (decisions with W1, paints with W2, no second round of decisions).
  A redesign that iterates to a true fixpoint will produce smaller pages than today's and fail byte-identity.

### 7.3 Soundness gap found on the way (verified)

`expandCase` (8191) evaluates a choice case's props without checking their deps are `fixed`; `caseOf` checks only
the `use` expression's deps. Inside the definition the props have `deps: []`, so the case's ROW bindings pass
`fixed` and their values (from *initial* state) land in `rowPaint`. Pass 2 inlines the case with its real props, so
plain bindings stay live and the HTML is right; but with `images` on, an `<img data-sn-attr="{ src }">` reached
through `<sn-component use="{ a: 'x-img' }['a']" data-sn-with="{ src: s }">` with `s` written by a button is
**prefolded as a static `<picture>`**, while the same component used directly keeps its binding. A redesign that
checks `fixed` on the props' caller deps would fix this and differ from today on such pages. The oracle should
exclude it, or the bug should be fixed first.

### 7.4 The minimal pre-scan before the single pass

Per page, from component units plus the page's own markup, without compiling value bindings:
1. Declarations: resources (`file:`/`content:` values, the entry), dialogs (exists: `declare`, 1633).
2. The wide instance graph of pass 1: inline uses, definitions (recursion points across `#`, every choice candidate
   via `fileGraph`/`reach`), fills reaching tree placements (fixpoint), every branch. With per-instance state
   identities and the caller-scope handlers/models/fills at each use.
3. W1: per state identity, fields written (summaries + caller-side writes + actions/resources/syncs/persist/`$error`),
   after the page alias closure with the 400 cap, `ANY` for props and helpers, scripts as `ALL`.
4. Elements with more than one instance under one key (repeated fills, case copies, choice clones).
5. Persisted state paths and kept (`data-sn-permanent` under swaps) subtrees.

Then: one top-down expansion that evaluates ifs, choices, recursion points and loops as `nodesOf` does (row
staticness from the units' definition-context facts, `fixed` against W1), keeping a list of top-level candidates
for the budget commit; then the budget commit, the layout-constants rule, layout, the walk of the decided page, and
today's `finishPage` (first paint, `dropConstants`, `fixedDeps` with W2). On any error, recompile as today. The
saving is pass 1's walk, chiefly the definitions it compiles for instances that end up inlined, which matches the
ceiling in compile-once.md (4). The risk is the same as there: every per-node fact in the units must agree with
what the walk would compile, so the units need a differential test against `worklist()` on every fixture before
they replace it.
