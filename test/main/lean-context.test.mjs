import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContext} from '../../build/tools/context.js';
import {explain} from '../../build/tools/explain.js';
import {reindex} from '../../build/tools/reindex.js';
import {closeDB,getDB} from '../../build/core/db.js';
import {unifiedSearchData} from '../../build/tools/search.js';

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

it('retains decisive interior predicates in oversized functions across files with verbatim bounded ranges', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-interior-'));
 try {
  const source = `import { auditUpload } from './audit';\nexport async function router(request) {\n${'  unrelatedWork();\n'.repeat(160)}  // Reserve outstanding upload intents against the shot limit.\n  const reserved = intents.filter(i => !i.completedAt).length;\n  if (used + reserved >= event.shotLimit) throw new Error('Shot limit reached');\n${'  unrelatedWork();\n'.repeat(160)}  // Finalization must reject a guest removed by erasure.\n  if (!db.guests.some(g => g.id === intent.guestId)) return null;\n${'  unrelatedWork();\n'.repeat(100)}}\n`;
  await writeFile(join(root,'router.ts'),source);
  await writeFile(join(root,'audit.ts'), 'export function auditUpload() { return "upload audit"; }\n');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  const text=await getContext({rootDir:root,query:'guest upload shot limit reservation finalization erasure',maxTokens:1200});
  assert.match(text,/used \+ reserved >= event.shotLimit/);
  assert.match(text,/!db.guests.some/);
  assert.ok(Buffer.byteLength(text)<=4800);
  assert.match(text,/Omitted: router.ts: partial/);
  for (const match of text.matchAll(/router\.ts:(\d+)-(\d+)\n([^]*?)(?=\n\n|$)/g)) {
   assert.equal(match[3],source.split('\n').slice(Number(match[1])-1,Number(match[2])).join('\n'));
  }
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('initializes discovery above the quick-refresh cap and catches a later large change', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-cold-discovery-'));
 try {
  for(let i=0;i<35;i++) await writeFile(join(root,`item-${i}.ts`),`export function item${i}() { return ${i}; }\n`);
  const first=await getContext({rootDir:root,query:'item34',maxTokens:512});
  assert.equal((await getDB(root)).getAllFiles().length,35);
  assert.match(first,/function item34/);
  assert.doesNotMatch(first,/remain stale|Discovery index: (empty|stale|refreshed)/);
  for(let i=0;i<35;i++) await writeFile(join(root,`item-${i}.ts`),`export function updated${i}() { return ${i+100}; }\n`);
  const next=await getContext({rootDir:root,query:'updated34',maxTokens:512});
  assert.match(next,/function updated34/);
  assert.equal((await getDB(root)).searchSymbolsByName('item34').length,0);
  assert.doesNotMatch(next,/remain stale|Discovery index: (empty|stale|refreshed)/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('prioritizes a named definition over short calls and documentation in a prose query', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-named-definition-'));
 try {
  const definition=`export function reusableAnswers(records) {\n${'  validate(records);\n'.repeat(30)}  return records.filter(record => record.approved && record.current);\n}\n`;
  await writeFile(join(root,'pipeline.ts'),`${'// processing implementation pipeline\n'.repeat(80)}${definition}${Array.from({length:25},(_,i)=>`export function preflight${i}() { return reusableAnswers([]); }`).join('\n')}`);
  for(let i=0;i<6;i++) await writeFile(join(root,`guide-${i}.md`),'# Find implementation of reusableAnswers in pipeline.ts\nReusable answers implementation publication validation pipeline.\n');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  const text=await getContext({rootDir:root,query:'Find implementation of reusableAnswers in pipeline.ts',maxTokens:512});
  assert.ok(text.includes(definition.trimEnd()),text);
  assert.ok(Buffer.byteLength(text)<=2048);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('recognizes quoted lowercase and dollar-prefixed names without confusing calls with definitions', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-literal-definition-'));
 try {
  await writeFile(join(root,'api.ts'),'export function parse() { return "parser-body"; }\nexport const $resolve = () => "resolver-body";\n');
  for(const query of ['Find implementation of parse', 'Where is `parse` defined?', '$resolve']) {
   const text=await getContext({rootDir:root,query,maxTokens:512});
   assert.match(text,query === '$resolve' ? /resolver-body/ : /parser-body/);
   assert.ok(Buffer.byteLength(text)<=2048);
  }
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('discovers literal UI text beyond summaries and retains the matching source window', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-literal-ui-'));
 try {
  const filler=Array.from({length:180},(_,i)=>`  const validation${i} = "unrelated setup";`).join('\n');
  await writeFile(join(root,'ui.tsx'),`export function Screen() {\n${filler}\n  return <button>Bericht erneut prüfen</button>;\n}\n`);
  await writeFile(join(root,'noise.ts'),'export const bericht = "Bericht";\nexport const erneut = "erneut";\n');
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  for(const query of ['Bericht erneut prüfen','"Bericht erneut prüfen"']) {
   const text=await getContext({rootDir:root,query,maxTokens:512});
   assert.match(text,/<button>Bericht erneut prüfen<\/button>/);
   assert.ok(Buffer.byteLength(text)<=2048);
  }
  const ranked=await unifiedSearchData({rootDir:root,query:'Bericht erneut prüfen',mode:'file',preset:'keyword_only',topK:1});
  assert.equal(ranked.files.results[0].path,'ui.tsx');
  await writeFile(join(root,'ui.tsx'),`export function Screen() {\n${filler}\n  return <button>Eintrag auswählen</button>;\n}\n`);
  const updated=await getContext({rootDir:root,query:'Eintrag auswählen',maxTokens:512});
  assert.match(updated,/<button>Eintrag auswählen<\/button>/);
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('retains Unicode lexical queries, including text with no ASCII letters', async () => {
 const root=await mkdtemp(join(tmpdir(),'contextpro-unicode-'));
 try {
  const db=await getDB(root);
  for(const [i,label] of ['重新分析','選','ausführen','café','تجربة'].entries()) {
   const file=`label${i}.ts`;
   await writeFile(join(root,file),`export const label${i} = "${label}";\n`);
  }
  await reindex({rootDir:root,noEmbed:true,autoHubs:false});
  for(const [i,label] of ['重新分析','選','ausführen','café','تجربة'].entries()) {
   assert.ok(db.searchFileText(label).some(row=>row.path===`label${i}.ts`),label);
   assert.match(await getContext({rootDir:root,query:label,maxTokens:512}),new RegExp(label));
  }
 }finally{closeDB(root);await rm(root,{recursive:true,force:true});}
});
