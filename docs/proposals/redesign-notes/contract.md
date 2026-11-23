# Redesign notes: the compiler's output contract, its callers, and the oracle

Read-only research for a new front half of the compiler (`src/compiler/compile.ts`; 11,138 lines today, one
`Compiler` class from line 1129). Line numbers are of this checkout. "Inference" marks what was read off the code
or the examples rather than stated by it. Examples were compiled with `dist/` (scripts in the session scratchpad,
`ex.mjs`, `ex3.mjs`, `ex4.mjs`; modelled on `bench/page-compile/run.mjs`).

Background worth reading first: `docs/proposals/compile-once.md` already did half of this analysis for shared
definitions (the linker, five reviews, why a single pass "is a rewrite of the compiler's front half").

## 1. The output contract

### Layers

```
compile(html, opts): CompileResult                 src/compiler/index.ts:40   (SN_LINK_AUDIT hook here, :42)
  compileOne -> compileParts(html, opts): CompiledParts    compile.ts:944
    compilePasses (compile.ts:1048): fromTemplate | pass 1 (+ pass 2 with decided/unrolled/constants/frozen/overLimit)
      new Compiler(opts).run(html) = finishPage(walkPage(html))        compile.ts:1577
    canonicalOnly: compilePasses again with canonicalLink:false        compile.ts:947
    json placeholders \u0001sn-json:<id>\u0001 replaced (not with describeOnly)  compile.ts:949
  pageLines(parts) -> the page module text; earlyLines(parts.early) -> the early module text (index.ts:228, 284)
```

`walkPage` (compile.ts:1587) is "the program": parse, `mergeLayout`, `expandComponents` (macro expansion of every
component tag into the page DOM, `freshCopy` of the parsed component, :2688/:2999), state/a11y checks,
`expandConstants` (pass 2), `canonical`, minify, layout/space, images, `declare`, `walkChildren` (bindings, functions,
templates, check frames), tree fills, choices, `data-sn-c`/`data-sn-r`/`data-sn-s` marks, resource checks,
`runCycles`, detach `remove`. `finishPage` (:1747) is the back half: `prerender` → `embedFolded` → `dropConstants` →
`dropFiles` → `foldScriptsOut` → `collectConstants`, then `anchors()` (comments + template paths, :8805),
`shareTemplates` (builds, :8936), `earlyParts`, `placeTemplates` (:8908), `groupStyles`, `find`/`make` per row template
(`findCode`/`makeCode`, :10814/:10857), `fixedDeps`, runtime reasons / `static`, `injectScript`, IR assembly (:1792),
URL code (`u`), helpers/namespaces imports, features, `compactTables` (builds only, :1850/:1901), and the returned
object (:1851–1887).

### `CompiledParts` (compile.ts:479–573) and who reads it

| field | what | read by |
| --- | --- | --- |
| `html` | serialized page (`parse5.serialize`), head templates `<template id="sn-t-N">`, `data-sn` ids, `<!--sn N-->` anchors | everyone; testing writes it into happy-dom |
| `runtime` | `RuntimeReason[]` in document order; empty = static | vite (`runtimeOf`), SN322 |
| `static` | prerender and nothing runs | index.ts (no module/early), vite |
| `ir` | `IR` v2 (src/ir.ts:365), compiler form (string paths) | `pageLines` → `compactIR`; testing mounts `compactIR(parts.ir)` (testing:783) |
| `fns` | the function table, code strings; `'0'` for dropped slots in dev | page module, testing (`new Function`, testing:703) |
| `fixedState` | `$s<sid>.<field>` used as constants | testing `state(el).update()` refusal |
| `sources` | `FnSources` (with `sourcemap`) | `MappedLines.map` → `CompileResult.map` |
| `features` | runtime feature modules in fixed order (:1859) | page module imports; testing |
| `helpers`, `namespaces`, `calls` | imports the module needs | page module; testing |
| `diagnostics` | ordered `Diagnostic[]` | all callers |
| `files` | sorted, every file read | vite `watch`, LSP includes |
| `pages`, `axes`, `contentNs`, `globs` | `<html data-sn-for>` entries, axes, per-point namespaces, glob folders | vite (templateOf, watchGlob) |
| `json`, `lateDiagnostics` | internal between passes | compileParts |
| `check` | `CheckUnit` (check-unit.ts) | `sinter check`, vite build (`units`), LSP |
| `early` | `EarlyParts` (ir/fns/sources/helpers/renderers) | `earlyLines` → `CompileResult.early` |
| `images`, `paint`, `unheld`, `waits`, `remote`, `remoteWidths` | images, first-paint CSS, logs | vite |
| `prefetch`, `embed`, `prefetchOff`, `loadEffect`, `permanent`, `keptSource`, `keptBound`, `swapOff`, `unlistedOrigins` | page description for other pages / server / swap | vite `describe()`, prefetch-build, prerender-build, embed json |
| `styles`, `scripts`, `lazy`, `lazyHelpers`, `preload` | component CSS/scripts, lazy loaders | index.ts module text, vite |

