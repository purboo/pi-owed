# q-stage: forks prepare, the parent accepts

Contract: `.owed/contract-0.33.0.md`, SG1–SG9 and Common rules. Baseline:
`ba0e8964d999fa8bf9c582155afafdc463ff9629`. This note describes the writer's
implementation; the parent owns submission, independent review and acceptance.

## Parent clarifications

The parent approved these concrete representations in the writer's structured ask
(they are the contract now):

1. `touches` is a JSON string array. Existing plan node ids denote nodes; every
   other value must be a repository-relative path without absolute or `..`
   segments, otherwise stage refuses. Overlap means a common node, equal paths,
   or a directory-prefix path overlap.
2. SG3 maps onto existing kinds. Unrelated plan entries do not invalidate
   stages: compare the canonical node definitions at `read_through_seq` with the
   later recorded plans for the stage's node and touched nodes (a node that was
   added or removed counts). A stage with a patch also checks the current file
   bytes (`before_sha256`). One accepted plan patch therefore does not stale an
   unrelated concurrent fork's stage.
3. Runtime questions: a stage records the sorted `qid`/`rev` fingerprint of the
   node's open writer questions (empty when none). Acceptance describes again; a
   differing fingerprint makes the stage stale with `question changed (qid …)`.
   If describe fails at accept, the accept is refused as retryable
   (`cannot verify open questions: …; retry`), records nothing and does not
   mark the stage stale. No new question ledger kind exists.
