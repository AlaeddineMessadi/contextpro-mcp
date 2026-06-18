import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

describe("repo-map and resolve-symbol", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-repo-map-"));
    await mkdir(join(fixtureRoot, "src"), { recursive: true });
    await mkdir(join(fixtureRoot, ".contextpro"), { recursive: true });

    await writeFile(
      join(fixtureRoot, "src", "foo.ts"),
      [
        "// Metrics class exposing graph stats through an instance method",
        "// FEATURE: fixture for resolve_symbol method prioritization",
        "export class Metrics {",
        "  getGraphStats() {",
        "    return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(fixtureRoot, "src", "bar.ts"),
      [
        "// Standalone graph stats helper with the same symbol name",
        "// FEATURE: fixture for explain ambiguity regression coverage",
        "export function getGraphStats() {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    );

    await writeFile(
      join(fixtureRoot, "src", "use.ts"),
      [
        "// Metrics runner that should resolve method calls to the imported class",
        "// FEATURE: fixture that reproduces ambiguous method vs function lookup",
        "import { Metrics } from './foo';",
        "",
        "export function runReport() {",
        "  const metrics = new Metrics();",
        "  return metrics.getGraphStats();",
        "}",
        "",
      ].join("\n"),
    );

    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "repo-map-fixture",
      sessionSource: "codex",
    });

    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("returns a compact repo map from indexed files", async () => {
    const mod = await import("../../build/tools/repo-map.js");
    const text = await mod.getRepoMap({
      rootDir: fixtureRoot,
      maxFiles: 10,
      maxSymbolsPerFile: 4,
    });

    assert.match(text, /=== Repo Map ===/);
    assert.match(text, /src\/foo\.ts/);
    assert.match(text, /src\/use\.ts/);
    assert.match(text, /runReport/);
  });

  it("prefers imported methods when resolving ambiguous symbols", async () => {
    const mod = await import("../../build/tools/resolve-symbol.js");
    const data = await mod.resolveSymbolData({
      rootDir: fixtureRoot,
      symbolName: "getGraphStats",
      fileContext: "src/use.ts",
      kind: "method",
      limit: 4,
    });

    assert.ok(data.bestMatch);
    assert.equal(data.bestMatch.path, "src/foo.ts");
    assert.equal(data.bestMatch.kind, "method");
  });

  it("uses resolve_symbol ranking inside explain for member calls", async () => {
    const mod = await import("../../build/tools/explain.js");
    const text = await mod.explain({
      rootDir: fixtureRoot,
      file: "src/use.ts",
      symbol: "runReport",
      depth: 1,
    });

    assert.match(text, /method: getGraphStats \(src\/foo\.ts/);
    assert.doesNotMatch(text, /function: getGraphStats \(src\/bar\.ts/);
  });
});
