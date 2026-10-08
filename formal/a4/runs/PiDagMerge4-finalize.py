from pathlib import Path
import os,time,subprocess,hashlib,json
R=Path(__file__).resolve().parent; A4=R.parent
pid=int((R/'PiDagMerge4-batch.pid').read_text())
deadline=time.monotonic()+1800

def owned_tlc():
 found=[]
 for p in Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:args=(p/'cmdline').read_bytes().split(b'\0')
  except (FileNotFoundError,PermissionError,ProcessLookupError):continue
  if args and args[0].endswith(b'java') and any(b'PiDagMerge4' in x for x in args):found.append(int(p.name))
 return found

def batch_running():
 try:
  stat=Path(f'/proc/{pid}/stat').read_text();cmd=Path(f'/proc/{pid}/cmdline').read_bytes()
  return stat.split()[2]!='Z' and b'PiDagMerge4-run.py' in cmd
 except FileNotFoundError:return False

while batch_running() or owned_tlc():
 if time.monotonic()>deadline:raise TimeoutError('Owned batch did not finish within finalizer wait bound')
 time.sleep(2)
print('Main batch stopped; owned TLCs:',owned_tlc(),flush=True)
# Same-seed control for the counterexample sampled in noRecused. Recused is
# identically true for the inherited merge environment's disjoint actors.
base='PiDagMerge4-a4-FreeCoreSafety-reproduce-free'
cfg=R/(base+'.cfg');cfg.write_bytes((R/'PiDagMerge4-a4-FreeCoreSafety-simulation-free.cfg').read_bytes())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
cmd=['nice','-n','19','taskset','-c','0','timeout','890','java','-Xmx1g','-XX:+UseParallelGC','-cp','../tla2tools.jar','tlc2.TLC','-noGenerateSpecTE','-workers','1','-metadir',str(R/(base+'.states')),'-simulate','num=10000','-depth','20','-seed','3340778300967657810','-config',str(cfg),'PiDagMerge4.tla']
with (R/(base+'.log')).open('w') as log:
 log.write('# module sha256 '+sha(A4/'PiDagMerge4.tla')+'\n# cfg    sha256 '+sha(cfg)+'\n# flags  <deadlock checked> -simulate num=10000 -depth 20 -seed 3340778300967657810\n# argv '+json.dumps(cmd)+'\n');log.flush()
 p=subprocess.run(cmd,cwd=str(A4),stdout=log,stderr=subprocess.STDOUT,timeout=900);log.write('\nTLC_EXIT='+str(p.returncode)+'\n')
print('Same-seed a4 control TLC exit:',p.returncode,flush=True)
if p.returncode not in [0,12]:raise RuntimeError('Same-seed control failed: '+str(p.returncode))
env=os.environ.copy();env.update(WORKERS='1',TLC_HEAP='512m',TLC_TIMEOUT='60',SIMULATE='num=100',DEPTH='20')
cmd=['nice','-n','19','taskset','-c','0','bash','-x',str(A4/'check.sh'),'PiDagMerge4','a4','Projection4','Scenario = "free"; O = o; K0 = k0; K1 = k1','-projection-free']
with (R/'PiDagMerge4-command-projection.log').open('w') as log:
 log.write(json.dumps({'argv':cmd,'env':{k:env[k] for k in ['WORKERS','TLC_HEAP','TLC_TIMEOUT','SIMULATE','DEPTH']}})+'\n');log.flush()
 p=subprocess.run(cmd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=70);log.write('\nWRAPPER_EXIT='+str(p.returncode)+'\n')
print('Projection self-check wrapper exit:',p.returncode,flush=True)
if p.returncode:raise RuntimeError('Projection check failed')
projection=(R/'PiDagMerge4-a4-Projection4-projection-free.log').read_text()
assert 'Finished in ' in projection and 'Error:' not in projection
for script in ['summary','coverage','audit','report']:
 subprocess.run(['python3',str(R/f'PiDagMerge4-{script}.py')],check=True,timeout=20)
coverage=json.loads((R/'PiDagMerge4-coverage.json').read_text())
assert coverage['complete'],coverage
assert not owned_tlc(),owned_tlc()
(R/'PiDagMerge4-finalize-receipt.json').write_text(json.dumps({'module_sha256':sha(A4/'PiDagMerge4.tla'),'planned_checks_complete':True,'owned_tlc_pids':owned_tlc(),'publication':'none','parent_acceptance':'not claimed'},indent=2)+'\n')
print('FINALIZER_COMPLETE',flush=True)
