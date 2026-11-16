# Navigation API probes

What the engines Playwright installs do with the Navigation API, for step 0 of
[the swap proposal](../../../docs/proposals/swap-navigation.md#2-one-way-in-navigate): which source of
navigation intents the swap uses. Each prints one line per browser; nothing asserts, since what they
record is the browsers' behaviour, not sinter's.

- `features.cjs`: what exists (`navigation`, `intercept`, `sourceElement`, `precommitHandler`, entry
  `index`, `moveBefore`, `parseHTMLUnsafe`, …).
- `behaviour.cjs`: a link, Back, `location.assign`, `navigation.navigate` with `info`, a `#hash`, a
  download, two navigations in a row, a precommit handler, a reload.
- `scroll.cjs`: `intercept({ scroll: 'after-transition' })` across push, Back, Forward and a reload,
  with content that is short at the swap and grows after.
- `interplay.cjs`: whether `history.pushState` fires `navigate`, and whether an intercepted traversal
  also fires `popstate`.
- `precommit.cjs`: whether the URL waits for a `precommitHandler`, read inside the page (`behaviour.cjs`
  reads it through Playwright, whose click can wait for the navigation: its precommit line is not to be
  trusted).
- `focus-bfcache.cjs`: `focusReset`, and Back into the app from a page load out of it (with a control
  page without the API: headless browsers keep nothing in the back/forward cache).

```sh
node features.cjs   # and the others; Firefox and WebKit: npx playwright install firefox webkit
```

Recorded 2026-11-16 with Chromium 153, Firefox 155 and WebKit 26.6: see the proposal.
