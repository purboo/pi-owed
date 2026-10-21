# q-bound: bounded pi tool results (0.32.0)

## Scope and ownership

- Writer slot: `owed/q-bound/1`, attempt 1, canonical cwd
  `/home/purboo/project/pi-things/pi-owed/.owed/wt/q-bound-1`.
- Baseline: `e93b679b6d3808b9202e8b2b6162f76ef4c8156d` (0.31.2); clean at assignment.
- Product change: `src/ext-worker.ts` only. `docs/SPEC.md` documents compact
  details and the parent-approved read-only pointer interpretation of TB1.
- No CLI/ops/reducer/ledger schema, lock order, append/rollback, status computation,
  README, skill, changelog or package-version changes. No new result persistence.
- Writer commits and stops. No submit, attest, rebase, merge, tag, push or publish.
  The parent owns integration, independent review and the full-suite invariant.

## Implementation

- Every registered tool executes through the common native worker result seam.
  Text is clipped to 48 * 1024 UTF-8 bytes; compact details serialize to at most
  8 * 1024 bytes before `postMessage`, so structured clone never sees the original
  reducer dictionary, parsed plan, diff or entry bodies. Raw RPC is tested too.
- Per-tool field projections retain action/entry identity, seqs, verdicts, commit,
  tree, launch identity and counts. Lists show at most five metadata samples and
  omitted counts; oversized projected fields are removed with omission metadata.
  Carried submits become counted metadata, not original submit arrays. Ruling
  follow-up bodies, dispatch packet/task duplication and observation bodies are
  removed from details even when small. The obsolete status prototype repair is gone.
- Text below the bound is unchanged. UTF-8 clipping preserves surrogate pairs,
  outcome/refusal heads and required version notices; the final line gives the
  exact omitted byte count and a short pointer. Completed mutations never point
  to replaying them: receipts name seqs, and plan/edit also name the plan path/seq.
  Dry-run pointers reconstruct a read-only invocation only when short and
  unambiguous; oversized arguments use the parent-approved generic CLI hint.
- Version metadata and the session seen-version set come from the host before
  worker clipping. This preserves SQ4 when same-version loader wrappers share a
  native worker rooted at a different installation. Full and version refusals
  always retain hints. Transport failures keep the existing no-replay behavior.
- Unexpected operation errors become bounded `internal` tool errors in the worker;
  transport/startup refusals are bounded on the host (no operation result crossed).

## Exact evidence

Passing product/test revision (before this documentation-only receipt commit):

- Commit: `96ef6a9d43bd4e1b2a382697fae3778934c7211b`.
- Tree: `53b2142d568ca272aaa1234d614a6b4b3f70aa49`.
- IPC run: `01M5F4K0K8X79BQ06P6NKW8N1T`, exit 0; clean tree in the log header.
- Complete log: `/tmp/owed-ipc/logs/q-bound-1-194718.log`.
- Log SHA-256: `593fa8ebbd41f16eecaea268d9fee13642b6db712affcba079bb159c64235604`.
- Typecheck passed; 150 tests passed, 0 failed/cancelled/skipped/todo.
  Test duration: 109300.02198 ms; durable command duration: 130068 ms.

Exact command (all Node/tsc/test execution ran through IPC, not locally):

```bash
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/q-bound-1 480 'npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/bound0320.test.ts test/tool-worker.test.ts test/surface.test.ts test/extension.test.ts test/coretools.test.ts test/edit.test.ts test/init-tool.test.ts test/compactreply.test.ts test/amend.test.ts test/checktry.test.ts test/left022.test.ts test/multiedit.test.ts test/answerstate.test.ts test/summary.test.ts'
```

Red evidence: tests-only commit `e905036e2ed193b58e36a3576495012904e81300`,
tree `a4379ca6c0ed41e16154cf55200d82b7197d3582`; src was still the baseline.
Command: `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/q-bound-1 240 'node --test --test-reporter=tap test/bound0320.test.ts'`.
Run `01M5F3J9FDX68BKBE1SFMZ18NA`, exit 1, 0/2 passed;
log `/tmp/owed-ipc/logs/q-bound-1-192926.log`, SHA-256
`d22e6d27edac1a2f87e0997b978760c45b622d548c7b317e007352b6c3e04d9e`.
Default status failed at 205598 content / 507870 details bytes; large refusal
failed at 80052 content bytes. These are behavioral failures, not import errors.

Intermediate failures were not accepted as passing evidence:

- `def6e69`, tree `4912e6ad2f9bae5c9d267fa6b04f9f9752fe2b9d`:
  typecheck passed; 65/67 tests. Log `q-bound-1-193619.log`. The new large CLI
  comparison differed only in live writing age (0s vs 2s); dispatch metadata JSON
  comparison depended on property order. Fixes normalize only the new test's age
  and parse the existing rendered JSON while preserving its values.
- `196591b`, tree `4174fe24a503aef205efbf5f3682c64745ca182f`:
  typecheck passed; 147/150 tests. Log `q-bound-1-193919.log`. TB test reached
  edit and found its fixture supplied only a genesis path, whereas edit uses the
  latest plan-entry path; every fixture edit now explicitly gives `plan.json`.
  LO3's replacement source, `why.rulingFollowUp`, is not the original delivered
  message with block lines; the assertion now uses `rulingFollowUp(state,node)`.
  SQ4 found a real shared-worker version-source regression; host version snapshots
  fix the product code. `test/summary.test.ts` remains entirely unchanged.
