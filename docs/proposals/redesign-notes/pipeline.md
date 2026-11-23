# The compiler's front half as it is: a map for the plan/emit/assemble redesign

Read-only research notes, 2026-11-23. Every `file:line` is `src/compiler/compile.ts` unless another file is named.
"Inference" marks what I concluded without a test or a trace. Background: `docs/proposals/compile-once.md` (4) and (5).

The hypothesis under test: compile each component file once per build into an immutable plan with local numbering,
cached per (component, binding-time signature); a use is `emit(plan, env)`; one linear assemble pass hands out
page-global numbers. Section 6 is the verdict.

---

## 1. Phases of one `run()`, in order

`compileParts` (944) → `compilePasses` (1048) → `fromTemplate` (1008, `<html data-sn-for>` only) or
`new Compiler(opts).run(html)` twice. `run` (1577) is `finishPage(walkPage(html))`. Pass 2 is a fresh `Compiler` given
pass 1's `decided`, `unrolled`, `constants`, `overLimit`, `frozen` (1066–1068). Nothing but those maps crosses passes.

The carrier between every phase is **the mutated parse5 DOM** plus **~150 fields of the `Compiler`** (1130–1575). There
is no IR between expansion and the walk: expansion's output *is* the DOM with WeakMap side tables keyed by its nodes.

### walkPage (1587–1681)

| # | step | reads | writes |
|---|---|---|---|
| 1 | `parseDocument(html)`, `tag(doc, origin)` (2007) | page text | `origins` for every node (recursively, also template content) |
| 2 | `mergeLayout` (2541) | page `<body>`'s top tag, layout file | a new document: the layout's, page content placed by `fillSlots(use, ldoc)` (2621); `useOf(lhtml)`, `hostUse`, `layoutBody`, `head` |
| 3 | `pagesOf(doc)` (7188) | `<html data-sn-for>` | `pagesDecl`, `fileData` |
| 4 | `expandComponents(doc, [])` (2688) | DOM, `componentFile()` (2343) | the DOM, macro-expanded: every component tag replaced by a `freshCopy` of its parsed file (2999); all side tables of §2 |
| 5 | `emptyStates`, `strayAndRepeated`, `accessible`, `slotsPlaced` (1595–1598) | expanded DOM, `uses`, `fileGraph` | DOM (else→if rewrite), `emptyOf`, diagnostics |
| 6 | pass 2 only: `expandConstants(doc, '', false)` (8616) | `opts.decided/unrolled`, `instKey` | DOM: decided branches inlined, rows cloned (`cloneTree`), recursion points/choice cases re-expanded per instance (`inlineInstance` 8713 → `expandUse`); `rowOf`, `instAt` |
| 7 | `canonical`, `<html lang>`, `checkHead`, `componentIds`, SN532 (1601–1614) | DOM, `uses` | DOM, diagnostics |
| 8 | pass 2: `prefold(doc)` (8556) | `opts.constants` keyed by `constKey` (siteKey + `Origin.use` + attr) | constant class/style/attr written into the DOM |
| 9 | `minify(doc)`, `snapshot(doc)` (pass 1 dry run) | DOM | DOM; `dry` copy |
| 10 | `new Layout(sheets, doc)`, `planSpace`, `rewriteImages(doc, …)` (1622–1632) | **the whole expanded DOM and the CSS cascade** | `layout`, `spacePlan` (by `<template data-sn-for>` element), image attributes in the DOM |
| 11 | `declare(doc)` (4868) | whole DOM, also inside expanded components | `page.resources`, `page.dialogs`, `page.ids`, `resources`, `resourceEls`, … |
| 12 | `pathPatterns(doc)` | `<html data-sn-path>` | `pathList`, `page.pathParams` |
| 13 | `walkChildren(doc, rootCtx)` (5028) → `element` (5073) per element | DOM + side tables + `page` | `roots`, `templates`, `fns`, `actions`, `stateInits`, `paints`, `tplEls`, `anchorEls`, `attrSources`, check frames…; DOM (`stripSn` 5442, `data-sn` ids, recursion points turned into `<template>`) |
| 14 | `finishTreeFills` (4433), `defRootBindings` (4719), `finishChoices` (4733) | `runtimePlacements`×`fillDefs`, `defAttrs`, `choiceGroups` | more templates (walks fills again), more `fns`, root bindings of shared definitions |
| 15 | `resolveSources` (5921), `fileUses`, `applyAliases` (9271) | `srcOf`, `srcCalls`, `page.aliases` | **rewrites code text** in `fns` (`/*src*/…/*end*/`, 5987–5990); extends `b.w` writes through aliases |
| 16 | `data-sn-c` / `data-sn-r` / `data-sn-s` marks (1645–1656) | `uses`, `landing`, `slotEls` | DOM attributes |
| 17 | `fileScripts`, `declareLayers`, `addPlaceholders`, `placeholders`, SN501, `runTargets`, `swapScripts`, `runCycles`, `remove`, `markLowPriority` | tables | DOM, diagnostics |

