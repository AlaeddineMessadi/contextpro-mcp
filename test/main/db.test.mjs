import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

const FIXTURE_DIR = join(process.cwd(), "test", "_db_fixtures");

let ContextPlusDB, hashContent;

before(async () => {
  const mod = await import("../../build/core/db.js");
  ContextPlusDB = mod.ContextPlusDB;
  hashContent = mod.hashContent;
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(join(FIXTURE_DIR, ".contextpro"), { recursive: true });
});

after(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

describe("ContextPlusDB", () => {
  describe("file operations", () => {
    it("upserts and retrieves a file", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id = db.upsertFile("src/main.ts", "abc123", "// Main entry point", "typescript", 1024);
      assert.ok(id > 0);

      const file = db.getFile("src/main.ts");
      assert.ok(file);
      assert.equal(file.path, "src/main.ts");
      assert.equal(file.content_hash, "abc123");
      assert.equal(file.header, "// Main entry point");
      assert.equal(file.language, "typescript");
      assert.equal(file.file_size, 1024);
      db.close();
    });

    it("updates existing file on second upsert", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      db.upsertFile("src/app.ts", "hash1", "// App", "typescript");
      db.upsertFile("src/app.ts", "hash2", "// App v2", "typescript");

      const file = db.getFile("src/app.ts");
      assert.equal(file.content_hash, "hash2");
      assert.equal(file.header, "// App v2");
      db.close();
    });

    it("detects stale files", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      db.upsertFile("src/old.ts", "oldhash", null, "typescript");

      const currentHashes = new Map([["src/old.ts", "newhash"]]);
      const stale = db.getStaleFiles(currentHashes);
      assert.ok(stale.includes("src/old.ts"));
      db.close();
    });

    it("detects removed files", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      db.upsertFile("src/deleted.ts", "hash", null, "typescript");

      const currentPaths = new Set(["src/main.ts", "src/app.ts"]);
      const removed = db.getRemovedFiles(currentPaths);
      assert.ok(removed.includes("src/deleted.ts"));
      db.close();
    });

    it("deletes a file and its symbols/embeddings", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const fileId = db.upsertFile("src/todelete.ts", "hash", null, "typescript");
      db.upsertSymbols(fileId, [{ name: "foo", kind: "function", lineStart: 1 }]);
      db.upsertEmbedding("file", fileId, new Float32Array([0.1, 0.2, 0.3, 0.4]), "hash");

      db.deleteFile("src/todelete.ts");
      assert.equal(db.getFile("src/todelete.ts"), null);
      assert.equal(db.getSymbolsByFile(fileId).length, 0);
      db.close();
    });

    it("indexes and searches file text with FTS", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      db.upsertFileSearchDocument({
        path: "src/payments.ts",
        header: "Payment workflow",
        language: "typescript",
        symbols: [{ name: "capturePayment", kind: "function", signature: "function capturePayment()" }],
      });
      const results = db.searchFileText("payment capture", 5);
      assert.ok(results.some((result) => result.path === "src/payments.ts"));
      db.deleteFileSearchDocument("src/payments.ts");
      assert.equal(db.searchFileText("payment capture", 5).length, 0);
      db.close();
    });

    it("verifies literal punctuation and morphology before limiting FTS candidates", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      try {
        for (let i = 0; i < 45; i++) db.upsertFileSearchDocument({path:`caller-${i}.ts`,content:'document.text.repair'});
        db.upsertFileSearchDocument({path:'repair.sql',content:'-- padding\n'.repeat(60) + 'document_text_repairs'});
        assert.deepEqual(db.searchFileText('document_text_repairs',1,true).map(row=>row.path), ['repair.sql']);
        assert.ok(db.searchFileText('document.text.repair',50,true).every(row=>row.path !== 'repair.sql'));
        db.upsertFileSearchDocument({path:'literal.ts',content:'ÉCLAIR to be'});
        assert.deepEqual(db.searchFileText('e\u0301clair',1,true).map(row=>row.path), ['literal.ts']);
        assert.deepEqual(db.searchFileText('to be',1,true).map(row=>row.path), ['literal.ts']);
      } finally {
        for (let i = 0; i < 45; i++) db.deleteFileSearchDocument(`caller-${i}.ts`);
        db.deleteFileSearchDocument('repair.sql'); db.deleteFileSearchDocument('literal.ts'); db.close();
      }
    });
  });

  describe("symbol operations", () => {
    it("upserts and retrieves symbols for a file", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const fileId = db.upsertFile("src/utils.ts", "hash", null, "typescript");
      db.upsertSymbols(fileId, [
        { name: "add", kind: "function", lineStart: 1, lineEnd: 5, signature: "function add(a: number, b: number): number" },
        { name: "subtract", kind: "function", lineStart: 7, lineEnd: 11 },
      ]);

      const symbols = db.getSymbolsByFile(fileId);
      assert.equal(symbols.length, 2);
      assert.equal(symbols[0].name, "add");
      assert.equal(symbols[0].kind, "function");
      assert.equal(symbols[0].line_start, 1);
      assert.equal(symbols[0].line_end, 5);
      db.close();
    });

    it("searches symbols by name", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const results = db.searchSymbolsByName("add");
      assert.ok(results.length > 0);
      assert.ok(results.some((s) => s.name === "add"));
      db.close();
    });

    it("replaces symbols on re-upsert", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const fileId = db.upsertFile("src/replace.ts", "hash", null, "typescript");
      db.upsertSymbols(fileId, [{ name: "old", kind: "function", lineStart: 1 }]);
      db.upsertSymbols(fileId, [{ name: "new", kind: "function", lineStart: 1 }]);

      const symbols = db.getSymbolsByFile(fileId);
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].name, "new");
      db.close();
    });
  });

  describe("embedding operations", () => {
    it("upserts and searches embeddings", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const fileId = db.upsertFile("src/embed.ts", "hash", null, "typescript");
      db.upsertEmbedding("file", fileId, [1.0, 0.0, 0.0, 0.0], "hash1");

      const fileId2 = db.upsertFile("src/embed2.ts", "hash", null, "typescript");
      db.upsertEmbedding("file", fileId2, [0.0, 1.0, 0.0, 0.0], "hash2");

      const results = db.searchEmbeddings([0.9, 0.1, 0.0, 0.0], 5, "file");
      assert.ok(results.length >= 1);
      assert.equal(results[0].sourceType, "file");
      assert.ok(results[0].distance < results[results.length - 1].distance);
      db.close();
    });

    it("replaces embedding on re-upsert", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const fileId = db.upsertFile("src/reembed.ts", "hash", null, "typescript");
      db.upsertEmbedding("file", fileId, [1.0, 0.0, 0.0, 0.0], "hash1");
      db.upsertEmbedding("file", fileId, [0.0, 1.0, 0.0, 0.0], "hash2");

      const hash = db.getEmbeddingHash("file", fileId);
      assert.equal(hash, "hash2");
      db.close();
    });

    it("clears incompatible vectors when the provider or model changes", async () => {
      const root = await mkdtemp(join(tmpdir(), "contextpro-db-model-change-"));
      await mkdir(join(root, ".contextpro"), { recursive: true });
      const db = new ContextPlusDB(root);
      try {
        db.recordEmbeddingProvider("ollama", "model-a");
        db.upsertEmbedding("file_search", "src/a.ts", [1, 0, 0, 0], "hash");
        db.upsertMemoryNode({ type: "note", label: "old-space", content: "old vector space" }, [1, 0, 0, 0]);

        db.recordEmbeddingProvider("ollama", "model-b");

        assert.equal(db.getEmbeddingsByType("file_search").length, 0);
        assert.equal(db.getEmbeddingStats().memory, 0);
        assert.deepEqual(db.isEmbeddingsStale(), {
          stale: true,
          reason: "provider/model changed from ollama/model-a to ollama/model-b",
        });
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });

    it("returns empty embedding results when vec metadata exists but tables are missing", async () => {
      const root = await mkdtemp(join(tmpdir(), "contextpro-db-missing-vec-"));
      await mkdir(join(root, ".contextpro"), { recursive: true });
      const db = new ContextPlusDB(root);
      try {
        db.upsertEmbedding("file", "orphaned", [1, 0, 0, 0], "hash");
        db.db.exec("DROP TABLE embeddings");
        db.db.exec("DROP TABLE memory_embeddings");
        assert.deepEqual(db.searchEmbeddings([1, 0, 0, 0], 5, "file"), []);
      } finally {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe("memory graph operations", () => {
    it("creates and retrieves a memory node", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id = db.upsertMemoryNode(
        { type: "concept", label: "auth", content: "Authentication system" },
        [0.5, 0.5, 0.0, 0.0],
      );
      assert.ok(id.startsWith("node-"));

      const node = db.getMemoryNode(id);
      assert.ok(node);
      assert.equal(node.type, "concept");
      assert.equal(node.label, "auth");
      db.close();
    });

    it("stores memory nodes without vector tables when embedding is unavailable", () => {
      return (async () => {
        const root = await mkdtemp(join(tmpdir(), "contextpro-db-no-vectors-"));
        await mkdir(join(root, ".contextpro"), { recursive: true });
        const db = new ContextPlusDB(root);
        try {
          const id = db.upsertMemoryNode({ type: "note", label: "offline-memory", content: "Stored without embedding" }, []);
          const node = db.getMemoryNode(id);
          assert.ok(node);
          assert.equal(node.label, "offline-memory");
          assert.equal(db.getEmbeddingStats().vectorTablesReady, false);
        } finally {
          db.close();
          await rm(root, { recursive: true, force: true });
        }
      })();
    });

    it("updates existing node with same label+type", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id1 = db.upsertMemoryNode({ type: "concept", label: "auth", content: "v1" }, [0.5, 0.5, 0.0, 0.0]);
      const id2 = db.upsertMemoryNode({ type: "concept", label: "auth", content: "v2" }, [0.6, 0.4, 0.0, 0.0]);
      assert.equal(id1, id2);

      const node = db.getMemoryNode(id1);
      assert.equal(node.content, "v2");
      db.close();
    });

    it("creates edges between nodes", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id1 = db.upsertMemoryNode({ type: "concept", label: "login", content: "Login flow" }, [0.1, 0.9, 0.0, 0.0]);
      const id2 = db.upsertMemoryNode({ type: "concept", label: "session", content: "Session management" }, [0.2, 0.8, 0.0, 0.0]);

      const edgeId = db.upsertMemoryEdge({ source: id1, target: id2, relation: "depends_on" });
      assert.ok(edgeId.startsWith("edge-"));
      db.close();
    });

    it("searches memory nodes by vector", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const results = db.searchMemoryNodes([0.5, 0.5, 0.0, 0.0], 3);
      assert.ok(results.length > 0);
      assert.ok(results[0].node);
      assert.ok(typeof results[0].distance === "number");
      db.close();
    });

    it("traverses neighbors from a node", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id1 = db.upsertMemoryNode({ type: "concept", label: "root", content: "Root node" });
      const id2 = db.upsertMemoryNode({ type: "concept", label: "child1", content: "Child 1" });
      const id3 = db.upsertMemoryNode({ type: "concept", label: "child2", content: "Child 2" });
      db.upsertMemoryEdge({ source: id1, target: id2, relation: "contains" });
      db.upsertMemoryEdge({ source: id1, target: id3, relation: "contains" });

      const results = db.getNeighbors(id1, 1);
      assert.ok(results.length >= 3);
      assert.equal(results[0].depth, 0);
      assert.ok(results.some((r) => r.depth === 1));
      db.close();
    });

    it("prunes stale edges", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id1 = db.upsertMemoryNode({ type: "note", label: "stale1", content: "Old note" });
      const id2 = db.upsertMemoryNode({ type: "note", label: "stale2", content: "Old note 2" });

      db.db.prepare("INSERT INTO memory_edges (id, source, target, relation, weight, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("old-edge", id1, id2, "relates_to", 0.01, Date.now() - 365 * 86_400_000, "{}");

      const { edgesRemoved } = db.pruneStaleEdges(0.15);
      assert.ok(edgesRemoved >= 1);
      db.close();
    });

    it("deletes memory nodes and their embeddings", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const id = db.upsertMemoryNode({ type: "note", label: "deleteme", content: "To be deleted" }, [0.1, 0.1, 0.1, 0.1]);
      db.deleteMemoryNode(id);
      assert.equal(db.getMemoryNode(id), null);
      db.close();
    });
  });

  describe("meta operations", () => {
    it("gets and sets meta values", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      db.setMeta("test_key", "test_value");
      assert.equal(db.getMeta("test_key"), "test_value");
      assert.equal(db.getMeta("nonexistent"), null);
      db.close();
    });
  });

  describe("hashContent", () => {
    it("returns consistent SHA-256 hashes", () => {
      const h1 = hashContent("hello world");
      const h2 = hashContent("hello world");
      assert.equal(h1, h2);
      assert.equal(h1.length, 16);
    });

    it("returns different hashes for different content", () => {
      const h1 = hashContent("hello");
      const h2 = hashContent("world");
      assert.notEqual(h1, h2);
    });
  });

  describe("graph stats", () => {
    it("returns node and edge counts", () => {
      const db = new ContextPlusDB(FIXTURE_DIR);
      const stats = db.getGraphStats();
      assert.ok(stats.totalNodes >= 0);
      assert.ok(stats.totalEdges >= 0);
      db.close();
    });
  });
});
