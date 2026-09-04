// Tests for graph analytics inspired by Graphify-style navigation

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function graph(nodes, edges) {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    rootDir: "/fixture",
    indexGeneration: 1,
    nodes,
    edges: edges.map((edge, index) => ({
      id: `edge:${index}`,
      confidence: "AST_EXTRACTED",
      evidence: "test edge",
      ...edge,
    })),
    stats: { nodes: nodes.length, edges: edges.length, files: nodes.length, symbols: 0, imports: 0, calls: 0, tests: 0, ambiguousCalls: 0 },
  };
}

describe("graph analytics", () => {
  it("prefers a stronger exact two-hop path over an ambiguous direct edge", async () => {
    const { findWeightedShortestPath } = await import("../../build/core/graph-analytics.js");
    const fixture = graph(
      [
        { id: "file:a.ts", type: "file", label: "a.ts", path: "a.ts" },
        { id: "file:b.ts", type: "file", label: "b.ts", path: "b.ts" },
        { id: "file:c.ts", type: "file", label: "c.ts", path: "c.ts" },
      ],
      [
        { type: "calls", source: "file:a.ts", target: "file:b.ts", confidence: "AMBIGUOUS", evidence: "name collision" },
        { type: "imports", source: "file:a.ts", target: "file:c.ts" },
        { type: "imports", source: "file:c.ts", target: "file:b.ts" },
      ],
    );
    const result = findWeightedShortestPath(fixture, "a.ts", "b.ts");
    assert.equal(result.analysis.status, "found");
    assert.equal(result.analysis.hops, 2);
    assert.deepEqual(result.nodes.map((node) => node.path), ["a.ts", "c.ts", "b.ts"]);
    assert.ok(result.edges.every((edge) => edge.confidence === "AST_EXTRACTED"));
  });

  it("reports ambiguous symbol selectors instead of guessing", async () => {
    const { findWeightedShortestPath } = await import("../../build/core/graph-analytics.js");
    const fixture = graph(
      [
        { id: "symbol:a:run", type: "symbol", label: "run", path: "a.ts", lineStart: 1 },
        { id: "symbol:b:run", type: "symbol", label: "run", path: "b.ts", lineStart: 1 },
        { id: "file:c.ts", type: "file", label: "c.ts", path: "c.ts" },
      ],
      [],
    );
    const result = findWeightedShortestPath(fixture, "run", "c.ts");
    assert.equal(result.analysis.status, "ambiguous");
    assert.equal(result.analysis.sourceCandidates.length, 2);
  });

  it("keeps higher-cost arrivals that retain a hop for a constrained route", async () => {
    const { findWeightedShortestPath } = await import("../../build/core/graph-analytics.js");
    const fixture = graph(
      ["source", "cheap-detour", "shared", "target"].map((name) => ({
        id: `file:${name}.ts`, type: "file", label: `${name}.ts`, path: `${name}.ts`,
      })),
      [
        { type: "imports", source: "file:source.ts", target: "file:cheap-detour.ts" },
        { type: "imports", source: "file:cheap-detour.ts", target: "file:shared.ts" },
        { type: "calls", source: "file:source.ts", target: "file:shared.ts", confidence: "AMBIGUOUS" },
        { type: "imports", source: "file:shared.ts", target: "file:target.ts" },
      ],
    );
    const result = findWeightedShortestPath(fixture, "source.ts", "target.ts", 2);
    assert.equal(result.analysis.status, "found");
    assert.deepEqual(result.nodes.map((node) => node.path), ["source.ts", "shared.ts", "target.ts"]);
    assert.equal(result.analysis.hops, 2);
  });

  it("ranks shared dependency hubs above leaves", async () => {
    const { rankGraphHotspots } = await import("../../build/core/graph-analytics.js");
    const nodes = ["hub", "a", "b", "c", "d"].map((name) => ({ id: `file:${name}.ts`, type: "file", label: `${name}.ts`, path: `${name}.ts` }));
    const fixture = graph(nodes, ["a", "b", "c", "d"].map((name) => ({ type: "imports", source: `file:${name}.ts`, target: "file:hub.ts" })));
    const ranked = rankGraphHotspots(fixture, 5);
    assert.equal(ranked[0].nodeId, "file:hub.ts");
    assert.equal(ranked[0].inDegree, 4);
  });

  it("separates strongly connected file groups into communities", async () => {
    const { detectGraphCommunities } = await import("../../build/core/graph-analytics.js");
    const names = ["auth/a", "auth/b", "auth/c", "billing/x", "billing/y", "billing/z"];
    const nodes = names.map((name) => ({ id: `file:src/${name}.ts`, type: "file", label: `${name.split("/").at(-1)}.ts`, path: `src/${name}.ts` }));
    const edges = [
      ["auth/a", "auth/b"], ["auth/b", "auth/c"], ["auth/c", "auth/a"],
      ["billing/x", "billing/y"], ["billing/y", "billing/z"], ["billing/z", "billing/x"],
    ].map(([source, target]) => ({ type: "imports", source: `file:src/${source}.ts`, target: `file:src/${target}.ts` }));
    const communities = detectGraphCommunities(graph(nodes, edges), 10);
    assert.equal(communities.length, 2);
    assert.deepEqual(communities.map((community) => community.size).sort(), [3, 3]);
    assert.ok(communities.some((community) => community.label.includes("auth")));
    assert.ok(communities.some((community) => community.label.includes("billing")));
  });

  it("disambiguates communities that share the same directory label", async () => {
    const { detectGraphCommunities } = await import("../../build/core/graph-analytics.js");
    const names = ["alpha-a", "alpha-b", "beta-a", "beta-b"];
    const nodes = names.map((name) => ({ id: `file:test/main/${name}.ts`, type: "test", label: `${name}.ts`, path: `test/main/${name}.ts` }));
    const edges = [
      { type: "imports", source: "file:test/main/alpha-a.ts", target: "file:test/main/alpha-b.ts" },
      { type: "imports", source: "file:test/main/beta-a.ts", target: "file:test/main/beta-b.ts" },
    ];
    const communities = detectGraphCommunities(graph(nodes, edges), 10);
    assert.equal(communities.length, 2);
    assert.equal(new Set(communities.map((community) => community.label)).size, 2);
    assert.ok(communities.every((community) => community.label.startsWith("test/main · ")));
  });
});

