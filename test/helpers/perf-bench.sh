# N4 benchmark on ipc: wais ledger copy at ~/owed-test/perf-wais/{owed,repo}. Not a test.
set -u
W=$HOME/owed-test/perf-wais
rm -rf $W/owed/cache
echo "# fill (empty cache)"; OWED_DIR=$W/owed node test/helpers/perf-bench.ts status $W/repo
echo "# warm cache, fresh process"
for i in 1 2 3; do
OWED_DIR=$W/owed node test/helpers/perf-bench.ts status $W/repo
OWED_DIR=$W/owed node test/helpers/perf-bench.ts why $W/repo LY-OWN-SNAPSHOT
done
echo "# hot, one process"; OWED_DIR=$W/owed node --expose-gc test/helpers/perf-bench.ts warm $W/repo 4
echo "# synthetic"; node test/helpers/perf-bench.ts synth ${SYNTH:-10000} 200
