// tool_calls persistence tests — dashboard-readable tool-call history
// FEATURE: A separate dashboard process reads real tool-call history across MCP
// restarts, so tool invocations are persisted to the per-root DB.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";

describe("tool_calls DB persistence", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-toolcalls-"));
    const { ensureProjectConfig } = await import("../../build/core/project-config.js");
    await ensureProjectConfig({ rootDir: root, projectId: "toolcalls-fixture", sessionSource: "codex" });
  });

  afterEach(async () => {
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("records and reads back tool-call history newest-first", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    db.recordToolCall("search", "ok", 12, 1000);
    db.recordToolCall("semantic_diff", "ok", 34, 2000);
    db.recordToolCall("search", "error", 99, 3000);

    const history = db.getToolCallHistory(10);
    assert.equal(history.length, 3);
    assert.equal(history[0].tool, "search");
    assert.equal(history[0].status, "error");
    assert.equal(history[0].calledAt, 3000);
    assert.equal(history[2].calledAt, 1000);
  });

  it("aggregates per tool with calls/errors/avg/max", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    db.recordToolCall("search", "ok", 10, 1000);
    db.recordToolCall("search", "ok", 30, 2000);
    db.recordToolCall("search", "error", 50, 3000);
    db.recordToolCall("status", "ok", 5, 1500);

    const aggs = db.getToolCallAggregates();
    const search = aggs.find((a) => a.tool === "search");
    assert.ok(search);
    assert.equal(search.calls, 3);
    assert.equal(search.errors, 1);
    assert.equal(search.avgMs, 30); // (10+30+50)/3
    assert.equal(search.maxMs, 50);
    assert.equal(search.lastAt, 3000);
  });

  it("filters aggregates by sinceMs", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    db.recordToolCall("search", "ok", 10, 1000);
    db.recordToolCall("search", "ok", 10, 5000);

    const recent = db.getToolCallAggregates(4000);
    const search = recent.find((a) => a.tool === "search");
    assert.equal(search.calls, 1, "only the call at 5000 should count");
  });

  it("prunes to a bounded size keeping the newest", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);
    for (let i = 0; i < 20; i++) db.recordToolCall("t", "ok", 1, 1000 + i);
    assert.equal(db.getToolCallTotal(), 20);

    const removed = db.pruneToolCalls(5);
    assert.equal(removed, 15);
    assert.equal(db.getToolCallTotal(), 5);
    const history = db.getToolCallHistory(10);
    assert.equal(history[0].calledAt, 1019, "newest must survive pruning");
  });

  it("the tool-metrics sink writes through to the DB", async () => {
    const { setToolCallSink, recordToolTiming } = await import("../../build/core/tool-metrics.js");
    const { getDB } = await import("../../build/core/db.js");
    const db = await getDB(root);

    setToolCallSink((event) => {
      db.recordToolCall(event.tool, event.status, event.durationMs, event.calledAt);
    });
    recordToolTiming(root, "repo_map", 42, "ok");
    setToolCallSink(null);

    const history = db.getToolCallHistory(10);
    assert.ok(history.some((h) => h.tool === "repo_map"), "sink should persist the call");
  });
});
