# q-delegate: node wakes go to exact forks of the session that follows the driver

Contract: `.owed/contract-0.33.0.md`, DL1–DL5 and Common rules. Baseline:
`383c513` (main). This note describes the writer's implementation; the parent
owns submission, independent review and acceptance.

## What the node does

The top-level pi session that follows a driver no longer delivers every
Needs-you wake of a node as a turn. When the recorded plan has a
`drive.delegate` block whose `on` lists the wake's kind, the extension hands
that wake to **one exact fork of the very session that follows the driver**:

```
dsa run --request <rid> --spec - --labels '{"owed_fork":"<node>","owed_wake":"<wake id>"}' \
       --cwd <repo> --origin-session <pi session id> --json
```

The call spec is one agent call: `{agent:"delegate", context:"exact", task:<packet>}`.
It names **no model** and no `budget` object (see "Interpretations"). The run
labels carry the node and the wake id, so a fork is traceable in the dsa
ledger. The fork's task is a generated packet:

```
owed delegate fork for node <node>

Wake (<kind>):
<wake text>

Read the ledger through seq <seq> (read_through_seq <seq>); the plan sha256 is <sha>.
Enabled A acts: <acts>.
The budget is <rounds> round(s) of work and at most <wall> s of wall time.

Rules:
- reread this node's ledger entries since seq <seq> first; the facts above may be stale.
- produce a bundle and run `owed stage <node> --file BUNDLE.json`.
- never fork or launch subagents.
- long reproductions run only as dsa command calls.
- stop after staging.
```

At most one fork per node runs at a time and at most `max` forks run at once;
later wakes queue in order and are forked as slots free. Who may stage does not
change: the fork stages as a writer (`owed stage`), the parent accepts.

## Where the code lives

| File | What it holds |
|---|---|
| `src/drive-bg.ts` | the wake kinds (`question`, `writer-stop`, `review-asks`, `infra-halt`, `needs-owner`), the stable wake id, and the `divert` hook of the follower (a taken wake is not part of the turn) |
| `src/watch.ts` | the `Delegate` engine: queue, one fork per node, the packet, the settle message, the quit/restore of pending wakes |
| `src/extension.ts` | the wiring: one delegate per repository, the plan/ledger facts, the dsa client, the store, the tick poll, the session start/shutdown |
| `src/dsa.ts` | `Dsa.run(..., originSession)`, the `--origin-session` probe (once per binary), `Dsa.describeCall(call)` and the `exact` facts of a call |
| `src/stage.ts` | ruling #4021 only: `forkPrincipal` resolves a call address through `describe <wid> --json` |

## DL1 – the fork

* The plan's `drive.delegate.on` decides which kinds are delegated; a wake of
  another kind stays in the turn.
* The wake id is `sha256(node, kind, facts, source text)` – stable across
  sessions, so a wake is never forked twice. The fact mark is part of it: two
  facts of the same node are two wakes.
* The fork is launched with the pi session id of the session that follows the
  driver (`--origin-session`), so the fork sees this session's context.
* The packet names the node, the wake text, the ledger head seq as
  `read_through_seq`, the plan sha256 and the enabled A acts (the plan's
  `a_acts` minus the kinds an `overturn` disabled), plus the five rules.

## DL2 – the settle

One batched message per settle (a poll in which forks ended):

```
owed delegate: 2 fork(s) settled
- <node>: staged <S<n>> (class <C>, <n> evidence file(s))
  <stage summary>
  owed accept <S<n>>
  exact: cache 97% · $0.031
- <node>: fork <rid> ended with no stage: <why>
  <the original wake text>
  exact: rebuilt (no-capture)
owed accept --all-b
```

* A staged fork takes at most ten lines (summary, class, evidence count, the
  accept command); the summary is truncated to fit.
* `owed accept --all-b` is added when more than one class-B stage is open.
* A fork that ended without a stage (failed, out of budget, stopped, no
  conclusion) keeps its original wake text unchanged and adds one line naming
  the fork call and why.
* The dsa `exact:` line is per fork: the cache ratio and the cost of an exact
  call, or `rebuilt (<reason>)` for a rebuilt one.

## DL3 – wakes are never lost

* A dsa launch refusal (rejected, conflict, no session) delivers the original
  wake at once: the wake goes back into the turn, not into a fork.
* On `session_shutdown` the pending forks (running and queued) are written to
  `<drive dir>/drive/delegate.json`. When the session follows the driver again,
  those wakes are delivered as their original wakes and are not forked a second
  time.

## DL4 – the 0.32.0 behavior

Nothing is delegated (and every wake is delivered exactly as in 0.32.0) when

* the plan has no `drive.delegate` block or an empty `on`,
* the session has no pi session id,
* the process runs inside a dsa call (`DSA_CALL`/`DSA_EXEC`),
* the dsa binary does not accept `--origin-session` (probed once per binary
  with `--help`; an older dsa behaves like 0.32.0).

## Interpretations (documented choices)

1. **Budget.** dsa 1.3.0 rejects a call budget that is not `{tokens?, costUsd?}`
   ("budget needs tokens or costUsd"), so the plan's `{rounds, wall_s}` cannot
   be passed verbatim. The wall budget becomes the call's `timeoutMs`
   (`wall_s * 1000`), and the rounds of work are stated in the packet. The
   contract's "budget from `drive.delegate.budget`" is therefore honored in
   effect, not in shape.
2. **Plan sha256.** The sha256 of the plan *file* the fork works against (the
   value a bundle's `plan_patch.before_sha256` must carry). Without a recorded
   plan path it falls back to the sha256 of the recorded plan blob.
3. **Wake text.** The plain `Needs you: …` line the session would have read.
   The fork packet carries that text; the driver report's raw text only feeds
   the wake id.
4. **Stage attribution.** A stage belongs to a fork when it is recorded for the
   fork's node and after the ledger seq the fork read through. A stage of
   another node or an earlier seq is not attributed to it.
5. **Open stages.** "Open" means a stage entry without a later accept or
   reject. The class-B count for `owed accept --all-b` is over all open stages.
6. **The delegate's state.** The pending forks live in
   `<drive dir>/drive/delegate.json` (the drive directory of the repository),
   next to the driver log. The store is best effort: if it cannot be written,
   the wake stays in the driver log and is read again.

## Tests

`test/delegate0330.test.ts` (18 tests) covers DL1–DL5 with the fake dsa:
launch arguments and labels, the packet, one fork per node, `max` and the
queue, the batched delivery with stage/class/evidence/accept/exact facts, the
`--all-b` line, a fork without a stage, a launch refusal, the quit and the
restart recovery, the missing session id, the older dsa and the call-address
description of ruling #4021.

Changed existing tests: `test/stage0330.test.ts` mocks `Dsa.describeCall`
instead of `Dsa.describe` for the fork principal (ruling #4021 changes which
call resolves a call address).

## Limits

* The fork's own `owed stage` needs the repository's ledger; the run is
  launched with `--cwd <repo>`, so the fork stages in the same repository.
* The settle message is delivered through the extension as an `owed-delegate`
  message; it is not gated by the driver's own busy check.
* dsa's `describe --key` still takes a request id; the fork's *call* address
  (needed for A acts inside a fork) is resolved through `describe <wid>`.
