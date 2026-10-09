import {it} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

it('does not embed a corpus during search, and really aborts a stalled Ollama query',async()=>{
 let requests=0;
 let stall=false;
 let reportClosed;
 const connectionClosed=new Promise(resolve=>{reportClosed=resolve;});
 const server=createServer((_req,res)=>{
  requests++;
  if(stall){res.once('close',reportClosed);return;}
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({embeddings:[[1,0]]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'contextpro-offline-search-'));
 const old=Object.fromEntries(['OLLAMA_HOST','CONTEXTPRO_QUERY_EMBED_TIMEOUT_MS','CONTEXTPRO_PROVIDER'].map(k=>[k,process.env[k]]));
 process.env.OLLAMA_HOST=`http://127.0.0.1:${server.address().port}`;
 process.env.CONTEXTPRO_QUERY_EMBED_TIMEOUT_MS='10000';
 process.env.CONTEXTPRO_PROVIDER='ollama';
 try {
  const {reindex}=await import('../../build/tools/reindex.js');
  const {unifiedSearch}=await import('../../build/tools/search.js');
  const {fetchQueryEmbedding,withQueryEmbeddingCache}=await import('../../build/core/embeddings.js');
  await writeFile(join(root,'api.ts'),'export function protectChallenge() { return true; }');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  const result=JSON.parse(await unifiedSearch({rootDir:root,query:'protectChallenge',mode:'hybrid',format:'compact'}));
  assert.ok(result.files.some(item=>item.path==='api.ts'));
  assert.equal(requests,0,'missing corpus vectors must cause lexical fallback, not an embedding rebuild');
  // Warm the lazily imported SDK and HTTP client before measuring cancellation.
  // On a fresh Node 22 runner, a 150 ms deadline can expire before dispatch.
  assert.deepEqual(await fetchQueryEmbedding('warm the local test provider'),[1,0]);
  assert.equal(requests,1);
  process.env.CONTEXTPRO_QUERY_EMBED_TIMEOUT_MS='500';
  await withQueryEmbeddingCache(async()=>{
   await new Promise(resolve=>setTimeout(resolve,600));
   const first=fetchQueryEmbedding('after slow index preparation');
   assert.equal(fetchQueryEmbedding('after slow index preparation'),first,'parallel readers share the query vector');
   assert.deepEqual(await first,[1,0],'index preparation must not consume the provider deadline');
   await new Promise(resolve=>setTimeout(resolve,600));
   await assert.rejects(fetchQueryEmbedding('another query in the same retrieval'),/abort|timeout|failed/i);
   assert.deepEqual(await fetchQueryEmbedding('after slow index preparation'),[1,0],'completed vectors remain reusable after the deadline');
  });
  assert.equal(requests,2,'the provider deadline stays shared after the first request');
  requests=0;stall=true;
  process.env.CONTEXTPRO_QUERY_EMBED_TIMEOUT_MS='500';
  const start=performance.now();
  await assert.rejects(fetchQueryEmbedding('a stalled query'),/abort|timeout|failed/i);
  assert.equal(requests,1);assert.ok(performance.now()-start<3000,'query must not wait for the old 60-second timeout');
  let closeTimer;
  try {
   await Promise.race([connectionClosed,new Promise((_,reject)=>{
    closeTimer=setTimeout(()=>reject(new Error('timed-out request left its HTTP connection open')),1000);
   })]);
  }finally{clearTimeout(closeTimer);}
  (await import('../../build/core/db.js')).closeDB(root);
 }finally{
  for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});

it('reuses content-verified indexed symbols, but parses changed source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-cached-symbols-'));
 const {reindex}=await import('../../build/tools/reindex.js');
 const {semanticIdentifierSearchResults,invalidateIdentifierSearchCache}=await import('../../build/tools/semantic-identifiers.js');
 const {IsolatedParser}=await import('../../build/core/parser-process.js');
 const original=IsolatedParser.prototype.request;let parses=0;
 try{
  await writeFile(join(root,'api.ts'),'export function protectChallenge() { return true; }');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  IsolatedParser.prototype.request=function(...args){parses++;return original.apply(this,args);};
  const options={rootDir:root,query:'protectChallenge',preset:'keyword_only',expandCallers:false};
  const first=await semanticIdentifierSearchResults(options);
  assert.ok(first.results.some(item=>item.name==='protectChallenge'));
  assert.equal(parses,0,'fresh persisted symbols should avoid WASM parsing');
  await writeFile(join(root,'api.ts'),'export function protectUpdatedChallenge() { return false; }');
  invalidateIdentifierSearchCache();
  const changed=await semanticIdentifierSearchResults({...options,query:'protectUpdatedChallenge'});
  assert.ok(changed.results.some(item=>item.name==='protectUpdatedChallenge'));
  assert.ok(parses>0,'a content hash mismatch must bypass persisted symbols');
 }finally{
  IsolatedParser.prototype.request=original;invalidateIdentifierSearchCache();
  (await import('../../build/core/db.js')).closeDB(root);
  await rm(root,{recursive:true,force:true});
 }
});

it('keeps chat reranking opt-in and aborts an opted-in stalled provider',async()=>{
 let requests=0;
 const server=createServer((_req,_res)=>{requests++;});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const root=await mkdtemp(join(tmpdir(),'contextpro-rerank-'));
 const keys=['OLLAMA_HOST','CONTEXTPRO_CHAT_PROVIDER','CONTEXTPRO_CHAT_MODEL','CONTEXTPRO_CHAT_RERANK'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{OLLAMA_HOST:`http://127.0.0.1:${server.address().port}`,CONTEXTPRO_CHAT_PROVIDER:'ollama',CONTEXTPRO_CHAT_MODEL:'test'});
 const candidates=['src/a.ts','src/b.ts','src/c.ts'].map(path=>({path,score:0.7,reason:'candidate',symbols:[]}));
 try{
  const {maybeChatRerankPlanningFiles}=await import('../../build/tools/planning-helpers.js');
  delete process.env.CONTEXTPRO_CHAT_RERANK;
  assert.deepEqual(await maybeChatRerankPlanningFiles(root,'fix gating',candidates),candidates);
  assert.equal(requests,0,'a configured provider must not silently enable chat reranking');
  process.env.CONTEXTPRO_CHAT_RERANK='true';
  const start=performance.now();
  assert.deepEqual(await maybeChatRerankPlanningFiles(root,'fix gating',candidates),candidates);
  assert.equal(requests,1);assert.ok(performance.now()-start<5000);
 }finally{
  for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await rm(root,{recursive:true,force:true});
 }
});
