# Spike: a core per site, without the parts its pages do not use

Status: spike (2026-11-17), on the branch `ccr-609d209b-vp07x6`, behind an option: `sinter({ siteCore: true })` (or
`SINTER_SITE_CORE=1`). It builds on the linking work (`ccr-e552100a-ha1vsv`) and changes nothing in a build without
the option. Recommendation: **take it, on by default for builds, after the tests below run the trimmed core.** It
needs no new attribute and no app change. It takes a quarter off a content site's JavaScript and 0.5 KB off each
RealWorld page.

## The question

The optional features are modules of their own already: a page imports `sse`, `paginate`, `optimistic` and the
others only when its markup uses them (`CompiledParts.features`). The core does not work that way. `mount`
(`src/runtime/app.ts`) is one closure of 1,400 lines, 15.4 KB gzip, and every page loads all of it: lists, branches,
actions, dialogs, models and the resource loader, whether the site has any or not. Can the build leave out the parts
no page of the site uses?

## Measured

Gzip -9 of minified code, as `scripts/size.mjs` counts it (`npm run size`; `SINTER_SITE_CORE=1` for RealWorld):

| | today | site core | |
| --- | ---: | ---: | ---: |
| the core alone, every part on | 15,361 B | | |
| the core alone, every part off (the floor) | | 7,429 B | −52% |
| the minimal page (one resource, one text binding) | 15,567 B | 11,046 B | −29% |
| RealWorld, article | 27,927 B | 27,393 B | −534 B |
| RealWorld, index | 29,703 B | 29,167 B | −536 B |
| RealWorld, login | 24,827 B | 24,296 B | −531 B |
| `examples/multilingual-site`, all its JavaScript | 17,591 B | 13,037 B | −26% |
| `examples/static-site`, all its JavaScript | 17,197 B | 14,077 B | −18% |

RealWorld uses 7 of the 9 parts (all but dialogs and styles), so it gains little. The content sites keep one or two
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
would need the next page's core.

## What it risks

- **A part the IR does not show.** The flags must cover everything a page can reach. The parts were chosen so that
  each one is reached only through the IR: bindings, nodes, actions, resources. What feature modules and the app's
  own code call (`app.request`, `storeFns`, `record`) stays in the floor. `coreParts` is conservative: a handler
  counts as `EVENTS` wherever it is, a model or a dialog adds `EVENTS`, any action adds `ACTION`. Two mistakes were
  caught while writing it and are covered: a branch template can be "simple" too (its handlers bound on their first
  event), and a model listens through the event dispatch.
- **The wait in `load`.** The flags module loads only once every page has compiled. Rolldown transforms the HTML
  entries concurrently, so nothing waits on the core while pages are still compiling. A page whose compile fails
  fails the build, and the wait goes with it. Dev serves the module as written, every part on.
- **Tests run the full core.** The suite (2,186 tests) passes. It runs the core with every part on, so it shows that
  nothing changed without the option. `test/vite/site-core.test.ts` builds a two-page site with the option and with
  it off. It checks that the code of the unused parts is gone and that the used parts' code stays, and it runs both
  pages in Chromium. Before this is on by default, the fuzz tests should also run against cores trimmed to their
  pages' parts. Pages that use more than they declare would then fail there, not in an app.

## Next

- **The request layer as a part** (`createRequestLayer`, `request.js`: 2.9 KB minified, about 1.3 KB gzip of the
  floor). Only resources, actions and the feature modules that send requests use it, but `app.req`, `app.request` and
  `CallContext.request` reach it from code the IR does not show (helpers, actions, islands). It needs a decision on
  what an app module may call.
- **Finer parts where RealWorld spends.** Within `RESOURCE` (3.3 KB): ordering by locale, the optimistic layers
  (`record`), `then`. Within `LIST`: adopting the early script's rows, which only pages whose early script renders
  rows need. Within the floor: `storeFns` (`reset`, `run`, `emit`, `showModal`), which the compiled functions name.
  The compiler knows which of them a page calls.
- **A budget for it** in `scripts/size.mjs`: the minimal page with its site core (11.0 KB now).
- **On by default** in builds, once the fuzz tests run trimmed cores.
