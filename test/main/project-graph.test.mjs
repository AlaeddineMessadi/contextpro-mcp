import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { reindex } from "../../build/tools/reindex.js";
import { buildProjectGraph, writeProjectGraphArtifacts } from "../../build/core/project-graph.js";
import { importScipIndex } from "../../build/core/scip-index.js";
import { queryProjectGraphTool } from "../../build/tools/project-graph.js";
import { impactDeltaTool } from "../../build/tools/impact-delta.js";
import { closeDB } from "../../build/core/db.js";

const FIXTURE_DIR = join(process.cwd(), "test", "_project_graph_fixtures");

describe("project graph", () => {
  before(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
    await mkdir(join(FIXTURE_DIR, "src"), { recursive: true });
    await mkdir(join(FIXTURE_DIR, "src", "routes"), { recursive: true });
    await writeFile(
      join(FIXTURE_DIR, "src", "math.ts"),
      "// Math helpers\n// FEATURE: Math\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await writeFile(
      join(FIXTURE_DIR, "src", "calc.ts"),
      "// Calculator\n// FEATURE: Calc\n\nimport { add } from './math';\n\nexport function inc(x: number): number {\n  return add(x, 1);\n}\n",
    );
    await writeFile(
      join(FIXTURE_DIR, "src", "math.test.ts"),
      "// Math tests\n// FEATURE: Math\n\nimport { add } from './math';\n\nexport function testAdd(): number {\n  return add(1, 2);\n}\n",
    );
    await writeFile(
      join(FIXTURE_DIR, "src", "routes", "users.ts"),
      "// User route\n// FEATURE: Routes\n\nexport function loader(): string {\n  return 'users';\n}\n",
    );
    await reindex({ rootDir: FIXTURE_DIR, force: true });
  });

  it("builds typed file, symbol, import, call, and test edges", async () => {
    const graph = await buildProjectGraph(FIXTURE_DIR);
    assert.ok(graph.nodes.some((node) => node.id === "file:src/math.ts" && node.type === "file"));
    assert.ok(graph.nodes.some((node) => node.type === "symbol" && node.label === "add" && node.path === "src/math.ts"));
    assert.ok(graph.edges.some((edge) => edge.type === "defines" && edge.source === "file:src/math.ts" && edge.confidence === "AST_EXTRACTED"));
    assert.ok(graph.edges.some((edge) => edge.type === "imports" && edge.source === "file:src/calc.ts" && edge.target === "file:src/math.ts"));
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.source === "file:src/calc.ts"));
    assert.ok(graph.edges.some((edge) => edge.type === "tests" && edge.source === "file:src/math.test.ts" && edge.target === "file:src/math.ts"));
    assert.ok(graph.edges.some((edge) => edge.type === "route_handles" && edge.source === "file:src/routes/users.ts" && edge.target === "route:/users"));
    assert.ok(graph.edges.every((edge) => edge.confidence && edge.evidence));
  });

  it("merges imported SCIP JSON references into the graph", async () => {
    await writeFile(
      join(FIXTURE_DIR, "src", "use.py"),
      "# Python usage\nfrom math import add\nprint(add(1, 2))\n",
    );
    await writeFile(
      join(FIXTURE_DIR, "scip.json"),
      JSON.stringify({
        documents: [
          {
            relative_path: "src/math.ts",
            symbols: [
              {
                symbol: "local src/math.ts add().",
                display_name: "add",
                kind: "Function",
              },
            ],
            occurrences: [
              {
                range: [3, 16, 19],
                symbol: "local src/math.ts add().",
                symbol_roles: 1,
              },
            ],
          },
          {
            relative_path: "src/use.py",
            occurrences: [
              {
                range: [2, 6, 9],
                symbol: "local src/math.ts add().",
                symbol_roles: 0,
              },
            ],
          },
        ],
      }, null, 2),
    );
    const imported = await importScipIndex(FIXTURE_DIR, "scip.json");
    assert.equal(imported.index.symbols.length, 1);
    assert.equal(imported.index.occurrences.length, 2);

    const graph = await buildProjectGraph(FIXTURE_DIR);
    assert.ok(graph.nodes.some((node) => node.id === "file:src/use.py"));
    assert.ok(graph.edges.some((edge) =>
      edge.type === "references"
      && edge.source === "file:src/use.py"
      && edge.confidence === "SCIP_RESOLVED",
    ));
  });

  it("writes portable graph artifacts", async () => {
    const result = await writeProjectGraphArtifacts(FIXTURE_DIR);
    const graphJson = await readFile(result.graphPath, "utf-8");
    const report = await readFile(result.reportPath, "utf-8");
    const dashboard = await readFile(result.dashboardPath, "utf-8");
    assert.ok(JSON.parse(graphJson).nodes.length > 0);
    assert.ok(report.includes("Confidence Notes"));
    assert.ok(dashboard.includes("ContextPro Graph Dashboard"));
  });

  it("queries graph neighborhoods without reading files", async () => {
    const raw = await queryProjectGraphTool({
      rootDir: FIXTURE_DIR,
      kind: "impact",
      file: "src/math.ts",
      format: "json",
    });
    const result = JSON.parse(raw);
    assert.ok(result.nodes.some((node) => node.path === "src/math.ts"));
    assert.ok(result.edges.some((edge) => edge.type === "imports" || edge.type === "tests"));
  });

  it("reports graph deltas after edits", async () => {
    const rootDir = join(process.cwd(), "test", "_impact_delta_fixtures");
    await rm(rootDir, { recursive: true, force: true });
    await mkdir(join(rootDir, "src"), { recursive: true });
    try {
      await writeFile(
        join(rootDir, "src", "base.ts"),
        "// Base\n// FEATURE: Delta\n\nexport function base(): number {\n  return 1;\n}\n",
      );
      await reindex({ rootDir, force: true });
      await writeProjectGraphArtifacts(rootDir);
      await writeFile(
        join(rootDir, "src", "consumer.ts"),
        "// Consumer\n// FEATURE: Delta\n\nimport { base } from './base';\n\nexport function consume(): number {\n  return base();\n}\n",
      );
      await reindex({ rootDir, force: true });
      const delta = JSON.parse(await impactDeltaTool({ rootDir, format: "json" }));
      assert.ok(delta.addedNodes.some((node) => node.id === "file:src/consumer.ts"));
      assert.ok(delta.impactedFiles.includes("src/consumer.ts"));
      assert.ok(delta.addedEdges.length > 0);
    } finally {
      closeDB(rootDir);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  after(async () => {
    closeDB(FIXTURE_DIR);
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });
});
