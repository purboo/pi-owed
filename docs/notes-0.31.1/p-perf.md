# p-perf — 0.31.1

Base: `590bdca9940e8e20fe1419f7d167219a2af5cfa7`. Implements parent rulings R-0311-PP-1 and R-0311-PP-2. **R-0311-PP-3 accepts the measurements and equality evidence.** The digest harness RSS is an observed equality-harness figure outside the PP-1 command cases, not a failed acceptance criterion; no reduction is requested. This writer does not submit the slot.

## Scope and reproduction

Read F-D/R1370. A shared, no-checkout clone at `/tmp/owed-perf/p-perf-0311/app` contains copies of the live ledger, plan cache, snapshot and blobs. No operation ran with the live repository as cwd. The captured ledger has 21,738 entries (last seq 21,737), 805 plan versions; original ledger SHA256 `192cf05bca983bb75a618952f235f5789ee91d38b449e4ec9b3d4bacca684304`. Candidate resubmitted: `FIX-D2-READ-ATTACH-HOST`, attempt 1, commit `1b0dc248d30a70c1a80ee76e3e2034f65c80b449`.

Phase A reproduced the minutes-long submit only after removing the disposable snapshot: cold submit 301.676 s, replay 295.787 s, output 3.264 s. With the copied snapshot, submit was 9.476 s. Profiles identified repeated node/check lookup (planWrites 47.76 s inclusive, quarantineDowngrades 38.53 s), downgrade comparison (82.55 s inclusive), plan reads (36.759 s) and dependency weight traversal (0.81 s of snapshot status). Inclusive phases overlap. No evidence supported skipping conflict checks or changing output.

PP-1 reuses the existing frozen-plan node index for writes/grant lookup, builds local first-match indexes for quarantine/downgrade comparison, and computes mergeQueue weights only for returned eligible nodes. Mutable plans retain direct lookup; duplicate IDs retain first-match behavior. No rule cache, larger plan LRU, key, vote or ledger change.

PP-2 stores snapshots in `snapshot/state-<encodeURIComponent(version)>.v8`. Read/write/verify-removal target only the current version; legacy and foreign filenames are never read. Successful publication retains the current file plus two newest other cache files by mtime. Retention skips directories/temp files, rechecks inode/mtime before deletion and ignores errors. The format and validation are unchanged.

## Snapshot investigation and persistence boundaries

Snapshots validate format, exact package version, payload digest/type, seq/hash and correspondence with the verified ledger, then unpack state through the plan lookup. They have no source-code hash. Ordinary plan entries are incremental folds, not invalidation. A new version without its own valid snapshot requires a cold replay; this also happens once when moving from the legacy filename to PP-2. A current-version snapshot whose seq/hash no longer matches the ledger is ignored. Ops normally writes after 256 folded entries or when no usable snapshot exists; in-process memoization uses a separate 32-entry interval.

Read-only live evidence placed CLI 0.31.0 installation at approximately 10-20 04:37Z, the driver still on 0.30.0 until 06:04Z, and F-D submit #20462 at 05:07Z. Both versions wrote `state.v8` and rejected the other's envelope version. This supports mixed-version overwrite as the cold-replay explanation; it does not prove which process last wrote the now-replaced historical file. PP-2 prevents that cross-version overwrite.

Snapshot write remains temp + atomic rename; publication is the rename commit point. Ledger locks and ledger append/rollback are unchanged. Verify removes only its own version. Retention is derived-cache cleanup after publication, with no new locks: racing replacement detected by inode/mtime is left alone. There remains a best-effort stat/unlink race with concurrent cache replacement; a lost cache can only trigger replay, because every read validates it against the ledger. A successful publication is never reported failed because retention failed.

## Before/after measurements

Bench: `test/perf/perf-0311.ts`. Loader hooks instrument named phases without editing product source. Each case runs in a fresh process with CPU profiling, the same disposable repo and machine:

`pi-durable-subagents hold machine --shared -- nice -n 19 timeout 900 node --max-old-space-size=6144 --cpu-prof --cpu-prof-dir=<profiles> --cpu-prof-name=<case>.cpuprofile <source>/test/perf/perf-0311.ts <operation> <copy> FIX-D2-READ-ATTACH-HOST 1b0dc248d30a70c1a80ee76e3e2034f65c80b449`

Set `OWED_PERF_PHASES=1`; `OWED_PERF_TS=2026-10-21T00:00:00.000Z` fixes appended time and rendered relative ages. `OWED_PERF_ARTIFACTS=<dir>` saves digest/output artifacts. Digest requires removal of the disposable snapshot. Snapshot before/after uses the same original payload, copied to each implementation's filename. Submit includes ops.submit plus CLI-equivalent rendered status. There have been **12/14** authorized local performance invocations, including both output-equivalence runs.

