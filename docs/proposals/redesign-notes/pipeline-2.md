# Build pipeline, round 2: the fixed part, and a static page outside the compiler

Running log (2026-11-23). Goal ([compile-units.md](../compile-units.md); round 1 in [pipeline-fixes.md](pipeline-fixes.md)):
what a build costs outside the compiler, the fixed part of every build and the per-page cost of a static page, measured
on a quiet machine, then cut where the output stays byte for byte the same.

## Where it stands

- **2026-11-24: decision 3 in** (the cross check in a worker beside the build, `SN_CROSS_LATE=0` the old place):
  −0.15 s at 100 static posts, −0.6 s at 400, −1.2 to −1.45 s at 1,000; peak memory +40 to 110 MB; a build it
  fails leaves `dist/` emptied. **Decision 4 in**: Vite's HTML step skipped for a page it does not change, in an app with no other HTML plugin
  (`SN_HTML_SKIP=0` off): −0.1 s at 100 static posts, −0.3 s at 400, −0.6 s at 1,000; live pages keep the step;
  peak memory unchanged. Every owner decision of this log is now built; nothing open here.
- **Done** for what can be fixed without a decision; three fixes in, each byte for byte the same over the bar; the rest
  written up below with what it would buy and what blocks it. Merged with `ccr-9ebf49d5-gpdej8` (0e55121): suite green
  (2,945), the integration branch alone against it identical over the bar, `render-audit` and `pass-audit` same.
- Measured: sinter's **fixed part is not the gap**. It is ≈1.1 s, against Astro's ≈1.35 s. The gap is per page: on the
  merged branch, 100 posts in 2.22 s and 400 in 5.21 s (wall), against Astro's 1.65 s and 3.04 s, so 10 ms a page
  against Astro's 4. Of sinter's 10 ms, ≈6 are the compiler's and ≈4 outside it.
