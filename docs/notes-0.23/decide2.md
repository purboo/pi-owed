# Decide follow-ups

## Atomic visibility for readers

A decision is appended as one write. A reader that does not hold the ledger lock (status, why, report, brief, the driver and the pi status line) and finds a final decision group whose ruling is not on disk yet treats the group as a write in flight, exactly like a torn final line: it does not fail, and it sees the state before the group's first entry, so no member of the group is visible. Replay caches and disk snapshots therefore never hold part of a group. Any act that takes the ledger lock, `owed verify`, and the check after a decision's own append still refuse such a tail as an interrupted atomic write. Only a tail that is a well-formed prefix of one group (every entry names the same first entry, none is the ruling) is hidden; anything else is judged by replay as before.

## Question hints

The asking notice (Needs-you) suggests `owed decide <node> --text …` only when the node has exactly one question across all asking runs of its current attempt, writer and reviewers together, counted the same way `owed decide` counts them. With two or more questions each notice shows `owed answer <node> --rid <rid> --qid <qid>` (and the matching `owed_answer` tool call) for each of its questions, so the suggested command is never one that refuses as ambiguous.

## Metrics

`owed report --metrics` counts every element of a decision ruling's `answers` list as an answer, exactly as a ruling with one answer is counted. The decision itself remains one parent act of class `answer`.

## Compatibility

- No new entry kind or field.
- Replay of the pre-existing rule `answer.rev` field again accepts any positive integer, as before decide; ledgers that validated before decide validate again. The newer `answers` list keeps its stricter revision checks.

## Existing regression expectations

`decide.test.ts` (truncated decision tails): an unlocked state read now returns the state before the group instead of refusing; the test now asserts that, and that a locked act and verify still refuse.
