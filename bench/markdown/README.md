# Markdown: md.parse in the page, a tree from the API, marked + DOMPurify

The table in [packages/sinter-markdown/docs/markdown.md](../../packages/sinter-markdown/docs/markdown.md#performance):
one article (`data.mjs`: 300 blocks, 47.5 kB of markdown, every node type the components render) from an API,
three ways:

| Page | What it does |
| --- | --- |
| `article.html` | the markdown from `/api/article`, `md.parse` in the page (the parser loaded with it), `<md-doc>` |
| `tree.html` | the tree from `/api/tree` (`md.parse` run in Node by `server.mjs`), `<md-doc>`: no parser |
| `island.html` | the markdown through marked and DOMPurify into `innerHTML` (`src/island.js`), as RealWorld rendered its article body until 2026-11-17 |

```sh
npm ci && npm run build          # at the repository's root first: npm ci && npm run build
node measure.mjs                 # loopback, median of 21, the pages interleaved, one fresh context per run
THROTTLE=1 RUNS=11 node measure.mjs   # slow 4G and a 4× slower CPU
```

`measure.mjs` prints JSON: per page the median LCP and script time (Chromium's `ScriptDuration`), the gzip
size of the scripts it loaded and of the API response, and the elements and comments in `<main>`. `server.mjs`
serves `dist/` and the API gzipped (`bench/gzip.mjs`).
