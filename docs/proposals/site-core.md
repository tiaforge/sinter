# Spike: a core per site, without the parts its pages do not use

Status: implemented (2026-11-17), merged after #71 and #72 (the 0.19.0 changelog). **On in every build, with no option**: a build keeps the parts of the core its pages use and
compiles away the rest. Dev serves the whole core. Nothing changes for an app's markup or code. It takes a quarter
off a content site's JavaScript and 0.6 KB off each RealWorld page. The whole test suite, the fuzz tests included,
runs every page on the smallest core for that page.

## The question

The optional features are modules of their own already: a page imports `sse`, `paginate`, `optimistic` and the
others only when its markup uses them (`CompiledParts.features`). The core does not work that way. `mount`
(`src/runtime/app.ts`) is one closure of 1,400 lines, 15.4 KB gzip, and every page loads all of it: lists, branches,
actions, dialogs, models and the resource loader, whether the site has any or not. Can the build leave out the parts
no page of the site uses?

## Measured

Gzip -9 of minified code, as `scripts/size.mjs` counts it (`npm run size`), before this branch and with it:

| | before | site core | |
| --- | ---: | ---: | ---: |
| the core alone, every part on | 15,361 B | | |
| the core alone, every part off (the floor) | | 7,429 B | −52% |
| the minimal page (one resource, one text binding) | 15,567 B | 11,046 B | −29% |
| RealWorld, article | 59,838 B | 59,231 B | −607 B |
| RealWorld, index | 33,323 B | 32,716 B | −607 B |
| RealWorld, login | 27,800 B | 27,193 B | −607 B |
| `examples/multilingual-site`, all its JavaScript | 17,591 B | 13,037 B | −26% |
| `examples/static-site`, all its JavaScript | 17,197 B | 14,077 B | −18% |

