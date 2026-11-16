# Proposal: collections, build-time data and a page per entry

Status: draft, revised after a first review (see [Decisions](#decisions)). It builds on
[`file:` resources](../resources.md#files), on [pages without JavaScript](static-pages.md) (constant
loops unrolled, helpers over constants run at build time, page URLs, `data-sn-path`, the sitemap) and on
the per-language inputs of `localePrefix`. Line references are to `main` at 2b33230.

A blog in sinter today is one of two things:

- **One page per post, written by hand**: `hello.html` reads `file:./hello.md`, is plain HTML at build
  time and ships no JavaScript. Adding a post means adding a page, and the index lists the posts by hand
  or from a JSON file kept in sync with the folder.
- **One pattern page**: `post.html` with `data-sn-path="/blog/:slug"` reads `/api/posts/{$url.slug}`. One
  file answers every slug, the post loads in the browser, the page ships the runtime, its canonical link
  is written by the early script, and the sitemap needs every slug again in `sitemap.paths`.

Neither is what Astro, Eleventy or Hugo do: a folder of markdown (or a CMS) becomes a list the build
knows, every page can loop over it, and one template becomes one HTML file per entry. The error `filePath`
gives for `file:./{slug}.md` says it outright: "pages per file are not supported" (`src/compiler/files.ts:36`).

**What this proposes: a collection is a named list the build loads once, from files or from anywhere an
async function can reach. A page reads it like any resource, and a pattern page can be built once per
entry.** Both ends are constants, so everything [static pages](../static-pages.md) already does applies:
loops unroll, `md.parse` folds, the page ships no JavaScript unless something on it runs.

## Goals

- A folder of markdown or JSON files is a list, with each file's frontmatter as fields: no index file to
  keep in sync.
- Data from a CMS, a database or an API is a list the same way, loaded at build time.
- A list is readable on any page (an index, a "latest posts" box in a layout, a tag cloud) and folds into
  its HTML.
- One template page becomes one HTML file per entry, at a real URL: no rewrite, a constant `$canonical`,
  in the sitemap without `sitemap.paths`, no JavaScript if nothing runs.
- Typos fail the build: an entry's fields are typed, and a link to an entry that does not exist is an
  error.
- Live data still mixes in: a generated post page can have `<sn-resource src="/api/comments?post=…">`.
- What a CMS returns and no page shows does not ship.

## Not goals

- **Incremental or on-demand regeneration** (ISR). A CMS change is a rebuild. A site whose content changes
  faster than it can rebuild keeps the pattern page and the [server layer](../server.md), which embeds
  the API's response into the one file at request time
  ([Build-time or request-time](#8-build-time-or-request-time)).
- **A content store or query language.** A collection is a list of plain data. Sorting, filtering and
  grouping happen in the loader, or in expressions and helpers, as everywhere in sinter.
- **Schemas at runtime** (Astro's zod). Types come from the loader's return type, checked by
  `sinter check`; a loader that wants runtime validation validates in its own code.
- **Rest parameters** (`/docs/:path*`): each value fills one path segment. Rest parameters touch the
  router everywhere (`matches()` compares segment counts, `vite.ts:1574`; `_redirects`, sinter-axum,
  Sinter.AspNetCore, `$url`) and are their own proposal; a page per entry does not need them.

## What sinter has to build on

| Piece | Where | What it gives |
| --- | --- | --- |
| `file:` resources | `src/compiler/files.ts`, `fileResource` in `compile.ts:5684` | a constant resource: `FILE_ATTRS` (`name`, `src`, `type`, `items`, `key`), embedded data for what still runs, SN332 for anything that would load it, dev reload on change |
| Constant loops and folding | `MAX_UNROLL = 1000`, `EXPANSION_LIMIT = 10_000` (`compile.ts:8467`) | a `data-sn-for` over a constant list is rows in the HTML; helpers over constants run at build time |
| Per-language inputs | `entries()`, `<root>/<locale>/<page>` (`src/vite.ts:544`, `762`) | one source page compiled several times with a different constant (`$locale`), each a Vite input with its own output path, fixed in `configResolved` |
| Exact paths | `movesToDirectory` (`src/page-paths.ts:21`) | a `data-sn-path` page stays a file and answers at exactly its paths: `login.html` at `/login`, served by hosts without a rule, canonical without a trailing slash |
| `sitemap.paths` | `src/sitemap-build.ts`, run in `generateBundle` (`vite.ts:1787`) | app code that may fetch, run once per build: a precedent for running such code, not for when (it runs after compiling; collections must run before) |

A collection is the `file:` resource made a list. A page per entry is the per-language input with an entry
where the language was, at exact paths.

## Design

### 1. Collections are declared in `src/sinter.content.ts`

```ts
// src/sinter.content.ts
import { collection, files } from '@tiaforge-ui/sinter/content';
import type { Post, Product, Tag } from './sinter.types';

/** content/posts/*.md: one entry per file, newest first */
export const posts = files<Post>('content/posts/*.md', {
  sort: (a, b) => b.date.localeCompare(a.date),
  draft: (p) => p.draft === true,
});

/** a CMS: any async function that returns a list */
export const products = collection<Product>({
  key: 'sku',
  load: async ({ env }) => {
    const r = await fetch('https://cms.example.com/api/products?status=published', {
      headers: { authorization: `Bearer ${env.CMS_TOKEN}` },
    });
    if (!r.ok) throw new Error(`CMS: ${r.status}`);
    return r.json();
  },
});

/** derived from another collection: a page per tag */
export const tags = collection<Tag>({
  key: 'slug',
  load: async ({ get }) => {
    const by = new Map<string, Post[]>();
    for (const p of await get(posts)) for (const t of p.tags) by.set(t, [...(by.get(t) ?? []), p]);
    return [...by].map(([slug, posts]) => ({ slug, posts }));
  },
});
```

- **A collection is an export whose value is `collection()`'s** (or `files()`'s, which is one). Other
  exports are an error (SN-new `content-module`), so a helper does not become a collection by being
  exported here.
- **`collection({ key, load, watch? })`**: `key` names the field that identifies an entry (required; it
  is the resource's `key`, and what pairs translations, [§6](#6-languages)). `load(ctx)` returns a list,
  sync or async. `watch` is a list of globs the dev server watches to reload it ([§7](#7-dev-sinter-check-and-the-editor)).
- **`ctx`** is what a loader may depend on, and the only way to reach another collection:

  | | |
  | --- | --- |
  | `get(c)` | another collection's list (by its value, so a typo is a TypeScript error); loaded once, a cycle is an error naming it |
  | `env` | the variables of Vite's `loadEnv(mode, root, '')`: `.env`, `.env.production`, and the process's, every prefix. Not `process.env` itself: the helpers loader calls `resolveConfig` (`helpers-node.ts:76`), and nothing in sinter loads `.env` today |
  | `mode` | `'development'` or `'production'` (Vite's mode) |
  | `locale` | with `localePrefix`, the language being loaded; `undefined` otherwise ([§6](#6-languages)) |

- **The module runs in Node, before any page compiles**, through its own loader (not `loadHelpers`, which
  never throws and folds nothing on failure, SN533): a content module that fails to load, or a loader that
  throws, fails the build. It is not checked for purity and never ships: it may fetch, read the disk and
  use secrets.
- **The result must be a list of plain data** (arrays, objects, strings, numbers, booleans, `null`), with
  `key` a string or number, unique. A `Date` from a CMS SDK is an error at the entry, which says to return
  `toISOString()`. The list is deep-frozen and shared by every page.
- **Its own file, not `vite.config`.** It sits beside `sinter.helpers.ts` and `sinter.types.ts`, where
  the editor and `sinter check` already look, and its loaders' return types are the collections' types
  ([Types](#5-types-and-links)). `sinter({ content: 'src/content.ts' })` moves it, as `helpers` does.

#### When loaders run: a pre-pass

Vite's inputs are fixed in `configResolved` (`vite.ts:762`), and compiling is synchronous. So a build with
a content module starts with a pre-pass, in `configResolved` after the per-language inputs are known:

1. load the content module;
2. scan the pages' `<html>` for `data-sn-pages` (a parse of the root element, not a compile) and their
   bodies for `content:` resources, giving the collections the build needs;
3. run those loaders, concurrently, with their dependencies through `get`;
4. turn each `data-sn-pages` page into one input per entry (and language), as `entries()` does per language.

A loader no page reads is not run. Any failure stops the build here, before an input exists, with the
export's name and the error. The values are then synchronous for the compiler, as a file's text is.

### 2. `files()`: a folder as a collection

`files(pattern, options?)` is a collection over every file a glob matches, relative to the project root,
with `watch` set to the pattern:

| File | Entry |
| --- | --- |
| `.md` | its frontmatter's fields, `body` (the markdown after the frontmatter), and `slug`, `dir`, `path` |
| `.json` | the parsed object's fields, and `slug`, `dir`, `path` (a file that is not an object is an error) |
| anything else | `body` (its text), `slug`, `dir`, `path` |

- `slug` is the file's name without its extension (`hello` for `content/posts/2026/hello.md`); a `slug`
  field in the frontmatter wins. `key` is `slug`. Two entries with one slug fail the build, naming both
  files: in a nested folder, put the year in the frontmatter or the URL (`/blog/:year/:slug`, with `year`
  a field), not in the slug.
- `dir` is the folder below the pattern's fixed part (`2026`, or `''`); `path` is the file from the root
  (`/content/posts/2026/hello.md`), for `md.parse(post.body, { base })`.
- Frontmatter is YAML between `---` lines, parsed with the failsafe schema plus numbers, booleans and
  `null`: no YAML dates (`date: 2026-11-16` stays the string `'2026-11-16'`, which `date()` formats at
  build time as a calendar date). The parser is a dependency of `@tiaforge-ui/sinter/content`, loaded
  only by the build, never in the browser.
- `sort` orders the list (default: by `path`). `draft` leaves entries out in a production build and keeps
  them in dev. `files(pattern).map(fn)` and `.filter(fn)` return collections, for a loader that changes
  entries without losing the watch.
- The same rules as `file:` paths: the glob stays inside the root, symlinks outside it are refused.

### 3. Reading a collection: `src="content:name"`

```html
<sn-resource name="posts" src="content:posts"></sn-resource>
<ul>
  <template data-sn-for="p in posts.slice(0, 10)">
    <li><a data-sn-attr="{ href: '/blog/' + p.slug }" data-sn-text="p.title"></a> <time data-sn-text="date(p.date)"></time></li>
  </template>
</ul>
```

- **It is a `file:` resource whose value comes from the content module**, with the same rules and the
  same attributes (`FILE_ATTRS`: `name`, `src`, `type`, `items`, `key`): nothing loads, refreshes or
  writes it, `$meta.<name>.loading` is `false`, SN332 for anything that would load or change it. `key`
  defaults to the collection's. Order is the loader's (`sort`), as a file's is its own.
- **`file:` or `content:`**: `file:` is one file whose path the page names; `content:` is a list, or
  anything that does not come from one file. A `.json` file read by one page stays `file:`.
- **`content:` is a reserved source name**, as `file` is: it cannot be an API's name (SN329). An unknown
  collection is SN-new `unknown-collection`, with a "did you mean".
- **What ships is only what browser code reads.** Bindings and helper calls over the collection are
  written into the HTML and ship nothing. For what still runs in the browser (a search box filtering
  `posts`), the compiler embeds the fields that code reads, which it knows when each read is a member
  access on an entry (`p.title`, `p.tags.includes(t)`). A read it cannot follow (the entry passed whole
  to a helper that runs in the browser, or to a component's script, or `p[k]`) is SN-new
  `content-fields`, fixed by naming what to embed: `fields="slug,title,tags"` on the resource. So a
  CMS's internal fields never reach a page by accident. The build line names each embedded collection
  and its size.
- **The unroll limits apply.** A `data-sn-for` over more than 1,000 entries stays a template that renders
  in the browser, and the page ships the runtime and the embedded fields. An index of thousands is paged
  with a collection of pages ([§4](#an-index-in-pages)).

### 4. A page per entry: `data-sn-pages`

```html
<!-- blog/post.html -->
<html data-sn-path="/blog/:slug" data-sn-pages="post in posts">
  <blog-layout data-sn-prop="{ title: post.title, description: post.summary }">
    <h1 data-sn-text="post.title"></h1>
    <md-doc data-sn-prop="{ doc: md.parse(post.body) }"></md-doc>

    <!-- live, beside the constant post -->
    <sn-resource name="comments" src="/api/comments?post={post.slug}" items="comments" key="id"></sn-resource>
    <comment-list data-sn-prop="{ comments }"></comment-list>
  </blog-layout>
</html>
```

```
dist/blog/hello.html      /blog/hello
dist/blog/recap.html      /blog/recap
```

- **`data-sn-pages="<name> in <collection>"` on `<html>`, beside a `data-sn-path` of one pattern.** The
  build compiles the page once per entry, and writes it at the pattern filled from the entry: each
  `:param` is the entry's field of that name. A field that is missing, not a string or number, empty, or
  holding a `/`, fails the build naming the entry (its file, for `files()`). Two entries that fill the
  same URL fail it too.
- **Exact paths, as every `data-sn-path` page has.** Each entry is a file at the filled pattern,
  `blog/hello.html` at `/blog/hello`, as `login.html` with `data-sn-path="/login"` is today: hosts serve
  it there without a rule, the canonical URL has no trailing slash (the form a pattern page's canonical
  already has, so moving a pattern page to `data-sn-pages` keeps its URLs), and the template's own file
  (`blog/post.html`) is not written, since nothing answers at it.
- **The rest follows from every URL being a file**: `$canonical` is a constant and the canonical link is
  written at build time, `_redirects` gets no rewrite for the pattern, the sitemap lists every entry (a
  `sitemap.paths` entry for the pattern is an error, since the build knows its values), and `$url` has no
  path parameters (`$url.slug` is SN-new `url-param-pages`, "use `post.slug`").
- **One pattern, nothing else.** A `data-sn-path` with a fixed path or a second pattern beside
  `data-sn-pages` is SN-new `pages-path`: a fixed path would be written once per entry, and a second
  pattern needs values the entry may not have.
- **`<name>` is page scope, like a resource**: the page's markup, its head and the layout's slots it fills
  read it; components and the layout get it through props, as they get a resource. It cannot shadow a
  store function, a resource or a magic name (`page in …` is SN-new, since `page` is a store function,
  `expr.ts:266`).
- **Implementation**: one input per entry and language, `<root>/<locale>/<filled pattern>.html`, resolved
  by the same `resolveId` and `load` hooks as a page in a language, compiled with `<name>` added to the
  page's constants. The page module, when one ships, is the same for every entry of a language (what
  differs between entries is constants, in the HTML or the embedded data), so it is bundled once per
  language, as today.
- **A long post stays static or fails.** Over `EXPANSION_LIMIT` a tree renders in the browser with SN536,
  a warning; on a `data-sn-pages` page it is an error, so one long post cannot silently ship its body and
  the runtime.
- **Live resources are not embedded** in the first version: under `embed: true`, a `data-sn-pages` page is
  not in `sinter-embed.json`, and its live resources load in the browser. One manifest entry per entry
  (the server reads every page at startup, `server.ts:321`) is [future work](#future-work).

#### An index in pages

A paged index is a collection of pages, and an ordinary `data-sn-pages` page:

```ts
// src/sinter.content.ts
export const postPages = collection({
  key: 'n',
  load: async ({ get }) => chunks(await get(posts), 20), // { n, items, count }, n from 1
});
```

```html
<!-- blog/archive.html -->
<html data-sn-path="/blog/page/:n" data-sn-pages="p in postPages">
  <template data-sn-for="post in p.items">…</template>
  <a data-sn-if="p.n > 1" data-sn-attr="{ href: '/blog/page/' + (p.n - 1) }">Newer</a>
  <a data-sn-if="p.n < p.count" data-sn-attr="{ href: '/blog/page/' + (p.n + 1) }">Older</a>
</html>
```

The blog's front page, `blog/index.html` at `/blog/`, is its own page: it reads `postPages` and renders
`postPages[0].items`, or reads `posts` and renders the latest ten. `/blog/page/1` exists too, with its own
canonical URL. `chunks` is exported by `@tiaforge-ui/sinter/content`. No special form: pagination is data.

### 5. Types and links

**Types.** A collection's type is its loader's return type (`files<Post>()` gives `Post & { slug: string;
dir: string; path: string; body: string }`), read by `sinter check` and the editor from the content
module, as `sinter.types.ts` is read today. A loader typed `any` (or an untyped `.js` module) is SN504 at
each `content:` resource and `data-sn-pages`, as an untyped `file:` resource is; `type="…"` on the
resource overrides it.

**Links to entries.** The build knows every URL a `data-sn-pages` page was written at, and the link
rewriting of [page URLs](../static-pages.md#page-urls) already visits every link it writes. A link in the
built HTML to a path matching a `data-sn-pages` pattern that no entry was written at is an error:

```
blog/index.html:14:12 error SN-new broken-entry-link: `/blog/helo` matches `/blog/:slug` (blog/post.html), but no entry of `posts` has slug `helo`. Did you mean `hello`?
```

It covers links from constants and folded expressions (the index's unrolled list), in markdown too
(`<md-doc>`'s links are attribute bindings over constants). A link built at run time is not in the HTML
and not checked. Patterns without `data-sn-pages` are not checked: their values are the API's. (Checking
every internal link, to fixed pages too, is a separate change; the name says what this one checks.)

### 6. Languages

With `localePrefix`, a `data-sn-pages` page is built once per language and entry (`/de/blog/hallo`), and
each language loads its own list:

- **A loader is called once per language when it reads `ctx.locale`**, and once in all when it does not
  (the call is traced: a loader that never touches `locale` is shared). `files()` takes the language in
  its options: `files((locale) => \`content/${locale}/posts/*.md\`)`; a plain string is one list for every
  language.
- **Entries are paired by `key`, not by URL.** `hello` in English and `hallo` in German are one post when
  their `key` field is equal (`files()` takes `key: 'id'` for a frontmatter `id`, since the slug is
  translated). So slugs can be translated.
- **`localeUrl()` and the alternates** work per entry: today `localeUrls()` is null for a page whose paths
  have parameters (`vite.ts:553`); an entry's page has its URL in each language that has the entry. An
  entry missing in a language has no page there, no `hreflang` alternate for it, and `localeUrl('de')`
  on it is `null` (a link written with it is left out by `data-sn-attr`, as a `null` attribute is).
- **Choosers**: each entry's unprefixed URL (`/blog/hello`) is a language chooser, as every page's is, in
  the languages that have the entry. That doubles the files; a host's file limit (Cloudflare Pages: 20,000
  per deployment) is checked at the end of the build, as the `_redirects` limits are (SN524).

### 7. Dev, `sinter check` and the editor

- **`vite dev`** runs the pre-pass at startup. A collection with `watch` (every `files()`) reloads when a
  watched file changes, is added or removed, and so does every page that read it; `data-sn-pages` URLs
  follow (a new file is served at its URL). A collection without `watch` reloads when the content module
  changes. Pages per entry are served by the middleware that serves a page in a language, compiled on
  request.
- **A loader that fails in dev** fails the pages that read it, in the overlay with the export's name and
  the error's message; the rest of the site works. The message is scrubbed (URLs lose their query and
  credentials, values from `ctx.env` are masked) since the overlay is a browser page; the terminal has the
  whole error.
- **`sinter check` and the editor do not run loaders**: a CMS fetch per keystroke or per CI type check
  would be slow, need secrets and depend on the network. They read a **snapshot**: the build and the dev
  server write each collection's list to `node_modules/.cache/sinter/content.json`, and check and the
  editor compile against it, so unrolling, SN536 and SN322 come out as in the build. Without a snapshot
  they type from the loaders' declared types alone, and say once that value-dependent checks were skipped;
  with one older than the content module or a watched file, they say it is stale. In CI, `sinter check`
  after `vite build` has a fresh one.

### 8. Build-time or request-time

Two ways to have a page per entry, documented side by side:

| | `data-sn-pages` (this proposal) | A pattern page with `embed` |
| --- | --- | --- |
| Files | one per entry | one |
| Data | at build time | at request time, from the API |
| A content change | a rebuild (a CMS webhook to the CI) | live |
| Server | any static host | sinter's server layer |
| JavaScript | none, unless something runs | the runtime, for the data |
| Sitemap | automatic | `sitemap.paths` |
| Broken links | build errors | not checked |

The rule of thumb: content people edit (posts, docs, product pages) is a collection; data that changes on
its own (prices, stock, comments) is a resource. A `data-sn-pages` page can have live resources, loaded in
the browser.

## Build time

Not yet measured; [the plan](#plan) prototypes it before part B. What is known:

- each entry is a compile of the page, a few milliseconds for a static page plus what folds (`md.parse` of
  a long post is tens of ms);
- a production build re-runs every folded call at its end in a fresh module (`src/fold-cross.ts:5`), which
  doubles the folding;
- every entry is a Rollup input, and the plugin keeps every page's HTML (`built`) until `generateBundle`.

The prototype is 10,000 entries of a markdown post page; the proposal's numbers and any cap come from it.

## Diagnostics

New codes, numbers assigned at implementation:

| Code | When |
| --- | --- |
| content-module | an export of the content module that is not a collection; the module fails to load |
| collection-load | a loader throws, returns a non-list, non-plain data, or a missing or duplicate `key` (with the export and, for `files()`, the file) |
| unknown-collection | `content:name` or `data-sn-pages` names no collection |
| content-fields | browser code reads an entry in a way the compiler cannot follow, without `fields` |
| pages-param | an entry has no usable value for a `:param` (missing, empty, not a string or number, a `/`), or two entries fill one URL |
| pages-path | `data-sn-pages` without exactly one pattern in `data-sn-path` |
| url-param-pages | `$url.<param>` on a `data-sn-pages` page |
| broken-entry-link | a link in the built HTML under a `data-sn-pages` pattern that no entry was written at |

SN332 grows by an attribute a `content:` resource does not take; SN504 by an untyped collection; SN329 by
an API named `content`; SN536 is an error on a `data-sn-pages` page.

## Testing

- **Unit**: `files()` (globs, slugs and `dir`, frontmatter, the failsafe YAML schema, drafts per mode,
  JSON that is not an object, symlinks out of the root), `collection()` validation, `get` and cycles,
  `ctx.env`, the per-locale trace, `chunks`.
- **Compiler**: `content:` resources as `file:` ones (the same suite, over both schemes), field pruning
  and `content-fields`, `data-sn-pages` constants in the head, slots and props, the new codes.
- **Build** (the fixture pattern of `test/static-*`): a blog of three posts, an index, a paged archive and
  a tag page; the files at exact paths, no JavaScript, the sitemap, the canonical links, no `_redirects`
  rule, no template file, a broken entry link failing; with `localePrefix` and a post missing in one
  language; a live resource on a generated page; a loader failing before any input exists.
- **Dev** (e2e): editing a markdown file reloads its page and the index; adding one serves its URL; a
  failing loader's overlay with a token in its URL, scrubbed.
- **Check**: with and without a snapshot, and with a stale one.
- **The static-site example** gains a blog from `content/posts/*.md` with sinter-markdown.

## Plan

Three pull requests, each followed by a review of where it departed from this text:

- **A, collections**: the content module and the pre-pass (§1), `files()` (§2), `content:` resources with
  field pruning (§3), types and the snapshot (§5, §7), dev reload. Useful alone: an index over a folder.
- **B, a page per entry**: first the 10,000-entry prototype ([Build time](#build-time)); then
  `data-sn-pages` (§4) on the per-language inputs, exact paths, the sitemap and canonical links,
  languages (§6), dev serving, `chunks`.
- **C, links and docs**: `broken-entry-link` (§5); a guide `docs/content.md`, the static-site example's
  blog, `resources.md` and `static-pages.md` pointing to it, `llms.txt`, CHANGELOG.

## Open questions

- **`files()` in core or in sinter-markdown.** Frontmatter means a YAML parser, a new dependency of core
  (build-only). `files()` also reads JSON and text, and a collection is not markdown-specific, so this
  proposal puts it in core under `@tiaforge-ui/sinter/content`; sinter-markdown could re-export it.
- **Tracing `ctx.locale`.** Calling a loader once per language only when it reads `locale` is convenient
  but implicit. The explicit alternative is `collection({ perLocale: true, … })`. To be decided with the
  prototype.

## Future work

- **Embedded live data on `data-sn-pages` pages**: one `sinter-embed.json` entry per entry, and a server
  that does not read thousands of pages at startup.
- **Rest parameters**, as their own proposal.
- **Markdown links between entries**: `[next](./other.md)` in a `files()` collection written as the other
  entry's URL, when exactly one `data-sn-pages` page uses the collection.
- **A collection as a shared asset**: ten thousand pages that each embed the same tag list repeat it; a
  hashed JSON file, preloaded, would be cached once, at the cost of a request in the first frame.
- **Incremental builds** that rebuild only the entries a changed file touches.
- **Images from a CMS** through the build's image pipeline, from declared image fields.
- **Loaders for common CMSs** as separate packages, on the `collection()` contract.

## Decisions

Settled in the first review, against `main` at 2b33230:

| Question | Decision | Section |
| --- | --- | --- |
| When loaders run | A pre-pass in `configResolved`: the content module, a scan of the pages' roots, the loaders, then the inputs; any failure stops the build before an input exists. `sitemap.paths` runs in `generateBundle` and is no precedent for timing | [§1](#when-loaders-run-a-pre-pass) |
| How a collection is declared | `collection({ key, load, watch })` with a context (`get`, `env`, `mode`, `locale`), not any exported function: `get` memoizes and orders loaders, `watch` makes a derived collection reload in dev, `mode` gives drafts | [§1](#1-collections-are-declared-in-srcsintercontentts) |
| Secrets | Loaders read `.env` through `ctx.env` (Vite's `loadEnv`, every prefix), since nothing loads `.env` today; browser code gets only the fields it reads, or those `fields` names; the dev overlay's messages are scrubbed | [§1](#1-collections-are-declared-in-srcsintercontentts), [§3](#3-reading-a-collection-srccontentname), [§7](#7-dev-sinter-check-and-the-editor) |
| An entry's URL | An exact path, as every `data-sn-path` page's: `blog/hello.html` at `/blog/hello`, canonical without a trailing slash; the template's file is not written (`movesToDirectory` is false for these pages, so there is no redirect file to keep) | [§4](#4-a-page-per-entry-data-sn-pages) |
| The attribute's name | `data-sn-pages`, not `data-sn-each`: `each` is already fan-out on `<sn-resource>` | [§4](#4-a-page-per-entry-data-sn-pages) |
| Paged indexes | No `pages()` built-in, and no fixed path beside the pattern (which would make every page's canonical the fixed URL): a collection of chunks, an ordinary `data-sn-pages` page | [An index in pages](#an-index-in-pages) |
| Sorting | In the loader; `content:` takes exactly `file:`'s attributes, so the two schemes do not differ | [§3](#3-reading-a-collection-srccontentname) |
| `sinter check` | Never runs loaders; compiles against the build's snapshot, so value-dependent checks agree with the build, and says when it has none or it is stale | [§7](#7-dev-sinter-check-and-the-editor) |
| Rest parameters and slugs with `/` | Out: one segment per parameter; nested folders give `dir`, and a URL with a year takes it as a field | [Not goals](#not-goals), [§2](#2-files-a-folder-as-a-collection) |
| Embedded live data | Not in the first version: `data-sn-pages` pages are left out of `sinter-embed.json` | [§4](#4-a-page-per-entry-data-sn-pages) |
| Languages | A loader per language when it reads `locale`; entries paired by `key`, so slugs can be translated; a missing entry has no page, no alternate and a `null` `localeUrl()`; one chooser per entry | [§6](#6-languages) |
| A long post over `EXPANSION_LIMIT` | An error on `data-sn-pages` pages, not SN536's warning | [§4](#4-a-page-per-entry-data-sn-pages) |
| Link checking's scope | Links under `data-sn-pages` patterns only, named `broken-entry-link`; checking every internal link is separate | [§5](#5-types-and-links) |
