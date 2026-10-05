import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { getContext } from '../../build/tools/context.js';
import { retrieveEvidence } from '../../build/tools/evidence-retrieval.js';
import { buildTaskPack } from '../../build/tools/agentic-context.js';
import { getFeatureBrief } from '../../build/tools/feature-brief.js';
import { lookupFeatureBrief } from '../../build/core/feature-brief-cache.js';
import { withProviderUsage } from '../../build/core/provider-usage.js';
import { maybeChatRerankPlanningFiles } from '../../build/tools/planning-helpers.js';
import { reindex } from '../../build/tools/reindex.js';
import { closeDB } from '../../build/core/db.js';
import { readArtifact, persistArtifact } from '../../build/core/artifacts.js';
import { finishSourceContext } from '../../build/core/source-context.js';
import { unifiedSearchData } from '../../build/tools/search.js';
import { Ollama } from 'ollama';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-connected-'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'quota.ts'), 'export function quota(used, reserved, limit) { if (used + reserved >= limit) throw Error("full"); return true; }\n');
  await writeFile(join(root, 'upload.ts'), 'import { quota } from "./quota.js";\nexport function reserveUpload(used, intents, limit) { return quota(used, intents.length, limit); }\n');
  await writeFile(join(root, 'route.ts'), 'import { reserveUpload } from "./upload.js";\nexport function postUpload(request) { return reserveUpload(request.used, request.intents, request.limit); }\n');
  await writeFile(join(root, 'tests/upload.test.ts'), 'import { reserveUpload } from "../upload.js";\ntest("reservation counts pending intents", () => expect(() => reserveUpload(1, [1], 2)).toThrow());\n');
  await writeFile(join(root, 'unrelated.ts'), 'export function paintSky() { return "blue"; }\n');
  await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
  return root;
}
const cleanup = async root => { closeDB(root); await rm(root, { recursive: true, force: true }); };
const id = text => text.match(/Context ID: (source_context-[a-f0-9]{14})/)?.[1];

it('abstains before graph expansion on weak semantic-only neighbors but retains strong paraphrases', async () => {
  const root = await fixture(), originalEmbed = Ollama.prototype.embed;
  const negative = 'How does this code calculate planetary orbital eccentricity?';
  const positive = 'Enforce the permissible capacity.';
  Ollama.prototype.embed = async ({ input }) => ({ embeddings: (Array.isArray(input) ? input : [input]).map(text => text === negative ? [.35, Math.sqrt(1 - .35 ** 2)] : [1, 0]) });
  try {
    await reindex({rootDir:root, noEmbed:false, autoHubs:false});
    for (const preset of ['balanced', 'semantic_only']) {
      const rejected = await retrieveEvidence({rootDir:root, query:negative, preset});
      assert.equal(rejected.candidates.length, 0);
      assert.equal(rejected.tests.length, 0);
      assert.match(rejected.relevanceNotice, /Weak semantic-only/);
      const empty = await getContext({rootDir:root, query:negative, retrievalPreset:preset, connected:true, maxTokens:1200});
      assert.doesNotMatch(empty, /^.+\.ts:\d+-\d+$/m);
      assert.match(empty, /No source fit or matched/);
    }
    const retrieved = await retrieveEvidence({rootDir:root, query:positive, preset:'semantic_only', graphHops:0, includeTests:false});
    const supported = await getContext({rootDir:root, query:positive, retrieved, retrievalPreset:'semantic_only', connected:true, maxTokens:2200});
    assert.match(supported, /used \+ reserved >= limit/);
    assert.ok(Buffer.byteLength(supported) <= 8800);
  } finally { Ollama.prototype.embed = originalEmbed; await cleanup(root); }
});

