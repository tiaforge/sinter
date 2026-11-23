# Embedding only what the browser reads of build-time data

Running log (2026-11-23). A page's build-time data (a `file:` resource, a `content:` collection, the entry of a page
per entry, an axis's item) that some code left for the browser reads was embedded whole, as
`<script type="application/json" data-sn="N">`. On the benchmark's live post (bench/astro, `live`) that was the
post's whole markdown source and its path on disk, 8,481 of the page's 20,345 bytes, for a module that read
`post.slug` once, in the comments resource's URL. Now, in order of preference:

1. **Fold.** A read of such a value down to a small primitive is that value's literal in the code. When every read
   folds, nothing reads the resource and it leaves the page (`dropFiles`), JSON script and all.
2. **Prune.** What cannot fold (an object or a list read at run time, a computed key, a long string) is embedded
   with only the paths the code reads.
3. **Whole.** Whatever can take the value whole keeps it whole, as before.

## The mechanism as found (53942ea)

- `fileResource`, `contentResource`, `entryResource` and `axisResource` read the value at build time and record it
  in `fileData` (`id`, `value`, `fields`); the resource is `{ src: [], data: id, fx: 1 }` in the IR.
- `fileScripts` puts an empty `<script type="application/json" data-sn>` per entry into the head while the page is
  walked; `fileJson`, at the end of `finishPage`, fills the ones still in the page with
  `d.fields ? pickFields(d.value, d.fields) : d.value` (`compileParts` writes the JSON).
- `fileConstant`/`fileConstants` make the value a constant of the build-time evaluator, so bindings over it fold and
  `dropConstants` drops them. `dropFiles` then removes a resource that no function left for the browser names
  (`$.$r.<name>` in their text), its script with it.
- The only pruning was `fields="a,b"` (`fieldsOf`, `pickFields`): written by hand, the fields of each entry of a list
  or of the object, required (SN344) for a `content:` collection the browser reads. Nothing inferred what was read:
  `docs/proposals/collections.md` left "inferring `fields` from member accesses" to future work. So a resource that
  any code still read was embedded whole.

## Found on the way: a `file:` value was never stored in a build (fixed)

