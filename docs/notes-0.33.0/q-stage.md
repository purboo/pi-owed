# q-stage: forks prepare, the parent accepts

Contract: `.owed/contract-0.33.0.md`, SG1–SG9 and Common rules. Baseline:
`ba0e8964d999fa8bf9c582155afafdc463ff9629`. This note describes the writer's
implementation; the parent owns submission, independent review and acceptance.

## Parent clarifications

The parent approved these concrete representations in the writer's structured ask:

- `touches` is a JSON string array. Existing plan node ids denote nodes; every
  other value must be a repository-relative path without absolute or `..` segments.
  Overlap means a common node, equal paths, or a directory-prefix path overlap.
- Unrelated plan entries do not invalidate stages. Compare the canonical node
  definitions at `read_through_seq` with the later recorded plans for the stage's
  node and touched nodes. A stage with a patch also checks the current file bytes.
- Record the sorted `qid`/`rev` fingerprint of open writer questions when staging.
  Acceptance describes again. Changes produce `question changed (qid …)`;
  describe failures refuse with `cannot verify open questions: …; retry` and
  record nothing. No question ledger kind is introduced.
- Acceptance without `decide` records one ordinary ruling for the stage node,
  using `ruling_text` or `--amend`, with the ` [stage S<n>]` suffix.
- SG1 permits the new optional `via` field on existing A-act entries. It is absent
  from ordinary entries and historical replay remains unchanged.
- An overturn disables that A-act kind until a later recorded plan explicitly
  lists it again in `drive.delegate.a_acts`.

## Behavior and storage

`owed stage`, `accept`, `reject`, `stages` and `overturn` have corresponding pi
tools. Staging validates the complete JSON envelope and stores its exact bytes;
patched plan bytes are separately retained. Evidence hashes and current/patched
plan hashes are verified before recording. Append paths require explicit plan
permission and filesystem resolution inside the repository, including symlinks.
Stages also reserve the nodes named by their `decide` and their append paths.

The existing ledger mappings that stale stages are `halt`, `submit` (candidate),
`review`, `rule` (ruling, answer or decide), `resume`, `abandon`, `merge`,
`dispatch`, `launch`, `rebase`, `hold`, `waive`, `defer`, `evidence` and `grant`,
when they name a stage/touched node. An executor `obs` names its `subject` and
optional `merging` node and counts unless it is a diagnostic trunk probe.
A `rule` on `*` names every node. A `plan` counts only for changed canonical node
definitions, including addition/removal, rather than naming all nodes.

Excluded bookkeeping kinds are `stage`, `accept`, `reject`, `overturn`, `note`,
`send`, `sweep`, `refresh`, `adopt`, `decoy-commit` and `decoy-reveal`; diagnostic
`obs` entries with `probe: trunk` are also excluded. Runtime question changes use
the fingerprint, independently of these ledger-kind mappings. Merely staging or
rejecting does not clear a driver halt.

Acceptance holds one ledger lock for freshness, overlap, authority and all
prospective-draft checks, plan replacement, the combined ledger append and marker
appends. It reuses plan admission/downgrade/carry rules and decision drafting.
Decision delivery occurs after releasing the lock. A patch's complete source is
used when composing an optional decision writes/cap amendment. A delegated owner
plan patch records `accept S<n>` as its reason. `--all-b` considers open class-B
stages in sequence order and stops on the first refusal.

A replaced plan equal to the stored patched bytes is recognized as an unfinished
acceptance and can be retried. Once `accept` is durable, retry reuses its original
ruling and completes only missing appends. Each append is prefixed with the stage
marker, and `{ruling}` uses the durable ruling sequence. A crash after a marker
write is not a transaction spanning the filesystem and ledger: the marker is the
contractual retry boundary.

Fork identity is resolved through one cached dsa describe per call identity,
including failed resolutions. Enabled preferred answers are restricted to the
fork's own open writer question and its uniquely marked preferred option.
Infrastructure resume requires its own infrastructure halt and non-error current
candidate measurements covering the execution obligations. These are owner acts
with `via: fork:<call>`. All other CLI/pi parent and owner acts retain D25.3's
refusal and point to `owed stage`. Overturn history remains visible in status.

A plan without `drive.delegate` receives no new defaults or enumerable replay
fields. Stages, their states, counts and commands are derived from optional ledger
entries; the reducer does not add a stages collection to old states.

## Tests and validation

New coverage is in `test/stage0330.test.ts`: field/hash refusals, semantic-kind
staleness, plan changes, question revisions/failures, overlap, full acceptance,
plain rulings, owner downgrade authority, combined edits, crash retries, markers,
batch refusal, CLI/pi surfaces, fork restrictions, overturn and legacy replay.
No existing test has been changed; consequently no existing-test expectation
requires a contract exception.

All Node, TypeScript and test commands run through `/tmp/owed-ipc/run.sh` on IPC.
The initial source checkpoint `9e756f07a029b33daaf04c7f6ba1038e69339563`, tree
`b1eb231d97ebbccfffeb2cd0dc9a218556397010`, passed `npm run typecheck` remotely
(log `/tmp/owed-ipc/logs/q-stage-1-121056.log`). Final-tree evidence is reported by
the writer with exact commit/tree and check logs; this initial result does not
attest later edits.