it('broad visual facets retain a renderer and its local artwork dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-visual-facets-'));
  try {
    await mkdir(join(root, 'components'));
    await mkdir(join(root, 'services'));
    for (let i = 0; i < 12; i++) await writeFile(join(root, `services/exercise${i}.ts`), '// exercise exercise exercise\nexport const count = 1;');
    await writeFile(join(root, 'components/Person.tsx'), 'import { shape } from "./drawing.js";\n// exercise renderer\nexport function Person() { return <svg>{shape}</svg>; }\n');
    await writeFile(join(root, 'components/drawing.ts'), 'export const shape = "M0 0 L10 20";\n');
    await writeFile(join(root, 'components/Entry.tsx'), '// onboarding animation accent\nexport const Entry = () => <div>Welcome</div>;\n');
    await reindex({rootDir:root, noEmbed:true, autoHubs:false});
    const query = 'onboarding animation exercise illustration theme accent';
    const packet = await retrieveEvidence({rootDir:root, query, preset:'keyword_only'});
    assert.ok(packet.candidates.some(item => item.path === 'components/Person.tsx'));
    assert.ok(packet.candidates.some(item => item.path === 'components/drawing.ts'));
    const text = await getContext({rootDir:root, query, connected:true, retrievalPreset:'keyword_only', maxTokens:1200});
    assert.match(text, /function Person/); assert.match(text, /M0 0 L10 20/);
  } finally { await cleanup(root); }
});

it('multiple identifiers contribute only one reciprocal-rank vote per file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-lane-votes-'));
  try {
    await writeFile(join(root, 'many.ts'), Array.from({length:20}, (_, i) => `export function storageOperation${i}() { return ${i}; }`).join('\n'));
    await writeFile(join(root, 'one.ts'), 'export function storageOperation() { return "authoritative"; }');
    await reindex({rootDir:root, noEmbed:true, autoHubs:false});
    const found = await retrieveEvidence({rootDir:root, query:'find storage operations', preset:'keyword_only', graphHops:0, includeTests:false});
    const many = found.candidates.find(item => item.path === 'many.ts');
    assert.ok(many.symbols.length > 1);
    const lanes = many.reason.split('; ').length;
    assert.ok(many.score <= lanes / 61 + Number.EPSILON, JSON.stringify(many));
  } finally { await cleanup(root); }
});

it('keeps connected cleanup implementation and tests for later topics in a long query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-cleanup-topics-'));
  try {
    for (const dir of ['migrations', 'scripts', 'tests']) await mkdir(join(root, dir));
    await writeFile(join(root, 'migrations/0125_media_storage_cleanup.sql'), '-- media storage cleanup candidate safeguards\ncreate function cleanup_candidates() returns void language sql as $$ select 1; $$;');
    await writeFile(join(root, 'scripts/process-media-cleanup.ts'), '// service-only media cleanup operator\nexport function processCleanup(candidate) { if (!candidate.expired) throw Error("not eligible"); return candidate.path; }');
    await writeFile(join(root, 'tests/media_storage_cleanup.test.ts'), 'import {processCleanup} from "../scripts/process-media-cleanup.js";\ntest("storage cleanup safeguards", () => expect(() => processCleanup({expired:false})).toThrow());');
    for (let i = 0; i < 20; i++) await writeFile(join(root, `event-storage-${i}.ts`), 'export const source = "background cover event image";');
    await reindex({rootDir:root, noEmbed:true, autoHubs:false});
    const query = 'Find existing service-only Storage cleanup RPC, operator script, and tests relevant to backgrounds cover files, event image path, and media cleanup migration 0125. Include source for candidate selection and safeguards.';
    const text = await getContext({rootDir:root, query, connected:true, retrievalPreset:'keyword_only', maxTokens:1800});
    for (const evidence of ['cleanup_candidates()', '!candidate.expired', 'toThrow()']) assert.ok(text.includes(evidence), text);
    assert.ok(Buffer.byteLength(text) <= 7200);
  } finally { await cleanup(root); }
});

