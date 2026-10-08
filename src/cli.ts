import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan } from './plan.ts';
import { OwedError } from './errors.ts';
import { renderReceipt, renderStatus, renderReport, renderEntry } from './views.ts';
import type { Entry } from './types.ts';
import type { Channel, Principal, Role } from './types.ts';
const HELP = `owed — 多代理验收账本\n用法：owed <命令> [参数] [--json] [--as role:id]\ninit <plan.yaml> | plan <plan.yaml> | rule <text> --nodes a,b|*\ndispatch <node> | submit <node> [--commit X] | attest <node> [--rerun]\nreview <node> --ok|--block --rank N [--note TEXT] [--ack-rulings N] [--obligation review|closure-review]\nwaive <node> <obligation> --reason TEXT [--accept-risk 12,15]\ndefer <node> <inv-id...> --reason TEXT | abandon <node> [--reason TEXT]\nmerge <node> | status | why <node> | report [--since seq|ISO] | verify\nowner 操作需要 TTY 确认或 --i-am-owner（flag 弱确认）。`;
const values = new Set(['as','commit','nodes','rank','note','ack-rulings','obligation','reason','accept-risk','since']);
const flags = new Set(['json','i-am-owner','rerun','ok','block','help']);
function usage(message:string): never { throw new OwedError(message,'usage'); }
export async function main(argv: string[]): Promise<number> {
  try {
    const args:string[] = [], opts = new Map<string,string|boolean>();
    for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (!a.startsWith('--')) { args.push(a); continue; } const [key,...rest]=a.slice(2).split('='); if (!key || (!values.has(key) && !flags.has(key))) usage(`未知选项 ${a}`); if (opts.has(key)) usage(`重复选项 --${key}`); if (flags.has(key)) { if(rest.length) usage(`${a} 不接受值`); opts.set(key,true); } else { const v=rest.length ? rest.join('=') : argv[++i]; if(v === undefined || v.startsWith('--')) usage(`--${key} 缺少值`); opts.set(key,v); } }
    if (opts.has('help')) { console.log(HELP); return 0; }
    const cmd=args.shift(); if(!cmd) usage(HELP);
    const allowed:Record<string,string[]> = { init:[],plan:[],rule:['nodes'],dispatch:[],submit:['commit'],attest:['rerun'],review:['ok','block','rank','note','ack-rulings','obligation'],waive:['reason','accept-risk'],defer:['reason'],abandon:['reason'],merge:[],status:[],why:[],report:['since'],verify:[] };
    if (!allowed[cmd]) usage(`未知命令 ${cmd}`);
    for (const k of opts.keys()) if (!['json','as','i-am-owner'].includes(k) && !allowed[cmd]!.includes(k)) usage(`${cmd} 不支持 --${k}`);
    const count = cmd === 'waive' || cmd === 'defer' ? 2 : ['status','report','verify'].includes(cmd) ? 0 : 1;
    if(args.length < count || (cmd !== 'defer' && args.length !== count)) usage(`${cmd} 参数数量错误`);
    const value = (key:string,required=false):string|undefined => { const v=opts.get(key); if(required && (typeof v !== 'string' || !v.trim())) usage(`需要 --${key}`); return typeof v === 'string' ? v : undefined; };
    const integer=(key:string,required=false):number|undefined => { const v=value(key,required); if(v === undefined) return undefined; if(!/^\d+$/.test(v)) usage(`--${key} 必须为非负整数`); return Number(v); };
    const cwd=process.cwd(); let principal:Principal={role:'parent',id:'cli'};
    if(opts.has('as')) { const match=/^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value('as')!); if(!match) usage('--as 必须为 role:id'); principal={role:match[1] as Role,id:match[2]!}; }
    else if(['init','waive','defer'].includes(cmd) || opts.has('i-am-owner')) principal={role:'owner',id:'human'};
    else if(cmd === 'submit') { const s=await ops.status({cwd}), slot=s.nodes[args[0]!]?.slot; if(slot && resolve(await git.repoRoot(cwd)) === resolve(slot.worktree)) principal={role:'writer',id:slot.writer.slice(7)}; }
    let channel:Channel|undefined;
    if(principal.role === 'owner') {
      if(opts.has('i-am-owner')) channel='flag';
      else { if(!process.stdin.isTTY || !process.stdout.isTTY) throw new OwedError('owner 操作需要 TTY 确认或 --i-am-owner'); const rl=createInterface({input:process.stdin,output:process.stdout}); try { const answer=await rl.question(`以 owner 身份执行 ${cmd}？输入 yes 确认：`); if(answer !== 'yes') throw new OwedError('owner 未确认'); channel='tty'; } finally { rl.close(); } }
    }
    const actor={cwd,as:principal,channel}, node=args[0]!;
    let result:unknown, text:string|undefined, exit=0;
    switch(cmd) {
      case 'init': { const r=await ops.init({...actor,channel:channel!,plan:await readFile(resolve(cwd,node),'utf8')}); result=r; text=`${renderEntry(r.entry)}\n初始观察 ${r.observations.length} 条\n${renderStatus(r.status)}`; break; }
      case 'plan': result=await ops.planSet({...actor,plan:await readFile(resolve(cwd,node),'utf8')}); break;
      case 'rule': { const nodes=value('nodes',true)!; result=await ops.rule({...actor,text:node,nodes:nodes === '*' ? '*' : nodes.split(',')}); break; }
      case 'dispatch': { const r=await ops.dispatch({...actor,node}); result=r; text=`${r.packet}\n\n---\n已派发 ${r.node} attempt ${r.attempt}\nworktree：${r.worktree}\nbranch：${r.branch}\nwriter 在 worktree 内 commit 后运行 owed submit ${r.node}`; break; }
      case 'submit': result=await ops.submit({...actor,node,commit:value('commit')}); break;
      case 'attest': { const r=await ops.attest({cwd,node,rerun:opts.has('rerun')}); result=r; text=renderReceipt(r.receipt); exit=r.accepted ? 0 : 1; break; }
      case 'review': { if(opts.has('ok') === opts.has('block')) usage('review 需要 --ok 或 --block'); const obligation=value('obligation'); if(obligation && !['review','closure-review'].includes(obligation)) usage('无效 review obligation'); result=await ops.review({...actor,node,verdict:opts.has('ok')?'ok':'block',rank:integer('rank',true)!,note:value('note') ?? '',ack_rulings:integer('ack-rulings'),obligation:obligation as 'review'|'closure-review'|undefined}); break; }
      case 'waive': { const risk=value('accept-risk'); if(risk && !/^\d+(,\d+)*$/.test(risk)) usage('accept-risk 必须为 seq 列表'); result=await ops.waive({...actor,channel:channel!,node,obligation:args[1]!,reason:value('reason',true)!,accept_risk:risk?.split(',').map(Number)}); break; }
      case 'defer': { const s=await ops.status({cwd}), n=s.nodes[node]; if(!n?.candidate) throw new OwedError('defer 需要当前候选'); const ledger=await Ledger.open(cwd), entries=await ledger.read(), law=entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis'); if(!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('缺少计划'); const plan=parsePlan((await ledger.getBlob(law.plan)).toString()); const m=await git.buildMerge(cwd,s.trunk.commit,n.candidate.commit,`owed merge ${node}`); if('conflicts' in m) throw new OwedError('rebase needed'); const facts=await git.stateFacts(cwd,plan,m.commit); result=await ops.defer({...actor,channel:channel!,node,items:args.slice(1).map(id => ({id,key:facts.invKeys[id] ?? ''})),reason:value('reason',true)!}); break; }
      case 'abandon': result=await ops.abandon({...actor,node,reason:value('reason') ?? ''}); break;
      case 'merge': { const r=await ops.merge({...actor,node}); result=r; text=`${renderEntry(r.entry)}\n主干已推进到 ${r.commit}${r.deferred.length ? `\n缓判债务仍保留：${r.deferred.map(i => `${i.subject}/${i.obligation}`).join('、')}` : ''}`; break; }
      case 'status': { const r=await ops.status({cwd}); result=r; text=renderStatus(r); break; }
      case 'why': { const r=await ops.why({cwd,node}); result=r; text=renderReceipt(r); break; }
      case 'report': { const v=value('since'), r=await ops.report({cwd,since:v && /^\d+$/.test(v) ? Number(v) : v}); result=r; text=renderReport(r); break; }
      case 'verify': { const r=await ops.verify({cwd}); result=r; text=r.ok ? `账本验证通过：${r.entries} 条记录` : `账本验证失败：${r.error}`; exit=r.ok ? 0 : 3; break; }
    }
    if(text === undefined) { const e=result as Entry; text=renderEntry(e); if(['submit','review','waive','abandon'].includes(cmd)) text+=`\n${renderReceipt(await ops.why({cwd,node}))}`; }
    console.log(opts.has('json') ? JSON.stringify(result) : text); return exit;
  } catch(e) { const error=e instanceof OwedError ? e : new OwedError(e instanceof Error ? e.message : String(e),'internal'); console.error(`${error.code === 'usage' ? '用法错误' : error.code === 'refused' ? '拒绝' : '内部错误'}：${error.message}`); return error.code === 'usage' ? 2 : error.code === 'refused' ? 1 : 3; }
}
