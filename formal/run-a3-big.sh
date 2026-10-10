#!/bin/bash
# The big a3 runs of REPORT-mc-port.md (run on ipc from formal/: bash run-a3-big.sh). Each command is bounded.
set -u
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/target}
cargo build -q --offline --release -p models --bin owedmc --examples || exit 1
B=$CARGO_TARGET_DIR/release
run() { echo "+ $*"; /usr/bin/time -f "# time %es maxrss %MkB" "$@"; echo "# rc=$?"; }
# Free authority exhaustive, MaxLog=3 (TLC: AllSafety HOLDS, 9,305,311 distinct, 10 min 41 s at 16 workers).
run $B/owedmc check a3_auth --mode a3 --const Scope=free --const MaxLog=3 --prop AllSafety --deadlock --workers 16 --timeout 1800
# The a22 free sanity checks at MaxLog=4 (TLC 4 workers: VIOLATED; deadlock impossible by construction, see report).
run $B/owedmc check a3_auth --mode a22 --const Scope=free --const MaxLog=4 --prop AuthoritySound --prop DecisionAuthority --prop NoWriterJudge --workers 16 --timeout 1800 --trace
# Free authority simulation, MaxLog=6, depth 8 (TLC: >1,043,507 traces without a violation, stopped at 900 s).
run $B/owedmc check a3_auth --mode a3 --const Scope=free --const MaxLog=6 --prop AllSafety --deadlock --simulate traces=2000000,depth=8,seed=1 --workers 16 --timeout 1800
run $B/owedmc check a3_auth --mode a3 --const Scope=free --const MaxLog=8 --prop AllSafety --deadlock --simulate traces=200000,depth=8,seed=2 --workers 16 --timeout 1800
# Free merge simulations, depth 20 (TLC ruling-free runs).
run $B/owedmc check a3_merge --mode a3 --const Scenario=free --prop FreeCoreSafety --deadlock --simulate traces=400000,depth=20,seed=1 --workers 16 --timeout 1800
run $B/owedmc check a3_merge --mode a22 --const Scenario=free --prop EscapeAttributable --deadlock --simulate traces=400000,depth=20,seed=1 --workers 16 --timeout 1800
for p in NoBypassedNegative NodeAcceptanceCovered; do
  run $B/owedmc check a3_merge --mode a22 --const Scenario=free --prop $p --deadlock --simulate traces=8000,depth=20,seed=1 --workers 16 --timeout 600
done
for p in NothingMerged NoDeferredMerge FreeNoTwoMerges; do
  run $B/owedmc check a3_merge --mode a3 --const Scenario=free --prop $p --deadlock --simulate traces=8000,depth=20,seed=1 --workers 16 --timeout 600
done
# Every row of reference/a3/tlc-runs.tsv incl. the heavy ones and the full simulation sizes.
run $B/examples/a3_compare --heavy --workers 16 --sim-timeout 600 > a3-compare.tsv
cat a3-compare.tsv
