#!/bin/bash
# The big a3 runs of REPORT-mc-port.md (run on ipc from formal/: bash run-a3-big.sh). Each command is bounded.
# Like models/scripts/owed05-big.sh, every run is capped so the shared host never swaps: 8 GB of virtual memory
# (ulimit -v 8000000), an explicit state cap (exhaustive runs: MS, default 22M distinct states, more than twice the
# largest run here, 9.3M states at 1.7 GB RSS; simulations: SMS, sampled states, default 2e9 so that the walk count is
# the bound) and the model checker's --timeout, plus a wall-clock `timeout` 120 s above it. A run stopped by a cap
# reports TIMEOUT (no verdict), never HOLDS.
set -u
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$PWD/target}
cargo build -q --offline --release -p models --bin owedmc --examples || exit 1
B=$CARGO_TARGET_DIR/release
MS=${MS:-22000000}
SMS=${SMS:-2000000000}
# run <wall_s> <command...>: the command under the memory cap and a wall-clock timeout (rc 124); the command line,
# time, RSS and rc go to stderr, so a redirected stdout holds only the command's output.
run() {
  local wall=$1; shift
  echo "+ $*" >&2
  ( ulimit -v 8000000; /usr/bin/time -f "# time %es maxrss %MkB" timeout "$wall" "$@" ); echo "# rc=$?" >&2
}
check() { local t=$1; shift; run $((t + 120)) $B/owedmc check "$@" --workers 16 --timeout "$t"; }
# Free authority exhaustive, MaxLog=3 (TLC: AllSafety HOLDS, 9,305,311 distinct, 10 min 41 s at 16 workers).
check 1800 a3_auth --mode a3 --const Scope=free --const MaxLog=3 --prop AllSafety --deadlock --max-states "$MS"
# The a22 free sanity checks at MaxLog=4 (TLC 4 workers: VIOLATED; deadlock impossible by construction, see report).
check 1800 a3_auth --mode a22 --const Scope=free --const MaxLog=4 --prop AuthoritySound --prop DecisionAuthority --prop NoWriterJudge --max-states "$MS" --trace
# Free authority simulation, MaxLog=6, depth 8 (TLC: >1,043,507 traces without a violation, stopped at 900 s).
check 1800 a3_auth --mode a3 --const Scope=free --const MaxLog=6 --prop AllSafety --deadlock --simulate traces=2000000,depth=8,seed=1 --max-states "$SMS"
check 1800 a3_auth --mode a3 --const Scope=free --const MaxLog=8 --prop AllSafety --deadlock --simulate traces=200000,depth=8,seed=2 --max-states "$SMS"
# Free merge simulations, depth 20 (TLC ruling-free runs).
check 1800 a3_merge --mode a3 --const Scenario=free --prop FreeCoreSafety --deadlock --simulate traces=400000,depth=20,seed=1 --max-states "$SMS"
check 1800 a3_merge --mode a22 --const Scenario=free --prop EscapeAttributable --deadlock --simulate traces=400000,depth=20,seed=1 --max-states "$SMS"
for p in NoBypassedNegative NodeAcceptanceCovered; do
  check 600 a3_merge --mode a22 --const Scenario=free --prop $p --deadlock --simulate traces=8000,depth=20,seed=1 --max-states "$SMS"
done
for p in NothingMerged NoDeferredMerge FreeNoTwoMerges; do
  check 600 a3_merge --mode a3 --const Scenario=free --prop $p --deadlock --simulate traces=8000,depth=20,seed=1 --max-states "$SMS"
done
# Every row of reference/a3/tlc-runs.tsv incl. the heavy ones and the full simulation sizes. a3_compare has no state
# cap of its own: its exhaustive rows are the fixed TLC configurations (largest 9.3M states, above), its simulations
# stop at --sim-timeout; the memory cap and a 1 h wall clock bound the whole comparison (169 s when published).
run 3600 $B/examples/a3_compare --heavy --workers 16 --sim-timeout 600 > a3-compare.tsv
cat a3-compare.tsv