it('spends a small graph budget on unseen files, not connected seeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-graph-limit-'));
  try {
    await writeFile(join(root, 'a.ts'), 'import { b } from "./b.js";\nimport { finish } from "./z.js";\n// reservation handling\nexport const a = () => finish(b());\n');
    await writeFile(join(root, 'b.ts'), '// reservation handling\nexport const b = () => 1;\n');
    await writeFile(join(root, 'z.ts'), 'import { value } from "./deep.js";\nexport const finish = () => value;\n');
    await writeFile(join(root, 'deep.ts'), 'export const value = 1;\n');
    await reindex({rootDir:root, noEmbed:true, autoHubs:false});
    const options = {rootDir:root, query:'reservation', preset:'keyword_only', includeTests:false};
    const plain = await retrieveEvidence({...options, graphHops:0});
    assert.deepEqual(plain.candidates.map(item => item.path).sort(), ['a.ts', 'b.ts']);
    for (const graphHops of [1, 2]) {
      const connected = await retrieveEvidence({...options, graphHops, graphMaxFiles:1});
      assert.ok(connected.candidates.some(item => item.path === 'z.ts'), JSON.stringify(connected.candidates));
      assert.ok(!connected.candidates.some(item => item.path === 'deep.ts'));
    }
  } finally { await cleanup(root); }
});

it('reserves connected and associated-test slots when many facet owners exceed the candidate cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-facet-cap-'));
  const topics = 'amber birch cedar delta ember fern granite hazel indigo jade kelp lilac maple nectar olive pearl quartz ruby spruce topaz umber violet willow zircon'.split(' ');
  try {
    for (const dir of ['src', 'tests']) await mkdir(join(root, dir));
    for (const [i, topic] of topics.entries()) {
      await writeFile(join(root, `src/owner-${i}.ts`), `import { value } from "./leaf-${i}.js";\nexport const owner = () => value;\n// ${topic}\n`);
      await writeFile(join(root, `src/leaf-${i}.ts`), 'export const value = 1;\n');
      await writeFile(join(root, `tests/owner-${i}.test.ts`), `import { owner } from "../src/owner-${i}.js";\nowner();\n`);
    }
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    for (const graphMaxFiles of [8, 16]) {
      const found = await retrieveEvidence({ rootDir: root, query: topics.join(' '), preset: 'keyword_only', graphMaxFiles });
      assert.equal(found.candidates.length, 32);
      assert.equal(new Set(found.candidates.map(item => item.path)).size, 32);
      assert.equal(found.limited, true);
      assert.equal(found.candidates.filter(item => /^src\/leaf-/.test(item.path)).length, graphMaxFiles, 'graph allocations must survive the global cap');
      assert.equal(found.tests.length, 4);
      for (const test of found.tests) assert.ok(found.candidates.some(item => item.path === test.path), test.path);
    }
  } finally { await cleanup(root); }
});

it('returns bounded connected implementation, predicate, caller and test source', async () => {
  const root = await fixture();
  try {
    const query = 'upload reservation outstanding intents limit checks';
    const found = await retrieveEvidence({ rootDir: root, query, preset: 'keyword_only' });
    assert.ok(found.candidates.length <= 32);
    assert.match(found.relationNotice, /heuristic/);
    const text = await getContext({ rootDir: root, query, connected: true, retrievalPreset: 'keyword_only', maxTokens: 2200 });
    for (const value of ['function reserveUpload', 'used + reserved >= limit', 'function postUpload', 'toThrow']) assert.ok(text.includes(value), text);
    assert.match(text, /heuristic/); assert.ok(Buffer.byteLength(text) <= 8800);
    assert.doesNotMatch(text, /paintSky/);
    process.env.CONTEXTPRO_CONNECTED_CONTEXT = 'true';
    const pack = JSON.parse(await buildTaskPack({ rootDir: root, task: query, preset: 'keyword_only', includeMemory: false, includeRecentDiffs: false, format: 'json', maxTokens: 4000 }));
    assert.ok(pack.source.some(part => part.text.includes('reserveUpload')));
    assert.ok(Buffer.byteLength(JSON.stringify(pack)) <= 16000);
  } finally { delete process.env.CONTEXTPRO_CONNECTED_CONTEXT; await cleanup(root); }
});

