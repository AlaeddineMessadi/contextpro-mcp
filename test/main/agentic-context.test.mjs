import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

let fixtureRoot = "";
let originalEmbed;
let originalHome = process.env.HOME;

describe("agentic-context", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-agentic-"));
    process.env.HOME = fixtureRoot;
    await mkdir(join(fixtureRoot, "src", "auth"), { recursive: true });
    await mkdir(join(fixtureRoot, "test", "auth"), { recursive: true });
    await writeFile(
      join(fixtureRoot, "README.md"),
      [
        "# Auth Session Refresh Race Condition",
        "",
        "This doc explains how to fix the auth session refresh race condition and session lock bug.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "auth-fixture",
        type: "module",
        scripts: {
          test: "node --test test/main/*.test.mjs",
          build: "tsc",
          lint: "eslint .",
        },
      }, null, 2) + "\n",
    );
    await writeFile(
      join(fixtureRoot, "src", "auth", "session.ts"),
      [
        "// Auth session refresh logic for concurrency-safe token reuse",
        "// FEATURE: auth session workflow context for task pack tests",
        "export function refreshSession() {",
        "  return withSessionLock();",
        "}",
        "export function withSessionLock() {",
        "  return 'ok';",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "src", "auth", "middleware.ts"),
      [
        "// Auth middleware calling session refresh during protected requests",
        "// FEATURE: auth middleware fixture used for impact analysis tests",
        "import { refreshSession } from './session';",
        "export function authMiddleware() {",
        "  return refreshSession();",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(fixtureRoot, "test", "auth", "session.test.ts"),
      [
        "// Auth session regression coverage for refresh and lock flow",
        "// FEATURE: auth tests fixture for contextplus task intelligence",
        "import { refreshSession } from '../../src/auth/session';",
        "refreshSession();",
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
            text.includes("test") ? 0.8 : 0.1,
            text.includes("lock") ? 0.7 : 0.1,
          ];
        }),
      };
    };
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    Ollama.prototype.embed = originalEmbed;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("builds task packs and change impact in structured mode", async () => {
    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "auth-fixture",
      clientId: "demo-client",
      sessionSource: "codex",
    });

    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("../../build/tools/agentic-context.js");
    const taskPack = JSON.parse(await agenticMod.buildTaskPack({
      rootDir: fixtureRoot,
      task: "fix auth session refresh race condition",
      includeRecentDiffs: false,
      format: "json",
    }));

    assert.equal(taskPack.repo.projectId, "auth-fixture");
    assert.ok(taskPack.trust.artifact.id.startsWith("task_pack-"));
    assert.ok(taskPack.freshness.indexGeneration >= 1);
    assert.ok(taskPack.files.some((file) => file.path.includes("session.ts")));
    assert.notEqual(taskPack.files[0].path, "README.md");
    assert.ok(taskPack.tests.some((test) => test.path.includes("session.test.ts")));

    const compactText = await agenticMod.buildTaskPack({
      rootDir: fixtureRoot,
      task: "fix auth session refresh race condition",
      includeRecentDiffs: false,
      maxTokens: 512,
      format: "json",
    });
    const compact = JSON.parse(compactText);
    assert.equal(compact.budget.maxTokens, 512);
    assert.ok(compactText.length <= 512 * 4, `compact task pack exceeded budget: ${compactText.length} chars`);
    assert.ok(compact.files.some((file) => file.path.includes("session.ts")), "budgeting must preserve the primary file");

    const impact = JSON.parse(await agenticMod.buildChangeImpact({
      rootDir: fixtureRoot,
      files: ["src/auth/session.ts"],
      format: "json",
    }));

    assert.ok(impact.trust.artifact.id.startsWith("change_impact-"));
    assert.ok(impact.affectedFiles.some((file) => file.path.includes("middleware.ts")));
    assert.ok(impact.affectedFiles.every((file) => file.kind !== "text_match"));
    assert.ok(Array.isArray(impact.affectedTests));
  });

  it("builds edit scope and validation with code-first ranking", async () => {
    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "auth-fixture",
      clientId: "demo-client",
      sessionSource: "codex",
    });

    const reindexMod = await import("../../build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("../../build/tools/agentic-context.js");
    const editScope = JSON.parse(await agenticMod.buildEditScope({
      rootDir: fixtureRoot,
      task: "fix auth session refresh race condition",
      format: "json",
    }));
    assert.ok(editScope.recommendedScope.some((item) => item.path === "src/auth/session.ts"));
    assert.ok(editScope.recommendedScope.every((item) => item.path !== "README.md"));

    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "fix auth session refresh race condition",
      format: "json",
    }));
    assert.ok(validation.tests.some((test) => test.path === "test/auth/session.test.ts"));
    assert.ok(validation.checks.some((check) => check.command.includes("npm run test -- test/auth/session.test.ts")));
    assert.ok(validation.checks.some((check) => check.command === "npm run build"));
  });

  it("records task memory and promotes patterns", async () => {
    const projectMod = await import("../../build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "auth-fixture",
      clientId: "demo-client",
      sessionSource: "codex",
    });

    const agenticMod = await import("../../build/tools/agentic-context.js");
    const recorded = JSON.parse(await agenticMod.recordTaskMemory({
      rootDir: fixtureRoot,
      task: "fix auth session refresh race condition",
      summary: "Added safer session lock handling",
      files: ["src/auth/session.ts", "test/auth/session.test.ts"],
      format: "json",
    }));

    assert.ok(recorded.taskMemoryId);
    assert.ok(recorded.linkedNodes.length >= 2);

    const promoted = JSON.parse(await agenticMod.promotePattern({
      rootDir: fixtureRoot,
      sourceMemoryId: recorded.taskMemoryId,
      targetScope: "client",
      summary: "Reusable session lock retry pattern",
      format: "json",
    }));

    assert.equal(promoted.targetScope, "client");
    assert.equal(promoted.linkedSource, recorded.taskMemoryId);
  });
});
