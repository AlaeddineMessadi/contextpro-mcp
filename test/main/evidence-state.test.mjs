import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindEvidence, memoryEvidenceStatus, createValidationSnapshot, recordValidation, validationState, evidenceConfigurationFiles } from '../../build/core/evidence-state.js';
import { getDB, closeDB } from '../../build/core/db.js';
import { getProjectMemoryHits } from '../../build/tools/retrieval-helpers.js';
import { recordTaskMemory } from '../../build/tools/agentic-context.js';

it('invalidates memory and host verification after source changes and retains supersession history', async () => {
  const root = await mkdtemp(join(tmpdir(),'cp-evidence-'));
  try {
    await writeFile(join(root,'source.ts'),'export const auth = true;\n');
    const db = await getDB(root), state = await bindEvidence(root,[{file:'source.ts'}]);
    const id = db.upsertMemoryNode({type:'note',label:'auth',content:'auth requires token',metadata:{source_evidence:JSON.stringify(state),scope:'project',project_id:''}});
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(id)),'current');
    const snapshot = await createValidationSnapshot(root);
    const result = await recordValidation({rootDir:root,snapshotId:snapshot.id,command:'node --test',exitCode:0,runtime:process.version});
    assert.equal(result.applicable,true);
    assert.equal(await validationState(root,result.artifact.id),'host-reported passed');
    await writeFile(join(root,'source.ts'),'export const auth = false;\n');
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(id)),'stale');
    assert.deepEqual(await getProjectMemoryHits(root,'auth',5,true),[]);
    assert.equal(await validationState(root,result.artifact.id),'stale');
    const stale = await recordValidation({rootDir:root,snapshotId:snapshot.id,command:'node --test',exitCode:0,runtime:process.version});
    assert.equal(stale.applicable,false);
    const successor = db.upsertMemoryNode({type:'note',label:'auth-new',content:'revised auth'});
    db.upsertMemoryEdge({source:id,target:successor,relation:'resolved_by',metadata:{relation_kind:'supersedes'}});
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(id)),'superseded');
    assert.equal(db.getMemoryNode(id).content,'auth requires token');
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(successor)),'unverified');
    await assert.rejects(bindEvidence(root,[{file:'source.ts',hash:'0'.repeat(64)}]), /mismatch/);
    await assert.rejects(bindEvidence(root,[{file:'source.ts',start:1,end:100}]), /exceeds source/);
  } finally { closeDB(root); await rm(root,{recursive:true,force:true}); }
});

it('task records preserve repeated history and invalidate when configuration is introduced', async () => {
  const root=await mkdtemp(join(tmpdir(),'cp-memory-history-'));
  try {
    await writeFile(join(root,'source.py'),'flag = True\n');
    const record=async summary=>JSON.parse(await recordTaskMemory({rootDir:root,task:'flag',summary,files:['source.py'],format:'json'}));
    const first=await record('first'), second=await record('second'), db=await getDB(root);
    assert.notEqual(first.taskMemoryId,second.taskMemoryId);
    assert.match(db.getMemoryNode(first.taskMemoryId).content,/first/);
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(first.taskMemoryId)),'current');
    await writeFile(join(root,'pyrightconfig.json'),'{}');
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(first.taskMemoryId)),'stale');
    for(const file of ['poetry.lock','Pipfile.lock','setup.cfg','environment.yml'])await writeFile(join(root,file),'fixture');
    assert.deepEqual(await evidenceConfigurationFiles(root),['Pipfile.lock','environment.yml','poetry.lock','pyrightconfig.json','setup.cfg']);
    const deletion=JSON.parse(await recordTaskMemory({rootDir:root,task:'delete old source',summary:'Deleted obsolete file',files:['deleted.py'],format:'json'}));
    assert.equal(deletion.evidenceState,'unverified');
    await assert.rejects(recordTaskMemory({rootDir:root,task:'explicit missing',summary:'Unproved',sourceEvidence:[{file:'deleted.py'}]}),/ENOENT/);
  } finally {closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('memory does not recommend a validation conclusion after other checked source changes', async () => {
  const root = await mkdtemp(join(tmpdir(),'cp-memory-validation-'));
  try {
    await writeFile(join(root,'source.ts'),'export const auth = true;\n');
    await writeFile(join(root,'check.ts'),'export const check = true;\n');
    const db = await getDB(root), state = await bindEvidence(root,[{file:'source.ts'}]);
    const snapshot = await createValidationSnapshot(root);
    const receipt = await recordValidation({rootDir:root,snapshotId:snapshot.id,command:'tsc',exitCode:0,runtime:process.version});
    const id = db.upsertMemoryNode({type:'note',label:'auth check',content:'auth validation passed',metadata:{
      source_evidence:JSON.stringify(state),validation_refs:JSON.stringify([receipt.artifact.id]),scope:'project',project_id:''}});
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(id)),'current');
    await writeFile(join(root,'check.ts'),'export const check = false;\n');
    assert.equal(await memoryEvidenceStatus(root,db.getMemoryNode(id)),'stale');
    assert.deepEqual(await getProjectMemoryHits(root,'auth',5,true),[]);
  } finally {closeDB(root);await rm(root,{recursive:true,force:true});}
});
