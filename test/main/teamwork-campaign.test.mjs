import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

it('freezes the original public tasks plus Python and counterbalances all 24 attempts after a mixed-language smoke subset',async()=>{
  const output=await mkdtemp(join(tmpdir(),'cp-campaign-'));
  try{
    await writeFile(join(output,'repos.json'),'{}');
    const original=JSON.parse(await readFile('scripts/fixtures/coding-pilot.json','utf8'));
    const added=JSON.parse(await readFile('scripts/fixtures/development-teamwork.json','utf8'));
    assert.deepEqual(added.tasks.slice(0,original.tasks.length),original.tasks);
    assert.equal(added.tasks.filter(task=>task.validator==='python').length,2);
    const {stdout}=await promisify(execFile)(process.execPath,['scripts/benchmark-coding-pilot.mjs'],{env:{...process.env,
      CONTEXTPRO_PILOT_OUTPUT:output,CONTEXTPRO_PILOT_MANIFEST:resolve('scripts/fixtures/development-teamwork.json'),
      CONTEXTPRO_PILOT_VARIANTS:'native,baseline,candidate',CONTEXTPRO_PILOT_REPEATS:'2',CONTEXTPRO_PILOT_TASK:''}});
    const {plan}=JSON.parse(stdout);assert.equal(plan.length,24);
    for(const task of added.tasks){
      const rounds=[0,1].map(repeat=>plan.filter(r=>r.repeat===repeat&&r.taskId===task.id).map(r=>r.variant));
      assert.deepEqual(rounds[0],rounds[1].reverse());assert.equal(rounds[0].length,3);
    }
    const smoke=plan.slice(0,12);assert.equal(new Set(smoke.map(r=>r.taskId)).size,4);
    assert.equal(new Set(smoke.filter(r=>r.taskId.startsWith('python-')).map(r=>r.taskId)).size,2);
  }finally{await rm(output,{recursive:true,force:true});}
});
