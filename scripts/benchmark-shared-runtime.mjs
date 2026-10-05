#!/usr/bin/env node
// Two concurrent local MCP sessions; sampled process-tree RSS is not peak usage.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile), temp=await mkdtemp(join(tmpdir(),'cp-shared-measure-'));
const entry=resolve(process.env.CONTEXTPRO_RUNTIME_BUILD??'build/index.js');
const output=resolve(process.env.CONTEXTPRO_RUNTIME_OUTPUT??'.contextpro/teamwork-runtime.json');
const results=[];
await writeFile(join(temp,'service.ts'),'export function charge(n: number) { return n * 100; }\n');
await writeFile(join(temp,'caller.ts'),'import {charge} from "./service";\nexport const result = charge(3);\n');
const rss=async seeds=>{
  const rows=(await exec('ps',['-axo','pid=,ppid=,rss='])).stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const pids=new Set(seeds);let size;
  do{size=pids.size;for(const [pid,ppid] of rows)if(pids.has(ppid))pids.add(pid);}while(size!==pids.size);
  return rows.filter(([pid])=>pids.has(pid)).map(([pid,ppid,rssKiB])=>({pid,ppid,rssKiB}));
};
try {
  // Counterbalance mode order across two independent process repetitions.
  for(let repeat=0;repeat<2;repeat++)for(const shared of repeat?[true,false]:[false,true]){
    const env={...process.env,CONTEXTPRO_TOOL_PROFILE:'full',CONTEXTPRO_REINDEX_NO_EMBED:'true',CONTEXTPRO_EMBED_TRACKER:'off',
      CONTEXTPRO_DAEMON:String(shared),CONTEXTPRO_RUNTIME_DIR:join(temp,'ipc')};
    let daemonPid;const clients=[],transports=[],stderr=[];
    try {
      if(shared) daemonPid=JSON.parse((await exec(process.execPath,[entry,'daemon','start'],{env})).stdout).pid;
      for(let i=0;i<2;i++){
        const client=new Client({name:'shared-measure',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[entry,'--root',temp],env,stderr:'pipe'});
        transport.stderr.on('data',chunk=>stderr.push(chunk.toString()));
        await client.connect(transport);clients.push(client);transports.push(transport);
      }
      const index=await clients[0].callTool({name:'reindex',arguments:{root:temp,no_embed:true,auto_hubs:false}});
      if(index.isError)throw Error(JSON.stringify(index));
      const samples=[];
      for(let round=0;round<4;round++){
        const calls=await Promise.all(clients.map(async client=>{
          const start=performance.now(),result=await client.callTool({name:'exact_references',arguments:{root:temp,file:'service.ts',line:1,symbol_name:'charge',format:'json'}});
          const text=JSON.stringify(result);
          return {elapsedMs:performance.now()-start,outputBytes:Buffer.byteLength(text),correct:!result.isError&&text.includes('caller.ts')};
        }));
        const processes=await rss([...transports.map(t=>t.pid),...daemonPid?[daemonPid]:[]]);
        samples.push({round,calls,processes,totalRssKiB:processes.reduce((sum,p)=>sum+p.rssKiB,0)});
      }
      results.push({repeat,shared,samples,fallbackWarnings:stderr.filter(line=>line.includes('[contextpro/daemon]'))});
    } finally {
      for(const client of clients)await client.close();for(const transport of transports)await transport.close();
      if(shared)await exec(process.execPath,[entry,'daemon','stop'],{env}).catch(()=>{});
    }
  }
  await writeFile(output,JSON.stringify({entry,conditions:'Two sessions, one root, TS references, two counterbalanced process repetitions. Round 0 is compiler-cold, rounds 1–3 compiler-warm; disk cache is not cleared. RSS includes observed descendants and service, sampled after calls, not peak. Index cache is shared on disk in both modes. This tiny fixture cannot establish general resource or latency gains.',results},null,2));
  console.log(output);
}finally{await rm(temp,{recursive:true,force:true});}
