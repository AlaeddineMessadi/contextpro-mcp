// Exercise CLI orchestration with a fake Codex executable; never use account quota.
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
it('plans without launching agents and records alternating trials with observed usage', { timeout: 30000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'contextpro-agent-runner-'));
  const source = join(scratch, 'source'), home = join(scratch, 'home'), bin = join(scratch, 'bin'), output = join(scratch, 'output');
  const script = join(process.cwd(), 'scripts/benchmark-codex-pairs.mjs');
  try {
    await mkdir(source); await mkdir(join(home, '.codex'), { recursive: true }); await mkdir(bin);
    await writeFile(join(source, 'example.ts'), 'export const fixture = true;\n');
    await exec('git', ['init', '-q'], { cwd: source }); await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'fixture'], { cwd: source });
    await writeFile(join(home, '.codex/config.toml'), `model = "fixture-model"\n[mcp_servers.contextpro]\ncommand = ${JSON.stringify(process.execPath)}\nargs = []\n`);
    const fake = join(bin, 'codex');
    await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), answer = args[args.indexOf('--output-last-message') + 1];
fs.appendFileSync(process.env.FIXTURE_LAUNCHES, JSON.stringify({cwd: process.cwd(), args}) + '\\n');
fs.writeFileSync(answer, JSON.stringify({identityFields:['abi','platform','arch','libc'],dependencyVersionsInKey:true,repairsSharedNodeModules:false,evidence:[{file:'src/core/native-runtime.ts',symbol:'nativeRuntimeIdentity'},{file:'src/core/native-repair.ts',symbol:'repairNativeRuntime'}]}));
const item = {id:'1',type:'command_execution',command:'read fixture',status:'completed',exit_code:0};
console.log(JSON.stringify({type:'item.started',item}));
console.log(JSON.stringify({type:'item.completed',item}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:8,output_tokens:4}}));
`);
    await chmod(fake, 0o755);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LAUNCHES: join(scratch, 'launches'), CONTEXTPRO_BENCH_REPEATS: '2', CONTEXTPRO_BENCH_INDEX_STATES: 'empty', CONTEXTPRO_BENCH_TASK: 'native-cache-contract' };
    delete env.CONTEXTPRO_BENCH_BASELINE_SERVER; delete env.CONTEXTPRO_BENCH_CANDIDATE_SERVER;
    const plan = await exec(process.execPath, [script, source, output], { env });
    assert.match(plan.stdout, /Plan only/);
    await assert.rejects(readFile(env.FIXTURE_LAUNCHES), /ENOENT/);
    await exec(process.execPath, [script, source, output, '--run'], { env });
    const runs = JSON.parse(await readFile(join(output, 'runs.json'), 'utf8'));
    assert.deepEqual(runs.map(r => r.variant), ['baseline', 'contextpro', 'contextpro', 'baseline']);
    assert.ok(runs.every(r => r.success && r.usage.input_tokens === 20 && r.usage.cached_input_tokens === 8 && r.usage.output_tokens === 4));
    assert.ok(runs.every(r => r.toolCalls[0].command === 'read fixture' && r.costUsd === null && r.serverTiming.serverBusyMs === null));
    const launches = (await readFile(env.FIXTURE_LAUNCHES, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const launch of launches) await assert.rejects(readFile(join(launch.cwd, 'example.ts')), /ENOENT/);
    await assert.rejects(exec(process.execPath, [script, source, output, '--run'], { env }), /fresh output directory/);
    assert.equal((await readFile(env.FIXTURE_LAUNCHES, 'utf8')).trim().split('\n').length, 4);
    const measured = JSON.parse(await readFile(join(output, 'agent-runs.json'), 'utf8'));
    assert.equal(measured[0].inputTokens + measured[0].outputTokens, 24);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
