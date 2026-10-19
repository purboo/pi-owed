import { parseDocument, stringify, isMap, isSeq, isNode, isAlias, isScalar, visit, type YAMLMap } from 'yaml';
import { canonical } from './canon.ts';
import { parsePlan } from './plan.ts';
import { OwedError } from './errors.ts';

/** ED1: YAML values, with paths relative to a node or invariant. */
export interface EditFields {
  node?: string; invariant?: string; node_new?: boolean;
  set?: string[]; unset?: string[];
}
function usage(text: string): never { throw new OwedError(text,'usage'); }
const checkFields = ['run','run_file','args','on_timeout','timeout_s','reads','min_tests','red','tests','red_expect','mutants','min_kill','repeat','quarantine','quarantine_set'];
function parts(path: string, o: EditFields): string[] {
  const p = path.split('.');
  if (p.some(x => !x || ['__proto__','prototype','constructor'].includes(x))) usage(`Invalid edit path: ${path}`);
  if (o.invariant !== undefined) {
    if (!(p.length === 1 && [...checkFields, 'known_red'].includes(p[0]!) || p.length === 2 && p[0] === 'run_file' && ['path','sha256'].includes(p[1]!))) usage(`Invalid invariant edit path: ${path}; use a check field other than id`);
  } else {
    const simple = ['title','brief','deps','writes','allow_only','later'];
    const valid = p.length === 1 && simple.includes(p[0]!) || p.length === 2 && p[0] === 'review' && ['count','min_rank'].includes(p[1]!) || p[0] === 'drive' && p.length >= 2 || p[0] === 'checks' && (p.length === 2 || p.length === 3 && checkFields.includes(p[2]!) || p.length === 4 && p[2] === 'run_file' && ['path','sha256'].includes(p[3]!));
    if (!valid || o.node_new && !['title','brief','deps','writes','allow_only','checks'].includes(p[0]!)) usage(`Invalid node edit path: ${path}`);
  }
  return p;
}
/** ED1: preserve the target's source range when safe; flow containers and anchors need Document context. */
export function editText(text: string, o: EditFields): string {
  if ((o.node === undefined) === (o.invariant === undefined)) usage('edit requires exactly one node or --invariant');
  if (o.node_new && o.invariant !== undefined) usage('--node-new requires a node');
  if (!(o.set?.length || o.unset?.length)) usage('edit requires at least one --set or --unset');
  const doc = parseDocument(text);
  if (doc.errors.length) usage(`Invalid plan YAML: ${doc.errors.map(e => e.message).join('; ')}`);
  const list = doc.get(o.invariant !== undefined ? 'invariants' : 'nodes',true), id = o.invariant ?? o.node!;
  if (!isSeq(list)) usage('edit target list is not a YAML sequence');
  let item = list.items.find(x => isMap(x) && x.get('id') === id);
  if (o.node_new) {
    if (item) usage(`Node ${id} already exists`);
    item = doc.createNode({ id });
  }
  if (!isMap(item)) usage(`${o.invariant !== undefined ? 'Invariant' : 'Node'} ${id} does not exist`);
  const target = item as YAMLMap;
  const locate = (p: string[], create: boolean): { map: YAMLMap; path: string[] } | undefined => {
    if (p[0] !== 'checks' || o.invariant !== undefined) return { map:target, path:p };
    let checks: unknown = target.get('checks',true);
    if (checks === undefined && create) { checks = doc.createNode([]); target.set('checks',checks); }
    if (!isSeq(checks)) { if (!create && checks === undefined) return undefined; usage('checks is not a YAML sequence'); }
    let check = checks.items.find(x => isMap(x) && x.get('id') === p[1]);
    if (p.length === 2) return { map:target, path:['checks',String(check ? checks.items.indexOf(check) : checks.items.length)] };
    if (!check && create) { check = doc.createNode({ id:p[1] }); checks.add(check); }
    if (!isMap(check)) { if (!create && !check) return undefined; usage(`Check ${p[1]} is not a YAML map`); }
    return { map:check as YAMLMap, path:p.slice(2) };
  };
  const pinned = new Set<YAMLMap>(), regenerate = new Map<YAMLMap,string>();
  visit(target,(_key,node) => { if (isMap(node) && node.has('run_file')) pinned.add(node); });
  for (const assignment of o.set ?? []) {
    const eq = assignment.indexOf('=');
    if (eq < 1) usage(`--set needs path=yaml: ${assignment}`);
    const raw = assignment.slice(eq+1), p = parts(assignment.slice(0,eq),o), value = parseDocument(raw);
    // PO7: brief is free text; explicit quoted/block YAML strings remain supported.
    const freeBrief = p.length === 1 && p[0] === 'brief' && !/^(?:["']|[|>](?:[+-]|[1-9])?\s*(?:\n|$))/.test(raw.trimStart());
    if (!freeBrief && value.errors.length) usage(`Invalid YAML value for ${p.join('.')}: ${value.errors.map(e => e.message).join('; ')}`);
    if (p[0] === 'checks' && p.length === 2 && o.invariant === undefined) {
      const mapping: unknown = value.contents;
      if (!isMap(mapping)) usage(`checks.${p[1]} needs a whole mapping`);
      if (mapping.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value !== 'id' && !checkFields.includes(pair.key.value))) usage(`checks.${p[1]} mapping has an unknown field`);
      const id = mapping.get('id',true);
      if (id !== undefined && (!isScalar(id) || id.value !== p[1])) usage(`checks.${p[1]} mapping has a different id`);
      mapping.set('id',p[1]);
    }
    // Keep YAML nodes (especially aliases) so they resolve against the plan's Document, not the value's.
    const at = locate(p,true)!, prior = at.map.getIn(at.path,true), next = freeBrief ? doc.createNode(raw) : value.contents?.clone() ?? doc.createNode(null);
    if (isNode(prior)) { next.comment = prior.comment; next.commentBefore = prior.commentBefore; next.spaceBefore = prior.spaceBefore; }
    if ((isMap(prior) && isMap(next)) || (isSeq(prior) && isSeq(next))) next.flow = prior.flow;
    // RF1: a stored canonical command is derived metadata; regenerate it when its pin/argv is edited.
    const runPath = o.invariant !== undefined ? 'run' : `checks.${p[1]}.run`;
    if (['run_file','args'].includes(at.path[0]!) && pinned.has(at.map)) regenerate.set(at.map,runPath);
    at.map.setIn(at.path,next);
  }
  for (const path of o.unset ?? []) {
    const at = locate(parts(path,o),false);
    if (!at || !at.map.deleteIn(at.path)) usage(`Cannot unset missing edit path: ${path}`);
    if (at.path[0] === 'args' && pinned.has(at.map)) regenerate.set(at.map,o.invariant !== undefined ? 'run' : `checks.${path.split('.')[1]}.run`);
  }
  for (const [map,runPath] of regenerate) if (map.has('run_file') && !(o.set ?? []).some(s => s.slice(0,s.indexOf('=')) === runPath)) map.delete('run');
  if (o.node_new) list.add(target);
  const documentText = doc.toString({ lineWidth:0 }), intended = canonical(parsePlan(documentText));
  const checked = (next: string): string => {
    if (canonical(parsePlan(next)) !== intended) throw new OwedError('cannot edit the plan: serialized YAML differs from the intended plan','internal');
    return next;
  };
  let contextual = !!list.flow || isMap(doc.contents) && !!doc.contents.flow;
  visit(target,(_key,node) => { if (isAlias(node) || isNode(node) && 'anchor' in node && node.anchor) contextual = true; });
  if (contextual) return checked(documentText);
  // A new block node is appended without re-emitting the existing nodes.
  if (o.node_new) {
    const first = list.items[0] as { range?: [number,number,number] } | undefined;
    const start = first?.range?.[0] ?? list.range![0], line = text.lastIndexOf('\n',start)+1;
    const indent = /^ */.exec(text.slice(line,start))![0];
    const rendered = stringify(target,{ lineWidth:0 }).trimEnd().split('\n').map((s,i) => `${indent}${i ? '  ' : '- '}${s}`).join('\n') + '\n';
    const end = list.range![2];
    return checked(text.slice(0,end) + (end && text[end-1] !== '\n' ? '\n' : '') + rendered + text.slice(end));
  }
  const range = target.range!;
  const startLine = text.lastIndexOf('\n',range[0])+1, indent = ' '.repeat(range[0]-startLine);
  const rendered = stringify(target,{ lineWidth:0 }).trimEnd().split('\n').map((s,i) => i ? indent+s : s).join('\n') + '\n';
  return checked(text.slice(0,range[0]) + rendered + text.slice(range[2]));
}
/** ED2: a compact diff of the changed region, accompanied by structured downgrade items in preview. */
export function editDiff(path: string, before: string, after: string): string {
  const a = before.trimEnd().split('\n'), b = after.trimEnd().split('\n');
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA-1] === b[endB-1]) { endA--; endB--; }
  return [`--- ${path}`,`+++ ${path}`,`@@ -${start+1},${endA-start} +${start+1},${endB-start} @@`,...a.slice(start,endA).map(s => `-${s}`),...b.slice(start,endB).map(s => `+${s}`)].join('\n');
}
