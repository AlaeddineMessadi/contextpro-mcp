"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface GNode { id: string; label: string; importance?: number; group?: string }
export interface GEdge { source: string; target: string; weight?: number }

const GROUP_COLORS: Record<string, string> = {
  file: "#5b9dff", test: "#3fb950", config: "#d29922", document: "#a371f7",
  concept: "#5b9dff", note: "#d29922", symbol: "#79c0ff", folder: "#8b90a0",
  default: "#8b90a0",
};

interface Pos { x: number; y: number; r: number; color: string }

/**
 * A dependency-free, force-directed graph with zoom/pan and click-to-focus.
 * - A few iterations of a Fruchterman-Reingold-style simulation spread nodes by
 *   connectivity (clusters emerge), seeded deterministically so layout is stable.
 * - Wheel zooms toward the cursor; drag pans. Click a node to focus it: its
 *   neighborhood stays bright, the rest dims, and a side label shows its degree.
 * - Node size = importance; color = group.
 */
export function GraphView({ nodes, edges, height = 480 }: { nodes: GNode[]; edges: GEdge[]; height?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const W = 1000;
  const H = height;

  // Deterministic force layout (computed once per node/edge set).
  const positions = useMemo(() => {
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const N = nodes.length;
    if (N === 0) return new Map<string, Pos>();

    // Seed on a circle (deterministic — no Math.random) so re-renders are stable.
    const px = new Float64Array(N);
    const py = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      px[i] = W / 2 + Math.cos(a) * (Math.min(W, H) / 3) * (0.6 + ((i % 7) / 10));
      py[i] = H / 2 + Math.sin(a) * (Math.min(W, H) / 3) * (0.6 + ((i % 5) / 10));
    }

    const links = edges
      .map((e) => [idx.get(e.source), idx.get(e.target)] as [number | undefined, number | undefined])
      .filter((l): l is [number, number] => l[0] !== undefined && l[1] !== undefined);

    const area = W * H;
    const k = Math.sqrt(area / N) * 0.8; // ideal edge length
    const iterations = Math.min(120, 40 + Math.floor(2000 / Math.max(1, N)));

    for (let it = 0; it < iterations; it++) {
      const dx = new Float64Array(N);
      const dy = new Float64Array(N);
      // Repulsion (sampled for big graphs to stay cheap).
      const step = N > 350 ? 2 : 1;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j += step) {
          let ddx = px[i] - px[j];
          let ddy = py[i] - py[j];
          let dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
          const rep = (k * k) / dist;
          ddx = (ddx / dist) * rep;
          ddy = (ddy / dist) * rep;
          dx[i] += ddx; dy[i] += ddy;
          dx[j] -= ddx; dy[j] -= ddy;
        }
      }
      // Attraction along edges.
      for (const [a, b] of links) {
        let ddx = px[a] - px[b];
        let ddy = py[a] - py[b];
        const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
        const att = (dist * dist) / k;
        ddx = (ddx / dist) * att;
        ddy = (ddy / dist) * att;
        dx[a] -= ddx; dy[a] -= ddy;
        dx[b] += ddx; dy[b] += ddy;
      }
      // Apply with cooling.
      const temp = (1 - it / iterations) * (Math.min(W, H) / 12);
      for (let i = 0; i < N; i++) {
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01;
        px[i] += (dx[i] / d) * Math.min(d, temp);
        py[i] += (dy[i] / d) * Math.min(d, temp);
        px[i] = Math.max(20, Math.min(W - 20, px[i]));
        py[i] = Math.max(20, Math.min(H - 20, py[i]));
      }
    }

    const maxImp = Math.max(1, ...nodes.map((n) => n.importance ?? 0));
    const map = new Map<string, Pos>();
    nodes.forEach((n, i) => {
      map.set(n.id, {
        x: px[i], y: py[i],
        r: 3.5 + ((n.importance ?? 0) / maxImp) * 12,
        color: GROUP_COLORS[n.group ?? "default"] ?? GROUP_COLORS.default,
      });
    });
    return map;
  }, [nodes, edges, H]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edges) { d.set(e.source, (d.get(e.source) ?? 0) + 1); d.set(e.target, (d.get(e.target) ?? 0) + 1); }
    return d;
  }, [edges]);

  // The set of nodes connected to the focused/hovered node.
  const active = focus ?? hover;
  const neighborhood = useMemo(() => {
    if (!active) return null;
    const s = new Set<string>([active]);
    for (const e of edges) {
      if (e.source === active) s.add(e.target);
      if (e.target === active) s.add(e.source);
    }
    return s;
  }, [active, edges]);

  // Wheel zoom toward cursor.
  function onWheel(ev: React.WheelEvent) {
    ev.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    const my = ((ev.clientY - rect.top) / rect.height) * H;
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const k = Math.max(0.4, Math.min(6, v.k * factor));
      // keep cursor point stable
      const x = mx - ((mx - v.x) * k) / v.k;
      const y = my - ((my - v.y) * k) / v.k;
      return { x, y, k };
    });
  }
  function onPointerDown(ev: React.PointerEvent) {
    dragRef.current = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  }
  function onPointerMove(ev: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = (ev.clientX - d.x) * (W / rect.width);
    const sy = (ev.clientY - d.y) * (H / rect.height);
    setView((v) => ({ ...v, x: d.vx + sx, y: d.vy + sy }));
  }
  function onPointerUp() { dragRef.current = null; }

  useEffect(() => { setFocus(null); }, [nodes]);

  if (nodes.length === 0) return <p className="muted">No graph data — index this project first.</p>;

  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", top: 6, right: 8, zIndex: 2, display: "flex", gap: 6 }}>
        <button className="gbtn" onClick={() => setView((v) => ({ ...v, k: Math.min(6, v.k * 1.3) }))}>+</button>
        <button className="gbtn" onClick={() => setView((v) => ({ ...v, k: Math.max(0.4, v.k / 1.3) }))}>−</button>
        <button className="gbtn" onClick={() => { setView({ x: 0, y: 0, k: 1 }); setFocus(null); }}>reset</button>
      </div>
      {focus && (
        <div style={{ position: "absolute", top: 6, left: 8, zIndex: 2, fontSize: 11 }} className="muted">
          focused: <b style={{ color: "var(--text)" }}>{(nodes.find((n) => n.id === focus)?.label || "").split("/").pop()}</b>
          {" "}· {degree.get(focus) ?? 0} connections
        </div>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height, cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none", background: "var(--panel-2)", borderRadius: 8 }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const a = positions.get(e.source), b = positions.get(e.target);
            if (!a || !b) return null;
            const isActive = active && (e.source === active || e.target === active);
            const dim = active && !isActive;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={isActive ? "#5b9dff" : "#30343f"} strokeWidth={(isActive ? 1.4 : 0.6) / view.k}
              opacity={dim ? 0.06 : 0.55} />;
          })}
          {nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const dim = neighborhood ? !neighborhood.has(n.id) : false;
            const showLabel = p.r * view.k > 9 || n.id === active;
            return (
              <g key={n.id} opacity={dim ? 0.18 : 1}
                 onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                 onClick={() => setFocus((f) => (f === n.id ? null : n.id))} style={{ cursor: "pointer" }}>
                <circle cx={p.x} cy={p.y} r={p.r} fill={p.color} stroke={n.id === focus ? "#fff" : "#0a0b0f"} strokeWidth={(n.id === focus ? 2 : 1) / view.k} />
                {showLabel && (
                  <text x={p.x + p.r + 2 / view.k} y={p.y + 3 / view.k} fontSize={9 / view.k} fill="#cfd3dd" style={{ pointerEvents: "none" }}>
                    {(n.label || "").split("/").pop()}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <style>{`.gbtn{background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:5px;width:26px;height:24px;font-size:13px;cursor:pointer;line-height:1}.gbtn:hover{border-color:var(--accent)}`}</style>
    </div>
  );
}
