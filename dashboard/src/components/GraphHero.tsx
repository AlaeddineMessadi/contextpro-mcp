"use client";

import { useMemo, useState } from "react";
import { GraphView, GNode, GEdge } from "./GraphView";

import type { CodeGraph, MemGraph } from "@/lib/dashboard-types";

type Mode = "code" | "memory";
interface Selected {
  id: string;
  label: string;
  group?: string;
  degree: number;
}

export function GraphHero({
  code,
  memory,
}: {
  code: CodeGraph | null;
  memory: MemGraph | null;
}) {
  const [mode, setMode] = useState<Mode>("code");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);

  const { nodes, edges, labelById } = useMemo(() => {
    const labelById = new Map<string, string>();
    if (mode === "code") {
      if (!code)
        return { nodes: [] as GNode[], edges: [] as GEdge[], labelById };
      const nodes: GNode[] = code.nodes.map((n) => {
        labelById.set(n.id, n.path ?? n.label);
        return {
          id: n.id,
          label: n.path ?? n.label,
          importance: n.importance,
          group: n.type,
        };
      });
      return { nodes, edges: code.edges as GEdge[], labelById };
    }
    if (!memory)
      return { nodes: [] as GNode[], edges: [] as GEdge[], labelById };
    const nodes: GNode[] = memory.nodes.map((n) => {
      labelById.set(n.id, n.label);
      return {
        id: n.id,
        label: n.label,
        importance: n.accessCount ?? 0,
        group: n.type,
      };
    });
    const edges: GEdge[] = memory.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
      type: e.relation,
    }));
    return { nodes, edges, labelById };
  }, [mode, code, memory]);

  // Connections of the selected node, for the details list.
  const connections = useMemo(() => {
    if (!selected) return [];
    const out: Array<{
      id: string;
      label: string;
      rel: string;
      dir: "→" | "←";
    }> = [];
    for (const e of edges) {
      const rel = (e as { type?: string }).type ?? "—";
      if (e.source === selected.id)
        out.push({
          id: e.target,
          label: labelById.get(e.target) ?? e.target,
          rel,
          dir: "→",
        });
      else if (e.target === selected.id)
        out.push({
          id: e.source,
          label: labelById.get(e.source) ?? e.source,
          rel,
          dir: "←",
        });
    }
    return out.slice(0, 60);
  }, [selected, edges, labelById]);

  const stats = mode === "code" ? code?.stats : null;

  return (
    <div className="panel full graph-hero">
      <div className="graph-toolbar">
        <div className="seg">
          <button
            aria-pressed={mode === "code"}
            className={mode === "code" ? "on" : ""}
            onClick={() => {
              setMode("code");
              setSelected(null);
            }}
          >
            Code graph
          </button>
          <button
            className={mode === "memory" ? "on" : ""}
            onClick={() => {
              setMode("memory");
              setSelected(null);
            }}
            aria-pressed={mode === "memory"}
          >
            Memory graph
          </button>
        </div>
        <input
          aria-label="Search graph nodes"
          className="gsearch"
          placeholder={`search ${mode === "code" ? "files" : "memory"}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="spacer" />
        {mode === "code" && stats && (
          <span className="muted gstats">
            {stats.files} files · {stats.imports} imports · {nodes.length} shown
          </span>
        )}
        {mode === "memory" && memory && (
          <span className="muted gstats">
            {memory.nodes.length} nodes · {memory.edges.length} edges
          </span>
        )}
      </div>

      <div className="graph-body">
        <div className="graph-canvas">
          {(mode === "code" ? code : memory) === null ? (
            <div className="empty-state">
              <h2>Waiting for the {mode} graph</h2>
              <p>
                Graph data loads independently of the other views. Any read
                error appears above.
              </p>
            </div>
          ) : nodes.length === 0 ? (
            <div className="empty-state">
              <h2>
                {mode === "memory"
                  ? "No project memory yet"
                  : "No code graph nodes"}
              </h2>
              <p>
                {mode === "memory"
                  ? "Record concepts or task notes through ContextPro to see their relationships here."
                  : "Update the source index to discover file dependencies."}
              </p>
            </div>
          ) : (
            <GraphView
              nodes={nodes}
              edges={edges}
              height={460}
              search={search}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          )}
          <div className="legend graph-legend">
            {mode === "code" ? (
              <>
                <span>
                  <i style={{ background: "#477562" }} /> file
                </span>
                <span>
                  <i style={{ background: "#6b8838" }} /> test
                </span>
                <span>
                  <i style={{ background: "#a17d32" }} /> config
                </span>
              </>
            ) : (
              <>
                <span>
                  <i style={{ background: "#477562" }} /> concept
                </span>
                <span>
                  <i style={{ background: "#a17d32" }} /> note
                </span>
                <span>
                  <i style={{ background: "#68858d" }} /> symbol
                </span>
              </>
            )}
            <span className="muted">
              · drag to pan · scroll to zoom · click a node
            </span>
          </div>
        </div>

        <aside className="graph-side">
          <label htmlFor="graph-node" className="muted">
            Inspect a node
          </label>
          <select
            id="graph-node"
            value={selected?.id ?? ""}
            onChange={(event) => {
              const n = nodes.find((node) => node.id === event.target.value);
              setSelected(
                n
                  ? {
                      id: n.id,
                      label: n.label,
                      group: n.group,
                      degree: edges.filter(
                        (edge) => edge.source === n.id || edge.target === n.id,
                      ).length,
                    }
                  : null,
              );
            }}
          >
            <option value="">Choose a file or memory node</option>
            {nodes
              .filter(
                (n) =>
                  !search ||
                  n.label.toLowerCase().includes(search.toLowerCase()) ||
                  selected?.id === n.id,
              )
              .map((n) => (
                <option value={n.id} key={n.id}>
                  {n.label}
                </option>
              ))}
          </select>
          {!selected ? (
            <p className="muted" style={{ fontSize: 12 }}>
              Click any node to inspect it and its connections.
              {mode === "code" && " Node size = how many files import it."}
            </p>
          ) : (
            <>
              <h2 style={{ marginTop: 0 }}>
                {(selected.label || "").split("/").pop()}
              </h2>
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  wordBreak: "break-all",
                  marginBottom: 8,
                }}
              >
                {selected.label}
              </div>
              <div className="stat-row" style={{ marginBottom: 10 }}>
                <div className="stat">
                  <span className="v">{selected.degree}</span>
                  <span className="l">connections</span>
                </div>
                <div className="stat">
                  <span className="v" style={{ fontSize: 13 }}>
                    {selected.group}
                  </span>
                  <span className="l">type</span>
                </div>
              </div>
              <div className="scroll" style={{ maxHeight: 380 }}>
                <table>
                  <tbody>
                    {connections.map((c, i) => (
                      <tr key={i}>
                        <td style={{ width: 18, color: "var(--accent)" }}>
                          {c.dir}
                        </td>
                        <td title={c.label}>{c.label.split("/").pop()}</td>
                        <td className="muted" style={{ fontSize: 10 }}>
                          {c.rel}
                        </td>
                      </tr>
                    ))}
                    {connections.length === 0 && (
                      <tr>
                        <td className="muted">No connections.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
