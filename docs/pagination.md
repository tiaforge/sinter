# Pagination

Add `paginate` to a resource and it loads one page at a time. You get `page()` to move between
pages and `$meta` fields to draw the pager. sinter builds the requests; your API supplies the
pages.

```html
<sn-resource name="messages" src="/api/messages" items="messages" total="total" key="id"
  paginate="keyset" page-size="2" cursor="{before: id}"></sn-resource>

<ul>
  <template data-sn-for="m in messages"><li data-sn-text="m.subject"></li></template>
</ul>
<nav>
  <button data-sn-on-click="page('messages', 'prev')" data-sn-attr="{disabled: !$meta.messages.hasPrev}">‹</button>
  <span data-sn-text="`${$meta.messages.from}–${$meta.messages.to} of ${$meta.messages.total}`"></span>
  <button data-sn-on-click="page('messages', 'next')" data-sn-attr="{disabled: !$meta.messages.hasNext}">›</button>
</nav>
```

The first request is `/api/messages?limit=2`. `next` sends `limit=2&before=<id of the last item>`.
See `docs/recipes/pagination.html`.

## Modes

| Mode | Request parameters | `page()` targets | Fits |
| --- | --- | --- | --- |
| `keyset` | `cursor` fields read from the page's boundary item, plus a direction | `first`, `prev`, `next`, `last`; a page number with `offset-param` | Large or live lists where pages must not shift |
| `offset` | `page-param` (1-based) and `size-param` | All of the above, and a page number | Lists that need "go to page N" |
| `append` | Like `keyset`, `next` only | `next` | "Load more" and infinite scroll |

`append` keeps every loaded item in the list; the other modes replace the page.

## Attributes