it('exact targets stay stateless and provider-free when connected retrieval is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contextpro-exact-fast-'));
  try {
    await writeFile(join(root, 'file.ts'), 'export const value = 1;');
    const result = await withProviderUsage(() => getContext({ rootDir: root, connected: true, targets: [{ file: 'file.ts' }], maxTokens: 512 }));
    assert.match(result.value, /export const value = 1/); assert.deepEqual(result.usage, []);
    await assert.rejects(access(join(root, '.contextpro')));
    await assert.rejects(getContext({ rootDir: root, targets: [{ file: 'file.ts' }], previousContextId: 'source_context-aaaaaaaaaaaaaa' }), /stateless/);
  } finally { await cleanup(root); }
});

it('explicit lexical retrieval is not diagnosed as unavailable semantic vectors', async () => {
  const root = await fixture();
  try {
    const search = await unifiedSearchData({ rootDir: root, query: 'upload reservation', preset: 'keyword_only', mode: 'hybrid', persistArtifact: false });
    assert.match(search.trust.ambiguities.join('\n'), /semantic evidence was not requested/);
    assert.doesNotMatch(search.trust.ambiguities.join('\n'), /embeddings are unavailable/);
    const context = await getContext({ rootDir: root, query: 'upload reservation', connected: true, retrievalPreset: 'keyword_only', maxTokens: 1200 });
    assert.match(context, /requested keyword_only preset/);
    assert.doesNotMatch(context, /lexical fallback|vectors unavailable/);
  } finally { await cleanup(root); }
});

it('connected task caches distinguish graph settings and source budgets', async () => {
  const root = await fixture(), old = process.env.CONTEXTPRO_CONNECTED_CONTEXT;
  process.env.CONTEXTPRO_CONNECTED_CONTEXT = 'true';
  try {
    const options = { rootDir: root, task: 'upload reservation outstanding intents', preset: 'keyword_only', includeMemory: false, includeRecentDiffs: false, format: 'json', maxTokens: 4000 };
    const get = async extra => JSON.parse(await buildTaskPack({ ...options, ...extra }));
    const noGraph = await get({ graphHops: 0 });
    assert.ok(noGraph.files.every(file => !file.reason.includes('graph:')));
    const defaultGraph = await get({});
    assert.ok(defaultGraph.files.some(file => file.reason.includes('graph:')));
    const limited = await get({ graphMaxFiles: 1 });
    const wider = await get({ graphMaxFiles: 8 });
    assert.notEqual(limited.context.id, wider.context.id);
    await get({ maxTokens: 512 });
    const large = await get({ maxTokens: 9000 });
    assert.ok(!large.trust.evidence.includes('served from artifact cache (no recompute)'));
    assert.ok(large.source.length > 0);
  } finally {
    old === undefined ? delete process.env.CONTEXTPRO_CONNECTED_CONTEXT : process.env.CONTEXTPRO_CONNECTED_CONTEXT = old;
    await cleanup(root);
  }
});

it('source deltas detect edits and deletions and recover across incompatible roots and budgets', async () => {
  const root = await fixture(), other = await fixture();
  try {
    const options = { rootDir: root, query: 'reserveUpload', maxTokens: 2000 };
    const first = await getContext(options), firstId = id(first);
    assert.ok(firstId);
    const same = await getContext({ ...options, previousContextId: firstId });
    assert.match(same, /Source ranges unchanged/); assert.ok(same.length < first.length);
    await writeFile(join(root, 'upload.ts'), 'export function reserveUpload() { return "changed-source"; }\n');
    const edited = await getContext({ ...options, previousContextId: firstId });
    assert.match(edited, /Changed:|Added:/); assert.match(edited, /changed-source/);
    const recovered = await getContext({ ...options, rootDir: other, previousContextId: firstId });
    assert.match(recovered, /Baseline missing, incompatible/); assert.doesNotMatch(recovered, /changed-source/);
    assert.match(await getContext({ ...options, maxTokens: 512, previousContextId: firstId }), /incompatible/);
    await rm(join(root, 'upload.ts'));
    const deleted = await getContext({ ...options, previousContextId: id(edited) });
    assert.match(deleted, /Removed: upload.ts/); assert.doesNotMatch(deleted, /changed-source/);
    const snapshot = await readArtifact(root, firstId);
    assert.ok(snapshot.payload.packet.ranges.length); assert.equal(snapshot.payload.complete, true);
    const incomplete = await persistArtifact({ rootDir: root, kind: 'source_context', key: 'incomplete', payload: { ...snapshot.payload, complete: false } });
    assert.match(await getContext({ ...options, previousContextId: incomplete.id }), /incomplete/);
  } finally { await cleanup(root); await cleanup(other); }
});

