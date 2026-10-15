# Model warnings (MD1 / MD2)

## User-facing behavior

- A selected `provider/id[:thinking]` compares with the recorded used model by `provider/id`; thinking-only differences no longer warn. Model ids with multiple slashes (such as `mccodex/ide/gpt-6.1-sol`) are preserved.
- A selected name resolves through dsa's `pools` in `$DSA_HOME/config.json`, defaulting to `~/.pi/durable-subagents/config.json`. Nested pool names and `{model, afterMs}` entries are supported. Any discovered member is a match, including fallback models.
- An unknown pool or unreadable/malformed config does not warn about a difference. `owed why` displays `selected <name> (pool membership unknown)` instead. Known nonmembers still warn and suggest checking launch configuration.
- `drive.same_model: accepted`, globally or in a node's `drive`, acknowledges the informational same-writer/reviewer-model warning. Default receipt text omits that warning; `owed why --full` retains it with `(acknowledged)`. Selection mismatch warnings remain visible.
- Actual writer/reviewer model identity ignores thinking for the same-model warning too. Unacknowledged warnings suggest an independent model or the acknowledgement key.
- Acknowledgement affects no obligation key, downgrade, review block, or acceptance rule. Removing it restores the warning without invalidating existing evidence.

## Plan keys / CLI flags

- New optional key: `drive.same_model: accepted` and `nodes[].drive.same_model: accepted`. Other values are refused. A node acknowledgement works without node role overrides; otherwise it inherits the global acknowledgement.
- No new CLI flags. Existing `why --full` and `why --json` expose acknowledgements.

## Ledger / JSON fields

- No new ledger entry kind or optional entry field. The existing plan blob stores the new key.
- `ReceiptCard.modelWarnings` keeps unacknowledged warnings as strings; an acknowledged warning is `{message: string, acknowledged: true}`. JSON retains it even when compact text hides it.
- The existing `models` display string gains unknown-pool selection diagnostics.

## Compatibility

- Old ledgers without the new key replay unchanged. Older plan parsers reject `same_model` as an unknown key; upgrade every reader/CLI/plugin before using it. Older tools can also emit false pool/thinking mismatches.
- JSON consumers must handle acknowledged warning objects in addition to the existing strings. No new acceptance evidence is introduced or weakened.

## Existing tests changed

- `test/driver020.test.ts`: the DR3 CLI model test used bare `selected` / `review-selected` names without a configured pool. Its old forced-mismatch assertions now assert explicit unknown membership and no mismatch warning, as required by MD1. Actual-model recording and same-model warning assertions remain.

## New behavioral coverage

- `test/models.test.ts`: 7 tests through real launch, submit, review, plan ops and CLI receipts. Covers nested/delayed members, thinking normalization, known nonmembers, missing/malformed/cyclic configs, default HOME lookup, top-level/node acknowledgement, full/JSON visibility, acknowledgement removal without downgrade, unrelated selection warnings remaining visible, review blocks remaining binding, and invalid acknowledgement values.

## Validation (remote host only)

Worktree: `/home/purboo/project/pi-things/pi-owed/.owed/wt/models-1`; base: `31a764d5a4d0709d46c04ad7dd4f8f426fa82ae2`.

- Focused: `/tmp/owed-ipc/run.sh <worktree> 900 "node --test --test-reporter=tap test/models.test.ts"`: exit 0, 7/7 passed; `/tmp/owed-ipc/logs/models-1-092000.log`.
- Typecheck: `/tmp/owed-ipc/run.sh <worktree> 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"`: exit 0; `/tmp/owed-ipc/logs/models-1-092033.log`.
- Full suite (once): `/tmp/owed-ipc/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: exit 0, 1113/1113 passed, no skips/cancellations; `/tmp/owed-ipc/logs/models-1-092118.log`.
- Base red: `/tmp/owed-ipc/red.sh <worktree> 31a764d5a4d0 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/models.test.ts`: red shown, underlying exit 1, all 7 tests failed; `/tmp/owed-ipc/logs/models-1-red-092055.log`. Failures include behavioral false-mismatch assertions and old parser refusing the new key.
- `git diff --check`: passed.

## Deviations / known limits

- Small interpretation: cyclic, empty, malformed or partially unresolved pools are membership-unknown unless the used model was found in a valid branch. This avoids speculative mismatch warnings; a proved member is never a difference.
- Small interpretation: `modelWarnings` uses a string/object union so existing unacknowledged JSON warnings remain strings.
- Pools are read from the current local dsa config when the receipt is rendered, not snapshotted in the ledger. This is informational only; missing launch selection blobs remain unknown as before.
- This node does not change dsa routing/fallback behavior or introduce any acceptance downgrade.
