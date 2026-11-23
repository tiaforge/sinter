#!/bin/bash
# paths: REPO (this checkout), BASE (the base checkout), WORK (scratch); tools from this script's folder
T=$(cd "$(dirname "$0")" && pwd); REPO=${REPO:-$(cd "$T/../.." && pwd)}; BASE=${BASE:-$REPO/../sinter-base}; WORK=${WORK:-$REPO/..}; MAIL=${MAIL:-$REPO/../tiavision/sinter-html}
# pdiff.sh <app-rel-path> <frame> : cpu profile of base and cur, diff by function
APP=$1; F=$2
for v in base cur; do d=$WORK/pb-$v; rm -rf $d; R=$REPO; [ $v = base ] && R=$BASE; (cd $R && node --cpu-prof --cpu-prof-dir=$d --cpu-prof-interval 50 bench/astro/run-sinter.mjs $APP >/dev/null 2>&1); node $T/prof.mjs $d/*.cpuprofile $F 80 > /tmp/p-$v.txt; done
head -1 /tmp/p-base.txt /tmp/p-cur.txt
python3 - <<'PY'
def load(f):
    d={}; sec=None
    for l in open(f):
        l=l.rstrip()
        if l.startswith('-- '): sec=l[3:]; continue
        if sec and l.strip():
            parts=l.split(None,1)
            try: v=float(parts[0])
            except: continue
            name=parts[1].rsplit(':',1)[0]
            d[(sec,name)]=d.get((sec,name),0)+v
    return d
a=load('/tmp/p-base.txt'); b=load('/tmp/p-cur.txt')
keys=set(a)|set(b)
rows=sorted(keys,key=lambda k:-(abs(b.get(k,0)-a.get(k,0))))
for k in rows[:28]: print(f"{k[0]:9} {a.get(k,0):7.1f} {b.get(k,0):7.1f} {b.get(k,0)-a.get(k,0):+7.1f} {k[1]}")
PY
