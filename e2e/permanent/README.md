# Permanent elements e2e: kept across links, in three browsers

`data-sn-permanent` in Chromium, Firefox and WebKit (Playwright; a browser that is not installed is
reported as skipped). Two pages share a layout ([`src/layouts/two-layout.html`](src/layouts/two-layout.html))
whose head binds: a `<title data-sn-text>`, a description `<meta data-sn-attr>`, and the page's head
slot. Page B ([`b.html`](b.html)) also puts its own stylesheet and a `data-sn-if` meta in the head, so
both pages' heads and bodies use the same `data-sn` ids. The kept element is a notes field and a
scrolled box.

The steps, in each browser:

1. A loads; notes are typed, the box scrolled, A's counter clicked.
2. **The link to B swaps:** one page load in total, the same kept element with its text and scroll
   position, B's title, description, `robots` meta and stylesheet, its list and a working counter,
   no `data-sn` id twice in the document.
3. **Back to A and Forward to B** do the same; B's stylesheet and meta leave with B.
4. **The last click wins:** a click on the link to A, then at once on the link to the page shown, is
   the browser's: B is loaded.
5. **A page without the element** (a 404 here) is loaded.

```sh
npm install
node run.mjs            # or: node run.mjs firefox webkit
```

Firefox and WebKit: `npx playwright install firefox webkit` (and `npx playwright install-deps` on Linux).
