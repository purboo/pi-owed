# Small tool surface and start

The default Pi tool profile is `core`: `owed_status`, `owed_why`, `owed_decide`, `owed_drive`, `owed_start`, `owed_submit`, and `owed_review` are direct. All other owed tools remain registered as deferred tools, discoverable and activatable by the host's tool search. Core descriptions explain discovery. `OWED_TOOLS=all` makes every owed tool direct. Hosts that do not report tool exposure through their API retain direct registration; an API unavailable during extension loading is checked again when the session starts. No Pi version is assumed.

`start` accepts optional `--plan`, `--max`, and `--stay`; `owed_start` accepts the corresponding `plan`, `max`, and `stay` fields, plus the usual optional `cwd`. It checks Git author and committer identity, validates and lints the plan, verifies the trunk ref, initializes a missing ledger as delegated `owner:pi`, records a changed plan under existing parent permissions, and starts the detached driver. Genesis measurements remain the driver's responsibility through the existing attest and merge lifecycle. Output gives the action, driver state, and next step; lint warnings stay available in structured results.

An unchanged plan with a running driver reports `already running`, preserving the ledger and live driver log. Plan comparison uses the existing canonical plan representation, so formatting-only edits do not record a plan. When `--plan` is omitted, start rereads the latest recorded plan source rather than guessing a filename. An explicit new plan source becomes the default after a changed plan is recorded. A running driver's concurrency and stay mode are not changed by another start.

## Parent ruling

Ruling #2550 (SF4) specifies fail-closed usage refusals without a blocking dialog or ledger entry: a missing plan source must be supplied; an uncovered downgrade requires an explicit owner plan decision with a reason; and initialization under `OWED_CONFIRM=owner` requires explicit init. Allowance-covered changes use the same authority and visible downgrade accounting as plan updates. Refusals identify the failed preflight and its remedy.

`owed_dispatch` prints the complete packet once. Its rendered subagents arguments refer to that packet, while the structured subagents arguments retain the complete executable task and existing isolation setting.

## Compatibility

No ledger entry kind, acceptance gate, observation key, or plan key is changed. Genesis entries created by start may contain optional `path`, identifying the initial plan source; historical entries without it replay unchanged. A historical latest plan without a recorded source requires an explicit plan parameter. Driver-start results may contain optional `alreadyRunning`; start results expose initialization, plan update, warnings, and driver state. Existing drive start retains its refusal when another driver is running.

## Existing test changes

The existing test “G2 text/details equal the in-process views; worker errors retain exact code and text” now expects the dispatch text's packet reference instead of a second serialized packet. Its structured argument assertion is unchanged. The existing “CR2 dispatch preserves the packet and subagent arguments and appends a brief” test makes the same text-only change, retaining brief and details assertions. “SPEC §11 lists every registered pi tool” temporarily includes these notes beside the existing decide notes fallback; missing notes are tolerated after the documentation is folded. Ruling #2576 (SF5) authorizes these two assertion updates and focused rechecks in place of a second full suite.

## SF5 verification exception

The full suite result is 1294/1296; the two failures are exactly the legacy assertions updated under SF5. Their focused rerun passed; its log is `/tmp/owed-bench/logs/surface-1-221413.log`. This evidence exception is recorded here as explicitly required by ruling #2576.

## Interpretation choices and limits

The only added genesis metadata is the plan source needed for omitted-plan starts. Canonical equality, existing allowance validation, driver lock serialization, and the current measurement lifecycle are reused rather than introducing new persistence or orchestration mechanisms. Initialization and plan recording remain durable if subsequent driver launch fails; explicit driver status and start recovery remain available. No unapproved deviation from SF or ruling #2550 is introduced.
