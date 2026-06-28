"use client";

interface ToolAggregate { tool: string; calls: number; errors: number; avgMs: number; maxMs: number; lastAt: number }
interface ToolCall { tool: string; status: string; durationMs: number; calledAt: number }
interface ToolsData { total: number; aggregates: ToolAggregate[]; history: ToolCall[] }

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ToolsPanel({ data }: { data: ToolsData | null }) {
  if (!data) return <div className="panel"><h2>Tool Activity</h2><p className="muted">No data.</p></div>;
  const maxCalls = Math.max(1, ...data.aggregates.map((a) => a.calls));

  return (
    <div className="panel">
      <h2>Tool Activity &amp; History</h2>
      {data.total === 0 ? (
        <p className="muted">No tool calls recorded yet. Use any MCP tool (search, status, semantic_diff…) and refresh.</p>
      ) : (
        <>
          <div className="stat-row" style={{ marginBottom: 12 }}>
            <div className="stat"><span className="v">{data.total}</span><span className="l">total calls</span></div>
            <div className="stat"><span className="v">{data.aggregates.length}</span><span className="l">distinct tools</span></div>
            <div className="stat">
              <span className={`v ${data.aggregates.reduce((s, a) => s + a.errors, 0) > 0 ? "red" : "green"}`}>
                {data.aggregates.reduce((s, a) => s + a.errors, 0)}
              </span>
              <span className="l">errors</span>
            </div>
          </div>

          <table>
            <thead><tr><th>Tool</th><th className="num">Calls</th><th className="num">Err</th><th className="num">Avg</th><th className="num">Max</th><th></th></tr></thead>
            <tbody>
              {data.aggregates.map((a) => (
                <tr key={a.tool}>
                  <td>{a.tool}</td>
                  <td className="num">{a.calls}</td>
                  <td className="num" style={{ color: a.errors > 0 ? "var(--red)" : "inherit" }}>{a.errors}</td>
                  <td className="num">{a.avgMs}ms</td>
                  <td className="num">{a.maxMs}ms</td>
                  <td style={{ width: 90 }}><div className="bar"><span style={{ width: `${(a.calls / maxCalls) * 100}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ marginTop: 16 }}>Recent Calls</h2>
          <div className="scroll">
            <table>
              <tbody>
                {data.history.slice(0, 60).map((c, idx) => (
                  <tr key={idx}>
                    <td>{c.tool}</td>
                    <td>{c.status === "error" ? <span className="badge red">error</span> : <span className="badge green">ok</span>}</td>
                    <td className="num">{c.durationMs}ms</td>
                    <td className="num muted">{ago(c.calledAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
