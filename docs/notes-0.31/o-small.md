# o-small — 0.31 SM1–SM4

Base: `ebf090b83644c4bb170802b97053bc17cd09a910` (0.30.0).
Ownership: only packet-authorized files; no sibling work taken over. No local node/tsc/tests.

Implemented:
- SM1: CLI seq/comma-list/latest and tool integer/string/nonempty integer-array inputs normalize to the existing single numeric ruling watermark. Malformed input refuses with usage error; required/future-watermark review validation remains intact.
- SM2: incomplete genesis refusal names `owed attest --genesis`; both adoption and merge guard diagnostics use the same hint.
- SM3: exclusive top-level drive target in CLI/tool; YAML Document map edits retain external bytes/comments where safe, validate final plan, and reuse existing plan authority, carry, lock, append/rename and dry-run paths. Drive has no node rule/resume target.
- SM4: named shared code-point/escape-aware sentence/whitespace/CJK clipping helper; structured details suffix points to full dsa describe JSON; review asks and driver evidence use the helper.
- R-031-SM-1 (#3714): writer head uses new boundaries and existing ` … ` separator; tail retains original ending, moving its start only within the existing 20-code-point window. Replies <=600 code points stay whole.

Changed existing tests (only contract-driven assertions):
- `test/owriter.test.ts`: one head-boundary assertion now ends at whitespace beyond the obsolete 20-code-point head retreat window; test title updated. Tail/end retention and 600/601-code-point tests remain.
- `test/structask.test.ts`: apply the existing <=300 details limit to the details payload, then verify the newly required full-question command suffix separately. Option/context limits remain.
- `test/asks026.test.ts`: the 300-character clipped ask now ends in the required ellipsis (299 original characters + ellipsis).
- `test/repair-epoch.test.ts`: keep the <=200 bound and single-line/ellipsis checks, but assert the required whitespace boundary instead of splitting the long following word to fill all 200 characters.
- `test/needs-structure.test.ts`: replace the exact CLI HELP digest for SM1/SM3 grammar and register the two exact SM2 guard refusal literals; no wildcard site exemption.
- `test/perf/differential.ts`: adapt only the exact SM2 genesis diagnostic in baseline query/refusal presentation. Frozen 0.10 fixtures, replay facts, keys, evidence and verdict comparisons remain unchanged. This serves existing `perf.test.ts` and `snapshot.test.ts`.
- All new regression coverage is in `test/small031.test.ts`: CLI/tool acknowledgment and atomic refusals, adoption with deliberately failed genesis execution, drive edit/create/flow/comments/atomic append failure/dry-run/schema/exclusivity/tool/verify, sentence/word/CJK/escape limits, writer tail hash retention, driver environment evidence, and a full-details command executed against a deterministic dsa fixture.

Source budget, `git diff --stat ebf090b -- src` (121 changed lines, <=130):
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

Validation (all runtime commands via `/tmp/owed-bench/run.sh`, no local node/tsc/tests):
- Tested tree: `b761cf6e7f653ed8a34a35a3e23ab62688379890`. Only this handoff's receipts changed after the passing run; source, tests and SPEC are identical.
- Baseline detached `ebf090b`, only new test copied: `node --test --test-reporter=tap test/small031.test.ts`, exit 1, 0/7 pass. Log `/tmp/owed-bench/logs/owed-small031-red-ebf090b-084503.log`. Reasons: old ack parser rejects lists; adoption omits completion command; CLI has no drive edit flag; old review/details clipping lacks sentence boundaries/ellipsis/full command. No import or fixture failures.
- `npm run typecheck`, exit 0; `node --test --test-concurrency=2 --test-reporter=tap test/small031.test.ts test/edit.test.ts test/multiedit.test.ts test/structask.test.ts test/adopt.test.ts test/cli.test.ts test/owriter.test.ts`, exit 0, 78/78 pass. Combined log `/tmp/owed-bench/logs/o-small-1-084510.log`.
- Same log: targeted rerun of the six first-full-suite failures with `node --test --test-concurrency=2 --test-reporter=tap --test-name-pattern='AK1: the first|English shipped|PR2: every|differential: fuzz|K5.4: each|equivalence: every k' test/asks026.test.ts test/english.test.ts test/needs-structure.test.ts test/perf.test.ts test/repair-epoch.test.ts test/snapshot.test.ts`, exit 0, 6/6 pass.
- Full suite `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (timeout 1800), exit 0, 2036/2036 pass, 1386.826 s. Log `/tmp/owed-bench/logs/o-small-1-084641.log`.
- Durable request `owed-b1da092bfb45-o-small-1-validation2`, run `01M5BC9P33N929AQ3JAHA3R587`, exit 0. `git diff --check` passed.

Remaining: no unmet SM1–SM4 criterion identified. Cross-sibling integration/review is parent-owned. The details command is behaviorally checked against a deterministic dsa fixture; no real runner question was created.

Publication state: slot branch only, no submit/attest/merge/release; parent owns those actions.
