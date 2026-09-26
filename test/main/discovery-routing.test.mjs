import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getContext } from '../../build/tools/context.js';
import { reindex } from '../../build/tools/reindex.js';
import { unifiedSearchData } from '../../build/tools/search.js';
import { getStatusData } from '../../build/tools/status.js';
import { closeDB, getDB } from '../../build/core/db.js';

async function fixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-discovery-routing-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), source);
    }
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    await run(root);
  } finally { closeDB(root); await rm(root, { recursive: true, force: true }); }
}

it('keeps locale copies and test variables from crowding out implementation evidence', async () => {
  const terms = 'subscription Pro feature limits pricing paywall home progress insights';
  await fixture({
    ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`locales/language-${i}.json`, JSON.stringify({ title: terms, copy: `${terms} ${terms}` })])),
    ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`tests/entitlement${i}.test.ts`, `const pro = true;\nexport const fixture = "${terms}";\n`])),
    'src/entitlements.ts': 'export function entitled(subscription: boolean, feature: string) {\n  const limits = subscription ? 100 : 3;\n  return { feature, limits };\n}\n',
    'src/paywall.ts': 'export function paywall(pricing: number) { return { pricing, subscription: true }; }\n',
  }, async root => {
    const result = await unifiedSearchData({rootDir:root,query:terms,mode:'file',preset:'keyword_only',topK:2,inlineCode:'off'});
    assert.ok(result.files.results.some(item => item.path === 'src/entitlements.ts'), JSON.stringify(result.files));
    const text = await getContext({rootDir:root,query:terms,maxTokens:1000});
    assert.match(text, /subscription \? 100 : 3/);
    const locales = await unifiedSearchData({rootDir:root,query:`translations copy ${terms}`,mode:'file',preset:'keyword_only',topK:2});
    assert.ok(locales.files.results.some(item => item.path.startsWith('locales/')));
    const tests = await unifiedSearchData({rootDir:root,query:'tests pro fixture entitlement',mode:'file',preset:'keyword_only',topK:2});
    assert.ok(tests.files.results.some(item => item.path.startsWith('tests/')));
  });
});

it('preserves quoted command evidence within prose instead of generic schema boilerplate', async () => {
  await fixture({
    ...Object.fromEntries(Array.from({length:14},(_,i)=>[`src/noise-${i}.ts`, 'export const schema = z.object({ document: z.object({content: z.string(), apply: z.boolean()}) });\n'])),
    'src/application.ts': '// unrelated preamble\n'.repeat(250) + 'export const applyCommand = z.object({\n  action: z.literal("document.content.apply"),\n  documentId: z.string(),\n});\n',
    'tests/apply.test.ts': 'export const input = { action: "document.content.apply" };\n',
  }, async root => {
    const query = '"document.content.apply" schema z.object';
    const results = await unifiedSearchData({rootDir:root,query,mode:'file',preset:'keyword_only',topK:1});
    assert.equal(results.files.results[0].path,'src/application.ts');
    const text = await getContext({rootDir:root,query,maxTokens:512});
    assert.match(text, /action: z.literal\("document.content.apply"\)/);
    assert.ok(Buffer.byteLength(text) <= 2048);
    const db = await getDB(root);
    assert.deepEqual(db.searchFileText('document.never.present',10,true), []);
  });
});

it('keeps camelCase usage evidence ahead of prose lookalikes and same-name test helpers', async () => {
  const query = 'native gallery personal photos listOwnMedia revealed own roll photo privacy';
  await fixture({
    'apps/native/gallery.tsx': 'export function Gallery() {\n  const photos = api.listOwnMedia();\n  return { photos, privacy: "personal", revealed: true, roll: "own" };\n}\n',
    'packages/api/client.ts': 'export function listOwnMedia() { return request("media"); }\n',
    'apps/native/tests/queue.test.ts': 'export function listOwnMedia() { return []; }\n// native gallery personal photos revealed own roll photo privacy\n',
    'design/prototype.html': '<p>native gallery personal photos list own media revealed own roll photo privacy</p>\n',
  }, async root => {
    const results = await unifiedSearchData({ rootDir: root, query, mode: 'file', preset: 'keyword_only', topK: 4 });
    assert.equal(results.files.results[0].path, 'apps/native/gallery.tsx', JSON.stringify(results.files));
    const text = await getContext({ rootDir: root, query, maxTokens: 512 });
    assert.match(text, /apps\/native\/gallery.tsx:/);
    assert.match(text, /api.listOwnMedia\(\)/);
    const testSource = text.search(/apps\/native\/tests\/queue.test.ts:\d/);
    assert.ok(testSource < 0 || text.indexOf('apps/native/gallery.tsx:') < testSource, text);
    assert.ok(Buffer.byteLength(text) <= 2048);
    const tests = await unifiedSearchData({ rootDir: root, query: 'tests listOwnMedia', mode: 'file', preset: 'keyword_only', topK: 1 });
    assert.equal(tests.files.results[0].path, 'apps/native/tests/queue.test.ts');
  });
});

