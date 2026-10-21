# pi-owed

**No receipt, not done.** Owed is an acceptance ledger for multi-agent task graphs in one Git repository: measured checks, independent reviews, owner waivers and remaining debt guard each merge. The runner does the work; owed records acceptance, not promises. Current release: **[0.31.2](CHANGELOG.md)**.

Why use it?
- Keep completion tied to a merge receipt, not an agent's success message.
- Reuse evidence only when its content-derived keys still match.
- Make risks, waivers and debt visible instead of hiding failures.
- Let the driver run routine work and wake the main agent for decisions.

The main agent is the parent and delegated owner. Pi owner tools act as `owner:pi` without a dialog unless `OWED_CONFIRM=owner`; CLI owner commands normally use `owner:cli`. Writers and reviewers never act as owner. Each acceptance-easing act needs a reason; the ledger records it for audit.

## Quickstart

Requires Node.js >= 22.19, Git with `merge-tree --write-tree`, Bash and a configured Git identity. The driver uses [pi-durable-subagents](https://www.npmjs.com/package/pi-durable-subagents) >= 1.0.27 with writer/reviewer agents available; >= 1.1.0 is needed for durable-writer waits, seal diagnostics and yield/priority leases (older dsa keeps 0.28 writer-wait and lease behavior), and >= 1.2.0 for structured asks (earlier runners retain plain asks).

```sh
pi install npm:pi-owed          # reload pi after installation
ln -sf "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin/owed" ~/.local/bin/owed
# Standalone CLI alternative: npm i -g pi-owed
```

`pi install npm:pi-owed` does not put `owed` on PATH, but agents, scripts and owed's printed commands call `owed`; use this link with `~/.local/bin` on PATH, or `npm i -g pi-owed` at the same version as the pi package.

In a disposable repository, save this plan as `plan.yaml` ([examples/plan.yaml](examples/plan.yaml)):

```yaml
version: 1
trunk: main
closure: [plan.yaml]
invariants: []
nodes:
  - id: greeting
    title: Add a greeting
    brief: Create hello.txt containing exactly hello followed by a newline.
    writes: [hello.txt]
    checks:
      - id: content
        run: 'test "$(cat hello.txt)" = hello'
        timeout_s: 10
        reads: [hello.txt]
    review: {count: 1, min_rank: 1}
```

```sh
mkdir owed-demo && cd owed-demo
# Save the plan above as plan.yaml, then configure Git identity if needed.
git init -b main
git add plan.yaml && git commit -m "Record acceptance plan"
owed start --plan plan.yaml
```

Start preflights, initializes/updates the plan and starts or reuses the detached driver. It dispatches an isolated writer, measures the candidate, obtains independent review and guards the merge. Automatic `Needs you:` / `Done:` wakes go only to the owning pi session; opening another session in the same repository or reusing its driver does not subscribe or transfer ownership. Use `owed watch` for explicit CLI observation without taking ownership. On a wake, act with `owed decide <node> --text "<decision and why>"`, `owed answer`, or the command the line gives. Use `owed why <node>` for outstanding work, `--full` for evidence. **Done means owed shows `greeting: merged`.** Later `owed start` rereads the recorded source; `--stay` waits for a growing plan. Never poll in a loop or launch a second writer for a quiet one.

## Reference: concepts and acceptance

Owed provides a CLI, a pi extension and an agent skill. It is not an agent scheduler, a sandbox or a replacement for code review: your runner schedules execution; owed keeps acceptance evidence and guards merges.

### When to use owed

Small, low-risk fixes can be committed off trunk, then landed by the parent with one
`owed adopt --commit <c> --note "<what changed and why it is acceptable>"` (using the owner's delegated
identity unless a parent adoption allowance applies). Use owed nodes with independent
review and red tests for authentication, concurrency, persistence, deletion/ownership,
public contracts and multi-agent waves. Routine evidence and recovery are the main
agent's job; reports to the user name what was delivered and what is genuinely blocked,
not routine halts the main agent already resolved.

### How acceptance works

- **Items and keys:** an item identifies a subject, an obligation, and a content-derived key. Checks use declared read sets and the pinned check closure. Matching keys allow evidence reuse; relevant changes require fresh evidence.
- **Receipt:** E means evidenced, W means visibly waived by the owner, and D means debt. `why --full` shows actual logs, counts when available, reviewers, blocks, untested changes, and plan downgrades; default why shows outstanding work. Speech and a successful agent exit are not evidence.
- **Blocks:** execution failures and negative reviews survive new candidates. Attribution reruns explain old execution failures. A judgment block requires the original reviewer at sufficient rank, a higher-rank reviewer, or an explicit owner risk waiver. A different reviewer at the same rank cannot clear it. When the brief or plan is ambiguous or contradictory, or the fix needs a product or contract decision, the reviewer records `owed review <node> --block --needs-parent ...`: `why` and `status` show the block as needing a parent ruling, and `owed drive` halts instead of sending the writer a repair until the parent records `owed decide <node> --writer --text "<decision and why>"` (a `*` ruling does not count); the driver then repairs with the ruling quoted.
- **Superseded blocks:** when a plan update changes a check's definition (the check spec excluding `selftest`, plus `setup`, `exec` and referenced `quarantine_set` entries, if any) or removes the check, the execution blocks recorded under the old definition become `superseded`: they no longer block, get no attribution rerun and need no waiver. The new definition must still pass on the current candidate. `why --full`, `status --full` and `report` show each one as `#<seq> superseded by plan #<p> (check <id> definition changed)` (or `removed`). Only a parent or owner can change a definition, and weakening a check is still an owner downgrade. A block whose definition did not change goes flaky as before.
- **Waivers:** an owner can waive a specific node obligation with a reason and explicit block sequence numbers in `accept_risk`. Waivers remain visible; they do not turn into measured passes. Invariants cannot be waived.
- **Debt:** missing evidence, failures, conflicts, and deferred invariants remain visible in the pending queue. `defer` permits specified invariant debt for one merge; it does not erase it.
- **Oracle strength:** a node check may list `mutants` (globs of patch files inside the closure) and `min_kill` (fraction in (0, 1], default 1). The node then owes `strength:<check id>`: for each mutant patch, read from the base and never from the candidate, owed applies it to the materialized candidate and runs the check. A mutant is killed when the run exits non-zero or reports failing tests; a zero-test run or a patch that does not apply is not a kill. The obligation passes when killed/total reaches `min_kill`; the receipt shows `strength k/n` and the log lists every mutant.
- **Merge guard:** owed tests the prospective synthetic merge commit (HEAD^1 = trunk tip, HEAD^2 = candidate); checks must not pin the candidate base. It checks node obligations and invariant debt, then advances the trunk with a compare-and-swap guard. An accepted candidate alone does not guarantee its merge is safe.

#### Large candidates

`owed submit` streams the full binary diff when computing the review identity,
preserving its UTF-8 decoding and hashes. Buffered Git calls, including blob
`show` and mutant `cat-file`, refuse output above 256 MiB with code `refused`,
naming the subcommand.

Optional top-level plan `limits: {file_mib: 100, diff_mib: 500}` sets positive,
finite MiB limits (fractions allowed). Submit checks the largest changed file
against `file_mib` and the sum of added/changed candidate blob sizes against
`diff_mib`, using Git metadata without reading content. Full blobs count once
per changed path, including mode changes; deleted files and gitlinks contribute
no bytes. Exceeding a limit refuses submit with code `refused`, naming the
limit and up to five largest files, with nothing recorded. Neither limit means
no size check. Limits enter no acceptance key, invalidate no submitted candidate
and add no ledger field. Older owed ignores them; use 0.14+ to enforce them.

## Reference: plans and nodes

### Authoring checks

Checks and invariants can use `run_file: {path: checks/unit.sh, sha256: <64 lowercase hex>}`
instead of `run` or `template`, with optional `args: ["literal argument"]`
(at most 64 strings, no NUL). Path segments use only `A-Z a-z 0-9 . _ @ + , = -`,
excluding `.` and `..`; paths must be normal and repository-relative. Plan
admission verifies uncached script bytes from the current worktree, or the
commit selected by `owed plan --rev`. Every execution installs those bytes
with mode 0755 after setup and overlays; supply a usable shebang. Candidate
script edits cannot replace the pin, but loaded helpers still follow ordinary
reads/closure rules. Pins and args enter execution keys (SPEC §3.6).

Use `owed check try <node> <check> --red <rev> --green <rev> [--plan <file>]`
or `owed check try --invariant <id> ...` (tool `owed_check_try`) to try the disk
plan before recording it; at least one revision is required. Each revision
uses a fresh exact-commit tree without closure/test overlays, with normal
setup, counts, timeout and repeat behavior. Even `red: true` is measured as an
ordinary check: red expects fail, green expects pass, and errors meet neither.
Without `--record`, no ledger entries are appended; logs are retained.
`owed check try --run '<command>' (--green|--red) <rev> [--min-tests N] [--timeout <seconds>]`
uses the same disk plan settings, defaulting to one required test and 900 seconds;
zero-test or unknown-count successes do not pass by default. Select exactly one
of node/check, invariant or run. Only committed revisions are measured, even
when the working directory has uncommitted edits.
`owed check try <node> <check> --green <rev> --record` saves an informational
receipt per side, including fail/error verdicts, and prints the tree and
`receipt #<seq>`. For invariant/ad-hoc receipts use `--record --for <node>`
to associate a plan node. `owed why <node>` shows the newest five associated
receipts; `--full` shows all. Cite the receipt for a ruling-ordered measurement;
receipts never satisfy gates or change keys or votes. Recording requires an
initialized ledger. Exit codes: 0 all met, 1 unmet, 2 usage, 75 lease busy;
`--no-lease` or plan `lease: false` opts out.

Optional `selftest: [{commit: <40 or 64 hex>, expect: pass|fail}]` (1–8 entries)
runs before recording new/changed checks or fixtures. Failed expectations or
errors refuse without ledger entries or replacing the edited plan file;
success records a `selftest/v1` note with the plan. Unchanged checks are not
rerun; new/changed checks without fixtures warn `not self-tested`, and previews
only announce pending selftests. Fixtures change no key, candidate or block
and are not acceptance evidence. `owed edit` accepts `checks.<id>.selftest`,
`checks.<id>.run_file.path`, `checks.<id>.run_file.sha256` and `checks.<id>.args`
(omit `checks.<id>.` for invariants). See SPEC §3.10.

Writer packets list invariants whose reads overlap the node's writes using
slot-base files and literal new write paths, grouping broad invariants once.
They point to `owed check try --invariant <id> --green <your commit>` and say:
`Checks, owed check try and your own preflight see committed HEAD only: commit code, then evidence, then measure, then report.`
`owed plan` and `owed edit --dry-run` print advisory invariant coverage notes
for added nodes or changed writes; these notes do not refuse the plan.

### Parallel slots and a moving trunk

In 0.20.1, `owed dispatch` retries compare-and-swap (CAS) refusals with fresh state, including a changed plan, up to three total attempts (initial plus two retries). Before creating paths/worktrees each attempt rechecks node membership, hold, readiness/dependencies and writes overlap; removed, held, unready or overlapping nodes refuse normally. Worktree, branch, directory and setup-exclude rollback finish before retry; rollback errors and non-CAS failures (including setup) are not retried. The driver reports exhausted CAS retries as `retry next pass`, never Needs you or a halt; standalone dispatch returns the original refusal class/code. `owed plan`/amend/edit retain the three-attempt policy only while the ledger plan sha is unchanged. Dispatch rollback uses `git update-ref -d refs/heads/<branch> <base>` to compare the tip and delete atomically, regardless of the main worktree's HEAD. A ref that moved is kept and the CAS failure is reported under the existing `git branch -d` rollback label. A branch still checked out in a worktree is kept too.

`owed dispatch <node>` refuses when the node's `writes` overlap (using conservative literal prefixes before wildcards) those of another node with an open slot and names that node; `--allow-overlap` dispatches anyway and records the overlap in the dispatch entry. Default `owed status` and `owed why <node>` explain ready nodes skipped by the
same predicate as the driver: writes overlap (with `owed dispatch <node>
--allow-overlap`), active-attempt capacity, or an owner decision. `max` counts
non-accepted open attempts; accepted attempts are `waiting to merge` outside
`max`, but all open attempts count toward the `2 × max` cap and reserve writes.
Same-pass reservations and removed nodes with open slots consume active capacity.
With pending merges, status adds `active <a> of max <m>, waiting to merge <p>`;
without them it keeps the prior output. Owner-needed ready nodes appear once
under Needs you. Current status capacity/ready lines and why use a live recorded
`--max` override when available; view callers outside summary/why read paths
use plan `drive.max` (SPEC §9.8).

When trunk moves under an open slot, there is no need to abandon and redispatch. `owed rebase <node>` (the parent, or the writer inside its worktree) moves the slot base to the current trunk and invalidates the open candidate; the writer then runs the printed `git rebase --onto <new base> <computed upstream>` in the same worktree and submits again. Review blocks still bind the node. `owed why <node> --full` shows the previously reviewed patch and a hint, `git range-diff <old base>..<old commit> <new base>..<new commit>`, so a reviewer only has to review the conflict resolution. Recovery names the actual interrupted Git operation, including `git cherry-pick --abort` and `git revert --abort`, rather than always suggesting rebase abort.

`owed rebase <node>` without `--apply` already records the slot-base move and
prints the writer's `git rebase --onto <new> <old>` (or computed upstream); it
is not a dry run. Parent/owner `--apply` additionally performs the Git rebase
and executor submit when safe. Submit refuses a commit containing trunk commits
after the recorded slot base: the parent records `owed rebase <node>` first,
then the writer runs the printed rebase and submits (SPEC §6.1, §7.25).

A plan change that alters a node's spec, `setup`, `exec` or `closure` invalidates its open candidate, because the keys were computed under the old plan. Since 0.10, when the node's spec changed only in `checks`, `writes`, `allow_only` (0.30), `type` or `drive` (plan-wide `setup`, `exec` and `closure` changes do not matter), `owed plan` carries the candidate in the same lock: it appends a carry submit by `executor:owed` for the same commit at the same base with keys recomputed under the new plan, and prints `Carried <node>: …` (a carry it cannot make, e.g. the commit is gone, prints `Not carried <node>: <reason>` and JSON `notCarried`; that candidate stays invalidated). Reviews and other evidence on unchanged keys still count; the next attest measures only the changed checks (or `writes`). `owed why <node> --full` and `owed status --full` show `candidate #C carried by plan #P from submit #S`. Any other change (`brief`, `deps`, `review`, `title`, `approve`, `evidence`) still needs the writer to submit again, and the driver tells it so: `plan #P changed this node's spec (<fields>); resubmit …` (reason `submit`), not a rebase. A ledger with a carry submit needs owed ≥ 0.10.0 to replay.

### Waiting, reports and backlog (0.13)

An open writer slot automatically waits while any dependency in the current plan
has not merged: `why`, `status` and the driver show `waiting (deps: a, b)`.
The driver sends no submit/repair/ruling follow-up and no missing-candidate halt;
questions still wake the parent. Adding a dependency while the writer runs sends
one durable `notify` per plan entry saying which dependencies are unmerged and
`do not submit until told`. When they merge, owed uses its existing slot rebase
and writer rebase follow-up before continuing.

`owed resume <node> --after a,b --note "wait for both"` (tool `owed_resume`
`after: "a,b"` or `["a", "b"]`) waits for every member, in addition to implicit
dependencies. A single string still works; a new resume replaces the explicit wait.
`owed resume <node> --expect report --note "diagnose first"` (tool
`expect: "report"`) asks the next writer follow-up to report findings and stop,
not submit. A successful sealed report without a new submit wakes the parent with
its last 40 lines (at most 4000 characters), appends no ledger entry, and parks the
node as `reported (resume #n)`. It stays parked until a rule naming it, another
resume, a plan entry changing it, or abandon; a new submit proceeds normally.
Reported receipts live in the driver's private runtime cache, not acceptance keys.
The same parking behavior is available with `owed decide <node> --expect report
--text "<pause ruling>"` and `owed answer <node> --expect report "<answer>"`
(tools `expect: "report"`). Decide refuses `--no-resume --expect report`.

Mark backlog nodes `later: true`: they are never ready or dispatched, and
`status`/`brief` list and count them as `Backlog (later)`. Remove the field in a
plan update to make them eligible; no check/invariant key changes. Staying idle
wake-ups include `ready`, `open`, `waiting`, `reported` and `later` counts.
`drive.idle_rewake_min` (default 60 minutes, 0 = off) repeats the wake while idle
with no ledger change. Waiting/reporting slots still surface questions.

Invariant ids in CLI/tool `defer` accept `unit` and `inv:unit`; unknown ids list
the valid spellings. `owed why inv:unit` (or `why unit` when it is not a node)
shows its trunk receipt. Invariants still cannot be waived. Compatibility:
owed 0.12 rejects resume lists/`expect` as an ordinary refusal; from 0.13 unknown
resume shapes are `version` errors. The new driver send kinds/reasons also
require 0.13; a single-string resume remains readable as before.

### Quarantine, trunk evidence and tracked debt

Top-level `quarantine_sets: {name: [{test, fix, note?}]}` defines reusable lists;
a check/invariant selects `quarantine_set: name`, optionally with own quarantine.
Duplicate exact names across the lists refuse. Own lists permit 20 entries, sets
200; set names match `[A-Za-z0-9_.-]+`, set test names contain no control characters,
and every fix names a plan node. Adding/reassigning entries or adding/changing a
set reference is owner-only, never covered by `allow`; removal is free. Active
own/set names are sorted in keys and disabled when the fix merges, including its
own merge tree. Referenced sets enter check definitions and can supersede blocks;
checks without sets keep their old definitions and keys (SPEC §3.6).

Eligible check/invariant runs receive `OWED_QUARANTINE_FILE`: an absolute private
temporary file outside the measured tree, sorted exact names one per line with
a final newline, unique per execution and removed afterward. Other jobs, including
setup, slot setup, red/mutants, sweep and timeout hooks, do not inherit it. Own
names with CR/LF cannot be delivered; the note explains why. Scripts may read it,
but delivery never rewrites their exit. Runs without a native protocol say
`quarantine file: <n> names (owed excused nothing)`; natively refused Node/Cargo
runs keep `quarantine not applied: <reason>`. Container wrappers must make the
host path visible; scripts that skip names cannot prove recovery.

Native excusal supports plain allowlisted `node --test` exit 1 with complete TAP,
and `cargo [+toolchain] test --no-fail-fast` exit 101 with complete libtest blocks,
results, summaries and consistent failed-target diagnostics. Leading environment
assignments are allowed; shell quoting/operators/scripts are not native syntax.
Every failure must be an exact active name and remaining tests must meet
`min_tests`; excused names count neither passed nor failed. Cargo compile/crash,
incomplete/mixed/terse/truncated output, duplicate/unlisted failures and more than
50 failures fail closed; templates, red/mutants and timeouts are never excused.
Complete native trunk/merge runs can record sorted `obs.quarantine_passed` names,
including explicit/automatic trunk probes. Candidate-only passes and skipped,
TODO or ignored results do not qualify. Debt suggests removal if green persists,
identifying pure trunk or `the merge tree of <node>` / batch `<a, b>`, never
calling a batch pass a trunk pass. Feedback changes no verdict/key/count and
never lifts quarantine automatically. Cargo records an excused exit as 0, while
TAP retains its original observed exit 1; both use excused counts for verdicts.
See SPEC §7.16 for the latest-observation display limit.

CLI `owed attest <node> --probe-trunk [--check ID] [--runs N]` needs an open
slot/candidate; default selection is checks with active/flaky exec blocks.
Runs are 1–10, default 1, sequential per check and stop at the first non-pass;
existing probes do not skip explicit runs. Red/mutants checks and tests new in
the candidate refuse; probe cannot combine with rerun/remeasure/trunk/genesis/all.
The lease, node attest lock and per-run plan/candidate/slot/trunk CAS apply.
Exit 0 means probes passed even if the candidate owes work, 1 a non-pass/moved
CAS, 2 usage, 75 Busy. Probes never satisfy/block obligations; latest non-error
current-trunk evidence changes trunk-red diagnosis, and merge reuses matching
probes but still refuses the failed merge check. A failed explicit or automatic
probe naming a candidate-added file absent from trunk records `error` with
`probe not applicable: trunk lacks <path>, which the candidate adds`, not
trunk-red; outside-checkout absolute paths are ignored. The pi attest tool has
no probe parameters (SPEC §7.27).

Complete test-only node-check failures may match same-definition/closure trunk
probes before or after the failure, with equal signatures or name-only matching
when neither side has one. Invariant rules are unchanged. Hints name the block,
trunk and probe, say `not this node's change`, and suggest a tracked waiver with
a matching fix candidate or a request to add one. Writers ask the parent instead
of changing code outside writes. Passing probes clear no block.

`owed waive … --tracked-by <fix>` (tool `tracked_by`) requires another unmerged
plan node. Debt identity is `(node, obligation, key, accept_risk block)`:
re-waiving a failure replaces only its tracker; different risks keep separate
lines even on one key. No-risk waivers keep node/obligation/key identity. Default
status/brief/summary omit only debt whose own tracker merges; full status/report
keep `settled by <fix> (merge #<seq>)`. An unmerged tracker leaving the plan keeps
debt visible; `why <fix>` lists its debts. A tracker change is a new act, not a
retry. Settlement changes no waiver/ΔO⁻/gate and never proves a flake gone
(SPEC §9.9).

**Upgrade every reader to 0.27 before the first 0.27 writer records shared
quarantine policy, `obs.quarantine_passed`, `waive.tracked_by` or `ignorable`.**
Upgrade CLI, every driver and pi session loading owed, restarting drivers/sessions,
and upgrade executors/result consumers. Recovery is automatic on existing own
quarantine too: finish before any 0.27 executor measurement, not just enabling
sets or merging. The checked 0.26 parser ignores set keys rather than refusing
them; old executors cannot enforce shared policy. It refuses new obs fields and
strict-kind markers but ignores extra waiver tracker metadata. From 0.27 readers
honour every listed unknown top-level `ignorable` field, not a registry whitelist;
known fields still validate and unknown kinds/channels/enums still refuse. Older
readers still refuse the marker where they refuse unknown fields. Never rewrite
receipts for them; plan keys/nested shapes have no marker extensibility. See
[SPEC compatibility](docs/SPEC.md#compatibility-020027).

### Manual demonstration

The quickstart above uses the driver. The following low-level commands demonstrate the same sample without automatic orchestration. Do not run a second writer/reviewer beside a running driver.

Initialize the repository, commit the plan, and initialize the ledger as its owner (by default the main agent, delegated):

```sh
mkdir owed-demo
cd owed-demo
# Save the plan above as plan.yaml here.
git init -b main
git add plan.yaml
git commit -m "Record acceptance plan"
owed init plan.yaml                # delegated owner act; explicit confirmation only under OWED_CONFIRM=owner
owed status
owed dispatch greeting
```

In pi, the main agent (the owner) can instead call the `owed_init` tool (`plan`, optional `cwd`): delegated by default (under
`OWED_CONFIRM=owner` it shows the trunk commit, plan sha, node count and invariants in a confirmation dialog), it records genesis and measures the invariants in the
background, showing progress in `owed_status` and sending one message when done. If a genesis attest stops early
(`Genesis attest incomplete: …`), the ledger is initialized; run `owed attest --genesis`, or let the next
attest/merge measure the missing invariants first.

Dispatch prints the packet once and returns its slot worktree and branch (by default `.owed/wt/greeting-1` and `owed/greeting/1`). Always use the returned paths, not guessed ones. Since 0.16 it also runs the plan's `setup` in that worktree before recording dispatch. Optional `slot_setup: "<command>"` overrides `setup` for slots; `slot_setup: false` skips it. Commands use the measurement shell/environment/wrapper (`bash -lc`, `exec.env`, `exec.wrap`, `CI=1 OWED=1 OWED_TREE=<slot worktree>`) and a 600-second timeout. Success adds `Setup: ran \`<command>\` in this worktree (exit 0)` to the packet, escaping the command onto one line (newlines as literal `\n`, backslashes doubled). Failure refuses with the exit code or timeout and the last 20 lines of combined output, rolls back the worktree (including setup artifacts), unchanged branch and newly created directories, and records no entry. Setup outputs never enter the candidate (SS5): a successful setup changing tracked paths refuses with the paths and the same rollback. Newly created untracked, not-ignored paths, found by comparing `git status --porcelain -z --untracked-files=normal` before/after, are appended once to the common `info/exclude` as anchored literal `/<path>` rules (directories retain `/`); existing rules stay, already ignored outputs are skipped, and repeated dispatches add no duplicate rules. Glob/backslash/leading `!` or `#`/trailing-space characters are escaped; newline or carriage-return paths refuse with one-line escaped names and rollback. After appending, SS6 verifies the outputs are actually ignored using `git status --porcelain -z --untracked-files=all`, including directory descendants. A tracked `.gitignore` negation such as `!/artifact` overrides `info/exclude`: any still-visible output refuses with one-line escaped paths and guidance to ignore setup outputs in the repository or change `slot_setup`. Rollback removes only this dispatch's appended exclude bytes, preserving pre-existing rules, removes the slot worktree/branch and records nothing; owed never edits tracked ignore files. The successful packet then ends `(exit 0; excluded: /a, /b)`. Rules apply to all worktrees and persist. Rebase reuses the worktree without rerunning setup (rerun on rebase is deferred). `slot_setup` enters no key and changing it alone invalidates no evidence or candidate; the existing `setup` keys are unchanged. No ledger kind or field is added, so 0.15 and 0.16 share a ledger. The field needs a 0.16 parser: 0.15 ignores unknown top-level fields, including `slot_setup`, and runs no setup at dispatch; mixing versions changes no acceptance, only whether dispatch runs setup.

If the writer needs a requirement clarified, the parent can record and deliver
one decision from the repository root:

```sh
owed decide greeting --text "Keep hello.txt to one line with a trailing newline."
```

This also answers the node's sole open question and resumes it if halted or
held. Use `--writer` when an existing candidate must be changed and submitted
again, or `--no-resume` to record the decision while retaining a halt. That
halt becomes `held by ruling #N` under In progress, without a resume need or
halt wake; `owed resume <node>` releases it. Other obligations, review
questions and debt remain actionable.

Act as the writer in that worktree:

```sh
cd .owed/wt/greeting-1
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m "Add greeting"
owed submit greeting
cd ../../..
owed attest greeting
owed why greeting
```

At this point `attest` exits **4** because the required independent review is still missing, even though the content check passed. Have an independent reviewer inspect the diff and receipt, then record that review using their identity:

```sh
git diff main...owed/greeting/1
owed review greeting --ok --rank 1 --as reviewer:demo-reviewer --note "Inspected greeting and acceptance evidence"
owed merge greeting
owed report
owed verify
```

For this small demonstration a person can perform the independent review. In a real agent workflow use a fresh reviewer who has never been the node's writer; assigning a different name to the writer does not make it independent. The example has no trunk invariants or red check; production plans should declare appropriate ones. The shell check verifies the greeting text; it is not a test-counted suite.

## Reference: the driver

### Start and preflight

`owed start [--plan <file>] [--max N] [--stay] [--restart]` / `owed_start {plan?, max?, stay?, restart?, cwd?}` checks the repository, Git author/committer identity, plan parser and shell lint, trunk ref, update permissions and driver lock before recording init/plan. On a fresh repository supply a plan; otherwise omission rereads the latest recorded source, not a guessed filename. Canonical equality ignores formatting-only changes. A changed source becomes the default only when a changed plan is recorded.

Fresh init is delegated `owner:pi`; the driver performs genesis measurements through the existing attest/merge lifecycle. Under `OWED_CONFIRM=owner`, start refuses with explicit `owed init <file>` guidance and never opens a dialog. An uncovered downgrade refuses and names `owed plan <file> --note "<why>"`; record that explicit owner act with `--as owner:pi`, then start again. Allowance-covered changes retain their downgrade accounting. Refusals name the failed preflight and remedy. Plan/init remains recorded if a later launch fails; fix the launch and start again, not init again.

An unchanged plan and live driver says `already running`, with no entry or log rotation. `max` (positive integer) and `stay` change only a newly started driver. Tool output has three lines: action (with lint warnings folded into it), driver state and next step. CLI start adds `followed by pi session <first 8 characters>` only for a running driver when its session is known, including reuse; otherwise a running driver adds:

```text
note: no pi session follows this driver; no automatic pi delivery. To observe it explicitly, run `owed watch` (for example as a dsa command call).
```

CLI JSON results are `{initialized, updated, plan, warnings, driver, followedBy}`, with optional driver `alreadyRunning` and `followedBy: <id> | null`; pi tool details keep compact summaries of the start and driver metadata. These are runtime fields. Attachment by the owning pi session revalidates complete wake lines from at most the last 256 KiB of the current drive log, then follows from the end; an existing follower preserves deduplication. `owed drive --detach` prints the same follower line. Already exited drivers omit follower information and report `followedBy: null`.

Any agent can explicitly observe with `owed watch [--after <offset>[:<ino>]] [--timeout s] [--json]`, for example in a durable dsa command call that wakes its caller on completion. This does not subscribe a pi session automatically or transfer driver ownership. `owed watch` reads the drive log; writes no ledger entries and takes no driver lock. It revalidates wakes against the ledger and dsa and may write the state snapshot cache. Without `--after` it starts at the current log end. Exit 0 delivers a wake or driver exit; exit 5 reports `no wake within <s> s`. Both print `next: owed watch --after <offset>:<ino>`: reuse that cursor to continue. On timeout it preserves pending ride-alongs such as merge `Done:` lines for the next watch. An inode change starts the current log at zero; bare byte offsets remain accepted. Timeout seconds must be a nonnegative integer. Exit 3 says `no owed driver is running in <repo>; start one with owed start` with no `next:` line. JSON is `{lines, next, exit}`, with a cursor string in `next`. An old cursor can show a repeated wake line again.

`owed start --restart` / `owed_start {restart:true}` drains a live driver's
current action and in-flight measurements, waits up to ten seconds for its
process to exit, then starts the replacement. A timeout refuses with the pid
and says repeating restart is safe; `owed drive --stop --now` is the explicit
immediate stop. Without a live driver it is ordinary start. Graceful restart
and `owed drive --stop` without `--now` signal each pid/start-time process at
most once: repeated requests wait, never escalate. Preflight and foreign-host
protection still apply (SPEC §10.2, §12.8).

### Stopped writers and parent questions

A successful sealed/pruned writer without a current candidate waits while dsa
reports outstanding durable wakes: no submit reminder or stopped/no-submit
halt, including after repair/ruling/rebase follow-ups; due follow-ups still run.
Use the packet's `pi-durable-subagents run --request owed-<project>-<node>-<attempt>-<name> --wake caller -- <command…>`, then end the turn without submitting.
A live driver's status/why show `writer waiting on durable <request>` under
In progress with no wait-generated parent wake; without a driver it is unknown.
Non-ok seals retain their halt/recovery route and name outstanding requests.
Wait age uses the described seal time, otherwise first observation of that
generation (reset on driver restart); it affects display only.

Otherwise, when a successful writer finishes without a candidate, the driver inspects its
worktree. A clean HEAD at the handed commit halts without a submit reminder;
a new commit or dirty worktree can receive one reminder, then halts if nothing
is submitted. Plan-changed resubmissions still allow the same clean commit.
After a pending-rebase follow-up, no new work means clean HEAD at any of the
last submitted commit (or original dispatch base) and each later rebase's
pre-rebase base; work outside that set can receive one reminder carrying the
rebase instructions. Unavailable inspection facts halt conservatively.

Stopped-writer wakes, default why and status quote `writer says: "<final text>"`
(or `writer gave no final text`) and offer `owed decide <node> --text "<ruling>" --writer`,
also for non-ok seals. The whole reply is flattened: up to 600 Unicode code
points in full, otherwise head 200/tail 380: the head prefers a late sentence
ending, then whitespace/CJK; the tail keeps the original ending and adjusts
only its start to a nearby whitespace/CJK boundary. It retains up to
three omitted commit and durable IDs each. Escaping is unchanged and recorded
halts are not rewritten. dsa seal diagnostics append the ended-process total
and at most three pid/commands (80 code points each). Full evidence retains
the cause/run/failures; pruned text requires runner retention. Real questions
keep their existing answer flow.

A due ruling follow-up takes precedence over a pending-rebase halt. After
that follow-up, if the writer seals again without a new submit or outstanding
durable wakes, the driver halts naming it and sends no further submit reminder.
This applies when the ruling follow-up follows both the rebase follow-up and latest resume, even
with dirty files or an unsubmitted commit outside the handed set (SPEC §12.5.4).
The halt also names `owed decide <node> --expect report --text "<pause ruling>"`
to park the writer without that halt.

Writer packets/follow-ups ask for `decision_needed` (one sentence), numbered
`options` with label/scope/cost/risk and one preferred choice, `facts`, `tried`
and `classification_candidates` with evidence and unproven explanations.
Use structured ask fields when available, else text starting `Decision needed:`.
Structured notices/wakes lead with DECISION and options, then context, details
and each question's answer command; answer `"option <n>; <limits>"`. Clipped
fields prefer sentence/word/CJK boundaries and end in `…`; clipped details add
`(full: pi-durable-subagents describe --key <rid> --json)` for the whole question. Plain asks
keep their existing flow. Never submit a candidate believed to fail checks;
submit reminders also say to ask when stopped for a parent decision.
When a ruling tells you to stop, pause or wait for a parent prerequisite, do not ask to confirm it; state your status and end your turn.

After answer delivery, `owed answer`/`owed decide` and their tools report the
answered call's observed state, including queued, still asking, asking again,
sealed or unknown. A describe failure never resends; a retry without the
original question's call address reports unknown (SPEC §12.5.1).

### Quiet output and evidence

Flaky exec needs name the failed commit/observation and same-key attribution pass,
plus the merge key when applicable and the separate current candidate outcome.
An older different-key candidate flake is held from owner/repair requests until
the current candidate has a counted pass: errors keep the hold, failures take
the repair route, a pass exposes the original risk. Same-key/merge-key flakes
remain immediate; held blocks still bind acceptance/merge and can be waived.
Combined needs, wakes, why, waiver hints and repairs show trunk-red first with
parent guidance and the `or owed waive … --accept-risk N` alternative, then
shared-check-on-trunk diagnosis, then the full flaky same-key pair, never lost.

Waive CLI/tool replies start with debt recorded, then effect, then compact why;
`--full` / tool `full:true` restores evidence. Accepted counting blocks say
`in effect now` and name the risk/pair even on merge keys. Candidate satisfaction
cites actual evidence (including reviews) or is omitted; only a waiver accepting
no counting block can say it is not needed while the candidate stays satisfied.

Plan/edit shell/reads lint repeats only for new checks/invariants or changes to
run, reads or timeout, matched by invariant id or node/check id. Closure warnings
repeat on relevant reads/closure changes; near-timeout warnings only when their
admission text changes. Initialization checks everything, status/cost keep full
views; general check-less/loop warnings retain their own rules. With sets,
new/changed Cargo/Node test commands lacking both quarantine fields warn;
an explicit empty own list suppresses this warning.

Unresolved needs-parent reviews say `review asks: <ask>` and give one
`owed decide <node> --text "<ruling>" --writer` command in wakes, status and
why. The first case-insensitive needs-parent marker supplies the ask; without
one, the final sentence is used (one line, at most 300 characters). Full why
keeps the note. Review acknowledgment validates before append: insufficient
or underivable ack refuses with nothing recorded and names the required
watermark. Read the rulings, then use `--ack-rulings latest` / tool
`ack_rulings:"latest"`, a sufficient number, or a comma list of numbers
(optionally including `latest`). Lists select their maximum; `latest` selects
the latest applicable ruling. The tool also accepts a nonempty integer array;
all forms record one numeric watermark, and malformed lists refuse.
Trunk repair guidance names failing tests and the recorded plan path, or
`owed edit --node-new` when no source exists. Existing repository notices
retain their red text, waiting membership and remedies.

Default `owed why <node>` starts with outcome, then unsatisfied obligations, active blocks/conditions and their next commands. It retains unacknowledged model warnings, the complete `Ruling to forward:` payload, measuring/merge-wait state and the diff-derived review requirement (context, not counted as outstanding). The total counts unsatisfied obligations and active blocks, not merge-wait context or every displayed line. Default ΔO⁻ lines are restricted to entries after the current dispatch or latest resume; `--full` retains older history (also on CLI rebase and candidate attest). `owed why <node> --full` / `owed_why {full:true}` restores observations, counts/logs, satisfied items, history, superseded entries, other ruling text, ΔO⁻, selected/used models, acknowledged warnings, backlog (`later`) and quarantine lifts. CLI JSON and act/refusal receipt cards stay detailed; pi tools obey the 48 KiB content and 8 KiB details bounds below, even with `full:true`. Non-node/trunk subjects receive trunk measurement or plan-repair commands, never a node command they cannot use.

Writer repairs list only failures since the latest non-refused repair follow-up to that run, with new failed-test/reviewer notes, plus one line naming earlier obligations still failing. Ruling steers, report/rebase/interrupted follow-ups and refused sends do not reset the boundary; before the first repair all failures are new. An empty delta says so. Rulings come first, then fix/commit/submit and `owed why <node> --full` for everything else; owed reruns checks itself. Driver restart recovers refused sends from retained halt reasons, recent driver reports and runner receipts, so refused repairs do not advance that text boundary. Removing all refusal evidence prevents recovery; binding failures remain in the full receipt.

A single or batch CLI merge gives `<node> merged (<commit12>); measured <n>, waived <n>, debt <n>` per member. Measured means evidenced check/red/strength/writes/invariant obligations, not reviews or manual evidence; debt is defers on this merge's keys only, not historical defers. Single merges retain debt/coverage lines and lease annotation; batches retain conflict dropouts and `Batch of <n>: <nodes>`. The post-commit receipt read is best-effort: a shortened `<node> merged (<commit12>)` still means success. No supplied current-key debt count means no debt field.

### Driving the loop with dsa

`owed start` is the normal preflight/start entry. The low-level `owed drive`
controls below remain for an initialized repository; unlike start, detached
drive start refuses an already running driver. Without a pi session, use
`owed watch` to wait for its wakes.

`owed drive` runs the mechanical loop — dispatch, writer, submit, attest,
reviewers, merge — with [pi-durable-subagents](https://www.npmjs.com/package/pi-durable-subagents)
(≥ 1.0.27) as the process runner, and stops for decisions. Every intent is
recorded in the ledger before dsa is called and retried with the same bytes and
id, so killing the driver at any point is safe. Attest and merge run under
`pi-durable-subagents hold machine --shared --priority 10 --no-wait` and are retried later
while the machine is busy; with an older dsa that rejects `--no-wait` the
attempt is halted with that error. Unknown `--priority`/`--yield` options fall
back only after a separate no-op hold confirms dsa's refusal; measured commands
are never replayed by fallback. One driver per repository
(`.git/owed/drive.lock`); a lock left by a dead driver on this host is taken
over, but a lock from another host is not: check that host, then remove the
file by hand. Attests and merges run in the background while the driver
serves other nodes (at most `drive.measure` at once, default 2, and one merge).
A first Ctrl-C stops after the current action and waits for them, a second
stops at once.

With an owner pi session and a dsa whose help advertises command runs with
`--session`, each driver attest runs as a command call named `owed attest <node>`.
It appears with live state and its seal in `/subagents`, and running calls appear
in dsa restart refusals. The call carries project, node, attempt and candidate
labels; status adds its request id. The existing shared hold and lease marker
run inside the call. Exit 0 means accepted, 1 measured failure, 4 obligations
outstanding and 75 busy; busy retries on a later pass. Other exits or invalid
seals halt with the request id and output tail.

The base request id is deterministic for project, node, attempt, candidate and
ledger length at start. A retry attaches to a live call or reuses a normal
0/1/4 result; confirmed old sealed non-results advance through deterministic
`:r1` to `:r20` ids. Exhausting them halts. Graceful stop waits; hard stop asks
dsa to stop the call. Without an owner session or command/session support, or
after a confirmed unsupported launch refusal, the driver uses the legacy
hold/direct path and prints one line explaining why measurements are not shown
in `/subagents`. Other launch failures halt. Capability is probed once per
binary/process, with no new fixed dsa version requirement. Merge measurement
and internal trunk refresh/sweep stay in-process (SPEC §12.7).

```sh
owed drive            # until idle; run it in a terminal or a systemd-run --user unit
owed drive --once     # one pass (also the pi tool owed_drive)
owed drive --detach   # the same loop as a detached background process; prints its pid and log
owed drive --detach --stay   # when idle, keep running and wait for ledger changes (a growing plan)
owed drive --status   # running (pid, host, since) or not, its last exit record, the last 10 log lines
owed drive --stop     # stop it after its current action and in-flight measurements (--now: at once)
```

The plan's optional `drive:` block sets the writer and reviewer dsa agents
(and models) for every node; a node may override them with its own `drive`
(0.7.0), e.g. to route routine nodes to cheaper models. The packaged default
reviewer is `owed-reviewer`: it must record its verdict with `owed review` and
may run checks in a scratch checkout, without editing the writer's or main
checkout. To keep a custom profile, explicitly set `drive.reviewer.agent`
globally or on the node; existing recorded launches keep their agent:

```yaml
drive:
  writer:   { agent: worker,   model: "example/model-large:high" }
  reviewer: { agent: owed-reviewer, model: "example/model-large:high" }
nodes:
  - id: docs-pass
    drive:
      writer:   { agent: worker-cheap }            # agent set: replaces the plan's writer (its own default model)
      reviewer: { model: "example/model-small" }   # model only: the plan's reviewer agent with this model
```

Batch merge measurements survive an unrelated node-only plan edit only when
every intervening plan, projected onto members plus all global settings,
is canonically unchanged. Relevant or transient member/global edits refuse;
facts are recomputed after unrelated edits and indirect changes still refuse.
Trunk, slot and candidate CAS and the latest guard remain binding (SPEC §7.21).
A refused driver batch's candidates merge alone across trunk changes, new
partners and restarts, until their commit changes, the node merges or its slot
closes. Re-submitting the same commit keeps isolation. Missing or unreadable
isolation state means no remembered isolation. Status reads the isolation file
and excludes matching candidates from its batch preview. If saving isolation
fails, the refusal report adds `(isolation not saved: <error code>)` and the
driver keeps the in-memory isolation.

After a `review-missing` halt, `owed resume <node>` gives the same sealed run
one new verdict follow-up; another seal without a review halts again. Rejected
or pruned runs cannot receive it, so their remedies omit resume. Builtin
read-only reviewer guidance includes `owed edit --drive --set
reviewer.agent=owed-reviewer --note "<why>"` for a new run of a later candidate,
then owner review or `owed abandon <node>`. The edit does not replace the
existing run.

A node `drive` is not an obligation: changing it is never a downgrade, keeps
the submitted candidate and affects only later launches (a re-launch resends
the recorded bytes). `owed why <node> --full` shows
`Drive: writer <agent> (<model>) · reviewer <agent> (<model>)` for a node that
sets it. owed 0.6.x ignores a node's `drive` and launches with the plan's drive.

In 0.20.1, `owed why` compares selected and used models by `provider/id`,
ignoring the trailing `:thinking` even for same-writer/reviewer warnings; ids
with several slashes stay intact. Selected names resolve through dsa `pools`
in `$DSA_HOME/config.json` (default `~/.pi/durable-subagents/config.json`),
including nested pools and `{model, afterMs}` fallbacks. Any discovered member
matches. Unknown/empty/cyclic/malformed or partially unresolved pools cannot
prove a mismatch; why instead shows `selected <name> (pool membership unknown)`
for unmatched used models. A valid branch can still prove membership. Config
is read locally when rendering, not snapshotted; missing launch blobs are
unknown and owed does not alter dsa routing.

Set `drive.same_model: accepted` globally or in a node's `drive` to acknowledge
only the informational same-model warning. Other values refuse; a node may
acknowledge without role overrides, otherwise inheriting the global key.
Compact why omits acknowledged warnings; `why --full` restores `(acknowledged)`
and JSON keeps `{message: string, acknowledged: true}` alongside ordinary
warning strings in `modelWarnings`. Selection mismatch warnings stay visible.
Adding/removing this key changes no obligation key, downgrade, review block
or acceptance rule; removing it restores the warning without invalidating
evidence. Upgrade every reader before using it: older parsers reject the key.

Environment failures wait instead of halting (0.11). A measurement that exits
non-zero with no failing test counted and `ENOSPC`, `No space left on device` or
`Disk quota exceeded` in the last 50 output lines (TAP/cargo test-name lines are
ignored, so a test title is never evidence; any counted failing test makes it a
plain `fail`), a check/invariant (red included) exiting 75 whose last non-empty
line matches `^hold: .*(not running the command|the command was stopped) \(exit 75\)$`,
or that fails before its command runs (worktree preparation,
spawn, `setup`), is recorded
as `error` with a note starting `environment: `. The driver does not count
those toward "attest recorded no verdict twice"; it waits 1, 2, 5, 10, then 30
minutes before the node's next attest (a resume starts again) and notifies once
per streak. Before it starts a measurement it checks the free space of the git
common dir and the temp dir against `drive.min_free_mb` (default 2048, 0
disables) and starts none while either is lower (one `disk low: …` notify per
change). Lease errors say the check did not run or yielded; trailing spaces
after `(exit 75)` and other exit-75 output keep their ordinary verdict.
A disk-full error escaping a pass logs a `disk-full` event (a wake),
sleeps 60 s and continues.

`--detach` refuses while a driver holds the lock (naming pid, host, start and
log). Otherwise it keeps the previous log as `.git/owed/drive/log.jsonl.1`,
starts `owed drive --json` in its own session with stdout and stderr appended to
`.git/owed/drive/log.jsonl` and returns once that driver holds the lock; if it
has not taken the lock within 30 s, `--detach` stops it (SIGTERM), prints the
log tail and exits 1. A concurrent `--detach` or `--stop` waits until that is
decided. The log's last line is the exit record
`{"event":"exit","code":C,"reason":"idle|stopped|killed|error","at":…}`; only
SIGKILL or a crash leave none, and `--status` then says it ended without an exit
record (an empty log says `no driver output yet`). The exit record is written
before the lock is released, so once `--stop` says `stopped` it is in the log.
`--stop` signals the lock's pid only when its process start time matches
(never a reused pid, never another host). In pi, `owed_drive` with `action:
"start"` does the same, and the owning pi session is woken with one message when the
driver halts, needs the owner, a run asks a question, it is stalled, dsa events
fail or the driver exits (merges ride along with the next message). One wake
per new fact: a halt or notify of a node wakes again only when its text changed
or the ledger gained entries for that node not written by the driver (e.g. the
writer resubmitted, a ruling); otherwise it only rides along with the next
message as `<text> (repeat n, no new ledger entries)`. Trunk moved outside owed is
not a halt: the driver merges nothing and notifies once per change with
`owed adopt --note "<why>"` (or the `git update-ref` that restores a rewound
trunk); after the adopt its next pass merges. Automatic attachment at session
startup, tool calls (including status, why and refusals), ticks and settlement
requires the current top-level pi session to own the live driver. Opening another
session in the same repository or reusing another session's driver does not
subscribe it or transfer ownership. Resuming the same owning session still
attaches, and matching owners discover their live drivers across repositories
at most once every ten seconds. Pi uses its validated context identity; only
when that context identity is unavailable does it fall back to validated
`DSA_SESSION`, then validated `PI_SESSION_ID`. An invalid supplied context
identity does not fall back. Missing identity or unknown ownership never
broadcasts. The current lock's session wins; a legacy PI-only registration
can establish ownership only when repository, pid, process start and lock time
match that exact live driver.

Owned attachment revalidates still-current wakes from complete lines in at most
the last 256 KiB of the current drive log, then follows from the end; an existing
follower keeps its deduplication. Changing context identity discards the old
session's followers and queued wakes, with identity checked again at delivery.
Sessions inside dsa calls (`DSA_EXEC`/`DSA_CALL` set) never attach automatically.
Explicit `owed watch` remains available without changing ownership; an absent
owner is never taken over automatically. Nobody has to poll
`action: "status"`; `action: "stop"` stops it. The driver survives pi exiting.
The driver carries no dsa call identity (`DSA_EXEC` and `DSA_CALL` are removed
from its environment; `DSA_HOME` and the rest are kept). Started from inside a
dsa call, start still works but prints `note: started from inside a dsa call; if
that call's processes are contained, the driver may end with it — prefer
starting it from a top-level session or systemd-run --user`.

Notices start with `Needs you: <node> — <decision> → <one command>`, then
`Done: <merged nodes>` when any, and `Driver continues (<n> in progress)` or
`Driver stopped: <reason>`. Each question/reason and its command appear once; raw node lines and internal identifiers are not echoed unless needed to act. Full repository notices and reported findings stay because they are the payload. There is no repeating `Details:` block; `Next: owed status / owed why <node>`
stays last. Action log `inProgress` counts open slots.

An answer recorded with `owed answer` suppresses the question in both the driver
and pi delivery, even while the run remains `asking` in the model queue. The
quiet log says `<node>: answered #<seq>, waiting for the run to resume` (runtime
outcome `answered`). If that question remains open after `drive.answer_grace_s`
(integer seconds 0..900, default 600, 0 = immediately), one reminder per rid/qid
in that driver run gives the exact answer retry command. Its `answerRetry: true`
log flag keeps this reminder deliverable while the answered question stays open.
The reminder uses `<node>: answered at #<seq> (HH:MM), still asking after <m>m: retry with owed answer <node> --rid <rid> --qid <qid> --rev <rev> -- <text>`, not a new question. The QN answer grace and this line share the same threshold. While a driver runs, status obtains this line from its runtime cache; it disappears when the run resumes or the slot closes. Without a driver the status line is absent, not proof of delivery.
The field changes no obligation key; plans omitting it replay as before, and
older plan parsers reject it as an unknown drive key. No new ledger entry is added.

Each JSON loop log line carries `driver: {pid, start?, at}`. A terminal line
from an earlier driver is checked against the current repository owner at delivery:
when a newer driver owned by the same session runs (or in explicit CLI watch),
it rides along with the next message as `earlier driver
(pid P, started T) <event>; driver pid Q (started U) is running`. Current-owner
terminal lines, and those with no live owner, still wake normally. An automatic
follower never reconnects to a replacement owned by another session: it retains
the owned log through rotation, delivers the old driver's terminal notice and
stops without reading the foreign replacement's log.

In pi a wake is never handed to the session while its agent is running: the
follower holds it until the agent settles, then drops what was resolved
meanwhile (a question no longer open in dsa, a node line whose node gained
ledger entries) and delivers the rest, with `(<n> wake(s) resolved before
delivery)` in the wake; if nothing is left the session is not woken. With `--stay`
(`owed_drive` `stay: true`) an idle driver does not exit: it wakes the session
once (`idle: nothing open and nothing ready; staying until the ledger changes
(owed drive --stop ends it)`), keeps the lock and resumes when the ledger
changes (a plan update, a ruling); `--status` then says `idle, waiting for
ledger changes since <at>`. After `owed plan` / `owed_plan`, when nodes are
ready to dispatch and no driver runs, the output adds `ready: <ids> (<n>); no
driver is running: owed drive --detach --stay` (pi: `owed_drive
{action:"start", stay:true}`); nothing starts automatically.

With pi-durable-subagents ≥ 1.0.31 the driver's runs are listed in the pi
session that started it. Pi tool starts pass the validated current context
identity through to the child launch without changing shared process environment;
when unavailable, they use validated `DSA_SESSION`, then `PI_SESSION_ID`.
CLI start keeps its existing `DSA_SESSION`-first semantics and lock representation:
it records the validated `DSA_SESSION` in `drive.lock`, hands it to a detached
driver and passes `--session <id>` to every `run`. Session identity is ignored
inside dsa calls. `owed drive --status`, `/owed` and
`owed_drive` status say `runs are listed in pi session <id>`, or `no pi
session: runs show only in pi-durable-subagents status / the CLI` for a driver
started outside pi. An older dsa that refuses `--session` is used without it
(one log line, never a halt). To move a repository's runs to another pi session,
stop the driver and start it from that session; earlier runs stay where they were.

The driver never answers a question, waives, changes the plan or forces a dsa
restart: questions and owner decisions are printed, and a halt (`owed status`,
`owed why`) waits for an action on the node by the main agent (the delegated owner;
owner halts list the command that resolves them). A ruling, submit, review,
rebase, abandon or resume on the node clears a halt, and the next pass resumes.
A decision with `--no-resume` instead keeps it held by ruling, with no halt
resume request/wake; independent needs remain. A ruling recorded while a
driver-launched writer or reviewer call is running reaches it as a steer
(reason `ruling`, recorded) once the node has nothing else to do; sealed calls
get rulings with the next follow-up (submit, rebase and repair follow-ups list
the undelivered rulings first; a ruling steer dsa rejected, e.g. because the call
had just ended, counts as undelivered), and reviewers still acknowledge them with
`--ack-rulings`. Launch entries and follow-ups record the rulings their
message carried, so a ruling recorded while one is being sent is steered
afterwards. A ruling naming the node gives the attempt a fresh repair budget
(`repairs` counts the repairs since the latest such ruling or plan change of the
node's spec), and a sealed writer the driver would otherwise halt for (finished
without submitting, repairs exhausted) gets it as one `ruling`
follow-up instead; never while a reviewer run of the candidate is running or
when the candidate has no block. Since 0.8 a due ruling comes before any other
halt too: a sealed writer gets it before the owner-needed notify (a flaky block,
a rank 2 review block), before the `sealed <status>` halt and before the
`stalled:` halt; when a stalled candidate owes only the `rulings`
acknowledgment, its sealed reviewer gets the ruling as a follow-up (or a new
reviewer is launched) and its ok with `--ack-rulings` lets the node merge.
Each ruling is sent once; if the node still needs the owner afterwards, the
notify or halt follows as usual. A flaky block's hints also offer `owed rule
"<what the writer must change>" --nodes <node>` for when the check or test
itself must change. A check that ran the same number of passing
tests twice, below its `min_tests`, halts for the parent (`the plan's threshold
may be wrong`) instead of another repair. Calls you launched by hand stay yours to steer. Driver calls
carry a dsa run name (`owed <node>#<attempt> writer` / `owed <node>#<attempt>
reviewer <n>`). Detailed asking diagnostics retain dsa addresses and answer forms; plain wakes give each question its text and one owed answer command.
Even while halted, the driver reports asking writers and reviewers of the current
candidate with the same answer hint and once/quiet behavior; it does not clear
that halt or send anything. Ordinary questions still use the driver's asking channel. While a driver runs, status additionally shows runtime-cached answered-but-still-asking questions after the grace period; brief otherwise stays ledger-only.

A rejected **run** stays fixed for the attempt (D15.1): fix the cause (plan,
agent, model), then `owed abandon <node>` so the driver dispatches a new attempt.
A rejected **send** need not lose the attempt (0.16.1, SR1–SR4). Row 4 skips it,
never re-sends it and lets later rows act if a later ledger entry is a resume or
submit of the same node/attempt, or a non-rejected send of that attempt to the
same rid (even one not yet confirmed applied). A rejected steer to a sealed or
pruned run is also skipped: the sealed-run rows decide (`unknown` gets the
`interrupted` follow-up). At send action time a rejected steer records only the
refusal and outcome `rejected`; next pass decides. A steer to a still
running/asking/queued run with nothing later still halts then; rejected
follow-ups and notices keep their action-time behavior, including existing
ruling-steer and waiting/ruling-notice exemptions. No ledger format or key changes.
The send halt says: `the attempt is not lost: continue the run (e.g. a dsa
follow-up), then owed resume <node>; a later resume, submit or send to this run
supersedes this send; or owed abandon <node>`. After that resume it does not
re-raise the same send halt; abandon is the last option.
Halts that name a driver run also give dsa's call address
(`to:"<wid>/<key>"`) when dsa reported one, so you can steer or inspect the call.

#### Same-key reviewer reuse (0.16.1)

An evidence-only resubmit with unchanged required `review` and `closure-review`
keys reuses reviewer runs launched since the start of that contiguous review
epoch in the open attempt. These runs still report questions and receive rulings;
the driver counts them instead of launching redundant reviewers. A review-key
change starts a new epoch with the existing launch behavior. A sealed carried
reviewer's verdict follow-up names the current candidate, and its earlier review
on the same key counts. Satisfied `owed why --full` / operation receipt items show each principal
once, with its latest qualifying review; this is view-only deduplication and
changes neither replayed state nor acceptance rules. Stopping already-surplus
reviewer runs remains deferred (SPEC RR4); 0.16.1 adds no driver `stop` effect.

## Reference: parent and owner acts

The main agent acts as parent and delegated owner: no user needs to operate owed. Pi owner acts use `owner:pi`, CLI owner acts `owner:cli`, with channel `delegated`; the brief lists these audit acts after outcome and Needs you. Downgrades, waivers, deferrals and adoptions require reasons; approval accepts a note, which the main agent should provide and report. Under `OWED_CONFIRM=owner` explicit confirmation restores default `owner:human`. Earlier CLI versions used that identity even without the gate; an explicit `--as owner:human` retains the label, not stronger authority.

### Parent decisions and recovery

Prefer `owed decide <node[,node...]> --text "<decision>"` (pi
`owed_decide {nodes: ["A"], text: "..."}`) for guidance that combines ruling,
question answer and recovery. It answers at most one open question per node
across writer and reviewer runs and resumes halted/held nodes by default.
`--writer` requires resubmission; `--no-resume` keeps the halt as `held by ruling #N`,
without a halt resume request/wake. `owed resume <node>` releases it; other
needs remain. When `owed rule` finds a
known writer call neither running nor asking, its receipt says the ruling was
recorded but not sent now; the driver delivers it on its next pass. A halted
node not held by a decision needs `owed resume <node>`; decide records and resumes in one step.
`owed rule` never sends follow-ups itself (SPEC §9.3). Add
`--writes path` (or `+path`) to amend the recorded plan with the same authority as amend,
`--defer INV` as owner to retain current merge-key debt, `--after FIX` to wait,
or `--remeasure` to request same-key invariant measurement. After/expect/remeasure
imply resume and cannot combine with no-resume. Every part validates before
one append; a refused part records nothing. Answer delivery is external: use
the exact retry command if it fails. Decisions do not clear review blocks or
acknowledge rulings for reviewers. Remeasure replies name each failed merge-tree
invariant key. If trunk/candidate moved since failure, the next merge builds a
new tree and remeasures the unchanged key or measures a new one normally; no
Git tree is built at decide/resume time. Active merge-check blocks follow
attribution on their original key; already-flaky ones still need accepted risk
or a fix, because remeasure measures invariants only.

For a report and pause, use `owed decide <node> --expect report --text "<pause ruling>"`
or `owed answer <node> --expect report "<answer>"` (both tools accept
`expect: "report"`). Like `owed resume --expect report`, they record a report
resume for the open writer attempt: a successful report without a new submit
becomes `reported (resume #n)`, wakes the parent once and stays quiet until a
relevant parent act naming the node. The ruling/answer and resume validate and
append together before delivery. A missing open slot or
`owed decide --no-resume --expect report` refuses without recording anything.
Answer retries reuse the original rule, resume and request id; they cannot add
a report resume to a prior plain answer or repark after a later parent act.

For one shared failure blocking several nodes, inspect the repository notice
and fix the common cause once; name the failed test in the fix node's brief.
An accepted, non-halted fix candidate takes precedence automatically. To retain
the debt knowingly, use owner
`owed decide A,B --defer inv:integration --text "<reason>"`. A narrow owner
`allow[].defer` can authorize executor deferral when both a matching-signature
shared failure and a pass exist on the merge key. Waiting and name-only
matching never grant acceptance. See SPEC §7.24.

The separate commands below remain valid. Use `owed answer` to disambiguate
multiple questions or retry a recorded answer; `owed resume` for a retry with
no new ruling or `--expect report`; `owed rule` for global/prospective policy;
`owed amend` for a standalone writes amendment, and `owed edit` for other plan
changes.

Answer a selected writer or reviewer question with `owed answer <node> [--qid Q] [--rid R] [--rev N] [--expect report] "<text>"` (pi `owed_answer {node, text, qid?, rid?, rev?, expect?: "report"}`, parent or owner). Omit qid when one open question matches; rid disambiguates questions across the node's current writer and reviewer runs. Ambiguity refuses and lists the open questions. The command records one rule naming the node, `writer: false`, text `Answer to <role> question <qid>: <text>`, and `answer: {rid, qid, rev}`, then sends dsa `kind: answer` with request id `owed-answer-<rule seq>`. A delivery failure retains the rule and reports its seq and an exact retry command including `--rev`. Use `--` before text beginning with `--`; exact retry commands include it. The driver does not send that answer rule back to the target rid as a ruling steer or follow-up. Other runs receive it normally and reviewers still acknowledge it. Successful text names the answered role/question/run and rule, then any other-role delivery result; CLI `--json` retains the request id and full details; pi tool details retain compact identifiers, delivery counts and state samples. Use `owed why <node> --full` for full ruling follow-ups.

Revision-aware answers (0.16, dsa 1.0.38 re-asks): identity is rid+qid+rev. An open matching question always uses its current rev from dsa describe, even if `--rev` names an old rule. A newer re-ask records a new rule and request id, with either the same or different answer text. Same rid+qid+rev and text retry the original request; different text at that rev refuses and names the rev. With no matching open question, `--rev N` retries that prior revision; omit it to retry the latest prior rule for rid+qid. The rid may be found from current-attempt launches when history identifies exactly one run; an explicit rid/qid retry also works after the slot closes. Without matching history, "No matching open question" refuses. `--rev` / tool `rev` must be a positive integer, otherwise a usage error. The driver still covers only questions at revisions <= the recorded answer rev, so q@2 after a q@1 answer remains an open question.

Compatibility: a re-ask answer records `supersedes: <seq>` of the latest prior answer rule for the same rid+qid with a lower rev. It is required exactly when that history exists and absent otherwise. Owed 0.15 and 0.16 share a ledger until the first rule with `supersedes`; after that every reader needs 0.16 (0.15 refuses with code `version` and an upgrade message). Historical states and keys are unchanged; no new entry kind is added. Owed < 0.13 also refuses a rule with the `answer` field with code `version`; upgrade before replaying it.

`owed resume <node> --note "<why>"` (pi `owed_resume`, parent or owner) clears a
halt without creating anything to acknowledge, and gives the attempt a fresh
repair budget: use it for "measure again", "retry the merge, the disk was full",
"go on". `owed resume <node> --after <other> --note "<why>"` makes the node wait
(`owed status`: `waiting for <other> (resume #<seq>)`; the driver leaves it alone
except for questions) until `<other>` merges; then the driver carries on, and the
writer's next follow-up starts with `The parent resumed this node (#<seq>) after
<other> merged at <commit>: <why>`. Use `owed decide <node> --text "<decision>"`
when the writer and reviewers must follow and acknowledge a decision (a
changed requirement, a contract answer): a ruling is an obligation, a resume is
not. The older `owed rule --nodes <node> "<decision>"` still works. Add `--writer`
(pi `owed_decide` parameter `writer: true`) when the decision
requires the writer to act: a ruling recorded after a named node's open submit
invalidates that candidate and requires a new submit, even of the same commit.
The driver sends the ruling to a sealed writer as a `ruling` follow-up or to a
running writer as a steer; reviewers still acknowledge it. A `*` ruling remains
general guidance and does not invalidate candidates. Without `--writer`, ruling
routing is unchanged. If a merge already measuring refuses after a
`resume --after` starts a wait, the driver reports `waiting` and records no halt.

For policy that should bind future work, use `owed rule --nodes "*"
--prospective "<policy>"` (pi `owed_rule` field `prospective: boolean`). It
records `prospective: true` on the rule and binds only attempts dispatched
after that rule; their packet and `rulings_seen` include it normally. Existing
attempts keep their current rulings obligation. Each unsealed writer and
reviewer run of an older open attempt receives one informational `notify`,
with no follow-up or new acknowledgment. Sealed runs receive no such policy
on later follow-ups and are never relaunched for it. Removed nodes receive no
notices; the parent closes their remaining slots. `--prospective` cannot
be combined with `--writer` (usage error, nothing recorded). Compatibility:
owed 0.13 and earlier refuse rule entries with `prospective`, including false,
with code `version`; upgrade all readers first. Omission or false retains the
ordinary ruling behavior and no obligation key changes.

When an ordinary `*` ruling leaves a candidate owing only `rulings`, the
driver sends the re-ack follow-up to the latest driver reviewer, or launches
a reviewer if none exists. The message includes the rulings, candidate commit
and `--ack-rulings <seq>`; the reviewer may block if the writer must change
something. Without a review/closure-review obligation, it instead sends the
writer one ruling follow-up per set, asking for `owed submit <node>` (the same
commit is allowed). The resubmit advances `rulings_seen` only through recorded
writer ruling follow-ups, not later unsent rulings or prospective notices; the
driver waits rather than issuing a stalled-owner halt. `owed report`'s "Status changes" omit nodes merged by the end of
the window, so later rulings do not add merged-node rulings noise. Owner
reviews use `--rank 3`; other ranks are refused with that instruction.

owed 0.7.x cannot read a ledger with a `resume` entry: upgrade the CLI, the
pi extension and every driver together.

### Atomic edits and attempt recovery

Use `owed edit` (pi `owed_edit`) for atomic field changes:

```sh
owed edit auth-api --set 'checks.unit.timeout_s=120' --unset drive.writer.model \
  --rule 'Keep the public API unchanged.' --resume --note 'Bound the unit check'
owed edit a,b --set 'review.count=2' --note 'Require two reviews for both nodes'
owed edit auth-api --set 'review.min_rank=2' --note 'Require a senior review' --dry-run
owed edit follow-up --node-new --set 'deps=[auth-api]' --set 'title=Verify integration' \
  --set 'writes=[test/integration/]' --note 'Add the integration task'
owed edit --invariant unit --set 'timeout_s=120' --note 'Bound invariant execution' --as owner:pi
owed edit --drive --set max=6 --set reviewer.agent=owed-reviewer --note 'Tune driver launches'
```

Node paths are `title`, `brief`, `deps`, `writes`, `allow_only`, `later`, `review.count`,
`review.min_rank`, node overrides under `drive.*`, `checks.<id>` (a whole YAML
mapping; id inferred) and `checks.<id>.<field>`. Repeat `--set path=yaml` and
`--unset path`; sets run in order before unsets. `--node-new` adds a node from
`deps`, `title`, `brief`, `writes`, `allow_only` and checks. `--invariant ID` edits a top-level
invariant field. `--drive` edits or creates the top-level drive mapping, with
relative paths such as `max`, `repairs`, `merge_batch` and `reviewer.model`,
validated by the plan parser. It excludes other targets, `--node-new`,
`--rule` and `--resume`. The source is `--plan FILE`, else the latest plan entry's path;
unrecorded semantic file changes refuse. Comments are kept and text outside a
simple block target keeps its layout. Flow containers and targets using anchors
or aliases use whole-Document serialization; spacing may be normalized. Results
must re-parse to the intended plan before writing. `--dry-run` prints the diff
and downgrades without owner confirmation, even with `OWED_CONFIRM=owner` in
a non-TTY process.

One ledger lock records the plan (same authority, downgrade guard and candidate
carries as `owed plan`), then optional `--rule TEXT` naming the targets, then
optional `--resume` on each target's open slot. `--writer` requires the rule and
requests writer action. Resume accepts `--after a,b` and `--expect report` with
their normal waiting/report behavior. Pre-write refusals record nothing and
leave the file unchanged; file replacement follows the append, with existing
recovery instructions if replacement fails. Tool targets are exclusive `node`,
`nodes: string[]`, `invariant` or `drive: true`; other parameters are `set`/`unset` string arrays,
`note`, optional `node_new`, `plan`, `rule`, `writer`, `resume`, `after` (string or
string array), `expect: "report"`, `dry_run`, `as` and `cwd`.

`owed edit a,b` applies the same assignments to both nodes, deduplicates in
first-seen order and validates only the final plan, computing carries once.
An exact existing CLI node ID wins over comma splitting; `--node-new` also
keeps its target literal. Use tool `nodes` or separate edits for a colliding
batch. Otherwise comma parts are trimmed and empty parts refuse. Creation
allows only one distinct node; dry-run prints one diff and all downgrades.
`owed amend` continues to work as before.

To widen one node's writes without rewriting the plan by hand, run `owed amend <node> --writes +path[,+path...] --note "<limit>" [--plan <file>]` (pi `owed_amend`). It appends the paths to the node's `writes` in the plan file (default: the file the latest plan entry recorded; comments and layout are kept), records it as `owed plan` would (same authority: the owner, or a parent under an `allow` rule; open candidates are carried), and in the same lock records a ruling `writes of <node> widened by plan #P: +<paths>. Limit: <limit>`, which the writer receives and reviewers acknowledge. It refuses, recording nothing and leaving the file unchanged, when the file has unrecorded edits, the node is unknown or merged, a removal is requested (`-path`, which needs `owed plan`), or the note is empty. Bare paths mean additions just like `+path`. A requested scope is covered only when equal to or provably contained by an existing write; `src/lib` under `src/*` widens, because a filename match is not prefix-range containment. Covered paths report `already covered by <entry>`; an all-covered amend changes neither file nor ledger. An all-covered decide still records its ruling/defer/resume but no plan entry and says `writes unchanged`. Multiple nodes must receive equal additions after dropping covered paths per node; mismatches name each node's covered and added scopes. An allow rule is not an existing write (SPEC §3, §8.3.1).

`owed abandon <node> --note TEXT` closes the open slot with a note.
Use `owed abandon <node> --hold --note "decision pending"` (pi
`owed_abandon {node, hold: true, note?}`) to prevent re-dispatch: abandon and
its new `hold` entry are appended atomically. Status and why show `held by
abandon #N`; dispatch names `owed resume <node>`, which releases the hold
with a resume entry carrying `release: "hold"` and no open slot. Normal
readiness rules apply afterwards; held nodes do not satisfy dependencies.
Hold release takes neither `--after` nor `--expect`; dispatch a new attempt
first. To retire a node, remove it from the plan first, then abandon its slot;
while deciding, use `--hold`. Removing the node makes its hold moot.
Hold entries and `resume.release` require 0.14; 0.13 refuses both with code
`version`. From 0.14 unknown abandon fields also return `version`; abandon
itself has no `hold` field. Historical ledgers and acceptance keys are unchanged.
If a driver's writer launch is stale because its node left the plan, was held
or abandoned, it closes its own never-launched empty slot without halting or
notifying. Clean, unlocked worktrees at the base are removed; commits and
uncommitted changes keep their worktree and branch. Parent-dispatched slots
and attempts with any writer launch intent remain untouched.

### Owner approval, manual evidence and receipts

Some acceptance cannot be measured by a check: an external effect the owner must authorize (an npm publish, a push), or a manual look at a real page. A node can declare both:

```yaml
  - id: release
    writes: ["package.json", "CHANGELOG.md"]
    approve: owner                      # obligation approve: only the owner discharges it
    evidence:
      - id: ui                          # obligation evidence:ui
        what: "looked at the page in a real browser"
        by: reviewer                    # reviewer (default), parent or owner; the owner always qualifies
```

`owed approve <node> [--note TEXT] [--block]` (owner: delegated — the main agent approves, optionally with a note, and states it in its report; under `OWED_CONFIRM=owner` explicit terminal confirmation; agents never use `--i-am-owner`; pi `owed_approve`, under the gate with a dialog showing the node, candidate commit, base and number of changed files) approves the open candidate the owner was shown — if the writer submits another candidate before the confirmation lands, nothing is recorded; `--block` records an owner block that a later owner approval clears. Approval is keyed by the candidate's patch, like a review. `owed review`, `owed waive`, `owed approve` and `owed evidence` (pi: the `candidate` parameter) take `--candidate <commit>` (40 hex or a prefix of at least 7): the act records only while that commit is still the node's open candidate, otherwise `candidate changed: you named …, the open candidate is #<seq> <commit12>; nothing recorded`. Delegated owners and reviewers pass the commit they actually read, so a resubmit between reading and acting fails instead of landing on content nobody judged; every command owed suggests (brief, why, driver halts and notifications, review packets) carries it. Under `OWED_CONFIRM=owner` the waive and owner-review confirmations show and pin the candidate as approve's does. `owed evidence <node> <id> --file <path> [--file …] --note TEXT --as reviewer:<id>` (pi `owed_evidence`) records manual evidence: owed hashes every file (sha256 and size) when it records it, and only a principal of the declared role, or the owner, who is not a writer of the node counts. `why --full` and operation receipt cards always show these as manual — `✔ approved (owner:human, tty)`, `✔ evidenced (manual) by reviewer:r1` with each file as `path sha12` and the note — never as measured, and `brief` counts them as `manual`. `owed drive` runs everything else first; when only approve and/or evidence remain it halts (needs the owner — the main agent — for approve, the named role or main agent acting as owner for evidence) with the exact command.

After a merge the same command records a **receipt**, informational evidence of what happened next, for example a publish:

```sh
owed evidence release npm --file pi-owed-0.5.0.tgz --note "0.5.0 published, dist-tag latest"
```

A receipt cites the node's latest merge; files are optional and the note is required. `why --full` and `report` list receipts. Removing `approve` or an evidence item from a plan (or weakening its `by`) is a downgrade only the owner may make.

### Trunk commits made outside owed

Trunk can move without owed: a release commit (version bump, changelog) or an external hotfix already committed to `main` (a detected drift, not the recommended workflow). owed does not trust a moved ref silently: `owed status` then reports `trunk moved outside owed: … ahead of the ledger trunk by N commits`, and every `owed merge` refuses the trunk CAS and names `owed adopt`. After checking those commits, the owner (the main agent, delegated) records them with a note saying what they are:

```sh
owed adopt --note "release 0.2.0"    # owner, delegated (under OWED_CONFIRM=owner: confirm on the terminal; pi owed_adopt asks in the UI)
```

Before adopting (and before asking for confirmation under `OWED_CONFIRM=owner`) the CLI prints the full prior..commit range, the commit count, every changed path and the note, then adopts exactly that commit: if the ref moves after you confirm, the adoption is refused. Without `--commit`, `adopt` takes what `refs/heads/<trunk>` points to, only when it fast-forwards ledger trunk. In 0.24 `--commit X` also accepts an off-ref fast-forward when that ref still equals ledger trunk (hotfix recipe below). As for a merge there is no new debt: owed measures every invariant whose key changed on the adopted commit; if one that held on the ledger trunk fails there, the adoption is refused, the failing observation is recorded, the refusal names the observation that decides each failing invariant (`h1 (obs #3)`; a repeated adopt of the same commit measures nothing new and names the existing observation) and trunk stays unadopted — fix trunk, then adopt again. Invariant debt that already existed does not block. The `adopt` entry records the prior and adopted commits, the commit count, the changed paths and the note; `owed report` and `owed brief` list it once: an owner adoption as an owner decision (the report's trunk adoptions section, not its owner actions), a parent adoption under allowance in its own adoptions section. Under `OWED_CONFIRM=owner` the pi tool `owed_adopt` asks for confirmation with a dialog that lists up to 50 changed paths, one per line; beyond 50 it lists the first 50 and then `… +N more paths; full list: git diff --no-renames --name-only <prior12>..<commit12>`. Open slots are untouched and merge onto the adopted trunk (rebase only on conflicts). Limits: a rewritten or reset trunk cannot be adopted (restore the ref to a descendant of the ledger trunk), and `owed escape` names merges, not adoptions.

For a hotfix while the driver runs, keep the commit off the trunk ref and let owed land it under the merge lock:

```sh
owed adopt --commit <c> --note "<what changed and why it is acceptable>"
```

An in-flight merge finishes first; adopt-pending makes the driver yield new merges. The owner, or a parent with an allowance covering every changed path, retains the same invariant guard. If c is no longer a fast-forward, adopt refuses before measuring and names the new trunk to rebase onto. An off-ref c already contained in ledger trunk instead refuses with `nothing to adopt: <c12> is already contained in the ledger trunk <prior12>` (no rebase needed). Guard failure records observations without landing the hotfix; an external ref move discards stale observations without overwriting it. The checked-out trunk stays attached; dirty or obstructing files refuse safely. CAS advances the ref before the ledger append, as merge does; a crash or append failure in between leaves trunk ahead. Recover with `owed adopt --note "<why>"` **without `--commit`**, under the usual guard. No adoption field or key changes (SPEC §8.3.2).

### Owner allowances: easing the owner pre-authorized

Even with a delegated owner, every downgrade (a review count lowered, writes widened) or out-of-band trunk commit is an owner act that needs a reason and is listed after outcome and Needs you in the brief. An `allow:` block in the plan lets the owner say in advance what the parent may do alone:

```yaml
allow:
  - nodes: ["phaseA-*"]          # node id globs; default ["*"]
    review_count: 0              # the parent may lower review.count down to 0
    review_rank: 1               # ... and review.min_rank down to 1
    writes: ["tests/", "docs/"]  # ... widen writes with prefixes inside these
    checks: ["ui-*"]             # ... remove or weaken node checks with these ids
  - adopt: ["testdata/", "tasks/"]   # the parent may adopt trunk commits that only touch these paths
```

A parent plan update (`owed plan`, `owed_plan`) whose downgrades the rules of the **current** plan (the one before the update) all cover needs no owner confirmation. It is still a downgrade: it is listed in ΔO⁻ and every view labels it `by parent:<id> under allowance (plan #S)`, S being the ledger seq of the plan entry that last changed `allow`, so every easing traces to an owner act. Never covered: removing a node or a dependency, weakening trunk invariants, changing setup/closure (or exec), and changing `allow` itself — any change other than deleting whole rules is the owner-only downgrade `trunk: allow changed`. A parent's refusal lists the downgrades no rule covers, each once; when they only widen writes it adds one line with a ready-to-paste rule for the next plan: `hint: an allow rule {nodes: ["KB4"], writes: ["<new prefixes>"]} in the prior plan would cover this`. `owed brief` lists the downgrades recorded under allowance since `since` with the same label.

Recipe: keep writes strict by default, and at plan time pre-authorize the `writes` prefixes that integration and packaging nodes tend to need (entry files, `package.json`, wiring directories):

```yaml
allow: [{nodes: ["KB*", "A9-*"], writes: ["app/src/entry/", "package.json"]}]
```

In 0.17, owed uses `allow.writes` at measurement time: covered out-of-writes paths are granted without a plan edit, ruling or parent round trip. Add these rules at plan time; change pre-authorized files only when the task needs it.

Optional node `allow_only: [lib/samples.mjs]` caps grants from these rules:
literals match exact paths, globs use syntax 2 (`dir/**` for a directory),
`[]` allows no grants, and own `writes` remain authorized. Current caps also
filter earlier grants and apply at merge recheck. Cap changes carry candidates
and remeasure writes; adding/provably narrowing a cap needs parent authority,
while removal/widening needs the owner and cannot use an allowance.
`owed decide <node> --allow-only p1,p2 --text "<limit>"` (tool `allow_only`)
replaces it alongside writes/resume; `--allow-only ''` sets `[]`. Multi-node
cap decisions refuse mixed changed/unchanged targets. `owed edit` accepts
`allow_only`; refusal hints name that edit. Upgrade every reader to 0.30 before
recording caps, which use `writes_syntax: 3` (SPEC §3.4.1).

`owed init` and `owed plan` warn, without refusing or recording anything, for each node of the new plan with no checks and no evidence obligations: `warning: node <id> has no checks: its acceptance rests on review alone`. The CLI prints the warnings after the result; `--json`, `owed_init` and `owed_plan` return them as `warnings: string[]`. They also warn about a check (or invariant) with `min_tests` that runs its command in a shell loop (`for/while/until … do`, `seq N`): owed counts only the last TAP (`# tests`), jest/vitest (`Tests:`) or pytest (`N passed`) summary of the log, i.e. one run, not the sum (only cargo `test result:` lines add up), so such a loop does not raise the count.

`owed adopt --note TEXT --as parent:<id>` (pi: `owed_adopt` with `as: parent:…`) adopts trunk commits without a prompt when every changed path matches an `adopt` scope and the usual no-new-debt guard passes; the refusal names the first path outside. Views show `adopted by parent:<id> under allowance (plan #S)`.

For a covered candidate, owed atomically records `{kind: "grant", by: "executor:owed", node, attempt, commit, paths, allowance}` before its writes observation. `paths` are sorted exact changed paths, not prefixes; `allowance` is the seq of the genesis/plan entry that last changed `allow`. Replay refuses a wrong principal, stale attempt/commit/allowance, uncovered path, closure match, overlap with another open slot or duplicate grant. Eligible paths receive partial grants even if other paths refuse; writes passes only when no refusals remain. Effective writes (plan scopes plus exact attempt grants) apply to measurement, merge recheck and dispatch overlap; grants survive plan/allow changes but a new attempt starts with none. Uncapped historical/wildcard-free writes keys stay unchanged; syntax-2 wildcard-bearing scopes include `writes_syntax: 2`.

`owed why --full` shows `Granted writes: <paths> (#seq, allowance plan #S)` (first 20, then `… +N more`; JSON `grantedWrites` keeps all grant entries). Report, brief and receipt ΔO⁻ label grants `granted by owed under allowance (plan #S)`. Dispatch packets show owner pre-authorization; reviewer packets ask whether each grant belongs to the node's task and require blocking otherwise. Failed grants leave the writes observation failing with the first reason (`not covered by an allow rule`, `under closure`, `overlaps open node <id>`). For uncovered paths, why/receipt, merge refusal and driver repair/halt text suggest `hint: an allow rule {nodes: ["<id>"], writes: ["<dirs>"]} would let owed grant these` (deduplicated parent directories, trailing `/`; top-level files stay literal). The merge refusal retains this hint even when trunk-red takes precedence. When paths become covered after their writes key failed, the hint instead says to submit a new commit (any change, e.g. an amended commit message) so writes are measured again under the new allow rule; attribution followed by `attest --rerun` on the same key creates a pass/fail conflict, not acceptance. JSON `outOfWrites` adds optional `hint`. A ruling never accepts out-of-writes paths.

Compatibility: owed 0.16 cannot read a ledger containing the new `grant` entry kind. A ledger without grants retains its existing keys and states.

A changed check definition refusal names the changed fields (`run`, `timeout_s`, `reads`, `tests`, `red_expect`). Owed cannot compare commands: the change needs owner authority or a matching check allowance; adding the command as a new check id avoids replacing the existing check. This explanation does not change which edits count as downgrades.

On `owed plan`, both check-less and loop warnings skip nodes already merged in the ledger. Invariant warnings and all `owed init` warnings are unchanged.

## Reference: evidence and debt

### Environment-signature routing

Optional top-level `env_signatures: {match: ['waiting for machine budget'], unless: ['AssertionError|ERR_ASSERTION']}`
marks matching ordinary node-check failures as `environment-suspect` without
changing their verdict, evidence or keys. Regexes are non-empty, at most 300
characters, without flags; `match` is non-empty and `unless` optional. Matching
uses retained log lines after ANSI CSI/CR removal. Red/strength executions,
checks with repeat, invariants and probes are excluded. For an unsatisfied
current-key check, attribution uses the failure's plan before writer repair;
two suspect failures halt without spending repair budget. Fix the environment,
then `owed attest <node> --rerun` and `owed resume <node>`; a resume after that
halt restores ordinary routing. A pass still needs flaky-block owner action.
Effectively waived checks do not trigger the halt; full recovery guidance is
in `owed why <node> --full` (SPEC §3.0a).

### Setup failures and exact-key resolution

A failed counted check or invariant with no test result is a setup failure;
failed names, test results, timeouts and executor errors are excluded. Eligible
single-node merge-tree/trunk invariants get one durable same-key retry; node
checks use attribution. A qualifying next counted pass on the identical
subject/obligation/key records `obs.infra`, resolving the consecutive setup
failures it references without conflict, waiver or debt. Real test failures
still bind. Repeat runs must each satisfy the original specification; batch
observations and trunk probes do not use this pairing (SPEC §7.26).

Current setup refusals/halts name the normalized error and offer `fix it, then
owed decide <node> --remeasure`, not a guessed rebase. Matching setup errors
within thirty minutes on at least two subjects produce one repository notice;
a node's candidate and merge tree count as one subject. Full why retains the
infra evidence; metrics count pairing receipts per obligation. A signature is
diagnostic only: the counted same-key pass, not the error wording, resolves it.

**Upgrade every reader to 0.26 before the first 0.26 writer records `obs.infra`
or a setup-only automatic retry.** Upgrade/restart CLI, drivers and pi sessions
before enabling 0.26 executor measurements: 0.25 refuses the new field, and
can refuse setup-only `auto_remeasure` even without it. See
[SPEC compatibility](docs/SPEC.md#compatibility-020027).

### Trunk invariants already red

After adding or changing an invariant, run `owed attest --trunk [--no-lease]`
(pi: `owed_attest {trunk: true}`, no node). It records executor `refresh`
`{commit, state: StateFacts}` on the ledger trunk, replaces its invariant keys
without moving trunk commit/seq, then measures the changed keys as trunk
observations. It is abortable and leased; an interrupted refresh resumes on
retry. No changed keys means `Nothing to refresh on trunk` and no new entries.
JSON returns `refresh?`, `changed`, `observations`, `superseded`, `failed`,
`missing`, `lease?`; newly recorded failures exit 1 (including known_red),
otherwise complete results exit 0 and missing results exit 4. Merge does this
before measuring, retaining refresh and
trunk observations on refusal; the driver refreshes on an otherwise quiet pass.

A merge failing only named tests already failed on recorded trunk can proceed
without defer only when both failed-name lists are complete. Truncated lists
refuse with `failed names truncated; cannot prove the failure is old`.
The executor's structured `execution: {completed, countOK}` (also on repeat
runs), not display notes, proves the merge failure is test-only; old observations
without it cannot provide that proof. Timeouts, errors, unnamed failures,
zero/unknown counts, `min_tests` failures and any new failed name still refuse. New names read
`invariant <id> new debt: new failures <new> (trunk already failed: <old>)`;
unknown names keep the ordinary measured-pass/defer refusal. Fix-node-owned
known-red names are not rescued. Owner defers and adopt keep their rules.
The new trunk remains D with discharger `parent`, detail `trunk-red: inv:<id>
already failed on trunk before <node> (<names>); merge #<seq>`.

`owed status` and `owed why trunk` explain `inv:<id> red on trunk since
<merge/refresh #seq> (<names>); not caused by any open node`, with options to
assign a fix node, list `known_red` names with that fix node via `owed edit
--invariant <id> ...`, or run `owed sweep --commit <trunk>` to find the culprit.
Status JSON may add `trunkRed: [{obligation, key, text}]`. The driver wakes the
parent once per invariant/key and does not halt writers for this debt. Its
`inv:<id>` notice carries `invariantRed: {obligation, key}`, separate from drift;
pi delivery revalidates that the current trunk item on that key is still red.
Before refresh, status says `inv:<id> not measured on trunk yet — owed attest --trunk`.
Compatibility: owed 0.14 refuses the new `refresh` entry and unknown obs
`execution` field with code `version`; upgrade CLI, extension and drivers
together and restart pi. Historical ledgers without the new fields retain their
0.14 replay (apart from the actionable missing-key text).

When a node check fails on the merge tree, `owed merge` first measures that same check on current trunk under the same lease, setup and execution configuration. Its diagnostic observation has `probe: "trunk"`, subject = node, commit/base = trunk and its own trunk check key; the same key on unchanged trunk is reused. Probes never satisfy or block obligations and invariants get no probes. A probe naming a missing candidate-added file absent from trunk, including CJS/ESM `Cannot find module '<path>'` diagnostics (not bare names without `/`), instead records `error` (`probe not applicable`), never trunk-red; the merge check still refuses. When neither side names failed tests, different failure lines after checkout-path and whitespace normalization produce `error` with `probe inconclusive: trunk fails differently (<line>)`; equal/missing lines or unreadable logs keep the prior classification. Otherwise, if the probe fails with every merge failure name among its names (or neither result has names), the refusal begins `trunk-red: check:X fails on trunk <short> without <node> (<names>)` and says the candidate is not shown to be the cause. `status`/`why` mark the item trunk-red with parent as discharger and both observation sequences. In 0.17, a candidate whose active binding blocks are all trunk-red waits instead: no driver halt, writer follow-up, reviewer launch or attest (questions still notify). Mixed blocks retain the existing behavior. One repository notice per current trunk/check/sorted-failed-name state lists the waiting nodes and trunk fix/adopt, optional sweep, or owner-waiver options; status and brief share one `Needs you` line and show `waiting: trunk-red (check:X on trunk <trunk12>)` in the node's progress phase. Queued pi notices recompute their waiting list at delivery. Moving trunk automatically resumes the existing measurement/rebase route without a resume entry. Deduplication uses the existing per-process once set: restart may print one repository notice again, never a parked-node halt. This adds no ledger fields and weakens no merge gate. Fix trunk with a fixing node, use a configured `owed sweep --commit <trunk>` for localization and a confirmed automatic escape, or knowingly accept the merge observation with `owed waive <node> check:X --accept-risk <merge-tree obs seq> --reason "<why the risk is acceptable>"` (existing active-block waivers reach merge keys). A failure cleared by attribution can still be accepted when its key equals the current merge key; that waiver binds only that key. Full why shows an additional `mergeChecks` item and `status` a parent pending item when an accepted candidate still has a reused trunk-red merge failure. Passing probes or differing names keep the ordinary refusal; moving trunk recomputes classification with a current-trunk probe, while failures on an unchanged merge check key remain valid. Compatibility: owed 0.13 refuses `obs.probe` with code `version`; owed 0.12 and older ignore the field and cannot safely interpret probes. Existing histories without probes keep their replayed states and keys; use 0.14 for the new merge-key waiver scope.

Merge refusals (0.16.2) also show the latest pass of a failing invariant on the current trunk: `inv:<id>: pass on trunk <trunk12> (#<seq>) → fail on merge tree <commit12> (#<seq>)`. This appears once per obligation, including anonymous failures, before intermittent and fix-candidate hints; if no such pass exists it is omitted. The node's current candidate adds `; node diff touches <p1>, <p2>, <p3> (+<N> more)` when it has changed paths. Merge refusals, driver halts, `why` merge-block hints and `Merge checks:` share the delta. This changes only text; 0.16.0, 0.16.1 and 0.16.2 share ledger fields, replay and keys.

Merge refusals (0.20.1) say `known intermittent` only when one key has both pass and failure evidence for that test; if the current failure has a signature, the failing observation must match it. A same-signature trunk failure alone is not intermittent. Matching latest current-key trunk failures take precedence as `<name>: trunk red since #S (after merge #M NODE); fix trunk before retrying` (or `after adopt #A`): S begins the uninterrupted same-signature run, broken by a pass, missing name or changed signature. Provenance is the latest merge/adopt at or before S, omitted if absent. This lookup scans complete matching subject/obligation/run-definition trunk history; generic history hints keep the last-5000-entry bound. Different known errors say `same test failed on older trees (different error)`. The node's own other trees are not independent evidence. Generic history hints show at most three sequences newest first. For names of at least six characters, an unmerged node with an open slot, accepted candidate or ready phase whose title, brief, check command or tests list contains the name verbatim adds `fix candidate: <node> (<phase>) — owed decide <refused> --after <node> --text "<wait for fix>"`. CLI merge refusals, driver merge-refused halts and `why` block lines carry these hints; `why` also shows hinted current merge-key failures, including invariants, under `Merge checks:`. Anonymous failures add neither named-test hint; missing signatures do not justify a different-error claim. An anonymous merge-check failure includes its escaped last non-empty output line (160 characters) in the refusal and newly marked need/notice details; old unmarked notes and invariant diagnostics keep their existing rendering. These hints are advisory and change no gate or key; 0.20 signature fields require upgrading readers together.

`owed status` now starts with `owed: <M> merged · <R> in progress · <A> need you · trunk <name> <short> <✔|✘> invariants (<ok>/<n>)`. `Needs you (<A>):` lists current parent/owner actions as `<node>: <plain reason> → <command>` (or `Needs you: none`); a trunk-red invariant from status `trunkRed` instead has one `trunk: <curated red-on-trunk text>` line with its options, and its Debt line is unchanged; ready nodes need manual dispatch only when no driver runs. `In progress (<R>):` lists open work as writing, measuring, reviewing, waiting for dependencies, held, or accepted (merge pending), with its age. `Debt:` appears for trunk-red invariants, active known-red/quarantine tests, owner defers that still bind the current merge invariant key and waivers of open nodes. The last line is `Details: owed status --full · owed why <node>`. Empty progress/debt sections are omitted. `owed status --full` (pi `owed_status {full:true}`) keeps the 0.14 evidence and pending queues, plus new invariant debt lines; historical confirmation, superseded-block and carried-candidate audit lines live there. CLI JSON retains every existing field; `summary` adds merged totals, current actions, phases/ages and debt. Pi tool content is bounded to 48 KiB and details to 8 KiB; follow the read-only CLI pointer after cut text or use CLI `--json` for full data. `report --since <sequence-or-ISO-time>` summarizes merges, E/W/D changes, rulings, downgrades, and owner decisions.

Pi act replies for `dispatch`, `plan`, `edit`, `amend`, `defer`, `abandon` and `resume` use a brief status (0.16.2): the same outcome line, current `Needs you (<A>):` items and commands when non-empty, then `Details: owed status · owed why <node>`. They omit the progress and debt lists. Dispatch keeps one complete packet in content; rendered subagents arguments refer to it, and callers set `task` to that complete packet. Tool details retain launch metadata without duplicating the task; plan/edit/amend keep their act lines and warnings; defer shows the recorded entry; abandon/resume show the entry and node phase, with resume's waits-for text retained. In 0.23, rule returns only the concise delivery receipt and warning lines described in SPEC §9.3, without an entry rendering or brief. Structured tool results are compact summaries under the bounds below. Use `owed status` for the full progress/debt lists, `owed why <node> --full` for an evidence receipt and `owed report` for the report. The CLI versions of these acts currently append no full status, so their existing outputs stay unchanged; CLI `init` and pi `adopt` retain their existing status output. Status, report and `/owed` retain their existing detailed views; explicit why uses the outstanding-only card described below, while `--full` retains all evidence.

`owed status --full` (pi `owed_status {full:true}`) also shows `Merge queue: a, b, c` (`none` when empty), and status JSON adds `mergeQueue: string[]`. In 0.20, accepted open attempts merge by unique unfinished transitive dependent count descending, continuous `nodes.<id>.acceptedSince` ascending, then id. This sequence records when the current candidate became continuously accepted; losing acceptance or replacing the candidate with a new submit resets it. In 0.20.1, ordinary/full status show `merge waiting for driver-internal job (catalog merge, since 09:12); 2 merges ahead`, selecting a running merge before other measurements. `mergeWaiting[id].job` names that internal job; `.ahead` is the current zero-based merge queue position, counting accepted predecessors even while merging. Reads recompute positions and omit ahead/count text for nodes outside the queue, even with stale cached values. Lease waits retain their existing reason/since with ahead added only for queued nodes. The internal time is the job's start displayed in the reader's local zone; `since` remains the continuous candidate/attempt wait start. Old waiting caches without job remain readable; brief keeps its existing scope. These fields are runtime cache, never ledger evidence. `owed resume X --after Y` (also list waits and `owed_resume`) is a dependency wait, not a priority override. The driver's single merge slot takes the first eligible merge action; other actions retain their existing order and every gate still applies. Higher-weight accepted nodes can overtake lower-weight ones; background trunk attest and sweeps yield to merge-ready work. This ordering is derived, with no new ledger kind or key; 0.20 receipt fields still require upgrading readers together.

`owed report --metrics [--since <seq|ISO>] [--until <seq|ISO>] [--json]` (0.15) measures merged nodes, interruptions (driver halts plus parent/owner answer rulings) and interruptions per merged node; submit-to-merge median/p90/max and first-dispatch-to-merge median/p90; first-pass acceptance (attempt 1, no block on any candidate); and repairs per merged node. Repairs sum writer submits after the first separately for each attempt, including abandoned attempts, excluding executor carry submits. `since` is exclusive and `until` inclusive; merges and interruptions count by their own entries, while earlier history supplies timing and classification. An ending entry can decide a halt: between the halt and the next resume/submit/merge/abandon/halt, a parent/owner rule naming the node or `*`, answer, waive, defer, abandon, hold, approval, evidence, owner review, or plan change to that node's spec/deps makes it `decision`; otherwise it is `no-decision`. Entries after `until` cannot decide a halt. The short text block lists the top five reasons per class, with digits and ids normalized. JSON returns all numeric summaries (durations in milliseconds, ratios as fractions, unavailable values `null`), per-merge attempts/repairs and per-halt classes, ending sequences and decision sequences; SPEC §9 defines each field. It reads only the ledger and recorded plan blobs, preserves old ledger states and keys, and records nothing. `--until` requires `--metrics`; ordinary `report` output is unchanged.

In 0.17, `parentActs.perMergedNode` is the gate metric for parent coordination cost, not the partial `interruptions.perMergedNode`. JSON adds `parentActs: {total, perMergedNode, byClass}` and `grants: {total, perMergedNode}`; all old fields retain their values. Each owner/parent entry in the window counts once, except `parent:drive` and non-decision transport kinds `dispatch`, `launch`, `send`; executor/writer/reviewer principals do not count. Classes use first-match order: `writes` (a plan with non-empty detected downgrades consisting only of writes widenings, or an amend ruling), `answer`, `trunk` (adopt, known_red-only invariant plan change, or resume after the node's last recorded halt starts `merge refused: trunk-red`), `resume`, `rule`, `plan`, `review` (owner reviews), `waive`, `defer`, `evidence`, `abandon`, `approve`, `other`. Genesis, notes and other unclassified acts count as `other`; owner approvals currently use review entries and therefore count as `review` (the `approve` class is zero). Amend rulings are recognized by the existing `ops.amend` text marker `writes of <node> widened by plan #<seq>: <paths>. Limit: <note>`; hand-written rulings matching this marker also count as `writes`. An amend counts its plan and ruling separately. Plan classification compares recorded blobs, not claimed downgrade text, regardless of allowance coverage. `byClass` includes zero counts for every class. `grants` counts entries whose kind is `grant` (zero on older ledgers); both rates divide by merges in the same window, or are `null` with none. Earlier history supplies plan and last-halt context, with nothing after `until` visible. Text leads with parent acts per merged node and the top five nonzero classes (count descending, class name for ties), shows grants, and labels the old line `driver halts + answers per merged node (partial)`. These metrics add no ledger fields or acceptance changes.

In 0.16, metrics bounds also accept date-only `YYYY-MM-DD` (UTC midnight).
Halt normalization preserves plain-word node ids in ordinary prose: ids matching
`/^[a-z]+$/` become `<id>` only at the reason start before `:`, before `/`, after
`node ` or `--after `, or as the argument of `owed <verb> `; other ids keep the
previous behavior. Thus unrelated `merge refused` and `review refused` reasons
no longer collapse just because nodes have those names.

When trunk drift or a merge-build conflict prevents defer rechecking, default
status and brief retain the open candidate's current-attempt recorded debt as
`<node>/inv:<id>: owner defer (not rechecked: trunk moved)` or
`(not rechecked: merge conflicts)`. Their JSON adds a non-empty `deferred` array
of `{seq, node, id, key, unverified?}`, with `unverified: 'drift' | 'conflict'`
for those records. Retired nodes/invariants and older attempts are excluded;
once the current merge key can be queried, stale defers disappear as before.
These 0.16 presentation changes add no ledger entry kinds or fields, change no
keys or gates, and keep 0.15/0.16 ledger replay compatible.

`owed brief [--since <sequence-or-ISO-time>] [--json]` starts with the same outcome line and **Needs you** section as status. It retains its other morning-view sections: **Merged** (per merged node: measured and waived obligation counts, reviewed obligations, untested changes, and reviewers; a waived obligation is never counted as measured), **Rejected or blocked** (active blocks with the node, obligation, failing observation sequence, and how to clear them), **In progress** (dispatched and submitted nodes with their age), and a total line (merged / accepted-unmerged / blocked / ready, plus nodes waiting on dependencies). `--since` limits only the Merged section; the other sections always show the current state. `--json` returns the structured view.

Plans are versioned through `owed plan <file>` / `owed_plan`; `owed plan <file> --rev <commit-ish>` reads the file from a commit (for example the plan kept in trunk) and the plan entry records that commit and path. Parents may strengthen or otherwise update a plan; weakening obligations requires an owner decision and remains visible as a downgrade. Owner operations are delegated by default (pi `owner:pi`, CLI `owner:cli`, channel `delegated`, no dialog). Only `OWED_CONFIRM=owner` enables pi/terminal confirmation; without that UI/TTY the gated decision refuses. `--i-am-owner` is a historical weak-confirmation channel, not an agent workflow: agents never use it.

### Known-red invariant debt (0.15)

Instead of hiding failures by changing a suite's run command, an invariant may
set `known_red: [{test: "exact name from obs.failed", fix: repair-node}]`:
at most 20 unique names, with each fix node in the same plan. Exact names are
case-sensitive, not patterns. The field changes no acceptance key. Adding an
entry or reassigning its fix is an owner-only plan downgrade (no `allow` rule
covers it in 0.15); removing entries is free. For example:

```sh
owed edit --invariant unit --set 'known_red=[{test: "old failure", fix: repair}]' --as owner:pi --note "Assign existing trunk debt to repair"
```

A failure consisting only of active listed failing tests is **W / ⚠**, satisfied
for merging but never a measured pass. Extra names, timeout, error, count failure
and pass/fail conflicts stay ordinary debt. Entries are active until their fix
node merges; that node cannot use its own list for its merge-result measurement,
and still-failing owned names refuse its merge even if trunk already failed them.
After the fix merges its entries lapse and recurrence is ordinary red.

`status`, `report` and `brief` always list active known-red debt with exact names,
fix nodes and current plan seq; full status also lists removable lapsed entries.
Item details read `inv:<id> known red: <names> (fix: <nodes>; plan #<seq>)`.
JSON views add optional `knownRed: [{invariant, entries: [{test, fix}], plan}]`;
status additionally exposes `lapsedKnownRed` in that shape. Clear the whole list
with `owed edit --invariant unit --unset known_red --note "Remove repaired debt"`,
or replace it with the remaining active entries. Existing ledgers without lists
keep their states, keys and JSON fields. Compatibility: owed 0.14 and older
ignore `known_red` and treat those tests as ordinary failures (stricter), so mixed
versions may halt merges that 0.15 accepts; upgrade CLI, extension and drivers
together.

### North-star metric: escapes

Acceptance is only as good as what it lets through. When a defect is found after a node was merged, record it against that merge:

```sh
owed escape greeting --merge 12 --class weak --note "check passed for any greeting" --evidence "issue 7"
```

`--class` names how it escaped: `missing` (② an obligation was missing), `false-pass` (①a a false affirmative observation), `reuse` (①b unsound evidence reuse), `weak` (①c a weak oracle) or `waiver` (③ an owner waiver let it through). The merge must be a merge of that node.

To measure the escape rate rather than wait for accidents, the owner can plant decoys: nodes whose work deliberately carries a known defect. Before dispatching them, write `{"nonce": "<at least 16 random characters>", "decoys": [{"node": "...", "defect": "..."}]}` to a file outside the repository, then commit to it without revealing it:

```sh
owed decoy digest decoys.json            # prints the sha256 to commit; writes nothing
owed decoy commit <digest>               # owner; before any listed node is dispatched
owed decoy reveal decoys.json            # owner; later, when the outcome should count
```

A decoy is **caught** if its node received an execution failure or a review block before any merge, or if a merge of it observed a failure (every observation appended by `owed merge <node>` records `merging: <node>`) on an invariant or check that was not already failing on trunk — pre-existing trunk debt, deferred or not, never counts — whether the merge was refused or later went through after an owner deferral. It is **escaped** if it merged without any of these, and **pending** otherwise. `owed report` ends with an Escapes section: counts by class, decoy outcomes and the escape rate, escaped / (caught + escaped).

### Advisory escape sweeps (0.13; scheduled and automatic escapes in 0.24)

A plan can run a broader suite after work settles, or on a schedule:

```yaml
sweep:
  run: node --test --test-reporter=tap 'test/**/*.test.ts'
  timeout_s: 900                 # default 600
  reads: ["app/**", "test/**"]   # optional description; no acceptance key
  every: {merges: 10, minutes: 30} # optional 0.24; either threshold makes it due
```

`owed sweep [--commit C] [--due]` (pi: `owed_sweep {commit?, due?, lease?, cwd?}`) measures a fresh detached tree of trunk by default, or the named commit. It uses the shared machine lease, setup and execution wrapper/environment; `--no-lease`, tool `lease: false`, or plan `lease: false` skips acquisition. It buffers the head and probes, recording their informational `sweep` entries atomically at completion, with the full commit, sweep definition key (command/timeout, setup and exec), `verdict: pass|fail|error`, parsed counts when available, log blob digest and up to 50 failed test names (`failed`). It exits 0 for pass, 1 for fail/error; acquisition busy exits 75. Sweeps never change acceptance keys or merge obligations.

With `sweep.every`, continuously running drivers, staying or not, start due sweeps under the shared lease with no waiting. Sweeps serialize on their own operation lock, consume no node measurement slot and continue alongside node work. Driver stop or a recorded sweep-definition/`every` change (including removing `every`) cancels an in-flight scheduled sweep without verdict/interruption; an atomic append already begun completes. Activity says `sweep aborted: plan changed`. Scheduled holds use `--yield`: a yield aborts with no record and retries later like busy. Replay and the first tree checkout precede leasing; acquisition starts immediately before the first setup/check command and lasts through command/tree cleanup. Without `every`, only staying idle drivers schedule sweeps: ready work preempts them in the same pass, cleanup leaves no verdict for the interrupted run, and completed heads are skipped across restarts. Busy acquisition retries later. `drive --once` and the pi pass never start a sweep; when due they print `sweep due; --once does not start it (run owed sweep --due or a background driver)` or emit runtime JSON `sweep-due`.

`--due` requires `sweep.every`; a not-due call records nothing and exits 0 with `sweep not due: next after N merges or at HH:MM` (absent threshold clauses omitted, local time). Regular sweeps force measurement. Completed head entries, not bisect samples, reset the schedule. Merge counting uses the first-parent range since an ancestor head sweep, so merges during measurement remain eligible; minutes use its timestamp. Before the first sweep, merges start at initialization and minutes at driver start (initialization for standalone cron). Scheduling changes no sweep definition key.

Head failures are rerun once; `flaky at head`, a measurement error or no green ancestor reports only. Bisect searches first-parent owed merges under the current definition, requiring two failed head samples, two failed culprit samples and a passing predecessor. Each commit runs at most twice, with a total budget of `ceil(log2(n))+4`; disagreement or exhausted confirmation budget reports `inconsistent (flaky)` without blaming a merge. A confirmed boundary and an automatic `missing` escape by `executor:owed` append atomically unless a prior escape cites the same merge and sorted recorded sweep names (including canonical manual evidence). A changed definition during measurement authorizes no stale escape. Each new escape gives one notice naming the fix and uncovered test files, or `add the test to an invariant`; hints are diagnostic, not proof of coverage. Dedupe uses all recorded names, limited by the protocol to fifty, though the notice shows five. Sweeps never block a merge or blame an adoption; an adopted failing tip whose last owed merge passes names no culprit. Status keeps `trunk: sweep red since #S (NAMES)` until a passing head sweep of that trunk or a descendant, not a bisect sample or older ancestor.

Each merge also reports **Unguarded paths**: changed paths matched by no invariant `reads`. Reports collapse their parent directories to globs such as `app/bundles/**`, dropping globs subsumed by shorter reported directories; root files remain literal. For `app/bundles/foo/a.ts` and `app/bundles/bar/b.ts`, it reports `app/bundles/foo/**` and `app/bundles/bar/**`, without widening to the common ancestor `app/bundles/**`. The CLI/tool merge output and driver merge report include this list, and `owed brief` lists the last 10 merges using the plan in force at each merge. This is advisory coverage information. Compatibility: owed before 0.13 refuses the `sweep` entry kind with code `version`. In 0.24 the optional `sweep.boundary` and `escape.sweep` fields require upgraded readers; no new entry kind is added.

## Reference: environment and installation

### Measurement cost diagnostics

Use `owed report --cost [--since <seq|ISO>] [--json]` to see checks/invariants
ordered by machine time: executions, total/median/p90 duration, failures,
setup failures separately and lease wait. Invariants also show measured-versus-
recorded merges and the top five reads prefixes that changed measured trunk
keys. Same-key retries add cost, not invalidations; repeat observations count
once, and successful batch measurements count for every member merge.
Dominant-prefix advice suggests narrowing reads (SPEC §9.7).

Plan lint warns for `**`/at least 90% repository reads, and for checks reading
closure files whose base version is used. Default status warns when the latest
trunk pass reaches 80% of an invariant's timeout; plan lint repeats it with
`warning: `. These are diagnostics, not gates or debt. Git commits must remain
available for prefix attribution; command/closure changes are not assigned to
reads prefixes. Cost is CLI-only, exclusive with metrics/counterfactual;
`--until` remains metrics-only and `--since` is exclusive.

### Install and tool profiles

The default `core` profile registers every owed tool but declares only `owed_status`, `owed_why`, `owed_decide`, `owed_drive`, `owed_start`, `owed_submit` and `owed_review` directly. Every other tool is deferred at load. Use `tool_search` when a tool is not declared, or the `owed <command>` CLI (`owed help` lists commands/flags).

At `session_start`, owed follows the host's MCP discovery precedent: when exposure is supported and `tool_search` declares `reachesTools`, add that search to the active set if inactive. If search is unavailable or cannot activate, re-register deferred owed tools as direct; older hosts ignoring exposure treat them as direct already. Owed never removes active tools. `OWED_TOOLS=all` declares all tools directly and opts out of search activation. Manually disabling search later can hide deferred tools until the next session start; hosts without session hooks cannot run this fallback repair. At `session_start` and every `agent_start`, owed also restores missing registered direct tools without removing active tools; unavailable or throwing host APIs are left alone. Deferred tool descriptions and parent-facing tool-name hints include the exact CLI alternative. SPEC §11 lists every registered tool and its parameters.

Requires Node.js 22.19 or later, Git with `merge-tree --write-tree`, and Bash. For pi:

```sh
pi install npm:pi-owed
ln -sf "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin/owed" ~/.local/bin/owed
```

`pi install npm:pi-owed` does not put `owed` on PATH, but agents, scripts and owed's printed commands call `owed`; use this link with `~/.local/bin` on PATH, or `npm i -g pi-owed` at the same version as the pi package.

For the standalone CLI:

```sh
npm i -g pi-owed
```

### Bounded pi tool results

Every owed pi tool, including `owed_status`, full views, dry runs, errors and
refusals, limits content to 48 KiB UTF-8 and serialized details to 8 KiB.
Details contain identifiers, counts and short metadata samples; use CLI
`--json` for scripts needing everything. Text that fits is unchanged. Cut text
keeps the outcome first and ends with an omitted-byte count and a read-only
CLI pointer, such as `owed status --full` or `owed why <node> --full`, when a
valid target is available. Run that command in the tool's target repository.
Completed mutations point to current receipts; do not replay a mutation to
retrieve omitted output.

Successful `owed_dispatch` content starts with its complete packet, submit
instruction and args byte-exact, exempt from the content limit. Only its
trailing status is bounded. All dispatch details remain bounded; the complete
packet is content-only. CLI text and `--json` are unchanged (SPEC §11).

Reload pi after installing. `/owed` shows status; `/owed why <node>` explains an acceptance decision. Tools include the core set above, plus `owed_report`, `owed_brief`, `owed_verify`, `owed_dispatch`, `owed_rebase`, `owed_attest`, `owed_merge`, `owed_adopt`, `owed_abandon`, `owed_gc`, `owed_rule`, `owed_answer`, `owed_plan`, `owed_waive`, `owed_defer`, `owed_escape`, `owed_decoy`, `owed_edit`, `owed_amend`, `owed_approve`, `owed_evidence`, `owed_sweep`, `owed_resume` and `owed_init`; each accepts an absolute `cwd` inside the target repository, so a session started elsewhere can drive it (docs/SPEC.md §11 lists the parameters). Owner confirmation dialogs show free text (notes, reasons, rulings, evidence) after the Repository and Identity lines, escaped onto one line. Those dialogs appear only under `OWED_CONFIRM=owner`, and wait at most `OWED_CONFIRM_TIMEOUT` seconds (default 120, `0` = no limit): a timeout records nothing (`Owner confirmation not given within N s; nothing was recorded.`). By default owner tools are delegated to the main agent (`owner:pi`, channel `delegated`, no dialog); `owed_plan` takes `note`, which a delegated downgrade requires. In a pi-durable-subagents call (`DSA_CALL`/`DSA_EXEC` set) owed refuses owner and parent acts in tools and CLI alike, and refuses a review or evidence on a node from inside that node's open slot worktree (run reviews from the repository root) — accident rails, not security boundaries. `parent:drive` is the driver's identity only: `--as parent:drive` / `as: "parent:drive"` is refused, and the ledger refuses entries by it other than dispatch, launch, send, halt, rebase and abandon of its own stale never-launched slot. The `owed` skill describes the full agent workflow. A subagents/dsa runner is a separate integration: dispatch returns a ready-to-use call specification with `agent: worker`, the slot worktree as `cwd`, and `isolation: none`.

### Execution environment: env and wrapper

A plan may give every process owed starts in a materialized tree — `setup`, checks, red runs, strength runs, invariants and attribution reruns — extra environment variables and a wrapper:

```yaml
exec:
  env: { CARGO_TARGET_DIR: /abs/shared/target }   # strings, used verbatim (no $VAR expansion); not CI or OWED; a new plan may not set OWED_TREE
  wrap: ["/abs/tmp/qa/heavy.sh"]                   # legacy argv prefix; string templates are also supported
```

For a remote runner, use a string template:

```yaml
exec:
  wrap: ssh runner /opt/project/run-check {cwd} {timeout} {cmd}
  wrap_grace_s: 30
```

Only `{cwd}`, `{timeout}` and required `{cmd}` are allowed. Each substitution
is already one POSIX single-quoted word; do not quote placeholders again.
The template runs via `bash -lc` with the same environment as local checks.
Provision/mirror the prepared directory yourself. Propagate termination and
bound remote execution: killing a local SSH/container client cannot prove that
remote work stopped. Pass output through without adding TAP/cargo/`owed-counts`
protocol text. `wrap_grace_s` is a nonnegative integer, default 30; template
measurement evidence freezes at `timeout_s`, remains timed out even if the
wrapper finishes during grace, and the local group is killed by timeout plus
grace. Legacy argv wrappers keep their timeout behavior. The literal template,
not substituted paths or grace, enters measurement keys; absent templates
preserve existing keys. String templates/grace require 0.22 readers.

#### Timeout diagnostics (0.20.1)

Optional `on_timeout: "<shell command>"` on a check or invariant runs once
before the timed-out measurement group is killed, with a separate 30-second
limit and the same tree, environment and wrapper. Use the existing edit API,
e.g. `owed edit A --set 'checks.C.on_timeout=ps -ef'` or
`owed edit --invariant I --set 'on_timeout=ps -ef'`. No new CLI flag is added;
diagnostic-only edits change no check/invariant key.

Measurement output freezes at the timeout boundary. Local/argv measurement
groups stop then; template wrappers retain their shutdown grace. The last 256 KiB of
stdout/stderr, `timeout after Ns`, diagnostic output (last 256 KiB) and a
best-effort pre-kill process tree are kept in the blob. The note keeps the
timeout plus the last three measurement output lines. Counts, names and
signatures use frozen measurement output, excluding hook output even when it
looks like a counts protocol; hook failure or its exit code cannot change the
error verdict or prevent cleanup. The snapshot includes pid, ppid, state,
wchan, elapsed and args (200 characters), bounded to 4 MiB ps input, 1000 rows
and two seconds. Unavailable ps is recorded; macOS is best effort, not validated
by the Linux behavioral coverage.

The environment is owed's own (without `NODE_TEST_CONTEXT` and any `DSA_*` variable but `DSA_HOME`, so owed commands inside a check are not refused as subagent acts) plus `exec.env`, then `CI=1 OWED=1 OWED_TREE=<absolute tree path>`. The wrapper runs in the materialized tree with that environment, in the same process group, under the timeout/grace rules above and existing abort handling: owed ends the whole group, wrapper included, and on Linux scans for descendants proven to carry the fresh `OWED_RUN` token in readable `/proc/<pid>/environ` (TERM/grace/KILL, five-second scan-inclusive bound) before releasing the lease. Untagged/unreadable processes are not individually signalled or waited for; leaving the group and clearing the token or making environ unreadable escapes containment. Normal exits and other-platform group cleanup remain unchanged; `OWED_RUN` enters no key. **Wrapper contract:** for argv arrays, run the trailing argv; for templates, run the substituted command, to completion in the given directory and environment, pass stdout and stderr through, and exit with the command's exit code. When the wrapper cannot run the command (transport, mirror or lease failure) it must exit **126 or 127**: owed reads those as "could not run" (a red run is then `error`), while other non-zero codes count as test failures — red passes unless the check sets `red_expect` — except the strict exit-75 lease diagnostics described above. Use `red_expect` on red checks run through a wrapper. A relative `wrap[0]` containing a slash resolves against the materialized tree, not the main worktree; use absolute paths (a bare name is looked up in `PATH`). `exec.env`, `exec.wrap` and an explicitly set `exec.touch` are part of every check, red, strength and invariant key, so changing them means fresh evidence (`parallel` and `trees` are not, see below); `exec: {}` is the same as no block. Because a wrapper can weaken every check (`wrap: ["true"]` passes everything), changing `env`, `wrap` or `touch` is owner-only and shows as a downgrade in ΔO⁻, like `setup`: set it once. `owed why <node> --full` prints `Exec: wrap <argv> · env <NAMES>` (names, never values).

#### Faster merges: `exec.parallel` and `exec.trees` (0.9)

```yaml
exec:
  parallel: 4      # jobs one merge / adopt / genesis attest measures at once (default 1)
  trees: reuse     # stable measurement worktrees instead of a fresh /tmp tree per run (default fresh)
  touch: reset     # 0.11: reset (default) | always | never; tracked mtimes in reused trees
```

`parallel` runs a merge's invariant and merge-result checks side by side instead of one after another; observations are still recorded in job order, and an abort kills every running job. Node attests stay serial (the driver already attests nodes in parallel). `trees: reuse` measures each check in a stable detached worktree `<git common dir>/owed/trees/<kind>-<check id>-<k>`, leased by a pid lock file so concurrent runs of one check get different trees. Before each run owed does `git checkout --detach --force <commit>` and `git clean -ffdx`, then empties each submodule (gitlink) directory inside the tree, never running `git submodule` or touching your config, so your own submodules stay initialized: the content equals a fresh tree (no untracked or ignored file survives), while the path stays stable. With `touch: reset` (the default), owed updates every tracked file's mtime to now when the tree changes commit; `always` updates them before every reused measurement, and `never` keeps Git's mtime behavior. Symlinks are touched without following their targets; gitlink directories stay empty. `touch` has no effect on fresh trees. A build cache outside the tree can persist between runs. A cache shared by several trees (a common `CARGO_TARGET_DIR`) can link artifacts from another checkout: use a per-tree directory. A shared-cache alternative requires a build-dir lock plus a last-checkout marker, touching tracked files under that lock when the checkout changes; `touch: always` alone does not serialize concurrent users. Every setup, wrapper and measurement receives `OWED_TREE` as the absolute materialized path, including fresh fallback trees; for example, export `CARGO_TARGET_DIR="$OWED_TREE/../target-$(basename "$OWED_TREE")"` in the command that builds (values in `exec.env` are not expanded). A tree that cannot be prepared falls back to a fresh one with a note in the log. Neither `parallel` nor `trees` is part of any key: changing them re-measures nothing, invalidates no candidate and needs no owner. `owed gc` removes free reuse trees once the plan stops reusing, their check is gone, or (0.11) their check belongs only to merged or abandoned nodes (`--dry-run` lists them). Parallel cargo builds sharing one `CARGO_TARGET_DIR` serialize on cargo's lock: give heavy invariants separate target dirs, or accept that they wait for each other.

Test counts come from TAP/node:test, cargo, pytest and jest/vitest summary lines. Pytest accepts only terminal summaries bounded by `=` runs or ending in `in <seconds>s` (optionally ` (<h:mm:ss>)`), with a body of comma-separated `<n> <word>` items (`passed`, `failed`, `skipped`, `error`, `errors`, `xfailed`, `xpassed`, `deselected`, `warning`, `warnings`, `rerun`); warnings, reruns and deselected do not count as tests. Zero-test forms are line-anchored (optional leading whitespace and `=` runs): pytest `no tests ran` (optionally `in <seconds>s`) or `collected 0 items`, and jest `No tests found` at the start of a line, not free-text mentions. A log with both cargo `test result:` lines and TAP (one check running `cargo test && node --test --test-reporter=tap`) sums them to one `mixed` count, which `min_tests` checks. A non-red check that exits non-zero with no recognizable count or zero tests (a wrong cargo package name, a missing script) is `fail`, and its note carries the last 5 output lines (shown under the item in `owed why` and in the driver's repair message); exit 126/127 with no count (the command never ran) and an exit-0 run with an unknown count under `min_tests` are `error`. cargo summaries count only at column 0, so a `# test result: …` line inside TAP is not a cargo count.

**Repeated measurements (0.13, RC1).** Checks and invariants may set
`repeat: {runs: 3, need: 2}` (integers `1 <= need <= runs <= 9`; need defaults
to runs). This is part of their key and is not allowed on red or mutants checks.
Commands run sequentially in the same prepared tree; stop when the required
passes are reached or unreachable. Counts and `min_tests` apply per run, never
to the sum; execution/environment errors stop with `error`, not failed votes.
The observation's `runs` retains each verdict, exit, counts, duration and log
digest; `noisy: true` marks disagreeing runs. `why` and driver measurement
reports show e.g. `noisy (2/3 passed)`. This also works at merge time:

```yaml
invariants:
  - id: timing
    run: ./check-timing.sh
    min_tests: 1
    repeat: {runs: 2, need: 1}
```

**Custom counts and failing names (0.13, RC2–RC3).** A command may print
`owed-counts {"pass":2,"fail":1,"failed":["latency gate"],"skip":0}`. Pass/fail
(and optional skip) are non-negative integers; failed is an optional string
array (at most 50 names retained). The last valid line overrides every other
count format, with `format: owed` and tests = pass + fail + skip. Malformed
column-0 protocol lines are ignored and noted. The token must start at column 0
and be followed by whitespace and a JSON object. Indented examples and comments
are silently ignored: `    owed-counts {"pass":0,"fail":0}` in a TAP diagnostic,
or `# owed-counts {"pass":0,"fail":0}`, never overrides real test counts.
Only this explicit format makes fail > 0 reject
an exit-0 run; other formats are unchanged. TAP `not ok N - name` and cargo
`test name ... FAILED` also supply names. In 0.20.1, failed notes, `why`, halts
and repair messages quote up to three tests in name order, for example
`failed tests: assertion (test/runtime.ts:31): expected 1, actual 2 | ...`.
Use both assertion values when present; otherwise the first error line or
`(no error text)`. Remainder counts appear for additional names; unrelated
passing summary/last-output tails are not appended to named failures. TAP YAML
errors (including quoted/plain/block scalars) and both cargo panic formats
remain recognized. Error messages strip ANSI, collapse whitespace, replace
semicolons with commas and stop at 160 characters. Locations prefer the
innermost repository test stack frame, otherwise the parsed location; omit
columns and shorten absolute paths relative to the run cwd (otherwise to their
last three segments). Assertion values are independently masked and cut to
120 characters. `obs.signatures` use `v2|` plus the masked first error line,
tree-relative test stack frame and expected/actual values; creation-site TAP
locations are not signature frames. Repository test paths are `test/`, `tests/`,
`.test.` / `.spec.` basenames or `_tests.<ext>`; external and node_modules
frames are excluded. Masks normalize long hex ids, durations and `/tmp/` paths.
`obs.failed` retains up to 50 names, including repeat unions, and log blobs
retain the evidence. Failed red checks (including `red_expect` mismatches)
get the same quote; successful red runs are unchanged. Reused measurements
keep the stored note. Anonymous failures still use the bounded tail (up to
15 lines, or five for no-count command failures); separate count-failure
reasons remain. Timeout notes follow the timeout rules above.

Use owed >= 0.13 for these fields: published 0.12 silently drops repeat while
parsing a plan and replays observations by aggregate verdict only (it ignores
runs/noisy/failed metadata). From 0.13 an unknown top-level obs field refuses
with code `version`, requiring an upgrade and pi session restart.

Recipes (sketches; adapt paths):

- **Slot limiter** — at most 5 heavy runs at once on this machine, `wrap: ["/abs/tmp/qa/heavy.sh"]`:
  ```bash
  #!/bin/bash
  # heavy.sh: hold one of $SLOTS flock slots while the command runs; the lock dies with the process group.
  slots=${SLOTS:-5}; dir=/tmp/qa-slots; mkdir -p "$dir" || exit 127   # cannot run: 127, never a test failure
  while :; do
    for i in $(seq 1 "$slots"); do
      exec 9>"$dir/$i"
      if flock -n 9; then "$@"; exit $?; fi
    done
    sleep 1
  done
  ```
  A single slot is just `wrap: ["flock", "/tmp/qa.lock"]`.
- **dsa machine lease (0.13, LE1–LE4)** — attest, merge, adopt and genesis measurements (including init's background attest) automatically take `pi-durable-subagents hold machine --shared` when dsa is available. Standalone CLI/tools wait; the driver uses `--no-wait` and retries busy attests and merges next pass without halting. Commands inside the lease get `OWED_LEASED=1` and output says `lease: machine (shared)` (JSON/details: `lease: "machine (shared)"`). A wrapper should skip its own lease when that marker is `1`, avoiding a nested request behind an exclusive waiter. Use CLI `--no-lease` on init, attest (also `--genesis`), merge or adopt, tool `lease: false`, or top-level plan `lease: false` to opt out. Default is on; the plan field and automatic environment marker change no item key. Driver/standalone attest and merge holds request `--priority 10`, with confirmed unknown-option fallback; sweeps lease only from their first command through cleanup. Merge's holder is released on completion, throw, abort or parent death.
- **Checks prepare their own artifacts** — owed measures in a fresh temporary worktree of the candidate or merge tree, so nothing that exists only in slot worktrees (build outputs, caches, `node_modules`) is present. A check or invariant must prepare its own build artifacts, for example through `setup` or its `run` command. When a failure was environmental and the parent fixes the check, that plan update supersedes the old block: no rerun and no owner waiver.
- **Build cache** — every materialized tree starts without build output. Keep build artifacts per tree, for example `export CARGO_TARGET_DIR="$OWED_TREE/../target-$(basename "$OWED_TREE")"` in the check's `run` command; a common target directory can link artifacts from another checkout (use the per-tree or locked last-checkout recipe above). Download caches such as `npm_config_cache` may be shared through `exec.env`. A cache is a trust input: a poisoned cache can make a check pass, so keep it per user and machine.
- **Remote host** — run checks on another machine:
  ```bash
  #!/bin/bash
  # remote.sh <host> bash -lc <command>: mirror the tree to <host> and run there.
  host=$1; shift; dir=/tmp/owed-remote/$(basename "$PWD")
  rsync -a --delete --exclude .git ./ "$host:$dir/" || exit 127      # mirror failed: could not run
  ssh "$host" "cd $(printf %q "$dir") && export CI=1 OWED=1 && timeout 900 $(printf '%q ' "$@")"
  rc=$?; [ "$rc" -eq 255 ] && exit 127                                  # ssh transport failure: could not run
  exit "$rc"
  ```
  A remote `timeout` exits 124, which owed reads as a test failure (a red pass unless `red_expect` is set); a command that itself exits 255 is indistinguishable from an ssh failure here and becomes 127.
  With `wrap: ["/abs/remote.sh", "runner"]` the key names the host (the wrapper argv), but owed cannot verify where the command ran, which environment it had or that the remote tree matched. owed only kills the local process group: the wrapper must bound the remote command itself (`timeout`), and it must forward the variables it needs (`exec.env` is not sent over ssh by itself). The mirror has no `.git`, so checks must not need Git.

## Reference: trust and storage

### Trust boundary and storage

The ledger lives under the Git common directory in `owed/`, shared by the repository's worktrees. Dispatch worktrees live under `.owed/wt/` and are locally excluded from Git. `OWED_DIR` overrides ledger storage for isolated tests.

Parsed plans are cached in `owed/cache/plans/<sha>.json` (0.10), so a status call does not parse every plan version's YAML again. The cache is derived: a damaged, stale or foreign-version entry is ignored and rewritten. `owed verify` parses every plan from YAML and checks each cache entry against it: an entry from another owed version is rewritten silently, while a corrupt entry or one whose content differs is reported in `cacheMismatch` (`--json`) and rewritten; and `owed gc` removes entries for plans the ledger no longer names. Deleting the directory is always safe.

Ledger lock identity uses the real ledger directory, including symlink
aliases. Unlocked counterfactual reporting hides an incomplete final decision
group just like status/why; locked reads and verification remain strict.
These safeguards change no acceptance key or complete historical ledger state.
`owed --version` / `owed version` prints the installed package version without
a repository and accepts no other arguments/options.

Since 0.31.1 owed keeps replayed state in `owed/snapshot/state-<version>.v8` (URI-component escaped version), so a call folds only the entries appended since (a long-running pi session keeps the same in memory). Only the current version's file is read; legacy `state.v8` is ignored, costing one cold replay on first use. Successful writes retain the current file and the two newest other snapshots by modification time, best effort. The format and validation are unchanged. A damaged or ledger-mismatching snapshot is ignored and rewritten; deleting it only costs one full replay. `owed verify` always replays the whole ledger; when the snapshot differs from that replay it deletes only the current version's file and reports `snapshotMismatch: <seq>`. A ledger entry written by a newer owed (an unknown kind or value) is refused with `ledger entry #<seq> (...) needs a newer owed than <version>: upgrade owed and restart pi sessions that load it` (exit 1).

Since 0.16 every driver state load (passes, measurement reaping/refusals and wake/status revalidation) uses the same verified replay and persistent plan caches as ops. At a cached replay point it neither full-replays nor parses historical YAML; appended entries fold from that point. The in-process memo still refreshes every 32 folded entries: after a short increment, a same-head reload may refold at most 31 entries, and consecutive incremental loads fold at most the newly appended entries plus 31. Crossing 32 folded entries advances the memo replay point, so a following same-head load folds zero; the disk snapshot cadence remains unchanged. Every load still reads and verifies the entire hash chain. The driver applies `drive/reports.json` only to that load's private state after caching the ledger-only replay: a report or driver mutation cannot leak into another load or the snapshot. Shared cached plans are immutable. No gate, key, ledger field, lock or scheduling/idempotence rule changes; incremental hash verification and driver pass frequency remain deferred. The scale benchmark is `node --expose-gc test/perf/driver-load-bench.ts` (not part of `npm test`).

#### Worktree location and branch names

A repository whose rules forbid worktrees inside the main worktree, or prescribe branch names, configures both in the plan:

```yaml
worktrees:
  root: ../dev/wais-worktree          # absolute, or relative to the main worktree root; default .owed/wt
  branch: "{type}/{node}-{attempt}"   # default "owed/{node}/{attempt}"; must contain {node} and {attempt}
nodes:
  - id: auth-api
    type: fix                         # optional, default feat; only fills {type}
```

Dispatch creates `<root>/<node>-<attempt>` (missing parent directories are created) on the templated branch; a name that `git check-ref-format --branch` rejects is refused before anything is written. Only a root inside the main worktree is added to `.git/info/exclude` (`.owed/` for the default root, as before); an outside root adds nothing. Every later command uses the branch and worktree recorded at dispatch, so changing `worktrees` or `type` affects only later dispatches; it is never a downgrade and keeps submitted candidates. The worktree is recorded by its physical path (symlinks in the root resolved), the same path git reports inside it. Dispatch, merge and gc never switch the main worktree's branch or HEAD or touch its tracked files; they do create slot worktrees inside it when the root lies inside it (the default `.owed/wt`), and a merge fast-forwards it when the trunk is checked out there. With a root outside it and the trunk checked out elsewhere, a main worktree with uncommitted user changes stays byte-identical. Glob characters in an inside root are escaped in the exclude line. A new plan is refused when `root` or the template contains a control character, or when the template is ambiguous (two (node, attempt) pairs could give the same name): `{node}` must occur exactly once, and each `{attempt}` or `{type}` must be separated from it by a character that cannot occur in that value (such as `/`), so `{node}{attempt}` (`a1`+`1` and `a`+`11` both give `a11`) is refused; a ledger whose recorded plan has such a template stays readable, and gc keeps a branch name recorded for more than one attempt. A dispatch that fails removes the parent directories it created.

If the trunk branch is checked out in another worktree (say `dev` in `../dev/wais-worktree/dev`), `owed status` says `Trunk dev is checked out at <path>; merges fast-forward it there (keep it clean).` A merge fast-forwards that worktree, and refuses while it has uncommitted changes: `trunk worktree <path> has uncommitted changes: commit them there, or detach it (git -C <path> switch --detach), then retry`.

This is a local, same-user trust boundary. It guards against mistakes and lazy cheating through normal tools, not a malicious user with shell access. The hash chain detects edits; it does not prevent them, and a user who controls the files can rewrite the chain. Principal names are workflow assertions, not authenticated accounts. Check commands execute locally with the current user's permissions.

### Reclaiming worktrees

Each dispatch leaves a worktree under `.owed/wt/<node>-<attempt>` of the main worktree (also when dispatched from inside another slot worktree) and a branch `owed/<node>/<attempt>` (or the configured root and branch template, see above). Once an attempt is merged or abandoned, `owed gc` (parent or owner only) reclaims them. At five registered, recorded closed attempts, compact/full status and merge replies show `Housekeeping: <n> finished attempt worktrees; owed gc reclaims them`. The read-only hint excludes open/unrecorded/measurement worktrees, disappears on listing failure and promises no dirty/locked removal:

```sh
owed gc --dry-run   # list what would be removed and what is kept, change nothing
owed gc             # remove clean finished worktrees and their branches, then git worktree prune
```

The current open slot is never touched, nor a finished worktree that contains another worktree. A finished worktree with uncommitted or untracked (non-ignored) changes is kept and reported as dirty, together with its branch, so no work is lost; clean or commit it and run `gc` again. Branches of abandoned attempts are deleted even though they were never merged. Before a branch goes, every commit submitted in that attempt that trunk does not already reach is pinned under `refs/owed/keep/<node>/<attempt>/<submit-seq>`, so `git gc` cannot prune it and a later attribution rerun of an old failure still works; `gc` never deletes `refs/owed/keep/*`. Each run that removes or pins something appends a `note` entry to the ledger naming what was removed and pinned; a second run removes and pins nothing, so it appends no note. `--json` returns `{removed:[{node,attempt,worktree,branch,pinned}], kept:[{node,attempt,worktree,branch,reason}]}`, where `worktree`/`branch` in `removed` is `null` when that part was already gone and `pinned` lists the keep refs created (or, with `--dry-run`, that would be created).

## Version history

### 0.27

Shared quarantine sets and script delivery replace hand-maintained skip lists;
native Cargo excusal requires complete libtest evidence. Trunk probes and tracked
waivers distinguish repository failures from node changes. Flaky needs retain
the same-key failure/pass pair and wait for a changed candidate's measurement.
Waive effects and remeasure hints say what happens next; unchanged admission
lint stays quiet. `ignorable` display fields support future readers after a
coordinated upgrade. See SPEC §3.6, §5, §7.16, §7.27, §9.9 and Compatibility.

### 0.26

Review needs quote the actual ask; stopped writers quote their final reply
and ask for a parent decision instead of an empty submit. Insufficient ruling
acknowledgment refuses before recording (`--ack-rulings latest` records a number). Ready nodes explain
why dispatch is skipped, writes amendments accept bare/covered scopes, and
unrelated node-only plan edits no longer invalidate a measured batch. Setup
failures can resolve through a qualifying exact-key counted pass; upgrade every
reader before the first incompatible executor receipt. `report --cost` and
reads/timeout warnings expose measurement cost. `start --restart` is graceful
and safely repeatable; version commands and operation-specific Git recovery
hints improve diagnostics. See SPEC §7.21, §7.26, §8.3.1, §9.2, §9.6–9.8,
§10.2, §12.5.4 and §12.8.

### 0.25

The core profile declares seven tools, discovers the others with tool search and falls back to direct exposure when needed (`OWED_TOOLS=all` opts out). `owed start` replaces the initial orchestration steps; dispatch prints its packet once. Wakes, outstanding-only why cards and incremental repairs keep actionable content quiet, while `--full` keeps the evidence. Single and batch merges print concise current-key receipts. Answer reminders default to ten minutes. The skill now links topic references from a small core. See SPEC §8.3.4, §9.6, §10.2, §11.2, §12.5.3 and §12.8.3–12.8.4.

### What's new in 0.24

Upgrade every reader to 0.24 — CLI, every driver and every pi session loading
owed, with each driver/session restarted — before (1) a sweep records a
confirmed boundary/automatic escape, (2) the plan sets `sweep.every`, or
(3) the plan sets `risk` or `closure_neutral`. Older readers refuse the new
sweep/escape fields; 0.23 rejects plans containing `sweep.every` as an unknown
key and cannot read their ledger state. It ignores top-level `risk` and
`closure_neutral`. Risk can raise or lower review requirements: old executors
can merge below a raising policy, making 0.24 replay refuse the entire ledger;
0.24 merges relying on a lowering policy can make old replay refuse the entire
ledger. Only `closure_neutral` used alone is conservative: old executors compute
`closureTouched=true` for new submits changing closure, while replay retains
recorded facts. No new ledger entry kind is added.
See [SPEC compatibility](docs/SPEC.md#compatibility-020027).

- **Scheduled sweeps and automatic escapes:** `sweep.every: {merges: N,
  minutes: M}` makes either threshold due. Running drivers sweep in the
  background alongside node work; `owed sweep --due` supports cron.
  Two failed head samples, two failed culprit samples and a passing predecessor
  confirm a `missing` escape recorded by owed, deduplicated with a coverage
  notice. Flaky/inconclusive results report only; sweeps never gate a merge.
  Without a schedule, staying drivers keep idle-only sweep preemption.
- **Diff-derived reviews:** owner-declared ordered `risk` classes use the first
  matching rule per changed path, then maximize count and rank across the diff.
  `closure_neutral` exempts declared JSON-only neutral closure changes from
  closure-review, while full-file measurement hashes remain. Lowering either
  policy requires the owner. Views explain the derived requirement;
  report/metrics `reviews.sameModel` keeps model correlation visible even
  when its warning is acknowledged.
- **Driver-safe hotfix adoption:** `owed adopt --commit <c> --note "<why>"`
  lands an off-ref fast-forward under the merge lock without stopping the
  driver. A running merge finishes first; if the hotfix then needs rebase,
  adoption refuses before measuring. Already-contained commits refuse as
  `nothing to adopt`. The normal invariant guard still applies. A crash
  between ref advance and ledger append requires adoption without `--commit`.
- **Idempotent identical acts:** retrying the same latest `review`, candidate
  `evidence`, `approve` (including block) or `waive` on the same open candidate
  appends nothing and succeeds with `already recorded as #<seq>` and runtime
  `alreadyRecorded` metadata. A changed judgment or new submit is a new act.
  Historical duplicate runs fold in text as `×<k>`; JSON and counts stay intact.
  Scripts identify Busy by exit 75, not output text.

Details and limits: SPEC §3.8–3.9, §6.2a, §7.15b, §7.21, §8.3.2–8.3.3
and §9.4–9.5.

### What's new in 0.23

Upgrade the CLI, driver and every pi session that loads owed (restart it)
before the first 0.23 `attest` or `merge`, or before recording 0.23 decisions
or applying executor rebases. Leasing is on by default; these measurements
need no manual opt-in. Older readers ignore writer review carry conservatively,
reject executor rebase submits, and refuse ledgers with the new observation
lease-wait field.
See [SPEC compatibility](docs/SPEC.md#compatibility-020027) for the upgrade order.

- **One parent decision:** `owed decide A,B --text "<decision>"` combines one
  ruling, unambiguous question answers and default recovery of halted/held
  nodes. Add `--writes +path`, owner `--defer INV`, `--after NODE`,
  `--remeasure` or `--writer` as needed; `--no-resume` preserves a halt.
  Validation and append are atomic; external delivery follows, with exact
  answer retry guidance. The pi tool is `owed_decide`. Older commands remain.
- **Shared failures:** matching failures observed without a candidate can
  park affected nodes under one repository notice. Eligible invariant failures
  get one same-key retry; pass plus fail still needs an owner decision. Accepted
  fix candidates merge first. Owner `allow[].defer` rules can pre-authorize
  visible invariant debt only with matching signatures and a same-key pass.
  Name-only matches support diagnostics and waiting, never automatic deferral.
- **Clean rebases:** exact clean-rebase trees carry independent OK reviews;
  checks and invariants still obey their keys. The driver rebases eligible
  clean, sealed writer slots without a writer turn. Parent/owner CLI
  `owed rebase A --apply` requests this explicitly; conflicts return to the
  writer route after rollback. Later rulings still need acknowledgment.
- **Measured coordination:** `owed report --metrics` adds decisions, acts per
  decision, acts targeting only merged nodes, halt classes, phase latency and
  lease wait. `owed report --counterfactual` estimates which historical halts
  would now park or rebase cleanly; it is read-only and costs about one cold
  replay, potentially tens of seconds on a large ledger. Driver lease samples
  exclude waiting between passes.
- **Quiet, current views:** rule receipts report delivery counts and direct
  failed/unknown deliveries to why's `Ruling to forward`. Active measurements
  replace stale wait labels. Text timestamps use local time when displayed;
  ledger and JSON timestamps stay ISO UTC.

Details and limits: SPEC §7.14a, §7.17, §7.24–7.25, §8.3.1 and §9.3–9.4.

### What's new in 0.22

0.22 includes the previously unreleased 0.20.1 and 0.21 changes below.
**Upgrade every driver, CLI and pi plugin to >= 0.22 before enabling
`drive.merge_batch`**, requesting a batch by hand, or using writes globs,
overlap retries or `remeasure_on`. Older readers can misjudge batch guards,
interpret globs literally or refuse new observation fields. Existing ledgers
retain their recorded writes dialect; no automatic migration rewrites them.

- **Batch merges:** `drive.merge_batch: N` (integer 1..8, default 1/off)
  lets the driver measure up to N accepted, non-overlapping nodes on one final
  tree and advance trunk once. Parent/owner `owed merge A,B,C` explicitly
  requests a batch regardless of the setting. Members must have no non-neutral closure changes
  (0.24 `closure_neutral`, SPEC §6.2a) or owe remeasurement; approval gates still apply. Conflicting members drop
  out for rebase/individual merge. Status shows the planned batch. Failed batch
  votes belong only to that batch: the driver retries members singly, each on
  its own tree, with its own eligible automatic remeasure. Batch observations
  never carry `remeasure_match`/`auto_remeasure`, block a member or count as its
  remeasure receipt. In 0.31, the same failed set stays suppressed on the same
  trunk while its candidate commits are unchanged; driver isolation also keeps
  refused candidates merging alone across trunk changes and restarts.
  Every member compares inherited debt with pre-train trunk. A later individual
  merge can identify old debt from a completed batch's trunk failure while still
  measuring its own tree; new/truncated failures and automatic retry conflicts
  still refuse. Replay rejects batch retry metadata, and single-merge retry
  diagnostics ignore batch votes. Planned batches exclude waiting, later, halted,
  parked and reported nodes; running members say `merge in batch with <leader>`.
- **Writes patterns:** node/allow writes and adopt scopes accept `*`, `?` and
  whole-segment `**`; `dir/**` equals `dir/`. Literal prefixes keep their old
  meaning. New input refuses absolute paths, parent traversal, brackets,
  braces, negation, backslashes and embedded `**`. Containment is conservative
  and unproven widenings still need the owner. Matching grants authorize exact
  files; overlap may conservatively delay disjoint globs sharing a prefix.
  New recorded plans carry `writes_syntax: 2`; historical entries stay literal.
  Plan/edit/amend may preserve invalid legacy entries at their original node or
  allowance position; new invalid entries still refuse, permission gates remain,
  and recording a new plan still opts into syntax 2. Runtime plan copies retain
  the dialect without adding it to plan JSON or changing its hash.
- **Partial grants and waits:** eligible files receive grants even when others
  refuse. If all refusals are ownership overlaps, `obs.waits_on` lets the driver
  wait until those slots merge or abandon, then remeasure writes once on the
  same key. The subsequent observation supersedes the earlier overlap-only
  failure. Mixed reasons keep normal repair/conflict rules. Waiting cycles halt
  with a plan/abandon/resume action. Without a driver, attest after slots close.
  Grant hints use optional structured `grant_refused` on closure/overlap
  refusals, not failure-note wording; uncovered-only paths do not set it.
  Historical field-free observations are not inferred from text. Upgrade older
  readers that reject unknown fields before reading new grant refusals.
- **Invariant retry policy:** `remeasure_on: ["connection refused"]` matches
  literal case-sensitive raw failure diagnostics, or captured raw output when
  no tests were parsed. Every failure must match; incomplete/missing diagnostics
  and error/timeout verdicts never authorize retry. Eligible single-node merge
  or trunk measurements get one durable same-key automatic retry. Both votes
  remain: repeat pools them; otherwise pass plus fail needs the owner. Changing
  this policy changes no key or exhausted budget. A node-specific defer does
  not resolve trunk conflict or authorize unrelated merges/adoption.
- **Plan shell lint:** new/changed commands in init/plan/edit/amend, including
  dry runs, expanded templates, setup/slot setup and timeout diagnostics, receive
  `bash -n` checks. Statically quoted nested Bash scripts are checked too, without
  executing expansions. Unchanged legacy commands stay loadable. Missing Bash
  warns; syntax errors refuse admission. Computed scripts remain a known limit.
- **Adopt priority:** `owed adopt --wait SECONDS` gives one total acquisition
  budget (default 60; finite nonnegative fractional values allowed) across lease
  and lock waits. Measurements retain their own timeouts. Per-process expiring
  pending markers make the driver finish its running merge and yield new merges
  to the oldest adopter. Busy messages name holder activity and its local start time.
- **Remote measurements:** string-template `exec.wrap` supports `{cwd}`,
  `{timeout}` and required `{cmd}` with shell-safe substitution. It covers setup,
  checks/red/mutants/invariants/probes/sweeps and diagnostics; Git, ledger and
  leases stay local. `wrap_grace_s` defaults to 30; evidence freezes at timeout
  while the wrapper gets shutdown grace. The template changes measurement keys
  only when set; legacy argv arrays retain their keys and behavior. See the
  execution section for the wrapper contract and remote cleanup limits.
- **Lock boundary:** command/job runners refuse to spawn under the ledger lock;
  destructive/worktree Git operations are guarded too. `advanceTrunk`'s ff-only
  advance of an already measured commit is the single named Git exemption.
  Owed never detaches trunk. Merge hooks still run under the ledger lock and may
  delay writers; an external process's lock is outside the async-context guard.
- **Review and conflict guidance:** active blocks suggest writer-action rulings
  and repair; owner review is explicitly labelled an override. CLI `--json`
  retains ruling delivery slots and full follow-ups; pi tool details keep
  bounded delivery counts and metadata samples. Concise receipts direct
  manual forwarding to `owed why <node> --full`. Status/why show conflict files
  against trunk and other candidates; `none` means a clean Git probe, `unknown`
  requires retry. Probes are cached diagnostics, not acceptance evidence. Missing
  ruling acknowledgments originally warned after recording; 0.26 now refuses
  insufficient or underivable ack before append. `--ack-rulings latest`
  records the current numeric watermark after the reviewer reads the rulings.
- **Idle watchdog:** `owed idle [--json]` is usable from cron/systemd: exits 0
  idle, 3 not idle, 2 usage/missing ledger, 70 internal error. It requires open
  work, no driver/locks/machine holder or matching running/asking labelled agent,
  and progress older than `drive.watch_idle_min` (default 15 minutes; 0 disables).
  Unknown subagent activity falls back to age and other conditions; failed
  installed machine inspection stays quiet. Pi watches repositories where the
  current session observed its own live driver, retaining observation after exit;
  successful explicit `owed_init` may also arm that session's idle watch. Startup
  cwd and ordinary queries do not arm it or take over an absent owner. Identity
  changes discard observation; a foreign live driver suppresses delivery. Pi
  checks these repositories every 120 seconds, wakes only a settled top-level
  agent and claims one notification per host, repository and idle period across
  sessions. This is advisory; unlabelled calls
  and a crash between claim and delivery can hide activity or a wake.

Batch-tail recovery also handles oversized non-final member lines. Existing
model-warning acknowledgments preserve candidate commits and keys while
independent review blocks remain binding.

For complete semantics and known limits, see [SPEC](docs/SPEC.md), especially
§3.7, §7.17–7.23, §8.4, §9.2 and §12.8.2. Torn batch tails must be completed
by restoring the trunk ref/history to the batch final commit and allowing the
next owed write to recover missing entries; `adopt` cannot close them.

### What's new in 0.20.1

Upgrade executors, drivers, CLI and pi plugins together before using the new
keys: older readers ignore `on_timeout`, reject `drive.same_model`, or retain
old diagnostics. No ledger entry kind or field is added, and no acceptance
gate is weakened. Historical untagged signatures still replay, but do not
match newly measured `v2|` signatures (including for defer carry). JSON consumers
must accept acknowledged `modelWarnings` objects as well as warning strings.

- **Failure evidence:** versioned signatures include the masked first error,
  innermost repository test frame and independently masked expected/actual
  values (120 characters each). Same-signature trunk failure alone is not
  intermittent; current trunk failures report when the uninterrupted run began
  and its merge/adopt provenance. Refusals quote up to three failed tests rather
  than error-frequency groups or unrelated passing summary tails.
- **Timeout evidence:** last 256 KiB of measurement output, timeout marker,
  optional diagnostics and a best-effort pre-kill process tree stay in the log.
  Check/invariant `on_timeout: "<command>"` runs once with a separate 30-second
  limit. Diagnostic output cannot change counts, signatures or the error verdict.
- **Model warnings:** compare direct models and dsa pool members by
  `provider/id`, ignoring thinking suffixes. Unknown membership is explicit,
  not a guessed mismatch. Global/node `drive.same_model: accepted` hides only
  the advisory same-model warning in compact why; full/JSON receipts retain it.
- **Quiet dispatch retries:** retry CAS changes, including changed plans, with
  fresh readiness/ownership checks and completed rollback, at most three total
  attempts. Exhaustion reports `retry next pass`, not Needs you or a halt.
- **Merge waiting:** ordinary/full status name the internal blocking job and
  its locally displayed start plus the current number of accepted merges ahead. JSON adds
  optional runtime-only `mergeWaiting[id].job` and `.ahead`; queue positions
  are derived on each read, not taken from stale cache.

### What's new in 0.20

Upgrade every driver, CLI and pi plugin together: only optional entry fields
and plan keys are added, with no new entry kind, but older versions can ignore,
misread or refuse them. Repeat across several observations on one key now pools
all runs (an old pass/fail conflict can replay as pass or fail).

- **Measure again, not invalidate:** `owed attest <node> --remeasure [--all]`
  remeasures current merge-tree invariants on the same key; use `--trunk` for
  trunk keys or `owed resume <node> --remeasure` for a driver retry. Without
  repeat, pass+fail still needs the owner; repeat pools `passes*N >= K*total`.
  Reused-observation refusals name the seq, age and remeasure command.
- **Native quarantine:** owner-only check/invariant `quarantine: [{test,fix,note?}]`
  excludes exact failing names until the fix merges; the fix's own prospective
  merge is measured without its quarantine, so it must repair those tests. Only a plain allowlisted `node --test` exit 1 with complete TAP,
  every failure quarantined and enough remaining tests can be excused. Cargo,
  templates, wrappers, red/mutants runs and crashes/timeouts are not excused.
  Status/brief/report list the debt; `why <fix> --full` lists what its merge lifts.
- **Check templates:** `cargo-tests`, `node-tap` and `evidence-json` replace
  handwritten `run`; versioned expansions appear in receipts. `min_ok` counts
  successful tests only, not skips/ignored tests or empty TAP file wrappers.
  JSON evidence checks own-field presence, not truthiness. See SPEC §3.6/RC2.
- **Attribution and actionable state:** non-shared merge-tree breaks on moved
  trunk recommend rebase when trunk changed candidate paths; disjoint changes
  point to `owed decide <node> --writer --text "<repair instruction>"`
  (shared/trunk-red failures instead wait). New
  tests use the slot base, and new submits do not re-halt on
  old candidate blocks. Intermittency and defer carry require recorded proof.
  Repair progress hides Needs you only when the driver needs no owner decision;
  approval waits stay waiting, guidance precedes labelled overrides, and
  `why --full` restores quiet confirmation history. Plan receipts precede boards;
  wake reasons appear once. Rebase packets compute upstream and say commit first.
- **Critical-path driver:** merge-ready nodes outrank background trunk attest /
  unscheduled idle sweeps, by unfinished transitive dependent count then
  acceptance age; 0.24 scheduled sweeps continue alongside node work. Status
  shows merge/measure waiting reasons and accepted age. Submit/review `--model`
  (pi `model`) records actual models; why warns about matching/mismatched models.
  Rules/answers immediately notify running roles and report delivery failures
  with stable body-bound ids, preserving exact answer retry commands.
- **Fewer parent acts:** covered amend is unnecessary; `owed resume A,B,C`
  (pi `node` array) is atomic. Metrics attribute acts per node and count batches
  once; plan/edit warn about critical-path write overlaps. Attest exits 0 = done,
  1 = newly measured failure, 4 = no new failure but obligations open; usage 2,
  internal 3 and busy 75 remain. Reviewer launch packets can derive only a
  complete-prefix ruling ack; brief edits preserve multiline / equals text.
- **Torn-read tolerance:** unlocked `Ledger.read()` ignores a final non-newline
  fragment; locked reads and malformed complete lines still fail. Other readers,
  stronger quarantine allowlist restrictions remain backlog
  (SPEC §7.17), not implemented guarantees.

## Development

```sh
npm install
npm run typecheck
npm run build
node --test --test-concurrency=2 'test/**/*.test.ts'
npm pack --dry-run
```

The package ships compiled `dist/` (including the extension worker), its entry point, CLI, skill, docs, and license. Source checkouts can load `index.js` with pi; it prefers the built extension when present. Delete `dist/` after packing when you work from source, or the CLI and extension keep using the stale build. Owed tools and drive-watch revalidation run in one eagerly loaded worker so ledger replay does not block pi's UI. After upgrading owed, the first tool output in each pi session appends a restart notice once per installed version, as its last line. `owed_status {full:true}` always shows the notice while versions differ, and a refusal caused by that mismatch still says it. Restart pi to load the installed version. A crashed worker is replaced only while the installed version still matches the session. See `docs/SPEC.md` for the acceptance rules and `docs/MODULES.md` for module contracts.