`CompileResult` (compile.ts:319–399) is `CompiledParts` minus `ir/fns/sources/features/helpers/...` plus `module`
(text), `core` (`coreParts(ir)`), `map`, `early` (text), `earlyMap`, `path`, `urlArrays`, `sameLinks`, `lazyScripts`
(index.ts:109–144). Every field is derived in `compileOne` from `CompiledParts` + options; nothing there reads the
`Compiler`. **So `CompiledParts` is the narrowest complete contract**: a new front half that yields an identical
`CompiledParts` gives an identical `CompileResult`.

### The IR (src/ir.ts)

- `roots: NodeDef[]` page nodes, each with `id` (its `data-sn` id or anchor comment number), `tag` (`#` for an anchor),
  `p` (index in the same list of the enclosing state scope, must come first), `state`/`sid` (`$s<sid>`), `b: Binding[]`.
- `templates: TemplateDef[]`, index = id = `sn-t-<id>`; `nodes` with `path` (child indexes in the content; an anchor
  counts as its start comment), `item`/`index`/`ii` (`$i<id>`), `key`/`keyFields`, `find`/`make` (function indices),
  flags `w o a tx dv` and, in the page module only, `sm ri`.
- `Binding`: `k` (text attr class style show model prop for if on ch cmp imp), `f` value/handler fn, `d` deps, `w`
  writes, `x` template (for/if) or action (on), `z` else template, `c` choice templates, `a` model setter, `s`
  selection, `g` style group, dev `at`.
- `resources`, `syncs`, `actions` with function indices (`u`, `when`, `then`, `body`, …); `sg`, `lm`, `si`, `path`,
  `urlArrays`, `urlReads`, `now`, `tw`.
- `compactIR` (ir.ts:562): `structuredClone`, path strings → a trie `ps` (pre-order, children sorted by name: a
  function of the *set* of paths, not of order), drops defaults, computes `ev`, `sm`, `ri`, `fed`.
- `mapFns` (ir.ts:409) visits every function index; `compactTables` renumbers templates (and `$i<id>` names in paths and
  code, `sn-t-<id>` in markup) and functions (dedupe by code, *in their original table order*).

### Worked example 1: one component, two live uses (state + handler)

```html
<!-- x-counter.html -->
<template data-sn-props="{ label: string; n: number }" data-sn-emits="{ bump: number }"><div class="ctr">
  <span data-sn-text="label + ': ' + n"></span><button data-sn-on-click="emit('bump', n)">+</button></div></template>
<!-- page -->
<section data-sn-state="{ a: 1, b: 2 }">
  <x-counter data-sn-with="{ label: 'A', n: a }" data-sn-on-bump="a++"></x-counter>
  <x-counter data-sn-with="{ label: 'B', n: b }" data-sn-on-bump="b++"></x-counter></section>
```

```html
<section data-sn="0"><div class="ctr" data-sn="1"><span data-sn="2">A: 1</span><button data-sn="3">+</button></div>
<div class="ctr" data-sn="4"><span data-sn="5">B: 2</span><button data-sn="6">+</button></div></section>
```

```js
const ir = {"v":2,"resources":[],"roots":[
 {"tag":"section","b":[],"state":0,"sid":0,"id":0},
 {"tag":"div","p":0,"b":[{"k":"on","f":1,"n":"bump","w":[5]}],"id":1},
 {"tag":"span","p":0,"b":[{"k":"text","f":2,"d":[5]}],"id":2},
 {"tag":"button","p":0,"b":[{"k":"on","f":3,"n":"click"}],"id":3},
 {"tag":"div","p":0,"b":[{"k":"on","f":4,"n":"bump","w":[6]}],"id":4},
 {"tag":"span","p":0,"b":[{"k":"text","f":5,"d":[6]}],"id":5},
 {"tag":"button","p":0,"b":[{"k":"on","f":6,"n":"click"}],"id":6}],
 "templates":[],"actions":[],"ps":{...},"ev":["bump","click"]};
const fns = [
  ($) => ({ a: 1, b: 2 }),
  ($) => {$.$s0.a++ },
  ($) => (('A') + ': ' + $.$s0.a),
  ($) => {$.$f.emit('bump', $.$s0.a) },
  ($) => {$.$s0.b++ },
  ($) => (('B') + ': ' + $.$s0.b),
  ($) => {$.$f.emit('bump', $.$s0.b) },
];
```

