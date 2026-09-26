import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

let fixtureRoot = "";
let originalHome = process.env.HOME;

describe("project-config", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-project-config-"));
    process.env.HOME = fixtureRoot;
    await mkdir(join(fixtureRoot, ".contextpro"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("adds project identity without dropping provider config", async () => {
    await writeFile(
      join(fixtureRoot, ".contextpro", "config.json"),
      JSON.stringify({
        provider: "ollama",
        embedModel: "nomic-embed-text:latest",
        chatModel: "nemotron-3-ultra:cloud",
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
    assert.equal(config.embedModel, "nomic-embed-text:latest");
    assert.equal(config.sessionSource, "codex");

    const saved = JSON.parse(await readFile(join(fixtureRoot, ".contextpro", "config.json"), "utf-8"));
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

  it("verifies unchanged projects without writing config or requiring free disk space", async (t) => {
    const mod = await import('../../build/core/project-config.js');
    const config = await mod.ensureProjectConfig({rootDir:fixtureRoot});
    const path = join(fixtureRoot, '.contextpro', 'config.json');
    const before = await readFile(path, 'utf8');
    const full = () => { throw Object.assign(new Error('disk full'), {code:'ENOSPC'}); };
    t.mock.method(fs, 'writeFile', full);
    t.mock.method(fs, 'mkdir', full);
    t.mock.method(fs, 'open', full);
    syncBuiltinESMExports();
    try {
      assert.deepEqual(await mod.ensureProjectConfig({rootDir:fixtureRoot}), config);
      assert.deepEqual((await mod.verifyProjectContext(fixtureRoot)).config, config);
      assert.equal(await readFile(path, 'utf8'), before);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  it("preserves the previous config when an actual update runs out of disk mid-write", async (t) => {
    const mod = await import('../../build/core/project-config.js');
    const initial = await mod.ensureProjectConfig({rootDir:fixtureRoot, projectId:'original'});
    const path = join(fixtureRoot, '.contextpro', 'config.json');
    const before = await readFile(path, 'utf8');
    const realWrite = fs.writeFile, realOpen = fs.open;
    const failure = () => Object.assign(new Error('disk full'), {code:'ENOSPC'});
    // Covers the old direct-write path as well as the replacement-file path.
    t.mock.method(fs, 'writeFile', async (file, ...args) => {
      if (String(file) === path) { await realWrite(file, '{partial'); throw failure(); }
      return realWrite(file, ...args);
    });
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
      const handle = await realOpen(file, flags, ...args);
      if (String(flags).includes('w')) {
        handle.writeFile = async () => { await handle.write('{partial'); throw failure(); };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(mod.ensureProjectConfig({rootDir:fixtureRoot,projectId:'changed'}), {code:'ENOSPC'});
      assert.equal(await readFile(path,'utf8'), before);
      assert.deepEqual(await fs.readdir(join(fixtureRoot,'.contextpro')), ['config.json']);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    const updated = await mod.ensureProjectConfig({rootDir:fixtureRoot,projectId:'changed'});
    assert.equal(updated.projectId, 'changed');
    assert.equal(updated.createdAt, initial.createdAt);
    assert.equal(JSON.parse(await readFile(path,'utf8')).projectId, 'changed');
  });
});
