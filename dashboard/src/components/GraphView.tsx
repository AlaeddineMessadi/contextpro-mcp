"use client";

import { useMemo, useState } from "react";

export interface GNode { id: string; label: string; importance?: number; group?: string }
export interface GEdge { source: string; target: string; weight?: number }

const GROUP_COLORS: Record<string, string> = {
  file: "#5b9dff", test: "#3fb950", config: "#d29922", document: "#a371f7",
  concept: "#5b9dff", note: "#d29922", symbol: "#79c0ff",
  default: "#8b90a0",
};

/**
 * Dependency-free graph renderer. Lays nodes on a deterministic golden-angle spiral
 * (importance pulls big nodes toward the center), draws edges as lines, and sizes
 * nodes by importance. Hover highlights a node's incident edges. Good enough to
 * "see the structure" without pulling in a force-simulation library.
 */
export function GraphView({ nodes, edges, height = 460 }: { nodes: GNode[]; edges: GEdge[]; height?: number }) {
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const W = 900, H = height;
    const cx = W / 2, cy = H / 2;
    const maxImp = Math.max(1, ...nodes.map((n) => n.importance ?? 0));
    // Sort by importance desc so important nodes get inner spiral slots.
    const ordered = [...nodes].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    const pos = new Map<string, { x: number; y: number; r: number; color: string }>();
    const golden = Math.PI * (3 - Math.sqrt(5));
    ordered.forEach((n, i) => {
      const t = i / Math.max(1, ordered.length - 1);
      const radius = 30 + t * (Math.min(W, H) / 2 - 50);
      const angle = i * golden;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      const r = 3 + ((n.importance ?? 0) / maxImp) * 11;
      const color = GROUP_COLORS[n.group ?? "default"] ?? GROUP_COLORS.default;
      pos.set(n.id, { x, y, r, color });
    });
    return { W, H, pos };
  }, [nodes, edges, height]);

  const incident = useMemo(() => {
    if (!hover) return new Set<string>();
    const s = new Set<string>();
    for (const e of edges) {
      if (e.source === hover || e.target === hover) { s.add(e.source); s.add(e.target); }
    }
    return s;
  }, [hover, edges]);

  if (nodes.length === 0) return <p className="muted">No graph data — index this project first.</p>;

  return (
    <svg viewBox={`0 0 ${layout.W} ${layout.H}`} style={{ width: "100%", height }} preserveAspectRatio="xMidYMid meet">
      {edges.map((e, idx) => {
        const a = layout.pos.get(e.source), b = layout.pos.get(e.target);
        if (!a || !b) return null;
        const active = hover && (e.source === hover || e.target === hover);
        return <line key={idx} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={active ? "#5b9dff" : "#262a36"} strokeWidth={active ? 1.5 : 0.6} opacity={hover && !active ? 0.15 : 0.6} />;
      })}
      {[...layout.pos.entries()].map(([id, p]) => {
        const node = nodes.find((n) => n.id === id)!;
        const dim = hover && !incident.has(id);
        return (
          <g key={id} onMouseEnter={() => setHover(id)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }} opacity={dim ? 0.2 : 1}>
            <circle cx={p.x} cy={p.y} r={p.r} fill={p.color} stroke="#0a0b0f" strokeWidth={1} />
            {(p.r > 7 || id === hover) && (
              <text x={p.x + p.r + 3} y={p.y + 3} fontSize={9} fill="#e6e8ee" style={{ pointerEvents: "none" }}>
                {(node.label || "").split("/").pop()}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
