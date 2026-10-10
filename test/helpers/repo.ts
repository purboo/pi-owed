import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git, revParse } from '../../src/git.ts';
// D25.3: these tests drive owed as the main agent. A writer that runs the suite inside a pi-durable-subagents call
// inherits DSA_CALL/DSA_EXEC, which would refuse every owner and parent act; tests that need them set them explicitly.
delete process.env.DSA_CALL; delete process.env.DSA_EXEC;
export async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'owed-test-'));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  const prior = process.env.OWED_DIR; process.env.OWED_DIR = join(root, 'ledger');
  await git(cwd, ['init', '-b', 'main']);
  const env = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost' };
  async function put(path: string, text: string) { await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), text); }
  async function commit() { await git(cwd, ['add', '.']); await git(cwd, ['commit', '--allow-empty', '-m', 'test'], { env }); return revParse(cwd, 'HEAD'); }
  return { root, cwd, put, commit, async cleanup() { if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior; await rm(root, { recursive: true, force: true }); } };
}
