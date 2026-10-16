# Trust, storage and safe retries

Read this topic when the corresponding action or failure is relevant. Return to the [core](../SKILL.md) for the loop and hard rules.

## Safe retries and replay

Repeating an identical latest review, candidate evidence, approve/block or waive on the same open candidate is safe: success with `alreadyRecorded`, no append. Changed acts/new submits are not duplicates; pins and role checks still apply. Scripts identify Busy by exit 75 with stderr `Busy:`, never output text.

Plan/edit/amend may retain invalid legacy writes entries at the original node or allowance position; new invalid entries still refuse and permission/downgrade checks still apply. New plan recording opts into syntax 2; runtime copies retain that dialect without changing plan JSON or its hash.

Unlocked `Ledger.read` ignores a final fragment without newline. An incomplete final atomic decision group is also hidden as a write in flight: readers see the state before that group. Counterfactual reporting uses the same decision-group-aware visibility. Locked reads, verify and malformed complete lines still refuse. Ledger directories are identified by realpath, so a symlink alias of the same ledger preserves lock ownership and strict locked-reader behavior. Other readers/stronger runner restrictions remain backlog; neither tolerance permits editing or accepting damaged ledger data.

## Trust and cleanup

The ledger is shared through the Git common directory. Principal names and subagent environment rails are workflow assertions, not authenticated security identities; same-user shell access can bypass them. Hash verification detects accidental edits, not a malicious rewrite of the chain. Derived plan caches and snapshots are disposable, never acceptance receipts; `owed verify` checks the hash chain and complete replay.

Use parent/owner `owed gc --dry-run` before cleanup. It never removes an open slot, dirty or locked finished worktree, or a worktree containing another worktree. Before deleting finished branches it pins unreachable submitted commits under `refs/owed/keep/<node>/<attempt>/<submit-seq>`, never deleting those pins. A run that removes or pins something appends a `note`; a no-op run records nothing. Follow the returned slot paths and branch templates rather than assuming the default layout.
