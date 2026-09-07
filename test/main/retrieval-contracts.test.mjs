import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ollama } from 'ollama';
import { buildTaskPack } from '../../build/tools/agentic-context.js';
import { unifiedSearchData, invalidateSearchCache, invalidateIdentifierSearchCache } from '../../build/tools/search.js';
import { semanticCodeSearchResults } from '../../build/tools/semantic-search.js';
import { getDB, closeDB } from '../../build/core/db.js';
import { readArtifact } from '../../build/core/artifacts.js';
import { reindex } from '../../build/tools/reindex.js';

let root, originalEmbed, calls;
const source = '// Session refresh implementation\nexport function refreshSession() { return 1; }\nexport function handleRequest() { return refreshSession(); }\n';
describe('retrieval contracts', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'contextpro-retrieval-contract-'));
    await writeFile(join(root, 'session.ts'), source);
    originalEmbed = Ollama.prototype.embed;
    calls = [];
    Ollama.prototype.embed = async function ({ input }) {
      calls.push(input);
      return { embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0.5, 0.1]) };
    };
    invalidateSearchCache(); invalidateIdentifierSearchCache();
  });
  afterEach(async () => {
    Ollama.prototype.embed = originalEmbed;
    invalidateSearchCache(); invalidateIdentifierSearchCache();
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });
  for (const oldVector of [[1, 0, 0], [1, 0, 0, 0]]) {
    it(`rebuilds durable memory after a model change from ${oldVector.length} dimensions`, async () => {
      const db = await getDB(root);
      db.recordEmbeddingProvider('ollama', 'old-memory-model');
      const id = db.upsertMemoryNode({ type: 'note', label: 'durable rule', content: 'Keep sessions atomic', metadata: { scope: 'project', custom: 'preserve' } }, oldVector);
      const original = db.peekMemoryNode(id);
      await reindex({ rootDir: root, noEmbed: true });
      assert.equal(db.getEmbeddingStats().memory, 0);
      assert.equal(db.isEmbeddingsStale().stale, true);
      assert.equal(calls.length, 0);
      await reindex({ rootDir: root, noEmbed: false });
      assert.ok(db.searchMemoryNodes([1, 0.5, 0.1], 10).some(result => result.node.id === id));
      assert.deepEqual(db.peekMemoryNode(id), original, 'rebuilding vectors must not rewrite durable metadata or access counters');
      assert.equal(db.isEmbeddingsStale().stale, false);
    });
  }
  it('retains stale state after memory embedding failure and repairs it on retry', async () => {
    const db = await getDB(root);
    db.recordEmbeddingProvider('ollama', 'old-memory-model');
    const id = db.upsertMemoryNode({ type: 'note', label: 'retry memory', content: 'Keep this rule' }, [1, 0, 0]);
    const original = db.setMemoryEmbedding;
    db.setMemoryEmbedding = () => { throw new Error('injected memory vector failure'); };
    try {
      const result = await reindex({ rootDir: root, noEmbed: false });
      assert.match(result, /injected memory vector failure/);
      assert.equal(db.isEmbeddingsStale().stale, true);
      assert.ok(db.listMemoryNodesWithoutEmbeddings().some(node => node.id === id));
    } finally { db.setMemoryEmbedding = original; }
    await reindex({ rootDir: root, noEmbed: false });
    assert.ok(db.searchMemoryNodes([1, 0.5, 0.1], 10).some(result => result.node.id === id));
    assert.equal(db.isEmbeddingsStale().stale, false);
  });
  it('does not attach rebuilt vectors to changed or deleted memory nodes', async () => {
    const db = await getDB(root);
    const id = db.upsertMemoryNode({ type: 'note', label: 'changing memory', content: 'before' });
    const before = db.peekMemoryNode(id);
    db.upsertMemoryNode({ type: 'note', label: 'changing memory', content: 'after' });
    assert.equal(db.setMemoryEmbedding(before, [1, 0, 0]), false);
    const after = db.peekMemoryNode(id);
    db.deleteMemoryNode(id);
    assert.equal(db.setMemoryEmbedding(after, [1, 0, 0]), false);
    assert.equal(db.peekMemoryNode(id), null);
  });
  it('keyword_only makes zero embedding calls on cold and warm hybrid search, including call sites and memory', async () => {
    const db = await getDB(root);
    db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'refreshSession rule', content: 'refreshSession must be atomic' });
    for (let i = 0; i < 2; i++) {
      const result = await unifiedSearchData({ rootDir: root, query: 'refreshSession', preset: 'keyword_only', persistArtifact: false });
      assert.ok(result.files.results.some(file => file.path === 'session.ts'));
      assert.ok(result.identifiers.results.some(item => item.name === 'refreshSession'));
      assert.ok(result.files.results.every(file => file.semanticScore === 0));
    }
    const pack = JSON.parse(await buildTaskPack({ rootDir: root, task: 'refreshSession', preset: 'keyword_only', format: 'json', includeRecentDiffs: false, maxTokens: 12000 }));
    assert.equal(pack.memory.length, 1);
    assert.equal(calls.length, 0, JSON.stringify(calls));
  });
  it('shares a single query embedding across file, identifier and task memory retrieval', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    await buildTaskPack({ rootDir: root, task: 'refreshSession', format: 'json', includeRecentDiffs: false, maxTokens: 12000 });
    assert.equal(calls.flat().filter(input => input === 'refreshSession').length, 1);
  });
  it('enforces semantic requirements and thresholds after FTS and exact-name boosts', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    const opts = { rootDir: root, query: 'refreshSession', preset: 'keyword_only', minSemanticScore: 0.5 };
    assert.deepEqual((await semanticCodeSearchResults(opts)).results, []);
    const unified = await unifiedSearchData({ ...opts, persistArtifact: false });
    assert.deepEqual(unified.files.results, []);
    assert.deepEqual(unified.identifiers.results, []);
    const requireSemantic = await unifiedSearchData({ ...opts, minSemanticScore: undefined, requireSemanticMatch: true, persistArtifact: false });
    assert.deepEqual(requireSemantic.files.results, []);
    assert.deepEqual(requireSemantic.identifiers.results, []);
  });
  it('bounds the final UTF-8 text and JSON response including metadata and long Unicode tasks', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    for (const format of ['json', 'text']) {
      const output = await buildTaskPack({ rootDir: root, task: 'refreshSession 中文🔬'.repeat(600), preset: 'keyword_only', format, maxTokens: 512, includeRecentDiffs: false });
      assert.ok(Buffer.byteLength(output, 'utf8') <= 2048, `${format}: ${Buffer.byteLength(output)}`);
      if (format === 'json') {
        const parsed = JSON.parse(output);
        assert.equal(parsed.budget.estimator, 'utf8_bytes_div_4');
        assert.equal(parsed.budget.estimatedTokens, Math.ceil(Buffer.byteLength(output) / 4));
        assert.equal(parsed.budget.truncated, true);
        assert.ok(parsed.context.id);
      }
    }
  });
  it('invalidates cached task memory for create, update, delete, and prune without source reindexing', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    const db = await getDB(root);
    const opts = { rootDir: root, task: 'refreshSession', preset: 'keyword_only', format: 'json', includeRecentDiffs: false, maxTokens: 12000 };
    const pack = async () => JSON.parse(await buildTaskPack(opts));
    assert.equal((await pack()).memory.length, 0);
    const generation = db.getIndexGeneration();
    const id = db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'refreshSession', content: 'refreshSession first rule' });
    assert.equal((await pack()).memory.length, 1);
    db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'refreshSession', content: 'refreshSession revised rule' });
    assert.match((await pack()).memory[0].summary, /revised/);
    db.deleteMemoryNode(id);
    assert.equal((await pack()).memory.length, 0);
    const first = db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'a', content: 'refreshSession' });
    const second = db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'b', content: 'refreshSession' });
    db.upsertMemoryEdge({ source: first, target: second, relation: 'relates_to', weight: 0.01 });
    const revision = db.getMemoryRevision();
    db.pruneStaleEdges(0.1);
    assert.ok(db.getMemoryRevision() > revision);
    assert.equal(db.getIndexGeneration(), generation);
  });
  it('provides immutable full recovery and explicit added/changed/removed deltas', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    const db = await getDB(root);
    const opts = { rootDir: root, task: 'refreshSession', preset: 'keyword_only', format: 'json', includeRecentDiffs: false, maxTokens: 12000 };
    const first = JSON.parse(await buildTaskPack(opts));
    assert.equal(first.context.mode, 'full');
    assert.equal(first.budget.truncated, false);
    const snapshotBefore = await readArtifact(root, first.context.id);
    assert.equal(JSON.parse(await buildTaskPack(opts)).context.id, first.context.id);
    const memoryId = db.upsertMemoryNode({ type: 'note', metadata: { scope: 'global' }, label: 'refreshSession', content: 'refreshSession newly learned' });
    await writeFile(join(root, 'session.ts'), source.replace('return 1', 'return 2'));
    await reindex({ rootDir: root, noEmbed: true });
    const second = JSON.parse(await buildTaskPack({ ...opts, previousContextId: first.context.id }));
    assert.equal(second.context.mode, 'delta');
    assert.ok(second.delta.added.some(entry => entry.id === `memory:${memoryId}`));
    assert.ok(second.delta.changed.some(entry => entry.id === 'file:session.ts'));
    assert.deepEqual(await readArtifact(root, first.context.id), snapshotBefore);
    db.deleteMemoryNode(memoryId);
    const third = JSON.parse(await buildTaskPack({ ...opts, previousContextId: second.context.id }));
    assert.ok(third.delta.removed.includes(`memory:${memoryId}`));
    const recovered = await readArtifact(root, third.context.id);
    assert.ok(recovered.payload.payload.files.length > 0);
    assert.equal(recovered.payload.payload.memory.length, 0);
    const unrelated = JSON.parse(await buildTaskPack({ ...opts, task: 'handleRequest', previousContextId: first.context.id }));
    assert.equal(unrelated.context.mode, 'full');
    assert.equal(unrelated.context.fallbackReason, 'unrelated_or_incomplete_baseline');
    const missing = JSON.parse(await buildTaskPack({ ...opts, previousContextId: 'task_context-00000000000000' }));
    assert.equal(missing.context.fallbackReason, 'baseline_not_found');
  });
  it('expands indexed import edges only on request and respects the expansion limit', async () => {
    await writeFile(join(root, 'session.ts'), 'import { dependency } from "./dependency.js";\n' + source.replace('return 1', 'return dependency()'));
    await writeFile(join(root, 'dependency.ts'), 'import { lower } from "./lower.js";\nexport function dependency() { return lower(); }\n');
    await writeFile(join(root, 'lower.ts'), 'export function lower() { return 1; }\n');
    await reindex({ rootDir: root, noEmbed: true });
    const opts = { rootDir: root, task: 'refreshSession', preset: 'keyword_only', format: 'json', includeRecentDiffs: false, includeMemory: false, maxFiles: 1, maxTokens: 12000 };
    const plain = JSON.parse(await buildTaskPack(opts));
    assert.equal(plain.relatedFiles, undefined);
    const expanded = JSON.parse(await buildTaskPack({ ...opts, graphHops: 2, graphMaxFiles: 1 }));
    assert.equal(expanded.relatedFiles.length, 1);
    assert.equal(expanded.relatedFiles[0].path, 'dependency.ts');
    assert.match(expanded.relatedFiles[0].reason, /indexed import edge.*heuristic/);
    assert.equal(calls.length, 0, JSON.stringify(calls));
  });
  it('refuses to omit context using a truncated baseline', async () => {
    await reindex({ rootDir: root, noEmbed: true });
    const opts = { rootDir: root, task: 'refreshSession '.repeat(700), preset: 'keyword_only', format: 'json', includeRecentDiffs: false, maxTokens: 512 };
    const first = JSON.parse(await buildTaskPack(opts));
    const second = JSON.parse(await buildTaskPack({ ...opts, maxTokens: 12000, previousContextId: first.context.id }));
    assert.equal(second.context.mode, 'full');
    assert.equal(second.context.fallbackReason, 'unrelated_or_incomplete_baseline');
  });
});
