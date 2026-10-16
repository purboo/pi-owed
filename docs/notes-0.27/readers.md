# Optional display fields

Ledger entries may carry `ignorable`, a non-empty, sorted, unique list of fields present with defined values. Readers ignore listed fields they do not understand before validation, state reduction and diagnostic node scans. Known fields are still interpreted and validated normally: listing a verdict or other known field cannot relax its rules. Base fields and `ignorable` itself cannot be listed. Malformed lists are reported as one invalid-entry error.

Unknown fields that are not listed retain their existing refusal behavior. Unknown entry kinds, channels and enumerated values still require a newer reader. No acceptance gate, evidence key, block or debt is changed by an unknown listed field.

The writer automatically marks present display-only fields from its registry before hashing, including waiver `tracked_by` and observation `quarantine_passed`. The marker is not act content. Changing or adding a waiver tracker is a new act; an unchanged waiver without a tracker retains its existing retry identity.

## Compatibility

Ledgers without `ignorable` keep their existing replay states and keys. Marked entries have different hashes because the metadata is part of the hash chain. Readers before this release still refuse `ignorable` where they enforce unknown-field validation; upgrade them before the first marked entry is written. New plan keys remain strictly validated and still need readers upgraded first.

No CLI flags or plan keys are added by reader compatibility. Ignoring a field does not prove that a failure has been fixed or settle debt; those behaviors belong to the tracker and quarantine features.

## Known limits

Only top-level entry fields can be marked. Nested receipt shapes and plan fields are not made extensible by `ignorable`. Unknown display fields need not appear in compact diagnostics; the stored ledger preserves their original bytes and hashes.

## Changed existing tests

None. Existing tests and their acceptance thresholds are unchanged.
