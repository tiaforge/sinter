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

`bench/static/measure.mjs` builds this site and measures it in Chromium.
