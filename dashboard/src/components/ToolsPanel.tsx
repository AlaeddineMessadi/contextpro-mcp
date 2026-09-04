"use client";

import { useMemo, useState } from "react";

interface ToolAggregate { tool: string; calls: number; errors: number; avgMs: number; maxMs: number; lastAt: number; savedTokens: number; representedFiles: number }
interface ToolCall { tool: string; status: string; durationMs: number; calledAt: number; savedTokens: number; representedFiles: number }
interface ToolsData { total: number; aggregates: ToolAggregate[]; history: ToolCall[] }

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Tiny inline bar sparkline of call counts over the last `buckets` time slots. */
function Sparkline({ history }: { history: ToolCall[] }) {
  const buckets = 40;
  const data = useMemo(() => {
    if (history.length === 0) return [];
    const now = Date.now();
    const oldest = Math.min(...history.map((h) => h.calledAt));
    const span = Math.max(60_000, now - oldest);
    const slot = span / buckets;
    const counts = new Array(buckets).fill(0);
    for (const h of history) {
      const i = Math.min(buckets - 1, Math.floor((h.calledAt - oldest) / slot));
      counts[i] += 1;
    }
    return counts;
  }, [history]);
  if (data.length === 0) return null;
  const max = Math.max(1, ...data);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 36, marginBottom: 10 }}>
      {data.map((c, i) => (
        <div key={i} title={`${c} calls`} style={{ flex: 1, height: `${(c / max) * 100}%`, minHeight: c > 0 ? 2 : 0, background: "var(--accent)", opacity: 0.4 + (c / max) * 0.6, borderRadius: 1 }} />
      ))}
    </div>
  );
}

export function ToolsPanel({ data }: { data: ToolsData | null }) {
  const [toolFilter, setToolFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  if (!data) return <div className="panel"><h2>Tool Activity</h2><p className="muted">No data.</p></div>;

  const filteredHistory = data.history.filter((c) =>
    (!toolFilter || c.tool === toolFilter) &&
    (statusFilter === "all" || c.status === statusFilter),
  );
  const maxCalls = Math.max(1, ...data.aggregates.map((a) => a.calls));
  const totalSaved = data.aggregates.reduce((sum, item) => sum + (item.savedTokens ?? 0), 0);

  return (
    <div className="panel">
      <h2>Tool Activity &amp; History</h2>
      {totalSaved > 0 && <p className="muted">Estimated source tokens avoided: <strong>~{totalSaved.toLocaleString()}</strong> · numeric history only, not billing data</p>}
      {data.total === 0 ? (
        <p className="muted">No tool calls recorded yet. Use any MCP tool (search, status, semantic_diff…) and they&apos;ll appear here. (Requires the MCP server running the persistence build.)</p>
      ) : (
        <>
          <Sparkline history={data.history} />
          <table>
            <thead><tr><th>Tool</th><th className="num">Calls</th><th className="num">Err</th><th className="num">Avg</th><th className="num">Saved est.</th><th></th></tr></thead>
            <tbody>
              {data.aggregates.map((a) => (
                <tr key={a.tool} onClick={() => setToolFilter((t) => (t === a.tool ? "" : a.tool))}
                    style={{ cursor: "pointer", background: toolFilter === a.tool ? "var(--panel-2)" : undefined }}>
                  <td>{a.tool}</td>
                  <td className="num">{a.calls}</td>
                  <td className="num" style={{ color: a.errors > 0 ? "var(--red)" : "inherit" }}>{a.errors}</td>
                  <td className="num">{a.avgMs}ms</td>
                  <td className="num" title={`${a.representedFiles ?? 0} represented file references`}>~{(a.savedTokens ?? 0).toLocaleString()}</td>
                  <td style={{ width: 80 }}><div className="bar"><span style={{ width: `${(a.calls / maxCalls) * 100}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, marginBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Recent Calls</h2>
            <span className="spacer" style={{ flex: 1 }} />
            {toolFilter && <button className="chip" onClick={() => setToolFilter("")}>tool: {toolFilter} ✕</button>}
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="chip">
              <option value="all">all</option>
              <option value="ok">ok</option>
              <option value="error">errors</option>
            </select>
          </div>
          <div className="scroll">
            <table>
              <tbody>
                {filteredHistory.slice(0, 80).map((c, idx) => (
                  <tr key={idx}>
                    <td>{c.tool}</td>
                    <td>{c.status === "error" ? <span className="badge red">error</span> : <span className="badge green">ok</span>}</td>
                    <td className="num">{c.durationMs}ms</td>
                    <td className="num muted">{c.savedTokens > 0 ? `~${c.savedTokens.toLocaleString()} saved` : "—"}</td>
                    <td className="num muted">{ago(c.calledAt)}</td>
                  </tr>
                ))}
                {filteredHistory.length === 0 && <tr><td className="muted">No calls match the filter.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      <style>{`.chip{background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:11px;font-family:var(--mono);cursor:pointer}.chip:hover{border-color:var(--accent)}`}</style>
    </div>
  );
}
