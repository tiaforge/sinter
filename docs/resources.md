# Resources

A resource is a named, page-wide cache of one piece of server data: a keyed collection or a single
object. You declare it once, read it by name anywhere on the page, and it stays current through
reloads, [server events](sync.md) and [optimistic updates](actions.md). Templates only read it;
changes go through store functions.

```html
<sn-resource name="people" src="/api/people" items="people" key="id" order="name"></sn-resource>

<section data-sn-state="{ q: '' }">
  <input type="search" data-sn-model="q">
  <p data-sn-show="$meta.people.loading" aria-busy="true">Loading…</p>
  <ul>
    <template data-sn-for="p in people.filter(p => p.name.toLowerCase().includes(q.toLowerCase()))">
      <li data-sn-text="p.name"></li>
    </template>
  </ul>
</section>
```

Loading needs no code. The list stays sorted by `name`, and the old data stays on screen during a
reload. See `docs/recipes/list-filter.html`.

## Attributes

| Attribute | Meaning |
| --- | --- |
| `name` | Identifier used in expressions. Required, must be a valid JavaScript identifier. |
| `src` | URL template, refetched when its interpolated values change. Required unless `call` is set. |
| `call` | Instead of `src`: one call of a [local action](actions.md), `ns.fn(args)`. Reloads when the arguments' inputs change. |
| `key` | Comma-separated item fields that form the identity. Required for collections; without it the resource is a single object. |
| `items` | Path to the array in the response. Default: the response itself. |
| `total` | Path to a total count, exposed as `$meta.<name>.total`. |
| `order` | Field kept sorted when items are inserted. `-field` sorts descending. Strings compare locale-aware. |
| `when` | Value expression. While falsy the resource is empty (`null` or `[]`) and a running request is aborted. |
| `cache` | Show the data from the last page load at once, then revalidate. No value means any age; `30s`, `10m`, `2h` or `1d` ignores older data. |
| `refresh` | Reload in the background once the data is this old: `30s`, `5m`, `1h` (at least `1s`). |
| `each` | `item in list`: one request per item of another list, merged into one collection. |
| `then` | Handler run after each successful load, with `$result`. |
| `type` | Type of what `items` selects, for the [type checker](type-checking.md). |

Paginated resources add more attributes; see [pagination](pagination.md).

A composite key joins fields: `key="account_id,uid"`. Keys are compared as joined strings, and a
duplicate key in a response keeps the last item (with a warning in dev builds).

## Single objects

Without `key` the resource is one object, such as the signed-in user. `upsert` replaces it, `patch`
merges fields into it and `remove` sets it to `null`.

## Status: `$meta`

Status lives under `$meta.<name>`, never on the data. The field set is fixed; any other field is a
build error, and so is a pagination field on a resource that is not paginated
([diagnostics](diagnostics.md)).

| Field | Meaning |
| --- | --- |
| `loading` | A request for this resource is in flight. |
| `error` | `{status, body, message}` after a failed load, `null` once a load succeeds. |
| `loadedAt` | Time (ms) of the last successful load, `null` before the server has answered on this page. |
| `pending` | Number of optimistic changes whose request has not settled. |
| `total` | From the `total` path, adjusted by optimistic removes. `null` if unknown. |

Pagination adds `page`, `pages`, `from`, `to`, `hasPrev` and `hasNext`.

## Changing a resource

Resources are read-only in expressions. To edit an item, copy it with `structuredClone(c)`, and write
with these store functions, usable in any handler:

| Function | Effect |
| --- | --- |
| `refresh('a', 'b')` | Reload the named resources. |
| `upsert('name', item)` | Insert or replace by key. |
| `patch(item, {…})` | Merge fields into an item. |
| `remove(item)` | Remove an item. |

A successful mutation's response is already applied to the right resources, so these are mostly
for local edits; see [actions](actions.md).

## Caching across page loads

`cache` shows the data from the last page load before the network answers, then revalidates:

```html
<sn-resource name="inbox" src="/api/messages?folder=inbox" key="id" order="-date" cache="1h"></sn-resource>

<p data-sn-show="$meta.inbox.loading && inbox.length">Updating…</p>
```