**An inlined instance leaves no trace at runtime**: its elements are page roots, its expressions page functions with
the props substituted (a prop is a `LetEntry` "inlined where it is read", expr.ts:87; a literal is parenthesized,
`('A')`, a path is not). The caller's handler on the tag lands on the component's root (`div` id 1). Only dev builds and
pages with scoped styles mark roots (`data-sn-c="x-counter"`, compile.ts:1646), and dev adds `src`/`at` positions.
The initial text (`A: 1`) is written by `prerender` (evaluated with the state's initial values).

### Worked example 2: a loop over a resource containing a component

`<template data-sn-for="it in items"><x-item data-sn-with="{ name: it.name, price: it.price }">` with
`x-item` = `<li><b data-sn-text="name"></b> <i data-sn-text="price.toFixed(2)"></i></li>`:

```html
<ul><!--sn 0--><!--/sn--></ul><template id="sn-t-0"><li><b></b> <i></i></li></template>
```
```js
roots: [{"tag":"#","b":[{"k":"for","f":0,"d":[5],"x":0}],"id":0}],
templates: [{"nodes":[{"tag":"b","b":[{"k":"text","f":1}],"path":[0,0]},{"tag":"i","b":[{"k":"text","f":2}],"path":[0,2]}],
             "item":"it","ii":"$i0","keyFields":["id"],"find":3,"make":4,"o":1,"sm":1}]
fns: ($) => ($.$r.items), ($) => ($.it.name), ($) => ($.it.price.toFixed(2)),
  (c) => { const n0 = c, n1 = n0?.firstChild, n2 = n1?.nextSibling, n3 = n2?.nextSibling; return [n1?.localName == "b" ? n1 : null, n3?.localName == "i" ? n3 : null]; },
  (c, $, w) => { …e0 = n1?.localName == "b" ? n1 : null…; const v0 = e0 ? ($.it.name) : w.U, v1 = e1 ? ($.it.price.toFixed(2)) : w.U; e0 && w.t(e0, "", v0); e1 && w.t(e1, "", v1); return [v0, v1]; },
  ($) => "/api/items"
```

The component is again flattened: the row template *is* the component's markup, its expressions read the loop item
directly (`$.it.name`). The loop is an anchor pair; the head template is cloned per row; `make` is a straight-line
creation function that inlines every binding's body (so the same code appears twice in the table: as `f` 1/2 and inside
`make` 4).

### Worked example 3: a recursive component over runtime data (a shared definition)

`x-tree` = `<li><span data-sn-text="node.label"></span><ul><template data-sn-for="k in node.kids" data-sn-key="k.label">
<x-tree data-sn-with="{ node: k }"></x-tree></template></ul></li>`, page `<ul><x-tree data-sn-with="{ node: root }">`
over `<sn-resource name="root" src="/api/tree">`:

```html
<ul><li><span data-sn="0"></span><ul><!--sn 1--><!--/sn--></ul></li></ul>
<template id="sn-t-0"><!--sn--><!--/sn--></template>
<template id="sn-t-1"><li><span></span><ul><!--sn--><!--/sn--></ul></li></template>
<template id="sn-t-2"><!--sn--><!--/sn--></template>
```
```js
roots: [{"tag":"span","b":[{"k":"text","f":0,"d":[5]}],"id":0}, {"tag":"#","b":[{"k":"for","f":2,"d":[5],"x":0}],"id":1}],
templates: [
 {"nodes":[{"tag":"#","b":[{"k":"for","f":8,"x":1}],"path":[0]}],"item":"k","ii":"$i0","dv":1,"key":1,"find":9},      // the page's loop: k in root.kids
 {"nodes":[{"tag":"li","b":[],"path":[0]},{"tag":"span","b":[{"k":"text","f":4}],"path":[0,0]},
           {"tag":"#","b":[{"k":"for","f":6,"x":2}],"path":[0,1,0]}],"item":"$p1","key":3,"find":10,"o":1},           // THE DEFINITION
 {"nodes":[{"tag":"#","b":[{"k":"for","f":7,"x":1}],"path":[0]}],"item":"k$2","ii":"$i2","dv":1,"key":5,"find":9}],   // its own loop
fns: 0 ($.$r.root.label) 1 ($.k.label) 2 ($.$r.root.kids) 3 () => 0 4 ($.$p1.node.label) 5 ($.k$2.label)
     6 ($.$p1.node.kids) 7 [{ "node": ($.k$2) }] 8 [{ "node": ($.k) }] 9,10 find 11 "/api/tree"
```

