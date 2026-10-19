# o-haltlead — HL1–HL2

Baseline: `bbf43fe20d70358062672fdcfdc624725391bf5b`.
Scope: `src/needs.ts`, `test/haltlead.test.ts`, behavior-specific existing test expectations, and `docs/SPEC.md`.
No persistence, reducer, driver policy, gates, JSON shape, or `src/views.ts` change.

## Behavior

- A recognized writer-stop halt leads `needs()` with its existing quoted writer reply, parent decision command, halt sequence and resume alternative, before questions/rules/obligations. Intentional held rulings still suppress that need; other halts keep their ordering.
- An active judgment block on the current candidate's review/closure-review key prevents old-key repair text and owner OK commands/alternatives for that obligation. An old-key-only repair retains its original reviewer/rank repair text and owner route.
- Existing view and wake adapters consume that ordered list; their rendering and API shapes remain unchanged.

## Existing test changes (contract-authorized only)

- `test/needs.test.ts:116`, NE3: HL2 removes the owner OK alternative for a current-key active review block.
- `test/needs.test.ts:185`, NE11: HL1 adds the writer halt before the unchanged unruled review need, including after candidate invalidation.
- `test/views028.test.ts:49` and `:58`, R-028-51: HL2 removes the current-block owner OK alternative in why; JSON shape assertions remain.
- `test/views028.test.ts:156`, VW1/C1: HL2 removes the current-block owner OK alternative in compact/full why; stress waiver and acceptance gate assertions remain.
- `test/views028.test.ts:262`, VW5/N5: HL1 makes the quoted writer reply lead the unchanged unruled review; resume refusal assertions remain.
- `test/brief.test.ts:150`, brief --since: HL2 removes the advertised closure-review OK alternative while the current block is active. Assert it is absent, then invoke the same explicitly pinned owner rank-3 act directly, preserving all assertions that guidance does not discharge the block and that an explicit owner review clears it and makes the candidate accepted.
- `test/drive028.test.ts:202`, DR1/C1/C4: HL2 removes the current review block's owner OK alternative. Primary/secondary wake need identity, primary decision and sibling evidence command assertions remain.
- `test/fixes.test.ts:53`, judgment block hints: HL2 no longer guarantees an owner override command is present; every `--as` that appears must still be `owner:<id>`, and the active-block OK alternative must be absent. Both same-rank peer-not-clearing and original-reviewer-clearing assertions remain unchanged.
- `test/halt-quiet.test.ts:147` and `:152`, E3.2: HL2 removes the active-block OK alternative; all remaining `--as` values are still restricted to the owner's own command. Primary decision, JSON keys, confirmation gate and non-writer halt wording assertions remain unchanged.
- `test/ux.test.ts:37`, UX1: HL2 changes the current-key active review block's owner override expectation to its absence; writer guidance and nonacceptance assertions remain unchanged.
- `test/views020.test.ts:50`, NY1/NY3: HL2 removes the owner OK alternative before the driver starts repair. Repair visibility, owner-needed predicate, acceptance, conflict and subsequent-block assertions remain unchanged.

## Source diff budget

`git diff --stat bbf43fe -- src`:

```text
 src/needs.ts | 16 ++++++++++------
 1 file changed, 10 insertions(+), 6 deletions(-)
```

## Validation

All Node, TypeScript and test execution uses `/tmp/owed-ipc/run.sh` on IPC.

- Typecheck plus new tests: exit 0; 7/7 tests passed. Log `/tmp/owed-ipc/logs/o-haltlead-1-133224.log` (tree `6aa257369cdf140d3204e77174e21ddd9a28ed40`).
- Earlier focused run: 104/105, with only a subsequently corrected new fixture failure (unsupported `approve: auto`); log `/tmp/owed-ipc/logs/o-haltlead-1-131905.log`. That run is not acceptance evidence for the current test file.
- Focused 8-file suite: exit 0, 105/105; log `/tmp/owed-ipc/logs/o-haltlead-1-134757.log` (tree `13c4c5e53e54f92efbb649e1723587d0bb75b09b`).
- Baseline red: isolated checkout `/tmp/o-haltlead-red-bbf43fe`, HEAD `bbf43fe`, only `test/haltlead.test.ts` copied from the candidate. `node --test --test-reporter=tap test/haltlead.test.ts`, exit 1, 3 pass / 4 fail; log `/tmp/owed-ipc/logs/o-haltlead-red-bbf43fe-134749.log`. Failures: tests 1 and 2 (#18776 current review / closure-review), test 6 (writer halt before unruled block), test 7 (driver/follower repair-stop wake). Controls 3–5 pass.
- First full suite and typecheck: typecheck passed, suite exit 1, 1884/1890; log `/tmp/owed-ipc/logs/o-haltlead-1-134904.log`. All six failures were old current-key active-block owner OK expectations (listed above), subsequently updated under HL2 and the parent's explicit ruling.
- Final six-file focused suite plus typecheck: `npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/brief.test.ts test/drive028.test.ts test/fixes.test.ts test/halt-quiet.test.ts test/ux.test.ts test/views020.test.ts`, exit 0, 67/67; log `/tmp/owed-ipc/logs/o-haltlead-1-142712.log`.
- Final full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, exit 0, 1890/1890; log `/tmp/owed-ipc/logs/o-haltlead-1-142824.log`.
- Both final runs tested tree `87b3b2a50413b15e6031c82e2e0fcf60d092a616`. Only this notes file changed afterward to record those results; source and tests are unchanged. No further checks or rebase, per parent ruling. Parent owns integration onto the advanced trunk.
