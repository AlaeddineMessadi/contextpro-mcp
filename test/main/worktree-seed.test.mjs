import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch = "";
let base = "";
let wt = "";

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

describe("worktree base-index seed", () => {
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "contextpro-seed-"));
    base = join(scratch, "main");
    wt = join(scratch, "wt");
    await mkdir(join(base, ".contextpro"), { recursive: true });
    await mkdir(wt, { recursive: true });
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(base);
    closeDB(wt);
    await rm(scratch, { recursive: true, force: true });
  });

  it("copies the base index.db into a fresh worktree", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(base);
    db.upsertFile("kept.ts", "hash", null, "typescript");
    const mod = await import("../../build/core/worktree-seed.js");
    const result = await mod.seedWorktreeFromBase(wt, base);
    assert.equal(result.seeded, true);
    assert.equal(await exists(join(wt, ".contextpro", "index.db")), true);
    assert.equal((await getDB(wt)).getFile("kept.ts").content_hash, "hash");
  });

  it("does not overwrite an existing worktree index", async () => {
    await writeFile(join(base, ".contextpro", "index.db"), "BASE");
    await mkdir(join(wt, ".contextpro"), { recursive: true });
    await writeFile(join(wt, ".contextpro", "index.db"), "WORKTREE_ALREADY");
    const mod = await import("../../build/core/worktree-seed.js");
    const result = await mod.seedWorktreeFromBase(wt, base);
    assert.equal(result.seeded, false);
    assert.equal(result.reason, "worktree-index-exists");
  });

  it("is a no-op when base and worktree are the same root", async () => {
    await writeFile(join(base, ".contextpro", "index.db"), "BASE");
    const mod = await import("../../build/core/worktree-seed.js");
    const result = await mod.seedWorktreeFromBase(base, base);
    assert.equal(result.seeded, false);
    assert.equal(result.reason, "same-root");
  });

  it("is a no-op when the base has no index yet", async () => {
    const mod = await import("../../build/core/worktree-seed.js");
    const result = await mod.seedWorktreeFromBase(wt, base);
    assert.equal(result.seeded, false);
    assert.equal(result.reason, "no-base-index");
  });
  it("includes uncheckpointed WAL state and clears a live base indexing lock", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { seedWorktreeFromBase } = await import("../../build/core/worktree-seed.js");
    const { waitForIndexingCompletion } = await import("../../build/tools/reindex.js");
    const db = await getDB(base);
    db.upsertFile("wal-only.ts", "committed", null, "typescript");
    db.setMetaBatch([
      ["index_status", "indexing"], ["index_owner_pid", String(process.pid)],
      ["index_started_at", String(Date.now())], ["extractor_stamp", "base-stamp"],
    ]);
    assert.equal((await seedWorktreeFromBase(wt, base)).seeded, true);
    const seeded = await getDB(wt);
    assert.equal(seeded.getFile("wal-only.ts").content_hash, "committed");
    assert.equal(seeded.getMeta("index_status"), "idle");
    assert.equal(seeded.getMeta("index_owner_pid"), "");
    assert.equal(seeded.getMeta("extractor_stamp"), "", "partial logical pass needs structural repair");
    assert.equal(db.getMeta("index_status"), "indexing", "base owner must remain untouched");
    assert.deepEqual(await waitForIndexingCompletion(wt, { timeoutMs: 500 }), { waited: false, timedOut: false });
  });

  it("publishes exactly one complete snapshot during simultaneous first requests", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { seedWorktreeFromBase } = await import("../../build/core/worktree-seed.js");
    const db = await getDB(base);
    for (let i = 0; i < 100; i++) db.upsertFile(`file${i}.ts`, `hash${i}`, null, "typescript");
    const results = await Promise.all(Array.from({ length: 8 }, () => seedWorktreeFromBase(wt, base)));
    assert.equal(results.filter((result) => result.seeded).length, 1);
    assert.ok(results.filter((result) => !result.seeded).every((result) => result.reason === "worktree-index-exists"));
    assert.equal((await getDB(wt)).getAllFiles().length, 100);
    assert.ok(!(await readdir(join(wt, ".contextpro"))).some((name) => name.startsWith(".seed-")));
  });

});
