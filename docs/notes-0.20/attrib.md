# 0.20 AT — attribution that blames the right thing (node `attrib`)

Sources: wais 2026-10-14 15:2x (merge-tree compile break labelled trunk-red), 00:5x (stale TR3 block after a new
submit), 2026-10-13 20:2x (defer lost when trunk moves) and the "known intermittent" reports (22:xx, 00:5x, 01:0x).

## New ledger field (optional, no new entry kind, no new plan key)

- `obs.signatures?: Record<string, string>` — per failed test name, the normalized first error line of the first
  run that failed it (TAP YAML `error:` or a Rust panic message, as already grouped for notes). Normalization masks
  hex ids of 8+ digits (`<hex>`), durations (`<t>`) and `/tmp/...` paths (`<tmp>`). Absent when no failed name has
  error text. A 0.17 owed refuses a ledger with this field ("needs a newer owed"): upgrade everything together.
  A ledger without it replays as in 0.17 (no defer carries without signatures; see AT5).

## AT1 Merge-tree break first

When an invariant on the same merge tree fails while its current trunk key passes (and has no fail), a node check
failure on that merge tree is not trunk-red (`trunkRedOf` returns nothing, the node is not parked, TR3 does not
halt). If the slot base differs from trunk, the merge refusal (CLI and the driver halt `merge refused: …`) leads with

    merge tree does not pass <inv>[, <inv>…] (trunk passes); trunk moved <N> commits since the slot base: rebase → owed rebase <node>

and the trunk-red text (waive/sweep/adopt suggestions) is absent. The lead is always the FIRST sentence: of the merge
refusal (also before `Node <node> current candidate is not yet accepted` when a retry is refused because the
candidate's blocking merge failures lie on such a tree), of the driver halt reason (which then has no
`merge refused: ` prefix), and so of the Needs-you line:
`<node>: driver halted: merge tree does not pass <inv> (trunk passes) → owed rebase <node>`.
New ops export: `MERGE_TREE_BREAK` (the lead's first words).
New reducer export: `mergeTreeBreaks(s, node, commit)`.

## AT2 New tests use the slot base as red reference

At merge, a failing node check whose `tests` globs match a file that does not exist at the candidate's slot base is
never probed on trunk (no `probe: 'trunk'` observation). The refusal adds

    check:<id> runs tests new in the candidate (<files, max 3>[, +N]): its red reference is the slot base <base12>, not trunk

New git helper: `newFiles(cwd, base, commit, globs)`. Checks without `tests` keep the 0.14 probe.

## AT3 A new submit supersedes the old candidate's merge-tree block

A block whose observation was recorded while an earlier candidate commit of the node was current
(`priorCandidateBlock`) no longer makes the node trunk-parked and never triggers the driver's TR3 halt; the driver
attests the new candidate first (attribution rerun clears or keeps the block as before). A resume after the new
submit therefore never re-halts on the old block. Blocks still bind until cleared (no gate weakened); the CLI
`merge` refusal of a not-accepted candidate keeps its existing text.

## AT4 Tighter "known intermittent"

The merge-failure hint now prints, per failed name:
- `known intermittent: <name> failed and passed on the same key (#a, #b, #c)` — an observation on the same
  subject/obligation/key passed, or a repeated observation of it had both pass and fail runs;
- `known intermittent: <name> failed with the same error on trunk (#…)` — a trunk observation (trunk invariant or
  trunk probe) failed the name with the same signature;
- `same test failed on older trees (different error): <name> (#…)` — other trees failed the name, both sides have
  known signatures and none matches;
- nothing otherwise (unknown signatures never claim "different error").
Trees of the refused node (its own observations and merge trees) are never evidence. The old text
`known intermittent: <name> also failed on #… (other trees)` is gone.

## AT5 Defer carry

An owner defer recorded for invariant `<inv>` on merge key K (open attempt) carries to the node's next merge key K'
(derived in `mergeGuard`, no new entry; only consulted when the merge cannot inherit the trunk failure) and is
fail-closed (ruling after review #1924). It carries only when the deciding observations at K (deferred), at the
current trunk key and at K' (current) are each `testOnlyFailure` and `failedNamesComplete` (every failing test named:
counts.fail equals the number of names; no timeout/crash/missing counts), the current names are a subset of the
deferred names, trunk failed them before the defer (trunk-own) and still fails each, every name has the same recorded
signature on all three, and the current observation meets the invariant's `min_tests`. The carried item is owner debt with detail

    inv:<inv> owner deferred, still debt; defer #<seq> carried (same trunk failure)

(shown under "Deferred debt remains" after the merge). When a defer exists but does not carry, the refusal adds
`defer #<seq> was bound to merge key <k12> (trunk moved)`. New reducer export: `carriedDefer`.

## SPEC sections affected

§6.3 merge guard (AT1, AT2, AT5), §6 trunk-red diagnostics TR1–TR3 (AT1–AT3), §12 driver TR3 / trunk park (AT3),
merge-failure hints FH1 (AT4), ledger `obs` fields (signatures).

## Interpretation choices

- AT1 lead is only printed when trunk actually moved since the slot base (N ≥ 1, parent ruling); otherwise the normal
  refusal stays.
- AT3 applies to the driver and parking; the CLI not-accepted merge refusal text is unchanged (GH2 behavior kept).
- AT4 "different error" requires known signatures on both sides.
- AT5 requires signatures; observations from 0.17 never carry a defer.
