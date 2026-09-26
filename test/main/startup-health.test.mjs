import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

let fixtureRoot = "";

describe("startup health", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-startup-health-"));
    await mkdir(join(fixtureRoot, ".contextpro"), { recursive: true });
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

    const formatted = mod.formatStartupHealthReport(report);
    assert.match(formatted, /\[contextpro\/startup\]/);
    assert.doesNotMatch(formatted, /\[contextplus\/startup\]/);
  });

  it("keeps the running build identity stable when artifacts on disk change", async (t) => {
    const mod = await import("../../build/core/startup-health.js");
    const initial = await mod.runStartupHealthCheck(fixtureRoot);
    const stat = fs.statSync;
    t.mock.method(fs, 'statSync', (path, ...args) => String(path).endsWith('/build/index.js')
      ? { mtime: new Date('2099-01-01T00:00:00Z') } : stat(path, ...args));
    syncBuiltinESMExports();
    try {
      const later = await mod.runStartupHealthCheck(fixtureRoot);
      assert.equal(later.runtime.buildStamp, initial.runtime.buildStamp);
      assert.notEqual(later.runtime.buildStamp, '2099-01-01T00:00:00.000Z');
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });

  it("formats native dependency diagnostics with remediation steps", async () => {
    const mod = await import("../../build/core/db.js");
    const diagnostic = mod.describeNativeStorageError(new Error("Could not locate the bindings file."));

    assert.equal(diagnostic.code, "native_module_missing");
    assert.match(diagnostic.message, /Could not locate the bindings file/);
    assert.ok(diagnostic.remediation.some((step) => step.includes("doctor --fix")));
    assert.ok(diagnostic.remediation.some((step) => step.includes(process.execPath)));
  });
});
