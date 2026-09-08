import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContext} from '../../build/tools/context.js';
import {explain} from '../../build/tools/explain.js';
import {reindex} from '../../build/tools/reindex.js';
import {closeDB} from '../../build/core/db.js';

it('batches direct sources without an index; deduplicates overlap and preserves exact source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-direct-'));
 try {
  const source='export function first() { return "one"; }\nexport function second() { return "two"; }\n';
  await writeFile(join(root,'api.ts'),source);
  const text=await getContext({rootDir:root,targets:[{file:'api.ts',symbol:'first'},{file:'api.ts',start:1,end:2},{file:'api.ts',symbol:'second'}]});
  assert.equal(text.split('return "one"').length,2);
  assert.equal(text.split('return "two"').length,2);
  assert.ok(text.includes(source.trimEnd()));
  await assert.rejects(access(join(root,'.contextpro')));
  const minimal=await explain({rootDir:root,file:'api.ts',symbol:'first',format:'source'});
  assert.equal(minimal,'api.ts:1-1\n'+source.split('\n')[0]);
  assert.doesNotMatch(minimal,/Siblings|Usage|Signature|Related tests/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('enforces budget and omissions; blocks traversal, symlink escape and ambiguous symbols',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-budget-'));
 const outside=await mkdtemp(join(tmpdir(),'contextpro-external-'));
 try {
  await writeFile(join(root,'large.ts'),`export function huge() { return '${'payload'.repeat(1000)}'; }`);
  const text=await getContext({rootDir:root,targets:[{file:'large.ts',symbol:'huge'}],maxTokens:512});
  assert.match(text,/Omitted/); assert.doesNotMatch(text,/payloadpayload/); assert.ok(Buffer.byteLength(text)<=2048);
  await writeFile(join(outside,'secret.ts'),'secret');
  await symlink(join(outside,'secret.ts'),join(root,'escape.ts'));
  await assert.rejects(getContext({rootDir:root,targets:[{file:'../outside.ts'}]}));
  await assert.rejects(getContext({rootDir:root,targets:[{file:'escape.ts'}]}));
  for(const targets of [[{file:'large.ts',start:3,end:2}],[{file:'large.ts',start:0}],[{file:'large.ts',symbol:'huge',start:1}]]) await assert.rejects(getContext({rootDir:root,targets}));
  await writeFile(join(root,'ambiguous.ts'),'class A { same() {} }\nclass B { same() {} }');
  assert.match(await getContext({rootDir:root,targets:[{file:'ambiguous.ts',symbol:'same'}]}),/ambiguous/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

it('combines identifier discovery with current source and import evidence',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-evidence-'));
 try {
  await writeFile(join(root,'guard.ts'),'export function guard() { return true; }');
  await writeFile(join(root,'write.ts'),'import {guard} from "./guard.js";\nexport function publish() { return guard(); }');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  await writeFile(join(root,'guard.ts'),'export function guard() { return false; }');
  const text=await getContext({rootDir:root,query:'publish',maxTokens:512});
  assert.match(text,/return guard\(\)/);assert.match(text,/return false/);assert.doesNotMatch(text,/return true/);
  assert.ok(Buffer.byteLength(text)<=2048);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('returns bounded forwarding helpers with the entry point, but ignores parameter shadowing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-forward-'));
 try {
  await writeFile(join(root,'api.ts'),`export function publish() { return locked(); }
function locked() { return "implementation"; }
export function indirect(locked: () => string) { return locked(); }
`);
  const text=await getContext({rootDir:root,targets:[{file:'api.ts',symbol:'publish'}],maxTokens:512});
  assert.match(text,/return locked/);assert.match(text,/return "implementation"/);
  assert.match(text,/possible same-file helpers/);assert.ok(Buffer.byteLength(text)<=2048);
  const shadow=await getContext({rootDir:root,targets:[{file:'api.ts',symbol:'indirect'}]});
  assert.doesNotMatch(shadow,/implementation/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('keeps a relevant whole declaration when a large discovered file exceeds the budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-selection-'));
 try {
  await writeFile(join(root,'api.ts'),`const unrelated = '${'noise'.repeat(3000)}';\nexport function authenticateUser() { return "verified"; }\n`);
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  const text=await getContext({rootDir:root,query:'authenticateUser',maxTokens:512});
  assert.match(text,/export function authenticateUser\(\) \{ return "verified"; \}/);
  assert.match(text,/Omitted: api.ts: partial/);assert.doesNotMatch(text,/noisenoise/);
  assert.ok(Buffer.byteLength(text)<=2048);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});
