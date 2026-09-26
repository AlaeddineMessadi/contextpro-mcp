#!/usr/bin/env node
// Explicit --prepare/--run only. Trial prompts and acceptance contracts are
// frozen in fixtures/coding-pilot.json; never tuned against candidate outcomes.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm, readdir, access, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createEventCollector, providerUsage, fingerprintLauncher, latencyDistribution } from './benchmark-evidence.mjs';

const exec = promisify(execFile), here = dirname(fileURLToPath(import.meta.url));
const flags = new Set(process.argv.slice(2));
const output = resolve(process.env.CONTEXTPRO_PILOT_OUTPUT ?? '.contextpro/productivity-pilot');
const manifestText = await readFile(join(here, 'fixtures/coding-pilot.json'), 'utf8');
const validatorText = await readFile(join(here, 'pilot-text-preview.mjs'), 'utf8');
const manifest = JSON.parse(manifestText);
const contractHash = createHash('sha256').update(manifestText).update(validatorText).digest('hex');
const repos = JSON.parse(await readFile(join(output, 'repos.json'), 'utf8'));
const tasks = manifest.tasks.filter(task => !process.env.CONTEXTPRO_PILOT_TASK || task.id === process.env.CONTEXTPRO_PILOT_TASK);
const repeats = Number(process.env.CONTEXTPRO_PILOT_REPEATS ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('repeats must be 1–10');
const variants = (process.env.CONTEXTPRO_PILOT_VARIANTS ?? 'baseline,candidate').split(',');
if (variants.some(v => !['baseline', 'candidate', 'native'].includes(v)) || new Set(variants).size !== variants.length) throw Error('Invalid variants');
const plan = Array.from({ length: repeats }, (_, repeat) => tasks.flatMap((task, index) => ((repeat + index) % 2 ? [...variants].reverse() : variants).map(variant => ({ taskId: task.id, variant, repeat })))).flat();
const existing = async path => access(path).then(() => true, () => false);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
await mkdir(output, { recursive: true });

async function run(command, args, cwd, logPath, timeout = 300000, env = {}) {
  const started = performance.now();
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '', timedOut = false, error = null;
    child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
    const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} };
    let force;
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 3000); }, timeout);
    child.on('error', err => { error = err.message; });
    child.on('close', async code => { clearTimeout(timer); clearTimeout(force); kill('SIGTERM'); await writeFile(logPath, text + (error ?? ''), { mode: 0o600 }); resolveResult({ code, timedOut, error, durationMs: performance.now() - started }); });
  });
}
async function cloneDirectory(from, to) {
  await mkdir(dirname(to), { recursive: true });
  if (process.platform === 'darwin') await exec('cp', ['-cR', from, to], { timeout: 120000 });
  else await cp(from, to, { recursive: true });
}
async function archive(task, revision, target) {
  await mkdir(target, { recursive: true });
  const tar = join(target, 'fixture.tar');
  await exec('git', ['archive', `--output=${tar}`, revision], { cwd: repos[task.repository] });
  await exec('tar', ['-xf', tar, '-C', target]); await rm(tar);
  // Preserve build scripts. Remove instructions and retrospective benchmark/QA
  // reports symmetrically, never replace them with tool-specific answers.
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'INSTRUCTIONS.md', 'agent-guide.md', 'agent-instructions.md', '.claude', '.codex', 'docs/benchmarks', 'docs/LAUNCH_READINESS.md']) await rm(join(target, name), { recursive: true, force: true });
  async function dependencies(source, dest, depth = 0) {
    if (await existing(join(source, 'node_modules'))) await cloneDirectory(join(source, 'node_modules'), join(dest, 'node_modules'));
    if (depth >= 3) return;
    for (const item of await readdir(dest, { withFileTypes: true })) if (item.isDirectory() && !item.name.startsWith('.') && !['node_modules', 'public', 'test', 'tests', 'src', 'docs'].includes(item.name)) {
      const next = join(source, item.name); if (await existing(next)) await dependencies(next, join(dest, item.name), depth + 1);
    }
  }
  await dependencies(repos[task.repository], target);
}
async function injectValidation(task, root) {
  for (const path of task.tests) {
    const { stdout } = await exec('git', ['show', `${task.fix}:${path}`], { cwd: repos[task.repository], maxBuffer: 10 * 1024 * 1024 });
    // The benchmark strips instruction documents to prevent tool-preference
    // leakage. Qualify the routing behavior, not the absent bundled prose.
    const test = task.id === 'contextpro-worktree-routing' ? stdout.replace("    const guide = await client.readResource({ uri: 'contextpro://instructions' });\n    assert.match(guide.contents[0].text, /absolute worktree root/);\n", '') : stdout;
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), test);
  }
}
async function validate(task, root, label) {
  const started = performance.now();
  if (!await existing(join(root, '.git'))) await exec('git', ['init', '-q'], { cwd: root });
  await injectValidation(task, root);
  const log = join(output, `${label}.validation.log`);
  try {
    let result;
    if (task.validator === 'node') {
      const build = await run(process.execPath, ['node_modules/typescript/bin/tsc'], root, `${log}.build`);
      if (build.code !== 0) return { passed: false, stage: 'build', ...build };
      result = await run(process.execPath, ['--test', ...task.tests], root, log);
    } else if (task.validator === 'vitest') {
      result = await run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...task.tests], root, log);
    } else if (task.validator === 'app-d-browser') {
      const build = await run(process.execPath, ['node_modules/next/dist/bin/next', 'build'], root, `${log}.build`, 300000, { NEXT_TELEMETRY_DISABLED: '1' });
      if (build.code !== 0) return { passed: false, stage: 'build', ...build };
      await writeFile(join(root, 'pilot.playwright.config.ts'), 'import base from "./playwright.config"; import {defineConfig} from "@playwright/test"; export default defineConfig({...base, projects:base.projects?.filter(p=>p.name==="desktop-chromium").map(p=>({...p,use:{...p.use,channel:"chrome"}}))});');
      result = await run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=pilot.playwright.config.ts', ...task.tests, '--project=desktop-chromium', '--workers=1', '--retries=0', ...(task.testPattern ? ['--grep', task.testPattern] : [])], root, log, 300000,
        { APP_D_E2E_PORT: '3219', NEXT_TELEMETRY_DISABLED: '1' });
    } else if (task.validator === 'text-preview') {
      result = await run(process.execPath, [join(here, 'pilot-text-preview.mjs'), root], root, log, 120000);
    } else throw Error('Unknown validator');
    return { passed: result.code === 0 && !result.timedOut, ...result, durationMs: performance.now() - started };
  } catch (error) { await writeFile(log, error.stack ?? error.message); return { passed: false, error: error.message, durationMs: performance.now() - started }; }
}

