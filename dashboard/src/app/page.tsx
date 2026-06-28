"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MetricStrip } from "@/components/MetricStrip";
import { StatusPanel } from "@/components/StatusPanel";
import { StatsPanel } from "@/components/StatsPanel";
import { ToolsPanel } from "@/components/ToolsPanel";
import { PerfPanel } from "@/components/PerfPanel";
import { GraphHero } from "@/components/GraphHero";

interface Project { projectId: string | null; root: string; hasIndex: boolean }

async function getJSON(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

export default function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [tools, setTools] = useState<Record<string, unknown> | null>(null);
  const [graph, setGraph] = useState<Record<string, unknown> | null>(null);
  const [memory, setMemory] = useState<Record<string, unknown> | null>(null);
  const [perf, setPerf] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  const reindexStart = useRef<number>(0);
  const [reindexElapsed, setReindexElapsed] = useState(0);

  useEffect(() => {
    getJSON("/api/projects")
      .then((d) => {
        setProjects(d.projects ?? []);
        if (!root && d.projects?.length) setRoot(d.projects[0].root);
      })
      .catch((e) => setError(String(e)));
  }, [root]);

  const lightRefresh = useCallback(async (r: string) => {
    const q = `?root=${encodeURIComponent(r)}`;
    const [s, t, p] = await Promise.all([getJSON(`/api/status${q}`), getJSON(`/api/tools${q}`), getJSON(`/api/perf`)]);
    setStatus(s.status); setTools(t); setPerf(p); setUpdatedAt(Date.now());
  }, []);

  const fullRefresh = useCallback(async (r: string | null) => {
    const q = r ? `?root=${encodeURIComponent(r)}` : "";
    try {
      const [s, st, t, g, m] = await Promise.all([
        getJSON(`/api/status${q}`), getJSON(`/api/stats${q}`), getJSON(`/api/tools${q}`),
        getJSON(`/api/graph${q}`), getJSON(`/api/memory${q}`),
      ]);
      setStatus(s.status); setStats(st.stats); setTools(t); setGraph(g.graph); setMemory(m.memory);
      setUpdatedAt(Date.now()); setError(null);
    } catch (e) { setError(String(e)); }
  }, []);

  useEffect(() => { if (root) fullRefresh(root); }, [root, fullRefresh]);

  useEffect(() => {
    if (!auto || !root || reindexing) return;
    const id = setInterval(() => { lightRefresh(root).catch(() => {}); }, 4000);
    return () => clearInterval(id);
  }, [auto, root, reindexing, lightRefresh]);

  // Tick elapsed timer while reindexing.
  useEffect(() => {
    if (!reindexing) return;
    const id = setInterval(() => setReindexElapsed(Date.now() - reindexStart.current), 200);
    return () => clearInterval(id);
  }, [reindexing]);

  const doReindex = useCallback(async (force: boolean) => {
    if (!root || reindexing) return;
    setReindexing(true); setReindexMsg(null); reindexStart.current = Date.now(); setReindexElapsed(0);
    try {
      // Fire-and-forget: the server starts the reindex in the background (it can
      // take minutes with embeddings), then we poll for completion.
      await getJSON("/api/reindex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, force }) });
      const q = `?root=${encodeURIComponent(root)}`;
      const poll = async (): Promise<void> => {
        const { state } = await getJSON(`/api/reindex${q}`);
        // Refresh status live so the user sees the "indexing" state + file counts.
        lightRefresh(root).catch(() => {});
        if (state && !state.running && state.finishedAt) {
          if (state.error) setReindexMsg(`Reindex failed: ${state.error}`);
          else setReindexMsg(`Indexed ${state.indexed} files in ${(state.durationMs / 1000).toFixed(1)}s · ${state.filesPerSec} f/s · ${state.skipped} skipped`);
          await fullRefresh(root);
          setReindexing(false);
          return;
        }
        setTimeout(poll, 1500);
      };
      setTimeout(poll, 1500);
    } catch (e) {
      setReindexMsg(`Reindex failed: ${String(e)}`);
      setReindexing(false);
    }
  }, [root, reindexing, fullRefresh, lightRefresh]);

  return (
    <>
      <header className="top">
        <span className="dot" style={{ background: reindexing ? "var(--yellow)" : "var(--green)" }} />
        <h1>ContextPro Dashboard</h1>
        <select value={root ?? ""} onChange={(e) => setRoot(e.target.value)} disabled={reindexing}>
          {projects.length === 0 && <option value="">(no projects found)</option>}
          {projects.map((p) => (
            <option key={p.root} value={p.root}>{(p.projectId ?? p.root.split("/").pop())}{p.hasIndex ? "" : " (no index)"}</option>
          ))}
        </select>
        <button onClick={() => doReindex(false)} disabled={reindexing} title="Reindex changed files">
          {reindexing ? `indexing… ${(reindexElapsed / 1000).toFixed(1)}s` : "↻ reindex"}
        </button>
        <button onClick={() => doReindex(true)} disabled={reindexing} title="Force full reindex">force</button>
        <button onClick={() => root && fullRefresh(root)} disabled={reindexing}>refresh</button>
        <button onClick={() => setAuto((a) => !a)} style={{ color: auto ? "var(--green)" : "var(--muted)" }}>{auto ? "● live" : "○ paused"}</button>
        <span className="spacer" />
        {reindexMsg && <span className="muted" style={{ fontSize: 11, color: reindexMsg.startsWith("Reindex failed") ? "var(--red)" : "var(--green)" }}>{reindexMsg}</span>}
        {!reindexMsg && updatedAt && <span className="muted" style={{ fontSize: 11 }}>updated {new Date(updatedAt).toLocaleTimeString()}</span>}
      </header>

      <div className="wrap">
        {error && <div className="panel" style={{ borderColor: "var(--red)", marginBottom: 16 }}><span className="err">⚠ {error}</span></div>}

        <MetricStrip status={status as never} stats={stats as never} tools={tools as never} />

        <GraphHero code={graph as never} memory={memory as never} />

        <div className="grid">
          <PerfPanel data={perf as never} tools={(tools as { aggregates?: never })?.aggregates ?? null} />
          <ToolsPanel data={tools as never} />
          <StatsPanel data={stats as never} timing={(status as { index?: never })?.index ?? null} />
          <StatusPanel data={status as never} />
        </div>

        <p className="muted" style={{ marginTop: 20, fontSize: 11 }}>
          {root && <>Reading <code>{root}/.contextpro/index.db</code> (WAL — safe alongside a live MCP).</>}
        </p>
      </div>
    </>
  );
}
