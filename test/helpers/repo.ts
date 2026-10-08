import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git, revParse } from '../../src/git.ts';
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