4. Acceptance without `decide` still records one ruling (a `rule` entry for the
   stage's node) with the `ruling_text`/`--amend` text and the ` [stage S<n>]`
   suffix; the accept entry cites that seq.
5. `via` is a new optional field on the entries an A act records (rule, resume).
   It is absent when unused, no existing field changes, and a replay test proves
   that an old ledger stays byte-identical.
6. An overturn disables that A-act kind until a later recorded plan entry
   (recorded after the overturn) lists the kind again in
   `drive.delegate.a_acts`.

## Parent review findings (F1–F3)

The parent reviewed the rebased branch and raised three findings; each is fixed
in its own commit on top of the rebased tree.

1. **F1 — a read-only listing must not fail wholesale when the dsa describe
   fails.** `ops.stages()` computed every stage's freshness with a dsa describe,
   so one failed describe aborted the whole listing and `owed status` /
   `owed stages` failed instead of listing the stages. `stageReason` now throws
   `UnverifiedQuestions` (an `OwedError`, so the refusal keeps its code and its
   message `cannot verify open questions: <detail>; retry`). The tolerant listing
   catches exactly that error and lists the stage as state `unknown` with the
   reason `cannot verify open questions: <detail>`, and keeps listing the other
   stages. The write path is unchanged: `owed accept` still refuses retryably
   and records nothing, and `owed accept --all-b` uses the strict listing
   (`strict: true`), so the whole batch refuses and records nothing. The
   `StageView` state gains `unknown`, `status` counts it, and the status stage
   line lists such a stage with its reason.
2. **F2 — the status stage line counted stale stages as open.** The line
   `Stages: <n> open (<k> stale) → owed stages` counted open and stale stages
   together, so one open and one stale stage reported two open. The open count
   now excludes the stale stages; the wording of the line is unchanged.
3. **F3 — a bundle's evidence paths and patched plan file could name files
   outside the repository.** Staging read them wherever they pointed. Both are
   now repository paths, checked like the append paths: the bundle refuses a
   path that is not repository-relative (`evidence.path: expected repository
   path`, `plan_patch.file: expected repository path`), and staging refuses a
   path that resolves outside the repository (`path escapes repository: …`).
   The paths are resolved against the repository root, like the append paths
   and the recorded plan path.

## Rebase

The branch was rebased onto trunk `c9c1fa0ef500472cb1a9a01054a108ae80c3d26f`
(the owed rebase #3998 moved the slot base from
`ba0e8964d999fa8bf9c582155afafdc463ff9629`). Only `src/views.ts` conflicted
(two hunks, both the q-stage and the q-halt side): the card line keeps both the
stage lines and the halt line, and the status line keeps both the stage line
and the halt line. The rebased chain is
`dbfa7d3` (stage and fork authority), `178660d` (stage acceptance and fork
tests), `94d04aa` (question revision and test entry types), `249e7d9` (accept
admission and describes outside the lock), `44a3bfd` (D25.3 fork wording),
`6abdb55` (stage authorship `writer:<dsa call>`), `1857d7c` (evidence and
limits) and `8ba84fe` (the suite receipt).

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

Acceptance performs every command-running step before the ledger lock: stage
freshness and overlap (including dsa describe), plan admission/self-tests for the
patched plan, and decision preparation. Under the lock it only verifies that the
ledger sequence it read is unchanged (otherwise it retries the whole accept, up to
five times, then refuses as retryable with nothing recorded), builds and guards the
decision and accept drafts, replaces the plan file and performs the single combined
ledger append. Plan admission refuses to run under the ledger lock (RF2), which is
why admission cannot be inside it. Marker appends and decision delivery follow the
durable append. It reuses plan admission/downgrade/carry rules and decision drafting.
A patch's complete source is used when composing an optional decision writes/cap
amendment. A delegated owner plan patch records `accept S<n>` as its reason.
`--all-b` considers open class-B stages in sequence order and stops on the first
refusal.

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
refusal; the refusal of a *fork* names `owed stage` (SG6), while a subagent call
that is not a fork keeps D25.3's exact wording. Overturn history remains visible
in status.

A plan without `drive.delegate` receives no new defaults or enumerable replay
fields. Stages, their states, counts and commands are derived from optional ledger
entries; the reducer does not add a stages collection to old states.

## Tests and validation

New coverage is in `test/stage0330.test.ts`: field/hash refusals, semantic-kind
staleness, plan changes, question revisions/failures, overlap, full acceptance,
plain rulings, owner downgrade authority, combined edits, crash retries, markers,
batch refusal, CLI/pi surfaces, fork restrictions, overturn and legacy replay.
The three parent findings add three more tests in the same file: `F1` (a
read-only listing keeps an unverifiable stage and names its reason, status does
not fail wholesale, and the accept path still refuses and records nothing), `F2`
(the status stage line counts the open stages only) and `F3` (bundle evidence and
plan patch paths stay inside the repository, including a symlink that points
out). Each test was checked to fail before its fix and to pass after it: with
the three fixes reverted, the run reports `not ok 21 - F1: …`, `not ok 22 - F2: …`
and `not ok 23 - F3: …` (log `/tmp/owed-bench/logs/q-stage-1-064407.log`).
One existing test changed: `test/needs-structure.test.ts` (PR2 command-literal
registry). The registry pins every `owed …` literal by file, enclosing function and
digest. (1) The `src/cli.ts` HELP digest changes because SG8 requires the new
`stage`/`accept`/`reject`/`stages`/`overturn` grammar in the help text. (2) The two
`decide` sites (ambiguous-question refusal and `owed merge` label) are unchanged
literals that moved into `prepareDecision`, the helper SG4 needs so accept can
compose decision drafts into its single append. (3) The new `<!-- owed S<n> -->`
append marker (SG4 dedup) is registered as non-command text. No assertion was
weakened; only the inventory rows changed.

All Node, TypeScript and test commands run through `/tmp/owed-bench/run.sh` on the bench host.

Final tree `9dfd88bad963bcad4cc2171f9c9ed4d0f9757ea2` (tree
`41255bc1d043b22d33e5712ea5ad656c001b7a45`):

- `npm run typecheck` plus the focused regression set (`stage0330`,
  `confirm-timeout`, `flow`, `needs-structure`, `english`, `surface`, `decide`):
  121 tests, 121 pass, 0 fail; log `/tmp/owed-bench/logs/q-stage-1-015109.log`
  (same sources, tree `590b84f11e5cf0527d99fbb7923fea73233a2f42`).
- `npm run typecheck` plus the full suite
  (`node --test --test-concurrency=2 --test-reporter=tap "test/**/*.test.ts"`):
  2274 tests, 2274 pass, 0 fail; log `/tmp/owed-bench/logs/q-stage-1-021916.log`.

The commit after the tested tree changes only this note file, which no owed
invariant covers (`inv:typecheck` reads `src/**`, `test/**`, `tsconfig.json`,
`package.json`; `inv:suite` runs the tests).

Earlier checkpoints (each superseded by the tree above): the first source
checkpoint `9e756f07a029b33daaf04c7f6ba1038e69339563` passed `npm run typecheck`
(log `/tmp/owed-bench/logs/q-stage-1-121056.log`); the first focused run failed
typecheck with two narrowing errors (log `/tmp/owed-bench/logs/q-stage-1-121956.log`),
the next failed seven tests (log `/tmp/owed-bench/logs/q-stage-1-122101.log`) and
the first full run failed two tests (log `/tmp/owed-bench/logs/q-stage-1-011143.log`).

Known limits: a crash between the plan file write and the ledger append is not a
transaction across the filesystem and the ledger, so the `<!-- owed S<n> -->`
marker is the contractual retry boundary; the accept retries at most five times
when the ledger moves underneath it and then refuses as retryable.
