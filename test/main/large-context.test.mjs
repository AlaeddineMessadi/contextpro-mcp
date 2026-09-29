import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getContext} from '../../build/tools/context.js';

it('reads and merges bounded ranges beyond 2 MB without indexing or parsing the bundle',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-large-ranges-'));
 try {
  const prefix='// unrelated bundle setup '.padEnd(64,'x')+'\n';
  const lines=Array(42000).fill(prefix.slice(0,-1));
  lines[41739]='  const description = "Résumé 🐈";\r';
  lines[41740]='  return description;\r';
  lines[41741]='  // selected trailing context\r';
  const source=lines.join('\n')+'\n';
  assert.ok(Buffer.byteLength(source)>2_000_000);
  await writeFile(join(root,'worker.mjs'),source);
  const text=await getContext({rootDir:root,targets:[
   {file:'worker.mjs',start:41740,end:41741},
   {file:'./worker.mjs',start:41741,end:41742},
   {file:'worker.mjs',start:41999,end:42005},
  ],maxTokens:512});
  assert.ok(text.includes('worker.mjs:41740-41742\n'+lines.slice(41739,41742).join('\n')),text);
  assert.match(text,/worker\.mjs:41999-42001/);
  assert.doesNotMatch(text,/exceeds 2 MB|over budget/);
  assert.ok(Buffer.byteLength(text)<=2048);
  await assert.rejects(access(join(root,'.contextpro')));
  const whole=await getContext({rootDir:root,targets:[{file:'worker.mjs'}],maxTokens:512});
  assert.match(whole,/exceeds 2 MB read limit/);
  const symbol=await getContext({rootDir:root,targets:[{file:'worker.mjs',symbol:'description'}],maxTokens:512});
  assert.match(symbol,/exceeds 2 MB read limit/);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('skips huge preceding lines, omits oversized selections and still returns later small targets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-large-lines-'));
 try {
  await writeFile(join(root,'bundle.js'),'x'.repeat(2_100_000)+'\nconst actual = "current source";\n');
  const text=await getContext({rootDir:root,targets:[
   {file:'bundle.js',start:1,end:1},
   {file:'bundle.js',start:2,end:2},
   {file:'bundle.js',start:8,end:9},
  ],maxTokens:512});
  assert.match(text,/bundle\.js:2-2\nconst actual = "current source";/);
  assert.match(text,/bundle\.js:1-1: over budget/);
  assert.match(text,/bundle\.js:8: beyond end of file/);
  assert.doesNotMatch(text,/xxxxxxxx/);
  assert.ok(Buffer.byteLength(text)<=2048);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('retains split UTF-8 and CRLF bytes and rejects binary large-file prefixes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-large-utf8-'));
 try {
  const lead='const result = "';
  const source='x'.repeat(65536-2-Buffer.byteLength(lead)-1)+'\n'+lead+'🐈é";\r\n'+'y'.repeat(2_100_000);
  await writeFile(join(root,'bundle.js'),source);
  const text=await getContext({rootDir:root,targets:[{file:'bundle.js',start:2,end:2}],maxTokens:512});
  assert.ok(text.includes('bundle.js:2-2\nconst result = "🐈é";\r'),text);
  await writeFile(join(root,'binary.js'),'\0\nconst result = "hidden";\n'+'x'.repeat(2_100_000));
  const binary=await getContext({rootDir:root,targets:[{file:'binary.js',start:2,end:2}],maxTokens:512});
  assert.match(binary,/binary file/);
  assert.doesNotMatch(binary,/hidden/);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('reports the scan cap explicitly and preserves already completed ranges',async()=>{
 const root=await mkdtemp(join(tmpdir(),'contextpro-large-scan-'));
 try {
  const handle=await open(join(root,'bundle.js'),'w');
  try {
   await handle.writeFile('const early = true;\n');
   const filler=Buffer.alloc(1024*1024,120);
   for(let i=0;i<64;i++) await handle.writeFile(filler);
   await handle.writeFile('\nconst late = true;\n');
  }finally{await handle.close();}
  const text=await getContext({rootDir:root,targets:[
   {file:'bundle.js',start:1,end:1},{file:'bundle.js',start:3,end:3},
  ],maxTokens:512});
  assert.match(text,/const early = true;/);
  assert.match(text,/exceeds 64 MiB range scan limit/);
  assert.doesNotMatch(text,/const late|xxxxxxxx/);
  assert.ok(Buffer.byteLength(text)<=2048);
 }finally{await rm(root,{recursive:true,force:true});}
});
