import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan } from './plan.ts';
import { OwedError } from './errors.ts';
import { renderReceipt, renderStatus, renderReport, renderEntry, renderBrief, renderGc, renderAdoptPreview } from './views.ts';
import type { Entry } from './types.ts';
import type { Channel, EscapeClass, Principal, Role } from './types.ts';
const HELP = `owed — multi-agent acceptance ledger\nUsage: owed <command> [arguments] [--json] [--as role:id]\ninit <plan.yaml> | plan <plan.yaml> [--rev COMMIT] | rule <text> --nodes a,b|*\ndispatch <node> [--allow-overlap] | submit <node> [--commit X] | rebase <node> | attest <node> [--rerun]\nreview <node> --ok|--block --rank N [--note TEXT] [--ack-rulings N] [--obligation review|closure-review]\nwaive <node> <obligation> --reason TEXT [--accept-risk 12,15]\ndefer <node> <inv-id...> --reason TEXT | abandon <node> [--note TEXT]\nmerge <node> | adopt [--commit X] --note TEXT (owner: record trunk commits made outside owed) | status | why <node> | report [--since seq|ISO] | brief [--since seq|ISO] | verify\nescape <node> --merge N --class missing|false-pass|reuse|weak|waiver --note TEXT [--evidence TEXT]\ndecoy commit <digest> | decoy reveal <file.json> | decoy digest <file.json>\ngc [--dry-run]  (parent/owner: reclaim worktrees/branches of merged or abandoned attempts)\nowner actions require TTY confirmation or --i-am-owner (flag weak confirmation).`;
const values = new Set(['as','commit','nodes','rank','note','ack-rulings','obligation','reason','accept-risk','since','merge','class','evidence','rev']);
const flags = new Set(['json','i-am-owner','rerun','ok','block','help','dry-run','allow-overlap']);
function usage(message:string): never { throw new OwedError(message,'usage'); }
/** Terminal I/O of the CLI; tests inject `ask` (the owner's answer to the TTY prompt) and capture output. */
export interface CliIo { ask?: (question: string) => Promise<string>; log: (text: string) => void; error: (text: string) => void }
const terminal: CliIo = { log: text => console.log(text), error: text => console.error(text) };
export async function main(argv: string[], io: CliIo = terminal): Promise<number> {
  try {
    const args:string[] = [], opts = new Map<string,string|boolean>();
    for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (!a.startsWith('--')) { args.push(a); continue; } const [key,...rest]=a.slice(2).split('='); if (!key || (!values.has(key) && !flags.has(key))) usage(`Unknown option ${a}`); if (opts.has(key)) usage(`Duplicate option --${key}`); if (flags.has(key)) { if(rest.length) usage(`${a} does not accept a value`); opts.set(key,true); } else { const v=rest.length ? rest.join('=') : argv[++i]; if(v === undefined || v.startsWith('--')) usage(`--${key} requires a value`); opts.set(key,v); } }
    if (opts.has('help')) { io.log(HELP); return 0; }
    const cmd=args.shift(); if(!cmd) usage(HELP);
    const allowed:Record<string,string[]> = { init:[],plan:['rev'],rule:['nodes'],dispatch:['allow-overlap'],submit:['commit'],rebase:[],attest:['rerun'],review:['ok','block','rank','note','ack-rulings','obligation'],waive:['reason','accept-risk'],defer:['reason'],abandon:['note','reason'],merge:[],status:[],why:[],report:['since'],brief:['since'],verify:[],escape:['merge','class','note','evidence'],decoy:[],gc:['dry-run'],adopt:['commit','note'] };
    if (!allowed[cmd]) usage(`Unknown command ${cmd}`);
    for (const k of opts.keys()) if (!['json','as','i-am-owner'].includes(k) && !allowed[cmd]!.includes(k)) usage(`${cmd} does not support --${k}`);
    const count = cmd === 'waive' || cmd === 'defer' || cmd === 'decoy' ? 2 : ['status','report','brief','verify','gc','adopt'].includes(cmd) ? 0 : 1;
    if(args.length < count || (cmd !== 'defer' && args.length !== count)) usage(`${cmd} wrong number of arguments`);
    if(cmd === 'decoy' && !['commit','reveal','digest'].includes(args[0]!)) usage('decoy requires commit <digest>, reveal <file.json> or digest <file.json>');
    const value = (key:string,required=false):string|undefined => { const v=opts.get(key); if(required && (typeof v !== 'string' || !v.trim())) usage(`Required: --${key}`); return typeof v === 'string' ? v : undefined; };
    const integer=(key:string,required=false):number|undefined => { const v=value(key,required); if(v === undefined) return undefined; if(!/^\d+$/.test(v)) usage(`--${key} must be a nonnegative integer`); return Number(v); };
    if(cmd === 'adopt') value('note',true);
    const cwd=process.cwd(); let principal:Principal={role:'parent',id:'cli'};
    if(opts.has('as')) { const match=/^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value('as')!); if(!match) usage('--as must be role:id'); principal={role:match[1] as Role,id:match[2]!}; }
    else if(['init','waive','defer','adopt'].includes(cmd) || (cmd === 'decoy' && args[0] !== 'digest') || opts.has('i-am-owner')) principal={role:'owner',id:'human'};
    else if(cmd === 'submit' || cmd === 'rebase') { const s=await ops.status({cwd}), slot=s.nodes[args[0]!]?.slot; if(slot && resolve(await git.repoRoot(cwd)) === resolve(slot.worktree)) principal={role:'writer',id:slot.writer.slice(7)}; }
    let channel:Channel|undefined, adoptCommit:string|undefined;
    // The owner confirms what is adopted: the preview is printed first and its commit is pinned, so a ref moving after the confirmation is refused.
    if(cmd === 'adopt' && principal.role === 'owner') { const p=await ops.adoptPreview({cwd,commit:value('commit')}); io.error(renderAdoptPreview(p,value('note')!)); adoptCommit=p.commit; }
    if(principal.role === 'owner') {
      if(opts.has('i-am-owner')) channel='flag';
      else if(io.ask) { if(await io.ask(`Execute ${cmd} as owner? Type yes to confirm: `) !== 'yes') throw new OwedError('owner did not confirm'); channel='tty'; }
      else { if(!process.stdin.isTTY || !process.stdout.isTTY) throw new OwedError('owner actions require TTY confirmation or --i-am-owner'); const rl=createInterface({input:process.stdin,output:process.stdout}); try { const answer=await rl.question(`Execute ${cmd} as owner? Type yes to confirm: `); if(answer !== 'yes') throw new OwedError('owner did not confirm'); channel='tty'; } finally { rl.close(); } }
    }
    const actor={cwd,as:principal,channel}, node=args[0]!;
    let result:unknown, text:string|undefined, exit=0;
    switch(cmd) {
      case 'init': { const r=await ops.init({...actor,channel:channel!,plan:await readFile(resolve(cwd,node),'utf8')}); result=r; text=`${renderEntry(r.entry)}\nInitial observations: ${r.observations.length}\n${renderStatus(r.status)}`; break; }
      case 'plan': result=await ops.planSet({...actor,...await ops.readPlan({cwd,path:node,rev:value('rev')})}); break;
      case 'rule': { const nodes=value('nodes',true)!; result=await ops.rule({...actor,text:node,nodes:nodes === '*' ? '*' : nodes.split(',')}); break; }
      case 'dispatch': { const r=await ops.dispatch({...actor,node,allowOverlap:opts.has('allow-overlap')}); result=r; text=`${r.packet}\n\n---\nDispatched ${r.node} attempt ${r.attempt}\nworktree: ${r.worktree}\nbranch: ${r.branch}\nwriter: commit in the worktree, then run owed submit ${r.node}`; break; }
      case 'submit': result=await ops.submit({...actor,node,commit:value('commit')}); break;
      case 'rebase': { const r=await ops.rebase({...actor,node}); result=r; text=`${renderEntry(r.entry)}\n${r.packet}\n${renderReceipt(await ops.why({cwd,node}))}`; break; }
      case 'attest': { const r=await ops.attest({cwd,node,rerun:opts.has('rerun')}); result=r; text=renderReceipt(r.receipt); exit=r.accepted ? 0 : 1; break; }
      case 'review': { if(opts.has('ok') === opts.has('block')) usage('review requires --ok or --block'); const obligation=value('obligation'); if(obligation && !['review','closure-review'].includes(obligation)) usage('Invalid review obligation'); result=await ops.review({...actor,node,verdict:opts.has('ok')?'ok':'block',rank:integer('rank',true)!,note:value('note') ?? '',ack_rulings:integer('ack-rulings'),obligation:obligation as 'review'|'closure-review'|undefined}); break; }
      case 'waive': { const risk=value('accept-risk'); if(risk && !/^\d+(,\d+)*$/.test(risk)) usage('accept-risk must be a list of seq numbers'); result=await ops.waive({...actor,channel:channel!,node,obligation:args[1]!,reason:value('reason',true)!,accept_risk:risk?.split(',').map(Number)}); break; }
      case 'defer': { const s=await ops.status({cwd}), n=s.nodes[node]; if(!n?.candidate) throw new OwedError('defer requires a current candidate'); const ledger=await Ledger.open(cwd), entries=await ledger.read(), law=entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis'); if(!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('Missing plan'); const plan=parsePlan((await ledger.getBlob(law.plan)).toString()); const m=await git.buildMerge(cwd,s.trunk.commit,n.candidate.commit,`owed merge ${node}`); if('conflicts' in m) throw new OwedError('rebase needed'); const facts=await git.stateFacts(cwd,plan,m.commit); result=await ops.defer({...actor,channel:channel!,node,items:args.slice(1).map(id => ({id,key:facts.invKeys[id] ?? ''})),reason:value('reason',true)!}); break; }
      case 'abandon': { if(opts.has('note') && opts.has('reason')) usage('abandon takes --note (or its older spelling --reason), not both'); result=await ops.abandon({...actor,node,reason:value('note') ?? value('reason') ?? ''}); break; }
      case 'merge': { const r=await ops.merge({...actor,node}); result=r; text=`${renderEntry(r.entry)}\nTrunk advanced to ${r.commit}${r.deferred.length ? `\nDeferred debt remains: ${r.deferred.map(i => `${i.subject}/${i.obligation}`).join(', ')}` : ''}`; break; }
      case 'adopt': { const note=value('note',true)!; const r=await ops.adopt({...actor,channel:channel!,commit:adoptCommit ?? value('commit'),note}); result=r; text=`${renderEntry(r.entry)}\nInvariant observations: ${r.observations.length}\nLedger trunk ${r.trunk} is now ${r.commit}`; break; }
      case 'status': { const r=await ops.status({cwd}); result=r; text=renderStatus(r); break; }
      case 'why': { const r=await ops.why({cwd,node}); result=r; text=renderReceipt(r); break; }
      case 'report': { const v=value('since'), r=await ops.report({cwd,since:v && /^\d+$/.test(v) ? Number(v) : v}); result=r; text=renderReport(r); break; }
      case 'brief': { const v=value('since'), r=await ops.brief({cwd,since:v && /^\d+$/.test(v) ? Number(v) : v}); result=r; text=renderBrief(r); break; }
      case 'escape': { const cls=value('class',true)!; if(!['missing','false-pass','reuse','weak','waiver'].includes(cls)) usage('--class must be missing, false-pass, reuse, weak or waiver'); result=await ops.escape({...actor,node,merge:integer('merge',true)!,class:cls as EscapeClass,note:value('note',true)!,evidence:value('evidence')}); break; }
      case 'decoy': { const file=resolve(cwd,args[1]!); if(args[0] === 'digest') { const r=ops.decoyDigest(await readFile(file,'utf8')); result=r; text=r.digest; } else if(args[0] === 'commit') result=await ops.decoyCommit({...actor,channel:channel!,digest:args[1]!}); else result=await ops.decoyReveal({...actor,channel:channel!,payload:await readFile(file,'utf8')}); break; }
      case 'verify': { const r=await ops.verify({cwd}); result=r; text=r.ok ? `Ledger verification passed: ${r.entries} entries` : `Ledger verification failed:${r.error}`; exit=r.ok ? 0 : 3; break; }
      case 'gc': { const r=await ops.gc({...actor,dryRun:opts.has('dry-run')}); result=r; text=renderGc(r); break; }
    }
    if(text === undefined) { const e=result as Entry; text=renderEntry(e); if(['submit','review','waive','abandon'].includes(cmd)) text+=`\n${renderReceipt(await ops.why({cwd,node}))}`; }
    io.log(opts.has('json') ? JSON.stringify(result) : text!); return exit;
  } catch(e) { const error=e instanceof OwedError ? e : new OwedError(e instanceof Error ? e.message : String(e),'internal'); io.error(`${error.code === 'usage' ? 'Usage error' : error.code === 'refused' ? 'Refused' : 'Internal error'}: ${error.message}`); return error.code === 'usage' ? 2 : error.code === 'refused' ? 1 : 3; }
}
