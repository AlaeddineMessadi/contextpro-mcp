import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { closeDB, getDB } from "../../build/core/db.js";

describe("semantic-identifiers", () => {
  it("preserves published vectors when generation fails, then replaces removed identifiers on retry", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextpro-identifier-recovery-"));
    const originalEmbed = Ollama.prototype.embed;
    const embed = async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]),
    });
    Ollama.prototype.embed = embed;
    try {
      const { refreshIdentifierEmbeddings } = await import("../../build/tools/semantic-identifiers.js");
      const { getEmbedProvider, getEmbedModel } = await import("../../build/core/embeddings.js");
      const db = await getDB(rootDir);
      db.recordEmbeddingProvider(getEmbedProvider(), getEmbedModel());
      await writeFile(join(rootDir, "stable.ts"), "export function stable() { return 1; }\n");
      await writeFile(join(rootDir, "changed.ts"), "export function oldName() { return 2; }\n");
      const options = { rootDir, relativePaths: ["stable.ts", "changed.ts"] };
      await refreshIdentifierEmbeddings(options);
      const rows = () => db.getEmbeddingsByType("identifier_cache").sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      const before = rows();
      assert.ok(before.length >= 2);

      await writeFile(join(rootDir, "changed.ts"), "export function newName() { return 3; }\n");
      Ollama.prototype.embed = async () => { throw new Error("provider unavailable"); };
      await assert.rejects(refreshIdentifierEmbeddings(options), /provider unavailable/);
      assert.deepEqual(rows(), before);

      Ollama.prototype.embed = embed;
      const publish = db.upsertEmbeddingsBatch;
      db.upsertEmbeddingsBatch = function (...args) {
        publish.apply(this, args);
        throw new Error("publish failed");
      };
      try {
        await assert.rejects(refreshIdentifierEmbeddings(options), /publish failed/);
        assert.deepEqual(rows(), before);
      } finally {
        db.upsertEmbeddingsBatch = publish;
      }
      assert.equal(await refreshIdentifierEmbeddings(options), 1);
      assert.deepEqual(rows().filter(row => row.sourceId.startsWith("id:stable.ts:")),
        before.filter(row => row.sourceId.startsWith("id:stable.ts:")));
      assert.ok(rows().some(row => row.sourceId.includes("newName")));
      assert.ok(!rows().some(row => row.sourceId.includes("oldName")));
      await rm(join(rootDir, "changed.ts"));
      await refreshIdentifierEmbeddings({ rootDir, relativePaths: ["changed.ts"] });
      assert.ok(!rows().some(row => row.sourceId.startsWith("id:changed.ts:")));
    } finally {
      Ollama.prototype.embed = originalEmbed;
      closeDB(rootDir);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("exports semanticIdentifierSearch as a function", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(typeof mod.semanticIdentifierSearch, "function");
  });

  it("exports invalidateIdentifierSearchCache as a function", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(typeof mod.invalidateIdentifierSearchCache, "function");
  });

  it("semanticIdentifierSearch uses single options parameter", async () => {
    const mod = await import("../../build/tools/semantic-identifiers.js");
    assert.equal(mod.semanticIdentifierSearch.length, 1);
  });

  it("does not count comments or strings as identifier call sites", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextpro-identifier-sites-"));
    const originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]),
    });
    try {
      await writeFile(join(rootDir, "score.ts"), [
        "export function calculateScore() { return 10; }",
        "function caller() {",
        "  calculateScore();",
        "  const message = 'calculateScore()';",
        "  // calculateScore();",
        "}",
        "",
      ].join("\n"));
      const mod = await import("../../build/tools/semantic-identifiers.js");
      mod.invalidateIdentifierSearchCache();
      const data = await mod.semanticIdentifierSearchResults({ rootDir, query: "calculateScore", topK: 1 });
      assert.equal(data.results[0].name, "calculateScore");
      assert.equal(data.results[0].totalCalls, 1);
      assert.equal(data.results[0].calls[0].line, 3);
    } finally {
      Ollama.prototype.embed = originalEmbed;
      closeDB(rootDir);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("demotes generic locals unless the query explicitly names them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "contextpro-identifier-generic-"));
    const originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async ({ input }) => ({
      embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]),
    });
    try {
      await writeFile(join(rootDir, "exam.ts"), "export function calculateExamResult() { return 10; }\n");
      await writeFile(join(rootDir, "exam.test.ts"), "const score = 10;\n");
      const mod = await import("../../build/tools/semantic-identifiers.js");
      mod.invalidateIdentifierSearchCache();
      const behavior = await mod.semanticIdentifierSearchResults({
        rootDir,
        query: "where is exam scoring and the pass threshold enforced",
        topK: 2,
      });
      assert.equal(behavior.results[0].name, "calculateExamResult");

      mod.invalidateIdentifierSearchCache();
      const exact = await mod.semanticIdentifierSearchResults({ rootDir, query: "score", topK: 2 });
      assert.equal(exact.results[0].name, "score");
    } finally {
      Ollama.prototype.embed = originalEmbed;
      closeDB(rootDir);
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
