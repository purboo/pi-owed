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
- `owed_start`: preflight, init/update plan and start/reuse the driver; `restart:true` drains it first.
- `owed_submit`: submit from the writer's committed, clean slot.
- `owed_review`: independent verdict on the candidate actually read; read rulings before `ack_rulings:"latest"`.

Other tools remain registered but deferred: use `tool_search` when they are not declared, or the `owed <command>` CLI (`owed help`). At session start owed activates reachable `tool_search`, as the host's MCP extension does; if discovery cannot work it falls back to direct tools without removing active tools. `OWED_TOOLS=all` makes every tool direct and opts out of search activation.

Write the plan, then `owed start --plan <file>` (later `owed start` rereads its recorded source). The driver runs and wakes you with `Needs you:` / `Done:` lines. Act with `owed decide <node> --text "<decision and why>"`, `owed answer`, or the command the line gives; the running driver continues. Use `owed why <node>` for outstanding work and `owed why <node> --full` for evidence. Finish only when owed shows the node merged. Use pi-durable-subagents >= 1.2.0 for structured asks; earlier versions retain plain asks, and versions before 1.1.0 keep 0.28 writer-wait and lease behavior.

Main agent = parent and delegated owner: plans, decisions and acceptance; owner tools default to `owner:pi`, no dialog unless `OWED_CONFIRM=owner`.
Writer: implement only the packet's scope, commit and submit in its slot worktree. For a decision outside your writes, ask the parent (your run waits): give `decision_needed` (one sentence), numbered `options` (label, scope, cost, risk; one preferred), `facts`, `tried` and `classification_candidates` with evidence and what remains unproven. Use ask fields when available, else text starting `Decision needed:`. Never submit a candidate you believe fails its checks.
Reviewer: independently inspect the actual candidate and evidence, record a verdict, never edit.

## Plan authoring and decisions

- Checks/invariants may use `run_file: {path, sha256}` instead of `run`/`template`, with optional `args` (at most 64 strings, no NUL). Use a normal repository-relative path whose segments contain only `A-Z a-z 0-9 . _ @ + , = -`, excluding `.`/`..`, and a 64-lowercase-hex SHA-256. Admission verifies uncached bytes from the current worktree or `plan --rev`; every run installs the pin after setup/overlays with mode 0755. Supply a shebang; helpers still follow reads/closure. Pin/args edits use `checks.<id>.run_file.path`, `checks.<id>.run_file.sha256`, `checks.<id>.args` (omit the prefix for invariants).
- Try the disk plan with `owed check try <node> <check> --red <rev> --green <rev> [--plan <file>]` or `owed check try --invariant <id> ...` (`owed_check_try`); at least one revision is required. Fresh exact-commit trees use no closure/test overlay. Even `red: true` uses ordinary verdicts: red expects fail, green pass; error meets neither. Logs remain, no ledger entries are appended. Exit 0/1/2/75 means met/unmet/usage/lease busy; `--no-lease` or plan `lease: false` opts out.
- Optional `selftest: [{commit: <40 or 64 hex>, expect: pass|fail}]` (1–8) runs before recording new/changed checks or fixtures. An unmet expectation or error leaves ledger and edited plan file unchanged; success adds a `selftest/v1` note with the plan. Unchanged checks are not rerun; missing fixtures warn `not self-tested`; previews do not execute them. Fixtures affect no keys, candidates or block supersede and prove no acceptance.
- Top-level `env_signatures: {match: [<regex>], unless: [<regex>]}` is a routing hint only: non-empty match, optional unless, non-empty JavaScript regex strings of at most 300 characters, no flags. Suspect ordinary node-check failures retain their verdict; unsatisfied current-key blocks get attribution before repair, then halt if suspect twice. Red/strength executions, repeat, invariants and probes are excluded. Fix the environment, `owed attest <node> --rerun`, then `owed resume <node>`; full remedies are in `owed why <node> --full`. A pass retains the flaky owner need; an effective waiver prevents suspect routing.
- Node `allow_only: [<path-or-glob>]` caps allow-rule grants, including effective old grants, without narrowing own `writes`. Literals are exact paths; directories use `dir/**`; `[]` grants nothing. `owed decide <node> --allow-only p1,p2 --text "<limit>"` (tool `allow_only`) replaces the cap; an empty value sets `[]`. `owed edit` also accepts it. Adding/provably narrowing needs parent authority; widening/removing needs the owner, never an allowance. Cap changes carry candidates and remeasure writes. Mixed changed/unchanged multi-node cap decisions refuse. Upgrade all readers to 0.30 before recording `writes_syntax: 3` caps.
- `owed edit a,b --set review.count=2 --note "<why>"` applies the same sets/unsets to deduplicated targets, validates only the final plan and records one plan, optional all-target rule and requested per-node resumes. Exact existing CLI IDs and `--node-new` targets stay literal even with commas; use `owed_edit {nodes:["a","b"], ...}` or separate edits for collisions. Tool `nodes` excludes `node`/`invariant`; creation permits one distinct node. Pre-write refusals preserve ledger/file; dry-run shows one diff and downgrades.
- Structured asks show DECISION, numbered options, context and details before each answer command; reply `"option <n>; <limits>"`. Plain asks retain their flow. After `owed answer`/answering `owed decide`, the observed state may be running, queued, still asking, asking again, sealed or unknown. Only the selected question's call address identifies that call; closed-question retries without it report unknown. A failed describe never resends the answer.

See [SPEC](../../docs/SPEC.md) §§3.0a, 3.4.1, 3.6, 3.10 and 12.5.1 for limits and recovery.

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
- [Evidence and debt](references/evidence.md): read for checks, native/script quarantine, trunk probes, flaky evidence, tracked waivers/defers, sweeps or metrics.
- [Execution environment](references/environment.md): read for wrappers, leases, timeouts, measurement trees or build caches.
- [Trust and storage](references/storage.md): read for safe retries, ignorable display fields, ledger verification, caches or cleanup.
- [Compatibility](references/compatibility.md): read before upgrades, mixed readers or enabling fields older versions cannot interpret.
