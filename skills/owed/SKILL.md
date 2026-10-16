---
name: owed
description: An acceptance ledger for multi-agent task graphs. Use owed to start a planned driver, act on its wakes, collect measured and independent review receipts, and guard merges while keeping waivers and debt visible.
---

# owed: No receipt, not done.

Owed records acceptance in one Git repository: what was measured, who independently reviewed it, what the owner waived, and what remains debt. The runner does the work; owed guards the merge. A node is done only when owed shows it merged, not when an agent says it finished.

## Tools and loop

The default `core` profile has seven direct tools:
- `owed_status`: outcome, next actions and progress.
- `owed_why`: what a node still owes; `full:true` for evidence.
- `owed_decide`: parent decision, answer and recovery.
- `owed_drive`: one pass, or start/status/stop the background driver.
- `owed_start`: preflight, init/update plan and start/reuse the driver.
- `owed_submit`: submit from the writer's committed, clean slot.
- `owed_review`: independent verdict on the candidate actually read.

Other tools remain registered but deferred: use `tool_search` when they are not declared, or the `owed <command>` CLI (`owed help`). At session start owed activates reachable `tool_search`, as the host's MCP extension does; if discovery cannot work it falls back to direct tools without removing active tools. `OWED_TOOLS=all` makes every tool direct and opts out of search activation.

Write the plan, then `owed start --plan <file>` (later `owed start` rereads its recorded source). The driver runs and wakes you with `Needs you:` / `Done:` lines. Act with `owed decide <node> --text "<decision and why>"`, `owed answer`, or the command the line gives; the running driver continues. Use `owed why <node>` for outstanding work and `owed why <node> --full` for evidence. Finish only when owed shows the node merged.

Main agent = parent and delegated owner: plans, decisions and acceptance; owner tools default to `owner:pi`, no dialog unless `OWED_CONFIRM=owner`.
Writer: implement only the packet's scope, commit and submit in its slot worktree.
Reviewer: independently inspect the actual candidate and evidence, record a verdict, never edit.

## Six hard rules

1. **Done means merged by owed:** a node is complete only when owed shows it merged; a writer's or reviewer's word is not a receipt.
2. **Stay in your role:** writers write and submit in their own worktree; reviewers review and never edit; only the parent/owner records rulings, decisions, waivers, defers, plans and merges.
3. **Never bypass owed:** do not edit `.git/owed`, move the trunk ref, or commit to trunk outside owed (use `owed adopt` for hotfixes).
4. **Never weaken a check to pass:** do not edit, skip or loosen tests, checks or invariants to turn a failure green; changes to existing tests need the contract's or a ruling's authority and are listed in the notes.
5. **Decide inside owed, with a reason:** answer questions with `owed answer` and decisions with `owed decide`/`rule`, each with a note saying why; a decision only in chat does not exist.
6. **Wait for the wake:** the driver wakes you when something needs you; do not poll status in a loop, and never launch a second writer for a slow or quiet one.

## References

- [Parent and owner acts](references/parent.md): read for plans, decisions/answers, allowances, approvals, hotfixes or recovery.
- [Writers and reviewers](references/writer-reviewer.md): read before writing, submitting, rebasing or independently reviewing a node.
- [Driver and output](references/driver.md): read for driver controls, wakes, why/status/brief, models, batches or idle behavior.
- [Evidence and debt](references/evidence.md): read for checks, red/strength, invariants, shared failures, waivers/defers, sweeps or metrics.
- [Execution environment](references/environment.md): read for wrappers, leases, timeouts, measurement trees or build caches.
- [Trust and storage](references/storage.md): read for safe retries, ledger verification, caches or cleanup.
- [Compatibility](references/compatibility.md): read before upgrades, mixed readers or enabling fields older versions cannot interpret.