describe("project graph concurrency and budgets", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("shares one graph object across concurrent callers for the same index generation", async () => {
    const { reindex } = await import("../../build/tools/reindex.js");
    const { buildProjectGraph, invalidateProjectGraphCache } = await import("../../build/core/project-graph.js");
    root = await mkdtemp(join(tmpdir(), "contextpro-graph-cache-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export function a() { return 1; }\n");
    await reindex({ rootDir: root, force: true, noEmbed: true });
    invalidateProjectGraphCache(root);
    const [first, second, third] = await Promise.all([
      buildProjectGraph(root),
      buildProjectGraph(root),
      buildProjectGraph(root),
    ]);
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
  });

  it("keeps text and JSON graph responses within their requested budget", async () => {
    const { reindex } = await import("../../build/tools/reindex.js");
    const { queryProjectGraphTool } = await import("../../build/tools/project-graph.js");
    root = await mkdtemp(join(tmpdir(), "contextpro-graph-budget-"));
    await mkdir(join(root, "src"), { recursive: true });
    for (let index = 0; index < 18; index++) {
      const dependency = index > 0 ? `import { f${index - 1} } from './f${index - 1}';\n` : "";
      await writeFile(join(root, "src", `f${index}.ts`), `${dependency}export function f${index}() { return ${index}; }\n`);
    }
    await reindex({ rootDir: root, force: true, noEmbed: true });
    const text = await queryProjectGraphTool({ rootDir: root, kind: "hotspots", limit: 50, maxTokens: 256 });
    assert.ok(text.length <= 256 * 4);
    const json = await queryProjectGraphTool({ rootDir: root, kind: "communities", limit: 50, maxTokens: 256, format: "json" });
    assert.ok(json.length <= 256 * 4);
    assert.doesNotThrow(() => JSON.parse(json));
  });
});
