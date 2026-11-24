#!/bin/bash
# paths: REPO (this checkout), BASE (the base checkout), WORK (scratch); tools from this script's folder
T=$(cd "$(dirname "$0")" && pwd); REPO=${REPO:-$(cd "$T/../.." && pwd)}; BASE=${BASE:-$REPO/../sinter-base}; WORK=${WORK:-$REPO/..}; MAIL=${MAIL:-$REPO/../tiavision/sinter-html}
# builds every app with $REPO's dist and compares with the base; then the mail pages
set -u
OUT=$WORK/out-cur; rm -rf $OUT
cd $REPO
node $T/ident.mjs $REPO $OUT "$@" > /tmp/ident.log 2>&1 || { cat /tmp/ident.log; }
grep -v " 0 [0-9]* ms $" /tmp/ident.log
for a in $(ls $OUT); do printf "%-18s " $a; node $T/ident.mjs --cmp $WORK/out-base/$a $OUT/$a | tail -1; done
