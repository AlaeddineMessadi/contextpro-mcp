import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

let fixtureRoot = "";
let originalEmbed;

async function writeFixture() {
  await mkdir(join(fixtureRoot, "engine"), { recursive: true });
  await mkdir(join(fixtureRoot, "tests"), { recursive: true });
  await writeFile(join(fixtureRoot, "engine", "__init__.py"), "");
  await writeFile(
    join(fixtureRoot, "engine", "detector.py"),
    [
      "# Detector primitives",
      "# FEATURE: flat skip detector",
      "def flat_skip_band(samples):",
      "    # Apply the flat-window filter before grouping skips.",
      "    return [sample for sample in samples if sample >= 0]",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "engine", "scanner.py"),
    [
      "# Scanner pipeline",
      "# FEATURE: flat skip detector",
      "from engine.detector import flat_skip_band",
      "",
      "def scan(values):",
      "    return flat_skip_band(values)",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "engine", "group.py"),
    [
      "# Group helpers unrelated to detector imports",
      "# FEATURE: grouping",
      "def group_values(values):",
      "    return list(values)",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "engine", "websocket.py"),
    [
      "# WebSocket buffering",
      "# FEATURE: socket",
      "def socket_window_filter(messages):",
      "    return messages[-10:]",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "tests", "test_detector.py"),
    [
      "from engine.detector import flat_skip_band",
      "",
      "def test_detector_direct():",
      "    assert flat_skip_band([1, -1]) == [1]",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(fixtureRoot, "tests", "test_scanner.py"),
    [
      "from engine.scanner import scan",
      "",
      "def test_scanner_pipeline():",
      "    assert scan([1, -1]) == [1]",
      "",
    ].join("\n"),
  );
}

describe("python graph regressions", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextpro-python-graph-"));
    await writeFixture();
    originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return {
        embeddings: batch.map((value) => {
          const text = String(value).toLowerCase();
          return [
            text.includes("flat-window") || text.includes("flat window") || text.includes("flat_skip_band") ? 1 : 0.05,
            text.includes("detector") ? 0.8 : 0.05,
            text.includes("websocket") || text.includes("socket") ? 0.2 : 0.05,
          ];
        }),
      };
    };
  });

  afterEach(async () => {
    Ollama.prototype.embed = originalEmbed;
    const dbMod = await import("../../build/core/db.js");
    dbMod.closeDB(fixtureRoot);
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("maps Python absolute imports into impact and test discovery", async () => {
    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const dbMod = await import("../../build/core/db.js");
    const db = await dbMod.getDB(fixtureRoot);
    const detector = db.getFile("engine/detector.py");
    assert.ok(detector);
    const importers = db.getImportersOf(detector.id).map((row) => db.getFileById(row.source_file_id)?.path);
    assert.ok(importers.includes("engine/scanner.py"));
    assert.ok(importers.includes("tests/test_detector.py"));

    const testMapMod = await import("../../build/tools/test-map.js");
    const testMap = await testMapMod.getTestMap({
      rootDir: fixtureRoot,
      file: "engine/detector.py",
    });
    assert.match(testMap, /tests\/test_detector\.py/);
    assert.match(testMap, /tests\/test_scanner\.py/);

    const agenticMod = await import("../../build/tools/agentic-context.js");
    const impact = JSON.parse(await agenticMod.buildChangeImpact({
      rootDir: fixtureRoot,
      files: ["engine/detector.py"],
      format: "json",
    }));
    assert.ok(impact.affectedFiles.some((file) => file.path === "engine/scanner.py"));
    assert.ok(impact.affectedTests.some((file) => file.path === "tests/test_detector.py"));
    assert.ok(impact.affectedTests.some((file) => file.path === "tests/test_scanner.py"));
    assert.ok(impact.affectedFiles.every((file) => file.path !== "engine/group.py"));
  });

  it("searches descriptive body meaning before unrelated test or socket matches", async () => {
    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const searchMod = await import("../../build/tools/semantic-search.js");
    searchMod.invalidateSearchCache();
    const result = await searchMod.semanticCodeSearchResults({
      rootDir: fixtureRoot,
      query: "where is the flat-window filter",
      topK: 4,
    });
    assert.equal(result.results[0].path, "engine/detector.py");
    assert.notEqual(result.results[0].path, "engine/websocket.py");
    assert.ok(result.results[0].semanticScore > 0);
  });

  it("finds Python references from the import and call index without SCIP", async () => {
    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const refsMod = await import("../../build/tools/exact-references.js");
    const refs = JSON.parse(await refsMod.exactReferencesTool({
      rootDir: fixtureRoot,
      symbolName: "flat_skip_band",
      format: "json",
    }));
    assert.equal(refs.confidence, "PYTHON_INDEX_RESOLVED");
    assert.ok(refs.references.some((ref) => ref.file === "engine/detector.py" && ref.isDefinition));
    assert.ok(refs.references.some((ref) => ref.file === "engine/scanner.py" && ref.context.includes("flat_skip_band")));
    assert.ok(refs.references.some((ref) => ref.file === "tests/test_detector.py" && ref.context.includes("flat_skip_band")));
  });
});
