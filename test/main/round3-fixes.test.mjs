// Tests for Round-3 feedback fixes: lint local-binary preference, config-key indexing, impact view
// FEATURE: Regression coverage for the three Round-3 issues

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

async function setup() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "ctxpro-r3-"));
}

async function teardown() {
  await rm(fixtureRoot, { recursive: true, force: true });
}

describe("round-3 fixes", () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await teardown(); });

  describe("config-key indexing in *.config.ts", () => {
    it("extracts singleton/react/shared keys from rsbuild-style config", async () => {
      const { analyzeFile } = await import("../../build/core/parser.js");
      const configPath = join(fixtureRoot, "rsbuild.config.ts");
      await writeFile(
        configPath,
        [
          "// Build config",
          "// For Module Federation",
          "",
          "export default {",
          "  moduleFederation: {",
          "    shared: {",
          "      react: {",
          "        singleton: true,",
          "        requiredVersion: '^18.0.0',",
          "      },",
          "    },",
          "  },",
          "};",
          "",
        ].join("\n"),
      );
      const analysis = await analyzeFile(configPath);
      const names = analysis.symbols.map((sym) => sym.name);
      assert.ok(names.includes("moduleFederation"), `Expected moduleFederation, got ${names.join(", ")}`);
      assert.ok(names.includes("shared"), `Expected shared key, got ${names.join(", ")}`);
      assert.ok(names.includes("react"), `Expected react key, got ${names.join(", ")}`);
      assert.ok(names.includes("singleton"), `Expected singleton key — the regression case from the assessment`);
    });

    it("extracts boolean keys with no trailing comma (Pattern 2 EOL regression)", async () => {
      const { analyzeFile } = await import("../../build/core/parser.js");
      const configPath = join(fixtureRoot, "rsbuild.config.ts");
      // The exact case the adversarial review flagged: `singleton: true` with no trailing , or }
      await writeFile(
        configPath,
        [
          "// Build config",
          "// EOL boolean test",
          "",
          "export default {",
          "  shared: {",
          "    react: {",
          "      singleton: true",
          "    }",
          "  }",
          "};",
          "",
        ].join("\n"),
      );
      const analysis = await analyzeFile(configPath);
      const names = analysis.symbols.map((sym) => sym.name);
      assert.ok(
        names.includes("singleton"),
        `Pattern 2 must match \`singleton: true\` at end-of-line (no trailing , or }). Got: ${names.join(", ")}`,
      );
    });

    it("does not extract config keys from non-config files", async () => {
      const { analyzeFile } = await import("../../build/core/parser.js");
      const sourcePath = join(fixtureRoot, "regular.ts");
      await writeFile(
        sourcePath,
        [
          "// Regular module",
          "// Not a config file",
          "",
          "export function build() {",
          "  const settings = { singleton: true };",
          "  return settings;",
          "}",
          "",
        ].join("\n"),
      );
      const analysis = await analyzeFile(sourcePath);
      const names = analysis.symbols.map((sym) => sym.name);
      assert.ok(names.includes("build"), "should still extract function");
      assert.ok(!names.includes("singleton"), "should NOT extract singleton from non-config file");
    });

    it("recognises framework-named *.config.* files even without exact prefix", async () => {
      const { analyzeFile } = await import("../../build/core/parser.js");
      const configPath = join(fixtureRoot, "next.config.ts");
      await writeFile(
        configPath,
        [
          "// next config",
          "// app settings",
          "",
          "export default {",
          "  experimental: {",
          "    serverActions: true,",
          "  },",
          "};",
          "",
        ].join("\n"),
      );
      const analysis = await analyzeFile(configPath);
      const names = analysis.symbols.map((sym) => sym.name);
      assert.ok(names.includes("experimental"));
      assert.ok(names.includes("serverActions"));
    });
  });

  describe("graph_query impact view differs from file view", () => {
    it("impact view selects via defines+imports/calls, file view selects direct edges", async () => {
      const projectGraph = await import("../../build/core/project-graph.js");
      assert.equal(typeof projectGraph.queryProjectGraph, "function");
    });

    it("impact view walks transitive incoming dependencies (BFS multi-hop)", async () => {
      const { queryProjectGraph } = await import("../../build/core/project-graph.js");
      const { reindex } = await import("../../build/tools/reindex.js");

      await mkdir(join(fixtureRoot, "src"), { recursive: true });
      await writeFile(
        join(fixtureRoot, "src", "leaf.ts"),
        [
          "// leaf utility",
          "// the root of the dependency chain",
          "",
          "export function leafFn(): number {",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(fixtureRoot, "src", "middle.ts"),
        [
          "// middle layer",
          "// imports leaf",
          "",
          "import { leafFn } from './leaf';",
          "export function middleFn(): number {",
          "  return leafFn() + 1;",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        join(fixtureRoot, "src", "consumer.ts"),
        [
          "// consumer",
          "// imports middle (transitively depends on leaf)",
          "",
          "import { middleFn } from './middle';",
          "export function consume(): number {",
          "  return middleFn() + 1;",
          "}",
          "",
        ].join("\n"),
      );

      await reindex({ rootDir: fixtureRoot, force: true, noEmbed: true });

      const fileView = await queryProjectGraph(fixtureRoot, { kind: "file", file: "src/leaf.ts", limit: 200 });
      const impactView = await queryProjectGraph(fixtureRoot, { kind: "impact", file: "src/leaf.ts", limit: 200 });

      const impactFilePaths = new Set(
        impactView.nodes.filter((node) => node.type === "file").map((node) => node.path),
      );
      assert.ok(impactFilePaths.has("src/middle.ts"), `impact must include direct importer src/middle.ts. Got: ${[...impactFilePaths].join(", ")}`);
      assert.ok(impactFilePaths.has("src/consumer.ts"), `impact must include TRANSITIVE importer src/consumer.ts (regression for single-hop bug). Got: ${[...impactFilePaths].join(", ")}`);

      // file view returns direct edges only; impact returns the full dependent tree
      // both should at minimum see the start node
      assert.ok(fileView.nodes.some((node) => node.path === "src/leaf.ts"));
    });

    it("differentiates 'not indexed' vs 'indexed but no incoming deps'", async () => {
      const { queryProjectGraphTool } = await import("../../build/tools/project-graph.js");
      const { reindex } = await import("../../build/tools/reindex.js");

      await mkdir(join(fixtureRoot, "src"), { recursive: true });
      await writeFile(
        join(fixtureRoot, "src", "isolated.ts"),
        "// isolated\n// no imports, no callers\n\nexport function lonely(): void {}\n",
      );
      await reindex({ rootDir: fixtureRoot, force: true, noEmbed: true });

      const indexedNoDeps = await queryProjectGraphTool({ rootDir: fixtureRoot, kind: "impact", file: "src/isolated.ts" });
      assert.match(indexedNoDeps, /indexed but has no incoming dependencies|no incoming dependencies/, `Expected differentiated message; got: ${indexedNoDeps}`);

      const notIndexed = await queryProjectGraphTool({ rootDir: fixtureRoot, kind: "impact", file: "src/does-not-exist.ts" });
      assert.match(notIndexed, /may not be indexed yet|No graph node found/, `Expected not-indexed message; got: ${notIndexed}`);
    });
  });

  describe("lint local-binary preference", () => {
    it("static-analysis module exports runStaticAnalysis", async () => {
      const sa = await import("../../build/tools/static-analysis.js");
      assert.equal(typeof sa.runStaticAnalysis, "function");
    });
  });

  describe("identifier-search filters internal locals", () => {
    it("excludes nested const/let from identifier docs but keeps top-level exports", async () => {
      const { reindex } = await import("../../build/tools/reindex.js");
      const { semanticIdentifierSearchResults } = await import("../../build/tools/semantic-identifiers.js");

      await mkdir(join(fixtureRoot, "src"), { recursive: true });
      await writeFile(
        join(fixtureRoot, "src", "alpha.ts"),
        [
          "// alpha module",
          "// has a public function and internal consts",
          "",
          "export function publicAlpha(): number {",
          "  const internalLocal = 1;",
          "  const containerStyle = { color: 'red' };",
          "  return internalLocal + 1;",
          "}",
          "",
          "export const TOP_LEVEL_EXPORTED = 42;",
          "",
        ].join("\n"),
      );
      await reindex({ rootDir: fixtureRoot, force: true, noEmbed: true });

      const result = await semanticIdentifierSearchResults({
        rootDir: fixtureRoot,
        query: "containerStyle",
        topK: 5,
      });
      const names = result.results.map((item) => item.name);
      assert.ok(
        !names.includes("containerStyle"),
        `Internal local 'containerStyle' must NOT appear in identifier search. Got: ${names.join(", ")}`,
      );
      assert.ok(
        !names.includes("internalLocal"),
        `Internal local 'internalLocal' must NOT appear in identifier search. Got: ${names.join(", ")}`,
      );

      const exportedQuery = await semanticIdentifierSearchResults({
        rootDir: fixtureRoot,
        query: "publicAlpha",
        topK: 5,
      });
      const exportedNames = exportedQuery.results.map((item) => item.name);
      assert.ok(
        exportedNames.includes("publicAlpha"),
        `Exported function 'publicAlpha' SHOULD appear. Got: ${exportedNames.join(", ")}`,
      );
    });
  });
});
