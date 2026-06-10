import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";

describe("path guard", () => {
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
