// Automatic structural freshness and multi-process coordination tests.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let root = "";
let priorRefresh;
let priorMaxFiles;

describe("automatic index freshness", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-freshness-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "value.ts"), "export function alpha() { return 1; }\n");
    const { reindex } = await import("../../build/tools/reindex.js");
    await reindex({ rootDir: root, force: true, noEmbed: true });
    priorRefresh = process.env.CONTEXTPRO_REFRESH;
    priorMaxFiles = process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES;
  });

  afterEach(async () => {
    if (priorRefresh === undefined) delete process.env.CONTEXTPRO_REFRESH;
    else process.env.CONTEXTPRO_REFRESH = priorRefresh;
    if (priorMaxFiles === undefined) delete process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES;
    else process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES = priorMaxFiles;
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("refreshes an edited file before a graph reader uses the index", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { ensureFreshIndex } = await import("../../build/core/index-freshness.js");
    const { buildProjectGraph } = await import("../../build/core/project-graph.js");
    const db = await getDB(root);
    const before = db.getIndexGeneration();

    await writeFile(join(root, "src", "value.ts"), "export function omega() { return 2; }\n");
    const freshness = await ensureFreshIndex(root);
    const graph = await buildProjectGraph(root);

    assert.equal(freshness.refreshed, true);
    assert.equal(db.getIndexGeneration(), before + 1);
    assert.ok(graph.nodes.some((node) => node.type === "symbol" && node.label === "omega"));
    assert.ok(!graph.nodes.some((node) => node.type === "symbol" && node.label === "alpha"));
  });

  it("hash mode catches a same-size edit whose mtime was restored", async () => {
    const source = join(root, "src", "value.ts");
    const originalStats = await stat(source);
    await writeFile(source, "export function omega() { return 2; }\n");
    await utimes(source, originalStats.atime, originalStats.mtime);
    process.env.CONTEXTPRO_REFRESH = "hash";

    const { ensureFreshIndex } = await import("../../build/core/index-freshness.js");
    const { getDB } = await import("../../build/core/db.js");
    const freshness = await ensureFreshIndex(root);
    const db = await getDB(root);
    const file = db.getFile("src/value.ts");

    assert.equal(freshness.refreshed, true);
    assert.ok(file);
    assert.ok(db.getSymbolsByFile(file.id).some((symbol) => symbol.name === "omega"));
  });

  it("invalidates every structural row when the extractor identity changes", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { getExtractorStamp } = await import("../../build/core/extractor-stamp.js");
    const { ensureFreshIndex } = await import("../../build/core/index-freshness.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    db.setMeta("extractor_stamp", "sha256:obsolete");

    const freshness = await ensureFreshIndex(root);
    assert.equal(freshness.refreshed, true);
    assert.equal(db.getIndexGeneration(), generation + 1);
    assert.equal(db.getMeta("extractor_stamp"), getExtractorStamp());
  });

  it("does not advance the generation for a no-change reindex", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { reindex } = await import("../../build/tools/reindex.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    const output = await reindex({ rootDir: root, noEmbed: true });
    assert.equal(db.getIndexGeneration(), generation);
    assert.match(output, /generation: unchanged/i);
  });

  it("incrementally removes a deleted file without reporting a degraded refresh", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { quickRefresh } = await import("../../build/tools/reindex.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    db.upsertEmbedding("file_search_cache", "src/value.ts", [1, 0, 0], "file-hash");
    db.upsertEmbedding("identifier_cache", "id:src/value.ts:alpha", [1, 0, 0], "identifier-hash");
    await unlink(join(root, "src", "value.ts"));

    const result = await quickRefresh(root, { includeEmbeddings: true });

    assert.equal(result.complete, true);
    assert.equal(result.fullReindex, undefined);
    assert.equal(db.getFile("src/value.ts"), null);
    assert.equal(db.getIndexGeneration(), generation + 1);
    assert.deepEqual(db.getEmbeddingsByType("file_search_cache"), []);
    assert.deepEqual(db.getEmbeddingsByType("identifier_cache"), []);
  });

  it("coalesces concurrent in-process readers into one refresh generation", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { ensureFreshIndex } = await import("../../build/core/index-freshness.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    await writeFile(join(root, "src", "second.ts"), "export const second = 2;\n");

    const results = await Promise.all(Array.from({ length: 10 }, () => ensureFreshIndex(root)));
    assert.ok(results.every((result) => result.refreshed));
    assert.equal(db.getIndexGeneration(), generation + 1);
  });

  it("coordinates two independent agent processes without duplicate generations", async () => {
    const { getDB, closeDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    await writeFile(join(root, "src", "cross-process.ts"), "export const crossProcess = true;\n");
    closeDB(root);

    const moduleUrl = new URL("../../build/core/index-freshness.js", import.meta.url).href;
    const program = `import { ensureFreshIndex } from ${JSON.stringify(moduleUrl)}; await ensureFreshIndex(process.argv[1]);`;
    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "-e", program, root]),
      execFileAsync(process.execPath, ["--input-type=module", "-e", program, root]),
    ]);

    const reopened = await getDB(root);
    assert.equal(reopened.getIndexGeneration(), generation + 1);
  });

  it("keeps one generation when two processes encounter a large-change fallback", async () => {
    const { getDB, closeDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    const generation = db.getIndexGeneration();
    for (let i = 0; i < 3; i++) {
      await writeFile(join(root, "src", `large-${i}.ts`), `export const large${i} = ${i};\n`);
    }
    closeDB(root);

    const moduleUrl = new URL("../../build/core/index-freshness.js", import.meta.url).href;
    const program = `process.env.CONTEXTPRO_QUICKREFRESH_MAX_FILES = "1"; const { ensureFreshIndex } = await import(${JSON.stringify(moduleUrl)}); await ensureFreshIndex(process.argv[1]);`;
    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "-e", program, root]),
      execFileAsync(process.execPath, ["--input-type=module", "-e", program, root]),
    ]);

    const reopened = await getDB(root);
    assert.equal(reopened.getIndexGeneration(), generation + 1);
    for (let i = 0; i < 3; i++) assert.ok(reopened.getFile(`src/large-${i}.ts`));
  });

  it("recovers an index lock owned by a dead process", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { waitForIndexingCompletion } = await import("../../build/tools/reindex.js");
    const db = await getDB(root);
    db.setMetaBatch([
      ["index_status", "indexing"],
      ["index_started_at", String(Date.now())],
      ["index_owner_pid", "2147483647"],
    ]);

    const result = await waitForIndexingCompletion(root, { timeoutMs: 500, pollMs: 50 });
    assert.equal(result.timedOut, false);
    assert.equal(db.getMeta("index_status"), "idle");
  });
});
