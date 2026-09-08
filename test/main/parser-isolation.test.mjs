import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {IsolatedParser} from '../../build/core/parser-process.js';
import {parseWithTreeSitter,validateSyntax} from '../../build/core/tree-sitter.js';

it('isolates fatal worker exits, rejects queued requests and restarts without killing the caller',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'contextpro-worker-'));
 const path=join(dir,'worker.mjs');
 await writeFile(path,`process.on('disconnect',()=>process.exit(0));process.on('message',m=>{if(m.content==='die')process.kill(process.pid,'SIGKILL');else process.send({id:m.id,result:{pid:process.pid,flags:process.execArgv}});});`);
 const client=new IsolatedParser({worker:pathToFileURL(path),cooldownMs:0,timeoutMs:10000});
 try {
  const a=await client.request('parse','ok','.ts');
  const b=await client.request('parse','ok','.ts');
  assert.equal(a.pid,b.pid);assert.notEqual(a.pid,process.pid);
  assert.ok(a.flags.includes('--liftoff-only'));assert.ok(a.flags.includes('--no-wasm-tier-up'));
  const results=await Promise.allSettled([client.request('parse','die','.ts'),client.request('parse','queued','.ts')]);
  assert.deepEqual(results.map(x=>x.status),['rejected','rejected']);
  const c=await client.request('parse','ok','.ts');assert.notEqual(c.pid,a.pid);
 }finally{client.close();await rm(dir,{recursive:true,force:true});}
});

it('terminates hung parsers and rejects oversized source before dispatch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'contextpro-timeout-'));const path=join(dir,'worker.mjs');
 await writeFile(path,`process.on('message',()=>{while(true){}});`);
 const client=new IsolatedParser({worker:pathToFileURL(path),timeoutMs:500});
 try {
  await assert.rejects(client.request('parse',' '.repeat(8_000_001),'.ts'),/capacity/);
  await assert.rejects(client.request('parse','hang','.ts'),/timed out/);
  await assert.rejects(client.request('validate','ok','.ts'),/recovering/);
 }finally{client.close();await rm(dir,{recursive:true,force:true});}
});

it('preserves concurrent parsing and syntax validation through the isolated runtime',async()=>{
 const results=await Promise.all(Array.from({length:30},(_,i)=>parseWithTreeSitter(`export function action${i}() { return ${i}; }`,'.ts')));
 for(let i=0;i<results.length;i++)assert.ok(results[i]?.some(s=>s.name===`action${i}`));
 assert.deepEqual(await validateSyntax('function broken( {','.ts'),{ok:false,checked:true,firstError:{line:1,column:1,type:'ERROR'}});
 assert.equal((await validateSyntax('function valid() {}','.ts')).ok,true);
});
