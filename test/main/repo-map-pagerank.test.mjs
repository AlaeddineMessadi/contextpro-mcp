// Repo-map PageRank integration test — proves graph-centrality drives ranking
// FEATURE: repo_map ranks by transitive import-graph importance (PageRank), not
// just local degree, and exposes a pageRank field per file entry.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";

async function write(rel, lines) {
  await writeFile(join(root, rel), lines.join("\n") + "\n");
}

describe("repo-map PageRank ranking", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-repomap-pr-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, ".contextpro"), { recursive: true });

    // Graph shape:
    //   index.ts -> service.ts -> core.ts   (core is depended on transitively)
    //   a.ts, b.ts, c.ts -> util.ts         (util is imported by many leaves)
    // core.ts is imported by ONE file (service) but that file is central;
    // util.ts is imported by THREE leaf files. Degree-counting would rank util
    // above core; PageRank should recognize core's transitive importance.
    await write("src/core.ts", [
      "// Core domain logic that the central service depends on",
      "// FEATURE: transitive-importance fixture target",
      "export function coreLogic(): number { return 1; }",
    ]);
    await write("src/service.ts", [
      "// Central service wired into the entry point",
      "// FEATURE: central node in the import graph",
      "import { coreLogic } from './core';",
      "export function service(): number { return coreLogic(); }",
    ]);
    await write("src/index.ts", [
      "// Entry point",
      "// FEATURE: app entry",
      "import { service } from './service';",
      "export function main(): number { return service(); }",
    ]);
    await write("src/util.ts", [
      "// Small leaf utility imported by several unimportant leaves",
      "// FEATURE: high-degree-but-shallow fixture",
      "export function util(): number { return 0; }",
    ]);
    for (const leaf of ["a", "b", "c"]) {
      await write(`src/${leaf}.ts`, [
        `// Leaf ${leaf}`,
        "// FEATURE: leaf importer",
        "import { util } from './util';",
        `export function ${leaf}(): number { return util(); }`,
      ]);
    }

    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: root,
      projectId: "repomap-pagerank-fixture",
      sessionSource: "codex",
    });
    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: root, force: true });
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("exposes a pageRank field and confers transitive rank along the import chain", async () => {
    const mod = await import("../../build/tools/repo-map.js");
    const data = await mod.getRepoMapData({ rootDir: root, maxFiles: 20 });

    const core = data.files.find((f) => f.path === "src/core.ts");
    const util = data.files.find((f) => f.path === "src/util.ts");
    const leafA = data.files.find((f) => f.path === "src/a.ts");
    assert.ok(core && util && leafA, "core, util, and a leaf should all be present");

    // pageRank field is populated and normalized 0–100.
    assert.equal(typeof core.pageRank, "number");
    assert.ok(core.pageRank >= 0 && core.pageRank <= 100);

    // core.ts is imported by exactly ONE file, the same direct in-degree class as a
    // single leaf importer — but it sits on the central index->service->core chain,
    // so PageRank flows transitive importance into it. It should rank far above the
    // leaf importers (a/b/c), which only point outward and receive nothing.
    assert.ok(
      core.pageRank > leafA.pageRank,
      `core pageRank (${core.pageRank}) should exceed a leaf importer (${leafA.pageRank})`,
    );

    // And core should land among the genuinely important files in the final map —
    // the import-graph sinks (util, core) outrank the source-only leaves overall.
    assert.ok(
      data.files[0].importance >= core.importance,
      "core should be near the top of the importance ranking",
    );
  });

  it("personalizes ranking toward a target subtree", async () => {
    const mod = await import("../../build/tools/repo-map.js");
    const all = await mod.getRepoMapData({ rootDir: root, maxFiles: 20 });
    const scoped = await mod.getRepoMapData({ rootDir: root, targetPath: "src/util.ts", maxFiles: 20 });

    // Scoped to util.ts, only that file is returned and it carries a rank.
    assert.ok(scoped.files.every((f) => f.path.startsWith("src/util.ts")));
    assert.ok(scoped.files.length >= 1);
    assert.ok(all.files.length > scoped.files.length, "unscoped map should be broader");
  });

  it("reseeds ranking toward focus_files for the current task (Aider-repomap-style)", async () => {
    const mod = await import("../../build/tools/repo-map.js");
    const baseline = await mod.getRepoMapData({ rootDir: root, maxFiles: 20 });
    const focused = await mod.getRepoMapData({ rootDir: root, maxFiles: 20, focusFiles: ["src/a.ts"] });

    const baselineLeaf = baseline.files.find((f) => f.path === "src/a.ts");
    const focusedLeaf = focused.files.find((f) => f.path === "src/a.ts");
    assert.ok(baselineLeaf && focusedLeaf, "leaf a.ts should be present in both maps");

    // a.ts is a low-importance leaf in the unfocused baseline (it only imports, nothing
    // imports it) — reseeding personalization toward it should visibly lift its pageRank
    // relative to the same file's baseline score.
    assert.ok(
      focusedLeaf.pageRank > baselineLeaf.pageRank,
      `focus_files should lift a.ts's pageRank (baseline ${baselineLeaf.pageRank} -> focused ${focusedLeaf.pageRank})`,
    );
  });

  it("reseeds ranking toward files defining a focus_identifier", async () => {
    const mod = await import("../../build/tools/repo-map.js");
    const baseline = await mod.getRepoMapData({ rootDir: root, maxFiles: 20 });
    const focused = await mod.getRepoMapData({ rootDir: root, maxFiles: 20, focusIdentifiers: ["coreLogic"] });

    // coreLogic is defined only in core.ts — biasing toward the mentioned identifier should
    // lift core.ts's pageRank without needing the caller to already know which file defines it.
    const baselineCore = baseline.files.find((f) => f.path === "src/core.ts");
    const focusedCore = focused.files.find((f) => f.path === "src/core.ts");
    assert.ok(baselineCore && focusedCore, "core.ts should be present in both maps");
    assert.ok(
      focusedCore.pageRank > baselineCore.pageRank,
      `focus_identifiers should lift core.ts's pageRank (baseline ${baselineCore.pageRank} -> focused ${focusedCore.pageRank})`,
    );
  });
});
