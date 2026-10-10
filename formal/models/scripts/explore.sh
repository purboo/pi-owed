#!/bin/bash
# owed05 ablation table (run on ipc from formal/ after building): for each guard, the property it protects on the same
# configuration with the guard (baseline) and without it (ablated). Mirrors tests/owed05.rs owed05_ablations_flip_a_property.
# Every run is capped at 8 GB of virtual memory, 20M distinct states and 240 s.
ulimit -v 8000000
S="--const REVIEWS=1 --const MAIN=1 --const ADOPT=false"
row() { # ablation mode property consts...
  local abl=$1 mode=$2 prop=$3; shift 3
  local b a
  b=$(timeout 300 target/release/owedmc check owed05 --mode "$mode" --workers 16 --timeout 240 --max-states 20000000 --prop "$prop" "$@" | grep -E "^owed05 " | awk '{print $4, $5}')
  a=$(timeout 300 target/release/owedmc check owed05 --mode "$mode" --workers 16 --timeout 240 --max-states 20000000 --prop "$prop" "$@" --const ABLATE="$abl" | grep -E "^owed05 " | awk '{print $4, $5}')
  printf '| %s | %s | %s | %s | %s | %s |\n' "$abl" "$mode" "$*" "$prop" "$b" "$a"
}
echo "| ablation | mode | consts | property | baseline (verdict, states) | ablated (verdict, states) |"
row owner-downgrade tools EasingAuthorized $S
row delegated-note tools EasingAuthorized $S
row star-covered tools EasingAuthorized $S --const ALLOW=2
row allow-free tools EasingAuthorized --const REVIEWS=1 --const MAIN=2 --const PLANS=2 --const ADOPT=false
row next-allow,allow-free tools EasingAuthorized $S --const COMBOS=true
row next-allow tools EasingAuthorized $S --const COMBOS=true
row adopt-role tools EasingAuthorized --const REVIEWS=1 --const MAIN=1 --const ADOPT=true
row waive-role forge BlockWins $S
row waive-role forge EasingAuthorized $S
row waive-cites tools BlockWins $S
row dissent tools BlockWins --const REVIEWS=2 --const MAIN=1 --const ADOPT=false
row flaky tools BlockWins $S
row recusal tools NoSelfJudge $S
row evidence-writer tools NoSelfJudge $S --const EVIDENCE=reviewer
row merge-guard tools MergedMeansCovered $S
row inv-guard tools BadMergeTracesToOwner $S
row inv-guard tools MergedMeansCovered $S
row approve-role tools MergedMeansCovered $S --const APPROVE=true
row pin gate ApprovePinned $S --const APPROVE=true
row dsa tools NoSubagentAuthority $S
row invalidate tools MergedMeansCovered $S
row invalidate tools BadMergeTracesToOwner $S
