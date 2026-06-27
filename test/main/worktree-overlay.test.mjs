import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const git = (cwd, ...a) => execFileAsync("git", a, { cwd, timeout: 8000 });

let scratch = "";
let base = "";
let wt = "";

describe("worktree overlay diff-set", () => {
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "contextpro-overlay-")));
    base = join(scratch, "main");
    wt = join(scratch, "wt");
    await execFileAsync("git", ["init", "-q", "-b", "main", base], { timeout: 8000 });
    await git(base, "config", "user.email", "t@t.dev");
    await git(base, "config", "user.name", "T");
    await writeFile(join(base, "shared.ts"), "export const shared = 1;\n");
    await writeFile(join(base, "edit_me.ts"), "export const before = 1;\n");
    await git(base, "add", ".");
    await git(base, "commit", "-q", "-m", "init");
    await git(base, "worktree", "add", "-q", wt, "-b", "feat");
  });

  afterEach(async () => {
    const router = await import("../../build/core/workspace-router.js");
    router.resetWorkspaceRouter();
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns an empty diff set for a pristine worktree", async () => {
    const mod = await import("../../build/core/worktree-overlay.js");
    const set = await mod.computeWorktreeDiffSet(wt, base);
    assert.deepEqual(set.changed, []);
    assert.deepEqual(set.added, []);
  });

  it("detects an uncommitted edit to a committed file", async () => {
    await writeFile(join(wt, "edit_me.ts"), "export const after = 2;\n");
    const mod = await import("../../build/core/worktree-overlay.js");
    const set = await mod.computeWorktreeDiffSet(wt, base);
    assert.ok(set.changed.includes("edit_me.ts"), `expected edit_me.ts in ${JSON.stringify(set.changed)}`);
  });

  it("detects a brand-new untracked file in the worktree", async () => {
    await writeFile(join(wt, "new_file.ts"), "export const fresh = 3;\n");
    const mod = await import("../../build/core/worktree-overlay.js");
    const set = await mod.computeWorktreeDiffSet(wt, base);
    assert.ok(set.added.includes("new_file.ts"), `expected new_file.ts in ${JSON.stringify(set.added)}`);
  });

  it("detects committed-on-branch divergence from base", async () => {
    await writeFile(join(wt, "shared.ts"), "export const shared = 99;\n");
    await git(wt, "add", ".");
    await git(wt, "commit", "-q", "-m", "branch change");
    const mod = await import("../../build/core/worktree-overlay.js");
    const set = await mod.computeWorktreeDiffSet(wt, base);
    assert.ok(
      set.changed.includes("shared.ts") || set.added.includes("shared.ts"),
      `expected shared.ts divergence in ${JSON.stringify(set)}`,
    );
  });

  it("reports the union of all overlay files via overlayFiles()", async () => {
    await writeFile(join(wt, "edit_me.ts"), "export const after = 2;\n");
    await writeFile(join(wt, "new_file.ts"), "export const fresh = 3;\n");
    const mod = await import("../../build/core/worktree-overlay.js");
    const set = await mod.computeWorktreeDiffSet(wt, base);
    const files = mod.overlayFiles(set).sort();
    assert.deepEqual(files, ["edit_me.ts", "new_file.ts"].sort());
  });
});
