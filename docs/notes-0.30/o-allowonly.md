# o-allowonly — node caps on allow grants

## Scope and behavior

- Branch `owed/o-allowonly/1`; worktree `/home/purboo/project/pi-things/pi-owed/.owed/wt/o-allowonly-1`; base `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94` (0.29.1). Implements contract-0.30 AO1–AO6 only. No new ledger field/kind, version change, submit, merge or publication.
- AO1: absent `allow_only` preserves old behavior; `[]` forbids allow grants. Literal entries match exactly, globs use syntax 2. Own writes are unaffected; the cap alone grants no permission.
- AO2: grant drafting/replay, effective grants, withinWrites/ownership overlap, executor and merge rechecks enforce the cap. Previous grants remain audit receipts, but paths excluded by the current cap no longer confer permission. Closure/ownership and partial grants remain intact. Cap refusals never become overlap-only waits; hints suggest editing the cap, not adding allow/amend scopes.
- AO3: only a present cap adds `allow_only` to the writes key, including `[]`; other keys remain unchanged. Cap changes use existing candidate carry and fresh writes measurement, not an old pass.
- AO4: adding or provably narrowing a cap needs parent authority; removal, widening or unproved containment records `allow_only widened: <node>` and requires owner authority. Allow rules cannot cover this downgrade.
- AO5: new capped genesis/plan entries record syntax 3; uncapped plans continue recording syntax 2. Syntax 3 keeps syntax-2 path matching; wildcard writes-key metadata remains 2. The existing old-reader guard refuses 3. Valid ignored fields in historical syntax 1/2 plans are removed rather than activated retroactively.
- AO6: CLI `decide --allow-only`, tool `allow_only`, `edit`, and writer packets expose caps. An empty CLI value sets `[]`. Cap/writes/resume changes share one append; refusal or append failure leaves plan and ledger unchanged. Delivery remains outside the lock; file replacement failure after append retains existing recovery semantics.

## Parent rulings and limits

- R-030-AO-1: compatibility covers fields actually recognized by 0.29. Do not extend recorded-plan parsing/cache boundaries. Valid historical `allow_only` remains ignored; malformed historical `allow_only` is explicitly refused on 0.30 replay. The parent checked 13885 blobs across pi-owed/pi-conductor/wais and found none with this field. PLAN_CACHE_VERSION includes OWED_VERSION, isolating old caches after the release leaf updates the version.
- R-030-AO-2: retain the DC gate equating ruling.nodes with the plan's actual changed-node set. Reject mixed cap no-ops in command preparation, including tool preview, naming unchanged/changed nodes and suggesting separate decisions. All-unchanged and all-changed groups remain valid; writes additions make a node changed. CLI/tool tests assert identical file and ledger bytes after refusal.
- R-030-AO-3: translate shipped notes to English. Update only the exact CLI HELP literal digest and register the exact new grantHint literal as a cycle-blocked remedy: needs imports reducer, so reducer cannot import needs. No scanner, assertion, negative fixture or function-wide exemption changes. Rerun typecheck, allowonly, needs-structure and English, reusing the full run's other 1916 passing tests only if its src subtree matches the final commit.
- Caps constrain file paths, not functions or diff hunks. Own writes remain independently authorized; no redesign or expanded milestone.

## Existing test changes and authority

1. `test/decide.test.ts`, DC2 writes-only validation: replace the title-tampering refusal regex `writes-only` with `writes additions.*allow_only replacements`. AO6 permits cap replacements; the illegal title-change rejection assertion remains.
2. `test/writesglob.test.ts`, WG2098 unknown syntax: change the forged unknown value from 3 to 4, because AO5/R-030-1 explicitly authorizes 3. Uncapped genesis/plan/edit/amend still require 2; unknown values still must be refused.
3. `test/needs-structure.test.ts`, PR2 exact command sites, R-030-AO-3: replace CLI HELP's raw-source SHA256 with `40f6061185e39e58253c05cf547c0f3d7cd51ea1f50741ba108da9c5e8b82344` (existing help/usage classification). Register only grantHint's new literal SHA256 `a9f32308f9458c842bb4f53d5e17deff133a852f434504ec3e669ff77f2ac305`, with the parent-approved cycle-blocked remedy reason. Scanner, assertions and all negative fixtures remain byte-identical.

New `test/allowonly.test.ts` has 12 top-level regressions: normal grants; sibling/suffix refusal; empty caps; own writes; globs; partial grants; old grants/carry/cold and snapshot replay; forged grants; keys/downgrades; syntax/old reader; decide rollback; CLI/tool/packets; multi-node changes and mixed no-ops.

## Writers and concurrency boundary audit

