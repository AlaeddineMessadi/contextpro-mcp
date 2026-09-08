#!/usr/bin/env node
// Fresh Codex comprehension sessions, provider-reported usage and explicit acceptance checks.
// Invoke only when the user authorizes agent trials; uses the configured model/account quota.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildTrialPlan, createEventCollector, providerUsage, summarizeServerTrace, latencyDistribution, fingerprintLauncher } from './benchmark-evidence.mjs';
import { summarizePairedAgentRuns } from './benchmark-retrieval.mjs';

const exec = promisify(execFile);
const positional = process.argv.slice(2).filter(arg => arg !== '--run' && arg !== '--plan');
const source = resolve(positional[0] || '.');
const output = resolve(positional[1] || '.contextpro/codex-pairs');
const profile = process.env.CONTEXTPRO_BENCH_PROFILE || 'workflow';
if (!['workflow', 'lean'].includes(profile)) throw new Error('Benchmark profile must be workflow or lean.');
const config = JSON.parse((await exec('python3', ['-c', 'import pathlib,tomllib,json; c=tomllib.loads((pathlib.Path.home()/".codex/config.toml").read_text()); print(json.dumps({k:c.get(k) for k in ("model","model_reasoning_effort","model_provider","mcp_servers")}))'])).stdout);
if (!config.model) throw new Error('Set an explicit configured model before measuring paired runs.');
if (config.model_provider && config.model_provider !== 'openai') throw new Error('This runner currently supports the standard OpenAI Codex provider only.');
const loadLauncher = async path => path ? JSON.parse(await readFile(resolve(path), 'utf8')) : null;
const mcp = await loadLauncher(process.env.CONTEXTPRO_BENCH_CANDIDATE_SERVER) ?? config.mcp_servers?.contextpro;
const baselineMcp = await loadLauncher(process.env.CONTEXTPRO_BENCH_BASELINE_SERVER);
for (const launcher of [mcp, baselineMcp].filter(Boolean)) {
  if (typeof launcher.command !== 'string' || !launcher.command || !Array.isArray(launcher.args) || launcher.args.some(x => typeof x !== 'string') || Object.values(launcher.env ?? {}).some(x => typeof x !== 'string')) throw new Error('Server launchers require command, args and optional string env values.');
}
if (!mcp) throw new Error('Configure ContextPro or supply CONTEXTPRO_BENCH_CANDIDATE_SERVER.');
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
const evidence = { type:'array', items:{ type:'object', properties:{ file:{type:'string'}, symbol:{type:'string'} }, required:['file','symbol'], additionalProperties:false } };
const tasks = [
  { id:'native-cache-contract', prompt:'Investigate native dependency repair in this repository. Which runtime identity fields and dependency versions determine the isolated cache key? Does automatic repair rebuild the shared project node_modules in place? Return the requested facts and precise file/symbol evidence.', properties:{ identityFields:{type:'array',items:{type:'string'}}, dependencyVersionsInKey:{type:'boolean'}, repairsSharedNodeModules:{type:'boolean'}, evidence },
    check: answer => ['abi','platform','arch','libc'].every(x=>answer.identityFields?.map(v=>v.toLowerCase().split(':')[0].trim()).includes(x)) && answer.dependencyVersionsInKey === true && answer.repairsSharedNodeModules === false && ['src/core/native-runtime.ts','src/core/native-repair.ts'].every(path=>answer.evidence?.some(e=>e.file.replace(/:\d+(?:-\d+)?$/, '').endsWith(path) && e.symbol)) },
  { id:'source-mutation-contract', prompt:'Investigate the actual source mutation path. Does it prevent symlink escapes from the repository, reject stale content at publication, and serialize concurrent writes? Return these three facts and precise file/symbol evidence for the implementation, not just tests or documentation.', properties:{ symlinkEscapeBlocked:{type:'boolean'}, staleWriteRejected:{type:'boolean'}, serializesWrites:{type:'boolean'}, evidence },
    check: answer => answer.symlinkEscapeBlocked === true && answer.staleWriteRejected === true && answer.serializesWrites === true && ['src/core/path-guard.ts','src/core/source-mutation.ts'].every(path=>answer.evidence?.some(e=>e.file.replace(/:\d+(?:-\d+)?$/, '').endsWith(path) && e.symbol)) },
];
const requestedTask = process.env.CONTEXTPRO_BENCH_TASK;
if (requestedTask && !tasks.some(task => task.id === requestedTask)) throw new Error('Unknown benchmark task.');
const selectedTasks = tasks.filter(task => !requestedTask || task.id === requestedTask);
const plan = buildTrialPlan(selectedTasks.map(task => task.id), Number(process.env.CONTEXTPRO_BENCH_REPEATS ?? 3), (process.env.CONTEXTPRO_BENCH_INDEX_STATES ?? 'seeded').split(','));
const fingerprints = { baseline: await fingerprintLauncher(baselineMcp), contextpro: await fingerprintLauncher(mcp) };
const metadata = { fingerprints, model: config.model, reasoningEffort: config.model_reasoning_effort, sourceCommit, profile,
  baseline: baselineMcp ? 'older ContextPro launcher' : 'native tools', candidate: 'ContextPro launcher',
  compilerState: 'fresh MCP process for every agent session; no warm compiler claim',
  indexStates: 'empty: no prepared index; seeded: structural reindex in a separate process, no semantic prewarming',
  plannedRuns: plan.length, plan };
