import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { canonical, sha256 } from '../src/canon.ts';
import { Dsa } from '../src/dsa.ts';
import { decide, launchSpec, reviewerLaunch, writerLaunch, type DriveOpts } from '../src/drive.ts';
import { drive } from '../src/drive-run.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { driveConfig, parsePlan, planDowngrades } from '../src/plan.ts';
import { reduce, runId } from '../src/reducer.ts';
import type { CandidateFacts, Draft, DriveConfig, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const dsaRoot = process.env.OWED_TEST_DSA_ROOT;
const LOCAL_DSA_SPEC = dsaRoot && join(dsaRoot, 'dist/compat/spec.js');
const LOCAL_DSA_REQUEST = dsaRoot && join(dsaRoot, 'dist/agent/main/tool.js');

const yamlPlan = (nodeExtra = '', planExtra = ''): string =>
  `version: 1\ntrunk: main\n${planExtra}nodes:\n  - id: a\n    writes: ["a/"]\n${nodeExtra}`;

test('role limits: valid parsing, empty limits dropped, canonical sha preserved without limits', () => {
  const full = parsePlan(yamlPlan(
    '    drive:\n      writer: { limits: { memoryMb: 2048.5, maxProcesses: 16, cpuPercent: 150.5, graceMs: 0, strict: true } }\n      reviewer: { model: "example/model-small", limits: { graceMs: 2500, strict: false } }\n',
    'drive:\n  writer: { agent: worker, model: "example/model-large:high", limits: { memoryMb: 4096, maxProcesses: 64, cpuPercent: 400, graceMs: 5000, strict: false } }\n  reviewer: { agent: owed-reviewer, limits: { memoryMb: 2048 } }\n',
  ));
  assert.deepEqual(full.drive?.writer.limits, { memoryMb: 4096, maxProcesses: 64, cpuPercent: 400, graceMs: 5000, strict: false });
  assert.deepEqual(full.drive?.reviewer.limits, { memoryMb: 2048 });
  assert.deepEqual(full.nodes[0]!.drive?.writer?.limits, { memoryMb: 2048.5, maxProcesses: 16, cpuPercent: 150.5, graceMs: 0, strict: true });
  assert.deepEqual(full.nodes[0]!.drive?.reviewer?.limits, { graceMs: 2500, strict: false });

  // Empty limits: {} drops cleanly and preserves canonical bytes/sha.
  const blob = (text: string): string => sha256(stringify(JSON.parse(canonical(parsePlan(text))), { sortMapEntries: true }));
  const plain = yamlPlan('    checks:\n      - { id: unit, run: "true" }\n');
  assert.equal(blob(plain), blob(`${plain}    drive:\n      writer:\n        limits: {}\n      reviewer:\n        limits: {}\n`));
  const planDrivePlain = yamlPlan('', 'drive:\n  writer: { agent: worker }\n  reviewer: { agent: owed-reviewer }\n');
  const planDriveEmptyLimits = yamlPlan('', 'drive:\n  writer: { agent: worker, limits: {} }\n  reviewer: { agent: owed-reviewer, limits: {} }\n');
  assert.equal(blob(planDrivePlain), blob(planDriveEmptyLimits));
  assert.equal('limits' in parsePlan(planDriveEmptyLimits).drive!.writer, false);
});

test('role limits: rejects invalid types, unknown keys, env, and out-of-bounds values per local DSA contract', async () => {
  const badPlan = (limitsYaml: string, re: RegExp) => {
    assert.throws(() => parsePlan(yamlPlan('', `drive:\n  writer:\n    limits: ${limitsYaml}\n`)), (e: Error) => re.test(e.message), `plan: ${limitsYaml}`);
    assert.throws(() => parsePlan(yamlPlan(`    drive:\n      reviewer:\n        limits: ${limitsYaml}\n`)), (e: Error) => re.test(e.message), `node: ${limitsYaml}`);
  };
  for (const raw of ['null', '[]', '3', '"fast"', 'true']) badPlan(raw, /limits: expected object/);
  badPlan('{ unknown: 1 }', /limits\.unknown: unknown key/);
  badPlan('{ env: { A: "1" } }', /limits\.env: unknown key/);
  for (const k of ['memoryMb', 'cpuPercent']) {
    for (const v of ['0', '-1', '-0.5', '.nan', '.inf', '-.inf', '"100"', 'null', 'true']) {
      badPlan(`{ ${k}: ${v} }`, new RegExp(`limits\\.${k}: expected positive finite number`));
    }
  }
  for (const v of ['0', '-1', '1.5', '9007199254740992', '.nan', '.inf', '"4"', 'null', 'true']) {
    badPlan(`{ maxProcesses: ${v} }`, /limits\.maxProcesses: expected positive integer/);
  }
  for (const v of ['-1', '-0.01', '.nan', '.inf', '-.inf', '"0"', 'null', 'false']) {
    badPlan(`{ graceMs: ${v} }`, /limits\.graceMs: expected nonnegative finite number/);
  }
  for (const v of ['"true"', '1', '0', 'null', '{}']) {
    badPlan(`{ strict: ${v} }`, /limits\.strict: expected boolean/);
  }
  // No env on role objects either (command-only in DSA).
  assert.throws(() => parsePlan(yamlPlan('', 'drive:\n  writer: { agent: worker, env: { A: "1" } }\n')), /drive\.writer\.env: unknown key/);
  assert.throws(() => parsePlan(yamlPlan('    drive:\n      writer: { env: { A: "1" } }\n')), /nodes\[0\]\.drive\.writer\.env: unknown key/);

  if (LOCAL_DSA_SPEC && existsSync(LOCAL_DSA_SPEC)) {
    const { validateCallSpec } = await import(LOCAL_DSA_SPEC) as { validateCallSpec: (spec: unknown) => string[] };
    const valid = parsePlan(yamlPlan('', 'drive:\n  writer: { agent: worker, limits: { memoryMb: 4096, maxProcesses: 64, cpuPercent: 400, graceMs: 0, strict: true } }\n'));
    const spec = JSON.parse(launchSpec({ ...driveConfig(valid).writer, cwd: '/tmp/repo', task: 'check' }));
    assert.deepEqual(validateCallSpec(spec), []);
  }
});

test('role limits: merge semantics with agent/model overrides and byte-identical old launch specs', () => {
  const plan = parsePlan(
    'version: 1\ntrunk: main\ndrive:\n' +
    '  writer: { agent: worker, model: "example/model-large:high", limits: { memoryMb: 4096, graceMs: 5000, strict: false } }\n' +
    '  reviewer: { agent: owed-reviewer, model: "example/model-large:high", limits: { memoryMb: 2048 } }\n' +
    'nodes:\n' +
    '  - id: replace-agent-no-limits\n    writes: ["a/"]\n    drive: { writer: { agent: worker-cheap } }\n' +
    '  - id: replace-agent-merge-limits\n    writes: ["b/"]\n    review: { count: 1, min_rank: 1 }\n    drive: { writer: { agent: worker-cheap, limits: { memoryMb: 1024, strict: true } } }\n' +
    '  - id: model-only-merge-limits\n    writes: ["c/"]\n    drive: { reviewer: { model: "example/model-small", limits: { cpuPercent: 200, graceMs: 0 } } }\n' +
    '  - id: limits-only\n    writes: ["d/"]\n    drive: { writer: { limits: { graceMs: 1000 } } }\n',
  );
  assert.deepEqual(driveConfig(plan, 'replace-agent-no-limits').writer, {
    agent: 'worker-cheap',
    limits: { memoryMb: 4096, graceMs: 5000, strict: false },
  });
  assert.deepEqual(driveConfig(plan, 'replace-agent-merge-limits').writer, {
    agent: 'worker-cheap',
    limits: { memoryMb: 1024, graceMs: 5000, strict: true },
  });
  assert.deepEqual(driveConfig(plan, 'model-only-merge-limits').reviewer, {
    agent: 'owed-reviewer',
    model: 'example/model-small',
    limits: { memoryMb: 2048, cpuPercent: 200, graceMs: 0 },
  });
  assert.deepEqual(driveConfig(plan, 'limits-only').writer, {
    agent: 'worker',
    model: 'example/model-large:high',
    limits: { memoryMb: 4096, graceMs: 1000, strict: false },
  });
  // Mutating returned config does not mutate plan.drive.
  const cfg = driveConfig(plan, 'limits-only');
  cfg.writer.limits!.memoryMb = 999;
  assert.equal(plan.drive!.writer.limits!.memoryMb, 4096);

  // Old launch specs without limits remain byte-identical.
  const oldSpec = canonical({ agent: 'worker', cwd: '/tmp/wt', isolation: 'none', model: 'example/model-large:high', name: 'owed a#1 writer', once: true, task: 'do x' });
  assert.equal(launchSpec({ agent: 'worker', model: 'example/model-large:high', cwd: '/tmp/wt', task: 'do x', name: 'owed a#1 writer' }), oldSpec);
  assert.equal(launchSpec({ agent: 'worker', model: 'example/model-large:high', limits: {}, cwd: '/tmp/wt', task: 'do x', name: 'owed a#1 writer' }), oldSpec);

  // writerLaunch / reviewerLaunch / decide recovery use merged limits.
  const pHash = 'h0';
  const rEntries: Entry[] = [];
  const plans: Record<string, Plan> = { p: plan };
  const blobs = new Map<string, string>();
  const add = (d: Draft): Entry => {
    const seq = rEntries.length;
    const e = { ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `h${seq}` } as Entry;
    rEntries.push(e);
    return e;
  };
  const stateOf = (): State => reduce(rEntries, sha => plans[sha]!);
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'replace-agent-merge-limits', attempt: 1, base: 's0', branch: 'owed/b/1', worktree: '/tmp/wt-b', packet: 'pkt', rulings_seen: -1 });
  const wLaunch = writerLaunch(stateOf(), 'replace-agent-merge-limits', pHash);
  assert.deepEqual(JSON.parse(wLaunch.spec).limits, { memoryMb: 1024, graceMs: 5000, strict: true });
  blobs.set(sha256(wLaunch.spec), wLaunch.spec);
  add({ kind: 'launch', by: 'parent:drive', node: 'replace-agent-merge-limits', attempt: 1, role: 'writer', rid: wLaunch.rid, spec: sha256(wLaunch.spec), labels: wLaunch.labels, rulings: wLaunch.rulings });
  const facts: CandidateFacts = { commit: 'c1', tree: 't1', base: 's0', patch: 'p1', changed: ['b/x'], closureTouched: false, keys: { writes: 'k1', rulings: 'k2', review: 'k3' } };
  add({ kind: 'submit', by: 'writer:replace-agent-merge-limits#1', node: 'replace-agent-merge-limits', attempt: 1, facts });
  const revLaunch = reviewerLaunch(stateOf(), 'replace-agent-merge-limits', 1, pHash, '/tmp/repo');
  assert.deepEqual(JSON.parse(revLaunch.spec).limits, { memoryMb: 2048 });
  const relaunchOpts: DriveOpts = { max: 4, repairs: 2, project: pHash, root: '/tmp/repo', applied: new Set(), rejected: new Map(), blobs };
  const absentAct = decide(stateOf(), stateOf().plan, new Map<string, RunView>([[runId(pHash, 'replace-agent-merge-limits', 1, 'writer'), { rid: wLaunch.rid, state: 'absent' }]]), relaunchOpts).find(x => x.node === 'replace-agent-merge-limits');
  assert.ok(absentAct?.do === 'launch' && absentAct.spec === wLaunch.spec);

  // Canonical JSON ordering inside limits (cpuPercent, graceMs, maxProcesses, memoryMb, strict).
  const withLimits = launchSpec({
    agent: 'worker',
    limits: { strict: true, memoryMb: 2048, graceMs: 0, cpuPercent: 150, maxProcesses: 8 },
    cwd: '/tmp/wt',
    task: 'do x',
  });
  assert.equal(withLimits, '{"agent":"worker","cwd":"/tmp/wt","isolation":"none","limits":{"cpuPercent":150,"graceMs":0,"maxProcesses":8,"memoryMb":2048,"strict":true},"once":true,"task":"do x"}');
});