Since 712fbd8 (URL templates compiled to code, `u`) the runtime resolves every resource's URL with `fns[def.u]` to
store its embedded data (`createLoader`'s `start`). The compiler gives `u` only to a resource with a `src`; a `file:`
resource has none, so `resolve()` threw (caught: `warn(17)`), the embedded value was not stored, and every run-time
read of a `file:`, `content:` or entry resource saw `null`. In the benchmark's base build the comments request was
never sent (the URL read `post.slug` of `null`). The behaviour tests did not see it: their reads fold at build time.
Fixed in the compiler: a constant gets `u` too, `($) => ""` (finishPage's URL loop). The browser test below would
fail without it.

## The rule implemented

### Fold (second pass, `PageInfo.folds`, expr.ts `foldOf`)

- `Compiler.foldValues()` (first pass): each `fileData` resource with its value as the browser reads it (`fields`
  applied, then `select`), unless something can change it: a write to `$r.<name>` or `$r.*` in any binding's,
  action's, resource's or event's `w` (after `applyAliases`, which marks every resource a write through an untraced
  alias may reach), a store call that names a resource (`$f.merge|upsert|remove(` in the compiled code: any of them
  disables folding on the page), or an `<sn-event>` feeding it (`page.fed`). Not in dev, and not in a description
  (`describeOnly`: the build gives one entry's description to every entry, `entryDescription`, so what it requests
  ahead must not hold one entry's values).
- The second pass gets them as `CompileOptions.folds`; the compiler puts them in `PageInfo.folds`. In `visitChain`,
  `foldOf` follows the member chain from a name that resolves to such a resource (`resolveQuiet(...).kind ===
  'resource'`: a local, a loop variable or a let of the same name does not) while each member is a fixed key that the
  value has as its own property, through plain objects only (not into a list). Where it reaches a primitive that
  `foldsInto` accepts, that member is recorded; `visitMemberParts` replaces it with the literal through `emitName`'s
  `let` case, as a let's or an unrolled row's value is pasted (`rowLets`: `(${jsLiteral(v)})`), and the chain adds no
  dependency. The rest of the chain applies to the literal (`post.slug.length`, `post.title.toUpperCase()`). Not the
  method of a call (`post.slug()` has `post` as receiver), not an assignment target (those never reach `visitChain`).
- **Size rule** (`FOLD_STRING`, `foldsInto`): `null`, booleans and finite numbers always; a string of at most 120
  characters (a slug, a title, a date). A longer string (a body) is read from the embedded value instead, so that a
  long text read in several places is not written into the module once per read. The bound is per read, not per page:
  a 120-character title read in five places costs five copies in the module, ≤ 600 bytes, against embedding it once
  plus the reads; above that the JSON wins.
- **When there is a second pass.** A page that had one (something decided or unrolled) folds in it. A page that had
  none gets one only when it would fold something: `foldGain` runs `resourceReads` (below) over the first pass's
  functions and asks whether some read reaches a foldable primitive, with the same walk as `foldOf`; then
  `compilePasses`' `second()` runs with the folds and nothing else new. A kept template (`fromTemplate`) folds in the
  second pass it runs anyway (the entry's value is applied there, `c.foldValues()` after `decideFor`); its first pass,
  shared by the entries, is unchanged (no fold happens in a first pass, so `sameProgram` still compares programs
  without entry values in them). A template whose entries have nothing to decide goes the usual way (`compilePasses`),
  which folds per entry.
- **Component scripts** (`foldsEscape`, after the second pass): a script can change an object its props give it, and
  a folded literal would then differ from the page's value. The script's props are its `cmp` binding's code. If a
  `cmp` binding is left in the page and its code reads a folded resource, `$r` whole, or anything else a prop can
  hold an object from (state, a row, a shared definition's prop: any `$.<name>` but `$r`, `$meta`, `$url`, `$now`,
  `$locale`), the second pass is compiled again without folds (and when the folds were the only reason for it, the
  first pass's result stands). Checked on what is left: on the benchmark `<md-view>`'s script is in the first pass
  but not in the page.

### Prune (`fileJson`, embed-reads.ts)

- `resourceReads(codes)` parses each function left for the browser (the page module's, not `'0'`, and the early
  file's) and finds every `<x>.$r` member. From there it climbs the member chain while each member is a fixed key
  (`.k`, `["k"]`, `[0]`), through `?.`; the path is where it stops. A method call takes the receiver whole (the last
  key is dropped), so `post.title.trim()` reads `post.title`. Any other use of the value at that point (an argument, a
  spread, `in`, an identity comparison, a loop's list, a computed key, a return value, a state field's initializer)
  reads the subtree there whole. `$r` itself whole, by a computed name, `$r` as a bare identifier (destructured), a
  write, or a function that does not parse: every resource whole (`{ all: true }`).
- `prune(value, paths)`: a plain object keeps the keys some path names, in their order, each pruned to the rest of
  its paths; what a path ends at, a list, a string or any other value is kept whole. A key no path names is left out.
  So the result is always a subset of the value (fewer keys at some depths).
- Applied per resource in `fileJson`, after `pickFields`, unless: dev (its modules are replaced while the page
  stays, so a later module may read a field this one did not; HMR and the devtools keep the whole value), `select`
  (the code reads below the select path, embedded is the whole file), a stream feeding it, or anything writing to
  `$r` (writes to a build-time resource are errors anyway: SN205 for an assignment, SN332 for `merge`/`upsert`/
  `remove`/`refresh`/`page` on one).
- **Lists are kept whole.** A `file:` glob or a collection that a run-time loop reads is read through the loop's
  variable (`$.p.title` in the row's code), which `resourceReads` does not follow to its list: the loop's `for`
  binding reads `$r.posts` whole. Pruning each item to the fields its rows read needs the row variables followed
  through templates, nested loops, components and `$slot`; not done. A list of a page per entry's own pages is not
  read at run time at all in the benchmark (only the entry is). `fields="…"` still prunes a list by hand.

No new `Compiler` field (so nothing for `LINK_FIELDS`): `foldValues`, `foldGain`, `foldsEscape` and `embedReads`
are methods over what the compiler holds; the folds travel as a compile option (`CompileOptions.folds`) and in
`PageInfo.folds`, which every unit shares as it shares `page`.

## Why this analysis

The brief asked for the dependency paths the compiler already trusts (`b.d`, `reads`, `stateReaders`). They do not
cover this: `b.d` is kept for bindings and resources only (handlers, state initializers, `make`, URL functions and
component props have none of their own reads in the IR), `reads` is "what an expression is about" for SN501 and the
checker, and `fixedDeps`/`dropFiles`/`stateReaders` work on the compiled code's text. What runs in the browser is
exactly the function table, and expr.ts writes every read of a resource as `$.$r.<name>` (`emitName`). So the read set
is taken from the functions' syntax trees (acorn, `parseExpression`, as `fixedScheme` and `earlyRender` do), not
from their text: the same code that ships, the early file's included, after every pass that drops or folds a
function. The fold itself is in expr.ts, at the place the code is written, with the pasting `rowLets` and lets use.

## Escape cases and how each is detected

| case | detected by | result | test |
| --- | --- | --- | --- |
| passed to a helper `fmt(post)` | `resourceReads`: chain ends at an argument | whole | embed-fields compiler test |
| spread `{ ...post }` | chain ends in a spread | whole | compiler + Chromium (`spread`) |
| keys / iteration `Object.keys(post)` | argument | whole | compiler + Chromium (`keys`) |
| computed key `post.author[k]` | non-literal computed member | `author` whole | compiler + Chromium (`computed`) |
| identity `post === x` | chain ends in a comparison | whole | compiler test |
| method on it `post.hasOwnProperty(…)` | callee: receiver whole | whole | compiler test |
| held in state, read through the alias (`p = d`, `{ p: post }`) | the handler's / initializer's read of `$r.post` whole | whole, no fold of `p.x` (it is `$.$s0.p.x`) | compiler + Chromium (`state`) |
| request body `data-sn-body="post"` | the body function reads it whole | whole | compiler + Chromium (`body`: the server gets the whole value) |
| `$r[name]`, `$r` whole or destructured | `{ all: true }` | every resource whole | `resourceReads` unit test |
| a component script given it | its `cmp` code reads it whole; folds: `foldsEscape` | whole; folds undone | (sinter-markdown's `<md-view>` in the benchmark: not in the page, folds kept) |
| a slot's data, a component prop | props and `$slot` are inlined as code: their reads are the caller's | as read | constant-trees test (`doc.children`) |
| `$el` code | reads no resource; a resource read beside it is read as any | as read | — |
| persisted state | its initializer reads the value whole | whole | — |
| a write | SN205 / SN332 before any of this; also checked (`w`, `$f.merge…`) | error | compiler test |
| a stream feeding it | `page.fed` | whole, no fold | — |
| the early file | its functions are scanned with the module's | as read | — |
| dev | `opts.dev` | whole, no fold | compiler test |
| `select` | `def.select` | whole | compiler test |

## Consumers of the embedded script, checked

- **The runtime's store** (`createLoader.start`, `store(data.v, request(url))`): stores the value as it is. For an
  object (no `key`) nothing reads its keys; a list keeps its keys because lists are kept whole. `$meta` is not data.
  `fx` resources are never loaded, refreshed, cached (`back.ts never()`), prefetched (prefetch.ts only writes
  resources with a loader URL) or restored.
- **The early script** (`src/early.ts` `json(id)`, `embedded(emb)`): reads `$r.<name>` through its own functions,
  which `fileJson` scans with the module's.
- **First paint / `render()` / `sinter render`**: run the page module in a DOM; same functions.
- **The server layers** (src/server.ts `split`, packages/sinter-axum, packages/sinter-aspnetcore): they fill the
  empty placeholders `embedSlots` lists (`sinter-embed.json`); a `file:` script is filled at build time and is not in
  the manifest (`embedSlots` skips `fx`). They neither produce nor read it.
- **Swaps** (swap-run.ts): the next page mounts its own module over its own document's head, reading its own
  embedded data; nothing carries a page's store to the next. Kept (`data-sn-permanent`) elements are taken over by
  the next page's code with that page's values.
- **Next-page data** (`prefetchParts`, vite's `entryDescription`): descriptions are compiled without folds, so the
  description of one entry is still every entry's.
- **The dev server**: dev keeps the whole value and folds nothing (`opts.dev`), so HMR, which replaces the module and
  keeps the page, and the devtools see the value as before.

## Weight

`node scripts/embed-audit.mjs --before <53942ea, built>`: each app built with 53942ea's dist and with this branch's,
each in a process of its own, the `dist/` trees compared file by file (hashes in names left out). A changed file must
be a page that embedded build-time data before, or a script such a page loads; each embedded value after must have
the same id as one before and be a subset of it (`subset`: fewer keys at some depth). sinter-mail's audit pages:
`mail-audit.mjs --keep` with each checkout (53942ea's own script against a copy of sinter-html linked to it), then
`embed-audit.mjs --compare` of both routes' trees.

| app | pages changed | HTML before | HTML after | JSON script before | JSON after | JSON script after | page module before | after | early file before | after |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| bench `live` (100 entries, mean a page) | 100 of 101 | 20,461 | 11,873 | 8,589 | 0 | no | 1,808 | 1,707 | — | — |
| bench `live`, `blog/post-1.html` | | 20,345 | 11,811 | 8,481 | 0 | no | 1,807 | 1,704 | 484 | 285 |
| bench `live-files` | 0 of 201 | | | | | | | | | |
| bench `static`, `static-files` | 0 | | | | | | | | | |
| examples: static-site, multilingual-site, dashboard, realworld | 0 | | | | | | | | | |
| sinter-mail audit pages (16, both routes) | 0 of 42 files | | | | | | | | | |

The whole `dist/` of `live` goes from 2,326,560 to 1,437,370 bytes. Every other app is byte-identical: none of their
pages reads build-time data at run time (their bindings over it fold, `live-files` writes the slug as a literal
already), so neither the fold nor the pruning nor the URL fix (`u`, only for a constant still in the page) reaches
them. The `live` page's module loses `post`'s resource and reads the literal (`[\`post\`,\`post-1\`]`); its early
file now requests the comments itself, as `live-files`' does (the URL is a constant now), instead of carrying the
rows' renderer. Every one of the 100 modules carries its own slug (checked by `grep`, one per file).

No page of these apps exercises pruning (rule 2) without folding: the compiler tests and the Chromium test cover it.

## Tests

- `test/compiler/embed-fields.test.ts`: the benchmark's case (no JSON, no `post` resource, the literal in the URL),
  folds of numbers, nested fields and methods; a long string pruned to itself; an object read whole, a computed key,
  a nested list; a glob read by a loop (whole); each escape case (whole); a write (SN205); `select`, dev;
  `resourceReads` and `prune` on their own.
- `test/vite/embed-fields.test.ts`: a build and Chromium. The page per entry with live comments: no JSON script, the
  module's URL has `post-1`, the request goes to `/api/comments?post=post-1`, and after a link to the next entry to
  `?post=post-2`. A pruned page, and spread, keys, computed key, state alias and body pages: each shows in Chromium
  what its code reads (the body page: the server gets the whole value).
- Updated: `test/compiler/constant-trees.test.ts` "a node with state of its own…" pinned the embedded tree's start
  `{"type":"doc"`; the page's code reads only `doc.children` (a loop), so the root's `type` is left out. The
  expectation now pins `{"children":[{"type":"heading"`. Nothing else pinned an embedded value.

## Results

- `npx vitest run`: 2,867 passed, 1 skipped; 5 failed in test/check/check.test.ts and test/lsp/lsp.test.ts (time
  limits under load), both files green run alone (one check test, alone again, green).
- `SN_RENDER_AUDIT=1 npx vitest run test/compiler`: one time-limited failure (unroll-limit "a site's own budget"),
  green alone. `SN_LINK_AUDIT=1 npx vitest run test/compiler`: three time-limited failures in link-review files, all
  green alone.
- `node scripts/render-audit.mjs`: "same" for all eight apps.
- `mail-audit.mjs --suite`: identical, 42 files; its typecheck, check (5 pages, 0 errors) and 234 tests pass.
- e2e: navigation, permanent, links, swap-csp pass in Chromium (none reads build-time data at run time).

## Left whole, and why

- **Lists** (a glob, a collection, a list inside a value): a loop reads them through its row variable, which the read
  analysis does not follow; pruning each item would need it followed through nested templates, components and slots.
  `fields="…"` prunes a list by hand, as before.
- **`select`**: the code reads below the selected path; the embedded value is the file. Whole.
- **dev**: whole and no folds (HMR replaces the module, not the page).
- **A page whose component scripts may be given the page's objects**: no folds (pruning still applies: the script's
  props read the value, and what they read is kept).
- **A store call naming any resource (`merge`, `upsert`, `remove`) on the page**: no folds and whole, for every
  resource (they are SN332 on a build-time one, so this is a belt over the braces).