- The **outermost use is still inlined** into the page (`span` id 0 reads `$.$r.root.label`); only inner uses go
  through the definition (template 1).
- A **recursion point is a `for` binding whose list is a one-element array of the props** (`[{ "node": ($.k) }]`),
  rendering template 1, whose `item` is `$p<tid>` (the props object) and whose key is constant (`() => 0`).
- Inside the definition, loop names are renamed (`k$2`, `$i2`) so they cannot capture the caller's (`ComponentScope.runtime: 'all'`).
- Runtime (app.ts:1241, 1312, 1438, 1059): `setRow` puts the props under `$p1` and also `$pp` (for `shareTemplates`'
  merged subtrees); `reconcile` keeps a definition's row when `sameProps(old, new)`; a force from above stops at a
  `$p…` row unless its props changed. So a shared definition costs, per tree node, one anchor pair, one row
  instance (`Object.create` scope), one clone of the head template and one `find`, plus a props-array allocation
  per evaluation. The prefix `$p` is semantically load-bearing; the number is not.

### Worked example 4 (supporting): one stateful component, three uses (live, constant, in a loop)

`x-toggle` = `<div data-sn-state="{ open: false }"><button data-sn-on-click="open = !open" data-sn-text="title">
</button><p data-sn-show="open" data-sn-text="title + '!'"></p></div>`; uses `{ title: u.name }`, `{ title: 'fixed' }`,
and `{ title: r.t }` in `r in u.rows`:

```
roots: div sid0 id0 | button id1 [text f1 d[6], on f2 w[11]] | p id2 [text f3, show f4]
       div sid1 id3 | button id4 [on f5 w[15]]               | p id5 [show f6]          <- constant use: no text bindings
       # id6 [for f7 x0]
template 0: div sid2 path[0,0] | button path[0,0,0] [text f8, on f9] | p path[0,0,1] [text f10, show f11]
fns: 0 ({ open: false }) (shared by all three: dedupe by code)
     1 ($.$r.u.name)  2 {$.$s0.open = !$.$s0.open}  3 ($.$r.u.name + '!')  4 ($.$s0.open)
     5 {$.$s1.open = !$.$s1.open}  6 ($.$s1.open)
     8 ($.r.t)  9 {$.$s2.open = !$.$s2.open}  10 ($.r.t + '!')  11 ($.$s2.open)
html: <button data-sn="4">fixed</button><p data-sn="5" hidden="">fixed!</p>
```

## 2. What is identical across uses, up to numbering

Side by side (example 4; the same holds for example 1):

| component expression | use 1 (live, page) | use 2 (constant) | use 3 (in a row) |
| --- | --- | --- | --- |
| `data-sn-state` | f0 `({ open: false })` | f0 (shared) | f0 (shared) |
| `open = !open` | `{$.$s0.open = !$.$s0.open}` | `{$.$s1.open = !$.$s1.open}` | `{$.$s2.open = !$.$s2.open}` |
| `data-sn-text="title"` | `($.$r.u.name)` | *gone: `fixed` in the HTML* | `($.r.t)` |
| `data-sn-show="open"` | `($.$s0.open)` | `($.$s1.open)` | `($.$s2.open)` |
| `title + '!'` | `($.$r.u.name + '!')` | *gone: `fixed!` in the HTML* | `($.r.t + '!')` |
| nodes | roots, `id` 0–2, `p` 0 | roots, `id` 3–5, `p` 3 | template 0 nodes, `path`s, `p` 0 |
| deps | `d:[6]`, `w:[11]` | `w:[15]` | `w:[19]` |

So the per-use output is **not** "the same up to numbering". To make a cached per-component fragment emit
byte-identical output, a use would have to patch:

1. **Ids in markup and IR**: `data-sn` ids (document order of the *expanded* DOM, `nextId`), anchor comments
   `<!--sn N-->`, head template ids `sn-t-N` and `$i<N>`/`$p<N>` names, state ids `$s<sid>` (in code, paths and `sid`).
