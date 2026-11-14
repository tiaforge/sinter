# RealWorld: Lighthouse under the same conditions

`bench/realworld/lighthouse.mjs` audits the other implementations on their public demos. Each demo then has its own
host, its own CDN, its own API latency and, for SvelteKit, its own server fetching the data. This harness takes
the network out of the comparison: every implementation is built from an exact commit and served on one machine,
against the same local API and the same copies of the third-party files.

| what | the same for every implementation |
| --- | --- |
| source | an exact commit (`implementations.mjs`), the latest on its default branch on 2026-11-14; the edits listed there |
| theme | the RealWorld spec's `assets/theme/styles.css` (Conduit Minimal CSS v4) at `realworld-apps/realworld` 2558884: Angular and Vue 3 (official) through their `realworld` submodule, the others in their own copy (identical) |
| install | from each repo's lockfile (`--frozen-lockfile`, `npm ci`) |
| static hosting | one Node server (`world.mjs` `serveStatic`): HTTP/1.1, brotli, `immutable` for hashed file names, `no-cache` for the rest, the SPA's `index.html` for unknown paths (sinter: its page per path) |
| server rendering | SvelteKit on its Node adapter (`adapter-node` 5.5.8), its server-side fetches to the same API over plain HTTP |
| API | `api.realworld.show` answered locally: 25 fixed articles (10 per page), 6 tags, signed out; every answer after the same delay (`--delay`, default 150 ms) |
| third-party files | Ionicons, the Google Fonts stylesheets and font files: recorded once (`--record`), then served locally like a CDN copy, with their sha256 in `work/fixtures/manifest.json` |
| browser | Chrome mapped to the local servers (`--host-resolver-rules`, no proxy); it trusts only the local certificate (`--ignore-certificate-errors-spki-list`) |
| audit | Lighthouse 13.6.0 (this directory's `../package.json`), mobile and desktop presets, a new Chrome with an empty profile per audit, runs interleaved across implementations, the median of `--runs` |

Each audit is checked: a failed request, or a client-rendered app that never requested the article list, is printed
and counted in the table. `check.mjs` also loads every home page once and checks it shows the API's 10 articles.

## Run it

```sh
cd bench/realworld && npm ci                     # Lighthouse, chrome-launcher, undici
npm run build --prefix ../../examples/realworld  # sinter's build (needs the repo's own build first)
node fair/setup.mjs                              # clones and builds the others into fair/work/ (bun, pnpm, npm)
CHROME=/path/to/chrome node fair/check.mjs --record   # records the third-party files, checks every page
CHROME=/path/to/chrome node fair/run.mjs --runs 5     # the tables: fair/work/results-<time>/results.md
```

`work/versions.json` lists every commit, the theme's sha256 and the tool versions the builds used;
`results.json` every audit's scores with the Chrome and Lighthouse versions and the fixtures' checksum.
Scores still vary from run to run (Lighthouse simulates the network from what it observed, and the CPU is the
machine's): compare runs from the same machine and session, and report the range.

## Results (2026-11-14)

Chrome for Testing 153.0.8010.12, Lighthouse 13.6.0, API delay 150 ms, one cloud VM; median of 5 interleaved runs
(range of the 5), no failed request in any audit. sinter at 812eb90.

| implementation | mobile | FCP | LCP | TBT | CLS | desktop | CLS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **sinter** | **93** (93–93) | 1.53 s | **1.53 s** | 0 ms | 0.151 | **100** (100–100) | 0 |
| SvelteKit | 92 (91–92) | 1.81 s | 3.16 s | 0 ms | 0.002 | 100 (100–100) | 0 |
| Solid | 90 (90–90) | 1.65 s | 2.55 s | 0 ms | 0.151 | 100 (100–100) | 0 |
| Angular | 88 (87–89) | 1.51 s | 2.81 s | 177 ms | 0.138 | 76 (76–76) | 0.767 |
| Vue 3 (mutoe) | 86 (85–86) | 1.44 s | 2.34 s | 0 ms | 0.227 | 76 (76–76) | 0.791 |
| Vue 3 (official) | 79 (79–82) | 1.50 s | 3.76 s | 59 ms | 0.198 | 76 (76–76) | 0.794 |

Reproduced from a fresh work directory (setup, check, then 3 runs): every median within one point (SvelteKit 93,
Vue 3 (official) 80), the same CLS for every implementation; fixtures `77001a24496a0567`.

- sinter's mobile CLS is the "Popular Tags" column (`.col-md-3`) moving down when the articles arrive in the narrow
  layout; Solid's is the same shift. The public demos did not show it: the live API had 4 articles then.
- With the tag list hidden while the feed's first rows load ([docs/first-paint.md](../../../docs/first-paint.md#a-box-whose-width-follows-the-list)),
  measured the same way afterwards: sinter mobile **100** (99–100), CLS 0.000, FCP and LCP 1.53 s; the others in that
  run within two points of the table (SvelteKit 93, Solid 90, Angular 89, Vue 3 (mutoe) 86, Vue 3 (official) 80).
- SvelteKit renders the feed on its server: almost no shift, and its largest paint waits for the API (3.16 s).
- Angular and both Vue apps on desktop: the page container moves when the feed arrives (CLS 0.77–0.79).

## What is still not the same

- **What each app does is its own.** Its markup, scripts, fonts it asks for and how it bundles CSS are its code:
  Angular inlines the Google Fonts CSS and loads its stylesheet without blocking the first paint; sinter bundles the
  Google Fonts CSS; Angular and Vue 3 (official) bundle and minify the theme, the others link it as a plain file.
- **Server rendering runs on this machine.** SvelteKit's HTML waits for its server's fetch of the API (the same
  delay); the client-rendered apps wait for theirs in the browser. That difference is the architecture, not the setup.
- **One machine, one network model.** Lighthouse's simulated slow 4G replays what it observed locally; a CDN at the
  edge with HTTP/2 is not modelled. Every implementation gets the same.
- **Not included:** React + Redux (last commit 2021), not attempted.
