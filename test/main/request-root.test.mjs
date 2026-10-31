import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
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

describe("request-root resolution", () => {
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "contextpro-reqroot-")));
    baseRepo = join(scratch, "main");
    worktreeDir = join(scratch, "wt");
    await execFileAsync("git", ["init", "-q", "-b", "main", baseRepo], { timeout: 8000 });
    await git(baseRepo, "config", "user.email", "t@t.dev");
    await git(baseRepo, "config", "user.name", "Tester");
    await writeFile(join(baseRepo, "a.txt"), "a\n");
    await git(baseRepo, "add", ".");
    await git(baseRepo, "commit", "-q", "-m", "init");
    await git(baseRepo, "worktree", "add", "-q", worktreeDir, "-b", "wt");
  });

  afterEach(async () => {
    const router = await import("../../build/core/workspace-router.js");
    router.resetWorkspaceRouter();
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(baseRepo);
    closeDB(worktreeDir);
    await rm(scratch, { recursive: true, force: true });
  });

  it("rejects an omitted root when the shared MCP could target another worktree", async () => {
    const mod = await import("../../build/core/request-root.js");
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo), (error) => {
      assert.match(error.message, /Ambiguous worktree/);
      assert.match(error.message, /Pass root as the absolute directory/);
      assert.ok(error.message.includes(baseRepo));
      assert.ok(error.message.includes(worktreeDir));
      return true;
    });
  });

  it("rejects a relative per-call root instead of resolving it against the server cwd", async () => {
    const mod = await import("../../build/core/request-root.js");
    for (const root of [".", "../wt", "wt", "~/x"]) {
      await assert.rejects(() => mod.resolveRequestRoot({ root }, baseRepo), (error) => {
        assert.match(error.message, /root must be an absolute path/);
        assert.ok(error.message.includes(root));
        return true;
      });
    }
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo), /Ambiguous worktree/);
  });

  it("errors on a missing root and creates nothing there", async () => {
    const mod = await import("../../build/core/request-root.js");
    const ghost = join(scratch, "ghost");
    await assert.rejects(() => mod.resolveRequestRoot({ root: ghost }, baseRepo), /does not exist or is not a directory/);
    await assert.rejects(() => stat(ghost), { code: "ENOENT" });
  });

  it("errors on a client root whose directory is missing", async () => {
    const mod = await import("../../build/core/request-root.js");
    const ghost = join(scratch, "ghost");
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo, {
      rootsProvider: async () => [new URL(`file://${ghost}`).href],
    }), /does not exist or is not a directory/);
    await assert.rejects(() => stat(ghost), { code: "ENOENT" });
  });

  it("errors on a Windows-style client root URI on non-Windows hosts", { skip: process.platform === "win32" }, async () => {
    const mod = await import("../../build/core/request-root.js");
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo, {
      rootsProvider: async () => ["file:///c%3A/x"],
    }), /does not exist or is not a directory/);
  });

  it("routes an explicit root arg to the worktree workspace", async () => {
    const mod = await import("../../build/core/request-root.js");
    const ws = await mod.resolveRequestRoot({ root: worktreeDir }, baseRepo);
    assert.equal(ws.rootDir, worktreeDir);
    assert.equal(ws.isWorktree, true);
  });

  it("strips the root arg from forwarded handler args", async () => {
    const mod = await import("../../build/core/request-root.js");
    const { handlerArgs } = await mod.resolveRequestRoot({ root: worktreeDir, file: "x.ts" }, baseRepo);
    assert.equal(handlerArgs.root, undefined);
    assert.equal(handlerArgs.file, "x.ts");
  });

  it("allows an explicit main-checkout root despite another worktree", async () => {
    const mod = await import("../../build/core/request-root.js");
    const ws = await mod.resolveRequestRoot({ root: baseRepo }, worktreeDir);
    assert.equal(ws.rootDir, baseRepo);
  });

  it("rejects omitted roots for linked checkouts backed by a separate Git directory", async () => {
    const mod = await import("../../build/core/request-root.js");
    const separateMain = join(scratch, "separate-main");
    const separateChild = join(scratch, "separate-child");
    await git(scratch, "init", "-q", "-b", "main", "--separate-git-dir", join(scratch, "store.git"), separateMain);
    await git(separateMain, "config", "user.email", "t@t.dev");
    await git(separateMain, "config", "user.name", "Tester");
    await writeFile(join(separateMain, "a.txt"), "a\n");
    await git(separateMain, "add", ".");
    await git(separateMain, "commit", "-q", "-m", "init");
    await git(separateMain, "worktree", "add", "-q", separateChild, "-b", "child");
    await assert.rejects(() => mod.resolveRequestRoot({}, separateChild), /Ambiguous worktree/);
    assert.equal((await mod.resolveRequestRoot({ root: separateChild }, separateMain)).rootDir, separateChild);
    await assert.rejects(() => mod.resolveRequestRoot({}, separateChild), /Ambiguous worktree/, "cached explicit routing must not bypass later validation");
  });

  it("rejects an ambiguous root before copying the base index into the guessed checkout", async () => {
    const mod = await import("../../build/core/request-root.js");
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(baseRepo);
    db.upsertFile("a.txt", "base-hash", null, "text");
    await assert.rejects(() => mod.resolveRequestRoot({}, worktreeDir), /Ambiguous worktree/);
    await assert.rejects(() => stat(join(worktreeDir, ".contextpro")), { code: "ENOENT" });
    await mod.resolveRequestRoot({ root: worktreeDir }, baseRepo);
    assert.equal((await stat(join(worktreeDir, ".contextpro", "index.db"))).isFile(), true);
  });

  it("does not trust a client's root list to identify a shared-connection subagent", async () => {
    const mod = await import("../../build/core/request-root.js");
    for (const uris of [[baseRepo], [worktreeDir], [baseRepo, worktreeDir]]) {
      await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo, {
        rootsProvider: async () => uris.map((root) => new URL(`file://${root}`).href),
        requestCwd: baseRepo,
      }), /Ambiguous worktree/);
    }
  });

  it("detects added and removed worktrees while the workspace resolution remains cached", async () => {
    const mod = await import("../../build/core/request-root.js");
    await git(baseRepo, "worktree", "remove", worktreeDir);
    assert.equal((await mod.resolveRequestRoot({}, baseRepo)).rootDir, baseRepo);
    await git(baseRepo, "worktree", "add", "-q", worktreeDir, "wt");
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo), /Ambiguous worktree/);
    await git(baseRepo, "worktree", "remove", worktreeDir);
    assert.equal((await mod.resolveRequestRoot({}, baseRepo)).rootDir, baseRepo);
  });

  it("ignores stale Git registry entries whose checkout was removed manually", async () => {
    const mod = await import("../../build/core/request-root.js");
    await rm(worktreeDir, { recursive: true, force: true });
    assert.equal((await mod.resolveRequestRoot({}, baseRepo)).rootDir, baseRepo);
  });

  it("retains no-root behavior for a non-Git directory", async () => {
    const mod = await import("../../build/core/request-root.js");
    const plain = join(scratch, "plain");
    await mkdir(plain);
    assert.equal((await mod.resolveRequestRoot({}, plain)).rootDir, plain);
  });

  it("bounds diagnostics and work when the registry is too large to verify", async () => {
    const mod = await import("../../build/core/request-root.js");
    await git(baseRepo, "worktree", "remove", worktreeDir);
    for (let i = 0; i < 66; i++) await mkdir(join(baseRepo, ".git", "worktrees", `stale-${i}`), { recursive: true });
    await assert.rejects(() => mod.resolveRequestRoot({}, baseRepo), (error) => {
      assert.match(error.message, /unverified linked worktrees/);
      assert.ok(error.message.length < 1600);
      return true;
    });
    // Explicit routing needs no registry enumeration, even when it is malformed.
    assert.equal((await mod.resolveRequestRoot({ root: baseRepo }, baseRepo)).rootDir, baseRepo);
  });

  it("ignores a root arg that escapes into an unsafe location", async () => {
    const mod = await import("../../build/core/request-root.js");
    const prev = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    await assert.rejects(() => mod.resolveRequestRoot({ root: "/" }, baseRepo), /Unsafe project root/);
    if (prev !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = prev;
  });
});
