# Ledger lock scope

Measurements never start in an async context holding the ledger `lock`. The shared command runner (including wrapped commands and timeout diagnostics) and job runner reject that programming error with an internal error before spawning. Worktree add/remove/prune, clean/reset/switch/checkout and arbitrary merge commands are protected too. Opening another Ledger in the same context does not bypass the protection; merge, attest, trunk-refresh and sweep operation locks still permit measurements. Driver cleanup of never-launched slots removes worktrees after releasing the ledger lock.

## Root cause (LKR ruling #2310)

The reported 11-minute Busy windows came from the parent's ipc harness, `/tmp/owed-ipc/remote-owed.sh`, which held the local ledger lock for the entire remote attest/merge to prevent the ledger hash chain from forking. That incident was not caused by owed holding its ledger lock across measurement execution. The ordinary measurement paths already used operation locks with short ledger locks to record results. The new guard enforces this boundary without changing the existing CAS or stale-result rules.

The investigation also found a secondary path: `git.advanceTrunk` invokes `git merge --ff-only` on a checked-out trunk in the final ledger-lock section. Per #2310, this single fast-forward of an already measured commit is explicitly exempted at that call site. The final gate, trunk CAS, fast-forward and observation/merge recording retain their existing order. The user's trunk worktree stays attached throughout the operation; no detach/reattach preparation is performed.

## Compatibility

No new plan keys, CLI flags, ledger kinds, measurement keys or acceptance exceptions. Existing ledgers retain their interpretation. The fast-forward exemption is private to `advanceTrunk`; arbitrary `git merge --ff-only` calls under the ledger lock still fail the guard. Wrapped execution retains its wrapper quoting, environment, timeout freeze and grace/kill behavior.

## Known limits

Merge hooks, including post-merge and reference-transaction hooks, run while the ledger lock is held. A slow hook can therefore delay other ledger writers. The merge lock and machine lease remain held across measurement execution, and this change does not add a general Git command timeout or change torn batch-tail recovery. External harnesses that take the ledger lock must manage their own lock scope; the async-context guard cannot detect a lock held by another process.

No existing test files were changed.
