# A list's empty state: `data-sn-else` after `data-sn-for`

Status: built 2026-11-20.

## What

A `<template data-sn-else>` directly after a `<template data-sn-for>` is the list's empty state:

```html
<template data-sn-for="a in list">…</template>
<template data-sn-else>
  <div>No articles are here... yet.</div>
</template>
```

It renders while the list is empty and every resource the list may come from has loaded, is not loading and has
no error. Over a list that is no resource's (state, a prop given none, a helper over state), it renders while the
list is empty.

## Why

"Empty" was the one status the examples wrote three ways (`!meta.loading && meta.loadedAt && !list.length`,
`$meta.x.loadedAt && !x.length`, `!x.length`), and the third was wrong: it showed "No tasks" beside "Loading…"
during a reload. The right condition names the list twice and each of its resources three times, and goes
wrong again when the list becomes a choice or gains a filter. A filtered list (`people.filter(…)` empty while
`people` has rows) is empty too, which no `$meta` field could say.

Loading and error stay as they are, written with `$meta`: `$meta.x.loading && !x.length` and `$meta.x.error`.
They differ per page (a spinner, a message, a retry button) and are one field each. Empty is the one that needs
the list, its sources and their status together. The three never show together: empty waits for no load to run
and no error.

## How it is built

The compiler turns the `data-sn-else` into a `data-sn-if` before the second pass reads the page
(`emptyStates`), and the walk writes its condition (`emptyCondition`), compiled where the list is:

```js
($meta.c.loadedAt && !$meta.c.loading && !$meta.c.error) && !(c.filter((p) => p.done)).length
```

From there on it is a branch like a hand-written one. So everything that reads branches reads it as one, with
nothing added: the build's constants (a `file:` list empty at build time writes the empty state into the page,
which works without JavaScript), the second pass, the early file (it paints the branch where a hand-written
`data-sn-if` with the same condition would be painted, and the page module adopts it), the reserved space
(`status-eval.ts` evaluates the condition: while a resource loads, `loadedAt` is null, so the branch is known
not to show and never meets the placeholder), anchors (it renders between its own comments, after the list's,
so CSS still sees plain children; the minifier, swaps and adoption already know a branch after a list). The
runtime has no new binding: the if binding renders it. `npm run size`: the core grew by the `when` change
below only (87 B minified, 18 B gzip; the `for` module 98 B, 26 B gzip). A page pays for its conditions: RealWorld's
index page, whose hand-written condition read a let of the status, is 57 B gzip larger.

The list is evaluated twice, by the list and by its empty state, as a hand-written condition does; an expensive
helper keeps its result with `memo()`. A plain array (a resource, a let choosing between collections, `filter`/`slice`/`toSorted`/`toReversed`) is
tested with `.length`; anything else (a `Set` in state, a helper's result) with `[...list].length`, since a list
may be any iterable.

## The sources

The resources are found as `merge()`/`remove()` and inferred row keys find them (`listOf`): a resource, a
`data-sn-let` name, `?:`/`||`/`??`, `filter`/`slice`/`toSorted`/`toReversed`, a helper's arguments. One
difference: at a choice the condition follows the choice. `shown: q ? results : recent` waits for `results`
while `q` is set and for `recent` otherwise; waiting for both would never show "nothing recent" while
`results`, whose `when` is `q`, never loads. Where the choice's test cannot be read at the list (a let's test
reads a name of the let's own place), every candidate is waited for.

| Kind | Has loaded | Why |
| --- | --- | --- |
| fetched (`src`) | `loadedAt` set, not `loading`, no `error` | `loadedAt` is the server's answer on this page; `loading` covers a reload (`refresh()`, a `src` change), which the loading branch shows. |
| a failed load | not empty | `error` is set: the error message shows, and "nothing here" beside "could not load" contradicts it. After an empty success, a failed reload hides the empty state too. |
| `when` falsy | not empty | Nothing was asked: a search box with nothing typed shows no "No results". This needed one runtime change: when `when` turns falsy after a load, `loadedAt` and `error` go back to null (the resource holds nothing from the server again), as before its first load. Before, clearing the search showed "No results" for an empty box. The same for a `for` resource, which counted `when` falsy as an empty list loaded. |
| `cache`, prefetched data | not until the server answers | `loadedAt` stays null for data shown early, so an empty cached list does not claim to be empty; rows from the cache show as rows. |
| `refresh="30s"` | stays shown | The background reload is silent: `loading` stays false, so the empty state does not flicker. |
| paginated, `page()` | not while the page loads | `page()` sets `loading`; a page with no items, once loaded, is empty. |
| `for` fan-out | once every current source answered | `loadedAt` is set then, and also when the list it fans out over is loaded and empty (no source: empty). |
| `call` | once the call returned | the same loader: `loading`, `loadedAt`, `error`. |
| `file:`, `content:` | nothing to wait for | A constant: empty means empty. Its `loadedAt` is always null, so it is left out of the condition, which the build then folds: the empty state is page markup or nothing. |
| embedded data (`data-sn-resource`) | at once | The embedded payload is the first load (`loadedAt` set at mount). |
| a list inside an item (`a.comments`) | nothing to wait for | It came with its row. Waiting for the row's resource would hide "No comments" in every row during each reload of the list. A field of a single resource (`feed.items`) waits for that resource. |
| state, a prop given state | nothing to wait for | Empty is empty from the first render. A prop given a resource waits for it (the prop's sources are the caller's). |

## Decisions

- **An else-if after a list is refused** (SN102), with the form that chooses inside the empty state:
  `<template data-sn-else><template data-sn-if="q">…</template><template data-sn-else>…</template></template>`.
  Allowing it would make a chain whose second link means "empty and q" and whose third means "not (empty and q)",
  which renders beside the rows. One meaning for the else after a list keeps it readable.
- **A second `data-sn-else`** after the empty state is SN102, as after any else.
- **`data-sn-else` takes no value** here either (SN401).
- **Not a component root.** A list alone is none (it renders many elements); with its empty state it is none
  either, and SN312 says so. A list with its empty state inside the root element, in a slot's default or fill
  (a `<template slot="x" data-sn-for>` takes its else into the fill, as `data-sn-if` does), and in the rows of
  another list work as anywhere.
- **A `data-sn-let` on the list's own template** is read by the list, not by its empty state, which is its
  sibling: SN102 says to move the let onto an element around both.
- **Not type-checked twice.** The condition is the compiler's, over what the list already reads, so `sinter
  check` and the editor report problems in the list once, at the list; the empty state adds no diagnostics.
- **A decided branch, and a list unrolled to no rows, read their resources** (SN501): a `file:` list empty at
  build time is read, though nothing of it is left in the page. This was a gap of hand-written conditions too.
