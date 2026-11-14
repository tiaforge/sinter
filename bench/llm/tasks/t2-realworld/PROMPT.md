This directory is a RealWorld ("Conduit") app built with {{FRAMEWORK}}, talking to the API at
https://api.realworld.show/api. Add two features to the article page (`/article/<slug>`), in the style
the project already uses. Keep everything else working as it does now.

1. **Table of contents.** Above the article body, a `<nav class="article-toc">` with one link per `#` or
   `##` heading of the article's Markdown body, in order. Each link's text is the heading's text and its
   `href` is `#<id>`, where the heading element in the rendered body has that `id`: the heading text in
   lower case, with each run of characters other than a-z and 0-9 replaced by one `-`, and no `-` at
   either end ("Part 2: Details" → `part-2-details`). An article without such headings has no
   `nav.article-toc`.
2. **Related articles.** Between the article and the comments, a `<section class="related-articles">`
   with an `<h3>` reading `More on <tag>` (the article's first tag), listing up to 3 other articles with
   that tag, newest first, as `<a class="related-link" href="/article/<slug>">` with the article's title
   as text. Get them from the API (`GET /articles?tag=<tag>&limit=4`) and leave out the article itself.
   An article without tags, or with no other article for its first tag, has no section.

## How it is checked

Automated browser tests run against the app with the API answered by a local copy (the same endpoints
and response shapes). They run, in this directory:

```sh
npm install
npm run build
npm run preview -- --port {{PORT}} --host 127.0.0.1
```

and then open http://127.0.0.1:{{PORT}}. Make sure `npm run build` still succeeds without errors.
When you are done, stop any servers you started.