test('role limits: raw launch spec and recovery relaunch in real Driver + fake-dsa', { timeout: 120_000 }, async () => {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  try {
    await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
    await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
    const planObj = {
      version: 1, trunk: 'main', closure: [], invariants: [],
      drive: {
        max: 4, repairs: 2,
        writer: { agent: 'worker', model: 'example/model-large:high', limits: { memoryMb: 4096, graceMs: 5000, strict: false } },
        reviewer: { agent: 'owed-reviewer', limits: { memoryMb: 2048, maxProcesses: 16 } },
      },
      nodes: [
        { id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 }, drive: { writer: { agent: 'worker-cheap', limits: { memoryMb: 1024, strict: true } }, reviewer: { model: 'example/model-small', limits: { cpuPercent: 150 } } } },
        { id: 'b', writes: ['b.txt'], checks: [], review: { count: 0, min_rank: 1 } },
      ],
    };
    const planText = JSON.stringify(planObj);
    await r.put('plan.json', planText); await r.put('README', 'x\n'); await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: planText });

    const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
    const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 60_000 });
    await writeFile(join(dir, 'agents', 'a-writer.sh'), 'set -e\necho a > a.txt; git add a.txt; git commit -qm a; owed submit a\n');
    await writeFile(join(dir, 'agents', 'b-writer.sh'), 'set -e\necho RUNNING\n');
    await writeFile(join(dir, 'agents', 'a-reviewer.sh'), 'set -e\nwho=$(grep -o "reviewer:drive-a-1-[0-9]*" "$FAKE_SPEC" | head -1)\nowed review a --as "$who" --ok --rank 1 --note "ok"\n');

    const runPass = () => drive({ cwd: r.cwd, once: true, dsa, log: () => {}, handleSignals: false });
    for (let i = 0; i < 8; i++) {
      const es = await (await Ledger.open(r.cwd)).read();
      const ls = es.filter((e): e is Extract<Entry, { kind: 'launch' }> => e.kind === 'launch');
      if (ls.some(l => l.node === 'a' && l.role === 'writer') && ls.some(l => l.node === 'b' && l.role === 'writer') && ls.some(l => l.node === 'a' && l.role === 'reviewer')) break;
      await runPass();
    }

    const entries = await (await Ledger.open(r.cwd)).read();
    const launches = entries.filter((e): e is Extract<Entry, { kind: 'launch' }> => e.kind === 'launch');
    const la = launches.find(l => l.node === 'a' && l.role === 'writer')!;
    const lb = launches.find(l => l.node === 'b' && l.role === 'writer')!;
    const lr = launches.find(l => l.node === 'a' && l.role === 'reviewer')!;
    assert.ok(la && lb && lr);

    const specA = JSON.parse(await readFile(join(dir, 'specs', la.rid), 'utf8'));
    const specB = JSON.parse(await readFile(join(dir, 'specs', lb.rid), 'utf8'));
    const specR = JSON.parse(await readFile(join(dir, 'specs', lr.rid), 'utf8'));
    assert.equal(specA.agent, 'worker-cheap');
    assert.equal('model' in specA, false);
    assert.equal('env' in specA, false);
    assert.deepEqual(specA.limits, { memoryMb: 1024, graceMs: 5000, strict: true });
    assert.equal(specB.agent, 'worker');
    assert.equal(specB.model, 'example/model-large:high');
    assert.deepEqual(specB.limits, { memoryMb: 4096, graceMs: 5000, strict: false });
    assert.equal(specR.agent, 'owed-reviewer');
    assert.equal(specR.model, 'example/model-small');
    assert.deepEqual(specR.limits, { memoryMb: 2048, maxProcesses: 16, cpuPercent: 150 });

    if (LOCAL_DSA_REQUEST && existsSync(LOCAL_DSA_REQUEST)) {
      const { request } = await import(LOCAL_DSA_REQUEST) as { request: (args: Record<string, unknown>, cwd: string) => unknown };
      for (const s of [specA, specB, specR]) assert.doesNotThrow(() => request({ ...s, action: 'run' }, s.cwd as string));
    }

    // Recovery after plan limits edit + absent run in dsa: stored spec bytes win over changed plan.
    const nextPlan = structuredClone(planObj);
    nextPlan.drive.writer.limits = { memoryMb: 8192, graceMs: 1000, strict: true };
    await ops.planSet({ cwd: r.cwd, as: { role: 'parent', id: 'test' }, plan: JSON.stringify(nextPlan) });

    // Simulate dsa losing `b`'s run (`state: absent` on describe) while `lb` launch entry + blob remain in ledger.
    const stateFile = join(dir, 'state.json'), dsaState = JSON.parse(await readFile(stateFile, 'utf8'));
    delete dsaState.requests[lb.rid];
    delete dsaState.runs[lb.rid];
    await writeFile(stateFile, JSON.stringify(dsaState, null, 2));

    await runPass();
    const relaunchedB = JSON.parse(await readFile(join(dir, 'specs', lb.rid), 'utf8'));
    assert.deepEqual(relaunchedB.limits, { memoryMb: 4096, graceMs: 5000, strict: false }, 'relaunch preserves recorded spec limits despite later plan edit');
    assert.equal(sha256(await readFile(join(dir, 'specs', lb.rid), 'utf8')), lb.spec);
  } finally { await r.cleanup(); }
});

