"use client";

import { GraphView, GNode, GEdge } from "./GraphView";

interface CodeGraphData {
  nodes: Array<{ id: string; label: string; type: string; path?: string; importance: number }>;
  edges: Array<{ source: string; target: string; type: string }>;
  stats: Record<string, number>;
}

export function CodeGraphPanel({ data }: { data: CodeGraphData | null }) {
  if (!data) return <div className="panel full"><h2>Code Graph</h2><p className="muted">No data.</p></div>;
  const nodes: GNode[] = data.nodes.map((n) => ({ id: n.id, label: n.path ?? n.label, importance: n.importance, group: n.type }));
  const edges: GEdge[] = data.edges;
  const top = [...data.nodes].sort((a, b) => b.importance - a.importance).slice(0, 8);

  return (
    <div className="panel full">
      <h2>Code Graph — import structure (node size = how many files import it)</h2>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <div className="stat"><span className="v">{data.stats.files ?? 0}</span><span className="l">files</span></div>
        <div className="stat"><span className="v">{data.stats.symbols ?? 0}</span><span className="l">symbols</span></div>
        <div className="stat"><span className="v">{data.stats.imports ?? 0}</span><span className="l">imports</span></div>
        <div className="stat"><span className="v">{data.stats.calls ?? 0}</span><span className="l">call sites</span></div>
        <div className="stat"><span className="v">{nodes.length}</span><span className="l">nodes shown</span></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 240px", gap: 12 }}>
        <GraphView nodes={nodes} edges={edges} height={460} />
        <div>
          <h2 style={{ marginTop: 0 }}>Most depended-on</h2>
          <table>
            <tbody>
              {top.map((n) => (
                <tr key={n.id}>
                  <td title={n.path}>{(n.path ?? n.label).split("/").slice(-2).join("/")}</td>
                  <td className="num">{n.importance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="legend">
        <span><i style={{ background: "#5b9dff" }} /> file</span>
        <span><i style={{ background: "#3fb950" }} /> test</span>
        <span><i style={{ background: "#d29922" }} /> config</span>
      </div>
    </div>
  );
}
