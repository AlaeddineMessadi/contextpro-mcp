// Persistent, auditable context estimates with isolated MCP-session accounting.
import { getDB } from "../core/db.js";
import { getToolSchemaTokens, runtimeSessionId, runtimeSessionStartedAt } from "../core/runtime-session.js";

export type EfficiencyScope = "session" | "24h" | "7d" | "all";
export interface EfficiencyReportOptions {
  rootDir: string;
  scope?: EfficiencyScope;
  sessionStartedAt?: number;
  sessionId?: string;
  inputCostPerMillion?: number;
  contextproCostUsd?: number;
  historyLimit?: number;
  format?: "text" | "json";
}
function sinceFor(scope: EfficiencyScope, started?: number): number | undefined {
  if (scope === "session") return started ?? runtimeSessionStartedAt;
  if (scope === "24h") return Date.now() - 86_400_000;
  if (scope === "7d") return Date.now() - 7 * 86_400_000;
  return undefined;
}
const fmt = (n: number): string => Math.max(0, Math.round(n)).toLocaleString("en-US");
function nonnegative(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`${label} must be a finite nonnegative number.`);
  return value;
}
export async function getEfficiencyReport(options: EfficiencyReportOptions): Promise<string> {
  const scope = options.scope ?? "session";
  const since = sinceFor(scope, options.sessionStartedAt);
  const sessionId = scope === "session" ? options.sessionId ?? runtimeSessionId : undefined;
  const db = await getDB(options.rootDir);
  const totals = db.getEfficiencyTotals(since, sessionId);
  const byTool = db.getToolCallAggregates(since, sessionId).sort((a, b) => b.savedTokens - a.savedTokens);
  const history = db.getToolSavingsHistory(options.historyLimit ?? 10, since, sessionId);
  const rate = nonnegative(options.inputCostPerMillion, "inputCostPerMillion");
  const operatingCost = nonnegative(options.contextproCostUsd, "contextproCostUsd");
  const schemaTokens = scope === "session" ? getToolSchemaTokens() : null;
  const netTokens = totals.sourceTokens - totals.outputTokens - totals.inputTokens - (schemaTokens ?? 0);
  const avoided = Math.max(0, netTokens);
  const cost = rate === undefined ? null : avoided * rate / 1_000_000;
  const costText = cost === null ? "cost unavailable (model price not supplied)" : `$${cost.toFixed(4)} hypothetical input cost avoided`;
  const finalSummary = `ContextPro: ${fmt(totals.calls)} tool calls; ~${fmt(avoided)} input tokens avoided versus full-file reads (estimate); ${costText}.`;
  const report = {
    scope, sessionId: sessionId ?? null, since: since === undefined ? null : new Date(since).toISOString(),
    observed: { toolCalls: totals.calls, errors: totals.errors, averageMs: totals.avgMs, maxMs: totals.maxMs },
    estimate: {
      savedTokens: avoided,
      sourceTokensRepresented: totals.sourceTokens,
      responseTokens: totals.outputTokens,
      requestTokens: totals.inputTokens,
      toolSchemaTokens: schemaTokens,
      netTokensAvoided: netTokens,
      representedFileReferences: totals.representedFiles,
      method: "UTF-8 bytes divided by four. Full-source baseline credits each represented file revision once per process session; subtract all request/response estimates and one advertised tool catalog for session reports. Historical rows may use the older per-call baseline.",
      limitations: ["Not tokenizer measurements or a measured comparison against another agent.", "Client schema loading, repeated prompt history and cache behavior are unknown; one catalog is a scenario assumption.", "Non-session windows combine sessions and older estimates; catalog overhead is unavailable.", "History is bounded to the latest 5,000 calls per project; old periods may be incomplete."],
    },
    calls: { total: totals.calls, errors: totals.errors, averageMs: totals.avgMs, maxMs: totals.maxMs },
    hypotheticalInputCostAvoided: cost === null ? null : {
      usd: Number(cost.toFixed(6)), inputCostPerMillionTokens: rate,
      contextproCostUsd: operatingCost ?? null,
      netUsdAfterSuppliedCosts: operatingCost === undefined ? null : Number((cost - operatingCost).toFixed(6)),
      note: "Scenario only: uncached input pricing, not actual billing savings. Net excludes operating costs unless supplied. No revenue is inferred.",
    },
    actualBillingSavingsUsd: null,
    actualAgentTokensSaved: null,
    finalSummary, byTool, recentSavings: history,
    privacy: "Only numeric metrics, tool names and an opaque session ID are stored. Prompts, responses, source text, and file paths are never retained in efficiency history.",
  };
  if (options.format === "json") return JSON.stringify(report, null, 2);
  const lines = [
    `ContextPro Efficiency — ${scope}`, finalSummary,
    `Full-source baseline: ~${fmt(totals.sourceTokens)} tokens; requests: ~${fmt(totals.inputTokens)}; responses: ~${fmt(totals.outputTokens)}.`,
    schemaTokens === null ? "Tool-catalog overhead: unavailable for this history window." : `Tool-catalog allowance: ~${fmt(schemaTokens)} tokens (one catalog; client behavior varies).`,
    `Observed: ${fmt(totals.errors)} errors; average ${fmt(totals.avgMs)}ms per call.`,
  ];
  if (netTokens < 0) lines.push(`Estimated overhead exceeds this baseline by ~${fmt(-netTokens)} tokens; no savings claimed.`);
  if (cost !== null && operatingCost !== undefined) lines.push(`Hypothetical net after supplied ContextPro costs: $${(cost - operatingCost).toFixed(4)}.`);
  if (cost === null) lines.push("Pass input_cost_per_million to calculate a price scenario; never guess a model price.");
  lines.push("", "Method: " + report.estimate.method, "Actual agent-token savings and billing savings are unknown. Provider caching and ContextPro costs can change the result.", report.privacy);
  return lines.join("\n");
}
