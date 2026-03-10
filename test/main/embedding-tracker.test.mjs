// Embedding tracker controller tests cover lazy startup and shutdown modes
// FEATURE: Verifies watcher creation only occurs when explicitly needed

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEmbeddingTrackerController,
  parseEmbeddingTrackerMode,
} from "../../build/core/embedding-tracker.js";

describe("embedding-tracker controller", () => {
  it("exports startEmbeddingTracker", async () => {
    const mod = await import("../../build/core/embedding-tracker.js");
    assert.equal(typeof mod.startEmbeddingTracker, "function");
  });

  it("startEmbeddingTracker takes one options argument", async () => {
    const mod = await import("../../build/core/embedding-tracker.js");
    assert.equal(mod.startEmbeddingTracker.length, 1);
  });

  it("parses tracker modes with lazy as the safe default", () => {
    assert.equal(parseEmbeddingTrackerMode(undefined), "lazy");
    assert.equal(parseEmbeddingTrackerMode("true"), "lazy");
    assert.equal(parseEmbeddingTrackerMode("lazy"), "lazy");
    assert.equal(parseEmbeddingTrackerMode("eager"), "eager");
    assert.equal(parseEmbeddingTrackerMode("off"), "off");
  });

  it("defers tracker startup in lazy mode", () => {
    let starts = 0;
    let stops = 0;
    const controller = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "true",
      starter: () => {
        starts += 1;
        return () => {
          stops += 1;
        };
      },
    });

    assert.equal(starts, 0);
    assert.equal(controller.isRunning(), false);
    controller.ensureStarted();
    controller.ensureStarted();
    assert.equal(starts, 1);
    assert.equal(controller.isRunning(), true);
    controller.stop();
    assert.equal(stops, 1);
    assert.equal(controller.isRunning(), false);
  });

  it("starts immediately in eager mode and never starts when disabled", () => {
    let eagerStarts = 0;
    const eager = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "eager",
      starter: () => {
        eagerStarts += 1;
        return () => {};
      },
    });

    assert.equal(eagerStarts, 1);
    assert.equal(eager.isRunning(), true);

    let disabledStarts = 0;
    const disabled = createEmbeddingTrackerController({
      rootDir: ".",
      mode: "false",
      starter: () => {
        disabledStarts += 1;
        return () => {};
      },
    });

    disabled.ensureStarted();
    assert.equal(disabledStarts, 0);
    assert.equal(disabled.isRunning(), false);
  });
});
