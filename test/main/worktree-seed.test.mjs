import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    await rm(scratch, { recursive: true, force: true });
  });

  it("copies the base index.db into a fresh worktree", async () => {
    await writeFile(join(base, ".contextpro", "index.db"), "BASEDBCONTENT");
    const mod = await import("../../build/core/worktree-seed.js");
    const result = await mod.seedWorktreeFromBase(wt, base);
    assert.equal(result.seeded, true);
    assert.equal(await exists(join(wt, ".contextpro", "index.db")), true);
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
});
