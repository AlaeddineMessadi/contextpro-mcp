import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";

let fixtureRoot = "";
let originalEmbed;
let originalHome = process.env.HOME;

describe("pytest detection from pyproject.toml", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-pytest-"));
    process.env.HOME = fixtureRoot;
    
    // Create basic Python project structure
    await mkdir(join(fixtureRoot, "src"), { recursive: true });
    await mkdir(join(fixtureRoot, "tests"), { recursive: true });
    
    // Create a simple Python source file
    await writeFile(
      join(fixtureRoot, "src", "app.py"),
      'def hello():\n    return "world"\n'
    );
    
    // Create a simple Python test file
    await writeFile(
      join(fixtureRoot, "tests", "test_app.py"),
      'from src.app import hello\n\ndef test_hello():\n    assert hello() == "world"\n'
    );

    originalEmbed = Ollama.prototype.embed;
    Ollama.prototype.embed = async function ({ input }) {
      const batch = Array.isArray(input) ? input : [input];
      return {
        embeddings: batch.map((value) => {
          const text = String(value).toLowerCase();
          return [
            text.includes("test") ? 0.9 : 0.1,
            text.includes("python") ? 0.8 : 0.1,
            text.includes("app") ? 0.7 : 0.1,
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

  it("detects pytest config from [tool.pytest.ini_options] in pyproject.toml", async () => {
    // Create pyproject.toml with pytest config
    await writeFile(
      join(fixtureRoot, "pyproject.toml"),
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        'python_files = ["test_*.py"]',
        "",
      ].join("\n"),
    );

    const projectMod = await import("/path/to/contextpro-mcp/build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "pytest-fixture",
      clientId: "demo-client",
      sessionSource: "test",
    });

    const reindexMod = await import("/path/to/contextpro-mcp/build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("/path/to/contextpro-mcp/build/tools/agentic-context.js");
    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "add new feature to app",
      format: "json",
    }));

    // Verify pytest detection
    const pytestCheck = validation.checks.find((check) => check.type === "test");
    assert.ok(pytestCheck, "Should have detected pytest check");
    assert.ok(
      pytestCheck.command.includes("pytest"),
      `Expected 'pytest' in command, got: ${pytestCheck.command}`
    );
    console.log("✓ Test 1 PASSED: pytest command found:", pytestCheck.command);
    console.log("  Reason:", pytestCheck.reason);
  });

  it("uses 'uv run pytest' when uv.lock is present", async () => {
    // Create pyproject.toml with pytest config
    await writeFile(
      join(fixtureRoot, "pyproject.toml"),
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    );

    // Create uv.lock to indicate uv-managed project
    await writeFile(join(fixtureRoot, "uv.lock"), "# uv lock file\n");

    const projectMod = await import("/path/to/contextpro-mcp/build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "pytest-uv-fixture",
      clientId: "demo-client",
      sessionSource: "test",
    });

    const reindexMod = await import("/path/to/contextpro-mcp/build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("/path/to/contextpro-mcp/build/tools/agentic-context.js");
    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "add new feature to app",
      format: "json",
    }));

    const pytestCheck = validation.checks.find((check) => check.type === "test");
    assert.ok(pytestCheck, "Should have detected pytest check");
    assert.ok(
      pytestCheck.command.includes("uv run pytest"),
      `Expected 'uv run pytest' in command, got: ${pytestCheck.command}`
    );
    console.log("✓ Test 2 PASSED: uv run pytest command found:", pytestCheck.command);
    console.log("  Reason:", pytestCheck.reason);
  });

  it("uses '.venv/bin/pytest' when .venv exists without uv.lock", async () => {
    // Create pyproject.toml with pytest config
    await writeFile(
      join(fixtureRoot, "pyproject.toml"),
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    );

    // Create .venv/bin/python to simulate virtualenv
    await mkdir(join(fixtureRoot, ".venv", "bin"), { recursive: true });
    await writeFile(join(fixtureRoot, ".venv", "bin", "python"), "#!/bin/bash\n");
    await writeFile(join(fixtureRoot, ".venv", "bin", "pytest"), "#!/bin/bash\n");

    const projectMod = await import("/path/to/contextpro-mcp/build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "pytest-venv-fixture",
      clientId: "demo-client",
      sessionSource: "test",
    });

    const reindexMod = await import("/path/to/contextpro-mcp/build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("/path/to/contextpro-mcp/build/tools/agentic-context.js");
    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "add new feature to app",
      format: "json",
    }));

    const pytestCheck = validation.checks.find((check) => check.type === "test");
    assert.ok(pytestCheck, "Should have detected pytest check");
    assert.ok(
      pytestCheck.command.includes(".venv/bin/pytest"),
      `Expected '.venv/bin/pytest' in command, got: ${pytestCheck.command}`
    );
    console.log("✓ Test 3 PASSED: .venv/bin/pytest command found:", pytestCheck.command);
    console.log("  Reason:", pytestCheck.reason);
  });

  it("falls back to bare 'pytest' without uv.lock or .venv", async () => {
    // Create pyproject.toml with pytest config (no uv.lock, no .venv)
    await writeFile(
      join(fixtureRoot, "pyproject.toml"),
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    );

    const projectMod = await import("/path/to/contextpro-mcp/build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "pytest-bare-fixture",
      clientId: "demo-client",
      sessionSource: "test",
    });

    const reindexMod = await import("/path/to/contextpro-mcp/build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("/path/to/contextpro-mcp/build/tools/agentic-context.js");
    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "add new feature to app",
      format: "json",
    }));

    const pytestCheck = validation.checks.find((check) => check.type === "test");
    assert.ok(pytestCheck, "Should have detected pytest check");
    assert.ok(
      pytestCheck.command.match(/^pytest\s/) || pytestCheck.command.includes(" -q"),
      `Expected bare pytest command, got: ${pytestCheck.command}`
    );
    assert.ok(
      !pytestCheck.command.includes("uv run"),
      `Should not have uv run, got: ${pytestCheck.command}`
    );
    assert.ok(
      !pytestCheck.command.includes(".venv"),
      `Should not have .venv, got: ${pytestCheck.command}`
    );
    console.log("✓ Test 4 PASSED: bare pytest command found:", pytestCheck.command);
    console.log("  Reason:", pytestCheck.reason);
  });

  it("prioritizes .venv over uv.lock when both exist (current implementation behavior)", async () => {
    // Create pyproject.toml with pytest config
    await writeFile(
      join(fixtureRoot, "pyproject.toml"),
      [
        "[build-system]",
        'requires = ["setuptools"]',
        "",
        "[tool.pytest.ini_options]",
        'testpaths = ["tests"]',
        "",
      ].join("\n"),
    );

    // Create both uv.lock and .venv
    await writeFile(join(fixtureRoot, "uv.lock"), "# uv lock file\n");
    await mkdir(join(fixtureRoot, ".venv", "bin"), { recursive: true });
    await writeFile(join(fixtureRoot, ".venv", "bin", "python"), "#!/bin/bash\n");

    const projectMod = await import("/path/to/contextpro-mcp/build/core/project-config.js");
    await projectMod.ensureProjectConfig({
      rootDir: fixtureRoot,
      projectId: "pytest-priority-fixture",
      clientId: "demo-client",
      sessionSource: "test",
    });

    const reindexMod = await import("/path/to/contextpro-mcp/build/tools/reindex.js");
    await reindexMod.reindex({ rootDir: fixtureRoot, force: true });

    const agenticMod = await import("/path/to/contextpro-mcp/build/tools/agentic-context.js");
    const validation = JSON.parse(await agenticMod.buildValidateScope({
      rootDir: fixtureRoot,
      task: "add new feature to app",
      format: "json",
    }));

    const pytestCheck = validation.checks.find((check) => check.type === "test");
    assert.ok(pytestCheck, "Should have detected pytest check");
    assert.ok(
      pytestCheck.command.includes(".venv/bin/pytest"),
      `Expected '.venv/bin/pytest' (.venv takes priority), got: ${pytestCheck.command}`
    );
    console.log("✓ Test 5 PASSED: prioritizes .venv over uv.lock, command:", pytestCheck.command);
    console.log("  Reason:", pytestCheck.reason);
  });
});
