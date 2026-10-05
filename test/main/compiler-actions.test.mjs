import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { reindex } from '../../build/tools/reindex.js';
import { closeDB } from '../../build/core/db.js';
import { compilerDiagnostics, previewRename, applyRename } from '../../build/tools/compiler-actions.js';
import { closeTypeScriptReferenceProcess } from '../../build/core/typescript-reference-process.js';
import { closePythonLanguageServers } from '../../build/core/python-language-server.js';
import { exactReferencesTool } from '../../build/tools/exact-references.js';

it('compiler previews preserve aliases and shadowed bindings, reject stale inputs and apply only previewed edits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cp-compiler-'));
  try {
    await writeFile(join(root,'service.ts'),'export function charge(n: number) { return n + 1; }\n');
    await writeFile(join(root,'caller.ts'),'import { charge as alias } from "./service";\nexport const result = alias(2);\nfunction local(charge: number) { return charge; }\n');
    await writeFile(join(root,'broken.ts'),'export const wrong: number = "text";\n');
    await reindex({rootDir:root,noEmbed:true,autoHubs:false});
    const diagnostics=await compilerDiagnostics({rootDir:root,files:['broken.ts']});
    assert.ok(diagnostics.results[0].diagnostics.some(item=>item.code==='2322'));
    const preview=JSON.parse(await previewRename({rootDir:root,file:'service.ts',line:1,column:17,newName:'bill'}));
    assert.equal(preview.files.length,2);
    await writeFile(join(root,'new-caller.ts'),'import { charge } from "./service";\ncharge(3);\n');
    await assert.rejects(applyRename({rootDir:root,previewId:preview.artifact.id}),/stale/);
    await reindex({rootDir:root,noEmbed:true,autoHubs:false});
    const next=JSON.parse(await previewRename({rootDir:root,file:'service.ts',line:1,column:17,newName:'bill'}));
    const applied=await applyRename({rootDir:root,previewId:next.artifact.id});
    assert.equal(applied.updated.length,3);
    const caller=await readFile(join(root,'caller.ts'),'utf8');
    assert.match(caller,/bill as alias/);assert.match(caller,/local\(charge: number\) \{ return charge/);
    assert.match(await readFile(join(root,'new-caller.ts'),'utf8'),/bill\(3\)/);
  }finally{closeTypeScriptReferenceProcess();closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('configured Pyright supplies references, diagnostics and cross-file rename with aliases and shadowing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cp-python-'));
  const previous=process.env.CONTEXTPRO_PYRIGHT_COMMAND;
  process.env.CONTEXTPRO_PYRIGHT_COMMAND=resolve('node_modules/.bin/pyright-langserver');
  try{
    await writeFile(join(root,'service.py'),'def charge(n: int) -> int:\n    return n + 1\n');
    await writeFile(join(root,'caller.py'),'from service import charge as alias\nvalue = alias(2)\ndef local(charge: int):\n    return charge\n');
    await writeFile(join(root,'broken.py'),'wrong: int = "text"\n');
    await writeFile(join(root,'pyrightconfig.json'),'{"typeCheckingMode":"basic"}');
    await reindex({rootDir:root,noEmbed:true,autoHubs:false});
    const diagnostics=await compilerDiagnostics({rootDir:root,files:['broken.py']});
    assert.ok(diagnostics.results[0].diagnostics.some(item=>item.severity==='error'));
    const refs=JSON.parse(await exactReferencesTool({rootDir:root,file:'service.py',line:1,symbolName:'charge',format:'json'}));
    assert.equal(refs.confidence,'LSP_RESOLVED');
    assert.ok(refs.references.some(ref=>ref.file==='caller.py'));
    const preview=JSON.parse(await previewRename({rootDir:root,file:'service.py',line:1,column:5,newName:'bill'}));
    await applyRename({rootDir:root,previewId:preview.artifact.id});
    assert.match(await readFile(join(root,'caller.py'),'utf8'),/from service import bill as alias/);
    assert.match(await readFile(join(root,'caller.py'),'utf8'),/def local\(charge: int\)/);
    const exec=promisify(execFile);
    await exec('python3',['-m','venv','--without-pip',join(root,'.venv')]);
    const site=(await exec(join(root,'.venv','bin','python'),['-c','import sysconfig;print(sysconfig.get_paths()["purelib"])'])).stdout.trim();
    await mkdir(join(site,'fixturelib'),{recursive:true});
    await writeFile(join(site,'fixturelib','__init__.py'),'value: int = 1\n');
    await writeFile(join(site,'fixturelib','py.typed'),'');
    await writeFile(join(root,'pyrightconfig.json'),'{"typeCheckingMode":"basic","venvPath":".","venv":".venv"}');
    await writeFile(join(root,'venv_check.py'),'from fixturelib import value\nwrong: str = value\n');
    const venv=await compilerDiagnostics({rootDir:root,files:['venv_check.py']});
    assert.ok(venv.results[0].diagnostics.some(item=>item.code==='reportAssignmentType'));
    assert.ok(!venv.results[0].diagnostics.some(item=>item.code==='reportMissingImports'));
  }finally{
    closePythonLanguageServers();closeDB(root);
    if(previous===undefined)delete process.env.CONTEXTPRO_PYRIGHT_COMMAND;else process.env.CONTEXTPRO_PYRIGHT_COMMAND=previous;
    await rm(root,{recursive:true,force:true});
  }
});

