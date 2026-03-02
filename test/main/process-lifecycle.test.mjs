import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBrokenPipeError, runCleanup } from "../../build/core/process-lifecycle.js";

describe("process-lifecycle", () => {
  it("detects broken pipe style stream errors", () => {
    assert.equal(isBrokenPipeError({ code: "EPIPE" }), true);
    assert.equal(isBrokenPipeError({ code: "ERR_STREAM_DESTROYED" }), true);
    assert.equal(isBrokenPipeError({ code: "ECONNRESET" }), true);
  });

  it("ignores non-broken-pipe errors", () => {
    assert.equal(isBrokenPipeError({ code: "ENOENT" }), false);
    assert.equal(isBrokenPipeError(new Error("x")), false);
    assert.equal(isBrokenPipeError(undefined), false);
  });

  it("runs cleanup hooks and stopTracker", async () => {
    const calls = [];
    await runCleanup({
      stopTracker: () => { calls.push("tracker"); },
      closeServer: async () => { calls.push("server"); },
      closeTransport: async () => { calls.push("transport"); },
    });
    assert.equal(calls.includes("tracker"), true);
    assert.equal(calls.includes("server"), true);
    assert.equal(calls.includes("transport"), true);
  });
});
