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
| **T4** ops board (hard) | greenfield app | T1 grown up. It adds sign-in with a redirect back to the page first asked for; server-side pagination, search, filter and sort, all in the URL, with Back and Forward working; live updates from other users over SSE; rename with version conflicts (409); undo on delete, with the server delete only after 5 s; optimistic changes with rollback; and a live detail page. | 24 | sinter, SvelteKit |
| **T5** bilingual site (hard) | greenfield static site | T3 grown up. Two languages with partial translations, a paginated index, a series with previous and next links per language, a computed reading time, dates per language, a language switcher with a fallback, `hreflang` alternates, feeds per language and a sitemap, with no JavaScript anywhere. | 15 | Astro |

T2 bases (`tasks/t2-realworld/setup.mjs`):
- sinter: `examples/realworld`.
- SvelteKit: `sveltejs/realworld` at df79670, with the two edits `bench/realworld/fair` makes.
- **Astro has no maintained RealWorld app**, so Astro sits out T2. A hand-written Astro base, reviewed
  by an Astro user, is listed under [next steps](#next-steps).

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
  parallel would skew the timings.

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

The rule is the same for every framework (`docs/fetch.mjs`, which rebuilds the files):

1. The framework's own documentation written for LLMs, as published, when it fits under the cap.
2. Otherwise, that documentation is cut at the cap, at a page boundary, in its own order.

The cap is a maximum, not a quota.

| framework | file | size |
| --- | --- | ---: |
| sinter | `llms.txt` from the published package, complete | 109 KB |
| SvelteKit | `svelte.dev/llms-small.txt`, the Svelte team's condensed docs for Svelte and SvelteKit, complete. Its `llms-medium.txt` (886 KB) cut at the cap would hold only the Svelte runtime and no SvelteKit | 53 KB |
| Astro | Astro's own abridged docs (`llms-small.txt`), rebuilt; see below | 155 KB |

How Astro's file is rebuilt:
- **Why rebuild.** Astro published `llms.txt`, `llms-small.txt` and `llms-full.txt` until 2026-04-20, when withastro/docs#13538 removed them in favour of its Docs MCP server.
- **Settings.** `docs/fetch.mjs` applies that last configuration (its `promote` and `exclude` lists, and starlight-llms-txt's ordering and minify defaults) to the current docs source.
- **Size.** That comes to 839 KB, cut at the cap after 15 of 60 pages, in Astro's own order: the promoted introduction pages, then the guides alphabetically, from Actions to Scripts.
- **Effect.** Astro gets less of its documentation under the cap than the others do. That follows from its documentation's size and order, not from a choice made here. The `tools` condition, with Astro's MCP server, is the counterweight.

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
- **Versions:** each framework resolves to its latest release when the agent installs it. The runs
  record the versions. Pin them in a release of the benchmark.
- **Refresh:** once sinter and these prompts are crawled, the tasks stop being unseen. Keep a private
  held-out set and rotate it.

```sh
node tasks/t2-realworld/setup.mjs                    # T2 bases → /tmp/llmbench/bases
node run.mjs --tasks t1,t2,t3,t4,t5 --frameworks sinter,astro,sveltekit --models haiku,sonnet,opus --reps 3 --slots 3
node report.mjs /tmp/llmbench/runs/<time>            # tables
```

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
