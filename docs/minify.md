# Minified HTML

Production builds minify every page's HTML: your comments are removed, and so is the white space that renders
nothing. The page looks the same at every viewport width; it is smaller. Dev never minifies.

```js
sinter({ minifyHtml: false }) // keep the HTML as written
```

The JavaScript is minified by Vite as usual (`build.minify`, which sinter's early files follow too). Neither
the HTML nor the JavaScript is compressed by the build: gzip or brotli is the server's or the host's job.

## What it saves

The example apps, all pages, before and after:

| Example | gzip | brotli | What goes |
| --- | ---: | ---: | --- |
| dashboard | −30% | −30% | comments and white space |
| RealWorld | −16% | −15% | comments only (it loads a stylesheet from another origin, see below) |
| static site | −2% | −2.5% | comments and white space |
| multilingual site | −1% | −1% | comments and white space |

Comments are most of it: a page explained in comments ships them to every visitor otherwise. White space alone is
a few percent after compression.

Each example's pages were compared with and without minifying, in Chromium, Firefox and WebKit, at 390 and
1280 px wide: the screenshots are identical pixel for pixel, and so are the position and size of every element
and line of text.

## Why sinter minifies, and not another tool

A generic HTML minifier breaks sinter's pages:

- Lists and branches are marked by comments (`<!--sn 4-->…<!--/sn-->`), and a text binding beside other text by
  an empty one (`<!---->`). Stripping comments breaks them (dev builds warn, codes 2 and 31).
- In a build, the place of the head scripts is a comment in the head (`<!--sn-head-…-->`), which sinter's last HTML
  step replaces with them: it never reaches the output. A plugin that removes it from the page (in its
  `transformIndexHtml`, which runs before that step whatever its order) fails the build.
- The runtime finds the nodes it binds in a row by counting siblings, white space included. A minifier that
  drops white space between `</li>` and `<li>`, or around `<b>`, inside the head templates moves every binding
  after it.
- It does not know your CSS, so it either keeps white space or drops some that shows: the gap between two
  `inline-block` links is a space in the HTML.

sinter minifies before it compiles the page, so its own comments are written afterwards and every count is made
on the minified markup. Keep any minifier or CDN optimizer of yours off sinter's pages: there is nothing left
for it to do, and it can only break them.

## The rules

- **Comments.** Yours are removed, in the page, its layout and components, and in templates. Comments of the
  forms sinter reserves are left, and are still an error (`SN105`).
- **Runs of white space** become one character: a newline when the run had one (a browser may drop a line break
  between two East Asian letters, but not a space), else a space.
- **White space that starts or ends a line** is removed: beside a block-level box in normal flow; at the edges of
  a block when no `::before` or `::after` with content can appear there and no list marker is inside its lines;
  and in flex and grid containers and the table boxes that hold rows and cells, between items, where white space
  alone renders nothing. A list or branch whose rows are block boxes counts as one, or as nothing when empty.
- **An element whose only content was white space** keeps one character, so `:empty` does not start matching.

Each of these is decided from your stylesheets' cascade, as for [reserved space](first-paint.md): the
display and `white-space` an element has at every viewport width between the stylesheets' breakpoints. When a
value cannot be decided (a state such as `:hover`, a media feature other than width, a class or style a
binding sets, `data-sn-show`), the white space is kept.

Left as written:

- `<pre>`, `<textarea>`, `<script>`, `<style>`, `<title>` and the other raw-text elements; text with
  `white-space: pre`, `pre-wrap`, `pre-line` or `break-spaces`; editable content (`contenteditable`);
- an element whose content a binding writes (`data-sn-text`, a `data-sn-with` of `innerHTML`/`textContent`);
- markup a component's scoped `<style>` reaches (the cascade is read from the page's stylesheets);
- SVG and MathML;
- your own `<template>`s (a script may read them as written);
- attribute values, and inline scripts and styles.

## Pages the build cannot judge

A page that loads a stylesheet from another origin (an icon font's CSS from a CDN) keeps all its white space:
the build cannot read that stylesheet, and an icon font sets `::before` content. Its comments are still removed.
Google Fonts' stylesheets do not count: they hold only `@font-face` rules, and the build downloads them
([fonts](configuration.md)).

A script of yours that changes classes or styles at run time, or reads `textContent` and expects the white space
as written, is not seen. Turn minifying off for such an app with `minifyHtml: false`.

## Testing

`render()` in `@tiaforge-ui/sinter/testing` does not minify, so a test sees the page as written. `render(html,
{ minifyHtml: true, css })` renders it as a build would, minified against `css`.
