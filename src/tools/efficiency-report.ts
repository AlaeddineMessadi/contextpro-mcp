// Persistent, auditable summary of ContextPro response efficiency.
// FEATURE: Agents can report cumulative token estimates without retaining prompts/code.

import { getDB } from "../core/db.js";

export type EfficiencyScope = "session" | "24h" | "7d" | "all";

export interface EfficiencyReportOptions {
  rootDir: string;
  scope?: EfficiencyScope;
  sessionStartedAt?: number;
  inputCostPerMillion?: number;
  historyLimit?: number;
  format?: "text" | "json";
}

function sinceFor(scope: EfficiencyScope, sessionStartedAt?: number): number | undefined {
  const now = Date.now();
  if (scope === "session") return sessionStartedAt ?? now;
  if (scope === "24h") return now - 24 * 60 * 60_000;
  if (scope === "7d") return now - 7 * 24 * 60 * 60_000;
  return undefined;
}

function formatNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export async function getEfficiencyReport(options: EfficiencyReportOptions): Promise<string> {
  const scope = options.scope ?? "24h";
  const since = sinceFor(scope, options.sessionStartedAt);
  const db = await getDB(options.rootDir);
  const totals = db.getEfficiencyTotals(since);
  const byTool = db.getToolCallAggregates(since)
    .filter((row) => row.savedTokens > 0)
    .sort((left, right) => right.savedTokens - left.savedTokens);
  const history = db.getToolSavingsHistory(options.historyLimit ?? 10, since);
  const rate = options.inputCostPerMillion;
  const hypotheticalCost = typeof rate === "number" && Number.isFinite(rate) && rate >= 0
    ? totals.savedTokens * rate / 1_000_000
    : null;

  const report = {
    scope,
    since: since ? new Date(since).toISOString() : null,
    estimate: {
      savedTokens: totals.savedTokens,
      sourceTokensRepresented: totals.sourceTokens,
      responseTokens: totals.outputTokens,
      requestTokens: totals.inputTokens,
      representedFileReferences: totals.representedFiles,
      method: "Sum indexed byte sizes for file paths explicitly represented by each request/response, divide by four, then subtract returned text size. Estimates are not billing data and do not model provider caching.",
    },
    calls: { total: totals.calls, errors: totals.errors, averageMs: totals.avgMs, maxMs: totals.maxMs },
    hypotheticalInputCostAvoided: hypotheticalCost === null ? null : {
      usd: Number(hypotheticalCost.toFixed(6)),
      inputCostPerMillionTokens: rate,
      note: "Scenario estimate only; actual cost depends on the agent model, cache behavior, and provider billing.",
    },
    byTool,
    recentSavings: history,
    privacy: "Only numeric metrics and tool names are stored. Prompts, responses, source text, and file paths are never retained in efficiency history.",
  };

  if (options.format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    `ContextPro Efficiency — ${scope}`,
    `Estimated source tokens avoided: ~${formatNumber(totals.savedTokens)}`,
    `Source context represented: ~${formatNumber(totals.sourceTokens)} tokens across ${formatNumber(totals.representedFiles)} file references`,
    `Response text delivered: ~${formatNumber(totals.outputTokens)} tokens`,
    `Tool calls: ${formatNumber(totals.calls)} (${formatNumber(totals.errors)} errors) | average ${formatNumber(totals.avgMs)}ms`,
  ];
  if (hypotheticalCost !== null) {
    lines.push(`Hypothetical input cost avoided: $${hypotheticalCost.toFixed(4)} at $${rate!.toFixed(2)}/1M input tokens`);
  } else {
    lines.push("Cost: not claimed; pass input_cost_per_million for a clearly-labelled scenario estimate.");
  }
  if (byTool.length > 0) {
    lines.push("", "Top estimated savings by tool:");
    for (const row of byTool.slice(0, 10)) {
      lines.push(`  ${row.tool}: ~${formatNumber(row.savedTokens)} tokens | ${row.calls} calls | ${row.representedFiles} file references`);
    }
  }
  lines.push(
    "",
    "Method: indexed bytes for explicitly represented file paths ÷ 4, minus returned text size. This is a transparent context-compression estimate, not provider billing data.",
    "History stores only numeric metrics and tool names—never prompts, response bodies, source text, or file paths.",
  );
  return lines.join("\n");
}
