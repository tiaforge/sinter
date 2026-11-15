# Haiku baseline, 2026-11-15

sinter at main f418bd4 (starter without temper, temporary); Astro 7.4.12, SvelteKit 3.2.0 and Svelte 5.57.3, Vite 8.3.8 (pinned); Haiku 5.5, cold; 3 runs per cell, 4 agents in parallel; every run regraded one at a time on an idle machine. T4 has the fixed login API and 25 checks. Five runs were redone after the session disk filled up (see bench/llm/SPEC.md).

Graded from `results-regraded.json`. Each cell: median (min–max) over its runs.

## T1 (19 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 19 (19–19) | 28 (27–55) | $0.14 ($0.10–$0.31) | 4 (4–5) | 2.2M (1.7M–4.6M) | 4 (4–5) | 22.2 (22.1–22.2) |
| astro | 3 | 19 (18–19) | 19 (12–22) | $0.03 ($0.03–$0.04) | 4 (3–4) | 1.1M (0.7M–1.2M) | 6 (5–8) | 1.5 (0–1.7) |
| sveltekit | 3 | 19 (19–19) | 20 (19–29) | $0.04 ($0.04–$0.10) | 4 (3–6) | 1.1M (0.9M–1.7M) | 3 (3–8) | 38.3 (38–38.9) |

## T2 (13 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 13 (13–13) | 31 (30–38) | $0.10 ($0.09–$0.14) | 3 (3–3) | 2.2M (2.0M–2.6M) | 7 (3–8) | 28.6 (28.6–28.7) |
| sveltekit | 3 | 13 (13–13) | 20 (12–21) | $0.02 ($0.02–$0.03) | 2 (2–3) | 0.9M (0.6M–1.1M) | 4 (3–7) | 44 (44–44.1) |

## T3 (13 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 13 (13–13) | 31 (27–38) | $0.11 ($0.08–$0.21) | 4 (3–5) | 2.4M (2.0M–3.3M) | 4 (1–4) | 0 (0–0) |
| astro | 3 | 13 (13–13) | 12 (11–19) | $0.02 ($0.02–$0.02) | 2 (2–2) | 0.5M (0.5M–0.8M) | 3 (2–3) | 0 (0–0) |
| sveltekit | 3 | 13 (13–13) | 26 (14–28) | $0.03 ($0.02–$0.03) | 2 (2–2) | 0.8M (0.7M–0.9M) | 2 (2–3) | 0 (0–0) |

## T4 (25 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 25 (25–25) | 59 (49–71) | $0.81 ($0.65–$0.85) | 15 (15–18) | 8.7M (6.3M–9.0M) | 11 (10–21) | 19.4 (17.2–20.8) |
| astro | 3 | 25 (25–25) | 39 (26–47) | $0.35 ($0.16–$0.37) | 13 (11–17) | 4.2M (2.3M–4.4M) | 14 (10–16) | 1.5 (1.4–69) |
| sveltekit | 3 | 25 (25–25) | 49 (48–72) | $0.54 ($0.49–$0.73) | 12 (10–17) | 5.3M (4.2M–7.7M) | 14 (7–24) | 43.1 (37.1–43.4) |

## T5 (15 checks)

| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sinter | 3 | 15 (15–15) | 37 (30–48) | $0.28 ($0.24–$0.34) | 6 (5–6) | 3.4M (2.7M–3.8M) | 4 (2–8) | 0 (0–0) |
| astro | 3 | 15 (15–15) | 17 (17–23) | $0.04 ($0.04–$0.05) | 3 (3–4) | 1.0M (1.0M–1.5M) | 3 (2–3) | 0 (0–0) |
| sveltekit | 3 | 15 (15–15) | 49 (40–67) | $0.29 ($0.23–$0.38) | 6 (6–7) | 4.5M (4.0M–5.2M) | 4 (1–9) | 0 (0–0) |

*Minutes are with the agents running in parallel (parallelSlots in meta.json); turns, cost and tokens do not depend on load.

## Failed grader checks

- t1-astro-haiku-cold-r3: search: filters as you type, ignoring case
  - t1-astro-haiku-cold-r3 "search: filters as you type, ignoring case": expected 1, got 5

## sinter: diagnostics that failed a build or check, render and docs

| run | failed builds / checks | SN codes (count) | `sinter render` | `sinter docs` | llms reads | early="off" |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| t1-sinter-haiku-cold-r1 | 0 / 0 | – | 5 | 5 | 2 | – |
| t1-sinter-haiku-cold-r2 | 0 / 0 | – | 3 | 8 | 4 | – |
| t1-sinter-haiku-cold-r3 | 0 / 0 | – | 14 | 21 | 9 | – |
| t2-sinter-haiku-cold-r1 | 0 / 0 | – | 0 | 0 | 3 | yes |
| t2-sinter-haiku-cold-r2 | 0 / 0 | – | 0 | 0 | 3 | yes |
| t2-sinter-haiku-cold-r3 | 0 / 0 | – | 0 | 0 | 4 | yes |
| t3-sinter-haiku-cold-r1 | 8 / 0 | SN208 ×3 | 0 | 6 | 2 | – |
| t3-sinter-haiku-cold-r2 | 0 / 0 | SN318 ×5 | 0 | 3 | 3 | – |
| t3-sinter-haiku-cold-r3 | 1 / 0 | SN318 ×1 | 0 | 5 | 3 | – |
| t4-sinter-haiku-cold-r1 | 1 / 0 | SN208 ×8 | 2 | 11 | 7 | – |
| t4-sinter-haiku-cold-r2 | 0 / 1 | SN315 ×3 | 0 | 11 | 6 | – |
| t4-sinter-haiku-cold-r3 | 0 / 0 | – | 0 | 4 | 9 | – |
| t5-sinter-haiku-cold-r1 | 1 / 0 | – | 0 | 4 | 3 | – |
| t5-sinter-haiku-cold-r2 | 0 / 0 | – | 0 | 5 | 1 | – |
| t5-sinter-haiku-cold-r3 | 0 / 0 | – | 0 | 5 | 7 | – |

All sinter runs: SN208 ×11, SN318 ×6, SN315 ×3.

