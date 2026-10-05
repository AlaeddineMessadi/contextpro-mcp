import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { daemonCommand, sharedCompute } from '../../build/core/local-daemon.js';
import { getDB, closeDB } from '../../build/core/db.js';

it('shared service isolates roots, refreshes edits, and falls back after a crash', {skip:process.platform === 'win32'}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cp-service-'));
  const before = { runtime:process.env.CONTEXTPRO_RUNTIME_DIR, daemon:process.env.CONTEXTPRO_DAEMON, pyright:process.env.CONTEXTPRO_PYRIGHT_COMMAND };
  process.env.CONTEXTPRO_RUNTIME_DIR = join(temp,'ipc');
  process.env.CONTEXTPRO_DAEMON = 'true';
  process.env.CONTEXTPRO_PYRIGHT_COMMAND = resolve('node_modules/.bin/pyright-langserver');
  let pid;
  try {
    const roots = [join(temp,'one'),join(temp,'two')];
    for (const [index,root] of roots.entries()) { await mkdir(root); await writeFile(join(root,'entry.ts'),`export const value${index} = "é";\n`); }
    const starters = await Promise.all(Array.from({length:4},()=>daemonCommand('start')));
    assert.equal(new Set(starters.map(item=>item.pid)).size,1);
    const status = starters[0]; pid = status.pid;
    const results = await Promise.all(roots.map(rootDir => sharedCompute('freshness',{rootDir})));
    assert.ok(results.every(result => result?.value.checked));
    assert.equal((await getDB(roots[0])).searchSymbolsByName('value1').length,0);
    assert.equal((await getDB(roots[1])).searchSymbolsByName('value0').length,0);
    await writeFile(join(roots[0],'entry.ts'),'export const edited = 3;\n');
    assert.equal((await sharedCompute('freshness',{rootDir:roots[0]})).value.refreshed,true);
    assert.ok((await getDB(roots[0])).searchSymbolsByName('edited').length);
    await writeFile(join(roots[0],'check.py'),'value: int = "wrong"\n');
    const python=await sharedCompute('python',{rootDir:roots[0],files:[join(roots[0],'check.py')],operation:'diagnostics'});
    assert.equal(python?.value.engine,'pyright');
    assert.ok(python.value.diagnostics.some(item=>item.severity==='error'));
    // A simultaneous burst must reject excess work instead of admitting it
    // while asynchronous root canonicalization is still in progress.
    const burst=Array.from({length:40},()=>sharedCompute('python',{rootDir:roots[0],files:[join(roots[0],'check.py')],operation:'diagnostics'}));
    const samples=await Promise.all(Array.from({length:8},()=>daemonCommand('status')));
    assert.ok(samples.every(sample=>sample.active<=16),JSON.stringify(samples.map(sample=>sample.active)));
    const settled=await Promise.all(burst);
    assert.ok(settled.some(value=>value===undefined),'excess service work falls back locally');
    process.kill(pid,'SIGKILL');
    await new Promise(done=>setTimeout(done,100));
    assert.equal(await sharedCompute('freshness',{rootDir:roots[0]}),undefined);
    const restarts = await Promise.all(Array.from({length:4},()=>daemonCommand('start')));
    assert.equal(new Set(restarts.map(item=>item.pid)).size,1);
    const restarted = restarts[0]; pid = restarted.pid;
    assert.notEqual(restarted.pid,status.pid);
    for(const root of roots) closeDB(root);
  } finally {
    try { await daemonCommand('stop'); } catch { if(pid) try { process.kill(pid,'SIGTERM'); } catch {} }
    if(before.runtime===undefined) delete process.env.CONTEXTPRO_RUNTIME_DIR; else process.env.CONTEXTPRO_RUNTIME_DIR=before.runtime;
    if(before.daemon===undefined) delete process.env.CONTEXTPRO_DAEMON; else process.env.CONTEXTPRO_DAEMON=before.daemon;
    if(before.pyright===undefined) delete process.env.CONTEXTPRO_PYRIGHT_COMMAND; else process.env.CONTEXTPRO_PYRIGHT_COMMAND=before.pyright;
    await rm(temp,{recursive:true,force:true});
  }
});
