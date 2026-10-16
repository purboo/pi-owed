# Backlog nits

## Behavior and flags

- Rebase help includes `--apply` and its supported global flags.
- Both version forms, `--version` and `version`, print the package version without requiring an initialized repository. They take no additional arguments or options.
- Recovery hints identify the actual Git operation, including cherry-pick and revert, rather than suggesting a rebase abort for every operation.
- A driver restart recovers terminal send refusals from recorded halt reasons and driver reports. A refused repair does not make undelivered findings appear old in the next repair; a delivered repair still advances that boundary.
- Each question's wake uses the answer command from its own trailer. Command-like text inside the question remains question text and cannot replace the suggested action.
- Counterfactual reports hide an incomplete final decision group until its write completes, matching other unlocked readers. Locked reads and verification remain strict.
- Ledger directories are identified by their real location. Opening the same ledger through a symbolic link preserves lock ownership and strict locked-reader behavior.

## Compatibility

No new plan keys, ledger kinds, optional ledger fields or principals are introduced. Existing complete ledgers retain their replay states and acceptance keys. Acceptance gates and lock acquisition order are unchanged.

## Known limits

Refusal recovery reads the current driver log and one rotated generation, as well as retained halt reasons and durable runner request receipts. Older logs are not retained across further background starts. If all such evidence is removed, the driver cannot infer a past refusal. Version output reflects the installed package; it does not inspect a ledger's reader requirements.

## Changed existing tests

None.
