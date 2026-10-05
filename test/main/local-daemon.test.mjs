import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonCommand, sharedCompute } from '../../build/core/local-daemon.js';
import { getDB, closeDB } from '../../build/core/db.js';

it('shared service isolates roots, refreshes edits, and falls back after a crash', {skip:process.platform === 'win32'}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cp-service-'));
  const before = { runtime:process.env.CONTEXTPRO_RUNTIME_DIR, daemon:process.env.CONTEXTPRO_DAEMON };
  process.env.CONTEXTPRO_RUNTIME_DIR = join(temp,'ipc');
  process.env.CONTEXTPRO_DAEMON = 'true';
  let pid;
  try {
    const roots = [join(temp,'one'),join(temp,'two')];
    for (const [index,root] of roots.entries()) { await mkdir(root); await writeFile(join(root,'entry.ts'),`export const value${index} = "é";\n`); }
    const status = await daemonCommand('start'); pid = status.pid;
    const results = await Promise.all(roots.map(rootDir => sharedCompute('freshness',{rootDir})));
    assert.ok(results.every(result => result?.value.checked));
    assert.equal((await getDB(roots[0])).searchSymbolsByName('value1').length,0);
    assert.equal((await getDB(roots[1])).searchSymbolsByName('value0').length,0);
    await writeFile(join(roots[0],'entry.ts'),'export const edited = 3;\n');
    assert.equal((await sharedCompute('freshness',{rootDir:roots[0]})).value.refreshed,true);
    assert.ok((await getDB(roots[0])).searchSymbolsByName('edited').length);
    process.kill(pid,'SIGKILL');
    await new Promise(done=>setTimeout(done,100));
    assert.equal(await sharedCompute('freshness',{rootDir:roots[0]}),undefined);
    const restarted = await daemonCommand('start'); pid = restarted.pid;
    assert.notEqual(restarted.pid,status.pid);
    for(const root of roots) closeDB(root);
  } finally {
    try { await daemonCommand('stop'); } catch { if(pid) try { process.kill(pid,'SIGTERM'); } catch {} }
    if(before.runtime===undefined) delete process.env.CONTEXTPRO_RUNTIME_DIR; else process.env.CONTEXTPRO_RUNTIME_DIR=before.runtime;
    if(before.daemon===undefined) delete process.env.CONTEXTPRO_DAEMON; else process.env.CONTEXTPRO_DAEMON=before.daemon;
    await rm(temp,{recursive:true,force:true});
  }
});
