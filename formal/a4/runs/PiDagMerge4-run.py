import subprocess, os, json, time, concurrent.futures
from pathlib import Path
R=Path(__file__).resolve().parent
root=R.parents[1]
fixed='launderTest launderReview rerun flakyDebt matrix genesis falsePass defer oldDebt waiver race good live'.split()
props='NoBypassedNegative EscapeAttributable NodeAcceptanceCovered NewEscapeAttributable NoLaundering NoFlakyRerunEscape P:NoNewBreakage JudgedAtCommit GenesisBeforeAdvance StateNeverWaived DeferredDebtVisible LeaseExcludes NothingMerged NoDeferredMerge NoOwnerWaivedMerge NoUnrelatedMerge NoOldDebtMerge P:GoodEventuallyMerges'.split()
freeprops='FreeCoreSafety NoBypassedNegative EscapeAttributable DeferredDebtVisible NodeAcceptanceCovered NewEscapeAttributable NothingMerged NoDeferredMerge NoOwnerWaivedMerge FreeNoTwoMerges'.split()
jobs=[]
diagprops=freeprops+['NoLaundering','NoFlakyRerunEscape','P:NoNewBreakage','JudgedAtCommit','GenesisBeforeAdvance','StateNeverWaived','LeaseExcludes']
for mode in ['a3','a4']:
 jobs.append(('replayWaiverCitation',mode,diagprops,False,'diagnostic'))
for scenario in fixed:
 for mode in ['a3','a4']:
  jobs.append((scenario,mode,props,False,'matrix'))
# Original replay scenarios retain the full free tail, so their core properties
# use the same bounded simulation as the general free scenario (below).
for mode in ['a4-noAuth','a4-noInformed','a4-noRecused','a4-noRel1','a4-noRel2','a4-noRel3']:
 for scenario in ['waiver','launderReview','launderTest','race','good','defer','live']:
  ps=['StateNeverWaived','NoBypassedNegative','NoFlakyRerunEscape','JudgedAtCommit','NothingMerged','NoOwnerWaivedMerge']
  if scenario=='live': ps=['P:GoodEventuallyMerges','LeaseExcludes','NothingMerged']
  jobs.append((scenario,mode,ps,False,'ablation'))

def run(job):
 scenario,mode,ps,sim,tag=job
 env=os.environ.copy(); env.update(WORKERS='1',TLC_HEAP='1g' if sim else '512m',TLC_TIMEOUT='890' if sim else '60')
 # Resume only unfinished checks of the exact current module; preserve passed
 # and violated results as evidence instead of repeating completed work.
 import hashlib
 sha=hashlib.sha256((R.parent/'PiDagMerge4.tla').read_bytes()).hexdigest()
 todo=[]
 for p in ps:
  name=p[2:] if p.startswith('P:') else p
  prior=R/f'PiDagMerge4-{mode}-{name}-{tag}-{scenario}.log'
  text=prior.read_text() if prior.exists() else ''
  finished=text.startswith('# module sha256 '+sha) and 'Finished in ' in text and ('No error has been found' in text or 'is violated' in text or 'was violated' in text or 'Temporal properties were violated' in text or (sim and 'Error:' not in text))
  if not finished: todo.append(p)
 if not todo: return
 ps=todo
 if sim: env.update(SIMULATE='num=10000',DEPTH='20')
 else: env.pop('SIMULATE',None)
 cmd=['nice','-n','19','taskset','-c','0','bash','-x',str(root/'a4/check.sh'),'PiDagMerge4',mode,' '.join(ps),f'Scenario = "{scenario}"; O = o; K0 = k0; K1 = k1',f'-{tag}-{scenario}']
 name=f'PiDagMerge4-command-{mode}-{tag}-{scenario}'
 with (R/(name+'.log')).open('a') as log:
  log.write(json.dumps({'argv':cmd,'env':{k:env.get(k) for k in ['WORKERS','TLC_HEAP','TLC_TIMEOUT','SIMULATE','DEPTH']}})+'\n'); log.flush()
  result=subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=(900 if sim else 70)*len(ps))
  log.write(f'\nWRAPPER_EXIT={result.returncode}\n')
 record={'scenario':scenario,'mode':mode,'properties':ps,'simulate':sim,'tag':tag,'wrapper_exit':result.returncode,'log':name+'.log'}
 with (R/'PiDagMerge4-batch.jsonl').open('a') as out: out.write(json.dumps(record)+'\n')
 print(json.dumps(record),flush=True)
 if result.returncode: raise RuntimeError(record)

if __name__=='__main__':
 # Machine-load constraint: exactly one owned TLC, core 0, nice 19.
 for job in jobs: run(job)
 for mode in ['a4','a4-noAuth','a4-noInformed','a4-noRecused','a4-noRel1','a4-noRel2','a4-noRel3']:
  ps=freeprops if mode=='a4' else ['FreeCoreSafety']
  run(('free',mode,ps,True,'simulation'))
 for scenario in ['replayNegative','replayDeferred']:
  for mode in ['a3','a4']:
   run((scenario,mode,['FreeCoreSafety'],True,'simulation'))
