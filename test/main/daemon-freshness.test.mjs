import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { daemonCommand, sharedCompute } from '../../build/core/local-daemon.js';

it('daemon retains freshness admission slots and databases until async work settles', {skip:process.platform==='win32'}, async () => {
  const temp=await mkdtemp(join(tmpdir(),'cp-freshness-lifetime-'));
  const before={runtime:process.env.CONTEXTPRO_RUNTIME_DIR,daemon:process.env.CONTEXTPRO_DAEMON};
  process.env.CONTEXTPRO_RUNTIME_DIR=join(temp,'ipc');process.env.CONTEXTPRO_DAEMON='true';
  const events=join(temp,'events.jsonl'), loader=join(temp,'loader.mjs');
  let child, pending=[];
  const waitFor=async predicate=>{
    const end=Date.now()+10_000;
    while(!await predicate()) {
      assert.ok(Date.now()<end,'timed out waiting for daemon test state');
      await new Promise(done=>setTimeout(done,20));
    }
  };
  const history=async()=> (await readFile(events,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  try {
    const log=`import {appendFileSync,existsSync} from 'node:fs';\nconst log=(event,root)=>appendFileSync(${JSON.stringify(events)},JSON.stringify({event,root})+'\\n');\n`;
    const freshness=log+`export async function ensureFreshIndex(root) {
      log('start',root);
      while(!existsSync(root+'/.release')) await new Promise(done=>setTimeout(done,10));
      if(root.endsWith('/root-15')) {log('reject',root);throw new Error('fixture refresh failed');}
      log('resolve',root);return {checked:true};
    }`;
    const db=log+`export function closeDB(root) {log('close',root);}`;
    // Delay only indexing in the child; exercise real IPC, admission and eviction.
    await writeFile(loader,`export async function load(url,context,next) {
      if(url===${JSON.stringify(pathToFileURL(resolve('build/core/index-freshness.js')).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(freshness)}};
      if(url===${JSON.stringify(pathToFileURL(resolve('build/core/db.js')).href)})return {format:'module',shortCircuit:true,source:${JSON.stringify(db)}};
      return next(url,context);
    }`);
    const preload='data:text/javascript,'+encodeURIComponent(`import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)});`);
    child=spawn(process.execPath,['--import',preload,resolve('build/core/local-daemon.js'),'--serve'],{
      env:{...process.env,CONTEXTPRO_DAEMON_SERVER:'true'},stdio:'ignore',
    });
    await waitFor(async()=>!!await daemonCommand('status').catch(()=>null));
    const roots=Array.from({length:17},(_,index)=>join(temp,`root-${index}`));
    await Promise.all(roots.map(root=>mkdir(root)));
    pending=roots.slice(0,16).map(rootDir=>sharedCompute('freshness',{rootDir}));
    await waitFor(async()=>(await history()).filter(item=>item.event==='start').length===16);
    assert.equal((await daemonCommand('status')).active,16);
    assert.ok(!(await history()).some(item=>item.event==='close'),'no running root may be evicted');
    assert.equal(await sharedCompute('freshness',{rootDir:roots[16]}),undefined,'the seventeenth operation must fall back');
    await Promise.all(roots.slice(0,8).map(root=>writeFile(join(root,'.release'),'')));
    assert.ok((await Promise.all(pending.slice(0,8))).every(result=>result?.value.checked));
    assert.equal((await daemonCommand('status')).active,8);
    await Promise.all(roots.slice(8,16).map(root=>writeFile(join(root,'.release'),'')));
    const rest=await Promise.all(pending.slice(8));
    assert.ok(rest.slice(0,7).every(result=>result?.value.checked));
    assert.equal(rest[7],undefined,'a rejected refresh must also release its slot');
    assert.equal((await daemonCommand('status')).active,0);
    const settled=new Set();
    for(const {event,root} of await history()) {
      if(event==='resolve'||event==='reject')settled.add(root);
      if(event==='close')assert.ok(settled.has(root),`evicted unfinished root ${root}`);
    }
    assert.ok((await history()).some(item=>item.event==='close'),'idle roots still evict');
  } finally {
    if(child) {child.kill('SIGKILL');await new Promise(done=>child.exitCode!==null||child.signalCode!==null?done():child.once('exit',done));}
    await Promise.allSettled(pending);
    if(before.runtime===undefined)delete process.env.CONTEXTPRO_RUNTIME_DIR;else process.env.CONTEXTPRO_RUNTIME_DIR=before.runtime;
    if(before.daemon===undefined)delete process.env.CONTEXTPRO_DAEMON;else process.env.CONTEXTPRO_DAEMON=before.daemon;
    await rm(temp,{recursive:true,force:true});
  }
});
