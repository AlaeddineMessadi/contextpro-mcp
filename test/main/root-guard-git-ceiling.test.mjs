import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Own process: root-guard.js sets GIT_CEILING_DIRECTORIES from homedir() when it is first imported.
const home = realpathSync(mkdtempSync(join(tmpdir(), "contextpro-dotfiles-home-")));
const previous = { HOME: process.env.HOME, ceiling: process.env.GIT_CEILING_DIRECTORIES, allow: process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT };

describe("root guard git ceiling", () => {
  before(async () => {
    for (const dir of [join(home, "a", "b"), join(home, "proj", "sub")]) mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", home]);
    execFileSync("git", ["init", "-q", join(home, "proj")]);
    process.env.HOME = home;
    process.env.GIT_CEILING_DIRECTORIES = "/existing/ceiling";
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    await import("../../build/core/root-guard.js");
  });

  after(() => {
    for (const [key, value] of [["HOME", previous.HOME], ["GIT_CEILING_DIRECTORIES", previous.ceiling], ["CONTEXTPRO_ALLOW_UNSAFE_ROOT", previous.allow]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("appends home to an existing ceiling without duplicating it", async () => {
    assert.equal(process.env.GIT_CEILING_DIRECTORIES, `/existing/ceiling${delimiter}${home}`);
    await import("../../build/core/root-guard.js?reload");
    assert.equal(process.env.GIT_CEILING_DIRECTORIES, `/existing/ceiling${delimiter}${home}`);
  });

  it("does not widen a non-repo folder below a dotfiles home to home", async () => {
    const { detectWorktreeInfo } = await import("../../build/core/project-config.js");
    const info = await detectWorktreeInfo(join(home, "a", "b"));
    assert.equal(info.worktreeRoot, join(home, "a", "b"));
    assert.equal(info.isWorktree, false);
  });

  it("still finds a repo below home from its subfolder", async () => {
    const { detectWorktreeInfo } = await import("../../build/core/project-config.js");
    assert.equal((await detectWorktreeInfo(join(home, "proj", "sub"))).worktreeRoot, join(home, "proj"));
  });
});
