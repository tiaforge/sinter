#!/usr/bin/env bash
# Downloads the compared libraries into vendor/, pinned by version and sha256.
# Datastar 1.x is published on GitHub only (npm stops at 1.0.0-beta.11), hence the gh/ URL.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p vendor
while read -r file url sha; do
  [[ -f vendor/$file ]] && echo "$sha  vendor/$file" | sha256sum -c --quiet 2>/dev/null && continue
  curl -sfL -o "vendor/$file" "$url"
  echo "$sha  vendor/$file" | sha256sum -c --quiet || { rm -f "vendor/$file"; exit 1; }
done <<'EOF'
htmx-2.0.11.min.js https://cdn.jsdelivr.net/npm/htmx.org@2.0.11/dist/htmx.min.js d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717
htmx-4.0.1.min.js https://cdn.jsdelivr.net/npm/htmx.org@4.0.1/dist/htmx.min.js a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130
datastar-1.0.4.js https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.4/bundles/datastar.js 727844adfc825ee651fb93c544a2a739986f9a21820a94524b35f0cac470cf91
EOF
ls vendor
