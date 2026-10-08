from pathlib import Path
import re,hashlib,csv,collections,difflib,json
R=Path(__file__).resolve().parent
module=R.parent/'PiDagMerge4.tla'
sha=hashlib.sha256(module.read_bytes()).hexdigest()
rows=[]
for log in sorted(R.glob('PiDagMerge4-*.log')):
 text=log.read_text(errors='replace')
 if not text.startswith('# module sha256 '+sha): continue
 cfg=log.with_suffix('.cfg')
 if not cfg.exists():continue
 c=cfg.read_text(); mode=re.search(r'Mode = "([^"]+)"',c).group(1); scenario=re.search(r'Scenario = "([^"]+)"',c).group(1)
 prop=re.search(r'(?:INVARIANT|PROPERTY) (\w+)',c).group(1)
 if 'Deadlock reached' in text: status='DEADLOCK'
 elif re.search(r'is violated|was violated|Temporal properties were violated',text): status='VIOLATED'
 elif 'No error has been found' in text: status='HOLDS'
 elif 'Finished in ' in text and 'Error:' not in text and '<exhaustive>' not in text: status='HOLDS-SIM'
 elif 'Error:' in text:status='ERROR'
 else:status='INCOMPLETE'
 def find(pattern):
  m=list(re.finditer(pattern,text));return m[-1].group(1).replace(',','') if m else ''
 steps=[int(x) for x in re.findall(r'^State (\d+):',text,re.M)]
 if scenario=='replayWaiverCitation' and status=='VIOLATED':
  # This TLC build omits the final eval/commit pair in its textual free trace.
  # The separately dumped BFS graph and PiDagMerge4-shortest.py establish 9.
  steps=[json.loads((R/'PiDagMerge4-waiverCitation-shortest.json').read_text())['transitions']+1]
 rows.append(dict(log=log.name,mode=mode,scenario=scenario,property=prop,status=status,distinct=find(r'([\d,]+) distinct states found'),checked=find(r'([\d,]+) states checked'),traces=find(r'([\d,]+) traces generated'),steps=max(steps)-1 if steps else '',seed=find(r'(?:seed |seed = )(-?\d+)'),module_sha=sha))
with (R/'PiDagMerge4-results.tsv').open('w') as f:
 w=csv.DictWriter(f,fieldnames=['log','mode','scenario','property','status','distinct','checked','traces','steps','seed','module_sha'],delimiter='\t');w.writeheader();w.writerows(rows)
original=R.parents[1]/'a3/PiDagMerge.tla'
a=original.read_text();b=module.read_text()
assert a.split('\\* Independent reference predicates',1)[1]==b.split('\\* Independent reference predicates',1)[1]
assert (R.parent/'check.sh').read_bytes()==(R.parents[1]/'a3/check.sh').read_bytes()
(R/'PiDagMerge4-diff.patch').write_text(''.join(difflib.unified_diff(a.splitlines(True),b.splitlines(True),fromfile='formal/a3/PiDagMerge.tla',tofile='formal/a4/PiDagMerge4.tla')))
print('SHA',sha,'checks',len(rows),dict(collections.Counter(r['status'] for r in rows)))
base={(r['scenario'],r['property'],r['mode']):r for r in rows if '-matrix-' in r['log']}
for (s,p,m),r in base.items():
 if m=='a3' and (s,p,'a4') in base:
  z=base[s,p,'a4']
  if r['status'] in ['HOLDS','VIOLATED'] and z['status'] in ['HOLDS','VIOLATED'] and r['status']!=z['status']:print('DIVERGENCE',s,p,r['status'],z['status'],r['steps'],z['steps'])
for r in rows:
 if r['mode'].startswith('a4-'):
  z=base.get((r['scenario'],r['property'],'a4'))
  if z and r['status'] in ['HOLDS','VIOLATED'] and r['status']!=z['status']: print('FLIP',r['mode'],r['scenario'],r['property'],z['status'],r['status'])
