# Layouts

A layout is the document every page shares: the head (charset, fonts, stylesheets, scripts, SEO
tags) and the frame of the body (a header, a footer). A page that uses it is only the layout's tag,
and its content fills the layout's slots, in the head and in the body.

```html
<!-- src/layouts/site-layout.html -->
<!doctype html>
<html lang="en" data-sn-layout="{ title?: string; description?: string; nav: string }">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <seo-tags data-sn-prop="{ title, description }">
    <slot name="seo" slot="extra"></slot>
  </seo-tags>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700">
  <link rel="stylesheet" href="./site.css">
  <script type="module" src="./main.ts"></script>
  <slot name="head"></slot>
</head>
<body>
  <site-header data-sn-prop="{ nav }"></site-header>
  <main><slot></slot></main>
  <footer><slot name="footer">© 2026 My Blog</slot></footer>
</body>
</html>
```

```html
<!-- post.html: the whole page -->
<site-layout data-sn-path="/post/:slug"
  data-sn-prop="{ nav: 'post', title: post?.title, description: post?.summary }">
  <sn-resource name="post" src="/api/posts/{$url.slug}" items="post"></sn-resource>
  <meta slot="seo" property="og:type" content="article">
  <link slot="head" rel="stylesheet" href="./post.css">

  <template data-sn-if="post">
    <article><h1 data-sn-text="post.title"></h1></article>
  </template>
</site-layout>
```

The build merges the two into one ordinary document before anything else reads the page. The early
scripts, the fetch preloads, embedded data, the Google Fonts rewrite and Vite's bundling of the
layout's script and stylesheets all work on the merged document as they do on a page written by
hand. Nothing of the layout is left at run time.

## The layout file

- A file in `src/layouts/`. Its name is its tag and contains a `-`, like a component's
  (`site-layout.html` is `<site-layout>`). A layout and a component with the same name is an error.
- A whole document: an optional doctype, `<html>`, `<head>` and `<body>`. Comments before `<html>`
  document the file and are left out of the pages.
- `data-sn-layout` on `<html>` declares its props, a TypeScript type literal as for a component
  (the names of `src/sinter.types.ts` and the OpenAPI schemas work). `data-sn-layout=""` takes none.
  A layout emits no events and has no script; the components it uses may have both.
- Slots are `<slot>` elements, named, in the head or the body, with fallback content for a page that
  leaves them empty. The default slot is in the body: it takes the page's content without `slot`.
- The layout uses components in its body and head components in its head, declares resources and
  state, and binds like a page. Its markup sees its props, its own state, the page's resources and
  the globals (`$url`, helpers, messages), not the page's state.
- Relative URLs of the layout's own `<link href>`, `<script src>`, `<img src>`, `srcset` and the like
  are relative to the layout file; a page in a subfolder gets the same file.
- A layout is not a page: leave `src/layouts/` out of the build's inputs.

## The page

- A page that uses a layout is its tag, at the top level, and nothing else (a doctype and comments
  may be around it). Anything else is `SN319`.
- The tag's children fill the slots: `slot="seo"` goes into `<slot name="seo">`, the rest into the
  default slot. A head element (`<title>`, `<meta>`, `<link>`, `<base>`) needs a head slot: given to
  the body, it is `SN320`. A slot takes every child that names it, in order.
- `data-sn-prop` passes the layout's props, evaluated in the page's scope: they can read the page's
  resources.
- `data-sn-state` on the tag is the page's state. The props and all the content the page passes in
  see it, in the head and the body; the layout's markup does not.

  ```html
  <site-layout data-sn-state="{ tab: 'all' }" data-sn-prop="{ nav: 'home', title: tab == 'all' ? 'All' : 'Mine' }">
  ```

- The tag's attributes go onto `<html>`. A plain one (`lang`, `dir`, `data-theme`) replaces the
  layout's, which is its default; `class` is joined. `data-sn-path`, `data-sn-prefetch`, handlers and
  `data-sn-class`, `-attr`, `-style` go onto `<html>` in the page's scope. A handler there hears every
  event that bubbles up the page: `data-sn-on-sn-error` handles the page's failed requests.

## Head components

A head component holds head elements, any number of them, inlined where its tag is in a head:

```html
<!-- src/components/seo-tags.html -->
<template data-sn-head="{ title?: string; description?: string }">
  <title data-sn-text="title ? title + ' · My Blog' : 'My Blog'">My Blog</title>
  <meta name="description" content="Notes on the web." data-sn-attr="{ content: description ?? 'Notes on the web.' }">
  <meta property="og:title" content="My Blog" data-sn-attr="{ content: title ?? 'My Blog' }">
  <slot name="extra"></slot>
</template>
```

It is declared with `data-sn-head` instead of `data-sn-component` and used in a head: a layout's, a
page's, or a head slot's content. See [components](components.md#head-components).

## Values and markup into the head

- **Values** go as props: the page gives `title: post?.title` to the layout, the layout gives
  `title` to `seo-tags`, which binds it. `sinter check` types every step.
- **Markup** goes through slots. A slot in the layout that is slot content of a component's tag
  forwards what fills it: `<seo-tags><slot name="seo" slot="extra"></slot></seo-tags>` puts the
  page's `slot="seo"` elements into `seo-tags`'s `extra` slot, in the page's scope.

### What binds in a head

- `<title data-sn-text>`.
- `data-sn-attr="{ content: … }"` on a `<meta>` with a literal `name`, `property` or `itemprop`.
  Nothing else of a meta binds, and nothing on `http-equiv`, `charset`, `<link>`, `<base>`,
  `<script>` or `<style>` (`SN207`).
- `<template data-sn-if>` and `data-sn-for` over head elements: an `og:image` only when there is one.

A head has one `<title>`, one `<base>`, one `<meta charset>`, one `<link rel="canonical">`, and one
`<meta>` with `name` `viewport`, `description` or `robots`, or `property` `og:title`,
`og:description`, `og:url`, `og:type`, `twitter:card`, `twitter:title` or `twitter:description`. A
second one in the merged head is `SN321`.

### What a crawler sees

A constant (`title: 'About'`) is written into the HTML at build time: every crawler and link preview
sees it. What the early script knows (helpers, messages, persisted values, embedded data) renders
as the head is parsed. A value from a request renders when the response arrives. Google renders
JavaScript and sees it; scrapers that run no script (most link previews: Slack, iMessage, X,
Facebook) see the element's literal content, so write a good fallback into it:
`<title data-sn-text="…">My Blog</title>`.

## In the editor

`sinter lsp` completes `slot="…"` with the slots of the tag the element is in (a layout's head slots
on a head element, its body slots on the rest), completes tags after `<` (layouts at the top of an
empty page, head components in a head, components elsewhere), goes from a `slot="…"` value to its
`<slot>` and from a layout's tag to its file, and shows a tag's props and slots on hover. A layout
no page uses yet is checked on its own. See [editors](editors.md).

## Types

`src/sinter.components.d.ts` lists the layouts as `LayoutName` and their props as `LayoutProps`.
`sinter check` checks the props at the page's tag and the layout's markup through every page that
uses it; an error in the layout is reported in the layout's file, followed by the page.

## Limits

- One layout per page, chosen by the page; a layout does not use another layout.
- A layout is decided at build time; data cannot change it.
- Values from data are not in the HTML for scrapers that run no script.

The design and its decisions: [the proposal](proposals/layouts.md).
