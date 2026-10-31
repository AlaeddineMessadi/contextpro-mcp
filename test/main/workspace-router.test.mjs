import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd, timeout: 8000 });
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

const noUnsafeOverride = { CONTEXTPRO_ALLOW_UNSAFE_ROOT: undefined, CONTEXTPLUS_ALLOW_UNSAFE_ROOT: undefined };

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

  it("uses the startup identity for a symlinked non-Git project", async () => {
    const mod = await import('../../build/core/workspace-router.js');
    const project = join(scratch,'plain');
    const alias = join(scratch,'alias');
    await mkdir(project);
    await symlink(project,alias,'dir');
    const first = await mod.resolveWorkspace(alias);
    assert.equal(first.rootDir,project);
    assert.equal(first.baseRoot,project);
    assert.equal(await mod.resolveWorkspace(project),first);
    assert.equal(mod.listActiveWorkspaces().length,1);
    mod.forgetWorkspace(alias);
    assert.equal(mod.listActiveWorkspaces().length,0);
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
  it("errors on a missing root, including the boot-root default", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const ghost = join(scratch, "ghost");
    await assert.rejects(() => mod.resolveWorkspace(ghost), /does not exist or is not a directory/);
    await assert.rejects(() => mod.resolveWorkspace(undefined, ghost), /does not exist or is not a directory/);
    await assert.rejects(() => stat(ghost), { code: "ENOENT" });
  });

  it("errors on a root deleted after its first resolution and does not recreate it", async () => {
    const mod = await import("../../build/core/workspace-router.js");
    const project = join(scratch, "plain");
    await mkdir(project);
    await mod.resolveWorkspace(project);
    await rm(project, { recursive: true });
    await assert.rejects(() => mod.resolveWorkspace(project), /does not exist or is not a directory/);
    await assert.rejects(() => stat(join(project, ".contextpro")), { code: "ENOENT" });
    assert.equal(mod.listActiveWorkspaces().length, 0);
  });

  describe("roots that Git widens to its toplevel", { skip: process.platform === "win32" }, () => {
    it("throws, not narrows, when the toplevel is the home folder", async () => {
      const mod = await import("../../build/core/workspace-router.js");
      const home = join(scratch, "home");
      const deep = join(home, "a", "b");
      await mkdir(deep, { recursive: true });
      await execFileAsync("git", ["init", "-q", "-b", "main", home], { timeout: 8000 });
      await withEnv({ HOME: home, GIT_CEILING_DIRECTORIES: undefined, ...noUnsafeOverride }, async () => {
        await assert.rejects(() => mod.resolveWorkspace(deep), (error) => {
          assert.match(error.message, new RegExp(`widened from ${deep} to its Git toplevel ${home}`));
          assert.match(error.message, /Unsafe project root/);
          return true;
        });
        await assert.rejects(() => stat(join(home, ".contextpro", "config.json")), { code: "ENOENT" });
        assert.equal(mod.listActiveWorkspaces().length, 0);
      });
      await withEnv({ HOME: home, GIT_CEILING_DIRECTORIES: undefined, CONTEXTPRO_ALLOW_UNSAFE_ROOT: "true" }, async () => {
        assert.equal((await mod.resolveWorkspace(deep)).rootDir, home);
      });
    });

    it("still resolves a request inside a repository directly under the home folder", async () => {
      const mod = await import("../../build/core/workspace-router.js");
      const home = join(scratch, "home");
      const proj = join(home, "proj");
      const sub = join(proj, "sub");
      await mkdir(sub, { recursive: true });
      await execFileAsync("git", ["init", "-q", "-b", "main", proj], { timeout: 8000 });
      await withEnv({ HOME: home, ...noUnsafeOverride }, async () => {
        assert.equal((await mod.resolveWorkspace(sub)).rootDir, proj);
      });
    });
  });
});