### finishPage (1747–1888)

| # | step | notes |
|---|---|---|
| 1 | `buildOnlyInIfs` | scans `fns` text for `$.$build` |
| 2 | `prerender()` (7740) | collects candidate bindings, **builds one `new Function` over the code text of every candidate** (7830), evaluates with a proxy scope, writes constants into the DOM; pass 1 also computes `decided`, `unrolls`, `constants` (the worklist 8144) |
| 3 | `embedFolded`, `dropConstants` (9080), `dropFiles`, `foldScriptsOut`, `collectConstants` | drop bindings/nodes, replace functions by `'0'` |
| 4 | `anchors()` (8805) | `<template>` → `<!--sn N-->…<!--/sn-->` (8838), content → head `<template id="sn-t-<tid>">`; **recomputes every template node's `path` from the DOM** (8861–8871) |
| 5 | `shareTemplates()` (8936, builds) | dedupes template subtrees across shared definitions by **regex-renaming code** (`@D`, `@0i`, `$pp`) |
| 6 | `earlyParts`, `placeTemplates` (8908) | head templates appended to head/body |
| 7 | `groupStyles` (1693) | **re-parses and merges style binding code** |
| 8 | `findCode`/`makeCode` per row template (1763–1772) | more functions |
| 9 | `fixedDeps`, `runtimeReasons`, script injection, IR assembly (1792) | |
| 10 | `checkUrlArrays` (1469) | **text-replaces `$.$u(` by `$.$l(`** in every function (1472–1475) |
| 11 | `compactTables` (1901, builds) | drops dead templates/functions, renumbers templates, **regex-renames `$i<old>`→`$i<new>`** in paths and code (1920–1949), dedupes functions by text, renumbers `sn-t-<id>` |
| 12 | `parse5.serialize(doc)` | the HTML |

So there are already three page-global text-renaming passes over generated code (5, 10, 11) and one text-patching pass
(walk step 15). Any plan design inherits them; they are naturally "assemble" work.

---

## 2. What a component use becomes

`expandUse(host, def, chain)` (2995–3199), per use:

1. `freshCopy(parsedText(def.text))` (2999): a deep copy of the cached fragment. Then `tag(frag, origin)` (3003) walks
   the copy and sets an `Origin` on every node, whose `chain` and `use` (`"<siteKey(host)><<outer use>"`) are this
   instance's path. That `use` string is what makes `instKey` per instance (8597).
2. Validation of the file (3013–3070): one template, script, style. Errors set `def.bad` on the shared
   `ComponentFile` (3009): a later use of it on this page is skipped (2754). Scoped CSS is computed once per
   `ComponentFile` (3058), i.e. once per `Compiler`, i.e. once per page per pass.
3. `typeMembers` of the declaration (3074), `declaredSlots` (3075) — per use (inference: not cached; cheap-ish).
4. `const use: Use = {…}` (3087).
5. `fillSlots(use, content)` (3394): the caller's children of the tag are moved (first placement) or `cloneTree`d
   (others) into the component's `<slot>`s; data slots get `place()` (3626); declared slots get a kept copy for tree
   placements (`fillDefs`, 3415–3433), whose components are expanded right there (3428).
6. Root not one plain element → `foldIn(content, constantProps(...))` (3100): `data-sn-if` on a literal prop decided by
   splicing the DOM.
7. `rootShape` (3205) → `el | chain | tag | choice | text`; attribute landing: plain host attrs copied onto the root(s)
   (3143–3168); `passOn`, `landing`, `scopeStart` recorded (3170–3194).
8. The root(s) replace the tag in the parent (3179–3184); `useOf(root)=use`, `hostUse(host)=use`,
   `uses[name].push(use)`.
9. Back in `expandComponents` (2757–2762): recurse into the root with `chain + name`.

Then the walk compiles the copy's elements like page markup. `element()` switches scope when it meets the root
(`useOf`, 5155–5157: `componentScope(use, ctx.scope)` → props as lets, §4), compiles the root's own attributes in
component scope and **the tag's `data-sn-*` attributes onto the same `NodeDef` in the caller's scope** (5367, and
5369 for `landing`).

