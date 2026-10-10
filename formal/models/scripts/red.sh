#!/bin/bash
# Cargo variant of /tmp/owed-ipc/red.sh: base tree + candidate test files, run the plan's check command on ipc.
# The remote cargo run is capped at 8 GB of virtual memory (ulimit -v) and the given timeout.
set -uo pipefail
WT=$(cd "$1" && pwd); BASE=$2; T=$3; EXP=$4; shift 4
NAME=$(basename "$WT")-red; LOG=/tmp/owed-ipc/logs/$NAME-$(date +%H%M%S).log
ssh ipc "rm -rf ~/owed-test/red/$NAME && mkdir -p ~/owed-test/red/$NAME"
git -C "$WT" archive "$BASE" | ssh ipc "tar -x -C ~/owed-test/red/$NAME"
for f in "$@"; do ssh ipc "mkdir -p ~/owed-test/red/$NAME/$(dirname "$f")"; nice -n 19 rsync -a "$WT/$f" "ipc:owed-test/red/$NAME/$f"; done
ssh ipc "cd ~/owed-test/red/$NAME && . ~/owed-test/env.sh && . ~/.cargo/env && ulimit -v 8000000 && ls -R formal | head -20 && git init -q -b main && git add -A && git commit -qm base && timeout -k 15 $T cargo test --offline --release --manifest-path formal/Cargo.toml -p models -- owed05" > "$LOG" 2>&1
rc=$?
if [ $rc -ne 0 ] && grep -qE "$EXP" "$LOG"; then echo "red=shown exit=$rc log=$LOG"; else echo "red=NOT-shown exit=$rc log=$LOG"; fi
