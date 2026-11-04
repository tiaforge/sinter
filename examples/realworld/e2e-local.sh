#!/usr/bin/env bash
# Runs the official e2e suite against a local RealWorld backend instead of api.realworld.show.
#   API=http://localhost:8000/api CHROME=/path/to/chrome ./e2e-local.sh [playwright args…]
# The app's API URL is a literal in its pages (by design), so a copy is built with it replaced.
# Note: user-fetch-errors.spec.ts mocks https://api.realworld.show itself and cannot pass here;
# run it against the public API instead.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
API=${API:-http://localhost:8000/api}
PORT=${PORT:-4174}
work=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT

curl -sf -o /dev/null "$API/tags" || { echo "no RealWorld API at $API"; exit 1; }
node "$here/e2e-seed.mjs" "$API"

tar -C "$here" --exclude=node_modules --exclude=dist --exclude=test-results --exclude=playwright-report -cf - . | tar -C "$work" -xf -
ln -s "$here/node_modules" "$work/node_modules"
grep -rl 'https://api.realworld.show/api' "$work" --include='*.html' --include='*.js' | grep -v '/e2e/' \
  | xargs sed -i "s#https://api.realworld.show/api#$API#g"
cd "$work"
npx vite build --logLevel error
npx vite preview --port "$PORT" --strictPort > /dev/null 2>&1 &
sleep 2
BASE_URL="http://localhost:$PORT" API_BASE="$API" npx playwright test "$@"
