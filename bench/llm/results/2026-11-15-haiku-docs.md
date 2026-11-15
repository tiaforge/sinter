# Haiku, docs condition, 2026-11-15

sinter at main 74563f4 (starter without temper, temporary); Astro 7.4.12, SvelteKit 3.2.0 and Svelte 5.57.3, Vite 8.3.8 (pinned); Haiku 5.5; **docs** condition: no web tools, and `framework-docs/` holds sinter's llms.txt (23.6 KB) or Svelte's llms-small.txt (52.8 KB, fetched 2026-11-15). Astro gets nothing, as Astro publishes nothing (SPEC.md § The docs each framework gets). 3 runs per cell, 4 agents in parallel; every run regraded one at a time on an idle machine. The agents' total cost: $11.00.

Notes:
- t4-sveltekit-haiku-docs-r3: the agent finished normally, but its first grading hung for an hour, past the grader's 15-minute timeout. That timeout killed only the `unshare` wrapper (fixed: lib.mjs `run()` now kills the process group). The run was then graded normally in the idle regrade: 25/25.
- t4-sinter-haiku-docs-r2 (6/25): a real miss, checked by hand. The app works (sign-in, a board of 10 per page, paging), but the list items lack `data-testid="incident"`, so every check that waits for the list fails. The agent's own browser suite used other selectors and reported all checks passing.

Graded from `results-regraded.json`. Each cell: median (min–max) over its runs.

## T1 (19 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 19 (19–19) | 56 (31–70) | $0.47 ($0.18–$0.48) | 7 (4–8) | 6.3M (2.6M–6.8M) | 7 (5–12) | 22.3 (22.2–23.2) |
| astro | 3 | 18 (18–19) | 22 (20–31) | $0.05 ($0.04–$0.06) | 4 (3–7) | 1.5M (1.1M–1.6M) | 9 (7–12) | 1.6 (0–1.7) |
| sveltekit | 3 | 19 (19–19) | 35 (28–48) | $0.17 ($0.07–$0.26) | 5 (4–6) | 2.9M (2.0M–3.7M) | 5 (3–5) | 39.1 (38.9–39.3) |

## T2 (13 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 13 (13–13) | 39 (34–41) | $0.17 ($0.10–$0.21) | 4 (3–5) | 3.1M (2.1M–3.2M) | 7 (4–8) | 28.7 (28.7–28.9) |
| sveltekit | 3 | 13 (13–13) | 15 (13–15) | $0.02 ($0.02–$0.03) | 2 (2–2) | 0.6M (0.5M–0.9M) | 2 (1–3) | 44.1 (44.1–44.1) |

## T3 (13 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 13 (13–13) | 35 (27–53) | $0.09 ($0.09–$0.26) | 4 (3–6) | 2.0M (2.0M–4.2M) | 2 (1–3) | 0 (0–0) |
| astro | 3 | 13 (13–13) | 12 (11–21) | $0.02 ($0.01–$0.02) | 2 (1–2) | 0.5M (0.4M–0.5M) | 1 (1–2) | 0 (0–0) |
| sveltekit | 3 | 13 (13–13) | 20 (18–21) | $0.03 ($0.03–$0.04) | 3 (3–3) | 1.1M (1.0M–1.2M) | 3 (3–4) | 0 (0–0) |

## T4 (25 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 25 (6–25) | 70 (53–137) | $0.97 ($0.53–$2.09) | 18 (10–29) | 10.9M (5.6M–28.7M) | 21 (9–23) | 17.3 (17–20.1) |
| astro | 3 | 25 (25–25) | 36 (24–38) | $0.36 ($0.32–$0.46) | 14 (12–17) | 3.9M (2.5M–4.2M) | 13 (12–15) | 1.5 (1.2–5.1) |
| sveltekit | 3 | 25 (23–25) | 62 (40–75) | $0.56 ($0.48–$1.08) | 14 (14–36) | 5.7M (5.0M–10.5M) | 12 (9–12) | 44.4 (37.4–44.6) |

## T5 (15 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 15 (15–15) | 31 (20–39) | $0.16 ($0.11–$0.25) | 5 (4–5) | 2.0M (1.4M–2.9M) | 3 (3–3) | 0 (0–0) |
| astro | 3 | 15 (14–15) | 31 (19–36) | $0.05 ($0.04–$0.05) | 4 (3–4) | 1.3M (1.2M–1.5M) | 2 (0–3) | 0 (0–0) |
| sveltekit | 3 | 15 (15–15) | 43 (27–75) | $0.13 ($0.13–$0.32) | 5 (4–6) | 2.3M (1.6M–4.1M) | 2 (2–4) | 0 (0–0) |