| Attribute | Meaning |
| --- | --- |
| `paginate` | `keyset`, `offset` or `append`. |
| `page-size` | Items per page, sent as `size-param`. |
| `size-param` | Name of the size parameter. Default `limit`. |
| `cursor` | Object literal evaluated on the boundary item: the last item for `next`, the first for `prev`. `first` and `last` send no cursor. Fields that are `null` or `undefined` are left out. |
| `direction-param` | Name of the direction parameter, sent with `first`, `prev`, `next` or `last`. |
| `direction-values` | Keyset and append: rename directions the server names differently, such as `{first: 'forward', prev: 'backward', next: 'forward'}`. Unlisted directions are sent by name. `first` and `next` may share a value, since `first` sends no cursor. |
| `page-param` | Offset mode: name of the page parameter. Default `page`. |
| `offset-param` | Send items to skip instead of a page number. In offset mode, page n sends `(n - 1) × page-size`. In keyset mode, it also enables page numbers. |
| `page-model` | Offset mode: the URL parameter that holds the page, `$url.page`. See [Page in the URL](#page-in-the-url). |

`total`, `items` and `key` work as on any [resource](resources.md).

## Server requirements for keyset

- The cursor fields must form a unique, stable sort key, such as a timestamp plus a row id.
- `prev` and `last` read the list in reverse on the server, but the response must come back in
  display order.
- Directions are `first`, `prev`, `next` and `last`, or the values `direction-values` maps them to.

## Jumping to a page number

Keyset mode can jump only if the server can also skip by offset. With `offset-param="offset"`,
`page('messages', 7)` requests the `first` direction with `offset=300` (at page size 50) and no
cursor; `prev` and `next` then continue by cursor from there. Without `offset-param`, a literal page
number on a keyset resource is build error `SN304`. sinter never simulates a jump by stepping through
pages. A jump past the end is clamped to `$meta.<name>.pages` when the total is known.

## Page in the URL

`page-model="$url.page"` keeps an offset list's page in the URL: `?page=3` is read at load and
written back on every move, so reload, Back and Forward and a shared link show the same page.

```html
<sn-resource name="articles" src="/api/articles?tag={$url.tag}" items="articles" total="count"
  paginate="offset" page-size="10" offset-param="offset" page-model="$url.page"></sn-resource>

<button data-sn-on-click="page('articles', 'next')" data-sn-attr="{disabled: !$meta.articles.hasNext}">›</button>
<span data-sn-text="`${$meta.articles.from}–${$meta.articles.to} of ${$meta.articles.total}`"></span>
```

- The URL is the single source. `page()` loads nothing itself: it writes the page it moves to
  (a new history entry; page 1 deletes the parameter), and the list follows the parameter. A handler
  or a field that writes `$url.page` moves the list the same way, a typed one after the typing pause.
- `$url.page` is the page asked for: it changes at once. `$meta.<name>.page` is the page shown: it
  changes when the response arrives, and stays after a failure. Highlight the active page link with
  `$url.page`; show the range from `$meta`.
- `next` and `prev` count from the page last requested (after a failed load, from the page shown),
  so two quick clicks move two pages. A target past the last page is clamped when the total is
  known; without a total, `next` waits while a page loads. Asking again for a page that failed loads
  it again. With `when` false, `page()` does nothing.
- The first URL the list gets restores the URL's page, at load or when a late `when` turns true
  (RealWorld's feed waits for the user). Nothing is corrected: `?page=abc` is page 1, and `?page=99`
  shows an empty page.
- Changing a filter (any other change of the resource's URL) starts at page 1 and deletes the
  parameter, replacing the history entry: Back returns to page 3 with the old filter. Back and
  Forward load the URL's page and never reset it.
- Lists bound to the same parameter page together and reset together.
- The early request, preload and embedded data ask for the URL's page.
- Only on `paginate="offset"`, where every move has a page number when it is made (SN401 elsewhere:
  keyset and append lists move by cursor). The value is a query parameter, `$url.<name>` (SN203
  for anything else); the resource's own `src` or `when` cannot read it (SN401), since each page
  would reset the list.

`start-page` is renamed to `page-model` (SN401). A start page from a path segment (`/blog/page/3`),
from another expression, or for keyset lists with `offset-param` is gone: those lists start at page 1.
See `docs/recipes/url-pagination.html`.

## `$meta` fields

| Field | Meaning |
| --- | --- |
| `hasPrev`, `hasNext` | Whether a previous or next page exists. |
| `from`, `to` | 1-based positions of the current page. `null` when unknown. |
| `total` | From the `total` path. |
| `page` | Offset mode, and keyset with `offset-param`: the page holding the last item shown. |
| `pages` | Page count, when `total` is known. |
| `loading`, `error` | As for any [resource](resources.md). |

In keyset mode, `hasNext` is true when the page came back full, and `hasPrev` is false after `first`
or when a `prev` page comes back short. `from` and `to` are `null` after `last` without a `total`.
`page` is `ceil(to / page-size)`: exact after a jump, approximate after cursor steps on a list that
gained items meanwhile.

## Computed targets

The target of `page()` may be an expression, so one handler can serve both directions:

```html
<div data-sn-let="{ shown: searching ? 'results' : 'messages' }"
     data-sn-on-list-step="page(shown, $event.detail > 0 ? 'next' : 'prev')">
```

The resource name may also be chosen between literals. The type checker verifies a computed
target: on keyset without `offset-param` it must be a subset of `'first' | 'prev' | 'next' | 'last'`
([type checking](type-checking.md)). `append` accepts only the literal `'next'`.

## Behavior at the edges

- `prev` does nothing while `hasPrev` is false, and `next` while `hasNext` is false, in every mode:
  no request, no change. Before the first load both flags are false. You can keep the `disabled`
  binding on buttons for looks, but handlers need no guard.
- `first` and `last` always load. Since they send no cursor, `first` doubles as "reload from the
  top".
- `append` stops requesting at the end: after a short page `hasNext` is false.
- A target the resource cannot reach (a page number on keyset without `offset-param`, a string that
  is not a direction, `NaN`) sends no request. It sets `$meta.<name>.error` and takes the
  unhandled-error path, with a dev warning. The next load clears it.
- Changing `src`, for example another filter value, resets to the first page.
- Calling `page()` while a page is loading aborts the pending load.
- A refetch, from `refresh()`, `refresh="30s"` or a server event, repeats the current page's exact
  request, so a refresh never jumps. In `append` mode it reloads everything loaded so far as one
  request. A live keyset list that should pick up items added after a short last page uses these
  too, since a refetch recomputes `hasNext`.
- `then` runs after every page. `$result` is the page just loaded; in `append` mode, only the new
  items.
- With `cache`, each page's request URL has its own entry; `append` caches only its first page.
- On a paginated resource, a [server event](sync.md) that upserts a key not on the current page
  becomes a refetch of the current page. `patch` and `remove` apply only to items present.
- The first request is the first page as the pager sends it, so it can be preloaded or embedded;
  `page()` then moves on from it ([first paint](first-paint.md)).
