# Proposal: same-page links stay on the page

Status: proposed (2026-11-13), reviewed for fit with sinter's design (2026-11-14). Follows
[bindable URL parameters](url-bindings.md).

Decided with the user:
- A plain click on a link to the same page that changes only query parameters the page reads is
  handled in the page: no new attribute and no handler. The link stays a link.
- **The invariant:** a same-page link shows what loading its URL would show. Only the state the user
  made (`data-sn-state`) and the scroll position differ. Every rule below follows from it.
- Only links whose path stays the same, permanently: crossing a path is routing, a Non-goal.
- State stays; the scroll position stays and a `#hash` is the browser's; no opt-out attribute.
- The module is `@tiaforge-ui/sinter/query-links`.
- It does not address RealWorld's four failing settings tests (a form's redirect to another page);
  those stay a documented limitation of the suite's `spa` branch for multi-page apps.

## Goals

1. **Links that change only the query behave like `$url` writes.** A pager link moves a
   `page-model` list, a tab link switches a view, a sort link sorts: one history entry, a request
   for what changed, the rest of the page as it was.
2. **Links stay links.** Crawlers, Ctrl/Cmd-click and middle-click (a new tab), "copy link", and
   pages without JavaScript work as before.
3. **Nothing to write beyond the `href`.** The link already says where it goes; saying it again in
   a handler could drift from it.

## The case

`page-model` keeps a list's page in the URL, but a pager made of links reloads the page on every
click: RealWorld's pager does, and so do its "Your Feed / Global Feed" tabs on `/`. The page is
fetched again, the early file runs, the list flashes back in. Making a link in-page today takes a
handler that leaves modified clicks alone and repeats the target:

```html
<a href="?page=3" data-sn-on-click="if (!$event.ctrlKey && !$event.metaKey && !$event.shiftKey && !$event.altKey && $event.button == 0) { $event.preventDefault(); page('articles', 3) }">3</a>
```

That is easy to get wrong and is the kind of code sinter's pages should not need.

A link that changes only the query is to a sinter page what a `#hash` link is to any page: the same
document, another state of it. That is the whole idea, and the limit of it: no route table, no path
handling, no content swap.

## What sinter has to build on