*Minutes are with the agents running in parallel (parallelSlots in meta.json); turns, cost and tokens do not depend on load.

## Failed grader checks

- t1-astro-haiku-docs-r1: search: filters as you type, ignoring case
- t4-sinter-haiku-docs-r2: auth: lasts across a reload and a new tab; auth: user name, sign out, stays signed out; auth: a token that stops working sends you to /login; board: 10 per page, newest first, page count; board: next page in the URL, Back and Forward; board: search is in the URL and does not send a request per keystroke; board: status and sort combine, survive a reload; board: changing a filter goes back to page 1; create: shows without a reload, field cleared; 422 kept; live: an incident created by someone else appears at the top; live: a title and a status changed by someone else; live: an incident deleted by someone else disappears; resolve and reopen: shown at once, saved; resolve: rolled back with an error when refused; rename: shown at once, saved; rename: a conflict is shown with the current title; delete: undo puts it back, nothing deleted; delete: without undo, deleted after 5 seconds; no uncaught page errors
- t4-sveltekit-haiku-docs-r2: board: status and sort combine, survive a reload; rename: a conflict is shown with the current title
- t5-astro-haiku-docs-r2: html lang, titles, markdown
- t1-astro-haiku-docs-r3: search: filters as you type, ignoring case
  - t1-astro-haiku-docs-r1 "search: filters as you type, ignoring case": expected 1, got 5
  - t4-sinter-haiku-docs-r2 "auth: lasts across a reload and a new tab": no incidents listed
  - t4-sinter-haiku-docs-r2 "auth: user name, sign out, stays signed out": no incidents listed
  - t4-sinter-haiku-docs-r2 "auth: a token that stops working sends you to /login": no incidents listed
  - t4-sinter-haiku-docs-r2 "board: 10 per page, newest first, page count": no incidents listed
  - t4-sinter-haiku-docs-r2 "board: next page in the URL, Back and Forward": no incidents listed
  - t4-sinter-haiku-docs-r2 "board: search is in the URL and does not send a request per keystroke": no incidents listed
  - t4-sinter-haiku-docs-r2 "board: status and sort combine, survive a reload": no incidents listed
  - t4-sinter-haiku-docs-r2 "board: changing a filter goes back to page 1": no incidents listed
  - t4-sinter-haiku-docs-r2 "create: shows without a reload, field cleared; 422 kept": no incidents listed
  - t4-sinter-haiku-docs-r2 "live: an incident created by someone else appears at the top": no incidents listed
  - t4-sinter-haiku-docs-r2 "live: a title and a status changed by someone else": no incidents listed
  - t4-sinter-haiku-docs-r2 "live: an incident deleted by someone else disappears": no incidents listed
  - t4-sinter-haiku-docs-r2 "resolve and reopen: shown at once, saved": no incidents listed
  - t4-sinter-haiku-docs-r2 "resolve: rolled back with an error when refused": no incidents listed
  - t4-sinter-haiku-docs-r2 "rename: shown at once, saved": no incidents listed
  - t4-sinter-haiku-docs-r2 "rename: a conflict is shown with the current title": no incidents listed
  - t4-sinter-haiku-docs-r2 "delete: undo puts it back, nothing deleted": no incidents listed
  - t4-sinter-haiku-docs-r2 "delete: without undo, deleted after 5 seconds": no incidents listed
  - t4-sinter-haiku-docs-r2 "no uncaught page errors": no incidents listed
  - t4-sveltekit-haiku-docs-r2 "board: status and sort combine, survive a reload": open by severity: ["Audit log missing entries","Images fail to load in Safari","Rate limiter blocks partners","Export to CSV times out","Status page shows stale data","Mobile app crashes on login","[locked] Database failover drill","Checkout returns 502 for EU customers","Map tiles render blank","Nightly backup took 6 hours"]
  - t4-sveltekit-haiku-docs-r2 "rename: a conflict is shown with the current title": no conflict shown
  - t5-astro-haiku-docs-r2 "html lang, titles, markdown": h2
  - t1-astro-haiku-docs-r3 "search: filters as you type, ignoring case": expected 1, got 5

## sinter: diagnostics that failed a build or check, render and docs

