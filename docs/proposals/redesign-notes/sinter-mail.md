# Redesign notes: sinter-mail, how it leans on sinter, its baselines, and the gate

`@tiavision/sinter-mail` (repository `tiavision/sinter-html`, commit `8fc9d9a`) is the component library the redesign
([compile-units.md](../compile-units.md)) is held to: after it, the library must work and be as fast in the browser as
now, or faster. This note says what the library uses, records the numbers against sinter main, and describes
`scripts/mail-audit.mjs`, the check that each stage runs.

Measured 2026-11-23 against `dist/` of sinter main (`bb9d1b9`…`458546e`: only docs and the audit script changed in
between, `dist/` is the 11:37 build), Node 22.23, Vite 8.3.5, TypeScript 7.0.2, Playwright 1.63 with its Chromium
(build 1243), on a 4-core machine that other agents were loading (load average 2–14). Every time below is a median,
and the spread is given. Runs on this machine vary by ±10–20 % at best. Treat a difference under 20 % as noise unless
the same comparison repeats it.

## 1. How the library uses sinter

**What it is.** It has three public components: `mail-body`, `mail-width` (a script that reports `media` as an
event) and `mail-warm` (a script that parses a sample email early). It also has 66 internal components, generated
from one table (`sinter/tags.ts`, `scripts/build-components.mjs`):

- one per tag, 63 of them (`mail-p`, `mail-a`, …), plus `mail-table`, which writes a table's whole structure
  literally;
- `mail-orphan`;
- the dispatch `mail-node`;
- `mail-tree` (the templates) and `mail-view` (the script builder).

Each tag component is markup with no whitespace between tags. Its root is the tag. On the root it has:

- one `data-sn-attr` with literal keys (the id written as `'mail-' + id`, which SN503 accepts);
- one `data-sn-style` of up to 60 literal property names, every one read as `node.style['…']`;
- `data-sn-class` (on `div` and `blockquote` only).

Inside the root, it loops over `node.children` (`data-sn-for`). For each child it tests text or element (`if`/`else`)
and `display !== 'none'` (`if`), then recurses through `<mail-node data-sn-with="{ node: c }">`. `mail-node` is one
`<sn-component use="{ a: 'mail-a', … }[node.tag]">` over 69 keys. `mail-a` and `mail-img` wrap their element in
`<slot name="link">` and `<slot name="image">`, so an app can replace every link and image.

The compiler features it depends on:

