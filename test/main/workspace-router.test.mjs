import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, timeout: 8000 });
}

let scratch = "";
let baseRepo = "";
let worktreeDir = "";

describe("workspace-router", () => {
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "contextpro-router-")));
    baseRepo = join(scratch, "main");
    worktreeDir = join(scratch, "wt-x");
    await execFileAsync("git", ["init", "-q", "-b", "main", baseRepo], { timeout: 8000 });
    await git(baseRepo, "config", "user.email", "t@t.dev");
    await git(baseRepo, "config", "user.name", "Tester");
    await writeFile(join(baseRepo, "a.txt"), "a\n");
    await git(baseRepo, "add", ".");
    await git(baseRepo, "commit", "-q", "-m", "init");
    await git(baseRepo, "worktree", "add", "-q", worktreeDir, "-b", "x");
  });

  afterEach(async () => {
    const mod = await import("../../build/core/workspace-router.js");
    mod.resetWorkspaceRouter();
    await rm(scratch, { recursive: true, force: true });
  });

  it("resolves a worktree request to its own root plus shared base", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const ws = await mod.resolveWorkspace(worktreeDir);
    assert.equal(ws.rootDir, worktreeDir);
    assert.equal(ws.baseRoot, baseRepo);
    assert.equal(ws.isWorktree, true);
  });

  it("caches resolution so repeated calls return the same object", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const first = await mod.resolveWorkspace(worktreeDir);
    const second = await mod.resolveWorkspace(worktreeDir);
    assert.equal(first, second);
  });

  it("resolves the main checkout to itself as base", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const ws = await mod.resolveWorkspace(baseRepo);
    assert.equal(ws.rootDir, baseRepo);
    assert.equal(ws.baseRoot, baseRepo);
    assert.equal(ws.isWorktree, false);
  });

  it("falls back to the provided default root when request root is empty", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const ws = await mod.resolveWorkspace(undefined, baseRepo);
    assert.equal(ws.rootDir, baseRepo);
  });

  it("rejects an unsafe root", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const prev = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    await assert.rejects(() => mod.resolveWorkspace("/"), /Unsafe project root/);
    if (prev !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = prev;
  });

  it("lists active workspaces", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    await mod.resolveWorkspace(worktreeDir);
    await mod.resolveWorkspace(baseRepo);
    const roots = mod.listActiveWorkspaces().map((w) => w.rootDir).sort();
    assert.deepEqual(roots, [baseRepo, worktreeDir].sort());
  });
});