it('includes SQL mutation source in compound-key discovery and refreshes it after edits', async () => {
  await fixture({
    'src/application.ts': 'export const action = "document.text.repair";\n',
    ...Object.fromEntries(Array.from({length:8},(_,i)=>[`apps/client-${i}.ts`, 'export const action = "document.text.repair";\n'])),
    'migrations/repair.sql': '-- Schema\n'.repeat(60) + 'create table document_text_repairs (id uuid);\ninsert into document_text_repairs(id) values (gen_random_uuid());\n',
    'tests/repair.test.ts': 'export const input = "document.text.repair document_text_repairs";\n',
  }, async root => {
    const query = 'document.text.repair document_text_repairs';
    const text = await getContext({rootDir:root,query,maxTokens:1200});
    assert.match(text, /src\/application.ts:/);
    assert.match(text, /migrations\/repair.sql:/);
    assert.match(text, /insert into document_text_repairs/);
    const db = await getDB(root);
    assert.equal(db.getFile('migrations/repair.sql').language, 'sql');
    assert.deepEqual(db.getSymbolsByFile(db.getFile('migrations/repair.sql').id), []);
    await writeFile(join(root, 'migrations/repair.sql'), 'select * from archived_document_repairs;\n');
    await getContext({rootDir:root,query:'document_text_repairs',maxTokens:512});
    assert.ok(!db.searchFileText('document_text_repairs',10,true).some(item => item.path === 'migrations/repair.sql'));
  });
});

