import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
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
/** Top level of the worktree containing cwd (a linked worktree is its own top level). */
export async function repoRoot(cwd: string): Promise<string> { return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim(); }
/** Absolute git common directory shared by every worktree of the repository. */
export async function commonDir(cwd: string): Promise<string> { return resolve(cwd, (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()); }
async function realOr(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
/**
 * Top level of the repository's main worktree, the same from inside any linked worktree (ruling #122).
 * In the main worktree (git dir == common dir) it is `--show-toplevel`; this covers submodules
 * (common dir super/.git/modules/sub) and `--separate-git-dir`. In a linked worktree, d = dirname(common dir)
 * is used only when git at d reports the same common dir and d is its top level; otherwise OwedError('usage').
 */
export async function mainRoot(cwd: string): Promise<string> {
  const [gitDir, common] = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])).stdout.trim().split('\n').map(p => resolve(cwd, p));
  if (await realOr(gitDir!) === await realOr(common!)) return (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const d = dirname(common!), refuse = (): never => { throw new OwedError(`cannot locate the main worktree of this repository from the linked worktree ${cwd}: run owed from the main worktree`, 'usage'); };
  const there = await git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  if (there.code || await realOr(resolve(d, there.stdout.trim())) !== await realOr(common!)) refuse();
  const top = await git(d, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.code || await realOr(top.stdout.trim()) !== await realOr(d)) refuse();
  return top.stdout.trim();
}
/** Reads `path` (relative to cwd, or absolute inside the worktree) from commit `rev`; returns the resolved commit and repository-relative path. */
export async function readAt(cwd: string, rev: string, path: string): Promise<{ commit: string; path: string; text: string }> {
  const top = await realpath(await repoRoot(cwd)), abs = isAbsolute(path) ? path : resolve(await realpath(cwd), path);
  const rel = relative(top, abs).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) throw new OwedError(`${path} is not inside the repository`, 'usage');
  const resolved = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { allowFail: true });
  if (resolved.code) throw new OwedError(`${rev} is not a commit`, 'usage');
  const commit = resolved.stdout.trim(), file = posix.normalize(rel);
  const shown = await git(cwd, ['show', `${commit}:${file}`], { allowFail: true });
  if (shown.code) throw new OwedError(`${file} does not exist in ${rev} (${commit.slice(0, 12)})`, 'usage');
  return { commit, path: file, text: shown.stdout };
}
export async function revParse(cwd: string, rev: string): Promise<string> { return (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).stdout.trim(); }
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  const r = await git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true });
  if (r.code > 1) throw new OwedError(r.stderr, 'internal'); return r.code === 0;
}
/** Number of commits in from..to. */
export async function countCommits(cwd: string, from: string, to: string): Promise<number> { return Number((await git(cwd, ['rev-list', '--count', `${from}..${to}`])).stdout.trim()); }
/** Paths changed between two commits (`git diff --no-renames --name-only`). */
export async function changedPaths(cwd: string, from: string, to: string): Promise<string[]> { return (await git(cwd, ['diff', '--no-renames', '--name-only', '-z', from, to])).stdout.split('\0').filter(Boolean); }
/** How refs/heads/<trunk> relates to the ledger trunk commit, when they differ (SPEC §9 status, merge CAS). */
export interface TrunkDrift { ref: string; commit: string | null; ledger: string; relation: 'ahead' | 'diverged' | 'missing'; ahead: number; behind: number }
export async function trunkDrift(cwd: string, trunk: string, ledger: string): Promise<TrunkDrift | undefined> {
  const ref = `refs/heads/${trunk}`;
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowFail: true });
  if (r.code) return { ref, commit: null, ledger, relation: 'missing', ahead: 0, behind: 0 };
  const commit = r.stdout.trim();
  if (commit === ledger) return undefined;
  const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${ledger}...${commit}`], { allowFail: true });
  const [behind, ahead] = counts.code ? [0, 0] : counts.stdout.trim().split(/\s+/).map(Number) as [number, number];
  return { ref, commit, ledger, relation: !counts.code && behind === 0 && await isAncestor(cwd, ledger, commit) ? 'ahead' : 'diverged', ahead, behind };
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
    if (c.mutants) keys[`strength:${c.id}`] = await strengthKey(cwd, plan, c, base, commit, closure);
    if (c.red) keys[`red:${c.id}`] = H({ o: 'red', id: c.id, run: c.run, red_expect: c.red_expect, timeout_s: c.timeout_s, setup: plan.setup, min_tests: c.min_tests, closure, base: await tree(cwd, base), tests: await readsDigest(cwd, commit, c.tests ?? []) });
  }
  keys.writes = H({ o: 'writes', base, cand: commit, writes: node.writes });
  const closureTouched = changed.some(p => matchesAny(p, plan.closure));
  if (closureTouched) keys['closure-review'] = H({ o: 'closure-review', patch });
  keys.review = H({ o: 'review', patch });
  keys.rulings = H({ o: 'rulings', attempt });
  return { commit, base, tree: await tree(cwd, commit), patch, changed, closureTouched, keys };
}
/** Mutant patch paths of `commit` (the base): matching a mutant glob and the plan closure, sorted. */
export async function mutantPaths(cwd: string, commit: string, mutants: string[], closure: string[]): Promise<string[]> {
  return (await files(cwd, commit)).map(([p]) => p).filter(p => matchesAny(p, mutants) && matchesAny(p, closure));
}
async function strengthKey(cwd: string, plan: Plan, spec: CheckSpec, base: string, commit: string, closure: string): Promise<string> {
  const mutants = H((await files(cwd, base)).filter(([p]) => matchesAny(p, spec.mutants ?? []) && matchesAny(p, plan.closure)));
  return H({ o: 'strength', id: spec.id, run: spec.run, timeout_s: spec.timeout_s, setup: plan.setup, min_tests: spec.min_tests, min_kill: spec.min_kill ?? 1, closure, mutants, reads: await readsDigest(cwd, commit, spec.reads) });
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
export interface WorktreeRecord { path: string; branch?: string; locked: boolean; prunable: boolean }
export async function listWorktrees(cwd: string): Promise<WorktreeRecord[]> {
  return (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0').filter(Boolean).map(record => {
    const fields = record.split('\0'), field = (name: string) => fields.find(f => f === name || f.startsWith(`${name} `));
    return { path: field('worktree')!.slice(9), branch: field('branch')?.slice(7), locked: !!field('locked'), prunable: !!field('prunable') };
  });
}
export async function branchExists(cwd: string, branch: string): Promise<boolean> { return (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0; }
