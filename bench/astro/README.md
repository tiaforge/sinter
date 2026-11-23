# The same blog in sinter and in Astro

The benchmark for [the compiler redesign](../../docs/proposals/compile-units.md): `n` markdown posts of six sections
(a heading, two paragraphs with inline marks and links, a list, a quote, a code block and a table; about 420 nodes a
post), one page per post and an index.

- **sinter** (`sinter-app.mjs`): the posts are `file:/content/posts/*.md`, parsed with `md.parse()` and rendered by
  sinter-markdown's components (`<md-doc>`), so a post is about 420 component instances and rows. Five variants:
  `static` (one template page, `data-sn-for` on `<html>`), `live` (the same, and on every post a section with state,
  a handler, a model and a live resource, so each page has a module), `static-files` and `live-files` (a page file
  per post instead of a template), and `static-typecheck` (`static` with the type check on; the others turn it off).
- **Astro** (`astro-app.mjs`): the posts are a content collection, rendered by `[slug].astro` with `<Content />`.

```sh
npm run build                                   # this checkout's dist/
mkdir -p packages/sinter-markdown/node_modules/@tiaforge-ui && ln -sfn "$PWD" packages/sinter-markdown/node_modules/@tiaforge-ui/sinter
node bench/astro/measure.mjs                    # --n 100 --runs 3 --only sinter|astro
```

Each build runs in a fresh process and is timed from the process's start to its exit; Astro's caches (`.astro`,
`node_modules/.astro`, `node_modules/.vite`) are removed before each run. The apps are written to `bench/astro/out/`
(ignored by git); Astro is installed there on the first run (`astro@latest`).

## Results

2026-11-23, `main` at 18d7b4f (0.21.0 and the changes after it), 4 cores, Node 22, Vite 8, Astro 7.4.13, 100 posts.
The sinter rows are one in-process run each (`run-sinter.mjs`), taken before the redesign started:

| Site | Pages | Time |
| --- | ---: | ---: |
| sinter, static | 101 | 13.9 s |
| sinter, live | 101 | 14.4 s |
| sinter, static-files | 101 | 14.6 s |
| sinter, live-files | 101 | 16.1 s |
| Astro, cold (median of 3) | 101 | 2.2 s |

Of the static build's 12.4 s of CPU time, 9.0 s is `compile` (the first pass's walk and evaluation, then the second
pass expanding each post's component tree per instance), 2.0 s garbage collection and 0.2 s parsing markdown. Astro
generates its 101 pages in 0.2 s; the rest of its 2.2 s is its own start, the content sync and Vite.
