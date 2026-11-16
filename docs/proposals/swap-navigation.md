# Proposal: swap navigation and kept elements

Status: draft (2026-11-16). A spike is on branch `ccr-f26a7473-xa5d6s` (`src/permanent.ts`, the dashboard
example, `e2e/permanent`, RealWorld); this text is what the spike taught, and what it got wrong.

Decided with the user:
- **Multi-page stays the stance.** The server picks the page and sends the whole document, as for a page
  load; nothing changes on the server, in embed or in the page's HTML. The client replaces the page in the
  document it has instead of the browser loading a new one. This is not routing: there is no route table,
  no view in the client, and every URL still loads on its own.
- **Opt-in, and nothing changes without it.** A page that does not opt in loads no module and behaves as
  today. A page that does falls back to a page load whenever anything is unexpected.
- **Kept elements** (`data-sn-permanent="name"`) are the first use: an audio player, an open drawer, a
  scroll container stay untouched across a link to a page with an element of the same name.
- **Navigation has one way in: `navigate()`** (review, 2026-11-16). Four parts of the runtime decide
  parts of a navigation today and the spike added a fifth; this proposal trims them to one decision that
  the rest plug into ([2](#2-one-way-in-navigate)).
- **The head is kept simple** (review, 2026-11-16): the title, sinter's own nodes and the stylesheets;
  the rest is for crawlers and link previews, which load each page ([4](#4-the-head)).
- **A later module builds on it:** richer view navigations (directional and nested transitions, shared
  elements, list-to-detail panes). This proposal does not build them, but every choice below is checked
  against them ([Room for view navigations](#9-room-for-view-navigations)).

## Goals

1. **State that must not reset survives a navigation:** media keeps playing, a drawer stays open, a
   scroll container keeps its position, focus and selection in a kept element stay.
2. **A navigation is not an unload:** JavaScript context, open responses and app code's state survive.
   This is what RealWorld's suite assumes after a form's redirect (below).
3. **Nothing to write beyond marking what to keep.** App code redirects with the `navigate()` that
   handlers already have, exported.
4. **A page that does not use it is byte-for-byte what it is today**, and so is the core.
5. **A base for view navigations:** one well-defined sequence with named steps that a later module
   can observe and drive.

## The case

- **The dashboard** (spike): a layout with `<details data-sn-permanent="dock">` holding an `<audio>`
  and a `<textarea>`. Overview → Latency → Back → Forward → Overview is one page load; the same `<audio>`
  element plays on (0.72 s → 1.33 s across the swap), the drawer stays open with its text and scroll
  position; each page's data, stream badge and Pause button work, and one event stream is open at the
  end (five opened, four closed). The build in Chromium, Firefox and WebKit; the dev server in Chromium.
- **RealWorld's settings tests.** In `spa` mode the official suite saves the settings and then reads the
  `PUT`'s response body over CDP, calls `page.evaluate`, and reads the current user at once. A page load
  to the profile drops the body (`Network.getResponseBody: No resource`) and the context (`Execution
  context was destroyed`): four tests, documented as unfixable for a multi-page app
  ([same-page-links.md](same-page-links.md)). With the footer kept on every page, the redirect is a swap:
  the full suite passes against the public API, **140 of 140**; the same build with a page load, **136**,
  the same four failing. The spike needed three more things for it, all in this proposal: no moment
  without a mounted app ([5](#5-the-sequence)), the cache written when an app goes
  ([7](#7-what-the-core-and-the-features-need)), and the app keeping its cache across a redirect within
  the same account (RealWorld's `settings-saved`).

## What the spike showed

| Finding | Where it goes |
| --- | --- |
| The page's code runs once per module URL: going back to a page seen before would show markup and nothing bound. The spike imports `module.js#sn-N` (a fragment is part of the module's URL and never reaches the server; a query broke the dev server's virtual modules with a 500). | [6](#6-the-pages-code) |
| Dev-only modules (Vite's client, the inspector) must not run twice: only the modules the new page does not share run. | [6](#6-the-pages-code) |
| `mount` walks the whole document, head included, and every page numbers its `data-sn` ids and `sn-t-N` templates from 0. Leaving the old head binds the new page to the old page's `<title>`; a head `data-sn-if` meta never rendered and the other page's stylesheet stayed (both caught by `e2e/permanent`). | [4](#4-the-head) |
| Moving an element with `insertBefore` resets its scroll position and drops focus, in every browser; Chromium and Firefox kept them only through `moveBefore`, which WebKit lacks. | [3](#3-kept-elements) |
| The old app's handlers and state stay on `<html>` and `<body>`, which the document keeps (`sinter.on` held two handlers after a swap); only the new one fired, but the old app stayed reachable. The spike deletes `sinter.*` symbols. | [7](#7-what-the-core-and-the-features-need) |
| `cache` writes confirmed changes on `pagehide`, which a swap never fires: RealWorld's profile showed the user from before the save. | [7](#7-what-the-core-and-the-features-need) |
| Between the URL change and the new mount the page had no app (`instance(document)` threw): a test that reads the app right after the URL changes saw `null`. Fixed by preloading the modules and changing URL, app and body in one step. | [5](#5-the-sequence) |
| A view transition skipped by a page load rejects `ready` and `finished`: unhandled rejections. | [8](#8-transitions) |
| A click on a link the browser follows (the page shown) during a pending swap must cancel it: the last click wins. | [2](#2-one-way-in-navigate) |
| **The build dropped the feature** (external review): a page whose only runtime need was a kept element built as "no JavaScript", so the marker stayed in the HTML and nothing read it. Dev always ships a module, so only builds broke; every page the spike tested also loaded data. Fixed: a kept element is a runtime reason (`runtimeReasons`), and `sinter({ static })` reports `SN322` for it; `e2e/permanent` swaps to and from a page with nothing bound. A page that keeps an element and runs nothing else now ships the shared runtime (17.1 KB gzip). | [1](#1-opting-in), [12](#12-size) |
| `data-sn-transition` relies on `pageswap`/`pagereveal`, which a swap does not fire: its morphs are lost (read from `transition.ts`, not measured). The CSS fade (`@view-transition { navigation: auto }`) does not apply either. | [8](#8-transitions) |
| WebKit refuses Speculation Rules prefetches over plain HTTP (console errors, with or without swaps): noise in local tests, not this feature. | — |
| The module is 2.7 KB gzip (min 6.7 KB) with the simpler head (2.9 KB with the first one). My first estimate was "a few hundred bytes", the second 2–3 KB. | [12](#12-size) |

## Design

### 1. Opting in

Two attributes, one feature:

- **`data-sn-navigation="swap"` on `<html>`** (a page's or its layout's): links and `navigate()` from this
  page to another page that also has it are swaps. It holds no element. RealWorld wants this: it kept its
  footer only to turn swaps on.
- **`data-sn-permanent="name"`** on an element: kept across a swap to a page with the same name. It
  implies swap navigation for the page (the spike's only switch).

A swap happens when **both** pages opt in, read from the fetched HTML; otherwise the response is
discarded and the page loads (the one request is not wasted for long: the browser has it in its HTTP
cache only if the server allows it, see [10](#10-prefetch-speculation-rules-the-early-script-and-embed)).

**Both markers must survive the build.** The compiler strips every `data-sn-*` attribute from the HTML;
`data-sn-permanent` is exempt, and `data-sn-navigation` must be too, since the next page's fetched HTML is
where the swap reads them. Each is also a runtime reason, so a page of constants still ships its module
(the external review's blocker, fixed for `data-sn-permanent` in the spike).

Build checks (`data-sn-permanent`, in the spike): a static name (`SN401`), once per page, not inside a
`<template>`, no bindings on or inside the element (`SN102`; the next page's code would not find nodes it
did not number). Proposed: a warning when a name is on one page only; dedicated codes instead of `SN102`.

### 2. One way in: `navigate()`

Today, each of these decides part of a navigation, with its own listener:

| Owner | Links | `navigate()` | Back/Forward | History |
| --- | --- | --- | --- | --- |
| core (`app.ts`) | — | `navigate()`: `ext.follow`, else `env.navigate` (`app.ts:748`); `onUnauthorized` calls `env.navigate` itself (`config.ts:187`) | re-reads `$url` (`app.ts:826`) | — |
| `location.ts` | — | — | its own `popstate` (`:106`) | `pushState`/`replaceState` for `$url` writes |
| `query-links.ts` | its own click listener (`:68`), `ext.sameLink` | replaces `ext.follow` (`:58`) | — | through `location` |
| `transition.ts` | its own capturing click listener (`:52`), to remember the link | — | `pageswap`/`pagereveal` | — |
| `permanent.ts` (spike) | another click listener | replaces `ext.follow` again | another `popstate`, which must run first and stop the others | its own |

and `prefetch.ts` watches links too (pointer events) and has to guess what a click would do
(`ext.sameLink`). Each new navigation feature adds a listener, and their order decides the outcome.

`navigate(url, { replace })` already has the right shape: it is the one entry point with a URL, and
`ext.follow` already makes it a chain, built by replacing a function. It becomes the only decision:

- **`navigate(url, { replace, trigger })`** asks the handlers features register with the core, in order
  (same-page links, then swap), and loads the page (`env.navigate`) when none takes it. Registering
  replaces patching `ext.follow`.
- **Links are calls to it.** One click listener, in a small module the link features share, turns a plain
  click (primary button, no modifier, default not prevented after the page's handlers, an `<a href>` or
  `<area href>` without `download`, a `target` or `rel="external"`) into `navigate(href, { trigger: a })`.
  `query-links` and the swap stop listening; `transition` reads the link from `trigger` instead of
  capturing clicks.
- **One `popstate`.** The core's listener hands a traversal to the same handlers (`kind: 'traverse'`)
  before it reads `$url` again: the swap takes it when the path changed, else the core does what it does
  today. No listener has to run first.
- **Asking without going.** Prefetch asks the chain what a URL would become (`same-page`, `swap`,
  `load`) instead of guessing; it requests the next page's data for `swap` and `load`, and its HTML too
  for `swap` ([10](#10-prefetch-speculation-rules-the-early-script-and-embed)).
- **App code** imports `navigate` from `@tiaforge-ui/sinter` (the page's instance's): RealWorld's islands
  call it instead of `location.assign`, and the core's own `onUnauthorized` redirect goes through it. The
  spike's `visit()` is gone.

The handlers see one **intent** (from, to, kind, trigger, signal: [5](#5-the-sequence)), which is also what a
view-navigation module needs first ([9](#9-room-for-view-navigations)).

A swap is tried for links, `navigate()` calls (with `replace: true`, it replaces the entry) and
traversals across entries a swap made. Everything else is the browser's: the same URL, a `#hash`, a new
tab, form submissions without a sinter action. A click the browser follows cancels a pending swap.

Falls back to a page load: a fetch error; a non-HTML, non-2xx or cross-origin (after redirects) response;
`data-sn-failed`; the other page not opted in; a name on two elements of either page (markup injected
with the attribute); no module to run; heads that differ in what only a load applies ([4](#4-the-head)).
A traversal that cannot swap reloads.

**Spiked** (2026-11-16, step 2 of the plan):
- The core: `Intent` (`to`, `kind`: `push`, `replace`, `traverse`; `trigger`; `peek`), `app.nav` (the
  handlers, in the order features registered them), `app.take(intent)`, `app.navigate(url, { replace,
  trigger })`, and `navigate` exported. The handler `navigate()` is `app.navigate` with its element as the
  trigger; the core's `popstate` asks the chain before it reads `$url`.
- `src/links.ts`: the one link listener, installed once per app by whichever link feature loads it.
- `query-links` is a handler (the same rules; `ext.sameLink` and `ext.follow` are gone); `transition`
  notes the trigger from a handler that never takes and lost its capturing click listener; prefetch asks
  with `peek` and skips what the chain calls `same`; the swap is one handler for links, `navigate()`
  (`replace` too, which it did not do) and traversals, with no listener of its own and no `visit()`.
- Behaviour unchanged where it was not meant to change: the whole unit suite (2014 tests, the
  query-links, transition, prefetch, speculation and navigate suites untouched), `e2e/navigation` in
  Chrome (next-page data, Speculation Rules, the list-to-detail morph and back), `e2e/permanent` in three
  browsers. Five tests of the chain itself (`test/behaviour/navigation-chain.test.ts`).
- RealWorld goes through it everywhere: the islands call the exported `navigate` for signing in and out,
  and `<conduit-redirect>` uses `navigate(to, { replace: true })`; the full suite passes, 140 of 140.
- Sizes (gzip, `scripts/size.mjs`, each module with `links.ts` bundled in): core 14,682 → 14,761 B (+79);
  query-links 770 → 816 (+46); transition 802 → 1,017 (+215: a page with only morphs now carries the
  link listener instead of a 20-byte capturing one); prefetch 1,457 → 1,474 (+17); the swap 2,705 →
  2,761 (+56, lost its listeners, gained `replace`). `links.ts` alone is about 350 B; a page with
  several link features pays for it once.
- Not done: the core's `onUnauthorized` redirect (`config.ts:187`) still calls `env.navigate`. It runs in
  request middleware, which has no app; how it finds the page's app (the one mounted on `document`, or the
  request's) is to decide. `location.ts` keeps its own `popstate` listener: it only resets what waited to
  be written and owns no decision, so it stays an observer.

**To decide:** the [Navigation API](https://developer.mozilla.org/docs/Web/API/Navigation_API)
(`navigation.addEventListener('navigate')` with `intercept()`) as the source of intents: one event for
links, forms, `location.assign` from app code and traversals, with scroll and focus handled by the
browser. It would feed the same chain, so the choice changes where intents come from, not who decides.
Its support across Chromium, Firefox and WebKit must be checked first; the click listener stays as the
fallback either way.

### 3. Kept elements

The new body's content is inserted into the live body after the old content, in one task. Each kept
element then takes the place of its namesake (`moveBefore` where the browser has it: an iframe's document,
focus, animations, scroll survive; else `insertBefore`, and the module restores the element's and its
descendants' scroll positions, focus and selection), and the old content is removed. A playing media
element moved within a task does not pause (all three browsers in the spike).

Kept elements hold no bindings, so nothing of the old app is inside them. **To decide:** a kept element's
*position* in the cascade can change (another parent on the new page); that is the author's to arrange, as
in Turbo. Kept elements in components are allowed when the component's markup has no bindings.

**Injected markup** (security.md: the runtime never acts on injected directives): an injected
`data-sn-permanent` next to the real one makes a name appear twice, which is a page load. An injected one
where the page has none would receive the old page's element. Proposed: the page module lists the names
it keeps with their `data-sn` ids (the compiler knows them), and the swap honours only elements carrying
those ids. That needs the compiler change in [6](#6-the-pages-code) first.

### 4. The head

What a person sees of the head is the title and the styles; the rest (description, Open Graph, canonical,
alternates, Speculation Rules) is for crawlers and link previews, which load each page and never swap. So
the swap changes only:

| What | Why | How |
| --- | --- | --- |
| `<title>` | the person sees it (tab, history, the announcement in [11](#11-accessibility-history-scroll)) | always the new page's |
| sinter's own head nodes: `data-sn` elements (a bound title or meta), `<!--sn N-->` anchors with what they rendered, `<template id="sn-t-N">`, embedded data (`script[type="application/json"][data-sn]`), `script[data-sn-messages]` | not for crawlers: the page's code finds them by number in the whole document, and every page numbers from 0. Left in place, the new page binds the old page's nodes, or renders the old page's template for a row | the old page's removed, the new page's appended, no comparison |
| stylesheets (`<link rel="stylesheet">`, `<style>`) | a page's own CSS (component styles, a page's `<link slot="head">`) must come with it and go with it (`e2e/permanent` caught B's stylesheet staying on A) | by resolved URL (a `<style>` by its text): the new page's that the document lacks are appended and loaded before the swap, the old page's that the new one lacks go with it. Appended, not placed: two pages whose sheets depend on their order between them is a case to report (none in the examples) |

Everything else stays as the first page loaded it, including metas the new page has and the old one
lacks; a page that relies on another head element at run time is a page load (not detected: documented).
Pages whose CSP `<meta>`, `<base>` or language picker (`data-sn-i18n`) differ are loaded: only a load
applies them. The early script does not run on a swap ([10](#10-prefetch-speculation-rules-the-early-script-and-embed)).

The first spike compared every head element and inserted the new page's in its order; this table is what
the review kept of it. Both pass `e2e/permanent` in three browsers; the module is 212 B smaller.

### 5. The sequence

The swap is one function with named steps. They are internal at first and become the hooks of
[9](#9-room-for-view-navigations):

1. **`intent`**: what is going where: `from` and `to` URLs, the kind (`push`, `replace`, `traverse`
   with a direction), the trigger (the link or the call), an `AbortSignal`. A newer intent aborts this one.
2. **`fetch`**: the page's HTML, the same request a load sends (`Accept: text/html`, cookies).
3. **`plan`**: parse it (`DOMParser`), pair the kept elements, plan the head, find the modules to run.
   A plan that cannot swap is a page load.
4. **`prepare`**: insert the head's new elements and load their stylesheets; preload the new page's
   modules (`<link rel="modulepreload">`, at the URL they will be imported at). Aborted: undone.
5. **`commit`**, one synchronous step: the old entry's scroll position saved, the history entry pushed or
   replaced, the old app destroyed, what it left on `<html>` and `<body>` dropped, the body replaced around
   the kept elements, the old head elements removed, `<html>` and `<body>` attributes copied, scroll and
   focus set.
6. **`mount`**: the new page's modules run; resolves when the new app has mounted and flushed once.
7. **`settled`**: the transition, if any, has finished.

Nothing outside sees the new URL without an app on the page: `commit` and the module's run have no
request between them. The spike measured this through RealWorld's suite; it is not a guarantee of the
platform (a dynamic import of a preloaded module still resolves asynchronously), so the new app should
also be able to mount within `commit` ([6](#6-the-pages-code)).

### 6. The page's code

The spike re-imports the page module at `module.js#sn-N`. It works in builds and in dev, but each visit
adds a module instance that is never freed, the page cannot be swapped to itself (two URLs served by one
page file, `/article/a` → `/article/b`: the same modules, so the spike loads the page), and the module's
run is asynchronous.

Proposed: on pages that opt in, the compiler exports the mount instead of calling it:
`export const page = { ir, fns, features, kept }` plus the existing top-level `mount(document, …)` guarded
to run only on a load. The swap imports the module once per URL (cached), and calls
`mount(document, page)` itself, inside `commit`: no module instance per visit, the same page file at
another path works, the URL, the body and the app change in one synchronous step, and `kept` lists the kept
elements' ids for [3](#3-kept-elements). Pages that do not opt in compile as today.

App code (an islands module, a config module) runs once per document, not once per page: listeners on
`document` keep working (RealWorld's), code that reads the page's DOM when it is imported does not.
Proposed: an event on `document` after each `mount` (`sn-page`, with the intent's `from`, `to` and kind)
and before each `commit` (`sn-pageleave`), documented as the place for per-page app code.

### 7. What the core and the features need

- **`destroy()` releases what it set on elements** (handlers, models, state): the spike deletes
  `sinter.*` symbols from `<html>` and `<body>` from outside, which only the core should do.
- **`cache` writes confirmed changes when the app is destroyed**, as on `pagehide` (in the spike; no
  measurable size).
- **Streams** close on destroy (they do: one open at the end of the dashboard run); a stream both pages
  use could be handed over instead of reconnecting. Not in this proposal.
- **`persist`, `versions`, `refresh` timers**: checked through destroy's cleanups; to be covered by tests
  of destroy with each feature.
- **Data the old page has** (`user`, loaded and confirmed) could reach the new page like next-page data
  (`Prefetched`), without the cache. Not needed for RealWorld; worth it for view navigations, where the
  detail page should paint with the row's data.

### 8. Transitions

A swap uses a same-document view transition (`document.startViewTransition`) where there is one, else
none:

- **The fade:** the default view transition is a cross-fade, which matches temper's
  `@view-transition { navigation: auto }` between pages. That rule only governs navigations between
  documents, and a script cannot read whether it applies, so an app that turned the fade off with
  `navigation: none` still gets one on a swap. Proposed opt-out: `data-sn-navigation="swap no-transition"`
  (to decide).
- **`data-sn-transition` morphs keep working.** The same feature names the pair at `commit` instead of at
  `pageswap`/`pagereveal`: the clicked row's element before the update, the new page's element after it.
  Same-document transitions make this better than across documents: the update callback can wait for
  `mount` and the first flush, so the new page is captured with its data, without the hold script.
  The proposal moves the naming into one function both paths call.
- A transition another navigation skips rejects its promises: caught (in the spike).

### 9. Room for view navigations

The later module (working name `views`) would do what one cross-fade cannot: forward and back
directions, nested layouts where only the inner region animates, a list and a detail side by side on
wide screens, shared elements beyond one pair, progress while the page is fetched. What it needs from this
proposal, and how each choice above is checked against it:

| It needs | Provided by | Checked |
| --- | --- | --- |
| to know where a navigation goes and why, before anything happens | the intent every navigation now passes through `navigate()` ([2](#2-one-way-in-navigate)): from, to, kind, direction, trigger, signal | one chain makes this one hook instead of five listeners; traversal direction: the spike only knows "traverse", entries need an index (in `history.state`) |
| to take a navigation itself (a pane that changes in place) | a handler in the chain, ahead of the swap | the chain is ordered by registration; the module needs a place in it |
| to run the DOM update inside its own transition, with types (`startViewTransition({ update, types })`) | `commit` is one function the module can call; the swap's own transition is the default caller | the spike's swap was already a callback; making it a parameter costs nothing |
| the new page painted with its data in the new snapshot | `mount` resolves after the first flush; `commit` can await it inside the update | needs [6](#6-the-pages-code) (mount in the update, not a module run after it) |
| to replace less than the body (a region both pages share stays, only `<main>` changes) | kept elements are the general case: a shared region is a kept element whose content is the new page's | **not yet:** kept elements hold no bindings. A region the new page binds needs the new page's code to take over the region's nodes, the takeover rejected for this proposal. Left open: the module could keep the region *element* and replace its content, which needs no takeover |
| shared elements across the swap (a thumbnail that becomes the hero) | `data-sn-transition` naming at `commit` | the pair is chosen by the clicked row; several pairs need a list, not one name in sessionStorage |
| to cancel or redirect a navigation (an unsaved form) | `intent`'s signal; `sn-pageleave` cancelable | the spike aborts on a newer click; a cancelable leave is new |
| progress UI while fetching | `intent` → `mount` events | none in the spike |
| to stay optional | the swap works without it; the module only observes and wraps steps | the dashboard and RealWorld need nothing of it |

What this rules out now: **no transition logic in the core**, and no step that cannot be wrapped (the
spike's swap still decides alone where the new content goes: fine for now, and the region case above is
where it would have to give that up). The step names are the contract; until the module exists they stay
internal and undocumented, so they can change.

### 10. Prefetch, Speculation Rules, the early script and embed

- **Speculation Rules** prefetch the HTML for a page load; a `fetch()` does not use that cache, so a swap
  requests the HTML again. Proposed: on pages that opt in, the hover prefetch that already requests the next
  page's data also requests its HTML (`fetch`, low priority) and the swap takes it; the build leaves
  Speculation Rules out of those pages, or keeps them for links to pages that do not opt in.
- **Next-page data** (`$prefetch`, handed to the next page's early file) must reach the swapped page's
  requests instead: the `Prefetched` handoff is the place (a page without the early file consumes nothing
  today).
- **The early script** does not run on a swap: what it renders before the module (persisted values,
  embedded data, `$url` bindings in the first frame) appears one frame later, at mount. With mount inside the
  transition's update ([8](#8-transitions)), the snapshot is taken after it, so nothing shows unrendered.
- **Embed** works unchanged: the server fills the HTML the swap fetches.

### 11. Accessibility, history, scroll

- The new page's title is announced (a polite live region with `document.title`, as other swap libraries
  do), focus goes to the document, or stays in a kept element that had it (in the spike).
- `history.scrollRestoration = 'manual'` once a swap happened; each entry stores its scroll position;
  Back restores it after the body is there, a `#hash` scrolls to its target. (In the spike; the hash case
  untested.)
- The back/forward cache no longer applies between swapped entries (they are one document); a page load
  out of the app and Back return to the swapped document from bfcache as usual (untested).

### 12. Size

Measured with `scripts/size.mjs`: the module is 2.7 KB gzip (6.7 KB min); the core is unchanged
(14.7 KB); `cache` is unchanged (790 B). Expected changes: the compiler change of [6](#6-the-pages-code)
removes the re-import code and the modulepreload step; the live region, `sn-page` events and the
transition naming add some; the target is under 3 KB.

## Testing

- **`e2e/permanent`** (in the spike): Chromium, Firefox and WebKit through Playwright. Two pages with a
  shared layout whose heads bind (same `data-sn` ids on both), one with its own stylesheet and a head
  `data-sn-if`; state and a handler on `<body>`. It checks: one page load in total; the same kept element
  with its text and scroll position; title, metas and stylesheet after each move; no `data-sn` id twice;
  each page working (a counter, a list); Back and Forward; `navigate()` from a handler; the last of two
  clicks wins; a page without the element loads. The first version of the module fails it.
- **The dashboard check** (a scratch script in the spike; to become a test): audio playing on, the stream
  count, the build in three browsers and the dev server in Chromium.
- **RealWorld's suite** in `spa` mode, all 140, as the integration test.
- **Unit tests** for the plan (pairs, head kinds, fallbacks) on parsed documents, and for each feature's
  destroy.
- Against the public RealWorld API, runs now and then show another account right after registering
  (`pw` + the time in base 36, `John Doe`, `www.google.com:80/`): 5 of 140 settings runs in two runs; 3
  of 140 tests in a full run with the simpler head, one of them `social`'s "should view own profile",
  whose path has no swap and no change of this proposal (registering redirects with `location.assign`,
  the home page loads). The shared API answers a new token with another account. The suite is to be
  run against a local backend (`e2e-local.sh`) for the record.

## Breaking changes

None for pages that do not opt in. `cache` writing on destroy changes when entries are written for any app
that calls `destroy()` (tests do): later, with the same data.

## Not in this proposal

- The view-navigation module ([9](#9-room-for-view-navigations)).
- Bound regions that stay (a region whose nodes the new page's code takes over).
- Streams and data handed from one page to the next.
- Forms without a sinter action (a plain `<form method="get">` to another page).
- Routing of any kind: the server keeps choosing the page.

## Docs

navigation.md: "Between pages" gets a section "Swap navigation and kept elements" (when a link swaps,
what is kept, what falls back, app code and `sn-page`, transitions); the opening sentence says a page
can opt in. attributes.md, llms.txt (its budget has 9 bytes left: something must be shortened),
spec.md, security.md (injected markers), CHANGELOG; RealWorld's README (in the spike).

## Plan

One commit each:

1. **The core and features for a page that goes without a page load:** `destroy()` releases its elements;
   `cache` writes on destroy; tests of destroy with each feature.
2. **One way in** (spiked, see [2](#2-one-way-in-navigate)): the handler chain behind `navigate()`, the
   shared link listener, the traversal hand-off, `navigate` exported; `query-links`, `transition` and
   prefetch moved onto it with no change in behaviour, `onUnauthorized` through it once decided.
3. **The compiler change of [6](#6-the-pages-code):** pages that opt in export their mount and kept ids;
   `data-sn-navigation`, the checks and their codes.
4. **The module** on that: a handler in the chain, the sequence with its named steps, the head, kept
   elements, history, scroll, focus, the live region, `sn-page` and `sn-pageleave`; unit tests;
   `e2e/permanent`.
5. **Transitions:** the fade and its opt-out, `data-sn-transition` at `commit`; e2e of a morph.
6. **Prefetch:** the HTML with next-page data, Speculation Rules on opted-in pages, the `Prefetched`
   handoff.
7. **Examples and docs:** the dashboard and RealWorld (`data-sn-navigation="swap"` instead of the kept
   footer), the docs above, sizes before and after.

Decide before step 2: the Navigation API or clicks and `popstate` as the source of intents ([2](#2-one-way-in-navigate)); the opt-out
of the fade ([8](#8-transitions)).
