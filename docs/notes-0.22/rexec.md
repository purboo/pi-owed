# Wrapped measurement execution

Set optional `exec.wrap` to a shell template, for example:

```yaml
exec:
  wrap: ssh runner /opt/project/run-check {cwd} {timeout} {cmd}
  wrap_grace_s: 30
```

`{cmd}` is required. The only placeholders are `{cwd}` (the absolute original measurement directory), `{timeout}` (integer seconds), and `{cmd}` (the original command). Each replacement is a POSIX single-quoted shell word, including embedded quotes. Do not quote placeholders again. The expanded template runs through `bash -lc`, with the existing measurement environment, including `OWED_TREE` and `OWED_LEASED` when the local lease is held. Plan admission checks placeholder names and runs the existing `bash -n` lint on an expansion with a placeholder command.

Checks, red counterfactuals, mutants, invariants, trunk probes, sweeps, setup and `on_timeout` diagnostics share this execution path. Git operations, worktree preparation, ledger records and lease acquisition remain local. The wrapper receives an already prepared local directory; provisioning or mirroring a remote directory is the wrapper's responsibility.

The wrapper's exit status is the command's exit status. Pass stdout/stderr through without adding text that could be parsed as TAP, cargo summaries, or `owed-counts`. Exit 126/127 if transport or provisioning prevents the command from running; configure `red_expect` for red checks to distinguish intended failures from transport failures.

`exec.wrap_grace_s` is an optional nonnegative integer, default 30. Measurement evidence freezes at `timeout_s`: later wrapper output and timeout diagnostics cannot supply counts, signatures or automatic-remeasurement matches. A template wrapper may finish during its grace, but the measurement remains timed out. At `timeout_s + wrap_grace_s`, owed kills the local wrapper process group; abort uses the existing process-tree termination behavior. The wrapper must bound remote execution itself and propagate termination to remote processes: killing local SSH/container clients alone does not prove remote cleanup.

## Compatibility

With no string template, existing measurement keys are unchanged. A string template is included verbatim in check, red, strength, invariant and trunk-probe keys; changing it invalidates prior measurement evidence. Substituted paths and wrapper grace are not added to those keys. Sweep identity already includes execution configuration. Pure local writes and review identities remain unchanged.

Legacy nonempty argv-array `exec.wrap` remains supported, with its existing execution, keys and timeout semantics, so old plans and ledgers replay unchanged. String templates and `wrap_grace_s` require 0.22-capable readers. As before, changing wrapper configuration requires owner authority because it can weaken every measurement.

## Existing test compatibility

`test/fixtures/views-0.10-base.ts`: the historical view fixture now narrows string versus argv-array wrappers before formatting. This is required by the new public `ExecConfig.wrap` union; existing argv-array output and baseline assertions are unchanged. `test/exec-env.test.ts`, “plan: exec block is parsed, empty fields are dropped, bad keys/types/names are errors”: a bare string wrapper now fails because it omits `{cmd}`, rather than because all strings were invalid. Only that expected diagnostic was updated; invalid argv-array expectations are unchanged.