Recursion (component inside itself through a `for`/`if`) and every `<sn-component use>` candidate are **shared
definitions** instead: `points`/`choices` set during expansion (2745, 2870); the walk calls `recursionPoint` (4231),
which compiles the definition once per page (`definition` 4772 → `compileDefinition` 4830: a synthetic host, expanded
and walked as row template `$p<tid>`) and emits a `for`/`ch` anchor over `[ { props…, $a, $f } ]`. This is today's
closest thing to a "plan": once per (page, component), all props runtime, numbered page-globally.

### The `Use` record (685–724)

`name, file, host, root, template, props, propsText, treeFills, slots, emits, emitsText, chain, late, sid, scope
(ComponentScope), caller (Scope), head, markup (cached Scope), shape, hostSlot, layout, bodyHandlers`. `caller`,
`scope`, `sid`, `markup` are written by the walk (`componentScope` 3986, `element` 5328), not by expansion.

### Side tables keyed by DOM node

W = written by, R = read by. "Clone" = exists only because instances are cloned DOM whose nodes must be traced back.

| table (decl. line) | for | W | R | clone? |
|---|---|---|---|---|
| `origins` WeakMap (1154) | file/src/chain/use of each node: diagnostics, `siteKey`, `instKey`, `markupFile`, library rules | `tag`, `choice`, `cloneTree`, `mergeLayout` | `report`, `instKey`/`constKey`, `libOfFile`, `rewriteImages fileOf`, sourcemaps | partly: a plan would key by (component, local node), but the per-instance `use` chain is what decisions are keyed on |
| `useOf` (1202) | element that is a component's root → its `Use` | `expandUse`, `expandHead`, `mergeLayout`, `cloneTree` | `element` (scope switch), `foldIn`, `inertFill`, `prefold`, `readsFormError` | yes |
| `hostUse` (1204) | tag → its `Use` | `expandUse`, `expandHead` | `expr` (event detail source), `recordExpr`, `compileDefinition` | yes |
| `slotOf` (1206) | caller content placed in a slot → the `Use` whose caller wrote it | `fillSlots`, `expandUse`, `inheritSlot`, `choice`, `cloneTree` | `expandComponents` (chain), `element` (scope back to caller), `foldIn` (skip), marks | yes: marks "this subtree is foreign" inside a cloned tree |
| `fillOf` / `defaultOf` / `childrenOf` (1208, 1210, 1236) | data-slot fill / default / children a fill's `<slot>` places → `FillChain` | `place`, `cloneTree`, `expandConstants` | `element` → `fillScope`/`fillAt` | yes |
| `emptyDefaults` (1212) | unfilled placements with empty default, by parent | `place`, `cloneTree` | `walkChildren` (5029) | yes |
| `enclosing` (1214) | tag → enclosing `Use` (tree-placement contract) | `expandComponents` | `treePlacement`, `componentScope` (fills) | no (an env) |
| `scopeStart` (1232) | node where a non-plain root's / outer component's markup starts → uses | `expandUse`, `choice`, `cloneTree`, `expandConstants` | `element` (5117–5128), `expandComponents`, `foldIn` | yes |
| `landing` (1234) | element that is the root of outer uses too → those uses | `expandUse` | `element` (5369), marks | yes |
| `passOn` (1230) | component tag / choice that is another component's root → outer uses | `expandUse`, `choice`, `cloneTree` | `expandUse`, `pointAttrs`, `inlineInstance` | yes |
| `points` (1266) | tag/candidate → definition name | `expandComponents`, `choice` | `element` → `recursionPoint`, `expandConstants`, `foldIn` | yes |
| `choices` (1268) | candidate clone → choice info + shared `ChoiceGroup` | `choice`, `freshChoices` | `recursionPoint`, `expandConstants` | yes (one clone per candidate) |
| `pointCtx` (1180) | point → `{ch, en}` to re-expand it as a use in pass 2 | `expandComponents`, `choice` | `inlineInstance` | yes |
| `forwarded` (1188) | text nodes forwarded to an inner slot | `fillSlots` | `fillSlots` | yes |
| `writtenIn` (1241), `caseInst` (1243), `chainCopyOf` (1245), `repeatedFills` (1247), `caseScopes` (1227) | fill bookkeeping across copies | `inheritSlot`, `finishTreeFills`, `cloneTree` | `element`, `instOf`, `fillAt` | yes |
| `instAt` (1182), `rowOf` (1176) | pass 2: instance path / unrolled row info of top nodes | `expandConstants` | `instOf`, `element` (rowLets), `prefold` | yes |
| `markups` (1184), `fillScopes` (1239) | per-instance scope cache of a `Use`/fill (rows share a `Use`) | `markupOf`, `fillScope` | same | yes: only because copies share one `Use` |
| `defRoots` (1278), `defHosts` (1283) | shared-definition root/host | `compileDefinition`, `cloneTree` | `element`, `componentScope`, `foldIn` | partly |
| `layoutBody` (1186), `tagIds` (3953), `runtimeSlots` (1218), `measured` (1289), `branchGuard` (1350), `emptyOf` (1354) | misc. | | | `measured` is per clone: SN507 measured per instance |
| walk outputs by element: `tplEls`, `textAt`, `textMarks`, `anchorEls`, `anchorStart`, `paints`, `attrSources`, `spacePlan`, `exprsOf`, `idEls`, `hrefs`, `boundHrefs` | `anchors`, `prerender`, `collectConstants`, check | walk | finish | not clone-specific: they are the residual's addresses |

