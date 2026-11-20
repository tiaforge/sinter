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

A long list or an expensive filter can wait for the typing to pause: `data-sn-model-debounce` on the
field delays the model's write, while the field shows each keystroke at once.

```html
<input type="search" data-sn-model="q" data-sn-model-debounce="200">
```

The pause takes the place of the typing pause, it does not add to it: a resource whose `src` reads `q`
loads right after the 200 ms, and a model on `$url` writes one history entry then. Enter, or leaving
the field, writes at once (so a form sent with Enter sends what was typed). `data-sn-model-debounce` is for a
form field's model; a component waits inside itself. On a field with an action too, `data-sn-debounce`
still delays the action and `data-sn-model-debounce` the model, each by its own pause.

To show the text at once in one place and filter after the pause in another, keep the model instant and
delay a handler that copies it: `<input data-sn-model="q" data-sn-on-input="term = q" data-sn-debounce-input="200">`,
then filter by `term`.

## Attributes

| Attribute | Meaning |
| --- | --- |
| `name` | Identifier used in expressions. Required, must be a valid JavaScript identifier. |
| `src` | URL template, reloaded when its interpolated values change. Required unless `call` is set. With [`sinter({ apis })`](apis.md) a path relative to an API (`/contacts`, `billing:/invoices`), checked against its spec. |
| `method` | `POST` for an endpoint that loads data with a request body (search, reports). Without it, GET. Not with `cache`, `paginate` or `each` ([docs/apis.md](apis.md#resources-that-load-with-post)). |
| `body` | With `method="POST"`: the request body, a value sent as JSON; the resource reloads when it changes. |
| `call` | Instead of `src`: one call of a [local action](actions.md), `ns.fn(args)`. Reloads when the arguments' inputs change. |
| `key` | Comma-separated item fields that form the identity. Required for collections; without it the resource is a single object. |
| `items` | Path to the array in the response. Default: the response itself. |
| `total` | Path to a total count, exposed as `$meta.<name>.total`. |
| `order` | Field kept sorted when items are inserted. `-field` sorts descending. Strings compare locale-aware. |
| `when` | Value expression. While falsy the resource is empty (`null` or `[]`) and a running request is aborted. |
| `cache` | Show the data from the last page load at once, then revalidate. No value means any age; `30s`, `10m`, `2h` or `1d` ignores older data. |
| `refresh` | Reload in the background once the data is this old, a duration: `30s`, `5m`, `1h`, `1d` (at least `1s`). |
| `each` | `item in list`: one request per item of another list, merged into one collection. |
| `then` | Handler run after each successful load, with `$result`. |
| `type` | Type of what `items` selects, for the [type checker](type-checking.md). |

Paginated resources add more attributes; see [pagination](pagination.md).

A composite key joins fields: `key="account_id,uid"`. Keys are compared as joined strings, and a
duplicate key in a response keeps the last item (with a warning in dev builds).

## Single objects

Without `key` the resource is one object, such as the signed-in user. `upsert` replaces it, `merge`
merges fields into it and `remove` sets it to `null`.

## Status: `$meta`

Status lives under `$meta.<name>`, never on the data. The field set is fixed; any other field is a
build error, and so is a pagination field on a resource that is not paginated
([diagnostics](diagnostics.md)).

| Field | Meaning |
| --- | --- |
| `loading` | A request for this resource is in flight. |
| `error` | `{status, body, message, detail}` after a failed load (as [`$error`](actions.md#then-and-catch)), `null` once a load succeeds. |
| `loadedAt` | When the last load succeeded, a `Date` like `$now` (`relative($meta.x.loadedAt)`), `null` before the server has answered on this page. |
| `total` | From the `total` path, adjusted by optimistic removes. `null` if unknown. |
| `live` | The server-event stream feeding the resource ([sync](sync.md#connection-status)): `'connecting'` until it first opens, `'open'`, `'retrying'` after a failure; `null` when no `<sn-event>` feeds the resource. |

Pagination adds `page`, `pages`, `from`, `to`, `hasPrev` and `hasNext`.

## Changing a resource

Resources are read-only in expressions. To edit an item, copy it with `structuredClone(c)`, and write
with these store functions, usable in any handler:

| Function | Effect |
| --- | --- |
| `refresh('a', 'b')` | Reload the named resources. |
| `upsert('name', item)` | Insert or replace by key. |
| `merge(item, {…})` | Merge fields into an item. |
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

- The clock restarts after every load, whatever caused it: a server event reload, `refresh()`, a
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
- It runs on every load: the first, `refresh()`, reloads from events, a changed `src`, each page of
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

## Files

`src="file:…"` reads the project at build time: one file, or with a glob a list of them.

```html
<sn-resource name="intro" src="file:./intro.txt"></sn-resource>
<sn-resource name="team" src="file:/content/team.json" items="people" key="id" type="Person[]"></sn-resource>
<sn-resource name="post" src="file:./hello.md" type="Post"></sn-resource>
<sn-resource name="posts" src="file:/content/posts/*.md" type="Post" order="-date" drafts="draft"></sn-resource>

<p data-sn-text="intro"></p>
<h1 data-sn-text="post.title"></h1>
<ul><template data-sn-for="p in posts"><li><a data-sn-attr="{ href: '/blog/' + p.slug + '/' }" data-sn-text="p.title"></a></li></template></ul>
```

| File | Value |
| --- | --- |
| `.md`, `.markdown` | its frontmatter's fields and `body`, the markdown after the frontmatter (`{ body }` without frontmatter) |
| `.json` | its parsed value |
| any other | its text |

- **Frontmatter** is YAML between `---` lines at the start of the file, read with YAML's core schema: a date
  stays a string (`date: 2026-11-16` is `'2026-11-16'`, which `date()` formats as a calendar date), and `yes`
  is a string. Anchors, aliases and tags are refused, and so are fields named `body`, `dir` or `path`, which
  sinter writes. For the markdown itself, see [sinter-markdown](../packages/sinter-markdown/docs/markdown.md):
  `md.parse(post.body)`.
- **A glob** (`*` within a folder, `**` across folders, `?` one character, `{a,b}` either) is a list with one
  entry per file, sorted by path. Each entry is the file's value, a text file's as `{ body }` and a `.json`
  file's an object, with `slug` (the file's name without its extension, unless the file gives a `slug`),
  `dir` (its folder below the glob's fixed part: `2026` for `content/posts/2026/recap.md`, or `''`) and
  `path` (from the project root). `key` is `slug` unless given; two entries with one key are an error, so in
  nested folders give the files distinct names or their own `slug`. Folders named `node_modules` or starting
  with a dot are skipped. A glob that matches nothing is warning `SN539`.
- **`order`** sorts the list once, at build time: `-date` descending, a missing value last, strings in the
  page's language (its `<html lang>`), as a live resource sorts in the visitor's.
- **`drafts="draft"`** names a field: an entry where it is `true` is left out by `vite build` and by
  `sinter check`, and kept by `vite dev`.
- **Types**: a markdown file is `{ body: string }`, and with `type="Post"` it is `Post & { body: string }`.
  On a glob, `type` names one entry: the list is `(Post & { slug: string; dir: string; path: string; body:
  string })[]` (`body` for markdown and text files). A markdown file or glob needs no `type`; a `.json` file
  or glob without one is `SN504`. With `type`, `sinter check` also checks every file against it: a field the
  type does not have (`titel:` in one post's frontmatter) or one it requires and the file leaves out is an
  error at that file, with TypeScript's "did you mean".
- **`{$locale}`** in a path, with [`sinter({ localePrefix })`](static-pages.md#languages), is each language's
  name: `file:/content/{$locale}/posts/*.md` reads `content/de/posts/` for the German pages. `sinter check`
  and the editor read the base language's. Without `localePrefix` it is `SN332`: the language is the
  visitor's, picked in the browser.
- The path is a literal: relative to the file that writes it (a page, a layout or a component), or `/…` from
  the project root. It must stay inside the project root (a symlink to a file outside it is refused too)
  and a single file must exist; an interpolation (`{…}`, other than a glob's `{a,b}`) is an error (`SN332`).
  With `sinter({ apis })` it is read the same way, and `file` cannot be an API's name (`SN329`).
- It is a constant: nothing loads, refreshes or changes it. `$meta.<name>.loading` is `false` and the
  other status fields are `null`. It takes only `name`, `src`, `type`, `items`, `key`, `order` and `drafts`;
  anything that would load or change it is `SN332`: `refresh`, `cache`, `paginate`, `each`, `call`, `when`,
  `then`, `early`, store functions that name it or change one of its items, write-through, and
  `<sn-event>`s. `items` picks a list out of one JSON file.
- Bindings over it are written into the page at build time, and so are helper calls over it (when the
  helper can run at build time: [static pages](static-pages.md#helpers-and-files-at-build-time)). What
  still runs in the browser reads it from embedded data in the page's head, so the first frame has it
  and no request is made; a file nothing in the browser reads is not in the page at all. It is not a
  placeholder for a server to fill (not in `sinter-embed.json`).
- The dev server reloads the page when a file it read changes, and when a file a glob matches is added or
  removed. The editor does the same: it checks the pages that read a file again when it changes or appears,
  and keeps what it read until then, so a glob over many files costs nothing per keystroke.
- `file:` is only for `<sn-resource src>`: an action or a stream sends a request.
- Any file inside the project root can be read this way, and what a page reads is written into the
  page it ships: keep secrets (`.env` files, keys) out of `file:` paths, as out of the page itself.

## Collections

`src="content:name"` reads a collection of the app's content module, `src/sinter.content.ts`: a list made by code
at build time, from a CMS, a database, an API or files, before any page compiles.

```ts
// src/sinter.content.ts
import { collection } from '@tiaforge-ui/sinter/content';

export const products = collection({
  key: 'sku',
  load: async ({ env }) => {
    const r = await fetch('https://cms.example.com/api/products', { headers: { authorization: `Bearer ${env.CMS_TOKEN}` } });
    if (!r.ok) throw new Error(`CMS: ${r.status}`);
    return r.json();
  },
});

export const tags = collection({
  key: 'slug',
  load: async ({ files }) => {
    const by = new Map();
    for (const p of await files('content/posts/*.md', { drafts: 'draft' })) for (const t of p.tags ?? []) by.set(t, [...(by.get(t) ?? []), p]);
    return [...by].map(([slug, posts]) => ({ slug, posts }));
  },
});
```

```html
<sn-resource name="products" src="content:products" type="Product" order="name"></sn-resource>
```

- **Every export is a collection**, `collection({ key, load })`: `key` names the field that tells entries apart,
  and `load` returns the list. An export that is not a collection (a helper) fails the build: helpers go in the
  helpers module.
- **`load` gets a context**: `files(glob, { drafts })` reads files as a [`file:` glob](#files) does (paths from
  the project root); `get(other)` is another collection's list, loaded once whoever asks; `env` has the variables
  of Vite's `loadEnv` (`.env`, `.env.production` and the process's, every prefix); `command` is `'build'` or
  `'serve'`.
- **Once per build, in Node, before any page compiles**, through Vite with the app's config, so its aliases and
  plugins apply. The collections run concurrently. Nothing of the module ships: it may fetch, read the disk and use
  secrets; what ships is what a page reads of the list.
- **The result is checked**: a list of plain data (arrays, objects, strings, numbers, booleans, `null`; a `Date` is
  refused, return `toISOString()`), each entry an object with a unique `key`. A loader that throws, or a result
  that fails the check, fails the build, naming the collection; in `vite dev` the pages that read it show the error
  ([SN342](diagnostics.md#sn342-unknown-collection)). Errors lose their URLs' credentials and query and the values
  of `env`, since they are printed and shown in the browser in dev.
- **On a page** it is a constant list, as a `file:` glob is: bindings over it are written at build time, `order`
  sorts it in the page's language, `key` is the collection's, and a [page per entry](static-pages.md#a-page-per-entry)
  can be built from it. `drafts` and `items` are the loader's business.
- **What ships is named.** Bindings over a collection are written into the HTML and ship nothing. When code in the
  browser reads it (a filter as you type), it is embedded in the page, and only with `fields="sku,name,price"`:
  those fields of each entry. Without `fields` that is [SN344](diagnostics.md#sn344-content-fields), so what a CMS
  returns and no page shows never ships by accident. Fields left out are `undefined` in the browser (`sinter check`
  does not narrow the type to them). A page per entry (`data-sn-for` on `<html>`) follows its list's `fields`. A `file:` resource takes
  `fields` too, and without it ships whole.
- **`vite dev`** runs the loaders at startup and again when the content module or a file `files()` read changes,
  then reloads the page. A change in the CMS needs a restart, or a rebuild in production (a webhook to the CI).
- **`sinter check` and the editor never run loaders** (a CMS fetch per keystroke or per CI check would be slow,
  need secrets and depend on the network). A `content:` resource without `type` is typed from its loader's return
  type, so `p.nmae` is an error with `collection<Product>({ … })`; its values come from the snapshot each build and
  dev server writes (`node_modules/.cache/sinter/content.json`), and `sinter check` says when there is none yet, or
  when the content module changed since.
- **Per language**: with [`localePrefix`](static-pages.md#languages), `collection({ key, perLocale: true, load })`
  runs once per language with `ctx.locale` (`load: ({ locale }) => cms.products({ locale })`), and each language's
  pages read its own list; `sinter check` and the editor see the base language's. A collection every language
  shares cannot `get` one that differs per language. Without `localePrefix`, `perLocale` is an error.
- **An index in pages**: `chunks(list, size)` from `@tiaforge-ui/sinter/content` gives `{ n, items, count }` per page,
  `n` from 1: a collection of pages for a [page per entry](static-pages.md#a-page-per-entry) at `/blog/page/:n`.
- `sinter({ content: false })` turns the module off. `content` cannot be an API's name (SN329).

## Loading behavior

- **Shared requests.** Resources with the same resolved `src` share one request, for example one
  endpoint that returns two lists.
- **Latest wins.** Changing `src` aborts the running request, and a late answer for an old URL is
  discarded.
- **Typing.** When `src` or `when` changes only because of keystrokes in a text field with
  `data-sn-model`, the request waits until typing pauses for 250 ms. The shown data stays and
  `loading` is not set. A select, checkbox or handler triggers the request at once. A text field
  bound to the URL (`data-sn-model="$url.q"`) waits the same, and writes the URL at that pause too.
- **Priority.** A resource read only inside `<dialog>` elements is requested with low priority.
- **Coming back.** Restoring a page from the back/forward cache, or going back online, reloads
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
