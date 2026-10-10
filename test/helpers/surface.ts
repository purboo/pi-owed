import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { git, revParse } from '../../src/git.ts';
// D25.3: these tests drive owed as the main agent. A writer that runs the suite inside a pi-durable-subagents call
// inherits DSA_CALL/DSA_EXEC, which would refuse every owner and parent act; tests that need them set them explicitly.
delete process.env.DSA_CALL; delete process.env.DSA_EXEC;
export const identity = { GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'test@localhost',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'test@localhost' };
export async function commitAt(cwd:string, files:Record<string,string>) { for(const [path,text] of Object.entries(files)) { await mkdir(dirname(join(cwd,path)),{recursive:true}); await writeFile(join(cwd,path),text); } await git(cwd,['add','.']); await git(cwd,['commit','--allow-empty','-m','fixture'],{env:identity}); return revParse(cwd,'HEAD'); }
export async function cli(cwd:string,args:string[]) {
  try { const r=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../../bin/owed.js',import.meta.url)),...args],{cwd,env:{...process.env,...identity},timeout:30_000,maxBuffer:2*1024*1024}); return {code:0,...r}; }
  catch(e) { const x=e as {code:number;stdout:string;stderr:string}; if(typeof x.code !== 'number') throw e; return x; }
}
export const checkTest = (id:string, expected:number) => `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('${id}',()=>assert.equal(require('./${id}.cjs'),${expected}));\n`;
export const planText=JSON.stringify({version:1,trunk:'main',closure:['test/helper.cjs'],invariants:[{id:'unit',run:'node --test --test-reporter=tap test/invariant.test.cjs',min_tests:1,reads:['test/invariant.test.cjs','test/state.cjs']}],nodes:[{id:'a',writes:['test/a'],checks:[{id:'a',run:'node --test --test-reporter=tap test/a.test.cjs',reads:['test/a*'],min_tests:1,red:true,tests:['test/a.test.cjs']}]},{id:'b',deps:['a'],writes:['test/'],checks:[{id:'b',run:'node --test --test-reporter=tap test/b.test.cjs',reads:['test/b*','test/helper.cjs'],min_tests:1,red:true,tests:['test/b.test.cjs']}]}]});
export async function seed(cwd:string) { return commitAt(cwd,{'test/a.cjs':'module.exports=0;','test/b.cjs':'module.exports=0;','test/state.cjs':'module.exports=1;','test/helper.cjs':'module.exports=0;','test/invariant.test.cjs':checkTest('state',1)}); }
