from pathlib import Path
import csv,json,hashlib
A4=Path(__file__).resolve().parent.parent;A3=A4.parent/'a3';R=A4/'runs'
old=list(csv.DictReader((A3/'runs/PiDagMerge-results.tsv').open(),delimiter='\t'))
new=list(csv.DictReader((R/'PiDagMerge4-results.tsv').open(),delimiter='\t'))
by={(x['scenario'],x['property']):x for x in new if x['mode']=='a3' and '-matrix-' in x['log'] and x['status'] in ['HOLDS','VIOLATED']}
comparison=[]
for o in old:
 if o['mode']!='a3' or (o['scenario'],o['property']) not in by:continue
 z=by[o['scenario'],o['property']];comparison.append({'scenario':o['scenario'],'property':o['property'],'old':o['status'],'new':z['status'],'old_distinct':o['distinct'],'new_distinct':z['distinct']})
assert all(x['old']==x['new'] and x['old_distinct']==x['new_distinct'] for x in comparison)
marker='\\* Independent reference predicates use historical observations, immutable'
source3=(A3/'PiDagMerge.tla').read_text();source4=(A4/'PiDagMerge4.tla').read_text()
assert source3[source3.index(marker):]==source4[source4.index(marker):]
assert (A3/'check.sh').read_bytes()==(A4/'check.sh').read_bytes()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report={'module_sha256':sha(A4/'PiDagMerge4.tla'),'a3_module_sha256':sha(A3/'PiDagMerge.tla'),'check_sh_sha256':sha(A4/'check.sh'),'check_sh_exact_copy':True,'ground_truth_tail_identical':True,'ground_truth_tail_bytes':len(source4[source4.index(marker):].encode()),'recorded_a3_intersections':len(comparison),'recorded_a3_result_and_state_counts_unchanged':True,'baseline_comparison':comparison}
(R/'PiDagMerge4-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('Audit:',report['module_sha256'],'ground truth identical, check.sh exact copy,',len(comparison),'baseline result/state-count matches')
