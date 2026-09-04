import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { closeDB } from "../../build/core/db.js";

describe("semantic-identifiers", () => {
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