| Case | Wall s before → after | CPU user/system s before → after | Wall change | Peak RSS MiB before → after | RSS change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cold submit | 301.676 → 104.147 | 220.395/7.297 → 106.648/5.198 | -65.48% | 1176.20 → 1207.96 | +2.70% |
| Snapshot submit | 9.476 → 5.715 | 10.230/0.811 → 6.846/0.812 | -39.69% | 795.13 → 809.24 | +1.77% |
| Snapshot status | 6.990 → 3.817 | 7.582/0.521 → 4.486/0.552 | -45.40% | 520.66 → 519.47 | -0.23% |
| Snapshot why | 7.037 → 3.538 | 7.961/0.405 → 4.481/0.396 | -49.72% | 520.07 → 520.70 | +0.12% |
| Diagnostic cold digest + outputs | 228.728 → 94.360 | 202.862/6.908 → 101.879/4.882 | -58.75% | 1241.45 → 1370.30 | +10.38% |
| Fixed-clock snapshot output comparison | 36.768 → 9.960 | 22.402/1.844 → 10.953/1.343 | -72.91% | 891.10 → 911.89 | +2.33% |

Cold-submit before was run after the first baseline submit (21,739 input entries), whereas after starts from the original 21,738-entry ledger; both append one entry and replay once. This one-entry difference is disclosed rather than called identical input. The exact-input cold digest comparison establishes state equivalence on all original entries. Snapshot cases fold 239 entries with ten plan misses on both sides. Plan LRU remains eight.

Cold-submit after: replay 100.478 s, plan reads 14.348 s, operation 102.636 s, output 1.509 s, candidate facts 0.464 s, review carry 0.001 s, append 0.566 s, conflict scan 0.046 s. Snapshot submit after: replay 2.492 s, operation 4.382 s, output 1.333 s, facts 0.393 s, append 0.497 s. Snapshot status replay 2.422 s / conflicts 0.039 s; why replay 2.463 s / conflicts 0.064 s. CPU user/system milliseconds, full phase data and profiles are in the logs below.

Cold submit passes the 241 s ceiling and 30% stretch target. Snapshot status passes 5.94 s; every snapshot operation improves, and their RSS increases are below 5%. Under R-0311-PP-3 the diagnostic digest's +10.38% RSS is recorded as an observation outside PP-1's command cases, not a PP-1 failure. Its full-state canonical serialization and repeated operations differ from the CLI workload; the cause of its increased peak is not established, and no further memory work is authorized.

## Exact equivalence

The original-entry cold replay stable-state digest is identical:

`e8d829fc07ea94058a8b026f61b0bef6f306f1cca9709df834b53846e381de3b`

Initial status comparison differed only in elapsed-age strings because the first benchmark revision fixed entry time but not Date.now. The benchmark now fixes both; independent before/after output invocations agree byte-for-byte. why and entry already agreed in the original cold run. The full entry, including fixed ts/seq/hash, agrees (stronger than the required field exclusions).

| Artifact | Identical SHA256 |
| --- | --- |
| status.txt | `39a8eb56442bfb197ee797a0ad523e4fa35d70a1a6346a1f4712369ee36a6032` |
| why.txt | `cd35afcae0e78335e868b47b29e7841240ba672ae2c08d4f1625838110d1a305` |
| entry.json | `e2f6b007003c22bb09e9a291c0f1a44a85af65144f722563579ab6c3abc5a933` |

Artifacts: `/tmp/owed-perf/p-perf-0311/{equality-before,equality-after,outputs-before,outputs-after,logs,profiles}`. Original source archive at `p-perf-base-0311/` contains 590bdca product code plus the new benchmark/regression tests for comparison.

## Validation and changed existing tests

No existing test was changed. New `test/perf0311.test.ts` covers first-match lookup, mutable plan reads, removed open-slot writes, quarantine additions/changes, downgrade first-match, and 80 small dependency graphs against the literal 590bdca queue implementation (ties, merges, diamonds, cycles, absent nodes). PP-2 tests cover alternating versions, escaped filenames, legacy/foreign isolation, current-version deletion, retention beyond three, ignored directories/temp files and failed publication.

The first test fixture omitted the existing mandatory owner note on plan removal; it failed equally on both trees and was corrected without product changes. Corrected red test on isolated 590bdca: 4 pass / 2 fail, precisely the new snapshot isolation and retention requirements; 0.35 s, exit 1. Candidate new tests pass; no behavior exception is hidden in existing tests.

All tests/typecheck ran on the bench host via `/tmp/owed-bench/run.sh <worktree> <timeout> '<command>'`:

