# Pages over languages and tenants

Step 0 of [the axes proposal](../../docs/proposals/axes.md#plan): what a site in many languages and for many
tenants costs to build today, so the one-walk-per-page step (step 4) and one build over a tenant axis (step 6) are
measured against it, not estimated.

The app (`app.mjs`) is a site of `pages` plain pages and a blog template with `posts` entries per language
(`data-sn-for` on `<html>` over `file:/content/{$locale}/posts/*.md`), in `langs` languages with `localePrefix`,
on one layout with messages and a language switcher (`localeUrl()`), so every page reads the language. A page is
built once per **point**: per language, and per entry for the blog. Tenants are built the way an app does it today:
the same app built once per tenant (`TENANT=t0 … t19`), each with its own `site`; the time is the sum.

```sh
npm run build                                   # this checkout's dist/
node bench/axes/measure.mjs                     # --pages 50 --posts 10 --langs 1,2,10 --tenants 1,20
```

Each build runs in a fresh process (`../collections/run.mjs`), with the linker of
[compile-once.md](../../docs/proposals/compile-once.md) (5) and without it (`SN_NO_LINK=1`). The apps are written to
`bench/axes/out/` (ignored by git).

## Results

2026-11-21, `65a6a32` with the step-0 fix, 4 cores, Node 22, Vite 8 (Rolldown), one run each; 50 pages and 10 posts per
language, so 61 points per language and tenant:

| Languages | Tenants | Points | Linker | Time | Per point | Peak memory |
| ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 1 | 1 | 61 | on | 1.3 s | 21.4 ms | 216 MB |
| 1 | 1 | 61 | off | 1.6 s | 26.4 ms | 215 MB |
| 1 | 20 | 1,220 | on | 26.8 s | 22.0 ms | 225 MB |
| 1 | 20 | 1,220 | off | 26.1 s | 21.4 ms | 223 MB |
| 2 | 1 | 122 | on | 1.7 s | 13.6 ms | 236 MB |
| 2 | 1 | 122 | off | 1.8 s | 14.5 ms | 241 MB |
| 2 | 20 | 2,440 | on | 34.8 s | 14.3 ms | 254 MB |
| 2 | 20 | 2,440 | off | 38.2 s | 15.7 ms | 253 MB |
| 10 | 1 | 610 | on | 7.0 s | 11.4 ms | 396 MB |
| 10 | 1 | 610 | off | 7.2 s | 11.8 ms | 386 MB |
| 10 | 20 | 12,200 | on | 139.4 s | 11.4 ms | 427 MB |
| 10 | 20 | 12,200 | off | 146.8 s | 12.0 ms | 419 MB |

What it says:

- **A language costs about 10 ms per page**, the same for every language: from one language to ten, the build goes
  from 1.3 s to 7.0 s for 549 more points. Each language's page is walked again; only the build's own start (about
  1 s: Vite, the project, the type check) is shared.
- **The linker saves little across languages**: 3 to 9% here. Every definition in this app reads the language (the
  layout's messages and `localeUrl()`), so its read check refuses it, as the proposal expected.
- **Tenants share nothing**: 20 tenants are 20 times one tenant (26.8 s against 1.3 s, 139 s against 7.0 s), the
  build's start included. Every tenant compiles the same pages again.

So at 20 tenants × 10 languages a page is walked 200 times for 200 points that have the same program. Step 4 (one walk
per page, evaluated per point) and step 6 (one build over the tenant axis) are measured against the 139 s here.
