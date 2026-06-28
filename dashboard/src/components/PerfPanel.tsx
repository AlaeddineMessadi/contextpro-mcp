"use client";

interface Proc { pid: number; cpu: number; rssMB: number; etime: string; kind: string; command: string }
interface PerfData {
  processes: Proc[];
  totals: { mcp: { count: number; cpu: number; rssMB: number }; ollama: { count: number; cpu: number; rssMB: number } };
  mcpSessions: number;
}
interface ToolAgg { tool: string; calls: number; avgMs: number; maxMs: number }

const KIND_COLOR: Record<string, string> = { mcp: "#5b9dff", ollama: "#a371f7", dashboard: "#3fb950", other: "#8b90a0" };

export function PerfPanel({ data, tools }: { data: PerfData | null; tools: ToolAgg[] | null }) {
  if (!data) return <div className="panel"><h2>Performance</h2><p className="muted">No data.</p></div>;

  // "Cost" of each tool = total ms spent = calls × avg. Surfaces the heaviest tools.
  const heaviest = (tools ?? [])
    .map((t) => ({ ...t, totalMs: Math.round(t.calls * t.avgMs) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 6);
  const maxCost = Math.max(1, ...heaviest.map((t) => t.totalMs));

  return (
    <div className="panel">
      <h2>Performance &amp; Resources</h2>

      <div className="stat-row" style={{ marginBottom: 12 }}>
        <div className="stat"><span className={`v ${data.mcpSessions > 2 ? "yellow" : ""}`}>{data.mcpSessions}</span><span className="l">MCP sessions</span></div>
        <div className="stat"><span className="v">{data.totals.mcp.cpu}%</span><span className="l">MCP cpu</span></div>
        <div className="stat"><span className="v">{data.totals.mcp.rssMB}<span className="muted" style={{ fontSize: 12 }}>MB</span></span><span className="l">MCP ram</span></div>
        <div className="stat"><span className={`v ${data.totals.ollama.cpu > 20 ? "yellow" : ""}`}>{data.totals.ollama.cpu}%</span><span className="l">ollama cpu</span></div>
        <div className="stat"><span className="v">{data.totals.ollama.rssMB}<span className="muted" style={{ fontSize: 12 }}>MB</span></span><span className="l">ollama ram</span></div>
      </div>

      {data.mcpSessions > 2 && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 10, color: "var(--yellow)" }}>
          ⚠ {data.mcpSessions} MCP servers running — each watches files + reconciles. Close unused Claude sessions to cut idle CPU.
        </div>
      )}

      <h2>Processes</h2>
      <div className="scroll" style={{ maxHeight: 180 }}>
        <table>
          <thead><tr><th>kind</th><th>pid</th><th className="num">cpu</th><th className="num">ram</th><th className="num">uptime</th></tr></thead>
          <tbody>
            {data.processes.map((p) => (
              <tr key={p.pid}>
                <td><span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 2, background: KIND_COLOR[p.kind] ?? "#888", marginRight: 6 }} />{p.kind}</td>
                <td className="muted">{p.pid}</td>
                <td className="num" style={{ color: p.cpu > 20 ? "var(--yellow)" : "inherit" }}>{p.cpu}%</td>
                <td className="num">{p.rssMB}MB</td>
                <td className="num muted">{p.etime}</td>
              </tr>
            ))}
            {data.processes.length === 0 && <tr><td className="muted">No tracked processes.</td></tr>}
          </tbody>
        </table>
      </div>

      {heaviest.length > 0 && (
        <>
          <h2 style={{ marginTop: 14 }}>Heaviest tools (total time spent)</h2>
          <table>
            <tbody>
              {heaviest.map((t) => (
                <tr key={t.tool}>
                  <td>{t.tool}</td>
                  <td className="num muted">{t.calls}×</td>
                  <td className="num">{t.avgMs}ms</td>
                  <td style={{ width: 80 }}><div className="bar"><span style={{ width: `${(t.totalMs / maxCost) * 100}%` }} /></div></td>
                  <td className="num muted">{(t.totalMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
