import {it} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getContext} from '../../build/tools/context.js';
import {reindex} from '../../build/tools/reindex.js';
import {scopedSourceCandidates} from '../../build/tools/scoped-discovery.js';
import {closeDB,getDB} from '../../build/core/db.js';

async function fixture(files,run) {
  const root=await mkdtemp(join(tmpdir(),'contextpro-scoped-discovery-'));
  try {
    for(const [path,source] of Object.entries(files)) {
      await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),source);
    }
    await reindex({rootDir:root,noEmbed:true,autoHubs:false});await run(root);
  } finally {closeDB(root);await rm(root,{recursive:true,force:true});}
}

it('retains named component usages in each requested route instead of popular unrelated files',async()=>{
  const files={
    'src/components/WidgetButton.tsx':'export function WidgetButton(props) { return <button {...props}/>; }\n',
    ...Object.fromEntries(['rules','identity'].map(name=>[`src/guest/${name}/page.tsx`,
      'import {WidgetButton} from "../../components/WidgetButton";\n'+'// unrelated preamble\n'.repeat(60)+
      `export function Page() { return <a aria-label="Back from ${name}"><WidgetButton tone="ghost"/></a>; }\n`])),
    ...Object.fromEntries(Array.from({length:12},(_,i)=>[`design/demo${i}.tsx`,
      `export const Demo${i} = () => <WidgetButton aria-label="guest rules identity pages props icon button semantics"/>;\n`.repeat(10)])),
  };
  await fixture(files,async root=>{
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'WidgetButton usage in guest rules and identity pages; props aria-label and surrounding icon button semantics',maxTokens:1500,connected});
      for(const route of ['rules','identity']) assert.match(text,new RegExp(`Back from ${route}`),text);
      assert.ok(Buffer.byteLength(text)<=6000);
    }
  });
});

it('retains a topic-matched SQL check for a compound error shared across RPCs',async()=>{
  await fixture({
    'src/actions.ts':'export function submitReportAction() { return invoke("publish_report"); }\n',
    'migrations/007_publish_report.sql':'-- unrelated migration preamble\n'.repeat(60)+
      "create function publish_report() returns void as $$\nbegin\n  if record.state not in ('revealed', 'archived') then\n    raise exception 'record_state_invalid';\n  end if;\nend;\n$$ language plpgsql;\n",
    ...Object.fromEntries(Array.from({length:12},(_,i)=>[`src/handlers/error${i}.ts`,
      `export const error${i} = "record_state_invalid RPC publish_report report state locked revealed";\n`.repeat(6)])),
  },async root=>{
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'submitReportAction implementation record_state_invalid RPC publish_report report state locked revealed',maxTokens:1500,connected});
      assert.match(text,/if record.state not in/);assert.match(text,/raise exception 'record_state_invalid'/);
      assert.ok(Buffer.byteLength(text)<=6000);
    }
  });
});

it('uses a verified directory hint to retain the requested platform implementation',async()=>{
  await fixture({
    'apps/mobile/app/host/[id]/reports/index.tsx':'// unrelated preamble\n'.repeat(60)+
      'export function Reports() { return <Button label="Publish reports" onPress={() => publish.mutate()} disabled={publish.isPending}/>; }\n',
    ...Object.fromEntries(Array.from({length:12},(_,i)=>[`apps/web/host/reports${i}.tsx`,
      `export const Report${i} = () => <button>Publish reports reveal control button state locked revealed re-notify guests</button>;\n`.repeat(10)])),
  },async root=>{
    for(const connected of [false,true]) {
      const text=await getContext({rootDir:root,query:'apps/mobile/app/host reports publish reports reveal control button state locked revealed re-notify guests',maxTokens:1500,connected});
      assert.match(text,/apps\/mobile\/app\/host\/\[id\]\/reports\/index.tsx:/);
      assert.match(text,/onPress=\{\(\) => publish.mutate\(\)\}/);
      assert.ok(Buffer.byteLength(text)<=6000);
    }
  });
});


