# Proposal: build-time data, collections and a page per entry

Status: draft, revised twice (see [Decisions](#decisions)): after a first review, and to fold the unreleased
`file:` source into this design, so that sinter has one concept for data the build reads, not two. It
builds on [pages without JavaScript](static-pages.md) (constant loops unrolled, helpers over constants run
at build time, page URLs, `data-sn-path`, the sitemap) and on the per-language inputs of `localePrefix`.
Line references are to `main` at 2b33230.

A blog in sinter today is one of two things:

- **One page per post, written by hand**: `hello.html` reads `file:./hello.md`, is plain HTML at build
  time and ships no JavaScript. Adding a post means adding a page; the post's title cannot come from its
  frontmatter (the value is the file's text, frontmatter included), and the index lists the posts by hand
  or from a JSON file kept in sync with the folder.
- **One pattern page**: `post.html` with `data-sn-path="/blog/:slug"` reads `/api/posts/{$url.slug}`. One
  file answers every slug, the post loads in the browser, the page ships the runtime, its canonical link
  is written by the early script, and the sitemap needs every slug again in `sitemap.paths`.

Neither is what Astro, Eleventy or Hugo do: a folder of markdown (or a CMS) becomes a list the build
knows, every page can loop over it, and one template becomes one HTML file per entry. The error `filePath`
gives for `file:./{slug}.md` says it outright: "pages per file are not supported" (`src/compiler/files.ts:36`).

**What this proposes: one kind of resource, the build-time resource, whose value the build reads once and
writes into pages as a constant. It has two sources: `file:` for the repository (one file, or a glob for a
list), and `content:` for code (a CMS, a list derived from others). And a page can be built once per entry
of one.** Everything [static pages](../static-pages.md) already does applies: loops unroll, `md.parse`
folds, the page ships no JavaScript unless something on it runs.

## Goals

- A folder of markdown or JSON files is a list, with each file's frontmatter as fields: no index file to
  keep in sync. One markdown file's frontmatter is readable too.
- Data from a CMS, a database or an API is a list the same way, loaded at build time.
- A list is readable on any page (an index, a "latest posts" box in a layout, a tag cloud) and folds into
  its HTML.
- One template page becomes one HTML file per entry, at a real URL: no rewrite, a constant `$canonical`,
  in the sitemap without `sitemap.paths`, no JavaScript if nothing runs.
- Typos fail the build: an entry's fields are typed, and a link to an entry that does not exist is an
  error.
- Live data still mixes in: a generated post page can have `<sn-resource src="/api/comments?post=…">`.
- What a CMS returns and no page shows does not ship.
- **One way to do each thing** (`docs/spec.md:24`): the repository's files are read one way, wherever the
  code that reads them is (a page, a layout, a library's component); code is run one way.

## Not goals

- **Incremental or on-demand regeneration** (ISR). A CMS change is a rebuild. A site whose content changes
  faster than it can rebuild keeps the pattern page and the [server layer](../server.md), which embeds
  the API's response into the one file at request time
  ([Build-time or request-time](#9-build-time-or-request-time)).
- **A content store or query language.** A list is plain data. Filtering and grouping are expressions,
  helpers or a `content:` loader.
- **Schemas at runtime** (Astro's zod). Types come from `type` and the loaders' return types, checked by
  `sinter check`.
- **Rest parameters** (`/docs/:path*`): each value fills one path segment. Rest parameters touch the
  router everywhere (`matches()` compares segment counts, `vite.ts:1574`; `_redirects`, sinter-axum,
  Sinter.AspNetCore, `$url`) and are their own proposal; a page per entry does not need them.

## What sinter has to build on

| Piece | Where | What it gives |
| --- | --- | --- |
| `file:` resources (unreleased) | `src/compiler/files.ts`, `fileResource` in `compile.ts:5684`, `test/behaviour/files.test.ts` | a constant resource: `FILE_ATTRS` (`name`, `src`, `type`, `items`, `key`), embedded data for what still runs, SN332 for anything that would load it, dev reload on change. This proposal extends it rather than adding a second kind |
| Constant loops and folding | `MAX_UNROLL = 1000`, `EXPANSION_LIMIT = 10_000` (`compile.ts:8467`) | a `data-sn-for` over a constant list is rows in the HTML; helpers over constants run at build time |
| Per-language inputs | `entries()`, `<root>/<locale>/<page>` (`src/vite.ts:544`, `762`) | one source page compiled several times with a different constant (`$locale`), each a Vite input with its own output path, fixed in `configResolved` |
| Exact paths | `movesToDirectory` (`src/page-paths.ts:21`) | a `data-sn-path` page stays a file and answers at exactly its paths: `login.html` at `/login`, served by hosts without a rule, canonical without a trailing slash |
| `sitemap.paths` | `src/sitemap-build.ts`, run in `generateBundle` (`vite.ts:1787`) | app code that may fetch, run once per build: a precedent for running such code, not for when (it runs after compiling; loaders must run before) |

## Design

### 1. One build-time resource, two sources

```html
<!-- one file of the repository -->
<sn-resource name="intro" src="file:./intro.txt"></sn-resource>
<sn-resource name="post" src="file:./hello.md"></sn-resource>

<!-- a folder: a list, one entry per file -->
<sn-resource name="posts" src="file:/content/posts/*.md" type="Post" order="-date"></sn-resource>

<!-- code: a CMS, a list derived from others -->
<sn-resource name="products" src="content:products" order="name"></sn-resource>
```

| Source | Reads | Written where |
| --- | --- | --- |
| `file:<path>` | one file of the repository | a page, a layout or a component, a library's too; relative to that file, or `/…` from the root |
| `file:<glob>` | every file the glob matches, as a list | the same |
| `content:<name>` | an export of the app's content module ([§3](#3-content-code-at-build-time)) | the app's pages, layouts and components (a library has no content module) |

Both are the same resource, with the same rules, the ones `file:` has today:

- **A constant**: nothing loads, refreshes or writes it; `$meta.<name>.loading` is `false` and the other
  status fields are `null`; SN332 for anything that would load or change it (`refresh`, `cache`,
  `paginate`, `each`, `call`, `when`, `then`, `early`, store functions that name it or change one of its
  items, write-through, `<sn-event>`s). Not in `sinter-embed.json`.
- **The same attributes for both**: `name`, `src`, `type`, `items`, `key` and, new, `order`
  ([§4](#4-what-a-page-gets)). `items` picks a list out of a value (a JSON file's, a loader's); `key`
  defaults to `slug` for a glob, and to a `content:` collection's key.
- **Folded or embedded**: bindings and helper calls over it are written into the HTML and ship nothing;
  what still runs in the browser gets the fields it reads ([§4](#4-what-a-page-gets)).
- **The dev server** reloads every page that read it when its value changes ([§8](#8-dev-sinter-check-and-the-editor)).

`file:` is for the repository and `content:` for code, so there is one way to read a file: a `.json` file
one page reads is `file:./team.json`, a folder is `file:` with a glob, and a `content:` loader that needs
files (to derive tags from posts) reads them through `ctx.files`, the same reader, not a second scheme.

### 2. `file:`: one file, or a glob

#### What a file's value is

| File | Value |
| --- | --- |
| `.md` | **an entry**: its frontmatter's fields and `body`, the markdown after the frontmatter (a file without frontmatter is `{ body }`) |
| `.json` | its parsed value, as today |
| anything else | its text, as today |

The `.md` row is the one change to `file:` as it is on `main` (where a `.md` file's value is its text): a
hand-written post page can now read its title and date, and `md.parse(post)` becomes `md.parse(post.body)`.
Since `file:` is unreleased, nothing released breaks; the docs, sinter-markdown's docs, fixtures and tests,
and the CHANGELOG's `file:` entry change with it ([Plan](#plan)).

Frontmatter is YAML between `---` lines at the start of the file, parsed with the failsafe schema plus
numbers, booleans and `null`: no YAML dates (`date: 2026-11-16` stays the string `'2026-11-16'`, which
`date()` formats at build time as a calendar date), no anchors or tags. Invalid frontmatter is SN332 with
the line. The parser is a build dependency of core, never in the browser.

#### A glob is a list

A `file:` path with `*`, `**`, `?` or `{a,b}` is a glob, and its value is a list with one entry per file,
sorted by path (or by `order`):

- each entry is the file's value as above, and for a `.json` file it must be an object (an array or a
  scalar in a glob is SN332 naming the file), and for a text file it is `{ body }`;
- every entry also has `slug`, the file's name without its extension (`hello` for
  `content/posts/2026/hello.md`), unless the file gives its own `slug`; `dir`, its folder below the glob's
  fixed part (`2026`, or `''`); and `path`, the file from the root (`/content/posts/2026/hello.md`), for
  `md.parse(post.body, { base })`;
- `key` defaults to `slug`; two entries with one key are SN332 naming both files. In a nested folder, put
  the year in the frontmatter or the URL (`/blog/:year/:slug` with `year` a field), not in the slug;
- **drafts**: an entry whose frontmatter has `draft: true` is left out of a production build and kept in
  dev. It is a convention, the one field sinter reads by name, so it needs no option;
- a glob that matches nothing is an empty list, and a warning (a typo in a folder name should not be a
  silently empty blog);
- the same rules as one file's path: a literal, inside the root, no symlink out of it.

#### `$locale` in a path

`{…}` in a `file:` path is an error today (SN332), since a path that depends on data would make the page
depend on it. The one exception is `{$locale}`, a constant in each language's build with `localePrefix`:

```html
<sn-resource name="posts" src="file:/content/{$locale}/posts/*.md" type="Post"></sn-resource>
```

Without `localePrefix`, `{$locale}` in a path is SN332: the language is the browser's. (`{a,b}` alternation
in a glob is not an interpolation: an interpolation starts with `{$`.)

### 3. `content:`: code at build time

```ts
// src/sinter.content.ts
import { collection } from '@tiaforge-ui/sinter/content';
import type { Post, Product, Tag } from './sinter.types';

/** a CMS */
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

/** derived from files: a page per tag */
export const tags = collection<Tag>({
  key: 'slug',
  load: async ({ files }) => {
    const by = new Map<string, Post[]>();
    for (const p of await files<Post>('/content/posts/*.md')) for (const t of p.tags) by.set(t, [...(by.get(t) ?? []), p]);
    return [...by].map(([slug, posts]) => ({ slug, posts }));
  },
});
```

- **A collection is an export whose value is `collection()`'s.** Any other export is SN-new
  `content-module`, so a helper does not become a collection by being exported here.
- **`collection({ key, load })`**: `key` names the field that identifies an entry (required: it is the
  resource's default `key`, and what pairs translations, [§7](#7-languages)). `load(ctx)` returns a list,
  sync or async.
- **`ctx`** is what a loader may depend on:

  | | |
  | --- | --- |
  | `files(glob)` | the files a glob matches, as `file:` reads them (the same entries, drafts left out in production), paths from the root; the dev server watches them for this collection |
  | `get(c)` | another collection's list (by its value, so a typo is a TypeScript error); loaded once, a cycle is an error naming it |
  | `env` | the variables of Vite's `loadEnv(mode, root, '')`: `.env`, `.env.production`, and the process's, every prefix. Not `process.env` itself: the helpers loader calls `resolveConfig` (`helpers-node.ts:76`), and nothing in sinter loads `.env` today |
  | `mode` | `'development'` or `'production'` (Vite's mode) |
  | `locale` | with `localePrefix`, the language being loaded; `undefined` otherwise ([§7](#7-languages)) |

- **The module runs in Node**, through its own loader (not `loadHelpers`, which never throws and folds
  nothing on failure, SN533): a module that fails to load, or a loader that throws, fails the build. It is
  not checked for purity and never ships: it may fetch, read the disk and use secrets.
- **The result must be a list of plain data** (arrays, objects, strings, numbers, booleans, `null`) with a
  unique string or number `key` per entry. A `Date` from a CMS SDK is an error at the entry, which says to
  return `toISOString()`. The list is deep-frozen and shared by every page.
- **Its own file, not `vite.config`.** It sits beside `sinter.helpers.ts` and `sinter.types.ts`, where the
  editor and `sinter check` already look. `sinter({ content: 'src/content.ts' })` moves it, as `helpers`
  does.
- **`content:` is a reserved source name**, as `file` is: it cannot be an API's name (SN329). An unknown
  collection is SN-new `unknown-collection`, with a "did you mean".

#### When loaders and globs run: a pre-pass

Vite's inputs are fixed in `configResolved` (`vite.ts:762`), and compiling is synchronous. Pages per entry
([§5](#5-a-page-per-entry-data-sn-pages)) need their lists before the inputs exist, so a build starts with
a pre-pass, in `configResolved` after the per-language inputs are known:

1. scan each page for `data-sn-pages` on its root and the build-time resource it names, and every page,
   layout and component for `content:` resources (a parse, not a compile);
2. load the content module if any `content:` source is used, and run the loaders those sources need,
   concurrently, with their dependencies through `get`; read the globs the `data-sn-pages` pages need;
3. turn each `data-sn-pages` page into one input per entry (and language), as `entries()` does per language.

A loader nothing reads is not run. Any failure stops the build here, before an input exists, with the
export's or file's name. Other `file:` reads stay where they are, in the compile, which reads files
synchronously; a glob is read once per build and shared.

### 4. What a page gets

```html
<sn-resource name="posts" src="file:/content/posts/*.md" type="Post" order="-date"></sn-resource>
<ul>
  <template data-sn-for="p in posts.slice(0, 10)">
    <li><a data-sn-attr="{ href: '/blog/' + p.slug }" data-sn-text="p.title"></a> <time data-sn-text="date(p.date)"></time></li>
  </template>
</ul>
```

- **`order`** sorts a list once, at build time, with the syntax a live resource's `order` has (`-date`,
  `name,-date`). A live resource compares strings in the visitor's language (`docs/resources.md:37`); at
  build time they are compared in the page's language with `localePrefix`, and in the base language
  without it (`sourceLanguageTag` of the inlang project, else `en`). `order` on a value that is not a list
  is SN332.
- **`type`** names the type of one entry for a glob (`type="Post"`, the frontmatter's fields), and sinter
  adds `slug`, `dir`, `path` and `body`: so the type a page reads is `(Post & FileEntry)[]`. For one `.md`
  file it is `Post & { body: string }`; for `.json`, a text file and `content:` it is the value's type, as
  today. A `content:` collection without `type` takes its loader's return type; a glob or `.md` file
  without `type` is SN504, as an untyped `.json` file is.
- **What ships is only what browser code reads.** For what still runs in the browser (a search box
  filtering `posts`), the compiler embeds the fields that code reads, which it knows when each read is a
  member access on an entry (`p.title`, `p.tags.includes(t)`). A read it cannot follow (an entry passed
  whole to a helper that runs in the browser or to a component's script, `p[k]`) is SN-new
  `content-fields`, fixed by naming what to embed: `fields="slug,title,tags"`. So a CMS's internal fields
  and posts' bodies never reach a page by accident. The build line names each embedded resource and its
  size. (`file:` today embeds a value whole; with this, it is pruned too.)
- **The unroll limits apply.** A `data-sn-for` over more than 1,000 entries stays a template that renders
  in the browser, and the page ships the runtime and the embedded fields. An index of thousands is paged
  ([An index in pages](#an-index-in-pages)).

### 5. A page per entry: `data-sn-pages`

```html
<!-- blog/post.html -->
<html data-sn-path="/blog/:slug" data-sn-pages="post in posts">
<sn-resource name="posts" src="file:/content/posts/*.md" type="Post"></sn-resource>
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

- **`data-sn-pages="<name> in <resource>"` on `<html>`, beside a `data-sn-path` of one pattern.**
  `<resource>` is a build-time resource of the page, `file:` with a glob or `content:`, declared at the
  page's top level (not inside a template, a component or the layout, so the pre-pass finds it). The build
  compiles the page once per entry, and writes it at the pattern filled from the entry: each `:param` is the
  entry's field of that name. A field that is missing, not a string or number, empty, or holding a `/`,
  fails the build naming the entry (its file, for a glob). Two entries that fill one URL fail it too.
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
  read it; components and the layout get it through props. It cannot shadow a store function, a resource
  or a magic name (`page in …` is SN-new, since `page` is a store function, `expr.ts:266`). The list
  itself stays readable under its own name, for a "next post" link.
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

A paged index is a collection of pages and an ordinary `data-sn-pages` page; no special form:

```ts
// src/sinter.content.ts
import { collection, chunks } from '@tiaforge-ui/sinter/content';
export const postPages = collection({
  key: 'n',
  load: async ({ files }) => chunks((await files<Post>('/content/posts/*.md')).sort(byDate), 20), // { n, items, count }, n from 1
});
```

```html
<!-- blog/archive.html -->
<html data-sn-path="/blog/page/:n" data-sn-pages="p in postPages">
<sn-resource name="postPages" src="content:postPages"></sn-resource>
<template data-sn-for="post in p.items">…</template>
<a data-sn-if="p.n > 1" data-sn-attr="{ href: '/blog/page/' + (p.n - 1) }">Newer</a>
<a data-sn-if="p.n < p.count" data-sn-attr="{ href: '/blog/page/' + (p.n + 1) }">Older</a>
</html>
```

The blog's front page, `blog/index.html` at `/blog/`, is its own page, reading `posts` and rendering the
latest ten; `/blog/page/1` exists too, with its own canonical URL.

### 6. Types and links

**Types** are as in [§4](#4-what-a-page-gets): `type` on the resource, or a `content:` loader's return
type, read by `sinter check` and the editor from the content module, as `sinter.types.ts` is read today.

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

### 7. Languages

With `localePrefix`, a `data-sn-pages` page is built once per language and entry (`/de/blog/hallo`), and
each language reads its own list:

- **`file:` with `{$locale}`** reads each language's folder ([§2](#locale-in-a-path)); a path without it is
  one list for every language.
- **A `content:` loader is called once per language when it reads `ctx.locale`**, and once in all when it
  does not (the call is traced: a loader that never touches `locale` is shared).
- **Entries are paired by `key`, not by URL.** `hello` in English and `hallo` in German are one post when
  their `key` is equal: for a glob, `key="id"` with an `id` in the frontmatter, since the slug is
  translated. So slugs can be translated.
- **`localeUrl()` and the alternates** work per entry: today `localeUrls()` is null for a page whose paths
  have parameters (`vite.ts:553`); an entry's page has its URL in each language that has the entry. An
  entry missing in a language has no page there, no `hreflang` alternate for it, and `localeUrl('de')` on
  it is `null` (a link written with it is left out by `data-sn-attr`, as a `null` attribute is).
- **Choosers**: each entry's unprefixed URL (`/blog/hello`) is a language chooser, as every page's is, in
  the languages that have the entry. That doubles the files; a host's file limit (Cloudflare Pages: 20,000
  per deployment) is checked at the end of the build, as the `_redirects` limits are (SN524).

### 8. Dev, `sinter check` and the editor

- **`vite dev`** runs the pre-pass at startup. A changed, added or removed file under a glob reloads that
  glob's resources and every page that read them, and `data-sn-pages` URLs follow (a new file is served at
  its URL); one file reloads as `file:` does today. A `content:` collection reloads when a file its
  `ctx.files` read changes, or when the content module changes. Pages per entry are served by the
  middleware that serves a page in a language, compiled on request.
- **A loader that fails in dev** fails the pages that read it, in the overlay with the export's name and
  the error's message; the rest of the site works. The message is scrubbed (URLs lose their query and
  credentials, values from `ctx.env` are masked) since the overlay is a browser page; the terminal has the
  whole error.
- **`sinter check` and the editor read `file:` sources, and never run loaders.** Files are the
  repository's: reading a glob is as cheap as reading one file is today, and its values make unrolling,
  SN536 and SN322 come out as in the build. A CMS fetch per keystroke or per CI type check would be slow,
  need secrets and depend on the network, so for `content:` they read a **snapshot**: the build and the dev
  server write each collection's list to `node_modules/.cache/sinter/content.json`. Without one they type
  from the loaders' declared types alone and say once that value-dependent checks were skipped; with one
  older than the content module, they say it is stale. In CI, `sinter check` after `vite build` has a
  fresh one.

### 9. Build-time or request-time

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

The rule of thumb: content people edit (posts, docs, product pages) is a build-time resource; data that
changes on its own (prices, stock, comments) is a live one. A `data-sn-pages` page can have both.

## Build time

Not yet measured; [the plan](#plan) prototypes it before part B. What is known:

- each entry is a compile of the page, a few milliseconds for a static page plus what folds (`md.parse` of
  a long post is tens of ms);
- a production build re-runs every folded call at its end in a fresh module (`src/fold-cross.ts:5`), which
  doubles the folding;
- every entry is a Rollup input, and the plugin keeps every page's HTML (`built`) until `generateBundle`.

The prototype is 10,000 entries of a markdown post page; the proposal's numbers and any cap come from it.

## Diagnostics

SN332 (`file-source`) becomes the code for every build-time source problem, and is renamed
`build-time-source` (unreleased, so free): a glob's `.json` file that is not an object, duplicate keys,
invalid frontmatter, `{…}` other than `{$locale}`, `order` on a value that is not a list, an attribute a
build-time resource does not take, and what it covers today. New codes, numbers assigned at implementation:

| Code | When |
| --- | --- |
| content-module | an export of the content module that is not a collection; the module fails to load |
| collection-load | a loader throws, returns a non-list, non-plain data, or a missing or duplicate `key` |
| unknown-collection | `content:name` names no collection |
| content-fields | browser code reads an entry in a way the compiler cannot follow, without `fields` |
| pages-param | an entry has no usable value for a `:param` (missing, empty, not a string or number, a `/`), or two entries fill one URL |
| pages-path | `data-sn-pages` without exactly one pattern in `data-sn-path`, or naming no top-level build-time list of the page |
| url-param-pages | `$url.<param>` on a `data-sn-pages` page |
| broken-entry-link | a link in the built HTML under a `data-sn-pages` pattern that no entry was written at |

A glob that matches nothing is a warning (SN-new `empty-glob`). SN504 covers an untyped glob or `.md`
file; SN329 an API named `content`; SN536 is an error on a `data-sn-pages` page.

## Testing

- **Unit**: frontmatter (the failsafe schema, no dates, invalid YAML with its line, a file without it),
  globs (slugs, `dir`, `path`, sort, drafts per mode, `.json` that is not an object, no match, symlinks out
  of the root, `{$locale}`), `collection()` validation, `ctx.files`, `get` and cycles, `ctx.env`, the
  per-locale trace, `chunks`.
- **Compiler**: the existing `test/behaviour/files.test.ts` over both sources; `.md` as an entry; `order`
  per language; field pruning and `content-fields`; `data-sn-pages` constants in the head, slots and
  props; the new codes.
- **Build** (the fixture pattern of `test/static-*`): a blog of three posts, an index, a paged archive and
  a tag page; the files at exact paths, no JavaScript, the sitemap, the canonical links, no `_redirects`
  rule, no template file, a broken entry link failing; with `localePrefix`, `{$locale}` and a post missing
  in one language; a live resource on a generated page; a loader failing before any input exists.
- **Dev** (e2e): editing a markdown file reloads its page and the index; adding one serves its URL; a
  failing loader's overlay with a token in its URL, scrubbed.
- **Check**: globs read without a build; `content:` with and without a snapshot, and with a stale one.
- **The static-site example** gains a blog from `content/posts/*.md` with sinter-markdown.

## Plan

Three pull requests, each followed by a review of where it departed from this text:

- **A, build-time resources**: `file:` as in §2 (a `.md` file is an entry, globs, drafts, `{$locale}`),
  `order` and field pruning (§4), `content:` and the content module with the pre-pass (§3), types and the
  snapshot (§6, §8), dev reload, SN332's rename. Since `file:` is unreleased, part A also changes what
  already uses it: `docs/resources.md#files`, the CHANGELOG's `file:` entry (rewritten as one entry for
  build-time resources, not a second one), sinter-markdown's README, `docs/markdown.md`, its fixture page
  and `test/static.test.ts` (`md.parse(post)` becomes `md.parse(post.body)`), `examples/static-site`, and
  the `file:` examples in `docs/proposals/component-libraries.md` (a note, since proposals are records).
  Useful alone: an index over a folder, a post's title from its frontmatter.
- **B, a page per entry**: first the 10,000-entry prototype ([Build time](#build-time)); then
  `data-sn-pages` (§5) on the per-language inputs, exact paths, the sitemap and canonical links, languages
  (§7), dev serving, `chunks`.
- **C, links and docs**: `broken-entry-link` (§6); a guide `docs/content.md`, the static-site example's
  blog, `resources.md` and `static-pages.md` pointing to it, `llms.txt`, CHANGELOG.

**Part A should land before the next release**, so that `file:` is never released in its current form and
then changed.

## Open questions

- **Tracing `ctx.locale`.** Calling a loader once per language only when it reads `locale` is convenient
  but implicit. The explicit alternative is `collection({ perLocale: true, … })`. To be decided with the
  prototype.
- **`draft` by convention.** Reading one frontmatter field by name is new for sinter. The alternative is an
  attribute (`drafts="draft"`), which is more to write for what every blog wants. This proposal picks the
  convention.

## Future work

- **Embedded live data on `data-sn-pages` pages**: one `sinter-embed.json` entry per entry, and a server
  that does not read thousands of pages at startup.
- **Rest parameters**, as their own proposal.
- **Markdown links between entries**: `[next](./other.md)` in a glob written as the other entry's URL,
  when exactly one `data-sn-pages` page reads that glob.
- **A list as a shared asset**: ten thousand pages that each embed the same tag list repeat it; a hashed
  JSON file, preloaded, would be cached once, at the cost of a request in the first frame.
- **Incremental builds** that rebuild only the entries a changed file touches.
- **Images from a CMS** through the build's image pipeline, from declared image fields.
- **Loaders for common CMSs** as separate packages, on the `collection()` contract.

## Decisions

Settled in review, against `main` at 2b33230, in the order they were discussed:

| Question | Decision | Section |
| --- | --- | --- |
| When loaders run | A pre-pass in `configResolved`: a scan of the pages, the content module and its loaders, the globs `data-sn-pages` needs, then the inputs; any failure stops the build before an input exists. `sitemap.paths` runs in `generateBundle` and is no precedent for timing | [§3](#when-loaders-and-globs-run-a-pre-pass) |
| How a collection is declared | `collection({ key, load })` with a context (`files`, `get`, `env`, `mode`, `locale`), not any exported function: `get` memoizes and orders loaders, `files` is watched in dev, `mode` gives drafts | [§3](#3-content-code-at-build-time) |
| Secrets | Loaders read `.env` through `ctx.env` (Vite's `loadEnv`, every prefix), since nothing loads `.env` today; browser code gets only the fields it reads, or those `fields` names; the dev overlay's messages are scrubbed | [§3](#3-content-code-at-build-time), [§4](#4-what-a-page-gets), [§8](#8-dev-sinter-check-and-the-editor) |
| An entry's URL | An exact path, as every `data-sn-path` page's: `blog/hello.html` at `/blog/hello`, canonical without a trailing slash; the template's file is not written (`movesToDirectory` is false for these pages, so there is no redirect file to keep) | [§5](#5-a-page-per-entry-data-sn-pages) |
| The attribute's name | `data-sn-pages`, not `data-sn-each`: `each` is already fan-out on `<sn-resource>` | [§5](#5-a-page-per-entry-data-sn-pages) |
| Paged indexes | No `pages()` built-in, and no fixed path beside the pattern (which would make every page's canonical the fixed URL): a collection of chunks, an ordinary `data-sn-pages` page | [An index in pages](#an-index-in-pages) |
| `sinter check` | Reads `file:` sources, globs included; never runs loaders, and compiles `content:` against the build's snapshot, saying when it has none or it is stale | [§8](#8-dev-sinter-check-and-the-editor) |
| Rest parameters and slugs with `/` | Out: one segment per parameter; nested folders give `dir`, and a URL with a year takes it as a field | [Not goals](#not-goals), [§2](#a-glob-is-a-list) |
| Embedded live data | Not in the first version: `data-sn-pages` pages are left out of `sinter-embed.json` | [§5](#5-a-page-per-entry-data-sn-pages) |
| Languages | `{$locale}` in a `file:` path; a loader per language when it reads `locale`; entries paired by `key`, so slugs can be translated; a missing entry has no page, no alternate and a `null` `localeUrl()`; one chooser per entry | [§7](#7-languages) |
| A long post over `EXPANSION_LIMIT` | An error on `data-sn-pages` pages, not SN536's warning | [§5](#5-a-page-per-entry-data-sn-pages) |
| Link checking's scope | Links under `data-sn-pages` patterns only, named `broken-entry-link`; checking every internal link is separate | [§6](#6-types-and-links) |
| `file:` and collections | One build-time resource with two sources: `file:` for the repository (one file or a glob, usable in a library's components), `content:` for code (the app's content module). No `files()` collection: a loader reads files through `ctx.files`. `file:` is unreleased, so it changes in part A rather than living beside a second mechanism | [§1](#1-one-build-time-resource-two-sources) |
| A `.md` file's value | An entry, `{ ...frontmatter, body }`, alone or in a glob; `.json` and text files keep their values | [§2](#what-a-files-value-is) |
| Sorting | `order` on both sources, sorted once at build time, in the page's language with `localePrefix` and the base language without; the same attributes for both sources | [§4](#4-what-a-page-gets) |
| Interpolation in `file:` | Only `{$locale}`, with `localePrefix`; anything else stays SN332 | [§2](#locale-in-a-path) |
| `type` on a glob | Names one entry's type (the frontmatter's); sinter adds `slug`, `dir`, `path`, `body` | [§4](#4-what-a-page-gets) |
| Drafts | `draft: true` in an entry's frontmatter, left out of production builds; no option | [§2](#a-glob-is-a-list) |
