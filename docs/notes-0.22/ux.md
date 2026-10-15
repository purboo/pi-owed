# UX improvements in 0.22

- An active review block now suggests `owed rule --nodes <node> --writer "<guidance>"`, followed by writer repair and resubmission. A rank-3 owner review is shown only as an explicitly labelled override. This does not change who can clear a review block or the accepted-risk requirement.
- When a ruling reaches zero running calls, its delivery receipt lists every affected open slot, the writer call id when recorded by the driver, and the exact follow-up message to send. A missing writer call is reported as unknown; use the slot writer. The message is JSON quoted to preserve newlines and quotes. Delivery remains a notification, never an acknowledgment.
- `owed status` (including `--full`) and `owed why <node>` show `conflicts with trunk: <files>` and `conflicts with <node>: <files>` for other open candidates. `none` means the Git probe merges cleanly. `unknown; retry owed status` means the probe failed, not that a merge is safe. Merge refusals requiring rebase also name the conflicting files.
- Conflict probes use `git merge-tree --write-tree --name-only` with NUL-separated paths. Results are cached for immutable commit pairs under the Git common directory's `owed/cache`; invalid cache files are recomputed. These diagnostics do not measure checks or grant acceptance.
- A review that omits an applicable ruling acknowledgment still records its verdict, and now prints a warning with the exact `owed review ... --ack-rulings <seq>` command to re-record it. The command pins the reviewed candidate and preserves verdict, rank, reviewer identity, obligation, note, model and needs-parent flag. The acknowledgment remains the existing numeric watermark through that sequence; no comma-list syntax is introduced. Existing automatic acknowledgment from a complete driver packet is unchanged.

## Compatibility

No plan keys, CLI flags or ledger entry kinds are added. Existing ledgers replay unchanged. `warnings`, delivery `slots` and view `conflicts` are optional runtime response fields; they are not persisted as acceptance evidence. Conflict values are path arrays, or null when the probe is unknown. Existing acknowledgment, review, write and merge gates remain in force.

## Validation

All compiler/test commands ran remotely through `/tmp/owed-bench/run.sh`, sequentially; none ran on the development host.

- `npx tsc --noEmit -p . && node --test --test-reporter=tap test/ux.test.ts test/brief.test.ts`: exit 0, 10/10; `/tmp/owed-bench/logs/ux-1-135702.log`.
- Required single full-suite run, `node --test --test-reporter=tap test/*.test.ts`: exit 1, 1202/1205; `/tmp/owed-bench/logs/ux-1-135802.log`. It found an adopt wall-time budget failure, Exec heading displacement by conflict lines, and the frozen differential adapter's old review suggestion. The latter two were addressed by preserving the heading and narrowly adapting UX1 labels.
- Final code tree: `npx tsc --noEmit -p . && node --test --test-reporter=tap test/ux.test.ts test/exec-env.test.ts test/adoptwait.test.ts test/perf.test.ts`: exit 0, 36/36; `/tmp/owed-bench/logs/ux-1-140252.log`. This includes all three previously failing cases; the adopt timing failure did not recur in this focused run. The full suite was not repeated.
- `git diff --check`: passed. Base-trunk red evidence remains the owed-managed `ux-red` check, not a locally claimed result.

## Existing test changes

All existing-test changes follow UX1's new suggestion and explicit override wording:

- `test/brief.test.ts`, “owed brief sections: decisions by downstream impact, merged counts never show waived as measured, blocks, progress and totals”: update the closure-review decision and rendered text expectations.
- `test/brief.test.ts`, “owed brief --since filters only merges by seq or ISO time, and the printed decision command discharges the item”: select the explicitly labelled override when exercising owner risk acceptance, rather than selecting the second semicolon-delimited fragment.
- `test/fixes.test.ts`, “judgment block hints describe in words who can clear them and never print --as of the blocking reviewer”: update the suggested command, retaining reviewer-clearance and identity assertions.
- `test/halt-quiet.test.ts`, “E3.2 D25.6 wording: owner halts, CAS merge halts and brief commands; no --as owner:human”: update the normal and confirmation-gated owner command expectations.
- `test/review-needs.test.ts`, “a * ruling after the block leaves the halt and the block unresolved”: expect the writer-action ruling in the why hint.
- `test/review-needs.test.ts`, “views: why and status show \"needs a parent ruling\" until a node ruling, then \"ruled #seq\"”: expect `--writer` in the status suggestion.
- `test/review-needs.test.ts`, “CLI: review --block --needs-parent records needs; --ok --needs-parent is refused; why/status wording; * vs node ruling”: expect `--writer` in the CLI status suggestion.
- `test/perf/differential.ts`, the rendering adapter shared by `test/perf.test.ts`'s fuzz, synthetic-ledger, and two real-ledger differential cases: normalize only the UX1 guidance/override labels and the added writer-action flag when comparing against frozen 0.10 views. Resolving review commands, replay states, keys, guards and acknowledgment evidence still compare exactly.
- `test/summary.test.ts`, “SQ1 default status shows outcome, each phase and only current parent/owner actions and debt”: expect `--writer` in the Needs-you command.
