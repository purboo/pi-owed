#!/usr/bin/env python3
"""Audit actual log/cfg hashes and raw TLC exit codes; extract shortest BFS logs."""
from pathlib import Path
import json,re,hashlib,collections
root=Path(__file__).resolve().parents[3]; runs=root/'formal/a4/runs'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
module_sha=sha(root/'formal/a4/PiDagAuth4.tla')
commands=json.loads((runs/'PiDagAuth4-commands.json').read_text())
assert len(commands) in (141,142), len(commands)
results=[]
for row in commands:
    c=row['cmd']; start=c.index('formal/a4/check.sh')
    mode,prop,tag=c[start+2],re.sub(r'^P:', '', c[start+3]),c[start+5]
    p=runs/f'PiDagAuth4-{mode}-{prop}{tag}.log'; cfg=p.with_suffix('.cfg'); text=p.read_text()
    assert text.splitlines()[0]=='# module sha256 '+module_sha,p
    assert text.splitlines()[1]=='# cfg    sha256 '+sha(cfg),p
    assert len(row['tlc_rc'])==1,row
    rc=int(row['tlc_rc'][0]); assert rc in [0,12],(p,rc)
    result='HOLDS' if rc==0 else 'VIOLATED'
    assert ('No error has been found' in text) if rc==0 else ('is violated' in text),p
    states=int(re.findall(r'([\d,]+) distinct states found',text)[-1].replace(',',''))
    logs=re.findall(r'/\\ log = (.*?)(?=\n/\\)',text,re.S)
    events=[]
    if rc==12:
        assert logs,p
        events=[' '.join(e.split()) for e in re.findall(r'\[\s*type\s*\|->.*?\]',logs[-1],re.S)]
    results.append(dict(mode=mode,property=prop,tag=tag,result=result,states=states,tlc_rc=rc,
                        seconds=row['seconds'],workers=int(row['env']['WORKERS']),trace=events,
                        log=str(p.relative_to(root))))
report=dict(module_sha256=module_sha,runs=len(results),exit_counts=dict(collections.Counter(str(r['tlc_rc']) for r in results)),
            max_driver_seconds=max(r['seconds'] for r in results),results=results)
(runs/'PiDagAuth4-results.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')
def find(mode,prop,tag):return next(r for r in results if (r['mode'],r['property'],r['tag'])==(mode,prop,tag))
lines=['| 性质 | a3 | a4 |','|---|---|---|']
for r in results:
    if r['mode']!='a3' or r['tag']!='-scenarios':continue
    p=r['property']; v=find('a4',p,'-scenarios')
    lines.append(f'| {p} | {r["result"]} / {r["states"]} | {v["result"]} / {v["states"]} |')
lines+=['','| 消融 | 相对 a4 翻转的性质 |','|---|---|']
for mode in ['a4-noAuth','a4-noInformed','a4-noRecused','a4-noRel1','a4-noRel2','a4-noRel3']:
    flips=[]
    for r in results:
        if r['mode']!=mode:continue
        base=find('a4',r['property'],'-scenarios')
        if r['result']!=base['result']:flips.append(f'{r["property"]}: {base["result"]}→{r["result"]}')
    lines.append(f'| {mode} | {"；".join(flips) or "无翻转"} |')
lines+=['','| free 检查 | 结果 | distinct states | 实际 TLC rc |','|---|---|---:|---:|']
for r in results:
    if r['tag'] in ['-scenarios','-ablation']:continue
    lines.append(f'| {r["mode"]} {r["property"]} {r["tag"]} | {r["result"]} | {r["states"]} | {r["tlc_rc"]} |')
(runs/'PiDagAuth4-tables.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='results'},indent=2))
