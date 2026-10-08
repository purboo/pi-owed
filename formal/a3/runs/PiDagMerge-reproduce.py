#!/usr/bin/env python3
"""Reproduce merge checks, exclusively through the parent-owned check.sh.
Each TLC process: one worker, 512m, 90s. No parallel processes or global cleanup.
The xtrace receipt preserves check.sh's actual per-TLC rc (its own exit is 0).
"""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
JOBS = [
    ('a22 a3 a3-K2', 'NoLaundering', 'launderReview', 'review'),
    *[('a22 a3 a3-K1 a3-K3', 'P:NoNewBreakage', s, s)
      for s in ['flakyDebt', 'matrix', 'genesis']],
    ('a22 a3 a3-K4', 'GenesisBeforeAdvance', 'good', 'genesis'),
    ('a22 a3 a3-K5atomic', 'JudgedAtCommit', 'race', 'race'),
    *[('a22 a3', 'NoLaundering', s, s) for s in ['launderTest', 'rerun']],
    ('a22 a3', 'NoFlakyRerunEscape', 'launderTest', 'flakyRerun'),
    ('a22 a3', 'P:NoNewBreakage', 'falsePass', 'falsePass'),
    ('a22 a3 a3-K3state', 'StateNeverWaived', 'waiver', 'waiver'),
    ('a22 a3 a3-K5queue', 'P:GoodEventuallyMerges LeaseExcludes NothingMerged', 'live', 'live'),
    ('a3', 'NothingMerged NoUnrelatedMerge', 'good', 'good'),
    ('a3', 'P:NoNewBreakage DeferredDebtVisible NoDeferredMerge', 'defer', 'defer'),
    ('a3', 'NoOwnerWaivedMerge', 'launderReview', 'owner'),
    ('a3', 'P:NoNewBreakage NoOldDebtMerge', 'oldDebt', 'oldDebt'),
]

def main():
    env = dict(os.environ, WORKERS='1', TLC_HEAP='512m', TLC_TIMEOUT='90')
    env.pop('NODEADLOCK', None)
    receipt_path = ROOT / 'formal/a3/runs/PiDagMerge-checks.log'
    with receipt_path.open('w') as receipt:
        receipt.write('WORKERS=1 TLC_HEAP=512m TLC_TIMEOUT=90 NODEADLOCK unset\n')
        for modes, props, scenario, tag in JOBS:
            cmd = ['bash', '-x', 'formal/a3/check.sh', 'PiDagMerge', modes, props,
                   f'Scenario = "{scenario}"; O = o; K0 = k0; K1 = k1', '-' + tag]
            receipt.write(repr(cmd) + '\n')
            receipt.flush()
            result = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True,
                                    text=True, timeout=120)
            receipt.write(result.stdout + result.stderr + f'\nwrapper_exit={result.returncode}\n')
            receipt.flush()
            print(result.stdout, end='', flush=True)
            if result.returncode:
                raise SystemExit(result.returncode)

if __name__ == '__main__':
    main()
