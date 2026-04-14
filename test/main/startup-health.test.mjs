import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

describe("startup health", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-startup-health-"));
    await mkdir(join(fixtureRoot, ".contextplus"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reports healthy startup data for a valid project root", async () => {
    const mod = await import("../../build/core/startup-health.js");
    const report = await mod.runStartupHealthCheck(fixtureRoot);

    assert.equal(report.status, "ok");
    assert.equal(report.project.ok, true);
    assert.equal(report.storage.ok, true);
    assert.equal(report.storage.databaseOpen.ok, true);
    assert.equal(report.rootDir, fixtureRoot);
  });

  it("formats native dependency diagnostics with remediation steps", async () => {
    const mod = await import("../../build/core/db.js");
    const diagnostic = mod.describeNativeStorageError(new Error("Could not locate the bindings file."));

    assert.equal(diagnostic.code, "native_module_missing");
    assert.match(diagnostic.message, /Could not locate the bindings file/);
    assert.ok(diagnostic.remediation.some((step) => step.includes("npm install")));
    assert.ok(diagnostic.remediation.some((step) => step.includes(process.execPath)));
  });
});
