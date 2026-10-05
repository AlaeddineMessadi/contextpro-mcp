import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindEvidence, memoryEvidenceStatus, createValidationSnapshot, recordValidation, validationState, evidenceConfigurationFiles } from '../../build/core/evidence-state.js';
import { getDB, closeDB } from '../../build/core/db.js';
import { getProjectMemoryHits } from '../../build/tools/retrieval-helpers.js';
import { recordTaskMemory } from '../../build/tools/agentic-context.js';
import { readArtifact } from '../../build/core/artifacts.js';
import { walkDirectory } from '../../build/core/walker.js';

it('validation and memory include authored dot-configs while respecting ignore and symlink exclusions', async () => {
  const root=await mkdtemp(join(tmpdir(),'cp-hidden-evidence-'));
  try {
    await writeFile(join(root,'source.ts'),'export const value = 1;\n');
    await writeFile(join(root,'.gitignore'),'.env\n');
    await writeFile(join(root,'.contextproignore'),'.private/\n');
    await writeFile(join(root,'.eslintrc.json'),'{}');
    await mkdir(join(root,'nested'));
    await writeFile(join(root,'nested','.gitignore'),'.excludedrc\n');
    await writeFile(join(root,'nested','.excludedrc'),'ignored');
    await writeFile(join(root,'nested','.babelrc'),'{}');
    await mkdir(join(root,'.config'));
    await writeFile(join(root,'.config','checker.json'),'{}');
    for (const directory of ['.private','.git','.contextpro','node_modules','dist']) {
      await mkdir(join(root,directory));
      await writeFile(join(root,directory,'.testrc'),'ignored');
    }
    await writeFile(join(root,'.env'),'ignored secret');
    await symlink(join(root,'.eslintrc.json'),join(root,'.linkedrc'));
    const snapshot=await createValidationSnapshot(root);
    const artifact=await readArtifact(root,snapshot.id);
    const paths=artifact.payload.state.files.map(item=>item.file);
    for(const file of ['.eslintrc.json','nested/.babelrc','.config/checker.json'])assert.ok(paths.includes(file),file);
    assert.ok(!paths.some(file=>/^(?:\.env|\.linkedrc|\.private\/|\.git\/|\.contextpro\/|node_modules\/|dist\/)|\.excludedrc$/.test(file)));
    assert.ok(!(await walkDirectory({rootDir:root})).some(entry=>entry.relativePath==='.eslintrc.json'),'discovery keeps its original hidden-file policy');
    const configs=await evidenceConfigurationFiles(root);
    for(const file of ['.eslintrc.json','nested/.babelrc','.config/checker.json'])assert.ok(configs.includes(file),file);
    const record=async()=>recordValidation({rootDir:root,snapshotId:(await createValidationSnapshot(root)).id,command:'eslint .',exitCode:0,runtime:process.version});
    const initial=await record();
    await writeFile(join(root,'.env'),'changed ignored secret');
    assert.equal(await validationState(root,initial.artifact.id),'host-reported passed');
    const memory=JSON.parse(await recordTaskMemory({rootDir:root,task:'lint',summary:'Checked source',files:['source.ts'],format:'json'}));
    await writeFile(join(root,'.eslintrc.json'),'{"rules":{"semi":"error"}}');
    assert.equal(await validationState(root,initial.artifact.id),'stale');
    assert.equal((await recordValidation({rootDir:root,snapshotId:snapshot.id,command:'eslint .',exitCode:0,runtime:process.version})).applicable,false);
    assert.equal(await memoryEvidenceStatus(root,(await getDB(root)).getMemoryNode(memory.taskMemoryId)),'stale');
    const beforeAdd=await record();
    await writeFile(join(root,'.prettierrc'),'{}');
    assert.equal(await validationState(root,beforeAdd.artifact.id),'stale');
    const beforeDelete=await record();
    await rm(join(root,'nested','.babelrc'));
    assert.equal(await validationState(root,beforeDelete.artifact.id),'stale');
  } finally {closeDB(root);await rm(root,{recursive:true,force:true});}
});

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
