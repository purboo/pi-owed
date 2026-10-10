import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, link, readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
export interface TrunkDrift { ref: string; commit: string | null; ledger: string; relation: 'ahead' | 'diverged' | 'missing' | 'ledger-missing'; ahead: number; behind: number }
export async function trunkDrift(cwd: string, trunk: string, ledger: string): Promise<TrunkDrift | undefined> {
  const ref = `refs/heads/${trunk}`;
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { allowFail: true });
  if (r.code) return { ref, commit: null, ledger, relation: 'missing', ahead: 0, behind: 0 };
  const commit = r.stdout.trim();
  if (commit === ledger) return undefined;
  if ((await git(cwd, ['cat-file', '-e', `${ledger}^{commit}`], { allowFail: true })).code) return { ref, commit, ledger, relation: 'ledger-missing', ahead: 0, behind: 0 };
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
/** The `exec` part of a check/red/strength/inv key (D20): only the non-empty fields, undefined (dropped by canonical JSON) without exec. */
export function execKey(plan: Plan): { env?: Record<string, string>; wrap?: string[] } | undefined {
  const env = plan.exec?.env && Object.keys(plan.exec.env).length ? plan.exec.env : undefined, wrap = plan.exec?.wrap?.length ? plan.exec.wrap : undefined;
  return env || wrap ? { env, wrap } : undefined;
}
async function checkKey(cwd: string, plan: Plan, spec: CheckSpec, commit: string, closure: string, o: string): Promise<string> {
  return H({ o, id: spec.id, run: spec.run, timeout_s: spec.timeout_s, setup: plan.setup, exec: execKey(plan), min_tests: spec.min_tests, closure, reads: await readsDigest(cwd, commit, spec.reads) });
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
    if (c.red) keys[`red:${c.id}`] = H({ o: 'red', id: c.id, run: c.run, red_expect: c.red_expect, timeout_s: c.timeout_s, setup: plan.setup, exec: execKey(plan), min_tests: c.min_tests, closure, base: await tree(cwd, base), tests: await readsDigest(cwd, commit, c.tests ?? []) });
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
  return H({ o: 'strength', id: spec.id, run: spec.run, timeout_s: spec.timeout_s, setup: plan.setup, exec: execKey(plan), min_tests: spec.min_tests, min_kill: spec.min_kill ?? 1, closure, mutants, reads: await readsDigest(cwd, commit, spec.reads) });
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
    if (!await isClean(path, false)) throw new OwedError(trunkDirtyText(path));
    if (!await isAncestor(cwd, from, to)) throw new OwedError('trunk advance is not a fast-forward');
    if (await revParse(cwd, ref) !== from) throw new OwedError('trunk changed (CAS)');
    const r = await git(path, ['merge', '--ff-only', to], { allowFail: true });
    if (r.code) throw new OwedError(r.stderr); return;
  }
  const r = await git(cwd, ['update-ref', ref, to, from], { allowFail: true });
  if (r.code) throw new OwedError(`trunk changed (CAS): ${r.stderr}`);
}
/** D19.5: refusal of a merge whose trunk worktree has uncommitted changes. */
export const trunkDirtyText = (path: string): string => `trunk worktree ${path} has uncommitted changes: commit them there, or detach it (git -C ${path} switch --detach), then retry`;
/**
 * D19.5: path of the worktree that has refs/heads/<trunk> checked out when it is not the main worktree (merges
 * fast-forward it there), else undefined. A layout whose main worktree cannot be located reports nothing.
 */
export async function trunkElsewhere(cwd: string, trunk: string): Promise<string | undefined> {
  let main: string; try { main = await realOr(await mainRoot(cwd)); } catch { return undefined; }
  const tree = (await listWorktrees(cwd)).find(w => w.branch === `refs/heads/${trunk}`);
  return tree && await realOr(tree.path) !== main ? tree.path : undefined;
}
export async function addWorktree(cwd: string, path: string, branch: string, base: string): Promise<void> { await git(cwd, ['worktree', 'add', '-b', branch, path, base]); }
/** 0.9 (M2): a reused measurement tree for one check: `kind` inv/check/red/strength and the check id. */
export interface ReuseSpec { kind: string; id: string; /** receives the one-line note when a reused tree cannot be prepared */ note?(line: string): void }
/**
 * A tree at `commit` for one measurement. Fresh (default): a new detached worktree under the system temp dir, removed
 * by dispose. With `reuse` (exec.trees: reuse): the stable tree `<git common dir>/owed/trees/<kind>-<id>-<k>` under the
 * lowest free lease k, prepared by `git checkout --detach --force` and `git clean -ffdx`; dispose releases the lease
 * and keeps the tree. A reused tree that cannot be prepared falls back to a fresh one (with `reuse.note`).
 */
