# Proposal: early helper modules shared with the page bundle

Status: evaluated (2026-11-17), option 1 prototyped behind an environment variable; nothing decided yet.

## The case

The early script and the page module are bundled apart, so every app module both use is in both, as separate
instances ([spec.md](../spec.md), "Own copies"; [first-paint.md](../first-paint.md)). Early helpers were tiny
until RealWorld's article body (PR #72): with embedded data (sinter-axum, `SINTER_EMBED=1`) `<md-doc>` renders
in the early script, so the markdown parser (`@tiaforge-ui/sinter-markdown`'s `parse.ts` and the prebundled
markdown-it, `parser.js`) is in the article's early file and again in its page module.

The early bindings import the helper from the module that declares it (`import { parse as md$parse } from
".../sinter-markdown/sinter/parse.ts"`), so that module is the unit to share.

## Measurements

RealWorld article page (`/article/article-25`), embedded-data builds, both served by sinter-axum against the
fixed mock API (`bench/realworld/ab.mjs --a-axum --b-axum`, new flag), Lighthouse, median of 7.
A: the current build. B: option 1, prototyped (`SN_SHARE='sinter-markdown/sinter/parse\.ts$'`).

| case | LCP A | LCP B | TBT A | TBT B | CLS A / B | JS A | JS B |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| mobile | 1,358 | 1,356 | 51 | 27 | 0.001 / 0.001 | 92.4 | 67.8 |
| mobile, after `/` | 1,412 | 1,407 | 40 | 0 | 0.384 / 0.384 | 64.2 | 39.6 |
| desktop | 378 | 367 | 0 | 0 | 0 / 0 | 92.4 | 67.8 |
| desktop, after `/` | 385 | 395 | 0 | 0 | 0 / 0 | 64.1 | 39.6 |

(ms; JS transferred, kB brotli; 8 script requests and 16 requests in every case)

What the article page loads (bytes of the files, brotli 11):

