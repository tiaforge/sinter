# Proposal: collections, build-time data and a page per entry

Status: draft, for review. It builds on [`file:` resources](../resources.md#files), on
[pages without JavaScript](static-pages.md) (constant loops unrolled, helpers over constants run at build
time, page URLs, `data-sn-path`, the sitemap) and on the per-language inputs of `localePrefix`. Line
references are to `main` at 2b33230.

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

## Not goals

- **Incremental or on-demand regeneration** (ISR). A CMS change is a rebuild. A site whose content changes
  faster than it can rebuild keeps the pattern page and the [server layer](../server.md), which embeds
  the API's response into the one file at request time. The docs say which to pick
  ([Build-time or request-time](#7-build-time-or-request-time)).
- **A content store or query language.** A collection is a list of plain data. Filtering, sorting and
  grouping are expressions and helpers, as everywhere in sinter (`posts.filter(p => p.tags.includes(t))`).
- **Schemas at runtime** (Astro's zod). Types come from `sinter.types.ts` or the loader's return type,
  checked by `sinter check`; a loader that wants runtime validation validates in its own code.

## What sinter has to build on

| Piece | Where | What it gives |
| --- | --- | --- |
| `file:` resources | `src/compiler/files.ts`, `fileResource` in `compile.ts:5684` | a constant resource: `FILE_ATTRS` (`name`, `src`, `type`, `items`, `key`), embedded data for what still runs, SN332 for anything that would load it, dev reload on change |
| Constant loops and folding | `MAX_UNROLL = 1000`, `EXPANSION_LIMIT = 10_000` (`compile.ts:8467`) | a `data-sn-for` over a constant list is rows in the HTML; helpers over constants run at build time |
| The helpers module in Node | `loadHelpers` (`src/helpers-node.ts:50`), through Vite's `ssrLoadModule` | a TypeScript module of the app, with its imports and aliases, run in the build, the dev server and `sinter check` |
| Per-language inputs | `entries()`, `<root>/<locale>/<page>` (`src/vite.ts:762`) | one source page compiled several times with a different constant (`$locale`), each a Vite input with its own output path |
| `data-sn-path` and page URLs | [static-pages.md](../static-pages.md#which-urls-a-page-answers-at) | patterns with `:name` segments, `$url` with their values, `_redirects`, the canonical link, the sitemap |
| `sitemap.paths` | `src/sitemap-build.ts` | the precedent for running app code (async, may fetch) once per build to learn a pattern's values |

A collection is the `file:` resource made a list, loaded by a module like the helpers module. A page per
entry is the per-language input with an entry where the language was.

## Design

### 1. Collections are declared in `src/sinter.content.ts`

```ts
// src/sinter.content.ts
import { files } from '@tiaforge-ui/sinter/content';
import type { Post, Author, Product } from './sinter.types';

/** content/posts/*.md: one entry per file */
export const posts = files<Post>('content/posts/*.md');

/** content/authors/*.json */
export const authors = files<Author>('content/authors/*.json');

/** a CMS: any async function that returns a list */
export const products = async (): Promise<Product[]> => {
  const r = await fetch('https://cms.example.com/api/products?status=published', {
    headers: { authorization: `Bearer ${process.env.CMS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`CMS: ${r.status}`);
  return r.json();
};
```

- **Every export is a collection**, named by the export. An export is a function (sync or async) that
  returns a list of plain data, or what `files()` returns (which is such a function, with what the dev
  server needs to watch its files: [Dev](#6-dev-sinter-check-and-the-editor)).
- **The module runs in Node, once per build**, loaded as the helpers module is (`ssrLoadModule`, with the
  app's Vite config, aliases and `.env`). Unlike helpers it is not checked for purity and never ships: it
  may fetch, read the disk, read `process.env` and use secrets. What it returns is what ships, so the same
  warning as `file:` applies: what a page reads is in the page.
- **Its own file, not `vite.config`.** It sits beside `sinter.helpers.ts` and `sinter.types.ts`, where
  the editor and `sinter check` already look, and its return types are the collections' types without a
  `type` attribute ([Types](#5-types-and-links)). `sinter({ content: 'src/content.ts' })` moves it, as
  `helpers` does; `content: false` turns it off.
- **The result must be a list of plain data**: arrays, objects, strings, numbers, booleans, `null`, as
  for helpers folded at build time. A `Date` from a CMS SDK is an error at the collection, which says to
  return `toISOString()`. A non-list, or a loader that throws, fails the build, naming the export.
- **Each loader runs once per build**, the first time a page reads it, and its result is shared by every
  page (and every language with `localePrefix`). Loaders run concurrently. The result is deep-frozen, as
  `md.parse` trees are.

### 2. `files()`: a folder as a list

`files(pattern, options?)` reads every file a glob matches, relative to the project root, sorted by path:

| File | Entry |
| --- | --- |
| `.md` | its frontmatter's fields, `body` (the markdown after the frontmatter), and `slug`, `path` |
| `.json` | the parsed object's fields, and `slug`, `path` (a file that is not an object is an error) |
| anything else | `body` (its text), `slug`, `path` |

- `slug` is the file's path below the pattern's fixed part, without its extension:
  `content/posts/2026/hello.md` under `content/posts/**/*.md` is `2026/hello`. A field `slug` in the
  frontmatter wins. Two entries with one slug fail the build, naming both files.
- `path` is the file's path from the root (`/content/posts/hello.md`), so `md.parse(post.body, { base })`
  can resolve images next to the file: `base: post.path.replace(/[^/]*$/, '')`.
- Frontmatter is YAML between `---` lines, parsed with the failsafe schema plus numbers, booleans and
  `null` (no YAML dates: `date: 2026-11-16` stays the string `'2026-11-16'`, which `date()` formats at
  build time as a calendar date). The parser is a dependency of `@tiaforge-ui/sinter/content`, which
  never reaches the browser.
- `files(pattern, { draft: (e) => e.draft === true })` leaves entries out in a production build and keeps
  them in dev; without the option, nothing is a draft.
- The same rules as `file:` paths: the glob stays inside the root, symlinks outside it are refused.

`files()` is a convenience, not a special case: what it returns is a loader like any other. A CMS package
can ship its own (`contentful('blogPost')`), and an app can wrap one (`async () => (await
files<Post>('…')()).filter(…)`).

### 3. Reading a collection: `src="content:name"`

```html
<sn-resource name="posts" src="content:posts" order="-date"></sn-resource>
<ul>
  <template data-sn-for="p in posts.slice(0, 10)">
    <li><a data-sn-attr="{ href: '/blog/' + p.slug + '/' }" data-sn-text="p.title"></a> <time data-sn-text="date(p.date)"></time></li>
  </template>
</ul>
```

- **It is a `file:` resource whose value comes from the content module.** The same constant semantics:
  nothing loads, refreshes or writes it, `$meta.<name>.loading` is `false`, SN332 for `refresh`, `cache`,
  `paginate`, `each`, store functions and `<sn-event>`s. Bindings and helper calls over it are written
  into the HTML; what still runs reads it from embedded data in the head.
- **It takes `name`, `src`, `type`, `key`, and `order`.** `order` is allowed here (unlike `file:`, where
  `fileAttrProblem` refuses it) because the list never changes: it sorts once, at build time, with the
  same syntax as a live resource's. `key` defaults to `slug` when every entry has one.
- **`content:` is a reserved source name**, as `file` is (`FILE` in `files.ts`): it cannot be an API's
  name (SN329). An unknown collection is SN332 with a "did you mean".
- **Only what is read is embedded.** A page that unrolls `p.title` and `p.slug` into its HTML ships none
  of the collection. A page whose browser code reads `posts` (a search box filtering it) embeds it,
  whole: a field the browser never reads is not pruned in the first version. The build line names the
  collection and its size, so a 2 MB embed is visible
  ([Open questions](#open-questions)).
- **The unroll limits apply.** A list of more than 1,000 posts in one `data-sn-for` stays a template that
  renders in the browser, with the page then shipping the runtime and the embedded list. For an index of
  thousands, page the index ([§4, pages over slices](#pages-over-slices-an-index-in-pages)).

### 4. A page per entry: `data-sn-each`

```html
<!-- blog/post.html -->
<html data-sn-path="/blog/:slug" data-sn-each="post in posts">
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
dist/blog/hello/index.html          /blog/hello/
dist/blog/2026/recap/index.html     /blog/2026/recap/    (a slug with a slash: see below)
dist/blog/post.html                 a redirect to /blog/ (as every page's old file URL)
```

- **`data-sn-each="<name> in <collection>"` on `<html>`, beside a `data-sn-path` with parameters.** The
  build compiles the page once per entry, with `<name>` a constant in the whole page (its layout,
  components, head), and writes it at the pattern filled from the entry: `:slug` is `post.slug`, and
  in general each `:param` is the entry's field of that name. A field that is missing, not a string or
  number, or empty, fails the build naming the entry (its file, for `files()`).
- **The collection is the page's, not a resource on it.** `data-sn-each` names an export of the content
  module directly, so the page needs no `<sn-resource>` to have it. A page that also loops over the
  collection (a "next post" link) declares the resource as usual; both are the same frozen list.
- **The page is a fixed-path page for every rule that follows**, because every URL is now a file:
  `$canonical` is a constant, the canonical link is written at build time, no `_redirects` rewrite is
  written for the pattern, `$url` has no path parameters (reading `$url.slug` is SN-new, "use
  `post.slug`"), and the sitemap lists every URL with no `sitemap.paths` entry for the pattern (one is an
  error, since the build knows the values).
- **A parameter that holds a slash** (`2026/recap`) is a rest parameter: `data-sn-path="/blog/:slug*"`.
  Without the `*`, a value with a slash fails the build. Values are encoded per segment as in the sitemap.
- **With `localePrefix`**, the page is built once per language and entry, `/de/blog/hello/`. An entry
  that differs per language is the loader's business: `files('content/{locale}/posts/*.md')` with
  `{locale}` filled per language, or a loader that takes the locale (`export const posts = (o: {
  locale: string }) => …`). A loader without a parameter is loaded once and shared by every language.
- **Implementation**: the per-language inputs already turn one source into several Vite inputs
  (`<root>/<locale>/<page>`) with a constant fixed per input. Entries are the same: one input per entry
  (`<root>/<locale>/<pattern filled>.html`, resolved by the same `resolveId`/`load` hooks), compiled with
  `post` added to the page's constants. The page module, when one ships, is the same for every entry,
  bundled once: what differs between entries is constants, which are in the HTML or the embedded data,
  not the module.
- **Build time** grows with entries × the page's compile time, which for a static page is a few
  milliseconds plus what folds (`md.parse` of a long post is tens of ms). The build line says how many
  files each page became and how long it took. A cap is not proposed; 10,000 entries of a small page
  would be about a minute, which is the order of every other generator.

#### Not a pattern page: one page, several URLs per entry

`data-sn-each` requires `data-sn-path` with parameters, and the page must have no other path in it
(`data-sn-path="/editor /editor/:slug"` with `data-sn-each` is an error: a fixed path would be built once
per entry to the same file).

#### Pages over slices: an index in pages

```html
<!-- blog/index.html -->
<html data-sn-path="/blog/ /blog/page/:n" data-sn-each="page in pages(posts, 20)">
```

`pages(list, size)` is a built-in that is only valid in `data-sn-each`: it gives `{ n, items, count,
prev, next }` per page, `n` from 1. The first page (`n === 1`) is written at the fixed path (`/blog/`), the
others at the pattern (`/blog/page/2/`). This is the one case where `data-sn-each` takes a fixed path
beside the pattern, and the reason the rule above says "a fixed path would be built once per entry": here
exactly one entry goes there. This keeps an index of thousands under `MAX_UNROLL` per page and in plain
HTML; the alternative, a client-side paged list over an embedded collection, ships the whole collection.

Taxonomies (a page per tag) are a loader, not a feature: `export const tags = async () => groupBy(await
posts(), 'tags')`, which returns `{ slug, posts }` per tag, and `tag.html` with `data-sn-each="tag in tags"`.
A loader may call another; each still runs once.

### 5. Types and links

**Types.** A collection's type is its loader's return type, read by `sinter check` and the editor from
the content module, as `sinter.types.ts` is read today. `files<Post>()` gives `Post & { slug: string;
path: string; body: string }`. A loader typed `any` (or an untyped `.js` module) is SN504 at each
`content:` resource and `data-sn-each`, as an untyped `file:` resource is; `type="…"` on the resource
overrides it.

**Links to entries.** The build knows every URL a `data-sn-each` page was written at, and every link it
writes into HTML (the link rewriting of [page URLs](../static-pages.md#page-urls) already visits them). A
link in the built HTML to a path under a `data-sn-each` pattern that no entry was written at is an error:

```
blog/index.html:14:12 error SN-new broken-link: `/blog/helo/` is under `/blog/:slug` (blog/post.html), but no entry of `posts` has slug `helo`. Did you mean `hello`?
```

- It checks what the build writes, so it covers links from constants and from folded expressions (the
  index's unrolled list), in markdown too (`<md-doc>`'s links are attribute bindings over constants).
- A link built at run time is not checked (it is not in the HTML), as page links are not rewritten there.
- A `files()` markdown link to a sibling `.md` file (`[next](./other.md)`) stays as written today
  (`md.parse`'s `base`); mapping it to the entry's URL is [future work](#future-work).
- Only patterns with `data-sn-each`: the slugs of an API-backed pattern page are not known.

### 6. Dev, `sinter check` and the editor

- **`vite dev`** loads a collection the first time a page reads it, and keeps it. A `files()` collection
  is watched: a changed, added or removed file reloads the collection and every page that read it (the
  `file:` resource's reload, at collection granularity). Any other loader is loaded once per dev server, and
  reloaded when the content module itself changes or the server restarts. A
  loader that fails in dev shows the error in the overlay for the pages that read it, and the rest of
  the site keeps working.
- **A page per entry in dev** is served at each entry's URL by the same middleware that serves a page in a
  language, compiled on request.
- **`sinter check` and the editor do not run loaders.** A CMS fetch per keystroke, or per CI type check,
  is wrong: it is slow, needs secrets and makes a check depend on the network. They type every
  expression from the loader's declared type. What needs values (link checking, a slug field that is
  missing, the `order` key's type) is checked by the build. The exception is `files()`, which reads only
  the repository: `check` and the editor read the files, cheaply, so a frontmatter field the type does
  not have, or a broken link to a sibling post, shows in the editor.

### 7. Build-time or request-time

Two ways to have a page per entry, both supported, documented side by side:

| | `data-sn-each` (this proposal) | A pattern page with `embed` |
| --- | --- | --- |
| Files | one per entry | one |
| Data | at build time | at request time, from the API |
| A content change | a rebuild (a CMS webhook to the CI) | live |
| Server | any static host | sinter's server layer |
| JavaScript | none, unless something runs | the runtime, for the data |
| Sitemap | automatic | `sitemap.paths` |
| Broken links | build errors | not checked |

The rule of thumb in the docs: content edited by people (posts, docs, product pages) is a collection;
data that changes on its own (prices, stock, comments) is a resource. A page can be both.

## Diagnostics

New codes (numbers assigned at implementation, in the ranges of the neighbours):

| Code | When |
| --- | --- |
| collection-load | a loader throws, returns a non-list, or non-plain data (with the export and, for `files()`, the file) |
| duplicate-slug | two entries of a collection fill a `data-sn-each` pattern with the same URL |
| each-param | an entry has no usable value for a `:param` of the page's pattern |
| each-path | `data-sn-each` without a parameterized `data-sn-path`, or with a fixed path beside it (except over `pages()`) |
| url-param-each | `$url.<param>` on a `data-sn-each` page, where the value is the entry's field |
| broken-link | a link in the built HTML under a `data-sn-each` pattern that no entry was written at |

SN332 grows: an unknown collection in `content:`, an attribute a `content:` resource does not take.
SN504: an untyped collection. SN329: an API named `content`.

## Testing

- **Unit**: `files()` (globs, slugs at depth, frontmatter, the failsafe YAML schema, drafts, JSON that is
  not an object, symlinks out of the root), loader validation (non-list, `Date`, a throw), `pages()`.
- **Compiler**: `content:` resources as `file:` ones (the same suite, parameterized over the scheme),
  `order` at build time, `data-sn-each` constants in the head, a layout and components, SN codes above.
- **Build** (the fixture pattern of `test/static-*`): a blog of three posts, an index and a tag page,
  asserting the files, that they ship no JavaScript, the sitemap, the canonical links, no `_redirects`
  rule for the patterns, a broken link failing the build; with `localePrefix`; with a live resource on a
  generated page (the runtime ships, the embedded post does not).
- **Dev** (e2e): editing a markdown file reloads its page and the index; adding one serves its new URL.
- **The static-site example** gains a blog from `content/posts/*.md` with sinter-markdown, the
  showcase of the feature.

## Plan

Three pull requests, each followed by a review of where it departed from this text:

- **A, collections**: the content module (§1), `files()` (§2), `content:` resources (§3), their types
  and dev reload (§5, §6 for resources). Useful alone: an index over a folder.
- **B, a page per entry**: `data-sn-each` (§4) on the per-language inputs, the sitemap, canonical links
  and redirects for it, dev serving, `pages()`.
- **C, links**: the broken-link check (§5), and the docs: a guide `docs/content.md`, the static-site
  example's blog, `resources.md` and `static-pages.md` pointing to it, `llms.txt`, CHANGELOG.

## Open questions

- **Pruning embedded collections.** A page whose browser code reads `posts` embeds the whole collection,
  `body` included. The compiler knows which fields browser code reads when every read is a static
  member access; it could embed only those, and fall back to the whole list otherwise. Worth it in the
  first version, or after a site needs it?
- **Shared embedded data.** Ten thousand post pages that each embed the same tag list repeat it ten
  thousand times. A collection as a hashed JSON asset, fetched with `preload`, would be cached once, at
  the cost of a request in the first frame. Probably future work; embedding is the right default for a
  first paint.
- **`data-sn-each` on `<html>` or in the content module.** The alternative is the content module naming
  the page (`export const posts = files(…).pages('blog/post.html')`), Astro's `getStaticPaths` turned
  around. The attribute keeps the page's URLs and data visible in the page, as `data-sn-path` does; the
  module keeps pages free of build concepts. This proposal picks the attribute.
- **Rest parameters.** `:slug*` is new syntax in `data-sn-path`; it also helps API-backed pattern pages.
  It could be split out and land first.

## Future work

- **Markdown links between entries**: `[next](./other.md)` in a `files()` collection written as the
  other entry's URL, when exactly one `data-sn-each` page uses the collection.
- **Content as an asset** (see Open questions), and incremental builds that rebuild only the entries a
  changed file touches.
- **Images from a CMS** through the build's image pipeline: today a remote image URL is written as
  given; a collection could declare image fields to download and optimize at build time.
- **Loaders for common CMSs** as separate packages, with their types, built on the plain-function
  contract.
