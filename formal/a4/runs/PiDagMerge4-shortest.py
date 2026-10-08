from pathlib import Path
import re,collections,json
R=Path(__file__).resolve().parent
text=(R/'PiDagMerge4-waiverCitation-evidence.dot').read_text()
nodes={};initial=[];edges=collections.defaultdict(list)
for line in text.splitlines():
 m=re.match(r'(-?\d+) \[label="(.*)"(?:,style = filled)?\];?$',line)
 if m:
  key,label=m.groups();label=label.replace(r'\n','\n').replace(r'\"','"').replace(r'\\','\\')
  nodes[key]=label
  if 'style = filled' in line:initial.append(key)
 m=re.match(r'(-?\d+) -> (-?\d+)',line)
 if m: edges[m[1]].append(m[2])
q=collections.deque(initial);prev={k:None for k in initial};end=None
while q:
 k=q.popleft()
 if 'receipts |->\n      << [' in nodes[k]:end=k;break
 for n in edges[k]:
  if n not in prev: prev[n]=k;q.append(n)
assert end is not None
path=[]
while end is not None:path.append(end);end=prev[end]
path.reverse();assert len(path)==10
assert 'waived |-> FALSE' in nodes[path[-1]]
assert 'truth |-> FALSE' in nodes[path[-1]].split('receipts |->',1)[1]
steps=['Init','FGenesis','FObserve(k0,fail,rank=2,accurate=TRUE)','FWaive(k0) at key <<k0,0>>','FEdit(k0,FALSE) to key <<k0,1>>','FObserve(k0,pass,rank=1,accurate=FALSE)','FDefer(k0)','FEnqueue(k0)','FEval(k0)','FCommit(k0)']
out=['# Shortest witness reconstructed from the TLC BFS graph','',
'Module SHA256: `241c794985fbbc7942f1c89dec7726e4b833bf276698cf2ed85a78bf42b3959b`.',
'All initial vertices participate in BFS. The first reachable receipt is at distance **9 transitions**, 10 states. The supplied TLC textual counterexample prints only the prefix through enqueue; the DOT dump contains eval and the violating receipt. This file preserves the complete path from actual dumped vertices instead of claiming that the incomplete textual prefix is a full counterexample.','',
'| State | Incoming action | DOT vertex |','|---|---|---|']
for i,(k,step) in enumerate(zip(path,steps),1):out.append(f'| {i} | {step} | {k} |')
out+=['','The final receipt has `truth=FALSE`, `waived=FALSE`, `deferred=TRUE`, `debt=TRUE`, `nodeDebt=FALSE`, key `<<k0,1>>`. Raw waivers contain only `<<k0,0>>`. The accurate rank-2 negative is not withdrawn in a3 history: the later current-key observation has rank 1, and an item waiver is not a node-wide withdrawal. The a4 current-key assertion instead quotes the old owner waiver (rank 3), whose premises include that negative. This satisfies the contract’s “another affirmative” alternative.','']
for i,k in enumerate(path,1):out+=['## State '+str(i)+' — '+steps[i-1],'','```tla',nodes[k],'```','']
(R/'PiDagMerge4-waiverCitation-shortest.md').write_text('\n'.join(out))
(R/'PiDagMerge4-waiverCitation-shortest.json').write_text(json.dumps({'transitions':9,'vertices':path,'actions':steps,'final_state':nodes[path[-1]]},indent=2)+'\n')
print('Shortest path:',len(path)-1,'transitions; graph',len(nodes),'vertices; initial',len(initial))
