// Tests for production-hardening fixes: atomic writes, JSON.parse guards, git-ref validation
// FEATURE: Locks in the production-readiness audit fixes

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
async function setup() { root = await mkdtemp(join(tmpdir(), "ctxpro-prod-")); await mkdir(join(root, "src"), { recursive: true }); }
async function teardown() { await rm(root, { recursive: true, force: true }); }

describe("production hardening", () => {
  beforeEach(setup);
  afterEach(teardown);

  describe("atomic writes", () => {
    it("writeFileAtomic writes the full content and overwrites cleanly", async () => {
      const { writeFileAtomic } = await import("../../build/core/artifacts.js");
      const target = join(root, "atomic.json");
      await writeFileAtomic(target, '{"a":1}');
      assert.equal(await readFile(target, "utf-8"), '{"a":1}');
      await writeFileAtomic(target, '{"b":2}');
      assert.equal(await readFile(target, "utf-8"), '{"b":2}');
      // No leftover temp files
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(root);
      assert.ok(!files.some((f) => f.endsWith(".tmp")), `no .tmp leftovers, got: ${files.join(", ")}`);
    });
  });

  describe("impact_delta corrupt baseline", () => {
    it("returns a clear message instead of crashing on a corrupt graph.json", async () => {
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      const { impactDeltaTool } = await import("../../build/tools/impact-delta.js");
      await writeFile(join(root, "src", "a.ts"), "// a\nexport const x = 1;\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      // Write a corrupt baseline
      await mkdir(join(root, ".contextpro"), { recursive: true });
      await writeFile(join(root, ".contextpro", "graph.json"), "{ this is not valid json");
      const out = await impactDeltaTool({ rootDir: root });
      assert.match(out, /corrupt|graph_export/i, `expected graceful message, got: ${out.slice(0, 200)}`);
    });

    it("returns a clear message when no baseline exists", async () => {
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      const { impactDeltaTool } = await import("../../build/tools/impact-delta.js");
      await writeFile(join(root, "src", "a.ts"), "// a\nexport const x = 1;\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      const out = await impactDeltaTool({ rootDir: root });
      assert.match(out, /No baseline graph found|graph_export first/i);
    });
  });

  describe("related() malformed import JSON", () => {
    it("does not crash when symbols_imported is malformed", async () => {
      const { ensureProjectConfig } = await import("../../build/core/project-config.js");
      const { reindex } = await import("../../build/tools/reindex.js");
      const { getRelated } = await import("../../build/tools/related.js");
      const { getDB } = await import("../../build/core/db.js");
      await writeFile(join(root, "src", "a.ts"), "// a\nexport function a(){return 1;}\n");
      await writeFile(join(root, "src", "b.ts"), "// b\nimport { a } from './a';\nexport function b(){return a();}\n");
      await ensureProjectConfig({ rootDir: root });
      await reindex({ rootDir: root, force: true, noEmbed: true });
      // Corrupt the symbols_imported JSON directly in the DB
      const db = await getDB(root);
      db.db?.prepare?.("UPDATE imports SET symbols_imported = ? WHERE symbols_imported IS NOT NULL").run("{not json");
      // Should not throw
      const out = await getRelated({ rootDir: root, file: "src/b.ts" });
      assert.ok(typeof out === "string");
    });
  });

  describe("diff git-ref validation", () => {
    it("rejects a branch arg that looks like a flag", async () => {
      const { getDiff } = await import("../../build/tools/diff.js");
      await assert.rejects(
        () => getDiff({ rootDir: root, branch: "--output=/tmp/pwned" }),
        /not valid in a git revision/,
      );
    });

    it("accepts a normal branch name", async () => {
      const { getDiff } = await import("../../build/tools/diff.js");
      // Not a git repo, so it returns "No changes detected" or similar — just must not throw on validation
      const out = await getDiff({ rootDir: root, branch: "main" });
      assert.ok(typeof out === "string");
    });
  });
});
