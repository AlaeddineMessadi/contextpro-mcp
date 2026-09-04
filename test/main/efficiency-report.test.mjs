// Auditable, privacy-preserving token-efficiency estimates and history.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root = "";
let priorFooter;

describe("efficiency reporting", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "contextpro-efficiency-"));
    const { ensureProjectConfig } = await import("../../build/core/project-config.js");
    await ensureProjectConfig({ rootDir: root, projectId: "efficiency-fixture", sessionSource: "test" });
    priorFooter = process.env.CONTEXTPRO_EFFICIENCY_FOOTER;
  });

  afterEach(async () => {
    if (priorFooter === undefined) delete process.env.CONTEXTPRO_EFFICIENCY_FOOTER;
    else process.env.CONTEXTPRO_EFFICIENCY_FOOTER = priorFooter;
    const { closeDB } = await import("../../build/core/db.js");
    closeDB(root);
    await rm(root, { recursive: true, force: true });
  });

  it("estimates savings only from explicitly represented indexed files", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { estimateToolEfficiency } = await import("../../build/core/efficiency.js");
    const db = await getDB(root);
    db.upsertFile("src/large.ts", "hash", "Large", "typescript", 8_000, Date.now());
    db.upsertFile("src/unmentioned.ts", "hash", "Other", "typescript", 40_000, Date.now());
    db.bumpIndexGeneration();

    const estimate = await estimateToolEfficiency(
      root,
      { file: "src/large.ts" },
      { content: [{ type: "text", text: "src/large.ts: export function useful()" }] },
    );
    assert.equal(estimate.representedFiles, 1);
    assert.equal(estimate.sourceTokens, 2_000);
    assert.ok(estimate.savedTokens > 1_900);
    assert.ok(estimate.outputTokens > 0);
  });

  it("does not count paths that occur only as another path's suffix", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { estimateToolEfficiency } = await import("../../build/core/efficiency.js");
    const db = await getDB(root);
    db.upsertFile("a.ts", "hash", "A", "typescript", 8_000, Date.now());
    db.upsertFile("index.ts", "hash", "Index", "typescript", 8_000, Date.now());
    db.bumpIndexGeneration();

    const estimate = await estimateToolEfficiency(
      root,
      {},
      { content: [{ type: "text", text: "data.ts and src/index.ts are unrelated files" }] },
    );
    assert.equal(estimate.representedFiles, 0);
    assert.equal(estimate.sourceTokens, 0);
  });

  it("counts equivalent dot-relative and absolute in-project path references", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { estimateToolEfficiency } = await import("../../build/core/efficiency.js");
    const db = await getDB(root);
    db.upsertFile("src/large.ts", "hash", "Large", "typescript", 8_000, Date.now());
    db.bumpIndexGeneration();

    for (const reference of ["./src/large.ts", resolve(root, "src/large.ts")]) {
      const estimate = await estimateToolEfficiency(
        root,
        { file: reference },
        { content: [{ type: "text", text: "No duplicate path needed." }] },
      );
      assert.equal(estimate.representedFiles, 1, `should recognize ${reference}`);
      assert.equal(estimate.sourceTokens, 2_000);
    }
  });

  it("adds a concise estimate footer and supports opting out", async () => {
    const { appendEfficiencyFooter } = await import("../../build/core/efficiency.js");
    const estimate = {
      inputTokens: 2,
      outputTokens: 20,
      sourceTokens: 2_000,
      savedTokens: 1_980,
      representedFiles: 1,
      method: "indexed-source-bytes-vs-response-chars",
    };
    const result = { content: [{ type: "text", text: "answer" }] };
    appendEfficiencyFooter(result, estimate);
    assert.match(result.content[0].text, /~1,980 source tokens avoided this call/);

    process.env.CONTEXTPRO_EFFICIENCY_FOOTER = "0";
    const disabled = { content: [{ type: "text", text: "answer" }] };
    appendEfficiencyFooter(disabled, estimate);
    assert.equal(disabled.content[0].text, "answer");
  });

  it("never corrupts JSON tool responses with a footer", async () => {
    const { appendEfficiencyFooter } = await import("../../build/core/efficiency.js");
    const result = { content: [{ type: "text", text: JSON.stringify({ file: "src/a.ts" }) }] };
    appendEfficiencyFooter(result, {
      inputTokens: 1,
      outputTokens: 5,
      sourceTokens: 1_000,
      savedTokens: 995,
      representedFiles: 1,
      method: "indexed-source-bytes-vs-response-chars",
    });
    assert.deepEqual(JSON.parse(result.content[0].text), { file: "src/a.ts" });
  });

  it("persists numeric history and computes transparent cost scenarios", async () => {
    const { getDB } = await import("../../build/core/db.js");
    const { getEfficiencyReport } = await import("../../build/tools/efficiency-report.js");
    const db = await getDB(root);
    db.recordToolCall("repo_map", "ok", 25, Date.now(), {
      inputTokens: 20,
      outputTokens: 500,
      sourceTokens: 10_000,
      savedTokens: 9_500,
      representedFiles: 8,
    });
    db.recordToolCall("search", "ok", 10, Date.now(), {
      inputTokens: 10,
      outputTokens: 100,
      sourceTokens: 2_000,
      savedTokens: 1_900,
      representedFiles: 2,
    });

    const report = JSON.parse(await getEfficiencyReport({
      rootDir: root,
      scope: "all",
      inputCostPerMillion: 5,
      format: "json",
    }));
    assert.equal(report.estimate.savedTokens, 11_400);
    assert.equal(report.estimate.representedFileReferences, 10);
    assert.equal(report.hypotheticalInputCostAvoided.usd, 0.057);
    assert.match(report.privacy, /prompts.*never retained/i);
    assert.equal(report.byTool[0].tool, "repo_map");
  });
});
