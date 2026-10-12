import { parseDocument, stringify, isMap, isSeq, isNode, type YAMLMap } from 'yaml';
import { OwedError } from './errors.ts';

/** ED1: YAML values, with paths relative to a node or invariant. */
export interface EditFields {
  node?: string; invariant?: string; node_new?: boolean;
  set?: string[]; unset?: string[];
}
function usage(text: string): never { throw new OwedError(text,'usage'); }
const checkFields = ['run','timeout_s','reads','min_tests','red','tests','red_expect','mutants','min_kill','repeat'];
function parts(path: string, o: EditFields): string[] {
  const p = path.split('.');
  if (p.some(x => !x || ['__proto__','prototype','constructor'].includes(x))) usage(`Invalid edit path: ${path}`);
  if (o.invariant !== undefined) {
    if (p.length !== 1 || !checkFields.includes(p[0]!)) usage(`Invalid invariant edit path: ${path}; use a check field other than id`);
  } else {
    const simple = ['title','brief','deps','writes','later'];
    const valid = p.length === 1 && simple.includes(p[0]!) || p.length === 2 && p[0] === 'review' && ['count','min_rank'].includes(p[1]!) || p[0] === 'drive' && p.length >= 2 || p[0] === 'checks' && (p.length === 2 || p.length === 3 && checkFields.includes(p[2]!));
    if (!valid || o.node_new && !['title','brief','deps','writes','checks'].includes(p[0]!)) usage(`Invalid node edit path: ${path}`);
  }
  return p;
}
/** ED1: edit only the target map's source range; bytes outside it retain their original layout. */
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
    return { map:check as YAMLMap, path:[p[2]!] };
  };
  for (const assignment of o.set ?? []) {
    const eq = assignment.indexOf('=');
    if (eq < 1) usage(`--set needs path=yaml: ${assignment}`);
    const p = parts(assignment.slice(0,eq),o), value = parseDocument(assignment.slice(eq+1));
    if (value.errors.length) usage(`Invalid YAML value for ${p.join('.')}: ${value.errors.map(e => e.message).join('; ')}`);
    const v = value.toJS();
    if (p[0] === 'checks' && p.length === 2 && o.invariant === undefined) {
      if (!isMap(value.contents)) usage(`checks.${p[1]} needs a whole mapping`);
      if (Object.keys(v).some(k => k !== 'id' && !checkFields.includes(k))) usage(`checks.${p[1]} mapping has an unknown field`);
      if (v.id !== undefined && v.id !== p[1]) usage(`checks.${p[1]} mapping has a different id`);
      value.set('id',p[1]);
    }
    const at = locate(p,true)!, prior = at.map.getIn(at.path,true), next = doc.createNode(value.toJS());
    if (isNode(prior)) { next.comment = prior.comment; next.commentBefore = prior.commentBefore; next.spaceBefore = prior.spaceBefore; }
    if ((isMap(prior) && isMap(next)) || (isSeq(prior) && isSeq(next))) next.flow = prior.flow;
    at.map.setIn(at.path,next);
  }
  for (const path of o.unset ?? []) {
    const at = locate(parts(path,o),false);
    if (!at || !at.map.deleteIn(at.path)) usage(`Cannot unset missing edit path: ${path}`);
  }
  // A new node is appended without re-emitting the existing nodes.
  if (o.node_new) {
    if (list.flow) { list.add(target); const range = list.range!; return text.slice(0,range[0]) + stringify(list,{ lineWidth:0 }).trimEnd() + text.slice(range[1]); }
    const first = list.items[0] as { range?: [number,number,number] } | undefined;
    const start = first?.range?.[0] ?? list.range![0], line = text.lastIndexOf('\n',start)+1;
    const indent = /^ */.exec(text.slice(line,start))![0];
    const rendered = stringify(target,{ lineWidth:0 }).trimEnd().split('\n').map((s,i) => `${indent}${i ? '  ' : '- '}${s}`).join('\n') + '\n';
    const end = list.range![2];
    return text.slice(0,end) + (end && text[end-1] !== '\n' ? '\n' : '') + rendered + text.slice(end);
  }
  const range = target.range!;
  const startLine = text.lastIndexOf('\n',range[0])+1, indent = ' '.repeat(range[0]-startLine);
  const rendered = stringify(target,{ lineWidth:0 }).trimEnd().split('\n').map((s,i) => i ? indent+s : s).join('\n') + '\n';
  return text.slice(0,range[0]) + rendered + text.slice(range[2]);
}
/** ED2: a compact diff of the changed region, accompanied by structured downgrade items in preview. */
export function editDiff(path: string, before: string, after: string): string {
  const a = before.trimEnd().split('\n'), b = after.trimEnd().split('\n');
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA-1] === b[endB-1]) { endA--; endB--; }
  return [`--- ${path}`,`+++ ${path}`,`@@ -${start+1},${endA-start} +${start+1},${endB-start} @@`,...a.slice(start,endA).map(s => `-${s}`),...b.slice(start,endB).map(s => `+${s}`)].join('\n');
}
