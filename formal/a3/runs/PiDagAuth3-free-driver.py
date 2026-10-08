import os, subprocess, json, time
from pathlib import Path
root=Path(__file__).resolve().parent
base=root.parent.parent.parent
const='Scope = "free"; MaxLog = {depth}; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2'
status=root/'PiDagAuth3-free-status.json'
results=[]
def run(mode,prop,depth,tag,sim=False,limit=600):
    cmd=['bash','-x','formal/a3/check.sh','PiDagAuth3',mode,prop,const.format(depth=depth),tag]
    env=dict(os.environ,WORKERS='4',TLC_HEAP='3g',TLC_TIMEOUT=str(limit))
    if sim: env.update(SIMULATE='num=500000',DEPTH='8')
    record=dict(mode=mode,property=prop,depth=depth,tag=tag,simulation=sim,command=cmd,start=time.time())
    status.write_text(json.dumps(dict(running=record,results=results),indent=2))
    with (root/(f'PiDagAuth3-driver-{mode}-{prop}'+tag+'.log')).open('w') as out:
        p=subprocess.run(cmd,cwd=base,env=env,stdout=out,stderr=subprocess.STDOUT,timeout=limit+40)
    record.update(exit=p.returncode,elapsed=time.time()-record['start'])
    results.append(record)
    status.write_text(json.dumps(dict(running=None,results=results),indent=2))
    text=(root/f'PiDagAuth3-{mode}-{prop}{tag}.log').read_text()
    return 'No error has been found' in text
try:
    run('a3','AllSafety',2,'-free-smoke2')
    if run('a3','AllSafety',4,'-free-ex4'):
        run('a3','AllSafety',5,'-free-ex5')
    else:
        run('a3','AllSafety',3,'-free-ex3')
    for prop in ['AuthoritySound','DecisionAuthority','NoWriterJudge']:
        run('a22',prop,4,'-free-sanity4')
    run('a3','AllSafety',6,'-free-sim6',True,900)
except BaseException as e:
    status.write_text(json.dumps(dict(running=None,results=results,error=repr(e)),indent=2))
    raise
