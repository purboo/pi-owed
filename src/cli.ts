import { TRY_FORMS, validateTry } from './checktry.ts';
import { followedBy, followText, parseWatchCursor, watchDriver, watchText } from './watch.ts';
import { alreadyRecordedText } from './identical-acts.ts';
import { idle, idleExit, idleText } from './watchdog.ts';
import { adoptWaitMs } from './adopt-wait.ts';
import { withWritesSyntax } from './writes.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { attestExit, measuredFailure, parentOverlapWarnings } from './parentops.ts';
import { renderMetrics } from './metrics.ts';
import { renderCost } from './cost.ts';
import { renderCounterfactual } from './counterfactual.ts';
import { answerText, ruleText } from './answer.ts';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { drive } from './drive-run.ts';
import { driveStart, driveStatus, driveStop, readyHint, readyHintText, renderDriveStart, renderDriveStatus, renderDriveStop } from './drive-bg.ts';
import { parsePlan, planWarnings, invariantId, quarantineNames } from './plan.ts';
import { OWED_VERSION, OwedError } from './errors.ts';
import { renderSweep, unguardedText } from './sweep.ts';
import { leaseText } from './lease.ts';
import { renderReceipt, renderWhy, renderStatus, renderReport, renderEntry, renderBrief, renderGc, renderAdoptPreview, waiverRecordedText, oneLine, allowanceLabel, carryLine, notCarriedLine, amendLines, measuredPendingText } from './views.ts';
import type { Entry } from './types.ts';
import type { Channel, EscapeClass, Principal, Role } from './types.ts';
const HELP = `owed — multi-agent acceptance ledger\nUsage: owed <command> [arguments] [--json] [--as role:id]\n--version | version (print the owed package version)\nstage <node> --file BUNDLE.json (prepare a decision for the parent)\naccept <stage-id> [--amend TEXT] | accept --all-b (parent/owner: apply staged decisions)\nreject <stage-id> --note TEXT | stages [--all] | overturn <seq> --note TEXT\nstart [--plan FILE] [--max N] [--stay] [--restart] (preflight, init or update the plan, then start or reuse the background driver)\ndecide <node[,node...]> --text TEXT [--writes +PATH ...] [--allow-only p1,p2] [--defer INV] [--resume|--no-resume] [--after NODE] [--expect report] [--remeasure] [--writer] (one atomic decision, answer and recovery)\nanswer <node> [--qid Q] [--rid R] [--rev N] [--expect report] "<text>" (record an answer ruling and deliver it to the asking run)\ninit <plan.yaml> | plan <plan.yaml> [--rev COMMIT] [--note TEXT] | rule <text> --nodes a,b|* [--writer|--prospective]\nedit <node[,node...]> --set path=yaml ... [--unset path ...] [--node-new] [--rule TEXT [--writer]] [--resume [--after a,b] [--expect report]] --note WHY [--dry-run] [--plan FILE] (exact existing IDs and --node-new stay literal; otherwise commas separate trimmed, non-empty IDs; for a colliding batch use owed_edit nodes or separate edits) | edit --invariant ID --set field=yaml --note WHY | edit --drive --set path=yaml [--unset path] --note WHY\namend <node> --writes +PATH[,+PATH...] --note LIMIT [--plan FILE]  (widen one node's writes: edits the plan file (default: the latest plan entry's path), records it as owed plan would (same authority) and a ruling with the limit)\ndispatch <node> [--allow-overlap] | submit <node> [--commit X] [--model MODEL] | rebase <node> [--apply] [--full] [--json] [--as role:id] [--i-am-owner] [--help] | attest <node> [--rerun] [--full] | attest <node> --probe-trunk [--check ID] [--runs N] (diagnostic trunk checks, N 1–10; exit 0 passed, 1 failed/CAS, 2 usage) | attest <node> --remeasure [--all] (measure failed merge-tree invariants again on the same merge key) | attest --genesis (measure genesis invariants still lacking an observation) | attest --trunk [--remeasure [--all]] (refresh current-plan trunk invariant keys and measure them; --remeasure: measure failed trunk keys again)\ncheck try <node> <check> [--red REV] [--green REV] [--plan FILE] [--no-lease] [--record] [--for NODE] | check try --invariant ID ... | check try --run COMMAND ... [--min-tests N] [--timeout SECONDS] (exactly one target form; at least one rev; red:true is measured as an ordinary check; --record saves informational receipts)\nattest exit codes: 0 = no measured failure and nothing outstanding; 1 = measured failure (an observation recorded by this action has verdict fail, including known_red); 4 = no measured failure but obligations outstanding; 3 = internal error (usage 2, refused 1, busy 75).\nreview <node> --ok|--block [--needs-parent] --rank N [--note TEXT] [--ack-rulings N|latest|N,N] [--obligation review|closure-review] [--candidate COMMIT] [--model MODEL]\nwaive <node> <obligation> --reason TEXT [--accept-risk 12,15] [--tracked-by FIX|ext:<id>] [--candidate COMMIT] [--full]\ndefer <node> <inv-id...> --reason TEXT | abandon <node> [--hold] [--note TEXT]\nresume <node[,node...]> [--after a,b] [--expect report] [--remeasure] [--note TEXT]  (parent/owner: clear a driver halt without an obligation; --after: wait until that node merges; --remeasure: the driver measures failed merge-tree invariants again before merging)\napprove <node> [--note TEXT] [--block] [--candidate COMMIT]  (owner: approve the open candidate of a node with approve: owner)\nevidence <node> <id> [--file PATH]... --note TEXT [--as role:id] [--candidate COMMIT]  (manual evidence on the open candidate; on a merged node a receipt)\n--candidate COMMIT (40 hex or a prefix of at least 7): record only if it is the open candidate's commit, the one you judged\nmerge <node> | adopt [--commit X] [--wait SECONDS] --note TEXT (owner: land an off-ref fast-forward hotfix under the merge lock without stopping the driver, or record commits already on trunk; --as parent:ID under an allow adopt rule) | status [--full] | idle [--json] (exit 0 idle, 3 not idle; drive.watch_idle_min defaults to 15, 0 disables) | why <node> [--full] | report [--metrics [--until seq|ISO] | --counterfactual | --cost] [--since seq|ISO] (--counterfactual: how recorded driver halts would be classified under the current policy) | brief [--since seq|ISO] | verify\n--no-lease (init, attest, merge, adopt): skip the shared machine lease; otherwise measurements wait for it (plan lease: false disables it repository-wide; leased commands get OWED_LEASED=1, not in any key)\nsweep [--commit C] [--due]  (advisory trunk sweep; --due uses sweep.every; confirmed bisects record escapes)\nescape <node> --merge N --class missing|false-pass|reuse|weak|waiver --note TEXT [--evidence TEXT]\ndecoy commit <digest> | decoy reveal <file.json> | decoy digest <file.json>\ngc [--dry-run]  (parent/owner: reclaim worktrees/branches of merged or abandoned attempts)\ndrive [--once] [--max N] [--stay]  (run the mechanical loop with pi-durable-subagents >= 1.0.27 until idle; --once: one pass; --stay: when idle, wait for ledger changes instead of exiting; one driver per repository)\ndrive --detach [--max N] | drive --status | drive --stop [--now]  (background driver: start it detached, logging to .git/owed/drive/log.jsonl; report it; stop it after its current action and in-flight measurements, --now at once; --detach takes --stay too)\nwatch [--after <cursor>] [--timeout SECONDS] [--json] (read-only driver follower; exit 0 wake or driver exit, 3 no driver, 5 timeout; prints the next byte offset)\nowner actions (--as owner:ID; init, waive, defer, adopt, approve, decoy default to owner:cli, owner:human under OWED_CONFIRM=owner) are delegated: recorded with channel delegated, no prompt; a delegated downgrade needs --note. OWED_CONFIRM=owner restores the TTY confirmation; --i-am-owner records flag (weak confirmation). In a pi-durable-subagents call (DSA_CALL/DSA_EXEC) owner and parent acts are refused.`;
const values = new Set(['run','for','min-tests','timeout','red','green','max','as','commit','nodes','rank','note','ack-rulings','obligation','reason','accept-risk','since','until','merge','class','evidence','rev','file','candidate','after','writes','plan','set','unset','invariant','rule','expect','qid','rid','model','wait','text','defer','check','runs','tracked-by','allow-only','amend']);
const flags = new Set(['record','version','full','json','metrics','cost','i-am-owner','rerun','ok','block','needs-parent','help','dry-run','allow-overlap','once','detach','status','stop','now','genesis','trunk','stay','writer','no-lease','node-new','resume','hold','prospective','remeasure','all','no-resume','apply','counterfactual','due','restart','probe-trunk','drive','all-b']);
function usage(message:string): never { throw new OwedError(message,'usage'); }
/** Parse the CLI grammar without I/O; execution and exported validation share this parser. */
function parseArgv(argv: string[]) {
    const args:string[] = [], opts = new Map<string,string|boolean>(), files:string[] = [], sets:string[] = [], unsets:string[] = [], writes:string[] = [];
    for (let i=0;i<argv.length;i++) { const a=argv[i]!; if (a === '--' && args[0] === 'answer') { args.push(...argv.slice(i+1)); break; } if (!a.startsWith('--')) { args.push(a); continue; } const [key,...rest]=a.slice(2).split('='); if (!key || (!values.has(key) && !flags.has(key))) usage(`Unknown option ${a}`); if (opts.has(key) && !['file','set','unset'].includes(key) && !(key === 'writes' && args[0] === 'decide')) usage(`Duplicate option --${key}`); if (flags.has(key)) { if(rest.length) usage(`${a} does not accept a value`); opts.set(key,true); } else { const v=rest.length ? rest.join('=') : argv[++i]; if(v === undefined || v.startsWith('--')) usage(`--${key} requires a value`); opts.set(key,v); if (key === 'file') files.push(v); if (key === 'set') sets.push(v); if (key === 'unset') unsets.push(v); if (key === 'writes') { writes.push(...v.split(',')); if (args[0] === 'decide') while (argv[i+1]?.startsWith('+')) writes.push(...argv[++i]!.split(',')); } } }
  return { args, opts, files, sets, unsets, writes };
}
const allowed:Record<string,string[]> = { stage:['file'],accept:['amend','all-b'],reject:['note'],stages:['all'],overturn:['note'],watch:['after','timeout'],check:['run','record','for','min-tests','timeout','red','green','plan','invariant','no-lease'],start:['plan','max','stay','restart'],decide:['text','writes','allow-only','defer','resume','no-resume','after','expect','remeasure','writer'],init:['no-lease'],plan:['rev','note'],amend:['writes','note','plan'],answer:['qid','rid','rev','expect'],edit:['drive','set','unset','invariant','node-new','rule','writer','resume','after','expect','note','dry-run','plan'],rule:['nodes','writer','prospective'],dispatch:['allow-overlap'],submit:['commit','model'],rebase:['apply','full'],attest:['rerun','genesis','trunk','no-lease','remeasure','all','full','probe-trunk','check','runs'],review:['ok','block','needs-parent','rank','note','ack-rulings','obligation','candidate','model'],waive:['reason','accept-risk','candidate','full','tracked-by'],defer:['reason'],abandon:['note','reason','hold'],resume:['after','expect','note','remeasure'],merge:['no-lease'],sweep:['commit','no-lease','due'],status:['full'],idle:[],why:['full'],report:['since','metrics','until','counterfactual','cost'],brief:['since'],verify:[],escape:['merge','class','note','evidence'],decoy:[],gc:['dry-run'],adopt:['commit','note','no-lease','wait'],approve:['note','block','candidate'],evidence:['file','note','candidate'],drive:['once','max','detach','status','stop','now','stay'] };
/** Command descriptions come only from HELP; split synopsis boundaries, never flag alternatives. */
function helpText(args: string[], opts: Map<string,string|boolean>): string | undefined {
  if (args[0] !== 'help' && !opts.has('help')) return;
  if (args[0] === 'help' && args.length > 2) usage('help takes at most one command');
  const cmd = args[args[0] === 'help' ? 1 : 0];
  if (!cmd) return HELP;
  const commands = [...Object.keys(allowed),'version'];
  if (!commands.includes(cmd)) usage(`Unknown command ${cmd}; known commands: ${commands.join(', ')}`);
  const parts = HELP.split(new RegExp(`\\n| \\| (?=(?:${commands.join('|')})(?:\\s|$))`));
  return [parts.find(p => p.startsWith('Usage:'))!, ...parts.filter(p => p === cmd || p.startsWith(`${cmd} `)), `Flags: ${[...(allowed[cmd] ?? []),'json','as','i-am-owner'].map(k => `--${k}`).join(' ')}`].join('\n');
}
/** NE-CLI: validate commands, flags, positional shape and required values without executing an act. */
export function validateArgv(argv: string[]): void {
  const { args, opts } = parseArgv(argv);
  if (helpText(args,opts) !== undefined) return;
  if (opts.has('version') || args[0] === 'version') {
    if (args.length !== (opts.has('version') ? 0 : 1) || opts.size !== (opts.has('version') ? 1 : 0)) usage('version takes no arguments or other options');
    return;
  }
  const cmd = args.shift(); if (!cmd) usage(HELP);
    if (!allowed[cmd]) usage(`Unknown command ${cmd}`);
    for (const k of opts.keys()) if (!['json','as','i-am-owner'].includes(k) && !allowed[cmd]!.includes(k)) usage(`${cmd} does not support --${k}`);
    const count = cmd === 'accept' && opts.has('all-b') ? 0 : cmd === 'check' ? (opts.has('invariant') || opts.has('run') ? 1 : 3) : cmd === 'edit' && (opts.has('invariant') || opts.has('drive')) ? 0 : cmd === 'attest' && (opts.has('genesis') || opts.has('trunk')) ? 0 : cmd === 'waive' || cmd === 'answer' || cmd === 'defer' || cmd === 'decoy' || cmd === 'evidence' ? 2 : ['stages','watch','start','status','idle','report','brief','verify','gc','adopt','drive','sweep'].includes(cmd) ? 0 : 1;
    if(args.length < count || (cmd !== 'defer' && args.length !== count)) usage(cmd === 'check' ? TRY_FORMS : `${cmd} wrong number of arguments`);
    if (cmd === 'check' && args[0] !== 'try') usage(TRY_FORMS);
    if(cmd === 'decoy' && !['commit','reveal','digest'].includes(args[0]!)) usage('decoy requires commit <digest>, reveal <file.json> or digest <file.json>');
  const value = (key: string, required = false): string | undefined => {
    const v = opts.get(key); if (required && (typeof v !== 'string' || !v.trim())) usage(`Required: --${key}`);
    return typeof v === 'string' ? v : undefined;
  };
  const integer = (key: string, required = false): number | undefined => {
    const v = value(key, required); if (v === undefined) return;
    if (!/^\d+$/.test(v)) usage(`--${key} must be a nonnegative integer`);
    return Number(v);
  };
  if (cmd === 'stage') value('file',true);
  if (cmd === 'reject' || cmd === 'overturn') value('note',true);
  if (cmd === 'accept' && opts.has('all-b') && opts.has('amend')) usage('accept --all-b does not take --amend');
  if (cmd === 'overturn' && (!/^\d+$/.test(args[0]!) || !Number.isSafeInteger(Number(args[0])))) usage('overturn needs an entry seq');
  if (cmd === 'check') validateTry({node:args[1],check:args[2],invariant:value('invariant'),run:value('run'),red:value('red'),green:value('green'),record:opts.has('record'),for:value('for'),min_tests:integer('min-tests'),timeout:integer('timeout')});
  if (cmd === 'edit' && opts.has('drive') && opts.has('invariant')) usage('edit --drive is exclusive with --invariant');
  if (cmd === 'decide' || cmd === 'answer') {
    const expect = value('expect'); if (expect !== undefined && expect !== 'report') usage('--expect must be report');
    if (cmd === 'decide' && opts.has('no-resume') && expect !== undefined) usage('--no-resume cannot take --expect report: no resume would be recorded');
  }
  if (cmd === 'review') ops.rulingAck(value('ack-rulings'));
  const wait = opts.has('wait') ? Number(value('wait', true)) : undefined;
  if (cmd === 'adopt') adoptWaitMs(wait);
  if (cmd === 'adopt' || cmd === 'evidence') value('note', true);
  ops.candidateArg(value('candidate'));
    if(cmd === 'report' && opts.has('until') && !opts.has('metrics')) usage('--until requires report --metrics');
    if(cmd === 'report' && ['counterfactual','metrics','cost'].filter(k => opts.has(k)).length > 1) usage('report takes --metrics, --counterfactual or --cost, not more than one');
    if(cmd === 'attest' && (opts.has('genesis') || opts.has('trunk')) && opts.has('rerun')) usage('attest --genesis/--trunk does not take --rerun');
    if(cmd === 'attest' && opts.has('genesis') && opts.has('trunk')) usage('attest takes --genesis or --trunk, not both');
    if(cmd === 'attest' && opts.has('remeasure') && (opts.has('rerun') || opts.has('genesis'))) usage('attest --remeasure does not take --rerun or --genesis');
    if(cmd === 'attest' && opts.has('all') && !opts.has('remeasure')) usage('attest --all requires --remeasure');
    if(cmd === 'attest' && opts.has('probe-trunk') && ['rerun','remeasure','trunk','genesis','all'].some(k => opts.has(k))) usage('attest --probe-trunk does not combine with --rerun/--remeasure/--trunk/--genesis/--all');
    if(cmd === 'attest' && (opts.has('check') || opts.has('runs')) && !opts.has('probe-trunk')) usage('--check/--runs require --probe-trunk');
  if (cmd === 'watch') {
    parseWatchCursor(value('after'));
    for (const key of ['timeout']) { const n = integer(key); if (n !== undefined && !Number.isSafeInteger(n)) usage(`--${key} must be a safe nonnegative integer`); }
    return;
  }
  if (cmd === 'start') {
    if (opts.has('as') || opts.has('i-am-owner')) usage('start uses delegated owner init and existing plan permissions; it takes no --as or --i-am-owner');
    integer('max');
    return;
  }
  if (cmd === 'drive') {
    if (opts.has('as') || opts.has('i-am-owner')) usage('drive always acts as parent:drive');
    const modes = ['once','detach','status','stop'].filter(k => opts.has(k));
    if (modes.length > 1) usage(`drive: ${modes.map(k => `--${k}`).join(' and ')} cannot be combined`);
    if (opts.has('now') && !opts.has('stop')) usage('--now is only valid with --stop');
    if (opts.has('stay') && ['once','status','stop'].some(k => opts.has(k))) usage('--stay is only valid with --detach or the loop');
    if (opts.has('max') && ['status','stop'].some(k => opts.has(k))) usage('--max is only valid with --detach, --once or the loop');
    const max = integer('max'); if (max !== undefined && max < 1) usage('--max must be at least 1');
    return;
  }
  if (opts.has('as') && !/^(owner|parent|writer|reviewer|executor):(.+)$/.test(value('as')!)) usage('--as must be role:id');
}
/** Terminal I/O of the CLI; tests inject `ask` (the owner's answer to the TTY prompt) and capture output. */
export interface CliIo { ask?: (question: string) => Promise<string>; log: (text: string) => void; error: (text: string) => void }
const terminal: CliIo = { log: text => console.log(text), error: text => console.error(text) };
/** Commands that run checks (D16): a signal aborts them and ends the check started; exit 130 for SIGINT, 143 for SIGTERM and SIGHUP. */
const ABORTABLE = ['check','plan','edit','amend','decide','attest','merge','init','adopt','sweep'], SIGNALS: NodeJS.Signals[] = ['SIGINT','SIGTERM','SIGHUP'];
const signalExit = (s: NodeJS.Signals): number => s === 'SIGINT' ? 130 : 143;
/** MT: the receipt of a batch merge: one line per member merge entry, then the trunk move. */
const batchMergeText = async (cwd: string, r: ops.BatchMergeResult): Promise<string> => [...await ops.mergedLines(cwd, r.entries.flatMap(e => e.kind === 'merge' ? [{ node: e.node, commit: e.commit }] : []), r.deferred && Object.fromEntries(Object.entries(r.deferred).map(([id, items]) => [id, items.length]))), ...(r.dropped.length ? [`Not batched (conflict; merge alone after a rebase): ${r.dropped.join(', ')}`] : []), `Batch of ${r.nodes.length}: ${r.nodes.join(', ')}${leaseText(r)}`].join('\n');
/** Signals within this time of the first are one stop request (D16a.3). */
const SAME_REQUEST_MS = 1000;
export async function main(argv: string[], io: CliIo = terminal): Promise<number> {
  const abort = new AbortController(), got: { signal?: NodeJS.Signals; at?: number; unhandle?: () => void } = {};
  let command: string | undefined;
  try {
    validateArgv(argv);
    const { args, opts, files, sets, unsets, writes } = parseArgv(argv);
    const help = helpText(args,opts); if (help !== undefined) { io.log(help); return 0; }
    if (opts.has('version') || args[0] === 'version') {
      if (args.length !== (opts.has('version') ? 0 : 1) || opts.size !== (opts.has('version') ? 1 : 0)) usage('version takes no arguments or other options');
      io.log(`owed ${OWED_VERSION}`); return 0;
    }
    const cmd=args.shift(); command=cmd; if(!cmd) usage(HELP);
    const value = (key:string,required=false):string|undefined => { const v=opts.get(key); if(required && (typeof v !== 'string' || !v.trim())) usage(`Required: --${key}`); return typeof v === 'string' ? v : undefined; };
    const integer=(key:string,required=false):number|undefined => { const v=value(key,required); if(v === undefined) return undefined; if(!/^\d+$/.test(v)) usage(`--${key} must be a nonnegative integer`); return Number(v); };
    const wait = opts.has('wait') ? Number(value('wait',true)) : undefined;
    // G1: the candidate the caller judged; checked under the ledger lock when the act is appended.
    const named=ops.candidateArg(value('candidate'));
    if(cmd === 'watch') {
      const r=await watchDriver({cwd:process.cwd(),after:value('after'),timeout:integer('timeout')});
      io.log(opts.has('json') ? JSON.stringify(r) : watchText(r)); return r.exit;
    }
    if(cmd === 'start') {
      const r=await ops.start({cwd:process.cwd(),plan:value('plan'),max:integer('max'),stay:opts.has('stay'),restart:opts.has('restart'),signal:abort.signal}), session=followedBy(r.driver);
      io.log(opts.has('json') ? JSON.stringify({...r,followedBy:session}) : `${ops.startText(r)}${r.driver.exited ? '' : `\n${followText(session)}`}`); return 0;
    }
    if(cmd === 'drive') {
      const max=integer('max');
      const json=opts.has('json');
      const stay=opts.has('stay');
      if(opts.has('detach')) { const r=await driveStart({cwd:process.cwd(),max,...(stay ? {stay} : {})}), session=followedBy(r); io.log(json ? JSON.stringify({...r,followedBy:session}) : `${renderDriveStart(r)}${r.exited ? '' : `\n${followText(session)}`}`); return 0; }
      if(opts.has('status')) { const r=await driveStatus({cwd:process.cwd()}); io.log(json ? JSON.stringify(r) : renderDriveStatus(r)); return 0; }
      if(opts.has('stop')) { const r=await driveStop({cwd:process.cwd(),now:opts.has('now')}); io.log(json ? JSON.stringify(r) : renderDriveStop(r)); return 0; }
      return await drive({cwd:process.cwd(),once:opts.has('once'),max,json:opts.has('json'),log:io.log,...(stay ? {stay} : {})});
    }
    const cwd=process.cwd(); let principal:Principal={role:'parent',id:'cli'};
    if(opts.has('as')) { const match=/^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value('as')!); if(!match) usage('--as must be role:id'); principal={role:match[1] as Role,id:match[2]!}; }
    else if(['init','waive','defer','adopt','approve'].includes(cmd) || cmd === 'decide' && opts.has('defer') || (cmd === 'decoy' && args[0] !== 'digest') || opts.has('i-am-owner')) principal={role:'owner',id:ops.confirmGate() ? 'human' : 'cli'}; // E3.3: owner:cli (delegated); owner:human only under OWED_CONFIRM=owner
    else if(cmd === 'submit' || cmd === 'rebase') { const s=await ops.status({cwd}), slot=s.nodes[args[0]!]?.slot; if(slot && resolve(await git.repoRoot(cwd)) === resolve(slot.worktree)) principal={role:'writer',id:slot.writer.slice(7)}; }
    // G2.3 (F5): parent:drive is the driver's identity; owed drive uses it internally, nobody claims it.
    if(principal.role === 'parent' && principal.id === 'drive') throw new OwedError(ops.DRIVER_CLAIM);
    // D25.3: a pi-durable-subagents call never acts as owner or parent (an accident rail, not a security boundary).
    // Reads and attest (recorded as executor) take no principal.
    // ED2: an edit preview is read-only, even when an owner principal was supplied.
    const preview = cmd === 'edit' && opts.has('dry-run');
    const records=!preview && !['stages','check','status','idle','why','report','brief','verify','attest','sweep'].includes(cmd) && !(cmd === 'decoy' && args[0] === 'digest');
    const subagent=records && cmd !== 'stage' && !(['answer','decide','resume'].includes(cmd) && await ops.forkPrincipal(cwd)) ? ops.subagentRefusal(principal.role) : undefined; if(subagent) throw new OwedError(subagent);
    let channel:Channel|undefined, adoptCommit:string|undefined, approvePin:ops.CandidatePin|undefined, pin:ops.CandidatePin|undefined;
    // The owner confirms what is adopted: the preview is printed first and its commit is pinned, so a ref moving after the confirmation is refused.
    if(cmd === 'adopt' && principal.role === 'owner') { const p=await ops.adoptPreview({cwd,commit:value('commit')}); io.error(renderAdoptPreview(p,value('note')!)); adoptCommit=p.commit; }
    // The owner confirms the candidate approved (review ruling #389): it is printed first and pinned, so a resubmit after the confirmation is refused.
    if(cmd === 'approve' && principal.role === 'owner') { const v=await ops.approvePreview({cwd,node:args[0]!}); io.error(`${opts.has('block') ? 'Block approval of' : 'Approve'} node ${oneLine(v.node)}: candidate ${v.commit} (submit #${v.seq}), base ${v.base}, ${v.changed} changed file${v.changed === 1 ? '' : 's'}`); approvePin={seq:v.seq,commit:v.commit}; }
    // G1.2: under the confirmation gate the owner confirms the candidate a waiver or owner review lands on: printed and pinned.
    if((cmd === 'waive' || cmd === 'review') && principal.role === 'owner' && ops.confirmGate() && !opts.has('i-am-owner')) { const v=await ops.candidatePreview({cwd,node:args[0]!}); io.error(`${cmd === 'waive' ? `Waive ${oneLine(v.node)}/${oneLine(args[1]!)}` : `Owner review of node ${oneLine(v.node)}`}: candidate ${v.commit} (submit #${v.seq}), base ${v.base}, ${v.changed} changed file${v.changed === 1 ? '' : 's'}`); pin={seq:v.seq,commit:v.commit}; }
    // D25.2/4: owner acts are delegated (no prompt) unless OWED_CONFIRM=owner restores the TTY confirmation; --i-am-owner records flag.
    if(principal.role === 'owner' && !preview) {
      if(opts.has('i-am-owner')) channel='flag';
      else if(!ops.confirmGate()) channel='delegated';
      else if(io.ask) { if(await io.ask(`Execute ${cmd} as owner? Type yes to confirm: `) !== 'yes') throw new OwedError('owner did not confirm'); channel='tty'; }
      else { if(!process.stdin.isTTY || !process.stdout.isTTY) throw new OwedError('owner actions require TTY confirmation or --i-am-owner'); const rl=createInterface({input:process.stdin,output:process.stdout}); try { const answer=await rl.question(`Execute ${cmd} as owner? Type yes to confirm: `); if(answer !== 'yes') throw new OwedError('owner did not confirm'); channel='tty'; } finally { rl.close(); } }
    }
    const actor={cwd,as:principal,channel}, node=args[0]!, signal=abort.signal, lease=!opts.has('no-lease');
    let result:unknown, text:string|undefined, exit=0;
    // D16: for the duration of a command that runs checks, the first SIGINT/SIGTERM/SIGHUP aborts it (the running
    // check's process group is killed, nothing more starts); a second one exits at once with the first one's code.
    // One stop request may arrive twice (D16a.3: `owed drive` signals hold's process group, which holds this process,
    // and hold also forwards it), so signals within 1 s of the first are the same request; only a later one is a second.
    if(ABORTABLE.includes(cmd)) {
      const onSignal = (s: NodeJS.Signals) => {
        if(got.signal) {
          if(Date.now() - got.at! < SAME_REQUEST_MS) return;
          io.error(`Aborted: ${got.signal}`); process.exit(signalExit(got.signal));
        }
        got.signal=s; got.at=Date.now(); abort.abort();
      };
      for(const s of SIGNALS) process.on(s,onSignal);
      got.unhandle=() => { for(const s of SIGNALS) process.off(s,onSignal); };
    }
    switch(cmd) {
      case 'stage': {const r=await ops.stage({...actor,node,file:value('file',true)!});result=r;text=`staged S${r.seq}: ${r.summary.split(/\r?\n/)[0]} → owed accept S${r.seq}`;break;}
      case 'stages': {const r=await ops.stages({cwd,all:opts.has('all')});result=r;text=ops.stageLines(r);break;}
      case 'accept': {if(opts.has('all-b')) {const r=await ops.acceptAllB({...actor,signal});result=r;text=r.map(ops.acceptText).join('\n') || 'No open class-B stages';}else {const r=await ops.accept({...actor,id:node,amend:value('amend'),signal});result=r;text=ops.acceptText(r);}break;}
      case 'reject': result=await ops.reject({...actor,id:node,note:value('note',true)!});text=`rejected ${node}`;break;
      case 'overturn': result=await ops.overturn({...actor,seq:Number(node),note:value('note',true)!});text=`overturned #${node}`;break;
      case 'check': { const r = await ops.checkTry({cwd,signal,lease,node:args[1],check:args[2],invariant:value('invariant'),run:value('run'),min_tests:integer('min-tests'),timeout:integer('timeout'),record:opts.has('record'),for:value('for'),red:value('red'),green:value('green'),plan:value('plan')}); result=r; text=await ops.checkTryText(cwd,r); exit=r.results.every(r => r.ok) ? 0 : 1; break; }
      // D24.3: once genesis is recorded init succeeds; an incomplete genesis attest is reported, never as "retry".
      // H2.2: warnings for check-less nodes of the new plan, printed after the result (JSON: `warnings`).
      case 'init': { const plan=await readFile(resolve(cwd,node),'utf8'), r=await ops.init({...actor,channel:channel!,signal,lease,plan,path:node}), warnings=[...planWarnings(parsePlan(plan)),...(r.warnings ?? [])]; result={...r,warnings}; text=`${renderEntry(r.entry)}\nInitial observations: ${r.observations.length}${r.genesis.complete ? '' : `${r.genesis.error ? `\nGenesis attest stopped: ${r.genesis.error}` : ''}\n${ops.genesisIncompleteText(r.entry.seq,r.genesis)}`}\n${renderStatus(r.status)}${leaseText(r)}${warnings.map(w => `\n${w}`).join('')}`; break; }
      case 'plan': {
        const prior=(await ops.readState({cwd})).state;
        const note=value('note'), read=await ops.readPlan({cwd,path:node,rev:value('rev')}), notCarried:ops.NotCarried[]=[], shellWarnings:string[]=[], notes:string[]=[], e=await ops.planSet({...actor,signal,...read,...(note !== undefined ? {note} : {}),notCarried,shellWarnings,planNotes:notes}), warnings=[...shellWarnings,...planWarnings(parsePlan(read.plan),new Set(Object.values((await ops.status({cwd})).nodes).filter(n => n.phase === 'merged').map(n => n.id))),...parentOverlapWarnings(withWritesSyntax(parsePlan(read.plan),2),prior)], carried=await ops.carriedBy({cwd,plan:e.seq}), carries={...(carried.length ? {carried} : {}),...(notCarried.length ? {notCarried} : {})}; result={...e,warnings,notes,...carries}; text=[await ops.recordedPlanReceipt({cwd,entry:e}),...carried.map(carryLine),...notCarried.map(notCarriedLine)].join('\n');
        // D21.3: a parent's downgrades accepted under an allowance are labelled with it.
        if(e.kind === 'plan' && !e.by.startsWith('owner:')) { const d=(await ops.report({cwd,since:e.seq-1})).downgrades.find(x => x.seq === e.seq); if(d?.allowance !== undefined) text+=`\nDowngrades ${allowanceLabel(d)}: ${d.items.map(i => `${i.node}: ${i.what}`).join('; ')}`; }
        const pending=await ops.genesisPending({cwd}); if(pending.length) { const w=`Warning: genesis attest pending for ${pending.join(', ')}`; if(opts.has('json')) io.error(w); else text=`${text}\n${w}`; }
        // H1.3: dispatchable ready nodes and no driver: one hint line before the H2.2 warnings, which end the text
        // (JSON: ready, driver false); nothing starts.
        const ready=await readyHint(cwd); if(ready) { result={...e,warnings,notes,...carries,ready,driver:false}; text=`${text}\n${readyHintText(ready,'cli')}`; }
        text+=[...notes,...warnings].map(w => `\n${w}`).join('');
        break;
      }
      // N3: plan text edit + plan entry (same guard as plan) + carries + ruling, in one lock.
      case 'amend': {
        const file=value('plan'), r=await ops.amend({...actor,signal,node,writes:value('writes')?.split(',') ?? [],note:value('note') ?? '',...(file !== undefined ? {plan:file} : {})}); result=r; text=amendLines(r).join('\n') + ops.amendLimitText(r);
        if(r.plan && !r.plan.by.startsWith('owner:')) { const d=(await ops.report({cwd,since:r.plan.seq-1})).downgrades.find(x => x.seq === r.plan?.seq); if(d?.allowance !== undefined) text+=`\nDowngrades ${allowanceLabel(d)}: ${d.items.map(i => `${i.node}: ${i.what}`).join('; ')}`; }
        break;
      }
      case 'edit': {
        const expect=value('expect'); if(expect !== undefined && expect !== 'report') usage('--expect must be report');
        // R-030-ME-1: exact current IDs and new IDs retain the 0.29 literal meaning.
        const batch = !opts.has('drive') && !opts.has('invariant') && !opts.has('node-new') && node.includes(',') && !(await ops.readState({cwd})).state.plan?.nodes.some(n => n.id === node);
        const after=value('after'), args:ops.EditArgs={cwd,signal,...(opts.has('drive') ? {drive:true} : opts.has('invariant') ? {invariant:value('invariant',true)!} : batch ? {nodes:node.split(',')} : {node}),set:sets,unset:unsets,note:value('note',true)!,node_new:opts.has('node-new'),...(value('plan') !== undefined ? {plan:value('plan')} : {}),...(value('rule') !== undefined ? {rule:value('rule')} : {}),...(opts.has('writer') ? {writer:true} : {}),resume:opts.has('resume'),...(after !== undefined ? {after} : {}),...(expect !== undefined ? {expect:'report'} : {})};
        if(opts.has('dry-run')) { const r=await ops.editPreview(args); result=r; text=`${r.diff}\nDowngrades: ${JSON.stringify(r.downgrades)}${[...r.notes,...r.warnings].map(w => `\n${w}`).join('')}`; }
        else { const r=await ops.edit({...actor,...args}) as ops.EditResult; result=r; text=[renderEntry(r.plan),...r.carried.map(carryLine),...r.notCarried.map(notCarriedLine),...(r.rule ? [renderEntry(r.rule)] : []),...(r.resumes ?? (r.resume ? [r.resume] : [])).map(renderEntry),`Wrote ${r.path}`,...(r.warnings ?? [])].join('\n'); }
        break;
      }
      case 'decide': {
        if (opts.has('resume') && opts.has('no-resume')) usage('decide takes --resume or --no-resume, not both');
        const r = await ops.decide({...actor,signal,nodes:node,text:value('text',true)!,...(opts.has('writes') ? {writes} : {}),...(opts.has('allow-only') ? {allow_only:value('allow-only') ? value('allow-only')!.split(',') : []} : {}),...(value('defer') !== undefined ? {defer:value('defer')} : {}),...(opts.has('resume') ? {resume:true} : opts.has('no-resume') ? {resume:false} : {}),...(value('after') !== undefined ? {after:value('after')} : {}),...(value('expect') === 'report' ? {expect:'report' as const} : {}),...(opts.has('remeasure') ? {remeasure:true} : {}),...(opts.has('writer') ? {writer:true} : {})});
        result=r; text=ops.decideText(r); break;
      }
      case 'answer': {
        const raw=value('rev'), rev=raw === undefined ? undefined : Number(raw);
        if(raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(rev) || rev! < 1)) usage('--rev must be a positive integer');
        const r=await ops.answer({...actor,node,text:args[1]!,qid:value('qid'),rid:value('rid'),rev,...(value('expect') === 'report' ? {expect:'report' as const} : {})}); result=r; text=answerText(node,r); break;
      }
      case 'rule': { if(opts.has('prospective') && opts.has('writer')) usage('--prospective cannot be combined with --writer'); const nodes=value('nodes',true)!; const r=await ops.rule({...actor,text:node,nodes:nodes === '*' ? '*' : nodes.split(','),...(opts.has('writer') ? {writer:true} : {}),...(opts.has('prospective') ? {prospective:true} : {})}); result=r; text=ruleText(r); break; }
      case 'dispatch': { const r=await ops.dispatch({...actor,node,allowOverlap:opts.has('allow-overlap')}); result=r; text=`${r.packet}\n\n---\nDispatched ${r.node} attempt ${r.attempt}\nworktree: ${r.worktree}\nbranch: ${r.branch}\nwriter: commit in the worktree, then run owed submit ${r.node}`; break; }
      case 'submit': result=await ops.submit({...actor,node,commit:value('commit'),model:value('model')}); break;
      case 'rebase': { const r=await ops.rebase({...actor,node,apply:opts.has('apply')}); result=r; text=r.applied ? `${renderEntry(r.entry)}; ${r.packet}; submitted #${r.submit!.seq}; owed measures checks next${r.callerAssertion ? `; ${r.callerAssertion}` : ''}` : [r.packet, renderEntry(r.entry), ...(r.applied === false ? [`rebase --apply fallback: ${r.conflicts?.length ? `conflicts: ${r.conflicts.map(oneLine).join(', ')}` : `error: ${oneLine(r.error ?? 'unknown error')}`}`] : []), renderReceipt(await ops.why({cwd,node}),{full:opts.has('full')})].join('\n'); break; }
      case 'attest': {
        if(opts.has('probe-trunk')) { const r=await ops.attestProbeTrunk({cwd,node,signal,lease,check:value('check'),runs:integer('runs')}); result=r; text=`${ops.trunkProbeText(r)}\n${renderWhy(r.receipt)}`; exit=r.checks.some(c => c.observations.some(e => e.kind === 'obs' && e.verdict !== 'pass')) ? 1 : 0; break; }
        if(opts.has('trunk')) { const r=await ops.attestTrunk({cwd,signal,lease,...(opts.has('remeasure') ? {remeasure:true,all:opts.has('all')} : {})}); result=r; text=`${ops.attestTrunkText(r)}${leaseText(r)}`; exit=attestExit(measuredFailure([...r.observations,...(r.remeasuredObs ?? [])]),!!r.missing.length); break; }
        if(opts.has('genesis')) { const r=await ops.attestGenesis({cwd,signal,lease}); result=r; text=`Genesis attest: ${r.observations.length} observation${r.observations.length === 1 ? '' : 's'} recorded; observed ${r.recorded.join(', ') || 'none'}${r.failed.length ? ` (failed ${r.failed.join(', ')})` : ''}; missing ${r.missing.join(', ') || 'none'}${ops.supersededText(r.superseded)}${leaseText(r)}`; exit=attestExit(measuredFailure(r.observations),!r.complete); break; }
        const r=await ops.attest({cwd,node,rerun:opts.has('rerun'),signal,lease,...(opts.has('remeasure') ? {remeasure:true,all:opts.has('all')} : {})}); result=r; exit=attestExit(measuredFailure(r.observations),!r.accepted); text=`${exit === 4 ? `${measuredPendingText(r.receipt)}\n` : ''}${r.remeasured ? `${ops.remeasureText(node,r.remeasured,r.observations)}\n` : ''}${renderReceipt(r.receipt,{full:opts.has('full')})}${ops.supersededText(r.superseded)}${leaseText(r)}`; break;
      }
      case 'review': { if(opts.has('ok') === opts.has('block')) usage('review requires --ok or --block'); const obligation=value('obligation'); if(obligation && !['review','closure-review'].includes(obligation)) usage('Invalid review obligation'); result=await ops.review({...actor,node,verdict:opts.has('ok')?'ok':'block',rank:integer('rank',true)!,note:value('note') ?? '',model:value('model'),ack_rulings:ops.rulingAck(value('ack-rulings')),obligation:obligation as 'review'|'closure-review'|undefined,...(opts.has('needs-parent') ? { needs:'parent' as const } : {}),named,...(pin ? {pin} : {})}); break; }
      case 'waive': { const risk=value('accept-risk'); if(risk && !/^\d+(,\d+)*$/.test(risk)) usage('accept-risk must be a list of seq numbers'); const w=await ops.waive({...actor,channel:channel!,node,obligation:args[1]!,reason:value('reason',true)!,accept_risk:risk?.split(',').map(Number),tracked_by:value('tracked-by'),named,...(pin ? {pin} : {})}), meaning=await ops.waiverMeaning({cwd,entry:w}); result={...w,meaning}; text=`${waiverRecordedText(w as import('./types.ts').WaiveEntry)}\n${meaning}\n${renderWhy(await ops.why({cwd,node}),{full:opts.has('full')})}`; break; }
      case 'defer': { const s=await ops.status({cwd}), n=s.nodes[node]; if(!n?.candidate) throw new OwedError('defer requires a current candidate'); const ledger=await Ledger.open(cwd), entries=await ledger.read(), law=entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis'); if(!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('Missing plan'); const plan=parsePlan((await ledger.getBlob(law.plan)).toString()); const m=await git.buildMerge(cwd,s.trunk.commit,n.candidate.commit,`owed merge ${node}`); if('conflicts' in m) throw new OwedError('rebase needed'); const facts=await git.stateFacts(cwd,plan,m.commit,quarantineNames(plan,id => !!s.nodes[id]?.merged,node)); result=await ops.defer({...actor,channel:channel!,node,items:args.slice(1).map(value => { const id=invariantId(plan,value); return {id,key:facts.invKeys[id] ?? ''}; }),reason:value('reason',true)!}); break; }
      case 'abandon': { if(opts.has('note') && opts.has('reason')) usage('abandon takes --note (or its older spelling --reason), not both'); result=await ops.abandon({...actor,node,reason:value('note') ?? value('reason') ?? '',hold:opts.has('hold')}); break; }
      case 'resume': { const after=value('after'), note=value('note'), expect=value('expect'); if(expect !== undefined && expect !== 'report') usage('--expect must be report'); const r=await ops.resume({...actor,node,...(after !== undefined ? {after} : {}),...(expect === 'report' ? {expect} : {}),...(note !== undefined ? {note} : {}),...(opts.has('remeasure') ? {remeasure:true} : {})}); result=r.entries ? r : r.entry; text=`${(r.entries ?? [r.entry]).map(renderEntry).join('\n')}${r.remeasure?.length ? `\n${r.remeasure.join('\n')}` : ''}${after === undefined ? '' : r.merged ? `\n${after} is already merged: ${node} resumes now` : `\n${node} waits for ${after} (resume #${r.entry.seq}); the driver acts again when ${after} merges`}`; break; }
      case 'approve': result=await ops.approve({...actor,node,note:value('note'),block:opts.has('block'),named,...(approvePin ? {candidate:approvePin} : {})}); break;
      case 'evidence': result=await ops.evidence({...actor,node,id:args[1]!,files,note:value('note',true)!,named}); break;
      case 'sweep': { const options={cwd,commit:value('commit'),signal,lease}; const r=await (opts.has('due') ? ops.sweep({...options,due:true}) : ops.sweep(options)); result=r; text=renderSweep(r); exit='notDue' in r || r.entry.verdict === 'pass' ? 0 : 1; break; }
      case 'merge': { if(node.includes(',')) { const r=await ops.mergeBatch({...actor,nodes:node.split(',').map(x => x.trim()).filter(Boolean),signal,lease}); result=r; text=await batchMergeText(cwd,r); break; } const r=await ops.merge({...actor,node,signal,lease}); result=r; text=`${(await ops.mergedLines(cwd,[{node,commit:r.commit}],{[node]:r.deferred.length}))[0]}${leaseText(r)}\n${unguardedText(r.unguarded)}${r.deferred.length ? `\nDeferred debt remains: ${r.deferred.map(i => `${i.subject}/${i.obligation}`).join(', ')}` : ''}`; break; }
      case 'adopt': { const note=value('note',true)!; const r=await ops.adopt({...actor,channel:channel!,commit:adoptCommit ?? value('commit'),note,signal,lease,wait}); result=r; text=`${renderEntry(r.entry)}${leaseText(r)}${r.allowance !== undefined ? `\nAdopted by ${r.entry.by} under allowance (plan #${r.allowance})` : ''}\nInvariant observations: ${r.observations.length}\nLedger trunk ${r.trunk} is now ${r.commit}`; break; }
      case 'idle': { const r=await idle(cwd); result=r; text=idleText(r); exit=idleExit(r); break; }
      case 'status': { const r=await ops.status({cwd}); result=r; text=renderStatus(r,{full:opts.has('full')}); break; }
      case 'why': { const r=await ops.why({cwd,node}); result=r; text=renderWhy(r,{full:opts.has('full')}); break; }
      case 'report': { const v=value('since'); if(opts.has('cost')) { const r=await ops.reportCost({cwd,since:v}); result=r; text=renderCost(r); } else if(opts.has('counterfactual')) { const r=await ops.reportCounterfactual({cwd,since:v,progress:line => io.error(line)}); result=r; text=renderCounterfactual(r); } else if(opts.has('metrics')) { const r=await ops.reportMetrics({cwd,since:v,until:value('until')}); result=r; text=renderMetrics(r); } else { const r=await ops.report({cwd,since:v && /^\d+$/.test(v) ? Number(v) : v}); result=r; text=renderReport(r); } break; }
      case 'brief': { const v=value('since'), r=await ops.brief({cwd,since:v && /^\d+$/.test(v) ? Number(v) : v}); result=r; text=renderBrief(r); break; }
      case 'escape': { const cls=value('class',true)!; if(!['missing','false-pass','reuse','weak','waiver'].includes(cls)) usage('--class must be missing, false-pass, reuse, weak or waiver'); result=await ops.escape({...actor,node,merge:integer('merge',true)!,class:cls as EscapeClass,note:value('note',true)!,evidence:value('evidence')}); break; }
      case 'decoy': { const file=resolve(cwd,args[1]!); if(args[0] === 'digest') { const r=ops.decoyDigest(await readFile(file,'utf8')); result=r; text=r.digest; } else if(args[0] === 'commit') result=await ops.decoyCommit({...actor,channel:channel!,digest:args[1]!}); else result=await ops.decoyReveal({...actor,channel:channel!,payload:await readFile(file,'utf8')}); break; }
      case 'verify': { const r=await ops.verify({cwd}); result=r; text=r.ok ? `Ledger verification passed: ${r.entries} entries${r.incompleteBatch ? `\nincompleteBatch: ${r.incompleteBatch}` : ''}${r.snapshotMismatch !== undefined ? `\nsnapshotMismatch: ${r.snapshotMismatch} (the disk snapshot differed from the full replay at #${r.snapshotMismatch}; deleted)` : ''}` : `Ledger verification failed:${r.error}`; exit=r.ok ? 0 : r.code === 'version' ? 1 : 3; break; }
      case 'gc': { const r=await ops.gc({...actor,dryRun:opts.has('dry-run')}); result=r; text=renderGc(r); break; }
    }
    if(text === undefined) { const e=result as Entry; text=renderEntry(e); if(['submit','review','waive','abandon','approve','evidence'].includes(cmd)) text+=`\n${renderReceipt(await ops.why({cwd,node}))}`; }
    const warnings = (result as { warnings?: string[] } | undefined)?.warnings;
    if (['amend','decide'].includes(cmd) && warnings?.length) text += `\n${warnings.join('\n')}`;
    if (cmd === 'review' && warnings?.length) text += `\n${warnings.join('\n')}`;
    const repeated = alreadyRecordedText((result ?? {}) as { alreadyRecorded?: number });
    if (repeated) text = repeated;
    io.log(opts.has('json') ? JSON.stringify(result) : text!);
    // A signal after the last abort point: the operation completed and is recorded. The exit code describes the ledger
    // outcome (`owed drive` reads it, D14.3), so it stays the normal one; only an aborted operation exits 130/143.
    if(got.signal) io.error(`Signal ${got.signal} arrived after the operation completed; nothing was aborted`);
    return exit;
  } catch(e) {
    const error=e instanceof OwedError ? e : new OwedError(e instanceof Error ? e.message : String(e),'internal');
    // K1: with --json a failure is also one line {"error", "code"} on stdout; stderr and the exit code are unchanged.
    if(argv.includes('--json')) io.log(JSON.stringify({ error:error.message, code:error.code }));
    // G3.1 (0.12): a stale act is a refusal (nothing recorded), not an internal error.
    if(error.code === 'stale') { io.error(`Stale: ${error.message.replace(/^stale: /,'')}`); return 1; }
    if(error.code === 'aborted') { if(error.message !== 'aborted') io.error(error.message); io.error(`Aborted: ${got.signal ?? 'signal'}`); return signalExit(got.signal ?? 'SIGINT'); }
    // G1.5: `version` (the ledger needs a newer owed) is a refusal to replay: exit 1, its own text.
    if(error.code === 'version') { io.error(error.message); return 1; }
    // WD: idle reserves 3 for a successful not-idle assessment; internal errors use EX_SOFTWARE (70).
    // Other commands keep their existing internal-error exit code.
    io.error(`${error.code === 'usage' ? 'Usage error' : error.code === 'refused' ? 'Refused' : error.code === 'busy' ? 'Busy' : 'Internal error'}: ${error.message}`); return error.code === 'usage' ? 2 : error.code === 'refused' ? 1 : error.code === 'busy' ? 75 : command === 'idle' ? 70 : 3;
  } finally { got.unhandle?.(); }
}
