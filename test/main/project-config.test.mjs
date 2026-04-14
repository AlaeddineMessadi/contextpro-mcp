import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";
let originalHome = process.env.HOME;

describe("project-config", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-project-config-"));
    process.env.HOME = fixtureRoot;
    await mkdir(join(fixtureRoot, ".contextplus"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("adds project identity without dropping provider config", async () => {
    await writeFile(
      join(fixtureRoot, ".contextplus", "config.json"),
      JSON.stringify({
        provider: "ollama",
        embedModel: "nomic-embed-text",
        chatModel: "llama3.2",
      }, null, 2),
    );

    const mod = await import("../../build/core/project-config.js");
    const config = await mod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "demo-project",
      clientId: "demo-client",
      sessionSource: "codex",
    });

    assert.equal(config.projectId, "demo-project");
    assert.equal(config.clientId, "demo-client");
    assert.equal(config.provider, "ollama");
    assert.equal(config.embedModel, "nomic-embed-text");
    assert.equal(config.sessionSource, "codex");

    const saved = JSON.parse(await readFile(join(fixtureRoot, ".contextplus", "config.json"), "utf-8"));
    assert.equal(saved.projectId, "demo-project");
    assert.equal(saved.provider, "ollama");
  });

  it("registers workspaces and promoted patterns in the user registry", async () => {
    const mod = await import("../../build/core/project-config.js");
    const config = await mod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "registry-project",
      clientId: "registry-client",
      sessionSource: "cursor",
    });
    await mod.registerWorkspace(config);

    const workspaces = await mod.listRegisteredWorkspaces("registry-client");
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].projectId, "registry-project");

    const pattern = await mod.createPromotedPattern({
      sourceMemoryId: "task-123",
      targetScope: "client",
      clientId: "registry-client",
      projectId: "registry-project",
      summary: "Reusable retry pattern",
      sanitize: true,
    });

    assert.equal(pattern.targetScope, "client");

    const patterns = await mod.listPromotedPatterns("registry-client");
    assert.ok(patterns.some((item) => item.patternId === pattern.patternId));
  });
});