Everything in the "yes" rows exists to answer, while walking a flat cloned DOM, "whose scope am I in and which
instance am I". In a plan/emit design that is the emit call stack (env), not data on nodes.

---

## 3. Numbering and naming

| id | counter / source | assigned | ends up in |
|---|---|---|---|
| top-level node id | `nextId` (1344) | `element` 5430, `recursionPoint` 4308, `runtimePlacement` 4421, `textNode` 4355, embedded data 5263 | markup `data-sn="N"` (5431); anchor comment `<!--sn N-->` (8838); `NodeDef.id`; kept elements get a range `keptBase(name)` (5050–5066, 10728) |
| template id `tid` | `templates.length` (`newTemplate` 5725) | `forTemplate` 6658, `if`/`else` 5404/5418, `compileDefinition` 4835, `runtimePlacement` 4404, `finishTreeFills` 4443 | `Binding.x/z/c` (IR); `<template id="sn-t-<tid>">` (markup); **inside code**: `$i<tid>` loop index (6661, in alias paths `{$i<tid>}` → deps and code), `$p<tid>` definition item (4835: props read as `$.$p<tid>.name`, 3992; `$a` reads 4670), `$sl<tid>` (4405, 4443, slot data `$.$sl<tid>.key` 4474), renamed loop names `item$<tid>` (6673–6677) |
| state id `sid` | `nextSid` (1345) | `stateOf` 4134, form `$error` 5310 | **inside code** `$.$s<sid>.field` (expr.ts 718), deps/writes `$s<sid>.x`, `cmp` writes 5383, refs `[$.$s<sid>, "name"]` 5873; `stateInits`; `NodeDef.sid` |
| use id | `useIds` (1264) | `componentScope` 4014–4016 (each call, so per instance and per row instance) | `ComponentScope.id` → `@ev:<id>:<event>` source refs (5826, 5830) in `srcOf`; resolved away in `resolveSources` but present in `/*src*/[…]/*end*/` placeholders inside code until then; part of the linker key (4782) |
| function index | `fns`/`fnIndex` (1134), dedupe by code text (`fn` 5749) | everywhere | `Binding.f/a/s.r/s.o`, `TemplateDef.key/find/make`, `NodeDef.state`, `ir.lm`, `d.u`. Order of first appearance = index |
| node list index | position in `ctx.list` | `element` 5287 | `NodeDef.p` (parent state index), `Binding.y` (else index); renumbered by `dropNodes`/`dropConstants` |
| template path | `[...ctx.path, index]` | `element` 5434 | `NodeDef.path`; **recomputed from DOM in `anchors()`** (8869) |
| action index | `actions.length` (6531) | `action` | `Binding.x` of an `on` binding (6532); linker refuses actions in definitions |
| fill id | `fillDefs.length` (3430) | `fillSlots` | **inside code**: `fillsCode` `{ "k": <id> }` (4536), `$slots` const (expr.ts 583), runtime placement map `JSON.stringify(P.map)` (4497) |
| choice case index | `g.cases` order | `recursionPoint` 4279 | code of the choice function (4749–4759) |
| lazy load local | `lazyLoads.size` (5904) | `lazyImport` | **inside code** `$l$<n>()` |
| lazy helper module | `lazyMods` index (constructor 1561) | | **inside code** `$.$z(<i>, "name")` (6070), deps `$lz.<i>` |
| component class local | `$cm$<name>` (5373) | | code; stable per component name |
| space placeholder | `spaceN`, `pendingSpace` | `placeholders` | markup |
| check frames | `check.frames.length` | `componentScope`, `stateOf`, `lets`, `forTemplate`, … | check unit only |

