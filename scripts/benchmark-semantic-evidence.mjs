#!/usr/bin/env node
// Local provider evaluation, separate from coding-agent usage. Uses disposable
// source fixtures, real embeddings and explicit absent/valid/obsolete vectors.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
process.env.CONTEXTPRO_PROVIDER = 'ollama';
process.env.CONTEXTPRO_EMBED_MODEL = 'bge-m3:latest';
process.env.CONTEXTPRO_CHAT_MODEL = 'gemma4:latest';
process.env.CONTEXTPRO_CHAT_RERANK = 'false';
process.env.CONTEXTPRO_FEATURE_SUMMARIES = 'false';
process.env.CONTEXTPRO_REINDEX_NO_EMBED = 'false';
const { reindex } = await import('../build/tools/reindex.js');
const { getContext } = await import('../build/tools/context.js');
const { unifiedSearchData, invalidateSearchCache, invalidateIdentifierSearchCache } = await import('../build/tools/search.js');
const { withProviderUsage } = await import('../build/core/provider-usage.js');
const { chatCompletion } = await import('../build/core/chat-model.js');
const { getDB, closeDB } = await import('../build/core/db.js');
const output = resolve(process.argv[2] ?? '.contextpro/semantic-evaluation');
await mkdir(output, { recursive: true });
const cases = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/retrieval-cases.json'), 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'contextpro-semantic-eval-'));
const rows = [], setup = [];
try {
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'quota.ts'), '// Count outstanding photo reservations against the event shot limit.\nexport function quota(used, reserved, limit) { if (used + reserved >= limit) throw Error("full"); }\n');
  await writeFile(join(root, 'router.ts'), 'import { quota } from "./quota.js";\nexport function reserveUpload(guest, used, intents, limit) { if (!guest.active) throw Error("erased"); return quota(used, intents.filter(i => !i.complete).length, limit); }\n');
  await writeFile(join(root, 'tests/upload.test.ts'), 'import { reserveUpload } from "../router.js";\ntest("outstanding intents count toward upload shot limit", () => expect(() => reserveUpload({active:true}, 1, [{}], 2)).toThrow());\n');
  await writeFile(join(root, 'view.tsx'), 'export function PhotoView() { return <main>Upload photos, manage guest gallery</main>; }\n');
  for (let i = 0; i < 12; i++) await writeFile(join(root, `noise${i}.ts`), `export function unrelated${i}() { return "document export settings retry page theme"; }\n`);
  await reindex({ rootDir: root, noEmbed: true, autoHubs: false });
  const db = await getDB(root);
  for (const state of ['absent', 'valid', 'obsolete']) {
    if (state === 'valid') {
      const measured = await withProviderUsage(() => reindex({ rootDir: root, noEmbed: false, autoHubs: false }));
      setup.push({ state, result: measured.value, usage: measured.usage });
    }
    if (state === 'obsolete') {
      // Keep vector rows present but give them a different content identity.
      // Correct retrieval must reject them, rather than label them semantic.
      for (const type of ['file_search_cache', 'identifier_cache']) {
        for (const row of db.getEmbeddingsByType(type)) {
          const floats = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
          db.upsertEmbedding(type, row.sourceId, floats, 'obsolete-content-hash');
        }
      }
      invalidateSearchCache(root); invalidateIdentifierSearchCache(root);
    }
    for (const test of cases) for (const preset of ['keyword_only', 'semantic_only', 'balanced']) for (const connected of [false, true]) {
      const start = performance.now();
      const measured = await withProviderUsage(() => getContext({ rootDir: root, query: test.query, maxTokens: test.maxTokens, retrievalPreset: preset, connected }));
      const durationMs = performance.now() - start, text = measured.value;
      const search = await unifiedSearchData({ rootDir: root, query: test.query, mode: 'file', preset, topK: 4, persistArtifact: false });
      const returned = [...text.matchAll(/^([^\n]+\.[a-z]+):(\d+)-(\d+)$/gm)].map(match => match[1]);
      const matched = test.expected.filter(value => text.includes(value));
      rows.push({ id: test.id, state, preset, connected, durationMs, outputBytes: Buffer.byteLength(text), usage: measured.usage, vectorsStored: db.getEmbeddingStats(),
        semanticResults: search.files?.results.filter(result => result.semanticScore > 0).length ?? 0,
        evidenceCoverage: test.expected.length ? matched.length / test.expected.length : null,
        missingEvidence: test.expected.filter(value => !matched.includes(value)), followupNeeded: matched.length < test.expected.length,
        irrelevantFiles: returned.filter(file => !test.relevantFiles.includes(file)), negativeReturnedSource: test.negative ? returned.length > 0 : null,
        lexicalFallbackReported: /lexical fallback/.test(text), exactNameFastPath: /^[A-Za-z_$][\w$]*$/.test(test.query) });
      await writeFile(join(output, 'results.json'), JSON.stringify({ setup, rows }, null, 2));
    }
    console.log(`Completed ${state}: ${rows.length} retrieval observations`);
  }
  try {
    const chat = await withProviderUsage(() => chatCompletion(root, 'Return only the word ready.', { timeoutMs: 1500, maxOutputTokens: 8 }));
    await writeFile(join(output, 'chat-readiness.json'), JSON.stringify({ available: true, usage: chat.usage }));
  } catch (error) { await writeFile(join(output, 'chat-readiness.json'), JSON.stringify({ available: false, error: error.message, qualityEvaluated: false })); }
} finally { closeDB(root); await rm(root, { recursive: true, force: true }); }
console.log(`Results: ${output}. Stored vectors are not proof of usable semantic evidence; see semanticResults and provider usage.`);
