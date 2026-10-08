from pathlib import Path
import runpy,csv,json,collections,hashlib
R=Path(__file__).resolve().parent
plan=runpy.run_path(str(R/'PiDagMerge4-run.py'))
jobs=list(plan['jobs'])
for mode in ['a4','a4-noAuth','a4-noInformed','a4-noRecused','a4-noRel1','a4-noRel2','a4-noRel3']:
 jobs.append(('free',mode,plan['freeprops'] if mode=='a4' else ['FreeCoreSafety'],True,'simulation'))
for sc in ['replayNegative','replayDeferred']:
 for mode in ['a3','a4']:jobs.append((sc,mode,['FreeCoreSafety'],True,'simulation'))
expected=[]
for sc,mode,props,sim,tag in jobs:
 for p in props:
  prop=p.removeprefix('P:') if hasattr(p,'removeprefix') else (p[2:] if p.startswith('P:') else p)
  expected.append((f'PiDagMerge4-{mode}-{prop}-{tag}-{sc}.log',sim))
rows=list(csv.DictReader((R/'PiDagMerge4-results.tsv').open(),delimiter='\t'))
by={r['log']:r for r in rows};missing=[];bad_budget=[]
for name,sim in expected:
 r=by.get(name,{})
 if r.get('status') not in ['HOLDS','HOLDS-SIM','VIOLATED']:missing.append(name)
 if sim and r.get('status')=='HOLDS-SIM' and int(r.get('traces') or '0')!=10000:bad_budget.append(name)
sha=hashlib.sha256((R.parent/'PiDagMerge4.tla').read_bytes()).hexdigest()
assert all(r['module_sha']==sha for r in rows)
receipt={'module_sha256':sha,'expected_checks':len(expected),'present_checks':len(rows),'completed_expected_checks':len(expected)-len(missing),'missing_or_incomplete':missing,'wrong_simulation_budget':bad_budget,'statuses':dict(collections.Counter(r['status'] for r in rows)),'complete':not missing and not bad_budget}
(R/'PiDagMerge4-coverage.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2) if len(missing)<8 else json.dumps({k:v for k,v in receipt.items() if k!='missing_or_incomplete'})+'; missing='+str(len(missing)))