**Instance-specific numbers inside generated code strings**, which decide holes vs. renaming:

- `$s<sid>`: every read/write of a component's own root state. A component with `data-sn-state` used 100 times
  produces 100 distinct function texts (different sid), no dedupe.
- prop values: **inlined as text** (expr.ts `emitName` 'let', 717). The caller's compiled expression becomes part of the
  component's code. This carries the caller's sids, loop names (`$.n`, `$.n$12`), `$p<tid>`, `$sl<tid>`, literal data.
- `$i<tid>`, `item$<tid>`, `$p<tid>`, `$sl<tid>`: the tid of templates inside or around the component.
- fill ids (tree slots), lazy indices, `/*src*/` refs with use ids.
- pass 2 unrolled rows: the item as a JS literal (`jsLiteral(x.value)`, 5095) inlined into every row binding.

Already text-renamed after the fact: `$i<n>` (`compactTables`), definition items → `$pp` (`shareTemplates`),
`$.$u(`→`$.$l(`. compile-once.md (5) records that regex renaming of generated code broke repeatedly (user text
`x$1` in strings, `US$2`, `@ev:<id>` in strings): the linker gave up renumbering entirely and keys plans by the page's
numbering instead (4782–4783). A plan design must make these holes **structural** (a token list or AST with typed
hole nodes), never found by pattern in the final text.

---

## 4. What compiling one element costs, and what is instance-independent

Example: inside `<x-item>` (`data-sn-props="{ node: Node }"`), `<p data-sn-text="node.value" data-sn-class="{ a: node.x }">`;
the page uses `<template data-sn-for="n in nodes"><x-item data-sn-with="{ node: n }">` and 99 other uses.

Per use, before the walk: `freshCopy` + `tag` of the whole file (every node), `fillSlots` (`placements` walk),
`rootShape`, `foldIn` walk (if non-plain root), attribute landing, splice.

Per use, at the root (`componentScope` 3985 → `propLets` 4164): `expr(host, 'data-sn-with', caller, …)` analyzes the
whole object, then **each entry is analyzed again** with `analyze(src.slice(...), caller, …)` (4195) to get its `inner`
code; `lazyLet`; `foldConstants` (another DOM walk when a prop is a literal, 3994, 5610); a `ComponentScope` with
`outer` = every caller name, `runtime` = caller loop names; check frame. Props become `LetEntry { code: q.inner, deps,
prop: true }` — **lets, inlined as code text at every read**, nothing per-use is bound at run time (except inside
shared definitions, where `code` is `$.$p<tid>.<name>`, 3992).

Per element, `element()` (5073):
1. href/axis bookkeeping; scope switching through 8 side tables (§2) — instance-dependent.
2. unknown-attribute scan; builds `known = new Set([...ATTRS…])` per element (5174) — instance-independent and
   identical for every element of the build (trivial but telling).
3. ~25 attribute families checked with `has()`/`get()` (linear scans of `sn`) — independent.
4. `bindings()` (5467): per attribute `expr()` (5820) → `analyze()` (expr.ts 482):
   - parse: `parseExpression` cache hit (parse.ts) — independent, cached.
   - resolution: every identifier through `resolve` (expr.ts ~556–710): lets (props) → loops → states → resources →
     store → helpers → globals; `emitName` writes the replacement text; deps from lets copied wholesale (expr.ts 1070).
     Dependent on the scope chain, page resources/helpers/locale.
   - codegen by `applyEdits` over the source; `reads`, `itemOf`, aliases, `page.usedHelpers` etc. as side effects.
   - `complexity()` (SN507) measured per element clone (keyed by element, 5697) — independent, recomputed per use.
   - `check`: `recordExpr` with the scope's frames — per instance by design.
   - `fn(code)` dedupe; `binding()`; `selection()` re-analyzes both sides of `===` (6384) when in a loop.
   - `source()` records `attrSources` for pass 1's constants.
5. node numbering (`ctx.tid < 0` → `data-sn` id + `paints`; else `path` + `tplEls`), `stripSn`.

