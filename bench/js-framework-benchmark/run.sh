#!/usr/bin/env bash
# Quick comparison: rebuild sinter and this entry, run sinter against svelte.
#   JFB=<js-framework-benchmark checkout> CHROME=<chrome binary> ./run.sh [benchmark prefixes…] [-- extra runner args]
# Defaults: all CPU benchmarks (prefix 0), 5 iterations. The benchmark server must be running.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
JFB=${JFB:-$here/../../../bench/js-framework-benchmark}
COUNT=${COUNT:-5}
benchmarks=()
while [[ $# -gt 0 && $1 != -- ]]; do benchmarks+=("$1"); shift; done
[[ ${1:-} == -- ]] && shift
[[ ${#benchmarks[@]} -eq 0 ]] && benchmarks=(0)

(cd "$here/../.." && npm run build >/dev/null)
(cd "$here" && npx vite build --logLevel error)
cd "$JFB/webdriver-ts"
node dist/benchmarkRunner.js --headless ${CHROME:+--chromeBinary "$CHROME"} \
  --framework keyed/sinter keyed/svelte --benchmark "${benchmarks[@]}" --count "$COUNT" "$@" > /tmp/sinter-jfb.log 2>&1 \
  || { tail -20 /tmp/sinter-jfb.log; exit 1; }
BASE=svelte ONLY=sinter,svelte node "$here/compare.mjs" results
