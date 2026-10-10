#!/bin/bash
# Shortest counterexamples of the findings and witnesses (run on ipc from formal/), compact one-line states.
o() { echo "=== $*"; timeout 300 target/release/owedmc check owed05 --workers 16 --timeout 240 --trace "$@" | grep -vE '^# (engine|flags)'; }
S="--const REVIEWS=1 --const MAIN=1 --const ADOPT=false"
o --mode tools $S --prop WaivePinned --prop OwnerReviewPinned --prop NoSelfJudgeProcess
o --mode tools $S --const APPROVE=true --prop ApprovePinned
o --mode tools $S --const ATTEMPTS=2 --prop NoSelfJudgeAtMerge
o --mode forge $S --const ALLOW=2 --prop DriveClaimNeverEases --prop WitnessReplayOnlyPlanClaims --prop WitnessReplayOnlyObs --prop WitnessReplayOnlyUnmeasured
o --mode tools $S --const FAIR=false --prop ExecBlockResolves
o --mode tools $S --prop WitnessNoBadMerge --prop WitnessNoFlakyWaived