For the example, the code is: `node` resolves to the let whose code is `$.n`, a plain path, so it is spliced bare:
`data-sn-text` → `($) => ($.n.value)`; class entry → `($) => ($.n.x)` (wrappers: expr.ts 1897 for a value,
1913 for each object entry; handlers are `($) => {…\n}`, 1898). All 100 uses with `{ node: n }` from loops named `n` get the same text → one function.
A use with `{ node: m }` gets `($.m.value)`; inside another component's loop with a clashing name, `$.n$17.value`; from
a shared definition, `$.$p4.node.value`; with a constant `{ node: { value: 'a' } }`, `(({ value: 'a' }).value)`, which
pass 1's `prerender` evaluates by `new Function` over that text (7830), paints into the DOM, and `dropConstants` then
drops. Deps are the prop's deps, not refined to `.value` for a let (expr.ts 739: a let's `basePath` has no segs).

What is identical for all 100 uses: the parse, the attribute scan and validation, the AST shape, which identifiers are
props vs. locals vs. helpers (given the same page/options), the SN5xx measures, the *structure* of the generated code
(`($) => (<prop:node>.value)`), the binding kinds and names, the node's tag, its local path within the component.
What depends on the use: the prop's code text and deps, the caller's loop names (renaming), the sids/tids, whether the
node is top-level (id) or in a row (path), dialog/form/late/kept context, the per-instance decisions of pass 2, the
diagnostics' chain, the check frames. The split is clean at the level of "analyzed attribute with prop holes" — but
today nothing stores that intermediate: `analyze` goes from source + full scope straight to final text.

---

## 5. What is already cached, and by what key

| cache | where | key | scope | holds |
|---|---|---|---|---|
| `PARSED` | 958 | component file text | process, cleared at 2,000 | parse5 fragment (read-only; each use `freshCopy`s it) |
| acorn trees | parse.ts `kept` | (kind e/p, options) → source text | process, 50,000 | frozen AST |
| `QUIET_MARKUP` | 1108 | file text | process | custom tags of a quiet file |
| `INERT_FILLS` | 1078 | `fillDefs` entry object | per compiler in effect | bool |
| `componentFiles`, `layoutFiles`, `kinds`, `graphs` (`fileGraph` 4545, `reach`, `inert`, `tree`) | fields | tag / name | **one `Compiler`** (one pass of one page) | file text, script/css lookup, scoped CSS (`def.css`), `bad` |
| `lineStarts` | 1290 | source text | one `Compiler` | line offsets |
| `fnIndex` | 1135 | code text | one `Compiler` | function index |
| choice `later` | 4245 | (scope object, `use` text) | one choice group | the analysis of `use` |
| `markups`, `fillScopes`, `Use.markup` | | (use, instance path) | one `Compiler` | computed scopes |
| `FOLD_MEMO` | 643 | helpers module → page file | a page's passes | build-time helper call results |
| `templates` (`fromTemplate` 1008) | option | file, locale, html | build | a walked pass-1 `Compiler` per `<html data-sn-for>` template |
| `definitions` (linker, `definition` 4772, link.ts) | option | pass 1/2, chain of earlier unit ids, name, existing `defs` names, **the page's numbering** (templates, sids, useIds, nextId, fns, actions) | build | recorded plan of a top-level shared definition: ops, preconditions (`Read`s), fn hand-outs; replay checks everything |

Not cached anywhere: expansion (DOM copy per use), `analyze` results, `propLets`, `componentScope`, `typeMembers`
of declarations, `declaredSlots`, scoped CSS across pages (per `Compiler`), anything of pass 2. The linker applies
only to top-level shared definitions in pass 1 (and only when the numbering before it matches); the 420-instance
markdown post's cost is pass 2's per-instance `inlineInstance`→`expandUse`→walk of constant tree nodes, which no
cache touches (compile-once.md (5): "its tree is a build-time constant, which the compiler expands per instance").

---

## 6. Verdict on plan(component, signature) + emit(plan, env) + assemble

The hypothesis is sound in direction — §4 shows the per-instance work is mostly the same work redone — but "plan
with holes, emitted cheaply" understates what a component's compile depends on. Obstacles, hardest first.

### 6.1 The page's whole expanded DOM is an input to the walk (hardest)

Between expansion and the walk, `Layout(sheets, doc)` (1622), `planSpace` (1624), `rewriteImages` (1626),
`snapshot`/dry run (1621), `prefold` (1616), `minify` (1619) read and rewrite the complete expanded markup, and the
walk reads their results (`spaceFor` 5440 via `spacePlan`, keyed by element; image `sizes`/`srcset` written per
`<img>`; `data-sn-r`/`data-sn-c` marks). An `<img>` in a component gets different `sizes` per placement because the
cascade around each instance differs. `declare(doc)` (1633) collects resources/dialogs/ids from inside components
before any expression resolves. So "no DOM per instance" fails whenever `styles`/`images` are on: there must be a
materialized page tree (or a layout engine that can query a lazily assembled tree) *before* bindings are final, and
per-instance outputs depend on instance position. Likely shape: emit the residual markup tree first (cheap, from
plans), run layout/images/declare on it, then finish bindings — i.e. emit is two-phase, and the plan's "markup" part
must stay addressable per instance.

