#!/usr/bin/env node
// Paired retrieval measurements against the locally configured MCP, not agent billing.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = resolve(process.argv[2] || '.');
const out = resolve(process.argv[3] || '.contextpro/benchmark-live');
if (await access(join(root, 'scripts/benchmark-live.mjs')).then(() => true, () => false)) {
  throw new Error('Use a frozen checkout without scripts/benchmark-live.mjs: otherwise search indexes its task queries and invalidates the benchmark. See docs/benchmarks/2026-09-07.md.');
}
const repetitions = Number(process.env.BENCH_REPETITIONS || 3);
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('Invalid repetitions');
await mkdir(out, { recursive: true });
const config = JSON.parse((await exec('python3', ['-c', 'import pathlib,tomllib,json; print(json.dumps(tomllib.loads((pathlib.Path.home()/".codex/config.toml").read_text())["mcp_servers"]["contextpro"]))'])).stdout);
const tasks = [
  { id: 'native-repair', query: 'Repair a native SQLite module compiled for the wrong Node ABI using an isolated cache', terms: ['native', 'repair', 'ABI'], expected: ['src/core/db-native.ts', 'src/core/native-repair.ts', 'src/core/native-runtime.ts'] },
  { id: 'safe-source-write', query: 'Prevent source edits from escaping the project through symlinks and serialize concurrent writes', terms: ['symlink', 'realpath', 'mutation'], expected: ['src/core/path-guard.ts', 'src/core/source-mutation.ts'] },
  { id: 'failed-reindex', query: 'After a partially failed reindex mark the index stale and require repair', terms: ['reindex', 'repair', 'stale'], expected: ['src/tools/reindex.ts', 'src/core/index-freshness.ts'] },
  { id: 'token-accounting', query: 'Calculate session token savings subtracting tool schema overhead without claiming actual billing savings', terms: ['schemaTokens', 'savedTokens', 'billing'], expected: ['src/core/efficiency.ts', 'src/tools/efficiency-report.ts', 'src/core/runtime-session.ts'] },
  { id: 'worktree-snapshot', query: 'Seed a new git worktree index from a consistent SQLite snapshot of the base checkout', terms: ['worktree', 'snapshot', 'seed'], expected: ['src/core/worktree-seed.ts'] },
  { id: 'parser-concurrency', query: 'Load and cache tree sitter WebAssembly grammars before parsing source code', terms: ['grammar', 'wasm', 'Parser'], expected: ['src/core/tree-sitter.ts'] },
];
const rows = [];
const captures = [];
const textOf = result => result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
async function rg(args) {
  try { return (await exec('rg', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 })).stdout; }
  catch (e) { if (e.code === 1) return ''; throw e; }
}
async function baseline(task) {
  // A compact Bash-equivalent pipeline: tracked code, rank distinct query terms,
  // then return three matching windows per selected file. No expected paths used.
  const inventory = (await exec('git', ['ls-files', '-z'], { cwd: root })).stdout.split('\0').filter(p => /\.(?:ts|tsx|js|jsx|mjs|py|rs|go|json|md|css|html|yml|yaml|toml)$/.test(p) && !/(?:^|\/)(?:package-lock|bun\.lock)\b/.test(p));
  const matches = await rg(['--no-ignore', '--json', '-i', ...task.terms.flatMap(t => ['-e', t]), '--', ...inventory]);
  const ranked = new Map();
  for (const line of matches.trim().split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type !== 'match') continue;
    const path = event.data.path.text;
    const entry = ranked.get(path) || { path, terms: new Set(), matches: 0 };
    for (const term of task.terms) if (event.data.lines.text.toLowerCase().includes(term.toLowerCase())) entry.terms.add(term);
    entry.matches++;
    ranked.set(path, entry);
  }
  const paths = [...ranked.values()].sort((a,b) => b.terms.size - a.terms.size || b.matches - a.matches || a.path.localeCompare(b.path)).slice(0,5).map(x=>x.path);
  const snippets = paths.length ? await rg(['--no-ignore', '-n', '-H', '-i', '-C', '2', '-m', '3', ...task.terms.flatMap(t=>['-e',t]), '--', ...paths]) : '';
  return { paths, text: paths.join('\n') + '\n' + snippets, request: { pipeline: 'git ls-files; rg JSON ranked by distinct terms then line hits; rg -n -H -C2 -m3 top5', terms: task.terms }, subprocesses: paths.length ? 3 : 2 };
}
async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: root, env: { ...process.env, ...config.env, ...extraEnv }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'contextpro-live-benchmark', version: '1.0.0' });
  const start = performance.now();
  await client.connect(transport);
  return { client, startupMs: performance.now()-start, stderr: () => stderr };
}
const session = await connect({ CONTEXTPRO_TOOL_PROFILE: 'full' });
const call = (name, args) => session.client.callTool({ name, arguments: { ...args, root } }, undefined, { timeout: 120000 });
const statusBefore = await call('status', { format: 'json' });
// Reconcile the seeded snapshot before timing; existing vectors are retained.
const prepareStart = performance.now();
const preparation = await call('reindex', { no_embed: true });
if (preparation.isError) throw new Error(textOf(preparation));
const preparationMs = performance.now() - prepareStart;
const catalog = await session.client.listTools();
await writeFile(join(out, 'catalog-full.json'), JSON.stringify(catalog.tools));
try {
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index];
      const variants = ['rg', 'keyword_only', 'balanced', 'balanced_text', 'balanced_compact', 'balanced_dependencies'];
      const offset = (index + repetition) % variants.length;
      for (const variant of [...variants.slice(offset), ...variants.slice(0,offset)]) {
        const start = performance.now();
        let result;
        let error = null;
        try {
          if (variant === 'rg') result = await baseline(task);
          else {
            const compact = ['balanced_compact','balanced_dependencies'].includes(variant);
            const request = { query: task.query, mode: 'file', preset: variant.startsWith('balanced') ? 'balanced' : variant, top_k: 5, format: compact ? 'compact' : variant === 'balanced_text' ? 'text' : 'json', inline_code: 'crux', ...(variant === 'balanced_dependencies' ? {include_dependencies:true,profile:true} : {}) };
            const response = await call('search', request);
            if (response.isError) throw new Error(textOf(response));
            const text = textOf(response);
            const paths = variant === 'balanced_text'
              ? [...text.matchAll(/^\d+\. (.+?) \([\d.]+% total\)/gm)].map(m=>m[1])
              : compact ? JSON.parse(text).files?.map(x=>x.path) || [] : JSON.parse(text).files?.results?.map(x=>x.path) || [];
            result = { text, request, paths, dependencyPaths: compact ? JSON.parse(text).dependencies?.map(x=>x.path) ?? [] : [] };
          }
        } catch (e) { error = String(e); result = { text: error, request: {}, paths: [] }; }
        const latencyMs = performance.now() - start;
        const hits = result.paths.filter(p=>task.expected.includes(p)).length;
        const workingSet = new Set([...result.paths, ...(result.dependencyPaths ?? [])]);
        const row = { task: task.id, repetition, variant, latencyMs, paths: result.paths, dependencyPaths:result.dependencyPaths ?? [], workingSetRecall:task.expected.filter(path=>workingSet.has(path)).length/task.expected.length, expected: task.expected, recallAt5: hits/task.expected.length, precisionAt5: hits/5, complete: hits === task.expected.length, error, capture: captures.length };
        captures.push({ ...result, task: task.id, variant, repetition });
        rows.push(row);
        await writeFile(join(out,'progress.json'), JSON.stringify(rows,null,2));
        console.log(`${task.id} ${variant} repeat=${repetition} ${Math.round(latencyMs)}ms recall=${row.recallAt5.toFixed(2)}${error ? ' ERROR' : ''}`);
      }
    }
  }
  // Known-target API and body retrieval: full reads and compact grep are both reported.
  for (const file of ['src/core/native-runtime.ts', 'src/core/tree-sitter.ts', 'src/core/efficiency.ts']) {
    const start = performance.now();
    const response = await call('skeleton', { file_path: file });
    captures.push({ task: `skeleton:${file}`, variant: 'skeleton', text: textOf(response), request: { file_path: file }, latencyMs: performance.now()-start, error: response.isError || false });
    const readStart = performance.now();
    captures.push({ task: `skeleton:${file}`, variant: 'full_read', text: await readFile(join(root,file),'utf8'), request: { file }, latencyMs: performance.now()-readStart });
    const grepStart = performance.now();
    captures.push({ task: `skeleton:${file}`, variant: 'export_grep', text: await rg(['-n','^export ', '--',file]), request: { pattern: '^export ', file }, latencyMs: performance.now()-grepStart });
  }
  const packetArgs = { task: tasks[0].query, max_tokens: 1500, max_files: 5, preset: 'keyword_only', format: 'json', include_memory: false, include_recent_diffs: false };
  const packet = await call('task_pack',packetArgs);
  captures.push({ task: 'packet-delta', variant: 'full', text: textOf(packet), request: packetArgs });
  const packetData = JSON.parse(textOf(packet));
  const contextId = packetData.contextId ?? packetData.context_id ?? packetData.context?.id;
  if (contextId) {
    const args = { ...packetArgs, previous_context_id: contextId };
    captures.push({ task:'packet-delta', variant:'delta', text:textOf(await call('task_pack',args)), request:args });
  }
  const efficiency = await call('efficiency_report', { scope: 'session', format: 'json' });
  const statusAfter = await call('status', { format: 'json' });
  await writeFile(join(out,'raw.json'),JSON.stringify({ generatedAt: new Date().toISOString(), root, commit: (await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(), runtime: process.version, config: { command: config.command, args: config.args, env: config.env }, startupMs: session.startupMs, preparationMs, preparation, tasks, rows, captures, statusBefore, statusAfter, efficiency },null,2));
} finally {
  await session.client.close();
  await writeFile(join(out,'server-stderr.txt'),session.stderr());
}
const workflow = await connect({ CONTEXTPRO_TOOL_PROFILE: 'workflow' });
try { await writeFile(join(out,'catalog-workflow.json'),JSON.stringify((await workflow.client.listTools()).tools)); }
finally { await workflow.client.close(); }
console.log(`Raw results: ${out}`);
