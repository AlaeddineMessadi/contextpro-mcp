import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {walkDirectory} from '../../build/core/walker.js';
import {getContext} from '../../build/tools/context.js';
import {reindex} from '../../build/tools/reindex.js';
import {closeDB} from '../../build/core/db.js';

const marker='# graft — repo map\n\nSmall markdown nodes summarising this repo.\n';

it('excludes recognized Graft caches, including scoped walks, while preserving authored graft modules',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-graft-walk-'));
 try {
  await mkdir(join(root,'graft','src'),{recursive:true});
  await mkdir(join(root,'packages','graft'),{recursive:true});
  await writeFile(join(root,'graft','src','route.md'),'# stale route summary');
  await writeFile(join(root,'packages','graft','index.ts'),'export const graft = "authored";');
  await writeFile(join(root,'packages','graft','INDEX.md'),'# Authored Graft library\n');
  await writeFile(join(root,'graft','INDEX.md'),marker);
  const entries=await walkDirectory({rootDir:root});
  assert.ok(entries.some(entry=>entry.relativePath==='packages/graft/index.ts'));
  assert.ok(entries.every(entry=>!entry.relativePath.startsWith('graft/')));
  for(const targetPath of ['graft','graft/src','graft/src/route.md']) {
   assert.deepEqual(await walkDirectory({rootDir:root,targetPath}),[],targetPath);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

it('keeps generated document summaries out of both selectors while retaining current API contract evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-graft-discovery-'));
 try {
  await mkdir(join(root,'graft','apps','api'),{recursive:true});
  await mkdir(join(root,'docs','engineering'),{recursive:true});
  await writeFile(join(root,'graft','apps','api','route.md'),'# documentation API contract PATCH media mission reassignment\nset_media_mission_atomic error envelopes obsolete generated summary\n');
  await writeFile(join(root,'route.ts'),'export function set_media_mission_atomic() { return "current mission handler"; }\n');
  await writeFile(join(root,'docs','engineering','06-api-contracts.md'),'# API contracts\n## PATCH media mission reassignment\nset_media_mission_atomic returns structured error envelopes.\n');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  await writeFile(join(root,'graft','INDEX.md'),marker);
  for(const connected of [false,true]) {
   const text=await getContext({rootDir:root,query:'documentation API contract for PATCH media mission reassignment set_media_mission_atomic error envelopes',maxTokens:3000,connected});
   assert.match(text,/06-api-contracts\.md/);
   assert.doesNotMatch(text,/graft\/|obsolete generated summary/);
   assert.ok(Buffer.byteLength(text)<=12000);
  }
  const exact=await getContext({rootDir:root,targets:[{file:'graft/apps/api/route.md',start:1,end:2}],maxTokens:512});
  assert.match(exact,/obsolete generated summary/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});
