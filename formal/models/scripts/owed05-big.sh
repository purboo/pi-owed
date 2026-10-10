#!/bin/bash
# owed05 at bigger bounds (run on ipc from formal/ after `cargo build --offline --release -p models`).
# Safety properties and the findings; the liveness property (whole graph kept) only on M1.
# Usage: bash models/scripts/owed05-big.sh [timeout_s per run, default 900] [runs, default all, e.g. "M4 M5"]
# Memory: ~300 bytes per distinct state at these sizes (full frontier states); every run is capped at 40M states (simulation: MS) and
# 14 GB of virtual memory (ulimit) so the shared host never swaps.
T=${1:-900}
ONLY=${2:-}
SAFETY="--prop EasingAuthorized --prop NoSubagentAuthority --prop NoSelfJudge --prop BlockWins --prop MergedMeansCovered --prop BadMergeTracesToOwner"
FIND="--prop ApprovePinned --prop WaivePinned --prop OwnerReviewPinned --prop NoSelfJudgeAtMerge --prop NoSelfJudgeProcess --prop DriveClaimNeverEases"
REPLAY="--prop ReplayAgreesWithOps --prop ReplayAgreesWithOpsOnAuthority"
run() {
  local name=$1; shift
  [ -n "$ONLY" ] && [[ " $ONLY " != *" $name "* ]] && return
  echo "=== $name: $*"
  ( ulimit -v 14000000; /usr/bin/time -f "# time %e s, max RSS %M KB" timeout $((T + 120)) target/release/owedmc check owed05 --workers 16 --timeout "$T" --max-states "${MS:-40000000}" "$@" ) | grep -vE '^# (engine|flags)'
  echo "exit=${PIPESTATUS[0]}"
}
run M1 --mode tools --const REVIEWS=2 --const MAIN=2 --const ADOPT=false $SAFETY $FIND --prop ExecBlockResolves
run M2 --mode tools --const REVIEWS=1 --const MAIN=2 --const ADOPT=true --const ALLOW=7 $SAFETY $FIND
run M3 --mode tools --const REVIEWS=1 --const MAIN=2 --const PLANS=2 --const ALLOW=7 --const APPROVE=true --const EVIDENCE=reviewer --const ADOPT=false $SAFETY $FIND
run M4 --mode forge --const REVIEWS=1 --const MAIN=2 --const FORGE=1 --const ALLOW=7 --const ADOPT=false $SAFETY $FIND $REPLAY
run M4b --mode forge --const REVIEWS=1 --const MAIN=1 --const FORGE=2 --const ALLOW=7 --const ADOPT=false $SAFETY $FIND $REPLAY
run M5 --mode tools --const REVIEWS=1 --const MAIN=2 --const ATTEMPTS=2 --const SUBMITS=3 --const ADOPT=false $SAFETY $FIND
run M6 --mode gate --const REVIEWS=2 --const MAIN=2 --const APPROVE=true --const ADOPT=false $SAFETY $FIND
# The default budgets (REVIEWS=2 MAIN=2 ADOPT=true SUBMITS=2) exceed 80M states and do not fit the memory cap:
# exhaustive runs above split them (M1 reviews x2, M2 adoption); S1/S2 sample far larger budgets.
# deep random walks on a rich configuration (sampled, not a proof)
RICH="--const REVIEWS=3 --const MAIN=4 --const PLANS=3 --const SUBMITS=4 --const ATTEMPTS=2 --const ALLOW=7 --const APPROVE=true --const EVIDENCE=reviewer --const FORGE=3"
MS=2000000000 run S1 --mode tools $RICH $SAFETY $FIND --simulate traces=20000000,depth=60,seed=1
MS=2000000000 run S2 --mode forge $RICH $SAFETY $FIND $REPLAY --simulate traces=20000000,depth=60,seed=2
