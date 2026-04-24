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
      /Unsafe implicit root/,
    );
  });

  it("allows unsafe root when explicit or override set", async () => {
    const mod = await import("../../build/core/root-guard.js");
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "flag" }));

    const previous = process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = "true";
    assert.doesNotThrow(() => mod.validateSelectedRoot({ rootDir: "/", source: "cwd" }));
    if (previous === undefined) delete process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT;
    else process.env.CONTEXTPLUS_ALLOW_UNSAFE_ROOT = previous;
  });
});
