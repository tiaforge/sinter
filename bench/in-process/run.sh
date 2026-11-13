#!/usr/bin/env bash
# Pages per second with the API in the same app, every layer on one core: sinter-axum (.api(router)),
# Sinter.AspNetCore (its endpoints in-process) and @tiaforge-ui/sinter/server (a wrapped Hono app) on Node
# and Bun. Each API answers with the same recorded JSON (data/). Needs oha and taskset; the server runs
# on core 0, the load generator on cores 2 and 3.
#
#   bench/in-process/run.sh <dist built with SINTER_EMBED=1> <Sinter.AspNetCore InProcess binary> [seconds, default 5]
#   (cargo build --release --example inprocess in packages/sinter-axum; dotnet publish -c Release
#    packages/sinter-aspnetcore/examples/InProcess; npm run build at the root; npm install here)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$here/../..
dist=$1 net=$2 secs=${3:-5}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -r "$dist" "$work/dist"
# the build names the public API; here it is the app's own: same-origin paths
sed -i 's#https://api.realworld.show##g' "$work/dist/sinter-embed.json"
port=4390
for name in ${SERVERS:-axum aspnetcore node bun}; do
  case $name in
    axum) cmd=("$root/packages/sinter-axum/target/release/examples/inprocess" "$work/dist" $port "$here/data") ;;
    aspnetcore) cmd=("$net" "$work/dist" $port "$here/data") ;;
    node) cmd=(node "$here/server.mjs" "$work/dist" $port "$here/data") ;;
    bun) cmd=(bun "$here/server.mjs" "$work/dist" $port "$here/data") ;;
  esac
  taskset -c 0 "${cmd[@]}" >/dev/null 2>&1 &
  pid=$!
  for _ in $(seq 100); do curl -fs "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.1; done
  # the page has its data, or the numbers mean nothing
  curl -fs "http://127.0.0.1:$port/" | grep -q '"tags":\[' || { echo "$name: the page has no data"; kill $pid; continue; }
  for enc in gzip identity; do for page in / /article/article-25; do
    taskset -c 2,3 oha -z 3s -c 32 --no-tui -H "accept-encoding: $enc" "http://127.0.0.1:$port$page" >/dev/null
    out=$(taskset -c 2,3 oha -z ${secs}s -c 32 --no-tui --output-format json -H "accept-encoding: $enc" "http://127.0.0.1:$port$page")
    # a server that died under load answers nothing: no numbers from it
    kill -0 $pid 2>/dev/null || { echo "$name: the server exited under load ($enc $page)"; break 2; }
    node -e 'const r=JSON.parse(process.argv[1]);console.log(process.argv[2].padEnd(11), process.argv[3].padEnd(9), process.argv[4].padEnd(20), "pages/s", String(Math.round(r.summary.requestsPerSec)).padStart(6), " p50", (r.latencyPercentiles.p50*1000).toFixed(1).padStart(5)+" ms", " bytes", Math.round(r.summary.sizePerRequest), JSON.stringify(r.statusCodeDistribution), r.statusCodeDistribution["200"] ? "" : "INVALID: no 200s")' "$out" "$name" "$enc" "$page"
  done; done
  kill $pid; wait $pid 2>/dev/null; sleep 1
done
