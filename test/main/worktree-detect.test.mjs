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

let baseRepo = "";
let worktreeDir = "";
let scratch = "";

describe("worktree detection", () => {
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "contextpro-worktree-")));
    baseRepo = join(scratch, "main");
    worktreeDir = join(scratch, "wt-feature");
    await execFileAsync("git", ["init", "-q", "-b", "main", baseRepo], { timeout: 8000 });
    await git(baseRepo, "config", "user.email", "t@t.dev");
    await git(baseRepo, "config", "user.name", "Tester");
    await writeFile(join(baseRepo, "file.txt"), "hello\n");
    await git(baseRepo, "add", ".");
    await git(baseRepo, "commit", "-q", "-m", "init");
    await git(baseRepo, "worktree", "add", "-q", worktreeDir, "-b", "feature");
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("detects the worktree toplevel and shared base root", async () => {
    const mod = await import("../../build/core/project-config.js");
    const info = await mod.detectWorktreeInfo(worktreeDir);
    assert.equal(info.isWorktree, true);
    assert.equal(info.worktreeRoot, worktreeDir);
    // base root is the main checkout that owns the shared .git
    assert.equal(info.baseRoot, baseRepo);
    assert.ok(info.gitCommonDir.endsWith(".git") || info.gitCommonDir.includes(".git"));
  });

  it("reports the main checkout as a non-worktree", async () => {
    const mod = await import("../../build/core/project-config.js");
    const info = await mod.detectWorktreeInfo(baseRepo);
    assert.equal(info.isWorktree, false);
    assert.equal(info.worktreeRoot, baseRepo);
    assert.equal(info.baseRoot, baseRepo);
  });

  it("falls back to the directory itself outside any git repo", async () => {
    const mod = await import("../../build/core/project-config.js");
    const nonGit = await realpath(await mkdtemp(join(tmpdir(), "contextpro-nongit-")));
    try {
      const info = await mod.detectWorktreeInfo(nonGit);
      assert.equal(info.isWorktree, false);
      assert.equal(info.baseRoot, nonGit);
      assert.equal(info.worktreeRoot, nonGit);
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });
});
