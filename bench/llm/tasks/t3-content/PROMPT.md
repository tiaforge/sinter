Build a small blog, "Field Notes", with {{FRAMEWORK}} in this directory. Start from an empty project:
set it up yourself, the way the framework recommends.

The posts are the Markdown files in `content/` (do not change them). Each has front matter with
`title`, `date` (YYYY-MM-DD), `description`, `tags` and sometimes `draft: true`. A post's slug is its file
name without `.md`. Drafts are never published anywhere: not listed, no page, not in the feed.

## Pages

- **`/`**: every published post, newest first. Each is an `<article data-testid="post">` with its title
  as a link to `/posts/<slug>/`, its date in `<time datetime="YYYY-MM-DD">`, and its description.
- **`/posts/<slug>/`**: an `<h1>` with the title, the date in `<time datetime="YYYY-MM-DD">`, the post's
  Markdown rendered as HTML (headings, links, bold text, code blocks as `<pre><code>`), and each of its
  tags as a link to `/tags/<tag>/`. The document `<title>` is `<post title> | Field Notes` and
  `<meta name="description">` holds the post's description.
- **`/tags/<tag>/`**: an `<h1>` containing the tag, and the published posts with that tag, newest first,
  in the same `<article data-testid="post">` form as on `/`. One page for every tag a published post
  uses.
- **`/rss.xml`**: an RSS 2.0 feed of the published posts, newest first: per post an `<item>` with
  `<title>`, `<link>` (absolute, with the site URL `https://fieldnotes.example`), `<pubDate>` and
  `<description>`.
- Every page has a header with a link to `/` and a `<title>`; the home page's is `Field Notes`.

The site is static content: it must work fully with JavaScript turned off, and the post pages must
not load any JavaScript at all (no `<script>` elements).

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
