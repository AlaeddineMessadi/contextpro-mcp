#!/usr/bin/env node
// Fresh Codex comprehension sessions, provider-reported usage and explicit acceptance checks.
// Invoke only when the user authorizes agent trials; uses the configured model/account quota.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedWorktreeFromBase } from '../build/core/worktree-seed.js';
import { summarizePairedAgentRuns } from './benchmark-retrieval.mjs';

const exec = promisify(execFile);
const source = resolve(process.argv[2] || '.');
const output = resolve(process.argv[3] || '.contextpro/codex-pairs');
const profile = process.env.CONTEXTPRO_BENCH_PROFILE || 'workflow';
if (!['workflow', 'lean'].includes(profile)) throw new Error('Benchmark profile must be workflow or lean.');
await mkdir(output, { recursive: true });
const config = JSON.parse((await exec('python3', ['-c', 'import pathlib,tomllib,json; c=tomllib.loads((pathlib.Path.home()/".codex/config.toml").read_text()); print(json.dumps({k:c.get(k) for k in ("model","model_reasoning_effort","model_provider","mcp_servers")}))'])).stdout);
if (!config.model) throw new Error('Set an explicit configured model before measuring paired runs.');
if (config.model_provider && config.model_provider !== 'openai') throw new Error('This runner currently supports the standard OpenAI Codex provider only.');
const mcp = config.mcp_servers.contextpro;
const evidence = { type:'array', items:{ type:'object', properties:{ file:{type:'string'}, symbol:{type:'string'} }, required:['file','symbol'], additionalProperties:false } };
const tasks = [
  { id:'native-cache-contract', prompt:'Investigate native dependency repair in this repository. Which runtime identity fields and dependency versions determine the isolated cache key? Does automatic repair rebuild the shared project node_modules in place? Return the requested facts and precise file/symbol evidence.', properties:{ identityFields:{type:'array',items:{type:'string'}}, dependencyVersionsInKey:{type:'boolean'}, repairsSharedNodeModules:{type:'boolean'}, evidence },
    check: answer => ['abi','platform','arch','libc'].every(x=>answer.identityFields?.map(v=>v.toLowerCase().split(':')[0].trim()).includes(x)) && answer.dependencyVersionsInKey === true && answer.repairsSharedNodeModules === false && ['src/core/native-runtime.ts','src/core/native-repair.ts'].every(path=>answer.evidence?.some(e=>e.file.replace(/:\d+(?:-\d+)?$/, '').endsWith(path) && e.symbol)) },
  { id:'source-mutation-contract', prompt:'Investigate the actual source mutation path. Does it prevent symlink escapes from the repository, reject stale content at publication, and serialize concurrent writes? Return these three facts and precise file/symbol evidence for the implementation, not just tests or documentation.', properties:{ symlinkEscapeBlocked:{type:'boolean'}, staleWriteRejected:{type:'boolean'}, serializesWrites:{type:'boolean'}, evidence },
    check: answer => answer.symlinkEscapeBlocked === true && answer.staleWriteRejected === true && answer.serializesWrites === true && ['src/core/path-guard.ts','src/core/source-mutation.ts'].every(path=>answer.evidence?.some(e=>e.file.replace(/:\d+(?:-\d+)?$/, '').endsWith(path) && e.symbol)) },
];
const requestedTask = process.env.CONTEXTPRO_BENCH_TASK;
if (requestedTask && !tasks.some(task => task.id === requestedTask)) throw new Error('Unknown benchmark task.');
const rows = [];
for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
  const task = tasks[taskIndex];
  if (requestedTask && task.id !== requestedTask) continue;
  for (const variant of taskIndex % 2 ? ['contextpro','baseline'] : ['baseline','contextpro']) {
    const runId = `${task.id}-${variant}`;
    const root = await mkdtemp(join(tmpdir(), 'contextpro-codex-pair-'));
    const archive = join(root,'source.tar');
    await exec('git',['archive',`--output=${archive}`,'HEAD'],{cwd:source});
    await exec('tar',['-xf',archive,'-C',root]);
    await rm(archive);
    // Remove project instructions equally so neither variant inherits a preferred-tool rule.
    for (const path of ['AGENTS.md','CLAUDE.md','.claude','.codex','scripts/benchmark-live.mjs','scripts/benchmark-codex-pairs.mjs','scripts/tokenize-live-benchmark.py','docs/benchmarks']) await rm(join(root,path),{force:true,recursive:true});
    await exec('git',['init','-q'],{cwd:root});
    await exec('git',['add','.'],{cwd:root});
    await exec('git',['-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Isolated benchmark corpus'],{cwd:root});
    const prepStart = performance.now();
    if (variant === 'contextpro') await seedWorktreeFromBase(root,source);
    const preparationMs = performance.now()-prepStart;
    const schema = join(output,`${runId}.schema.json`);
    await writeFile(schema,JSON.stringify({type:'object',properties:task.properties,required:Object.keys(task.properties),additionalProperties:false}));
    const answerPath = join(output,`${runId}.answer.json`);
    const overrides = ['model='+JSON.stringify(config.model), 'project_doc_max_bytes=0', 'approval_policy="never"'];
    if (config.model_reasoning_effort) overrides.push('model_reasoning_effort='+JSON.stringify(config.model_reasoning_effort));
    if (variant === 'contextpro') {
      overrides.push('mcp_servers.contextpro.command='+JSON.stringify(mcp.command),'mcp_servers.contextpro.args='+JSON.stringify(mcp.args));
      for (const [key,value] of Object.entries({...mcp.env, CONTEXTPRO_TOOL_PROFILE:profile})) overrides.push(`mcp_servers.contextpro.env.${key}=${JSON.stringify(value)}`);
    }
    const guidance = profile === 'lean'
      ? 'Use ContextPro context(query:...) to find and read evidence together. If necessary, batch further file/symbol/line reads with context(targets:[{file,symbol?},...]). Native tools remain available if needed.'
      : 'Use ContextPro first for discovery, preferring compact/text results and bounded import context. Batch independent symbol reads with explain(symbols:[{symbol,file},...],depth:0,format:"source") rather than repeated calls. Native tools remain available if needed.';
    const prompt = `${task.prompt}\n\nThis is a read-only repository comprehension benchmark. Do not edit files, delegate, browse the web, or inspect any files outside this repository. Use source evidence; stop once the requested facts are verified. ${variant === 'contextpro' ? guidance : 'Use ordinary local shell search and file reads.'}`;
    const args = ['exec','--ignore-user-config','--ephemeral','--json','--sandbox','workspace-write','-C',root,'--output-schema',schema,'--output-last-message',answerPath,...overrides.flatMap(value=>['-c',value]),prompt];
    console.log(`START ${runId} ${config.model} ${config.model_reasoning_effort ?? 'default effort'}`);
    const started = performance.now();
    const child = spawn('codex',args,{cwd:root,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},300000);
    const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    clearTimeout(timer);
    const wallTimeMs=performance.now()-started;
    await writeFile(join(output,`${runId}.events.jsonl`),stdout);
    await writeFile(join(output,`${runId}.stderr.txt`),stderr);
    const events=stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const usageEvents=events.filter(e=>e.type==='turn.completed' && e.usage);
    const usage=usageEvents.length ? usageEvents.reduce((acc,e)=>{ for(const [key,value] of Object.entries(e.usage)) if(typeof value==='number') acc[key]=(acc[key]??0)+value;return acc;},{}) : null;
    let answer=null;
    try{answer=JSON.parse(await readFile(answerPath,'utf8'));}catch{}
    const success=exitCode===0 && !!answer && task.check(answer);
    rows.push({taskId:task.id,pairId:'1',variant,profile,prompt,model:config.model,reasoningEffort:config.model_reasoning_effort,sourceCommit:(await exec('git',['rev-parse','HEAD'],{cwd:source})).stdout.trim(),preparationMs,wallTimeMs,exitCode,timedOut,success,usage,tokenSource:usage?'provider_usage':null,costUsd:null,costSource:null,answer,acceptanceEvidence:'Typed source-contract facts plus required implementation-file evidence; one deterministic comprehension check, not patch correctness.',contextproCalls:events.filter(e=>e.type==='item.completed' && e.item?.type==='mcp_tool_call').map(e=>({type:e.type,server:e.item.server,tool:e.item.tool,status:e.item.status,isError:e.item.result?.isError ?? e.item.result?.content?.some(c=>c.text?.startsWith("MCP error")) ?? false})),root});
    await writeFile(join(output,'runs.json'),JSON.stringify(rows,null,2));
    console.log(`END ${runId}: success=${success} ${Math.round(wallTimeMs)}ms usage=${JSON.stringify(usage)}`);
  }
}
if (rows.every(row => Number.isSafeInteger(row.usage?.input_tokens) && Number.isSafeInteger(row.usage?.output_tokens))) {
  const measured = rows.map(row => ({ taskId:row.taskId,pairId:row.pairId,model:row.model,variant:row.variant,success:row.success,inputTokens:row.usage.input_tokens,outputTokens:row.usage.output_tokens,...(Number.isSafeInteger(row.usage.cached_input_tokens)?{cachedInputTokens:row.usage.cached_input_tokens}:{}),wallTimeMs:row.wallTimeMs,tokenSource:'provider_usage',costUsd:null,costSource:'unavailable',acceptanceEvidence:row.acceptanceEvidence }));
  await writeFile(join(output,'agent-runs.json'),JSON.stringify(measured,null,2));
  await writeFile(join(output,'summary.json'),JSON.stringify(summarizePairedAgentRuns(measured),null,2));
}
console.log(`Results: ${output}. Provider token counts are observed; dollar savings remain unknown without verified pricing/billing.`);
