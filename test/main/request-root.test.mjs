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
    await rm(scratch, { recursive: true, force: true });
  });

  it("uses the default root when no root arg is present", async () => {
    const mod = await import("../../build/core/request-root.js");
    const ws = await mod.resolveRequestRoot({}, baseRepo);
    assert.equal(ws.rootDir, baseRepo);
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

  it("ignores a root arg that escapes into an unsafe location", async () => {
    const mod = await import("../../build/core/request-root.js");
    const prev = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    await assert.rejects(() => mod.resolveRequestRoot({ root: "/" }, baseRepo), /Unsafe project root/);
    if (prev !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = prev;
  });
});