- Plan writers retain planBlob/storePlan, planDrafts and init recording paths, setting syntax 3 when capped. Extension authority preview uses the same dialect.
- Decide prepares and validates before the lock. Under ledger.withLock it rechecks plan/candidate/rules/runs/halt and guards/replays all drafts, then stages a temporary plan file, appends once, and renames. Append failure removes the temporary file. Lock order and transaction boundaries are unchanged.
- Measurement checks jobCurrent before recording under the lock; stale keys append no grant/obs. Attribution uses the original plan and neither erases a failure nor converts it to pass. Effective permissions remain separate from audit receipts.

## Validation ledger

All node/tsc/tests execute through `/tmp/owed-ipc/run.sh` on IPC. Complete logs and actual exit codes are retained. `<slot>` below is the worktree listed above.

- Final regressions on the detached baseline: `/tmp/owed-ipc/run.sh /tmp/owed-ipc/o-allowonly-red-1 600 "node --test --test-reporter=tap test/allowonly.test.ts"`.
  - Exit 1 (expected red); 12 tests, 0 pass, 12 fail; log `/tmp/owed-ipc/logs/o-allowonly-red-1-194236.log`; tree `d76410372313a42d03cd766645e3e1b1826ddb95`.
  - The first behavioral failure incorrectly accepts the sibling/suffix candidate (true !== false); the empty-cap case also incorrectly allows paths. Red is not solely a missing-export error.
- Final focused set: `/tmp/owed-ipc/run.sh <slot> 600 "npm run typecheck && node --test --test-reporter=tap test/allowonly.test.ts test/amendcovered.test.ts test/amend.test.ts test/writesglob.test.ts test/grant.test.ts test/granthint.test.ts test/allowances.test.ts test/edit.test.ts test/decide.test.ts"`.
  - Exit 0; typecheck passed; 100 tests, 100 pass, 0 fail; log `/tmp/owed-ipc/logs/o-allowonly-1-194244.log`; tree `c45cfd6e4fcb3cba51ff2bdf71f0dbe30aaa9825`.
- Earlier focused logs `/tmp/owed-ipc/logs/o-allowonly-1-193000.log` (93/96) and `/tmp/owed-ipc/logs/o-allowonly-1-193631.log` (98/99): wrong dialect in a new test, two AO5/AO6-authorized old assertions, and a mistaken new attribution assertion. All were fixed and checked by the final set, without changing scheduling to satisfy an incorrect assertion.
- Full suite: `/tmp/owed-ipc/run.sh <slot> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`.
  - Exit 1, not a timeout; 1918 tests, 1916 pass, 2 fail; duration 1328548.742723 ms; log `/tmp/owed-ipc/logs/o-allowonly-1-194439.log`; tree `8b2cb63588b3f75f6982fb6214766fa26fe7584b`.
  - Failures: shipped English rejected the Chinese notes; PR2 found the two exact command sites above. Only notes and the two registry entries changed afterward; no src or behavioral test changed.
  - Full-run src subtree `4c0b99123e21f90886c25a69dabccaf5547999d8` equals the current/final src subtree. Verified via `git rev-parse 8b2cb63588b3f75f6982fb6214766fa26fe7584b:src` and the current temporary-index tree's src; `git diff --name-only <full-tree> -- src` is empty. Final commit verification repeats this equality. Reuse of the other 1916 passes is authorized by R-030-AO-3; no second complete suite is claimed.
- Post-fix checks: `/tmp/owed-ipc/run.sh <slot> 600 "npm run typecheck && node --test --test-reporter=tap test/allowonly.test.ts test/needs-structure.test.ts test/english.test.ts"`.
  - Exit 0; typecheck passed; 20 tests, 20 pass, 0 fail; log `/tmp/owed-ipc/logs/o-allowonly-1-201015.log`; tree `d2a70560f83d8755e2fe67fbe055ec889a8635d1`. Final changes after this run only update these English validation notes; final src/test subtrees equal the post-fix run. Both previously failed checks now pass; no second full-suite run is claimed.
- Local `git diff --check` passed.

## Source budget

`git diff --stat 1e8540a -- src`:

```text
 src/cli.ts       |  8 ++++----
 src/edit.ts      |  4 ++--
 src/exec.ts      |  4 ++--
 src/extension.ts |  8 ++++----
 src/git.ts       |  2 +-
 src/ops.ts       | 46 ++++++++++++++++++++++++++++++----------------
 src/plan.ts      |  7 ++++++-
 src/reducer.ts   | 35 ++++++++++++++++++++++-------------
 src/types.ts     |  6 ++++--
 src/views.ts     |  2 ++
 src/writes.ts    | 28 +++++++++++++++++++++-------
 11 files changed, 98 insertions(+), 52 deletions(-)
```

Net +46, below the AO budget of +150.