2. **Function indices**: the table is deduped by code and numbered by the order of `fn()` calls in the walk, then
   compacted *in that order* (compile.ts:1749, :1956). A use whose code coincides with earlier code reuses its index;
   a use's functions interleave with the caller's (example 1: f1 the caller's `a++`, f2–f3 the component's, f4 the
   caller's again).
3. **Names inside code**: the props are substituted textually (`label` → `('A')`, `n` → `$.$s0.a`, `title` → `$.r.t`),
   state names `$s<sid>`, loop names renamed per definition (`k$2`), and `make` functions inline those bodies again.
4. **Dependency paths**: `d`/`w` come from the substituted expressions (`$r.u`, `$s0.**`), so the path trie differs.
5. **Which bindings exist at all**: a constant prop makes the binding a build-time constant: `prerender` writes it into
   the HTML and `dropConstants` removes the binding, its function and possibly the node's `data-sn` id; a decided
   `data-sn-if`/unrolled loop inside the component changes its markup (pass 2). This is per use and depends on the
   whole page's writes (state nothing writes is constant, `fixedState`).
6. **Placement**: a use at page level emits roots with ids; the same component in a row emits template nodes with
   paths into the row's content, and makes the row template's `find`/`make` code (which is a function of the whole
   row's node list). `p` indices are positions in the enclosing list.
7. **Diagnostics and check frames** are per use (§5, §7).

What *is* invariant per component (inference from the examples): the markup skeleton before folding, the binding
kinds and their order per element, the expression ASTs with prop/state/loop names as holes, and the component's own
literal code (state initialisers dedupe to one function). A "compiled once" component must therefore be a
*parameterised* unit (holes for props, ids, sids, a fold step per use), not a frozen fragment — unless the output
contract changes so instances read props from a scope object as shared definitions do (`$p<tid>`), which is not
byte-identical to today.

## 3. The runtime side: which numbering is load-bearing

- **Roots are found by one TreeWalker pass** over elements and comments (app.ts:918–927): an element's `data-sn`
  attribute, or a start comment `<!--sn N-->` (`isStart`, app.ts:443). Ids are checked against the IR's `tag`
  (`nameOf`, warn on mismatch or duplicate). The *values* are arbitrary (example 1 first run had ids 2 and 4 only,
  gaps are fine) but must be unique and agree between markup, `roots[].id`, and the early IR.
- **Order of `roots` is load-bearing**: `bindNodes` (app.ts:1009) walks `defs` in order and resolves `p` (index of
  the enclosing state node, must come first); `resources[].scope`/`syncs[].scope` index into `roots`.
- **Templates by index**: `tplOf(tid)` = `document.getElementById('sn-t-' + tid)` (app.ts:1521); bindings' `x`/`z`/`c`
  are indices. Must agree; values arbitrary.
- **Template nodes by path**: `find` (compiled straight-line, `findCode`) or the generic path walk (app.ts:1563ff,
  anchors count as one node each, early-rendered extents are skipped). Paths are structural, determined by the head
  template's content after `anchors()` normalises text nodes.
- **Names**: `$i<tid>` is matched against path segments `{$i<tid>}` to find which rows a write reaches (app.ts:661, 762);
  `$p` prefix on `item` marks a definition row (app.ts:1059, 1244, 1312); `$s<sid>` is the state's scope key
  (app.ts:1017) and the persist/testing key. Numbers arbitrary, consistency required.
- **Function indices**: arbitrary; only the IR's references matter. The path trie `ps` is order-independent.
- **Row creation**: clone `content` (or `firstChild` with `o`), then `make(first, scope, writers)` for simple templates
  (`sm`), else `find` + per-binding objects; wrappers (`a`) and text runs (`tx`) clone nothing (app.ts:1528–1600).

Conclusion: no runtime structure knows about components except definitions (`$p`) and `cmp` bindings (scripts).
Everything else is numbering the runtime needs only to be *consistent*; byte identity is what pins it to today's
walk order.

## 4. Callers and how many compiles a page gets

| caller | call | options of note | reads | needs |
| --- | --- | --- | --- | --- |
| vite `build()` from `transformIndexHtml` (vite.ts:1408, 2036) | `compile` | `pageOptions` (vite.ts:1358: `compileOptionsOf`, locale, urls, axes, page, `prerender:true`, helperValues/fold), `sourcemap: dev \|\| build.sourcemap`, `moduleSrc`, builds: `globCache`, `templates`, `definitions` (unless `SN_NO_LINK`), `check: typecheckOn() && !dev`, `foldLog`, images, styles, minify, fonts, `paintCss`, `early`+`observe`, `embed`, `componentCss`, `swapList` | nearly every `CompileResult` field (vite.ts:1428–1446, 2041–2093) | full |
| vite, after `images.analyze` (vite.ts:2038) | `compile` again | same | same | full (a second full compile per page with new images) |
| vite `describe()` (vite.ts:1068) | `compile`, `describeOnly: true` | no prerender; `definitions: describedDefinitions` from `LINK_DESCRIPTIONS` = 8 entries (vite.ts:227); per template one description (`entryDescription`, :708) | `prefetch`, `path`, `prefetchOff`, `permanent`, `keptSource`, `keptBound`, `swapOff`, `loadEffect` | a part: no HTML (json not serialised, quiet definitions skipped: compile.ts:4232) |
| vite `describeSource()` (vite.ts:1083) | `compile` | no prerender, no describeOnly | `.path` only | a part, compiled in full (inference: could be `describeOnly`) |
| vite `templateOf()` (vite.ts:906) | `compile` | `prerender:true`, locale, axes | `pages`, `axes`, SN340/341 | a part |
| vite `buildStart` (vite.ts:1666) | none | clears `templates`, `definitions`, `describedDefinitions`, `templatesKept`, `globCache` | — | — |
| `sinter check` (cli.ts:76) | `compile` | `checkPageOptionsOf`, `check:true`, helperValues | `diagnostics`, `check` | full walk + check unit |
| `checkPage` (check/index.ts:251) | `compile` | `compileOptionsOf`, `check:true` | same | same |
| LSP `compilePages` (lsp/workspace.ts:272) | `compile` | `check:true`; a component no page uses is compiled through a synthetic use `<x-name></x-name>` at `.sinter-use-<name>.html` | `files` (includes), `globs`, `diagnostics`, `check` (hover/completion/extract read `unit.exprs`/`frames`) | full + check |
| LSP `trial` (workspace.ts:309) | `compile` | `check:true`, trial helpers | error diagnostics in one file | full |
| testing `render()` (testing/index.ts:553) | **`compileParts`** (not `compile`) | `dev: options.dev ?? true`, `prerender:true`, `lazy:true`, helperValues, optional early/css/minify | `html`, `ir`, `fns`, `features`, helpers, namespaces, calls, scripts, lazy, early, remote, fixedState, diagnostics | full `CompiledParts` |
| `render-cli.ts` | via testing `render()` (render-cli.ts:597, 650) | | | |
| golden / many compiler tests | `compileParts` / `compile` / `pageModule` | | | |
| `scripts/size.mjs` | `compile` (minimal page) | | module | |
| prerender-build.ts, prefetch-build.ts, early.ts | do not compile | consume `loadEffect`, `PrefetchParts`, the early module/`EarlyIR` | | |

Compiles per page in a build (non-template page with something constant to decide): `describe` (1, describeOnly;
often several pages share linked definitions), `describeSource` (1 per source page where called), pass 1 + pass 2
(`compilePasses`), ×2 again if `canonicalOnly`, ×2 again after `images.analyze`. A `<html data-sn-for>` template: one
`templateOf` compile, one `keepTemplate` walk (+1 checked), then per entry only `decideFor` + pass 2 (`fromTemplate`).

Notable (from the code, not measured): **with `typecheck` on (the default when TypeScript is installed), every build
compile has `check: true`, and `definition()` does not link when `this.check` is set** (compile.ts:4778: `if (!cache
|| L.depth > 0 || L.off || this.check || this.opts.dev) return this.compileDefinition(name)`). Pass 2 also gets
`check:true` and builds a unit that `compilePasses` throws away (compile.ts:1068–1071). Dev never links.

`compileOptionsOf` (project.ts:322) is the project-level part (root, helpers, actions, config, readFile, listFiles,
openapi, apis, complexity, expansionLimit, componentNames, libraries, lazy, static/swap per file);
`checkPageOptionsOf` (project.ts:340) wraps the plugin's `pageOptions` for check and the editor.

## 5. Type checking

- `expr()` (compile.ts:5820) calls `recordExpr` (compile.ts:6122) for every expression it compiles, **so a component's
  markup is recorded once per use**: example 1 with `check: true` gives frames 1 and 2, both `{ kind: 'props',
  component: 'x-counter', type: { kind: 'ts', text: '{ label: string; n: number }' } }`, and the expressions
  `label + ': ' + n` and `emit('bump', n)` twice at the same `x-counter.html:1:126`/`:177`, one per frame.
- The shadow (check/shadow.ts:290) declares a props frame as `/** @type {<declared props>} */ const $props = $any;
  const { label, n } = $props;`: **each copy is checked against the declared props, not the use's inferred types**.
  The component's expressions' frames hold only the component's own frames (props, its state, loops, lets, guards
  inside it), not the caller's (example: frames `[1]`, not `[0, 1]`).
- The use is checked on the caller's side: `data-sn-with` against the props (compile-time SN313 for unknown or missing keys;
  with `check`, `typeLast({ returns: Pick<Props, given> & Partial<Props> })`, compile.ts:4171–4179), `data-sn-on-<event>` gets `detail` from `data-sn-emits`
  (compile.ts:6143), slot fills see `$slot` typed by `Slot<T>`.
