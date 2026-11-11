# Proposal: layouts

Status: implemented (2026-11-11), steps 1 to 7 of the [Plan](#plan); the guide is
[layouts.md](../layouts.md). The choices in [Decisions](#decisions) were settled with the maintainer
while drafting; [Open questions](#open-questions) lists what is still open, and
[Deviations](#deviations) where the implementation departs from this text.

Components cannot hold a page's `<html>` or `<head>`: a component is a `<template>`, and inside a
`<template>` the HTML parser drops `<html>`, `<head>` and `<body>` tags (a `<template
data-sn-component>` around a whole document fails with `SN312`, two roots). Every page therefore
repeats its head (charset, viewport, fonts, stylesheets, scripts, the SEO tags) and wraps its body in
the same header and footer components, as the RealWorld example does on all of its pages.

A **layout** is a whole document with slots. A page that uses one is only the layout's tag; its
children fill the layout's slots, in the head and in the body. The compiler merges the two into one
document **before anything else reads the page**, so everything sinter and Vite do with a head (the
early scripts, preloads, embedded data, Google Fonts, bundled scripts and stylesheets) works on the
merged document exactly as it does on a hand-written one.

## An example

```html
<!-- src/layouts/site-layout.html -->
<!doctype html>
<html lang="en" data-sn-layout="{ title?: string; description?: string; nav: Nav }">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <seo-tags data-sn-prop="{ title, description }">
    <slot name="seo" slot="extra"></slot>
  </seo-tags>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700">
  <link rel="stylesheet" href="./styles/site.css">
  <script type="module" src="./main.ts"></script>
  <slot name="head"></slot>
</head>
<body>
  <sn-resource cache name="user" src="/api/user" items="user" early="off"></sn-resource>
  <site-header data-sn-prop="{ nav, user }"></site-header>
  <main><slot></slot></main>
  <site-footer><slot name="footer"></slot></site-footer>
</body>
</html>
```

```html
<!-- src/components/seo-tags.html: a head component -->
<template data-sn-head="{ title?: string; description?: string }">
  <title data-sn-text="title ? title + ' — Conduit' : 'Conduit'">Conduit</title>
  <meta name="description" content="A place to share your knowledge."
        data-sn-attr="{ content: description ?? 'A place to share your knowledge.' }">
  <meta property="og:title" content="Conduit" data-sn-attr="{ content: title ?? 'Conduit' }">
  <slot name="extra"></slot>
</template>
```

```html
<!-- article.html: the whole page -->
<site-layout lang="en" data-sn-path="/article/:slug"
  data-sn-prop="{ nav: 'article', title: article?.title, description: article?.description }">
  <sn-resource name="article" src="/api/articles/{$url.slug}" items="article"></sn-resource>
  <meta slot="seo" property="og:type" content="article">
  <link slot="head" rel="stylesheet" href="./styles/article.css">

  <template data-sn-if="article">
    <article>
      <h1 data-sn-text="article.title"></h1>
      …
    </article>
  </template>
</site-layout>
```

The built `article.html` is one ordinary document: the layout's `<html>` with `lang` and
`data-sn-path` from the tag; a head with the early scripts first, then the charset and viewport, the
`<title>` and `<meta>` tags of `seo-tags` (with `og:type` from the page where its `extra` slot was), the
bundled font CSS, the hashed stylesheets and script, the fetch preload of `article`, and the page's
own stylesheet; and a body with the header, the article in `<main>`, and the footer. Nothing of the
layout is left at run time: like a component, it costs nothing.

## Design

### Three kinds, each with its own declaration

What a file is, and where it can be used, is written in its declaration: the one attribute that holds
its props type. Nothing is inferred from the file's contents or its folder.

| Kind | Declaration | Holds | Used |
| --- | --- | --- | --- |
| Component | `<template data-sn-component="{ … }">` in `src/components/` | one root element | in a body, as often as needed |
| Head component | `<template data-sn-head="{ … }">` in `src/components/` | any number of head elements | in a head or a head slot, as often as needed |
| Layout | `<html data-sn-layout="{ … }">` in `src/layouts/` | a whole document | as a page's only tag |

- The three take the same props type syntax, and `data-sn-prop`, `SN313`, the types and the LSP work the
  same for all three. Only the placement rules differ, and the errors about them name the kind.
- A file with none of them, or with two, is an error (`SN312` in `src/components/`, `SN318` in
  `src/layouts/`). A declaration in the wrong folder is an error that names the right one.
- A wrong kind is caught with its fix: two `<meta>`s in a `data-sn-component` are `SN312` with the hint
  "head elements: declare it with `data-sn-head`"; a `<div>` in a `data-sn-head` is `SN320`.

### The layout file

- A layout is an HTML file in `src/layouts/`. Its file name is its tag, and contains a `-`, as a
  component's does (`site-layout.html` is `<site-layout>`). A layout and a component with the same
  name is an error.
- It is a whole document: an optional doctype, then `<html>`, `<head>` and `<body>`.
- `data-sn-layout` on its `<html>` marks the file and declares its props, as `data-sn-component` does
  for a component (TypeScript, with the names `src/sinter.types.ts` exports and the OpenAPI schemas).
  `data-sn-layout=""` takes no props. There is no `data-sn-emits`: nothing is above a layout to
  receive an event.
- Slots are `<slot>` elements, named or not, in the head or the body. A slot's children are its
  fallback, used when the page leaves it empty: `<slot name="title"><title>Conduit</title></slot>`.
  Two slots with the same name are an error.
- The layout may use components in its body (`<site-header>`) and head components in its head
  (`<seo-tags>`), declare resources and state, and use every binding a page can. Its markup sees its
  props, its own state, its own resources and the globals (`$url`, helpers, messages), and none of the
  page's state: the same rule as for a component, with the same error naming the prop to add.
- A layout has no script beside it (`site-layout.ts`). Its components may have scripts.
- A layout is not a page: a file in `src/layouts/` listed as a Vite input (a glob over every `.html`)
  is an error that names it.

### The page

- A page that uses a layout is its tag, at the top level, and nothing else: no `<head>`, no other
  element before or after it (a doctype and comments are allowed). Anything else is an error
  (`SN319`). A page without a layout tag is an ordinary page, as today.
- The tag's children fill the slots, as for a component: `slot="seo"` goes into `<slot name="seo">`,
  the rest into the default `<slot>`. A slot name the layout does not have is `SN314`.
- A slot takes every child that names it, in the order they are written: two `<meta slot="seo">` both
  go into `seo`. A `<template data-sn-if>` or `data-sn-for` with a `slot` attribute goes into that slot
  as one piece. The `slot` attribute is not in the output.
- `data-sn-prop` passes the layout's props (`SN313` for an unknown or a missing one), and props are
  evaluated in the page's scope, so they can read the page's resources: `title: article?.title`.
- **The page's scope.** The slot content and the props see the page's resources (declared anywhere in
  the slot content), the globals, and the state of a `data-sn-state` on the tag. That state is the
  page's top-level state, shared by everything the page passes in, in the head and in the body:

  ```html
  <site-layout data-sn-state="{ tab: 'all' }" data-sn-prop="{ title: tab == 'all' ? 'All' : 'Mine' }">
  ```

  It is placed on `<html>` in the output, and the layout's markup does not see it.
- **Attributes on the tag go onto `<html>`.** `lang`, `dir`, `data-sn-path`, `class` and the like are
  written on the tag. Unlike a component, an attribute on the tag *replaces* the layout's value instead
  of being an error: the layout's attributes on `<html>` are its defaults (`lang="en"`, overridden by a
  German page). `class` is joined. Handlers (`data-sn-on-*`) on the tag are the page's `<body>`
  handlers: they go onto the layout's `<body>` in the page's scope, ahead of its own, for DOM events
  and sinter's `sn-error` and `dismiss` (`SN315` otherwise).
- A layout tag inside a component, inside another layout, or below the top level of a page is an
  error. So is `<sn-component use>` naming a layout, and `data-sn-early` on a layout tag (a layout is
  the whole page; leave its parts out of the early script on their own tags).

### The merge

The merge runs first, before any other HTML transform of the build or the dev server:

1. Parse the page. If its only top-level element is a layout tag, parse the layout.
2. Expand the layout like a component: the slots are filled with the tag's children (or keep their
   fallback), the props are bound, the tag's attributes and state go onto `<html>`.
3. Rewrite the layout's relative URLs (below).
4. Hand the merged document on. From here on it is a page like any other: components are expanded,
   bindings compiled, and the head gets what it gets today.

Because the merged document is what the rest of the pipeline sees, these need no change:

| Feature | Why it works |
| --- | --- |
| Early scripts (`sinter-head`, `<page>-head`) | inserted first in the merged head |
| Fetch preloads, preconnects, embedded-data slots | computed from the resources of the merged document, placed in its head |
| Google Fonts inlining and font preloads | the link is in the merged head when `sinter:fonts` reads it |
| `<script type="module">`, stylesheets, `<link rel="icon">` | Vite's HTML build runs after the `'pre'` transforms: it bundles and hashes them per page |
| Speculation Rules, CSP hashes | added to the merged document |
| `data-sn-path`, navigation, transitions | the attribute is on `<html>` in the output |
| Image sizes from the stylesheets | the stylesheets are the merged head's |

In the Vite plugin, the merge is its own plugin placed before `sinter:fonts` and the page compiler,
both of which are `transformIndexHtml` handlers with `order: 'pre'` today: the fonts plugin reads the
head's links, so it must see the layout's.

**Relative URLs.** A relative `src` or `href` in a layout (`./main.ts`, `styles/site.css`) is written
relative to the layout file and rewritten to a root-relative one (`/src/layouts/main.ts`), so a page in
a subfolder gets the same file. Root-relative and absolute URLs are left as written, and Vite's `base`
applies as usual. Relative URLs in slot content stay relative to the page, as they are written there.

**Dev server.** A change to a layout, or to a component it uses, reloads every page that uses it
(the files are watched per page, as component files are today).

### Parsing the head

The standard parser ends the head at the first element it does not know in a head: `<seo-tags>` and
`<slot>` would close the head, and what follows (the title, the stylesheets) would be in the body.
Measured on the current build: a component tag in the head moves itself and every later head element
into the body, without an error.

So sinter parses the **contents of the head** of a page and of a layout as template content, where any
element stays where it is written; the rest of the document is parsed as before. The output is still
plain HTML: after expansion, only head elements are left in the head. An element in the head that
does not end up as head content after expansion (a `<div>`, a body component) is an error (`SN320`),
so the browser never sees a head it would parse differently. Positions stay those of the source file.

This applies to every page, with or without a layout: a head component can be used in a plain page's
head too.

### Head components

A head component is declared with `data-sn-head` instead of `data-sn-component`. It holds any number
of head elements, inlined at the use, with no wrapper:

```html
<template data-sn-head="{ title: string }">
  <title data-sn-text="title"></title>
  <meta property="og:title" data-sn-attr="{ content: title }">
</template>
```

- `data-sn-head` takes the props type as `data-sn-component` does, and `data-sn-emits` too (an event
  from a head element is rare, but nothing forbids it).
- Head content is `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, other
  head components, `<slot>`s, and `<template data-sn-if>` / `<template data-sn-for>` over head content.
  A `<style>` *inside* the component's `<template>` is a head element; the scoped `<style>` stays the
  one beside the `<template>` in the file.
- Anything else in a `data-sn-head` is `SN320`, naming the element.
- It is used in a head, a layout's or a page's, and in a head slot's content. Used in a body, it is
  `SN320`, saying that a head component goes in a head.
- Its tag takes `data-sn-prop` and slot content, nothing else: there is no root for other attributes
  to move onto. A `<style>` beside it in the file is an error, since head elements render nothing to
  scope; put the CSS in a stylesheet.
- Props, scope, slots, constants deciding `data-sn-if` at build time and the types work as for every
  component.

### Slots in the head

- A `<slot>` in the layout's head takes head content only: content of any other kind is `SN320`. The
  LSP offers only the head slots on head elements, and the body slots on the rest (below).
- Content without a `slot` attribute goes to the default slot, which is a body slot (a default slot in
  the head is an error), so `<meta>` or `<link>` without `slot` is not silently placed in the body:
  head elements in the default slot are `SN320` with the head slots as the fix.
- **Forwarding.** A `<slot>` in a layout can be slot content of a component the layout uses:
  `<seo-tags><slot name="seo" slot="extra"></slot></seo-tags>`. The page's `slot="seo"` content goes
  into `seo-tags`'s `extra` slot, and keeps the page's scope. When the page leaves `seo` empty, the
  forwarded slot's fallback (or `extra`'s own) is used. This works for body slots and components
  too.

### Head bindings

A per-page title and description from data need bindings in the head.

- `<title>` takes `data-sn-text`, as it does today.
- `<meta>` takes `data-sn-attr` with the one key `content`, when the meta has a literal `name` or
  `property` (and `itemprop` for structured data). Today every binding on a `<meta>` is `SN207`. Still
  refused: `http-equiv` (a refresh, a CSP), `charset`, a bound `name` or `property`, and every binding on
  `<link>`, `<base>`, `<script>` and `<style>`.
- `data-sn-if` and `data-sn-for` templates over head elements work in the head (an `og:image` only
  when the article has one, one `<link rel="alternate" hreflang>` per language).
- Two `<title>`s, or two `<meta>`s with the same literal `name` or `property`, in the merged head are an
  error (`SN321`), unless they are in two branches of one `data-sn-if`/`data-sn-else`.

**What a crawler sees.** Values that are build-time constants, or that the early script knows
(`$url`, messages, helpers; see [Deviations](#deviations) for `$url`), are in the HTML or rendered as the head is parsed. A value from API data
is rendered when the data arrives: at once with embedded data, otherwise after the request. Google
renders JavaScript and sees it. Scrapers that do not run scripts (most link previews: Slack, iMessage,
X, Facebook) see the element's literal content and the constants: `<title>Conduit</title>`. The guide
will say so, and that per-article previews need the server to write the head; see
[Open questions](#open-questions).

### Types and checking

- `src/sinter.components.d.ts` gets `LayoutName` and every layout's props type, beside the
  components'. The file is written when a project has layouts, not only when a component has a
  script.
- `sinter check` checks the tag's `data-sn-prop` against `data-sn-layout`, the slot names against the
  layout's slots, the head bindings, and the layout's own markup through each page that uses it. An
  error in a layout is reported in the layout file, followed by where it is used, as for components.
- Head components are typed like other components. `ComponentName` (for `<sn-component use>`) stays the
  body components; head components are not chosen at run time.

### Editor support

The goal: writing a page against a layout is guided, with no need to open the layout file.

- **Slot names.** In `slot="…"` on a child of a layout or component tag, the LSP completes the slot
  names of that layout or component, with where each one is (head or body) and its fallback in the
  detail. On a head element it offers the head slots, on any other element the body slots. A wrong
  name is underlined as you type (`SN314`), with the did-you-mean quick fix. This is new: the LSP's
  completion today is TypeScript's, inside expressions. `"` is added to the trigger characters.
- **Props.** In `data-sn-prop="{ … }"` on the tag, TypeScript completes the prop names and types, as
  in a component's props, since the expression is checked against the declared props type.
- **Tags.** At the top level of an empty page, the LSP offers the layout tags; in a head, the head
  components; elsewhere, the body components.
- **Go to definition** from the tag to the layout file, and from a `<slot>`'s name to where pages fill
  it. **Hover** on the tag lists the props and the slots.

## Diagnostics

| Code | Name | Reported for |
| --- | --- | --- |
| `SN318` | `invalid-layout` | a file in `src/layouts/` that is not a whole document with `data-sn-layout` on `<html>`; a `data-sn-layout` outside `src/layouts/`; two slots with one name; a default slot in the head; a name shared with a component; a layout with a script |
| `SN319` | `layout-use` | a page with a layout tag and other content outside it; a layout tag below the top level, inside a component or a layout, or named by `<sn-component use>` |
| `SN320` | `head-content` | a body element in a head or a head slot; a head element in a body slot; a head component used in a body; a non-head element in a `data-sn-head`; a head component with a scoped `<style>` |
| `SN321` | `duplicate-head` | two `<title>`s, or two `<meta>`s with one `name` or `property`, in the merged head |
| `SN207` | `unsafe-sink` | changed: `content` on a `<meta name|property|itemprop>` is allowed |
| `SN312` | `invalid-component` | also: a file in `src/components/` with neither `data-sn-component` nor `data-sn-head`, or both; head elements in a `data-sn-component`, with the hint to declare it with `data-sn-head` |
| `SN313`, `SN314` | | as for components, for all three kinds |

## What others do

| | Layout | Per-page head |
| --- | --- | --- |
| Astro | a component with `<html>` and `<slot>`; named slots | props through the layout, or slots; rendered on the server |
| SvelteKit | `+layout.svelte`, nested by folder; one slot (`children`) | `<svelte:head>` in any component, hydrated |
| Next.js | `layout.tsx`, nested by folder | the `metadata` export or `generateMetadata`, on the server |
| sinter (this proposal) | a document in `src/layouts/` with any number of slots in head and body; chosen by the page's tag | props and head slots, into head components; build-time constants in the HTML, data-bound values rendered early or on arrival; on a static host |

The difference is the one components have: a layout is gone after the build, so it adds nothing to
the first frame or the runtime, and everything the head needs for a fast first paint is computed from
the merged page.

## Limits

- One layout per page, chosen by the page. No nesting (a layout using a layout) in this proposal.
- A layout cannot change by data at run time: it is decided at build time.
- Data-bound head values are not in the HTML for scrapers that do not run scripts.

## Plan

1. **Head parsing.** Parse head contents as template content, for pages and layouts, with source
   positions; `SN320` for what would not stay in a head. Plain pages build byte for byte as before
   (the golden tests).
2. **Head components.** `data-sn-head`, with any number of head elements; uses in heads; the `SN312` hint for head elements in a `data-sn-component`.
3. **Layouts and the merge.** `src/layouts/`, `data-sn-layout`, the page form (`SN319`), attributes and
   state onto `<html>`, slots in head and body with fallbacks, relative URL rewriting, the merge as the
   first transform in the Vite plugin, dev reloads, `SN318`, `SN321`.
4. **Slot forwarding** into components, for head and body slots.
5. **Head bindings.** `<meta content>` in `SN207`; `data-sn-if`/`data-sn-for` in the head; check that the
   early script renders head bindings as the head is parsed (its `MutationObserver` watches the
   document, but every early root so far is in the body), in Chromium, Firefox and WebKit.
6. **Types and editor.** `LayoutName` and props in the generated types, `sinter check` through pages,
   slot-name and tag completion, go to definition and hover in the LSP; `data-sn-head` and
   `data-sn-layout` in `html-custom-data.json` for editors' HTML completion.
7. **Docs and proof.** `docs/layouts.md`, head components in `components.md`, the crawler note in
   `first-paint.md`, the diagnostics, `llms.txt`, README and CHANGELOG. The RealWorld example moves to one layout
   with a `seo-tags` component; measured against the current build (HTML bytes per page, first paint,
   early script size), which should be level.

## Open questions

- **Nested layouts.** An admin layout inside the site layout. A layout could use another layout's tag
  around its own document's body; left out until there is a need.
- **A default layout.** `sinter({ layout: 'site-layout' })` for pages that are only body content,
  without the tag. Saves one line per page and hides where the head comes from; not proposed.
- **Head values for scrapers.** With `sinter({ embed: true })` the server already fills embedded data
  into the page. It could also fill the `<title>` and `<meta content>` that read only embedded
  resources, so link previews get the article's title. Needs a design of its own.
- **Required slots.** A slot the page must fill (`<slot name="actions" required>`), for markup that must
  be there; a required value is a required prop. Left out for now (2026-11-11).

## Deviations

Where the implementation (2026-11-11) departs from the text above, or goes further than it. The text
above is left as designed; each entry says what it said, what was built, and why. Status: *approved*
by the maintainer (kept as built), *open* (to be decided), or *fixed* (built as the text says).

### Behaviour

| Topic | The text | Built | Why | Status |
| --- | --- | --- | --- | --- |
| Relative URLs in a layout | every relative `src` or `href` is rebased to the layout's file | only the URLs of what the page loads: `href` of `<link>`, `src` of `<script>`, `<img>`, `<source>`, `<video>`, `<audio>`, `<track>`, `<input type="image">`, `srcset` and `poster`. An `<a href>` stays as written | a link's relative URL is relative to the page the browser shows, as on any page; rebasing it to `src/layouts/` would break it | approved |
| Comments around the layout's `<html>` | not covered | dropped: they document the layout file and are not copied into the pages | measured on RealWorld: the layout's leading comment made every page 230 B larger | approved |
| `SN321` | two `<title>`s, or two `<meta>`s with one `name` or `property` | a fixed list of elements a head has once: `<title>`, `<base>`, `<meta charset>`, `<link rel="canonical">`, `<meta name>` `viewport`, `description`, `robots`, `<meta property>` `og:title`, `og:description`, `og:url`, `og:type`, `twitter:card`, `twitter:title`, `twitter:description`; a `<meta media>` is not counted. It applies to every page, not only to merged heads. Templates count as the text says: the branches of one `data-sn-if`/`data-sn-else` are one, a branch's element and a top-level one are two, and one in a `data-sn-for` is one per row (a first implementation ignored templates) | `og:image`, `article:tag`, `og:locale:alternate` and `theme-color` with `media` repeat legitimately | approved (the list and every page); templates fixed |
| Parsing the head | every head is parsed as template content | as the text says: the content of every written `<head>…</head>` is parsed as template content. A first implementation did so only for a head the browser's parser would cut short, to leave other pages untouched; the maintainer chose the text's rule (no release yet to protect), and every existing test page builds as before | – | fixed |
| Head content | an element that does not end up as head content is `SN320` | as the text says, on every page; `<sn-resource>` and `<sn-sync>` are `SN320` too (they go in the body). A first implementation allowed them in a head, which had no use: a resource is page-wide wherever it is written, and its requests start in the head anyway | – | fixed |
| Slot content's scope | slot content keeps the page's scope through forwarding | slot content keeps its first caller's scope through any number of components, forwarded or not | before, content a component passed on into another component's slot took the scope of the component in between: a bug the forwarding work found | approved |
| `$url` in the head | the early script knows `$url` | as the text says, on every page: the early script renders bindings that read `$url` (its query and `data-sn-path` parameters). When this was written it did so only on pages with embedded data; it was extended for this ([first-paint.md](../first-paint.md#the-early-script)) | the URL is known as the head is parsed. RealWorld: the shared head script grows 92 B (gzip: the attribute and text writers, now used early; the URL reader was there), the home and profile head scripts 94 and 97 B; the home page's tag tab (`/tag/css`) is in the first frame | fixed |
| Handlers on the layout's tag | onto `<html>`, in the page's scope | onto the layout's `<body>` (the page's `<body>` handlers, as before layouts), ahead of its own, for DOM events, `sn-error` and `dismiss` (`SN315` otherwise). Decided with the maintainer; see [Decisions](#decisions) | page-wide shortcuts and the page's failed actions are what they are for, and both reach `<body>`. A first implementation put them on `<html>` without a name check, which the decision replaced | approved (decided) |

### Editor

| Topic | The text | Built | Why | Status |
| --- | --- | --- | --- | --- |
| Go to definition of a slot | from a `<slot>`'s name to where pages fill it | from a `slot="…"` value to the `<slot>` it names | the direction that answers "what is this slot"; the other one is a search over pages, left for later | approved |

### Proof

| Topic | The text | Built | Why | Status |
| --- | --- | --- | --- | --- |
| RealWorld's size | level with the build before layouts | HTML and head scripts level (within ±5 B gzip per page); page modules 60 to 104 B (gzip) larger ([realworld-comparison.md](../realworld-comparison.md#layouts)) | the title and description are bindings now (a constant one is written into the HTML and its binding stays, as for every prerendered binding), and the page's state is on `<html>` instead of a `<div>` | open |
| RealWorld's titles | not covered | the article and profile pages take their titles from data; scrapers that run no script see `Conduit` there, where they saw `Article — Conduit` | the example shows a title from data; a server writing the head is an [open question](#open-questions) | open |
| Every engine | head bindings checked in Chromium, Firefox and WebKit | the test runs in every engine Playwright has; locally only Chromium was installed, so Firefox and WebKit run in CI | the development machine had no Firefox or WebKit | open (CI) |

## Decisions

Settled with the maintainer on 2026-11-11:

| Question | Decision |
| --- | --- |
| How a page uses a layout | The page is only the layout's tag; its children fill the slots, and its attributes go onto `<html>`. (Rejected: pages stay full documents with `<html data-sn-layout>`.) |
| Components in the head | Head components declared with `data-sn-head` (in place of `data-sn-component`), holding any number of head elements with no wrapper. sinter parses heads so custom tags stay. (Rejected in drafts on 2026-11-11: a plain `<template>` as one wrapper root, which nested two templates; inferring the kind from the top-level elements, an implicit rule that is harder to learn and to write correctly, for people and LLMs; no components in heads.) |
| Where a layout's declaration sits | On its `<html>`: the declaration sits on the file's root element, `<template>` for a fragment, `<html>` for a document. (Rejected: `<template data-sn-layout>` around the document, since the parser drops `<html>`, `<head>` and `<body>` inside a template; sinter would need its own parser for the whole file, and editors, formatters and LLMs would read it differently from the build.) |
| How a file says its kind | One declaration attribute per kind: `data-sn-component`, `data-sn-head`, `data-sn-layout`, each holding the props type. (Rejected: one `data-sn-component` for all, with the kind from the folder and the contents.) |
| Head bindings | `<title>` text and `<meta name|property> content` bind at run time; constants are in the HTML; `http-equiv`, `charset`, `<link>`, `<base>` stay unbindable. (Rejected: build time only; title only.) |
| Handlers on the layout's tag | The page's `<body>` handlers: on the layout's `<body>`, in the page's scope, ahead of its own; DOM events, `sn-error` and `dismiss` only (`SN315`). They cover page-wide shortcuts and the page's failed actions. (Rejected: on `<html>` with no name check, a first draft of the implementation; on the page content's first element, which is not one element.) |
| Passing values to the head | Both: typed props for values, slots for markup, and slots forwarded from a layout into its components; the LSP completes slot names. (Rejected: slots only.) |

Defaults chosen while writing, open to review: an attribute on the layout tag replaces the layout's
(components make that an error); `data-sn-state` on the tag is the page's shared top-level state; the
default slot is always in the body; relative URLs in a layout are relative to the layout file.
