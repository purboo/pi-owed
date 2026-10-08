#!/usr/bin/env bash
# usage: ./check.sh MODULE "mode1 mode2" "Prop1 Prop2" "CONST1 = v; CONST2 = v" [tag]
set -u
cd "$(dirname "$0")"
mod=$1; modes=$2; props=$3; consts=$4; tag=${5:-}
for mode in $modes; do
  for p in $props; do
    base=runs/$mod-$mode-$p$tag
    { echo "CONSTANTS"; echo "  Mode = \"$mode\""
      echo "$consts" | tr ';' '\n' | sed 's/^ */  /'
      echo "INIT Init"; echo "NEXT Next"; echo "INVARIANT $p"; } > $base.cfg
    timeout ${TLC_TIMEOUT:-1800} java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -noGenerateSpecTE -workers 8 -deadlock \
      -metadir $base.states -config $base.cfg $mod.tla > $base.log 2>&1
    rc=$?; rm -rf $base.states
    if grep -q "No error has been found" $base.log; then r=HOLDS
    elif grep -q "is violated" $base.log; then r=VIOLATED
    else r="ERROR(rc=$rc)"; fi
    printf '%-14s %-5s %-20s %-10s %s\n' $mod $mode $p "$r" "$(grep -oE '[0-9,]+ distinct states found' $base.log | tail -1)"
  done
done
