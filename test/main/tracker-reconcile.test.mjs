// Tracker reconcile-sweep integration tests
// FEATURE: The embedding tracker runs a periodic self-healing reconcile sweep so
// drift the FS-watch misses is caught automatically. The sweep skips the FS walk
// when idle, but still forces a periodic deep sweep to catch out-of-band changes
// (git checkout, atomic renames). These tests inject fakes for the sweep + clock
// so behavior is verified deterministically without real timers or a real repo.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createReconcileScheduler } from "../../build/core/reconcile-scheduler.js";

describe("reconcile scheduler", () => {
  it("does not sweep while idle when no activity occurred", async () => {
    let sweeps = 0;
    const scheduler = createReconcileScheduler({
      rootDir: ".",
      forceEverySweeps: 100,
      sweep: async () => {
        sweeps += 1;
        return { refreshed: 0, removed: 0, drifted: 0, pending: 0, changedSymbols: [] };
      },
    });

    // Several idle ticks with no signalled activity → no FS walk.
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(sweeps, 0, "idle ticks must not trigger a sweep");
  });

  it("sweeps after activity is signalled, then returns to idle", async () => {
    let sweeps = 0;
    const scheduler = createReconcileScheduler({
      rootDir: ".",
      forceEverySweeps: 100,
      sweep: async () => {
        sweeps += 1;
        return { refreshed: 1, removed: 0, drifted: 1, pending: 0, changedSymbols: [] };
      },
    });

    scheduler.signalActivity();
    await scheduler.tick();
    assert.equal(sweeps, 1, "activity should trigger exactly one sweep");

    // No further activity → idle again.
    await scheduler.tick();
    assert.equal(sweeps, 1, "no extra sweep without new activity");
  });

  it("forces a deep sweep periodically even when idle (catches git ops)", async () => {
    let sweeps = 0;
    const scheduler = createReconcileScheduler({
      rootDir: ".",
      forceEverySweeps: 3,
      sweep: async () => {
        sweeps += 1;
        return { refreshed: 0, removed: 0, drifted: 0, pending: 0, changedSymbols: [] };
      },
    });

    await scheduler.tick(); // 1 idle
    await scheduler.tick(); // 2 idle
    await scheduler.tick(); // 3rd → forced deep sweep
    assert.equal(sweeps, 1, "a forced deep sweep should fire on the Nth idle tick");
  });

  it("keeps sweeping promptly while a backlog is pending", async () => {
    let sweeps = 0;
    const pendings = [5, 2, 0];
    const scheduler = createReconcileScheduler({
      rootDir: ".",
      forceEverySweeps: 100,
      sweep: async () => {
        const pending = pendings[sweeps] ?? 0;
        sweeps += 1;
        return { refreshed: 4, removed: 0, drifted: 9, pending, changedSymbols: [] };
      },
    });

    scheduler.signalActivity();
    await scheduler.tick(); // pending=5 → stays hot
    assert.equal(scheduler.isDraining(), true, "should be draining while pending > 0");
    await scheduler.tick(); // pending=2 → still hot
    await scheduler.tick(); // pending=0 → drained
    assert.equal(sweeps, 3, "should keep sweeping until the backlog drains");
    assert.equal(scheduler.isDraining(), false);
  });

  it("never runs two sweeps concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let sweeps = 0;
    const scheduler = createReconcileScheduler({
      rootDir: ".",
      forceEverySweeps: 100,
      sweep: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (sweeps === 0) await gate;
        sweeps += 1;
        active -= 1;
        return { refreshed: 0, removed: 0, drifted: 0, pending: 0, changedSymbols: [] };
      },
    });

    scheduler.signalActivity();
    const first = scheduler.tick();
    scheduler.signalActivity();
    const second = scheduler.tick(); // must not start while first is in-flight
    release();
    await Promise.all([first, second]);
    assert.equal(maxActive, 1, "sweeps must be serialized");
  });
});
