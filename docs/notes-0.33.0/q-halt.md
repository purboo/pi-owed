# q-halt (0.33.0): transient dsa reads and newer generations never halt (HT1-HT5)

## HT1: read retries and the 10-minute rule

- `Dsa` reads (describe via `inspect`/`describe`/`request`, the attest status poll inside `command`, `status`,
  `leases`, the `--help` feature probe) go through one helper, `read`. With `retryReads` on, a read that times out
  or ends by a signal is retried up to three more times after 1 s, 3 s and 9 s (`READ_PAUSES_MS`; `readPausesMs` for
  tests). A non-zero exit or unparsable output is not retried. No retry after `killAll` (hard stop) or while an attest
  status poll is stopping.
- A read still failing throws `DsaError` with `transient: true` (`transientRead(e)` also accepts the wording
  `timed out` / `ended by signal` of older fakes). `command` returns `{outcome:'error', transient:true, call}`.
- The transient feature probe is not cached: the next call probes again (legacy path meanwhile).
- `retryReads` is off by default and the `Driver` turns it on for its client. Reason: the driver's reads are the only
  ones whose failure can halt a node. One-shot display reads keep a single attempt: submit's model lookup
  (`ops.ts`, `timeoutMs 5000`), answers, question listings, the watchdog. With retries on everywhere, `owed submit`
  inside a fake-dsa agent took 4 x 5 s + 13 s (the fake's describe waits on the lock held by the run that executes
  the agent), which broke `test/surface.test.ts` "SF2 fresh start". Parent: reject this if every owed read must retry.
- Driver (`src/drive-run.ts`): `readFailed(key, call, error)` / `readOk(key)` keep one failure streak per read,
  timed with `DriveOptions.clock` (default `Date.now`). On the first failure of a streak the driver logs one loop event
  `read-unavailable`, shown as `dsa read unavailable: <call>: <reason>`. It does not halt or wake, and the action is
  decided again on a later pass. Once the streak is 10 minutes old (`READ_HALT_MS`) the driver halts the node with
  `dsa reads failing for 10 min: <call>: <last error>` and the streak starts again. A success ends the streak.
  - Writer/reviewer describe in `observe`: a transient failure replaces the `describe-failed` notify. Non-transient
    failures still notify as before. A halted or waiting node is not halted again.
  - Attest status read: see HT3. The streak key is `attest <node>`, because the attest request id changes with the
    ledger length.
  - The driver's own one-time describe retry (F4, wais #34) is removed: the client retries now.

## HT2: read timeout

`Dsa.readTimeoutMs` = option `readTimeoutMs`, else `$OWED_DSA_SHORT_MS` when it is an integer 1000-120000, else the
client's `timeoutMs` when given, else 15000 ms (`SHORT_MS_DEFAULT`). Every read uses it unless the caller passes its
own limit (`describe(rid, ms)`). This replaces the 2000 ms of the attest status poll. A plain `new Dsa()` read used to
inherit the 90 s write limit and now has 15 s. Any other value of the variable is ignored, with one stderr line per
process and value: `owed: ignoring OWED_DSA_SHORT_MS="<v>" (expected an integer 1000-120000); read timeout 15000 ms`.
Write calls (run, send, stop, and the run/stop of `command` at 2000 ms) are unchanged.

## HT3: attest result from the ledger

`attest()` gets the node's `attestJobs` from the pass state. Every attest error (status read failed or unavailable,
lost response, unknown/invalid seal, hold refused/signal, owed exit 2/3) goes through `fail`. At reap time, `fail`
first checks the ledger: every job needs an observation at or after the attest's start (ledger length) with the same
subject, obligation and key and a pass/fail verdict. When all jobs have one, the attest reports `done` exactly like a
returned attest (`accepted`, or `measured; not accepted yet: <need>`) plus `; attest result taken from ledger #<seqs>`.
Nothing is halted, and the next pass merges or repairs from the ledger as usual. Otherwise a transient status read
yields `retry` (no halt, no wake; the attest is decided again and re-attaches to the same request id while the ledger
length is unchanged), and after 10 minutes the 10-minute halt. Any other error halts with `attest error: …` as before.

