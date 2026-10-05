import {it} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

it('fresh lean MCP enables specialists and binds actual host checks, handoffs and compiler edits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cp-protocol-team-'));
  await writeFile(join(root,'source.ts'),'export function charge(n: number) { return n; }\n');
  const client=new Client({name:'teamwork-acceptance',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('build/index.js'),'--root',root],
    env:{...process.env,CONTEXTPRO_TOOL_PROFILE:'lean',CONTEXTPRO_REINDEX_NO_EMBED:'true',CONTEXTPRO_EMBED_TRACKER:'off',CONTEXTPRO_TEAM_DIR:join(root,'.contextpro','teams')},stderr:'pipe'});
  transport.stderr.on('data',()=>{});
  const call=async(name,args)=>{
    const r=await client.callTool({name,arguments:{root,...args}});assert.ok(!r.isError,JSON.stringify(r));
    return r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  };
  try{
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['context','discover_tools','exact_references']);
    const experts=['team_status','team_task','memory_record_task','validate_scope','validation_record','compiler_diagnostics','rename_preview','rename_apply','artifact_read'];
    for(let i=0;i<experts.length;i+=6)await call('discover_tools',{enable:experts.slice(i,i+6)});
    const refused=await client.callTool({name:'discover_tools',arguments:{root,call:{name:'rename_apply',arguments:{preview_id:'rename_preview-00000000000000'}}}});
    assert.equal(refused.isError,true);
    const task=JSON.parse(await call('team_task',{action:'create',title:'Rename charge'}));
    await call('team_task',{action:'claim',task_id:task.task.id,owner:'acceptance',files:['source.ts']});
    const scope=JSON.parse(await call('validate_scope',{task:'Verify source',files:['source.ts'],format:'json'}));
    execFileSync(process.execPath,[resolve('node_modules/typescript/bin/tsc'),'--noEmit','--skipLibCheck',join(root,'source.ts')]);
    const receipt=JSON.parse(await call('validation_record',{snapshot_id:scope.snapshot.id,command:'node node_modules/typescript/bin/tsc --noEmit --skipLibCheck source.ts',exit_code:0,runtime:process.version}));
    assert.equal(receipt.applicable,true);
    const memory=JSON.parse(await call('memory_record_task',{task:'Check charge',summary:'TypeScript check passed',source_evidence:[{file:'source.ts'}],validation_refs:[receipt.artifact.id],format:'json'}));
    assert.equal(memory.evidenceState,'current');
    await call('team_task',{action:'handoff',task_id:task.task.id,owner:'acceptance',handoff_id:memory.handoff.id});
    const preview=JSON.parse(await call('rename_preview',{file:'source.ts',line:1,column:17,new_name:'bill'}));
    await call('rename_apply',{preview_id:preview.artifact.id});
    const stale=JSON.parse(await call('artifact_read',{artifact_id:receipt.artifact.id}));
    assert.equal(stale.currentApplicability,'stale');
    const handoff=JSON.parse(await call('artifact_read',{artifact_id:memory.handoff.id}));
    assert.equal(handoff.currentApplicability.sourceEvidence,'stale');
    assert.equal(handoff.currentApplicability.validation[0].state,'stale');
    const completed=JSON.parse(await call('team_task',{action:'complete',task_id:task.task.id,owner:'acceptance'}));
    assert.equal(completed.task.state,'completed');
    const diagnostics=JSON.parse(await call('compiler_diagnostics',{files:['source.ts']}));
    assert.equal(diagnostics.results[0].diagnostics.length,0);
  }finally{await client.close();await transport.close();await rm(root,{recursive:true,force:true});}
});
