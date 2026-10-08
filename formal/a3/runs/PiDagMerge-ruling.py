#!/usr/bin/env python3
"""Parent-ruling regression checks, only via check.sh; sequential TLC jobs."""
import os, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
jobs=[('a22 a3','NoBypassedNegative EscapeAttributable DeferredDebtVisible',s,'ruling-'+s,None,90)
      for s in ['launderReview','launderTest','rerun','flakyDebt','matrix','genesis','falsePass','oldDebt','defer']]
jobs += [('a22','NoBypassedNegative EscapeAttributable NodeAcceptanceCovered','free','ruling-free','num=2000',120),
         ('a3','NothingMerged NoDeferredMerge FreeNoTwoMerges','free','ruling-free','num=2000',120)]
with (ROOT/'formal/a3/runs/PiDagMerge-ruling-checks.log').open('w') as out:
 for modes,props,scenario,tag,sim,bound in jobs:
  env=dict(os.environ,WORKERS='4' if sim else '1',TLC_HEAP='1g' if sim else '512m',TLC_TIMEOUT=str(bound))
  for key in ['NODEADLOCK','SIMULATE','DEPTH']: env.pop(key,None)
  if sim: env.update(SIMULATE=sim,DEPTH='20')
  cmd=['bash','-x','formal/a3/check.sh','PiDagMerge',modes,props,
       f'Scenario = "{scenario}"; O = o; K0 = k0; K1 = k1','-'+tag]
  out.write(repr(cmd)+'\n'+repr({k:env.get(k) for k in ['WORKERS','TLC_HEAP','TLC_TIMEOUT','SIMULATE','DEPTH']})+'\n');out.flush()
  p=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,timeout=bound*len(props.split())*len(modes.split())+20)
  out.write(p.stdout+p.stderr+f'\nwrapper_exit={p.returncode}\n');out.flush()
  print(p.stdout,end='',flush=True)
  if p.returncode: raise SystemExit(p.returncode)