- **The new floor** (the build with the compiler free, merged branch, median of 3 profiles): 0.98 s at 10 posts, 1.43 s
  at 100, 2.59 s at 400; 3.9 ms a page outside the compiler (it was 4.8, and 6.8 from 10 to 100, before these fixes and
  the integration branch's).
- Fixes: (1) SN521's scan, quadratic with a page file per post: −1.2 s at 1,000 page files; (2) `pageStyles`' import
  scan once per module, not per page: −0.33 ms a page; (3) the project read twice per build, not four times, and the
  rules hashed once: ≈10 ms. At 100 posts (2) and (3) are inside the run-to-run noise of the wall time (±0.1 s).
- **Decision 1 in** (the owner's go-ahead): the rules' paths folded into one exact pattern; at 1,000 page files a
  page is 11.4 kB instead of 58 kB and the floor 6.3 s instead of 10.3. Decision 2 in: the fold check's analyses on disk, ≈0.1 s off a warm build's start
  (0.2 s with sinter-mail's helpers).
- **For the owner** (below, "Decisions"): the cross check off the critical path (0.23 s at 100 posts, ≈0.5 s at 400;
  a failing SN534 build would then empty `dist/` and report from `generateBundle`); Vite's HTML step skipped for pages
  it does not change (≈1 ms a page; it changes none of the static blog's 101); an on-disk cache of the fold check
  (≈110 ms a build); the Speculation Rules inline in every page listing every page (with a page file per post the HTML
  grows with n: 58 kB a page at 1,000).

## How it is measured

- The machine: 4 cores, nothing else running (load < 0.3 before each series). Node 22.23, Vite 8.3.5, Astro 7.4.13.
- **Wall time**: `node bench/astro/run-sinter.mjs <app>` from process start to exit (`wall.sh`), and the in-process
  figure it prints; Astro's is a whole process (`measure.mjs --only astro`, its caches removed before each run).
  The tables give **wall time** unless marked, so sinter and Astro compare like for like. `run-sinter.mjs` imports Vite
  in the process, so its in-process figure leaves out Node's start and the import of Vite (≈150 ms).
- Node's compile cache: Astro's CLI turns it on (`module.enableCompileCache()`, not under `CI`); so does Vite's CLI
  (`vite build`), `run-sinter.mjs` does not. Measured: Astro 1.65 s with it, 1.85 s without (`CI=1`); sinter via
  `vite build` 2.23 s with it, 2.25 s without. So it is worth ≈0.2 s to Astro and nothing measurable to sinter; the
  tables use each tool as a user runs it (Astro's CLI; sinter's `run-sinter.mjs`, which is within 0.1 s of `vite build`).
- **The floor** and the owners: `node --cpu-prof --cpu-prof-interval 500` of one `run-sinter.mjs` build, read by `own.mjs`:
  compile = samples under `compile` (dist/compiler/index.js), GC between two compile samples counted as the compiler's,
  floor = the rest. Each other sample goes to the first frame from the leaf that belongs to sinter (dist/, not under
  `compile`), the helpers (sinter-markdown), Vite (split by the functions on the stack: the HTML step, the module runner,
  the config file, `resolveConfig`, `emptyDir`), Rolldown's JS, or Node's module loader. Libraries a frame calls (acorn,
  parse5) count as their caller's.
- **Byte identity** (`snap.sh <label>`, `cmp.sh base <label>`): the five bench apps at 100 and static/static-files at
  400, `scripts/baseline.mjs --keep` (the four examples, swap-csp, vite-i18n, axes), `scripts/mail-audit.mjs`'s 48 files
  (both of its builds); every file diffed (names, hashes in names, bytes); and the log lines at `info` and `warn` of
  realworld, dashboard, static-site, multilingual-site, sinter-live-100 and sinter-static-100, each build's lines sorted
  (the HTML step runs pages concurrently), durations masked. The snapshot before any change is `base` (HEAD `d64bc0b`).
- Scripts in the session's scratchpad (`snap.sh`, `cmp.sh`, `logs.sh`, `wall.sh`, `ab.sh`, `own.mjs`, `cat.mjs`,
  `prof.mjs`); the apps in `bench/astro/out/` (also `sinter-static-1000`, `sinter-static-files-1000`).

## The measured breakdown (before any change)

### Wall time, sinter against Astro

| app | n=10 | n=100 | n=400 | fixed | per page (100→400) |
| --- | ---: | ---: | ---: | ---: | ---: |
| sinter static (wall; in-process in brackets) | 1.23 s (1.09) | 2.33 s (2.18) | 5.98 s (5.80) | ≈1.11 s | 12.2 ms |
| Astro (its CLI, compile cache on) | 1.39 s | 1.65–1.86 s | 3.04 s | ≈1.35 s | 3.9 ms |

Medians of 3. Astro's own log at 100 / 400 posts: content sync and types 0.89 / 1.71 s (its markdown parse, ≈2.7 ms a
post), static entrypoints (Vite) 0.17 / 0.32 s, generating the routes 0.16 / 0.46 s (≈1 ms a page), "101 pages built in
1.33 s" / "401 in 2.64 s"; the rest of the wall time (≈0.4 s) is Node's start and loading Astro. So Astro is ≈0.9 s
fixed inside its build plus ≈0.45 s of start, and ≈4.4 ms a page, 2.7 of it parsing markdown.

### The floor (the build with the compiler free), CPU profile, one run each

| app | total | compile + its GC | floor | floor per page |
| --- | ---: | ---: | ---: | --- |
| static-10 | 1,388 ms | 450 | **938** | |
| static-100 | 2,778 | 1,230 | **1,549** | 6.8 ms (10→100) |
| static-400 | 6,599 | 3,605 | **2,994** | 4.8 ms (100→400) |
| static-1000 | 14,242 | 8,174 | **6,069** | 5.1 ms (400→1000) |
| static-files-100 | 3,051 | 1,562 | 1,489 | |
| static-files-400 | 8,973 | 5,085 | 3,888 | 8.0 ms (100→400) |
| static-files-1000 | 23,371 | 11,166 | 12,205 | 13.9 ms (400→1000): grows with n |

### The fixed part, by owner (static-10, ms; the whole floor less ≈10 pages)

| owner | ms | what |
| --- | ---: | --- |
| Node: module loading | 263 | Node's start, Vite (55 modules, ≈100 ms), the plugin (221 modules, ≈110 ms: 73 of sinter's, css-tree's 123 ≈40 ms, parse5, acorn, acorn-typescript, yaml; all used by a static build), the config file |
| Vite: the module runner | 112 | the helpers module and, at the end, its fresh copy (`ssrTransform` of sinter-markdown, run inline) |
| sinter: the fold check | ≈110 | `foldVerdicts` inclusive (acorn's parse of the helpers' modules, the walk); cached for the fresh copy |
| Rolldown's JS | 69 | its plugin dispatch |
| GC (outside the compiler) | 67 | |
| Vite: the HTML step | 50 | ≈10 pages |
| Vite: `resolveConfig` and the rest | ≈60 | the build's, the helpers' runner's, the fresh copy's |
| sinter: `project()` | 35 | 4 calls (configResolved twice, the probe, buildStart) |
| SN534's cross check | 32 | the fresh copy's calls (10 posts) |
| sinter: the rest of the plugin | ≈60 | `vite.js`, `components-build.js`, `head.js`, `styles.js` |
| idle / program | 56 | |

Measured apart: the plugin's import is 110 ms (Vite's 100); the helpers' fresh copy at the end of a build is ≈60 ms
warm (`loadHelpers({ fresh: true })`, the fold check cached) and the first copy 350 ms cold (with the fold check and
Vite's imports).

### Per static page outside the compiler (ms a page, from 400 and 1,000 pages)

| item | static 100→400 | static 400→1000 | static-files 400→1000 | what |
| --- | ---: | ---: | ---: | --- |
| Vite's HTML step | 1.0 | 0.9 | 4.2 | `traverseHtml` (parse5) of every page in its transform; its `generateBundle`, which looks each page's chunk up with `Object.values(bundle).find` (quadratic: 56 ms at 400, 373 at 1,000) |
| SN534's cross check | 0.8 | 0.8 | 0.6 | every post's `md.parse` again (≈60 % of it), the memo's `freeze` of the result (20 %), `resultKey` and the hash (15 %) |
| GC outside the compiler | 0.9 | 1.4 | 3.8 | |
| `pageStyles` | 0.5 | 0.3 | 0.5 | the regex scan of the helpers' import tree, per page (sinter-markdown resolves outside `node_modules`, so its parser's source is scanned on every page) |
| Rolldown's JS | 0.4 | 0.2 | 0.5 | |
| sinter's plugin (`vite.js`) | 0.3 | 0.4 | 2.2 | static-files: SN521's scan, quadratic (fix 1) |
| other (page-urls, head, program) | ≈0.6 | | | |

Static-files pages also grow with n: each page's Speculation Rules list every page (58 kB a page at 1,000 posts against
15.7 kB at 100), which is what makes Vite's HTML step and GC grow there. That is the page's bytes (the rules' JSON,
`rulesJson`): left, see below.

## Fix 1: SN521's scan, one pass per page module