With data present, `loading` means "updating". `loadedAt` stays `null` until the server has
answered, so guards like `$meta.user.loadedAt && !user` never act on cached data. A failed
revalidation keeps the cached data and sets `error`. See `docs/recipes/cached-list.html`.

- Entries live in `sessionStorage`, so they last one tab's lifetime. They are keyed by request URL
  and the `items` and `total` paths, so two pages loading the same data share an entry.
- Only the first load reads the cache; a `src` that changes later does not.
- An entry over 256 KB is not written.
- Every entry is removed on any 401 response and by `clearPersisted()`, which apps call on logout.

## Background refresh

`refresh` reloads a resource once its last load is that old. Use it for data no stream updates, or
as a safety net for one that might miss events.

```html
<sn-resource name="jobs" src="/api/jobs" key="id" refresh="30s"></sn-resource>
```

- The clock restarts after every load, whatever caused it: a server event refetch, `refresh()`, a
  reconnect, a changed `src`. A resource a stream reloads often is rarely refreshed.
- The reload is silent: `loading` stays false, so a spinner binding does not flicker every 30 s.
- Nothing is reloaded while the tab is hidden; a refresh that fell due runs when it is shown again.
- Failures back off, doubling the wait up to 30 s, and are reported once, not on every try.
- The wait varies by ±10 %, so pages opened together do not reload together.
- If the server sends an `ETag` (or `Last-Modified`) and the data has not changed, the response is
  not parsed or re-rendered. Answer unchanged data with the same `ETag` and a refresh costs a `304`.
  Send `Cache-Control: no-cache` with it, and expose `ETag` via `Access-Control-Expose-Headers` for
  cross-origin APIs.

## After a load: `then`

`then` is a handler run after every successful load, with `$result` set to what was stored (what
`items` selects, or the whole response).

```html
<sn-resource name="body" src="/api/messages/{open.id}/body" when="open"
             then="$result && !open.is_read && run('mark-read')"></sn-resource>
```

- It sees the state around the resource and may assign it. Store functions and `run('id')` work.
- It runs on every load: the first, `refresh()`, refetches from events, a changed `src`, each page of
  a paginated resource, and embedded data. It does not run for cached data shown early, failed loads,
  or changes that are not loads (optimistic updates, `upsert` from events).
- So a handler meant to run once must guard itself, one step per guard. A handler that refreshes its
  own resource loops.
- An exception in the handler is logged; the load still counts as successful.

## Fan-out with `each`

Some APIs list a collection per parent. `each` makes one request per item of another list and merges
the results into one collection:

```html
<sn-resource name="accounts" src="/api/accounts" key="account_id"></sn-resource>
<sn-resource name="mailboxes" each="a in accounts" src="/api/mailboxes?account_id={a.account_id}"
             key="account_id,name" order="name"></sn-resource>
```

- `key` is required and must tell the sources apart, as `account_id` does here. `paginate`, `total`
  and `cache` do not combine with `each`.
- When the list changes, only new sources load and a removed source's items are dropped.
- `loading` is true while any source loads. `loadedAt` is set once every current source has answered.
- `refresh('mailboxes')` reloads every source. `then` runs once per source response.
- If you control the server, prefer one endpoint for the whole collection.

## Loading behavior

- **Shared requests.** Resources with the same resolved `src` share one request, for example one
  endpoint that returns two lists.
- **Latest wins.** Changing `src` aborts the running request, and a late answer for an old URL is
  discarded.
- **Typing.** When `src` or `when` changes only because of keystrokes in a text field with
  `data-sn-model`, the request waits until typing pauses for 250 ms. The shown data stays and
  `loading` is not set. A select, checkbox or handler triggers the request at once.
- **Priority.** A resource read only inside `<dialog>` elements is requested with low priority.
- **Coming back.** Restoring a page from the back/forward cache, or going back online, refetches
  every resource. Resources a stream feeds are left to the stream's reconnect.
- **Immutable data.** Items are frozen in dev builds. Changes always replace the item object.

## Data from the server

Besides fetching `src`, a resource can start from JSON embedded in the page:

```html
<script type="application/json" data-sn-data="people">[{"id": 1, "name": "Ada"}]</script>
```

That payload is the first load and no request is made. An empty placeholder counts as no data, so
the resource loads normally. Who writes the JSON is up to your server or middleware; see
[first paint](first-paint.md).
