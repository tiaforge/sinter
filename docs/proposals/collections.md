# Proposal: build-time data, collections and a page per entry

Status: draft, revised three times and prototyped (see [Decisions](#decisions)): after a first review, to fold the
unreleased `file:` source into this design (so that sinter has one concept for data the build reads, not
two), and after a second review. sinter is pre-1.0 with no users and every piece touched here is
unreleased, so compatibility is not a constraint anywhere in this proposal: what exists changes freely. It
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
| Constant loops and folding | `MAX_UNROLL = 1000` per list, `EXPANSION_LIMIT = 10_000` per page (`compile.ts:8467`) | a `data-sn-for` over a constant list is rows in the HTML; helpers over constants run at build time. The per-list limit is removed since ([§4](#4-what-a-page-gets)) |
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
- **The same attributes for both**: `name`, `src`, `type`, `items`, `key` and, new, `order`, `fields` and
  `drafts` ([§2](#a-glob-is-a-list), [§4](#4-what-a-page-gets)). `items` picks a list out of a value (a JSON file's, a loader's); `key`
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
| `.md`, `.markdown` | **an entry**: its frontmatter's fields and `body`, the markdown after the frontmatter (a file without frontmatter is `{ body }`) |
| `.json` | its parsed value, as today |
| anything else | its text, as today |

The `.md` row is the one change to `file:` as it is on `main` (where a `.md` file's value is its text): a
hand-written post page can now read its title and date, and `md.parse(post)` becomes `md.parse(post.body)`.
The docs, sinter-markdown's docs, fixtures and tests, and the CHANGELOG's `file:` entry change with it
([Plan](#plan)).

- **Fields sinter writes are reserved.** A frontmatter key `body`, `dir` or `path` is SN332; `slug` may be
  given (it replaces the file name, [below](#a-glob-is-a-list)).
- **`items` on a `.md` file** is SN332: an entry is one object, not a list to pick from.
- **A text file is a string alone and `{ body }` in a glob**: a list's entries are objects, so that they
  can carry `slug`, `dir` and `path`. This is the one place the two forms differ, and it is stated in the
  docs' table.

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
- **drafts** are explicit: `drafts="draft"` names a boolean field, and an entry where it is `true` is left
  out by `vite build` and kept by `vite dev` (by command, not Vite's mode, which can be any name:
  `staging`). `sinter check` and the editor treat drafts as `vite build` does, so unrolling and link
  checks agree with the build. Without the attribute, no field is read by name, and CMS or JSON data that
  happens to have a `draft` field is left alone;
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
- **`collection({ key, load, perLocale? })`**: `key` names the field that identifies an entry (required:
  it is the resource's default `key`, and what pairs translations, [§7](#7-languages)). `load(ctx)` returns
  a list, sync or async. `perLocale: true` calls it once per language with `ctx.locale` typed `string`;
  without it, `ctx` has no `locale` and the list is every language's.
- **`ctx`** is what a loader may depend on:

  | | |
  | --- | --- |
  | `files(glob, { drafts? })` | the files a glob matches, as `file:` reads them (the same entries, the same `drafts` rule), paths from the root; the dev server watches them for this collection |
  | `get(c)` | another collection's list (by its value, so a typo is a TypeScript error); loaded once, a cycle is an error naming it |
  | `env` | the variables of Vite's `loadEnv(mode, root, '')`: `.env`, `.env.production`, and the process's, every prefix. Not `process.env` itself: the helpers loader calls `resolveConfig` (`helpers-node.ts:76`), and nothing in sinter loads `.env` today |
  | `command` | `'build'` or `'serve'` |
  | `locale` | with `perLocale: true` and `localePrefix`, the language being loaded ([§7](#7-languages)) |

- **The module runs in Node**, through its own loader (not `loadHelpers`, which never throws and folds
  nothing on failure, SN533): a module that fails to load, or a loader that throws, fails the build. In
  the build it is a short-lived module runner like the helpers' build loader, whose `resolveConfig` call
  re-enters sinter's plugin, so it needs the same guard (`loadingHelpers()`, `vite.ts:248`); in dev it is
  the dev server's `ssrLoadModule`. It is not checked for purity and never ships: it may fetch, read the
  disk and use secrets.
- **The result must be a list of plain data** (arrays, objects, strings, numbers, booleans, `null`) with a
  unique string or number `key` per entry. A `Date` from a CMS SDK is an error at the entry, which says to
  return `toISOString()`. The list is deep-frozen and shared by every page.
- **Its own file, not `vite.config`.** It sits beside `sinter.helpers.ts` and `sinter.types.ts`, where the
  editor and `sinter check` already look. `sinter({ content: 'src/content.ts' })` moves it, as `helpers`
  does.
- **`content:` is a reserved source name**, as `file` is: it cannot be an API's name (SN329). An unknown
  collection is SN-new `unknown-collection`, with a "did you mean".

#### When loaders and globs run: a pre-pass

Pages per entry ([§5](#5-a-page-per-entry-data-sn-pages)) need their lists before the build's inputs exist,
and compiling is synchronous. Today the only way to learn a page's `data-sn-path` is a full compile
(`describe`, `describeSource`, `vite.ts:566`), which needs the lists. So:

- **An extractor** in `src/compiler/` reads, from a page's HTML without compiling it, its root's
  `data-sn-path` and `data-sn-pages` and its top-level build-time resources (`src`, `key`, `items`,
  `order`, `drafts`, `{$locale}`). It is one function with the compiler's own attribute parsing, and
  `compile()` asserts that it agrees with what the compile found, so the two cannot drift silently.
  Resources inside components and layouts need no pre-pass: they are read during the compile, as `file:`
  is today, synchronously, from values loaded before it.
- **In the build**, the pre-pass runs in sinter's `configResolved`, which is already async and already
  replaces the inputs for `localePrefix` (`vite.ts:762`): run the extractor over the pages, load the content
  module through its own runner, run the loaders the pages' resources name (concurrently, dependencies
  through `get`), read the globs, and set one input per entry (and language). The prototype does exactly
  this, without languages, and Vite's HTML entries, the canonical links, the sitemap and the redirect
  rules take the virtual inputs as they are ([Prototype](#prototype)); Rollup's `options` hook is not
  needed. `content:` resources that only components read are loaded in `buildStart`, before any compile.
  Any failure stops the build before an input exists, with the export's or file's name.
- **Virtual inputs without languages.** Today inputs are rewritten, and `resolveId` resolves virtual
  pages, only with `localePrefix` (`vite.ts:762`, `993`). The virtual page becomes `{ source, locale?,
  entry? }`, used with either or both.
- **In dev**, nothing runs at startup: a request for a URL under a `data-sn-pages` pattern is routed by the
  existing pattern matching (`rewrite()`, `matches`, `vite.ts:1574`), which loads the list on first use,
  finds the entry, and compiles that page.

A loader nothing reads is not run. A glob is read once per build and per language; resources share the raw
list and sort or filter copies (each resource has its own `order`, `items` and `drafts`).

### 4. What a page gets

```html
<sn-resource name="posts" src="file:/content/posts/*.md" type="Post" order="-date"></sn-resource>
<ul>
  <template data-sn-for="p in posts.slice(0, 10)">
    <li><a data-sn-attr="{ href: '/blog/' + p.slug }" data-sn-text="p.title"></a> <time data-sn-text="date(p.date)"></time></li>
  </template>
</ul>
```

- **`order`** sorts a list once, at build time, with the syntax a live resource's `order` has (one field,
  `-date` descending). A live resource compares strings in the visitor's language (`docs/resources.md:37`); at
  build time they are compared in the page's language: its `<html lang>` (the layout's included), which with
  `localePrefix` is each language's, else `en`. `order` on a value
  that is not a list is SN332.
- **`type`** names the type of one entry for a glob (`type="Post"`, the frontmatter's fields), and sinter
  adds `slug`, `dir`, `path` and `body`: so the type a page reads is `(Post & FileEntry)[]`. For one `.md`
  file it is `Post & { body: string }`; for `.json`, a text file and `content:` it is the value's type, as
  today. A `content:` collection without `type` takes its loader's return type. A `.md` file or glob
  without `type` is `{ body: string }` plus the file fields, with no warning: a markdown file with no
  frontmatter needs nothing (an untyped `.json` file stays SN504).
- **`type` is checked against the files.** `sinter check` reads `file:` values anyway, so its shadow file
  writes each value as a literal that must satisfy the type (`[…] satisfies Post[]`): a `titel:` in one
  post's frontmatter is a type error at that resource, naming the file. Without this, `type` would be an
  unchecked assertion and typos in content would build.
- **What ships is only what is named.** Embedding today is the whole value (`scriptJson`), kept when a
  compiled function's text mentions the resource (`dropFiles`, `compile.ts:6190`), and nothing tracks which
  fields of an entry are read through loops, props or component scripts. Inferring the fields is real
  compiler work, so the first version is explicit: a build-time list or object that browser code reads
  needs `fields="slug,title,tags"`, and only those fields of each entry are embedded. Without `fields`,
  such a read is SN-new `content-fields`, naming the read. Browser code sees the type narrowed to those
  fields (`Pick<Post, 'slug' | 'title' | 'tags'>[]`), so `sinter check` reports a read outside them. A
  value nothing in the browser reads is not embedded at all, and needs no `fields`, as today; a string (a
  text file) embeds whole. So a CMS's internal fields and posts' bodies never reach a page by accident.
  The build line names each embedded resource and its size. Inferring `fields` from member accesses is
  [future work](#future-work).
- **One limit: the page's budget.** Today a page has two: `MAX_UNROLL`, at most 1,000 items per list
  (`listOf`, `compile.ts:6278`), and `EXPANSION_LIMIT`, at most 10,000 rows and component instances per
  page, at any depth (`compile.ts:8474`). The second already counts every row of every list, and it is the
  measured one: about 0.2 ms of compile per row or instance, so a page stays near one second in the
  build and in the editor, which compiles on every edit. The first adds nothing but a refusal: a list of
  5,000 rows on a page far under its budget stays a template, with no diagnostic at all. **`MAX_UNROLL` is
  removed**: a constant list unrolls as long as the page's budget holds, and one that would cross it
  renders in the browser with SN536 at its loop, as a tree that crosses it does today. The budget becomes
  an option, `sinter({ expansionLimit })` (today internal, "tests and measurements", `compile.ts:192`),
  for a site that measures a bigger page as fast enough. An index of thousands is still better paged
  ([An index in pages](#an-index-in-pages)): HTML for every post on one page is heavy for the visitor,
  whatever it costs the build.

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
  entry's field of that name, encoded as a path segment with the sitemap's encoder (`fillPattern`,
  `sitemap-build.ts:68`: `a b` is `a%20b`, unicode percent-encoded). A field that is missing, not a string
  or number, empty, `.` or `..`, or holding a `/`, fails the build naming the entry (its file, for a
  glob). A URL that two entries fill, or that another page or a file in `public/` is written at (a slug
  `index` beside `blog/index.html`, `/:slug` beside `about.html`), fails it too, naming both.
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
- **`<name>` is page scope, because it is a resource**: the compile of each entry adds an implicit
  build-time resource `<name>` whose value is the entry (a `fileData` entry, as a `file:` value is), so it
  has a build-time resource's rules, scope and `fields`. The page's markup, its head and the layout's
  slots it fills read it; components and the layout get it through props. It cannot shadow a store function, a resource
  or a magic name (`page in …` is SN-new, since `page` is a store function, `expr.ts:266`). The list
  itself stays readable under its own name, for a "next post" link.
- **One page module per entry.** Each entry is a virtual page (`{ source, locale?, entry }`) with its own
  module, as each page in a language has one today (`moduleSrc` per page, `vite.ts:658`); and the
  compiler's second pass writes the module from constants (`decided`, `unrolled`, `constants`,
  `compile.ts:707`), so two entries that decide a `data-sn-if` differently have different code. A
  `data-sn-pages` page with nothing to run has no module, so a static blog is unaffected; one with a live
  resource (the comments above) has one small module per entry, sharing the runtime chunk. The prototype
  measures what 10,000 of them cost the build; a module shared between entries, reading the entry from
  embedded data instead of folding it, is [future work](#future-work).
- **The fold cross-check runs per entry.** A production build re-runs each page's folded calls at its end
  (`logFold`, `vite.ts:639`), keyed by source page and reset at its first call; it is keyed by virtual
  page instead, so every entry is checked, not only the last one compiled.
- **A long post stays static or fails.** Over the page's budget, a tree or list renders in the browser
  with SN536, a warning; on a `data-sn-pages` page it is an error, so one long post cannot silently ship
  its body and the runtime. The way out is a higher `expansionLimit` for the site.
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
- **A `content:` loader is called once per language with `perLocale: true`**, and once in all without it.
  It is explicit (`docs/spec.md`: everything visible, nothing implicit), and it is what types
  `ctx.locale`. A collection that `get`s a per-language one is per-language too, and must say so (a
  mismatch is `collection-load`).
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
- **`sinter check` and the editor read `file:` sources, and never run loaders.**
  - They compile without a language (`lsp/workspace.ts:214`; the shadow file does not know `localePrefix`,
    `shadow.ts:170`), so `{$locale}` is the base language there and `order` compares in it.
  - Globs are cached by each file's modification time: the editor recompiles on a debounce with a
    synchronous `readFile`, and re-parsing ten thousand frontmatters per keystroke is not an option. A
    change re-reads only the files that changed.
  - The editor watches the globs' fixed parts (`content/posts/`), registered with the client beside its
    current watchers (`lsp/server.ts:174`, which have no `.md`), so editing a post updates the pages that
    read it.
  - For `content:` they read a **snapshot**: the build and the dev server write each collection's list to
    `node_modules/.cache/sinter/content.json`, keyed by collection, language and command. Without one they
    type from the loaders' declared types alone and say once that value-dependent checks were skipped.
    Staleness is best-effort: a snapshot older than the content module is reported stale, but a CMS
    change or a changed file a loader read is not detected; in CI, `sinter check` after `vite build` has a
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

## Prototype

Part 0 is done: `sinter({ prototypePages })` on the branch builds a template page once per entry, as
virtual inputs at the filled `data-sn-path`, and `bench/collections/` builds a markdown blog with
sinter-markdown at several sizes, static and with a live resource ([its README](../../bench/collections/README.md)).

**What works as designed, with no code beyond the virtual inputs.** Each entry is written at its exact path
(`blog/post-3.html` at `/blog/post-3`), its canonical link is written at build time, the sitemap lists every
entry without `sitemap.paths`, `_redirects` needs no rule, a static post ships no JavaScript, and a post
with a live resource gets a module of its own. The pre-pass fits in `configResolved` (above).

**One quadratic, found and fixed.** The Speculation Rules list every page's URL, in every page's head: at
1,000 entries 23 kB of each post's 26 kB was the list, so 10,000 entries would have written about 2.3 GB.
A `data-sn-pages` page is named in the rules once, by its pattern (`/blog/:slug` as `/blog/*`), as a
pattern page is today; the prototype does this, and each post is 3.2 kB at any size.

**Build time is linear, and it is the compiler's, not this feature's** (4 cores, Node 22, posts of about
600 words, the median of one run each):

| Entries | Static | With a live resource | Peak memory, static / live |
| ---: | ---: | ---: | ---: |
| 100 | 18 s (181 ms each) | 21 s (215 ms each) | 0.5 / 0.5 GB |
| 1,000 | 176 s (176 ms each) | 195 s (195 ms each) | 0.7 / 1.2 GB |

The profile of the static build (100 entries) says where the time goes:

- **Every page is compiled twice**: once in `buildStart`, which collects the early scripts (`vite.ts:876`,
  44% of the time), and again in `transformIndexHtml` (`vite.ts:1201`, 40%). With `firstPaint: false`,
  which skips the first, the same build takes 12 s instead of 22.
- **One compile of a markdown post is about 90 ms**, nearly all of it expanding `<md-doc>`'s tree: acorn
  re-parses the same expressions at every node (25%), and component files are read again, with
  `realpath` and `lstat`, at every instance (13%). Caching file reads across compiles saves about 15 ms
  per entry.
- `describe` (each page's paths, for links and prefetch) is about 5 ms per page, and the per-page lists
  (`pageEntries`, the rules) are negligible.

None of this is specific to a page per entry: a hand-written page over one markdown file costs the same
today. A page per entry multiplies it. So the work that makes this feature practical at thousands of
entries is the compiler's, and it helps every page:

1. **One compile per page**: the early-script pass reuses the page's compile instead of compiling it again
   (half of the time);
2. **Caches across compiles within a build**: component files read and parsed once, and expressions
   parsed once per source text (together, most of what is left);
3. **Compiles in workers**, when the first two are not enough: pages are independent, and the compile is
   synchronous and single-threaded today.

The 10,000-entry run was stopped: linear scaling from 100 to 1,000 says it would take about 30 minutes as
it was. Items 1 and 2 are done (see [Plan](#plan)): 100 posts build in 6.5 s instead of 21.2 s, so 10,000
would take about 11 minutes, before workers.

The Speculation Rules' list of every page is also quadratic for a site of many fixed pages today, not only
for pages per entry: a site of 10,000 hand-written pages writes every URL into every page. Part B names a
`data-sn-pages` page by its pattern; a site of that many fixed pages would need the rules to stop listing
pages (a pattern for the site, with exclusions), which is a separate change. Memory grows about 0.3 MB per
entry static and 0.7 MB with a live resource (a module per entry), so roughly 3 GB and 7 GB at 10,000:
the same run checks that too.

## Diagnostics

SN332 (`file-source`) becomes the code for every build-time source problem, and is renamed
`build-time-source`: a glob's `.json` file that is not an object, duplicate keys, invalid frontmatter, a
reserved frontmatter key, `items` on a `.md` file, `{…}` other than `{$locale}`, `order` on a value that is
not a list, an attribute a build-time resource does not take, and what it covers today
(`fileAttrProblem`'s wording, `files.ts:18`, which refuses `order`, changes with it). New codes, numbers assigned at implementation:

| Code | When |
| --- | --- |
| content-module | an export of the content module that is not a collection; the module fails to load |
| collection-load | a loader throws, returns a non-list, non-plain data, or a missing or duplicate `key` |
| unknown-collection | `content:name` names no collection |
| content-fields | browser code reads a build-time list or object without `fields` |
| pages-param | an entry has no usable value for a `:param` (missing, empty, not a string or number, `.`, `..`, a `/`), or its URL is another entry's, another page's or a `public/` file's |
| pages-path | `data-sn-pages` without exactly one pattern in `data-sn-path`, or naming no top-level build-time list of the page |
| url-param-pages | `$url.<param>` on a `data-sn-pages` page |
| broken-entry-link | a link in the built HTML under a `data-sn-pages` pattern that no entry was written at |

A glob that matches nothing is a warning (SN-new `empty-glob`). SN329 covers an API named `content`;
SN536 is an error on a `data-sn-pages` page.

## Testing

- **Unit**: frontmatter (the failsafe schema, no dates, invalid YAML with its line, a file without it),
  globs (slugs, `dir`, `path`, reserved keys, sort, `drafts` per command, `.json` that is not an object,
  no match, symlinks out of the root, `{$locale}`), `collection()` validation, `ctx.files`, `get` and
  cycles, `ctx.env`, `perLocale`, `chunks`; the extractor against the compiler on every fixture page.
- **Compiler**: the existing `test/behaviour/files.test.ts` over both sources; `.md` as an entry; `order`
  per language; `fields`, the narrowed type and `content-fields`; `type` checked against the files
  (`satisfies`); a list of 5,000 rows unrolled, one over the budget with SN536 at its loop; `data-sn-pages` constants in the head, slots and
  props; the new codes.
- **Build** (the fixture pattern of `test/static-*`): a blog of three posts, an index, a paged archive and
  a tag page; the files at exact paths, no JavaScript, the sitemap, the canonical links, no `_redirects`
  rule, no template file, a broken entry link failing; with `localePrefix`, `{$locale}` and a post missing
  in one language; a live resource on a generated page; a loader failing before any input exists.
- **Dev** (e2e): editing a markdown file reloads its page and the index; adding one serves its URL; a
  failing loader's overlay with a token in its URL, scrubbed.
- **Check and editor**: globs read without a build, cached by mtime, a changed `.md` re-checked through
  the watcher; `content:` with and without a snapshot, and with a stale one.
- **The static-site example** gains a blog from `content/posts/*.md` with sinter-markdown.

## Plan

A prototype first, then three pull requests, each followed by a review of where it departed from this text:

- **0, prototype**: done ([Prototype](#prototype)): the pre-pass in `configResolved`, virtual pages
  without `localePrefix`, the Speculation Rules by pattern, and the measurements.
- **Compile cost, before B**: done, on its own ([Prototype](#prototype), items 1 and 2): one compile per
  page, expressions parsed once per text, the project and its files read once per build. 100 markdown
  posts build in 6.5 s instead of 21.2 s, with the same output. The 10,000-entry run waits for part B: as
  files, 10,000 pages would hit the Speculation Rules' quadratic (below), which exists today for any site
  with that many fixed pages, and which part B fixes for `data-sn-pages` pages by naming the pattern.
- **A, build-time resources**, in four pull requests: (1) `file:` for the repository: a markdown file as an
  entry, globs, `key` and `slug`, `drafts`, `order`, SN332's rename and SN539, and what already used `file:`
  (sinter-markdown's `md.parse(post.body)`); (2) the limits: `MAX_UNROLL` removed, `expansionLimit` public;
  (3) `{$locale}`, `fields`, `type` checked against the files, the editor's glob cache and watchers; (4)
  `content:` and the content module, in three pull requests: (4.1) the module, its loaders and `content:`, done:
  collections are loaded in `configResolved` with the helpers' runner, all of them (not only those pages read: finding
  those needs the pages compiled, which needs the lists), and `data-sn-pages` takes them; (4.2) `sinter check` and the
  editor (the snapshot, types from the loaders); (4.3) `fields`. The first three are done, except `fields`, which moves to (4): its check, a
  browser read outside `fields`, needs to tell build-time reads from browser reads of one resource, since `sinter
  check` types a resource once and a post's `body` is read at build time by the same page whose browser code reads
  its title; that is the field tracking listed as future work, and it matters most for a CMS's data; in it, `order` compares in the page's `<html lang>`.
  The whole part, as planned: `file:` as in §2 (a `.md` file is an entry, globs, `drafts`, `{$locale}`),
  `order`, `fields`, `MAX_UNROLL` removed and `expansionLimit` public (§4), `content:` and the content module (§3), types checked against
  the files, the snapshot and the editor's watchers (§6, §8), dev reload, SN332's rename. Part A also
  changes what already uses `file:`, and the docs of the limit: `docs/static-pages.md` ("a list over 1,000
  items"), `docs/resources.md#files`, the CHANGELOG's `file:` entry (rewritten
  as one entry for build-time resources), sinter-markdown's README, `docs/markdown.md`, its fixture page
  and `test/static.test.ts` (`md.parse(post)` becomes `md.parse(post.body)`), `examples/static-site`, and
  the `file:` examples in `docs/proposals/component-libraries.md` (a note, since proposals are records).
  Useful alone: an index over a folder, a post's title from its frontmatter.
- **B, a page per entry**: `data-sn-pages` (§5) with the extractor and the pre-pass, exact paths and
  collisions, the sitemap and canonical links, languages (§7), dev routing, the per-entry fold check,
  `chunks`. Done, over `file:` globs, with these departures:
  - **No extractor**: `configResolved` compiles each template once, which reads its `file:` list synchronously
    and reports every entry with its filled path (`CompileResult.pages`). Nothing can drift from the compiler's
    rules, and it costs one compile per template. `content:` (step 4) loads its loaders before that compile.
  - **The entry is an internal build-time resource** beside the list, so scope, folding, embedding and the
    check's type (`Item<typeof posts>`) come from the resource machinery.
  - **Not yet**: languages (§7, a build error says so), `$url.<param>` on such a page (SN-new), SN536 as an
    error there, `chunks`.
  - **Two quadratic costs found and fixed**: every entry's page wrote the whole list's JSON into its head and
    parsed it before dropping it (now written only for values left after the compile), and built the list
    again (now kept per build). 1,000 entries build at 65 ms each, as 100 do. Four more were found at larger sizes and
    fixed in the next PR (#64); 10,000 markdown posts now build in 626 s (63 ms each, 4,000 at 49 ms), with no
    JavaScript shipped.
- **C, links and docs**: `broken-entry-link` (§6); a guide `docs/content.md`, the static-site example's
  blog, `resources.md` and `static-pages.md` pointing to it, `llms.txt`, CHANGELOG.

## Open questions

- **A module per entry at 10,000**: at 1,000 entries a module per post costs 10% more time and 0.5 GB
  more memory than none. Whether that holds at 10,000, or the first version needs the shared module, is
  the 10,000-entry run after the compile work.

## Future work

- **Inferred `fields`**: embedding the fields browser code reads, tracked through loops, lets and props,
  so `fields` is needed only where a read cannot be followed.
- **A module shared by every entry** of a `data-sn-pages` page, reading the entry from embedded data
  instead of folding it, if the prototype shows a module per entry is too costly.
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
| When loaders run | Before any input exists; `sitemap.paths` runs in `generateBundle` and is no precedent for timing. Revised in the second review: an extractor in `src/compiler/`, asserted by `compile()`, finds what the pre-pass needs without compiling; the build's pre-pass runs in `configResolved` (the prototype confirmed it; no `options` hook), with the helpers loader's re-entry guard; dev loads on first request | [§3](#when-loaders-and-globs-run-a-pre-pass) |
| How a collection is declared | `collection({ key, load, perLocale })` with a context (`files`, `get`, `env`, `command`, `locale`), not any exported function: `get` memoizes and orders loaders, `files` is watched in dev | [§3](#3-content-code-at-build-time) |
| Secrets | Loaders read `.env` through `ctx.env` (Vite's `loadEnv`, every prefix), since nothing loads `.env` today; browser code gets only the fields `fields` names (explicit in the first version, since nothing tracks field reads today), and its type is narrowed to them; the dev overlay's messages are scrubbed | [§3](#3-content-code-at-build-time), [§4](#4-what-a-page-gets), [§8](#8-dev-sinter-check-and-the-editor) |
| An entry's URL | An exact path, as every `data-sn-path` page's: `blog/hello.html` at `/blog/hello`, canonical without a trailing slash; the template's file is not written (`movesToDirectory` is false for these pages, so there is no redirect file to keep) | [§5](#5-a-page-per-entry-data-sn-pages) |
| The attribute's name | `data-sn-pages`, not `data-sn-each`: `each` is already fan-out on `<sn-resource>` | [§5](#5-a-page-per-entry-data-sn-pages) |
| Paged indexes | No `pages()` built-in, and no fixed path beside the pattern (which would make every page's canonical the fixed URL): a collection of chunks, an ordinary `data-sn-pages` page | [An index in pages](#an-index-in-pages) |
| `sinter check` and the editor | Read `file:` sources, globs cached by mtime and watched; never run loaders, and compile `content:` against the build's snapshot (keyed by collection, language and command; staleness best-effort); compile in the base language | [§8](#8-dev-sinter-check-and-the-editor) |
| Rest parameters and slugs with `/` | Out: one segment per parameter; nested folders give `dir`, and a URL with a year takes it as a field | [Not goals](#not-goals), [§2](#a-glob-is-a-list) |
| Embedded live data | Not in the first version: `data-sn-pages` pages are left out of `sinter-embed.json` | [§5](#5-a-page-per-entry-data-sn-pages) |
| Languages | `{$locale}` in a `file:` path; a loader per language with `perLocale: true` (explicit, not traced); entries paired by `key`, so slugs can be translated; a missing entry has no page, no alternate and a `null` `localeUrl()`; one chooser per entry | [§7](#7-languages) |
| Limits | One: the page's budget (`EXPANSION_LIMIT`, measured, every row and instance), public as `sinter({ expansionLimit })`. `MAX_UNROLL`, the per-list cap, is removed: it refused lists the budget allowed, silently. Over the budget is SN536, an error on `data-sn-pages` pages | [§5](#5-a-page-per-entry-data-sn-pages) |
| Link checking's scope | Links under `data-sn-pages` patterns only, named `broken-entry-link`; checking every internal link is separate | [§6](#6-types-and-links) |
| `file:` and collections | One build-time resource with two sources: `file:` for the repository (one file or a glob, usable in a library's components), `content:` for code (the app's content module). No `files()` collection: a loader reads files through `ctx.files`. `file:` is unreleased, so it changes in part A rather than living beside a second mechanism | [§1](#1-one-build-time-resource-two-sources) |
| A `.md` file's value | An entry, `{ ...frontmatter, body }`, alone or in a glob; `.json` and text files keep their values; `body`, `dir` and `path` are reserved frontmatter keys; untyped, it is `{ body: string }` with no warning | [§2](#what-a-files-value-is) |
| Sorting | `order` on both sources, sorted once at build time, in the page's language with `localePrefix` and the base language without; the same attributes for both sources | [§4](#4-what-a-page-gets) |
| Interpolation in `file:` | Only `{$locale}`, with `localePrefix`; anything else stays SN332 | [§2](#locale-in-a-path) |
| `type` on a glob | Names one entry's type (the frontmatter's); sinter adds `slug`, `dir`, `path`, `body`; `sinter check` checks every file's value against it (`satisfies`) | [§4](#4-what-a-page-gets) |
| Drafts | Explicit, `drafts="field"` (and `ctx.files(glob, { drafts })`): left out by `vite build`, kept by `vite dev`, as the build in `check`; no field is read by name without it |
| Compatibility | None needed: pre-1.0, no users, every piece unreleased. `content` is reserved as a source name although `apis` shipped; `file:` changes in place |
| A page module per entry | Yes in the first version, since the second pass writes modules from constants; the prototype measures it, a shared module is future work |
| Speculation Rules | A `data-sn-pages` page is named once, by its pattern: listing every entry in every page was quadratic (found by the prototype) | [Prototype](#prototype) |
| Compile cost | The prototype measured 180 ms per markdown entry, linear, the compiler's own cost (two compiles per page, re-parsing per node). One compile per page and caches across compiles come before part B | [Prototype](#prototype) |
| Entry URLs | Encoded with the sitemap's encoder; a URL another entry, page or `public/` file has fails the build | [§2](#a-glob-is-a-list) |
