import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { reindex } from "../../build/tools/reindex.js";
import { closeDB } from "../../build/core/db.js";
import {
  invalidateSearchCache,
  semanticCodeSearch,
  semanticCodeSearchResults,
} from "../../build/tools/semantic-search.js";

describe("semantic-search", () => {
  describe("invalidateSearchCache", () => {
    it("is a function", () => {
      assert.equal(typeof invalidateSearchCache, "function");
    });

    it("does not throw when called", () => {
      assert.doesNotThrow(() => invalidateSearchCache());
    });

    it("can be called multiple times", () => {
      invalidateSearchCache();
      invalidateSearchCache();
      invalidateSearchCache();
      assert.ok(true);
    });
  });

  describe("semanticCodeSearch (structural)", () => {
    it("is exported as a function", async () => {
      const mod = await import("../../build/tools/semantic-search.js");
      assert.equal(typeof mod.semanticCodeSearch, "function");
    });

    it("has expected parameter signature (rootDir, query, topK)", async () => {
      const mod = await import("../../build/tools/semantic-search.js");
      assert.equal(mod.semanticCodeSearch.length, 1);
    });

    it("skips oversized data files and still indexes source files", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "contextplus-semantic-search-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      const previousSizeLimit = process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE;

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => [
            value.includes("greet") ? 1 : 0.25,
          ]),
        };
      };

      process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE = "1024";

      try {
        await writeFile(
          join(rootDir, "app.ts"),
          [
            "// Semantic search fixture header line one two three four",
            "// FEATURE: semantic search fixture coverage for mixed data projects",
            "export function greet(name: string): string {",
            "  return `hello ${name}`;",
            "}",
            "",
          ].join("\n"),
        );
        await writeFile(
          join(rootDir, "data.json"),
          JSON.stringify({
            rows: Array.from({ length: 50000 }, (_, idx) => ({
              id: idx,
              value: `payload_${idx}`,
            })),
          }),
        );

        invalidateSearchCache();
        const result = await semanticCodeSearch({
          rootDir,
          query: "greet",
          topK: 3,
        });
        assert.match(result, /app\.ts/);
        assert.doesNotMatch(result, /data\.json/);
      } finally {
        if (previousSizeLimit === undefined)
          delete process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE;
        else process.env.CONTEXTPLUS_MAX_EMBED_FILE_SIZE = previousSizeLimit;
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("uses indexed FTS results when embeddings are unavailable", async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "contextplus-semantic-search-fts-"),
      );
      const originalEmbed = Ollama.prototype.embed;
      Ollama.prototype.embed = async function () {
        throw new Error("offline");
      };

      try {
        await writeFile(
          join(rootDir, "auth.ts"),
          [
            "// Auth token service",
            "// FEATURE: auth token lifecycle",
            "export function issue_token(subject: string): string {",
            "  return `token:${subject}`;",
            "}",
            "",
          ].join("\n"),
        );
        await reindex({ rootDir, force: true });
        invalidateSearchCache();
        const result = await semanticCodeSearch({
          rootDir,
          query: "issue token",
          topK: 3,
        });
        assert.match(result, /auth\.ts/);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        closeDB(rootDir);
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("inlines a bounded relevant crux by default and supports full definition bodies", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-semantic-inline-"));
      const originalEmbed = Ollama.prototype.embed;
      const query = "where is exam scoring and the pass threshold enforced";
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => value === query || value.includes("Server-authoritative submit") ? [1, 0] : [0, 1]),
        };
      };

      try {
        await writeFile(join(rootDir, "exam.ts"), [
          "export async function finishExam(answers: number[]) {",
          "  const localScore = answers.length;",
          "  // Server-authoritative submit recomputes the score against correct answers.",
          "  const result = await submitExamResult(answers);",
          "  if (result.percentage < result.passThreshold) return 'failed';",
          "  return 'passed';",
          "}",
          "",
        ].join("\n"));
        await writeFile(join(rootDir, "coverage.ts"), "export const coverageThreshold = 90;\n");
        invalidateSearchCache();
        const crux = await semanticCodeSearchResults({ rootDir, query, topK: 2, inlineCode: "crux" });
        const hit = crux.results.find((result) => result.path === "exam.ts");
        assert.equal(hit?.inlineCode?.mode, "crux");
        assert.match(hit?.inlineCode?.text ?? "", /Server-authoritative submit/);
        assert.ok((hit?.inlineCode?.endLine ?? 0) - (hit?.inlineCode?.startLine ?? 0) < 8);

        invalidateSearchCache();
        const full = await semanticCodeSearchResults({ rootDir, query, topK: 1, inlineCode: "full" });
        assert.equal(full.results[0].inlineCode?.mode, "full");
        assert.match(full.results[0].inlineCode?.text ?? "", /return 'passed'/);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        closeDB(rootDir);
        await rm(rootDir, { recursive: true, force: true });
      }
    });

    it("keeps keyword-only FTS tail scores distinct and below semantic matches", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-semantic-ranking-"));
      const originalEmbed = Ollama.prototype.embed;
      const query = "exam scoring pass threshold enforced";
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((value) => value === query || value.includes("AUTHORITATIVE_EXAM_LOGIC") ? [1, 0] : [0, 1]),
        };
      };

      try {
        await writeFile(join(rootDir, "exam.ts"), [
          "// AUTHORITATIVE_EXAM_LOGIC exam scoring pass threshold enforced",
          "export function finishExam() { return submitExam(); }",
          "",
        ].join("\n"));
        for (let index = 1; index <= 4; index++) {
          await writeFile(
            join(rootDir, `coverage-${index}.ts`),
            `// exam scoring pass threshold enforced ${"coverage ".repeat(index)}\nexport const threshold${index} = ${80 + index};\n`,
          );
        }
        await reindex({ rootDir, force: true });
        invalidateSearchCache();
        const data = await semanticCodeSearchResults({ rootDir, query, topK: 5, inlineCode: "off" });
        const semantic = data.results.find((result) => result.path === "exam.ts");
        const lexicalOnly = data.results.filter((result) => result.semanticScore === 0);
        assert.ok(semantic && semantic.semanticScore > 40);
        assert.equal(lexicalOnly.length, 4);
        assert.ok(lexicalOnly.every((result) => result.score < semantic.score));
        assert.equal(new Set(lexicalOnly.map((result) => result.score)).size, lexicalOnly.length);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        closeDB(rootDir);
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });
});