| file | A | B |
| --- | ---: | ---: |
| `article-head` (early file) | 26,530 | 26,574 |
| `article` (page module entry) | 27,277 | 5,235 |
| all scripts of the page | 79.4 kB | 57.4 kB |
| `parse` (B's fallback chunk, not loaded on a first load) | – | 22,227 |

- LCP is unchanged: the body is in the first paint either way. The page downloads 22 kB brotli less
  (24.8 kB gzip) and has 24 ms (cold) to 40 ms (warm) less blocking time on mobile: the parser is
  neither downloaded nor compiled a second time, and the mount's `md.parse` is a memo hit (one instance).
- The body's DOM after the mount is the same as A's (hashed) on a first load, with the early file
  blocked, and after a swap. No request for the fallback chunk on a first load.
- `script-src 'self'` and `require-trusted-types-for 'script'` on the documents: no violation in A or B.
- **Swap** from `/` into the article (click to body rendered, slow 4G at 150 ms RTT, 4× CPU, median of 7;
  swaps run no head script, so B takes its fallback): A 979 ms, B 1,139 ms (the fallback chunk starts only
  once the page module has run). With the page naming the fallback in an inert `<link data-sn-shared
  href>` that the swap imports beside the page module (patched into the build): **859 ms**, faster than A
  (two smaller files in parallel instead of one). An inert `<link>` loads nothing on a first load (checked).
- `md.parse` itself (option 2), Chromium at 4× CPU: article-25's body (1.4 kB) 0.1–1.6 ms, bench/markdown's
  article (47.5 kB) 19–26 ms. RealWorld would save about a millisecond.
- Static builds (no embedded data): `scripts/size.mjs --check` passes (article 59.8 kB gzip, budget 62 kB). The
  prototype changes them (below); a real implementation must not.

## Options

### 1. The page bundle uses the early file's instance (recommended)

The early file leaves the namespace of each shared module on a global (`Symbol.for('sinter.shared')`, keyed
by a hash of the module); in the page bundle the module is replaced by a stub that takes the global's
namespace, and otherwise imports its own copy, which Rolldown splits into a chunk (the fallback: a blocked
early file, a swap, a page whose early file does not contain the module).

- Saves the whole second copy (22 kB brotli here) and the second parse, with no new API for an app.
- It changes "Own copies" for these modules: one instance, so module state is shared (md.parse's memo is
  the point). Limited to modules that declare helpers an early binding calls; helpers are pure (they
  fold at build time), so their state is caches. sinter's own packages (`@tiaforge-ui/sinter`) keep their
  existing handoff and are never shared this way.
- CSP and Trusted Types: no inline script, no eval; the fallback is a same-origin hashed chunk.
- Early budget and SN523: the early file grows by the registration (44 B here); nothing else changes.

What the prototype does not do yet, and a real implementation needs:
1. **Decide per build, from the early files**: share a module only when some page's early file imports it.
   The prototype matches by name, so a static build (no early file has the parser) gets the stub too and
   would make the static article wait for the fallback chunk. The early modules are known only once every
   page is compiled (`transformIndexHtml`), and a shared module can be resolved before that (another
   page's graph reaches the helpers module first), so the stub's `load` waits until every HTML entry is
   compiled. With no early file importing the module, the bundle is exactly today's.
2. **Pages without the early copy**: a page whose page bundle reaches a shared module that its own early
   file does not have (RealWorld's editor, if it showed a preview) gets `<link rel="modulepreload">` for the
   fallback chunk, as `data-sn-preload` writes for lazy packages: no waterfall, the same bytes as today.
3. **Swaps**: pages with the early copy name the fallback chunk in `<link data-sn-shared href>`, and the
   swap imports it beside the page module (measured above).
4. **No top-level await**: the prototype's stub uses `await import()`, which needs a build target with
   top-level await. Instead the stub's exports delegate to the instance (functions only), and the mount
   waits for the fallback as it waits for lazy helper modules (`later()`). A shared module whose used
   exports are not all functions stays duplicated, and the build says so (option 3's report).
5. **Keys**: the hash of the module's code and its imports, so a tab that swaps across a deploy uses an
   old instance only when its code is the same.
6. **Tests**: a build test (stub only for modules in an early file; static build byte-identical; the
   preload and swap links), a browser test (first load requests no fallback; early file blocked; swap),
   and the early-takeover case in the component fuzz with a shared helper.

Size of the work: the plugin (decide, stub, register, links), one line in the swap, docs (spec, first-paint,
"Own copies"), tests. Some days, not a rewrite.

### 2. Hand over the result, not the code

The early file leaves `md.parse`'s results (its memo) on a global; the page module's `md.parse` starts with
them. The parser is still downloaded and compiled twice (the 22 kB and most of the 24–40 ms of TBT stay);
what it saves is the parse at mount, about 1 ms here, 20–80 ms for a 47.5 kB document on a slow phone. It
needs a handoff API per helper (or in `memo()`), and option 1 gives the same thing as a side effect.
Not worth it alone.

### 3. Keep the duplication, report it

The build's early-size line names modules over a threshold that are in both an early file and the page
bundle (`... and in the page module: sinter-markdown/sinter/parser.js 22 kB brotli`). Cheap, and useful
whatever is chosen: with option 1 it reports what could not be shared (item 4 above). Alone it leaves the
22 kB.

### 4. Others considered

- **The parser lazy in the page bundle** (`sinter({ lazy })`): SN325 forbids a lazy package in an early
  file, and the mount evaluates `md.parse` anyway, so the chunk would load on every first load: no saving
  without option 1.
- **The mount adopts what the early file rendered without evaluating it again** (inputs unchanged): the
  parser would load only when the body changes. A runtime change against "the runtime owns every binding",
  much larger; option 1 gets the bytes without it.
- **The tree from the server** (bench/markdown's `tree.html`): no parser in the browser at all, but the API
  (or sinter-axum, in Rust) would have to produce sinter-markdown's tree. Out of reach for RealWorld's API.

## Recommendation

Option 1, with option 3's report for what cannot be shared, built as items 1–6 above. On the article page
it saves 22 kB brotli and 24–40 ms of mobile TBT at the same LCP, and with the swap link it makes swaps
into the article faster than today. Static builds stay byte-identical.

## Found on the way (not part of this)

- Mobile, article after `/` (Lighthouse's warm run): CLS 0.384 with or without this change; the cold run is
  0.001.
- Under `require-trusted-types-for 'script'` a swap is refused (`This document requires 'TrustedHTML'
  assignment`) and the navigation falls back to a page load: the right page, but no swap. security.md says
  the core needs no policy of its own; the swap's HTML parse is a TrustedHTML sink.
