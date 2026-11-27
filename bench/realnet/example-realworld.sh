#!/bin/bash
# The worked example (README.md): RealWorld's home page over HTTP/2 and HTTP/1.1, rounds interleaved, on a 1.6 Mbit/s
# path with a 150 ms round trip emulated in the browser and 4x CPU, cold cache. nginx serves examples/realworld's build
# and sends the API host (api.realworld.show, resolved to nginx in the browser) to bench/realworld's mock API.
#   sudo bench/realnet/example-realworld.sh [rounds, default 4] [default|tuned]
# Builds examples/realworld first if it has no dist/. Everything it starts is stopped and the namespace removed on exit.
set -u
D=$(dirname "$(realpath "$0")"); REPO=$(realpath "$D/../..")
ROUNDS=${1:-4}; MODE=${2:-default}
ADDR=${REALNET_NET:-10.77.0}.1; H2=${REALNET_H2:-8443}; H1=${REALNET_H1:-8444}
STATE=${REALNET_STATE:-${TMPDIR:-/tmp}/sinter-realnet}; mkdir -p "$STATE"
OUT=${OUT:-$STATE/realworld.jsonl}
MOCK=''
cleanup() { "$D/nginx.sh" stop; [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null; "$D/realnet.sh" down >/dev/null; }
trap cleanup EXIT

if [ ! -f "$REPO/examples/realworld/dist/index.html" ]; then
  (cd "$REPO/examples/realworld" && { [ -d node_modules ] || npm ci; } && npx vite build) || exit 1
fi
# the mock API's plain-HTTP side (bench/realworld/mock-api.mjs), on the host's loopback for nginx to proxy to
node -e "import('$REPO/bench/realworld/mock-api.mjs').then(async (m) => { const a = await m.mockApi(); console.log(a.http); })" > "$STATE/mock.url" &
MOCK=$!
for _ in $(seq 50); do [ -s "$STATE/mock.url" ] && break; sleep 0.2; done
BACKEND=$(sed 's#http://##' "$STATE/mock.url")
"$D/realnet.sh" up 1600kbit || exit 1
"$D/nginx.sh" start "$REPO/examples/realworld/dist" "$BACKEND" "$([ "$MODE" = tuned ] && echo tuned)" || exit 1
rm -f "$OUT"
load() {  # protocol port
  "$D/realnet.sh" exec node "$D/timeline.mjs" "https://$ADDR:$2/" --rtt 150 --throttle 4 --data '.tag-list .tag-pill' \
    --host-map "api.realworld.show=$ADDR:$2,code.ionicframework.com=$ADDR:$2,fonts.googleapis.com=$ADDR:$2" --label "$MODE $1" --json "$OUT"
}
for r in $(seq "$ROUNDS"); do
  if [ $((r % 2)) = 1 ]; then load h2 "$H2"; load h1 "$H1"; else load h1 "$H1"; load h2 "$H2"; fi
done
node "$D/summary.mjs" "$OUT"
