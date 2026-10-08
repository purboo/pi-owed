#!/usr/bin/env python3
"""Serial, core-0, idle-priority TLC reruns under the user's load constraint.
MaxLog=3 is deliberately deferred to parent. Historical commands remain in JSON.
"""
from pathlib import Path
import subprocess, os, json, time
root=Path(__file__).resolve().parents[3]
runs=root/'formal/a4/runs'
safety='AuthoritySound DecisionAuthority NoWriterJudge NoAuthorJudge RelevantInvalidates UnrelatedPreserves StateRemainsDebt ConflictDebt SamePrincipalSupersedes RetroHonored FuturePreserves'
props=safety+' AllSafety P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived NothingCrossWaived NothingSpeechWaived NothingRevivedWaived'
base='Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2'
ledger=[]
def run(mode, prop, scope, depth, tag, timeout=900):
    const=f'Scope = "{scope}"; MaxLog = {depth}; '+base
    cmd=['nice','-n','19','taskset','-c','0','bash','-x','formal/a4/check.sh','PiDagAuth4',mode,prop,const,tag]
    env=dict(os.environ,WORKERS='1',TLC_HEAP='1g',TLC_TIMEOUT=str(timeout))
    path=runs/f'PiDagAuth4-driver-{mode}-{prop.replace("P:","")}{tag}.log'
    start=time.time()
    with path.open('w') as f:
        rc=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=timeout+60).returncode
    text=path.read_text()
    import re
    raw=re.findall(r'^\+ rc=(\d+)$',text,re.M)
    row=dict(cmd=cmd,env={k:env[k] for k in ['WORKERS','TLC_HEAP','TLC_TIMEOUT']},outer_rc=rc,tlc_rc=raw,seconds=round(time.time()-start,3),driver=str(path.relative_to(root)))
    ledger.append(row)
    (runs/'PiDagAuth4-commands.json').write_text(json.dumps(ledger,indent=2)+'\n')
    print(mode,prop,tag,'tlc_rc='+str(raw),flush=True)
for mode in ['a3','a4']:
    for prop in props.split(): run(mode,prop,'scenarios',5,'-scenarios')
for mode in ['a4-noAuth','a4-noInformed','a4-noRecused','a4-noRel1','a4-noRel2','a4-noRel3']:
    for prop in (safety+' P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived').split():
        run(mode,prop,'scenarios',5,'-ablation')
run('a4','AllSafety','free',2,'-free2')
for prop in ['AuthoritySound','DecisionAuthority','NoWriterJudge']:
    run('a22',prop,'free',2,'-sanity2')
run('a4','NothingMerged','free',2,'-witness2')
print('MaxLog=3 exhaustive: deferred to parent (machine-load constraint)',flush=True)
