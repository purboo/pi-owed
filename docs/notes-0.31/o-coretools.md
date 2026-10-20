# o-coretools — 0.31 CT1–CT3

Base: `ebf090b83644c4bb170802b97053bc17cd09a910` (0.30.0).
Ownership: the dispatched o-coretools slot; no ledger/reducer, key, vote,
plan, driver scheduling or persistence changes. Source budget: +50 lines;
actual net source growth: +10 lines.

## Behaviour

- CT1: `ensureDirectActive` in `src/ext-worker.ts` restores registered direct
  owed tools at session_start (after the existing discovery repair) and every
  agent_start. It preserves the complete active prefix, adds only missing direct
  registrations, does nothing when all are active, and swallows unsupported or
  throwing host APIs. This also covers OWED_TOOLS=all and previously promoted
  deferred registrations. The discovery repair still runs only at session_start.
- CT2: the registration wrapper adds the exact CLI fallback suffix to each
  deferred description, converting underscores in command names to spaces
  (`owed_check_try` → `owed check try`). The core discovery sentence is retained;
  the all-tools profile retains direct descriptions.
- CT3: the ready hint and initialization reply now pair tool names with CLI
  commands. Description references to other owed tools also include CLI forms.
  Existing question wakes already include complete CLI commands and stay intact.

## CT3 tool-name text inventory

Inspected `rg -n 'owed_[a-z]' src` (all source files):

- `src/needs.ts`, `readyHintText`: pi ready hint names `owed_drive`; added
  `owed drive --detach --stay`. The CLI surface is unchanged. Views and replies
  consume this shared hint; no independent tool-name hint exists in views.ts.
- `src/extension.ts`, init reply: `owed_status` now pairs with `owed status`
  while genesis measurements run. The init description has the same pairing.
- `src/extension.ts`, resume description: `owed_rule` / `owed rule`.
- `src/extension.ts`, decide description: `owed_amend` / `owed amend` and
  `owed_resume` / `owed resume`.
- `src/extension.ts`, edit and amend descriptions: `owed_plan` / `owed plan`.
- `src/drive.ts`, `askingText`: plain and structured single-question wakes pair
  `owed_decide` with `owed decide <node> --text`; multiple-question wakes pair
  `owed_answer` with `owed answer <node> --rid ... --qid ...`. Already compliant;
  new tests exercise all four combinations without changing their text.
- `src/ops.ts`, `amendSource` refusal: `owed_amend plan` already shares its text
  with `owed amend --plan <file>`; no change.
- `src/reducer.ts`, `validateDraft` refusal: `owed_plan note` already shares its
  text with `owed plan --note TEXT`; no change.
- Remaining matches are registration names, schemas, comments, internal event
  names, or type/prototype checks, rather than instructions to call a tool.
  Core descriptions' `owed_*` discovery sentence already includes the CLI.

## Changed existing tests

- `test/drive-live.test.ts`, H1.3 tool-plan ready-hint assertion: CT3 adds the
  exact CLI fallback to the pi hint; the regex now requires that suffix. All
  other assertions and test flow are unchanged.
- `test/needs-structure.test.ts`, exact classified literal inventory: CT2/CT3
  introduce eight raw CLI-bearing literals in extension descriptions and the
  initialization reply. Registered only their exact hashes as help/usage;
  existing classifications and negative tests are unchanged.

New behaviour tests are exclusively in `test/coretools.test.ts`: direct repair
on both events, no removal, repeated repair/no-op, deferred tools left alone,
all-tools profile, missing/throwing APIs, promoted fallback registrations,
command-specific description suffixes, ready hint, existing question wakes and
real initialization reply. The init fixture waits for worker-visible genesis
measurement completion before deleting its ledger, including on red failures.

## Validation

All Node/typecheck/test commands run through `/tmp/owed-bench/run.sh` on the bench host.
No Node, tsc or tests run on the local host.

Initial diagnostics (superseded by the final runs below): typecheck passed;
node checks 43/47 passed. Fixed new-test ordering and asynchronous fixture cleanup,
and registered the newly introduced text literals. No source correction was needed.
Initial logs: `/tmp/owed-bench/logs/o-coretools-1-081213.log` (typecheck),
`/tmp/owed-bench/logs/o-coretools-1-081234.log` (diagnostics).

Final red, typecheck, node checks and full-suite results are recorded in the
handoff accompanying the commit. The red checkout is detached ebf090b under
`/tmp/owed-coretools-red-ebf090b`, with only test/coretools.test.ts copied in.
The full suite command is
`node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`
with bench timeout 1800 seconds. No owed submit is run: the parent owns submission,
attestation, integration and acceptance.

## Source size

`git diff --stat ebf090b -- src`:

```
 src/ext-worker.ts | 12 +++++++++++-
 src/extension.ts  | 14 +++++++-------
 src/needs.ts      |  2 +-
 3 files changed, 19 insertions(+), 9 deletions(-)
```
