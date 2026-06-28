"use client";

interface Status {
  index?: { state?: string; generation?: number; missingIndexedFiles?: number; removedIndexedFiles?: number; lastReindexDurationMs?: number | null };
  files?: { indexed?: number; source?: number };
  embeddings?: { total?: number; provider?: string | null; model?: string | null; dimension?: number | null; stale?: boolean };
  memory?: { nodes?: number; edges?: number };
  git?: { branch?: string; uncommitted?: number };
}
interface Stats { totalSymbols?: number }
interface Tools { total?: number; aggregates?: Array<{ errors: number }> }

function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function stateColor(s?: string): string {
  if (s === "fresh") return "var(--green)";
  if (s === "indexing") return "var(--accent)";
  if (s === "stale") return "var(--yellow)";
  return "var(--red)";
}

/**
 * The single source of truth for headline numbers — shown once, at the top, so no
 * panel below repeats file/symbol/embedding/memory counts.
 */
export function MetricStrip({ status, stats, tools }: { status: Status | null; stats: Stats | null; tools: Tools | null }) {
  const i = status?.index ?? {};
  const drift = (i.missingIndexedFiles ?? 0) + (i.removedIndexedFiles ?? 0);
  const errors = tools?.aggregates?.reduce((s, a) => s + a.errors, 0) ?? 0;

  const metrics: Array<{ label: string; value: React.ReactNode; color?: string; title?: string }> = [
    { label: "index", value: i.state ?? "—", color: stateColor(i.state) },
    { label: "files", value: (status?.files?.indexed ?? 0).toLocaleString(), title: `${status?.files?.source ?? 0} source files` },
    { label: "symbols", value: (stats?.totalSymbols ?? 0).toLocaleString() },
    { label: "drift", value: drift, color: drift > 0 ? "var(--yellow)" : undefined, title: "files missing-from / removed-in the index" },
    { label: "embeddings", value: (status?.embeddings?.total ?? 0).toLocaleString(), title: `${status?.embeddings?.provider ?? "?"} · ${status?.embeddings?.model ?? "?"} · dim ${status?.embeddings?.dimension ?? "?"}` },
    { label: "memory", value: `${status?.memory?.nodes ?? 0} / ${status?.memory?.edges ?? 0}`, title: "nodes / edges" },
    { label: "tool calls", value: (tools?.total ?? 0).toLocaleString() },
    { label: "errors", value: errors, color: errors > 0 ? "var(--red)" : "var(--green)" },
    { label: "last reindex", value: fmtDuration(i.lastReindexDurationMs) },
    { label: "branch", value: status?.git?.branch ?? "—", title: `${status?.git?.uncommitted ?? 0} uncommitted` },
  ];

  return (
    <div className="metric-strip">
      {metrics.map((m) => (
        <div className="metric" key={m.label} title={m.title}>
          <span className="metric-v" style={{ color: m.color }}>{m.value}</span>
          <span className="metric-l">{m.label}</span>
        </div>
      ))}
    </div>
  );
}
