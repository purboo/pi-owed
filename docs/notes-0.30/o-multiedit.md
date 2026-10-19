# o-multiedit — ME1

## Scope and implementation

- Base: `cdb851bcb4ed2f735bd28e0b6da098ddc7b1ed53`; slot: `owed/o-multiedit/1`.
- CLI accepts `edit a,b`; the tool and ops accept `nodes`, exclusive with `node` and `invariant`.
- R-030-ME-1 (parent ledger #3650, resolving review #3649): an exact current node ID wins over comma splitting, including when both individual parts exist. CLI `--node-new` always treats its target as one literal ID. Otherwise split commas, trim, reject empty parts, deduplicate in order. Use tool `nodes` or separate edits for a colliding batch.
- Deduplicate array node ids in first-seen order; refuse tool/ops `node_new` arrays with multiple distinct nodes.
- Apply all assignments/unsets in one YAML Document and validate only the final plan.
- Replace safe block targets in reverse source order, keeping untouched bytes exact; flow/anchor/alias edits retain Document context.
- Compute plan/carries once from the final plan; validate all drafts under one lock, then append one plan, carries, an optional whole-batch rule, and one requested resume per node in one call.
- Single-node results/output retain `resume`; multiple distinct nodes return `resumes`, and CLI/tool render each receipt.
- Parent ruling: retain the single-node ED2 append boundary. Every pre-write refusal leaves the ledger and plan file unchanged; mid-write/sync failures inside `Ledger.append` are existing behavior outside this leaf. `src/ledger.ts` is unchanged.

## Test changes

- New `test/multiedit.test.ts`: CLI batch, final-plan carries, one locked append, ordered rule/resumes, unknown second node, missing second unset, authority, second resume/after rejection, pre-write append refusal, deduplication, dry-run, flow/alias/final-only validation, exclusive targets, node_new, tool nodes, and single-node compatibility. R-030-ME-1 adds comma-ID precedence with and without existing parts, fallback list trimming/empty rejection, literal CLI node creation, and explicit tool array node_new refusal; the earlier CLI node_new refusal expectation is replaced per the ruling.
- Existing `test/needs-structure.test.ts`: update only the exact CLI HELP literal digest and its classification reason. ME1 changes the synopsis from `edit <node>` to `edit <node[,node...]>`; R-030-ME-1 adds the literal-ID precedence explanation. Exact-site enforcement and negative fixtures remain unchanged.
- Existing `test/trackhelp.test.ts`: update only the edit synopsis assertion to `edit <node[,node...]>`, required by ME1. Other isolated-help, invariant-form, flags, and exit-code assertions remain unchanged.
- No other existing tests changed. The English documentation check is unchanged; this note uses English to meet its published-document rule.

## Validation

All Node/TypeScript/test commands run through `/tmp/owed-bench/run.sh` on the bench host; durable commands use `--wake caller`.

R-030-ME-1 passing implementation/test tree: `4760bd493973dc75528c5e2c0fec54e3f2df7119`. Only this note's final receipt update follows those checks; the English check is rerun after that update.

- Red regression on detached `aa67aa4`, with only the updated test copied: `node --test --test-reporter=tap --test-name-pattern='R-030-ME-1: literal comma id' test/multiedit.test.ts`; exit 1, 2/2 fail. Log: `/tmp/owed-bench/logs/owed-me030-red-aa67aa4-000138.log`.
- `npm run typecheck && node --test --test-reporter=tap test/multiedit.test.ts test/edit.test.ts test/trackhelp.test.ts test/needs-structure.test.ts`: exit 0, typecheck passed, 35/35 tests passed. Log: `/tmp/owed-bench/logs/o-multiedit-1-000142.log`.
- `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800: exit 0, 1946/1946 tests passed, 1328.061 s. Log: `/tmp/owed-bench/logs/o-multiedit-1-000240.log`.
- Earlier repair check `/tmp/owed-bench/logs/o-multiedit-1-235941.log`: typecheck passed, 34/35 tests passed; the collision fixture accidentally triggered a writes-overlap warning. Giving fixture nodes independent paths fixed the output expectation without changing production code or relaxing assertions.

Earlier ME1 passing implementation/test tree: `c273857ba98fcd764a47d288356a157b2bc1897b`; those results precede the R-030-ME-1 repair.

- Current new test on detached `cdb851b` with only that test copied: `node --test --test-reporter=tap test/multiedit.test.ts`; exit 1, 8 tests / pass 1 / fail 7. CLI reports `Node a,b does not exist`; single-node compatibility passes. Log: `/tmp/owed-bench/logs/owed-multiedit-red-cdb851b-225317.log`.
- `npm run typecheck`: exit 0. Then `node --test --test-reporter=tap test/multiedit.test.ts test/edit.test.ts test/planlint.test.ts test/parentops.test.ts`: exit 0, 41/41 pass. Then `node --test --test-reporter=tap test/multiedit.test.ts`: exit 0, 8/8 pass. Combined log: `/tmp/owed-bench/logs/o-multiedit-1-225323.log`.
- Full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800; exit 1, 1943 tests / pass 1940 / fail 3, 1319.333 s. Failures: the original Chinese note violates the published-English check; the CLI HELP exact-site digest and edit synopsis assertion still expected the old grammar. These are corrected above. Log: `/tmp/owed-bench/logs/o-multiedit-1-225417.log`.
- Corrected-tree `npm run typecheck` and `node --test --test-reporter=tap test/multiedit.test.ts test/edit.test.ts test/planlint.test.ts test/parentops.test.ts test/english.test.ts test/needs-structure.test.ts test/trackhelp.test.ts`: exit 0, typecheck passed, 57/57 tests passed. Log: `/tmp/owed-bench/logs/o-multiedit-1-231750.log`.
- Corrected-tree full suite, exact command above, timeout 1800: exit 0, 1943/1943 tests passed, 1336.601 s. Log: `/tmp/owed-bench/logs/o-multiedit-1-231850.log`.

Earlier development diagnostics (both fixed): typecheck failure for a new-test actor type assertion, `/tmp/owed-bench/logs/o-multiedit-1-224936.log`; 39/41 focused tests passed with two incorrect new-test assumptions about an untouched node's default review count, `/tmp/owed-bench/logs/o-multiedit-1-225045.log`. The corrected tests compare that default with the parsed original plan and also assert untouched bytes.

## Source budget

`git diff --stat cdb851b -- src`:

```text
 src/cli.ts       |  8 +++++---
 src/edit.ts      | 40 ++++++++++++++++++++++++++++++----------
 src/extension.ts |  4 ++--
 src/ops.ts       | 13 +++++++------
 4 files changed, 44 insertions(+), 21 deletions(-)
```

Net +23 lines; budget +80. No ledger kind/field/enum or reducer changes.

## Delivery

R-030-ME-1 implementation, red regression, typecheck and full-suite verification are complete. Not published; `owed submit` is reserved for the parent. Hand off the slot commit for parent submission, attestation, review and merge. Sibling branches o-ask/o-envsuspect/o-allowonly are not merged into this slot; parent integration follows its prescribed order.
