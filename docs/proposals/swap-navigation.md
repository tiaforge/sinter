# Proposal: swap navigation and kept elements

Status: draft (2026-11-16), implemented step by step on branch `swap-navigation` (one pull request for
the proposal and the feature; the spike the measurements come from, `src/permanent.ts`, `e2e/permanent`
and the examples' changes, is on branch `ccr-f26a7473-xa5d6s` until the steps below bring each part
over); reviewed three times (an external review, then two maintainer reviews; the
second maintainer review's verdict: steps 1 and 2 can start with the changes below, steps 3 to 5 need the
decisions and spikes listed in the [Plan](#plan)). A spike is on
branch `ccr-f26a7473-xa5d6s`: `src/permanent.ts` (the swap), `src/links.ts`, the navigation chain in
`src/runtime/app.ts`, the dashboard example, `e2e/permanent`, RealWorld. This text is what the spike and
the reviews showed; where the spike does something else, the text says so.

Decisions:
- **Multi-page stays the stance.** The server picks the page and sends the whole document, as for a page
  load; nothing changes on the server, in embed or in the page's HTML. The client replaces the page in the
  document it has instead of the browser loading a new one. There is no route table and no view in the
  client, and every URL still loads on its own.
- **Off by default, turned on per app** (decided 2026-11-16, replacing the earlier "on by default"): an app
  turns swaps on with `sinter({ swap: true })`; a page or a link of such an app opts out with
  `data-sn-swap="off"`. Anything unexpected is a page load. An app that does not turn them on gets none of
  the stub, the breaking changes or the cost ([1](#1-turning-swaps-on), [Breaking changes](#breaking-changes));
  only the core's share of the one way in (+80 B gzip) reaches every app.
- **Pages without JavaScript** get the swap's stub only when they keep an element (audio and the like);
  others stay without JavaScript and their links are page loads (decided).
- **Size:** the stub is optimized first; the budget is raised if that is not enough (decided). With swaps
  off by default, the budget in question is that of the pages of apps that turn them on.
- **The new page's response-header CSP is applied, not only its title** (decided): a swapped page runs
  under its own policy, or is loaded ([4](#4-the-head)).
- **The fade follows the standard opt-in:** a swap transitions when the app's CSS asks for page
  transitions with `@view-transition { navigation: auto }` (temper's rule, inside its reduced-motion
  media), as a page load does ([8](#8-transitions); decided).
- **Kept elements** (`data-sn-permanent="name"`) are the first use: an audio player, an open drawer, a
  scroll container stay untouched across a link to a page with an element of the same name.
- **Kept elements may hold bindings, through reserved numbering** (decided 2026-11-16): the nodes inside a
  kept element are numbered in a range of their own, the same on every page, so the next page's code takes
  them over and the element (a playing player included) stays ([3](#3-kept-elements)). It is its own step
  (7) with its own spike; the first version keeps kept elements without bindings. Separate apps per region
  are not part of the proposal; they remain possible later.
- **Navigation has one way in: `navigate()`.** Four parts of the runtime decided parts of a navigation and
  the first spike added a fifth; the chain behind `navigate()` is the one decision ([2](#2-one-way-in-navigate)).
- **The head is kept simple:** the title, sinter's own nodes and the stylesheets; the rest is for crawlers
  and link previews, which load each page ([4](#4-the-head)).
- **A later module builds on it:** view navigations (directional and nested transitions, shared elements,
  list-to-detail panes). This proposal does not build them; each choice is checked against them
  ([9](#9-room-for-view-navigations)).

## Goals

1. **State that must not reset survives a navigation:** media keeps playing, a drawer stays open, a
   scroll container keeps its position, focus and selection in a kept element stay.
2. **A navigation is not an unload:** JavaScript context, open responses and app code's state survive.
   This is what RealWorld's suite assumes after a form's redirect (below).
3. **Nothing to write beyond marking what to keep.** App code redirects with the `navigate()` that
   handlers already have, exported.
4. **An app that does not turn swaps on behaves as today**, its pages larger only by the core's share of
   the one way in ([12](#12-size)). In an app that does, a page that opts out and a page without
   JavaScript that keeps nothing behave as today; the others pay the stub, within the page budgets.
5. **A base for view navigations:** one sequence with named steps that a later module can observe and
   drive.

## The case

- **The dashboard** (spike): a layout with `<details data-sn-permanent="dock">` holding an `<audio>`
  and a `<textarea>`. Overview → Latency → Back → Forward → Overview is one page load; the same `<audio>`
  element plays on, the drawer stays open with its text and scroll position, each page's data, stream
  badge and Pause button work. Measured with a scratch script (the audio's `currentTime` across a swap,
  0.72 s → 1.33 s; event streams opened and closed, five and four), in three browsers for the build and in
  Chromium for the dev server; the script is not in the repo yet ([Testing](#testing)).
- **RealWorld's settings tests.** In `spa` mode the official suite saves the settings and then reads the
  `PUT`'s response body over CDP, calls `page.evaluate`, and reads the current user at once. A page load
  to the profile drops the body (`Network.getResponseBody: No resource`) and the context (`Execution
  context was destroyed`): four tests, documented as unfixable for a multi-page app
  ([same-page-links.md](same-page-links.md)). With the footer kept on every page, the redirect is a swap:
  against a local backend (realworld-django-ninja on SQLite, 2026-11-16) the full suite passes, **140 of
  140**, and the same build with page loads (the four RealWorld files from before the swap work) **136**,
  failing exactly those four. No other account appeared in either run: that symptom was the shared public
  API's ([Testing](#testing)). The swap needed three more things for it: no moment without a mounted app
  ([5](#5-the-sequence)), the cache written when an app goes ([7](#7-what-the-core-and-the-features-need)),
  and the app keeping its cache across a redirect within the same account (RealWorld's `settings-saved`).

## What the spike and the reviews showed

| Finding | Where it goes |
| --- | --- |
| The page's code runs once per module URL: going back to a page seen before would show markup and nothing bound. The spike imports `module.js#sn-N` (a fragment is part of the module's URL and never reaches the server; a query broke the dev server's virtual modules with a 500). | [6](#6-the-pages-code) |
| The spike runs again every module script the previous page did not have, not only the page module: a page-specific island runs on every visit and its `document` listeners pile up. Only the page module may run again. | [6](#6-the-pages-code) |
| `mount` walks the whole document, head included, and every page numbers its `data-sn` ids and `sn-t-N` templates from 0. Leaving the old head binds the new page to the old page's nodes (caught by `e2e/permanent`). | [4](#4-the-head) |
| Moving an element with `insertBefore` resets its scroll position and drops focus, in every browser; `moveBefore` keeps them, and WebKit lacks it. | [3](#3-kept-elements) |
| The old app's handlers and state stay on `<html>` and `<body>`, which the document keeps; the spike deletes `sinter.*` symbols from outside. | [7](#7-what-the-core-and-the-features-need) |
| `cache` writes confirmed changes on `pagehide`, which a swap never fires. | [7](#7-what-the-core-and-the-features-need) |
| Between the URL change and the new mount the page had no app: a read of the app right after the URL changed saw `null`. The spike preloads the modules and changes URL, app and body in one step; the export of [6](#6-the-pages-code) makes it one synchronous step. | [5](#5-the-sequence) |
| **The build dropped the feature** (external review): a page whose only runtime need was a kept element built as "no JavaScript". Fixed: a kept element is a runtime reason, `sinter({ static })` reports `SN322` for it, and `e2e/permanent` swaps to and from a page with nothing bound. Such a page now ships the shared runtime (17.1 KB gzip). | [1](#1-turning-swaps-on) |
| **Scroll** (maintainer review, reproduced, fixed in the spike, each with an `e2e/permanent` step that fails without its fix): Back restored the position of the page being left; opting in turned off the browser's restoration on every reload; a link's `#hash` was dropped (a `Response.url` has no fragment). Restoring the position at the swap is too early: what the new page renders above it moves the content, so it is set again after the page's first loads. | [11](#11-accessibility-history-scroll) |
| **A second navigation during the transition** (maintainer review, reproduced, fixed): the commit did not check that it was still current, so the first page's content committed too. Now only the last navigation's page commits; the first one's entry stays (its URL had committed, as a page load's would). A second click while the page is still fetched leaves no entry (`precommitHandler`). | [5](#5-the-sequence) |
| **Second review, fixed in the spike, each with an `e2e/permanent` step that fails without its fix** (three browsers): a traversal that could not swap became a new entry (now it reloads that entry: no precommit step for a traversal); after a swapped Back, the next Back within the page did not read `$url` (the traversal's marker is now cleared when used, and deciding changes nothing); a GET form and a same-origin `rel="external"` link were swapped (now the browser's, from `sourceElement`, with `download`, `target` and `data-sn-swap="off"`); the swap started a transition the stylesheet never asked for (now only with `@view-transition { navigation: auto }`, so not under temper's reduced motion). A module that fails to mount reloads the page. | [2](#2-one-way-in-navigate), [8](#8-transitions) |
| **Second review, open:** the header rule cannot work as written (script cannot read its own document's headers; a nonce CSP differs on every response); two intents per navigation where one would do (a link and its event, an event and its `popstate`); no veto contract; the chain per app, not per document; the event fallback calls `location.*` past `env`; `precommitHandler` on a navigation that cannot be canceled (guarded in the spike, untested headed). | [2](#2-one-way-in-navigate), [4](#4-the-head), [Plan](#plan) |
| **A page the swap cannot take is requested twice**, once by the swap and once by the load, and asking (`peek`) answered `swap` for any same-origin path, so prefetching HTML would request `/logout` or a one-time callback on hover (maintainer review, reproduced: two GETs). | [1](#1-turning-swaps-on) |
| What a load does and a swap does not: inline and classic scripts, `<noscript>` (live after `DOMParser`), styles added to the head at run time, the new page's response-header policies, declarative shadow DOM (maintainer review, partly reproduced). | [4](#4-the-head) |
| `data-sn-transition` relies on `pageswap`/`pagereveal`, which a swap does not fire: its morphs are lost on a swap (read from `transition.ts`). | [8](#8-transitions) |
| WebKit refuses Speculation Rules prefetches over plain HTTP, and headless WebKit restores no scroll position on a reload, with or without sinter: noise in local tests. | — |

## Design

### 1. Turning swaps on

Decided: **`sinter({ swap: true })`; off unless an app sets it**; then `data-sn-swap="off"` on a page's (or
its layout's) `<html>` takes the page out, on a link takes the link out (a page load, always);
`data-sn-permanent="name"` keeps an element across swaps. Reasons a page or link opts out: a page with
classic or inline scripts that expect a load (analytics, a chat widget, ads, a legacy page), a page served
with another CSP or other headers, a page that relies on `load` or `DOMContentLoaded`, a long-lived
document that should start fresh. Decided: in an app that turns swaps on, the build **warns** for a page
or layout with an inline or classic script in its body, naming the page and the script; it does not opt
the page out by itself (swaps are the app's choice, and the warning says how: `data-sn-swap="off"`).

- **Pages without JavaScript** (`static`, and pages of constants) ship no script today. Decided: they get
  the stub only when they keep an element (it is a runtime reason, as now); others stay without
  JavaScript and their links are page loads. To define in step 3: such a page reached by a swap is the
  same page reached by a load (it gets no module either way), so a link from it is a page load however
  one arrived; the spike cannot yet swap *to* a page without a module of its own.
- **Size on every page that ships JavaScript**: the swap must be on the page a link *leaves* (the
  `navigate` event is intercepted synchronously, as it fires), so with the default every page that ships
  JavaScript carries it, not only pages with a kept element. Proposed, to keep that small: a **stub** on
  every such page (the `navigate` listener, the build's list of pages that swap, the `intercept()` call)
  and the rest of the swap (fetch, plan, head, commit, scroll) loaded when needed: inside the
  `precommitHandler`, which may wait, or earlier when a link is hovered or the page is idle, so it is
  there before the click. Where the `navigate` event is missing, the stub does nothing and loads nothing.
  Measured (a prototype, built and minified as `scripts/size.mjs` does, not yet run): the stub is
  **1,252 B gzip** (2,523 min) with the chain (299 B) in it, the whole swap 3,337 B. Today, with the whole
  module on every page, RealWorld's article page is 23,470 → 26,518 B gzip and the index 25,239 → 28,118 B
  (`scripts/size.mjs` before the spike and now). **The budget:** the minimal page is 14,973 of its 15,360 B
  (387 B left), so the stub does not fit it as is; decided: optimize the stub first (for example the
  scroll listener can live in the part loaded later, since the stub records the leaving position at the
  navigation), then raise the budget if needed.
- **No breaking change for apps that leave swaps off**; for an app that turns them on, what changes is
  listed in [Breaking changes](#breaking-changes).

**The decision comes from the build, not from a fetch.** The build knows which pages opt in and which
names each keeps; it writes them into the manifest next-page data already uses (`prefetch.ts`: the app's
pages and their path patterns). A swap is tried only for a URL that matches a page that opts in; any other
URL is the browser's, requested once. The fetched HTML then *verifies* (the markers are there, the names
match) and a mismatch falls back to a load, which costs a second request only in that unexpected case.
This keeps a swap from requesting `/logout`, a download or a one-time callback, and lets prefetch ask
the chain safely ([2](#2-one-way-in-navigate)). The spike decides from the fetched HTML; this is the change.

**The markers survive the build.** The compiler strips every `data-sn-*` attribute from the HTML;
`data-sn-permanent` is exempt (in the spike) and `data-sn-swap` must be. Each is a runtime reason,
so a page of constants still ships its module.

Build checks (`data-sn-permanent`, in the spike): a static name (`SN401`), once per page, not inside a
`<template>`, no bindings on or inside the element (`SN102`; lifted once kept elements are numbered
apart, [3](#3-kept-elements)). Proposed: dedicated codes, and a warning
when a name is on one page only.

What the swap leaves to the browser (in the spike): a form's navigation (GET too), a link with
`rel="external"` (another site, whatever its origin), `download`, another `target`, and
`data-sn-swap="off"`, all read from the navigation's `sourceElement`. `location.assign` from app code, a
third-party script included, has no source element and swaps; such code that needs a load uses a link
with `data-sn-swap="off"` or turns the page off.

### 2. One way in: `navigate()`

Before step 2, each of these decided part of a navigation with a listener of its own (line numbers from
the commit before it, `35d50bf`):

| Owner | Links | `navigate()` | Back/Forward | History |
| --- | --- | --- | --- | --- |
| core (`app.ts`) | — | `ext.follow`, else `env.navigate` (`app.ts:748`); `onUnauthorized` calls `env.navigate` (`config.ts:187`) | re-reads `$url` (`app.ts:826`) | — |
| `location.ts` | — | — | resets pending writes (`:106`) | `pushState`/`replaceState` for `$url` writes |
| `query-links.ts` | a click listener (`:68`), `ext.sameLink` | replaces `ext.follow` (`:58`) | — | through `location` |
| `transition.ts` | a capturing click listener (`:52`) | — | `pageswap`/`pagereveal` | — |
| the first spike | another click listener | replaces `ext.follow` again | a `popstate` that must run first | its own |

and `prefetch.ts` guessed what a click would do (`ext.sameLink`).

**Spiked** (step 2, after step 0 and the reviews): every navigation is an **intent** that the
handlers decide on; the core runs the decision.
- `Navigator` returns a `Decision` (`name`, optional `run`). `decide(intent)` asks every handler and runs
  nothing (next-page data uses it); `go(intent)` runs the first decision; `onGo` tells observers of what
  goes (a transition's trigger). Deciding changes nothing. The fallbacks are by source: a link nobody
  decides on is the browser's to follow, a call loads the page, an event goes on as the browser's; a
  `run` that returns false loads (an event's own `load`: a load, or a reload once its URL committed).
- `Intent`: `from`, `to`, `kind` (`push`, `replace`, `traverse`), `source` (`link`, `call`, `popstate`,
  `event`), `trigger`, `index`, `signal`, `event`, `load`.
- The chain (`nav`, `onGo`, `decide`, `go`) lives in `links.ts` (`chain(app)`), loaded by pages with same-page
  links, morphs or swaps; the core keeps `navigate()` and its `popstate` asking an installed chain (else they
  load or read `$url`, as before) and the `leaving` hand-off in `mount` (core 14,762 B gzip, +80).
- The swap decides only on `navigate` events, and on the `popstate` of a traversal it intercepted (once).
  `query-links` decides without side effects; a history call the browser refuses returns false.
- Measured: the unit suite (the query-links, transition, prefetch, speculation and navigate suites
  untouched), `e2e/navigation` in Chrome, `e2e/permanent` in three browsers, the chain's tests
  (`test/behaviour/navigation-chain.test.ts`), RealWorld 140 of 140 against a local backend.

**Step 2 since the second review** (on branch `swap-navigation`):
- **One intent per navigation** (done): where the browser has the Navigation API, its `navigate` event is
  the one source; a `navigate()` call is handed to the browser (`navigation.navigate`, its trigger in
  `info`); same-page links intercept their event; the click listener and the core's `popstate` only where
  the API is missing. `e2e/links` checks it in Chromium, Firefox and WebKit (the same checks pass on the
  click path).
- **Ranks** (done): handlers are added with a rank (`views`, `same`, `swap`), not in the compiler's order.
- **Refusal** (done, decided): **`data-sn-on-navigate`**, a handler for every navigation while its element
  is on the page, before anything acts; `$event` has `to`, `from`, `kind` and `trigger` (typed by the
  checker); `$event.preventDefault()` refuses it. Guards run when a navigation goes, never when the chain is
  only asked (next-page data on hover runs none), and not for what can no longer be refused (Back without
  the API, the browser's own Back without activation, a reload: `beforeunload` stays for those). A
  `navigate` module of its own (1,231 B gzip with the chain); the core is unchanged. No `redirect`
  (decided).
- **One chain per document** (done, after step 7): every app on the document adds its handlers, observers
  and guards to one chain (they go with the app), with one `navigate` listener and one claim on a
  traversal, so a guard of any app refuses for all and one decision runs; a call's fallback uses the env of
  the app that went. Only the app mounted on the document swaps. With several apps, a same-page link is
  the first deciding app's (the others do not read `$url` again). Cost: about 170 B gzip in each module
  with the chain (the stub 1,904 B). The swap's fallbacks are its own (`location`), and there is no
  redirect under `precommitHandler` (decided: none).

Every way in is then one of: a link (the shared listener), `navigate()` (handlers and app code), a
traversal (the core's `popstate`), and the browser's own (a new tab, a modifier, a link the chain does not
take). `location.ts`'s `popstate` stays an observer: it drops what waited to be written and decides nothing.

A swap is tried for links, `navigate()` calls and traversals across entries a swap made, to pages that opt
in ([1](#1-turning-swaps-on)). Everything else is the browser's: the same URL, a `#hash` on the same page, a new
tab, form submissions without a sinter action. A click the browser follows cancels a pending swap.

Falls back to a page load: a fetch error; a non-HTML, non-2xx or cross-origin (after redirects) response;
`data-sn-failed`; the fetched page does not verify ([1](#1-turning-swaps-on)); a name on two elements of either
page; heads that differ in what only a load applies ([4](#4-the-head)). A traversal that cannot swap
reloads, once: a second failure for the same entry is left to the browser (a reload loop otherwise).

**Where intents come from: the Navigation API** (step 0, decided 2026-11-16). The `navigate` event of
the [Navigation API](https://developer.mozilla.org/docs/Web/API/Navigation_API) is the source of intents
(for the swap in the spike; for every navigation once step 2 is done), with `intercept()` in place of the
swap's own history writes. Swaps happen only where it
exists; elsewhere every navigation stays a page load (the opt-in's fallback). Same-page links and
transitions keep working where it is missing, through `links.ts` and the core's `popstate`, as today.

Support: Baseline Newly Available since January 2026, in Chrome 102, Safari 26.2 (December 2025) and
Firefox 147 (January 2026) ([web.dev](https://web.dev/blog/baseline-navigation-api),
[caniuse](https://caniuse.com/wf-navigation)). Measured with the engines Playwright installs here
(Chromium 153, Firefox 155, WebKit 26.6) by the probes in `e2e/permanent/navigation-api/`:

| | Chromium | Firefox | WebKit | So |
| --- | --- | --- | --- | --- |
| a link, `location.assign`, `navigation.navigate()` give an interceptable `push`; Back a `traverse` with the destination's `index` | yes | yes | yes | one source for links, app code and Back; the direction for view navigations |
| `sourceElement` is the clicked link; `navigate(url, { info })` carries a trigger | yes | yes | yes | the intent's `trigger` (MDN still calls `sourceElement` experimental: `info` for `navigate()`, `null` when missing) |
| a `#hash` (`hashChange`), a download (`downloadRequest`), a reload: flagged | yes | yes | yes | left to the browser without checks of our own; a new tab or a modifier fires no event |
| a second navigation aborts the first (`signal`) | yes | yes | yes | the last click wins, from the browser |
| `precommitHandler` keeps the old URL until the new page is ready | yes | yes | yes (an earlier probe said no: it read the URL through Playwright, whose click waits; `precommit.cjs` reads it in the page) | the fetch and the plan run there: a second click before the page is ready replaces the navigation without an entry, as with page loads. Safari 26.2 reportedly shipped without it: feature-detected (`NavigationPrecommitController`), else the URL commits first |
| `focusReset: 'after-transition'` moves focus to the document as a load does; `'manual'` keeps it | yes | yes | yes | the default, and `manual` when focus is in a kept element (`focus-bfcache.cjs`) |
| back/forward cache: a load out of the app, then Back | reloads | reloads | reloads | headless browsers keep no page in it even without the API (a control page); not testable here. Back to an intercepted entry from outside loads that URL as a page, which is right |
| `scroll: 'after-transition'` restores each entry's position | only the first page's | none | traversals yes, a reload stale | **not used**: the swap keeps positions itself (`scroll: 'manual'`), keyed by `navigation.currentEntry.key` |
| `userInitiated` | right | right | inverted | not used |
| `history.pushState` fires `navigate` (`sameDocument`) | yes | yes | yes | ignored: `$url` writes and same-page links stay what they are |
| an intercepted traversal also fires `popstate` | yes | yes | yes | the core's `popstate` must not ask the chain again for a traversal the `navigate` event gave it (one intent per navigation, step 2) |
| a page load between two pages with `@view-transition { navigation: auto }` runs a transition (`cross-document-vt.cjs`) | yes | no `pagereveal` at all | the event, no transition headless | the swap follows the same rule: Firefox gets no transition on a swap, as on a load |
| `moveBefore` | yes | yes | no | as before ([3](#3-kept-elements)) |
| `Document.parseHTMLUnsafe` (declarative shadow DOM) | yes | yes | yes | the parser for the fetched page ([4](#4-the-head)) |

What it replaces in the spike: the swap's link handling (the shared listener stays only for same-page
links and transitions where the API is missing), its `popstate` path, its hash, download and abort
handling, its history writes, and the entry keys in `history.state` (so `location.ts`'s `null` state no
longer matters to it); `location.assign` from app code is intercepted, so app code needs no `navigate()`
to swap (it keeps working). What it does not replace: the scroll positions, the commit and the mount,
and the announcement. A `precommitHandler` is given only to a navigation that can be canceled and is not a
traversal (in the spike: the browser's own Back without activation cannot be canceled, and a traversal
that cannot swap must not become a new entry); headed browsers are to confirm it.

### 3. Kept elements

The new body's content is inserted into the live body after the old content, in one task. Each kept
element then takes the place of its namesake (`moveBefore` where the browser has it: an iframe's document,
focus, animations, scroll survive; else `insertBefore`, and the module restores the element's and its
descendants' scroll positions, focus and selection), and the old content is removed. A playing media
element moved within a task does not pause (all three browsers in the spike).

A kept element's position in the cascade can change (another parent on the new page); that is the
author's to arrange, as in Turbo.

**Kept elements with bindings** (decided; step 7, after a spike of its own; the first version keeps kept
elements without bindings, as the spike). A
page's code finds its nodes by number (`data-sn="5"`) and every page numbers from 0, so a kept element with
bindings would collide with the next page's numbers. Instead, the compiler numbers the nodes inside a kept
element in a range of their own, derived from its name (`header:0`, `header:1`, …). A kept element comes
from the layout or a component, so it is the same source on every page; the build checks it: one name,
one markup, on every page that has it, else an error. On a swap the old app goes and the new page's code
takes the element's nodes over:
- **What stays:** the element and everything in it (identity, scroll positions, focus, a playing
  `<audio>` or `<video>`, CSS animations), and it follows the new page: a bound "active" link, a prop the
  page passes.
- **What starts again:** what the old app held for it. Its `data-sn-state` starts from its initial value
  (an open menu closes) unless persisted; its resources load again (with `cache`, the last data shows at
  once); its streams reconnect.
- **Requirements for media to play on** (measured: setting a playing `<audio>`'s `src` to the *same*
  value restarts it at 0 and pauses it, in Chromium, Firefox and WebKit,
  `e2e/permanent/navigation-api/media-src.cjs`):
  - the core's attribute writer writes only a value that changed (today it calls `setAttribute` on every
    write; the text writer already skips equal text);
  - media is not rebuilt: lists and branches inside a kept element are adopted by the new page's code
    (their rendered rows kept, matched by key), not rendered again;
  - no bindings to playback properties (`currentTime`, `paused`, `volume`): a build warning on a kept
    element, since the new page's code would write them again. A bound `src` that really changes (the
    next track) starts it, as it should.
- **To settle in its spike** (second review): the takeover adopts what is rendered (rows and branches by
  key), which is a new capability of the core (its size to measure); a `data-sn-model` field inside the
  element keeps its typed text (it is the element's) while its state starts again, which must not
  overwrite it; the reserved ids' form against today's numeric ids, anchors (`<!--sn N-->`) and `sn-t-N`
  templates.

**Injected markup** (security.md: the runtime never acts on injected directives). An injected
`data-sn-permanent` next to the real one makes a name appear twice, which is a page load. An injected one
where the page has none would receive the old page's element: until the page module lists the names it
keeps with their `data-sn` ids ([6](#6-the-pages-code)) and the swap honours only those, this is open, so
the compiler change comes before the module in the plan. security.md gets the trust model: the fetched
HTML is trusted as a load of it would be, but it runs under the first page's policies ([4](#4-the-head)).

### 4. The head

What a person sees of the head is the title and the styles; the rest (description, Open Graph, canonical,
alternates, Speculation Rules) is for crawlers and link previews, which load each page and never swap. So
the swap changes only:

| What | Why | How |
| --- | --- | --- |
| `<title>` | the person sees it (tab, history, the announcement in [11](#11-accessibility-history-scroll)) | always the new page's |
| sinter's own head nodes: `data-sn` elements (a bound title or meta), `<!--sn N-->` anchors with what they rendered, `<template id="sn-t-N">`, embedded data (`script[type="application/json"][data-sn]`), `script[data-sn-messages]` | the page's code finds them by number in the whole document, and every page numbers from 0. Left in place, the new page binds the old page's nodes, or renders the old page's template for a row | the old page's removed, the new page's appended, no comparison |
| stylesheets the pages' HTML has (`<link rel="stylesheet">`, `<style>`) | a page's own CSS must come with it and go with it (`e2e/permanent` caught B's stylesheet staying on A) | by resolved URL (a `<style>` by its text): the new page's that the document lacks are appended and loaded before the swap, the old page's that the new one lacks go with it |

Everything else stays as the first page loaded it. Pages whose CSP `<meta>`, `<base>` or language picker
(`data-sn-i18n`) differ are loaded: only a load applies them.

**What a swap skips that a load does** (listed in the docs; maintainer review):
- **Scripts in the new page's HTML** other than its module: inline and classic scripts do not run
  (reproduced). Pages that opt in are checked at build time: an inline or classic script in the body is a
  warning naming it.
- **`<noscript>`**: `DOMParser` parses with scripting off, so its content would become live DOM (a
  tracking pixel was requested, reproduced). The swap is to remove `<noscript>` elements from the new body
  (not in the spike).
- **Styles added to the head at run time** (CSS-in-JS, widgets, Vite's dev styles): the spike removed
  every `<style>` the new page lacks (reproduced). Only stylesheets the old page's *HTML* had are to
  leave; the module records them when the page loads or is swapped in (not in the spike).
- **The new page's response-header CSP is applied** (decided: not only the title). What the platform
  allows (probed in Chromium, Firefox and WebKit, `e2e/permanent/navigation-api/csp.cjs`): a document's
  policy can only be *added to*. A `<meta http-equiv="Content-Security-Policy">` inserted later is enforced
  on top of the header's; removing it does not lift it; a looser one does not loosen anything. So a policy
  cannot be replaced on a swap, and script cannot read the current document's own response headers.
  Decided (option A), as SPAs and Turbo do it: **one policy per app, the first document's.** An SPA has
  one document, so the policy of its first response governs the session; Turbo, which also swaps whole
  pages, keeps the first page's policy and stamps the document's nonce (from `<meta name="csp-nonce">`) on
  the scripts and styles it inserts. So:
  - the pages of an app that swaps share one policy (the app's); a page with another one opts out with
    `data-sn-swap="off"` and is loaded;
  - the swap stamps the document's nonce, read from `<meta name="csp-nonce">`, on the styles and scripts it
    inserts, so pages with a nonce policy swap too (the fetched page's own inline styles and scripts are
    trusted as a load of that page would trust them: the server's own HTML, the trust model of
    [3](#3-kept-elements));
  - no automatic detection of a differing policy (it would need the first page's headers, which script
    cannot read); kept as a later option (a `HEAD` of the first page's URL, compared with each response).
  Referrer-Policy and Permissions-Policy follow the same rule: one per app, else the page opts out.
- **Declarative shadow DOM**: `parseFromString` does not attach it; `Document.parseHTMLUnsafe` does, and
  all three engines have it (step 0's probe), so it is to be the parser for the fetched page (the spike
  still uses `DOMParser`).
- **The early script** does not run; what it renders before the module appears at mount
  ([10](#10-prefetch-speculation-rules-the-early-script-and-embed)).

### 5. The sequence

The swap is one function with named steps. They are internal at first and become the hooks of
[9](#9-room-for-view-navigations):

1. **`intent`**: from the chain ([2](#2-one-way-in-navigate)). A newer intent aborts this one.
2. **`fetch`**: the page's HTML, the same request a load sends (`Accept: text/html`, cookies), for a URL
   the build lists as opted in ([1](#1-turning-swaps-on)).
3. **`plan`**: parse it, verify the markers, pair the kept elements, plan the head, find the page module.
4. **`prepare`**: insert the head's new elements and load their stylesheets; preload the page module.
   Aborted: undone.
5. **`commit`**, one synchronous step that first checks it is still current (a navigation that came
   while the transition waited for its update has the page; in the spike, reproduced and fixed): the
   entry is the browser's (`intercept()`), the old app is marked `leaving` (the next mount destroys it),
   what it left on `<html>` and `<body>` dropped, the body replaced around the kept elements, the old head
   elements removed, `<html>` and `<body>` attributes copied, scroll set, and (with
   [6](#6-the-pages-code)) the new app mounted in the same step, which removes `leaving` from the core.
6. **`mount`**: resolves when the new app has flushed once.
7. **`settled`**: the transition, if any, has finished; the scroll position of a traversal is set again
   ([11](#11-accessibility-history-scroll)).

### 6. The page's code

The spike re-imports module scripts at `module.js#sn-N`. It works in builds and in dev, but each visit
adds a module instance that is never freed, it runs every module the previous page lacked (an island
included) rather than only the page module, a page cannot be swapped to itself (two URLs served by one
page file, `/article/a` → `/article/b`), and the module's run is asynchronous.

Proposed, on pages that opt in: the compiler marks the page module and exports the mount instead of
calling it, `export const page = { ir, fns, features, kept }`, with the top-level `mount(document, …)`
guarded to run only on a load. The swap imports the page module once per URL (cached) and calls
`mount(document, page)` inside `commit`: no module instance per visit, the same page file at another path
works, other modules run once per document, the URL, the body and the app change in one synchronous step,
and `kept` lists the kept elements' ids for [3](#3-kept-elements). Pages that do not opt in compile as today.

App code (an islands module, a config module) then runs once per document, not once per page: listeners on
`document` keep working (RealWorld's), code that reads the page's DOM when it is imported does not.
Proposed: an event on `document` after each `mount` (`sn-page`, with the intent), documented as the place
for per-page app code.

### 7. What the core and the features need

- **`destroy()` releases what it set on elements** (handlers, models, state): the spike deletes
  `sinter.*` symbols from `<html>` and `<body>` from outside, which only the core should do.
- **`cache` writes confirmed changes when the app is destroyed**, as on `pagehide` (in the spike).
- **Streams** close on destroy (the dashboard script: one open at the end); a stream both pages use could
  be handed over instead of reconnecting. Not in this proposal.
- **`persist`, `versions`, `refresh` timers**: through destroy's cleanups; covered by tests of destroy
  with each feature.

### 8. Transitions

A swap uses a same-document view transition (`document.startViewTransition`) where there is one, else
none:

- **When (decided, in the spike):** a swap starts a transition only when the app's stylesheets ask for
  page transitions with the standard `@view-transition { navigation: auto }` and its `@media` holds, read
  from the sheets (`CSSViewTransitionRule`; another origin's sheet cannot be read). temper's rule sits in
  `prefers-reduced-motion: no-preference`, so reduced motion needs nothing of sinter's, and temper works
  as it is. Firefox exposes no such rule and runs no transition between documents (probed), so a swap
  there starts none, as a load does. No sinter option; the look is the app's CSS
  (`::view-transition-group(root) { animation: none }` for none at all). `e2e/permanent` checks a
  transition with the rule and none under reduced motion.
- **`data-sn-transition` morphs keep working.** The feature names the pair at `commit` instead of at
  `pageswap`/`pagereveal`: the clicked row's element before the update, the new page's element after it.
  With the mount inside `commit` ([6](#6-the-pages-code)), the new snapshot shows the new page bound; in the
  spike it is taken before the mount, so it fades to the new page's unbound markup.
- A transition another navigation skips rejects its promises: caught (in the spike).

**Who owns transitions: sinter labels them, the stylesheet styles them.** The browser runs a view
transition; CSS alone cannot know what a navigation is (a push or Back, which page to which), and the
runtime should not own how it looks. So the contract is three things sinter sets and a stylesheet (temper,
or the app's) reads, the same for a swap and for a page load:
- **Types** on every transition, for `:active-view-transition-type()`: `sn-push`, `sn-replace` or
  `sn-traverse`, and on a traversal `sn-back` or `sn-forward` (from the entries' `index`, which the
  `navigate` event gives). A swap passes them to `startViewTransition({ update, types })`; on a page load
  the transition feature adds the same ones in `pageswap`/`pagereveal` (`viewTransition.types`), so one
  rule styles both.
- **Names and classes:** `data-sn-transition` pairs as today (`view-transition-class: sn-transition`);
  each kept element named for the swap's duration with a name of its own (`sn-keep-` and a hash of its
  name: one name on two elements would skip the transition) and the class `sn-keep`, so it stays still
  while the page around it changes (to probe: a playing video's snapshot, paint order, pointer events).
- **Types on page loads** need the code on every page: the stub, which every page that swaps carries,
  adds them in `pageswap`/`pagereveal`.

temper then provides transitions as CSS only: its `@view-transition { navigation: auto }` stays for page
loads, and rules such as `:root:active-view-transition-type(sn-back)::view-transition-old(root) { … }`
give swaps and loads a direction, with the reduced-motion handling it already has. Measured
(`e2e/permanent/navigation-api/view-transitions.cjs`): types, the type selector and
`view-transition-class` work in Chromium 153, Firefox 155 and WebKit 26.6. The `@view-transition` rule is
readable from script (`CSSViewTransitionRule`) in Chromium and WebKit but not Firefox, which runs no
transitions between documents either; the swap reads it only to decide whether to start one. The view-navigation module ([9](#9-room-for-view-navigations)) adds
types and pairs to the same contract (a list-to-detail type, several shared elements).

### 9. Room for view navigations

The later module (working name `views`) would do what one cross-fade cannot: forward and back
directions, nested layouts where only the inner region animates, a list and a detail side by side on
wide screens, shared elements beyond one pair, progress while the page is fetched. What it needs, and how
each choice is checked against it:

| It needs | Provided by | Checked |
| --- | --- | --- |
| to know where a navigation goes and why, before anything happens | the intent every navigation passes through `navigate()` ([2](#2-one-way-in-navigate)) | the spike's intent has `from`, `index` and `signal`; one intent per navigation is step 2 |
| to take a navigation itself (a pane that changes in place) | a decision in the chain, ahead of the swap | needs the explicit order of [2](#2-one-way-in-navigate) |
| to veto or redirect a navigation (an unsaved form) | every handler asked before any acts ([2](#2-one-way-in-navigate)) | every handler is asked in the spike, but a decision cannot refuse or redirect yet: the shape is step 2 |
| to run the DOM update inside its own transition, with types | `commit` is one function the module can call | the spike's swap is already a callback |
| the new page painted with its data in the new snapshot | the mount inside `commit` | needs [6](#6-the-pages-code) |
| to replace less than the body (a region both pages share stays, only `<main>` changes) | kept elements, with bindings through reserved numbering ([3](#3-kept-elements), step 7) | a shared bound region is a kept element the next page takes over; what the old app held for it (state, streams) starts again. A region running as an app of its own (its state kept) remains possible later |
| shared elements across the swap | `data-sn-transition` naming at `commit` | one name in sessionStorage today; a list of pairs is needed |
| progress UI while fetching | the intent → `mount` | none in the spike |
| to stay optional | the swap works without it | the dashboard and RealWorld need nothing of it |

What this rules out now: **no transition logic in the core**, and no step that cannot be wrapped. The step
names are the contract; until the module exists they stay internal and undocumented.

### 10. Prefetch, Speculation Rules, the early script and embed

- **Speculation Rules** prefetch the HTML for a page load; a `fetch()` does not use that cache. Pages that
  opt in leave their links to opted-in pages out of the rules (the swap requests the HTML when the link is
  followed). Prefetching the HTML for a swap is not in this proposal.
- **Next-page data** (`$prefetch`) must reach the swapped page's requests: the `Prefetched` handoff is the
  place (a page without the early file consumes nothing today). Prefetch asks the chain before it
  requests anything ([2](#2-one-way-in-navigate)), and only for URLs the build lists ([1](#1-turning-swaps-on)).
- **The early script** does not run on a swap: what it renders before the module (persisted values,
  embedded data, `$url` bindings in the first frame) appears at mount; with the mount inside the
  transition's update, the snapshot is taken after it.
- **Embed** works unchanged: the server fills the HTML the swap fetches.

### 11. Accessibility, history, scroll

- **Announcement and focus:** focus goes to the document after a swap, as after a load (`focusReset`, the
  browser's, in the spike), and stays inside a kept element that had it. The new page's title is to be
  announced through a polite live region (not in the spike).
- **Scroll** (in the spike, each with an `e2e/permanent` step): each entry's position is recorded by its
  key (`navigation.currentEntry.key`) as the page scrolls, and the leaving entry's when a navigation
  starts; a swap is intercepted with `scroll: 'manual'`, so the browser's own restoration is untouched for
  reloads and loads (headless WebKit restores nothing on a reload, with or without sinter; the test compares
  with a page without sinter). On a traversal the position is set at the swap and again once the new page's
  first loads are done (at most a second later): what renders above it moves the content, and scroll
  anchoring then keeps the wrong part in view (859 instead of 800 in all three browsers before the second
  set). A link's `#hash` stays in the URL and its target is scrolled to.
- The back/forward cache no longer applies between swapped entries (they are one document); a load out of
  the app and Back returns to the swapped document from bfcache as usual (untested).

### 12. Size

Measured with `scripts/size.mjs` (gzip):

| | before step 2 | the spike now |
| --- | --- | --- |
| core (every page) | 14,682 B | 14,762 B (+80: `navigate()` and `popstate` ask an installed chain, the `leaving` hand-off) |
| transition (pages with morphs) | 802 B | 1,233 B (+431: the chain and the shared link listener instead of a 20-byte capturing one) |
| query-links | 770 B | 1,024 B (+254: the chain and the link listener) |
| prefetch | 1,457 B | 1,489 B (+32) |
| the swap | 2,705 B | 3,337 B (the chain, the Navigation API path, the precommit split) |
| the stub (prototype) | — | 1,252 B, the chain included; the rest of the swap loaded when needed |
| minimal page | 14,884 B | 14,973 B of its 15,360 B budget (387 B left: the stub does not fit yet) |

Each module is measured alone, with `links.ts` (the chain and the link listener, about 550 B) bundled in;
a page with several of them pays for it once. The compiler change of [6](#6-the-pages-code) removes the
re-import and preload code; the live region and the head records add some.

## Testing

- **`e2e/permanent`** (in the spike): Chromium, Firefox and WebKit through Playwright. Two pages with a
  shared layout whose heads bind (the same `data-sn` ids on both), one with its own stylesheet and a head
  `data-sn-if`, a page with nothing bound; state and a handler on `<body>`. It checks one page load in
  total; the same kept element with its text and scroll position; title, metas and stylesheet after each
  move; no `data-sn` id twice; each page working; Back and Forward; `navigate()` from a handler; a page
  with nothing bound both ways; the last of two clicks wins, before the fetch and during the transition;
  a page without the element loads; the page's position on Back and Forward, after a link, and after a
  reload before and after a swap; a link's `#hash`; a traversal that cannot swap; Back after a swapped
  Back; a GET form and `rel="external"`; the transition with the stylesheet's rule and none under reduced
  motion. Each fix of the reviews has a step that fails without it.
- **CI:** `e2e/links` runs in its own job in Chromium, Firefox and WebKit (a browser that does not start
  fails it there); the swap's `e2e/permanent` joins it in step 4.
- **A headed-browser run** (to add): the browser's own Back without activation (`cancelable` false), the
  back/forward cache, WebKit's reload; headless browsers cannot show them.
- **The dashboard check** (a scratch script; to be committed as a test): the audio playing on, the
  streams opened and closed, the build in three browsers and the dev server in Chromium.
- **RealWorld's suite** in `spa` mode as the integration test, against a local backend
  (`e2e-local.sh`; 140 of 140 with swaps, 136 with page loads). Its cleanup now stops the preview server
  it starts (it left one serving a deleted folder, which failed the next run). Against the public API, runs now and then show another account right after
  registering (`pw` + the time in base 36, `John Doe`, `www.google.com:80/`), including on a path with no
  swap (`social`'s "should view own profile": registering redirects, the home page loads): the shared API
  answers a new token with another account, so its numbers are not a record.
- **Unit tests** for the chain (in the spike), the plan (verification, pairs, head kinds, fallbacks) on
  parsed documents, and destroy with each feature.

## Breaking changes

None for an app that leaves swaps off, apart from its core growing by 80 B gzip. In an app that turns
them on, a link or `navigate()` to another page of the app is no page load:
- inline and classic scripts on the next page do not run, `load` and `DOMContentLoaded` do not fire again,
  and analytics that count loads count only the first (the build's opt-out for such pages, [1](#1-turning-swaps-on));
- every page that swaps runs under the first page's response-header policies: one policy per app
  ([4](#4-the-head));
- app modules run once per document, not per page; per-page work goes to `sn-page`;
- pages whose stylesheet asks for page transitions get them on swaps too, as on loads.

And: every page's core grows by 80 B gzip; in an app that turns swaps on, a page that swaps carries the stub (about 1.25 KB today, to be
optimized); pages with morphs or same-page links carry the chain and the link listener. `cache` writes on
destroy (for an app that calls `destroy()`, tests do: later, with the same data). `ext.sameLink` and
`ext.follow` are gone (internal).

## Not in this proposal

- The view-navigation module ([9](#9-room-for-view-navigations)).
- State that lives on across a swap inside a kept element (its `data-sn-state`, open streams): it starts
  again with the new page's code. A region running as an app of its own would keep it; nothing needs
  that now.
- Streams and data handed from one page to the next.
- Prefetching the HTML for a swap.
- A cancelable "leaving the page" event (the veto of [9](#9-room-for-view-navigations) comes with the
  decision phase of step 2).
- Forms without a sinter action (a plain `<form method="get">` to another page): the browser's, as in the
  spike.
- Routing of any kind: the server keeps choosing the page.

## Docs

Done in step 6: navigation.md ("Swaps", "Refusing a navigation", swaps and types in "Page transitions"; swaps
are off by default, `sinter({ swap: true })` turns them on), configuration.md, attributes.md and llms.txt
(from the vocabulary), security.md (the trust model, injected markers), the RealWorld and dashboard
READMEs. Not yet: spec.md and the CHANGELOG.

## Plan

0. **The source of intents** (decided): the Navigation API's `navigate` event; swaps only where it
   exists ([2](#2-one-way-in-navigate)). The probes are in `e2e/permanent/navigation-api/`.

One commit each:

1. **The core and features for a page that goes without a page load:** `destroy()` releases its elements;
   `cache` writes on destroy; the attribute writer writes only changed values ([3](#3-kept-elements));
   tests of destroy with each feature. **Done** on branch `swap-nav-step-1` (`bc44a26`): core 14,946 →
   14,985 B gzip on current `main`, `test/behaviour/destroy.test.ts`.
2. **One way in** (done on `swap-navigation`, one chain per document included, [2](#2-one-way-in-navigate)): the chain with decisions the core
   runs and the full intent; one intent per navigation where the Navigation API exists (same-page links on
   the `navigate` event), `links.ts` and the core's `popstate` where it does not; the veto and redirect
   shape; one ordered chain per document; fallbacks through `env`; `query-links`, `transition` and
   prefetch on it with no change in behaviour; the second review's fixes with their `e2e/permanent` steps.
   Sizes before and after. Ready to start.

**Before step 3, decide:** the budget for the pages of apps that turn swaps on, once the stub is optimized
(deferred until the numbers are there). Then spike the
manifest, the stub and the exported mount together: they are the unproven half.

3. **The compiler:** the manifest of pages that swap and the names they keep ([1](#1-turning-swaps-on));
   the page module marked, its mount exported with the kept ids ([6](#6-the-pages-code)); `sinter({ swap })`
   off by default, `data-sn-swap="off"` for pages and links, the warning for pages with inline or classic scripts; pages without JavaScript
   (the stub only with a kept element); the checks and their codes. **Done** on `swap-navigation`: the
   `swap` option (also for `sinter check` and the editor); `data-sn-permanent` checks as `SN346`, a runtime
   reason only with swaps on; `data-sn-swap="off"` on `<html>`, a layout's tag or a link (kept in the HTML);
   `SN540` for an inline or classic script in the body; the list as the virtual module `/@sinter/swap.js`
   (`{ m: paths, k: names }` per page, pages with `data-sn-swap="off"` left out); the page module exports
   `boot` and `kept` and mounts itself only when `globalThis[Symbol.for('sinter.swapping')]` is not set.
   Not yet: the page module's import of the stub (it comes with the module, step 4) and the warning for a
   name on one page only.
4. **The module** on that, split into the stub every page that swaps carries and the part loaded when
   needed: the sequence with its named steps, verification, the head and what a swap skips (`<noscript>`,
   run-time styles, `parseHTMLUnsafe`, the header rule), kept elements without bindings, scroll, focus and
   the live region, `sn-page`; unit tests; `e2e/permanent`.
   **Done** on `swap-navigation`: `src/swap.ts`, the stub (the decision for URLs the build lists, the
   `intercept()` with `precommitHandler`, the leaving entry's position on every navigation through the chain's
   `onGo`, no scroll listener) and `src/swap-run.ts`, loaded by the first swap (fetch, plan, head, commit,
   mount, `sn-page`, the announcement in a `role="status"` region, the traversal's second scroll). What
   changed from the design above, found on the way:
   - **The page module registers its mount instead of exporting it:** an app build keeps no exports of a
     page's entry (Vite's HTML entries), so the module puts `{ boot, kept }` on
     `globalThis[Symbol.for('sinter.pages')]` under `import.meta.url`, which the swap looks up by the
     script's URL. The swap imports the next page's module scripts once each (with the flag set, they do
     not mount) and calls `boot()` inside `commit`, after `destroy()` of the old app: no `leaving` hand-off
     is needed in the core.
   - **Chromium's `parseHTMLUnsafe(html)` drops comments**, sinter's anchors (a list rendered nothing);
     with a configuration, `{ sanitizer: {} }`, it keeps them in all three engines and attaches declarative
     shadow DOM (`e2e/permanent/navigation-api/parse.cjs`). `DOMParser` where it is missing.
   - **A swap needs no kept element:** every page of the list swaps; a page module that lists a name the
     fetched HTML does not have once is a load, and only names both page modules list are kept (injected
     markers keep nothing).
   - **A link to the URL shown swaps the page in again** (a `replace`, as the browser makes it).
   - **Speculation Rules** leave out the pages that swap (the swap's `fetch()` does not use the prefetch
     cache); only pages with `data-sn-swap="off"` stay in them.
   - **A page with `<html data-sn-swap="off">` carries no stub:** links from it are page loads, as links to it.
   Checked: `e2e/permanent` (in CI with `e2e/links`) in Chromium, Firefox and WebKit, with new steps for
   `data-sn-swap="off"` on a link and on a page, `<noscript>`, `sn-page` and the announcement; a swap
   under `vite dev` in Chromium; unit tests of the plan (`test/behaviour/swap-plan.test.ts`) and of the
   page module (`swap-boot.test.ts`). Sizes (gzip): the stub 1,699 B (the chain about 1,050 of it), the
   rest 2,734 B, loaded by the first swap; the minimal page with swaps on 16,702 B, over its 15,360 B
   budget (15,247 B without swaps). Not yet: the nonce stamp and a page with built-in messages in an
   e2e; the next-page data handoff; one chain per document (done since: [2](#2-one-way-in-navigate)).
5. **Transitions:** the types on swaps and on loads (from the stub), each kept element's own name, the
   `data-sn-transition` pair at `commit`; a probe of named kept media; an e2e of a morph across a swap.
   **Done** on `swap-navigation`: the swap starts `startViewTransition({ update, types })` with
   `vtTypes` (links.ts: `sn-push`, `sn-replace`, `sn-traverse`, and `sn-back`/`sn-forward` from the entry
   the navigation leaves, recorded at `onGo`, and the destination's index); it fires `sn-pageswap` on the
   page left right after the transition starts and `sn-pagereveal` once the next page is mounted, with
   `viewTransition` and `activation` shaped like the browser's, so `transition.ts` names the pair with the
   handlers it has for loads; each kept element is named for the transition's duration (`sn-` and a hash
   of `keep <name>`, class `sn-keep`). Page loads get the same types (`loadTypes`: `pageswap` and
   `pagereveal`) from `transition.ts`, on pages with a morph; the stub had them too, and left them out to
   fit (207 B: in an app that swaps, a load between its pages is the exception). Checked: `e2e/permanent` (the
   pair named alike on both pages, the kept element its own, `sn-push` on a link and `sn-traverse sn-back`
   on Back, in Chromium and WebKit; Firefox runs no page transitions); `kept-media.cjs` (a playing `<audio>`
   and `<video>` named and moved in the update play on, in all three); unit tests
   (`transition-types.test.ts`). Sizes (gzip): the stub 1,908 B (+209), the rest 3,072 B (+338), transition
   1,895 B (+184); the minimal page with swaps 16,894 B.
6. **Examples and docs:** the dashboard (its check committed) and RealWorld (swaps by default instead of
   the kept footer, the suite against a local backend), a headed-browser run, the docs above, sizes before
   and after.
   **Done** on `swap-navigation`:
   - **The dashboard** (`sinter({ swap: true })`, a latency page, the layout's kept player and notes) and its
     check, `examples/dashboard/e2e-swap.mjs`, in CI in Chromium, Firefox and WebKit: one page load across a
     link and Back, the sound playing on, notes and drawer kept, one event stream open at a time. It found
     a core bug: a flush scheduled before `destroy()` (a stream's frame flush) ran after it, on elements
     `destroy()` had released (WebKit, a component's state); `flush()` now does nothing on a destroyed app
     (`destroy.test.ts`).
   - **RealWorld** with `swap: true` instead of the kept footer, the settings form's `upsert` and
     `navigate()`, the islands' `navigate()`: 140 of 140 against a local backend (realworld-django-ninja),
     the base 136.
   - **Headed browsers** (`HEADED=1 xvfb-run node e2e/permanent/run.mjs`): Chromium and Firefox pass every
     step; neither restored the swapped document from the back/forward cache after a load out of the app
     (it is loaded again, which is right too). Headed WebKit under xvfb crashes on any same-document view
     transition, with or without sinter: not testable here. The browser's own Back without activation
     needs a person at the keyboard: still to do.
   - **Docs:** `docs/navigation.md` (Swaps, Refusing a navigation, swaps and types in Page transitions),
     `docs/configuration.md` (`swap`), `docs/security.md` (the trust model), the RealWorld and dashboard
     READMEs; `llms.txt` 24,998 of its 25,000 B.
   - **The budget** (decided: trim first, then raise): the stub went from 1,908 to 1,732 B (the page-load
     types left to `transition.ts`, `precommitHandler` passed without detecting it: a browser without it
     ignores the option); the chain's own code did not get smaller by rewriting it. The minimal page with
     swaps on is then 16,747 B: it has a budget of its own, 17 KB (`scripts/size.mjs`); the minimal page
     without swaps keeps 15 KB.
   - **Sizes** (gzip, `scripts/size.mjs`, the base `aca5a78` and this branch): core 14,946 → 15,048 (+102:
     destroy, the attribute writer, `navigate()` and `popstate` asking the chain, the flush guard); minimal
     page 15,148 → 15,252 of its 15,360 B; with swaps on 16,901 B (the budget decision is open);
     query-links 828 → 1,663 and transition 802 → 1,895 (the chain, step 2); navigate 1,231, the stub 1,908,
     the rest 3,072 (loaded by the first swap); RealWorld pages +3.3 to +3.5 KB with swaps on (the article
     23,761 → 27,235 of its 27,648 B budget).
7. **Kept elements with bindings** ([3](#3-kept-elements)), after a spike of its own: reserved numbering,
   the one-markup check, the takeover (rows and branches adopted), the playback-property warning.
   **Done** on `swap-navigation` (the spike became the step):
   - **Reserved numbering:** a kept element's nodes get ids from `1,000,000 + (hash(name) mod 1000) × 1000`,
     the same on every page; the page's own numbering goes on after it. Two names with the same range, or
     more than 1000 bound nodes, are `SN346`. The core finds nodes by id in one walk of the document, so a
     kept element in another place is found; row templates (`sn-t-N`) are the new page's own, at the end of
     its body.
   - **The one-markup check:** each kept element's source (file, offset, a hash of its text); the build
     reports `SN346` when a name binds on one page and another page writes it elsewhere or differently.
   - **The takeover:** before `destroy()`, the swap marks the lists and branches the old app rendered
     inside kept elements with the early script's marks (`sinter.early.rows`, `sinter.early`), which the
     core already adopts: rows (when as many as the new items; keyed rows then match by key) and the shown
     branch. The core exposes its root bindings (`app.rbs`) for it; the rest is in the swap's lazy part.
   - **The warning:** `SN541` for a bound `muted` (or another playback property) on media in a kept
     element (`data-sn-prop` is for custom elements only, so `data-sn-attr` is the one way).
   - Checked: `e2e/permanent` (a kept section in the layout with state, a text that follows the page, a
     keyed list and a branch: the same nodes after the swap, and its button works on the next page);
     `test/compiler/permanent.test.ts`, `test/vite/swap.test.ts`.
   - **The nonce and built-in messages** (after step 7, `e2e/swap-csp`, in CI): pages served with a fresh
     nonce per response (on every inline style and script, in the policy, in `<meta name="csp-nonce">`) and
     the app's messages in English and German. It found three bugs, fixed: the language picker's
     `data-sn-i18n` lists each page's own dictionary files, so comparing it whole made every swap a load
     (the swap compares its settings, and loads the next page's dictionary for the current language
     before it mounts, merged with the one the page shown reads); the page module of an app with messages
     returned `undefined` from its mount, which the swap took for a failure and reloaded; Chromium reports
     a parsed page's inline styles against the document's policy whatever the parser
     (`navigation-api/parse-csp.cjs`), so the swap puts the document's nonce on the page's styles and
     scripts before the parse.
   - **The second review** (a Fable agent, of `563f0af`; each finding reproduced in the browsers, each fix with
     a step that failed before it):
     - constant props shaped a kept element (a branch decided, bindings dropped at build time), so its ids
       and bindings differed between pages and the next page bound the wrong nodes or none: with swaps on,
       nothing inside a kept element is folded, decided or unrolled (`test/compiler/permanent.test.ts`, the
       `kind` constant in `e2e/permanent`);
     - a history write while the swap fetched (a `$url` write, a script's `replaceState`) aborted it and the
       link was lost, or after Back the address was A's and the page B's: the stub sees the abort, and when
       the latest `navigate` event was a same-document write, navigates again (before the URL committed) or
       loads the entry (after);
     - a link to a page that ships no JavaScript was requested twice (the swap found no page module and
       loaded it): such a page is swapped in with nothing to mount;
     - an error in the commit (a malformed `#hash`) left a half-swapped, unbound page: the commit reloads
       on any error; an error while preparing is a load;
     - a kept element inside another was removed from the page: `SN346`, and the swap keeps only the outer;
     - a link to another site asked no guard where the Navigation API exists: its event asks them while it
       can be refused, and since WebKit fires no `navigate` event for such a link, `navigate.ts` asks them
       on its click;
     - a `#hash` with no target kept the old page's scroll position: the page starts at the top first.
     Not changed (low, or kept for later): stylesheet order in the head after a swap, apps mounted on
     elements not destroyed by a swap, the guards and `onGo` running twice for nested mounts without the
     API, a traversal between two entries of one path the swap made, a bound head stylesheet both pages
     have, `rel="alternate stylesheet"` never loading.
   - **Left:** a `data-sn-model` field inside shows its state's value again (the state starts again);
     rows over data that is not there at mount (no `cache`) are built again; a stream both pages use
     reconnects.
