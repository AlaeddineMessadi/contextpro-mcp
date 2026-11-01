import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("agent instructions", () => {
  it("keeps manifest instructions tiny because clients may repeat them per tool", async () => {
    const manifest = await readFile(join(process.cwd(), "agent-instructions.md"), "utf8");
    assert.ok(Buffer.byteLength(manifest) <= 400);
    for (const required of ["context", "search", "explain", "discover_tools", "root", "contextpro://instructions"]) {
      assert.match(manifest, new RegExp(`\\b${required}\\b`));
    }
  });

  it("tells agents when to omit root and to always pass it from a subagent", async () => {
    const { CONTEXTPRO_PROJECT_INSTRUCTIONS: block } = await import("../../build/core/agent-setup.js");
    const texts = await Promise.all(["agent-instructions.md", "agent-guide.md", "INSTRUCTIONS.md"].map(file => readFile(join(process.cwd(), file), "utf8")));
    for (const text of [block, ...texts]) {
      assert.match(text.replace(/\s+/g, " "), /every subagent call/);
      assert.doesNotMatch(text.replace(/\s+/g, " "), /active (root|repository\/worktree)[^.]* on every call/);
    }
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    assert.doesNotMatch(readme, /absolute\/path\/to\/project|--root "\$PWD"/);
  });

  it("keeps the detailed workflow in the on-demand instructions resource", async () => {
    const guide = await readFile(join(process.cwd(), "agent-guide.md"), "utf8");
    for (const required of ["task_pack", "search", "skeleton", "blast_radius", "validate_scope", "reindex"]) {
      assert.match(guide, new RegExp(`\\b${required}\\b`));
    }
  });
});
