# 0.31.2 session-owned notifications

Scope: SN1-SN6 on baseline `7537f144f475b01f1090ab2248ac7d3547922de4`.
Writer role: commit and stop; no submission, rebase, attestation, merge or plan acts.

## Behavior

- Automatic attachment requires the current validated pi context identity to own
  the live driver. Reads, refusals, startup cwd and foreign-driver reuse do not
  subscribe a stranger. Matching owners still discover drivers across repos.
- Pi starts pass context identity explicitly across the native worker and ops
  boundary into the child environment without changing shared `process.env`.
  Unavailable context keeps validated DSA-first / PI fallback; CLI lock and run
  semantics and child exclusion remain unchanged.
- Automatic followers retain their owned log inode through foreign replacement,
  preserve owned terminal delivery, and do not read the replacement log. Busy
  buffering, revalidation and per-follower cursors remain independent.
- Identity changes retire followers and idle observation; host callback delivery
  checks identity again. Only observed owners or successful explicit init arm idle
  watching. CLI watch is independent explicit opt-in; its cursor is unchanged.

## Existing test changes

- `test/follow.test.ts`: the two positive FW1 tool/refusal scenarios now provide
  matching lock/context ownership; the fixture supports explicit lock overrides.
  FW3's no-session message expectation now states no automatic delivery. Registry,
  child-exclusion and CLI cursor assertions are otherwise unchanged.
- `test/driver0311.test.ts`: the PD fixture records `pd-session` to match its host
  context, preserving replay and refusal-path positive controls under SN1.
- `test/tool-worker.test.ts`: the harness and the two watcher locks identify
  `worker-session`; latency and rejected-delivery assertions are unchanged.
- `test/drive-bg.test.ts`: the host and synthetic live locks identify `bg-session`;
  two titles clarify owner-only positive controls. The same-session witness still
  demonstrates independent followers, not repo-wide broadcasting.
- `test/fixtures/shutdown-child.ts`: supplies the matching `bg-session` context so
  the existing lifecycle cleanup test still proves a real owned follower exits.
- `test/drive-live.test.ts`: the host and synthetic live locks identify
  `live-session`, retaining busy/revalidation coverage for an authorized observer.
- `test/surface.test.ts`: SF6's two positive watcher instances now carry the
  same `surface-owner` context. The test still proves replay for both fresh and
  reused owned drivers and follower-local deduplication; it does not authorize
  stranger reuse to subscribe.
- `test/needs-structure.test.ts`: refreshes the exact CLI no-session hint and
  drive description hashes, and adds one classified exact reply literal for the
  new explicit-watch hint. Unrelated abandon/genesis literals retain their
  original entries. No behavioral gate is relaxed.

## New regression coverage

`test/session0312.test.ts` uses the real extension/native-worker seam for same-cwd
owner/stranger, resume, cross-repo discovery, reads/refusals/reuse, missing identity
and ownership, validated fallback, context/env disagreement on fresh starts,
DSA exclusion, identity switches, replacement/terminal behavior and idle watch.
It also checks explicit CLI watch and replacement during async revalidation.
A test-only clock inside an actual native worker proves the 120-second idle path
without adding a production test hook. On the baseline, the first test fails
with `ERR_ASSERTION`: the stranger receives one wake instead of zero.

## Evidence

Initial committed check: `eba5f7ef222e042a191bab234ede67c5b299f73a`, tree
`c61c27ac97c0f318bdb5627b514374dc04d19432`, clean mirror.
Command (420-second IPC bound):

```sh
node --test --test-concurrency=2 --test-reporter=tap test/session0312.test.ts test/driver0311.test.ts test/drive-bg.test.ts test/follow.test.ts test/drive-session.test.ts test/surface.test.ts test/tool-worker.test.ts test/watchdog.test.ts test/drive-live.test.ts test/needs-structure.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Log: `/tmp/owed-ipc/logs/q-session-1-170431.log`. Focused exit 1: 114 tests,
111 pass, 3 fail, 0 cancelled/skipped. Typecheck exit 2: one optional-session
fixture type error. Combined wrapper exit 1, elapsed 158736 ms. Failures were
an idle fixture with no actionable work (`later:true`), an SF6 positive watcher
without identity, and two wrongly replaced inventory hashes. Repairs retain
all assertions and correct those preconditions; the idle test now uses ready
work. An additional source repair keeps the owned inode when a replacement has
already released its lock, with a new behavior regression. Same-owner reconnect
and in-flight host identity delivery controls were added.

Passing check: `73566753583fc2dbc5ee01a12d66db1f278f9bd7`, tree
`b0ac548f7a119bdbde00659649b0972a8498dc50`, clean mirror. The same focused
and typecheck commands above passed: focused exit 0 (117 tests, 117 pass,
0 failed/cancelled/skipped), typecheck exit 0, combined exit 0. Durable run
`01M5EVK25CHAMXJDF6SGTPMQDN`, elapsed 148376 ms, log
`/tmp/owed-ipc/logs/q-session-1-171003.log`, SHA-256
`d0951f17e6fe57e5cdec5694c4efc5d82b9baea7ab65b1418787075888ef9db2`.
The final evidence commit changes this notes file only; source and tests retain
this tested tree's contents, so no further suite run is needed for that commit.

Baseline red: exported `git archive --format=tar
7537f144f475b01f1090ab2248ac7d3547922de4` (archive SHA-256
`e3b69cce98d6fda72958b48c535d0586c03b2ffec8313fc56e7b76cc31205a66`)
to an IPC temporary directory, copied only the candidate's
`test/session0312.test.ts` over it, linked the mirror dependencies, initialized
a local fixture git repository, and ran:

```sh
node --test --test-reporter=tap test/session0312.test.ts
```

The 180-second bounded command's exact preparation is in the log header; its
EXIT trap removed the isolated directory. Durable run
`01M5EVSDWWPFP5GTPZTD5E5CJW`, elapsed 10940 ms. Expected red exit 1:
13 tests, 2 pass, 11 fail, 0 cancelled/skipped. First failure at test line 57:
`opening another pi in the same cwd must not replay the owner log`, expected 0,
actual 1, code `ERR_ASSERTION`. This proves the behavioral failure before the
fix rather than an import/setup failure. Log
`/tmp/owed-ipc/logs/q-session-1-171331.log`, SHA-256
`d0398c85a21ca28fdf3778f6470bc01cb261ad58c8476407c3608e6a9fb01161`.

All Node checks ran through `/tmp/owed-ipc/run.sh`, under
`pi-durable-subagents hold machine --shared`. The full suite is reserved for the
parent's merge invariant; this writer does not publish.

CJK scan: `rg -n '[\\p{Han}\\p{Hiragana}\\p{Katakana}\\p{Hangul}]'` over all
18 changed files returned only existing `test/driver0311.test.ts` fixtures at
lines 78, 85, 142 and 148. Its diff changes only the owner session fixture at
line 39. Shipped prose is English; those CJK fixtures exercise UTF-8 replay and
cursor handling. No new CJK prose is introduced. Runtime registry and idle
claims remain best-effort state, not a new ledger ownership record.