if (flags.has('--prepare') || flags.has('--recheck')) {
  const records = flags.has('--recheck') ? JSON.parse(await readFile(join(output, 'preflight.json'), 'utf8')) : [];
  for (const task of tasks) {
    const before = join(output, 'corpus', `${task.id}-before`), after = join(output, 'corpus', `${task.id}-after`);
    if (!flags.has('--recheck') && (await existing(before) || await existing(after))) throw Error(`Fixture already exists: ${task.id}; choose a fresh output directory.`);
    const parent = (await exec('git', ['rev-parse', `${task.fix}^`], { cwd: repos[task.repository] })).stdout.trim();
    console.log(`PREPARE ${task.id}`);
    if (!await existing(before)) await archive(task, parent, before);
    if (!await existing(after)) await archive(task, task.fix, after);
    // Validation copies contain hidden tests; the agent corpus remains untouched.
    const precheck = join(output, 'checks', `${task.id}-before`), postcheck = join(output, 'checks', `${task.id}-after`);
    await cloneDirectory(before, precheck); await cloneDirectory(after, postcheck);
    const pre = await validate(task, precheck, `${task.id}-before`), post = await validate(task, postcheck, `${task.id}-after`);
    const record = { taskId: task.id, parent, fix: task.fix, contractHash, before: pre, after: post, discriminates: !pre.passed && post.passed };
    const index = records.findIndex(row => row.taskId === task.id);
    if (index >= 0) records[index] = record; else records.push(record);
    await save(join(output, 'preflight.json'), records);
    console.log(`VALIDATOR ${task.id}: before=${pre.passed}, after=${post.passed}`);
    await rm(precheck, { recursive: true, force: true }); await rm(postcheck, { recursive: true, force: true });
    await rm(after, { recursive: true, force: true });
  }
  if (records.some(row => !row.discriminates)) process.exitCode = 1;
} else if (flags.has('--run')) {
  const preflight = JSON.parse(await readFile(join(output, 'preflight.json'), 'utf8'));
  for (const task of tasks) if (!preflight.some(row => row.taskId === task.id && row.contractHash === contractHash && row.discriminates)) throw Error(`Validator not qualified: ${task.id}`);
  if (await existing(join(output, 'runs.json'))) throw Error('runs.json exists; never silently overwrite/retry a campaign');
  const config = JSON.parse((await exec('python3', ['-c', 'import pathlib,tomllib,json; c=tomllib.loads((pathlib.Path.home()/".codex/config.toml").read_text()); print(json.dumps({k:c.get(k) for k in ("model","model_reasoning_effort")}))'])).stdout);
  if (!config.model) throw Error('Explicit configured agent model required');
  const launchers = Object.fromEntries(['baseline', 'candidate'].map(variant => [variant, { command: process.execPath, args: [join(output, variant, 'build/index.js')] }]));
  const fingerprints = Object.fromEntries(await Promise.all(Object.entries(launchers).map(async ([variant, launcher]) => [variant, await fingerprintLauncher(launcher)])));
  await save(join(output, 'plan.json'), { contractHash, plan, config, fingerprints, dependencyPolicy: 'APFS copies of existing installed dependencies, identical per task; not a clean lockfile install', contextPolicy: 'structurally seeded, no corpus embeddings; local semantic evaluation is a separate campaign' });
  const rows = [];
  for (const trial of plan) {
    const task = tasks.find(task => task.id === trial.taskId), label = `${task.id}-${trial.repeat}-${trial.variant}`;
    const root = join(output, 'runs', label), launcher = launchers[trial.variant];
    console.log(`START ${label}`);
    const prepStart = performance.now();
    await cloneDirectory(join(output, 'corpus', `${task.id}-before`), root);
    await exec('git', ['init', '-q'], { cwd: root }); await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Pilot', '-c', 'user.email=pilot@localhost', 'commit', '-qm', 'Isolated task fixture'], { cwd: root, maxBuffer: 1024 * 1024 });
    if (launcher) {
      if (JSON.stringify(await fingerprintLauncher(launcher)) !== JSON.stringify(fingerprints[trial.variant])) throw Error('Server build changed');
      const client = new Client({ name: 'pilot-prepare', version: '1' });
      const transport = new StdioClientTransport({ command: launcher.command, args: [...launcher.args, '--root', root], env: { ...process.env, CONTEXTPRO_TOOL_PROFILE: 'full', CONTEXTPRO_REINDEX_NO_EMBED: 'true', CONTEXTPRO_EMBED_TRACKER: 'lazy' }, stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      try { await client.connect(transport); const result = await client.callTool({ name: 'reindex', arguments: { root, no_embed: true, auto_hubs: false } }, undefined, { timeout: 120000 }); if (result.isError) throw Error('Index preparation failed'); }
      finally { await client.close(); await transport.close(); }
    }
    const preparationMs = performance.now() - prepStart;
    const providerTrace = join(output, `${label}.provider.jsonl`), serverTrace = join(output, `${label}.server.jsonl`);
    const overrides = ['model=' + JSON.stringify(config.model), 'project_doc_max_bytes=0', 'approval_policy="never"'];
    if (config.model_reasoning_effort) overrides.push('model_reasoning_effort=' + JSON.stringify(config.model_reasoning_effort));
    if (launcher) {
      overrides.push('mcp_servers.contextpro.command=' + JSON.stringify(launcher.command), 'mcp_servers.contextpro.args=' + JSON.stringify([...launcher.args, '--root', root]));
      const env = { CONTEXTPRO_TOOL_PROFILE: 'lean', CONTEXTPRO_REINDEX_NO_EMBED: 'true', CONTEXTPRO_EMBED_TRACKER: 'lazy', CONTEXTPRO_CHAT_RERANK: 'false', CONTEXTPRO_FEATURE_SUMMARIES: 'false', CONTEXTPRO_CONNECTED_CONTEXT: String(trial.variant === 'candidate'), CONTEXTPRO_TOOL_TRACE_PATH: serverTrace, CONTEXTPRO_PROVIDER_TRACE_PATH: providerTrace };
      for (const [key, value] of Object.entries(env)) overrides.push(`mcp_servers.contextpro.env.${key}=${JSON.stringify(value)}`);
    }
    const prompt = `${task.prompt}\n\nImplement and validate the change in this isolated repository. Do not browse, delegate, inspect files outside this repository, or access another checkout or git history. Do not alter dependency installations. Preserve unrelated behavior and stop when done. ${launcher ? 'Use ContextPro first for unfamiliar code, bounded outputs and batched reads. Native search and reads are available when needed. Pass this absolute repository root to every MCP call.' : 'Use ordinary native search and file reads.'}`;
    const collector = createEventCollector(), start = performance.now();
    const child = spawn('codex', ['exec', '--ignore-user-config', '--ephemeral', '--json', '--sandbox', 'workspace-write', '-C', root, ...overrides.flatMap(value => ['-c', value]), prompt], { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; collector.push(chunk.toString(), performance.now() - start); }); child.stderr.on('data', chunk => { stderr += chunk; });
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    let force; const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 3000); }, manifest.agentTimeoutMs);
    let exitCode;
    try { exitCode = await new Promise((resolveCode, reject) => { child.on('error', reject); child.on('close', resolveCode); }); }
    finally { clearTimeout(timer); clearTimeout(force); kill('SIGTERM'); }
    const agentMs = performance.now() - start; collector.finish(agentMs);
    await writeFile(join(output, `${label}.events.jsonl`), stdout, { mode: 0o600 }); await writeFile(join(output, `${label}.stderr.log`), stderr, { mode: 0o600 });
    // Include agent-created source files as well as modifications. Hidden
    // validation is injected only after capturing the patch.
    await exec('git', ['add', '-N', '.'], { cwd: root });
    await writeFile(join(output, `${label}.patch`), (await exec('git', ['diff', '--binary'], { cwd: root, maxBuffer: 20 * 1024 * 1024 })).stdout, { mode: 0o600 });
    const validation = await validate(task, root, label);
    const row = { ...trial, contractHash, preparationMs, agentMs, validation, wallTimeMs: agentMs + validation.durationMs,
      exitCode, timedOut, success: exitCode === 0 && !timedOut && validation.passed, usage: providerUsage(collector.events),
      toolCalls: [...collector.calls.values()], nativeCommandCalls: [...collector.calls.values()].filter(call => call.type === 'command_execution').length,
      nativeReadCommandCandidates: [...collector.calls.values()].filter(call => call.type === 'command_execution' && /\b(rg|grep|sed|cat|head|tail|find|read_file|readFile|read_text)\b/.test(call.command ?? '')).length,
      providerUsage: await readFile(providerTrace, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse), () => null), costUsd: null };
    if (launcher && JSON.stringify(await fingerprintLauncher(launcher)) !== JSON.stringify(fingerprints[trial.variant])) throw Error('Server changed during trial');
    rows.push(row); await save(join(output, 'runs.json'), rows);
    console.log(`END ${label}: success=${row.success}, agent=${Math.round(agentMs)}ms`);
    await rm(root, { recursive: true, force: true });
  }
  const pairs = Array.from({ length: repeats }, (_, repeat) => tasks.map(task => ({ taskId: task.id, repeat, baseline: rows.find(row => row.taskId === task.id && row.repeat === repeat && row.variant === 'baseline'), candidate: rows.find(row => row.taskId === task.id && row.repeat === repeat && row.variant === 'candidate') }))).flat();
  const passing = pairs.filter(pair => pair.baseline?.success && pair.candidate?.success);
  const ratios = passing.map(pair => ({ taskId: pair.taskId, repeat: pair.repeat, time: pair.candidate.wallTimeMs / pair.baseline.wallTimeMs,
    tokens: pair.candidate.usage && pair.baseline.usage ? (pair.candidate.usage.input_tokens + pair.candidate.usage.output_tokens) / (pair.baseline.usage.input_tokens + pair.baseline.usage.output_tokens) : null }));
  const timeRatio = latencyDistribution(ratios.map(r => r.time)).medianMs, tokenRatio = latencyDistribution(ratios.map(r => r.tokens)).medianMs;
  await save(join(output, 'summary.json'), { samples: rows.length, success: Object.fromEntries(variants.map(variant => [variant, rows.filter(row => row.variant === variant && row.success).length])),
    correctnessRegressions: pairs.filter(p => p.baseline?.success && !p.candidate?.success).map(p => p.taskId), jointlyPassing: passing.length, ratios, medianTimeRatio: timeRatio, medianTokenRatio: tokenRatio,
    note: 'Single-run paired pilot; no confidence intervals or universal savings claim. Costs unavailable; provider tokens include cached inputs once.' });
} else console.log(JSON.stringify({ contractHash, plan, instruction: '--prepare qualifies validators; --run consumes configured Codex quota after qualification.' }, null, 2));
