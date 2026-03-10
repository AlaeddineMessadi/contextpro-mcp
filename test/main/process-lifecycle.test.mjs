import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createIdleMonitor,
  getIdleShutdownMs,
  isBrokenPipeError,
  isProcessAlive,
  runCleanup,
  startParentMonitor,
} from "../../build/core/process-lifecycle.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      stopTracker: () => {
        calls.push("tracker");
      },
      closeServer: async () => {
        calls.push("server");
      },
      closeTransport: async () => {
        calls.push("transport");
      },
    });
    assert.equal(calls.includes("tracker"), true);
    assert.equal(calls.includes("server"), true);
    assert.equal(calls.includes("transport"), true);
  });

  it("stops monitors during cleanup", async () => {
    const calls = [];
    await runCleanup({
      stopTracker: () => {
        calls.push("tracker");
      },
      stopMonitors: () => {
        calls.push("monitors");
      },
      closeServer: async () => {
        calls.push("server");
      },
      closeTransport: async () => {
        calls.push("transport");
      },
    });
    assert.deepEqual(calls, ["monitors", "tracker", "server", "transport"]);
  });

  it("parses idle timeout values with disable support", () => {
    assert.equal(getIdleShutdownMs(undefined), 900000);
    assert.equal(getIdleShutdownMs("off"), 0);
    assert.equal(getIdleShutdownMs("1000"), 60000);
  });

  it("checks process liveness through signal probing", () => {
    assert.equal(
      isProcessAlive(42, () => {}),
      true,
    );
    assert.equal(
      isProcessAlive(42, () => {
        throw { code: "ESRCH" };
      }),
      false,
    );
    assert.equal(
      isProcessAlive(42, () => {
        throw { code: "EPERM" };
      }),
      true,
    );
  });

  it("fires idle monitor after inactivity", async () => {
    let calls = 0;
    const monitor = createIdleMonitor({
      timeoutMs: 30,
      onIdle: () => {
        calls += 1;
      },
    });

    await wait(15);
    monitor.touch();
    await wait(20);
    assert.equal(calls, 0);
    await wait(20);
    assert.equal(calls, 1);
    monitor.stop();
  });

  it("fires parent monitor when parent disappears", async () => {
    let checks = 0;
    let calls = 0;
    const stop = startParentMonitor({
      parentPid: process.ppid,
      pollIntervalMs: 10,
      isProcessAlive: () => {
        checks += 1;
        return false;
      },
      onParentExit: () => {
        calls += 1;
      },
    });

    await wait(1100);
    stop();
    assert.equal(calls, 1);
    assert.equal(checks, 1);
  });
});
