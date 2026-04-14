import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

let fixtureRoot = "";
let originalEmbed;

describe("agent workflow metadata", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-agent-flow-"));
    await mkdir(join(fixtureRoot, "src", "auth"), { recursive: true });

    await writeFile(
      join(fixtureRoot, "src", "auth", "session.ts"),
      [
        "// Session refresh primitive shared by auth middleware",
        "// FEATURE: auth session workflow for artifact and hub tests",
        "export function refreshSession() {",
        "  return 'ok';",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "src", "auth", "middleware.ts"),
      [
        "// Middleware invoking session refresh during protected requests",
        "// FEATURE: auth session workflow for artifact and hub tests",
        "import { refreshSession } from './session';",
        "export function authMiddleware() {",
        "  return refreshSession();",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "src", "index.ts"),
      [
        "// Entry point for the auth workflow fixture",
        "// FEATURE: auth session workflow for artifact and hub tests",
        "import { authMiddleware } from './auth/middleware';",
        "export function run() {",
        "  return authMiddleware();",
        "}",
        "",
      ].join("\n"),
    );

    originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return {
        embeddings: batch.map((value) => {
          const text = String(value).toLowerCase();
          return [
            text.includes("auth") ? 1 : 0.1,
            text.includes("session") ? 0.9 : 0.1,
            text.includes("middleware") ? 0.8 : 0.1,
            text.includes("run") ? 0.7 : 0.1,
          ];
        }),
      };
    };
  });

  afterEach(async () => {
    Ollama.prototype.embed = originalEmbed;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("persists artifacts, reports trust metadata, exposes timings, and discovers auto hubs", async () => {
    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "agent-flow-fixture",
      sessionSource: "codex",
    });

    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const searchMod = await import("../../build/tools/search.js");
    const repoMapMod = await import("../../build/tools/repo-map.js");
    const artifactsMod = await import("../../build/core/artifacts.js");
    const hubMod = await import("../../build/core/hub.js");
    const metricsMod = await import("../../build/core/tool-metrics.js");
    const statusMod = await import("../../build/tools/status.js");

    const search = await searchMod.unifiedSearchData({
      rootDir: fixtureRoot,
      query: "auth session middleware",
      mode: "hybrid",
      persistArtifact: true,
    });
    assert.ok(search.trust.artifact?.id);
    assert.ok(search.freshness.indexGeneration >= 1);

    const repoMap = await repoMapMod.getRepoMapData({
      rootDir: fixtureRoot,
      maxFiles: 5,
      maxSymbolsPerFile: 4,
      format: "json",
    });
    assert.ok(repoMap.trust.artifact?.id);

    const artifacts = await artifactsMod.listArtifacts(fixtureRoot);
    assert.ok(artifacts.some((artifact) => artifact.kind === "search"));
    assert.ok(artifacts.some((artifact) => artifact.kind === "repo_map"));

    const storedSearch = await artifactsMod.readArtifact(fixtureRoot, search.trust.artifact.id);
    assert.equal(storedSearch?.payload.query, "auth session middleware");

    const hubs = await hubMod.discoverHubs(fixtureRoot);
    assert.ok(hubs.some((hub) => hub.startsWith(".contextplus/hubs/")));

    metricsMod.recordToolTiming(fixtureRoot, "search", 12, "ok");
    const status = await statusMod.getStatusData({ rootDir: fixtureRoot, format: "json" });
    assert.ok(status.tools.timings.some((timing) => timing.tool === "search"));
    assert.ok(status.index.autoHubCount >= 1);
  });
});