it('source context IDs reject altered packets and forged completion flags', async () => {
  const root = await fixture();
  try {
    const options = { rootDir: root, query: 'upload', maxTokens: 1200 };
    const packet = { text: 'Original source', ranges: [{ file: 'upload.ts', start: 1, end: 1, text: 'original' }], hashes: { 'upload.ts': 'before' }, notices: [], settings: 'test-v1', complete: true };
    const firstId = id(await finishSourceContext(options, packet));
    const saved = await readArtifact(root, firstId);
    const changed = { ...packet, text: 'Changed source', ranges: [{ ...packet.ranges[0], text: 'changed' }], hashes: { 'upload.ts': 'after' } };
    saved.payload.packet = changed;
    await writeFile(saved.path, JSON.stringify(saved));
    const response = await finishSourceContext({ ...options, previousContextId: firstId }, changed);
    assert.match(response, /Baseline missing, incompatible or incomplete/);
    assert.match(response, /Changed source/); assert.doesNotMatch(response, /Source ranges unchanged/);
    // A full current read repairs a corrupt cache entry with the same content ID.
    await finishSourceContext(options, packet);
    assert.deepEqual((await readArtifact(root, firstId)).payload.packet, packet);
    const incompleteId = id(await finishSourceContext(options, { ...packet, complete: false }));
    const incomplete = await readArtifact(root, incompleteId); incomplete.payload.complete = true;
    await writeFile(incomplete.path, JSON.stringify(incomplete));
    assert.match(await finishSourceContext({ ...options, previousContextId: incompleteId }, packet), /Baseline missing, incompatible or incomplete/);
  } finally { await cleanup(root); }
});

it('feature briefs invalidate on source, dependency membership and retrieval configuration changes', async () => {
  const root = await fixture();
  try {
    const query = 'upload reservation limit';
    const first = await getFeatureBrief({ rootDir: root, query, maxTokens: 1200 });
    assert.match(first, /Extracted evidence/); assert.doesNotMatch(first, /Model interpretations/);
    assert.ok(Buffer.byteLength(first) <= 4800);
    assert.ok(await lookupFeatureBrief(root, query));
    assert.match(await getFeatureBrief({ rootDir: root, query }), /validated cache/);
    const cached = await lookupFeatureBrief(root, query);
    for (const key of ['CONTEXTPRO_ADAPTIVE_CONTEXT', 'CONTEXTPRO_CHAT_RERANK', 'CONTEXTPRO_EMBED_MODEL']) {
      const previous = process.env[key];
      try {
        process.env[key] = key === 'CONTEXTPRO_EMBED_MODEL' ? 'different-test-embedding' : previous === 'true' ? 'false' : 'true';
        assert.equal(await lookupFeatureBrief(root, query), null, `${key} must invalidate prior ranking`);
      } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
      assert.ok(await lookupFeatureBrief(root, query));
    }
    const corrupt = { ...cached.brief, query: 'corrupt brief', interpretations: [{ text: 'Unsupported cached claim', citations: ['E999'] }] };
    await persistArtifact({ rootDir: root, kind: 'feature_brief', key: 'invalid-cached-citation', payload: corrupt });
    assert.equal(await lookupFeatureBrief(root, 'corrupt brief'), null);
    for (const [name, change] of [
      ['out-of-source-range', brief => { brief.citations[0].end = 999999; }],
      ['wrong-source-hash', brief => { brief.citations[0].hash = '0'.repeat(64); }],
      ['invalid-warning-shape', brief => { brief.warnings = null; }],
      ['altered-fact-text', brief => { brief.facts[0] = `[${brief.citations[0].id}] Arbitrary claim presented as extracted evidence`; }],
      ['missing-facts', brief => { brief.facts = []; }],
      ['invalid-fact-role', brief => { brief.citations[0].roles = ['Arbitrary extracted claim']; }],
      ['old-generator', brief => { brief.version = 2; }],
      ['missing-retrieval-identity', brief => { delete brief.retrievalIdentity; }],
    ]) {
      const malformed = structuredClone(cached.brief); malformed.query = name; change(malformed);
      await persistArtifact({ rootDir: root, kind: 'feature_brief', key: name, payload: malformed });
      assert.equal(await lookupFeatureBrief(root, name), null, name);
    }
    await writeFile(join(root, 'new-caller.ts'), 'import { reserveUpload } from "./upload.js"; export const another = reserveUpload;');
    assert.equal(await lookupFeatureBrief(root, query), null);
    await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
    assert.equal(await lookupFeatureBrief(root, query), null);
    await getFeatureBrief({ rootDir: root, query });
    assert.ok(await lookupFeatureBrief(root, query));
    await writeFile(join(root, 'quota.ts'), 'export function quota() { return "changed"; }');
    assert.equal(await lookupFeatureBrief(root, query), null);
  } finally { await cleanup(root); }
});