| Check | Command (bench timeout) | Result | Measured tree | Full log |
| --- | --- | --- | --- | --- |
| Baseline red | `node --test --test-reporter=tap test/perf0311.test.ts` (120 s) | Expected exit 1, 4 pass / 2 snapshot regressions fail | `cce382cbee4e2582e2d393e11263b087365ce7ba` | `/tmp/owed-bench/logs/p-perf-base-0311-015318.log` |
| Typecheck + node checks | `npm run typecheck && node --test --test-reporter=tap test/perf0311.test.ts test/perf.test.ts test/snapshot.test.ts` (1800 s) | Exit 0, **29/29**, tests 136.38 s | `2343c82bef3c3f3eda8153d7d6dff4f984492cfd` | `/tmp/owed-bench/logs/p-perf-1-015320.log` |
| Full suite | `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (2400 s) | Exit 0, **2102/2102**, 1434.47 s | `2343c82bef3c3f3eda8153d7d6dff4f984492cfd` | `/tmp/owed-bench/logs/p-perf-1-015602.log` |
| Final benchmark typecheck | `npm run typecheck` (180 s) | Exit 0, driver 20.67 s | `71eb467a045f07edc64b3d195943a17ea644f100` | `/tmp/owed-bench/logs/p-perf-1-022637.log` |

**Tree difference requiring parent disposition:** product source, SPEC and regression tests are identical to the suite-tested tree. `test/perf/perf-0311.ts` differs: after that suite, the standalone benchmark gained the deterministic Date.now clock and `outputs` mode used for the successful byte comparison. These changes were performance-run and typechecked, but the suite was not rerun. They are retained for reproducibility rather than silently reverted. Thus the commit differs from the suite-tested tree in this benchmark **and** the notes, not notes alone. Per PP-3 no additional check is being launched; the parent decides whether further validation is required. Relative to the final typechecked tree, only these notes differ. The final typecheck was launched before PP-3 and completed in durable run `01M5D91FKFBHKH49N0G7K3JMRF`.

Durable runs: `01M5D74EP59076FDXM5FWMFSRC` (bench passed; measurement driver exited 92 for the unfixed status clock), `01M5D8RCXHKBBFH87WMA1DJVDE` (fixed-clock equivalence and remaining measurements, exit 0). Local results are recorded in `logs/exits.txt`; all 12 node invocations exited 0.

Selected log SHA256:

- before-submit: `beafa428ce1b5ff2b878fb42c65b69dd55ed084f9d0df35f24dea4ddc24232ac`
- before-status: `9fa5595e97e95bc8a739c822ff76b3ed3012d57dafd8a17a11b80a736f144805`
- before-why: `29542d5263d4e32944da6d2e8a0223b9c02ad4e9221e1d30462cb1172d217dc5`
- before-cold-submit: `2002a6cb4187a13b9a77ff41a3edb710d90e4afb0bb6457f86c5fee2e4bc5fdc`
- after-cold-submit: `1ec765f3339c7c5f88d5c0fc0202be649ad9b408bdb690f0d84ae06f753b318f`
- after-digest: `d1ed758d7a23b3ad518bd98e64764fb296cee4460dbf8c5bdae1312e3c465f5b`
- after-submit: `79b79c8e41a806f962d99eabd223f53ea8a2032a506b61cca4253c5284dcd041`
- after-status: `08cf1d311e7d8079a41b1052d09cb4511d979713043ed3e7f443d645a6ef22de`
- after-why: `315d8ed70b9a046340a0cfa9c63c5933397bde50ff5bfa247c6948f6546a48a5`

- before-digest: `68d10fd79e3aa8fb58287859724bef9747abff8fb1eda84485884cc76e825b97`
- before-outputs: `b9d5efbf794706788631523916678426427186c26b01255c63b60fbb574da81b`
- after-outputs: `e6926de84f68a2e954be2aa51ebbcb9d2f46e6683b74769efa6a02b9b2177fed`
- bench focused: `df0f3ed84df3fbe3673a9a0603698f654e3fcbee0350d4e1b9aa6f96fb554216`
- bench suite: `9eca3481b04678e20152e55ff6b6110133231e6ab1163270cb1cf5fe7f1440b6`
- bench final typecheck: `14c1fb6f4e3900bb2a2b48c9505aa5e2fd4dda10e10c4c4c9f07bbc3e81520a4`

## Source diff and handoff

`git diff --stat 590bdca -- src`:

```text
 src/ledger.ts  | 27 ++++++++++++++++++++++-----
 src/plan.ts    |  8 +++++++-
 src/reducer.ts | 18 +++++++++++-------
 3 files changed, 40 insertions(+), 13 deletions(-)
```

Net **+27** source lines, within PP-2's +130 budget. SPEC G1.4 documents the filename and retention. No version/release metadata change. R-0311-PP-3 accepts the measurements; the benchmark difference from the suite-tested tree is explicitly handed back for parent disposition. No live repo writes, publication, merge, or owed submit. Writer stops after committing.
