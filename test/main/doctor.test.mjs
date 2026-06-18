import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fixtureRoot = "";

describe("doctor", () => {
  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "contextplus-doctor-"));
    await mkdir(join(fixtureRoot, ".contextpro"), { recursive: true });
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reports current health without running repair actions", async () => {
    const mod = await import("../../build/core/doctor.js");
    const report = await mod.runDoctor(fixtureRoot, false);

    assert.equal(report.fixApplied, false);
    assert.equal(report.actions.length, 0);
    assert.equal(report.before.status, "ok");
    assert.equal(report.after.status, "ok");
  });

  it("formats doctor output with before and after status", async () => {
    const mod = await import("../../build/core/doctor.js");
    const report = await mod.runDoctor(fixtureRoot, false);
    const text = mod.formatDoctorReport(report);

    assert.match(text, /ContextPro Doctor/);
    assert.match(text, /Before: ok/);
    assert.match(text, /After: ok/);
  });
});
