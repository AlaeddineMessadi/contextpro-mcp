"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusPanel } from "@/components/StatusPanel";
import { ToolsPanel } from "@/components/ToolsPanel";
import { CodeGraphPanel } from "@/components/CodeGraphPanel";
import { MemoryPanel } from "@/components/MemoryPanel";

interface Project { projectId: string | null; root: string; hasIndex: boolean }

async function getJSON(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [tools, setTools] = useState<Record<string, unknown> | null>(null);
  const [graph, setGraph] = useState<Record<string, unknown> | null>(null);
  const [memory, setMemory] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Load project list once.
  useEffect(() => {
    getJSON("/api/projects")
      .then((d) => {
        setProjects(d.projects ?? []);
        if (!root && d.projects?.length) setRoot(d.projects[0].root);
      })
      .catch((e) => setError(String(e)));
  }, [root]);

  const refresh = useCallback(async (r: string | null) => {
    const q = r ? `?root=${encodeURIComponent(r)}` : "";
    try {
      const [s, t, g, m] = await Promise.all([
        getJSON(`/api/status${q}`),
        getJSON(`/api/tools${q}`),
        getJSON(`/api/graph${q}`),
        getJSON(`/api/memory${q}`),
      ]);
      setStatus(s.status); setTools(t); setGraph(g.graph); setMemory(m.memory);
      setUpdatedAt(Date.now()); setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Refresh on root change.
  useEffect(() => { if (root) refresh(root); }, [root, refresh]);

  // Auto-refresh status + tools (cheap) every 4s; the graphs change rarely.
  useEffect(() => {
    if (!auto || !root) return;
    const q = `?root=${encodeURIComponent(root)}`;
    const id = setInterval(async () => {
      try {
        const [s, t] = await Promise.all([getJSON(`/api/status${q}`), getJSON(`/api/tools${q}`)]);
        setStatus(s.status); setTools(t); setUpdatedAt(Date.now());
      } catch { /* keep last good */ }
    }, 4000);
    return () => clearInterval(id);
  }, [auto, root]);

  return (
    <>
      <header className="top">
        <span className="dot" />
        <h1>ContextPro Dashboard</h1>
        <select value={root ?? ""} onChange={(e) => setRoot(e.target.value)}>
          {projects.length === 0 && <option value="">(no projects found)</option>}
          {projects.map((p) => (
            <option key={p.root} value={p.root}>
              {(p.projectId ?? p.root.split("/").pop())}{p.hasIndex ? "" : " (no index)"}
            </option>
          ))}
        </select>
        <button onClick={() => root && refresh(root)}>↻ refresh</button>
        <button onClick={() => setAuto((a) => !a)} style={{ color: auto ? "var(--green)" : "var(--muted)" }}>
          {auto ? "● live" : "○ paused"}
        </button>
        <span className="spacer" />
        {updatedAt && <span className="muted" style={{ fontSize: 11 }}>updated {new Date(updatedAt).toLocaleTimeString()}</span>}
      </header>

      <div className="wrap">
        {error && <div className="panel" style={{ borderColor: "var(--red)", marginBottom: 16 }}><span className="err">⚠ {error}</span></div>}
        <div className="grid">
          <StatusPanel data={status as never} />
          <ToolsPanel data={tools as never} />
          <CodeGraphPanel data={graph as never} />
          <MemoryPanel data={memory as never} />
        </div>
        <p className="muted" style={{ marginTop: 24, fontSize: 11 }}>
          {root && <>Reading <code>{root}/.contextpro/index.db</code> (WAL — safe alongside a live MCP). </>}
          Tool history is persisted by the MCP server; restart it on this branch to start logging.
        </p>
      </div>
    </>
  );
}
