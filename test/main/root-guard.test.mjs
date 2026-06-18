import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("root guard", () => {
  it("prefers explicit --root over positional and cwd", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const selected = mod.selectRootDir("/tmp/cwd", ["/tmp/positional"], "/tmp/flag");
    assert.equal(selected.rootDir, "/tmp/flag");
    assert.equal(selected.source, "flag");
  });

  it("uses positional root when provided", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const selected = mod.selectRootDir("/tmp/cwd", ["/tmp/positional"]);
    assert.equal(selected.rootDir, "/tmp/positional");
    assert.equal(selected.source, "positional");
  });

  it("rejects unsafe cwd fallback at filesystem root", async () => {
    const mod = await import("../../build/core/root-guard.js");
    assert.throws(
      () => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }),
      /Unsafe project root/,
    );
  });

  it("rejects unsafe --root flag at filesystem root", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previous = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    assert.throws(
      () => mod.validateSelectedRoot({ rootDir: "/", source: "flag" }),
      /Unsafe project root/,
    );
    if (previous !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previous;
  });

  it("allows unsafe root when override env is set", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previousNew = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    const previousLegacy = process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = "true";
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }));
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "flag" }));
    if (previousNew === undefined) delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousNew;
    if (previousLegacy === undefined) delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = previousLegacy;
  });

  it("legacy CONTEXTPLUS_ALLOW_UNSAFE_ROOT still works", async () => {
    const mod = await import("../../build/core/root-guard.js");
    const previousNew = process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    const previousLegacy = process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    delete process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT;
    process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = "true";
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }));
    if (previousNew !== undefined) process.env.CONTEXTPRO_ALLOW_UNSAFE_ROOT = previousNew;
    if (previousLegacy === undefined) delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = previousLegacy;
  });
});
