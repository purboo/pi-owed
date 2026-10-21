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
without adding a production test hook. The first behavior assertion is intended
to fail with `ERR_ASSERTION` on the baseline, not an import or fixture error.

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

Focused checks and typecheck run only through `/tmp/owed-ipc/run.sh`, under
`pi-durable-subagents hold machine --shared`. Final focused and red evidence
will be recorded after the bounded run. The full suite is reserved for the
parent's merge invariant; this writer does not publish.

Shipped prose is English. Existing CJK fixtures in `test/driver0311.test.ts`
exercise UTF-8 replay/cursor handling and are intentional; no new CJK prose is
introduced. Runtime registry and idle claims remain best-effort state, not a new
ledger ownership record.
