# One decision, one act

`owed decide A[,B...] --text TEXT [--writes +PATH ...] [--defer INV] [--resume | --no-resume] [--after NODE] [--remeasure] [--writer]` combines an amendment, ruling, answer delivery, invariant debt and recovery. `owed_decide` accepts `{nodes: ["A", "B"], text, writes?, defer?, resume?, after?, remeasure?, writer?, as?, cwd?}`.

All parts are validated under one ledger lock before one append. Expensive Git preparation and question discovery happen before that lock and are checked against the current state before recording. Dsa delivery happens afterwards. Refusal records no entries and leaves the plan file unchanged. Plan replacement follows the existing amendment protocol: if replacement fails after the append, owed reports the recorded temporary plan and exact recovery location.

The order is plan, amendment carry submits, defers, one ruling, resumes. Without writes, defers precede the ruling. `--writes` uses `owed amend`'s recorded plan source, layout preservation and owner authority. All decided nodes must gain the same paths; a node with all paths already present refuses, as does a group with different partially present paths. Paths covered by `allow.writes` retain amend's "not needed" refusal: owed grants them at measurement. No plan key is added.

`--defer` requires owner authority and defers the named invariant on each current candidate's merge key, with TEXT as the reason. It runs before `--writer` invalidates the candidate, just as the individual commands would in that order. No checks are waived and no acceptance gate changes.

Resume defaults on for halted or held nodes. `--no-resume` preserves the halt, even though the ruling is recorded. Explicit `--resume`, `--after` or `--remeasure` requests resume; after and remeasure cannot be combined with no-resume. Hold release retains `owed resume`'s restrictions. `--writer` asks writers to change and resubmit; it does not acknowledge the ruling or clear a review block.

One unambiguous open question per named node is answered, using current dsa revisions. Multiple questions on a node refuse with guidance to select one through the existing `owed answer` command. One answer keeps the existing answer field and prefixed text; two or more use one shared ruling with unchanged TEXT and sorted answer references. The answered calls receive only an answer, while other running roles receive ruling notification. Exact `owed answer --rid ... --qid ... --rev ...` retries reuse the original ruling and dsa request, not another decision. A delivery failure preserves the decision and prints at most one additional line with retry instructions. Multiline retry values use Bash ANSI-C quoting to preserve one-line output without changing the bytes delivered.

The default receipt is `decision #S for A,B: ruling #R`, followed only by the performed writes, deferred invariant, answer count and resume clauses. Halt, Needs-you, review-block and question suggestions prefer decide; legacy rule, answer, amend, defer and resume commands remain supported. Owner overrides remain explicitly labelled and separate from writer repair guidance.

## Compatibility

- Optional `decision: number` on existing plan, carry submit, defer, rule and resume entries identifies the first sequence of a contiguous group. Replay validates order, one ruling, decided-node scope and principal/channel. The only principal exception is an amendment carry submit by `executor:owed`, validated against the amended node's previous candidate. No entry kind is added.
- Optional rule `answers: [{node, rid, qid, rev}]` is allowed only on decision rulings with at least two answers, sorted by node then question. It is mutually exclusive with `answer` and `supersedes`. Each reference names a launch of a decided node's current open attempt; duplicate or backwards revisions refuse. Single-answer decisions retain `answer` and normal `supersedes` history.
- Older readers refuse these fields or cannot interpret decision halt/group semantics. Upgrade CLI, drivers and pi plugins together before recording decisions. Historical field-free ledgers retain identical replay states and measurement keys; only recovery suggestions change.

## Existing regression expectations

Only recovery suggestion expectations change in `answer.test.ts`, `brief.test.ts`, `drive-order.test.ts`, `drive-rulings.test.ts`, `drive.test.ts`, `fixes.test.ts`, `flakyhint.test.ts`, `halt-quiet.test.ts`, `hold.test.ts`, `remeasure.test.ts`, `resume.test.ts`, `review-needs.test.ts`, `repair-epoch.test.ts`, `ruling-any.test.ts`, `stalesend.test.ts`, `summary.test.ts`, `ux.test.ts` and `views020.test.ts`, `writesglob.test.ts` and `measure-bg.test.ts`. The differential adapter in `test/perf/differential.ts` normalizes only these intentionally changed human command suggestions; ledger/state/key comparisons remain exact. `flow.test.ts` accepts the explicitly requested release note as tool documentation until the documentation integration folds it into SPEC.

## Limits and interpretation

- The atomic guarantee applies to validation and ledger append, not to external delivery or a plan replacement after successful append; this matches existing answer/amend recovery semantics.
- No automatic answer retry loop or implicit reviewer acknowledgment is introduced.
- The existing AW #2090 concurrent-adopt deadline assertion can fail under high load by reaching the merge lock rather than the expected ledger lock. Parent ruling DC5 identifies independent occurrences in `/tmp/owed-ipc/logs/sb0221-1-181214.log` and `/tmp/owed-ipc/logs/adoptff-1-204349.log`; this decision milestone does not change the test or its timing semantics.
- `--after` and `--remeasure` imply explicit resume when no resume flag is supplied. A plain decision on a running node adds no unnecessary resume.
- A legal writes/defer prefix is readable by pure replay, historical report cutoffs and snapshot boundaries. Extending it with a foreign entry, wrong order or ruling outside its decided nodes refuses. A full ledger tail missing its ruling refuses load and verify, names the first decision sequence and identifies an interrupted atomic write; no automatic repair is introduced.