it('bounds hint candidates and rejects missing or excluded directories and unknown names',async()=>{
  await fixture(Object.fromEntries(Array.from({length:20},(_,i)=>[
    `apps/mobile/app/host/area${i}/reports.ts`,
    `export function report${i}() { return submitReport(); }\n`,
  ])),async root=>{
    const db=await getDB(root);
    assert.equal(scopedSourceCandidates(db,'apps/mobile/app/host reports',[]).length,8);
    for(const query of ['missing/path reports','../apps/mobile/app/host reports','apps/mobile/app/host/../ reports','outside apps/mobile/app/host reports','exclude apps/mobile/app/host reports','not in apps/mobile/app/host reports']) {
      assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
    }
    assert.deepEqual(scopedSourceCandidates(db,'MissingWidget usage in reports',['MissingWidget']),[]);
    assert.deepEqual(scopedSourceCandidates(db,'Find reports',['Find']),[]);
    const semantic=await getContext({rootDir:root,query:'apps/mobile/app/host reports submitReport',maxTokens:512,connected:true,retrievalPreset:'semantic_only'});
    assert.doesNotMatch(semantic,/Source evidence[^]*apps\/mobile\/app\/host/);
    assert.doesNotMatch(semantic,/Scoped candidates/);
  });
});

it('keeps scope hints worktree-local and exact target reads stateless',async()=>{
  await fixture({'apps/mobile/reports.ts':'export const reports = "first-root";\n'},async first=>{
    await fixture({'apps/web/reports.ts':'export const reports = "second-root";\n'},async second=>{
      assert.equal(scopedSourceCandidates(await getDB(first),'apps/mobile reports',[]).length,1);
      assert.deepEqual(scopedSourceCandidates(await getDB(second),'apps/mobile reports',[]),[]);
      const exact=await getContext({rootDir:first,targets:[{file:'apps/mobile/reports.ts'}],maxTokens:512});
      assert.match(exact,/first-root/);assert.doesNotMatch(exact,/Scoped candidates|source_context-/);
    });
  });
});

for (const exclusion of ['outside of', 'except for', 'exclude files under']) {
  it(`does not promote directory hints after "${exclusion}"`,async()=>{
    await fixture({'apps/mobile/app/host/reports.ts':'export const reports = "mobile";\n'},async root=>{
      const db=await getDB(root);
      for(const quote of ['', '`', '"', "'"]) {
        const query=`show reports ${exclusion} ${quote}apps/mobile/app/host${quote}`;
        assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
      }
    });
  });
}

it('keeps exclusions local to their path and preserves a separate positive scope',async()=>{
  await fixture({
    'apps/mobile/app/host/reports.ts':'export const reports = "mobile";\n',
    'apps/web/app/host/reports.ts':'export const reports = "web";\n',
  },async root=>{
    const db=await getDB(root);
    for(const query of [
      'show reports outside of apps/mobile/app/host, in apps/web/app/host',
      'show reports in apps/web/app/host, except for apps/mobile/app/host',
      'show reports; EXCLUDE all files under `apps/mobile/app/host`; include apps/web/app/host',
      'show reports not in the directory apps/mobile/app/host but in apps/web/app/host',
      'show reports outside\n of\t apps/mobile/app/host and inside apps/web/app/host',
    ]) {
      assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['apps/web/app/host/reports.ts'],query);
    }
    assert.equal(scopedSourceCandidates(db,'show reports in apps/mobile/app/host',[]).length,1);
  });
});

it('recognizes exclusion clauses with arbitrary intervening modifiers',async()=>{
  await fixture({'apps/mobile/app/host/reports.ts':'export const reports = "mobile";\n'},async root=>{
    const db=await getDB(root);
    for(const phrase of [
      'exclude everything under',
      'exclude automatically generated legacy implementations under',
      'exclude anything that includes generated reports within',
      'ignore experimental report handlers beneath',
      'except for old platform-specific report handlers from',
    ]) {
      for(const quote of ['', '`', '"']) {
        const query=`show reports; ${phrase} ${quote}apps/mobile/app/host${quote}`;
        assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
      }
    }
  });
});

it('carries an exclusion across a path list until a new positive clause',async()=>{
  await fixture({
    'apps/mobile/reports.ts':'export const reports = "mobile";\n',
    'apps/legacy/reports.ts':'export const reports = "legacy";\n',
    'apps/web/reports.ts':'export const reports = "web";\n',
  },async root=>{
    const db=await getDB(root);
    for(const query of [
      'show reports; exclude everything under apps/mobile and apps/legacy; include apps/web',
      'show reports except apps/mobile, apps/legacy but include apps/web',
      'show reports outside of apps/mobile and apps/legacy, then inspect apps/web',
      'show reports; ignore generated files in apps/mobile. Find reports in apps/web',
    ]) {
      assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['apps/web/reports.ts'],query);
    }
  });
});

