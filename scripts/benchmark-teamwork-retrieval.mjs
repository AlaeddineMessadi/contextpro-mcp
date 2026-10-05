#!/usr/bin/env node
// Explicit, bounded structural/text comparison. Supply installed competitor binaries.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const root=resolve(process.env.CONTEXTPRO_COMPARISON_ROOT??'.contextpro/teamwork-retrieval-fixture');
const output=resolve(process.env.CONTEXTPRO_COMPARISON_OUTPUT??'.contextpro/teamwork-retrieval.json');
const files={
  'src/service.ts':'export function charge(amount: number) { return amount * 100; }\n',
  'src/caller.ts':'import {charge} from "./service";\nexport const total = charge(3);\n',
  'python/config.py':'def load_config(path: str):\n    return {"path": path}\n',
  'humanpending.md':'# Owner dependencies\n\nGitHub Actions is blocked because account payments failed or the spending limit was reached. The owner must resolve billing before hosted CI can run.\n',
  '.gitignore':'.codanna/\n.contextpro/\n.codebase-memory/\n.fastembed_cache\n',
};
for(const [path,text] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);}
const codanna=process.env.CONTEXTPRO_CODANNA, memory=process.env.CONTEXTPRO_CODEBASE_MEMORY;
if(!codanna||!memory)throw Error('Supply CONTEXTPRO_CODANNA and CONTEXTPRO_CODEBASE_MEMORY executable paths.');
try{await readFile(join(root,'.codanna/settings.toml'));}catch{await exec(codanna,['init'],{cwd:root});}
const settings=join(root,'.codanna/settings.toml'), original=await readFile(settings,'utf8');
await writeFile(settings,original.replace(/(\[semantic_search\][\s\S]*?enabled = )true/,'$1false'));
const indexStart=performance.now();await exec(codanna,['index','.','--no-progress'],{cwd:root});const codannaIndexMs=performance.now()-indexStart;
const project='contextpro-comparison-'+createHash('sha256').update(root).digest('hex').slice(0,12);
const queries=[
  {id:'ts-definition',query:'charge',path:'src/service.ts',body:'return amount * 100'},
  {id:'python-definition',query:'load_config',path:'python/config.py',body:'return {"path": path}'},
  {id:'ci-billing',query:'billing',path:'humanpending.md',body:'owner must resolve billing'},
  {id:'no-answer',query:'nonexistent_zebra_468291',path:null,body:null},
];
const results=[];
for(const engine of ['contextpro','codebase-memory','codanna']){
  const client=new Client({name:'bounded-comparison',version:'1'});
  const transport=new StdioClientTransport({command:engine==='contextpro'?process.execPath:engine==='codanna'?codanna:memory,
    args:engine==='contextpro'?[resolve('build/index.js'),'--root',root]:engine==='codanna'?['serve']:[],cwd:root,stderr:'pipe',
    env:{...process.env,CONTEXTPRO_TOOL_PROFILE:'full',CONTEXTPRO_REINDEX_NO_EMBED:'true',CONTEXTPRO_EMBED_TRACKER:'off',CONTEXTPRO_ADAPTIVE_CONTEXT:'true',CONTEXTPRO_DAEMON:'false'}});
  transport.stderr.on('data',()=>{});
  const start=performance.now();await client.connect(transport);const startupMs=performance.now()-start;
  try {
    const schemas=(await client.listTools()).tools;
    let indexMs=codannaIndexMs;
    if(engine!=='codanna'){
      const begin=performance.now();const result=await client.callTool({name:engine==='contextpro'?'reindex':'index_repository',arguments:engine==='contextpro'?{root,no_embed:true,auto_hubs:false}:{repo_path:root,name:project,mode:'fast'}},undefined,{timeout:120000});
      if(result.isError)throw Error(JSON.stringify(result));indexMs=performance.now()-begin;
    }
    const rows=[];
    for(let repeat=0;repeat<2;repeat++)for(const query of queries){
      const call=engine==='contextpro'?{name:'context',arguments:{root,query:query.query,intent:'lookup',max_tokens:1200}}
        :engine==='codebase-memory'?{name:'search_code',arguments:{project,pattern:query.query,mode:'full',limit:5,max_output_tokens:1200}}
        :query.id==='ci-billing'?{name:'search_documents',arguments:{query:query.query,limit:5}}:{name:'find_symbol',arguments:{name:query.query}};
      if(!schemas.some(tool=>tool.name===call.name))throw Error('Missing comparison tool '+call.name);
      const begin=performance.now();let result;
      try{result=await client.callTool(call,undefined,{timeout:30000});}catch(error){result={isError:true,message:error.message};}
      const elapsedMs=performance.now()-begin,text=JSON.stringify(result);
      const rssKiB=await exec('ps',['-o','rss=','-p',String(transport.pid)]).then(r=>Number(r.stdout.trim())||null,()=>null);
      rows.push({query:query.id,repeat,call,elapsedMs,outputBytes:Buffer.byteLength(text),serverRssKiB:rssKiB,
        locationFound:query.path?text.includes(query.path):null,sourceFound:query.body?text.includes(query.body.replaceAll('"','\\"')):null,result});
    }
    results.push({engine,startupMs,indexMs,rows});
  } finally {await client.close();await transport.close();}
}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({fixtureHash:createHash('sha256').update(JSON.stringify(files)).digest('hex'),files,queries,
  conditions:'Same bounded local corpus; structural/text only, no corpus embeddings. First/warm are first/second requests in one session, not OS-cache-cold. Codanna document search requires a separately embedded collection and is reported unavailable in this provider-free comparison. RSS is server process only, sampled after requests, not peak or process-tree usage. Location/source checks are simple fixture assertions, not coding outcomes. No billing estimates.',results},null,2));
console.log(output);
