# Measuring tools (the evaluation's, stage6-eval.md)

Plain Node scripts; nothing here is imported by sinter. A base checkout beside this one (a `git worktree` at the base
commit, `npm run build` there) is what the A/B and byte comparisons run against.

- `instr.mjs` + `hooks.mjs`: a preload. `node --import bench/tools/instr.mjs bench/astro/run-sinter.mjs <app>` wraps
  `Compiler.prototype` methods (`SN_METHODS`, default `decideFor,settle,prerender,worklist,fileConstants,writtenState`;
  `#1`/`#2` by pass) and `compile()` through a load hook, and prints each one's calls, sum, p25 and median at exit
  (`SN_PHASES=<file>`: JSON lines instead). Wall clock (`SN_CLOCK=cpu`: thread CPU, which ticks at 4 ms on some
  kernels). `SN_COUNT=1` also rewrites a few lines of `dist/compiler/compile.js` to count calls (row bindings run, proxy
  reads, rows walked, templates rendered, `writeFirstPaint` by kind…); a rewrite whose text is gone throws, so update it
  with the code.
- `ab.mjs <rounds> <appA> <appB> [phases…]`: interleaved builds of two apps (each built by the checkout it links),
  per phase p25 / median / mean a call, the median over rounds.
- `prof.mjs <profile> [frame] [n]`: a `--cpu-prof` profile's self and inclusive time by function, under a frame;
  `lines.mjs <profile> <function> [line]`: one function's self time by source line; `pdiff.sh <app> <frame>`: both
  checkouts profiled and the functions that moved.
- `ident.mjs <checkout> <out> [apps…]`: the five benchmark apps at 100 posts and the four examples built with that
  checkout; `ident.mjs --cmp <a> <b>`: two such trees file by file. `check-all.sh`: this checkout's builds against the
  base's (`$WORK/out-base`, made with `ident.mjs $BASE $WORK/out-base`); `check-mail.sh`: sinter-mail's audit pages
  (and the 2,000-element one) against the base's `--keep` trees.
- `mkmail.mjs <checkout> <sinter-mail> <out>`: sinter-mail's three 12-page apps (file email, a generated `GEN`-element
  email, the API route).
- `mem/` (redesign-notes/alloc.md): memory and garbage. `memrun.mjs <checkout> <app>` (with `--expose-gc`): a build with a
  probe plugin, memory after forced collections at the build's hooks (`MEM_SMAPS=1`: RSS by mapping kind,
  `MEM_SNAP=<points>`: heap snapshots); `mempre.mjs` (+ `memhooks.mjs`): a preload, memory after each `compile()`
  (`MEM_GC=k`, `MEM_SNAPN=<n,…>`); `snap.mjs`, `ret.mjs`, `born.mjs`, `root1.mjs`: heap snapshots by type, retainer,
  objects born or died between two snapshots of one process; `heapprof.mjs`: the sampling heap profiler with collected
  objects included (`HP_MAJOR_ONLY=1`: what reaches the old generation), read by `hpsum.mjs` and `hpratio.mjs`;
  `gcsum.mjs`: `--trace-gc` output summed by kind.