`sinter:pages`' `generateBundle`, for every page that moves (`blog/post-1.html` → `blog/post-1/index.html`: every page
of a site with a file per page), built a `RegExp` for every page and tested it on that page's module (empty for a
static page): n² patterns. Now every module is read once for every page file it names (`filesNamed` in
`src/page-urls.ts`: at each quote followed by the base's path and `/`, the names in the page list that end where the
pattern's lookahead allows), the first time a page moves, and each moved page reports the modules that name it, in the
same order. Test: `test/vite/files-named.test.ts` (the old pattern as the oracle, on cases and 300 random ones).

| sinter's `generateBundle` (self time, CPU profile) | before | after |
| --- | ---: | ---: |
| static-files-100 | 21 ms | – |
| static-files-400 | 192 ms | < 9 ms |
| static-files-1000 | 1,174 ms | < 27 ms |
| floor, static-files-1000 | 12,205 ms | 10,954 ms |

Byte identity: every file of the bar, and the log lines, the same as `base`.

## Fix 2: `pageStyles`' scan, each module's import list once

For the box sizes of images and lists, every page's stylesheets are collected (`pageStyles`, `src/styles.ts`), with the
CSS the app's modules import: from the config, the early module, the helpers and the actions module, each module's
imports are followed through the project's own files. Each page ran the comment-stripping regex and the import regex
over every one of those modules again. On the blog, `src/sinter.helpers.ts` re-exports sinter-markdown, which resolves
to a folder outside `node_modules` (a workspace link, as in the benchmark), so every page scanned the markdown parser's
whole source. The import list is now kept by the module's file while its text is the same string (`read` already keeps
the text by mtime), and the resolution of each import still runs per page (its importer may differ). Test:
`test/vite/page-styles-scan.test.ts` (two pages, the same stylesheets; the module edited, the new order; a page's own
module script scanned as it is).

| `pageStyles` and `styles.ts` (CPU profile, outside the compiler) | before | after |
| --- | ---: | ---: |
| static-100 | 60 ms | 26 ms |
| static-400 | 213 ms | 82 ms (−0.33 ms a page) |

Byte identity: every file of the bar, and the log lines, the same as `base`.

## Fix 3: the project read twice per build; the rules hashed once

- `project()` (the components, the libraries, the helpers' manifest, ≈3–7 ms warm, 25–30 cold) ran four times per build:
  `configResolved`'s content load and the template probe (each afresh, as no build had started), the helpers' load at
  `buildStart`, then `buildStart` itself. The config phase now keeps its first read until `buildStart`
  (`configPhase`), and `buildStart` reads it before loading the helpers, which use that read. Dev is unchanged (read
  afresh as files change); `vite build --watch` reads it again at each rebuild's start. Test:
  `test/vite/project-reads.test.ts` (a build with a page per entry: 2 reads, 4 before; a rebuild: 1 more, and the edited
  component shows).
- The Speculation Rules' CSP hash (`speculationTag`) was a SHA-256 of the rules per page; the pages of a group have the
  same rules, so it is kept for the last rules seen. With a page file per post the rules list every page (58 kB a page
  at 1,000): 43 ms at 1,000 such pages, nothing at 100.

| `project()` inclusive, static-10 (CPU profile) | before | after |
| --- | ---: | ---: |
| one build | 35 ms | 27–32 ms |

Byte identity: every file of the bar, and the log lines, the same as `base`.

## Sinter against Astro, like for like (after: the merged branch)

Wall time, process start to exit, median of 3; sinter through `run-sinter.mjs`, Astro through its CLI with its caches
removed before each run.

| posts | sinter static, before (d64bc0b) | sinter static, after (0e55121) | Astro 7.4 | sinter's floor (compiler free), after |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 1.23 s | 1.20 s | 1.39 s | 0.98 s |
| 100 | 2.33 s | 2.22 s | 1.65–1.86 s | 1.43 s |
| 400 | 5.98 s | 5.21 s | 3.04 s | 2.59 s |
| per page (100→400) | 12.2 ms | 10.0 ms | 3.9 ms | 3.9 ms |
| fixed | ≈1.1 s | ≈1.2 s | ≈1.35 s | ≈1.0 s |

Most of the change from before to after is the integration branch's (the compiler); this branch's three fixes are
worth ≈50 ms at 100 static posts and 0.2 s at 400 page files (alternating `dist/` builds of the integration branch
and the merge: static-files-400 7.82 → 7.62 s, static-100 2.23 → 2.22 s, inside the noise). To be level with Astro at
100 posts the build has ≈1.7 s: the floor is 1.43 s of it, which leaves 2.7 ms a page for the compiler (it is ≈6 now);
the decisions below would take the floor to ≈1.1 s at 100 (0.23 s the cross check, ≈0.1 s Vite's HTML step), which
leaves ≈6 ms.

## Decisions for the owner

### The cross check (SN534) off the critical path

What it protects against (`src/fold-cross.ts`, docs/diagnostics.md SN534, `test/vite/fold-cross.test.ts`): a helper
whose result depends on the calls before it (state in a `Map`, an object, an imported module's table, a namespace
member: eight forms in the test), which the static fold check cannot see and which would give each page what the
build's page order made of it. At `buildEnd` it loads a fresh copy of the helpers module (`ssr.noExternal`: the
packages too), runs every page's calls again with the pages in reverse order, and fails the build with the first six
differences. On the blog it is every post's `md.parse` again: 60 % the parse, 20 % the memo's `freeze` of the result,
15 % `resultKey` and its hash.

Measured: the fresh copy's load ≈0.1 s in a build (60 ms standalone, warm); the calls 0.8 ms a page (157 ms at 100
posts, 423 ms at 400). Without the check at all (a patched `dist/`, to measure the bound): 2.29 → 2.06 s at 100 posts.

