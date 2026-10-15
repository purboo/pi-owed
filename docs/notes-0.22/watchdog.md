# Idle watchdog

`owed idle [--json]` checks one repository without starting a driver or changing its ledger. Exit 0 means idle; exit 3 means not idle; usage and internal errors retain their normal error codes. The text gives the age of the last progress, up to five node states with the status view's exact next command, and the last progress timestamp. JSON also includes the reason, last progress, and whether subagent activity is known.

## Conditions and configuration

Idle requires ready-to-dispatch work, an open submitted/accepted/blocked or rebase-pending attempt, or an active next action; no live background driver; no held ledger, merge, trunk-refresh or adopt lock; no machine measurement holder; no running or asking durable-subagent call labelled with an unmerged plan node; and no ledger entry for more than `drive.watch_idle_min` minutes. The optional nonnegative integer defaults to 15; 0 disables the watchdog. It is independent of the staying driver's `drive.idle_rewake_min` reminders. Foreign or unreadable lock owners are treated conservatively as busy, and dead local lock owners are ignored without deleting their files.

Subagent activity and machine holders are read through the configured pi-durable-subagents CLI. Missing subagent tooling makes call activity unknown, so the other conditions and the age test decide. If the CLI is installed but machine-holder inspection fails, the watchdog conservatively stays quiet. No particular host, pool or execution wrapper is required.

## Pi wake-ups

A top-level pi session watches repositories where it uses an owed tool, and its initial working directory when that directory is inside an initialized owed repository. Every 120 seconds it assesses watched repositories; it never wakes while the session's agent is running. Assessment results are checked against the latest ledger progress before delivery. A wake is an `owed-idle` follow-up with `triggerTurn: true`, using the same plain text as the CLI. Writer/reviewer subagent sessions do not attach automatically.

An atomic create of `<git common directory>/owed/watch/idle-<last progress sequence>` admits only one session on the host per repository and idle period. With `OWED_DIR`, the marker follows that configured ledger directory. A new ledger entry permits a new wake; restarting pi does not repeat a delivered wake for the old period. Rejected delivery releases its claim so an idle session can try again.

## Compatibility and limits

No ledger entry kind or measurement key changes. Old plans retain their parsed shape when the new key is absent; older owed versions reject the new plan key, so upgrade CLI, driver and plugin together before configuring it. CLI polling is suitable for cron/systemd and does not consume the pi wake marker.

Detection is an advisory snapshot, not a gate or a scheduler. Work can start immediately after the final progress check. A process crash after claiming but before delivering can leave a marker and suppress that period's wake. Calls without a matching `node` label are not attributed to this repository. The status command remains the full diagnostic view.

Existing tests were not changed.
