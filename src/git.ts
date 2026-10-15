import { writesKeySyntax } from './writes.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, link, readdir, stat, lstat, lutimes, rename } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { H, sha256 } from './canon.ts';
import { OwedError } from './errors.ts';
import { assertNoLedgerLock } from './lock-context.ts';
import { matchesAny, type QuarantineNames } from './plan.ts';
import type { Plan, NodeSpec, CandidateFacts, StateFacts, CheckSpec, ExecConfig } from './types.ts';

/** Buffered git output is bounded, including stderr; the review diff uses the streaming path below. */
export const GIT_MAX_OUTPUT_BYTES = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
/** Test seams: lower the buffering bound or split hash input into small chunks. Neither enters a key. */
export const gitHooks: { maxOutputBytes?: number; hashChunkBytes?: number } = {};
interface GitOptions { input?: string; allowFail?: boolean; env?: Record<string, string>; maxOutputBytes?: number }
export function git(cwd: string, args: string[], opts?: GitOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  return runGit(cwd, args, opts);
}
function runGit(cwd: string, args: string[], opts?: GitOptions, stdout?: (chunk: Buffer) => void, ledgerExemption?: 'advanceTrunk'): Promise<{ code: number; stdout: string; stderr: string }> {
  const limit = Math.min(opts?.maxOutputBytes ?? gitHooks.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES, GIT_MAX_OUTPUT_BYTES);
  const subcommand = args.find(arg => !arg.startsWith('-')) ?? args[0];
  // Worktree mutations can run hooks or rewrite many files; ref CAS/read-only facts remain local and short.
  const allowedFastForward = ledgerExemption === 'advanceTrunk' && args.length === 3 && args[0] === 'merge' && args[1] === '--ff-only';
  if (!allowedFastForward && (['merge', 'switch', 'checkout', 'reset', 'clean'].includes(subcommand ?? '') || (subcommand === 'worktree' && args.some(a => ['add','remove','prune'].includes(a))))) assertNoLedgerLock();
  if (!Number.isFinite(limit) || limit <= 0) return Promise.reject(new OwedError('git output bound must be positive', 'usage'));
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: { ...process.env, ...opts?.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: OwedError | undefined;
    const collect = (chunk: Buffer, target: Buffer[]): void => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > limit) {
        failure = new OwedError(`git ${subcommand} output exceeds ${limit} bytes; refused to buffer it`, 'refused');
        out.length = err.length = 0;
        p.kill('SIGKILL');
      } else target.push(chunk);
    };
    p.stdout.on('data', (b: Buffer) => { if (!failure) { if (stdout) stdout(b); else collect(b, out); } });
    p.stderr.on('data', (b: Buffer) => collect(b, err));
    p.on('error', e => reject(new OwedError(`git: ${e.message}`, 'internal')));
    p.on('close', code => {
      if (failure) { reject(failure); return; }
      const result = { code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
      if (result.code && !opts?.allowFail) reject(new OwedError(`git ${args[0]}: ${result.stderr}`, 'internal')); else resolve(result);
    });
    p.stdin.on('error', () => {}); p.stdin.end(opts?.input);
  });
}
/** Hash the 0.13 UTF-8 decoded/re-encoded diff, preserving replacement and split-character semantics. */
async function diffHash(cwd: string, base: string, commit: string): Promise<string> {
  const hash = createHash('sha256'), decoder = new StringDecoder('utf8'), chunkBytes = gitHooks.hashChunkBytes;
  await runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', base, commit], undefined, b => {
    if (chunkBytes && Number.isInteger(chunkBytes) && chunkBytes > 0) {
      for (let i = 0; i < b.length; i += chunkBytes) hash.update(decoder.write(b.subarray(i, i + chunkBytes)));
    } else hash.update(decoder.write(b));
  });
  hash.update(decoder.end());
  return hash.digest('hex');
}
/** Submit-only size policy: inspect new blob ids and sizes, never blob content. Deletions/gitlinks add no bytes. */
export async function checkCandidateLimits(cwd: string, limits: Plan['limits'], base: string, commit: string): Promise<void> {
  if (limits?.file_mib === undefined && limits?.diff_mib === undefined) return;
  const raw = (await git(cwd, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, commit])).stdout.split('\0');
  const changed: { path: string; oid: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const fields = raw[i]!.split(' '), mode = fields[1]!, oid = fields[3]!;
    if (mode === '000000' || mode === '160000') continue;
    changed.push({ path: raw[i + 1]!, oid });
  }
  if (!changed.length) return;
  const oids = [...new Set(changed.map(f => f.oid))];
  const batch = await git(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: oids.join('\n') + '\n' });
  const sizes = new Map(batch.stdout.trim().split('\n').map(line => {
    const [oid, type, size] = line.split(' ');
    if (type !== 'blob' || !Number.isSafeInteger(Number(size))) throw new OwedError(`git cat-file: expected blob size for ${oid}`, 'internal');
    return [oid!, Number(size)] as const;
  }));
  const files = changed.map(f => ({ path: f.path, bytes: sizes.get(f.oid)! })).sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = files.reduce((sum, f) => sum + f.bytes, 0), exceeded: string[] = [];
  if (limits.file_mib !== undefined && files[0]!.bytes > limits.file_mib * 1024 * 1024) exceeded.push(`limits.file_mib ${limits.file_mib} MiB (largest changed file: ${files[0]!.bytes} bytes)`);
  if (limits.diff_mib !== undefined && total > limits.diff_mib * 1024 * 1024) exceeded.push(`limits.diff_mib ${limits.diff_mib} MiB (total added/changed blobs: ${total} bytes)`);
  if (exceeded.length) throw new OwedError(`submit refused: candidate exceeds ${exceeded.join('; ')}\nLargest changed files (up to 5):\n${files.slice(0, 5).map(f => `${JSON.stringify(f.path)}: ${f.bytes} bytes (${(f.bytes / 1024 / 1024).toFixed(3)} MiB)`).join('\n')}`, 'refused');
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
/**
 * SB1: the newest trunk commit that `commit` contains but slot base `base` does not: a merge base of `commit` and the
 * ledger trunk `trunk` that strictly descends from `base`; undefined when the candidate holds no later trunk work.
 */
