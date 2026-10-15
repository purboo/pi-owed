# ER — clean rebase review carry and executor rebase

Scope: clean rebase review inheritance and executor rebase. No new plan keys or version/publication changes; the existing manual rebase route remains available.

## Behavior

- `submit` can carry review and closure-review receipts only from this open attempt's previous candidate. All required counts/ranks must be satisfied by independent OK reviews, not waivers or blocked judgments. Git computes `merge-tree --write-tree --merge-base <C.base> <new base> <C.commit>`; carry requires exit 0 and tree exactly equal to C-prime's tree. Context/patch keys may change; substantive edits and conflict resolutions never get carry. Plan carry and repeated clean rebases retain original review seqs. Checks, red/strength and invariant observations are not copied; their usual exact keys still govern. Later rulings still require acknowledgment.
- Receipts show `review carried from <C> (#seq, …) across a clean rebase onto <base>`. The review epoch crosses explicit clean-carry transitions, preventing repeated reviewer calls.
- Automatic executor rebase requires a recorded writer launch, no writer launch/follow-up intent after the latest submit, a freshly inspected sealed current generation, a clean worktree without Git operations in progress, and HEAD equal to that candidate. It runs `git rebase --onto <current trunk> <merge-base(HEAD, current trunk)>` using SB2's upstream advance (so trunk commits already merged into the writer branch are not replayed), then appends adjacent rebase + executor submit. The normal driver measures the resulting keys. Later writer follow-ups say `owed rebased your worktree onto <base> (clean); continue from HEAD`.
- `owed rebase <node> --apply` is parent/owner-only. With a recorded writer run it requires sealed/current; without one the parent/owner explicitly asserts no writer is active, and the one-line result says so. Manual/dirty/live/unknown/noncandidate automatic slots keep the writer route.
- Conflict/error/stale results abort and restore original HEAD (and prove a clean tree) before a fallback is recorded. Rebase execution is bounded at 60 seconds; abort/reset at 15 seconds. A crash/SIGKILL cannot run cleanup: in-progress directories or a clean but moved HEAD are left for the writer, not silently reset. In-progress messages offer abort; moved HEAD messages offer keep (inspect slot-base..HEAD, focused tests, submit) or reset to latest submit and rebase. The reset command computes `git merge-base HEAD <new base>` after reset, rather than reusing the moved HEAD's upstream. Status preserves NY7: aligned clean HEAD is not drift. The driver separately inspects recovery and sends it once per recorded base/rebase-follow-up rule.

## Writers, locks and persistence

- Per-node operation lock `rebase-<sha256(node)[0:16]>` precedes the ledger lock. `ops.rebase`, `ops.launch`, `ops.send` share it; they refuse inverted ledger-lock nesting. Waits use the bounded existing ledger timeout. Driver busy launch/send/rebase outcomes retry next pass without halting.
- All owed writer intents reach `ops.launch` / `ops.send`: driver launch/send (including replay), rule --writer follow-up, decide's recorded launch/send actions, and resume follow-ups. Locks cover the intent append; dsa/Git mutations and merge-tree work stay outside the ledger lock.
- The executor rereads state under its op lock, snapshots candidate/base/plan, mutates Git, recomputes facts, proves ancestor relation and clean HEAD, then CAS-validates state and atomically appends adjacent receipts. A competing ruling/plan/candidate/slot/trunk change is validated or rejected; rejected stale execution restores the owned HEAD rather than recording stale facts. A read-only Git check is performed immediately before the append lock.
- Direct dsa sends or Git writes outside owed are not serialized by owed's operation lock. Fresh current-generation inspection and pre-submit clean/HEAD recheck are the guards; this is not a promise of crash-safe automatic recovery or immunity to arbitrary external writes.

## Compatibility

- New optional `submit.facts.carry: {from: string, reviews: number[]}`. Strict replay checks exact object fields, full commit syntax, distinct safe nonnegative seqs, previous same-attempt candidate commit, eligible OK review keys/counts/ranks, and no active review block. Plan carry can retain this provenance in derived candidate state without fabricating another clean merge assertion.
- New optional `submit.facts.rebased: true`. Only `executor:owed`, immediately after a rebase of the same open attempt, on exactly that base. The executor measured `merge-base --is-ancestor <base> <commit>`; this is the same trusted Git-facts boundary as existing candidate facts. Writer/other-principal markers, false values, mismatched/nonadjacent receipts and merge-facts markers are rejected. Existing executor plan carry remains distinct via numeric `submit.carry`.
- `RebasePending.recovery`, `ReceiptCard.reviewCarried` and additional `RebaseResult` output fields are derived/API metadata, not ledger fields. Old entries without the two optional submit fields replay unchanged. No migration.

## Decisions / deviations (parent approved)

- Ruling 1: object lives in `facts.carry`, not existing numeric `submit.carry`; ancestor fact is `facts.rebased: true`.
- Rulings 2–3: automatic no-launch slots use the writer route; explicit parent/owner --apply without a launch is caller-authorized. Per-node lock covers all launch/send entry points.
- Ruling 4: no persistent crash journal; normal failures roll back, crash leftovers use the writer route.
- Ruling 5: NY7 status convention remains unchanged; aligned unsubmitted HEAD recovery is driver-only, once, with keep/reset choices.
- New behavioral regressions use real Git fixtures, CLI/ops/views/replay and bounded fake dsa adapters. On integration with SB2, existing pure-driver tests in `test/drive-order.test.ts` and `test/drive.test.ts` change only the fallback command text expectations from a recorded old base to `$(git merge-base HEAD <new base>)`; routing, conflict-list and ruling assertions remain intact. SB tests are unchanged.

