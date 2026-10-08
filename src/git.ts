import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { H, EMPTY_SHA, sha256 } from './canon.ts';
import { OwedError } from './errors.ts';
import { matchesAny } from './plan.ts';
import type { Plan, NodeSpec, CandidateFacts, StateFacts, CheckSpec } from './types.ts';

export function git(cwd: string, args: string[], opts?: { input?: string; allowFail?: boolean; env?: Record<string,string> }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: { ...process.env, ...opts?.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on('data', b => out.push(b)); p.stderr.on('data', b => err.push(b));
    p.on('error', e => reject(new OwedError(`git: ${e.message}`, 'internal')));
    p.on('close', code => {
      const result = { code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
      if (result.code && !opts?.allowFail) reject(new OwedError(`git ${args[0]}: ${result.stderr}`, 'internal')); else resolve(result);
    });
    p.stdin.on('error', () => {}); p.stdin.end(opts?.input);
  });
}
export async function repoRoot(cwd: string): Promise<string> { return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim(); }
export async function revParse(cwd: string, rev: string): Promise<string> { return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).stdout.trim(); }
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true });
  if (r.code > 1) throw new OwedError(r.stderr, 'internal'); return r.code === 0;
}
export async function isClean(worktree: string, untracked = true): Promise<boolean> { return !(await git(worktree, ['status', '--porcelain', `--untracked-files=${untracked ? 'all' : 'no'}`])).stdout; }
// [path, mode, oid]: the mode is content too (an executable bit or a symlink changes behavior).
async function files(cwd: string, commit: string): Promise<[string, string, string][]> {
  return (await git(cwd, ['ls-tree', '-rz', '--full-tree', commit])).stdout.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, , oid] = line.slice(0, tab).split(' '); return [line.slice(tab + 1), mode!, oid!] as [string, string, string];
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}
export async function readsDigest(cwd: string, commit: string, globs: string[]): Promise<string> { return H((await files(cwd, commit)).filter(([p]) => matchesAny(p, globs))); }
async function tree(cwd: string, commit: string): Promise<string> { return (await git(cwd, ['rev-parse', `${commit}^{tree}`])).stdout.trim(); }
async function checkKey(cwd: string, plan: Plan, spec: CheckSpec, commit: string, closure: string, o: string): Promise<string> {
  return H({ o, id: spec.id, run: spec.run, timeout_s: spec.timeout_s, setup: plan.setup, min_tests: spec.min_tests, closure, reads: await readsDigest(cwd, commit, spec.reads) });
}
export async function candidateFacts(cwd: string, plan: Plan, node: NodeSpec, base: string, commit: string, attempt: number): Promise<CandidateFacts> {
  base = await revParse(cwd, base); commit = await revParse(cwd, commit);
  const changed = (await git(cwd, ['diff', '--no-renames', '--name-only', '-z', base, commit])).stdout.split('\0').filter(Boolean);
  // Review identity = the exact bytes of the full-index binary diff (paths, modes, blob ids,
  // whitespace). patch-id is not used: it ignores whitespace, which can change meaning.
  const diff = (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', base, commit])).stdout;
  const patch = diff ? sha256(diff) : EMPTY_SHA;
  const closure = await readsDigest(cwd, base, plan.closure), keys: Record<string,string> = {};
  for (const c of node.checks) {
    keys[`check:${c.id}`] = await checkKey(cwd, plan, c, commit, closure, 'check');
    if (c.red) keys[`red:${c.id}`] = H({ o: 'red', id: c.id, run: c.run, red_expect: c.red_expect, timeout_s: c.timeout_s, setup: plan.setup, min_tests: c.min_tests, closure, base: await tree(cwd, base), tests: await readsDigest(cwd, commit, c.tests ?? []) });
  }
  keys.writes = H({ o: 'writes', base, cand: commit, writes: node.writes });
  const closureTouched = changed.some(p => matchesAny(p, plan.closure));
  if (closureTouched) keys['closure-review'] = H({ o: 'closure-review', patch });
  keys.review = H({ o: 'review', patch });
  keys.rulings = H({ o: 'rulings', attempt });
  return { commit, base, tree: await tree(cwd, commit), patch, changed, closureTouched, keys };
}
export async function stateFacts(cwd: string, plan: Plan, commit: string): Promise<StateFacts> {
  commit = await revParse(cwd, commit);
  const closure = await readsDigest(cwd, commit, plan.closure), invKeys: Record<string,string> = {};
  for (const c of plan.invariants) invKeys[c.id] = await checkKey(cwd, plan, c, commit, closure, 'inv');
  return { commit, tree: await tree(cwd, commit), invKeys };
}
export async function buildMerge(cwd: string, prior: string, cand: string, message: string): Promise<{ commit: string; tree: string } | { conflicts: string[] }> {
  const r = await git(cwd, ['merge-tree', '--write-tree', prior, cand], { allowFail: true });
  if (r.code === 1) return { conflicts: r.stdout.trim().split('\n').slice(1).filter(Boolean) };
  if (r.code) throw new OwedError(r.stderr, 'internal');
  const tree = r.stdout.trim().split('\n')[0]!;
  const env: Record<string,string> = {};
  for (const role of ['AUTHOR', 'COMMITTER']) { env[`GIT_${role}_NAME`] = process.env[`GIT_${role}_NAME`] ?? 'owed'; env[`GIT_${role}_EMAIL`] = process.env[`GIT_${role}_EMAIL`] ?? 'owed@localhost'; }
  const commit = (await git(cwd, ['commit-tree', tree, '-p', prior, '-p', cand], { input: message, env })).stdout.trim();
  return { commit, tree };
}
export async function advanceTrunk(cwd: string, trunk: string, from: string, to: string): Promise<void> {
  const ref = `refs/heads/${trunk}`;
  if ((await revParse(cwd, ref)) !== from) throw new OwedError('trunk changed (CAS)');
  const records = (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0');
  for (const record of records) {
    const fields = record.split('\0');
    if (!fields.includes(`branch ${ref}`)) continue;
    const path = fields.find(f => f.startsWith('worktree '))!.slice(9);
    // Untracked files are left to `merge --ff-only`, which refuses to overwrite them.
    if (!await isClean(path, false)) throw new OwedError('trunk worktree is dirty');
    if (!await isAncestor(cwd, from, to)) throw new OwedError('trunk advance is not a fast-forward');
    if (await revParse(cwd, ref) !== from) throw new OwedError('trunk changed (CAS)');
    const r = await git(path, ['merge', '--ff-only', to], { allowFail: true });
    if (r.code) throw new OwedError(r.stderr); return;
  }
  const r = await git(cwd, ['update-ref', ref, to, from], { allowFail: true });
  if (r.code) throw new OwedError(`trunk changed (CAS): ${r.stderr}`);
}
export async function addWorktree(cwd: string, path: string, branch: string, base: string): Promise<void> { await git(cwd, ['worktree', 'add', '-b', branch, path, base]); }
export async function materialize(cwd: string, commit: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'owed-run-')), path = join(root, 'tree');
  try { await git(cwd, ['worktree', 'add', '--detach', path, commit]); } catch (e) { await rm(root, { recursive: true, force: true }); throw e; }
  return { path, async dispose() { try { await git(cwd, ['worktree', 'remove', '--force', path]); } finally { await rm(root, { recursive: true, force: true }); } } };
}
export async function overlay(cwd: string, dir: string, fromCommit: string, globs: string[], mode: 'replace' | 'add'): Promise<void> {
  const source = (await files(cwd, fromCommit)).map(([p]) => p).filter(p => matchesAny(p, globs));
  if (mode === 'replace') {
    const current = (await git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(p => p && matchesAny(p, globs));
    for (const p of current) if (!source.includes(p)) await rm(join(dir, p), { recursive: true, force: true });
  }
  // Git restores modes, symlinks and binary content without shell interpolation.
  if (source.length) await git(dir, ['--literal-pathspecs', 'restore', `--source=${fromCommit}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: source.join('\0') + '\0' });
}