## HT4: newer generations

- Before executing a decided `halt`, or a new `repair` follow-up, the driver checks whether that decision was made on a
  sealed/pruned writer view. If so, it describes the writer again. When dsa reports a newer generation that is running,
  queued or asking, the driver does neither. It reports outcome `waiting` with the line
  `waiting: <rid>[ (to:…)] generation <n> is running` (no wake) and decides again later. A running generation is never
  halted, so the halt or repair is re-decided only after that generation ends. A newer generation that already ended
  yields `stale` (decided again next pass). A transient failure of this describe skips the action this pass (outcome
  `unavailable`, no wake).
- Every driver halt records the writer generation it concerned (`facts.lastGen`) in `drive/halt-gens.json`, keyed by
  node and halt seq. Each pass, the driver writes `drive/stale-halts.json` (tmp + rename) with the active halts whose
  writer now runs a newer generation: `[{node, seq, rid, gen}]`.
- `assembleRuntime` (`src/activity.ts`, ruling #3977) reads that file only while a driver runs. It keeps rows whose
  seq is still the node's active halt and sets `Runtime.staleHalts` only when one remains. Absent, unreadable, no
  driver or none left: the field is absent, and status/why JSON is unchanged.
- `src/needs-types.ts` stays byte-identical (its sha is pinned by `test/activity.test.ts` "AC vocabulary is the
  byte-for-byte pinned needs-types sha" and `test/needs.test.ts` "NE18 pinned vocabulary is byte-identical to the
  contract sha"). The optional field is added as a type-only module augmentation of `Runtime` in `src/activity.ts`.
- Views: `StatusView.staleHalts` and `ReceiptCard.staleHalt` (present only when non-empty). The line
  `stale halt: generation <n> is running (<rid>)` appears in `owed status` (default and `--full`, `⏸ <node>: …`) and in
  `owed why` (default and `--full`, `⏸ …`). Halts the driver did not record (or recorded before 0.33.0) are never
  shown as stale.

## Changed existing tests

None: no existing test file is changed (`test/fixtures/fake-dsa.mjs` only gains two new fault kinds, and
`test/removed.test.ts` has the two F4.5 cases listed below).

- `test/removed.test.ts` "F4.5 (#34) … retried once …", renamed "F4.5 (#34) / HT1: … transient …". HT1 moves the retry
  into the client (1 s/3 s/9 s), so the driver describes once per pass. A describe still timing out is transient: one
  `dsa read unavailable` line per streak and no `describe-failed` notify.
- `test/removed.test.ts` "F4.5 (#34): a describe failure of a node waiting …": `inspects >= 2` becomes `>= 1` for the
  same reason (HT1). The assertions that nobody is notified are unchanged.
- `test/fixtures/fake-dsa.mjs`: new faults `describe hang [ms]` and `describe signal`. Nothing existing changes.

## Tests (test/halt0330.test.ts)

Client retries (timeout, then signal, then success; counted), persistent timeout/signal giving a transient error,
no retry for a non-zero exit, the 15000 ms default and `OWED_DSA_SHORT_MS` parsing and warning, reads vs writes
limits, driver: timeout then success (no line, no halt, retries counted), persistent failure (no halt at 9:59 on the
injected clock, halt at 10:00 with the reason), a success restarting the streak, attest error with the measurements
in the ledger (unknown seal and timed-out status read: no halt, `done … taken from ledger #n`, then merged), the
opposite (halts), a transient status read with nothing in the ledger (retry, no halt), a newer generation suppressing
halt and repair (and both following once it ends), the stale-halt file and its display in status/why with a lock
held, absent without a driver, ignored for a superseded halt and for a torn file.
