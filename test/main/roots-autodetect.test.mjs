import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("roots auto-detection — selection logic", () => {
  it("returns undefined when there are no client roots", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    assert.equal(mod.selectRootFromList([], "/cwd"), undefined);
  });

  it("returns the only root when exactly one is advertised", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const picked = mod.selectRootFromList(["file:///repo/wt"], "/whatever");
    assert.equal(picked, "/repo/wt");
  });

  it("prefers the root that contains the request cwd when several exist", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const picked = mod.selectRootFromList(
      ["file:///repo/main", "file:///repo/wt-a", "file:///repo/wt-b"],
      "/repo/wt-a/src/file.ts",
    );
    assert.equal(picked, "/repo/wt-a");
  });

  it("returns undefined when several roots exist and none contains the cwd", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const picked = mod.selectRootFromList(
      ["file:///repo/main", "file:///repo/wt-a"],
      "/somewhere/else",
    );
    assert.equal(picked, undefined);
  });

  it("does not match a sibling that shares a name prefix", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    assert.equal(mod.selectRootFromList(["file:///x/app", "file:///x/other"], "/x/app2/src"), undefined);
    assert.equal(mod.selectRootFromList(["file:///x/app", "file:///x/app2"], "/x/app2/src"), "/x/app2");
  });

  it("counts a child folder named ..foo as inside its root", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    assert.equal(mod.selectRootFromList(["file:///x/app", "file:///y"], "/x/app/..foo/file.ts"), "/x/app");
  });

  it("decodes percent-encoded file URIs", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const picked = mod.selectRootFromList(["file:///repo/my%20wt"], "/x");
    assert.equal(picked, "/repo/my wt");
  });

  it("ignores non-file URIs", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const picked = mod.selectRootFromList(["https://example.com/x"], "/x");
    assert.equal(picked, undefined);
  });
});

describe("roots auto-detection — resolveAutoRoot orchestration", () => {
  it("uses the provider result when no explicit root is given", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const provider = async () => ["file:///repo/wt"];
    const root = await mod.resolveAutoRoot(undefined, "/boot", provider, "/repo/wt/sub");
    assert.equal(root, "/repo/wt");
  });

  it("prefers an explicit root over the provider", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    let called = false;
    const provider = async () => { called = true; return ["file:///repo/other"]; };
    const root = await mod.resolveAutoRoot("/explicit", "/boot", provider, "/x");
    assert.equal(root, "/explicit");
    assert.equal(called, false, "provider must not be queried when root is explicit");
  });

  it("falls back to boot root when the provider yields nothing usable", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const provider = async () => [];
    const root = await mod.resolveAutoRoot(undefined, "/boot", provider, "/x");
    assert.equal(root, "/boot");
  });

  it("falls back to boot root when the provider throws", async () => {
    const mod = await import("../../build/core/roots-detect.js");
    const provider = async () => { throw new Error("client has no roots capability"); };
    const root = await mod.resolveAutoRoot(undefined, "/boot", provider, "/x");
    assert.equal(root, "/boot");
  });
});