console.log(JSON.stringify(metadata, null, 2));
if (!process.argv.includes('--run')) {
  console.log('Plan only. Add --run to use the configured Codex model/account quota.');
  process.exit(0);
}
try { await access(join(output, 'runs.json')); throw new Error('Output already contains runs.json; choose a fresh output directory.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(join(output, 'plan.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
const rows = [];
const rootArgs = (launcher, root) => {
  const args = [];
  for (let i = 0; i < launcher.args.length; i++) {
    if (launcher.args[i] === '--root') { i++; continue; }
    if (launcher.args[i].startsWith('--root=')) continue;
    args.push(launcher.args[i]);
  }
  return [...args, '--root', root];
};
async function prepareIndex(launcher, root) {
  const env = { ...process.env, ...launcher.env, CONTEXTPRO_TOOL_PROFILE: 'workflow', CONTEXTPRO_REINDEX_NO_EMBED: 'true' };
  delete env.CONTEXTPRO_TOOL_TRACE_PATH;
  const client = new Client({ name: 'benchmark-preparation', version: '1' });
  const transport = new StdioClientTransport({ command: launcher.command, args: rootArgs(launcher, root), env, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'reindex', arguments: { root, no_embed: true, auto_hubs: false } }, undefined, { timeout: 120000 });
    if (result.isError) throw new Error('Benchmark index preparation failed');
  } finally { await client.close(); await transport.close(); }
}
for (const trial of plan) {
  const task = selectedTasks.find(task => task.id === trial.taskId);
  const { variant, pairId, indexState } = trial;
  const launcher = variant === 'contextpro' ? mcp : baselineMcp;
  const runId = `${task.id}-${pairId}-${variant}`;
  const root = await mkdtemp(join(tmpdir(), 'contextpro-codex-pair-'));
  if (JSON.stringify(await fingerprintLauncher(launcher)) !== JSON.stringify(fingerprints[variant])) {
    await rm(root, { recursive: true, force: true });
    throw new Error('Server build changed during the benchmark; discard this incomplete comparison and rerun with fixed builds.');
  }
  try {
    const archive = join(root, 'source.tar');
    await exec('git', ['archive', `--output=${archive}`, sourceCommit], { cwd: source });
    await exec('tar', ['-xf', archive, '-C', root]); await rm(archive);
    // Remove benchmark answers and preferred-tool instructions equally.
    for (const path of ['AGENTS.md', 'CLAUDE.md', '.claude', '.codex', 'scripts', 'docs/benchmarks']) await rm(join(root, path), { force: true, recursive: true });
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-qm', 'Isolated benchmark corpus'], { cwd: root });
    const prepStart = performance.now();
    if (launcher && indexState === 'seeded') await prepareIndex(launcher, root);
    const preparationMs = performance.now() - prepStart;
    const schema = join(output, `${runId}.schema.json`);
    await writeFile(schema, JSON.stringify({ type: 'object', properties: task.properties, required: Object.keys(task.properties), additionalProperties: false }), { mode: 0o600 });
    const answerPath = join(output, `${runId}.answer.json`);
    const tracePath = join(output, `${runId}.server.jsonl`);
    const overrides = ['model=' + JSON.stringify(config.model), 'project_doc_max_bytes=0', 'approval_policy="never"'];
    if (config.model_reasoning_effort) overrides.push('model_reasoning_effort=' + JSON.stringify(config.model_reasoning_effort));
    if (launcher) {
      overrides.push('mcp_servers.contextpro.command=' + JSON.stringify(launcher.command), 'mcp_servers.contextpro.args=' + JSON.stringify(rootArgs(launcher, root)));
      for (const [key, value] of Object.entries({ ...launcher.env, CONTEXTPRO_TOOL_PROFILE: profile, CONTEXTPRO_TOOL_TRACE_PATH: tracePath })) overrides.push(`mcp_servers.contextpro.env.${key}=${JSON.stringify(value)}`);
    }
    // Identical guidance for both versions; tool schemas advertise version capabilities.
    const guidance = 'Use ContextPro first for unfamiliar code, bounded outputs and batched reads. Use exact_references for binding-resolved TS/JS callers when available. Native tools remain available if needed.';
    const prompt = `${task.prompt}\n\nThis is a read-only repository comprehension benchmark. Do not edit files, delegate, browse the web, or inspect any files outside this repository. Use source evidence; stop once the requested facts are verified. ${launcher ? guidance : 'Use ordinary local shell search and file reads.'}`;
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--json', '--sandbox', 'workspace-write', '-C', root, '--output-schema', schema, '--output-last-message', answerPath, ...overrides.flatMap(value => ['-c', value]), prompt];
    console.log(`START ${runId}`);
    const started = performance.now();
    const collector = createEventCollector();
    const child = spawn('codex', args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; collector.push(chunk, performance.now() - started); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const kill = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
    let forceTimer;
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); forceTimer = setTimeout(() => kill('SIGKILL'), 5000); }, 300000);
    let exitCode;
    try { exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }); }
    finally { clearTimeout(timer); clearTimeout(forceTimer); kill('SIGTERM'); }
    const wallTimeMs = performance.now() - started;
    collector.finish(wallTimeMs);
    await writeFile(join(output, `${runId}.events.jsonl`), stdout, { mode: 0o600 });
    await writeFile(join(output, `${runId}.timed-events.jsonl`), collector.timedEvents.map(e => JSON.stringify(e)).join('\n'), { mode: 0o600 });
    await writeFile(join(output, `${runId}.stderr.txt`), stderr, { mode: 0o600 });
    if (JSON.stringify(await fingerprintLauncher(launcher)) !== JSON.stringify(fingerprints[variant])) throw new Error('Server build changed during this trial');
    const usage = providerUsage(collector.events);
    let answer = null, serverTrace = [];
    try { answer = JSON.parse(await readFile(answerPath, 'utf8')); } catch {}
    try { serverTrace = (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); } catch {}
    const success = exitCode === 0 && !timedOut && !!answer && task.check(answer);
    const toolCalls = [...collector.calls.values()];
    const contextproCalls = toolCalls.filter(c => c.type === 'mcp_tool_call' && c.server === 'contextpro');
    rows.push({ ...trial, profile, prompt, model: config.model, reasoningEffort: config.model_reasoning_effort, sourceCommit,
      launcher: launcher ? { command: launcher.command, args: launcher.args, buildFingerprint: fingerprints[variant] } : null,
      preparationMs, wallTimeMs, exitCode, timedOut, success, usage, tokenSource: usage ? 'provider_usage' : null,
      costUsd: null, costSource: 'unavailable', answer, toolCalls, contextproCalls,
      serverTiming: summarizeServerTrace(serverTrace, toolCalls), compilerState: launcher ? 'fresh_process' : 'not_applicable',
      acceptanceEvidence: 'Typed source-contract facts plus required implementation-file evidence; comprehension checks, not patch correctness.' });
    await writeFile(join(output, 'runs.json'), JSON.stringify(rows, null, 2), { mode: 0o600 });
    console.log(`END ${runId}: success=${success} ${Math.round(wallTimeMs)}ms usage=${JSON.stringify(usage)}`);
  } catch (error) {
    rows.push({ ...trial, model: config.model, sourceCommit, success: false, usage: null, tokenSource: null, costUsd: null, costSource: 'unavailable', wallTimeMs: null,
      error: error instanceof Error ? error.message : String(error), toolCalls: [], contextproCalls: [], acceptanceEvidence: 'Trial could not be completed or its evidence could not be validated.' });
    await writeFile(join(output, 'runs.json'), JSON.stringify(rows, null, 2), { mode: 0o600 });
    console.error(`FAILED ${runId}: ${error.message}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (rows.every(row => Number.isSafeInteger(row.usage?.input_tokens) && Number.isSafeInteger(row.usage?.output_tokens))) {
  const measured = rows.map(row => ({ taskId: row.taskId, pairId: row.pairId, model: row.model, variant: row.variant, success: row.success,
    inputTokens: row.usage.input_tokens, outputTokens: row.usage.output_tokens,
    ...(Number.isSafeInteger(row.usage.cached_input_tokens) ? { cachedInputTokens: row.usage.cached_input_tokens } : {}),
    wallTimeMs: row.wallTimeMs, tokenSource: 'provider_usage', costUsd: null, costSource: 'unavailable', acceptanceEvidence: row.acceptanceEvidence }));
  await writeFile(join(output, 'agent-runs.json'), JSON.stringify(measured, null, 2), { mode: 0o600 });
  await writeFile(join(output, 'summary.json'), JSON.stringify(summarizePairedAgentRuns(measured), null, 2), { mode: 0o600 });
}
const groups = new Map();
for (const row of rows) { const key = `${row.taskId}/${row.indexState}/${row.variant}`; groups.set(key, [...(groups.get(key) ?? []), row]); }
await writeFile(join(output, 'latency.json'), JSON.stringify([...groups].map(([group, rows]) => ({ group, successes: rows.filter(r => r.success).length, ...latencyDistribution(rows.map(r => r.wallTimeMs)) })), null, 2), { mode: 0o600 });
console.log(`Results: ${output}. Provider tokens are observed; dollar savings remain unknown without verified pricing/billing.`);

if (rows.some(row => !row.success)) process.exitCode = 1;