it('JavaScript compiler rename preserves aliases, strings and same-named local parameters',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cp-js-rename-'));
  try{
    await writeFile(join(root,'service.js'),'export const charge = (n) => n + 1;\n');
    await writeFile(join(root,'caller.js'),'import { charge as alias } from "./service.js";\nexport const result = alias(2);\nexport function local(charge) { return charge + "charge"; }\n');
    await reindex({rootDir:root,noEmbed:true,autoHubs:false});
    const preview=JSON.parse(await previewRename({rootDir:root,file:'service.js',line:1,column:14,newName:'bill'}));
    assert.equal(preview.files.length,2);await applyRename({rootDir:root,previewId:preview.artifact.id});
    const caller=await readFile(join(root,'caller.js'),'utf8');
    assert.match(caller,/bill as alias/);assert.match(caller,/local\(charge\) \{ return charge \+ "charge"/);
  }finally{closeTypeScriptReferenceProcess();closeDB(root);await rm(root,{recursive:true,force:true});}
});

it('Pyright restarts after an installation version or dependency manifest changes', {skip:process.platform==='win32'}, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'cp-python-version-')), root = join(temp,'repo'), installation = join(temp,'pyright');
  const previous = process.env.CONTEXTPRO_PYRIGHT_COMMAND, log = join(temp,'starts.log');
  try {
    await mkdir(root); await mkdir(installation);
    await symlink(resolve('node_modules/pyright/dist'),join(installation,'dist'));
    const manifest = join(installation,'package.json');
    await writeFile(manifest,JSON.stringify({name:'pyright',version:'1.1.414'}));
    const executable = join(installation,'launch.cjs');
    await writeFile(executable,`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},'start\\n');\nrequire(${JSON.stringify(resolve('node_modules/pyright/langserver.index.js'))});\n`);
    await chmod(executable,0o755); process.env.CONTEXTPRO_PYRIGHT_COMMAND = executable;
    await writeFile(join(root,'broken.py'),'wrong: int = "text"\n');
    const check = async () => assert.ok((await compilerDiagnostics({rootDir:root,files:['broken.py']})).results[0].diagnostics.some(item=>item.severity==='error'));
    const starts = async () => (await readFile(log,'utf8')).trim().split('\n').length;
    await check(); await check(); assert.equal(await starts(),1);
    await writeFile(manifest,JSON.stringify({name:'pyright',version:'1.1.415'}));
    await check(); assert.equal(await starts(),2);
    await writeFile(join(root,'requirements.txt'),'fixture-package==1.0\n');
    await check(); assert.equal(await starts(),3);
  } finally {
    closePythonLanguageServers(); closeDB(root);
    if(previous===undefined) delete process.env.CONTEXTPRO_PYRIGHT_COMMAND; else process.env.CONTEXTPRO_PYRIGHT_COMMAND=previous;
    await rm(temp,{recursive:true,force:true});
  }
});
