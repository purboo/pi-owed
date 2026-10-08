#!/usr/bin/env python3
"""Extract results from completed current-module logs; does not run TLC."""
import csv
import hashlib
import re
from collections import Counter
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
RUNS = ROOT / 'formal/a3/runs'
SHA = hashlib.sha256((ROOT / 'formal/a3/PiDagMerge.tla').read_bytes()).hexdigest()
rows = []
def last(pattern, text):
    hits = re.findall(pattern, text)
    return hits[-1].replace(',', '') if hits else ''
for path in sorted(RUNS.glob('PiDagMerge-*.log')):
    text = path.read_text()
    if not text.startswith('# module sha256 ' + SHA):
        continue
    cfg = path.with_suffix('.cfg').read_text()
    if re.search(r'is violated|was violated|Temporal properties were violated', text):
        status = 'VIOLATED'
    elif 'Random Simulation' in text and 'Finished in' in text and 'Error:' not in text:
        status = 'HOLDS-SIM'
    elif 'No error has been found' in text:
        status = 'HOLDS'
    elif path.name.endswith('NoBypassedNegative-free-exhaustive.log') and 'Finished in' not in text:
        status = 'TIMEOUT(124)'
    else:
        status = 'ERROR/INCOMPLETE'
    row = dict(log=path.name, mode=last(r'Mode = "([^"]+)"', cfg),
        scenario=last(r'Scenario = "([^"]+)"', cfg),
        property=last(r'(?:INVARIANT|PROPERTY) (\w+)', cfg), status=status,
        distinct=last(r'([\d,]+) distinct states found', text),
        generated=last(r'(?:The number of states generated: )([\d,]+)', text)
                  or last(r'([\d,]+) states generated,', text),
        checked=last(r'([\d,]+) states checked', text),
        traces=last(r'([\d,]+) traces generated', text),
        trace_steps=str(max([int(v) for v in re.findall(r'^State (\d+):', text, re.M)], default=0)-1),
        seed=last(r'(?:Simulation using seed |seed )(-?\d+)', text),
        module_sha=SHA)
    rows.append(row)
with (RUNS / 'PiDagMerge-results.tsv').open('w') as out:
    writer = csv.DictWriter(out, fieldnames=rows[0].keys(), delimiter='\t')
    writer.writeheader()
    writer.writerows(rows)
print('module_sha=' + SHA)
print('checks=' + str(len(rows)) + ' ' + str(dict(Counter(r['status'] for r in rows))))
for row in rows:
    if row['scenario'].startswith(('free', 'replay')):
        print({k: v for k, v in row.items() if k not in {'module_sha', 'log', 'seed'}})
