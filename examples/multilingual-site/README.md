# A site in two languages with sinter

The pages of `../static-site`, in English and German: `sinter({ localePrefix: true })` builds each page once
per language of `project.inlang`, under its prefix (`/en/about/`, `/de/about/`), with that language's text in
the HTML. Three pages ship no JavaScript in either language; `status.html` loads data and records the
visitor's language in a cookie. `/`, `/about/` and the other unprefixed URLs are language choosers. See
[languages](../../docs/static-pages.md#languages).

```sh
npm install            # in the repo root first: npm run build
npm run build          # dist/en/…, dist/de/…, the choosers, _redirects
npm run preview        # http://localhost:4175
```

`bench/static/locales.mjs` builds this site and checks it on a static server and in Chromium.
