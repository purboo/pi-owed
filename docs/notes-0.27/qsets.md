# Shared quarantine and script delivery

Plans may define `quarantine_sets`, a mapping of named lists of `{test, fix, note?}` entries. An invariant or node check selects one with `quarantine_set`, optionally alongside its own `quarantine`. A name present in both lists is refused. Set names use letters, digits, underscores, dots and hyphens; each set accepts at most 200 entries, with exact test names and no control characters. Every fix must name a node in the plan.

Adding a set entry, changing its fix, or adding or changing a set reference requires an owner decision, even when `allow` covers checks. Removal is free. Active own and shared names participate in measurement keys; checks without a set retain their previous keys. A fix's merge disables its entries, including while measuring that fix's merge tree.

Check and invariant commands receive `OWED_QUARANTINE_FILE` when their key commits to active quarantine names. It names a private temporary file outside the measured tree, containing sorted exact names, one per line. Each execution gets a separate file, removed afterward. Setup, slot setup, timeout diagnostics, sweep, red and mutant executions do not inherit the variable. Existing own names containing line breaks remain readable but cannot be delivered in this format; the observation explains that no file was written.

Scripts may read this file instead of maintaining a repository skip list. Delivery does not excuse failures or change the script's exit code: unrecognized runs explicitly say that owed excused nothing. A container wrapper may not see the host's temporary file. A script that skips a name cannot prove that test passes again.

Native TAP measurements on trunk or a merge tree record passing active names in optional `obs.quarantine_passed`. Status debt identifies that measurement and suggests removing names if they stay green; skipped or TODO results are not passing evidence. This is diagnostic only and changes no verdict, count or key. Candidate-only passes do not trigger this suggestion.

When sets exist, admission warns about new or changed Cargo or Node test checks without either quarantine field. Unrelated plan edits do not repeat this warning; changes are matched by invariant id or node/check id and compare run, reads and timeout.

## Compatibility

The new plan fields require readers that understand shared quarantine. Readers before this release refuse `obs.quarantine_passed`; the newer-reader compatibility mechanism is delivered separately. Existing plans and ledgers without these fields preserve their behavior and keys. No ledger entry kind is added.

## Changed existing tests

- `MS4 fail-closed: ...; exit 3 is not a known test runner: not excused, and why says so`: its why assertion now expects the delivered-file explanation instead of the old unknown-runner explanation. Its failed verdict, exit code and unexcused names are unchanged.
