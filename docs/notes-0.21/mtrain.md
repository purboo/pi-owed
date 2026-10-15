# MT: batch merge (merge train) — node `mtrain` (0.21.0)

Accepted nodes no longer have to wait in a strictly serial merge queue: with `drive.merge_batch: N` (N >= 2) the
driver merges up to N accepted, non-overlapping nodes as one batch, measures the invariants once and advances trunk
once.

## Plan key
- `drive.merge_batch: N` — integer 1..8, default 1 (off). Not part of any obligation key. Any other value is a plan
  error `drive.merge_batch: expected integer 1..8`.

## CLI
- `owed merge A,B[,C...]` (parent/owner; `--no-lease` as for `owed merge`) merges the listed nodes as one batch. It
  works whatever `drive.merge_batch` says; the driver batches only when it is >= 2.
- Members are taken in merge-queue order. Every member must be accepted (an `approve: owner` is then no longer pending),
  must not touch the closure and must not have an owed `--remeasure`; the members' writes must not overlap pairwise (the
  same overlap rule as dispatch). Otherwise the command refuses and names the member and the next command
  (`batch merge refused: e touches the closure; merge it alone: owed merge e`).
- Receipt: one line per member merge entry (`merged a → <Mi> (batch of 3 → <Mn>)`), conflicting members
  (`Not batched (conflict; merge alone after a rebase): c`), then `Trunk advanced to <Mn> (batch of 3: a, b, c)`.

## Semantics
- Build M1 = merge(T, c1), Mi = merge(M(i-1), ci). A member that conflicts drops out of the batch and merges alone later
  (it needs a rebase as now). Fewer than 2 members left: refused, nothing recorded.
- Measured once on Mn: every invariant (keys on Mn) and every member's node checks (keys computed on Mn, closure of Mn,
  quarantine with every member counted as merged). Genesis jobs as now. Keys that already have a verdict are reused.
- Pass: under the ledger lock with CAS on the plan, the ledger trunk, every member's slot and candidate and the trunk
  ref, the observations and one `merge` entry per member are appended in order (member i: prior M(i-1), commit Mi,
  facts against M(i-1) as now), and the trunk ref moves once from T to Mn. Intermediate Mi are never a trunk head.
- Each batch merge entry carries `batch: { final: <Mn>, state: <StateFacts of Mn>, keys: <member's check keys on Mn>,
  members: [ids] }`. Its merge guard evaluates invariant items on `batch.state` and merge-tree check items on
  `batch.keys`; base, accepted, blocks, writes and rulings are judged as for a single merge. The last member's `commit`
  and `state` equal `batch.final`/`batch.state`; a non-last member never merges `batch.final`.
- Fail: the observations are appended with `batch: [ids]` and without `merging` (attributed to no member; they never
  add a block and never count as a decoy catch or as a trunk observation for failure signatures). The merge is refused:
  `batch merge of a, b refused on batch tree <Mn>: <subject/obligation: failure>; ...; the members merge one at a time
  next (owed merge a)`. The same member set is not batched again until trunk moves (`owed merge a,b` refuses with
  `already failed on trunk`, status plans no batch). A failure that also fails on a single-member merge tree is
  attributed as now (when the single tree has the same content the batch observation is reused on that key).
- Driver: when `drive.merge_batch` >= 2 and the head of the merge queue is batchable, the merge action of the head runs
  the batch (its `started` line ends `— batch of N: a, b, c`); all members report `merged`. A refused batch is a
  `retry` line (`batch merge refused (...); a, b merge one at a time from the next pass`), never a halt; the driver
  then merges the members singly in queue order and handles their refusals as now.

## Status
- `owed status --full`: `Merge queue: a, b, c; batch of 3: a, b, c` when the driver would merge a batch next.
- `owed status --json`: `mergeBatch: [ids]` (absent when no batch is planned).

## Ledger fields (no new entry kind)
- `merge.batch?: { final, state, keys, members }`.
- `obs.batch?: string[]` (members; never with `merging`, `probe` or `attribution`; a node subject must be a member).

## Compatibility
- An owed older than 0.21 refuses to replay a ledger with an `obs.batch` field (`needs a newer owed`). A batch `merge`
  entry it would replay without `batch` is misjudged: its guard looks at the intermediate tree Mi, which was never
  measured. Batch merges happen only through `owed merge A,B` or `drive.merge_batch >= 2` (opt-in): upgrade every
  driver, CLI and pi plugin to 0.21 before enabling it.

## Known limits
- "Not batched again until trunk moves" is derived from a recorded batch failure observation. A batch refused without a
  new failing observation (e.g. every key already had a verdict, or a guard reason) is remembered only by the running
  driver; status may still show that batch, and `owed merge A,B` refuses again with the same reason.
- A plan change during the batch measurement refuses the batch (`Plan, candidate or trunk changed; retry`) instead of
  keeping the still-current observations as single merges do; the driver then merges the members one at a time.
- Batch members are never bisected; after a batch failure each member is measured on its own merge tree.

## Tests
- `test/mtrain.test.ts` (8 tests): plan key; CLI batch of 3 (one invariant run on Mn, 3 merge entries, one trunk move,
  status line, replay/verify, guard of a merge entry without `batch` refuses); conflict drop; invariant fail fallback
  (unattributed, no blocks, not batched again, single merges as now); exclusion of overlap/closure/pending approval;
  CAS when trunk moves during the measurement; driver batch of 3; driver fallback after a failed batch.
- Existing tests changed: none.