| option | buys at 100 / 400 | what it changes |
| --- | --- | --- |
| a worker that loads the fresh copy while the pages compile, the calls run in it at `buildEnd`, awaited there | ≈0.1 s / ≈0.1 s | nothing visible; but the tests run the plugin from `src/` (TypeScript), which a worker cannot load without a loader of its own, and the replay needs `resultKey` (in `compiler/compile.ts`, the whole compiler) in the worker. Machinery for 4 % |
| the same, awaited in `generateBundle` (`order: 'post'`, so after Vite's HTML step) | ≈0.2 s / ≈0.5 s | the error text is the same (`[plugin sinter]`, the same message), but it is raised after Vite has emptied `dist/` (a failing build leaves it empty instead of untouched), and another `generateBundle` error now comes first |
| each distinct (helper, arguments) once | nothing on the blog (no call repeats) | weaker: a stateful helper called twice with the same arguments is what it catches |
| sample the pages, or split the reversed list across workers | ≈0.15 s / ≈0.4 s | weaker, and the message's differences change |
| check at the first call | – | the build's own order, so it catches nothing the twice-in-a-row check does not |

None is taken: the first is not worth its machinery, the others change what the check reports or when. Recommended if
anything: the second, with the build failing before `dist/` is emptied kept as a requirement (it would need Vite to
empty `dist/` later, or the check to finish before `renderStart`, which brings back the first option's buy only).

### Vite's HTML step for pages it does not change

Every page goes through `vite:build-html`: its transform parses the page (parse5 with source locations,
`traverseHtml`) to find module scripts, stylesheet links, `<style>`, inline styles with `url()` and asset attributes,
and its `generateBundle` looks up the page's chunk (`Object.values(bundle).find`, over every chunk for every page:
quadratic, 56 ms at 400 pages, 373 at 1,000), injects the tags and runs the `post` HTML hooks. What we hand it is the
compiled page (the hook is `order: 'pre'`), 11 kB a post; the body is ≈95 % of the parse (0.7–0.8 ms of a page's
0.8 ms, parse5 alone, measured on the 400 posts' output). The step costs 1.0–1.1 ms a page (106 ms at 100, 426 at 400).

On the static blog it changes nothing: every one of the 101 pages comes out of Vite's step byte for byte as sinter
handed it over (captured at a `pre` and a `post` hook). On live pages it does (the head scripts are written in, the
module script replaced by the bundle's), and on realworld (stylesheets, module scripts).

There is no way to hand it less while it processes the page: what it parses is what it writes. Skipping it for a page
would mean the page is not an `.html` module (Vite's transform filters on `\.html$`) and sinter emits its HTML itself.
What sinter would have to reproduce, and check per page that it does not need: the `%ENV%` replacement
(`htmlEnvHook`), every other plugin's `transformIndexHtml` hooks (an app's own plugins would no longer see those
pages: the blocking part), asset URLs in `src`/`srcset`/`href` of the asset elements and in `url()` of inline styles,
`<link rel="stylesheet">` and `<style>` moved into the bundle's CSS and linked back with its hash, module scripts and
their `modulepreload`s, the CSP nonce and import-map hooks, and the public directory's URLs. A page with none of these
and an app with no other HTML hook would come out the same: ≈1 ms a page (0.1 s at 100, 0.4 s at 400, more at 1,000
with the lookup). Not taken: it changes what an app's plugins see.

### The fold check's analyses cached on disk

`foldVerdicts` (≈110–130 ms of every build's start: 60 % acorn parsing the helpers' modules, sinter-markdown's four
whole, the rest the walk) analyses the same unchanged files on every build. `FoldCache` already keys its per-module
analyses by mtime and size; written to `node_modules/.cache/sinter/` (where the image and font caches are), a warm
build would skip ≈110 ms. Not done: a new persistent cache (what invalidates it, a version key, what a corrupt file
does) is a design decision.

### The Speculation Rules inline with a page file per post

With a page file per post, each page's rules list every page (`href_matches`, two patterns per post): 4.7 kB of a
15.7 kB page at 100 posts, 47 kB of 58 kB at 1,000 (the template app's rules are four patterns). Vite's HTML step
parses it, sinter hashes it (fix 3 hashes it once) and GC carries it: static-files-1000's floor is 11 s against the
template app's 6 s, most of the difference in Vite's HTML step (3.2 s) and GC (2.7 s). A pattern (`/blog/post-*`), or
the rules file (`RULES_FILE`, already used with `delivery: 'header'`) above some number of pages, would make it
linear; it changes the pages' bytes and is the page description's (`rulesJson`, `appPages`).

## Decision 1 (taken): the Speculation Rules' paths folded into one pattern

The owner decided to go ahead (2026-11-23, evening): linear rules with the same behaviour in the browser.

**How the rules were built.** `rulesOf` (`src/vite.ts`) gives `speculationRules` (`src/prefetch-build.ts`) the paths of
every page that is not `data-sn-prefetch="off"` (and, with swaps, does not swap): `pagePaths`, two per page that moves
to a directory (`/blog/post-1/`, `/blog/post-1`), a page per entry's pattern once (`/blog/:slug`); with
`prerender: 'auto'` two lists, the prerender rule leaving out what the prefetch list matches. Each path became a URL
pattern `<path>\?*#*`. The same JSON is inline in every page of a group (one CSP hash, two with same-page links) or the
rules file under `delivery: 'header'`. With a page file per post the list is two patterns a post in every page.

**The candidates weighed.**

- (b) each page listing only the pages it links to: exact only for a page whose links are all in its HTML (no
  script that adds or changes one), and it gives every page rules of its own, so a hash per page: a CSP sent as a
  header that allows the rules by their hash (what the build's log line offers) would stop allowing them, and the
  browser would prefetch nothing. Not taken.
- (c) the rules file: only where the app's server sends the header (`delivery: 'header'`), a deployment change; it
  already applies there.
- (a) a pattern instead of the list: a wildcard (`/blog/post-*`) is exact only over the URLs the build knows, so a link
  to a URL the site does not serve would be prefetched where it was not. **Taken in its exact form**: a URL pattern's
  regular-expression group that matches exactly the listed paths, no more, for every URL, known or not.

**The form.** The plain paths of a list (`/`, then segments of `[A-Za-z0-9._~-]`, none `.` or `..`, none empty, no
`:`), when there are 16 or more, become one pattern `/(<re>)\?*#*`, where `<re>` is a trie of the paths without their
`/`, the branches whose rests are the same written once as a character class (`pathsPattern`). 0 to 999 with both
slash forms is `/((?:blog/post-(?:0(?:/)?|[1-9](?:/|[0-9](?:/|[0-9](?:/)?)?)?)|index\.html)?)\?*#*`. The other paths
(patterns with `:`, paths with other characters, a list under 16) are written as before, in their place.

**Why it is the same.** A URL pattern matches the pathname of the link's URL as parsed (percent-encoded, dot segments
resolved): a literal pattern part is canonicalized the same way, and a plain path is its own canonical form, so the
literal `/blog/post-1` and the group's `blog/post-1` match the same URLs; the group is anchored like the pattern, and
holds the whole path (an unescaped `?` after it would start the pattern's query). The search and hash parts and the
other conditions (`not` of downloads and other targets, a same-page `not`, the prerender rule's `not` of the prefetch
patterns, folded the same way) are as before. Off pages and swapping pages are not in the list, so not in the group.
The trie's language is exactly the set of paths (a class merges only branches whose rests are the same expression).
The rules are still the same JSON on every page of a group: one hash, as before (its value changes once).

**Evidence.**

- `test/vite/rules-folded.test.ts`: four apps built with the list (`SN_RULES_FOLD=0`) and folded; every page's
  preload candidates in Chromium 157 (CDP `Preload.preloadingAttemptSourcesUpdated`: the links the rules match) the
  same; files that differ, differ in the rules script alone. The apps: 24 page files with two `data-sn-prefetch="off"`,
  links to `public/` files (`/files/a.pdf`, `/blog/post-2.txt`), near misses (`/blog/post-99/`, `/blog/post-1x/`,
  `/blog/post-1/extra`, `/BLOG/post-1/`), relative, cross-origin, `?`/`#` links, and links a module script adds after
  load (not rewritten by the build: the other URL form of a page, an off page, no page); a page per entry (unchanged
  bytes); 12 pages in two languages under `localePrefix` (links to `/en/…`, `/de/…`, unprefixed, `/fr/…`). And the
  expression itself: 1,000 posts, their near misses.
- A fuzz run in Chromium (session scratchpad, `sr/fuzz.mjs`): 65 random sets of 30–90 paths over `ab-._~0/`, the
  links their paths, prefix, suffix, slash, case and query variants and random ones: 2,495 candidates, the same.
- The bar's apps before (the merged tree) and after, in Chromium: multilingual-site 15 pages (75 candidates), axes 21
  (111), static-files-100 and live-files-100 (60 pages each), sinter-mail's 19: every page the same.
- Byte identity (`cmp-rules.mjs`): every file of the bar is the same or differs in its `<script
  type="speculationrules">` alone. Changed: static-files-100 and -400, live-files-100, axes (12 pages), multilingual-site
  (8), sinter-mail's 16 pages and 3 more of its files; the template apps, the examples' other pages, realworld,
  dashboard, swap-csp, vite-i18n unchanged. Log lines: the same but Vite's size lines and the hash's value. With
  `SN_RULES_FOLD=0` the build is byte for byte the tree before. `SN_DESCRIBE_AUDIT=1` reports the same as before.

**What it does not cover** (the list as before): paths with characters a URL percent-encodes or a pattern's syntax
(`%`, spaces, non-ASCII, `:` `*` `(`…), `.`-led segments (`/.well-known/…`), `data-sn-path` patterns, and lists of fewer
than 16 paths (the template apps, most small sites: unchanged and readable).

| page files | HTML a page, before | after | gzip, before | after | rules a page, before | after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| static, 100 | 15,709 B | 11,274 B | 1,746 B | 1,252 B | 4,724 B | 289 B |
| static, 1,000 | 58,164 B | 11,441 B | 6,572 B | 1,263 B | 47,024 B | 301 B |
| live, 100 | 16,249 B | 11,814 B | 1,996 B | 1,492 B | 4,724 B | 289 B |
| live, 1,000 | 58,711 B | 11,988 B | 6,898 B | 1,506 B | 47,024 B | 301 B |
| template app (static-100) | 11,262 B | 11,262 B | 1,224 B | 1,224 B | 285 B | 285 B |

| static-files | floor before (2 profiles) | floor after | wall before | wall after |
| --- | ---: | ---: | ---: | ---: |
| 100 | 1.57 / 1.51 s | 1.42 / 1.50 s | 2.66 s | 2.81 s (noise) |
| 400 | 3.42 / 3.10 s | 2.64 / 2.77 s | 7.5–8.3 s | 7.1–7.3 s (profiled) |
| 1,000 | 10.3 s | 6.3 s | 19.4 s | 15.1 s |
| live-files-1,000 | | | 24.8 s | 22.0 s |

At 1,000 page files the floor is now the template app's (6.1 s): what grew with n² was the rules' bytes.

## Decision 2 (taken): the fold check's analyses on disk

The owner decided to go ahead (2026-11-23, evening).

**What is kept.** `foldVerdicts` (`src/fold-check.ts`) asks each export's reach, module by module; each module's
`analyze(file, code)` (acorn's parse, then its units: what each function and the top level reference, the exports,
the `export *`s, a parse error) is what costs. That analysis is a function of the module's path (its extension: JSON,
TypeScript or JavaScript) and its text alone: it holds the import specifiers as written, and every build resolves them
afresh (`resolveImport`, with the app's aliases and root; kept in memory only, as before), so neither the aliases, the
root, the packages' `exports` nor another module's text is in it. The verdicts are not kept: they are walked from the
analyses every build, so an edited imported module changes its importers' verdicts without touching their analyses.

**The key.** A file per module path (`node_modules/.cache/sinter/fold/<sha256(path)>.json`, so the folder holds one
file per module ever analysed, not one per version of it) holding the path, a SHA-256 of the text and the analysis's
version; read only when all three match. The version is a hash of `fold-check.js`'s own source (the analysis, its
globals), `parseModule`'s source (the parser's options), acorn's and acorn-typescript's versions and sinter's: any of
them changing reads nothing kept. The text is hashed whenever the in-memory stamp (mtime and size) misses, so an edit
that keeps both is still seen (tested).

**What it gets right, each tested** (`test/fold-cache.test.ts`, `test/vite/fold-cache-build.test.ts`):

- the same verdicts, positions and chains with no cache, a cold and a warm one (folds, a global, an assigned module
  binding, a package, JSON, a module that does not parse);
- kept by the text: an edit of the same size with the old mtime is analysed again;
- an imported module edited: its importers' verdicts follow, their kept analyses are unchanged;
- a kept analysis is really read (one changed on disk shows), and not under another version, nor under `fresh`;
- a corrupt, truncated, empty or foreign file: ignored and written again, never an error;
- a folder that cannot be made (its parent a file): the same verdicts, silently;
- builds writing at once: four processes rewriting the same entries forty times while the test reads them: every file
  reads whole, no temporary file left (a write is a temporary file renamed over the entry);
- this suite keeps no cache (`VITEST` set) unless a test asks, `SN_FOLD_CACHE=1`; `SN_FOLD_CACHE=0` turns it off; a
  build: the same files and log lines with no cache, cold and warm, and the folder only when asked.

`vite build` has no `--force` in Vite 8; the dev server's (`optimizeDeps.force`) reads no kept analysis and writes them.
Neither the image nor the font cache has a way to be cleared but deleting its folder: documented the same way, in
`docs/static-pages.md` ("Helpers and files at build time"), where the check is described.

**Measured** (CPU profile, `foldVerdicts` inclusive, one build each, quiet machine):

| | no cache | cold | warm |
| --- | ---: | ---: | ---: |
| sinter-static-100 (sinter-markdown's helpers, 4 modules + the app's) | 106 / 109 / 132 ms | 108 / 108 ms | 4 / 8 / 9 ms |
| sinter-mail's 16 pages (its helpers, 19 modules) | 191 / 229 ms | | 7 / 8 ms |

About 0.1 s off every warm build's start of the blog, 0.2 s of sinter-mail's. The image and font caches' folder
(`node_modules/.cache/sinter/`) is the app's; `sinter check` and the language server keep their in-memory cache only
(the editor's process lives long; `sinter check` could take the folder too, not done).

**Byte identity, three ways**: the bar (bench 100/400, the baseline apps, sinter-mail's 48 files, the log lines) built
with no cache (`SN_FOLD_CACHE=0`), then with every cache folder deleted (cold), then again (warm): every file and
every log line the same three ways, and the same as the tree before the cache. sinter-mail's audit builds in a new
folder each time (always cold), so its warm build was checked apart: 48 files the same as with no cache. Wall time of
sinter-static-100, alternating, 4 runs each: 2.25 s with no cache, 2.07 s warm (medians; the profile's 0.1 s is the
part that can be attributed).

## Decision 3 (taken): the cross check (SN534) beside the build

The owner decided (2026-11-24, 03:41 UTC) the second option: the check's work beside the build, waited for after
Vite's HTML step, accepting that a build this check fails leaves `dist/` emptied (it was left untouched) and that
another error may be reported first.

**How.** Beside the build means another thread: the check is CPU work (the helpers' calls), so on the build's own
thread, waited for later, it would cost the same. At `buildStart`, once the helpers are loaded, the build starts a
worker (`src/fold-late.ts`, `src/fold-worker.ts`) that loads its fresh copy of the helpers module through Vite's module
runner, as `loadHelpers({ fresh: true })` did at `buildEnd` (`importModule`, the same root, config file, mode and, with
no config file, aliases), while the pages compile. At `buildEnd` the build sends it every page's calls, as recorded,
and goes on; the worker runs `crossCheck` (the same function: every page's calls, the pages in reverse order, the chain
of results) and answers the differences, or why its copy did not load. The last plugin, named `sinter` as the main one
(so the error is `[plugin sinter]` and the same text), `enforce: 'post'` with `generateBundle` in `order: 'post'`,
waits for the answer and reports it as `buildEnd` did (`crossReport`: the SN534 error, or SN534's warning that the
calls could not be checked). The worker never keeps the process alive (`unref`), each build has its own (`--watch`),
and a worker that cannot start (an alias with a function cannot be sent to it), cannot take the calls or dies is
replaced by the check on the build's thread, at the same place (`crossHere`, today's code).

- A fresh copy in a thread of its own is at least as fresh as one beside the build's instance on its thread: the
  fold check does not let a folding helper reach `globalThis`, and Node's own modules are the thread's.
- **The tests' `src/` plugin**: the worker is then TypeScript. Each `.ts` file it loads is transformed by the
  bundler's `transformSync` in a load hook (`compiler/compile.ts` has a parameter property, which type stripping
  alone refuses; it was Node's `--experimental-transform-types` at first, which Node 26 no longer has: the worker
  could not start there and CI's Node 26 job caught the fallback) and a resolve hook that maps a `.js` specifier to the `.ts` file beside it (`registerHooks`, in the worker
  only), as `tsc`'s output has them. That is a loader of its own, 10 lines, used only when the plugin itself is a `.ts`
  file; the built plugin starts `dist/fold-worker.js`. It costs a worker about 0.7 s to load the sources, so this
  suite runs the check on the build's thread unless a test asks (`SN_CROSS_LATE=1`), as with the fold cache.
- **The switch**: `SN_CROSS_LATE=0` runs the check where it ran (on the build's thread at `buildEnd`); a build's
  default is the worker. `SN_CROSS_LOG=1` prints which one answered (`sinter cross: worker`, `here`, `here (the worker
  failed: …)`) and how long the last plugin waited. Dev and `sinter check` never ran this check: unchanged.
- **What changes**: a build this check fails has gone through Vite's HTML step, so `dist/` is emptied and nothing is
  written (it was left as it was); an error raised after `buildEnd` (sinter:pages' link checks, SN521's warning comes
  first in the log), and a type error of the build's type check (later in `buildEnd`, which the SN534 error stopped
  before), is now reported before it. The message and the differences are the same.

**Tests** (`test/vite/fold-cross.test.ts`): its build tests run both ways (`SN_CROSS_LATE=0` and `=1`): the eight
forms of state kept between calls, pure helpers and a memo, `undefined` and a chain of calls, a fresh copy per
`--watch` rebuild; and, against each other: the same message and the same differences (two pages, stack and the
order-dependent values masked), `dist/` left as it was at `buildEnd` and emptied beside the HTML step, the worker's
answer for a check that passes, and a worker that cannot start (an alias with a function) checked on the build's thread.
SN534's text in `docs/diagnostics.md` (from `diagnostic-docs.ts`) says where it runs and what `dist/` is left as.

**Measured** (whole process, base `SN_CROSS_LATE=0` and the worker in interleaved rounds, 3 rounds, Astro in the same
rounds; medians; peak RSS the highest of the rounds):

| app | base | worker | Δ | peak RSS |
| --- | ---: | ---: | ---: | ---: |
| static-100 | 2.26 s | 2.11 s | −0.15 s | 354 → 432 MB |
| live-100 | 2.53 s | 2.56 s | +0.03 s | 488 → 551 MB |
| static-files-100 | 2.69 s | 2.47 s | −0.23 s | 398 → 469 MB |
| live-files-100 | 3.01 s | 2.92 s | −0.09 s | 541 → 599 MB |
| Astro, 100 | 1.82 s | | | |
| static-400 | 5.56 s | 4.95 s | −0.61 s | 584 → 694 MB |
| live-400 | 6.89 s | 6.47 s | −0.42 s | 834 → 894 MB |
| static-files-400 | 7.05 s | 6.44 s | −0.61 s | 627 → 727 MB |
| live-files-400 | 9.47 s | 8.67 s | −0.80 s | 952 → 1,045 MB |
| Astro, 400 | 3.03 s | | | |
| static-1000 | 13.09 s | 11.88 s | −1.20 s | 821 → 909 MB |
| live-1000 | 16.17 s | 15.16 s | −1.01 s | 1,538 → 1,579 MB |
| static-files-1000 | 16.67 s | 15.23 s | −1.45 s | 878 → 932 MB |
| live-files-1000 | 23.56 s | 22.75 s | −0.81 s | 1,526 → 1,619 MB |

The estimate was 0.2 s at 100 posts and 0.5 s at 400: 0.15 and 0.61 here for the static template app (an earlier
series of 8 rounds at 100 gave 0.135 s). The last plugin waits 13 to 88 ms for the worker: the rest of the check is
hidden. The worker's own heap adds 40 to 110 MB to the peak. Live pages gain less at 100: their early scripts'
nested builds (after `buildEnd`) are on the main thread beside the worker's start.

**The worker's memory, and a build that fails elsewhere.** The +80 to 120 MB at the peak is the worker's own heap:
measured when it answers, 81 MB (57 in use) at 100 posts, 106 MB (78 in use) at 400: Vite and the compiler modules it
loads, its fresh copy of the helpers and the replay's results. Nothing is held twice on the build's thread (the calls it
sends were held until `buildEnd` before too). It terminates as soon as it has answered (`fold-late.ts`). A heap cap
(`resourceLimits`) is not taken: on a site whose replay needs more, the worker would die and the check fall back to the
build's thread, slower than today. It never keeps the process alive (`unref`); `buildEnd` stops it when it does not get
the calls (an error before or at `buildEnd`, no folded calls), an error after `buildEnd` lets it finish its one job and
terminate itself, and the next `buildStart` stops any that is left.

**Checked**: the bar with `SN_CROSS_LATE=0` against the default: every file and log line the same (bench 100/400, the
baseline apps, sinter-mail's 48 files); `pass-audit` and `render-audit --canon`: every app "same"; the suite (3,032)
green. `scripts/baseline.mjs`: its recorded hashes predate the redesign (every app "DIFFERENT" at the base too); its
report is the same both ways.

## Decision 4 (taken): Vite's HTML step skipped for pages it does not change

The owner decided (2026-11-24, 03:41 UTC), in the restricted form: only in an app with no other plugin that has an HTML
hook, only for a page that needs none of what the step does, emitted byte for byte as the step would.

**How.** Vite's step cannot be kept away from a page (its transform filters every `.html` module), and sinter's own
hooks run inside it, so a page is kept out of the step's work, not out of the step: `sinter:html-in`, the last HTML
hook before the step (`enforce: 'pre'`, after `sinter:fonts`), keeps the page and gives Vite a stand-in
(`STEP_STAND_IN`, an empty document); Vite parses that, gives it the same module (a page with no scripts or
stylesheets has an empty one either way, so the chunks and their hashes are the same), and in its `generateBundle`
runs the HTML hooks after the step, of which `sinter:html-out` is the first (`enforce: 'post'`, before `sinter:early`):
it puts the page back. From there the page goes on as it did: `sinter:early`'s and `sinter:pages`' hooks, Vite's own
two (the CSP nonce and the import map, which change nothing without a nonce or an import map), the placeholder
replacements (none in such a page) and the asset Vite emits. A stand-in that comes back changed is an error, not a
guess. `src/html-step.ts` decides which pages: a page with anything the step reads or rewrites, or anything the check
does not read whole, goes through it (its list: `%…%`, `__VITE_`, `vite-ignore`, `url(`/`image-set(`, `<style>`, the
asset elements, a `<script>` other than the Speculation Rules or with `import`, a `<link href>` on this origin or with
`imagesrcset`, an image `<meta>`). The app is checked once (`configResolved`): a build, no plugin outside sinter's
with `transformIndexHtml`, no `html.cspNonce`, no extra asset sources, `cssCodeSplit` not off, no `chunkImportMap`.

**The switch and the audit.** `SN_HTML_SKIP=0` sends every page through Vite's step as before; `SN_HTML_LOG=1` prints
how many pages were kept out. The audit is the existing scripts' switch, which build both ways and compare every file:
`node scripts/render-audit.mjs --switch SN_HTML_SKIP`, `node scripts/pass-audit.mjs --switch SN_HTML_SKIP`,
`node scripts/mail-audit.mjs <checkout> --switch SN_HTML_SKIP`.

**What it covers.** The benchmark's static pages, template or page files (every one of 101 at 100 posts), and a live
app's pages without a page module (live-100: the index). Not: live pages (their module script, Vite's tags), the four
examples' pages (stylesheets, module scripts), realworld's: they keep the step as before. Vite's step also warns on a
page's HTML parse errors (`handleParseError`): parsing every page the benchmark writes with Vite's filter (static and
page files at 100, 400 and 1,000) gives none, so nothing is lost from the log there; a page sinter writes is
serialized from its tree.

**Tests** (`test/vite/html-step.test.ts`): the check, case by case (a static page with its rules and other-origin
links: kept out; 26 kinds that keep it in: an env value, Vite's placeholders, `vite-ignore`, each kind of script,
stylesheets, icons, relative links, `imagesrcset`, `<style>`, `url()`, `image-set()`, images in either case, video,
source, svg `use`, object, `og:image`, `twitter:image`, a quoted `>`, a script it cannot read whole); an app with a
page of each kind built both ways: the same files and log lines, two pages kept out and four through (the stylesheet
bundled, `%MODE%` written); and an app with another plugin's HTML hook: no page kept out, the hook sees every page,
the same files.

**Measured** (whole process, base `SN_HTML_SKIP=0` and the default in interleaved rounds, 3 rounds, Astro in the same
rounds; the worker of decision 3 on in both; medians; peak RSS the highest of the rounds):

| app | base | skipped | Δ | peak RSS |
| --- | ---: | ---: | ---: | ---: |
| static-100 | 2.21 s | 2.11 s | −0.10 s | 433 → 455 MB |
| live-100 | 2.52 s | 2.59 s | (+0.07, noise: 1 page skipped) | 538 → 557 MB |
| static-files-100 | 2.51 s | 2.38 s | −0.13 s | 474 → 478 MB |
| live-files-100 | 3.17 s | 2.87 s | (noise) | 584 → 587 MB |
| Astro, 100 | 2.05 s | | | |
| static-400 | 5.33 s | 5.03 s | −0.31 s | 668 → 666 MB |
| live-400 | 7.02 s | 6.71 s | (noise) | 879 → 920 MB |
| static-files-400 | 6.94 s | 6.32 s | −0.62 s | 726 → 744 MB |
| live-files-400 | 8.98 s | 9.04 s | (noise) | 1,017 → 1,041 MB |
| Astro, 400 | 3.33 s | | | |
| static-1000 | 12.05 s | 11.48 s | −0.57 s | 935 → 1,030 MB |
| live-1000 | 15.47 s | 16.12 s | (noise) | 1,549 → 1,559 MB |
| static-files-1000 | 16.06 s | 15.41 s | −0.65 s | 997 → 935 MB |
| live-files-1000 | 23.27 s | 23.95 s | (noise) | 1,607 → 1,753 MB |

The estimate was 0.1 s at 100 and 0.4 s at 400: 0.10 and 0.31 for the template app, 0.13 and 0.62 with page files.
The live rows skip one page of 101: their differences (±0.7 s at 1,000) are the rounds' noise. **Peak memory** does
not move: sinter holds each kept page until it goes back (Vite held the same page until it wrote it), and the live
builds' 1.5 to 1.6 GB at 1,000 posts are pages that keep the step; what would lower that is Vite not holding every
page's HTML at once, which is Vite's.

**Checked**: the bar with `SN_HTML_SKIP=0` against the default: every file and log line the same (bench 100/400, the
baseline apps, sinter-mail's 48 files); `render-audit --switch SN_HTML_SKIP`, `pass-audit --switch SN_HTML_SKIP`,
`mail-audit --switch SN_HTML_SKIP`: every app the same; the suite (3,059) green with the skip on.

## Looked at, not changed

- **The SN534 worker awaited in `buildEnd`**: dropped for the late wait (decision 3), which hides most of the check.
- **Loading the build's fresh copy of the helpers earlier, on the main thread**: its CPU work (`resolveConfig`, the
  runner's transforms) would land in the page loop instead; nothing to gain without another thread.
- **One `resolveConfig` for both copies of the helpers** (two environments of one config): ≈25 ms, but the copies would
  share the config file's plugin instances, which a fresh copy is not supposed to.
- **GC outside the compiler** (≈0.9 ms a page): the heap at `buildEnd` (after a full GC) grows 0.15 MB a page: 51 MB at
  10 posts, 72 at 100, 118 at 400; by a heap snapshot's strings, the posts' markdown trees (`text`, `tableCell`,
  `paragraph` nodes) and each page's HTML, which Vite keeps until it writes (retainers not traced); the rest is allocation
  (parse5's trees in Vite's HTML step, the cross check's parses). No one structure to free.
- **Rolldown's JS side** (0.4 ms a page): its hook dispatch, `resolveId` for each page's imports, the output bundle's
  proxies; nothing of ours in it.
- **Node's compile cache**: nothing measurable for sinter (above).
- **Vite's chunk lookup per page** in `vite:build-html`'s `generateBundle` (quadratic, ≈6 ms at 100 pages, 373 ms at
  1,000): Vite's code; an upstream fix (a map from facade module to chunk) would make it linear.
- **Emptying `dist/`** (10 ms at 100 pages, 39 at 400, 140 at 1,000 page files): Vite's `emptyOutDir`, as in Astro.
- **Lazy imports of what a static build does not use**: every module the plugin loads is used by the static blog's
  build (css-tree by the components' styles, yaml by the posts' front matter, acorn-typescript by the helpers' fold
  check); `check/` is imported by `project.js` and `components-build.js` for `typeExports`, a few ms.

## Commits

- `a97bb69` perf(build): SN521's scan reads each page module once, not once per moved page
- `2963542` perf(build): pageStyles scans each module's imports once, not once per page
- `01ec27a` perf(build): the project read twice per build, the rules' hash once per distinct rules
- `0e55121` merge of `ccr-9ebf49d5-gpdej8`
