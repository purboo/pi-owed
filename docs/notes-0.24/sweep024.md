# Scheduled advisory sweeps

`sweep.every: {merges?: N, minutes?: M}` accepts positive integers with at least one threshold. Either threshold makes a sweep due. Drivers that keep running (foreground or detached, staying or not) start due sweeps in the background, using the shared machine lease with no waiting. Scheduled sweeps have a separate operation lock, consume no node measurement slot, continue alongside node work, and are cancelled on driver stop. Without `every`, staying drivers retain the existing idle-only scheduling and node-work preemption.

`owed drive --once` and the pi `owed_drive` pass never start a sweep. They retain K6: wait only for the node measurements their pass started. When a scheduled sweep is due, they print `sweep due; --once does not start it (run owed sweep --due or a background driver)`; JSON output emits one `sweep-due` event. A continuously running idle driver uses the existing ledger-change wake for merge thresholds and one timer at the minute deadline. Ledger polling does not trigger a full pass or reread the ledger merely to check the sweep schedule; a ledger wake or the deadline causes a new pass and re-arms the timer.

`owed sweep --due` (tool `owed_sweep` parameter `due: true`) measures only when due. Otherwise it records nothing, exits successfully, and prints `sweep not due: next after N merges or at HH:MM`; absent thresholds omit their clause, and the time uses the local timezone. `--due` requires `sweep.every`. Regular `owed sweep` still forces a measurement. Sweep failure exit status remains nonzero; no sweep verdict gates a merge.

Only completed head sweeps reset the schedule, not their bisect samples. Merge counting uses the first-parent range from the last measured head commit, so merges during a background measurement remain eligible. Minutes use that head entry's timestamp, including when trunk has not moved. Before the first sweep, drivers use their own start time for minutes; standalone cron invocations use initialization time. Merge counting before the first sweep starts at initialization. Historical sweeps outside the current trunk's ancestry do not reset its schedule. Scheduling fields do not enter the sweep definition key or any acceptance key.

A twice-failing head with a confirmed first failing owed merge and a passing predecessor under the current definition automatically records a `missing` escape by `executor:owed`. Boundary evidence and escape append atomically after measurement; an existing escape for the same merge and sorted complete recorded names suppresses a duplicate. Evidence text lists at most five names. Manual escapes remain available to parent and owner. A flaky head, inconsistent bisect, measurement error or missing green boundary only reports evidence. A definition change during measurement prevents the stale result from authorizing an automatic escape.

Each newly recorded escape produces one notice: `escape: NODE (merge #S) broke NAMES on trunk COMMIT12; no check covered it. Fix: a node whose brief names the test; coverage: HINT`. When diagnostic protocols supply locations, the hint names failing test files outside every invariant's `reads`; otherwise it says `add the test to an invariant`. Repeated detection emits no new escape notice. Ordinary and full status retain `trunk: sweep red since #S (NAMES)` across merges and errors until a later passing sweep of that trunk or a descendant clears it. Passing bisect samples and sweeps of an older ancestor cannot clear it.

## Compatibility

- New optional plan field: `sweep.every`, with optional `merges` and `minutes`. Existing sweep definitions keep their previous keys when `every` is absent; changing only `every` also preserves them.
- New optional ledger field: `sweep.boundary: {head, merge}`. It is present only on the final passing predecessor sample and references earlier samples and the culprit merge. Strict replay checks the shape, one contiguous same-definition run, two failed head samples, two failed culprit samples, the passing predecessor commit, and current definition key.
- New optional ledger field: `escape.sweep`, citing the confirmed boundary entry. Strict replay permits it only for `executor:owed`, class `missing`, with matching node/merge, canonical evidence and no prior escape for the same merge/names. Existing field-free manual escape validation is unchanged. Dedupe can also recognize a manual escape whose evidence cites the sweep in the canonical format.
- Runtime JSON adds the `sweep-due` event for once calls; no ledger field is added for the idle deadline or once notice.
- No new entry kind or acceptance obligation. Field-free historical ledgers retain their states and keys. Upgrade readers before recording the new fields or executor principal; older readers refuse these records.

## Existing tests adjusted

- `SW bisects first-parent owed merges, records every step, and prints an executable proposal only`: now expects one automatic escape and no duplicate notice, replacing the former proposal-only behavior.
- `SW failures wake parent with names/proposal once; stale results stay bound to their measured commit`: now expects the automatic escape notice and coverage hint; stale-commit assertions remain.

## Interpretations and limits

The first-sweep merge baseline and standalone cron minute baseline use initialization because cron has no durable driver start time. A completed head entry means the first non-bisect sample in an atomically recorded run. Dedupe uses all recorded names, even though evidence displays only five; the existing protocol limit of fifty names remains. Coverage hints are diagnostic and do not prove an invariant executes the failing tests. These interpretations add no merge gate or owner action.
