# o-small — 0.31 SM1–SM4

Base: `dc40bae09aa33083d144d942a5d664910a8c3ac6` (parent-rebased candidate #3729, after o-coretools on main `05440a0`). Repair is one new commit; no amend/rebase. Keep the combined edit description and its `3590c17e...` CT2/CT3 digest unchanged.
Ownership: only packet-authorized files; no sibling work taken over. No local node/tsc/tests.

Implemented:
- SM1: CLI seq/comma-list/latest and tool integer/string/nonempty integer-array inputs normalize to the existing single numeric ruling watermark. Malformed input refuses with usage error; required/future-watermark review validation remains intact.
- SM2: incomplete genesis refusal names `owed attest --genesis`; both adoption and merge guard diagnostics use the same hint.
- SM3: exclusive top-level drive target in CLI/tool; YAML Document map edits retain external bytes/comments where safe, validate final plan, and reuse existing plan authority, carry, lock, append/rename and dry-run paths. Drive has no node rule/resume target.
- SM4: named shared code-point/escape-aware sentence/whitespace/CJK clipping helper; structured details suffix points to full dsa describe JSON; review asks and driver evidence use the helper.
- R-031-SM-1 (#3714): writer head uses new boundaries and existing ` … ` separator; tail retains original ending, moving its start only within the existing 20-code-point window. Replies <=600 code points stay whole.
- R-031-SM-2 (parent accepts independent review #3740): ASCII semicolon is a sentence end only before whitespace/end; fullwidth semicolon is a sentence end without whitespace, like the other CJK marks. Three named regressions distinguish both positive cases and the ASCII no-whitespace negative case. All other clipping behavior stays unchanged.

Changed existing tests (only contract-driven assertions):
- `test/owriter.test.ts`: one head-boundary assertion now ends at whitespace beyond the obsolete 20-code-point head retreat window; test title updated. Tail/end retention and 600/601-code-point tests remain.
- `test/structask.test.ts`: apply the existing <=300 details limit to the details payload, then verify the newly required full-question command suffix separately. Option/context limits remain.
- `test/asks026.test.ts`: the 300-character clipped ask now ends in the required ellipsis (299 original characters + ellipsis).
- `test/repair-epoch.test.ts`: keep the <=200 bound and single-line/ellipsis checks, but assert the required whitespace boundary instead of splitting the long following word to fill all 200 characters.
- `test/needs-structure.test.ts`: replace the exact CLI HELP digest for SM1/SM3 grammar and register the two exact SM2 guard refusal literals; no wildcard site exemption.
- `test/perf/differential.ts`: adapt only the exact SM2 genesis diagnostic in baseline query/refusal presentation. Frozen 0.10 fixtures, replay facts, keys, evidence and verdict comparisons remain unchanged. This serves existing `perf.test.ts` and `snapshot.test.ts`.
- All new regression coverage is in `test/small031.test.ts`: CLI/tool acknowledgment and atomic refusals, adoption with deliberately failed genesis execution, drive edit/create/flow/comments/atomic append failure/dry-run/schema/exclusivity/tool/verify, sentence/word/CJK/escape limits, writer tail hash retention, driver environment evidence, and a full-details command executed against a deterministic dsa fixture.

Original SM1-SM4 source budget at `821be51`, `git diff --stat ebf090b -- src` (121 changed lines, <=130):
```
 src/cli.ts       | 16 +++++++++-------
 src/drive.ts     |  7 ++++---
 src/edit.ts      | 39 ++++++++++++++++++++++++++++++++++++---
 src/extension.ts |  4 ++--
 src/needs.ts     | 16 +++++++++++++++-
 src/ops.ts       | 14 +++++++++++---
 src/reducer.ts   |  4 ++--
 src/views.ts     | 21 ++++++++++++---------
 8 files changed, 91 insertions(+), 30 deletions(-)
```

Validation for R-031-SM-2 (all runtime commands via `/tmp/owed-ipc/run.sh`):
- Tested tree `ead7f713a07d3afe13cd461cf29debd486dfdc48`; only this English handoff's receipts changed afterward. Source and tests are identical to the passing tree.
- Isolated dc40bae plus new tests: `node --test --test-reporter=tap --test-name-pattern='R-031-SM-2' test/small031.test.ts`, exit 1; both positive cases fail with the old whitespace/CJK fallback, ASCII no-whitespace negative passes (1 pass, 2 failures). Log `/tmp/owed-ipc/logs/owed-small031-sm2-red-dc40bae-092447.log`.
- `npm run typecheck`, exit 0.
- `node --test --test-reporter=tap test/small031.test.ts`, exit 0, 10/10 pass (also the exact o-small-red node command on the repaired tree).
- `node --test --test-reporter=tap test/needs-structure.test.ts`, exit 0, 5/5 pass.
- Exact o-small node check: `node --test --test-reporter=tap test/small031.test.ts test/edit.test.ts test/multiedit.test.ts test/structask.test.ts test/adopt.test.ts test/cli.test.ts`, exit 0, 57/57 pass. Typecheck and all focused checks share `/tmp/owed-ipc/logs/o-small-1-092450.log` (timeout 600 s).
- Full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, exit 0, 2051/2051 pass, 1390.161 s (timeout 1800 s). Log `/tmp/owed-ipc/logs/o-small-1-092549.log`.
- Durable request `owed-b1da092bfb45-o-small-sm2-validation`, run `01M5BEJDR7H4V91M2M7XE5JRGJ`, exit 0. `git diff --check` passes. Combined edit description and CT2/CT3 digest are byte-identical to dc40bae.
Prior passing receipts are superseded for this changed tree.

Repair source budget: `git diff --stat dc40bae -- src` = one changed line (1 insertion, 1 deletion). Original SM1-SM4 source budget above remains 121 changed lines against its original base.

Remaining: no unmet R-031-SM-2 requirement identified. Independent re-review and integration are parent-owned.

Publication state: slot branch only, no submit/attest/merge/release; parent owns those actions.
