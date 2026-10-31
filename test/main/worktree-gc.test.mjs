import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const git = (cwd, ...a) => execFileAsync("git", a, { cwd, timeout: 8000 });
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

let scratch = "";
let base = "";
let wt = "";

describe("dead worktree GC", () => {
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "contextpro-wtgc-")));
    base = join(scratch, "main");
    wt = join(scratch, "wt");
    await execFileAsync("git", ["init", "-q", "-b", "main", base], { timeout: 8000 });
    await git(base, "config", "user.email", "t@t.dev");
    await git(base, "config", "user.name", "T");
    await writeFile(join(base, "a.txt"), "a\n");
    await git(base, "add", ".");
    await git(base, "commit", "-q", "-m", "init");
    await git(base, "worktree", "add", "-q", wt, "-b", "feat");
  });

  afterEach(async () => {
    const router = await import("../../build/core/workspace-router.js");
    router.resetWorkspaceRouter();
    await rm(scratch, { recursive: true, force: true });
  });

  it("lists live worktrees from the base checkout", async () => {
    const mod = await import("../../build/core/worktree-gc.js");
    const live = await mod.listLiveWorktrees(base);
    const sorted = live.sort();
    assert.ok(sorted.includes(base));
    assert.ok(sorted.includes(wt));
  });

  it("removes the .contextpro dir of a pruned worktree", async () => {
    // Give the worktree an index dir, then physically remove the worktree + prune.
    const router = await import("../../build/core/workspace-router.js");
    await router.resolveWorkspace(wt, base);
    await writeFile(join(wt, ".contextpro-marker"), "x"); // untracked file: remove needs --force
    await git(base, "worktree", "remove", "--force", wt);
    await git(base, "worktree", "prune");

    const mod = await import("../../build/core/worktree-gc.js");
    const result = await mod.garbageCollectDeadWorktrees(base);
    assert.equal(result.removedWorkspaces, 1);
    assert.deepEqual(result.removedDirs, [join(wt, ".contextpro")]);
    assert.equal(result.error, undefined);
    // The router should no longer report the dead worktree.
    const stillKnown = router.listActiveWorkspaces().map((w) => w.rootDir);
    assert.ok(!stillKnown.includes(wt), `router still knows dead worktree ${wt}`);
  });

  it("never removes the base checkout", async () => {
    const router = await import("../../build/core/workspace-router.js");
    await router.resolveWorkspace(base, base);
    const mod = await import("../../build/core/worktree-gc.js");
    await mod.garbageCollectDeadWorktrees(base);
    assert.equal(await exists(base), true);
    assert.ok(router.listActiveWorkspaces().map((w) => w.rootDir).includes(base));
  });

  it("removes nothing when git cannot list worktrees", async () => {
    const router = await import("../../build/core/workspace-router.js");
    await router.resolveWorkspace(wt, base);
    await mkdir(join(wt, ".contextpro"), { recursive: true });
    await writeFile(join(wt, ".contextpro", "index.db"), "x");
    const mod = await import("../../build/core/worktree-gc.js");

    const emptyBin = await mkdtemp(join(scratch, "nogit-"));
    const savedPath = process.env.PATH;
    let result;
    try {
      process.env.PATH = emptyBin;
      result = await mod.garbageCollectDeadWorktrees(base);
    } finally {
      process.env.PATH = savedPath;
    }
    assert.ok(result.error, "expected an error when git is unavailable");
    assert.equal(result.removedWorkspaces, 0);
    assert.deepEqual(result.removedDirs, []);
    assert.equal(await exists(join(wt, ".contextpro", "index.db")), true);
    assert.ok(router.listActiveWorkspaces().map((w) => w.rootDir).includes(wt));
  });

  it("skips a worktree git no longer lists while its checkout still exists", async () => {
    const router = await import("../../build/core/workspace-router.js");
    await router.resolveWorkspace(wt, base);
    await mkdir(join(wt, ".contextpro"), { recursive: true });
    await writeFile(join(wt, ".contextpro", "index.db"), "x");
    await rm(join(base, ".git", "worktrees", "wt"), { recursive: true, force: true });
    assert.equal(await exists(join(wt, ".git")), true);

    const mod = await import("../../build/core/worktree-gc.js");
    const result = await mod.garbageCollectDeadWorktrees(base);
    assert.equal(result.removedWorkspaces, 0);
    assert.deepEqual(result.removedDirs, []);
    assert.equal(await exists(join(wt, ".contextpro", "index.db")), true);
    assert.ok(router.listActiveWorkspaces().map((w) => w.rootDir).includes(wt));
  });
});
