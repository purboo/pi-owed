# tornread — torn ledger read (contract TR)

## Behaviour
- A `Ledger.read()` that does not hold the ledger lock (`lock`) treats a final fragment of `ledger.jsonl` without a
  trailing `\n` as an append in flight: it ignores that fragment and returns the complete entries before it. The hash
  chain of those entries is verified as before.
- A malformed complete line (one ending in `\n`) is still an error for every reader:
  `ledger seq N: invalid JSON` (code `internal`).
- A read under the lock (inside `withLock`, e.g. the read in `append`) keeps the 0.17 behaviour: a torn final fragment
  fails with `ledger seq N: invalid JSON`, or `ledger seq N: incomplete line` when the fragment parses, so a
  crash-torn tail is reported and never silently dropped or appended after.

## Why
`append` writes with `FileHandle.writeFile` under the lock, which is not atomic for a reader. Unlocked readers
(views, drivers polling state) could see a half-written last line and fail with `ledger seq N: invalid JSON`; a driver
then exited 3 (observed in K6 drive.measure: `ledger seq 18: invalid JSON`).

## Compatibility
No new CLI flag, tool parameter, entry kind, entry field or plan key. Ledgers replay exactly as in 0.17.
SPEC sections affected: the ledger file / read and locking description (unlocked reads tolerate an in-flight tail).

## Test
`test/tornread.test.ts` writes a valid ledger plus half of the next JSON line directly (no timing race):
unlocked read returns the two complete entries and later sees the third once the line is completed (TR1); a
malformed complete line still fails unlocked (TR1); a locked read fails with `invalid JSON` / `incomplete line` (TR2).
Red on base 5e88733.

## Backlog (not implemented)
Reject PATH/NODE_OPTIONS and --require/--import/--test-isolation in the MS4 runner allowlist (review #1957 nit).
