# Swaps e2e: pages swapped in, elements kept, in three browsers

`sinter({ swap: true })` and `data-sn-permanent` in Chromium, Firefox and WebKit (Playwright; under CI a
browser that does not start fails the run). Two pages share a layout
([`src/layouts/two-layout.html`](src/layouts/two-layout.html)) whose head binds: a `<title data-sn-text>`, a
description `<meta data-sn-attr>`, and the page's head slot. Page B ([`b.html`](b.html)) also puts its own
stylesheet and a `data-sn-if` meta in the head, so both pages' heads and bodies use the same `data-sn` ids,
and has a `<noscript>` image. [`plain.html`](plain.html) binds nothing but keeps the element;
[`off.html`](off.html) opts out with `<html data-sn-swap="off">`. The kept element is a notes field and a
scrolled box.

What `run.mjs` checks, in each browser: one page load in total across links, Back, Forward and
`navigate()`; the same kept element with its text and scroll position; title, metas and stylesheets after
each move; no `data-sn` id twice; each page working; `sn-page` after each swap; the new title announced;
`<noscript>` left inert; the last of two clicks wins; a link with `data-sn-swap="off"`, a page with it, and
a 404 are page loads; each entry's scroll position on Back and Forward and after reloads; a link's `#hash`;
a click during the transition and while the page is fetched; a traversal that cannot swap; Back after a
swapped Back; a GET form and `rel="external"`; the transition with the stylesheet's rule and none under
reduced motion.

```sh
npm ci
node run.mjs            # or: node run.mjs firefox webkit
```

Firefox and WebKit: `npx playwright install firefox webkit` (and `npx playwright install-deps` on Linux).
[`navigation-api/`](navigation-api/) holds the probes of the browsers' Navigation API the design rests on.
