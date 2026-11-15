# Agent benchmark: how well do coding agents build with sinter?

**Question.** Given the same prompt, how often does a coding agent ship a *working* app with sinter,
compared with established frameworks (Astro, SvelteKit, …), and at what cost? Then the harder
question: how much of the gap is the framework (its syntax, its docs, its error messages) and how much
is the model having seen thousands of Astro and Svelte projects while training?

The harness is in this directory: `run.mjs` (runs agents), `tasks/*/PROMPT.md` (the prompts),
`tasks/*/grader/grade.mjs` (hidden checks), `lib.mjs`. [Baseline results](#baseline-run-2026-11-14) are at
the end.

## Principles

1. **The same prompt for every framework.** Only the framework's name changes (`{{FRAMEWORK}}`), plus
   ports, which differ per parallel slot. sinter is named with its npm package, because a developer
   asking for a new library would name the package too.
2. **Specify outcomes, never mechanisms.** A prompt says "the status changes at once and comes back if
   the server refuses", not "use optimistic updates". Each framework does it its own way.
3. **Hidden, executable grading.** The agent sees the prompt and the DOM contract (`data-testid`s,
   URLs, the three commands the grader runs). It never sees the checks. Checks are browser tests
   (Playwright) on the production build, served by `npm run preview`.
4. **Every grader is validated before any agent runs.** A dependency-free reference solution must
   pass 100% (`tasks/t1-incidents/reference`, `tasks/t3-content/reference`). For T2, the untouched base
   must score exactly the regression and "absent" checks (5/13) for every framework.
5. **Tasks cover each framework's home turf.** T1 (interactive app over an API) favours sinter and
   SvelteKit. T3 (static content site) favours Astro. T2 (changing an existing app) tests reading
   someone else's code.
6. **The agent cannot see the answer.** Runs use a fresh workspace outside this repository, with no
   user settings, no MCP servers and no subagents. Every tool call in the transcript is scanned for
   paths into this repository and for fetches of sinter's examples (`leaks`).

## Tasks

| id | kind | what the agent does | checks | home turf |
| --- | --- | --- | ---: | --- |
| **T1** incidents | greenfield app | From an empty directory and a given JSON API (`api/server.mjs`, `API.md`): a list with live search, a status filter in the URL, a create form with server-side validation errors, optimistic resolve/reopen with rollback, delete, a detail page with comments, and a not-found state. | 19 | sinter, SvelteKit |
| **T2** RealWorld | change an existing project | Into each framework's RealWorld app: a table of contents from the Markdown headings (slugged ids) and a "related articles" section fetched from the API. Regressions are checked too. | 13 (5 already pass on the base) | neutral: reading code |
| **T3** content | greenfield static site | From 6 Markdown posts (one draft): an index, post pages with no JavaScript at all, tag pages, an RSS feed, titles and meta descriptions. Graded with JavaScript disabled. | 13 | Astro |
| **T4** ops board (hard) | greenfield app | T1 grown up. It adds sign-in with a redirect back to the page first asked for; server-side pagination, search, filter and sort, all in the URL, with Back and Forward working; live updates from other users over SSE; rename with version conflicts (409); undo on delete, with the server delete only after 5 s; optimistic changes with rollback; and a live detail page. | 25 (24 before 2026-11-15) | sinter, SvelteKit |
| **T5** bilingual site (hard) | greenfield static site | T3 grown up. Two languages with partial translations, a paginated index, a series with previous and next links per language, a computed reading time, dates per language, a language switcher with a fallback, `hreflang` alternates, feeds per language and a sitemap, with no JavaScript anywhere. | 15 | Astro |

T2 bases (`tasks/t2-realworld/setup.mjs`):
- sinter: `examples/realworld`.
- SvelteKit: `sveltejs/realworld` at df79670, with the two edits `bench/realworld/fair` makes.
- **Astro has no maintained RealWorld app**, so Astro sits out T2. A hand-written Astro base, reviewed
  by an Astro user, is listed under [next steps](#next-steps).

**T4's login, fixed on 2026-11-15.** Before then, `POST /api/login` accepted a body with no username and no
password: `USERS[undefined] !== undefined` is false, so it issued a token. One agent's app sent its body
encoded twice, a JSON string, and was signed in that way. The API now answers 400 when either field is
missing or not a string, and 401 unless the user exists and the password matches. A 25th check, "an
empty or wrong password does not sign in", goes through the app's own login form.

The T4 rows before the fix ran against the lenient API and were graded with 24 checks. No score
changed: every one of those runs passed its sign-in checks, and the existing wrong-password check
already required the API's message. Compare T4 rows across the fix by the 24 checks they share.

T1 to T3 turned out too easy to separate the frameworks: nearly every model passes nearly every check.
T4 and T5 are the hard versions. Each was validated with a dependency-free reference solution that
passes every check (`tasks/t4-ops/reference`: 24/24, `tasks/t5-content-i18n/reference`: 15/15).

### Tasks to add for the full benchmark

The aim is 8–12 tasks, so that one task cannot swing the result:

- **T6 debug** (neutral): a seeded bug in the base project, described only by its symptom (for example,
  "the favourite count goes wrong after paging"). This measures diagnosis, where compile-time errors
  should help.
- **T7 a11y** (neutral): keyboard-navigable tabs, a combobox and a dialog. Graded with axe and the keyboard.
- **T8 migration**: port T3's site from plain HTML into the framework. This measures how far a
  framework lets an agent keep existing markup.

## What is measured

Per run (`results.json` has one row per run):

| metric | how | why |
| --- | --- | --- |
| **pass rate** | checks passed / total (T2: also the 8 feature checks alone) | the headline: does it work |
| **resolved** | all checks pass | strict success, like SWE-bench |
| build ok | `npm install && npm run build` exit 0 | an app that does not build scores 0 |
| cost (USD), output tokens | from the agent's result event | "friendly" also means "cheap to get right" |
| wall time, turns, tool calls | transcript | effort spent |
| build/check runs | Bash calls to `build`/`check` | how much the agent leaned on the toolchain's feedback |
| doc reads, web fetches and searches | tool calls that read `llms.txt`, `AGENTS.md` or package docs; WebFetch URLs | where the agent learned the framework |
| lines and files written | `git diff --numstat` against the start, without lockfiles or generated files | size of the solution; review burden |
| leaks | tool calls touching this repository | runs with a leak are excluded |
| **build output** | bytes of the client build output (`dist/`, `build/`, `.svelte-kit/output/client`; server bundles left out), split into JS, CSS and HTML | what is deployed |
| **download per page** | JS, CSS and HTML the browser fetches on each task's two key pages, each gzipped at level 9 by the grader, plus the request count | what users pay for |
| **Lighthouse** | mobile preset on the key pages (T4: `/login`, since Lighthouse cannot sign in): performance, accessibility, best practices, FCP, LCP, TBT, CLS. For T2 the RealWorld API is answered by `bench/realworld`'s mock, through Chrome's host mapping | output quality beyond "works" |

Per cell (task × framework × model), aggregated over repetitions:
- **pass@1**: mean pass rate.
- **pass^k**: the share of repetitions that resolve the task. It rewards reliability, not one lucky run.
- **median cost**.
- The spread across repetitions.

Secondary, not in the headline:
- **Code quality.** An LLM judge with a rubric (idiomatic for the framework, no dead code, no
  disabled checks), blind to the framework where the syntax allows. This only adds information when
  pass rates are equal.
- **Weight and Lighthouse** are measured for every run, but reported in their own table. Agent
  friendliness and output performance are different claims. Lighthouse runs in a separate pass, one
  run at a time on an otherwise idle machine (`run.mjs --grade-only --slots 1`). Agents running in
  parallel would skew the timings. Sizes and Lighthouse are always collected during grading; each row records
  `measuredAlone`, and a run measured beside others can be measured again with `--grade-only --slots 1`.

## Conditions: separating the framework from the training data

Established frameworks are in the training data, and sinter is not (yet). The options below come from
the literature and from framework vendors' own evals:

| method | what it isolates | cost | used here |
| --- | --- | --- | --- |
| **No mitigation** (`cold`): the framework's name only, web tools on | what a user gets today; familiarity included | 1× | **baseline run** |
| **Offline** (`offline`): no web tools | pure parametric knowledge plus what the installed packages carry (sinter ships `llms.txt`) | 1× | harness ready |
| **Equal docs** (`docs`): no web; each framework's documentation, capped at the same 200,000 characters (about 50k tokens), in `framework-docs/`, named in one identical prompt line ([details](#the-docs-each-framework-gets)) | learnability from docs, with the amount and the delivery held constant. Vercel's Next.js evals found passive in-context docs (AGENTS.md) beat on-demand skills, so the delivery is a confound to hold fixed | 1× | harness ready |
| **Vendor tooling** (`tools`): no web; what each vendor recommends for coding agents. Astro: its Docs MCP server. SvelteKit: the Svelte MCP server and Svelte's AGENTS.md. sinter: its starter template's agent notes, pointing at `llms.txt` and `sinter check` (it has no MCP server). Instructions go in `CLAUDE.md`; the prompt is unchanged | each ecosystem's best foot forward for agents, as its makers set it up | 1× | harness ready |
| **Familiarity gap** = score(`docs`) − score(`offline`) per framework | how much a framework's score depends on the model already knowing it. sinter should be near zero; a large gap for Astro measures the training-data advantage | from the two runs above | report |
| **Renamed clone** (MonkeyEval/BeatNumEval style): e.g. Astro with renamed components, directives, config keys and docs, published under a new name | pure familiarity. Astro vs clone is the training-data effect; clone vs sinter is the fairest learnability comparison, since neither is known | high: a fork plus doc rewriting, once | optional control |
| **Novel task specs, kept private** (LiveCodeBench, SWE-bench-Live) | stops memorised solutions. RealWorld itself is heavily memorised, so T2 changes it with features no implementation has | low | yes: T1 to T3 are new |
| **Several models with different cutoffs** (Haiku, Sonnet, Opus) | whether friendliness holds for weaker models, which have less capacity to learn from docs in context | linear in models | **yes** |
| **Post-cutoff breaking versions** (GitChameleon, CodeUpdateArena) | *prior interference*: models write Svelte 4 in a Svelte 5 project. A cost of familiarity, not a benefit | low | grade for it in the judge |
| **Perplexity probes** (Min-K% Prob) | whether framework idioms were in pretraining | needs logprobs; Claude has none | no |

### The docs each framework gets

Each framework gets only what it publishes itself (`docs/fetch.mjs`, which rebuilds the files):

1. The framework's own documentation written for LLMs, as published, when it fits under the cap.
2. A larger file is cut at the cap, at a page boundary, in its own order.
3. A framework that publishes no such file gets none, and no prompt line.

| framework | file | size |
| --- | --- | ---: |
| sinter | `llms.txt` from the published package, complete. From the release with tiaforge/sinter#45 on, that is the short `llms.txt`: the opening rules, the core reference and an index of `npx sinter docs <topic>` commands. Like Svelte's `llms-small.txt`, it is the LLM file the framework recommends; `llms-full.txt` (59 KB) ships beside it, and `sinter docs` reads from it. Rebuild `docs/sinter.txt` with `docs/fetch.mjs` after that release | 109 KB (0.18.0); 23 KB from #45 |
| SvelteKit | `svelte.dev/llms-small.txt`, the Svelte team's condensed docs for Svelte and SvelteKit, complete. Its `llms-medium.txt` (886 KB) cut at the cap would hold only the Svelte runtime and no SvelteKit | 53 KB |
| Astro | none. Astro published `llms.txt`, `llms-small.txt` and `llms-full.txt` until 2026-04-20, when withastro/docs#13538 removed them in favour of its Docs MCP server. That server is Astro's entry in the `tools` condition | – |

So for Astro, `docs` is the same as `offline`.

Recommended reporting:
- **Headline:** pass rate under `docs`.
- **Next to it:** `cold` (what users get today) and the familiarity gap.

The esoteric-language results (EsoLang-Bench, follow-ups) say compiler and interpreter feedback helps
models with an unknown language far more than written docs. So also log build/check runs and run an
ablation with sinter's diagnostics turned off (`strict: false`, no `sinter check`). That tells whether
sinter's friendliness comes from `llms.txt` or from its errors.

Sources:
- Vercel next-evals-oss: https://github.com/vercel/next-evals-oss (the AGENTS.md vs skills numbers come from secondary reports; unverified)
- Convex evals (with/without guidelines, with web): https://github.com/get-convex/convex-evals
- Angular web-codegen-scorer: https://github.com/angular/web-codegen-scorer
- Svelte AI evals: https://github.com/sveltejs/ai
- Private-library APIs (MonkeyEval, BeatNumEval): https://arxiv.org/abs/2210.17236
- CodeUpdateArena: https://arxiv.org/abs/2407.06249
- GitChameleon 2.0: https://arxiv.org/abs/2507.12367
- EsoLang-Bench: https://arxiv.org/abs/2603.09678
- LiveCodeBench: https://arxiv.org/abs/2403.07974
- Min-K% Prob: https://arxiv.org/abs/2310.16789

### Plan: a renamed SvelteKit (familiarity control, not built yet)

The model knows SvelteKit from training, and it knows neither sinter nor a renamed SvelteKit. So the
gap between SvelteKit and a renamed copy of it measures familiarity alone, with the design held fixed.
The copy here is called "Quartz"; any name with no prior use works.

**The renaming map.** Every public name changes, and so does the shape wherever it is distinctive
(the next table).

| SvelteKit | Quartz |
| --- | --- |
| `svelte`, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, `@sveltejs/adapter-node` | `@qz/core`, `@qz/kit`, `@qz/vite`, `@qz/adapter-node` |
| `sv` (create), `svelte-check`, `svelte.config.js` | `create-quartz`, `qz-check`, `quartz.config.js` |
| `.svelte` | `.qz` |
| `$state`, `$derived`, `$props`, `$effect`, `$bindable`, `$inspect` | `$cell`, `$from`, `$inputs`, `$watch`, `$twoway`, `$peek` |
| `bind:`, `class:`, `use:`, `transition:` / `in:` / `out:`, `style:` | `sync:`, `toggle:`, `with:`, `anim:` / `enter:` / `leave:`, `css:` |
| `src/routes/`, `+page.qz`, `+layout`, `+page.js` / `+page.server.js`, `+server.js`, `+error`, `hooks.server.js` | `src/pages/`, `_view.qz`, `_frame`, `_data.js` / `_data.server.js`, `_endpoint.js`, `_failure`, `_hooks.server.js` |
| `[slug]`, `[...rest]`, `(group)` folders | `{slug}`, `{...rest}`, `((group))` |
| `load`, `actions` (form actions), `fail`, `redirect`, `error` | `fetchData`, `handlers`, `refuse`, `goTo`, `abort` |
| `$app/state`, `$app/navigation`, `$app/forms` (`enhance`), `$env/*`, `$lib` | `qz:app`, `qz:nav`, `qz:forms` (`upgrade`), `qz:env/*`, `~lib` |
| config keys `kit.adapter`, `kit.files`, `kit.paths`, `compilerOptions.runes` | `quartz.server`, `quartz.dirs`, `quartz.urls`, (always on) |

**Shape changes beyond the names.** These are needed so the code doesn't look like Svelte:

| Svelte | Quartz |
| --- | --- |
| `{#if a}…{:else if b}…{:else}…{/if}` | `[[if a]]…[[elif b]]…[[else]]…[[end]]` |
| `{#each items as item, i (item.id)}` | `[[for item, i in items by item.id]]` (word order changed) |
| `{#await p}…{:then v}…{:catch e}…{/await}` | `[[wait p]]…[[done v]]…[[failed e]]…[[end]]` |
| `{@html x}`, `{@const y = …}` | `[[raw x]]`, `[[let y = …]]` |
| `{#snippet name(a)}`, `{@render name(a)}` | `[[part name(a)]]`, `[[show name(a)]]` |

- `{expr}` interpolation and `onclick={…}` attributes stay as they are: JSX and Vue use the same
  shape, so they don't point at Svelte.
- The `<script>`, markup and `<style>` layout of a component also stays (Vue's single-file components
  look the same).
- The props destructuring, `let { a } = $inputs()`, keeps its shape. If the leak check says it still
  gives Svelte away, the next change is `inputs<T>()` without the `$` sigil.

**The translation layer: no fork of the compiler.** A Vite plugin and a preprocessor map Quartz back to
SvelteKit before the real compiler runs.

1. **`@qz/vite`.** It wraps `vite-plugin-svelte` and handles `.qz` files. Its preprocessor
   (`quartz.config.js` → `preprocess`) rewrites the block syntax and the directives in the markup, and
   the rune names in `<script>`. Block syntax goes through a small tokenizer that knows strings,
   comments and nesting. Runes go through an acorn pass that renames only the identifiers in call
   position, so a variable called `cell` stays as it is. Each mapping returns a sourcemap, so the
   compiler's positions point into the `.qz` file.
2. **Routes.** A watcher mirrors `src/pages/` into `.quartz/routes/` with SvelteKit's file names, and
   `kit.files.routes` points there. Imports of `qz:*`, `~lib` and `@qz/*` resolve to the real modules,
   through an alias in the plugin.
3. **The rest** (`@qz/kit`, `@qz/adapter-node`, `create-quartz`, `qz-check`) are thin wrappers that
   re-export, set the config keys and translate.

**Error messages and docs.**
- Compiler errors, warnings, `svelte-check` output and the dev server's overlay pass through a reverse
  map (names, rune names, file names, `svelte.dev/e/<code>` links → `quartz docs <code>`) before they
  are printed.
- Runtime warnings in the browser come from the bundled runtime, so its message strings are rewritten
  in the packed `dist`.
- The docs: Svelte's `llms-small.txt` is rewritten with the same map. Its code samples go through the
  forward translator, and every sample has to compile through Quartz, so the docs and the compiler
  can't drift apart.

**The packages and the local registry.**
- `registry.mjs` serves the `@qz/*` packages.
- Their `dist` is the pinned Svelte and SvelteKit code, minified, with names rewritten in strings and
  file names, and with comments and sourcemaps (which embed the original source) removed.
- Their own `dependencies` point at the real packages under aliases (`npm:` specifiers would show the
  names, so the registry serves them as `@qz/internal-*`).
- What is left on disk:
  - the MIT licence files must keep the original copyright notice, which names Svelte. That's a known,
    accepted leak, so a transcript that reads `LICENSE` is counted;
  - an agent can still `npm install svelte` on its own, which the leak check also counts.

**The leak check: before any agent run, and in every run.**
1. **Probe, before any runs.** Ask Haiku, Sonnet and Opus 10 times each, with a fresh context and no
   tools: "Here is a component and a page from a framework, and an excerpt of its docs: which existing
   framework is this, or is it based on?". The samples are a T1 page in Quartz and 2 KB of the
   rewritten docs.
   - Naming Svelte or SvelteKit counts as a leak.
   - If more than 2 of 10 answers name it, for any model, the disguise has failed. Change the shape
     next, not the names.
2. **During runs.** Every transcript is grepped for `svelte`, `sveltekit`, `\$state(`, `{#each`, `+page`,
   `svelte.dev` and `vite-plugin-svelte`, in the agent's own text and commands (tool output from the
   packages is left out). The agent's files are grepped too, for original syntax that compiles only
   because of a gap in the translator. A run with a hit is reported as leaked, and is not averaged with
   the others.
3. **After runs.** At the end of each run, ask the agent once which framework it thinks this is, and
   report the answers.

**Effort and risks.**
- Effort: about 3–4 days.
  - The translator and the route mirror: 1.5 days.
  - The packages, the rewritten `dist`, the messages and the registry: 1 day.
  - The docs rewrite and the sample compile check: 0.5 day.
  - Porting the T1 and T4 references to Quartz and checking the graders pass them: 0.5–1 day.
- Risks:
  - SvelteKit internals that read file names, such as HMR, error pages and the `+`-prefix checks in
    the router. The route mirror may need to cover more of them than expected.
  - Type declarations (`.d.ts`) are full of the original names, and editors and `qz-check` show them.
  - The leak through structure: the model may recognise Svelte from the component layout even with
    every name changed. That is what step 1 of the leak check is for.
  - Upkeep, which is why everything is pinned to Svelte 5.57.3 and SvelteKit 3.2.0.
  - A translator bug that a SvelteKit agent would never hit would count against Quartz. Running the
    references through it, and the docs-compile check, limit that.

**The smallest first step that shows whether it works** (about 1 day):
- Components, runes and blocks only, plus the route mirror for `_view.qz` and `_data.js`: enough for T1.
- Port the T1 reference and check it passes T1's grader.
- Run the probe (step 1 of the leak check) with all three models. If the disguise holds (2 of 10 or
  fewer for every model), run T1 × 3 with Haiku under `cold` and under `docs`, and compare with the
  SvelteKit rows.
- If it doesn't hold, the result itself is useful: shape alone gives SvelteKit away. Report that, and
  decide whether to go on with deeper shape changes or keep familiarity as a measured gap
  (`docs` − `offline`).

## Protocol

- **Agent:** Claude Code headless (`claude -p`, stream-json transcript).
- **Tools:** Bash, Read, Write, Edit, Glob, Grep, TodoWrite, plus WebFetch and WebSearch under
  `cold`. No subagents, no MCP. `--setting-sources project`, so the user's settings play no part.
- **Models:** the latest of each tier: Haiku 5.5, Sonnet 5.5, Opus 5.5. The harness is model-agnostic;
  adding other agents (Codex, Gemini CLI) means writing another `agent()`.
- **Limits:** $15 and 45 minutes per run. Hitting a limit is graded as is.
- **Repetitions:** at least 3 per cell for any claim (5 is better). Agent runs vary a lot: one cell at
  n=1 is an anecdote.
- **Isolation:** one workspace per run, ports per slot (`4400+slot`, API `3100+slot`), and the agent's
  process group is killed afterwards. Grading happens after the agent exits, on a clean
  install and build.
- **Versions:** the agents install the frameworks themselves. For a comparison round, the local
  registry pins each competitor at the release the earlier rows used (`registry.mjs --pin`: nothing
  newer is served, `latest` points to the pin). For the rounds from 2026-11-14 on:
  - Astro 7.4.12;
  - SvelteKit 3.2.0, with Svelte 5.57.3 (T2's RealWorld base keeps its `^2` range: SvelteKit 2.70.4);
  - Vite 8.3.8.

  sinter is the packed commit (`pack-branch.mjs`). Every run's lockfile records what it got.
- **Refresh:** once sinter and these prompts are crawled, the tasks stop being unseen. Keep a private
  held-out set and rotate it.

```sh
node tasks/t2-realworld/setup.mjs                    # T2 bases → /tmp/llmbench/bases
node run.mjs --tasks t1,t2,t3,t4,t5 --frameworks sinter,astro,sveltekit --models haiku,sonnet,opus --reps 3 --slots 3
node report.mjs /tmp/llmbench/runs/<time>            # tables
```

### Against an unpublished sinter build

To measure a change before it is released, pack it and serve it from a local registry. The agent's
`npm install @tiaforge-ui/sinter` and `npm create sinter` then get that build, as they would after a
release, and everything else still comes from npmjs:

```sh
node pack-branch.mjs <branch or commit>     # sinter and create-sinter, one commit, version 0.18.1
node registry.mjs /tmp/llmbench/registry/*.tgz
node run.mjs --tasks t4 --frameworks sinter --models haiku --registry http://127.0.0.1:4873/ --note "<commit>"
```

The commit goes in each run's `meta.json` (`note`).

**Temporary: temper removed from the starter, for fairness.** `create-sinter`'s template uses temper for
styling, so a sinter agent that runs `npm create sinter` also reads temper's docs and runs `temper check`.
That is work the Astro and SvelteKit agents do not do, and the graders do not score it. Until the
comparison includes styling, runs use a starter without it:

```sh
node pack-branch.mjs <commit> --patch starter/no-temper.mjs
```

The patch changes only the packed copy, never `packages/create`, and fails if the template no longer
matches it. It removes:
- the temper dependencies, its Vite plugin and `temper check`;
- the temper lines in `AGENTS.md` and the README;
- temper's attributes from the markup, which becomes plain HTML with a few lines of plain CSS.

Record it in the run's `--note`.

Each run also gets its own npm cache. `npm create` keeps starters in npx's cache by name and version,
and every branch build is packed as the same version, so a shared cache would hand a run an earlier
build's starter.

## Threats to validity

- **The author's bias.** sinter's authors wrote these tasks, and T1 plays to sinter's strengths
  (optimistic updates, resolved data). T3 is the counterweight. More tasks should come from outside,
  for example from Astro and Svelte users.
- **The DOM contract is unnatural for every framework alike.** It is the price of hidden tests that
  work with any framework.
- **Grading through `npm run preview`.** This penalises an agent that builds a working app it can only
  serve with `npm run dev`. The prompt states it, so it is part of the task.
- **One agent harness.** The results are for Claude Code. Other agents read docs differently.

## Baseline run (2026-11-14)

See [`results/2026-11-14-cold.md`](results/2026-11-14-cold.md).

## Next steps

1. Run the `docs` and `offline` conditions and report the familiarity gap.
2. Use n ≥ 3 per cell.
3. Add an Astro T2 base (hand-written, reviewed by an Astro user) and more tasks (T6 to T8).
4. Ablate sinter's diagnostics.
5. Add a second agent harness.
