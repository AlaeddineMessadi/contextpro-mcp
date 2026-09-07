// Schema-v5 migration remains safe for real v4 indexes and partial retries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("schema v5 migration", () => {
  it("adds file fingerprints and numeric efficiency columns to a v4 database", async () => {
    const root = await mkdtemp(join(tmpdir(), "contextpro-schema-v4-"));
    const dataDir = join(root, ".contextpro");
    await mkdir(dataDir, { recursive: true });
    const { loadNativeStorageBindings } = await import("../../build/core/db-native.js");
    const { Database } = loadNativeStorageBindings();
    const path = join(dataDir, "index.db");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('schema_version', '4');
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        content_hash TEXT NOT NULL,
        header TEXT,
        language TEXT,
        symbol_count INTEGER DEFAULT 0,
        last_indexed_at INTEGER NOT NULL,
        file_size INTEGER DEFAULT 0
      );
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        called_at INTEGER NOT NULL
      );
    `);
    raw.close();

    try {
      const { getDB, closeDB } = await import("../../build/core/db.js");
      const db = await getDB(root);
      assert.equal(db.getMeta("schema_version"), "7");
      closeDB(root);

      const migrated = new Database(path);
      const fileColumns = migrated.prepare("PRAGMA table_info(files)").all().map((row) => row.name);
      const callColumns = migrated.prepare("PRAGMA table_info(tool_calls)").all().map((row) => row.name);
      assert.ok(fileColumns.includes("file_mtime_ms"));
      assert.ok(fileColumns.includes("file_ctime_ms"));
      for (const column of ["input_tokens_est", "output_tokens_est", "source_tokens_est", "saved_tokens_est", "represented_files", "session_id"]) {
        assert.ok(callColumns.includes(column), `missing ${column}`);
      }
      migrated.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
