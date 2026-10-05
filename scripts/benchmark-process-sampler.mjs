#!/usr/bin/env node
// Optional read-only observer for an existing coding campaign. RSS is sampled,
// not peak memory or unique physical pages. Never records command arguments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const exec = promisify(execFile);
const [pidArgument, progressArgument, outputArgument] = process.argv.slice(2);
const runnerPid = Number(pidArgument);
if (!Number.isInteger(runnerPid) || runnerPid <= 1 || !progressArgument || !outputArgument) {
  throw Error('Usage: node scripts/benchmark-process-sampler.mjs RUNNER_PID PROGRESS_LOG OUTPUT_JSONL');
}
if (process.platform === 'win32') throw Error('This observer requires Unix ps; memory evidence is unavailable on this platform.');
const progress = resolve(progressArgument), output = resolve(outputArgument);
await appendFile(output, JSON.stringify({kind:'sampling_started',at:new Date().toISOString(),runnerPid,
  policy:'Every two seconds while the selected runner lives. Sum of observed Codex process-tree RSS; excludes the harness and non-agent preparation/validation. Shared pages may be counted more than once. Missing or earlier samples are unavailable, not zero.'})+'\n',{mode:0o600});
while (true) {
  const text = (await exec('ps',['-axo','pid=,ppid=,rss=,comm='],{maxBuffer:8*1024*1024})).stdout;
  const rows = text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{pid:Number(match[1]),ppid:Number(match[2]),rssKiB:Number(match[3]),name:basename(match[4])}] : [];
  });
  if (!rows.some(row=>row.pid===runnerPid)) break;
  const descendants = seeds => {
    const ids = new Set(seeds);
    for(let count=-1;count!==ids.size;) {count=ids.size;for(const row of rows)if(ids.has(row.ppid))ids.add(row.pid);}
    return ids;
  };
  const tree = descendants([runnerPid]);
  const agents = rows.filter(row=>tree.has(row.pid) && /^codex(?:-cli)?$/.test(row.name));
  const agentTree = descendants(agents.map(row=>row.pid));
  const processes = rows.filter(row=>agentTree.has(row.pid));
  const log = await readFile(progress,'utf8');
  const last = log.trim().split('\n').at(-1) ?? '';
  const trial = last.startsWith('START ') ? last.slice(6) : null;
  if(trial && agents.length) await appendFile(output,JSON.stringify({kind:'sample',at:new Date().toISOString(),trial,
    processes,totalRssKiB:processes.reduce((sum,row)=>sum+row.rssKiB,0)})+'\n');
  await new Promise(done=>setTimeout(done,2000));
}
await appendFile(output,JSON.stringify({kind:'sampling_stopped',at:new Date().toISOString()})+'\n');
