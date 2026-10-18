import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("path guard", () => {
  it("accepts absolute root aliases without losing relative names or symlink safety", async () => {
    const { resolveProjectPath, toProjectRelativePath } = await import("../../build/core/path-guard.js");
    const { assertMutationPath } = await import("../../build/core/source-mutation.js");
    const sandbox = await realpath(await mkdtemp(join(tmpdir(), "contextpro-root-alias-")));
    const root = join(sandbox, "root"), alias = join(sandbox, "alias"), outside = join(sandbox, "outside");
    try {
      await mkdir(root); await mkdir(outside);
      await symlink(root, alias, "junction");
      await writeFile(join(root, "code.ts"), "export const value = 1;");
      await symlink(join(root, "code.ts"), join(root, "inner.ts"));
      await symlink(root, join(root, "loop"), "junction");
      await symlink(outside, join(root, "escape"), "junction");
      await symlink(join(root, "code.ts"), join(outside, "back.ts"));
      for (const [selectedRoot, inputRoot] of [[root, alias], [alias, root]]) {
        assert.equal(resolveProjectPath(selectedRoot, join(inputRoot, "code.ts")), join(selectedRoot, "code.ts"));
        assert.equal(toProjectRelativePath(selectedRoot, join(inputRoot, "code.ts")), "code.ts");
        assert.equal(toProjectRelativePath(selectedRoot, join(inputRoot, "new", "code.ts")), "new/code.ts");
        assert.equal(resolveProjectPath(selectedRoot, join(inputRoot, "inner.ts")), join(selectedRoot, "inner.ts"));
        assert.throws(() => assertMutationPath(selectedRoot, join(inputRoot, "inner.ts")), /refuses symlink/);
        assert.equal(toProjectRelativePath(selectedRoot, join(inputRoot, "loop", "code.ts")), "loop/code.ts");
        assert.throws(() => assertMutationPath(selectedRoot, join(inputRoot, "loop", "code.ts")), /refuses symlink/);
        assert.throws(() => resolveProjectPath(selectedRoot, join(inputRoot, "escape", "new.ts")), /escapes project root/);
        assert.throws(() => resolveProjectPath(selectedRoot, "../outside/back.ts"), /escapes project root/);
        assert.throws(() => resolveProjectPath(selectedRoot, join(outside, "back.ts")), /escapes project root/);
      }
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });

  it("resolves relative paths inside the project root", async () => {
    const mod = await import("../../build/core/path-guard.js");
    const root = join(process.cwd(), "test", "_path_guard_root");
    assert.equal(mod.resolveProjectPath(root, "src/app.ts"), join(root, "src", "app.ts"));
  });

  it("allows absolute paths when they stay inside the project root", async () => {
    const mod = await import("../../build/core/path-guard.js");
    const root = join(process.cwd(), "test", "_path_guard_root");
    const inside = join(root, "src", "app.ts");
    assert.equal(mod.resolveProjectPath(root, inside), inside);
  });

  it("rejects paths that escape the project root", async () => {
    const mod = await import("../../build/core/path-guard.js");
    const root = join(process.cwd(), "test", "_path_guard_root");
    assert.throws(() => mod.resolveProjectPath(root, "../outside.txt"), /Path escapes project root/);
    assert.throws(() => mod.resolveProjectPath(root, "/tmp/outside.txt"), /Path escapes project root/);
  });

  it("normalizes safe paths to portable relative paths", async () => {
    const mod = await import("../../build/core/path-guard.js");
    const root = join(process.cwd(), "test", "_path_guard_root");
    assert.equal(mod.toProjectRelativePath(root, "./src/../src/app.ts"), "src/app.ts");
  });
});
