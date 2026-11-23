#!/bin/bash
# paths: REPO (this checkout), BASE (the base checkout), WORK (scratch); tools from this script's folder
T=$(cd "$(dirname "$0")" && pwd); REPO=${REPO:-$(cd "$T/../.." && pwd)}; BASE=${BASE:-$REPO/../sinter-base}; WORK=${WORK:-$REPO/..}; MAIL=${MAIL:-$REPO/../tiavision/sinter-html}
# the mail-audit pages (and the 2,000-element one) built with this checkout, compared with the base's
cd $REPO
rm -rf $WORK/mail-cur $WORK/mailgen-cur
node scripts/mail-audit.mjs $MAIL --keep $WORK/mail-cur "$@" | grep -i "identical\|DIFFERENT\|builds"
node scripts/mail-audit.mjs $MAIL --gen 2000 --only file-gen --keep $WORK/mailgen-cur "$@" | grep -i "identical\|DIFFERENT\|builds"
for d in mail mailgen; do for v in off on; do printf "$d $v vs base: "; node $T/ident.mjs --cmp $WORK/$d-base/$v $WORK/$d-cur/$v | tail -1; done; done
