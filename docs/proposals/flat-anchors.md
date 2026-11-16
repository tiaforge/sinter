# Flat anchors: wrappers and text runs without nodes of their own

Status: built (follows [component-libraries.md](component-libraries.md), section 1, anchors as comments).

## The problem

Anchors as comments put every list, branch and choice between two comments. A level whose whole content is
another anchor still had its own pair, and its own instance: a clone of `<!--sn--><!--/sn-->`, a lookup, a
binding object. A markdown article (`@tiaforge-ui/sinter-markdown`, 47.5 kB of markdown, 300 blocks) took 6,597
template instances, of which 3,821 were such wrappers and 1,454 a lone text run (`<!----><!---->`); its DOM had
11,784 comments beside 1,365 elements. Typical chains:

- a `data-sn-for` row whose content is one `if`/`else` (a text run or `<md-phrasing>`);
- an `else` whose content is one choice (a component's `<sn-component use>`);
- a component whose root is a slot or a choice;
- md-heading's six-level `if`/`else` chain.

## The design

The compiler decides what flattens, from each template's content; the runtime only follows two flags.

**Wrappers (`TemplateDef.a`).** A template whose content is one `if` or choice anchor and nothing else (no
state, no dialog, no `$el`, not inside `<svg>`/`<math>`). A fresh row or branch of it is not cloned and has no
comments: its anchor is bound without a start or end comment (`RB.u`: the anchor whose row or branch it is;
`RB.x`: that row or branch), and the anchor's branch stands in the wrapper's place. Rows are delimited by their
first node and the next row's, so:

- the wrapper's first node is its branch's first node; an empty comment holds the place while the branch
  renders nothing, so a row always has one;
- when the branch changes, the new first node is set on the row, and on every wrapper above it whose branch it
  is (a chain of wrappers shares one first node);
- the branch ends where the wrapper does: the next row's first node in a list, or the end of the anchor it is
  the branch of (`after()`).

A wrapper keeps its binding and its scope: updates, dependencies and a choice's props work as before. What goes
is the clone, the two comments and the lookup.

**Text runs (`TemplateDef.tx`).** A template whose content is one `<template data-sn-text>` and nothing else
(its own mark and its place: two empty comments). A fresh row or branch of it is one `Text` node, which its
binding writes itself (the writer `x` writes a text node's data). A text slot always keeps its own place right
after its mark, so no other slot takes the run's node for its own.

**Early renders.** The early script renders these templates as before, with their comments; the page module
adopts that DOM as it is (with `pre`, nothing flattens). A list or branch may hold both shapes, and every
operation works on both. When an adopted part renders again, it takes the flat shape.

## What it changes for authors

The comments a wrapper and a text run had are gone from the live DOM (`childNodes` counts change; CSS selectors,
which see no comments, do not). An empty comment stands where a wrapper renders nothing. The server's HTML, the
early script's first paint and the head templates are unchanged.

## Measured

The article in headless Chromium, against the same article through marked + DOMPurify into `innerHTML` (an
island), median of 21 interleaved runs, on one machine and session:

| | before | after |
| --- | ---: | ---: |
| comments | 11,784 | 3,090 |
| template clones | 6,597 | 1,523 |
| elements, text nodes | 1,365, 1,586 | the same |
| script time | 92 ms | 62 ms (with md.parse in one pass) |
| LCP | island + 8 ms | level with the island |

The rendered HTML, comments stripped, is byte-identical. Core: +242 B gzip (14,682 → 14,924).
js-framework-benchmark and the live grid are level (their rows have no wrappers).

## Considered, and not done

- **One decision per chain** (the compiler composing `if → else → choice` into one choice function, with no
  binding object per level). Within one scope (an if's branches read their anchor's scope) it composes cleanly
  and was built: md-heading's chain became one six-case choice. Measured against flat wrappers alone it was
  2–5 ms slower on the article in three A/B rounds (its functions are larger, the dispatch the same), and its
  page module 0.4 kB gzip larger, so it was taken out. Across a scope level (a row, a choice's case with props)
  the inner dependencies name that level's variables, which composing would have to rewrite.
- **A branch whose content is a `data-sn-for`** (md-list-item's tight paragraph: 201 instances on the article)
  stays a wrapper with comments: a list without comments would need its own boundaries.
- **memo's freeze** (1.5 ms per article tree, warm): the fastest variant that keeps its checks saves 0.3 ms.

Tests: `test/behaviour/wrapper-fuzz.test.ts` (random chains of wrappers, text runs, choices and slot roots in
rows, changed in place step by step, against a fresh render, from the module's DOM and the early script's).
