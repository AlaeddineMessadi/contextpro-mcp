import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teamStatus, teamTask } from '../../build/core/team-ledger.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);

it('atomically claims tasks and file leases, enforces dependencies, and recovers expired ownership', async () => {
  const root = await mkdtemp(join(tmpdir(),'cp-team-'));
  const previous = process.env.CONTEXTPRO_TEAM_DIR;
  process.env.CONTEXTPRO_TEAM_DIR = join(root,'ledger');
  try {
    const create = (id, dependencies=[]) => teamTask({rootDir:root,action:'create',taskId:id,title:id,dependencies},1000);
    await create('base'); await create('dependent',['base']); await create('parallel');
    const claim = (taskId, owner, files=['src.ts'], now=1001) => teamTask({rootDir:root,action:'claim',taskId,owner,files},now);
    await assert.rejects(claim('dependent','b'), /incomplete/);
    const claims = await Promise.allSettled([claim('base','a'),claim('base','b')]);
    assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);
    const owner = claims.find(result=>result.status==='fulfilled').value.task.owner;
    await assert.rejects(claim('parallel','c'), /conflict/);
    await assert.rejects(teamTask({rootDir:root,action:'update',taskId:'base',owner,dependencies:['dependent']},1002),/cycle/);
    await teamTask({rootDir:root,action:'complete',taskId:'base',owner},1003);
    assert.equal((await teamStatus(root,1004)).tasks.find(task=>task.id==='dependent').ready,true);
    await claim('dependent','b');
    await assert.rejects(teamTask({rootDir:root,action:'renew',taskId:'dependent',owner:'b'},400000),/expired/);
    assert.equal((await claim('dependent','c',['other.ts'],400000)).task.owner,'c');
    assert.ok((await teamStatus(root,400001)).events.length >= 6);
    await assert.rejects(claim('parallel','d',['../escape']), /outside|escape|traversal/i);
  } finally {
    if(previous===undefined) delete process.env.CONTEXTPRO_TEAM_DIR; else process.env.CONTEXTPRO_TEAM_DIR=previous;
    await rm(root,{recursive:true,force:true});
  }
});

it('arbitrates independent processes and warns on overlapping work in linked worktrees',async()=>{
  const temp=await mkdtemp(join(tmpdir(),'cp-team-process-')), root=join(temp,'main'), worktree=join(temp,'branch');
  const previous=process.env.CONTEXTPRO_TEAM_DIR;
  process.env.CONTEXTPRO_TEAM_DIR=join(temp,'ledger');
  try {
    await mkdir(root);
    await exec('git',['init','-q'],{cwd:root});
    await exec('git',['-c','user.name=Test','-c','user.email=test@localhost','commit','--allow-empty','-qm','fixture'],{cwd:root});
    await exec('git',['worktree','add','--detach',worktree],{cwd:root});
    await teamTask({rootDir:root,action:'create',taskId:'one',title:'one'});
    await teamTask({rootDir:worktree,action:'create',taskId:'two',title:'two'});
    const module=new URL('../../build/core/team-ledger.js',import.meta.url).href;
    const claims=await Promise.allSettled(['a','b','c'].map(owner=>exec(process.execPath,['--input-type=module','-e',
      `const {teamTask}=await import(${JSON.stringify(module)});await teamTask(${JSON.stringify({rootDir:root,action:'claim',taskId:'one',owner,files:['source.ts']})});`])));
    assert.equal(claims.filter(item=>item.status==='fulfilled').length,1);
    const cross=await teamTask({rootDir:worktree,action:'claim',taskId:'two',owner:'other',files:['source.ts']});
    assert.equal(cross.warnings.length,1);
    assert.equal((await teamStatus(root)).tasks.length,2);
    await mkdir(join(worktree,'directory'));
    await assert.rejects(teamTask({rootDir:worktree,action:'renew',taskId:'two',owner:'other',files:['directory']}),/directories/);
  } finally {
    if(previous===undefined)delete process.env.CONTEXTPRO_TEAM_DIR;else process.env.CONTEXTPRO_TEAM_DIR=previous;
    await rm(temp,{recursive:true,force:true});
  }
});