| run | failed builds / checks | SN codes (count) | `sinter render` | `sinter docs` | llms reads | early="off" |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| t1-sinter-haiku-docs-r1 | 0 / 0 | – | 17 | 9 | 8 | – |
| t1-sinter-haiku-docs-r2 | 0 / 0 | – | 13 | 18 | 3 | – |
| t1-sinter-haiku-docs-r3 | 0 / 0 | – | 16 | 13 | 5 | – |
| t2-sinter-haiku-docs-r1 | 0 / 1 | SN504 ×4 | 1 | 3 | 4 | yes |
| t2-sinter-haiku-docs-r2 | 1 / 1 | SN518 ×2, SN504 ×3 | 1 | 3 | 4 | yes |
| t2-sinter-haiku-docs-r3 | 0 / 0 | – | 1 | 6 | 2 | yes |
| t3-sinter-haiku-docs-r1 | 0 / 7 | SN208 ×13 | 0 | 6 | 6 | – |
| t3-sinter-haiku-docs-r2 | 0 / 0 | – | 0 | 4 | 2 | – |
| t3-sinter-haiku-docs-r3 | 0 / 0 | – | 0 | 6 | 3 | – |
| t4-sinter-haiku-docs-r1 | 1 / 0 | SN315 ×2 | 1 | 5 | 7 | – |
| t4-sinter-haiku-docs-r2 | 0 / 0 | – | 26 | 2 | 7 | – |
| t4-sinter-haiku-docs-r3 | 0 / 0 | – | 0 | 10 | 4 | – |
| t5-sinter-haiku-docs-r1 | 0 / 0 | – | 0 | 4 | 2 | – |
| t5-sinter-haiku-docs-r2 | 0 / 0 | – | 0 | 4 | 3 | – |
| t5-sinter-haiku-docs-r3 | 1 / 0 | – | 0 | 2 | 3 | – |

All sinter runs: SN208 ×13, SN504 ×7, SN518 ×2, SN315 ×2.


## The familiarity gap: docs minus cold

Cold is the baseline (2026-11-15-haiku-baseline.md, sinter at f418bd4; sinter between f418bd4 and 74563f4 gained the shared-definition fixes, new SN208 and SN315 hints, and docs fixes, so for sinter the gap mixes in those changes). Medians over 3 runs; cost and turns from the transcripts (`node gap.mjs <docs dir> <cold dir>`).

| task | framework | checks cold → docs | cost cold → docs | Δ cost | turns cold → docs | Δ turns |
|---|---|---|---|---|---|---|
| t1 | sinter | 19/19 → 19/19 | $0.14 → $0.47 | +$0.33 (+247%) | 28 → 56 | +28 (+100%) |
| t1 | astro | 19/19 → 18/19 | $0.03 → $0.05 | +$0.01 (+31%) | 19 → 22 | +3 (+16%) |
| t1 | sveltekit | 19/19 → 19/19 | $0.04 → $0.17 | +$0.13 (+339%) | 20 → 35 | +15 (+75%) |
| t2 | sinter | 13/13 → 13/13 | $0.10 → $0.17 | +$0.08 (+80%) | 31 → 39 | +8 (+26%) |
| t2 | sveltekit | 13/13 → 13/13 | $0.02 → $0.02 | −$0.00 (−18%) | 20 → 15 | −5 (−25%) |
| t3 | sinter | 13/13 → 13/13 | $0.11 → $0.09 | −$0.02 (−21%) | 31 → 35 | +4 (+13%) |
| t3 | astro | 13/13 → 13/13 | $0.02 → $0.02 | −$0.00 (−13%) | 12 → 12 | +0 (+0%) |
| t3 | sveltekit | 13/13 → 13/13 | $0.03 → $0.03 | +$0.00 (+13%) | 26 → 20 | −6 (−23%) |
| t4 | sinter | 25/25 → 25/25 | $0.81 → $0.97 | +$0.16 (+19%) | 59 → 70 | +11 (+19%) |
| t4 | astro | 25/25 → 25/25 | $0.35 → $0.36 | +$0.02 (+5%) | 39 → 36 | −3 (−8%) |
| t4 | sveltekit | 25/25 → 25/25 | $0.54 → $0.56 | +$0.02 (+3%) | 49 → 62 | +13 (+27%) |
| t5 | sinter | 15/15 → 15/15 | $0.28 → $0.16 | −$0.12 (−43%) | 37 → 31 | −6 (−16%) |
| t5 | astro | 15/15 → 15/15 | $0.04 → $0.05 | +$0.00 (+4%) | 17 → 31 | +14 (+82%) |
| t5 | sveltekit | 15/15 → 15/15 | $0.29 → $0.13 | −$0.15 (−54%) | 49 → 43 | −6 (−12%) |

Sums of the medians over the tasks each framework ran (T2 has no Astro base):

| framework | cost cold → docs | turns cold → docs |
|---|---|---|
| sinter | $1.44 → $1.86 (+29%) | 186 → 231 (+24%) |
| astro | $0.44 → $0.47 (+6%) | 87 → 101 (+16%) |
| sveltekit | $0.92 → $0.92 (−0%) | 164 → 175 (+7%) |