- Per page: `units` map by file in vite (vite.ts:2061), one `tsc` run at `generateBundle` over all units; a template's
  unit once per template (`t.typed`, compile.ts:1043); pass 1's unit is the one kept (an unrolled loop has no loop
  variable in pass 2).
- Duplicated TS errors: `parseTsc` (check/index.ts) does not dedupe; each copy maps to the same component position
  (inference: a type error inside a component used N times is reported N times by `sinter check`). The LSP dedupes
  on publish by `file\0line\0col\0code\0message` (workspace.ts:327).

"Check each component once per build, and each use's `data-sn-with` against the props" would lose, as far as the
code shows: (a) the per-use duplicates (likely a gain; but diagnostics would change, so not byte-identical for the
`sinter check` output); (b) the `(included from …)` chain each copy carries in its `loc.chain`, so the message names
the use; (c) `guard` narrowing from a caller's `data-sn-if`, which does not reach the component frames anyway; (d)
SN538 for a `<sn-component use>` candidate is per use site and stays on the caller's side. Inference: nothing
semantic, because the props are typed by declaration. A use's types never flow into the component's body today.

## 6. The test oracle

- `scripts/baseline.mjs`: builds 7 apps (examples, e2e/swap-csp, a typecheck fixture, a generated axes app) with
  `dist/` and compares every emitted file's hash with `test/baseline/<app>.json`; `--record`, `--keep`, `--only`.
  Manual (`npm run baseline`), not in CI.
