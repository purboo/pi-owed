# q-ux: full questions, retried tool refusals, recorded plan hash

Contract: `.owed/contract-0.33.0.md`, UX1–UX4 and Common rules. Baseline:
`1490a17c3994e8e7a6ea019d165dd0b43eaa5d26`. This note describes the writer's
implementation; the parent owns submission, independent review and acceptance.

## UX1 — the full question of a node

* `src/ops.ts` `question(o)` reads the open slot of the node, describes every
  launch of that attempt and returns the questions of the asking runs:
  `decision_needed`, the options (`label`, `scope`, `cost`, `risk`,
  `preferred`), `facts`, `tried`, the classification candidates
  (`label`, `evidence`, `unproven`), the question text, the call address, the
  `qid`/`rev` and the answer command. The `dsa` client is injectable
  (`o.dsa`), so the read is testable without a dsa host. A `qid` selects one
  question (exact match or a prefix, because the driver logs the first eight
  characters of a qid); without one, every open question of the node is
  returned. An unknown node or a node without an open slot refuses; a node with
  no open question returns an empty list.
* `src/views.ts` `questionText(v)` renders one question whole: the decision
  first, the numbered options with their limits, the facts, the tried list, the
  candidates with their evidence and unproven points, the question text, the
  call with its qid and rev, the answer command and the pi tool call. Nothing
  is clipped.
* `src/cli.ts` adds `owed question <node> [qid] [--json]`: the command prints
  the rendered questions, `--json` prints the fields. It is a read (no
  principal, no ledger write, refused nowhere but the node/qid itself).
* The pointer: `src/needs.ts` `questionPointer(node, qid)` is
  `→ owed question <node> <qid>`.
  * `withQuestionPointers(text)` adds it to a wake message that shows a
    question: a driver ask line (`asks (qid …)`) and a question wake
    (`— decide … → owed answer …`). The extension applies it to every wake it
    delivers (`src/extension.ts`, `makeWatch`), so the wake names the full
    question. A wake line that does not carry the qid points at
    `owed question <node>` (all open questions of the node); a line that carries
    it points at `owed question <node> <qid>`.
  * `src/views.ts` `questionMark(n)` adds it to an answer need (the state of an
    open question, not its text) in the `owed why` headline and in the
    `Next:` lines of `owed why` and `owed why --full`.
  * The driver's ask line itself keeps its shape (SA2 freezes the clipped
    payload); the wake that carries it points at the full question.

## UX2 — one retry after an optimistic-concurrency refusal

* `src/extension.ts` exports `optimisticRefusal(error)` (an `OwedError` with
  code `busy`, or code `refused` whose message holds `changed; retry`) and
  `retryOnce(act)`: the act runs, and a first optimistic refusal runs it once
  more and reports the first refusal. A second refusal is returned as today, and
  every other refusal is not retried at all.
* The `tool()` wrapper applies it to the recording tools `decide`, `answer`,
  `resume`, `plan`, `edit`, `amend`, `rule`, `stage` and `accept`. The retry
  re-runs the tool body, so it re-reads (the plan file, the ledger state, the
  node) before it acts again. The output then starts with
  `retried once after: <first refusal>`.
* Under `OWED_CONFIRM=owner` the retry asks the owner again: the confirmation
  is part of the act that is retried.

## UX3 — the recorded plan hash (R1580)

* The receipt: `src/views.ts` `recordedPlanLine(entry, fileSha)` renders
  `recorded plan #<seq> blob <sha> file sha256 <sha>`. `owed_plan`,
  `owed_edit` and `owed_amend` end with that line. The blob sha is the sha of
  the ledger blob the plan entry points at (recorded under the lock); the file
  sha256 is the sha256 of the plan file bytes that were recorded:
  * `owed_plan`: the bytes the tool read and handed to `ops.planSet`; they are
    verified against the file under the ledger lock (below), so the two agree.
    With `--rev COMMIT` the recorded bytes are the commit's, not the working
    tree's.
  * `owed_edit` and `owed_amend`: the bytes the act wrote to the plan file
    (`ops.edit`/`ops.amend` return them as `fileSha`); the file holds exactly
    those bytes.
* R1580 (an `owed_plan` tool call recorded the hash of an older plan version,
  `#22484` recorded the v516 hash `98f2bd5f`): the cause was that
  `ops.planSet` recorded the text the caller read, without comparing it to the
  plan file at the moment of recording. A file that changed between the read
  and the lock was therefore recorded as an older plan version.
  `ops.planSet` now compares the plan file with the recorded bytes **under the
  ledger lock** (`planFileUnchanged`, `src/ops.ts`): a file that holds other
  bytes refuses with `plan file changed; retry (…), nothing recorded`, and the
  tool's UX2 retry re-reads the file and records the current one. The test
  `UX3: a plan file that changed while recording is refused…` reproduces the
  report: the file changes after the read, the recording refuses and nothing is
  written to the ledger. The second test drives the same race through the tool
  (the owner's confirmation rewrites the file) and shows the retry recording
  the current file.

## UX4 — the tests

`test/ux0330.test.ts` holds the thirteen tests of this node: the full question
and its fields, the qid selection and the refusals, the CLI grammar, the
pointer in a clipped question and in a wake, the `owed why` line of an open
question, the retry semantics (unit) and the retry through the plan tool, the
recorded plan receipt of the three tools and the R1580 reproduction.

## Changed existing tests

1. `test/needs-structure.test.ts`: the frozen digest of the CLI help literal
   changed, because the help gained the `question` command line (UX1). The
   registration now names the new digest and the reason mentions the command.
2. `test/compactreply.test.ts`, `test/drive-live.test.ts`,
   `test/plan-guidance.test.ts`: the plan, amend and edit outputs now end with
   the recorded plan receipt (UX3). The assertions that the output ends with the
   status details line now assert that the details line is still there and that
   the output ends with the receipt.

## Limitations

* The wake pointer names the qid only when the wake line carries it; the
  driver's plain question wake does not (`owed question <node>` prints every
  open question of the node instead).
* The retry of a recording tool re-runs the whole tool body, including the
  owner confirmation under `OWED_CONFIRM=owner`.
* `ops.planSet` compares the plan file with the recorded bytes only when the
  plan was read from the working tree (no `--rev`) and the file is readable.
