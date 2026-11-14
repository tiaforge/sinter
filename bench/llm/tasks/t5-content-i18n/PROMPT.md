Build a bilingual blog, "Field Notes", with {{FRAMEWORK}} in this directory. Start from an empty project:
set it up yourself, the way the framework recommends.

The posts are the Markdown files in `content/en/` (English) and `content/de/` (German); do not change
them. Each has front matter with `title`, `date` (YYYY-MM-DD), `description`, `tags`, and sometimes
`series` and `part` (a numbered series), or `draft: true`. A post's slug is its file name without `.md`; a
German file with the same slug as an English one is its translation. Drafts are never published: no page,
not listed, not linked, not in a feed or the sitemap. The site's URL is `https://fieldnotes.example`.

## Pages, for each language `<lang>` (`en`, `de`)

- **`/<lang>/`**: the language's published posts, newest first, **2 per page**: `/<lang>/` is page 1,
  `/<lang>/page/2/` page 2, and so on, with no empty page. Each post is an `<article data-testid="post">`
  with its title as a link to `/<lang>/posts/<slug>/`, its date in `<time datetime="YYYY-MM-DD">` and its
  description. Pages link to each other with `<a rel="prev">` and `<a rel="next">` (only where that page
  exists).
- **`/<lang>/posts/<slug>/`**: an `<h1>` with the title, the date in `<time datetime="YYYY-MM-DD">`, the
  Markdown rendered as HTML, and the reading time in `data-testid="reading-time"`.
  - **Dates** are written out in the page's language: `March 14, 2026` in English, `14. März 2026` in
    German. This applies to the lists too.
  - **Reading time**: the number of words in the Markdown body (everything after the front matter,
    split on whitespace), divided by 200 and rounded up, at least 1. Written `4 min read` in English
    and `4 Min. Lesezeit` in German.
  - **Series**: a post in a series has a `<nav data-testid="series">` that reads `Part <n> of <total>`
    in English and `Teil <n> von <total>` in German. `<total>` counts that language's published parts.
    It links the previous and next part in the same language with `<a rel="prev">` and `<a rel="next">`
    (only where that part exists). No other `rel="prev"` or `rel="next"` links are on a post page.
- **`/<lang>/rss.xml`**: an RSS 2.0 feed of that language's published posts, newest first, with
  `<language>en</language>` or `<language>de</language>`, and per post `<title>`, an absolute `<link>`,
  `<pubDate>` and `<description>`.

## Every page

- `<html lang="en">` or `<html lang="de">`, a `<title>` (`<post title> | Field Notes` on post pages), and a
  header with a link to its language's home (`/<lang>/`).
- **A language switcher.** A link with `hreflang` set to the other language, pointing to the same page in
  that language: the translation of a post if it exists, otherwise that language's home. On index pages
  it points to the other language's home.
- **Alternates.** Post pages whose translation exists have `<link rel="alternate" hreflang="…" href="…">`
  for both languages, with absolute URLs. Posts without a translation have none.

## Also

- **`/`** shows the English home or sends the browser to `/en/`; it must work without JavaScript.
- **`/sitemap.xml`**: every published page with its absolute URL in a `<loc>`: both homes, every further
  index page, and every published post in each language. Nothing that does not exist.
- The site must work with JavaScript turned off, and no page may load any JavaScript (no `<script>`
  elements).

## How it is checked

Automated tests run against your site, with JavaScript disabled in the browser. They run, in this
directory:

```sh
npm install
npm run build
npm run preview -- --port {{PORT}} --host 127.0.0.1
```

and then open http://127.0.0.1:{{PORT}}. Make sure these three commands work and that `npm run build`
succeeds without errors. Styling is up to you and not graded; keep it readable.
When you are done, stop any servers you started.
