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
- `view-transitions.cjs`: transition types and their selector, `view-transition-class`, and whether the
  stylesheet's `@view-transition` rule is readable from script.
- `media-src.cjs`: whether setting a playing `<audio>`'s `src` to the same value restarts it (it does,
  in all three: what a takeover of a bound kept player must not do).
- `csp.cjs`: whether a document's CSP can be replaced: a `<meta>` policy added on top of the header's,
  then removed, then a looser one (it cannot: added policies only tighten, in all three).
- `focus-bfcache.cjs`: `focusReset`, and Back into the app from a page load out of it (with a control
  page without the API: headless browsers keep nothing in the back/forward cache).
- `parse.cjs`: which parser keeps sinter's anchor comments and attaches declarative shadow DOM
  (`parseHTMLUnsafe` drops comments in Chromium unless it is given `{ sanitizer: {} }`).
- `parse-csp.cjs`: whether parsing a fetched page reports its inline styles against the document's CSP
  (Chromium does, with any parser; not with the document's nonce on them; Firefox and WebKit never).
- `kept-media.cjs`: a playing `<audio>` and `<video>` in a kept element, named for a same-document
  transition and moved into a new body in its update (they play on and the transition runs, in all three).

```sh
node features.cjs   # and the others; Firefox and WebKit: npx playwright install firefox webkit
```

Recorded 2026-11-16 with Chromium 153, Firefox 155 and WebKit 26.6: see the proposal.