export async function trunkAfterBase(cwd: string, base: string, commit: string, trunk: string): Promise<string | undefined> {
  const r = await git(cwd, ['merge-base', '--all', commit, trunk], { allowFail: true });
  if (r.code) return undefined;
  for (const m of r.stdout.split('\n').map(x => x.trim()).filter(Boolean)) if (m !== base && await isAncestor(cwd, base, m)) return m;
  return undefined;
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
/** AT2: files matching `globs` at `commit` that do not exist at `base` (tests new in the candidate). */
export async function newFiles(cwd: string, base: string, commit: string, globs: string[]): Promise<string[]> {
  if (!globs.length) return [];
  const old = new Set((await files(cwd, base)).map(([p]) => p));
  return (await files(cwd, commit)).map(([p]) => p).filter(p => matchesAny(p, globs) && !old.has(p));
}
async function tree(cwd: string, commit: string): Promise<string> { return (await git(cwd, ['rev-parse', `${commit}^{tree}`])).stdout.trim(); }
/** The `exec` part of a check/red/strength/inv key (D20): only the non-empty fields, undefined (dropped by canonical JSON) without exec. */
export function execKey(plan: Plan): Pick<ExecConfig, 'env' | 'wrap' | 'touch'> | undefined {
  const env = plan.exec?.env && Object.keys(plan.exec.env).length ? plan.exec.env : undefined, wrap = plan.exec?.wrap?.length ? plan.exec.wrap : undefined;
  const touch = plan.exec?.touch;
  return env || wrap || touch ? { env, wrap, touch } : undefined;
}
/** MS4: `quarantine` (sorted active names) is present only when non-empty, so a key without active entries is the 0.17 key. */
async function checkKey(cwd: string, plan: Plan, spec: CheckSpec, commit: string, closure: string, o: string, quarantine: string[] = []): Promise<string> {
  return H({ o, id: spec.id, run: spec.run, timeout_s: spec.timeout_s, setup: plan.setup, exec: execKey(plan), min_tests: spec.min_tests, repeat: spec.repeat ? { runs: spec.repeat.runs, need: spec.repeat.need ?? spec.repeat.runs } : undefined, closure, reads: await readsDigest(cwd, commit, spec.reads), quarantine: quarantine.length ? [...quarantine].sort() : undefined });
}
/** TR1: the node check's own key on trunk, with closure pinned from that same commit. */
export async function trunkCheckKey(cwd: string, plan: Plan, spec: CheckSpec, commit: string, q?: QuarantineNames): Promise<string> {
  return checkKey(cwd, plan, spec, commit, await readsDigest(cwd, commit, plan.closure), 'check', q?.(spec));
}
/**
 * MS4: whether the key of check/inv job (`kind`, `spec`, `key`, measured on `commit`, closure from `base` for a
 * check and `commit` for an invariant) commits to exactly the quarantine names `names`. The executor excuses a
 * quarantined failure only then, so a stale key can never be satisfied by an excuse it does not name.
 */
export async function keyCommitsTo(cwd: string, plan: Plan, job: { kind: string; spec?: CheckSpec; key: string; commit: string; base: string }, names: string[]): Promise<boolean> {
  if (!job.spec || (job.kind !== 'inv' && job.kind !== 'check')) return false;
  const closure = await readsDigest(cwd, job.kind === 'inv' ? job.commit : job.base, plan.closure);
  return await checkKey(cwd, plan, job.spec, job.commit, closure, job.kind, names) === job.key;
}
export async function candidateFacts(cwd: string, plan: Plan, node: NodeSpec, base: string, commit: string, attempt: number, q?: QuarantineNames): Promise<CandidateFacts> {
  base = await revParse(cwd, base); commit = await revParse(cwd, commit);
  const changed = (await git(cwd, ['diff', '--no-renames', '--name-only', '-z', base, commit])).stdout.split('\0').filter(Boolean);
  // Review identity preserves 0.13's UTF-8 decoding, while retaining only one stdout chunk at a time.
  // patch-id is not used: it ignores whitespace, which can change meaning.
  const patch = await diffHash(cwd, base, commit);
  const closure = await readsDigest(cwd, base, plan.closure), keys: Record<string,string> = {};
  for (const c of node.checks) {
    keys[`check:${c.id}`] = await checkKey(cwd, plan, c, commit, closure, 'check', q?.(c));
    if (c.mutants) keys[`strength:${c.id}`] = await strengthKey(cwd, plan, c, base, commit, closure);
    if (c.red) keys[`red:${c.id}`] = H({ o: 'red', id: c.id, run: c.run, red_expect: c.red_expect, timeout_s: c.timeout_s, setup: plan.setup, exec: execKey(plan), min_tests: c.min_tests, closure, base: await tree(cwd, base), tests: await readsDigest(cwd, commit, c.tests ?? []) });
  }
  keys.writes = H({ o: 'writes', base, cand: commit, writes: node.writes, ...writesKeySyntax(plan,node.writes) });
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
export async function stateFacts(cwd: string, plan: Plan, commit: string, q?: QuarantineNames): Promise<StateFacts> {
  commit = await revParse(cwd, commit);
  const closure = await readsDigest(cwd, commit, plan.closure), invKeys: Record<string,string> = {};
  for (const c of plan.invariants) invKeys[c.id] = await checkKey(cwd, plan, c, commit, closure, 'inv', q?.(c));
  return { commit, tree: await tree(cwd, commit), invKeys };
}
/** UX3: resolve request metadata once; memoize unordered probes, including cache misses. */
export async function conflictProbe(cwd: string, commits: string[]): Promise<(left: string, right: string) => Promise<string[] | undefined>> {
  let dir: string;
  try { dir = join(await commonDir(cwd), 'owed', 'cache'); }
  catch { return async () => undefined; }
  const resolved = new Map(await Promise.all([...new Set(commits)].map(async ref => [ref, await revParse(cwd, ref).catch(() => undefined)] as const)));
  const pairs = new Map<string, Promise<string[] | undefined>>();
  return (left, right) => {
    const a = resolved.get(left), b = resolved.get(right);
    if (!a || !b) return Promise.resolve(undefined);
    const pair = [a, b].sort(), key = pair.join('-');
    let pending = pairs.get(key);
    if (!pending) { pending = conflictPaths(cwd, dir, pair); pairs.set(key, pending); }
    return pending;
  };
}
/** Immutable commit-pair diagnostics; never acceptance evidence. */
async function conflictPaths(cwd: string, dir: string, pair: string[]): Promise<string[] | undefined> {
  try {
    const file = join(dir, `conflicts-${pair.join('-')}.json`);
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'));
      if (cached.version === 1 && cached.pair?.join(':') === pair.join(':') && Array.isArray(cached.paths) && cached.paths.every((p: unknown) => typeof p === 'string')) return cached.paths;
    } catch { /* missing or corrupt cache: probe again */ }
    const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ...pair], { allowFail: true });
    const fields = r.stdout.split('\0').filter(Boolean);
    if (![0, 1].includes(r.code) || !/^[0-9a-f]{40,64}$/.test(fields[0] ?? '')) return undefined;
    const paths = r.code === 0 ? [] : [...new Set(fields.slice(1))].sort();
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { await mkdir(dir, { recursive: true }); await writeFile(temp, JSON.stringify({ version: 1, pair, paths })); await rename(temp, file); }
    catch { /* read-only cache does not suppress diagnostics */ }
    finally { await rm(temp, { force: true }).catch(() => undefined); }
    return paths;
  } catch { return undefined; }
}
export async function buildMerge(cwd: string, prior: string, cand: string, message: string): Promise<{ commit: string; tree: string } | { conflicts: string[] }> {
  const r = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', prior, cand], { allowFail: true });
  if (r.code === 1) return { conflicts: [...new Set(r.stdout.split('\0').slice(1).filter(Boolean))].sort() };
  if (r.code) throw new OwedError(r.stderr, 'internal');
  const tree = r.stdout.split('\0')[0]!;
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
    // LKR #2310: the single ledger-lock exemption is this fast-forward of an already measured commit.
    // Keep the user's trunk attached; post-merge/reference-transaction hooks consequently run under lock.
    const r = await runGit(path, ['merge', '--ff-only', to], { allowFail: true }, undefined, 'advanceTrunk');
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
export interface ReuseSpec { kind: string; id: string; touch?: 'reset' | 'always' | 'never'; /** receives the one-line note when a reused tree cannot be prepared */ note?(line: string): void }
/**
 * A tree at `commit` for one measurement. Fresh (default): a new detached worktree under the system temp dir, removed
 * by dispose. With `reuse` (exec.trees: reuse): the stable tree `<git common dir>/owed/trees/<kind>-<id>-<k>` under the
 * lowest free lease k, prepared by `git checkout --detach --force` and `git clean -ffdx`; dispose releases the lease
 * and keeps the tree. A reused tree that cannot be prepared falls back to a fresh one (with `reuse.note`).
 */
export async function materialize(cwd: string, commit: string, reuse?: ReuseSpec): Promise<{ path: string; dispose(): Promise<void> }> {
  if (reuse) {
    try { return await reusedTree(cwd, commit, reuse.kind, reuse.id, reuse.touch ?? 'reset'); }
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
  await staleTemps(dirname(lock), lock);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await linkTake(lock)) return true;
    let held: string;
    try { held = await readFile(lock, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
    if (!await deadContent(lock, held)) return false;
    const token = `${lock}.dead-${tokenOf(held)}`;
    try { await writeFile(token, `${process.pid}\n`, { flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A token older than 1 h belongs to a crashed reclaimer: remove it and try again; a younger one wins.
      if (await olderThan(token, LEASE_TOKEN_STALE_MS)) { await rm(token, { force: true }); continue; }
      return false;
    }
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
/**
 * Empties the directory of every gitlink (mode 160000) of the index of the tree `path`: its contents (a `.git` file
 * included) are removed and the empty directory kept, as a fresh `git worktree add` leaves it. Touches nothing outside
 * the tree (no config, no modules dir).
 */
async function emptyGitlinks(path: string): Promise<void> {
  const entries = (await git(path, ['ls-files', '-s', '-z'])).stdout.split('\0').filter(l => l.startsWith('160000 '));
  for (const line of entries) {
    const dir = join(path, line.slice(line.indexOf('\t') + 1));
    let isDir = false; try { isDir = (await lstat(dir)).isDirectory(); } catch { /* missing */ }
    if (!isDir) { await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true }); continue; }
    for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
  }
}
/** Removes `<lock>.tmp-*` files of crashed takers older than 60 s in the directory of `lock` (`lock` undefined: of every lock); returns them. */
async function staleTemps(dir: string, lock: string | undefined, dryRun = false): Promise<string[]> {
  const out: string[] = [], prefix = lock === undefined ? undefined : `${basename(lock)}.tmp-`;
  let names: string[]; try { names = await readdir(dir); } catch { return []; }
  for (const name of names.filter(n => prefix ? n.startsWith(prefix) : /\.lock\.tmp-[^/]+$/.test(n)).sort()) {
    const p = join(dir, name);
    try { if (Date.now() - (await stat(p)).mtimeMs <= LEASE_EMPTY_DEAD_MS) continue; } catch { continue; }
    if (!dryRun) await rm(p, { force: true });
    out.push(p);
  }
  return out;
}
/** Whether the file at `path` is older than `ms` (false when it is gone). */
async function olderThan(path: string, ms: number): Promise<boolean> { try { return Date.now() - (await stat(path)).mtimeMs > ms; } catch { return false; } }
/** Removes reclaim tokens in the reuse dir older than LEASE_TOKEN_STALE_MS (unless `dryRun`); returns their paths. */
export async function staleTokens(cwd: string, dryRun: boolean): Promise<string[]> {
  const dir = await reuseDir(cwd), out: string[] = [];
  let names: string[]; try { names = await readdir(dir); } catch { return []; }
  for (const name of names.filter(n => /\.lock\.dead-[^/]+$/.test(n)).sort()) {
    const path = join(dir, name);
    if (!await olderThan(path, LEASE_TOKEN_STALE_MS)) continue;
    if (!dryRun) await rm(path, { force: true });
    out.push(path);
  }
  // Temp files of crashed takers (link-based take) older than 60 s.
  return [...out, ...await staleTemps(dir, undefined, dryRun)];
}
/** Whether `path` is a worktree of the repository of `cwd` whose top level is `path` itself. */
async function ownTree(cwd: string, path: string): Promise<boolean> {
  try { if (!(await stat(path)).isDirectory()) return false; } catch { return false; }
  const top = await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { allowFail: true });
  if (top.code) return false;
  const [t, c] = top.stdout.trim().split('\n');
  return !!t && !!c && await realOr(t) === await realOr(path) && await realOr(resolve(path, c)) === await realOr(await commonDir(cwd));
}
/** F6: refresh tracked files without following symlinks outside the tree; gitlinks are directories, not files. */
async function touchTracked(path: string): Promise<void> {
  const now = new Date();
  for (const line of (await git(path, ['ls-files', '-s', '-z'])).stdout.split('\0').filter(Boolean)) {
    if (line.startsWith('160000 ')) continue;
    const file = join(path, line.slice(line.indexOf('\t') + 1));
    await lutimes(file, (await lstat(file)).atime, now);
  }
  // Keep Git's stat cache in sync: a later forced checkout of the same commit must not rewrite these files.
  await git(path, ['update-index', '--refresh']);
}
/** The completion marker of a reused tree, inside its private git dir (not in the tree; removed with the worktree). */
async function preparedMarker(path: string): Promise<string> { return join((await git(path, ['rev-parse', '--absolute-git-dir'])).stdout.trim(), 'owed-prepared'); }
/** Test seam: `beforeTouch` runs right before the touch of a reused tree (tests inject a failure there). */
export const reuseHooks: { beforeTouch?: (path: string) => Promise<void> | void } = {};
async function reusedTree(cwd: string, commit: string, kind: string, id: string, touch: NonNullable<ReuseSpec['touch']>): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await reuseDir(cwd), name = `${kind}-${treeId(id)}`;
  await mkdir(dir, { recursive: true });
  let k = 0;
  for (; !await takeLease(join(dir, `${name}-${k}.lock`)); k++) if (k > 1000) throw new Error('no free reused tree lease');
  const path = join(dir, `${name}-${k}`), lock = `${path}.lock`;
  try {
    let ready = false, prior = '';
    if (await ownTree(cwd, path)) {
      // F6 (ruling #1095): preparation is all-or-nothing. The marker names the commit of the last COMPLETE preparation;
      // it is removed first and rewritten only after touch, so a failed preparation is redone in full next time.
      const marker = await preparedMarker(path);
      prior = await readFile(marker, 'utf8').catch(() => '');
      await rm(marker, { force: true });
      const co = await git(path, ['checkout', '--detach', '--force', commit], { allowFail: true });
      ready = !co.code && !(await git(path, ['clean', '-ffdx'], { allowFail: true })).code;
      // A fresh `git worktree add` tree has empty submodule directories: empty each gitlink dir (never a `git submodule`
      // command: it would edit the shared config and de-initialize the user's submodules).
      if (ready) await emptyGitlinks(path);
    }
    if (!ready) {
      // Missing or broken: recreate it (-f overrides a registration whose directory is gone).
      await git(cwd, ['worktree', 'remove', '--force', path], { allowFail: true });
      await rm(path, { recursive: true, force: true });
      await git(cwd, ['worktree', 'add', '-f', '--detach', path, commit]);
    }
    // Still under the lease: no measurement or other preparation can see a partially touched tree.
    const head = await revParse(path, 'HEAD');
    if (touch === 'always' || (touch === 'reset' && prior !== head)) { await reuseHooks.beforeTouch?.(path); await touchTracked(path); }
    await writeFile(await preparedMarker(path), head);
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