test('role limits: edit CLI, edit --drive, owed_edit tool, invalid edits atomic, and candidate carry', async () => {
  const r = await repo();
  try {
    const initial = '# header\nversion: 1\ntrunk: main\nlease: false\nclosure: []\ninvariants: []\ndrive:\n  max: 4\n  writer: { agent: worker, limits: { memoryMb: 4096 } }\n  reviewer: { agent: owed-reviewer }\nnodes:\n  - id: a\n    writes: [a.txt]\n';
    const file = join(r.cwd, 'plan.yaml');
    await r.put('plan.yaml', initial);
    await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: initial, path: 'plan.yaml', measure: false });
    await ops.planSet({ cwd: r.cwd, as: { role: 'parent', id: 'test' }, ...await ops.readPlan({ cwd: r.cwd, path: 'plan.yaml' }) });

    // Dispatch and submit a candidate before editing limits: candidate must carry/survive cleanly with zero downgrades.
    const d = await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'test' }, node: 'a' });
    await commitAt(d.worktree, { 'a.txt': '1\n' });
    const sub = await ops.submit({ cwd: d.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });

    const driveEdit = await cli(r.cwd, ['edit', '--drive', '--set', 'writer.limits.graceMs=0', '--set', 'reviewer.limits={memoryMb: 2048, strict: true}', '--note', 'Set role limits']);
    assert.equal(driveEdit.code, 0, driveEdit.stderr);
    const nodeEdit = await cli(r.cwd, ['edit', 'a', '--set', 'drive.writer.limits.memoryMb=1024', '--note', 'Tighten node a writer memory']);
    assert.equal(nodeEdit.code, 0, nodeEdit.stderr);

    const afterEdits = parsePlan(await readFile(file, 'utf8'));
    assert.deepEqual(driveConfig(afterEdits, 'a').writer.limits, { memoryMb: 1024, graceMs: 0 });
    assert.deepEqual(driveConfig(afterEdits, 'a').reviewer.limits, { memoryMb: 2048, strict: true });

    const ledger = await Ledger.open(r.cwd);
    const status = await ops.status({ cwd: r.cwd });
    assert.equal(status.nodes.a!.candidate?.seq, sub.seq, 'editing role limits does not invalidate open candidate');
    assert.deepEqual(planDowngrades(parsePlan(initial), afterEdits), []);

    // Tool path (`owed_edit`) and `--unset`.
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_edit')!;
    const unsetRes = await tool.execute('e1', { cwd: r.cwd, node: 'a', unset: ['drive.writer.limits.memoryMb'], note: 'Restore plan default memory' }, undefined, undefined, { cwd: r.cwd, hasUI: false } as Parameters<ToolDefinition['execute']>[4]) as { isError?: boolean; content: { text?: string }[] };
    assert.equal(unsetRes.isError, undefined, unsetRes.content[0]?.text);
    assert.deepEqual(driveConfig(parsePlan(await readFile(file, 'utf8')), 'a').writer.limits, { memoryMb: 4096, graceMs: 0 });

    // Invalid edits leave plan file and ledger unchanged.
    const savedText = await readFile(file, 'utf8'), savedCount = (await ledger.read()).length;
    for (const args of [
      ['edit', '--drive', '--set', 'writer.limits.memoryMb=0', '--note', 'bad'],
      ['edit', '--drive', '--set', 'writer.limits.strict="yes"', '--note', 'bad'],
      ['edit', 'a', '--set', 'drive.writer.limits.maxProcesses=1.5', '--note', 'bad'],
      ['edit', 'a', '--set', 'drive.writer.limits.unknown=1', '--note', 'bad'],
      ['edit', 'a', '--set', 'drive.writer=worker', '--set', 'drive.writer.limits.memoryMb=1', '--note', 'bad'],
    ]) {
      const bad = await cli(r.cwd, args);
      assert.equal(bad.code, 2, `${args.join(' ')}: ${bad.stdout} ${bad.stderr}`);
      assert.equal(await readFile(file, 'utf8'), savedText);
      assert.equal((await ledger.read()).length, savedCount);
    }
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});