- `15d3097`, tree `2ba27792a2131d4598f700f9c997d2251bac4a87`:
  typecheck and all 5 selected TB/LO3/SQ4 tests passed, exit 0;
  `/tmp/owed-ipc/logs/q-bound-1-194426.log`. The final full focused set above
  supersedes this selected recheck and validates the immediate final refinements.

## Measurements on the passing tree

Fixture: 300 nodes, 2863971-byte plan, Unicode briefs/ruling, long node IDs.

| Real worker result | Content UTF-8 bytes | Details JSON bytes |
|---|---:|---:|
| status default | 49152 | 3894 |
| status full | 49152 | 3894 |
| why full | 49151 | 366 |
| edit large dry-run | 49152 | 259 |
| edit recorded | 49151 | 409 |
| plan recorded | 49152 | 2187 |
| large refusal | 49151 | 542 |

Status default/full wall time was 771.1/658.2 ms. Baseline default status in the
red run was 777.8 ms; these single runs are observations, not a speedup claim.
The unchanged G2 test measured host max event-loop delay on 2201 entries:
worker status/why/dispatch/watch 0.4/0.6/0.9/0.3 ms; cold in-process positive
controls 197.6/223.7/127.5/108.2 ms. Status computation remains in the worker
and its cost/semantics are unchanged; this task bounds transfer/storage only.

## Existing-test changes and why (TB2/TB5)

No tests were skipped, deleted, downgraded or changed outside removed details
consumers. CLI, rendered content, authority, transaction and rollback assertions
remain in place. `test/bound0320.test.ts` is new, with real-seam large fixture,
raw RPC, all registered-tool refusal paths, small text equality, UTF-8/escape
boundaries, list omission accounting, safe pointers and retained version hints.

- `test/tool-worker.test.ts`, G2 equality: full details == ops view contradicts
  TB2. Check retained node/phase/count/totals metadata and absent nodes/bodies,
  retaining exact small text/refusal equality. Dispatch packet/subagent task
  fields are removed; assert compact launch identity and parse the rendered
  args (JSON property order is not a behavior guarantee), retaining the brief.
  Event-loop, crash/abort, owner-dialog and jiti tests are unchanged.
- `test/extension.test.ts`, dispatch: remove details packet/task equality;
  assert packet absence and agent/cwd/isolation identity. The following real
  writer commit, submit inference and authority checks are unchanged.
- `test/surface.test.ts`, SF3 dispatch: packet and task cannot remain in details.
  Read packet from content, assert compact launch identity, and still prove it
  prints once and its rendered args use the complete-packet placeholder.
- `test/compactreply.test.ts`, CR2 dispatch/plan/amend/edit/defer/resume/abandon:
  obtain original entry bodies/carries from the ledger by retained seq instead
  of removed details, then compare the same act/carry text. Check counted carry
  metadata and packet absence; launch args are parsed. Brief/suffix/phase/debt,
  file writes, carries and no-refusal-write assertions remain unchanged.
- `test/amend.test.ts`, N3/PO1/AC1 authority: ruling body is absent from details;
  assert that absence, find the entry by seq, and assert the same limit text.
  Owner identity, rendered content and chain verification remain unchanged.
- `test/checktry.test.ts`, CT2 tool carry: use `carriedSummary` identity, seq,
  node, source-carry and commit rather than raw carried submit entries. CLI/ops
  still compare the complete carry; note ordering, reducer candidate, recorded
  full carry and tool content assertions remain unchanged.
- `test/left022.test.ts`, LO3: raw slot follow-up is forbidden by TB2; assert
  it is absent, then reconstruct the same original message with
  `rulingFollowUp(state,node)` and retain both literal ruling/block checks.
  Compact receipt, finished writer identity and concise rendered lines are unchanged.
- `test/multiedit.test.ts`, ME1: resume bodies are absent in compact details;
  use the ledger entry by seq for the same rendered-entry assertion. Atomicity,
  ordering, batch targets, preview/no-write and failure-path assertions are unchanged.

## Limits and delivery state

- The final receipt commit adds only this notes file; tested source, specification
  and tests are identical to the passing revision above. Its final HEAD/tree are
  recorded in the writer handoff, not self-referentially inside this file.
- Shipped-text CJK scan: Python scan of added lines in the baseline-to-current
  diff for `src/ext-worker.ts` and `docs/SPEC.md` (ranges U+3400-U+9FFF,
  U+3040-U+30FF, U+AC00-U+D7AF) found 0 hits in 262 added lines; exit 0.
  `git diff --check` passed. Final receipt is English as required.
- Full project suite and independent grouped review were not run by this writer;
  they remain the parent's integration/full-suite invariant obligations.
- CLI remains complete, proven through large status/default/full/why text and
  large status JSON comparisons. Mutation pointers expose read-only current
  receipts, not a byte-exact historical response (parent-approved interpretation).
- No acceptance/release/publication claim. No external job was replayed and no
  other worktree, active service, driver or session was changed.
