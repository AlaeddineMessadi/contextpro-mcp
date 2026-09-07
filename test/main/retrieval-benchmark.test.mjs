import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRetrievalBenchmark, retrievalMetrics, summarizePairedAgentRuns } from "../../scripts/benchmark-retrieval.mjs";

describe("retrieval benchmark", () => {
  it("executes the fixed corpus offline and reports bounded ranking and output metrics", async () => {
    const report = await runRetrievalBenchmark();
    assert.equal(report.summary.tasks, 5);
    assert.equal(report.summary.providerCalls, 0, "keyword-only search must never attempt a provider call");
    assert.equal(report.methodology.moneySavedUsd, null);
    assert.equal(report.methodology.agentTokensSaved, null);
    assert.equal(report.externalAgentRuns, null);
    for (const row of report.tasks) {
      for (const variant of ["baseline", "contextpro"]) {
        const result = row[variant];
        assert.ok(result.paths.length > 0 && result.paths.length <= 5, `${row.taskId}/${variant} should return useful bounded discovery`);
        assert.equal(result.hitAt1, 1, `${row.taskId}/${variant} should rank a relevant file first`);
        assert.equal(result.recallAt5, 1, `${row.taskId}/${variant} should retrieve all fixture-relevant files`);
        assert.ok(result.outputBytes > 0);
        assert.ok(result.estimatedOutputTokens > 0);
        assert.ok(result.coldLatencyMs >= 0 && result.warmLatencyMs >= 0);
      }
      assert.ok(row.contextpro.concurrentQueriesPerSecond > 0);
      assert.ok(row.packetGraph.relatedFiles <= 4);
      assert.ok(row.packetGraph.recallAt5 >= row.packetDefault.recallAt5);
      assert.ok(row.packetGraph.estimatedOutputTokens <= 2048);
    }
    const stale = report.tasks.find((row) => row.taskId === "recover-stale-index");
    assert.equal(stale.contextpro.freshness.refreshed, true);
    const worktree = report.tasks.find((row) => row.taskId === "worktree-local-implementation");
    assert.equal(worktree.contextpro.freshness.refreshed, true);
  });

  it("counts missed relevant files and does not claim success from a partial result", () => {
    assert.deepEqual(retrievalMetrics(["wrong.ts", "right.ts", "right.ts"], ["right.ts", "missed.ts"]), {
      hitAt1: 0, reciprocalRank: 0.5, recallAt5: 0.5, precisionAt5: 0.2,
    });
    assert.equal(retrievalMetrics([], ["right.ts"]).recallAt5, 0);
  });

  it("requires paired actual usage and preserves negative cost differences", () => {
    const common = { taskId: "fix-auth", pairId: "run-1", model: "evaluator-model", inputTokens: 100, outputTokens: 50, tokenSource: "provider_usage", costSource: "provider_billing" };
    const baseline = { ...common, variant: "baseline", success: false, costUsd: 0.01 };
    const contextpro = { ...common, variant: "contextpro", success: true, costUsd: 0.02 };
    const report = summarizePairedAgentRuns([baseline, contextpro]);
    assert.equal(report.pairs, 1);
    assert.equal(report.baselineSuccesses, 0);
    assert.equal(report.contextproSuccesses, 1);
    assert.equal(report.costDifferenceUsd, -0.01);
    assert.equal(report.inputTokenDifference, 0);
    assert.throws(() => summarizePairedAgentRuns([baseline]), /pair/);
    assert.throws(() => summarizePairedAgentRuns([baseline, { ...contextpro, tokenSource: "estimated" }]), /measured provider usage/);
    assert.throws(() => summarizePairedAgentRuns([baseline, { ...contextpro, model: "different" }]), /pair/);
    assert.throws(() => summarizePairedAgentRuns([baseline, baseline, contextpro]), /Duplicate/);
  });
});
