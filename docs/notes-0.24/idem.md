# Identical repeated acts

`review`, `evidence`, `approve` (including an approval block), and `waive` are safe to retry on the same open candidate. An act whose content matches that principal's latest act of that kind on the same node and obligation records nothing, prints `already recorded as #<seq>`, and succeeds with exit code 0. Pi tools return the same success text, without an error.

Equality includes verdict, rank, acknowledged applicable rulings as a set, needs-parent, note, evidence file paths and digests, accepted risks as a set, and waiver reason, as applicable. File order and the numeric acknowledgment watermark do not distinguish acts when their sets are equal. Delivery channel and model attribution do not change a judgment. A changed act is recorded normally, and A, B, A records all three acts. Another principal or obligation has its own retry stream. A new submit starts a new candidate retry scope, even when it resubmits the same commit. Evidence receipts after merge retain their existing behavior.

Candidate pins, writer restrictions, role checks, file reads and confirmation checks still apply. Repeating a successful waiver can cite risks that the original waiver already consumed; this is a no-op and accepts no additional risk. A different waiver still needs valid current risks.

`owed why` review and ruling acknowledgment lines and `owed report` text fold consecutive identical historical acts in each principal/node/candidate/obligation stream into one item with `×<k>`. Changed acts break the run, including A, B, A. Report windows count only the acts inside the window. JSON evidence, report rows, review counts and replay remain unchanged.

For scripts, a busy ledger is identified only by exit code 75 with stderr starting `Busy:`. Never infer Busy from stdout or other output text: successful notes can contain that word. Retrying the same act after an uncertain response is safe while the candidate and that principal's latest act are unchanged.

## Compatibility

No ledger kind, ledger field, plan key or CLI flag is added. Historical duplicate entries still replay with their original acceptance behavior. Successful duplicate responses add only runtime `alreadyRecorded: <seq>` metadata alongside the existing entry; that metadata is never persisted. Existing why/report JSON shapes are unchanged.

## Interpretation choices and limits

Consecutive means consecutive within each principal's act stream for one candidate and obligation; other principals and obligations do not interrupt it. Candidate scope uses the current submit, rather than an evidence key shared by multiple submissions. The existing why view still selects the latest qualifying review per principal when the review obligation is satisfied; its `×<k>` describes the identical historical run represented by that review. Text folding is presentational and does not remove ledger entries.

## Existing test adjustment

`test/waive-key.test.ts` now expects an exact retry of the successful waiver to return its original sequence without appending. Its assertions still refuse another node's risk, another obligation's risk, and a changed judgment citing an already cleared risk. This is the ID1 change to retry behavior; risk acceptance rules are unchanged.