- `$url` is bindable, and history behaves as in an SPA
  ([navigation.md](../navigation.md#the-url-and-the-history)): a user's event pushes, Back and
  Forward re-read `$url` and never write.
- Everything that reads `$url` already follows a change: models refill, resources whose `src`
  changed refetch, a `page-model` list loads the parameter's page.
- Back and Forward already have the rule this needs: a `page-model` list loads the URL's page and
  never resets it.
- The compiler knows each `$url.<name>` a page reads.
- Next-page data (`prefetch.ts`) already prefetches a same-path link with another query (it skips
  only the identical URL), and the Speculation Rules match the app's pages with any query.

## Design

### 1. Which links

A click is handled in the page when all of these hold:

- the target is an `<a href>` (or `<area href>`), without `download`, without a `target` other than
  `_self`, and without `rel="external"`;
- the event is a primary-button `click` without Ctrl, Meta, Shift or Alt, and nothing prevented its
  default;
- the URL it resolves to has the page's origin and **the same path** (path parameters included:
  `/tag/go?page=2` → `/tag/go?page=3` stays, `/tag/go` → `/` loads `/`);
- **every query parameter that differs is one the page reads.** The build lists the names the
  page's expressions read as `$url.<name>` (array parameters included). A parameter the page does
  not read (`?lang=de`, `?preview=1`, one a server or an island acts on) makes the click load the
  URL, as today. A page that reads `$url` by a computed name, or the whole `$url` object, gets no
  list and every click loads.

Parameters are compared by name and values, not as a string: `?a=1&b=2` is `?b=2&a=1`.

A link to the current URL (the active page of a pager, the active tab) is handled in the page and
changes nothing, as a `$url` write of the current query adds no entry. A link that changes only the
hash is the browser's, as today.

The same link may stay on one page and load from another (in a layout, a component): correct under
the invariant, since it depends on what each page reads. The docs say so.

### 2. What happens

1. A pending typing commit goes into its own entry first (the typing run ends, as at any push).
2. `pushState` the link's URL without its hash: a new entry, its query as the link wrote it
   (`?page=1`, `?tag=` stay literal, so the address bar is what "copy link" gave; a `$url` write
   would normalize them).
3. `$url`'s query parameters become exactly the link's (names missing from it are removed, array
   parameters read as lists); path parameters do not change.
4. Everything follows as after Back or Forward, which is what loading the URL would show: a
   `page-model` list loads the link's page and is not reset, so `?tag=js&page=3` shows page 3, and
   `?tag=js` alone shows page 1 because it names none. Models refill, resources refetch.
5. A `#hash` in the link: `location.replace('#' + id)` after the push, a native fragment navigation
   in the same entry, so `:target`, `scroll-margin` and the focus starting point behave as in any
   page (to verify in Chromium, Firefox and WebKit). Without one, the scroll position stays.

### 3. What it does not do

- **No view transition.** With `@view-transition { navigation: auto }` (temper) every page load
  cross-fades today, and `pageswap`/`pagereveal` fire; an in-page link does neither. That is
  intended: the list keeps its rows until the response, as with `page()`. No `startViewTransition`
  around it: the data arrives later, and it would be a second transition system.
- **No `<form method="get">`.** A form to the same page with only a query is not covered: a
  `data-sn-model="$url.q"` is the one way to bind a field to the URL, and a submit serializes fields
  rather than naming a URL. The docs say so.
- **Focus and announcements** stay what the browser does for a same-document history change, as for
  `page()`. The docs show what a pager should carry: `aria-current="page"` from `$url.page`,
  `aria-busy` (temper's busy state) on the list, and the clicked link keeps focus when it is not
  re-rendered (a keyed list keeps it).

### 4. Next-page data and Speculation Rules

- A load the click causes first takes what hovering the link prefetched (`ext.prefetch.take`, as
  the first load does), so a tab's data can be there before the click. Paginated resources are not
  prefetched, as today.
- The Speculation Rules leave out the page's own URLs with another query on a page that loads this
  module: under `speculation: 'prerender'` a hover would otherwise prerender the page itself. First
  choice: a pattern relative to the document (`{ not: { href_matches: '?*' } }`), if Chromium
  resolves it against the page's path (to verify); otherwise the page's literal paths, which leaves
  a pattern page (`/tag/:tag`) with a wasted prefetch, not a wrong page.

### 5. Where it lives

`@tiaforge-ui/sinter/query-links` (estimated 250–350 B gzip): one `click` listener on the root, the
checks of 1 against the page's list of read names (in the IR), the write through `location.ts`. The
compiler loads it on every page that reads a query parameter by name, so links an island renders
are covered too; it brings `location.ts` with it. A page that reads no query parameter does not
load it.

### 6. Building links

`href="?page=3"` resolves to `?page=3` alone: standard URL resolution drops every other parameter.
On `/?feed=following` that link leaves the feed. The docs and the pagination recipe build the whole
query (as RealWorld's pager does), and the build warns for a static query-only `href` on a page that
reads other parameters (a new SN5xx warning).

### 7. Recommended form

A pager is links with `page-model`: crawlable, a new tab, copy link, and in the page with this
module. `page('next')` stays for relative moves and for buttons; the docs present links first.

### 8. Testing

`render()`'s simulated clicks count as the user's: a click on a same-page link changes `url()` and
`history()`, and `navigations` (the URLs sinter tried to load) stays empty; a click that changes a
parameter the page does not read is a navigation. A test for each rule of 1 and 2.

## Breaking changes

- A same-page link that changes only parameters the page reads no longer reloads: state stays, and
  there is no cross-document view transition.

## Not in this proposal

- Links to another path or page (a client-side router): not later either.
- Navigating in code (`go(url)`): considered and dropped. Next-page data revalidates anyway (two
  requests), embedded resources are not prefetched, an automatic version through the Navigation
  API loses its requests when the next page commits, and the next page's early file already
  requests its data first.
- An opt-out attribute: a parameter the page does not read already makes a link load, and
  `rel="external"` does for any link. Revisit if real pages need more.
- RealWorld's settings tests (see Decided).

## Docs

navigation.md's opening sentence becomes "A sinter app is multi-page: every navigation to another
page is a page load", followed by the `#hash` analogy and a section "Same-page links" (which links,
the invariant, what it does not do, the layout case, building the query); the history table gets a
row. spec.md, pagination.md (links first), llms.txt, CHANGELOG.

## Plan

One commit each:

1. **The module:** the read names in the IR, `query-links.ts` (the checks, the write, the hash),
   the compiler loading it, `take` for loads a click causes, the "load as Back does" rule for the
   pager; testing support and tests for each rule.
2. **The build warning** for a static query-only `href` that drops parameters the page reads.
3. **Speculation Rules:** verify the relative exclusion in Chromium (a Playwright check), then the
   exclusion in `speculationRules`, with a build test.
4. **Docs and RealWorld:** the docs above; RealWorld's pager and feed tabs are then in-page with no
   change to its pages, its README notes it; a Chromium test (a pager of links: click, Back,
   Ctrl-click opens a new page, a `#hash` link).

Sizes before and after: the core (unchanged), the module, RealWorld index and profile.
