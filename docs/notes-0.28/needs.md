# One authority for parent and owner needs

`needs()` returns parent and owner work separately for each obligation. `activity()` describes writer, reviewer and executor progress without predicting the driver's next action. `itemLine()` describes one obligation's next step, `repoNeeds()` describes repository work, and `needId()` retains node, obligation, block, key, candidate and question identity.

## Behavior

- Each obligation has its own resolving command. Accepting another obligation's risk does not end this obligation's need.
- Only a running candidate-tree attest for the exact node, current candidate and obligation suppresses that obligation's owner need. Queued, other-tree and old-candidate measurements supply progress context only.
- A halted slot first needs its unresolved review ruling, then its parent or owner obligation work. Otherwise it needs resume. A writer-stop decision is selected only in that final case, with resume as its alternative.
- An ordinary active check failure remains writer work. An owner check halt can offer its risk waiver without turning every check failure into owner work.
- A repair submit does not clear an old review block. Its explanation names the original principal, rank and current-key requirement; closure-review commands name their obligation explicitly. Another reviewer's same-rank OK does not clear the original reviewer's block.
- Repository needs never decide, rule or resume trunk. When no single existing command resolves the work, the explanation says so explicitly.

## Commands and compatibility

Exported `validateArgv()` shares the CLI's pre-I/O argument grammar: command names, allowed flags, positional arguments, value shapes and required values checked before I/O. Checks previously performed after repository access or confirmation stay at those points, preserving the CLI's output, exit codes and error precedence. Candidate pins appear on waive, review, approve and evidence only, not attest, decide or resume.

Removed-node items do not create new needs; their existing halt and ruling paths remain. A reviewer item requiring rank above two names the sufficient owner review route. Node and obligation words are shell-quoted whenever they are not plain safe command words.

Risk commands retain `--accept-risk`, `--candidate`, `--reason` and their role. Review commands retain `--note` and `--ack-rulings latest`; evidence retains files, explanatory text and its role. There are no new flags, plan keys or ledger fields, and no changes to reducer acceptance, provenance or clearance rules. Existing displays and driver callers remain unchanged until the subsequent rendering integration.

## Known limits

- Merge-tree risk commands require the matching merge-key waiver correction. Candidate checks must still pass independently.
- Git-derived merge-check, drift and rebase-pending additions remain on their existing display paths, outside pure Runtime.
- Inviting an independent reviewer again during an unrelated halt is outside this change. Text describes the record that can clear the old block, not a promise to launch review.
- An absent runtime field means unknown; it does not establish that the driver stopped or measurement ended.

## Changed existing tests

None. Existing tests are unchanged. New tests rebuild the contract's display sample states and compare them with a frozen baseline table identifying permitted corrections.
