# Spike: component trees over constants, rendered straight to markup

Status: spiked (2026-11-23), off by default (`SN_FAST=1`). `src/compiler/static-tree.ts`, called from `walkPage`
(`staticTrees`). Builds on [compile-once.md](compile-once.md), which made each page compile fewer times; this one makes
what a compile does with a constant tree cheaper.

## Why

A page per markdown post costs about 0.6 ms per component instance in the build: 100 posts of six sections (headings,
paragraphs, lists, a quote, code, a table) build in 11 s, against 3.6 s for the same site in Astro, and the build time
grows linearly with the length of the posts. Markdown parsing is 0.4 s of it. The rest is the compiler expanding
`<md-doc>`'s components (`md-tree` → `md-block` → `md-list` → `md-list-item` …) for each post: the first pass compiles
them and records a decision per `data-sn-if`, `<sn-component use>` and `data-sn-for` under its instance path (keys of
about 1.5 kB, each segment an absolute file path), and the second clones the tree (`cloneTree`, ten side tables per
node) and walks it again, looking each decision up. Nothing in that is markdown's: `examples/static-site` renders a JSON
tree with the same pattern (`content-tree`, `node-*`).

## What the spike does

Before the components expand, each component tag on the page (outside templates) is tried: its `data-sn-with` and its
component's markup are interpreted over the page's constants, and on success the tag is replaced by the markup it
renders. The constants are the page's entry (`data-sn-for` on `<html>`), its single `file:` resources (read as
`fileResource` reads them), its ancestors' lets, and the helpers through `helperCalls` (so a helper folds exactly when
it folds today). Values are written with the compiler's own `firstPaintValue` and `writeFirstPaint`, so URL schemes,
boolean attributes and classes are as the full compile writes them.

It knows `data-sn-props`, `data-sn-if`/`data-sn-else`, `data-sn-for` (with an index), `data-sn-text` (on an element
and on a template), `data-sn-attr`, `data-sn-class`, `data-sn-with`, `<slot>` fallbacks and `<sn-component use>`
(checked against `choicePool`). Anything else gives up on the whole tree, which then compiles the usual way: a fill,
a component with styles or a script, any other `data-sn-*` attribute, an `id` in the component's markup (SN532 is the
full compile's to report), a name that is not a constant, a value the first paint cannot write, past the expansion
limit. Expressions run with `with` over a proxy: a name in no scope that is not one of ECMAScript's deterministic
globals gives up.

Where the page marks component roots (scoped styles anywhere on it, dev builds), each root the tree rendered gets
`data-sn-c` with the innermost component's name, after its markup's own attributes and before those the tree wrote,
as the full compile orders them.

It runs in second passes (`decided`, `unrolled`, `constants`), whose type check is the first pass's: the first pass
still compiles the tree, so `sinter check` sees the page as written. With `SN_FAST_FIRST=1` it also runs in a first pass
that checks no types (`typecheck: false`, or no TypeScript installed).

## Measured

One run each, every build in its own process, outputs diffed file by file against the same `dist/` with `SN_FAST=0`:

| Build | Full compile | Second passes | Both passes | Output |
| --- | ---: | ---: | ---: | --- |
| 100 markdown posts with tables, `data-sn-for` on `<html>`, no type check | 11.1 s | 5.6 s | 4.1 s | identical (101 files) |
| `bench/collections`, 100 static posts, template | 3.6 s | 2.7 s | 2.3 s | identical |
| `bench/collections`, 100 static posts, a page each, no type check | 5.7 s | 5.4 s | 3.8 s | identical |
| `bench/collections`, 100 static posts, a page each, type check | 12.0 s | 10.0 s | (not taken) | identical |
| `bench/collections`, 100 live posts, template / a page each | 5.9 / 13.4 s | 4.8 / 12.4 s | | anchor ids numbered otherwise |
| `examples/static-site`, `realworld`, `dashboard`, `multilingual-site` | | | | identical |

The same site in Astro 7.4: 3.6 s. A post's tree renders in the interpreter as 422 instances and rows.

The live builds differ only in numbering: the full compile hands out ids (`nextId`) as it expands the tree, so the
comments list after it is `<!--sn 34-->` there and `<!--sn 7-->` here, in the page and in its scripts alike. Normalized
for those ids and the asset hashes they change, every file is the same.

`vitest run` with `SN_FAST=1`: 2,757 passed. Few tests reach the path (a build's second pass), so that says it breaks
nothing else, not that it is right: the output diffs above are the evidence.

## Found on the way

- **Scoped styles in unrolled rows (a bug on `main`).** A styled component used directly in a `data-sn-for` over
  constants (`<template data-sn-for="x in [1, 2]"><my-card data-sn-with="{ x }">`) has no `data-sn-c` on its rows: the
  use's root is the template's element, and the rows are `cloneTree` copies of it, so its `@scope` rules do not apply
  to them. `md-list-item` in `md-list` is such a use (no styles, so nothing shows). The spike marks those rows, which
  is the one difference it has on a page with scoped styles.
- **The type check is half of a page-per-file build.** `bench/collections --files`: 12.0 s with it, 5.7 s without. It
  is the first pass's walk, per page; nothing above makes it cheaper.
- `bench/collections` failed at `main` (SN208: the posts had no frontmatter type). Fixed.

## What it would take

- **The type check.** A first pass that checks types compiles the tree in full today. A component's own markup is
  checked per instance, against the props of each use; for a library's component over its own types, that is the same
  check every time. Checking a use (its `data-sn-with` against the component's props, which a frame already does)
  without walking the component's markup, and the markup once per build, would let the first pass take the fast path
  too: that is the 10.8 s → about 4 s of the table's last static row.
- **Numbering.** Byte-identical output on pages with runtime parts after the tree needs the ids the full compile would
  have used, or accepting other numbering (the page and its scripts agree either way).
- **Fills.** `examples/static-site`'s guide (a `link` fill with `$slot`) gives up today. A fill is caller markup
  evaluated in the caller's scope with `$slot`; the rules for which component a fill reaches (forwarding, rule 3 across
  packages) must be the full compile's.
- **Styles.** A styled component's root and its slot content are marked (`data-sn-c`, `data-sn-r`, `data-sn-s`), and its
  sheet ships with the page (`uses`); taking it means doing both.
- **Diagnostics.** What the full compile reports inside such a tree (SN532 ids, SN536 page-wide, SN534 in dev) must be
  reported the same, or the tree left to it: the spike leaves it.
- **The oracle.** Build with the full compile beside the fast path (as `SN_LINK_AUDIT` does for the linker) in CI over
  the benchmark and the examples, and fail on any difference.
