#!/usr/bin/env python3
"""Bounded free-environment checks; every TLC run goes through check.sh.
No parallel TLC runs: each uses four workers. Simulation num is per worker.
Timeouts are retained as incomplete evidence, never labelled HOLDS.
"""
import os
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[3]
JOBS = [
    ('a3', 'EscapeAttributable NoBypassedNegative', 'free-exhaustive', None, 25),
    ('a3', 'NoBypassedNegative', 'free-sim', 'num=10000', 570),
    ('a3', 'FreeCoreSafety', 'free-sim', 'num=10000', 570),
    ('a3', 'EscapeAttributable DeferredDebtVisible NoLaundering P:NoNewBreakage NothingMerged FreeNoTwoMerges NoOwnerWaivedMerge NoDeferredMerge', 'free-sim', 'num=2000', 120),
    ('a22', 'NoBypassedNegative EscapeAttributable', 'free-sim', 'num=2000', 120),
]

def main():
    with (ROOT / 'formal/a3/runs/PiDagMerge-free-checks.log').open('w') as receipt:
        for modes, props, tag, simulate, bound in JOBS:
            env = dict(os.environ, WORKERS='4', TLC_HEAP='1g', TLC_TIMEOUT=str(bound), DEPTH='20')
            env.pop('NODEADLOCK', None)
            if simulate:
                env['SIMULATE'] = simulate
            else:
                env.pop('SIMULATE', None)
            cmd = ['bash', '-x', 'formal/a3/check.sh', 'PiDagMerge', modes, props,
                   'Scenario = "free"; O = o; K0 = k0; K1 = k1', '-' + tag]
            receipt.write(repr(cmd) + f'\nWORKERS=4 TLC_HEAP=1g TLC_TIMEOUT={bound} DEPTH=20 SIMULATE={simulate}\n')
            receipt.flush()
            result = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True,
                                    timeout=bound * len(props.split()) + 30)
            receipt.write(result.stdout + result.stderr + f'\nwrapper_exit={result.returncode}\n')
            receipt.flush()
            print(result.stdout, end='', flush=True)
if __name__ == '__main__':
    main()