it('orients lexical-only repositories using the entry point, central modules, and their dependencies', async () => {
  await fixture({
    'package.json': '{"scripts":{"build":"tsc","test":"node --test"}}',
    'README.md': '# Example\nDocumentation for this repository.\n',
    'src/index.ts': 'import { client } from "./client.js";\nimport { app } from "./app.js";\nimport { queue } from "./queue.js";\napp(client, queue);\n',
    'src/app.ts': 'import { client } from "./client.js";\nimport { lifecycle } from "./lifecycle.js";\nimport { prompt } from "./prompts.js";\nimport { queue } from "./queue.js";\nexport const app = () => client();\n',
    'src/queue.ts': 'export const queue = () => "pending jobs";\n',
    'src/client.ts': 'import { lifecycle } from "./lifecycle.js";\nexport const client = () => lifecycle();\n',
    'src/lifecycle.ts': 'export const lifecycle = () => "running";\n',
    'src/prompts.ts': 'export const prompt = "Orient repository package scripts MCP tool implementation SDK integration tests documentation";\n',
    ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/tools/tool${i}.ts`, 'import { client } from "../client.js";\nexport const run = () => client();\n'])),
    'tests/client.test.ts': 'import { client } from "../src/client.js";\nclient();\n',
  }, async root => {
    for (const query of [
      'Orient repository: package scripts, MCP tool implementation, SDK integration, tests and documentation',
      'Repository overview purpose README package.json architecture MCP tools server tests CI documentation roadmap',
      'Repository overview: read package.json and explain the architecture and tests',
    ]) {
      const text = await getContext({ rootDir: root, query, maxTokens: 2000 });
      for (const path of ['package.json', 'README.md', 'src/index.ts', 'src/client.ts', 'src/lifecycle.ts', 'src/app.ts', 'src/queue.ts', 'tests/client.test.ts']) assert.ok(text.includes(`${path}:`), text);
      assert.ok(Buffer.byteLength(text) <= 8000);
      assert.match(text, /lexical fallback/);
    }
    const exact = await getContext({ rootDir: root, query: 'Repository overview', targets: [{file:'package.json'}], maxTokens:512 });
    assert.match(exact, /package.json:/);
    assert.doesNotMatch(exact, /README.md:|src\/index.ts:/);
    await writeFile(join(root, '.gitignore'), 'README.md\n');
    const ignored = await getContext({ rootDir: root, query: 'Repository overview', maxTokens: 2000 });
    assert.doesNotMatch(ignored, /README.md:/);
  });
});

it('reads explicitly named files before unrelated matches and preserves their full contents when they fit', async () => {
  const files = Object.fromEntries(['src/client.ts', 'src/tools/events.ts', 'tests/client.test.ts'].map((path, i) => [path,
    `export function implementation${i}() {\n${Array.from({length:70}, (_, j) => `  const step${j} = ${j};`).join('\n')}\n  return "end-${i}";\n}\n`]));
  await fixture({ ...files, 'src/noise.ts': 'export const keywords = "request retries event stream";\n' }, async root => {
    const text = await getContext({ rootDir: root, query: 'Read src/client.ts and src/tools/events.ts plus tests/client.test.ts relevant request retries event stream', maxTokens: 4000 });
    for (const source of Object.values(files)) assert.ok(text.includes(source.trimEnd()), text);
    assert.doesNotMatch(text, /src\/noise.ts:/);
    assert.ok(text.indexOf('src/client.ts:') < text.indexOf('tests/client.test.ts:'));
    assert.ok(Buffer.byteLength(text) <= 16000);
    const narrow = await getContext({ rootDir: root, query: 'Read src/client.ts and src/tools/events.ts plus tests/client.test.ts relevant request retries event stream', maxTokens: 512 });
    assert.ok(Buffer.byteLength(narrow) <= 2048);
    assert.match(narrow, /[Oo]mitted/);
  });
});

it('keeps release lookup focused on source but allows explicit lockfile inspection', async () => {
  await fixture({
    'package.json': '{"version":"1.11.0","name":"server"}',
    'src/index.ts': 'export const server = {version: "1.11.0"};\n',
    'package-lock.json': JSON.stringify({ version: '1.11.0', packages: Object.fromEntries(Array.from({length:100}, (_, i) => [`node_modules/server-release-${i}`, {version:'1.11.0'}])) }, null, 2),
  }, async root => {
    const text = await getContext({ rootDir: root, query: 'version 1.11.0 server package release', maxTokens: 3500 });
    assert.match(text, /package.json:/);
    assert.match(text, /src\/index.ts:/);
    assert.doesNotMatch(text, /package-lock.json:/);
    const locks = await getContext({ rootDir: root, targets: [{file:'package-lock.json', start:1, end:5}], maxTokens:512 });
    assert.match(locks, /package-lock.json:1-5/);
    const ranked = await unifiedSearchData({ rootDir: root, query: 'package-lock.json version 1.11.0', mode:'file', preset:'keyword_only', topK:3 });
    assert.ok(ranked.files.results.some(file => file.path === 'package-lock.json'));
  });
});

it('retains lockfile matches when they are the only evidence', async () => {
  await fixture({'package-lock.json': '{"name":"unique-release-marker"}'}, async root => {
    const text = await getContext({rootDir:root, query:'unique-release-marker', maxTokens:512});
    assert.match(text, /package-lock.json:/);
    assert.match(text, /unique-release-marker/);
  });
});

it('describes empty vectors truthfully after automatic structural discovery and exposes runtime identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-status-vectors-'));
  try {
    await writeFile(join(root, 'api.ts'), 'export const ready = true;\n');
    await getContext({ rootDir:root, query:'ready', maxTokens:512 });
    const status = await getStatusData({ rootDir:root });
    assert.equal(status.index.state, 'fresh');
    assert.equal(status.embeddings.fileSearch, 0);
    assert.match(status.warnings.join('\n'), /Search does not generate corpus embeddings/);
    assert.doesNotMatch(status.warnings.join('\n'), /populate lazily/);
    assert.equal(status.runtime.pid, process.pid);
    assert.ok(status.runtime.serverVersion);
    assert.ok(status.runtime.buildStamp);
  } finally { closeDB(root); await rm(root, {recursive:true, force:true}); }
});

it('discovers project status and readiness documents outside the structural index', async () => {
  await fixture({
    'package.json': '{"name":"sample"}',
    'README.md': '# Sample\nProject overview.\n',
    'docs/AGENT_BRIEF.md': '# Shared agent brief\n## Project status\nThe next step is browser validation.\n',
    'docs/LAUNCH_READINESS.md': '# Launch readiness\n## Current launch status\nExternal signoff is still pending.\n',
    'docs/protocol.md': '# Wire protocol\nUnrelated message format.\n',
    'src/prompt.ts': 'export const prompt = "Project status README roadmap next steps blockers package.json architecture tests recent handoff launch readiness QA reports product scope";\n',
  }, async root => {
    const status = await getContext({rootDir:root, query:'Project status README roadmap next steps blockers package.json architecture tests recent handoff', maxTokens:1500});
    assert.match(status, /docs\/AGENT_BRIEF.md:/);
    assert.match(status, /next step is browser validation/);
    assert.match(status, /README.md:/);
    const readiness = await getContext({rootDir:root, query:'Find project instructions and current launch readiness, blockers, QA reports, roadmap and product scope', maxTokens:1500});
    assert.match(readiness, /docs\/LAUNCH_READINESS.md:/);
    assert.match(readiness, /External signoff is still pending/);
    assert.ok(readiness.indexOf('docs/LAUNCH_READINESS.md:') < readiness.indexOf('src/prompt.ts:'));
    assert.ok(Buffer.byteLength(readiness) <= 6000);
    const named = await getContext({rootDir:root, query:'Read docs/protocol.md', maxTokens:512});
    assert.match(named, /Unrelated message format/);
    assert.doesNotMatch(named, /src\/prompt.ts:/);
    await writeFile(join(root, 'docs/.gitignore'), 'LAUNCH_READINESS.md\n');
    await writeFile(join(root, '.contextproignore'), 'docs/AGENT_BRIEF.md\n');
    await symlink(join(root,'README.md'), join(root,'docs/READINESS.md'));
    const ignored = await getContext({rootDir:root, query:'Project status readiness roadmap handoff', maxTokens:1500});
    assert.doesNotMatch(ignored, /docs\/(?:AGENT_BRIEF|LAUNCH_READINESS|READINESS).md:/);
  });
});