it('oversized deltas and malformed snapshots safely return bounded full evidence', async () => {
  const root = await fixture();
  try {
    const options = { rootDir: root, query: 'upload', maxTokens: 512 };
    const ranges = Array.from({ length: 120 }, (_, i) => ({ file: `old-${i}.ts`, start: 1, end: 1, text: 'export const old = 1;' }));
    const old = { text: 'Old evidence', ranges, hashes: {}, notices: [], settings: 'fixture-v1', complete: true };
    const firstId = id(await finishSourceContext(options, old));
    const current = { ...old, text: 'Current evidence', ranges: [], hashes: {} };
    const delta = await finishSourceContext({ ...options, previousContextId: firstId }, current);
    assert.match(delta, /Delta over budget; returning full context/);
    assert.match(delta, /Current evidence/); assert.ok(Buffer.byteLength(delta) <= 2048);
    const saved = await readArtifact(root, firstId);
    const malformed = await persistArtifact({ rootDir: root, kind: 'source_context', key: 'malformed', payload: { ...saved.payload, packet: { ranges: [null], hashes: {} } } });
    assert.match(await finishSourceContext({ ...options, previousContextId: malformed.id }, current), /Baseline missing, incompatible or incomplete/);
  } finally { await cleanup(root); }
});

it('model assistance is opt-in, citation checked, bounded, and reports actual usage', async () => {
  const root = await fixture();
  const keys = ['CONTEXTPRO_CHAT_PROVIDER', 'CONTEXTPRO_API_KEY', 'CONTEXTPRO_BASE_URL', 'CONTEXTPRO_CHAT_MODEL', 'CONTEXTPRO_CHAT_RERANK', 'CONTEXTPRO_FEATURE_SUMMARIES'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let mode = 'rank', requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(JSON.parse(text));
    if (mode === 'timeout') return; // The client deadline must release the call.
    const content = mode === 'rank' ? '{"ranked_paths":["quota.ts","upload.ts","route.ts"]}'
      : mode === 'bad-rank' ? '{"ranked_paths":["../escape.ts"]}'
      : mode === 'claims' ? '{"claims":[{"text":"Reservations count outstanding intents.","citations":["E1"]}]}'
      : '{"claims":[{"text":"Invented","citations":["E999"]}]}';
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 43, completion_tokens: 12 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.CONTEXTPRO_CHAT_PROVIDER = 'openai'; process.env.CONTEXTPRO_API_KEY = 'fixture-only';
    process.env.CONTEXTPRO_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`; process.env.CONTEXTPRO_CHAT_MODEL = 'fixture-chat';
    const candidates = ['upload.ts', 'quota.ts', 'route.ts'].map(path => ({ path, score: .5, reason: 'match', symbols: [] }));
    assert.deepEqual(await maybeChatRerankPlanningFiles(root, 'fix upload limit', candidates), candidates); assert.equal(requests.length, 0);
    process.env.CONTEXTPRO_CHAT_RERANK = 'true';
    const measured = await withProviderUsage(() => maybeChatRerankPlanningFiles(root, 'fix upload limit', candidates));
    assert.equal(measured.value[0].path, 'quota.ts'); assert.match(requests[0].messages[0].content, /used \+ reserved/);
    assert.equal(measured.usage[0].inputTokens, 43); assert.equal(measured.usage[0].outputTokens, 12); assert.equal(measured.usage[0].cachedInputTokens, null);
    mode = 'bad-rank'; assert.deepEqual(await maybeChatRerankPlanningFiles(root, 'fix upload limit', candidates), candidates);
    mode = 'timeout';
    const start = performance.now();
    assert.deepEqual(await maybeChatRerankPlanningFiles(root, 'fix upload limit', candidates), candidates);
    assert.ok(performance.now() - start < 2500, '1.5-second model deadline must bound reranking');
    delete process.env.CONTEXTPRO_CHAT_RERANK; process.env.CONTEXTPRO_FEATURE_SUMMARIES = 'true';
    mode = 'claims';
    const brief = await getFeatureBrief({ rootDir: root, query: 'upload reservation', refresh: true });
    assert.match(brief, /Model interpretations/); assert.match(brief, /not independently verified/);
    process.env.CONTEXTPRO_CHAT_MODEL = 'changed-model';
    assert.equal(await lookupFeatureBrief(root, 'upload reservation'), null);
    mode = 'bad-claims';
    const bad = await getFeatureBrief({ rootDir: root, query: 'upload reservation', refresh: true });
    assert.doesNotMatch(bad, /Invented|E999/); assert.match(bad, /invalid/);
  } finally {
    for (const key of keys) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await cleanup(root);
  }
});

it('lean MCP dispatch exposes the brief schema and source packet recovery without catalog refresh', async () => {
  const root = await fixture(), old = process.env.CONTEXTPRO_TOOL_PROFILE;
  process.env.CONTEXTPRO_TOOL_PROFILE = 'lean';
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerTools } = await import('../../build/tools/register-tools.js');
  const server = new McpServer({ name: 'connected-wire', version: '1' }), client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  registerTools(server, root, handler => handler);
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['context', 'discover_tools', 'exact_references']);
    const call = (name, args) => client.callTool({ name, arguments: { root, ...args } });
    const discovery = JSON.parse((await call('discover_tools', { enable: ['feature_brief'] })).content[0].text);
    assert.equal(discovery.schemas[0].callable, true);
    assert.equal(discovery.schemas[0].inputSchema.properties.max_tokens.maximum, 12000);
    const brief = await call('discover_tools', { call: { name: 'feature_brief', arguments: { query: 'upload reservation', max_tokens: 512 } } });
    assert.ok(!brief.isError); assert.ok(Buffer.byteLength(brief.content[0].text) <= 2048);
    const first = await call('context', { query: 'reserveUpload', max_tokens: 1200 });
    const contextId = id(first.content[0].text); assert.ok(contextId);
    const delta = await call('context', { query: 'reserveUpload', max_tokens: 1200, previous_context_id: contextId });
    assert.match(delta.content[0].text, /unchanged/);
    const recovery = await call('discover_tools', { call: { name: 'artifact_read', arguments: { artifact_id: contextId } } });
    assert.ok(JSON.parse(recovery.content[0].text).payload.packet.ranges.length);
  } finally {
    await client.close(); await server.close(); old === undefined ? delete process.env.CONTEXTPRO_TOOL_PROFILE : process.env.CONTEXTPRO_TOOL_PROFILE = old;
    await cleanup(root);
  }
});
