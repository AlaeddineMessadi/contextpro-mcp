import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("native repair helpers", () => {
  it("flags repairable native storage failures", async () => {
    const mod = await import("../../build/core/native-repair.js");

    assert.equal(mod.isRepairableNativeError("native_module_missing"), true);
    assert.equal(mod.isRepairableNativeError("native_module_abi_mismatch"), true);
    assert.equal(mod.isRepairableNativeError("native_module_error"), true);
    assert.equal(mod.isRepairableNativeError("something_else"), false);
    assert.equal(mod.isRepairableNativeError(undefined), false);
  });

  it("enables auto repair by default and honors opt-out env values", async () => {
    const mod = await import("../../build/core/native-repair.js");
    const previous = process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR;

    delete process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR;
    assert.equal(mod.isNativeAutoRepairEnabled(), true);

    process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR = "false";
    assert.equal(mod.isNativeAutoRepairEnabled(), false);

    process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR = "off";
    assert.equal(mod.isNativeAutoRepairEnabled(), false);

    process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR = "true";
    assert.equal(mod.isNativeAutoRepairEnabled(), true);

    if (previous === undefined) delete process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR;
    else process.env.CONTEXTPLUS_NATIVE_AUTO_REPAIR = previous;
  });

  it("resolves repair root to ContextPlus package root, not active workspace root", async () => {
    const mod = await import("../../build/core/native-repair.js");
    const packageRoot = mod.getContextPlusPackageRoot();
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf-8"));

    assert.equal(pkg.name, "contextplus");
    assert.equal(packageRoot.endsWith("/contextplus-official"), true);
  });
});
