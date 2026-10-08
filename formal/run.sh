#!/usr/bin/env bash
# usage: ./run.sh  -> checks every property in both modes, one TLC run each
set -u
cd "$(dirname "$0")"
PROPS="${PROPS:-JudgedAdvance NegativeWins FailIsDebt BadVisible OnlyHolderContent NoMergeUnderDebt NoBadMerged NothingMerged}"
for mode in ${MODES:-a1 a2 a3}; do
  for p in $PROPS; do
    cfg=runs/$mode-$p.cfg
    cat > $cfg <<CFG
CONSTANTS
  Nodes = ${NODES:-{n1, n2\}}
  Mode = "$mode"
  MaxEpoch = ${EPOCH:-2}
  MaxVersion = ${VER:-2}
INIT Init
NEXT Next
INVARIANT $p
CFG
    out=runs/$mode-$p${TAG:-}.log
    timeout 600 java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -noGenerateSpecTE -workers 4 -deadlock \
      -metadir runs/states-$mode-$p -config $cfg PiDag.tla > $out 2>&1
    rc=$?
    if grep -q "No error has been found" $out; then r=HOLDS
    elif grep -q "is violated" $out; then r=VIOLATED
    else r="ERROR(rc=$rc)"; fi
    states=$(grep -oE '[0-9,]+ distinct states found' $out | tail -1)
    printf '%-3s %-18s %-10s %s\n' $mode $p "$r" "$states"
  done
done