### 6.2 Constant-ness is page-global and data-valued, not a per-prop binding-time bit

- What is constant is decided by evaluating the compiled program (`prerender` + worklist 8144) against `writtenState`
  (9343), which unions writes from every binding, action, resource, stream, persisted model on the page, extended
  through `applyAliases` (9271: a page handler mutating an object aliased into a component's state field makes that
  field written). So even a component's *own* state is not locally decidable (inference from 9271–9300).
- Decisions are per instance path (`instKey` = siteKey + `Origin.use` chain, 8597; row prefixes `<loop>#<k>/`), and
  pass 2 changes the *shape* per instance: branch kept or dropped, rows unrolled with the item inlined as a literal
  (5095), choice case inlined (`inlineInstance`). `foldIn` (5616) already splices the DOM per use on literal props.
- `EXPANSION_LIMIT`/`overLimit` budget is counted across the page.
- Constants are computed by generating JS text and `new Function` (7830), then painted and dropped.
So the signature cannot be "which props are known": for a known prop the plan's output depends on its *value*
(structure and text). The plan must be a residualizing partial evaluator: `emit(plan, env)` evaluates the static part
from env values (directly over the analyzed form, not via codegen+eval), and emits residual bindings for the rest. That
also needs the "is this state written" facts from the whole page *before* emit — today the reason for pass 1. A real
single pass needs those facts computed from a cheap pre-scan of plans (each plan exporting its writes/aliases as a
summary) — that is the "second front end that must agree" compile-once.md (4) rejected, unless the plan *is* the front
end and the summary falls out of it.

### 6.3 Props are inlined as code text; instance numbers live inside code strings

Props are lets whose `code` is spliced into every read (expr.ts 717, `componentScope`/`propLets`). Together with
`$s<sid>`, `$i<tid>`, `item$<tid>` (renaming depends on the *caller's* loop names: `runtime` 3998, `clash` 6672),
`$p<tid>`, `$sl<tid>`, fill ids, `$l$<n>`, `$.$z(<i>`, `@ev:<useid>`, the generated text of a component's function
is a function of the instance. Deps (`b.d`) carry the caller's paths too. A plan therefore needs code as a template with
typed holes (prop-code, sid, tid-derived names, fill ids), and dedupe by final text must happen after substitution
(assemble). Feasible, but: (a) every place that builds code by string concatenation (`pointAttrs` 4705, choices
4749–4759, tree placements 4497, `cmp` 5384, form `$error` 5306, `groupStyles`, `findCode`/`makeCode`) must speak the
hole format; (b) `analyze`'s side effects keyed by resolved names (`reads`, `itemOf`, `assigns`, aliases with `$s<sid>`
paths, `page.objectFields`) must be holes too. The alternative — bind props at run time as a scope frame (what shared
definitions do with `$p<tid>`) — makes the plan text truly instance-independent but changes the shipped IR/runtime and
output bytes; worth deciding explicitly, because it is the difference between "holes everywhere" and "no holes".

### 6.4 The use site and the page parameterize a component's compile (signature inputs)

Read from the use site / context during expansion or walk:
- position: `ctx.tid < 0` (id + `paints` + text anchor pair vs. path + comment mark, 5429, 4354); `ctx.dialog`/`ctx.form`
  (5284–5286; `action` inForm 5574); kept element and `opts.swap` (5050, 5620); `late` from the tag or any enclosing
  component (4014, 5283); HTML parser context (table rule 3090; foreign content: the file is parsed as an HTML
  fragment regardless of context — inference).
- slots: which slots are filled and with what shape decides the root shape (`rootShape` 3205: a filled root `<slot>`,
  a text root, a fill that is the root) and attribute landing; fills are caller markup *inside* component markup, and a
  fill's own `<slot>` places component markup inside the caller's fill (`place` 3662–3688) — nesting both ways. Tree
  slots: `fills` (4003–4013) depend on the enclosing roots and package boundaries (`crossesPackage` reads the host's
  markup file, 2445).
- tag attributes: compiled in caller scope onto the root's `NodeDef` (5367, 5369); plain attrs copied onto the root,
  `class` merged (3143–3168); outer tags passing on (`passOn`/`landing`).
