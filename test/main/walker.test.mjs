import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { walkDirectory, groupByDirectory } from "../../build/core/walker.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

const FIXTURE_DIR = join(process.cwd(), "test", "_walk_fixtures");

describe("walker", () => {
  before(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    await mkdir(join(FIXTURE_DIR, "src", "utils"), { recursive: true });
    await mkdir(join(FIXTURE_DIR, "docs"), { recursive: true });
    await writeFile(join(FIXTURE_DIR, "index.ts"), "export {}");
    await writeFile(join(FIXTURE_DIR, "src", "app.ts"), "const x = 1;");
    await writeFile(
      join(FIXTURE_DIR, "src", "utils", "helpers.ts"),
      "export function h() {}",
    );
    await writeFile(join(FIXTURE_DIR, "docs", "readme.txt"), "Hello");
  });

  describe("walkDirectory", () => {
    it("returns files and directories", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      assert.ok(entries.length > 0);
      const files = entries.filter((e) => !e.isDirectory);
      const dirs = entries.filter((e) => e.isDirectory);
      assert.ok(files.length >= 3);
      assert.ok(dirs.length >= 2);
    });

    it("includes relative paths", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const paths = entries.map((e) => e.relativePath);
      assert.ok(paths.includes("index.ts"));
      assert.ok(paths.some((p) => p.includes("src")));
    });

    it("respects depth limit", async () => {
      const entries = await walkDirectory({
        rootDir: FIXTURE_DIR,
        depthLimit: 1,
      });
      const deepFiles = entries.filter((e) =>
        e.relativePath.includes("helpers.ts"),
      );
      assert.equal(
        deepFiles.length,
        0,
        "files inside utils/ should not appear at depthLimit 1",
      );
    });

    it("respects targetPath", async () => {
      const entries = await walkDirectory({
        rootDir: FIXTURE_DIR,
        targetPath: "src",
      });
      const nonSrcFiles = entries.filter((e) => e.relativePath === "index.ts");
      assert.equal(nonSrcFiles.length, 0);
      assert.ok(entries.some((e) => e.relativePath.includes("app.ts")));
    });

    it("ignores node_modules", async () => {
      await mkdir(join(FIXTURE_DIR, "node_modules", "pkg"), {
        recursive: true,
      });
      await writeFile(
        join(FIXTURE_DIR, "node_modules", "pkg", "index.js"),
        "module.exports = {}",
      );
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const nmEntries = entries.filter((e) =>
        e.relativePath.includes("node_modules"),
      );
      assert.equal(nmEntries.length, 0);
      await rm(join(FIXTURE_DIR, "node_modules"), {
        recursive: true,
        force: true,
      });
    });

    it("ignores .git directory", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const gitEntries = entries.filter((e) => e.relativePath.includes(".git"));
      assert.equal(gitEntries.length, 0);
    });

    it("returns empty for non-existent targetPath", async () => {
      const entries = await walkDirectory({
        rootDir: FIXTURE_DIR,
        targetPath: "nonexistent",
      });
      assert.equal(entries.length, 0);
    });

    it("includes depth info", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const topLevel = entries.filter((e) => e.depth === 0);
      assert.ok(topLevel.length > 0);
    });

    it("respects .gitignore", async () => {
      await writeFile(join(FIXTURE_DIR, ".gitignore"), "docs/\n");
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const docFiles = entries.filter((e) =>
        e.relativePath.includes("readme.txt"),
      );
      assert.equal(docFiles.length, 0, "files inside docs/ should be ignored");
      await rm(join(FIXTURE_DIR, ".gitignore"));
    });

    it("respects nested .gitignore files", async () => {
      await mkdir(join(FIXTURE_DIR, "packages", "api", "generated"), { recursive: true });
      await writeFile(join(FIXTURE_DIR, "packages", "api", "handler.ts"), "export function handle() {}");
      await writeFile(join(FIXTURE_DIR, "packages", "api", "generated", "schema.ts"), "export type Schema = {}");
      await writeFile(join(FIXTURE_DIR, "packages", "api", ".gitignore"), "generated/\n");

      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const handlerFiles = entries.filter((e) => e.relativePath.includes("handler.ts"));
      const generatedFiles = entries.filter((e) => e.relativePath.includes("schema.ts"));

      assert.equal(handlerFiles.length, 1, "handler.ts should be included");
      assert.equal(generatedFiles.length, 0, "generated/schema.ts should be ignored by nested .gitignore");

      await rm(join(FIXTURE_DIR, "packages"), { recursive: true, force: true });
    });

    it("stacks nested .gitignore rules with root rules", async () => {
      await writeFile(join(FIXTURE_DIR, ".gitignore"), "*.log\n");
      await mkdir(join(FIXTURE_DIR, "sub"), { recursive: true });
      await writeFile(join(FIXTURE_DIR, "sub", ".gitignore"), "*.tmp\n");
      await writeFile(join(FIXTURE_DIR, "sub", "app.ts"), "const x = 1;");
      await writeFile(join(FIXTURE_DIR, "sub", "debug.log"), "log data");
      await writeFile(join(FIXTURE_DIR, "sub", "cache.tmp"), "temp data");

      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const paths = entries.map((e) => e.relativePath);

      assert.ok(paths.some((p) => p === "sub/app.ts"), "app.ts should be included");
      assert.ok(!paths.some((p) => p === "sub/debug.log"), "debug.log should be ignored by root .gitignore");
      assert.ok(!paths.some((p) => p === "sub/cache.tmp"), "cache.tmp should be ignored by nested .gitignore");

      await rm(join(FIXTURE_DIR, "sub"), { recursive: true, force: true });
      await rm(join(FIXTURE_DIR, ".gitignore"));
    });

    it("skips symlinks to prevent infinite loops", async () => {
      const { symlink } = await import("fs/promises");
      await mkdir(join(FIXTURE_DIR, "real_dir"), { recursive: true });
      await writeFile(join(FIXTURE_DIR, "real_dir", "file.ts"), "export {}");
      try {
        await symlink(join(FIXTURE_DIR, "real_dir"), join(FIXTURE_DIR, "link_dir"));
      } catch {
        return;
      }

      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const linkEntries = entries.filter((e) => e.relativePath.startsWith("link_dir"));
      assert.equal(linkEntries.length, 0, "symlinked directories should be skipped");

      await rm(join(FIXTURE_DIR, "link_dir"));
      await rm(join(FIXTURE_DIR, "real_dir"), { recursive: true, force: true });
    });

    it("respects .contextplusignore file", async () => {
      await mkdir(join(FIXTURE_DIR, "vendor"), { recursive: true });
      await writeFile(join(FIXTURE_DIR, "vendor", "lib.js"), "module.exports = {}");
      await writeFile(join(FIXTURE_DIR, ".contextplusignore"), "vendor/\n");

      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const vendorFiles = entries.filter((e) => e.relativePath.includes("vendor"));
      assert.equal(vendorFiles.length, 0, "vendor/ should be ignored by .contextplusignore");

      await rm(join(FIXTURE_DIR, "vendor"), { recursive: true, force: true });
      await rm(join(FIXTURE_DIR, ".contextplusignore"));
    });
  });

  describe("groupByDirectory", () => {
    it("groups files by their parent directory", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const groups = groupByDirectory(entries);
      assert.ok(groups instanceof Map);
      assert.ok(groups.size > 0);
    });

    it("puts root files under '.'", async () => {
      const entries = await walkDirectory({ rootDir: FIXTURE_DIR });
      const groups = groupByDirectory(entries);
      const rootGroup = groups.get(".");
      assert.ok(rootGroup);
      assert.ok(rootGroup.some((e) => e.relativePath === "index.ts"));
    });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
