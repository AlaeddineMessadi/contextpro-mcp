"use client";

import { GraphView, GNode, GEdge } from "./GraphView";

interface MemoryData {
  nodes: Array<{ id: string; type: string; label: string; accessCount?: number }>;
  edges: Array<{ source: string; target: string; relation: string; weight: number }>;
}

export function MemoryPanel({ data }: { data: MemoryData | null }) {
  if (!data) return <div className="panel"><h2>Memory Graph</h2><p className="muted">No data.</p></div>;

  if (data.nodes.length === 0) {
    return (
      <div className="panel">
        <h2>Memory Graph</h2>
        <p className="muted">No memory nodes yet. The memory graph fills as agents call <code>memory_create</code> / <code>memory_record_task</code>.</p>
      </div>
    );
  }

  const nodes: GNode[] = data.nodes.map((n) => ({
    id: n.id, label: n.label, group: n.type, importance: n.accessCount ?? 0,
  }));
  const edges: GEdge[] = data.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight }));

  // Relation-type distribution
  const byRelation = new Map<string, number>();
  for (const e of data.edges) byRelation.set(e.relation, (byRelation.get(e.relation) ?? 0) + 1);

  return (
    <div className="panel">
      <h2>Memory Graph</h2>
      <div className="stat-row" style={{ marginBottom: 8 }}>
        <div className="stat"><span className="v">{data.nodes.length}</span><span className="l">nodes</span></div>
        <div className="stat"><span className="v">{data.edges.length}</span><span className="l">edges</span></div>
      </div>
      <GraphView nodes={nodes} edges={edges} height={300} />
      <div className="legend">
        {[...byRelation.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([rel, n]) => (
          <span key={rel}>{rel}: {n}</span>
        ))}
      </div>
    </div>
  );
}