- page/options: `page.resources`, `dialogs`, `ids` (a component may read page resources; resolution differs per page),
  helpers/namespaces/lazy modules, `locale` (`$locale` and `localeUrl` inlined as constants, expr.ts 561–564),
  `urls` (`$canonical`), `axisUrl`, `contentNs`, libraries (`choicePool` by file), `dev`, `check`, `sourcemap`,
  `minify`, `prerender`, `early`, `describeOnly`, `complexity` levels, `remoteImages`. The linker learned these the hard
  way (compile-once.md (5), first review: page flags, `$locale`, image host).
A signature that includes all of these is large; the practical form is a page-config hash (per page) plus per-use
context bits (top/in-row, dialog, form, late, kept, slot-fill shapes, tree-fill ids as holes).

### 6.5 Post-walk merges make shared definitions depend on all their uses

`defAttrs`/`defRootBindings` (4663, 4719): a definition's root gets bindings for the union of attribute keys over all
its uses on the page. `finishTreeFills` (4433): a definition gets one case template per fill on the page that reaches
it, walked after the walk, iterated to a fixpoint. `finishChoices` (4742): lookup table vs. chain depends on how many
cases the page gave the group. These are "assemble"-time by nature: a plan can export the open sets and assemble
closes them, but the closing step compiles new markup (fills) and so re-enters emit.

### 6.6 Order dependence (instance N vs. N−1)

Semantic dependence between instances is small; numbering and first-wins dependence is everywhere:
- function index by first appearance and dedupe (`fn` 5749); `fnAt`/`codeAt` first site wins (source maps).
- `once()` (3740): a library error reported at the first use only; `reportedOnce`.
- `ComponentFile` mutated at first use: `def.bad` (3009) skips later uses; `def.css` computed at first use.
- choice `later` reuse (4245); `defs` compiled at the first recursion point; `componentIds` checks `list[0]` (3963).
- `useIds` per `componentScope` call; `nextId` per top-level node, kept ranges reset `nextId` (5054–5065).
- `page.resources[].used`, `usedHelpers`, `features`, `aliases`, `objectFields`, `mutated`, `urlWrites`,
  `listWrites`, `readsUrl`: additive effects; order-free if a plan records them as an effect set.
None of these is a blocker for assemble-time numbering; they mean assemble must reproduce "first appearance" order
exactly to stay byte-identical (compactTables already renumbers templates and functions in order, which helps).

### 6.7 Diagnostics and `sinter check` are per instance

`report` (2293) appends the instance's include chain to each message (2299); check frames/exprs are pushed per instance
(`componentScope` 4017, `recordExpr` 6122) and narrow per choice candidate (4259). A plan reports its own
errors once per (component, signature); the per-use ones (SN313 props, SN315 events, SN334 roots, fills) stay at emit.
Byte-identical diagnostics would need the plan to replay its diagnostics per use with the chain — or a deliberate
behavior change (report once). Keep the old path for `check`, as the linker does.

### 6.8 Smaller ones

- The walk mutates its input (`stripSn`, `setAttr data-sn`, points turned into templates); a plan's markup must be
  copy-on-emit or emitted as text/tokens — fine, but `prerender` paints into DOM elements found through `paints`/
  `tplEls`, so the residual needs element handles.
- `anchors()` recomputes row paths from the final DOM (8861–8871); a plan's local paths are only provisional.
- `shareTemplates` exists because definitions compile per page with distinct tids; with real per-component plans it
  becomes unnecessary (the plan is the shared template) — a simplification, not an obstacle.

### Ranking summary

1. Layout/images/declare over the full expanded DOM before the walk (6.1) — forces a two-phase emit.
2. Page-global, value-dependent constant decisions and the two passes (6.2) — the plan must be a partial evaluator
   with whole-page write facts available before emit.
3. Prop inlining and instance numbers inside code text (6.3) — structural holes, or move props to run-time frames.
4. Signature breadth: use-site context and page config (6.4).
5. Post-walk union/fixpoint merges for shared definitions (6.5).
6. Diagnostics/check per instance (6.7).
7. First-appearance numbering order (6.6) — mechanical, solvable in assemble.

Where it holds up: everything in §4 marked instance-independent is real and dominant; the existing shared definition
already demonstrates a per-(page, component) unit with all-runtime props, and the existing post-passes
(`compactTables`, `shareTemplates`, `checkUrlArrays`, `resolveSources`) show that page-global numbering and text fixups
can live at the end. Where it breaks as stated: "same mechanism for constant and live uses" only if emit evaluates
(partial evaluation), and "no DOM cloning" only if layout/images can run on emitted output before bindings are final.