it('does not read directory names as exclusion or clause instructions',async()=>{
  await fixture({
    'apps/outside/reports.ts':'export const reports = "outside";\n',
    'apps/but/reports.ts':'export const reports = "but";\n',
    'apps/web/reports.ts':'export const reports = "web";\n',
  },async root=>{
    const db=await getDB(root);
    assert.deepEqual(scopedSourceCandidates(db,'show reports in apps/outside and apps/web',[]).map(item=>item.file).sort(),
      ['apps/outside/reports.ts','apps/web/reports.ts']);
    assert.deepEqual(scopedSourceCandidates(db,'show reports; exclude everything in apps/but and apps/outside; include apps/web',[]).map(item=>item.file),
      ['apps/web/reports.ts']);
  });
});

it('excludes a negative child scope even when its parent is a positive scope',async()=>{
  await fixture({
    'apps/web/reports.ts':'export const reports = "current";\n',
    'apps/web/legacy/reports.ts':'export const reports = "legacy";\n',
    'apps/web/legacy/nested/reports.ts':'export const reports = "nested";\n',
    'apps/web/legacy-new/reports.ts':'export const reports = "new";\n',
  },async root=>{
    const db=await getDB(root);
    for(const query of [
      'show reports in apps/web except apps/web/legacy',
      'show reports in apps/web; exclude everything under apps/web/legacy',
      'show reports; exclude apps/web/legacy; include apps/web',
    ]) {
      assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file).sort(),
        ['apps/web/legacy-new/reports.ts','apps/web/reports.ts'],query);
    }
  });
});

it('does not promote identifier matches from explicitly excluded subtrees',async()=>{
  await fixture({
    'apps/web/reports.ts':'export const reports = buildReport();\n',
    'apps/web/legacy/reports.ts':'export const reports = buildReport();\n',
  },async root=>{
    const db=await getDB(root);
    for(const query of [
      'buildReport usage in reports outside of apps/web/legacy',
      'buildReport usage in apps/web reports except apps/web/legacy',
    ]) {
      assert.deepEqual(scopedSourceCandidates(db,query,['buildReport']).map(item=>item.file),
        ['apps/web/reports.ts'],query);
    }
  });
});

