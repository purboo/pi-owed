# Owner hotfix landing under the merge lock

## User-facing behavior

`owed adopt --commit <c> --note "<why>"` (pi tool `owed_adopt` with `commit`) can land an off-ref owner hotfix without stopping the driver. The trunk ref must still equal the ledger trunk, and the hotfix must descend from that trunk. A waiting adoption publishes the existing adopt-pending marker; a running merge finishes first. If that merge makes the hotfix no longer a fast-forward, adoption refuses before measuring, names the new trunk, and tells the caller to rebase the hotfix and retry with its new commit.

Adoption retains the existing owner authority, or parent authority under an adopt allowance with every changed path checked before measurement or ref advancement. It measures every invariant whose key changes and applies the existing adoption guard. A guard refusal records its observations but does not land the hotfix; its remedy is to fix the hotfix and retry, not to edit trunk directly. An external ref move during measurement discards the stale observations and never overwrites that ref. Abort behavior retains only completed observations under the existing stability rules.

After the guard passes, adoption uses exactly merge's trunk advancement helper before appending the observations and adoption entry together. A checked-out trunk stays attached and is fast-forwarded in its worktree; tracked dirt or obstructing untracked files refuses advancement without discarding user files. If ref advancement fails, nothing is appended. A crash or append failure after advancement leaves the ref ahead of the ledger: recover with `owed adopt --note "<why>"` **without `--commit`** to adopt the now-current ref under the existing guard.

The existing forms (no `--commit`, or a commit already equal to the trunk ref) retain their behavior. An off-ref commit cannot bypass a trunk ref that has moved outside owed.

## CLI flags and plan keys

No new flags or plan keys. The existing `--commit` / tool `commit` accepts the additional off-ref fast-forward form. Help and tool descriptions identify it as driver-safe hotfix landing. `--wait`, the machine lease, and allowance syntax remain unchanged.

## Compatibility

No new ledger kind or optional field; the adoption entry, observations, state keys, and replay validation are unchanged. The ref captured for CAS is private in-memory state and is absent from the public preview and result. Older executors cannot initiate off-ref adoption but can replay its unchanged entries.

## Existing tests and deviations

No existing tests changed. No contract deviations; checked-out trunk advancement deliberately reuses merge's existing `--ff-only` path rather than introducing a different ref/worktree transaction.

## Known limits

Trunk advancement and ledger append are not one filesystem transaction, just as for merge. The recovery above is required after a crash in that interval. All other existing adoption guard, abort, lease, and lock limitations remain in force.
