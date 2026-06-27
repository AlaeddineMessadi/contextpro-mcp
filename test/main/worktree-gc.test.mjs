import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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
    await writeFile(join(wt, ".contextpro-marker"), "x"); // ensure dir is tracked
    await rm(wt, { recursive: true, force: true });
    await git(base, "worktree", "prune");

    const mod = await import("../../build/core/worktree-gc.js");
    const result = await mod.garbageCollectDeadWorktrees(base);
    assert.ok(result.removedWorkspaces >= 0);
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
});