it('distinguishes an outside handler subject from an outside directory phrase',async()=>{
  await fixture({'src/menu/outside-handler.ts':'export function handleClickOutside() {}\n'},async root=>{
    const db=await getDB(root);
    for(const query of [
      'find the click outside handler in src/menu',
      'find pointer outside behavior under src/menu',
      'show click outside handling within src/menu',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['src/menu/outside-handler.ts'],query);
    for(const query of ['find outside handler outside src/menu','find outside handler outside of src/menu']) {
      assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
    }
  });
});

it('keeps behavior described with without inside a positive directory hint',async()=>{
  await fixture({'src/api/routes.ts':'export const routes = "no authentication";\n'},async root=>{
    const db=await getDB(root);
    for(const query of [
      'find routes without authentication in src/api',
      'find routes without automatic retries under src/api',
      'show routes without cache within src/api',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['src/api/routes.ts'],query);
    assert.deepEqual(scopedSourceCandidates(db,'show routes without src/api',[]),[]);
  });
});

it('accepts existing top-level trailing-slash scopes and their exclusions',async()=>{
  await fixture({
    'src/reports.ts':'export const reports = "source";\n',
    'packages/reports.ts':'export const reports = "package";\n',
    'design/reports.ts':'export const reports = "design";\n',
  },async root=>{
    const db=await getDB(root);
    for(const scope of ['src/','packages/']) {
      assert.deepEqual(scopedSourceCandidates(db,`show reports in ${scope}`,[]).map(item=>item.file),[scope+'reports.ts']);
    }
    for(const query of [
      'show reports outside src/ and packages/',
      'show reports without src/ and packages/',
      'show reports in missing/',
      'show reports in ../',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
  });
});

it('binds bare not to a directory while preserving behavioral subjects',async()=>{
  await fixture({
    'apps/web/reports.ts':'export const reports = "current";\n',
    'apps/web/legacy/reports.ts':'export const reports = "legacy";\n',
  },async root=>{
    const db=await getDB(root);
    for(const query of [
      'show reports in apps/web but not apps/web/legacy',
      'show reports in apps/web; not `apps/web/legacy`',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['apps/web/reports.ts'],query);
    assert.equal(scopedSourceCandidates(db,'show reports not cached in apps/web',[]).length,2);
  });
});

it('does not let negative-only path topics crowd out the requested implementation',async()=>{
  await fixture({
    'apps/web/reports.ts':'export const reports = "current";\n',
    'apps/web/legacy/reports.ts':'export const reports = "excluded";\n',
    ...Object.fromEntries(Array.from({length:8},(_,i)=>[
      `apps/web/legacy-new/reports/handler${i}.ts`,`export const handler${i} = "other";\n`,
    ])),
  },async root=>{
    const db=await getDB(root);
    for(const excluded of ['apps/web/legacy','missing/legacy']) {
      const plain=scopedSourceCandidates(db,`show reports in apps/web except ${excluded}`,[]);
      assert.equal(plain[0]?.file,'apps/web/reports.ts');
      assert.ok(plain.every(candidate=>!candidate.terms.includes('legacy')));
    }
    const explicit=scopedSourceCandidates(db,'show legacy reports in apps/web except apps/web/legacy',[]);
    assert.ok(explicit.length>0);
    assert.ok(explicit.every(candidate=>candidate.file.startsWith('apps/web/legacy-new/')));
  });
});

it('does not use identifiers mentioned only in an excluded path as positive hints',async()=>{
  await fixture({
    'apps/web/reports.ts':'export const reports = "current";\n',
    'apps/web/LegacyReports/reports.ts':'export const reports = "excluded";\n',
    'apps/web/helpers/reports.ts':'export const reports = LegacyReports();\n',
  },async root=>{
    const query='show reports in apps/web except apps/web/LegacyReports';
    const candidates=scopedSourceCandidates(await getDB(root),query,['LegacyReports']);
    assert.equal(candidates[0]?.file,'apps/web/reports.ts');
    assert.ok(candidates.every(candidate=>!candidate.terms.includes('legacy')));
  });
});

it('lets an explicit positive location override an earlier outside-of subject',async()=>{
  await fixture({'src/menu/click-handler.ts':'export function handleMenuClick() {}\n'},async root=>{
    const db=await getDB(root);
    for(const query of [
      'find clicks outside of the menu in src/menu',
      'find menu handlers outside of the component under src/menu',
      'find menu handlers outside of the deprecated implementations in src/menu',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]).map(item=>item.file),['src/menu/click-handler.ts'],query);
    for(const query of [
      'find menu handlers outside of src/menu',
      'find menu handlers; exclude everything under src/menu',
      'find menu handlers not in src/menu',
    ]) assert.deepEqual(scopedSourceCandidates(db,query,[]),[],query);
  });
});

it('binds positive locations across arbitrary descriptive words before the path',async()=>{
  await fixture({
    'src/menu/click-handler.ts':'export function handleMenuClick() {}\n',
    'src/menu/legacy/click-handler.ts':'export function handleLegacyMenuClick() {}\n',
  },async root=>{
    const db=await getDB(root);
    for(const location of ['in the directory','in the source tree','under the recently reorganized source area','inside the current menu implementation']) {
      const query=`find clicks outside of the menu ${location} src/menu`;
      assert.equal(scopedSourceCandidates(db,query,[])[0]?.file,'src/menu/click-handler.ts',query);
    }
    assert.deepEqual(scopedSourceCandidates(db,'find clicks outside of the menu in the directory src/menu outside of src/menu/legacy',[]).map(item=>item.file),['src/menu/click-handler.ts']);
    assert.deepEqual(scopedSourceCandidates(db,'find menu handlers; exclude everything in the directory src/menu',[]),[]);
  });
});

it('keeps a positive location after a behavioral except phrase',async()=>{
  await fixture({
    'apps/web/reports.ts':'export function reports() {}\n',
    'apps/web/legacy/reports.ts':'export function legacyReports() {}\n',
  },async root=>{
    const db=await getDB(root);
    for(const phrase of ['except drafts','except for unpublished drafts','except dynamically generated draft reports']) {
      const query=`find all reports ${phrase} in apps/web`;
      assert.equal(scopedSourceCandidates(db,query,[])[0]?.file,'apps/web/reports.ts',query);
    }
    assert.deepEqual(scopedSourceCandidates(db,'find all reports except drafts in apps/web except apps/web/legacy',[]).map(item=>item.file),['apps/web/reports.ts']);
    assert.deepEqual(scopedSourceCandidates(db,'find all reports except apps/web',[]),[]);
    assert.deepEqual(scopedSourceCandidates(db,'find all reports; exclude drafts in apps/web',[]),[]);
  });
});