- **`<sn-component use>` with many candidates**, compiled as a lookup table (sinter#77). Every candidate is a
  recursion point, so the 65 tag components are **shared definitions**: `$p<tid>` rows, and `sameProps` at run time.
- **Recursion over data** through that choice: a component reached inside itself across a `for` or `if`.
- **Tree slots and fills** (`link`, `image`) that pass down through a recursive tree. A fill reads `$slot.node`,
  and a link's fill takes the link's children through `<slot></slot>`. The fills are the `$f` entries that `sameProps`
  compares by entry.
- **`$build` and `$slots`** in `mail-body`, which choose the route per use:
  `data-sn-if="($build && (!!body || !body)) || $slots.link || $slots.image || !!templates"`. The
  `(!!body || !body)` reads `body` so that the condition is constant only where `body` is. The library relies on the
  documented rule "evaluated once more as the browser will see it" ([components.md](../../components.md#choosing-how-it-renders-per-use-build-and-slots)).
- **Folding at build time**: `file:` resources, constant data up to 1,024 levels deep (sinter's change 4 for this
  library), and loops unrolled at every depth. Its helpers (`mail.parse`, `mail.plain`; pure, `memo()`'d, frozen
  trees) run at build time over a `file:` email.
- **Constant styles written as a `style` attribute.** `mail-body`'s `display: body ? 'flow-root' : null` is written so
  that a page rendered in the browser has no constant inline style, which `style-src 'self'` blocks.
- **Component scripts** (`mail-view.ts`, `mail-width.ts`, `mail-warm.ts`): `this.root`, `this.props`, `connected`,
  `propsChanged`, emits. It also uses sinter's run-time exports `attrAllowed` and `styleAllowed`.
- **Not used:** scoped styles, early renderers (`mail-width` gets SN543 in one test app), `data-sn-key`, state
  inside the tree components.

### The three routes

| route | the use | what the BUILD does | what the BROWSER does |
|---|---|---|---|
| (i) an email from a file | `src="file:./x.html"` + `mail.parse` in a let, or a `file:` tree | **Pass 1** compiles all 65 definitions (one per recursion point) and the worklist evaluates every instance. **Pass 2** copies each instance into the page (`expandConstants`, `inlineInstance`, `cloneTree`), analyzes and evaluates each binding, writes the values and drops them. Output: plain HTML, no JS | nothing (no script, no anchor, no template) |
| (ii) an email from an API, no fill | `data-sn-with="{ body: message }"` | **Pass 1** still compiles `mail-tree` and the 65 definitions (the `$build` branch). It decides the `if` false as the browser sees it. **Pass 2** compiles only `mail-view`: 14 ms/page | `mail-body`'s choice and the root's class and style bindings. Then `MailView.#render`: `build()` creates the elements directly, copies elements whose style it has seen before (`cloneNode`), and checks with `attrAllowed` and `styleAllowed`. A new body is rebuilt whole |
| (iii) an email from an API, through the components | a `link`/`image` fill, or `templates: true` | **Pass 1** compiles the definitions. **Pass 2** compiles them again (instances remain points), then `shareTemplates` and `compactTables`. The page ships 72 head templates and their functions | runtime shared definitions (contract.md example 3). Per tree element, see below |

**What route (iii) costs per element** (V8 call counts, one render of the 2,012-element generated newsletter,
`templates: true`): `instantiate` 10,931 (5.4 per element), `make` 7,311, `setRow` 5,296, `reconcile` 2,014,
`bindNodes` and `find` 2,013, `evaluate` 23,343 (11.6 per element), `write` 14,017, and 8,448 `setProperty` calls.
The rendered body keeps 4,026 comments: an anchor pair per element.

A child element goes through:

1. the parent's `for` row, a wrapper for `if text / else`;
2. the `if display` wrapper;
3. the dispatch choice, a wrapper with an `Object.create` scope;
4. the definition's row (`$p<tid>`; for `a` and `img`, a slot choice);
5. the element's template: one clone, one compiled `find`, a binding object per `attr`, one style group of about 60
   values, and the children `for` with its anchor pair.

Route (ii), on the same tree, makes 2,012 `open` calls, 78 `setProperty` calls (copied prototypes) and no comments.

## 2. Baselines against main

### The library's own suite

| command | result |
|---|---|
| `npm run typecheck` | passes (0.6 s, tsgo) |
| `npm run check` (`sinter check`) | passes: 5 pages, 0 errors, 0 warnings, 5 of 5 resources typed |
| `npm test` (vitest) | **passes: 12 files, 234 tests**, 54 s, Chromium included |

The only setup needed was `ln -s /home/user/sinter /home/user/tiavision/sinter` and `npm install`. Playwright finds
the preinstalled Chromium through `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, so `executablePath` was not needed.
Problems found, all in the library's benches and none in sinter:

- `bench/images.mjs` cannot load under Node: it imports `../sinter/parse.ts`, whose `./raw.js` specifiers do not
  resolve to `.ts`. It ran with a resolve hook that maps a missing `.js` to the `.ts` beside it.
- `bench/grow.mjs` needs `app.changed()`, which only the identity spike has (`TypeError: app.changed is not a
  function` on main). It cannot run against main.
- `bench/trace.mjs`'s non-`api` variant builds the same API page: `buildApi(undefined)` takes the default. There is
  no library bench for route (iii); the audit adds one.

### Build time

Each build runs in a fresh process: `test/app.ts`'s `app()` plus `vite.build` with
`sinter({ libraries: ['@tiavision/sinter-mail'] })`, as `bench/harness.mjs` builds. Each process builds twice: cold,
then warm. The table gives medians of 3 interleaved rounds in ms, with the range in brackets. The route (i) email is
`test/corpus/newsletter.html`, parsed at build (`images: 'allow'`): 35 elements, so about 70 component instances
(the dispatch plus the tag) and about 35 loops unrolled.

| app | cold | warm | JS shipped (raw / gzip) |
|---|---:|---:|---|
| (i) file, 1 page | 2,200 [2,071–2,235] | 1,465 [1,267–1,558] | none |
| (i) file, 12 pages | 7,412 [6,699–8,881] | 5,534 [5,421–6,494] | none |
| (ii) API, 1 page | 1,500 [1,411–1,579] | 901 [767–927] | 36.5 kB / **15.0 kB** |
| (ii) API, 12 pages | 3,707 [3,528–4,678] | **2,767** [2,610–3,217] | 53.1 kB / 22.1 kB for 13 files |
| (iii) `templates: true`, 1 page | 2,007 [1,850–2,391] | 1,254 [1,241–1,289] | 139.6 kB / **22.3 kB** (+5.2 kB HTML: 72 templates) |
| (iii) `templates: true`, 12 pages | 5,510 [5,447–6,159] | 4,413 [3,998–5,031] | 1,278 kB / 92.6 kB for 13 files |
| (i) generated newsletter as a `file:` tree, 212 el. | 3,953 [3,874–4,121] | 3,356 [3,188–3,722] | none |
| the same, 512 elements | 7,624 [6,744–8,811] | 6,553 [6,291–6,725] | none |
| the same, 2,012 elements (1 run) | 27,593 | 26,520 | none |

- The CHANGELOG's "~2.6 s for 12 pages" is route (ii) without TypeScript in the app: 2.77 s here.
- An extra page costs about 370 ms on route (i), 170 ms on (ii) and 290 ms on (iii).
- A folded element costs **about 11–13 ms at build** (212 → 512 → 2,012 elements). The CHANGELOG's figure does not
  show this.
- Route (iii) on 12 pages ships each page's own copy of the definitions' code: 1.28 MB raw, against 140 kB for one
  page.
- **With TypeScript installed in the app**, the build type-checks (`typecheck` defaults to on). Then:
  - the linker is off (contract.md §4);
  - every page compiles the library unlinked: 4,158 `definition` calls per page instead of 745, 304 ms/page instead
    of 125;
  - `check()` (tsc plus shadows) adds about 10–11 s for 12 pages (`shadowOf` is only 86 ms/page; the rest is the
    tsc child process).

  One or two runs each, warm (cold in brackets):

  | route | 1 page | 12 pages |
  |---|---:|---:|
  | (i) | 4.1 s (5.5) | 22.7 s (31.3) |
  | (ii) | 3.3 s (4.7) | 13.0–16.4 s (18.1–18.8) |
  | (iii) | 4.9 s (5.5) | 23.1 s (25.7) |

  An app that installs TypeScript is the common case.

**Where the compile time goes.** These figures come from the profile-agent instrumentation (`instr.mjs`/`hooks.mjs`:
wrapped methods, by pass, inclusive; it adds 5–10 %) and `node --cpu-prof` summarized with `prof.mjs`, from one
build each, without TypeScript. Figures are ms per page.

| | (i) file ×12 | (ii) API ×12 | (iii) templates ×12 | (i) 512-el. tree ×1 |
|---|---:|---:|---:|---:|
| `compile()` total | 519 | 233 | 399 | 6,361 |
| pass 1 `walkPage` (of which `definition`) | 166 (133) | 159 (125) | 159 (129) | 527 (452) |
| pass 1 `finishPage` (of which `prerender`) | 124 (45) | 59 (22) | 59 (20) | 623 (374) |
| pass 2 `walkPage` | 171 | 13 | 130 (`definition` 103) | 2,790 |
|   `expandConstants` / `inlineInstance` / `cloneTree` | 48 / 15 / 19 | – | – | 1,234 / 354 / 538 (82,527 calls) |
|   `walkChildren` (of which `expr`, `analyze`) | 102 (77, 72) | 1 | 107 (21, 22) | 1,394 (1,029, 940) |
| pass 2 `finishPage` (of which `prerender`) | 58 (53) | 1 | 49 (14; `shareTemplates` 17) | 2,417 (2,373) |
| `compile({describeOnly})` (prefetch) | 28 | 33 | 34 | 144 |
| GC inside compile, whole build | 956 ms | 405 ms | 781 ms | 689 ms |

- Linking: the first page records its definitions (`recordChild`, 720–920 ms once), and each later page replays them
  (`replay`, 30–33 ms).
- CPU-profile self time, route (i) ×12: `compile.js` 3.1 s, GC 1.2 s, `expr.js` 0.86 s (of which `applyEdits`, the
  textual prop substitution, 0.56 s), `link.js` 0.65 s, parse5's tokenizer 0.31 s.
- On the 512-element tree, pass 2's `prerender` alone is 1.9 s of self time: each inlined binding evaluated again.

### Run time

In Chromium, against the default build of the audit's pages, `node scripts/mail-audit.mjs <checkout> --bench --runs 9`
gives medians of 9 page loads after one warm-up load, with the range in brackets. "First render" runs from the API
response's `responseEnd` to the last mutation inside `#message`.

Two audit runs (load average 4–8 during both). Each cell is run 1 / run 2, median of 9 [range of both runs]:

| page, tree | first render (ms) | same message again (ms; its script) | use re-evaluated, same body (script ms) | `setProperty` | comments |
|---|---|---|---|---:|---:|
| (ii) `api`, newsletter 2,012 el. | 44.7 / 46.2 [22–88] | 20.5 / 22.6 (11.6 / 14.9) | 0.8 / 0.8 | 78 | 0 |
| (ii) `api`, static.json 95 el. | 34.7 / 38.0 [16–56] | 9.9 / 8.7 (3.0 / 3.5) | 0.7 / 0.8 | 106 | 0 |
| (iii) `api-templates`, 2,012 el. | **120.3 / 106.9** [86–171] | 101.4 / 88.1 (93.1 / 77.4) | **1.6 / 1.1** | 8,448 | 4,026 |
| (iii) `api-templates`, 95 el. | 43.8 / 52.3 [27–128] | 17.7 / 14.9 (9.0 / 9.1) | 1.2 / 1.2 | 111 | 176 |
| (iii) `api-fills`, 2,012 el. | 135.8 / 126.1 [80–183] | 95.2 / 104.4 (83.6 / 95.7) | 1.2 / 1.2 | 7,644 | 4,026 |
| (iii) `api-fills`, 95 el. | 49.0 / 54.8 [36–88] | 20.1 / 15.0 (11.3 / 10.4) | 1.3 / 1.3 | 105 | 176 |

- The deterministic columns (`setProperty`, comments, rendered elements) are the sharpest regression signal. The
  timed ones need a quiet machine.
- In all of these the "first render" time includes about 20–30 ms that are not rendering, since a 95-element body
  takes as long. Compare route (iii)'s 2,012-element result against route (ii)'s, or use the trace below.

The library's own benches against main (medians):

- `test/browser.test.ts`, "measured", route (ii): render of 2,012 elements in **33 ms** (runs 31–40). Page JS with
  the components is 35.6 kB / **14.6 kB gzip**, without them 28.0 / 11.9 kB, so the components add 2.7 kB gzip.
- `bench/trace.mjs api`, route (ii), 3 runs: one script task of **11–15 ms**, then style 4.3–4.7 ms, layout 7–12 ms
  and paint 2–3 ms. First contentful paint 60–74 ms after the response.
- The same trace for route (iii) (`templates: true`, the harness with that body), 3 runs: one script task of
  **86–108 ms**, then style 4.4–5.7 ms and layout 7.5–11 ms. First contentful paint 138–167 ms. The script is the
  difference: route (ii) builds the tree about 7× faster, as the README says.
- `bench/count.mjs`: route (ii) makes **78** `setProperty` calls for 1,743 styled elements. Route (iii) makes
  **8,448**, the progressive-rendering note's figure.
- `bench/network.mjs 2000 3`: unthrottled, the last byte comes 79 ms before first paint. On fast 4G it is 124 ms
  (the page's JS arrives 42 ms after the body), on slow 4G 230 ms (168 ms).
- `bench/micro.mjs` (DOM only, no sinter): 2,000 elements; 2/5/10 properties take 1.4–1.6 / 1.9–9.8 / 4.1–8.7 ms
  with `setProperty` and 2.2–2.5 / 2.7–5.0 / 6.4–10.3 ms with `cssText`. The machine was too loaded to rank them; the
  recorded finding (cssText is not faster) stands.
- `bench/images.mjs 3` (eager = route (ii), lazy = a route (iii) `image` fill): on fast 4G, hero and LCP at 853 /
  872 ms eager against 968 / 988 ms lazy. On slow 4G, 4,184 / 4,196 against 4,701 / 4,724 ms. CLS 0.10 in both, and
  624 kB of images in both. This bench measures the network, not the compiler.

**Page weight against which the redesign is measured** (one-page app, the harness's): route (ii) 36,493 B / 14,965 B
gzip; route (iii) 139,556 B / 22,266 B gzip, plus 5,208 B of HTML holding 72 templates; route (i) 0 B of JS. The
audit's multi-page app gives larger per-page numbers (shared chunks), which are comparable only between two audit runs.

## 3. The repeatable check: `scripts/mail-audit.mjs`

```
node scripts/mail-audit.mjs <sinter-mail checkout> [--bench] [--runs N] [--suite] [--keep <dir>]
```

**What it builds.** One app of 16 pages that cover the three routes:

- route (i):
  - the 4 corpus emails as `file:` HTML through `mail.parse`, the newsletter also at `media: 'narrow'`;
  - `mail.plain` over the plain-text corpus email;
  - `fixtures/trees/static.json` (every tag), and the same with both slots filled;
  - `all.json` (12 deep);
  - a 212-element generated newsletter;
- route (ii):
  - a tree from the API;
  - HTML from the API parsed in the page;
  - `mail-width` with `mail-warm`;
- route (iii):
  - `templates: true`;
  - fills;
  - both renderings on one page.

The app is assembled as `test/app.ts` assembles one, with links to the checkout and to this repository.

**How it compares.** It builds twice, each time in a fresh child process with the same root: with `SN_RENDER=0` and
without. Then it diffs the two output trees byte for byte, prints the first difference (file, offset, 120 bytes of
context either side), and exits 1. It also fails when a route (i) page ships JavaScript or a route (ii)/(iii) page
ships none.

**The flags.**

- `--bench` runs, per route (ii)/(iii) page and per tree (the 2,012-element generated newsletter and `static.json`):
  - first render;
  - the same message fetched again (`refresh`): a new tree, its time and its script;
  - the use evaluated again over the same body (`#tick`, five times): the `sameProps` path, which must not touch the
    email;
  - `setProperty` calls, comments and rendered elements.

  It then prints a `JSON …` line (build times, identity, page weights, bench) that can be compared between two
  checkouts.
- `--suite` also runs the library's `typecheck`, `check` and `test`.
- `--keep` keeps both trees.

It requires the checkout's `@tiaforge-ui/sinter` to resolve to this repository, so that the library's own sinter
import is the one under test, and it says how to link it.

**Output on main**:

```
$ node scripts/mail-audit.mjs ../tiavision/sinter-html --bench --runs 9
mail-audit: sinter 458546e (modified), sinter-mail 8fc9d9a; 16 pages; app in /tmp/sinter-mail-audit-nM6PZX/app
builds: SN_RENDER=0 19561 ms, default 20395 ms
identical: 42 files, byte for byte
page              route   html B  templates  folded elements  JS B (gzip)
file-newsletter   i         4880          0               35  0 (0)
file-narrow       i         4908          0               35  0 (0)
file-outlook      i         2255          0               15  0 (0)
file-legacy       i         4584          0               25  0 (0)
file-reply        i         1924          0               15  0 (0)
file-plain        i         1937          0               13  0 (0)
file-static       i         5979          0               95  0 (0)
file-all          i         6105          0               97  0 (0)
file-fills        i         5902          0               95  0 (0)
file-gen          i        29197          0              212  0 (0)
api               ii        1429          0                0  46798 (19590)
api-html          ii        1408          0                0  146221 (54746)
api-width         ii        1511          0                2  149114 (55968)
api-templates     iii       6008         72                0  141762 (22429)
api-fills         iii       6244         75                0  142229 (22521)
api-both          ii+iii    6066         72                0  148467 (25414)
bench api            newsletter-2000  2012 elements (2012 rendered): first render 44.7 ms [27.2–88], same body again 20.5 ms (script 11.6 ms), same body re-evaluated: script 0.8 ms; setProperty 78, comments 0
bench api            corpus-static    95 elements (95 rendered): first render 34.7 ms [15.5–55.9], same body again 9.9 ms (script 3 ms), same body re-evaluated: script 0.7 ms; setProperty 106, comments 0
bench api-templates  newsletter-2000  2012 elements (2012 rendered): first render 120.3 ms [91.4–170.9], same body again 101.4 ms (script 93.1 ms), same body re-evaluated: script 1.6 ms; setProperty 8448, comments 4026
bench api-templates  corpus-static    95 elements (95 rendered): first render 43.8 ms [27.4–128.2], same body again 17.7 ms (script 9 ms), same body re-evaluated: script 1.2 ms; setProperty 111, comments 176
bench api-fills      newsletter-2000  2012 elements (2012 rendered): first render 135.8 ms [80.3–182.2], same body again 95.2 ms (script 83.6 ms), same body re-evaluated: script 1.2 ms; setProperty 7644, comments 4026
bench api-fills      corpus-static    95 elements (95 rendered): first render 49 ms [36.7–64.7], same body again 20.1 ms (script 11.3 ms), same body re-evaluated: script 1.3 ms; setProperty 105, comments 176
JSON {"sinter":"458546e","sinterMail":"8fc9d9a","runs":9,"build":{...},"identical":true,"weight":{...},"bench":{...}}
```
Exit status 0. A second run was also identical; its bench numbers are in the table in section 2.

`SN_RENDER` is not read on main, so the two builds are the same compile and the expected result is "identical". Once
stage 1 reads it, the default build is the new route. The audit build takes 14–22 s here, almost all of it route (i)'s
second pass.

## 4. What the redesign means for this library

### Stage by stage

1. **Rows rendered at build time.** This stage is for route (i):
   - The 512-element tree spends 5.2 s of 6.4 s in pass 2 (`walkPage` 2.8 s, `prerender` 2.4 s).
   - The 35-element newsletter spends 228 ms/page there, against 290 ms in pass 1.
   - If the worklist's values give the rows, a folded element should go from 11–13 ms to well under 1 ms
     (inference: pass 1's evaluation of the 512 instances is part of 374 ms).
   - Route (i) 12 pages from 5.5 s to about 3 s. Pass 1's per-page library compile (133 ms) stays until stage 4.

   **Must stay byte-identical**, and `test/static.test.ts` pins it: attribute order (the table's), property order in
   `style` (the table's), `target`/`rel` first on links, the `mail-` id prefix, `class` after attributes, `&nbsp;`
   escapes, no whitespace between tags, no anchor or template left behind, no `<script>` other than the speculation
   rules.

   The library also relies on three rules that stage 1 must keep:
   - The worklist's acceptance at 1,024 levels deep and at 2,000+ elements: it folds today, and `gen.json` and
     `all.json` in the audit guard it. The budget is spent in candidate order (decisions.md §7), so a page near the
     budget is the risky case.
   - A **fill that folds with the tree**: `file-fills` has no residue.
   - A use that decides `$build` with the body constant.
2. **Rows that keep something.** Route (i) has no residue: no handler, state or fill that stays. The library is a
   regression check here, not a beneficiary. `mail-width`'s handler is outside any row.
3. **One compile per page.**
   - Route (iii): pass 2 compiles every definition again (103 ms/page, `shareTemplates` 17 ms). That should go.
   - Route (i): what remains of pass 2.
   - Route (ii): pass 2 costs 14 ms, and pass 1 already costs what the dropped branch costs.
4. **Units kept per build.** This is the largest build gain for routes (ii) and (iii):
   - The 65 definitions are compiled on every page: 125–133 ms/page linked, **304 ms/page with TypeScript in the
     app**, where the linker is off.
   - Estimate (inference: 11 × 125 ms): route (ii) 12 pages from 2.8 s to about 1.4 s.
   - With TypeScript, the 12-page builds are 13–23 s and `check()` is 10–11 s of that. "A component's markup is
     checked once" helps only if the per-page shadows stop re-checking the library. That is not shown yet, and it is
     worth measuring before claiming the with-TypeScript gain.

   What must not change: the head templates' content and order (`sn-t-<n>`), the numbering, and the `$p`/`$pp`
   names and `$f` entries the runtime's `sameProps` reads.
5. **Live uses from units.** Route (iii)'s definitions come from units. This is the same output and a cheaper pass 1
   per page.
6. **Deciding from summaries.** Route (ii) decides `mail-body`'s `if` false from `$build` "as the browser sees it",
   yet pass 1 compiles `mail-tree` and all 65 definitions to get there (125 ms/page). If deciding comes first, a
   route (ii) page would compile `mail-view` only: about 15 ms instead of 230 (inference from pass 2's 14 ms).

   The library depends on the exact semantics of `$build && (!!body || !body)`: constant only where `body` is,
   otherwise re-evaluated with `$build` undefined. It also depends on `$slots` being known per use. A summary that
   says "reads `body`" must give the same decision.
7. **Units at run time.** The only stage that can change route (iii)'s browser cost (below). Routes (i) and (ii) do not
   use the runtime's tree machinery.

**Places where the library relies on something the redesign plans to change or has listed for a decision:**

- **"Props as a run-time frame" is "Not planned"** in compile-units.md, while stage 7 assumes it. Route (iii) is the
  case for it.
- **Linking off under type checking.** Route (ii)/(iii) build cost doubles with TypeScript installed. Stage 4 is the
  fix, and the audit does not install TypeScript, so it measures the linked case only.
- **Choice props not checked for being constant** (decisions.md §7.3, with `images` on). The library passes `node`
  through `<sn-component use>` and never turns `images` on (`srcset: null` everywhere), so it is unaffected today. If
  that rule changes, `mail-img`'s `src` must stay a binding in routes (ii) and (iii).

### Where the runtime could get faster for route (iii)

The cost to beat is one script task of 86–108 ms for 2,012 elements. Route (ii) takes 11–15 ms, and style plus layout
about 15 ms in both. A sampled profile of route (iii) (unminified, profiler on, 181 ms per load with the profiler's
inflation of about 1.6–2×) splits it as follows:

- binding evaluation 37 ms, of which the binding functions 20. The style group function builds an array of about 60
  values per element;
- writes 26 ms, of which `setProperty` 14;
- GC 26 ms;
- `instantiate` self 16.5 ms, `reconcile` self 12.4, `setRow` self 12.4, `make` 4.5;
- `cloneNode` only 3.5 ms.

**The recorded spikes** (`bench/*.diff`, `docs/proposals/progressive-rendering.md`):

| spike | idea | measured | fate |
|---|---|---|---|
| `sinter-batched-style.diff` | first style write as one `cssText` | 67.2 → 68.9 ms (noise); `micro.mjs`: `cssText` slower than `setProperty` | dropped: no gain, and it needs a `declSafe` injection check |
| `sinter-shallow-props-unsafe.diff` | keep a choice's row when the new props are shallow-equal | stepped render: steps level at about 27 ms instead of climbing to 87 | unsafe as written (sinter's `anchors.test`, `wrapper-fuzz.test` fail: an in-place change under a prop reached the row only through the forced walk). Landed correctly in sinter#78 as `sameProps && !inside(rb)` |
| `sinter-copy-spike.diff` + `sinter-mail-copy-spike.diff` | force level 3: a replaced item renders down to components whose props did not change; rows keyed by node number | steps of a few hundred rows; no API; +44 B gzip; first renders unchanged | **landed** in sinter#78 (the `3` in `walkRow`/`toggle`/`reconcile`). The library's stepped rendering was later removed, because route (ii) renders whole in about the time of one step |
| `sinter-identity-spike.diff` | `app.changed(...objs)`: an index from objects to the definition rows holding them; a forced walk stops at unchanged props | steps 3–10 ms; +331 B gzip; +0.7–2 ms on a recursive first render | not landed: it needs a public API (a script can only mark a top-level field), and copies were enough |

The audit's `#tick` case measures what #78 gives today: evaluating the use again over the same body costs **1.0–1.3
ms** of script for 2,012 elements on route (iii), and nothing in the email is touched. `sameProps` cuts at the top.

**What a unit design (a component compiled once, its props a run-time frame) would make natural**, and my estimates:

- **One instance per element instead of about 5.4.** All of the following are inference; I have not built a
  prototype.
  - Today, an element is 4–5 nested row instances around one clone. A unit can own its children's dispatch: the text
    test, the `display` test and the choice compile into the unit's children program, a switch over the child's
    tag, and that creates the child unit directly. The wrapper instances, their `Object.create` scopes and the
    `$p…` list-of-one go.
  - The candidates for that saving are `instantiate`, `make`, `setRow`, the per-list `reconcile` setup (a `Map`, a
    `Uint8Array`, `lis()` even on a first render with no old rows), and some of the GC: about 45–55 ms of the 181
    profiled ms, so roughly 25–35 ms of the real 86–108.
  - Estimate: route (iii) from about 95 to about 60–70 ms of script, still 4–5× route (ii). The evidence is the call
    counts above and the self times. The risk is that `evaluate` and `write` (about 63 profiled ms) do not shrink at
    all.
- **Monomorphic frames.** `setRow`'s 12 ms of self time for 5,296 calls (about 2.3 µs each) is far more than its two
  stores should cost, which suggests dictionary-mode scopes. The scopes take computed names (`$p12`, `$i3`, `$pp`) on
  `Object.create` chains. A unit whose props are one frame object of a fixed shape would avoid that. Inference: not
  confirmed with V8's `%HaveSameMap` or a deopt trace.
- **`sameProps` and the identity index at the unit boundary.** Force level 3 and `sameProps` become structural: the
  walk checks props where a unit starts, instead of testing `t.item.startsWith('$p')` per row. The identity spike's
  index (object → instances whose props hold it) is also natural when an instance is a unit with its props. The
  update gains are small today (a tick is already about 1 ms), and in-place growth has no consumer since the
  library's steps went. Low priority.
- **Shared library code across pages.** Route (iii) on 12 pages ships 1.28 MB raw / 92.6 kB gzip of JS, about 6.4 kB
  gzip per added page, because each page module repeats the definitions. Units per build could emit a library's
  units once in a shared chunk. That changes bytes, so it is a stage-7 decision, and it helps only multi-page apps
  that use route (iii).
- **What units do not fix.** Most of the 7× gap is not structural. Route (ii) keeps no bindings and rebuilds whole. It
  copies a prototype per repeated style (78 `setProperty` calls against 8,448). It never builds a 60-entry style
  array: it walks the style object's own keys. A runtime "style from an object, over allowed names" write, an IR
  feature and not a unit feature, would attack the `evaluate`, `write` and GC share. That is also inference, and
  should be spiked on this library first.

**Recommendation for stage 7:**

- Measure route (iii) on the audit's `--bench` (first render, refresh, tick) and on `bench/trace.mjs` with the
  templates body.
- Accept it only if the first render's script drops clearly beyond the noise (at least 20 % over 9+ runs), the tick
  stays at about 1 ms, and the route (iii) page weight (22.3 kB gzip one-page) does not grow.
- Routes (i) and (ii) must come out byte-identical.