export async function materialize(cwd: string, commit: string, reuse?: ReuseSpec): Promise<{ path: string; dispose(): Promise<void> }> {
  if (reuse) {
    try { return await reusedTree(cwd, commit, reuse.kind, reuse.id); }
    catch (e) { reuse.note?.(`reused tree for ${reuse.kind} ${reuse.id} unavailable, measuring in a fresh tree: ${(e instanceof Error ? e.message : String(e)).trim().split('\n')[0]}`); }
  }
  const root = await mkdtemp(join(tmpdir(), 'owed-run-')), path = join(root, 'tree');
  try { await git(cwd, ['worktree', 'add', '--detach', path, commit]); } catch (e) { await rm(root, { recursive: true, force: true }); throw e; }
  return { path, async dispose() { try { await git(cwd, ['worktree', 'remove', '--force', path]); } finally { await rm(root, { recursive: true, force: true }); } } };
}
/** Directory of the reused measurement trees (M2): `<git common dir>/owed/trees`. */
export async function reuseDir(cwd: string): Promise<string> { return join(await commonDir(cwd), 'owed', 'trees'); }
/** The path-safe form of a check id in a reused tree name: the id itself when safe, else `h` + 16 hex of its sha256. */
export function treeId(id: string): string { return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ? id : `h${sha256(id).slice(0, 16)}`; }
/** Parses a reused tree directory name `<kind>-<tree id>-<k>`. */
export function parseTreeName(name: string): { kind: string; id: string; k: number } | undefined {
  const m = /^(inv|check|red|strength)-(.+)-(\d+)$/.exec(name); return m ? { kind: m[1]!, id: m[2]!, k: Number(m[3]) } : undefined;
}
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}
/** An empty or unparsable lock older than this is dead (a crash between create and write of an older owed). */
export const LEASE_EMPTY_DEAD_MS = 60_000;
/** gc removes reclaim tokens (`<lock>.dead-<X>`) older than this: their reclaimer crashed. */
export const LEASE_TOKEN_STALE_MS = 3_600_000;
/** Whether lock content `held` (of the lock file `lock`) is dead: a dead pid, or empty/unparsable and older than 60 s. */
async function deadContent(lock: string, held: string): Promise<boolean> {
  const t = held.trim();
  if (/^[1-9][0-9]*$/.test(t)) return !alive(Number(t));
  try { return Date.now() - (await stat(lock)).mtimeMs > LEASE_EMPTY_DEAD_MS; } catch { return false; }
}
/** The `<X>` of a reclaim token for lock content `held`: the dead pid, else `h` + 16 hex of the content's sha256. */
const tokenOf = (held: string): string => /^[1-9][0-9]*$/.test(held.trim()) ? held.trim() : `h${sha256(held).slice(0, 16)}`;
/** Atomic take: the pid is written to a unique temp file which is then link()ed to `lock`, so a lock is never empty. */
async function linkTake(lock: string): Promise<boolean> {
  const tmp = `${lock}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, `${process.pid}\n`, { flag: 'wx' });
  try { await link(tmp, lock); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
  finally { await rm(tmp, { force: true }); }
}
/**
 * Takes the lease `lock` (it then holds this pid; created by link(), never empty). A lock whose content X is dead (a dead
 * pid, or empty/unparsable and older than 60 s) is reclaimed under the token `<lock>.dead-<X>`, created with O_EXCL:
 * holding it, the reclaimer re-reads the lock, unlinks it only when it still holds X, tries the normal take once, and
 * unlinks the token. A reclaimer that loses the token, or the take, does nothing more for this lock. Returns false
 * when the lease is not taken (held, or lost to a racing taker).
 */
export async function takeLease(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await linkTake(lock)) return true;
    let held: string;
    try { held = await readFile(lock, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (!await deadContent(lock, held)) return false;
    const token = `${lock}.dead-${tokenOf(held)}`;
    try { await writeFile(token, `${process.pid}\n`, { flag: 'wx' }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    try {
      let again: string | undefined;
      try { again = await readFile(lock, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (again === held) await rm(lock, { force: true });
      return await linkTake(lock);
    } finally { await rm(token, { force: true }); }
  }
  return false;
}
/** Releases a lease this process holds (only when the file still holds this pid). */
export async function releaseLease(lock: string): Promise<void> {
  try { if ((await readFile(lock, 'utf8')).trim() === String(process.pid)) await rm(lock, { force: true }); } catch { /* already gone */ }
}
/** Whether a reused tree's lease is free: no lock file, or one whose content is dead. */
export async function leaseFree(lock: string): Promise<boolean> {
  try { return await deadContent(lock, await readFile(lock, 'utf8')); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; }
}
/** Removes reclaim tokens in the reuse dir older than LEASE_TOKEN_STALE_MS (unless `dryRun`); returns their paths. */
export async function staleTokens(cwd: string, dryRun: boolean): Promise<string[]> {
  const dir = await reuseDir(cwd), out: string[] = [];
  let names: string[]; try { names = await readdir(dir); } catch { return []; }
  for (const name of names.filter(n => /\.lock\.dead-[^/]+$/.test(n)).sort()) {
    const path = join(dir, name);
    try { if (Date.now() - (await stat(path)).mtimeMs <= LEASE_TOKEN_STALE_MS) continue; } catch { continue; }
    if (!dryRun) await rm(path, { force: true });
    out.push(path);
  }
  return out;
}
/** Whether `path` is a worktree of the repository of `cwd` whose top level is `path` itself. */
async function ownTree(cwd: string, path: string): Promise<boolean> {
  try { if (!(await stat(path)).isDirectory()) return false; } catch { return false; }
  const top = await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { allowFail: true });
  if (top.code) return false;
  const [t, c] = top.stdout.trim().split('\n');
  return !!t && !!c && await realOr(t) === await realOr(path) && await realOr(resolve(path, c)) === await realOr(await commonDir(cwd));
}
async function reusedTree(cwd: string, commit: string, kind: string, id: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await reuseDir(cwd), name = `${kind}-${treeId(id)}`;
  await mkdir(dir, { recursive: true });
  let k = 0;
  for (; !await takeLease(join(dir, `${name}-${k}.lock`)); k++) if (k > 1000) throw new Error('no free reused tree lease');
  const path = join(dir, `${name}-${k}`), lock = `${path}.lock`;
  try {
    let ready = false;
    if (await ownTree(cwd, path)) {
      const co = await git(path, ['checkout', '--detach', '--force', commit], { allowFail: true });
      ready = !co.code && !(await git(path, ['clean', '-ffdx'], { allowFail: true })).code;
      // A fresh `git worktree add` tree has empty submodule directories: deinit makes a reused one match.
      if (ready && await stat(join(path, '.gitmodules')).then(() => true, () => false)) ready = !(await git(path, ['submodule', 'deinit', '--all', '--force'], { allowFail: true })).code;
    }
    if (!ready) {
      // Missing or broken: recreate it (-f overrides a registration whose directory is gone).
      await git(cwd, ['worktree', 'remove', '--force', path], { allowFail: true });
      await rm(path, { recursive: true, force: true });
      await git(cwd, ['worktree', 'add', '-f', '--detach', path, commit]);
    }
  } catch (e) { await releaseLease(lock); throw e; }
  return { path, async dispose() { await releaseLease(lock); } };
}
/**
 * The reused measurement trees (M2) of the repository: directory name, path, lock, parsed name, and whether the lease
 * is free.
 */
export async function reusedTrees(cwd: string): Promise<{ name: string; path: string; lock: string; kind: string; id: string; k: number; free: boolean }[]> {
  const dir = await reuseDir(cwd); let names: string[];
  try { names = (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
  const out = [];
  for (const name of names) { const p = parseTreeName(name); if (!p) continue; const path = join(dir, name), lock = `${path}.lock`; out.push({ name, path, lock, ...p, free: await leaseFree(lock) }); }
  return out;
}
/** Removes a reused tree under its own lease (taken here); false when a live process holds the lease. */
export async function removeReusedTree(cwd: string, path: string): Promise<boolean> {
  const lock = `${path}.lock`;
  if (!await takeLease(lock)) return false;
  try { await git(cwd, ['worktree', 'remove', '--force', path], { allowFail: true }); await rm(path, { recursive: true, force: true }); await git(cwd, ['worktree', 'prune'], { allowFail: true }); }
  finally { await releaseLease(lock); }
  return true;
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
