---
name: owed
description: An acceptance ledger for multi-agent task graphs. Use owed to dispatch worktrees, collect measured and independent review evidence, explain rejections and debt, and check acceptance conditions before merging.
---

# owed: No receipt, not done.

Every `owed_*` tool takes an optional `cwd`: the absolute path of a directory inside the target repository (default: the session's working directory). A session started elsewhere passes `cwd` on every call to drive another repository; relative paths such as `owed_plan`'s `plan` and `owed_decoy`'s `file` resolve against it. To submit as the slot writer, pass the slot worktree as `cwd`.

Start with `owed_brief` (CLI `owed brief [--since seq|ISO]`): owner decisions with the exact command that discharges each, merges since `since`, rejected or blocked nodes and how to clear them, work in progress with its age, and totals.

1. Use `owed_status` (CLI `owed status`) to inspect ready nodes and pending queues. Dependencies must have merge records before dispatch; a verbal claim of completion is not a receipt.
2. Use `owed_dispatch` to dispatch a ready node. Pass its `subagents` object to subagents/dsa: `agent: worker`, `cwd` must be the slot worktree, `isolation: none`, and `task` must contain the complete packet. owed has already created an isolated worktree; do not add another isolation layer.
3. Writers modify only the packet's writes scope, commit their work, and keep the worktree clean. Run `owed submit <node>` or `owed_submit` inside that worktree. A parent submitting on behalf of a writer must explicitly use the slot's `writer:<node>#<attempt>` identity.
4. Use `owed_attest` (CLI `owed attest <node>`) for executor measurements. Rerun attribution for original failures first, then process the current candidate. Read logs and rejection reasons; after repairs, commit, submit, and attest.
5. Start a fresh, independent reviewer with the current diff, packet, receipt card, and failure evidence. The reviewer must not have been a writer for any attempt of the node. Use `owed_review` with an independent `reviewer:id`, rank, verdict, and note. Closure changes require `closure-review` at rank 2 or higher. Read new rulings and acknowledge their seq with `ack_rulings`.
6. The parent inspects receipts and actual changes, then uses `owed_merge`. It checks the merge tree, invariants, and trunk CAS; neither review ok nor an accepted candidate replaces the merge guard. After merging, use `owed_report` to report evidence, waivers, and remaining debt.

7. If an attempt is a dead end, the parent closes its slot with `owed_abandon` (`node`, optional `reason`); the node can then be dispatched again. Periodically run `owed_gc` (first with `dry_run: true`) to remove worktrees and branches of merged or abandoned attempts; it never removes an open slot, a dirty or locked worktree, and it pins submitted commits under `refs/owed/keep/`. Use `owed_verify` to check the ledger hash chain.
8. If `owed_status` reports "trunk moved outside owed" (or a merge refuses the trunk CAS naming `owed adopt`), commits were made on trunk directly. Do not move refs to work around it: report it to the owner, who reviews those commits and runs `owed_adopt` (`note`, optional `commit`, UI confirmation) or `owed adopt --note TEXT`. A diverged/rewritten trunk cannot be adopted; the owner must restore it.
9. A defect found after a merge is recorded with `owed_escape` (`node`, `merge` = seq of that merge entry, `class`, `note`, optional `evidence`). Decoys belong to the owner: `owed_decoy` with `action: digest` only computes a digest, while `commit` and `reveal` require human UI confirmation.

10. `owed drive` (CLI; pi tool `owed_drive` = one pass, `--once`) runs dispatch → writer → submit → attest → reviewers → merge through pi-durable-subagents (≥ 1.0.27) as `parent:drive`. Run the long loop in a terminal or a `systemd-run --user` unit, never inside a tool or dsa call. The driver never answers a run's question, never waives, never changes the plan, never runs `restart --force`, and never touches a node that needs the owner; it prints those. Attest goes through `hold machine --shared --no-wait`: a busy machine is retried next pass; an older dsa that rejects `--no-wait` halts the attempt with that error (upgrade dsa). A driver halt (status "Halted (driver)" / Pending owner, `owed why`) is cleared by any later action on that node by someone other than `parent:drive` — fix the cause, then e.g. submit, review, rebase, abandon (a new attempt), or record a ruling naming the node — and the driver resumes on its next pass.

The `owed_why` / `owed why <node>` card lists keys and evidence for each obligation: ✔ measured or reviewed, ⚠ waived, ✘ rejected, ⊥ awaiting observation, ⊤ conflict, ⏸ deferred, ⛔ blocked. E means a pass supported by evidence, W means an owner waiver, and D means remaining debt. Also inspect "Untested changes" and ΔO⁻ (weakened or removed obligations); changes without test coverage must not be described as verified.

The status pending queues are grouped by discharger: parent+writer handle dispatch, submission, and repairs; executor handles attest; reviewer provides independent judgment; owner handles risks and downgrades. Resolve specific obligations from the queues instead of repeatedly trying merge.

Rules that must not be broken:

- Do not edit closure files to make checks pass; the executor pins the check closure from base. Necessary, genuine closure changes must explicitly receive closure-review acceptance.
- Do not self-review, disguise a writer as an independent reviewer under another name, or fabricate executor evidence.
- Agents must never use `--i-am-owner`. `owed_waive`, `owed_defer`, `owed_decoy` commit/reveal, `owed_adopt`, and downgrading `owed_plan` require human UI confirmation; without a UI, stop that decision and report it.
- The parent may update the plan through a file path with `owed_plan`; only owner may confirm downgrades. Never silently weaken acceptance conditions.
- Negative observations may only be cleared by the rules. Execution failures require attribution on the original key/commit/base: another failure clears the old block; a pass creates a conflict requiring owner to explicitly accept the risk of the corresponding seq.
- A judgment block at rank r may only be cleared by an ok from the original reviewer at rank at least r, or another reviewer at a higher rank. Another reviewer at the same rank cannot clear it. Owner waivers must also reference `accept_risk`.
- Do not directly edit the ledger, blobs, or closure to bypass rejection. Defer only permits a specific merge to retain invariant debt; it is not a pass. Invariants cannot be waived.