RealWorld uses 6 of the 9 parts (all but dialogs, props and styles; props went with #72, which renders the article
body with a component instead of a custom element), so it gains little. The content sites keep one or two
(`RESOURCE`; `BRANCH, RESOURCE`). (`examples/dashboard` installs sinter from npm and does not build with this
branch's markup.)

What each part costs, alone over the floor and as what turning it off saves with every other part on (they share
code, so the two differ):

| part | what uses it | alone | off, the rest on |
| --- | --- | ---: | ---: |
| `RESOURCE` | `<sn-resource>`: the loaders, the shared GET, the store | 3,403 B | 3,325 B |
| `LIST` | `data-sn-for`: reconcile, keys, the early script's rows | 2,177 B | 1,031 B |
| `BRANCH` | `data-sn-if`/`else`, `<sn-component use>` | 1,447 B | 288 B |
| `ACTION` | `data-sn-get`…`delete`, `data-sn-call` | 1,007 B | 869 B |
| `EVENTS` | delegated events: handlers, models, a dialog's `toggle` | 322 B | 644 B |
| `DIALOG` | bindings in a `<dialog>`, which wait while it is closed | 78 B | 441 B |
| `MODEL` | `data-sn-model` | 182 B | 226 B |
| `PROP` | `data-sn-prop` | 98 B | 100 B |
| `STYLE` | `data-sn-style` | 73 B | 74 B |

## How it works

1. **The flags.** `src/runtime/flags.ts` exports one constant per part, all `true`: the core works for any page
   (tests, dev, an app that does not build with the plugin). The core reads them where code reaches a part (about 20
   places: `if (F.LIST && k == 'for') reconcile(rb, v)`, `p: F.PROP ? (el, n, v) => … : undefined`).
2. **What a page uses.** `coreParts(ir)` (`src/core-parts.ts`) reads the page's IR: binding kinds, `dl`, actions,
   resources, `ev`. The compile result carries it (`CompileResult.core`). This works with workers too, since the
   list is plain data.
3. **The union.** The plugin adds each page's parts as the page compiles (`finishPage`). Its `load` hook for the
   flags module waits until every entry of the build has compiled. It then returns the module with the parts no page
   uses set to `false` (`flagsModule`), and logs what it kept (`sinter: the site's core keeps …`).
4. **The bundler does the rest.** Rolldown inlines the imported constants. The minifier drops the dead branches and
   the closure's functions only they call (`reconcile`, `instantiate`, `send`…), then the modules only those reach
   (`store.js` without `RESOURCE`). Checked on Vite 8.3.5.

**Why per site, not per page.** Every page of a build imports the core from one shared chunk. One core per site
keeps that chunk shared: the next page's core is already cached, and a swap (`sinter({ swap: true })`) can mount any
page of the site with the core it has. A per-page core would cost a new chunk per combination of parts, and a swap
would need the next page's core. Measured on RealWorld, a core per page would not pay
either: every page uses the five large parts (lists, branches, actions, events, resources). They differ only by
models (about 230 B: not on the index and profile pages). A page that loaded only its own parts would save at most
about 230 B, once, on the first page of a visit. It would pay for that
with more requests, weaker compression across small files, and a fetch before a swap to a page that needs a part not
loaded yet.

## What it risks

- **A part the IR does not show.** The flags must cover everything a page can reach. The parts were chosen so that
  each one is reached only through the IR: bindings, nodes, actions, resources (and, for the store functions, the
  handlers' code: [finer parts](#finer-parts)). What feature modules and the app's own code call (`app.request`,
  `record`, `app.optimistic`) stays in the floor. `coreParts` is conservative: a handler
  counts as `EVENTS` wherever it is, a model or a dialog adds `EVENTS`, any action adds `ACTION`. Two mistakes were
  caught while writing it and are covered: a branch template can be "simple" too (its handlers bound on their first
  event), and a model listens through the event dispatch.
- **The wait in `load`.** The flags module loads only once every page has compiled. Rolldown transforms the HTML
  entries concurrently, so nothing waits on the core while pages are still compiling. A page whose compile fails
  fails the build, and the wait goes with it. A page of the build that never compiles would hold it forever: when no
  page has compiled for 30 s, the build fails and names the pages it waited for.
- **Dev and the build run different cores.** Dev serves the whole core (it compiles a page when it is requested and
  never knows all of them). A part a page needs but its IR does not show would fail only in a build. The tests
  cover this; see below.
- **The core's hash follows the site.** A page that uses a part no other page did (the site's first `<dialog>`)
  changes the core's chunk, and every page's visitors fetch it again after that deploy. Before, it changed with a
  sinter upgrade. Deploys change chunks often anyway.
- **No sharing between sites.** Browsers partition their HTTP cache by site, so a core is never shared between two
  sites, trimmed or not. The gain is what each site ships, parses and compiles.
- **An app that calls `mount` itself.** Only page modules mount, and the build sees all of them. An app's own module
  that called `mount` with an IR of its own (not documented, and nothing in the repository does) would get the
  site's core.

## The tests run trimmed cores

The test suite does not run the core as written. `vitest.config.ts` aliases its flags module to `test/core-flags.ts`,
where every part is a switchable `let`, off at the start of each test (`test/core-flags-setup.ts`). `mount` calls
`use(ir)` from the flags module, which is `undefined` in a build, so the call compiles away. In the tests, `use` turns
on the parts that page's IR uses, joined with those of pages the test mounted before. The core reads the flags through
its namespace import, so a change applies at once. Every test, then, runs its pages on the smallest core they could
get, which is stricter than a site's union. The page fuzz tests (component, anchor, reactivity, wrapper, minify) reset
the parts for each seed, since each runs all its seeds in one test. `test/core-flags.test.ts` checks that the core does read them: with lists off, a list stops
rendering.

Results: the whole suite passes (2,195 tests), the page fuzz tests at their default seeds included, as CI runs them.
Once, as CONTRIBUTING asks before a pull request: component and reactivity fuzz at 2,000 seeds each (5 minutes),
passed.
`test/vite/site-core.test.ts` builds a two-page site and the same site with a third page (a dialog, an action, a custom
element's property). It checks that the code of those parts is only in the second build, and runs both first pages in
Chromium.

## Finer parts

Added on 2026-11-27, from an audit of what RealWorld's home page ships that none of its pages can reach. Each is
decided like the parts above, in `coreParts`, from the IR or from the page's expression functions (`CompiledParts.fns`,
which the compiler writes and `mount` receives: the tests read them as the build does).

| part | kept when | what goes without it | reached anyway |
| --- | --- | --- | --- |
| `FN_DIALOG`, `FN_ITEMS`, `FN_REFRESH`, `FN_PAGE`, `FN_EMIT`, `FN_RUN` | a handler or an optimistic change names one of the group's store functions (`$.$f.merge(…)` in its code): `openDialog`/`closeDialog`; `upsert`/`merge`/`remove`; `refresh`; `page`; `emit`; `run` | that group of `app.storeFns()` (733 B minified for all six) | a TypeError in the handler (`… is not a function`), which `exec` logs |
| `TEXTRUN`, `SHOW`, `CLASSX`, `ATTR` | a binding of the kind: `data-sn-text` on a `<template>` (a text binding with a name), `data-sn-show`, `data-sn-class` with a computed key (a class binding without a name), `data-sn-attr` or any attribute binding | the writer of that kind (`W.x`, `W.h`, `W.k`, `W.a`; `ATTR` also the scheme check, `security.ts`): 1,172 B minified for all four | a TypeError out of the render (`write` calls the missing writer; a creation function's call falls back to `write`) |
| `KEYED`, `ORDER` | a resource with a `key`; a resource with an `order` (`ResourceDef.key`, `.order`) | the store's keyed collections (by key, arrival order, a key's patches), its sorting by `order` with the collators: 1,628 B minified for both | `createResource` throws at mount (`sinter: xs: no KEYED in this build's core`) |
| `MOVES` | a paginated resource without `model` (`ResourceDef.paginate.model`): keyset, append, a numbered page in memory | the pager's moves by direction and cursor in `src/paginate.ts` (a feature module, which reads its flag as the core does): 1,559 B minified on RealWorld's home page | the pager throws at mount (`sinter: xs: no MOVES in this build's core`) |

Why nothing else can call them. The compiled handlers are the only callers the runtime has: no feature module calls
`storeFns`; the page's `$f` (`app.page.$f`) is the handlers' scope; a component's handlers and its fills are functions of
the page's table, so their code is read with the page's. App code could reach `instance(root).storeFns()`, which the
islands' API never documented ([islands.md](../islands.md#instance-api)). `navigate` and `signOut` are no part: the
package's `navigate()` and `signOut()` call them through `storeFns(null)`. `closePopover` was the `POPOVER` part already.
The writers are called by `write`, for a binding of the IR, and by the templates' creation functions, which the compiler
writes from the same bindings (`makeCode`); the early script has writers of its own. The store's resources are only
the IR's (`createLoader`, for each `ResourceDef`): an app module reads and writes them through `app.resource(name)` but
cannot give one a key or an order. A pager is only a resource's (`ResourceDef.paginate`), and the compiler allows `model`
on a numbered pager only, so with `MOVES` off every move is a page number the URL names. Not a part: the optimistic layers (`LAYERS` was measured: about 0.2 kB gzip more on a page with no
optimistic action), since an island's `app.optimistic()` uses them and no build can see it call that.

## Next

In order of what they save:

- **The request layer as a part** (`createRequestLayer`, `request.js`: 2.9 KB minified, about 1.3 KB gzip of the
  floor). Only resources, actions and the feature modules that send requests use it, but `app.req`, `app.request` and
  `CallContext.request` reach it from code the IR does not show (helpers, actions, islands). It needs a decision on
  what an app module may call.
- **Finer parts where RealWorld spends.** Within `RESOURCE` (3.3 KB): ordering by locale, the optimistic layers
  (`record`), `then`. Within `LIST`: adopting the early script's rows, which only pages whose early script renders
  rows need. (The floor's store functions, which the compiled functions name, are parts now: [finer parts](#finer-parts).)
- **Dev on the site's core.** Dev could serve the union of the pages it has compiled, so that a missing part fails
  there too. But each newly visited page that adds a part would reload the core. Not worth it while the tests run
  trimmed cores.

The size budgets follow the site's core (`scripts/size.mjs`): the minimal page 12 KB (11.0 KB now), with swaps
13.5 KB (12.9 KB). The RealWorld article keeps main's 62 KB (59.2 KB now: its head scripts counted since #70, the markdown
parser since #72).