- `scripts/size.mjs`: size budgets (min+gzip) per page, `--check` in CI; not an identity check.
- CI `link-audit` (ci.yml:56): the whole vitest suite with `SN_LINK_AUDIT=1` (+ `SN_LINK_AUDIT_LOG`). The hook is in
  `compile()` (index.ts:42): each compile runs plain, then three times through one `definitions` cache (seen,
  recorded, linked), then under another name and folder; `differs()` (index.ts:54) JSON-serialises whole
  `CompileResult`s (Maps/Sets as arrays, functions as `[fn]`) and throws at the first differing offset.
- `test/compiler/link.test.ts`, `link-review{,-2..-5}.test.ts`: scenario pages compiled in rounds through one cache,
  each compared with itself compiled alone; `link-fields.test.ts` classifies every `Compiler` field (`LINK_FIELDS`,
  `compilerFields`, compile.ts:977) and will have to change with any new front half.
- `test/compiler/golden.test.ts` + `golden/`: snapshot of `compileParts` output for a few pages.

**Gaps of the existing audit**: it is skipped for `dev` and `check` compiles (index.ts:42), and it is in `compile()`,
so it never sees `compileParts` callers: testing's `render()` (dev by default, about 100 test files import testing),
golden tests, `pageModule` tests.

**Cheapest reliable oracle for a new front half** (proposal): an env switch, say `SN_FRONT_AUDIT=1`, in
`compileParts` (compile.ts:944), which compiles with the old and the new front half and compares the two
`CompiledParts` with the same `differs` serialiser (move it from index.ts; `CompiledParts` holds a `Map` in `json` and
`early`/`check` objects, all plain data). Put it in `compileParts`, not `compile`, so render(), golden and every
`compile()` caller go through it, and do not exclude `dev`/`check`/`describeOnly` (those are exactly the modes a new
front half is likely to get wrong). The finer hook is one level down: in `compilePasses`/`fromTemplate`/`keepTemplate`
where `new Compiler(opts).run(html)` is called, so each pass is compared separately (then a pass-1 difference is not
masked by pass 2's decisions); options there already carry `decided`/`unrolled`/`constants`. Run it as a second CI job
like `link-audit`, with `SN_NO_LINK=1` while the new front half does not link. Plus `scripts/baseline.mjs` before
merging (builds exercise `templates`, `definitions`, images, minify, early, typecheck on vite-i18n), and one
benchmark build per `bench/collections` shape as compile-once.md's "Work left" prescribes.

## 7. Verdict: hard requirements for a drop-in, and what makes "compile once, emit per use" hard

Requirements (each is visible in `CompiledParts` and therefore in the oracle):

1. **Numbering in walk order of the expanded page**: `data-sn` ids, template ids (before compaction), sids, use ids,
   action indices, and the *order of `fn()` calls* (the function table is numbered by first call and deduped by code;
   compaction keeps that order). Emitting a component's functions from a cache means replaying its `fn()` calls at
   the right moment of the caller's walk, interleaved with the caller's own (caller handlers on the tag, slot fills).
2. **Code text identical**: props inlined with today's parenthesisation, state as `$s<sid>`, loop renames, `make`
   inlining, `groupStyles` merges, `$i<id>` renames after compaction.
3. **Folding per use**: constant props/state/loops (pass 1's worklist decisions keyed by `instKey`, the expansion
   budget SN536 across trees, `prerender`, `dropConstants`, `fixedState`). A use is static or live depending on the
   whole page's writes, so the "emission" of a use is a function of the cached unit *and* the page's decisions.
4. **Diagnostics, in order and duplicated**: an error inside a component is reported once per use, in document order,
   interleaved with the caller's (ex4: SN201, SN401, SN201, SN401, SN313, SN201, SN401), each with `(included from
   <use>)` / `… used at`; some codes are reported once (`once()`: SN312 appeared once for three uses). Late
   diagnostics (`lateDiagnostics`, after the evaluation) and pass interplay (`clean` decides pass 2) must match.
5. **Source maps**: `FnSources` per function = the site of the *first* `fn()` of that code (`fnAt`, `codeAt`: code →
   first expression site; compile.ts:5749), `parts` for `make`'s inlined bodies; with identical code in two uses the
   map points at the first. Dev's `at` maps per binding use `callAt` (the latest `fn()` of that index: the use's own
   place) and nodes' `src`. A cache must keep per-use sites even when the code dedupes.
6. **Dev extras**: `dev` feature, `data-sn-c` on roots, `src`/`at` in the IR, no `compactTables` (dropped slots stay
   `'0'`), no `shareTemplates`. Testing runs in dev by default.
7. **`describeOnly`**: quiet definitions skipped, no JSON; only description fields must match (but the oracle compares
   everything, so the whole `CompiledParts` of a describe compile must match too, or the oracle must narrow).
8. **`check`**: a per-use `CheckUnit` (frames per use, exprs per use with their `loc.chain`), `broken` exprs for the
   editor's completion, `exprsOf` per element for `typeLast`; the editor's synthetic-use compile of a lone component.
9. **The kept walk** (`fromTemplate`: `walkPage` once, `decideFor` per entry, `sameProgram`) and the linker
   (`definitions`, link.ts) are built on the `Compiler`'s fields; a new front half either reimplements
   `entryProgram`/`sameProgram`/`decideFor` or keeps the old path for them.
10. **Templates' HTML**: head templates placed by `placeTemplates` (head when the early file renders them, else end of
    body), `o`/`w`/`a`/`tx` flags derived from the content after `anchors()`.

What makes "compile a component once, emit per use" difficult, in order of weight:

- **Props are a macro, not a parameter** (§2): the per-use code, deps, and *which bindings survive* depend on the
  use's prop expressions and on page-wide constant analysis. A cached unit has to be an expression-level template with
  holes plus a fold step per use; only definitions (`$p`) read props at runtime, and switching ordinary uses to that
  model changes the output (not byte-identical: new templates, new `$p` scope, different runtime cost).
- **Global, order-dependent numbering** (ids, fn table dedupe across caller and component, `codeAt` first-site), which
  compile-once.md's linker found fragile enough to drop renumbering altogether and key plans by the page's numbering.
- **Per-use diagnostics and check frames** whose order and text must replay.
- **Two passes** whose decisions are keyed by instance (`instKey`), and the template/linker caches tied to `Compiler`.

Easier than it looks: the runtime does not care about any of the numbering beyond consistency (§3), and `CompiledParts`
is a closed, serialisable contract with an existing comparison routine (`differs`), so an oracle at `compileParts`
is cheap to add. A realistic plan (inference) is to keep `finishPage` (the back half) as is and replace `walkPage`'s
expansion + walk with a per-component cached *analysis* (parsed tree, expression ASTs, binding plan, diagnostics
templated by use) that still emits into the page's tables in walk order, so numbering, dedupe and source sites come
out as today.
