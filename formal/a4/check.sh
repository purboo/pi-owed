#!/usr/bin/env bash
# usage: ./check.sh MODULE "mode1 mode2" "Inv1 P:Temporal2" "CONST1 = v; CONST2 = v" [tag]
#   - cfg uses SPECIFICATION Spec (module must define Spec, with fairness if liveness is checked)
#   - property names prefixed with "P:" are checked as PROPERTY (temporal/action), else INVARIANT
#   - deadlock IS checked unless NODEADLOCK=1 (a deadlock = a frozen state; report it, don't hide it)
#   - every log starts with the sha256 of the module and of this cfg, so results stay attributable
#   - SIMULATE="num=200000" (optional) runs TLC random simulation (-simulate <spec> -depth ${DEPTH:-12}) instead of
#     exhaustive BFS: for state spaces too large to exhaust; "HOLDS" then means "no violation in the sampled traces"
#   - exit status of this script = number of runs that ended in ERROR (property results are in the printed table)
#   - outputs: runs/<MODULE>-<mode>-<prop><tag>.{cfg,log}; counterexample traces stay in the log
set -u
cd "$(dirname "$0")"
mkdir -p runs
mod=$1; modes=$2; props=$3; consts=$4; tag=${5:-}
dl=""; [ "${NODEADLOCK:-0}" = 1 ] && dl="-deadlock"
sim=""; [ -n "${SIMULATE:-}" ] && sim="-simulate $SIMULATE -depth ${DEPTH:-12}"
errs=0
for mode in $modes; do
  for p in $props; do
    kind=INVARIANT; name=$p
    case $p in P:*) kind=PROPERTY; name=${p#P:};; esac
    base=runs/$mod-$mode-$name$tag
    { echo "CONSTANTS"; echo "  Mode = \"$mode\""
      echo "$consts" | tr ';' '\n' | sed 's/^ */  /'
      echo "SPECIFICATION Spec"; echo "$kind $name"; } > $base.cfg
    { echo "# module sha256 $(sha256sum $mod.tla | cut -c1-64)"
      echo "# cfg    sha256 $(sha256sum $base.cfg | cut -c1-64)"
      echo "# flags  ${dl:-<deadlock checked>} ${sim:-<exhaustive>} $(date -Is)"; } > $base.log
    timeout ${TLC_TIMEOUT:-1800} java -Xmx${TLC_HEAP:-5g} -XX:+UseParallelGC -cp ../tla2tools.jar tlc2.TLC \
      -noGenerateSpecTE -workers ${WORKERS:-4} $dl $sim \
      -metadir $base.states -config $base.cfg $mod.tla >> $base.log 2>&1
    rc=$?; rm -rf $base.states
    if [ $rc -eq 124 ]; then r=TIMEOUT; errs=$((errs+1))
    elif grep -q "No error has been found" $base.log; then r=HOLDS
    elif grep -qE "is violated|was violated|Deadlock reached|Temporal properties were violated" $base.log; then r=VIOLATED
    elif [ -n "$sim" ] && [ $rc -eq 0 ] && grep -qE "^Finished in " $base.log && ! grep -q "^Error" $base.log; then r=HOLDS-SIM
    else r="ERROR(rc=$rc)"; errs=$((errs+1)); fi
    printf '%-16s %-6s %-22s %-9s %s\n' $mod $mode $name "$r" "$(grep -oE '[0-9,]+ distinct states found' $base.log | tail -1)"
  done
done
exit $errs
