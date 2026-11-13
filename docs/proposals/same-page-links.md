# Proposal: same-page links stay on the page

Status: proposed (2026-11-13). Follows [bindable URL parameters](url-bindings.md).

Decided with the user:
- A plain click on a link to the same page, with another query string, is handled in the page: no
  new attribute and no handler. The link stays a link.
- Only links whose path stays the same; a link to another path still loads that page.
- It does not address RealWorld's four failing settings tests (a form's redirect to another page);
  those stay a documented limitation of the suite's `spa` branch for multi-page apps.

Open, with a recommendation each: [Open decisions](#open-decisions).

## Goals

1. **Links that change only the query behave like `$url` writes.** `<a href="?page=3">` moves a
   `page-model` list, `<a href="?feed=following">` switches a view, `<a href="?sort=new">` sorts:
   one history entry, a request for what changed, the rest of the page as it was.
2. **Links stay links.** Crawlers, Ctrl/Cmd-click and middle-click (a new tab), "copy link", and
   pages without JavaScript work as before.
3. **Nothing to write.** The `href` already says where the link goes; saying it again in a handler
   could drift from it.

## The case

`page-model` keeps a list's page in the URL, but a pager made of links reloads the page on every
click: RealWorld's pager does, and so do its "Your Feed / Global Feed" tabs on `/`. The page is
fetched again, the early file runs, the list flashes back in, and `page()`'s in-page history is
never used. Making a link in-page today takes a handler that must leave modified clicks alone:

```html
<a href="?page=3" data-sn-on-click="if (!$event.ctrlKey && !$event.metaKey && !$event.shiftKey && !$event.altKey && $event.button == 0) { $event.preventDefault(); page('articles', 3) }">3</a>
```

That is easy to get wrong, says the target twice, and is the kind of code sinter's pages should not
need.

## What sinter has to build on

- `$url` is bindable, and history behaves as in an SPA ([navigation.md](../navigation.md#the-url-and-the-history)):
  a user's event pushes, Back and Forward re-read `$url` and never write.
- Everything that reads `$url` already follows a change: models refill, resources whose `src`
  changed refetch, a `page-model` list loads the parameter's page, a changed filter starts it at
  page 1.
- `location.ts` writes the history; the core re-reads `$url` on `popstate` (`readUrl`).
- Next-page data (`prefetch.ts`) listens for links about to be followed, and skips only a link to
  the identical URL (`prefetch.ts:87`): a same-path link with another query is prefetched today.
- The generated Speculation Rules (`speculationRules` in `prefetch-build.ts`) match the app's
  pages with any query (`\?*#*`), same-page links included.

## Design

### 1. Which links

A click is handled in the page when all of these hold:

- the target is an `<a href>` (or `<area href>`) in the page, without `download` or a `target`
  other than `_self`;
- the event is a primary-button `click` without Ctrl, Meta, Shift or Alt, and nothing prevented its
  default (a handler on the link that calls `$event.preventDefault()` keeps it);
- the URL it resolves to has the page's origin and **the same path** as the current URL, and its
  query differs. A link that changes only the hash is the browser's, as today.

Path parameters (`data-sn-path`'s `:name` segments) are part of the path: `/tag/go?page=2` →
`/tag/go?page=3` stays; `/tag/go` → `/` loads `/`.

### 2. What happens

1. `pushState(href)`: a new history entry, as for any `$url` write a user's event causes. A
   pending typing commit goes into the entry before it (the typing run ends, as at a push).
2. `$url`'s query parameters become exactly the link's: names missing from it are removed, array
   parameters read as lists. Path parameters do not change.
3. It is marked as a change, not as Back: everything follows as after a handler's write. A
   `page-model` list loads the link's page (`?page=3`); a filter link (`?tag=js`) changes the
   list's `src`, which starts it at page 1 and deletes `page` in the same entry.
4. A `#hash` in the link: the element with that id is scrolled into view, as the browser would.
   Otherwise the scroll position stays (see [Open decisions](#open-decisions), 2).

Back and Forward between such entries are the existing `popstate` path: nothing new.

### 3. Next-page data and Speculation Rules

- **Next-page data** for a same-page link is not lost: a load the click causes first takes what
  hovering the link prefetched (`ext.prefetch.take`, as the first load does), so a filter link's
  data can be there before the click. Paginated resources are not prefetched, as today.
- **Speculation Rules** must not fetch the page's own HTML for a link that never leaves it. A page
  that loads this feature adds an exclusion for its own path with any query. Whether
  `{ not: { href_matches: '?*' } }` (a pattern relative to the document, inheriting its path) does
  that in Chromium is to be verified first; otherwise the rules exclude the page's literal paths,
  and a pattern page (`/tag/:tag`) keeps the prefetch (a wasted request, not a wrong page).

### 4. Where it lives

A small feature module, `@tiaforge-ui/sinter/links` (estimated 250–350 B gzip): one `click`
listener on the root, the checks of 1, and the write of 2 through `location.ts`. The compiler loads
it on pages that read `$url` and have a link (a static `href`, or one `data-sn-attr` sets), and it
brings `location.ts` with it. A page that reads no `$url` gains nothing from it and does not load
it.

### 5. Testing

`render()`'s simulated clicks count as the user's: a click on a same-page link changes `url()` and
`history()`, and `navigations` (the URLs sinter tried to load) stays empty. A test for each rule of 1.

## Open decisions

1. **State.** A reload starts `data-sn-state` fresh (drafts, open dialogs, selections); in the page it
   stays. **Recommended: it stays.** The user did not leave the page, and a `$url` write from a
   handler or a model keeps state today. A page that relied on the reload to reset it behaves
   differently: the CHANGELOG says so.
2. **Scroll.** A reload goes to the top (or the `#hash`). **Recommended: the position stays, a
   `#hash` is followed**, as for any `$url` write; a pager at the bottom of a long list stays at the
   bottom while the list above it changes. The alternative, to the top as a reload does, suits
   pagers and breaks filter chips at the top. A link that wants the top can point at an anchor
   (`href="?page=3#list"`).
3. **Scope.** **Recommended: the same path only.** A different path parameter on the same page file
   (`/article/a` → `/article/b`) replaces every resource, and 1 and 2 weigh more; it is close to a
   client-side router. It can come later if needed.
4. **Opting out.** **Recommended: nothing at first.** A link that must reload can call
   `location.assign` in a handler. If real pages need it, an attribute later.

## Breaking changes

- A same-page link that changes the query no longer reloads the page (state stays; see 1).

## Not in this proposal

- Links to another path or page (a client-side router).
- Navigating in code (`go(url)`): considered and dropped. Next-page data revalidates anyway (two
  requests), embedded resources are not prefetched, an automatic version through the Navigation
  API loses its requests when the next page commits, and the next page's early file already
  requests its data first.
- RealWorld's settings tests (see Decided).
- Focus and announcements beyond what the browser does for a same-document history change.

## Plan

One commit each:

1. **The module:** `links.ts` (the checks, the write through `location.ts`, the hash), the compiler
   loading it, `take` for loads a click causes; testing support and tests for each rule.
2. **Speculation Rules:** verify the relative exclusion in Chromium (a Playwright check), then the
   exclusion in `speculationRules`, with a build test.
3. **Docs and RealWorld:** navigation.md (a section "Same-page links", the history table's row),
   spec.md, pagination.md (a pager of links), llms.txt, CHANGELOG; RealWorld's pager and feed tabs
   are then in-page with no change to the pages, its README notes it; a Chromium test (a pager of
   links: click, Back, Ctrl-click opens a new page).

Sizes before and after: the core (unchanged), the module, RealWorld index and profile.
