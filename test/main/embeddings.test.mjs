import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ollama } from "ollama";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SearchIndex,
  fetchEmbedding,
  getEmbeddingBatchSize,
} from "../../build/core/embeddings.js";

describe("embeddings", () => {
  describe("getEmbeddingBatchSize", () => {
    it("uses a bounded provider default", () => {
      const value = getEmbeddingBatchSize();
      assert.ok(value >= 1 && value <= 128);
    });

    it("allows small batches and caps oversized overrides", () => {
      const previous = process.env.CONTEXTPRO_EMBED_BATCH_SIZE;
      try {
        process.env.CONTEXTPRO_EMBED_BATCH_SIZE = "1";
        assert.equal(getEmbeddingBatchSize(), 1);
        process.env.CONTEXTPRO_EMBED_BATCH_SIZE = "999";
        assert.equal(getEmbeddingBatchSize(), 128);
      } finally {
        if (previous === undefined) delete process.env.CONTEXTPRO_EMBED_BATCH_SIZE;
        else process.env.CONTEXTPRO_EMBED_BATCH_SIZE = previous;
      }
    });
  });

  describe("SearchIndex", () => {
    it("creates an instance", () => {
      const index = new SearchIndex();
      assert.ok(index);
    });

    it("has zero documents initially", () => {
      const index = new SearchIndex();
      assert.equal(index.getDocumentCount(), 0);
    });

    it("index method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.index, "function");
    });

    it("search method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.search, "function");
    });

    it("getDocumentCount method exists", () => {
      const index = new SearchIndex();
      assert.equal(typeof index.getDocumentCount, "function");
    });

    it("re-embeds when content changes beyond first 8000 characters", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-embed-"));
      let callCount = 0;
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        for (const value of batch) {
          if (value.length > 8000)
            throw new Error("input length exceeds context length");
        }
        callCount += batch.length;
        return { embeddings: batch.map(() => [1, 0, 0]) };
      };

      try {
        const index = new SearchIndex();
        const sharedPrefix = "x".repeat(8500);
        const firstDoc = [
          {
            path: "src/long.ts",
            header: "header",
            symbols: ["alpha"],
            content: `${sharedPrefix} tail_one`,
          },
        ];
        const secondDoc = [
          {
            path: "src/long.ts",
            header: "header",
            symbols: ["alpha"],
            content: `${sharedPrefix} tail_two`,
          },
        ];

        await index.index(firstDoc, rootDir);
        const firstPassCalls = callCount;
        assert.ok(firstPassCalls > 0);

        callCount = 0;
        await index.index(secondDoc, rootDir);
        assert.ok(callCount > 0);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe("SearchIndex fusion", () => {
    // Query vector fixed to match doc-x's vector exactly, so cosine similarity gives a clean,
    // predictable semantic ranking: X (cos=1, best) > Y (cos=0.5) > Z (cos=-1, worst).
    // Keyword coverage is arranged in the OPPOSITE order via real (unmocked) term-overlap
    // scoring against the query "alpha beta gamma": X has none of the terms, Y has one, Z has
    // the literal phrase — so X is best-semantic/worst-keyword and Z is the mirror image.
    async function buildFusionIndex() {
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-fusion-"));
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        return {
          embeddings: batch.map((text) => {
            if (text.includes("doc-x-marker")) return [1, 0, 0];
            if (text.includes("doc-y-marker")) return [0.5, 0.866, 0];
            if (text.includes("doc-z-marker")) return [-1, 0, 0];
            return [1, 0, 0]; // the query text itself
          }),
        };
      };
      const index = new SearchIndex();
      await index.index(
        [
          { path: "doc-x.ts", header: "doc-x-marker", symbols: [], content: "no query terms in this document at all" },
          { path: "doc-y.ts", header: "doc-y-marker", symbols: [], content: "mentions alpha but nothing else from the query" },
          { path: "doc-z.ts", header: "doc-z-marker", symbols: [], content: "literal alpha beta gamma phrase match" },
        ],
        rootDir,
      );
      return { index, rootDir };
    }

    it("keeps weighted fusion as an explicit opt-out", async () => {
      const originalEmbed = Ollama.prototype.embed;
      try {
        const { index, rootDir } = await buildFusionIndex();
        const results = await index.search("alpha beta gamma", { minCombinedScore: 0, fusion: "weighted" });
        const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
        assert.equal(results[0].path, "doc-x.ts");
        assert.equal(byPath["doc-x.ts"].keywordScore, 0);
        // X (semantic 100, keyword 0) and Z (semantic 0, keyword ~80) are mirror-image
        // extremes — each best in exactly one dimension. Weighted fusion's default
        // semantic-leaning weights (0.72/0.28) give X a large, clear lead over Z.
        assert.ok(byPath["doc-x.ts"].score - byPath["doc-z.ts"].score > 40);
        await rm(rootDir, { recursive: true, force: true });
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("uses RRF by default and hard-demotes zero-semantic collisions", async () => {
      const originalEmbed = Ollama.prototype.embed;
      try {
        const { index, rootDir } = await buildFusionIndex();
        const results = await index.search("alpha beta gamma", { minCombinedScore: 0 });
        const explicitRrf = await index.search("alpha beta gamma", { minCombinedScore: 0, fusion: "rrf" });
        const byPath = Object.fromEntries(results.map((r) => [r.path, r]));
        assert.deepEqual(results, explicitRrf);
        assert.equal(byPath["doc-z.ts"].semanticScore, 0);
        assert.ok(byPath["doc-z.ts"].score < 40);
        assert.ok(byPath["doc-z.ts"].score < byPath["doc-x.ts"].score);
        assert.ok(byPath["doc-z.ts"].score < byPath["doc-y.ts"].score);
        await rm(rootDir, { recursive: true, force: true });
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("does not let a weak lone semantic rank pass an absolute confidence threshold", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const rootDir = await mkdtemp(join(tmpdir(), "contextplus-weak-rrf-"));
      try {
        Ollama.prototype.embed = async function ({ input }) {
          const batch = Array.isArray(input) ? input : [input];
          return {
            embeddings: batch.map((text) => text.includes("weak-doc-marker")
              ? [0.16, Math.sqrt(1 - 0.16 ** 2), 0]
              : [1, 0, 0]),
          };
        };
        const index = new SearchIndex();
        await index.index([
          { path: "weak.ts", header: "weak-doc-marker", symbols: [], content: "unrelated corpus vocabulary" },
        ], rootDir);

        const permissive = await index.search("needle query", { minCombinedScore: 0 });
        const strict = await index.search("needle query", { minCombinedScore: 0.8 });
        assert.equal(permissive.length, 1);
        assert.ok(permissive[0].score < 20, `weak cosine must not display as 100%: ${permissive[0].score}`);
        assert.deepEqual(strict, []);
      } finally {
        Ollama.prototype.embed = originalEmbed;
        await rm(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe("fetchEmbedding", () => {
    it("splits failing batches and preserves embedding order", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const calls = [];
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        calls.push(batch.map((value) => value.length));
        if (batch.length > 1)
          throw new Error("the input length exceeds the context length");
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const inputs = ["alpha", "beta", "gamma", "delta", "epsilon"];
        const vectors = await fetchEmbedding(inputs);
        assert.deepEqual(vectors, [[5], [4], [5], [5], [7]]);
        assert.ok(calls.some((batch) => batch.length > 1));
        assert.ok(calls.some((batch) => batch.length === 1));
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("shrinks oversized single inputs until they fit context", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const seenLengths = [];
      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        seenLengths.push(batch[0].length);
        if (batch[0].length > 400)
          throw new Error("input length exceeds context length");
        return { embeddings: [[batch[0].length]] };
      };

      try {
        const vectors = await fetchEmbedding("x".repeat(2048));
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] <= 400);
        assert.ok(seenLengths.length > 1);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("splits oversized text into chunks and merges vectors", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const tailMarker = "__tail_marker__";
      const seenLengths = [];

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        for (const value of batch) {
          seenLengths.push(value.length);
          if (value.length > 8000)
            throw new Error("input length exceeds context length");
        }
        return {
          embeddings: batch.map((value) => [
            value.includes(tailMarker) ? 10 : 1,
          ]),
        };
      };

      try {
        const vectors = await fetchEmbedding(
          `${"a".repeat(9000)}${tailMarker}${"b".repeat(1000)}`,
        );
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] > 1);
        assert.ok(seenLengths.every((length) => length <= 8000));
        assert.ok(seenLengths.length > 1);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("keeps shrinking under strict context limits beyond eight retries", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const seenLengths = [];

      Ollama.prototype.embed = async function ({ input }) {
        const batch = Array.isArray(input) ? input : [input];
        seenLengths.push(...batch.map((value) => value.length));
        if (batch.some((value) => value.length > 20)) {
          throw new Error("input length exceeds context length");
        }
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const vectors = await fetchEmbedding("x".repeat(8000));
        assert.equal(vectors.length, 1);
        assert.ok(vectors[0][0] <= 20);
        assert.ok(seenLengths.length > 9);
      } finally {
        Ollama.prototype.embed = originalEmbed;
      }
    });

    it("forwards configured embed runtime options to Ollama", async () => {
      const originalEmbed = Ollama.prototype.embed;
      const previousEnv = {
        CONTEXTPLUS_EMBED_NUM_GPU: process.env.CONTEXTPLUS_EMBED_NUM_GPU,
        CONTEXTPLUS_EMBED_MAIN_GPU: process.env.CONTEXTPLUS_EMBED_MAIN_GPU,
        CONTEXTPLUS_EMBED_NUM_THREAD: process.env.CONTEXTPLUS_EMBED_NUM_THREAD,
        CONTEXTPLUS_EMBED_NUM_BATCH: process.env.CONTEXTPLUS_EMBED_NUM_BATCH,
        CONTEXTPLUS_EMBED_NUM_CTX: process.env.CONTEXTPLUS_EMBED_NUM_CTX,
        CONTEXTPLUS_EMBED_LOW_VRAM: process.env.CONTEXTPLUS_EMBED_LOW_VRAM,
      };
      const requests = [];

      process.env.CONTEXTPLUS_EMBED_NUM_GPU = "1";
      process.env.CONTEXTPLUS_EMBED_MAIN_GPU = "0";
      process.env.CONTEXTPLUS_EMBED_NUM_THREAD = "6";
      process.env.CONTEXTPLUS_EMBED_NUM_BATCH = "64";
      process.env.CONTEXTPLUS_EMBED_NUM_CTX = "4096";
      process.env.CONTEXTPLUS_EMBED_LOW_VRAM = "true";

      Ollama.prototype.embed = async function (request) {
        requests.push(request);
        const batch = Array.isArray(request.input)
          ? request.input
          : [request.input];
        return { embeddings: batch.map((value) => [value.length]) };
      };

      try {
        const vectors = await fetchEmbedding("gpu options probe");
        assert.equal(vectors.length, 1);
        assert.ok(requests.length > 0);
        assert.deepEqual(requests[0].options, {
          num_gpu: 1,
          main_gpu: 0,
          num_thread: 6,
          num_batch: 64,
          num_ctx: 4096,
          low_vram: true,
        });
      } finally {
        Ollama.prototype.embed = originalEmbed;
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });
});
