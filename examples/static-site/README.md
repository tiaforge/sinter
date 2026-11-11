# A static site with sinter

Four pages that share one layout (`src/layouts/site-layout.html`): a head component for the SEO
tags, a header whose nav is a list of links given as a constant prop, a feature grid from a
constant list, and a footer. Three pages have nothing to run and ship no JavaScript; `status.html`
loads data and keeps sinter's runtime. See [docs/static-pages.md](../../docs/static-pages.md).

```sh
npm install            # in the repo root first: npm run build
npm run build          # prints, per page, "no JavaScript" or what runs and where
npm run preview        # http://localhost:4174
```

`vite.config.js` lists the static pages in `sinter({ static })`, so a handler added to the shared
header or footer fails the build instead of putting JavaScript back on every page.

Each page is written as a directory's index (`about.html` as `about/index.html`, at `/about/`), so the
built site works on any static server; the nav's links, written as `/about.html`, name `/about/` in the
build. See [page URLs](../../docs/static-pages.md#page-urls).

`bench/static/measure.mjs` builds this site and measures it in Chromium; `bench/static/urls.mjs` checks its
URLs on a static server with no configuration.
